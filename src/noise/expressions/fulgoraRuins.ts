/**
 * Fulgora's ruins layer - two noise fields and the four expressions that decide
 * which artificial tile a position gets.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 383-402 (the two noise fields) and 539-578 (the four outputs).
 *
 * Each of the four is a probability, fed straight to a tile's
 * `probability_expression`, so they are compared against each other and against
 * the four natural tiles by the argmax in `fulgoraCatalog.ts` - not thresholded
 * here.
 *
 * `paving` and `walls` each have TWO terms under a `max`: one gated by
 * `natural_and_mesa_mask` (ruins scattered on natural ground) and one gated by
 * `artificial_mask` (the built city). `conduit` and `machinery` have only the
 * artificial term, and both subtract `road_paving_2c` a SECOND time outside the
 * mask product - so they go negative on open ground rather than to zero.
 */
import { memoXY } from "../eval/memoXY";
import { f32 } from "../eval/f32";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import type { FulgoraCells } from "./fulgoraCells";
import type { FulgoraCtx } from "./fulgoraShared";
import type { FulgoraMasks } from "./fulgoraMasks";
import type { FulgoraRoads } from "./fulgoraRoads";

const SEED1_RUINS_WALLS = 2307136174; // crc32("fulgora_ruins_walls") = 0x89841AAE
const SEED1_RUINS_PAVING = 3946133559; // crc32("fulgora_ruins_paving") = 0xEB353837

export interface FulgoraRuins {
  /** `0.66 - abs(multioctave)` - ridged, same shape as `fulgora_dunes`. */
  readonly ruinsWalls: (x: number, y: number) => number;
  /** `abs(multioctave)` - billows, no offset. */
  readonly ruinsPaving: (x: number, y: number) => number;
  readonly tileRuinPaving: (x: number, y: number) => number;
  readonly tileRuinWalls: (x: number, y: number) => number;
  readonly tileRuinConduit: (x: number, y: number) => number;
  readonly tileRuinMachinery: (x: number, y: number) => number;
}

export function makeFulgoraRuins(
  cells: FulgoraCells,
  masks: FulgoraMasks,
  roads: FulgoraRoads,
  ctx: FulgoraCtx,
): FulgoraRuins {
  const seed0 = ctx.seed0;

  const wallsNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_RUINS_WALLS,
    octaves: 3,
    persistence: 0.7,
    inputScale: 1 / 6,
    outputScale: 1,
  });
  const pavingNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_RUINS_PAVING,
    octaves: 3,
    persistence: 0.7,
    inputScale: 1 / 16,
    outputScale: 1,
  });

  // The same `0.66 - abs(v)` shape as `fulgora_dunes`, on a different seed, and
  // it failed the same way: 19/101 as an f64 literal, **101/101** narrowed, at
  // a residual of exactly 0. Two fields with one shape failing identically is
  // what turned #273 from three edits into a sweep of the whole chain.
  const ruinsWalls = memoXY((x: number, y: number) => f32(0.66) - Math.abs(wallsNoise(x, y)));
  const ruinsPaving = memoXY((x: number, y: number) => Math.abs(pavingNoise(x, y)));

  const tileRuinPaving = memoXY((x: number, y: number) =>
    Math.max(
      masks.naturalAndMesaMask(x, y) * (3 * ruinsPaving(x, y) * roads.roadPavingThin(x, y) - 0.5),
      masks.artificialMask(x, y) * (4 * roads.roadPaving2c(x, y) + ruinsPaving(x, y) - 1),
    ),
  );

  // Per-operation narrowing throughout, matching the engine's own evaluation
  // order: 88/101 -> **101/101** at a residual of exactly 0. Every constant here
  // (0.5, 0.25, 4, 2, 2.5) is already exact at f32, so this is case 1 only -
  // the rounding of the intermediates, not of any literal.
  const tileRuinWalls = memoXY((x: number, y: number) =>
    Math.max(
      f32(
        masks.naturalAndMesaMask(x, y) *
          f32(f32(f32(2 * ruinsWalls(x, y)) + ruinsPaving(x, y)) - 0.5),
      ),
      f32(
        masks.artificialMask(x, y) *
          f32(
            f32(
              f32(
                f32(f32(0.25 * ruinsWalls(x, y)) + f32(0.25 * roads.structureSubnoise(x, y))) -
                  f32(4 * roads.structureFacets(x, y)),
              ) - roads.roadPaving2c(x, y),
            ) + 2.5,
          ),
      ),
    ),
  );

  const tileRuinConduit = memoXY(
    (x: number, y: number) =>
      masks.artificialMask(x, y) *
        (ruinsWalls(x, y) +
          roads.structureSubnoise(x, y) +
          2 * roads.structureFacets(x, y) -
          roads.roadPaving2c(x, y) +
          0.2 +
          0.3 * cells.vaultsAndStartingVault(x, y)) -
      roads.roadPaving2c(x, y),
  );

  const tileRuinMachinery = memoXY(
    (x: number, y: number) =>
      masks.artificialMask(x, y) *
        (-ruinsWalls(x, y) +
          1.25 * roads.structureSubnoise(x, y) +
          2.5 * roads.structureFacets(x, y) -
          roads.roadPaving2c(x, y) -
          0.2 +
          0.3 * cells.vaultsAndStartingVault(x, y) +
          2 * (roads.spotsPrebanding(x, y) < 1 ? 1 : 0)) -
      roads.roadPaving2c(x, y),
  );

  return {
    ruinsWalls,
    ruinsPaving,
    tileRuinPaving,
    tileRuinWalls,
    tileRuinConduit,
    tileRuinMachinery,
  };
}
