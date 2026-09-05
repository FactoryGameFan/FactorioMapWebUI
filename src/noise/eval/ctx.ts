import { seedNormalized, seedSmall } from "../expressions/vulcanusSeed";

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

/** Neutral/default sliders - the same `1` convention as `vulcanusVolcanismFrequency`. */
export const DEFAULT_VULCANUS_RESOURCE_CONTROLS: VulcanusResourceControls = {
  tungstenOre: { frequency: 1, size: 1 },
  vulcanusCoal: { frequency: 1, size: 1 },
  calcite: { frequency: 1, size: 1 },
  sulfuricAcidGeyser: { frequency: 1, size: 1 },
};

/**
 * The complete free-variable environment the `elevation_lakes` tree needs. Every
 * field maps to a game noise variable: `seed0 = map_seed`,
 * `waterLevel = 10*log2(control:water:size)`, `segmentationMultiplier =
 * control:water:frequency`, and the two spawn/lake point lists. `distance` is NOT
 * stored - it is derived from `startingPositions` at evaluation time (single source
 * of truth). No `control:*` constant is referenced by elevation_lakes, so none are
 * plumbed.
 */
export interface EvalCtx {
  x: number;
  y: number;
  seed0: number;
  waterLevel: number;
  segmentationMultiplier: number;
  startingPositions: Point[];
  /**
   * Lake points for `starting_lake_distance`. Optional: when unset,
   * `makeElevationLakes` computes the game's real positions from
   * `(seed0, startingPositions)` (the single owner of this default). An explicit
   * value (including `[]`) is honored as-is.
   */
  startingLakePositions?: Point[];

  // --- Vulcanus additions (Task 5) ---------------------------------------
  /**
   * `control:vulcanus_volcanism:frequency` (the wire value of the autoplace
   * control's frequency slider). Neutral/default = `1` - confirmed against the
   * oracle (`vulcanus_scale_multiplier = slider_rescale(1, 3) = 1` at the default
   * preset), the same convention every other autoplace control in this codebase
   * uses (e.g. `control:trees:frequency`), NOT `0`.
   */
  vulcanusVolcanismFrequency: number;
  /** `control:vulcanus_volcanism:size` (wire value). Neutral/default = `1`, same convention as {@link vulcanusVolcanismFrequency}. */
  vulcanusVolcanismSize: number;
  /** `control:temperature:bias` (wire value). Default = `0` (no bias). */
  temperatureBias: number;
  /**
   * `control:<resource>:frequency|size` for the four Vulcanus resources (V2).
   * Consumed only by `makeVulcanusResources`; every other planet ignores it.
   */
  vulcanusResourceControls: VulcanusResourceControls;
  /**
   * `map_seed_normalized`, the engine's own free var. Computed default:
   * `seedNormalized(seed0)` (Task 2). Overridable only to cross-check a fixture
   * that pins this value independent of `seed0`.
   */
  mapSeedNormalized: number;
  /**
   * `map_seed_small`, the engine's own free var. Computed default:
   * `seedSmall(seed0)` (Task 2). Overridable only to cross-check a fixture that
   * pins this value independent of `seed0`.
   */
  mapSeedSmall: number;
}

/** Everything except the required `seed0` may be omitted and defaulted. */
export type EvalCtxInput = { seed0: number } & Partial<Omit<EvalCtx, "seed0">>;

/** The far-from-spawn MVP defaults (see the M1 design spec), plus the Vulcanus neutral-control defaults (Task 5). */
export const DEFAULT_CTX_FIELDS = {
  x: 0,
  y: 0,
  waterLevel: 0,
  segmentationMultiplier: 1,
  startingPositions: [{ x: 0, y: 0 }] as Point[],
  vulcanusVolcanismFrequency: 1,
  vulcanusVolcanismSize: 1,
  temperatureBias: 0,
};

/** Apply the M1 (+ Task 5 Vulcanus) defaults over a partial input. Array defaults are fresh per call. */
export function withCtxDefaults(input: EvalCtxInput): EvalCtx {
  return {
    x: input.x ?? DEFAULT_CTX_FIELDS.x,
    y: input.y ?? DEFAULT_CTX_FIELDS.y,
    seed0: input.seed0,
    waterLevel: input.waterLevel ?? DEFAULT_CTX_FIELDS.waterLevel,
    segmentationMultiplier:
      input.segmentationMultiplier ?? DEFAULT_CTX_FIELDS.segmentationMultiplier,
    startingPositions: input.startingPositions ?? [{ x: 0, y: 0 }],
    startingLakePositions: input.startingLakePositions,
    vulcanusVolcanismFrequency:
      input.vulcanusVolcanismFrequency ?? DEFAULT_CTX_FIELDS.vulcanusVolcanismFrequency,
    vulcanusVolcanismSize: input.vulcanusVolcanismSize ?? DEFAULT_CTX_FIELDS.vulcanusVolcanismSize,
    temperatureBias: input.temperatureBias ?? DEFAULT_CTX_FIELDS.temperatureBias,
    vulcanusResourceControls: input.vulcanusResourceControls ?? DEFAULT_VULCANUS_RESOURCE_CONTROLS,
    mapSeedNormalized: input.mapSeedNormalized ?? seedNormalized(input.seed0),
    mapSeedSmall: input.mapSeedSmall ?? seedSmall(input.seed0),
  };
}
