/**
 * The three solid Vulcanus ores rendered by the V2 overlay, listed here in
 * `space-age/prototypes/entity/resources.lua` order for tungsten-ore and
 * calcite (tungsten-ore precedes calcite there). **Coal is not in that file** -
 * despite appearing on Vulcanus, `coal` is the base-mod prototype
 * (`base/prototypes/entity/resources.lua`), routed onto Vulcanus via
 * `property_expression_names["entity:coal:probability"] = "vulcanus_coal_probability"`
 * in `space-age/prototypes/planet/planet-map-gen.lua:17`. Since `base` loads
 * before `space-age`, coal's true global registration index actually *precedes*
 * tungsten-ore and calcite, not follows them as this array's order suggests.
 *
 * Among those three the order is functionally inert: all three autoplace
 * `order = "b"`, so ties fall back to registration order, but their
 * favorabilities gate on disjoint biomes (basalts / mountains / ashlands), so
 * two of them are never simultaneously eligible at the same pixel and the
 * tie-break never fires. Listed in this order for readability, not correctness -
 * do not reorder the first three on the strength of the citation fix above.
 *
 * **That disjointness does NOT extend to the fourth entry.** The sulfuric acid
 * geyser gates on `vulcanus_mountains_sulfur_favorability`, which is drawn from
 * the same mountains biome as calcite's `vulcanus_mountains_resource_favorability`
 * (`planet-vulcanus-map-gen.lua:653` and `:664`), so calcite and the geyser can
 * be eligible at the same pixel and the tie-break fires for the first time.
 * **The geyser is last on purpose.** The game arbitrates a tile among competing
 * autoplacers by maximum probability; calcite's probability saturates to ~1
 * inside its footprint while the geyser's peaks below 0.09 (measured - see
 * `sulfuricAcidGeyserProbability`), so calcite wins that pixel. The renderer
 * reproduces that outcome by painting the geyser's roll marks FIRST and the
 * three thresholded ores over the top, so a solid ore still wins a shared pixel
 * (`renderVulcanusResources.ts`).
 */
import type { VulcanusResourceControls, VulcanusResourceLevers } from "../eval/ctx";
import type { VulcanusResources } from "../expressions/vulcanusResources";

/**
 * How this entry decides where it is drawn.
 *
 * - `"threshold"` - draw wherever the entry's own probability clears
 *   `PROBABILITY_THRESHOLD`, i.e. paint the patch as a solid footprint. Right
 *   for the three solid ores, whose probability saturates to ~1 inside a patch
 *   and 0 outside: the threshold *is* the patch boundary.
 * - `"roll"` - draw where the game's per-tile placement draw beats `probability`
 *   (`docs/noise/placement-roll-NOTES.md`), subject to the two arbitration
 *   gates. Right for the geyser, whose probability never exceeds ~0.09
 *   anywhere: there is no threshold that yields a footprint, because a geyser
 *   is an individual entity the game rolls for, not a patch.
 */
export type VulcanusResourcePlacement = "threshold" | "roll";

export interface VulcanusResourceParams {
  /** Entity/prototype name. */
  readonly name: string;
  /** Autoplace control name - the `control:<x>:*` levers and the preset dict key. */
  readonly controlName: string;
  /** `map_color`, scaled to 0..255 (rounded), as the game's preview tints it. */
  readonly mapColor: readonly [number, number, number];
  /**
   * Which `VulcanusResources` region this entry is built from.
   *
   * For a `"threshold"` entry this is the game's own probability expression up
   * to the `1000 *` scale the renderer applies, and it decides the footprint.
   * For the `"roll"` entry the renderer does NOT consult it - it is the field
   * `probability` is a formula over, kept here because the geyser's extent
   * ("where the game would roll at all") is still `region > 0`.
   */
  readonly region: (r: VulcanusResources) => (x: number, y: number) => number;
  /** Which `VulcanusResourceControls` entry gates this ore's size/frequency. */
  readonly levers: (c: VulcanusResourceControls) => VulcanusResourceLevers;
  /** How the renderer turns this entry into pixels. */
  readonly placement: VulcanusResourcePlacement;
  /**
   * The game's `entity:<name>:probability` at a tile, for `"roll"` entries. May
   * be negative where the entry cannot place - a negative probability simply
   * never wins the roll, exactly as in the game's expression.
   */
  readonly probability?: (r: VulcanusResources) => (x: number, y: number) => number;
}

/**
 * `vulcanus_sulfuric_acid_geyser_probability`, verbatim from
 * `space-age/prototypes/planet/planet-vulcanus-map-gen.lua:849` (2.1.12):
 *
 * ```
 * (control:sulfuric_acid_geyser:size > 0)
 *   * (0.025 * ((vulcanus_sulfuric_acid_region_patchy > 0)
 *               + 2 * vulcanus_sulfuric_acid_region_patchy))
 * ```
 *
 * It reaches the geyser via
 * `property_expression_names["entity:sulfuric-acid-geyser:probability"]`
 * (`planet-map-gen.lua:21`), which replaces the prototype's own
 * `probability_expression = 0`. **There is no `random_penalty` wrapper** - unlike
 * its calcite/coal/tungsten neighbours in the same file, and unlike the Nauvis
 * spawners, both of which do wrap theirs. Read from source rather than trusted
 * from the comment this replaced.
 *
 * The leading `size > 0` factor is applied by the renderer's `enabled` filter,
 * so it is not repeated here.
 *
 * **The peak is not 0.065.** That figure sat in this file as a reasoned bound
 * (assuming `region <= 1` and `patches <= 0.8`) and it is wrong: `region` is a
 * `max` against `vulcanus_starting_sulfur`, which is not capped at 1. Sweeping
 * +/-3000 tiles at seed 123456 on a 7-tile grid and refining around the argmax
 * measures **0.0883** at (2481, -1985), where `patchy` is 1.217. Still two
 * orders of magnitude below calcite's saturated ~1, which is all the catalog
 * ordering argument needs.
 */
export function sulfuricAcidGeyserProbability(
  r: VulcanusResources,
): (x: number, y: number) => number {
  return (x, y) => {
    const patchy = r.sulfuricAcidRegionPatchy(x, y);
    return 0.025 * ((patchy > 0 ? 1 : 0) + 2 * patchy);
  };
}

export const VULCANUS_RESOURCE_CATALOG: readonly VulcanusResourceParams[] = [
  {
    name: "tungsten-ore",
    controlName: "tungsten_ore",
    // map_color = {r = 98/256, g = 86/256, b = 150/256} -> Math.round(v * 255)
    mapColor: [98, 86, 149],
    region: (r) => (x, y) => r.tungstenRegion(x, y),
    levers: (c) => c.tungstenOre,
    placement: "threshold",
  },
  {
    name: "calcite",
    controlName: "calcite",
    // map_color = {0.8, 0.7, 0.7}
    mapColor: [204, 179, 179],
    region: (r) => (x, y) => r.calciteRegion(x, y),
    levers: (c) => c.calcite,
    placement: "threshold",
  },
  {
    name: "coal",
    controlName: "vulcanus_coal",
    // map_color = {0, 0, 0} (base/prototypes/entity/resources.lua)
    mapColor: [0, 0, 0],
    region: (r) => (x, y) => r.coalRegion(x, y),
    levers: (c) => c.vulcanusCoal,
    placement: "threshold",
  },
  {
    // The geyser is NOT a solid patch: every geyser in-game comes from a
    // per-tile RNG roll against `sulfuricAcidGeyserProbability`, which peaks
    // below 0.09, so no threshold on it yields a footprint. Until 2026-07-27
    // this entry thresholded anyway and drew the whole *patch extent* - the
    // region where the game would roll at all - which overstates the geysers'
    // area by **4.2x** (measured: 371 placements at 2.8 x 2.8 against 12130
    // footprint tiles over a +/-2000-tile sample, 0.240). Earlier text here and
    // in the notes said "more than an order of magnitude"; that was reasoned
    // from the pre-collision roll rate, never measured, and is wrong. It now
    // rolls (`docs/noise/placement-roll-NOTES.md`), and the roll's density is
    // validated against the game in `test/entityDensity.spec.ts`.
    //
    // `region` stays `sulfuricAcidRegionPatchy` - the field the probability is
    // built from, and NOT the plain `sulfuricAcidRegion` that richness uses -
    // because `probability > 0` is exactly `patchy > 0`, so it is still the
    // right answer to "could a geyser roll here". The renderer no longer draws
    // it.
    name: "sulfuric-acid-geyser",
    controlName: "sulfuric_acid_geyser",
    // map_color = {0.78, 0.78, 0.1} (space-age/prototypes/entity/resources.lua)
    mapColor: [199, 199, 26],
    region: (r) => (x, y) => r.sulfuricAcidRegionPatchy(x, y),
    levers: (c) => c.sulfuricAcidGeyser,
    placement: "roll",
    probability: sulfuricAcidGeyserProbability,
  },
];
