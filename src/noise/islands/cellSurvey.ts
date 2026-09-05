/**
 * Stage 1 of the island finder: find WHERE the islands are, cheaply.
 *
 * Fulgora's map is a Voronoi tiling and every island is one cell (see
 * `crates/fmw-noise/src/expressions/fulgora_cells.rs`), so enumerating islands is enumerating cells rather than
 * flood-filling pixels. One `cells` evaluation costs about 2.33 us, against
 * about 48 us for a rendered pixel, so this stage is a rounding error in the
 * finder's total cost.
 *
 * The Voronoi is sampled through a coordinate warp with no analytic inverse, so
 * this does NOT invert the grid to find cell centres. It scans world positions
 * and groups them by the cell each one lands in.
 */
import type { FulgoraCtx } from "./surveyThroughWasm";
import type { EngineExports } from "../wasm/engine";
import { surveyCellsThroughWasm } from "./surveyThroughWasm";
import { bearingTrig } from "../wasm/request";

export type IslandClass = "mesa" | "sprawl" | "vault";

export interface IslandCandidate {
  readonly cellX: number;
  readonly cellY: number;
  /** The cell's `voronoi_cell_id`, in [0.33, 1). Below 0.33 is ocean. */
  readonly id: number;
  readonly klass: IslandClass;
  readonly sampleCount: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly centroidX: number;
  readonly centroidY: number;
}

export interface SearchBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Cells below this id become oil ocean - `fulgora_blanks` in the Lua. */
const OCEAN_BELOW = 0.33;

/**
 * The scan step, in tiles.
 *
 * `grid / 8` rather than a constant. A fixed 48-tile step averages only 2.6
 * samples across a cell at the smallest grid the Islands frequency slider
 * allows (125), and Manhattan Voronoi at jitter 0.6 produces cells noticeably
 * smaller than the grid - so small islands would fall between samples and never
 * be reported. A silent miss is the worst failure this tool can have, and the
 * whole stage costs well under a second, so there is nothing to economize.
 */
export function surveyStep(grid: number): number {
  return grid / 8;
}

function classify(id: number): IslandClass {
  if (id > 0.75) return "mesa";
  if (id > 0.5) return "sprawl";
  return "vault";
}

interface Acc {
  cellX: number;
  cellY: number;
  id: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
  /**
   * Every sample position that landed in this cell, so the centroid can be
   * chosen as one of THEM rather than their arithmetic mean - see the
   * comment on `centroidX`/`centroidY` below for why that distinction is
   * load-bearing rather than cosmetic.
   */
  points: { x: number; y: number }[];
}

export function surveyIslands(
  ctx: FulgoraCtx,
  box: SearchBox,
  engine: EngineExports,
  stepOverride?: number,
): IslandCandidate[] {
  const acc = new Map<string, Acc>();

  /**
   * Fold one swept position into the accumulator.
   *
   * This is the part that decides which cell a sample belongs to and what the
   * candidate's bounds and centroid are built from. It used to be shared by
   * the engine sweep and a TypeScript one, deliberately, so the two could not
   * drift while every value they read still matched; #371 removed the
   * TypeScript sweep and `test/surveyThroughWasm.spec.ts` grades what is left
   * against the list frozen while both agreed.
   */
  const fold = (x: number, y: number, id: number, cellX: number, cellY: number): void => {
    if (id < OCEAN_BELOW) return;
    const key = `${cellX},${cellY}`;
    const a = acc.get(key);
    if (a === undefined) {
      acc.set(key, {
        cellX,
        cellY,
        id,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
        sumX: x,
        sumY: y,
        points: [{ x, y }],
      });
    } else {
      if (x < a.minX) a.minX = x;
      if (x > a.maxX) a.maxX = x;
      if (y < a.minY) a.minY = y;
      if (y > a.maxY) a.maxY = y;
      a.sumX += x;
      a.sumY += y;
      a.points.push({ x, y });
    }
  };

  // The module does the whole sweep, and the step comes from the module too:
  // `surveyStep` is `grid / 8` and `grid` moves with `islandsFrequency`, so
  // deriving it here would need the Fulgora stack #371 deleted. Stage 1 is
  // 96.3% of the finder's cost, measured in Chrome, and this call is that
  // 96.3%.
  const trig = bearingTrig(ctx.seed0);
  const step =
    stepOverride ??
    engine.fulgora_survey_step(
      ctx.seed0,
      ctx.islandsFrequency ?? 1,
      ctx.islandsSize ?? 1,
      trig.sinStart,
      trig.cosStart,
      trig.sinVault,
      trig.cosVault,
    );
  surveyCellsThroughWasm(engine, ctx, box, step, fold);

  return [...acc.values()].map((a) => {
    const n = a.points.length;
    const meanX = a.sumX / n;
    const meanY = a.sumY / n;
    // The centroid is the SAMPLED position closest to the group's mean,
    // rather than the mean itself. The warp `wx`/`wy` applies is nonlinear,
    // so the region of raw (x, y) that lands in one warped Voronoi cell need
    // not be convex - the arithmetic mean of a handful of samples along a
    // curved or box-clipped edge can fall outside the cell it was computed
    // from, which re-reading `cells` at that point would then attribute to a
    // DIFFERENT island. A sampled point cannot have that problem: it already
    // proved membership by producing this exact `id` when it was scanned.
    let bestPoint = a.points[0] as { x: number; y: number };
    let bestDist = Infinity;
    for (const pt of a.points) {
      const dx = pt.x - meanX;
      const dy = pt.y - meanY;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestPoint = pt;
      }
    }
    return {
      cellX: a.cellX,
      cellY: a.cellY,
      id: a.id,
      klass: classify(a.id),
      sampleCount: n,
      minX: a.minX,
      minY: a.minY,
      maxX: a.maxX,
      maxY: a.maxY,
      centroidX: bestPoint.x,
      centroidY: bestPoint.y,
    };
  });
}
