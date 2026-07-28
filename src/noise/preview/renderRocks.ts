/**
 * Composite the rocks overlay onto a terrain ImageData: sweep the same pixel grid
 * as renderTerrain/renderEnemies, roll the game's per-tile placement draw against
 * the rock probability field, and paint a single `ROCK_MAP_COLOR` pixel wherever
 * it wins. Mutates `base` in place. 1 pixel per placed rock, no legibility block:
 * rocks are point-like, and a block would merge scattered rocks into a blob.
 *
 * This rolls rather than thresholds: it draws `makePlacementSet`'s per-tile `U`
 * and places where `U < density(x, y)` AND the game's two arbitration gates pass
 * (`docs/noise/placement-roll-NOTES.md`: the winner is picked by max probability
 * "subject to collision-mask and tile-restriction checks"). Positions are not
 * tile-exact - there is no cross-overlay arbitration against the other
 * autoplacers and no jitter draws within the tile (see `placementRoll.ts`) - but
 * density is the property under test, and `test/entityDensity.spec.ts` pins it
 * against the real game's per-region entity counts.
 *
 * Rocks collide with water, so water pixels are skipped, reusing renderTerrain's
 * exact water decision via WATER_TILE_COLORS the same way renderResources does.
 * That pixel-colour skip is only an optimisation and a paint guard - the gate
 * that matters for correctness is `tileAllowed` below, which is derived from the
 * ported tile resolver and is therefore a pure function of world position.
 * Cliff exclusion is not wired, matching the existing ore-on-cliffs deferred item.
 */
import type { Point } from "../distanceFromNearestPoint";
import { PLACEMENT_SALT, makePlacementSet } from "../placement/placementRoll";
import type { PlacementCollisionBox } from "../placement/placementRoll";
import { makeRockFields, type RockFieldParams } from "../rocks/rockField";
import {
  ROCK_FIELD_LATTICE,
  ROCK_MAP_COLOR,
  NAUVIS_ROCK_MARK_RADIUS_PX,
  latticeSnapped,
  type RockControls,
} from "../rocks/rockCatalog";
import { makeTileResolver } from "../tiles/resolve";
import { paintMark } from "./renderCliffs";
import { WATER_TILE_COLORS } from "./renderResources";

export interface RenderRocksOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** control:rocks:frequency/size. Defaults to { frequency: 1, size: 1 }. */
  readonly controls?: RockControls;
  readonly segmentationMultiplier?: number;
  readonly moistureFrequency?: number;
  readonly moistureBias?: number;
  readonly auxFrequency?: number;
  readonly auxBias?: number;
  readonly startingAreaMoistureSize?: number;
  readonly startingAreaMoistureFrequency?: number;
  /** Spawn points for `distance`. Default single origin spawn. */
  readonly startingPositions?: readonly Point[];
  /**
   * World box to sweep for rock placements. Defaults to this render's own pixel
   * box. The tiled renderer widens it by `NAUVIS_ROCK_MARK_RADIUS_PX` pixels' worth of
   * tiles (clamped to the full image) so a rock centred just outside this tile
   * still paints the part of its mark that falls inside. `paintMark` clips to the
   * pixel grid, so a wider sweep can never paint outside this tile's own bounds.
   *
   * Rocks did NOT need this while they painted 1x1 - a single pixel cannot
   * straddle a seam. It became load-bearing the moment the mark grew to 3x3, and
   * `test/tiledEquality.spec.ts` failed on four cases until it was added.
   */
  readonly sweepBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

/**
 * The two tiles no rock may sit on.
 *
 * Unlike Vulcanus's rocks, none of the three Nauvis rock prototypes declares a
 * `tile_restriction` at all - `decoratives.lua` has no such key anywhere. The
 * restriction comes from the collision mask instead: all three are
 * `type = "simple-entity"`, whose default mask is `building()` in
 * `core/lualib/collision-mask-defaults.lua`, and that includes `water_tile`. So
 * the gate is "the tile is not water", and it is shared by all three prototypes
 * - which is the condition `resolveChunk`'s doc comment requires before a single
 * probability-then-restriction test is allowed to stand in for the game's
 * arbitrate-then-roll order.
 */
const WATER_TILE_NAMES = new Set(["water", "deepwater"]);

/**
 * The three prototypes' collision boxes, from `decoratives.lua` (2.1.12):
 * `huge-rock` {{-1.5,-1.1},{1.5,1.1}}, `big-rock` {{-1.0,-0.9},{1.0,1.0}},
 * `big-sand-rock` {{-0.75,-0.75},{0.75,0.75}}.
 */
const HUGE_ROCK_BOX: PlacementCollisionBox = { w: 3, h: 2.2 };
const BIG_ROCK_BOX: PlacementCollisionBox = { w: 2, h: 1.9 };
const BIG_SAND_ROCK_BOX: PlacementCollisionBox = { w: 1.5, h: 1.5 };

/**
 * Pick the collision box of whichever prototype has the highest probability at
 * this tile - the argmax rule, kept here because on Nauvis it is NOT degenerate
 * in identity, unlike on Vulcanus (`renderVulcanusRocks.ts`).
 *
 * **What IS degenerate here.** `huge-rock` can never win the argmax, and that is
 * a theorem rather than a seed accident. With `T = moisture_band + rock_density`,
 * `big = 0.17*(T - 1.6)` and `huge = 0.07*(T - 1.7)`, so `big > huge` exactly
 * when `T > 1.53`; but `big` is only positive when `T > 1.6` and `huge` only when
 * `T > 1.7`, so wherever either prototype can place at all, `big` is strictly
 * ahead. Same shape as the Vulcanus finding, and the same consequence: the
 * max-probability arbitration this port models predicts 0% huge-rock, while the
 * game's region 0 holds 42 huge / 149 big / 1 sand - 22% huge. See the
 * falsification writeup in `docs/noise/placement-roll-NOTES.md`; the claim this
 * overlay makes is density, not identity.
 *
 * **What is not.** `big-sand-rock` vs `big-rock` is a real contest, and this is
 * where Nauvis differs from Vulcanus. The two read DIFFERENT climate bands -
 * `big-rock`'s `region_box` wants moisture in [0.35, 1], `big-sand-rock`'s wants
 * moisture in [0, 0.3] AND aux in [0.3, 1] - and those moisture ranges are
 * disjoint, so whichever band a tile sits in decides the winner. Measured over
 * the placed tiles of the two oracle regions the split is total: region 0 is
 * 205 big / 0 sand, region 1 is 0 big / 54 sand. The game's own populations
 * agree in direction (region 0: 42 + 149 + 1; region 1: 0 + 0 + 64).
 *
 * **But the argmax makes no numeric difference here, and that is worth knowing
 * before reusing this shape.** Placement is resolved on the integer tile lattice
 * with tile-centred boxes, so what a box does is set an exclusion neighbourhood.
 * `big-rock` (2 x 1.9) excludes |dx| <= 1 and |dy| <= 1; `big-sand-rock`
 * (1.5 x 1.5) excludes exactly the same 3x3. Only `huge-rock` (3 x 2.2) differs,
 * at 5x5 - and huge can never win. So argmax, uniform-big and uniform-sand all
 * place identically (measured: 205 / 54 for all three), and only uniform-huge is
 * distinguishable (168 / 46, materially worse). The agreement is pointwise, not
 * just in aggregate: a mixed big/sand pair also tests as 3x3, so no tile can
 * differ.
 *
 * The argmax is kept because it is the rule the game describes, and it would
 * start to matter the moment a mod or another planet separated those two boxes -
 * not because it bought accuracy today. **No lever this app exposes can separate
 * them.** `control:rocks:size` is the same outer multiplier on all three
 * probabilities, and the huge-vs-big theorem holds for every value of the shared
 * term `T` (which is where size's other effect lands), so no size setting lets
 * huge win. The moisture and aux levers move `T` and the two region boxes, so they
 * can only shift which of big and sand wins - and those two are lattice-identical.
 */
function rockCollisionBoxFor(huge: number, big: number, sand: number): PlacementCollisionBox {
  if (sand > big && sand > huge) return BIG_SAND_ROCK_BOX;
  if (big >= huge) return BIG_ROCK_BOX;
  return HUGE_ROCK_BOX;
}

/**
 * The shipped Nauvis rock placement predicate: the roll against `density`, gated
 * by the water restriction and by collision against rocks already placed in the
 * same chunk. Exported so `test/entityDensity.spec.ts` measures the exact
 * predicate the renderer paints, not a re-derivation of it.
 *
 * **Measured rather than assumed**, against
 * `test/fixtures/oracle-entity-counts.seed123456.json` (Factorio 2.1.12, seed
 * 123456), comparing the placed-tile count with the sum of the game's
 * huge-rock + big-rock + big-sand-rock counts:
 *
 * | | region 0 `[0,0]` (game 192) | region 1 `[4096,4096]` (game 64) |
 * | --- | --- | --- |
 * | bare roll, no gates | 312 (62.5%) | 182 (184.4%) |
 * | + water restriction only | 252 (31.3%) | 60 (6.3%) |
 * | + collision, uniform huge box | 168 (12.5%) | 46 (28.1%) |
 * | **+ collision, argmax box (shipped)** | **205 (6.8%)** | **54 (15.6%)** |
 *
 * Uniform-big and uniform-sand also give 205 / 54; see `rockCollisionBoxFor`
 * for why those three rules cannot differ on the integer lattice.
 *
 * Two honest caveats on the numbers. Region 1 is 60% water (measured with the
 * same tile resolver), so the restriction gate alone does most of the work there
 * and happens to land closer to the game (6.3%) than the full model does
 * (15.6%); that is a 6-rock difference on a 64-rock region, not evidence that
 * the collision gate is wrong, and dropping a gate the game demonstrably applies
 * in order to improve one region's number would be fitting. Second, the
 * denominators are small - one rock is 0.5% of region 0 and 1.6% of region 1 -
 * so these percentages are far noisier per rock than the Vulcanus ones, whose
 * regions hold ~1200 rocks each.
 */
export function makeNauvisRockPlacement(
  params: RockFieldParams,
): (x: number, y: number) => boolean {
  const fields = makeRockFields(params);
  // Derived from the ported tile resolver, NOT from rendered pixel colours: the
  // chunk resolver asks about tiles outside the render window, and reading the
  // ImageData would make the answer window-dependent.
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
    salt: PLACEMENT_SALT.nauvisRocks,
    // Snapped to `ROCK_FIELD_LATTICE`, which ships at 1 (a no-op that returns
    // `fields.density` itself) - see `rockCatalog.ts`.
    probability: latticeSnapped(fields.density, ROCK_FIELD_LATTICE),
    tileAllowed: (x, y) => !WATER_TILE_NAMES.has(tileAt(x, y).name),
    collisionBox: (x, y) => {
      const p = fields.at(x, y);
      return rockCollisionBoxFor(p.huge, p.big, p.sand);
    },
  });
}

export function renderRocks(base: ImageData, opts: RenderRocksOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const placed = makeNauvisRockPlacement({
    seed0: opts.seed0,
    rocksFrequency: opts.controls?.frequency ?? 1,
    rocksSize: opts.controls?.size ?? 1,
    segmentationMultiplier: opts.segmentationMultiplier,
    moistureFrequency: opts.moistureFrequency,
    moistureBias: opts.moistureBias,
    auxFrequency: opts.auxFrequency,
    auxBias: opts.auxBias,
    startingAreaMoistureSize: opts.startingAreaMoistureSize,
    startingAreaMoistureFrequency: opts.startingAreaMoistureFrequency,
    startingPositions: opts.startingPositions,
  });

  const isWater = (r: number, g: number, b: number): boolean => {
    for (const [wr, wg, wb] of WATER_TILE_COLORS) {
      if (r === wr && g === wg && b === wb) return true;
    }
    return false;
  };

  const box = opts.sweepBox;
  const pxStart = box ? Math.round((box.x0 - originX) / tpp) : 0;
  const pxEnd = box ? Math.round((box.x1 - originX) / tpp) : width;
  const pyStart = box ? Math.round((box.y0 - originY) / tpp) : 0;
  const pyEnd = box ? Math.round((box.y1 - originY) / tpp) : height;

  for (let py = pyStart; py < pyEnd; py++) {
    const wy = originY + py * tpp;
    for (let px = pxStart; px < pxEnd; px++) {
      const o = (py * width + px) * 4;
      // Rocks never sit on water - skip water tiles (and the field call for them).
      if (isWater(base.data[o], base.data[o + 1], base.data[o + 2])) continue;
      const wx = originX + px * tpp;
      if (!placed(wx, wy)) continue;
      // `isWater` is re-checked per painted pixel, so a thickened mark still
      // stops at the coastline rather than spilling onto water.
      paintMark(base, px, py, ROCK_MAP_COLOR, NAUVIS_ROCK_MARK_RADIUS_PX, isWater);
    }
  }
}
