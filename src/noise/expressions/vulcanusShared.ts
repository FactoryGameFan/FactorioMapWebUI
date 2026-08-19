/**
 * `starting_spot_at_angle` (core/prototypes/noise-functions.lua) - the radial-
 * placement backbone Vulcanus's biome/resource expressions build on: a soft
 * disc of radius `radius`, centered `distance` tiles from spawn at `angle`
 * degrees (measured clockwise from north, since `sin` drives x and `-cos`
 * drives y), optionally re-centered by `(x_distortion, y_distortion)`.
 * Verbatim:
 *
 *   angle_rad = angle / 180 * pi
 *   delta_x   = distance * sin(angle_rad) - x_from_start + x_distortion
 *   delta_y   = -distance * cos(angle_rad) - y_from_start + y_distortion
 *   result    = 1 - (delta_x*delta_x + delta_y*delta_y)^0.5 / radius
 *
 * `x_from_start`/`y_from_start` are the engine's own per-point free vars
 * (`distance_from_nearest_point_x/_y(x, y, starting_positions)` -
 * core/prototypes/noise-programs.lua). Task 2 found they equal the raw world
 * `(x, y)` at the default origin spawn on a freshly `create_surface()`'d
 * Vulcanus surface (no offset) - so callers here pass the current `(x, y)` as
 * `xFromStart`/`yFromStart` explicitly, keeping this function pure and correct
 * even if a non-origin spawn ever appears.
 */
import { f32 } from "../eval/f32";
import { cos, PI, sin } from "../eval/math";

/**
 * `pi` narrowed to f32, which the game holds it at. Not `PI` - the f64 constant
 * is a different number one operation later, and #279 measured that the vault
 * cone cannot reach the game without this.
 */
const PI32 = f32(PI);

export interface StartingSpotAtAngleParams {
  /** Angle in degrees, clockwise from north (sin drives x, -cos drives y). */
  readonly angle: number;
  /** Distance in tiles from spawn to the disc's center, before distortion. */
  readonly distance: number;
  /** Radius in tiles of the soft disc (1 at the center, 0 at the edge). */
  readonly radius: number;
  /** Added to the center's x position after the angle/distance projection. */
  readonly xDistortion: number;
  /** Added to the center's y position after the angle/distance projection. */
  readonly yDistortion: number;
  /** `x_from_start`: the world x at the default origin spawn (Task 2 finding). */
  readonly xFromStart: number;
  /** `y_from_start`: the world y at the default origin spawn (Task 2 finding). */
  readonly yFromStart: number;
}

/**
 * `starting_spot_at_angle{angle, distance, radius, x_distortion, y_distortion}`.
 *
 * **Evaluated with per-operation f32 rounding, including the trig and `pi`**
 * (#279). The noise machine evaluates this one operation at a time in f32; an
 * f64 chain left both Fulgora cones short of the game at 83/101 and 85/101
 * exact matches.
 *
 * Five narrowings are needed and **no subset is enough** - per-operation, an f32
 * `pi`, f32 `sin`/`cos`, and then f32 radius/distance and f32 angle at the CALL
 * SITES, which is why `fulgoraShared.ts` narrows `grid / 1.8` and
 * `seed0 / 360`. Read any row of that lattice alone and the two cones look like
 * they want opposite fixes: an f32 `pi` helps the vault cone and HURTS the main
 * one until the angle is narrowed too. They call the same function, so that
 * reading has to be wrong - it is an artifact of scoring one change at a time.
 *
 * `^0.5` is the noise machine's exact `sqrt`, not its fastapprox `^`, so
 * `Math.sqrt` is right here. See `src/noise/eval/f32.ts` for the two-case rule
 * these narrowings follow.
 */
export function startingSpotAtAngle(params: StartingSpotAtAngleParams): number {
  const angleRad = f32(f32(params.angle / 180) * PI32);
  const sinA = f32(sin(angleRad));
  const cosA = f32(cos(angleRad));
  const deltaX = f32(f32(f32(params.distance * sinA) - params.xFromStart) + params.xDistortion);
  const deltaY = f32(f32(f32(-params.distance * cosA) - params.yFromStart) + params.yDistortion);
  const sumSq = f32(f32(deltaX * deltaX) + f32(deltaY * deltaY));
  return f32(1 - f32(f32(Math.sqrt(sumSq)) / params.radius));
}
