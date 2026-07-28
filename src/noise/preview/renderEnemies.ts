/**
 * Composite the enemy-base overlay onto a terrain ImageData: sweep the same pixel
 * grid as renderTerrain/renderResources, roll the game's per-tile placement draw
 * against the spawner probability, and paint a `PLACEMENT_MARK_RADIUS_PX` (3x3)
 * mark in `ENEMY_MAP_COLOR` wherever it wins. Mutates `base` in place.
 *
 * This rolls rather than thresholds. The old render painted every pixel where
 * `enemy_base_probability` cleared a 0.05 footprint threshold, which drew the
 * *shape of a base's cone* rather than the spawners inside it. The game instead
 * rolls `U < probability` per tile (`docs/noise/placement-roll-NOTES.md`) subject
 * to two arbitration gates, and `makePlacementSet` reproduces all three.
 *
 * Unlike rocks, the mark stays 3x3: a spawner is a 7.4 x 6.4-tile entity and this
 * overlay places ~1 per 1700-10000 tiles, so a 1px dot would be invisible.
 * A 3x3 mark can spill across a worker-tile seam, so - exactly like cliffs and
 * like Vulcanus rocks before they went to 1x1 - the tiled renderer hands in a
 * halo-widened `sweepBox` (`elevationRenderRequest.ts`'s `placementMarkSweepBox`).
 * Without it `test/tiledEquality.spec.ts` fails at the seams.
 *
 * The water skip is now TWO separate things, and the distinction matters:
 *
 * - `tileAllowed` inside `makeNauvisEnemyPlacement` is the CORRECTNESS gate. It is
 *   derived from the ported tile resolver, so it is a pure function of world
 *   position - required, because the chunk resolver asks about tiles outside the
 *   render window where no pixel exists to read.
 * - the `isWater` pixel check passed to `paintMark` is only a PAINT guard, so the
 *   mark's outer ring does not spill red onto a lake the terrain already drew.
 */
import type { Point } from "../distanceFromNearestPoint";
import { makeEnemyBaseField } from "../enemies/enemyBaseField";
import {
  ENEMY_RANDOM_PENALTY_AMPLITUDE,
  ENEMY_SPAWNER_MAP_GEN_BOX,
  ENEMY_MAP_COLOR,
  type EnemyControls,
} from "../enemies/enemyCatalog";
import {
  PLACEMENT_MARK_RADIUS_PX,
  PLACEMENT_SALT,
  makePlacementRoll,
  makePlacementSet,
} from "../placement/placementRoll";
import { makeTileResolver } from "../tiles/resolve";
import { paintMark } from "./renderCliffs";
import { WATER_TILE_COLORS } from "./renderResources";

export interface RenderEnemiesOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  readonly controls: EnemyControls;
  /** Spawn points for `distance`. Default single origin spawn. */
  readonly startingPositions?: readonly Point[];
  /**
   * Climate/terrain params, threaded only into the water gate's tile resolver so
   * the gate agrees with the terrain the same request drew. All default to the
   * game's defaults.
   */
  readonly segmentationMultiplier?: number;
  readonly moistureFrequency?: number;
  readonly moistureBias?: number;
  readonly auxFrequency?: number;
  readonly auxBias?: number;
  readonly startingAreaMoistureSize?: number;
  readonly startingAreaMoistureFrequency?: number;
  /**
   * World box to sweep for roll hits. Defaults to this render's own pixel box.
   * The tiled renderer widens it by `PLACEMENT_MARK_RADIUS_PX` tiles (clamped to
   * the full image) so a hit centered just outside this tile still paints the
   * part of its mark that falls inside. `paintMark` clips to the pixel grid, so a
   * wider sweep can never paint outside this tile's own bounds.
   */
  readonly sweepBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

export interface NauvisEnemyPlacementParams {
  readonly seed0: number;
  readonly controls: EnemyControls;
  readonly startingPositions?: readonly Point[];
  readonly segmentationMultiplier?: number;
  readonly moistureFrequency?: number;
  readonly moistureBias?: number;
  readonly auxFrequency?: number;
  readonly auxBias?: number;
  readonly startingAreaMoistureSize?: number;
  readonly startingAreaMoistureFrequency?: number;
}

/**
 * The two tiles no spawner may sit on.
 *
 * Neither spawner declares a `tile_restriction`, and neither overrides
 * `collision_mask`; `type = "unit-spawner"` defaults to `building()`
 * (`core/lualib/collision-mask-defaults.lua:67`), which includes `water_tile`. So
 * the gate is "the tile is not water" - the same gate, from the same default, as
 * the Nauvis rocks overlay - and it is shared by both prototypes, which is the
 * precondition `resolveChunk`'s doc comment requires before a single
 * probability-then-restriction test may stand in for the game's
 * arbitrate-then-roll order.
 */
const WATER_TILE_NAMES = new Set(["water", "deepwater"]);

/**
 * The spawner GROUP's arbitrated probability at a tile: `max` over the two
 * spawners of `random_penalty{min(enemy_base_probability, 0.25), amplitude 0.1}`,
 * which is `source - 0.1 * min(U_biter, U_spitter)`, floored at 0.
 *
 * Exported so `test/entityDensity.spec.ts`'s ungated roll-vs-field-integral check
 * - the claim that holds independent of the two gates - integrates the same
 * field the renderer rolls against, rather than the un-penalised
 * `makeEnemyBaseField(...).probability`.
 *
 * See `makeNauvisEnemyPlacement` for where the penalty comes from and what
 * leaving it out measures.
 */
export function makeNauvisEnemyProbability(
  params: NauvisEnemyPlacementParams,
): (x: number, y: number) => number {
  const field = makeEnemyBaseField({
    seed0: params.seed0,
    controls: params.controls,
    startingPositions: params.startingPositions,
  });
  const biterPenalty = makePlacementRoll(PLACEMENT_SALT.enemyBiterPenalty);
  const spitterPenalty = makePlacementRoll(PLACEMENT_SALT.enemySpitterPenalty);
  // Floored at 0 because random_penalty can drive a small source negative, and a
  // negative probability simply never wins the roll.
  return (x, y) =>
    Math.max(
      0,
      field.probability(x, y) -
        ENEMY_RANDOM_PENALTY_AMPLITUDE * Math.min(biterPenalty(x, y), spitterPenalty(x, y)),
    );
}

/**
 * The shipped Nauvis enemy-base placement predicate: the roll against the
 * spawner group's probability, gated by the water restriction and by collision
 * against spawners already placed in the same chunk. Exported so
 * `test/entityDensity.spec.ts` measures the exact predicate the renderer paints.
 *
 * ## What the two spawners actually declare (from source, 2.1.12)
 *
 * | | biter-spawner | spitter-spawner |
 * | --- | --- | --- |
 * | autoplace | `enemy_autoplace_base(0, 6)` | `enemy_autoplace_base(0, 7)` |
 * | autoplace order | `b[enemy]-a[spawner]` | `b[enemy]-a[spawner]` |
 * | collision_box | 4.4 x 4.4 | 4.4 x 4.4 |
 * | map_generator_bounding_box | **7.4 x 6.4** | **7.4 x 6.4** |
 * | tile_restriction | none | none |
 * | collision_mask | `building()` default | `building()` default |
 *
 * **The argmax box question is fully degenerate here, and for the strongest
 * possible reason: the two prototypes declare the SAME box.** No rule - argmax,
 * uniform-biter, uniform-spitter - can differ. That is a different degeneracy
 * from the Nauvis rock one (three distinct boxes that happen to collapse onto the
 * same lattice neighbourhood) and from the Vulcanus one (an ordering theorem);
 * this overlay simply has one box. The live question was `collision_box` vs
 * `map_generator_bounding_box`, and the prototype API settles it: the latter is
 * "used instead of the collision box during map generation". Measurement agrees -
 * see the table below.
 *
 * ## The probability is NOT `enemy_base_probability`
 *
 * `enemy_autoplace_base(0, seed)` wraps `min(enemy_base_probability, 0.25)` in
 * `random_penalty{x = x + seed, amplitude = 0.1}`, so each spawner's probability
 * is `source - 0.1*U`, and the group's arbitrated winner is the max of the two,
 * i.e. `source - 0.1*min(U_biter, U_spitter)`.
 *
 * `random_penalty` is a batch op whose stream depends on the batch order
 * (`randomPenalty.ts`), so the two `U`s here are deterministic per-tile stand-ins
 * drawn from the same taus88 chunk machinery as the placement roll, under their
 * own salts. **The distribution is exact; the positional identity is not** - the
 * identical compromise `PLACEMENT_SALT` already documents. Positions were never
 * claimed to match; density is.
 *
 * ## Why the spawners are treated as a group of two, and worms are ignored
 *
 * `enemy_worm_autoplace` puts the four worms at order `b[enemy]-b[worm]` while
 * both spawners share `b[enemy]-a[spawner]`, and the notes' arbitration section
 * records that `generateEntities` processes autoplacers in groups sorted by a
 * name `memcmp`. Per-group arbitration is not merely convenient here, it is
 * FORCED by the fixture: `behemoth-worm-turret` is `enemy_autoplace_base(8, 5)`,
 * whose cap is `0.25 + 8*0.05 = 0.65` and whose multiplier at region 1's distance
 * (~5800 tiles) is `1 + 0.016*(5793 - 2646) = 51`, so a single GLOBAL
 * max-probability arbitration would hand essentially every enemy tile out there
 * to a behemoth worm and leave ~0 spawners. The game has 142. So the spawner
 * group arbitrates among its own two members, and this overlay models exactly
 * that.
 *
 * ## Measured, against `test/fixtures/oracle-entity-counts.seed123456.json`
 *
 * Factorio 2.1.12, seed 123456, `biter-spawner + spitter-spawner` summed:
 *
 * | variant | region 0 `[0,0]` (game 19) | region 1 `[4096,4096]` (game 142) |
 * | --- | --- | --- |
 * | bare roll, no gates, no penalty | 284 (1394.7%) | 7763 (5366.9%) |
 * | + water restriction only | 284 (1394.7%) | 1704 (1100.0%) |
 * | + collision only, map-gen box | 36 (89.5%) | 730 (414.1%) |
 * | + both gates, `collision_box` 4.4 x 4.4 | 61 (221.1%) | 290 (104.2%) |
 * | + both gates, map-gen box | 36 (89.5%) | 167 (17.6%) |
 * | **+ both gates, map-gen box, + penalty (shipped)** | **28 (47.4%)** | **157 (10.6%)** |
 *
 * Two things that table settles. The map-gen box beats the collision box in both
 * regions by a wide margin, confirming the API doc rather than assuming it. And
 * `random_penalty` removes 47% of region 0's overshoot (17 -> 9 spawners above the
 * game's 19) and 40% of region 1's (25 -> 15 above 142) - it is not a rounding
 * detail. Stated against the overshoot, in the same units as the "points" above,
 * because the count reduction (8/36 and 10/167, i.e. 22% and 6%) says nothing
 * about agreement.
 *
 * **The last row is salt-dependent and the spread is worth knowing before anyone
 * reads it as precise.** Re-running it over six different penalty salt pairs
 * gives 27-28 in region 0 (rel 0.42-0.47) and 149-157 in region 1 (rel
 * 0.049-0.106); the shipped pair happens to sit at the top of both ranges. The
 * band in `test/entityDensity.spec.ts` is pinned to the shipped constants, which
 * are fixed, so the test is deterministic - but every one of those six pairs
 * passes that band, so **a salt change is absorbed silently** even though it is a
 * real ~5-point move. The band has power over the physics, not over this choice.
 *
 * ## Region 0 is a STOP-AND-REPORT, not a passing region
 *
 * 47.4% is past this project's 0.3 report threshold and `test/entityDensity.spec.ts`
 * deliberately does NOT pin a `rel` band for it. The cause was measured, not
 * guessed: spawners sort at `b[enemy]-a[spawner]`, while trees (`a[tree]-...`)
 * and rocks (`a[landscape]-c[rock]-...`) sort BEFORE them, so under the same
 * per-group sequential processing that the worm argument above forces, trees and
 * rocks take their tiles first and a spawner's large box cannot fit beside them.
 * Sweeping this app's own tree density and rock placement over the two regions
 * and excluding the tiles they occupy:
 *
 * | | region 0 | region 1 |
 * | --- | --- | --- |
 * | area excluded by trees | 34.3% | 10.9% |
 * | area excluded by rocks | 3.8% | 1.3% |
 * | spawners with those blockers applied | 19 (0.0%) | 155 (9.2%) |
 *
 * So the residual is the forest, and it is ~3x larger in the near-spawn region
 * because that region is ~3x more wooded. Region 0 landing exactly on 19 is not
 * evidence of a precise model - the salt spread above is wider than that - but
 * the direction and the ~3x asymmetry are the point.
 *
 * This is NOT modelled here. Doing it means running a tree placement roll that
 * has never been validated against anything (the trees overlay renders expected
 * coverage and never places), inside the enemy chunk resolver, at roughly 2x the
 * current cost. That is a cross-overlay task, not a band.
 */
export function makeNauvisEnemyPlacement(
  params: NauvisEnemyPlacementParams,
): (x: number, y: number) => boolean {
  const tileAt = makeTileResolver({
    seed0: params.seed0,
    segmentationMultiplier: params.segmentationMultiplier,
    moistureFrequency: params.moistureFrequency,
    moistureBias: params.moistureBias,
    auxFrequency: params.auxFrequency,
    auxBias: params.auxBias,
    startingAreaMoistureSize: params.startingAreaMoistureSize,
    startingAreaMoistureFrequency: params.startingAreaMoistureFrequency,
    startingPositions: [...(params.startingPositions ?? [{ x: 0, y: 0 }])],
  });

  return makePlacementSet({
    salt: PLACEMENT_SALT.enemyBases,
    probability: makeNauvisEnemyProbability(params),
    tileAllowed: (x, y) => !WATER_TILE_NAMES.has(tileAt(x, y).name),
    collisionBox: () => ENEMY_SPAWNER_MAP_GEN_BOX,
  });
}

export function renderEnemies(base: ImageData, opts: RenderEnemiesOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const placed = makeNauvisEnemyPlacement({
    seed0: opts.seed0,
    controls: opts.controls,
    startingPositions: opts.startingPositions,
    segmentationMultiplier: opts.segmentationMultiplier,
    moistureFrequency: opts.moistureFrequency,
    moistureBias: opts.moistureBias,
    auxFrequency: opts.auxFrequency,
    auxBias: opts.auxBias,
    startingAreaMoistureSize: opts.startingAreaMoistureSize,
    startingAreaMoistureFrequency: opts.startingAreaMoistureFrequency,
  });

  const isWater = (r: number, g: number, b: number): boolean => {
    for (const [wr, wg, wb] of WATER_TILE_COLORS) {
      if (r === wr && g === wg && b === wb) return true;
    }
    return false;
  };

  // Local pixel range to sweep - the image's own bounds by default, widened by
  // the halo when `sweepBox` is given. The world->local division is exact:
  // `sweepBox` is always originX/originY plus an integer multiple of tpp (see
  // `placementMarkSweepBox`), the same guarantee `cliffCellQueryBox` relies on.
  const box = opts.sweepBox;
  const pxStart = box ? Math.round((box.x0 - originX) / tpp) : 0;
  const pxEnd = box ? Math.round((box.x1 - originX) / tpp) : width;
  const pyStart = box ? Math.round((box.y0 - originY) / tpp) : 0;
  const pyEnd = box ? Math.round((box.y1 - originY) / tpp) : height;

  for (let py = pyStart; py < pyEnd; py++) {
    const wy = originY + py * tpp;
    for (let px = pxStart; px < pxEnd; px++) {
      const wx = originX + px * tpp;
      if (!placed(wx, wy)) continue;
      paintMark(base, px, py, ENEMY_MAP_COLOR, PLACEMENT_MARK_RADIUS_PX, isWater);
    }
  }
}
