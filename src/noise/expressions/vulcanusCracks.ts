/**
 * Vulcanus's crack/flood helpers - `vulcanus_hairline_cracks`,
 * `vulcanus_flood_cracks_a`, `vulcanus_flood_cracks_b`, `vulcanus_flood_paths`,
 * and `vulcanus_flood_basalts_func` - transcribed verbatim from
 * `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` (`~/GitHub/factorio-data`,
 * tag 2.1.11, lines ~490-523). These build the lava/plate pattern that Task 9's
 * elevation (`vulcanus_basalt_lakes` -> `vulcanus_elev`) samples; they are pure noise
 * (no spawn dependency), stacked on `makeVulcanusHelpers`'s `plasma`/`detailNoise`.
 *
 * `vulcanus_cracks_scale = 0.325` (a bare number literal in the source - the file's
 * "used to be segmentation_multiplier" constant). Every scale argument below is that
 * constant times a per-call factor, transcribed exactly.
 *
 * Verbatim:
 *
 *   cracks_scale = 0.325
 *
 *   hairline_cracks = plasma(15223, 0.3*cs, 0.6*cs, 0.6, 1)
 *
 *   flood_cracks_a = lerp(min(plasma(7543, 2.5*cs, 4*cs, 0.5, 1),
 *                             plasma(7443, 1.5*cs, 3.5*cs, 0.5, 1)),
 *                         1,
 *                         clamp(detail_noise(241, 2*cs, 2, 0.25), 0, 1))
 *
 *   flood_cracks_b = lerp(1,
 *                         min(plasma(12223, 2*cs, 3*cs, 0.5, 1),
 *                             plasma(152, 1*cs, 1.5*cs, 0.25, 0.5)) - 0.5,
 *                         clamp(0.2 + detail_noise(821, 6*cs, 2, 0.5), 0, 1))
 *
 *   flood_paths = 0.4 - plasma(1543, 1.5*cs, 3*cs, 0.5, 1)
 *                     + min(0, detail_noise(121, cs*4, 2, 0.5))
 *
 *   flood_basalts_func = min(max(flood_cracks_a - 0.125, flood_paths), flood_cracks_b)
 *                        + 0.3 * min(0.5, hairline_cracks)
 *
 * `detail_noise`'s call form here is positional (`detail_noise(seed1, scale, octaves,
 * magnitude)`), matching `VulcanusHelpers.detailNoise`'s signature 1:1.
 */
import type { EvalCtx } from "../eval/ctx";
import { clamp, lerp, max, min } from "../eval/math";
import { f32 } from "../eval/f32";
import { memoXY } from "../eval/memoXY";
import type { VulcanusHelpers } from "./vulcanusHelpers";

/** `vulcanus_cracks_scale` - a bare number literal in the source (was segmentation_multiplier). */
export const VULCANUS_CRACKS_SCALE = 0.325;

export interface VulcanusCracks {
  /** `vulcanus_hairline_cracks`. */
  hairlineCracks(x: number, y: number): number;
  /** `vulcanus_flood_cracks_a`. */
  floodCracksA(x: number, y: number): number;
  /** `vulcanus_flood_cracks_b`. */
  floodCracksB(x: number, y: number): number;
  /** `vulcanus_flood_paths`. */
  floodPaths(x: number, y: number): number;
  /** `vulcanus_flood_basalts_func`. */
  floodBasaltsFunc(x: number, y: number): number;
}

/** Build the Vulcanus crack/flood closures for one seed/ctx. */
export function makeVulcanusCracks(_ctx: EvalCtx, helpers: VulcanusHelpers): VulcanusCracks {
  // `vulcanus_cracks_scale` is a noise-EXPRESSION, not a Lua number, so every
  // `k * vulcanus_cracks_scale` below is an f32 multiply inside the noise
  // machine (#293). 0.325 has no exact f32 form, so holding it and narrowing
  // each product is what takes `hairlineCracks` from 2 of 61 to 61 of 61 with
  // worst residual exactly 0. `scaled` is that multiply, written once.
  const cs = f32(VULCANUS_CRACKS_SCALE);
  const scaled = (k: number): number => f32(f32(k) * cs);
  const { plasma, detailNoise } = helpers;

  // Pre-build the plasma/detail closures once (each captures its own seed tables).
  const hairline = plasma(15223, scaled(0.3), scaled(0.6), 0.6, 1);

  const crackA1 = plasma(7543, scaled(2.5), scaled(4), 0.5, 1);
  const crackA2 = plasma(7443, scaled(1.5), scaled(3.5), 0.5, 1);
  const crackAMix = detailNoise(241, scaled(2), 2, 0.25);

  const crackB1 = plasma(12223, scaled(2), scaled(3), 0.5, 1);
  const crackB2 = plasma(152, scaled(1), scaled(1.5), 0.25, 0.5);
  const crackBMix = detailNoise(821, scaled(6), 2, 0.5);

  const pathPlasma = plasma(1543, scaled(1.5), scaled(3), 0.5, 1);
  const pathDetail = detailNoise(121, scaled(4), 2, 0.5);

  const hairlineCracks = memoXY((x: number, y: number): number => hairline(x, y));

  const floodCracksA = memoXY((x: number, y: number): number =>
    lerp(min(crackA1(x, y), crackA2(x, y)), 1, clamp(crackAMix(x, y), 0, 1)),
  );

  const floodCracksB = memoXY((x: number, y: number): number =>
    lerp(1, min(crackB1(x, y), crackB2(x, y)) - 0.5, clamp(0.2 + crackBMix(x, y), 0, 1)),
  );

  const floodPaths = memoXY(
    (x: number, y: number): number => 0.4 - pathPlasma(x, y) + min(0, pathDetail(x, y)),
  );

  const floodBasaltsFunc = memoXY(
    (x: number, y: number): number =>
      min(max(floodCracksA(x, y) - 0.125, floodPaths(x, y)), floodCracksB(x, y)) +
      0.3 * min(0.5, hairlineCracks(x, y)),
  );

  return { hairlineCracks, floodCracksA, floodCracksB, floodPaths, floodBasaltsFunc };
}
