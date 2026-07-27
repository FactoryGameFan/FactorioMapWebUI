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
 * inside its footprint while the geyser's never exceeds ~0.065 (see the entry
 * below), so calcite wins that pixel. The renderer's first-in-catalog-order-wins
 * loop reproduces that outcome only while the geyser sits after the solid ores.
 */
import type { VulcanusResourceControls, VulcanusResourceLevers } from "../eval/ctx";
import type { VulcanusResources } from "../expressions/vulcanusResources";

export interface VulcanusResourceParams {
  /** Entity/prototype name. */
  readonly name: string;
  /** Autoplace control name - the `control:<x>:*` levers and the preset dict key. */
  readonly controlName: string;
  /** `map_color`, scaled to 0..255 (rounded), as the game's preview tints it. */
  readonly mapColor: readonly [number, number, number];
  /**
   * Which `VulcanusResources` region decides this entry's footprint. The
   * renderer draws where `1000 * region >= 0.5`; for the three solid ores that
   * is the game's own probability expression, for the geyser it is a stand-in
   * for the patch extent (see that entry).
   */
  readonly region: (r: VulcanusResources) => (x: number, y: number) => number;
  /** Which `VulcanusResourceControls` entry gates this ore's size/frequency. */
  readonly levers: (c: VulcanusResourceControls) => VulcanusResourceLevers;
}

export const VULCANUS_RESOURCE_CATALOG: readonly VulcanusResourceParams[] = [
  {
    name: "tungsten-ore",
    controlName: "tungsten_ore",
    // map_color = {r = 98/256, g = 86/256, b = 150/256} -> Math.round(v * 255)
    mapColor: [98, 86, 149],
    region: (r) => (x, y) => r.tungstenRegion(x, y),
    levers: (c) => c.tungstenOre,
  },
  {
    name: "calcite",
    controlName: "calcite",
    // map_color = {0.8, 0.7, 0.7}
    mapColor: [204, 179, 179],
    region: (r) => (x, y) => r.calciteRegion(x, y),
    levers: (c) => c.calcite,
  },
  {
    name: "coal",
    controlName: "vulcanus_coal",
    // map_color = {0, 0, 0} (base/prototypes/entity/resources.lua)
    mapColor: [0, 0, 0],
    region: (r) => (x, y) => r.coalRegion(x, y),
    levers: (c) => c.vulcanusCoal,
  },
  {
    // The geyser is NOT a solid patch, and this entry does not pretend to place
    // one. The game's expression (`planet-vulcanus-map-gen.lua:849`) is
    //
    //   probability = (control:sulfuric_acid_geyser:size > 0)
    //               * 0.025 * ((patchy > 0) + 2 * patchy)
    //
    // which peaks around 0.065 - there is no threshold that yields a footprint,
    // because every geyser in-game comes from a per-tile RNG roll against that
    // probability. Reproducing those rolls needs the per-chunk placement stream
    // (`docs/noise/placement-roll-NOTES.md`), which is shared across all ~14
    // Vulcanus entity autoplacers and is deferred - see issue #9.
    //
    // So what this draws is the **patch extent**, not individual geysers: the
    // region where the game would roll at all. `probability > 0` is exactly
    // `patchy > 0`, and the renderer's `1000 * region >= 0.5` rule reduces here
    // to `patchy >= 0.0005` - the same area up to a rim far thinner than a pixel
    // at any preview scale. Note this reads `sulfuricAcidRegionPatchy`, the
    // field the probability uses, not the plain `sulfuricAcidRegion` that
    // richness uses.
    name: "sulfuric-acid-geyser",
    controlName: "sulfuric_acid_geyser",
    // map_color = {0.78, 0.78, 0.1} (space-age/prototypes/entity/resources.lua)
    mapColor: [199, 199, 26],
    region: (r) => (x, y) => r.sulfuricAcidRegionPatchy(x, y),
    levers: (c) => c.sulfuricAcidGeyser,
  },
];
