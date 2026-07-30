/**
 * The two cliff fields for Vulcanus.
 *
 * Vulcanus does not reuse Nauvis's cliff expressions. `planet-map-gen.lua:13-14`
 * overrides both properties:
 *
 * ```lua
 * cliffiness      = "cliffiness_basic",
 * cliff_elevation = "cliff_elevation_from_elevation",   -- = "elevation"
 * cliff_settings  = { name = "cliff-vulcanus",
 *                     cliff_elevation_interval = 120,
 *                     cliff_elevation_0 = 70 }
 * ```
 *
 * so the port is much smaller than the Nauvis one: `cliff_elevation` is just the
 * planet's own elevation (already ported), and `cliffiness_basic` is a single
 * clamp over a 2-octave `quick_multioctave_noise` (also already ported). None of
 * the Nauvis hills/ringbreak/billows machinery is involved.
 *
 * **There are no Vulcanus cliff sliders.** `space-age/prototypes/autoplace-controls.lua`
 * defines `gleba_cliff` and `fulgora_cliff` but no Vulcanus equivalent, and
 * `planet_map_gen.vulcanus()`'s `autoplace_controls` list contains no cliff
 * entry - so frequency and continuity are fixed at 1 and `cliff_richness`
 * (`getModifiedRichness(richness, size)`) is fixed at 1. The interval and
 * elevation-0 below are planet constants for the same reason: they come from the
 * planet definition, not from the user's preset, which describes a Nauvis
 * surface. Contrast Nauvis, where all four come off `preset.cliffSettings` and
 * the `nauvis_cliff` control.
 */

import type { EvalCtx } from "../eval/ctx";
import { makeVulcanusBiomes } from "../expressions/vulcanusBiomes";
import { makeVulcanusClimate } from "../expressions/vulcanusClimate";
import { makeVulcanusCracks } from "../expressions/vulcanusCracks";
import { makeVulcanusElevation } from "../expressions/vulcanusElevation";
import { makeVulcanusHelpers } from "../expressions/vulcanusHelpers";
import { makeVulcanusSpawn } from "../expressions/vulcanusSpawn";
import { quickMultioctaveNoise } from "../quickMultioctaveNoise";
import type { VulcanusStack } from "../tiles/vulcanusCatalog";
import type { CliffFields } from "./cliffPlacement";

/** `cliff_elevation_0` from `planet_map_gen.vulcanus()`'s `cliff_settings`. */
export const VULCANUS_CLIFF_ELEVATION_0 = 70;

/** `cliff_elevation_interval` from the same `cliff_settings`. */
export const VULCANUS_CLIFF_ELEVATION_INTERVAL = 120;

/**
 * `cliff_smoothing` on Vulcanus - **1, and it is load-bearing.**
 *
 * Vulcanus's `cliff_settings` block sets only `name`, `cliff_elevation_interval`
 * and `cliff_elevation_0`, so smoothing takes the CliffPlacementSettings
 * prototype default, which is `1` (full smoothing), not 0. Vulcanus is the odd
 * planet out: Nauvis (`base/prototypes/planet/planet-map-gen.lua:18`), Fulgora
 * and Gleba all set `cliff_smoothing = 0` explicitly, Fulgora with the comment
 * "This is critical for correct cliff placement."
 *
 * The prototype docs say smoothing "makes cliffs straighter on rough elevation
 * but makes placement inaccurate", and that is exactly what it did here: with
 * this left at Nauvis's 0, Vulcanus reproduced 57-69% of real cliffs while
 * placing 1.1-1.6x too many (issue #18). See `smoothingKnots` in
 * `cliffPlacement.ts` for the rule this feeds.
 */
export const VULCANUS_CLIFF_SMOOTHING = 1;

/**
 * `cliff_richness` on Vulcanus. `getModifiedRichness(richness, size)` with no
 * cliff autoplace control to move either lever, so it is pinned at 1 and the
 * `0.5 * log2(cliff_richness)` term of `cliffiness_basic` vanishes. Kept as a
 * named constant rather than folded away so the expression below still reads
 * like the Lua it ports.
 */
export const VULCANUS_CLIFF_RICHNESS = 1;

/** `seed1` of `cliffiness_basic`'s `quick_multioctave_noise` call. */
export const CLIFFINESS_BASIC_SEED1 = 123;

/**
 * `cliffiness_basic` (`core/prototypes/noise-programs.lua:310`):
 *
 * ```
 * clamp(0.5 * log2(cliff_richness) +
 *       quick_multioctave_noise{x = x, y = y, seed0 = map_seed, seed1 = 123,
 *                               input_scale = 1/32, output_scale = 1, octaves = 2,
 *                               octave_output_scale_multiplier = 1,
 *                               octave_input_scale_multiplier = 1/3},
 *       0, 1) + 0.5
 * ```
 *
 * Range `[0.5, 1.5]`. That matters for the placement gate: `crossesCliff`
 * compares the AVERAGE of two corners' cliffiness against `0.5`, so on Vulcanus
 * an edge is cliffy whenever the clamp is above zero at either corner - a
 * continuous field, unlike Nauvis's `cliffiness_nauvis` which is a hard 0-or-10
 * gate. Same comparison, different shape of input.
 */
export function makeCliffinessBasic(
  seed0: number,
  cliffRichness = VULCANUS_CLIFF_RICHNESS,
): (x: number, y: number) => number {
  const richnessTerm = 0.5 * Math.log2(cliffRichness);
  return (x: number, y: number): number => {
    const n = quickMultioctaveNoise(x, y, {
      seed0,
      seed1: CLIFFINESS_BASIC_SEED1,
      octaves: 2,
      inputScale: 1 / 32,
      outputScale: 1,
      octaveOutputScaleMultiplier: 1,
      octaveInputScaleMultiplier: 1 / 3,
      offsetX: 0,
    });
    return Math.min(1, Math.max(0, richnessTerm + n)) + 0.5;
  };
}

/**
 * Both fields the placement pass needs, for one seed/ctx. `cliffElevation` is
 * `vulcanus_elevation` itself (`= max(-500, vulcanus_elev)`), which is what
 * `cliff_elevation_from_elevation` resolves to once the planet has routed the
 * `elevation` property at `vulcanus_elevation`.
 */
export function makeVulcanusCliffFields(ctx: EvalCtx, shared?: VulcanusStack): CliffFields {
  // Same seam `makeVulcanusRockFields` uses: reuse the composite's one stack
  // when there is one, and build a private DAG only for a standalone call.
  const elevation =
    shared?.elevation ??
    (() => {
      const helpers = makeVulcanusHelpers(ctx);
      const spawn = makeVulcanusSpawn(ctx, helpers);
      const cracks = makeVulcanusCracks(ctx, helpers);
      const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
      const climate = makeVulcanusClimate(ctx, helpers, cracks);
      return makeVulcanusElevation(ctx, helpers, biomes, cracks, climate);
    })();

  return {
    cliffElevation: (x, y) => elevation.elevation(x, y),
    cliffiness: makeCliffinessBasic(ctx.seed0),
  };
}
