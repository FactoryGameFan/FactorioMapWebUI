/**
 * Composite the resource-patch overlay onto a terrain ImageData: sweep the same
 * pixel grid as renderTerrain, and where a resource wins, paint its `map_color`
 * opaque; leave the terrain pixel untouched elsewhere. Mutates `base` in place.
 * See M3a plan T7.
 *
 * **Two placement modes, because one resource is not a patch.** The catalog's
 * `placement` field picks per entry (`resourceCatalog.ts`):
 *
 * - The four solids and uranium THRESHOLD. Their `random_probability` is 1, so
 *   the probability is `clamp(all_patches, 0, 1)`, which saturates to 1 inside a
 *   patch and is 0 outside - `>= 0.5` is the patch boundary.
 * - Crude oil ROLLS. It is the only entry whose `random_probability` is not 1
 *   (1/48), which multiplies its probability by
 *   `random_penalty{source = 1, amplitude = 48}` - a factor that is positive on
 *   only about one tile in 48. Thresholding that paints the whole patch extent
 *   as solid ore: 1234 tiles in `[0,0]-[512,512]` where the game has **8** oil
 *   wells. See `makeNauvisOilPlacement`.
 *
 * **Paint order: oil marks first, then the thresholded resources over the top.**
 * Oil's autoplace order is "c", so the four solids must win a shared pixel, and
 * painting them last reproduces that without a colour test. The one inversion
 * this introduces is against uranium, which is also "c" but sorts *after* oil
 * (`patchSetIndex` 5 vs 4), so a uranium patch covering an oil well would hide it
 * where the game would show the well. Measured rather than waved away: over
 * `[-2048,-2048]-[2048,2048]` at seed 123456 the two footprints cover 39869 and
 * 10733 tiles and share **0** of them, so the inversion is unreachable there. It
 * is a latent ordering bug, not a visible one. Recorded rather than guarded
 * against, because a per-pixel guard would cost every pixel to fix a case that
 * does not occur - but this is a seed-specific zero, not a theorem, so a guard
 * becomes the right call the moment a counterexample turns up.
 *
 * Resources collide with water, so ore is never placed on a water tile. The
 * threshold pass skips any pixel the terrain drew as water/deepwater (which also
 * skips the expensive resolver there), reusing renderTerrain's exact water
 * decision so the ore edge lines up with the coastline already drawn. Oil's roll
 * instead gates on the ported tile resolver, because its chunk collision pass
 * asks about tiles outside the render window, where there are no pixels to read.
 */
import type { Point } from "../distanceFromNearestPoint";
import {
  PLACEMENT_MARK_RADIUS_PX,
  PLACEMENT_SALT,
  makePlacementRoll,
  makePlacementSet,
} from "../placement/placementRoll";
import type { PlacementCollisionBox } from "../placement/placementRoll";
import { RESOURCE_CATALOG } from "../resources/resourceCatalog";
import { makeResourcePatches } from "../resources/resourcePatches";
import { makeResourceResolver, type ResourceControlLevers } from "../resources/resolveResource";
import { makeTileResolver } from "../tiles/resolve";
import { paintMark } from "./renderCliffs";

/**
 * The Nauvis water tiles' `map_color` RGB (deepwater, water) - mirrors catalog.ts.
 * Resources are excluded from these tiles. A drift-guard test (renderResources.spec)
 * asserts these still match the catalog.
 */
export const WATER_TILE_COLORS: readonly (readonly [number, number, number])[] = [
  [38, 64, 73], // deepwater
  [51, 83, 95], // water
];

/**
 * The Nauvis tiles no resource may sit on, by name.
 *
 * **Derived from the collision mask.** `type = "resource"` defaults to a
 * `{layers = {resource = true}}` collision mask
 * (`core/lualib/collision-mask-defaults.lua:187`), and on Nauvis the tile masks
 * carrying `resource = true` are `water()` and `shallow_water()`
 * (`base/prototypes/tile/tile-collision-masks.lua:22`, `:51`). The default-Nauvis
 * tile catalog can only produce `water` and `deepwater`
 * (`src/noise/tiles/catalog.ts`), so those two are the whole set here - the same
 * set the rock and enemy overlays use, and the same one the threshold pass
 * expresses as pixel colours.
 */
const WATER_TILE_NAMES = new Set(["water", "deepwater"]);

/**
 * Crude oil's `collision_box`, 2.8 x 2.8 tiles
 * (`base/prototypes/entity/resources.lua:262`: `{{-1.4,-1.4},{1.4,1.4}}`).
 *
 * **Checked for `map_generator_bounding_box`, which is absent** - a grep over
 * `base/`, `core/` and `space-age/` at 2.1.12 returns eight declarations and not
 * one is a `resource`. That field overrides the collision box during map
 * generation and cost Task 6 87-132 points when it was missed, so it is checked
 * per overlay rather than assumed. Oil and the sulfuric-acid geyser turn out to
 * declare the *same* box, which is a coincidence of two prototypes rather than a
 * rule about resources.
 */
const OIL_COLLISION_BOX: PlacementCollisionBox = { w: 2.8, h: 2.8 };

/** `random_penalty` amplitude for oil: `1 / random_probability` = 1 / (1/48). */
const OIL_PENALTY_AMPLITUDE = 48;

/** Inputs shared by oil's probability and its gated placement predicate. */
export interface NauvisOilPlacementParams {
  readonly seed0: number;
  readonly controls?: Record<string, ResourceControlLevers>;
  readonly startingPositions?: readonly Point[];
  readonly segmentationMultiplier?: number;
  readonly moistureFrequency?: number;
  readonly moistureBias?: number;
  readonly auxFrequency?: number;
  readonly auxBias?: number;
  readonly startingAreaMoistureSize?: number;
  readonly startingAreaMoistureFrequency?: number;
}

const DEFAULT_LEVERS: ResourceControlLevers = { frequency: 1, size: 1, richness: 1 };
/** The regular set shares one candidate stream across all 6 resources. */
const REGULAR_SKIP_SPAN = 6;
/** The starting set shares one candidate stream across the 4 solids. */
const STARTING_SKIP_SPAN = 4;

/**
 * Crude oil's `entity:crude-oil:probability`, the game's expression from
 * `core/lualib/resource-autoplace.lua:103-105` (2.1.12):
 *
 * ```lua
 * probability_expression = "clamp(var('<all_patches>'), 0, 1)"
 * if (params.random_probability or 1) < 1 then
 *   probability_expression = probability_expression
 *     .. "* random_penalty{x = x, y = y, source = 1, amplitude = 1 /" .. params.random_probability .. "}"
 * ```
 *
 * so with `random_probability = 1/48`:
 *
 * ```
 * probability = clamp(all_patches, 0, 1) * random_penalty{source = 1, amplitude = 48}
 *             = clamp(all_patches, 0, 1) * (1 - 48 * U)
 * ```
 *
 * **`U` comes from a dedicated placement-roll stream, not from the game's batch.**
 * `random_penalty` is a batch op whose draw order depends on the evaluation
 * batch's extent and starting position (`docs/noise/random-penalty-NOTES.md`), and
 * this port does not reproduce the noise path's batching. It does not have to:
 * `source = 1` is constant and strictly positive, so every tile consumes exactly
 * one draw and each tile's `U` is marginally uniform on [0, 1) regardless of how
 * the batch is cut. Density is a sum of per-tile marginals and is therefore
 * batch-invariant; only *which* tile gets which draw changes, and positions are
 * explicitly not claimed (`test/entityDensity.spec.ts`). This is the same
 * stand-in the two spawner penalties use (`renderEnemies.ts`, Task 6).
 *
 * The result is floored at 0 because `1 - 48 * U` is negative for `U > 1/48` -
 * a negative probability simply never wins the roll, exactly as in the game.
 *
 * **The factor costs a factor of 96, not 48.** `1 - 48U` is positive only for
 * `U < 1/48`, and its mean over that range is 1/2, so the expected probability is
 * `clamp / 96`. Confirmed against the field sum: over `[0,0]-[512,512]`,
 * `sum(clamp)` is 1234.0 and `sum(penalised)` is 13.1 against the predicted
 * 1234/96 = 12.85.
 */
export function makeNauvisOilProbability(
  params: NauvisOilPlacementParams,
): (x: number, y: number) => number {
  const oil = RESOURCE_CATALOG.find((p) => p.name === "crude-oil");
  if (oil === undefined) throw new Error("crude-oil missing from RESOURCE_CATALOG");
  const levers = params.controls?.[oil.controlName] ?? DEFAULT_LEVERS;
  const patches = makeResourcePatches(oil, {
    seed0: params.seed0,
    controls: levers,
    startingPositions: params.startingPositions,
    segmentationMultiplier: params.segmentationMultiplier,
    regularSkipSpan: REGULAR_SKIP_SPAN,
    regularSkipOffset: oil.patchSetIndex,
    startingSkipSpan: STARTING_SKIP_SPAN,
    startingSkipOffset: oil.patchSetIndex,
  });
  const penalty = makePlacementRoll(PLACEMENT_SALT.crudeOilPenalty);
  return (x, y) =>
    Math.max(0, patches.probability(x, y) * (1 - OIL_PENALTY_AMPLITUDE * penalty(x, y)));
}

/**
 * The shipped crude-oil placement predicate: the roll against
 * {@link makeNauvisOilProbability}, gated by the water tile restriction and by
 * collision against oil already placed in the same chunk. Exported so
 * `test/entityDensity.spec.ts` measures the exact predicate the renderer paints.
 *
 * ## The prototype data, from source (2.1.12)
 *
 * | | crude-oil |
 * | --- | --- |
 * | type | `resource` |
 * | autoplace order | `c` (the four solids are `b`; uranium is also `c`) |
 * | random_probability | **1/48** - the only one in the catalog below 1 |
 * | collision_box | 2.8 x 2.8 |
 * | map_generator_bounding_box | **not declared** - so the collision box is the map-gen box |
 * | tile_restriction | none - the water gate comes from the collision MASK |
 *
 * The prototype carries the developer comment that the sulfuric-acid geyser's
 * `order = "c"` copies almost verbatim: *"Other resources are 'b'; oil won't get
 * placed if something else is already there."* This is where that sentence
 * originates, and it is the same textual evidence for sequential shared space
 * that `docs/noise/placement-roll-NOTES.md` records for the geyser.
 *
 * ## Measured, against `test/fixtures/oracle-entity-counts.seed123456.json`
 *
 * Factorio 2.1.12, seed 123456.
 *
 * | variant | region 0 `[0,0]` (game 8) | region 1 `[4096,4096]` (game 0) |
 * | --- | --- | --- |
 * | old threshold footprint | 1234 | 248 |
 * | roll, no penalty factor | 118 | 0 |
 * | **roll + penalty (shipped)** | **7** | **0** |
 *
 * **Region 0's n = 8 is the weakest denominator in the whole density oracle.**
 * Poisson sigma on 8 is 2.83, i.e. 35%, so 7-vs-8 (12.5%) is well inside the
 * noise and is emphatically not evidence of 12.5%-grade accuracy. Region 1
 * contributes a zero-vs-zero agreement, which rules out gross over-placement in
 * a window with patches but no oil and is worth having, but it cannot
 * discriminate a factor-of-two error either. Treat oil as the loosest-validated
 * overlay in the set.
 */
export function makeNauvisOilPlacement(
  params: NauvisOilPlacementParams,
): (x: number, y: number) => boolean {
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
    salt: PLACEMENT_SALT.crudeOil,
    probability: makeNauvisOilProbability(params),
    tileAllowed: (x, y) => !WATER_TILE_NAMES.has(tileAt(x, y).name),
    collisionBox: () => OIL_COLLISION_BOX,
  });
}

export interface RenderResourcesOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Per-resource control levers, keyed by controlName; missing => all-default. */
  readonly controls: Record<string, ResourceControlLevers>;
  /** Spawn points for `distance`. Default single origin spawn. */
  readonly startingPositions?: readonly Point[];
  /** elevation inputs for the starting-patch favorability coupling (solids only). */
  readonly segmentationMultiplier?: number;
  readonly waterLevel?: number;
  readonly startingLakePositions?: readonly Point[];
  /** Climate inputs for oil's tile gate (the ported tile resolver). */
  readonly moistureFrequency?: number;
  readonly moistureBias?: number;
  readonly auxFrequency?: number;
  readonly auxBias?: number;
  readonly startingAreaMoistureSize?: number;
  readonly startingAreaMoistureFrequency?: number;
  /**
   * World box to sweep for oil roll hits. Defaults to this render's own pixel
   * box. The tiled renderer widens it by `PLACEMENT_MARK_RADIUS_PX` pixels'
   * worth of tiles (clamped to the full image) so a hit centred just outside this
   * tile still paints the part of its 3x3 mark that falls inside. `paintMark`
   * clips to the pixel grid, so a wider sweep can never paint outside this tile's
   * own bounds. The thresholded resources paint 1x1 and ignore this.
   */
  readonly sweepBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

export function renderResources(base: ImageData, opts: RenderResourcesOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const resolve = makeResourceResolver({
    seed0: opts.seed0,
    controls: opts.controls,
    startingPositions: opts.startingPositions,
    segmentationMultiplier: opts.segmentationMultiplier,
    waterLevel: opts.waterLevel,
    startingLakePositions: opts.startingLakePositions,
  });

  const isWater = (r: number, g: number, b: number): boolean => {
    for (const [wr, wg, wb] of WATER_TILE_COLORS) {
      if (r === wr && g === wg && b === wb) return true;
    }
    return false;
  };

  // Pass 1: crude oil, the one roll resource, painted as a 3x3 mark. An oil well
  // is 2.8 x 2.8 tiles and the game puts down single digits of them per 512x512
  // region, so a lone pixel disappears - the same reasoning the geyser and the
  // spawners use for the same mark. See the module comment for the paint order.
  const oil = RESOURCE_CATALOG.find((p) => p.placement === "roll");
  if (oil !== undefined && (opts.controls[oil.controlName]?.size ?? 1) > 0) {
    const placed = makeNauvisOilPlacement({
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
        paintMark(base, px, py, oil.mapColor, PLACEMENT_MARK_RADIUS_PX);
      }
    }
  }

  // Pass 2: the thresholded resources, over the top - see the module comment on
  // paint order.
  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const o = (py * width + px) * 4;
      // Ore never sits on water - skip water tiles (and the resolver call for them).
      if (isWater(base.data[o], base.data[o + 1], base.data[o + 2])) continue;
      const wx = originX + px * tpp;
      const winner = resolve(wx, wy);
      if (!winner) continue;
      base.data[o] = winner.mapColor[0];
      base.data[o + 1] = winner.mapColor[1];
      base.data[o + 2] = winner.mapColor[2];
      base.data[o + 3] = 255;
    }
  }
}
