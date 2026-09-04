/**
 * The six Nauvis resources and their `resource_autoplace_settings` params, copied
 * from base/prototypes/entity/resources.lua plus the defaults in
 * core/lualib/resource-autoplace.lua. One entry per resource, in the order they are
 * registered by `initialize_patch_set` (iron, copper, coal, stone, crude-oil,
 * uranium) - which is also their `regular_patch_set_index`.
 *
 * Lua math folded into the stored values:
 * - `regularRqFactor = regular_rq_factor_multiplier / 10`
 * - `mapColor` = the prototype's `map_color` (0..1 floats) scaled to 0..255, rounded.
 * Defaults applied here: base_spots_per_km2 2.5, candidate_spot_count 21, seed1 100,
 * random_probability 1, random_spot_size 0.25..2, additional/minimum richness 0,
 * richness_post_multiplier 1.
 */
export interface ResourceParams {
  /** Entity/prototype name, e.g. "iron-ore". */
  readonly name: string;
  /** Autoplace control name (= name for base resources); the control:<x>:* levers. */
  readonly controlName: string;
  /** Autoplace order: "b" resources beat "c" (oil/uranium yield) in the overlay. */
  readonly order: "b" | "c";
  /** regular_patch_set_index (init order 0..5); also the skip_offset in the regular set. */
  readonly patchSetIndex: number;
  readonly baseDensity: number;
  readonly baseSpotsPerKm2: number;
  readonly candidateSpotCount: number;
  /** regular_rq_factor = regular_rq_factor_multiplier / 10. */
  readonly regularRqFactor: number;
  /** starting_rq_factor = starting_rq_factor_multiplier / 7 (needed for basement_value). */
  readonly startingRqFactor: number;
  readonly seed1: number;
  readonly randomProbability: number;
  readonly randomSpotSizeMin: number;
  readonly randomSpotSizeMax: number;
  readonly additionalRichness: number;
  readonly minimumRichness: number;
  readonly richnessPostMultiplier: number;
  readonly hasStartingAreaPlacement: boolean;
  /** map_color, scaled to 0..255 (rounded). */
  readonly mapColor: readonly [number, number, number];
  /** How the renderer turns this entry into pixels - see {@link ResourcePlacement}. */
  readonly placement: ResourcePlacement;
}

/**
 * How a resource decides where it is drawn.
 *
 * - `"threshold"` - draw wherever `probability >= 0.5`, i.e. paint the patch as a
 *   solid footprint. Right for the five resources whose `random_probability` is
 *   1: their probability is `clamp(all_patches, 0, 1)`, which saturates to 1
 *   inside a patch and is 0 outside, so the threshold *is* the patch boundary.
 * - `"roll"` - draw where the game's per-tile placement draw beats the
 *   probability, subject to the tile and collision gates. Right for crude oil
 *   alone, whose probability carries a `random_penalty{source = 1,
 *   amplitude = 48}` factor that is positive on only ~1 tile in 48. Thresholding
 *   it paints the whole patch extent as solid ore, where the game puts down a
 *   handful of individual wells (measured: 1234 tiles against the game's 8
 *   entities in `[0,0]-[512,512]`).
 */
export type ResourcePlacement = "threshold" | "roll";

/** control:<res>:frequency|size|richness levers for one resource. */
export interface ResourceControlLevers {
  readonly frequency: number;
  readonly size: number;
  readonly richness: number;
}

/** map_color (0..1) -> 0..255, rounded, matching the game's preview tint. */
function color255(r: number, g: number, b: number): readonly [number, number, number] {
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** Defaults for a base solid ore (order "b", starting placement, no specials). */
function solidOre(
  name: string,
  patchSetIndex: number,
  baseDensity: number,
  regularRqFactorMultiplier: number,
  startingRqFactorMultiplier: number,
  candidateSpotCount: number,
  mapColor: readonly [number, number, number],
): ResourceParams {
  return {
    name,
    controlName: name,
    order: "b",
    patchSetIndex,
    baseDensity,
    baseSpotsPerKm2: 2.5,
    candidateSpotCount,
    regularRqFactor: regularRqFactorMultiplier / 10,
    startingRqFactor: startingRqFactorMultiplier / 7,
    seed1: 100,
    randomProbability: 1,
    randomSpotSizeMin: 0.25,
    randomSpotSizeMax: 2,
    additionalRichness: 0,
    minimumRichness: 0,
    richnessPostMultiplier: 1,
    hasStartingAreaPlacement: true,
    mapColor,
    placement: "threshold",
  };
}

export const RESOURCE_CATALOG: readonly ResourceParams[] = [
  solidOre("iron-ore", 0, 10, 1.1, 1.5, 22, color255(0.415, 0.525, 0.58)),
  solidOre("copper-ore", 1, 8, 1.1, 1.2, 22, color255(0.803, 0.388, 0.215)),
  solidOre("coal", 2, 8, 1.0, 1.1, 21, color255(0, 0, 0)),
  solidOre("stone", 3, 4, 1.0, 1.1, 21, color255(0.69, 0.611, 0.427)),
  {
    name: "crude-oil",
    controlName: "crude-oil",
    order: "c",
    patchSetIndex: 4,
    baseDensity: 8.2,
    baseSpotsPerKm2: 1.8,
    candidateSpotCount: 21,
    regularRqFactor: 1 / 10,
    startingRqFactor: 1 / 7,
    seed1: 100,
    randomProbability: 1 / 48,
    randomSpotSizeMin: 1,
    randomSpotSizeMax: 1,
    additionalRichness: 220000,
    minimumRichness: 0,
    richnessPostMultiplier: 1,
    hasStartingAreaPlacement: false,
    mapColor: color255(0.78, 0.2, 0.77),
    // The one roll resource. `randomProbability = 1/48` puts a
    // `random_penalty{source = 1, amplitude = 48}` factor on oil's probability
    // and nothing else in this catalog carries one - see `ResourcePlacement` and
    // `makeNauvisOilPlacement` in `src/noise/preview/renderResources.ts`.
    placement: "roll",
  },
  {
    name: "uranium-ore",
    controlName: "uranium-ore",
    order: "c",
    patchSetIndex: 5,
    baseDensity: 0.9,
    baseSpotsPerKm2: 1.25,
    candidateSpotCount: 21,
    regularRqFactor: 1 / 10,
    startingRqFactor: 1 / 7,
    seed1: 100,
    randomProbability: 1,
    randomSpotSizeMin: 2,
    randomSpotSizeMax: 4,
    additionalRichness: 0,
    minimumRichness: 0,
    richnessPostMultiplier: 1,
    hasStartingAreaPlacement: false,
    mapColor: color255(0, 0.7, 0),
    // Uranium shares oil's autoplace order "c" but NOT its penalty:
    // `random_probability` is 1 here, so its probability saturates inside a patch
    // like the four solids' and a threshold is the right rule.
    placement: "threshold",
  },
];
