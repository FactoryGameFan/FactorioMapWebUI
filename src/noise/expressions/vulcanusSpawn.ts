/**
 * Vulcanus's seed-derived radial spawn geometry ("Starting Area blobs" -
 * `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`, `~/GitHub/factorio-data`
 * tag 2.1.11, lines ~162-225). This is what makes Vulcanus faithful *at* spawn:
 * three biome "starts" (ashlands, basalts, mountains) are placed at fixed
 * distances/radii around spawn, at angles 120 degrees apart, rotated and mirrored
 * by the map seed. `starting_area` is their max (clamped to [0,1], used to blend
 * biomes near spawn); `starting_circle` is a related but separate, unclamped
 * falloff used to push random ore placement away from spawn.
 *
 * Verbatim (`r` = `vulcanus_starting_area_radius`):
 *
 *   starting_area_radius = 0.7 * 0.75                          (= 0.525)
 *   starting_direction    = -1 + 2 * (map_seed_small & 1)
 *   ashlands_angle        = map_seed_normalized * 3600
 *   mountains_angle       = ashlands_angle + 120 * starting_direction
 *   basalts_angle         = ashlands_angle + 240 * starting_direction
 *
 *   ashlands_start  = 4 * starting_spot_at_angle{angle = ashlands_angle,
 *                          distance = 170*r, radius = 350*r,
 *                          x_distortion = 0.1*r*(wobble_x+wobble_large_x+wobble_huge_x),
 *                          y_distortion = 0.1*r*(wobble_y+wobble_large_y+wobble_huge_y)}
 *   basalts_start   = 2 * starting_spot_at_angle{angle = basalts_angle,
 *                          distance = 250, radius = 550*r,           -- NOTE: bare 250, no *r
 *                          x_distortion = 0.1*r*(...same three x wobbles...),
 *                          y_distortion = 0.1*r*(...same three y wobbles...)}
 *   mountains_start = 2 * starting_spot_at_angle{angle = mountains_angle,
 *                          distance = 250*r, radius = 500*r,
 *                          x_distortion = 0.05*r*(...), y_distortion = 0.05*r*(...)}
 *
 *   starting_area   = clamp(max(basalts_start, mountains_start, ashlands_start), 0, 1)
 *   starting_circle = 1 + starting_area_radius * (300 - distance) / 50   -- NOT clamped
 *
 * `distance` is the engine's own `distance_from_nearest_point(x, y, starting_positions)`
 * (uncapped) - the same free var `elevation_nauvis`/`moisture` derive it from (see
 * `elevationNauvis.ts` / `moisture.ts`). `wobble_x`/`wobble_large_x`/`wobble_huge_x`
 * (and their y counterparts) are `makeVulcanusHelpers`'s six wobble closures (Task 5).
 * `x_from_start`/`y_from_start` for `starting_spot_at_angle` are the raw world
 * `(x, y)` at the default origin spawn (Task 2 finding) - see `vulcanusShared.ts`.
 *
 * ashlands/basalts share the SAME distortion coefficient (0.1*r); mountains uses
 * half that (0.05*r). basalts_start's `distance` is a bare `250` (no `*r`),
 * unlike ashlands (170*r) and mountains (250*r) - easy to get wrong, transcribed
 * verbatim from the source above.
 */
import { f32 } from "../eval/f32";
import { distanceFromNearestPoint } from "../distanceFromNearestPoint";
import type { EvalCtx } from "../eval/ctx";
import { clamp, max } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import type { VulcanusHelpers } from "./vulcanusHelpers";
import { startingSpotAtAngle } from "./vulcanusShared";

/** `vulcanus_starting_area_radius = 0.7 * 0.75`. */
export const VULCANUS_STARTING_AREA_RADIUS = 0.7 * 0.75;

export interface VulcanusSpawn {
  /** `vulcanus_starting_direction = -1 + 2*(map_seed_small & 1)` (either -1 or +1). */
  readonly startingDirection: number;
  /** `vulcanus_ashlands_angle = map_seed_normalized * 3600`, in degrees. */
  readonly ashlandsAngle: number;
  /** `vulcanus_mountains_angle = ashlands_angle + 120*starting_direction`, in degrees. */
  readonly mountainsAngle: number;
  /** `vulcanus_basalts_angle = ashlands_angle + 240*starting_direction`, in degrees. */
  readonly basaltsAngle: number;
  /** `vulcanus_ashlands_start`. */
  ashlandsStart(x: number, y: number): number;
  /** `vulcanus_basalts_start`. */
  basaltsStart(x: number, y: number): number;
  /** `vulcanus_mountains_start`. */
  mountainsStart(x: number, y: number): number;
  /** `vulcanus_starting_area = clamp(max(basalts_start, mountains_start, ashlands_start), 0, 1)`. */
  startingArea(x: number, y: number): number;
  /** `vulcanus_starting_circle = 1 + starting_area_radius*(300 - distance)/50` (unclamped). */
  startingCircle(x: number, y: number): number;
}

/** Build the Vulcanus radial spawn geometry for one seed/ctx. */
export function makeVulcanusSpawn(ctx: EvalCtx, helpers: VulcanusHelpers): VulcanusSpawn {
  const r = VULCANUS_STARTING_AREA_RADIUS;

  const startingDirection = -1 + 2 * (ctx.mapSeedSmall & 1);
  const ashlandsAngle = f32(ctx.mapSeedNormalized * 3600);
  const mountainsAngle = f32(ashlandsAngle + f32(120 * startingDirection));
  const basaltsAngle = f32(ashlandsAngle + f32(240 * startingDirection));

  // Shared distortion inputs (same three wobble closures feed every *_start).
  const wobbleXSum = memoXY(
    (x: number, y: number): number =>
      helpers.wobbleX(x, y) + helpers.wobbleLargeX(x, y) + helpers.wobbleHugeX(x, y),
  );
  const wobbleYSum = memoXY(
    (x: number, y: number): number =>
      helpers.wobbleY(x, y) + helpers.wobbleLargeY(x, y) + helpers.wobbleHugeY(x, y),
  );

  const ashlandsStart = memoXY(
    (x: number, y: number): number =>
      4 *
      startingSpotAtAngle({
        angle: ashlandsAngle,
        distance: f32(170 * r),
        radius: f32(350 * r),
        xDistortion: 0.1 * r * wobbleXSum(x, y),
        yDistortion: 0.1 * r * wobbleYSum(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
  );

  const basaltsStart = memoXY(
    (x: number, y: number): number =>
      2 *
      startingSpotAtAngle({
        angle: basaltsAngle,
        // Bare 250, NOT 250*r - transcribed verbatim (see file-level doc comment).
        distance: 250,
        radius: f32(550 * r),
        xDistortion: 0.1 * r * wobbleXSum(x, y),
        yDistortion: 0.1 * r * wobbleYSum(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
  );

  const mountainsStart = memoXY(
    (x: number, y: number): number =>
      2 *
      startingSpotAtAngle({
        angle: mountainsAngle,
        distance: f32(250 * r),
        radius: f32(500 * r),
        xDistortion: 0.05 * r * wobbleXSum(x, y),
        yDistortion: 0.05 * r * wobbleYSum(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
  );

  const startingArea = memoXY((x: number, y: number): number =>
    clamp(max(basaltsStart(x, y), mountainsStart(x, y), ashlandsStart(x, y)), 0, 1),
  );

  const startingCircle = memoXY((x: number, y: number): number => {
    const distance = distanceFromNearestPoint(x, y, ctx.startingPositions);
    return 1 + (r * (300 - distance)) / 50;
  });

  return {
    startingDirection,
    ashlandsAngle,
    mountainsAngle,
    basaltsAngle,
    ashlandsStart,
    basaltsStart,
    mountainsStart,
    startingArea,
    startingCircle,
  };
}
