/**
 * A point in world tiles.
 *
 * Declared here since #371 deleted `distanceFromNearestPoint.ts`, whose port is
 * `crates/fmw-noise/src/distance_from_nearest_point.rs`. The spawn and lake
 * lists a render request carries are what still needs it on this side.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * `control:<resource>:frequency|size` for one Vulcanus resource. Richness is
 * deliberately absent: the client preview renders placement, not yield, so no
 * Vulcanus richness expression is ported (see the V2 design spec).
 */
export interface VulcanusResourceLevers {
  readonly frequency: number;
  readonly size: number;
}

/** The four Vulcanus resource autoplace controls, keyed by their in-code name. */
export interface VulcanusResourceControls {
  readonly tungstenOre: VulcanusResourceLevers;
  readonly vulcanusCoal: VulcanusResourceLevers;
  readonly calcite: VulcanusResourceLevers;
  readonly sulfuricAcidGeyser: VulcanusResourceLevers;
}
