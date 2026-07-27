import type {
  AreaToGenerateAtStart,
  AutoplaceSetting,
  FormatVersion,
  MapPosition,
  StartingPoint,
} from "../codec/mapExchangeString";
import type { CliffSettings, MapSettings } from "./mapSettings";

export type { AreaToGenerateAtStart, AutoplaceSetting, FormatVersion, MapPosition, StartingPoint };

export interface Preset {
  name: string;
  builtin: boolean;
  /**
   * Which built-in this preset's values came from, if any - the target of the
   * Reset button. Set by the store's `createFromBuiltin` / `applyBuiltinToActive`
   * / first-launch seeding.
   *
   * Optional on purpose, and `PersistedState` stays at version 1 because of it:
   * "origin unknown" is a legal state, so presets already in localStorage from
   * before this field existed need no migration. It is also absent for presets
   * imported from an exchange string - a pasted string has no built-in origin,
   * and guessing one would be wrong. Reset is simply disabled in both cases.
   *
   * Model-only: `presetToEncodable` never reads it, so the exchange string and
   * its byte-exactness are unaffected.
   */
  sourceBuiltin?: string;
  /**
   * Map generation seed (u32 LE at mid offset 2). `null` is the single source
   * of truth for "random each new map" and encodes to wire 0; a wire 0 decodes
   * back to `null`. The "Random each new map" UI checkbox is a pure computed
   * view over this field (checked iff seed === null).
   */
  seed: number | null;
  autoplaceControls: Record<string, AutoplaceSetting>;
  /** Map width in tiles (typed from the mid-block; editable). */
  width: number;
  /** Map height in tiles (typed from the mid-block; editable). */
  height: number;
  /** Starting-area size scale (f32 LE at mid offset 38; typed in Phase 1c). */
  startingArea: number;
  /** peaceful_mode flag (bool at mid offset 42; typed from the mid-block). */
  peacefulMode: boolean;
  /** no_enemies_mode flag (bool at mid offset 43; typed from the mid-block). */
  noEnemiesMode: boolean;
  /** default_enable_all_autoplace_controls (bool at mid offset 1; typed from the mid-block). */
  defaultEnableAllAutoplaceControls: boolean;
  /** area_to_generate_at_start: the engine's pre-generated spawn region (a constant (-224,-224)-(+224,+224) box), typed from the mid-block. Vestigial and non-editable; carried for byte-exact round-trip. */
  areaToGenerateAtStart: AreaToGenerateAtStart;
  /** starting_points (MapGenSettings.starting_points): map spawn positions in tile coordinates, typed from the variable-length mid-block trailer. */
  startingPoints: StartingPoint[];
  propertyExpressionNames: Record<string, string>;
  /**
   * Base64 of the undecoded payload bytes after property_expression_names
   * (cliffs, MapSettings, difficulty).
   * Carried opaquely so the Phase 1 encoder can round-trip before those
   * fields are individually mapped. Replaced by typed fields in Phase 1.
   */
  opaqueTailB64: string;
  /** Nested, typed view of the cliff section of the tail, derived from `opaqueTailB64` for JSON export/display. Read-only; not the round-trip source of truth. */
  cliffSettings: CliffSettings;
  /**
   * Nested, typed view of the MapSettings sections of the tail. The
   * enemyEvolution / enemyExpansion sections and the Advanced-tab subset of
   * pollution (enabled, ageing, enemyAttackPollutionConsumptionModifier,
   * minPollutionToDamageTrees, pollutionRestoredPerTreeDamage, diffusionRatio),
   * difficulty (technologyPriceMultiplier, spoilTimeModifier), and asteroids
   * (spawningRate) are round-trip EDITABLE: `presetToEncodable` overlays them
   * back onto the tail (see `writeMapSettingsToTail`). Every OTHER field here
   * (unitGroup, pathFinder, the remaining pollution/difficulty keys) is a
   * read-only derived view for JSON export/display and is ignored by the
   * encoder - wiring one to a control requires extending the overlay first.
   */
  mapSettings: MapSettings;
  formatVersion: FormatVersion;
}
