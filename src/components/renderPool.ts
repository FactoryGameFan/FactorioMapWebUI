/**
 * Concurrency for the region-tiled renderer: plan a render into tiles, keep at
 * most `size` of them in flight, and hand each finished tile to `onTile` so the
 * caller can paint it immediately.
 *
 * `execute` is the seam. In the app it posts to one of `size` Web Workers (the
 * `slot` argument says which); in tests it calls `runRenderRequest` in-process,
 * which is what lets the tiled-equals-untiled gate run in Node with no Workers.
 */
import type { ImageBox, TileBox } from "../noise/preview/tiling";
import type {
  ElevationRenderRequest,
  ElevationRenderResult,
} from "../noise/preview/elevationRenderRequest";

/** A finished tile, positioned within the full image. */
export interface TilePaint {
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
  readonly buffer: ArrayBuffer;
}

export interface RenderPoolOptions {
  /** Maximum tiles in flight at once. */
  readonly size: number;
  /**
   * Cut the full image into the tiles this pool dispatches, in the order they
   * are handed out. `planTiles` (square tiles) and `planTileGrid` (a grid
   * sized to the pool) both fit; the app picks with `planForPool`.
   */
  readonly plan: (full: ImageBox) => readonly TileBox[];
  readonly execute: (req: ElevationRenderRequest, slot: number) => Promise<ElevationRenderResult>;
}

export interface RenderPool {
  /**
   * Render `req` as tiles, calling `onTile` per finished tile. Resolves true
   * when every tile was painted, false when a newer render (or `dispose`)
   * superseded this one. Rejects if any tile fails.
   */
  render(req: Omit<ElevationRenderRequest, "id">, onTile: (t: TilePaint) => void): Promise<boolean>;
  dispose(): void;
}

export function createRenderPool(opts: RenderPoolOptions): RenderPool {
  // Without this, size 0 would dispatch nothing and silently resolve false -
  // a render that looks superseded rather than misconfigured.
  if (!(opts.size > 0)) throw new Error("createRenderPool: size must be positive");

  // Bumped by every new render and by dispose(); slots of an older generation
  // stop dispatching and their results are dropped, so a superseded render can
  // never paint over a newer one.
  let generation = 0;
  let nextId = 1;

  return {
    async render(req, onTile) {
      const gen = ++generation;
      const full: ImageBox = {
        originX: req.originX,
        originY: req.originY,
        width: req.width,
        height: req.height,
        tilesPerPixel: req.tilesPerPixel,
      };
      const fullImage = {
        originX: full.originX,
        originY: full.originY,
        width: full.width,
        height: full.height,
      };
      const queue = opts.plan(full);

      let next = 0;
      let painted = 0;
      let aborted = false;

      const runSlot = async (slot: number): Promise<void> => {
        for (;;) {
          if (aborted || gen !== generation) return;
          const tile = queue[next++];
          if (!tile) return;
          const result = await opts.execute(
            {
              ...req,
              id: nextId++,
              originX: tile.originX,
              originY: tile.originY,
              width: tile.width,
              height: tile.height,
              fullImage,
            },
            slot,
          );
          if (aborted || gen !== generation) return;
          onTile({
            dx: tile.dx,
            dy: tile.dy,
            width: tile.width,
            height: tile.height,
            buffer: result.buffer,
          });
          painted++;
        }
      };

      // Promise.all attaches a handler to every slot, so a second failure after
      // the first cannot surface as an unhandled rejection.
      await Promise.all(
        Array.from({ length: Math.min(opts.size, queue.length) }, (_, i) =>
          runSlot(i).catch((e: unknown) => {
            aborted = true;
            throw e;
          }),
        ),
      );
      return painted === queue.length;
    },

    dispose() {
      generation++;
    },
  };
}
