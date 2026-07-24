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
 * The order here is functionally inert either way: all three autoplace
 * `order = "b"`, so ties fall back to registration order, but the three
 * favorabilities gate on disjoint biomes (basalts / mountains / ashlands), so
 * two of them are never simultaneously eligible at the same pixel and the
 * tie-break never fires. Listed in this order for readability, not correctness -
 * do not reorder this catalog on the strength of the citation fix above.
 *
 * The sulfuric acid geyser is deliberately absent: it is a fluid placed at
 * `density * 0.025` (scattered points, not a solid patch), deferred to V3. Its
 * region field is still computed, because the tile catalog reads it.
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
  /** Which `VulcanusResources` region decides this ore's footprint. */
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
];
