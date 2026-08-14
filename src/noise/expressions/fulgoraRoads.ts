/**
 * Fulgora's road and structure layer - the Voronoi grids that lay out the
 * ruined city, and the four paving stages built on them.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 403-512.
 *
 * The shape: two more Voronoi tilings on top of the island tiling, one at a
 * third of the island grid for the main roads and one at an eighth for
 * individual structure blocks. `road_cells` gives each road block an id that
 * picks WHICH of three small-road patterns fills it, and the paving stages
 * composite the patterns, then cut structure blocks and district centres back
 * out.
 *
 * Two things here are easy to get wrong by reading:
 *
 * 1. **`structure_cells` and `structure_facets` are sampled at `y * 0.8`**, not
 *    at `y`. The stretch is in the Lua call, not in the grid size.
 * 2. **`structure_subnoise` reads `x + 10000 * structure_cells`, and the
 *    MULTIPLY itself must be rounded to f32**, not just the coordinate that
 *    reaches `multioctave_noise`. Narrowing only where the sum crosses into
 *    `makeMultioctaveNoise` (which itself narrows incoming coordinates as of
 *    #190) is a different, coarser rounding than the game performs, and at
 *    this field's coordinate magnitudes (up to ~17460, where one f32 ULP is
 *    2.08e-3) the two disagree by a lot. Measured over the 101-position
 *    fixture: narrowing only the sum misses by 3.91e-5; narrowing the product
 *    (`x + f32(10000 * structure_cells)`) drops that to 2.98e-7 - a 131x
 *    improvement, and back in line with this field's continuous siblings. Do
 *    not "simplify" this back to narrowing the sum alone.
 *
 * These two are the port's worked examples of the same rule, and they need
 * OPPOSITE fixes - one narrows the product, the other narrows the constant.
 * The general rule, and why applying the wrong one silently fixes nothing,
 * lives in `src/noise/eval/f32.ts`. Read that before chasing an f32 residual
 * anywhere else in this port.
 */
import { f32 } from "../eval/f32";
import { lerp } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import { makeVoronoi, type Voronoi } from "../voronoiNoise";
import type { FulgoraCells } from "./fulgoraCells";
import type { FulgoraCtx, FulgoraShared } from "./fulgoraShared";

/**
 * `seed1` values, computed with `crc32` from `src/codec/crc32.ts` over the UTF-8
 * bytes of the name in the Lua, never guessed. Note `structure_facets` uses the
 * string `'fulgora_structure_cells'` - it is the SAME field read through a
 * different op, exactly as `pyramids` shares `cells`' seed in `fulgoraCells.ts`.
 */
const SEED1_ROAD_CELLS = 2103387040; // crc32("fulgora_road_cells") = 0x7D5F23A0
const SEED1_STRUCTURE_CELLS = 2736009210; // crc32("fulgora_structure_cells") = 0xA3142FFA
const SEED1_STRUCTURE_SUBNOISE = 1886976824; // crc32("fulgora_structure_subnoise") = 0x7078FB38

/** `fulgora_road_jitter` and `fulgora_structure_jitter` - named constants in the Lua. */
const ROAD_JITTER = 1;
const STRUCTURE_JITTER = 0.8;

/** A comparison yields 1 or 0, matching the engine's boolean-to-number convention. */
const gt = (a: number, b: number): number => (a > b ? 1 : 0);
const lt = (a: number, b: number): number => (a < b ? 1 : 0);

export interface FulgoraRoads {
  readonly roadCells: (x: number, y: number) => number;
  readonly roadPyramids: (x: number, y: number) => number;
  readonly pyramidsBanding: (x: number, y: number) => number;
  readonly spotsPrebanding: (x: number, y: number) => number;
  readonly spotsBanding: (x: number, y: number) => number;
  readonly structureCells: (x: number, y: number) => number;
  readonly structureSubnoise: (x: number, y: number) => number;
  readonly structureFacets: (x: number, y: number) => number;
  readonly roadPavingThin: (x: number, y: number) => number;
  readonly roadPaving2: (x: number, y: number) => number;
  readonly roadPaving2b: (x: number, y: number) => number;
  readonly roadPaving2c: (x: number, y: number) => number;
  readonly roadDust: (x: number, y: number) => number;
}

export function makeFulgoraRoads(
  shared: FulgoraShared,
  cells: FulgoraCells,
  ctx: FulgoraCtx,
): FulgoraRoads {
  const seed0 = ctx.seed0;
  const grid = shared.grid;

  // One instance per field, two ops each - same reasoning as `fulgoraCells.ts`.
  const road: Voronoi = makeVoronoi({
    seed0,
    seed1: SEED1_ROAD_CELLS,
    gridSize: grid / 3,
    distanceType: "chebyshev",
    jitter: ROAD_JITTER,
  });
  const structure: Voronoi = makeVoronoi({
    seed0,
    seed1: SEED1_STRUCTURE_CELLS,
    gridSize: grid / 8,
    distanceType: "minkowski3",
    jitter: STRUCTURE_JITTER,
  });
  const subnoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_STRUCTURE_SUBNOISE,
    octaves: 3,
    persistence: 0.7,
    inputScale: 1 / 12,
    outputScale: 1,
  });

  const roadCells = memoXY((x: number, y: number) => road.cellId(x, y));
  const roadPyramids = memoXY((x: number, y: number) => road.pyramidNoise(x, y));

  // `0.8` must be narrowed to f32 BEFORE the multiply, not after: the engine's
  // own `0.8` literal is f32 (0.80000001192092895508), not f64
  // (0.80000000000000004441), and those are different numbers. Measured over
  // the 101-position fixture, `structureFacets` worst residual: `y * 0.8`
  // 7.629e-6; `f32(y * 0.8)` (narrowing the product) still 7.629e-6, no help;
  // `y * f32(0.8)` (narrowing the constant) exactly 0. Do not "simplify" this
  // back to a bare `0.8` literal or to narrowing the product instead.
  const structureCells = memoXY((x: number, y: number) => structure.cellId(x, y * f32(0.8)));
  const structureFacets = memoXY((x: number, y: number) => structure.facetNoise(x, y * f32(0.8)));
  // The multiply is narrowed to f32 on its own, matching the engine's
  // per-op f32 evaluation - see the file header for why narrowing only the
  // sum (which `makeMultioctaveNoise` already does internally) is not enough.
  const structureSubnoise = memoXY((x: number, y: number) =>
    subnoise(x + f32(10000 * structureCells(x, y)), y),
  );

  const pyramidsBanding = memoXY((x: number, y: number) => (cells.pyramids(x, y) * 8) % 1);
  const spotsPrebanding = memoXY(
    (x: number, y: number) =>
      Math.min(cells.spots(x, y), (1 - shared.startingVaultCone(x, y)) / 2) * 9 + 0.5,
  );
  const spotsBanding = memoXY((x: number, y: number) => spotsPrebanding(x, y) % 1);

  const roadPavingThin = memoXY((x: number, y: number) =>
    Math.max(lt(roadPyramids(x, y), 0.03) * 0.9, lt(structureFacets(x, y), 0.06) * 0.5),
  );

  const roadPaving2 = memoXY((x: number, y: number) => {
    const rc = roadCells(x, y);
    return Math.max(
      lt(roadPyramids(x, y), 0.05) * 0.9,
      lt(pyramidsBanding(x, y), 0.1) * 0.85 * lt(rc, 0.6) * gt(rc, 0.25),
      lt(spotsBanding(x, y), 0.1) * 0.85 * lt(rc, 0.25),
      lt(structureFacets(x, y), 0.1) * 0.85 * gt(rc, 0.6),
    );
  });

  const roadPaving2b = memoXY((x: number, y: number) =>
    lerp(roadPaving2(x, y), lt(structureFacets(x, y), 0.2) * 0.9, gt(structureCells(x, y), 0.8)),
  );

  const roadPaving2c = memoXY((x: number, y: number) => {
    const sp = spotsPrebanding(x, y);
    return lerp(roadPaving2b(x, y), gt(sp, 1) * 0.9, lt(sp, 1.3));
  });

  const roadDust = memoXY(
    (x: number, y: number) => lt(roadPyramids(x, y), 0.08) * 0.9 - roadPaving2c(x, y),
  );

  return {
    roadCells,
    roadPyramids,
    pyramidsBanding,
    spotsPrebanding,
    spotsBanding,
    structureCells,
    structureSubnoise,
    structureFacets,
    roadPavingThin,
    roadPaving2,
    roadPaving2b,
    roadPaving2c,
    roadDust,
  };
}
