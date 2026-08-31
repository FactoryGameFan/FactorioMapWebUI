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
 * **This module is a table, not an engine.** The probability expressions, the
 * footprint test and the placement threshold were ported to Rust in #227 and
 * live in `crates/fmw-noise/src/resources/vulcanus_catalog.rs`; the renderer
 * that walks them is `crates/fmw-wasm/src/render.rs:1400-1443`. What survives
 * here is the order and the map colours, which
 * `test/wasmVulcanusRenderParity.spec.ts` grades the engine's pixels against.
 *
 * Among the three solid ores the order is functionally inert: all three
 * autoplace `order = "b"`, so ties fall back to registration order, but their
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
 * inside its footprint while the geyser's peaks below 0.09 (measured at
 * **0.0858645**, at (2481, -1985) on seed 123456, where `patchy` is 1.2172893 -
 * see `sulfuric_acid_geyser_probability` in the Rust catalog), so calcite wins
 * that pixel. The renderer reproduces that outcome by painting the geyser's roll
 * marks FIRST and the three thresholded ores over the top, so a solid ore still
 * wins a shared pixel.
 */

/**
 * How this entry decides where it is drawn.
 *
 * - `"threshold"` - draw wherever the entry's own probability clears the
 *   placement threshold, i.e. paint the patch as a solid footprint. Right for
 *   the three solid ores, whose probability saturates to ~1 inside a patch and 0
 *   outside: the threshold *is* the patch boundary.
 * - `"roll"` - draw where the game's per-tile placement draw beats
 *   `probability` (`docs/noise/placement-roll-NOTES.md`), subject to the two
 *   arbitration gates. Right for the geyser, whose probability never exceeds
 *   ~0.09 anywhere: there is no threshold that yields a footprint, because a
 *   geyser is an individual entity the game rolls for, not a patch.
 *
 * Mirrors `VulcanusResourcePlacement` in
 * `crates/fmw-noise/src/resources/vulcanus_catalog.rs`, which is what actually
 * branches on it.
 */
export type VulcanusResourcePlacement = "threshold" | "roll";

export interface VulcanusResourceParams {
  /** Entity/prototype name. */
  readonly name: string;
  /** Autoplace control name - the `control:<x>:*` levers and the preset dict key. */
  readonly controlName: string;
  /** `map_color`, scaled to 0..255 (rounded), as the game's preview tints it. */
  readonly mapColor: readonly [number, number, number];
  /** How the engine turns this entry into pixels. */
  readonly placement: VulcanusResourcePlacement;
}

export const VULCANUS_RESOURCE_CATALOG: readonly VulcanusResourceParams[] = [
  {
    name: "tungsten-ore",
    controlName: "tungsten_ore",
    // map_color = {r = 98/256, g = 86/256, b = 150/256} -> Math.round(v * 255)
    mapColor: [98, 86, 149],
    placement: "threshold",
  },
  {
    name: "calcite",
    controlName: "calcite",
    // map_color = {0.8, 0.7, 0.7}
    mapColor: [204, 179, 179],
    placement: "threshold",
  },
  {
    name: "coal",
    controlName: "vulcanus_coal",
    // map_color = {0, 0, 0} (base/prototypes/entity/resources.lua)
    mapColor: [0, 0, 0],
    placement: "threshold",
  },
  {
    // The geyser is NOT a solid patch: every geyser in-game comes from a
    // per-tile RNG roll against the probability expression, which peaks below
    // 0.09, so no threshold on it yields a footprint. Until 2026-07-27 this
    // entry thresholded anyway and drew the whole *patch extent* - the region
    // where the game would roll at all - which overstates the geysers' area by
    // **4.2x** (measured: 371 placements at 2.8 x 2.8 against 12130 footprint
    // tiles over a +/-2000-tile sample, 0.240). Earlier text here and in the
    // notes said "more than an order of magnitude"; that was reasoned from the
    // pre-collision roll rate, never measured, and is wrong. It now rolls
    // (`docs/noise/placement-roll-NOTES.md`), and the roll's density is
    // validated against the game's own counts in `test/oracle/entityCounts.ts`,
    // whose fourth region exists precisely to give the geyser overlay something
    // to compare against.
    name: "sulfuric-acid-geyser",
    controlName: "sulfuric_acid_geyser",
    // map_color = {0.78, 0.78, 0.1} (space-age/prototypes/entity/resources.lua)
    mapColor: [199, 199, 26],
    placement: "roll",
  },
];
