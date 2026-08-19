import { onBeforeUnmount } from "vue";
import type {
  ElevationRenderRequest,
  ElevationRenderResult,
} from "../noise/preview/elevationRenderRequest";
import { loadEngineModule } from "../noise/wasm/load";
import { createRenderPool, type RenderPool, type TilePaint } from "./renderPool";

/** The minimal Worker surface the renderer uses, so tests can inject a fake. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface ElevationRenderer {
  /**
   * Render tiled across the pool, calling `onTile` per finished tile so the
   * caller can paint progressively. Resolves true when every tile landed, false
   * when a newer render superseded this one.
   */
  render(req: Omit<ElevationRenderRequest, "id">, onTile: (t: TilePaint) => void): Promise<boolean>;
  dispose(): void;
}

/** Square tile edge in pixels. 128 gives 64 tiles at the fixed 1024px preview. */
export const DEFAULT_TILE_SIZE = 128;

/**
 * One worker per core, less one so the main thread stays free to blit tiles and
 * keep the UI responsive. Falls back to 4 cores when the browser will not say.
 *
 * `cores` is a required parameter rather than a defaulted one: passing
 * `undefined` to a defaulted parameter silently re-applies the default, which
 * would make the fallback untestable.
 */
export function defaultPoolSize(cores: number | undefined): number {
  return Math.max(1, (cores ?? 4) - 1);
}

function createRenderWorker(): WorkerLike {
  // A real Worker's onerror is ((ev: ErrorEvent) => any) | null, narrower than
  // WorkerLike's ((e: unknown) => void) | null (kept broad so tests can invoke
  // it with any value) - the real Worker structurally provides everything
  // WorkerLike needs, so assert the narrowing here rather than loosen the type.
  const worker = new Worker(
    new URL("../noise/preview/elevationRender.worker.ts", import.meta.url),
    { type: "module" },
  ) as unknown as WorkerLike;

  // Hand the worker the compiled Rust engine as soon as it is available (#223).
  // `loadEngineModule` memoises, so N workers cost ONE compile - a
  // `WebAssembly.Module` is structured-cloneable, which is the whole reason the
  // main thread compiles and the workers only instantiate.
  //
  // **This lives in the real worker factory rather than in `createWorkerHost`,
  // and that is deliberate.** The host is constructed with a fake factory by
  // every test that exercises it, and fetching from there made those tests
  // print a page of `ECONNREFUSED` while still passing - the module URL under
  // vitest points at a dev server that is not running. Loading beside the real
  // `new Worker` means only the real browser path ever reaches the network.
  //
  // **A render dispatched before the engine arrives is not a bug**, and that is
  // what makes this cutover safe rather than merely tested: the two render
  // paths are byte-identical, so a request that lands first takes the
  // TypeScript path and returns the same pixels. There is no window in which
  // the worker is wrong, only one in which it is slower - which is also why a
  // failed fetch or compile is swallowed. A missing `engine.wasm` costs speed,
  // not correctness.
  void loadEngineModule().then(
    (module) => {
      worker.postMessage({ kind: "engine", module });
    },
    () => {
      /* no engine; the TypeScript path renders exactly the same pixels */
    },
  );
  return worker;
}

/**
 * A pool of `size` workers - one per slot, created lazily on first use and
 * reused for the host's lifetime - dispatched by request id. Owns the worker
 * lifecycle and id-keyed reply routing only; no tiling or supersede semantics,
 * so a second consumer that isn't a tiled renderer can share it.
 */
export interface WorkerHost {
  execute(req: ElevationRenderRequest, slot: number): Promise<ElevationRenderResult>;
  readonly size: number;
  dispose(): void;
}

/**
 * Own a pool of `size` workers - one per pool slot, created lazily on first use
 * and reused for the host's lifetime. Lifecycle-free; callers own dispose().
 */
export function createWorkerHost(
  createWorker: () => WorkerLike = createRenderWorker,
  size: number = defaultPoolSize(
    typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
  ),
): WorkerHost {
  const workers: (WorkerLike | null)[] = Array.from({ length: size }, () => null);

  // Keyed by request id, NOT by slot. A slot can legitimately hold two in-flight
  // tiles at once: when a new render supersedes an older one, the older tile is
  // still awaiting its worker while the newer tile is dispatched into the same
  // slot. A one-entry-per-slot map would overwrite the older tile's resolver,
  // stranding its promise forever so the superseded render never settles and the
  // panel sticks on "Rendering..." - a real hang, found in review. A worker
  // handles its messages in order, so both entries resolve in turn.
  const pending = new Map<
    number,
    { slot: number; resolve: (r: ElevationRenderResult) => void; reject: (e: unknown) => void }
  >();

  // Collect first, then settle: rejecting inside the loop would mutate `pending`
  // while iterating it.
  function rejectSlot(slot: number, message: string) {
    const doomed: { id: number; reject: (e: unknown) => void }[] = [];
    for (const [id, entry] of pending) {
      if (entry.slot === slot) doomed.push({ id, reject: entry.reject });
    }
    for (const { id, reject } of doomed) {
      pending.delete(id);
      reject(new Error(message));
    }
  }

  function dropWorker(slot: number) {
    const w = workers[slot];
    workers[slot] = null;
    if (w) w.terminate();
  }

  function ensureWorker(slot: number): WorkerLike {
    const existing = workers[slot];
    if (existing) return existing;
    const w = createWorker();
    w.onmessage = (e: MessageEvent) => {
      const result = e.data as ElevationRenderResult;
      const entry = pending.get(result.id);
      // An id with no pending entry is a reply to an already-settled request.
      if (!entry) return;
      pending.delete(result.id);
      entry.resolve(result);
    };
    // A worker crash would otherwise leave its tiles' promises pending forever.
    // Every tile this slot holds fails, not just the newest.
    w.onerror = () => {
      dropWorker(slot);
      rejectSlot(slot, "Elevation render worker error");
    };
    workers[slot] = w;
    return w;
  }

  return {
    size,
    execute: (req, slot) =>
      new Promise<ElevationRenderResult>((resolve, reject) => {
        pending.set(req.id, { slot, resolve, reject });
        ensureWorker(slot).postMessage(req);
      }),
    dispose() {
      for (let slot = 0; slot < size; slot++) {
        dropWorker(slot);
        rejectSlot(slot, "Elevation renderer disposed");
      }
    },
  };
}

/**
 * Own a pool of `size` workers and drive them through a RenderPool - the
 * tiling queue and supersede-on-new-render semantics layered on top of a
 * WorkerHost. Lifecycle-free; callers own dispose().
 */
export function createElevationRenderer(
  createWorker: () => WorkerLike = createRenderWorker,
  size: number = defaultPoolSize(
    typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
  ),
  tileSize: number = DEFAULT_TILE_SIZE,
): ElevationRenderer {
  const host = createWorkerHost(createWorker, size);
  const pool: RenderPool = createRenderPool({
    size,
    tileSize,
    execute: (req, slot) => host.execute(req, slot),
  });

  return {
    render: (req, onTile) => pool.render(req, onTile),
    dispose() {
      pool.dispose();
      host.dispose();
    },
  };
}

/** Vue composable: a renderer auto-disposed when the calling component unmounts. */
export function useElevationPreview(
  createWorker: () => WorkerLike = createRenderWorker,
): ElevationRenderer {
  const renderer = createElevationRenderer(createWorker);
  onBeforeUnmount(() => renderer.dispose());
  return renderer;
}
