import { PLANET_LABELS, PLANETS, type Planet } from "./planets";

export type ControlCategory = "resource" | "terrain" | "enemy";

/** Which of the shared autoplace knobs a table column edits. */
export type ControlColumnKey = "frequency" | "size" | "richness";

/** A relabelled autoplace column, e.g. Scale/Coverage for terrain coverage. */
export interface ControlColumn {
  key: ControlColumnKey;
  label: string;
}

/** Terrain splits into two tables: coverage (scale/coverage) and cliffs (frequency/continuity). */
export type TerrainGroup = "coverage" | "cliff";

export interface ControlEntry {
  planet: Planet;
  category: ControlCategory;
  label: string;
  hasRichness: boolean;
  /** True iff the game exposes an enable/disable checkbox for this control (its `can_be_disabled` flag). */
  canBeDisabled: boolean;
  /** Set only for terrain controls, to split them into their two tables. */
  terrainGroup?: TerrainGroup;
  /** Optional native-title help text shown as an info glyph after the label. */
  info?: string;
}

function resource(planet: Planet, label: string): ControlEntry {
  return { planet, category: "resource", label, hasRichness: true, canBeDisabled: true };
}

function terrain(
  planet: Planet,
  label: string,
  canBeDisabled: boolean,
  terrainGroup: TerrainGroup = "coverage",
): ControlEntry {
  return { planet, category: "terrain", label, hasRichness: false, canBeDisabled, terrainGroup };
}

function cliff(planet: Planet, label: string): ControlEntry {
  return terrain(planet, label, true, "cliff");
}

function enemy(planet: Planet, label: string): ControlEntry {
  return { planet, category: "enemy", label, hasRichness: false, canBeDisabled: false };
}

/** All 28 autoplace controls of Factorio 2.1.9 Space Age, keyed by wire name. */
export const CONTROL_CATALOG: Record<string, ControlEntry> = {
  // Nauvis (unprefixed names)
  "iron-ore": resource("nauvis", "Iron ore"),
  "copper-ore": resource("nauvis", "Copper ore"),
  stone: resource("nauvis", "Stone"),
  coal: resource("nauvis", "Coal"),
  "crude-oil": resource("nauvis", "Crude oil"),
  "uranium-ore": resource("nauvis", "Uranium ore"),
  "enemy-base": {
    ...enemy("nauvis", "Enemy bases"),
    info: "Note: Value lower than 100% will disable some achievements.",
  },
  water: { ...terrain("nauvis", "Water", true), info: "If disabled: only in starting area" },
  trees: terrain("nauvis", "Trees", true),
  rocks: terrain("nauvis", "Rocks", true),
  nauvis_cliff: cliff("nauvis", "Cliffs"),
  starting_area_moisture: terrain("nauvis", "Starting area moisture", true),
  // Vulcanus
  vulcanus_coal: resource("vulcanus", "Coal"),
  calcite: resource("vulcanus", "Calcite"),
  sulfuric_acid_geyser: resource("vulcanus", "Sulfuric acid geyser"),
  tungsten_ore: resource("vulcanus", "Tungsten ore"),
  vulcanus_volcanism: terrain("vulcanus", "Vulcanus volcanism", false),
  // Gleba
  gleba_stone: resource("gleba", "Stone"),
  gleba_water: terrain("gleba", "Gleba water", false),
  gleba_plants: terrain("gleba", "Gleba plants", false),
  gleba_cliff: cliff("gleba", "Gleba cliffs"),
  gleba_enemy_base: {
    ...enemy("gleba", "Gleba enemy bases"),
    info: "Note: Value lower than 100% will disable some achievements.",
  },
  // Fulgora
  scrap: resource("fulgora", "Scrap"),
  fulgora_cliff: cliff("fulgora", "Fulgora cliffs"),
  fulgora_islands: terrain("fulgora", "Fulgora islands", false),
  // Aquilo
  aquilo_crude_oil: resource("aquilo", "Crude oil"),
  lithium_brine: resource("aquilo", "Lithium brine"),
  fluorine_vent: resource("aquilo", "Fluorine vent"),
};

/** Labels two planets both use, so the label alone cannot identify a row. */
const AMBIGUOUS_LABELS: ReadonlySet<string> = new Set(
  Object.values(CONTROL_CATALOG)
    .map((entry) => entry.label)
    .filter((label, i, all) => all.indexOf(label) !== i),
);

/**
 * The row's label, made unique across the catalog. Three labels (Coal, Stone,
 * Crude oil) appear on two planets each, and the tables list every planet in
 * one table - so those rows are told apart visually by the "Appears on" icon
 * alone. A control's accessible name has no such column to lean on, so it
 * carries the planet inline.
 */
export function controlRowLabel(name: string): string {
  const entry = CONTROL_CATALOG[name];
  if (!entry) return name;
  return AMBIGUOUS_LABELS.has(entry.label)
    ? `${entry.label} (${PLANET_LABELS[entry.planet]})`
    : entry.label;
}

export function controlsFor(planet: Planet, category: ControlCategory): string[] {
  return Object.entries(CONTROL_CATALOG)
    .filter(([, entry]) => entry.planet === planet && entry.category === category)
    .map(([name]) => name);
}

/**
 * Every control of a category across all planets, grouped in planet order
 * (Nauvis first), matching the game's single "Appears on"-tagged table.
 */
export function controlsForCategory(category: ControlCategory): string[] {
  return PLANETS.flatMap((planet) => controlsFor(planet, category));
}

/**
 * Terrain controls of one group (coverage or cliff), in planet order, so the
 * Terrain tab can render its two tables from the single terrain category.
 */
export function controlsForTerrainGroup(group: TerrainGroup): string[] {
  return controlsForCategory("terrain").filter(
    (name) => CONTROL_CATALOG[name]?.terrainGroup === group,
  );
}
