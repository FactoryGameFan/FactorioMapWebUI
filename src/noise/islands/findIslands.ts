/**
 * The island finder's orchestrator: survey, measure coarsely, refine the best,
 * then group into chains.
 *
 * Two constants carry the whole cost model, both measured in a real browser
 * Worker against a production build (spec section 2b):
 *
 * - Every request uses `view: "terrain"`. `"all"` adds the scrap overlay, whose
 *   placement roll iterates TILES rather than pixels, so a coarse render still
 *   pays the full tile cost - 5,537 ms against 49 ms for the same window, 112x.
 *   Nothing in the types prevents someone changing this; `findIslands.spec.ts`
 *   asserts it directly.
 * - Refinement runs at 2 tiles/px, not 1. Full resolution costs about 14s
 *   pooled against 4s, to sharpen a rectangle edge by one tile - on a renderer
 *   whose own land boundary is only good to about a tile.
 */
import { largestRectangle, type Rect } from "./largestRectangle";
import { surveyIslands, type IslandCandidate } from "./cellSurvey";
import { floodFillFrom, landMaskFromImage } from "./islandMask";
import { chainComponents, type PlacedMask } from "./chainGraph";
import type { FulgoraCtx } from "../expressions/fulgoraShared";
import type {
  ElevationRenderRequest,
  ElevationRenderResult,
} from "../preview/elevationRenderRequest";

export const COARSE_TILES_PER_PIXEL = 8;
export const REFINE_TILES_PER_PIXEL = 2;
export const DEFAULT_REFINE_COUNT = 50;

/** Padding around a candidate's sample bounding box, in tiles. */
const WINDOW_PAD_TILES = 32;

export interface IslandResult extends IslandCandidate {
  readonly rect: Rect;
  readonly rectTiles: { readonly width: number; readonly height: number };
  readonly landTiles: number;
  readonly refined: boolean;
  readonly chainId: number;
  readonly distanceFromSpawn: number;
}

export interface FindOptions {
  readonly ctx: FulgoraCtx;
  /** Half-width of the search box, in tiles. */
  readonly radius: number;
  /** Same shape as `WorkerHost.execute` (Task 4), so it passes straight through. */
  readonly execute: (req: ElevationRenderRequest, slot: number) => Promise<ElevationRenderResult>;
  readonly concurrency: number;
  readonly refineCount?: number;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

interface Measured {
  readonly candidate: IslandCandidate;
  readonly rect: Rect;
  readonly landTiles: number;
  readonly placed: PlacedMask;
  readonly refined: boolean;
}

function windowFor(c: IslandCandidate, tpp: number) {
  const originX = c.minX - WINDOW_PAD_TILES;
  const originY = c.minY - WINDOW_PAD_TILES;
  const tilesW = c.maxX - c.minX + WINDOW_PAD_TILES * 2;
  const tilesH = c.maxY - c.minY + WINDOW_PAD_TILES * 2;
  return {
    originX,
    originY,
    width: Math.max(1, Math.ceil(tilesW / tpp)),
    height: Math.max(1, Math.ceil(tilesH / tpp)),
  };
}

/**
 * The nearest land pixel to `(sx, sy)` in `mask`, by Chebyshev distance,
 * searching outward ring by ring across the whole window. Undefined if the
 * window has no land pixel at all.
 *
 * Bounded by the window itself (already bounded by `WINDOW_PAD_TILES`) rather
 * than a fixed pixel count: a fixed radius in PIXELS covers a different
 * number of TILES at each `tpp`, so a radius sized for the coarse pass (8
 * tiles/px) would cover 4x fewer tiles at the refine pass (2 tiles/px) -
 * exactly backwards, since the refine window is the one where a seed miss
 * needs the wider search.
 */
function nearestLandPixel(
  mask: Uint8Array,
  width: number,
  height: number,
  sx: number,
  sy: number,
): { x: number; y: number } | undefined {
  if (sx >= 0 && sy >= 0 && sx < width && sy < height && mask[sy * width + sx]) {
    return { x: sx, y: sy };
  }
  const maxR = Math.max(width, height);
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (mask[y * width + x]) return { x, y };
      }
    }
  }
  return undefined;
}

async function measure(
  c: IslandCandidate,
  tpp: number,
  ctx: FulgoraCtx,
  execute: FindOptions["execute"],
  id: number,
  slot: number,
  refined: boolean,
): Promise<Measured> {
  const win = windowFor(c, tpp);
  const res = await execute(
    {
      id,
      seed0: ctx.seed0,
      planet: "fulgora",
      // Never "all" - see this module's header.
      view: "terrain",
      width: win.width,
      height: win.height,
      originX: win.originX,
      originY: win.originY,
      tilesPerPixel: tpp,
      fulgoraIslandControls: { frequency: ctx.islandsFrequency, size: ctx.islandsSize },
    } as unknown as ElevationRenderRequest,
    slot,
  );

  const rgba = new Uint8ClampedArray(res.buffer);
  const all = landMaskFromImage(rgba, win.width, win.height);
  const seedPx = Math.round((c.centroidX - win.originX) / tpp);
  const seedPy = Math.round((c.centroidY - win.originY) / tpp);
  // Task 3's ruling guarantees the centroid names a WORLD position that
  // belongs to a non-ocean Voronoi cell - it does NOT guarantee the rendered
  // TILE at that position is land. Those are different questions: cell
  // classification says what kind of terrain this region would grow, actual
  // per-tile elevation decides whether any given point ends up land or water,
  // and a cell can render mostly water near its own boundary. Measured
  // directly on radius 600 / SEED0: rounding the centroid to a pixel and
  // flood-filling from it landed on ocean for several real candidates, one of
  // which only flipped from land (coarse) to ocean (refine) because the two
  // passes round to different world positions. `nearestLandPixel` searches
  // outward for the closest actual land pixel in the window instead of
  // trusting the raw rounded seed; `undefined` means the window - already
  // padded by `WINDOW_PAD_TILES` - has no land at all, which `findIslands`
  // treats as "not a real island" and drops.
  const seed = nearestLandPixel(all, win.width, win.height, seedPx, seedPy);
  const mine =
    seed === undefined
      ? new Uint8Array(win.width * win.height)
      : floodFillFrom(all, win.width, win.height, seed.x, seed.y);

  let landPx = 0;
  for (let i = 0; i < mine.length; i++) if (mine[i]) landPx++;

  return {
    candidate: c,
    rect: largestRectangle(mine, win.width, win.height),
    landTiles: landPx * tpp * tpp,
    placed: {
      mask: mine,
      width: win.width,
      height: win.height,
      originX: win.originX,
      originY: win.originY,
      tilesPerPixel: tpp,
    },
    refined,
  };
}

/**
 * Run `jobs` with at most `limit` in flight, stopping early if aborted.
 *
 * Each runner keeps a FIXED slot for its whole life and passes it to the job.
 * That is what pins one runner to one worker in `WorkerHost`; handing out a
 * rotating slot would let two in-flight jobs land on the same worker while
 * another sat idle.
 */
async function pooled<T>(
  jobs: readonly ((slot: number) => Promise<T>)[],
  limit: number,
  signal: AbortSignal | undefined,
  onDone: () => void,
): Promise<T[]> {
  const out: (T | undefined)[] = Array.from({ length: jobs.length });
  let next = 0;
  const runners = Array.from({ length: Math.max(1, limit) }, async (_unused, slot) => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await (jobs[i] as (s: number) => Promise<T>)(slot);
      onDone();
    }
  });
  await Promise.all(runners);
  return out.filter((v): v is T => v !== undefined);
}

export async function findIslands(opts: FindOptions): Promise<IslandResult[]> {
  const { ctx, radius, execute, concurrency, signal } = opts;
  const refineCount = opts.refineCount ?? DEFAULT_REFINE_COUNT;

  const candidates = surveyIslands(ctx, {
    x0: -radius,
    y0: -radius,
    x1: radius,
    y1: radius,
  });

  const total = candidates.length + Math.min(refineCount, candidates.length);
  let done = 0;
  const tick = () => opts.onProgress?.(++done, total);

  let id = 1;
  const coarseAll = await pooled(
    candidates.map(
      (c) => (slot: number) => measure(c, COARSE_TILES_PER_PIXEL, ctx, execute, id++, slot, false),
    ),
    concurrency,
    signal,
    tick,
  );

  // A cell's Voronoi id can classify it as non-ocean (mesa/sprawl/vault) while
  // the window around this particular sampled point still renders zero land
  // pixels - most often a single-sample sliver caught right at the search
  // box's own edge, whose real coastline sits elsewhere in the cell. That is
  // not a real island, so it is dropped here rather than carried through
  // refinement and into the final list. Measured on radius 600 / SEED0: 7 of
  // 41 coarse candidates were exactly this, all with sampleCount 1-37 and a
  // bounding box touching the box boundary.
  const coarse = coarseAll.filter((m) => m.landTiles > 0);

  const byArea = [...coarse].sort(
    (a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height,
  );
  const toRefine = byArea.slice(0, refineCount);
  const refined = await pooled(
    toRefine.map(
      (m) => (slot: number) =>
        measure(m.candidate, REFINE_TILES_PER_PIXEL, ctx, execute, id++, slot, true),
    ),
    concurrency,
    signal,
    tick,
  );

  // Refined rows replace their coarse counterparts, keyed by the STABLE cell
  // index rather than by list position, which the sort above has shuffled.
  const merged = new Map<string, Measured>();
  for (const m of coarse) merged.set(`${m.candidate.cellX},${m.candidate.cellY}`, m);
  for (const m of refined) merged.set(`${m.candidate.cellX},${m.candidate.cellY}`, m);

  // A candidate that still measures zero land after `nearestLandPixel` -
  // coarse or refined - is not a real island: its cell's Voronoi id classified
  // it as non-ocean, but no actual land tile exists anywhere in its rendered
  // window. Filtered here (not just after the coarse pass above) because
  // refinement can occasionally flip a marginal coarse hit to zero too - the
  // finer window samples a different rounded position, and the land it found
  // coarsely turns out to have been outside the refine window's own reach.
  const finals = [...merged.values()].filter((m) => m.landTiles > 0);
  const chains = chainComponents(finals.map((m) => m.placed));

  const results: IslandResult[] = finals.map((m, i) => ({
    ...m.candidate,
    rect: m.rect,
    rectTiles: {
      width: m.rect.width * m.placed.tilesPerPixel,
      height: m.rect.height * m.placed.tilesPerPixel,
    },
    landTiles: m.landTiles,
    refined: m.refined,
    chainId: chains[i] as number,
    distanceFromSpawn: Math.hypot(m.candidate.centroidX, m.candidate.centroidY),
  }));

  results.sort(
    (a, b) => b.rectTiles.width * b.rectTiles.height - a.rectTiles.width * a.rectTiles.height,
  );
  if (done < total) opts.onProgress?.(total, total);
  return results;
}
