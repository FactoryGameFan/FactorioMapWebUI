/**
 * Vulcanus's elevation surface - `mountain_basis_noise`, `mountain_elevation`,
 * `volcano_inverted_peak`, `vulcanus_mountains_func`, `vulcanus_ashlands_func`,
 * `vulcanus_basalt_lakes`, and the biome-weighted `vulcanus_elev` lerp-of-lerps
 * plus `vulcanus_elevation = max(-500, vulcanus_elev)` - all transcribed verbatim
 * from `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`
 * (`~/GitHub/factorio-data`, tag 2.1.11, lines ~428-562). This is the surface Task 10
 * (tile colors) resolves against, and it closes Task 7's deferred `vulcanus_temperature`.
 *
 * Verbatim (constants: `vulcanus_elevation_offset = 0`,
 * `vulcanus_mountains_elevation_multiplier = 1.5`):
 *
 *   mountain_basis_noise = basis_noise{seed1 = 13423, input_scale = 1/500, output_scale = 250}
 *   mountain_plasma      = vulcanus_plasma(102, 2.5, 10, 125, 625)   -- helpers.plasma
 *
 *   mountain_elevation = lerp(max(clamp(mountain_plasma, -100, 10000), mountain_basis_noise),
 *                             mountain_plasma,
 *                             clamp(0.7 * mountain_basis_noise, 0, 1))
 *                        * (1 - clamp(vulcanus_plasma(13, 2.5, 10, 0.15, 0.75), 0, 1))
 *
 *   volcano_inverted_peak(spot, inversion_point) =
 *     (inversion_point - abs(spot - inversion_point)) / inversion_point
 *
 *   vulcanus_mountains_func =
 *     lerp(mountain_elevation,
 *          700 * volcano_inverted_peak(mountain_volcano_spots, 0.65),
 *          clamp(mountain_volcano_spots * 3, 0, 1))
 *     + 200 * (aux - 0.5) * (mountain_volcano_spots + 0.5)
 *
 *   vulcanus_ashlands_func (local scale = 3) =
 *     300 + 0.001 * min(basis_noise{seed1 = 12643, input_scale = vulcanus_scale_multiplier/50/scale, output_scale = 150},
 *                       basis_noise{...IDENTICAL...})
 *   -- the two basis calls are byte-identical, so min(a, a) = a (transcribed as written).
 *
 *   vulcanus_basalt_lakes =
 *     min(1, -0.2 + vulcanus_flood_basalts_func
 *            - 0.35 * clamp(vulcanus_contrast(vulcanus_detail_noise(837, 1/40, 4, 1.25), 0.95)
 *                           * vulcanus_contrast(vulcanus_detail_noise(234, 1/50, 4, 1), 0.95)
 *                           * vulcanus_detail_noise(643, 1/70, 4, 0.7),
 *                           0, 3))
 *
 *   vulcanus_elev = vulcanus_elevation_offset (= 0)
 *     + lerp(lerp(120 * vulcanus_basalt_lakes_multisample,
 *                 20 + vulcanus_mountains_func * vulcanus_mountains_elevation_multiplier (= 1.5),
 *                 vulcanus_mountains_biome),
 *            vulcanus_ashlands_func,
 *            vulcanus_ashlands_biome)
 *
 *   vulcanus_elevation = max(-500, vulcanus_elev)
 *
 * `vulcanus_basalt_lakes_multisample` (a `local_expression` of `vulcanus_elev`) is a
 * 2x2 MIN-FILTER over the four integer-neighbour corners, using Task 4's `multisample`
 * primitive (a plain integer coordinate shift: `multisample(f, dx, dy) at (x, y) =
 * f(x + dx, y + dy)`):
 *
 *   min(multisample(basalt_lakes, 0, 0), multisample(basalt_lakes, 1, 0),
 *       multisample(basalt_lakes, 0, 1), multisample(basalt_lakes, 1, 1))
 *   = min(basalt_lakes(x, y),   basalt_lakes(x+1, y),
 *         basalt_lakes(x, y+1), basalt_lakes(x+1, y+1))
 *
 * IMPORTANT: `vulcanus_temperature` (see {@link makeVulcanusTemperature}) reads the
 * RAW `vulcanus_elev`, NOT the `max(-500, ...)`-clamped `vulcanus_elevation`, so both
 * are exposed.
 *
 * Oracle-validated to the elevation-scale f32 floor - see
 * `test/vulcanusElevation.spec.ts` / `test/fixtures/oracle-vulcanus-elevation.seed123456.json`.
 */
import { basisNoiseTablesFromSeed } from "../basisNoise";
import type { EvalCtx } from "../eval/ctx";
import { clamp, lerp, max, min } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import { multisample } from "../eval/multisample";
import { basisNoiseExpr } from "../eval/primitives";
import type { VulcanusBiomes } from "./vulcanusBiomes";
import type { VulcanusClimate } from "./vulcanusClimate";
import type { VulcanusCracks } from "./vulcanusCracks";
import type { VulcanusHelpers } from "./vulcanusHelpers";

/** `vulcanus_elevation_offset = 0`. */
export const VULCANUS_ELEVATION_OFFSET = 0;
/** `vulcanus_mountains_elevation_multiplier = 1.5`. */
export const VULCANUS_MOUNTAINS_ELEVATION_MULTIPLIER = 1.5;
/** `vulcanus_ashlands_func`'s `local_expressions.scale = 3`. */
const ASHLANDS_SCALE = 3;

export interface VulcanusElevation {
  /** `vulcanus_elev` (raw, pre-clamp; read by `vulcanus_temperature`). */
  elev(x: number, y: number): number;
  /** `vulcanus_elevation` (= `max(-500, vulcanus_elev)`). */
  elevation(x: number, y: number): number;
  /**
   * `vulcanus_elevation` as the CLIFF GENERATOR sees it - the same field with
   * `vulcanus_basalt_lakes_multisample`'s min-filter widened from 1 tile to the
   * 4-tile cliff lattice, because `multisample`'s offsets are in the consuming
   * noise program's GRID UNITS. See `msGrid` in {@link makeVulcanusElevation}.
   *
   * It hangs off the same object rather than needing a second stack: every
   * sub-expression below the multisample (helpers, cracks, biomes, climate, the
   * basalt-lakes field itself) is shared and stays memoized, so the extra cost is
   * one more top-level lerp and four already-memoized basalt-lakes lookups at
   * shifted points. Building a private DAG for cliffs instead cost enough to
   * time the render tests out.
   */
  cliffElevation(x: number, y: number): number;
}

/** Build the Vulcanus elevation surface for one seed/ctx. */
export function makeVulcanusElevation(
  ctx: EvalCtx,
  helpers: VulcanusHelpers,
  biomes: VulcanusBiomes,
  cracks: VulcanusCracks,
  climate: VulcanusClimate,
): VulcanusElevation {
  /**
   * **`multisample`'s offsets are in GRID UNITS, not tiles** - so this scales
   * the basalt-lakes min-filter's footprint to the grid of whatever noise
   * program is consuming the field. 1 (the default) is the per-tile channel
   * every tile/terrain consumer uses; the cliff generator walks the 4-tile
   * corner lattice and passes 4.
   *
   * Measured 2026-08-01 through the cliff generator itself
   * (`test/oracle/capture.ts multisample-grid`, `test/multisampleGrid.spec.ts`):
   * routing `multisample(x, 4, 0)` onto `cliff_elevation` moves the contour by
   * **16 tiles, not 4**. The primitive's own docs say it evaluates "in a
   * separate noise program with a larger grid", and that is what "larger grid"
   * means. `docs/noise/vulcanus-multisample-NOTES.md` measured `x + dx` and was
   * right - for `calculate_tile_properties`, whose grid is 1 tile.
   */
  const CLIFF_MULTISAMPLE_GRID = 4;
  const seed0 = ctx.seed0;

  // --- basis_noise leaves (own seed tables) ----------------------------------
  const makeBasis = (seed1: number, inputScale: number, outputScale: number) => {
    const tables = basisNoiseTablesFromSeed(seed0, seed1);
    return (x: number, y: number): number =>
      basisNoiseExpr(x, y, { seed0, seed1, inputScale, outputScale }, tables);
  };
  const mountainBasisNoise = makeBasis(13423, 1 / 500, 250);
  const ashlandsBasisNoise = makeBasis(12643, helpers.scaleMultiplier / 50 / ASHLANDS_SCALE, 150);

  // --- mountain_elevation ----------------------------------------------------
  const mountainPlasma = helpers.plasma(102, 2.5, 10, 125, 625); // mountain_plasma
  const mountainElevPlasma = helpers.plasma(13, 2.5, 10, 0.15, 0.75); // the (1 - clamp(...)) factor

  const mountainElevation = (x: number, y: number): number => {
    const mp = mountainPlasma(x, y);
    const mbn = mountainBasisNoise(x, y);
    const base = lerp(max(clamp(mp, -100, 10000), mbn), mp, clamp(0.7 * mbn, 0, 1));
    return base * (1 - clamp(mountainElevPlasma(x, y), 0, 1));
  };

  // --- vulcanus_mountains_func -----------------------------------------------
  const volcanoInvertedPeak = (spot: number, inversionPoint: number): number =>
    (inversionPoint - Math.abs(spot - inversionPoint)) / inversionPoint;

  const mountainsFunc = (x: number, y: number): number => {
    const mvs = biomes.mountainVolcanoSpots(x, y);
    return (
      lerp(mountainElevation(x, y), 700 * volcanoInvertedPeak(mvs, 0.65), clamp(mvs * 3, 0, 1)) +
      200 * (climate.aux(x, y) - 0.5) * (mvs + 0.5)
    );
  };

  // --- vulcanus_ashlands_func (min of two identical basis calls = itself) -----
  const ashlandsFunc = (x: number, y: number): number =>
    300 + 0.001 * min(ashlandsBasisNoise(x, y), ashlandsBasisNoise(x, y));

  // --- vulcanus_basalt_lakes -------------------------------------------------
  const bl837 = helpers.detailNoise(837, 1 / 40, 4, 1.25);
  const bl234 = helpers.detailNoise(234, 1 / 50, 4, 1);
  const bl643 = helpers.detailNoise(643, 1 / 70, 4, 0.7);

  const basaltLakes = (x: number, y: number): number =>
    min(
      1,
      -0.2 +
        cracks.floodBasaltsFunc(x, y) -
        0.35 *
          clamp(
            helpers.contrast(bl837(x, y), 0.95) * helpers.contrast(bl234(x, y), 0.95) * bl643(x, y),
            0,
            3,
          ),
    );

  // vulcanus_basalt_lakes_multisample: a 2x2 min-filter whose footprint is one
  // GRID STEP wide - `g` tiles, not necessarily one tile. See the note above.
  const basaltLakesMultisample = (x: number, y: number, g: number): number =>
    min(
      multisample(basaltLakes, x, y, 0, 0),
      multisample(basaltLakes, x, y, g, 0),
      multisample(basaltLakes, x, y, 0, g),
      multisample(basaltLakes, x, y, g, g),
    );

  // --- vulcanus_elev / vulcanus_elevation ------------------------------------
  // `elev` is read ~12x per pixel by the tile `*_range` expressions (and again by
  // temperature), so memoize it; `elevation` piggybacks on the memoized `elev`.
  const elevAtGrid = (x: number, y: number, g: number): number => {
    const mountainsBlend = lerp(
      120 * basaltLakesMultisample(x, y, g),
      20 + mountainsFunc(x, y) * VULCANUS_MOUNTAINS_ELEVATION_MULTIPLIER,
      biomes.mountainsBiome(x, y),
    );
    return (
      VULCANUS_ELEVATION_OFFSET +
      lerp(mountainsBlend, ashlandsFunc(x, y), biomes.ashlandsBiome(x, y))
    );
  };

  const elev = memoXY((x: number, y: number): number => elevAtGrid(x, y, 1));
  const elevation = (x: number, y: number): number => max(-500, elev(x, y));

  // Memoized separately: the cliff pass samples only the 4-tile corner lattice,
  // so its working set is ~1/16 of the tile pass's and must not evict it.
  const cliffElev = memoXY((x: number, y: number): number =>
    elevAtGrid(x, y, CLIFF_MULTISAMPLE_GRID),
  );
  const cliffElevation = (x: number, y: number): number => max(-500, cliffElev(x, y));

  return { elev, elevation, cliffElevation };
}

/**
 * `vulcanus_temperature` - deferred out of Task 7 (`makeVulcanusClimate`) until
 * `vulcanus_elev` existed. Kept a separate function (rather than retro-fitting the
 * climate signature) because it needs the raw elev, which climate does not. Transcribed
 * verbatim (lines ~104-115):
 *
 *   vulcanus_temperature =
 *     100 + 100 * var('control:temperature:bias')
 *     - min(vulcanus_elev, vulcanus_elev / 100)
 *     - 2 * vulcanus_moisture
 *     - 1 * vulcanus_aux
 *     - 20 * vulcanus_ashlands_biome
 *     + 200 * max(0, mountain_volcano_spots - 0.6)
 *
 * It reads the RAW `vulcanus_elev` (`elevation.elev`), NOT the `max(-500, ...)`-clamped
 * `vulcanus_elevation`. Oracle-validated in `test/vulcanusElevation.spec.ts` against
 * `test/fixtures/oracle-vulcanus-temperature.seed123456.json`.
 */
export function makeVulcanusTemperature(
  ctx: EvalCtx,
  climate: VulcanusClimate,
  biomes: VulcanusBiomes,
  elevation: VulcanusElevation,
): (x: number, y: number) => number {
  return (x: number, y: number): number => {
    const e = elevation.elev(x, y);
    return (
      100 +
      100 * ctx.temperatureBias -
      min(e, e / 100) -
      2 * climate.moisture(x, y) -
      1 * climate.aux(x, y) -
      20 * biomes.ashlandsBiome(x, y) +
      200 * max(0, biomes.mountainVolcanoSpots(x, y) - 0.6)
    );
  };
}
