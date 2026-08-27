import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkerHost, type WorkerLike } from "../src/components/useElevationPreview";
import type { ElevationRenderRequest } from "../src/noise/preview/elevationRenderRequest";

/** A fake worker that echoes the request id back after a tick. */
function fakeWorker(): WorkerLike & { posted: ElevationRenderRequest[] } {
  const w = {
    posted: [] as ElevationRenderRequest[],
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    postMessage(req: ElevationRenderRequest) {
      w.posted.push(req);
      queueMicrotask(() =>
        w.onmessage?.({ data: { id: req.id, width: 1, height: 1, buffer: new ArrayBuffer(4) } }),
      );
    },
    terminate: vi.fn(),
  };
  return w as unknown as WorkerLike & { posted: ElevationRenderRequest[] };
}

const req = (id: number): ElevationRenderRequest =>
  ({
    id,
    seed0: 1,
    width: 1,
    height: 1,
    originX: 0,
    originY: 0,
    tilesPerPixel: 1,
  }) as ElevationRenderRequest;

describe("createWorkerHost", () => {
  it("routes each response to the request that asked for it, even out of order", async () => {
    const host = createWorkerHost(() => fakeWorker(), 2);
    const [a, b] = await Promise.all([host.execute(req(1), 0), host.execute(req(2), 1)]);
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    host.dispose();
  });

  it("reuses one worker per slot rather than creating one per request", async () => {
    const made: WorkerLike[] = [];
    const host = createWorkerHost(() => {
      const w = fakeWorker();
      made.push(w);
      return w;
    }, 2);
    await host.execute(req(1), 0);
    await host.execute(req(2), 0);
    await host.execute(req(3), 0);
    expect(made.length).toBe(1);
    host.dispose();
  });

  it("rejects the one request when the worker reports an engine failure", async () => {
    // #227: with the TypeScript math gone, a worker that cannot instantiate the
    // engine posts `{ id, error }` instead of a result. The host must REJECT
    // that id - resolving it would hand the panel an object with no `buffer`
    // and fail later, somewhere that does not name the cause.
    const failing = (): WorkerLike => {
      const w = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        onerror: null as ((e: unknown) => void) | null,
        postMessage(r: ElevationRenderRequest) {
          queueMicrotask(() => w.onmessage?.({ data: { id: r.id, error: "engine is broken" } }));
        },
        terminate: vi.fn(),
      };
      return w as unknown as WorkerLike;
    };
    const host = createWorkerHost(failing, 1);
    await expect(host.execute(req(1), 0)).rejects.toThrow("engine is broken");

    // The worker is NOT dropped: the failure is the module, so a replacement
    // would fail identically. A later request reaches the same worker and gets
    // the same answer rather than hanging.
    await expect(host.execute(req(2), 0)).rejects.toThrow("engine is broken");
  });

  it("terminates its workers on dispose", async () => {
    const made: (WorkerLike & { terminate: ReturnType<typeof vi.fn> })[] = [];
    const host = createWorkerHost(() => {
      const w = fakeWorker() as unknown as WorkerLike & { terminate: ReturnType<typeof vi.fn> };
      made.push(w);
      return w;
    }, 1);
    await host.execute(req(1), 0);
    host.dispose();
    expect(made[0]!.terminate).toHaveBeenCalled();
  });
});
