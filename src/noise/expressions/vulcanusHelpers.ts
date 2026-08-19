/**
 * Vulcanus's reusable helper closures - `vulcanus_detail_noise`, `vulcanus_plasma`,
 * `vulcanus_threshold`, `vulcanus_contrast`, `vulcanus_biome_noise`, and the six
 * `vulcanus_wobble_*` fields built from `vulcanus_detail_noise` - all transcribed
 * verbatim from `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`
 * (`~/GitHub/factorio-data`, tag 2.1.11). These are the shared building blocks the
 * rest of the Vulcanus tree (climate, biomes, elevation) calls.
 *
 * Verbatim source (helper section, lines ~48-94 and ~399-425):
 *
 *   vulcanus_scale_multiplier = slider_rescale(control:vulcanus_volcanism:frequency, 3)
 *
 *   vulcanus_detail_noise(seed1, scale, octaves, magnitude) =
 *     multioctave_noise{x, y, seed0 = map_seed, seed1 = seed1 + 12243, octaves,
 *                        persistence = 0.6, input_scale = 1/50/scale, output_scale = magnitude}
 *
 *   vulcanus_plasma(seed, scale, scale2, magnitude1, magnitude2) =
 *     abs(basis_noise{x, y, seed0 = map_seed, seed1 = 12643,
 *                     input_scale = 1/50/scale, output_scale = magnitude1}
 *       - basis_noise{x, y, seed0 = map_seed, seed1 = 13423 + seed,
 *                     input_scale = 1/50/scale2, output_scale = magnitude2})
 *
 *   vulcanus_threshold(value, threshold) = (value - (1 - threshold)) * (1 / threshold)
 *   vulcanus_contrast(value, c) = clamp(value, c, 1) - c
 *
 *   vulcanus_biome_noise(seed1, scale) =
 *     multioctave_noise{x, y, persistence = 0.65, seed0 = map_seed, seed1, octaves = 5,
 *                        input_scale = vulcanus_scale_multiplier / scale}
 *     (no output_scale in the source -> the native op's default, 1)
 *
 *   vulcanus_wobble_x        = vulcanus_detail_noise{seed1 = 10,   scale = 1/8, octaves = 2, magnitude = 4}
 *   vulcanus_wobble_y        = vulcanus_detail_noise{seed1 = 1010, scale = 1/8, octaves = 2, magnitude = 4}
 *   vulcanus_wobble_large_x  = vulcanus_detail_noise{seed1 = 20,   scale = 1/2, octaves = 2, magnitude = 50}
 *   vulcanus_wobble_large_y  = vulcanus_detail_noise{seed1 = 1020, scale = 1/2, octaves = 2, magnitude = 50}
 *   vulcanus_wobble_huge_x   = vulcanus_detail_noise{seed1 = 30,   scale = 2,   octaves = 2, magnitude = 800}
 *   vulcanus_wobble_huge_y   = vulcanus_detail_noise{seed1 = 1030, scale = 2,   octaves = 2, magnitude = 800}
 *
 * IMPORTANT seed gotcha (easy to get wrong): `vulcanus_plasma`'s FIRST basis_noise
 * term has a hardcoded `seed1 = 12643` that does NOT depend on the function's
 * `seed` parameter - only the SECOND term uses `13423 + seed`. `vulcanus_detail_noise`
 * offsets its `seed1` parameter by `+ 12243` (distinct constant, one digit
 * transposed from `12643` - do not confuse the two).
 *
 * Validated against the oracle to the f32 floor for the three leaf expressions the
 * task brief names: `vulcanus_wobble_x`, `mountain_plasma = vulcanus_plasma(102,
 * 2.5, 10, 125, 625)`, and `vulcanus_detail_noise(837, 1/40, 4, 1.25)` - see
 * `test/vulcanusHelpers.spec.ts` / `test/fixtures/oracle-vulcanus-helpers.seed123456.json`.
 * `threshold`/`contrast` are pure arithmetic (no noise, no oracle risk) and
 * `biomeNoise` is exercised indirectly (same `makeMultioctaveNoise` primitive as
 * `detailNoise`, already oracle-validated per-primitive).
 */
import { basisNoiseTablesFromSeed } from "../basisNoise";
import type { EvalCtx } from "../eval/ctx";
import { clamp } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import { basisNoiseExpr } from "../eval/primitives";
import { sliderRescale } from "../eval/math";
import { makeMultioctaveNoise } from "../multioctaveNoise";

export interface VulcanusHelpers {
  /** `vulcanus_detail_noise(seed1, scale, octaves, magnitude)`. */
  detailNoise: (
    seed1: number,
    scale: number,
    octaves: number,
    magnitude: number,
  ) => (x: number, y: number) => number;
  /** `vulcanus_plasma(seed, scale, scale2, magnitude1, magnitude2)`. */
  plasma: (
    seed: number,
    scale: number,
    scale2: number,
    magnitude1: number,
    magnitude2: number,
  ) => (x: number, y: number) => number;
  /** `vulcanus_threshold(value, threshold)`. Pure arithmetic, no seed dependency. */
  threshold: (value: number, threshold: number) => number;
  /** `vulcanus_contrast(value, c)`. Pure arithmetic, no seed dependency. */
  contrast: (value: number, c: number) => number;
  /** `vulcanus_biome_noise(seed1, scale)`. */
  biomeNoise: (seed1: number, scale: number) => (x: number, y: number) => number;
  /** `vulcanus_scale_multiplier = slider_rescale(control:vulcanus_volcanism:frequency, 3)`. */
  scaleMultiplier: number;
  wobbleX: (x: number, y: number) => number;
  wobbleY: (x: number, y: number) => number;
  wobbleLargeX: (x: number, y: number) => number;
  wobbleLargeY: (x: number, y: number) => number;
  wobbleHugeX: (x: number, y: number) => number;
  wobbleHugeY: (x: number, y: number) => number;
}

/** Build the Vulcanus shared helper closures for one seed/ctx. */
export function makeVulcanusHelpers(ctx: EvalCtx): VulcanusHelpers {
  const seed0 = ctx.seed0;

  const detailNoise: VulcanusHelpers["detailNoise"] = (seed1, scale, octaves, magnitude) =>
    makeMultioctaveNoise({
      seed0,
      seed1: seed1 + 12243,
      octaves,
      persistence: 0.6,
      inputScale: 1 / 50 / scale,
      outputScale: magnitude,
    });

  const plasma: VulcanusHelpers["plasma"] = (seed, scale, scale2, magnitude1, magnitude2) => {
    // First term's seed1 is a hardcoded constant (12643), independent of `seed` -
    // see the file-level doc comment. Only the second term uses `13423 + seed`.
    const tablesA = basisNoiseTablesFromSeed(seed0, 12643);
    const tablesB = basisNoiseTablesFromSeed(seed0, 13423 + seed);
    return (x: number, y: number): number =>
      Math.abs(
        basisNoiseExpr(
          x,
          y,
          { seed0, seed1: 12643, inputScale: 1 / 50 / scale, outputScale: magnitude1 },
          tablesA,
        ) -
          basisNoiseExpr(
            x,
            y,
            {
              seed0,
              seed1: 13423 + seed,
              inputScale: 1 / 50 / scale2,
              outputScale: magnitude2,
            },
            tablesB,
          ),
      );
  };

  const threshold: VulcanusHelpers["threshold"] = (value, thresholdParam) =>
    (value - (1 - thresholdParam)) * (1 / thresholdParam);

  const contrast: VulcanusHelpers["contrast"] = (value, c) => clamp(value, c, 1) - c;

  const scaleMultiplier = sliderRescale(ctx.vulcanusVolcanismFrequency, 3);

  const biomeNoise: VulcanusHelpers["biomeNoise"] = (seed1, scale) =>
    makeMultioctaveNoise({
      seed0,
      seed1,
      octaves: 5,
      persistence: 0.65,
      inputScale: scaleMultiplier / scale,
      outputScale: 1,
    });

  // Each wobble is read by both the biome offset (offX/offY) and the spawn
  // distortion sums (wobbleXSum/wobbleYSum), so memoize per pixel.
  const wobbleX = memoXY(detailNoise(10, 1 / 8, 2, 4));
  const wobbleY = memoXY(detailNoise(1010, 1 / 8, 2, 4));
  const wobbleLargeX = memoXY(detailNoise(20, 1 / 2, 2, 50));
  const wobbleLargeY = memoXY(detailNoise(1020, 1 / 2, 2, 50));
  const wobbleHugeX = memoXY(detailNoise(30, 2, 2, 800));
  const wobbleHugeY = memoXY(detailNoise(1030, 2, 2, 800));

  return {
    detailNoise,
    plasma,
    threshold,
    contrast,
    biomeNoise,
    scaleMultiplier,
    wobbleX,
    wobbleY,
    wobbleLargeX,
    wobbleLargeY,
    wobbleHugeX,
    wobbleHugeY,
  };
}
