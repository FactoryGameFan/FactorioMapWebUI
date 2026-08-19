/**
 * A reimplementation of Factorio's `distance_from_nearest_point` primitive
 * (`NoiseOperations::DistanceFromNearestPoint`), read directly from its register
 * `run` in the non-stripped Mach-O - `0x101759568` in 2.1.11, and re-read at
 * `0x101767b08` in 2.1.14 when the precision below was settled. Its `points`
 * argument is a runtime list the noise DSL will not accept as a literal, so it
 * cannot be probed standalone; it validates through `finish_elevation`, whose
 * tree feeds it `starting_lake_positions`.
 *
 * The shape (per tile):
 *
 *   distance_from_nearest_point(x, y) =
 *       min( maximum_distance , min over p in points of dist((x,y), p) )
 *
 * Computed as: seed a running best with `maximum_distance^2`, loop the points
 * tracking the smallest squared distance, then return
 * `bestSq < maximum_distance^2 ? sqrt(bestSq) : maximum_distance`.
 *
 * NOT wired into the app - a building block for a client-side map preview.
 *
 * ## Every step is f32, and this used to be f64 with no narrowing at all
 *
 * Corrected 2026-08-18 (#220). The function returned a raw f64 and
 * `test/distanceFromNearestPoint.spec.ts` compared `Math.fround(...)` of it -
 * so the comparison site was recovering a value the op never produced. Scored
 * raw, against the game's own captured values, that reading was **0 of 26** on
 * `oracle-elevation-lakes`' `distance` and 17 of 26 on its
 * `startingLakeDistance`. This is the same defect #260 found in
 * `random_penalty`, one op later and worse: there the raw op still scored 4 of
 * 40.
 *
 * The register widths settle the precision - `s` registers are floats, `d` are
 * doubles, and this function contains no `d` at all:
 *
 * ```
 * +200  mov    w11, #0x3b800000        // f32 1/256
 * +220  ldp    s0, s1, [x9]            // the point, two int32 fixed-point words
 * +224  scvtf  s0, s0                  // int32 -> FLOAT
 * +232  fmul   s0, s0, s2              // * 1/256, in SINGLE
 * +300  ldr    s2, [x12]               // x, from an f32 register slot
 * +304  fsub   s2, s2, s0              // dx, SINGLE
 * +312  fsub   s3, s3, s1              // dy, SINGLE
 * +316  fmul   s4, s2, s2              // dx*dx, SINGLE
 * +320  fmul   s5, s3, s3              // dy*dy, SINGLE
 * +324  fadd   s4, s4, s5              // d2,    SINGLE
 * +436  ldp    s2, s1, [x19, #0x38]    // maximum_distance and its SQUARE, both
 * +440  fsqrt  s3, s0                  //   f32 constants; SINGLE-precision sqrt
 * +444  fcmp   s0, s1
 * +448  fcsel  s0, s3, s2, lt          // bestSq < maxSq ? sqrt(bestSq) : max
 * +452  str    s0, [x9], #0x4          // stored as f32
 * ```
 *
 * Three consequences that are not guessable from the shape alone:
 *
 * - **`maximum_distance` and `maximum_distance^2` are f32 constants read
 *   together by one `ldp`**, precomputed when the operation is constructed. So
 *   the cap comparison is against `f32(max)^2` rounded once, not against a
 *   product recomputed per call in f64.
 * - **The incoming coordinates arrive as f32**, because the noise machine's
 *   register buffer is `float`. Feeding a primitive f64 coordinates is a
 *   recorded hazard on this port worth up to 331x (#190).
 * - **The point conversion is `int32 * f32(1/256)`, in f32**, not
 *   `round(v * 256) / 256` in f64. Identical for the integer tile positions
 *   every caller passes, and different past +-65,536 tiles, where the int32
 *   exceeds 2^24 and `scvtf` starts rounding. The game genuinely loses
 *   sub-tile precision that far out; so does this now.
 *
 * **The fixtures cannot tell this apart from f64-with-one-final-narrowing.**
 * Measured: the two agree on all 26 fixture points and on all 41,495 points of
 * a wide sweep, worst difference 0. So this shape is a reading of the binary,
 * not a fit to the data - which is exactly why it was read. What the fixtures
 * DO reject, at 0 of 26, is the f64 return this replaced.
 *
 * The kernel is `sqrt(dx*dx + dy*dy)`, not `hypot`. That too is a reading: the
 * two differ on 8 of the 26 fixture points in f64 and on 0 of 26 in f32.
 */
import { f32 } from "./eval/f32";

/** A point in world tiles. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** `f32(1/256)`, the exact multiplier at +200 (`0x3b800000`). */
const INV_256 = f32(1 / 256);

/**
 * A point coordinate as the game holds it: `int32 = round(coord * 256)`,
 * converted back with `scvtf` + a single-precision multiply by 1/256.
 */
const quantise = (v: number): number => f32(f32(Math.round(v * 256)) * INV_256);

/**
 * Evaluate `distance_from_nearest_point` at world coordinates `(x, y)`: the Euclidean
 * distance to the nearest of `points`, capped at `maximumDistance`. With no points
 * (or all beyond the cap) it returns `maximumDistance`. `maximumDistance` defaults to
 * `Infinity` (uncapped); the game's exact default when the DSL omits it is
 * unconfirmed, but every base-game caller passes one (e.g. the elevation tree's 1024).
 *
 * Returns an f32 value, because the op stores one - see the header.
 *
 * Pass `points` already reduced to the region of interest when sweeping a grid - the
 * cost is O(points) per tile.
 */
export function distanceFromNearestPoint(
  x: number,
  y: number,
  points: readonly Point[],
  maximumDistance = Infinity,
): number {
  // Both are f32 constants the operation precomputes, read together by one
  // `ldp s2, s1` at +436.
  const max = f32(maximumDistance);
  const maxSq = f32(max * max);
  // The register buffer the noise machine reads these from holds `float`.
  const xf = f32(x);
  const yf = f32(y);

  let bestSq = maxSq;
  for (const p of points) {
    const dx = f32(xf - quantise(p.x));
    const dy = f32(yf - quantise(p.y));
    const d2 = f32(f32(dx * dx) + f32(dy * dy));
    if (d2 < bestSq) bestSq = d2;
  }
  // `fsqrt s`. Taking the f64 square root of an f32 and rounding once is
  // exactly the single-precision result - f64's 53 bits clear the 2*24+2 = 50
  // a correctly rounded single sqrt needs - so this is one rounding, not two.
  return bestSq < maxSq ? f32(Math.sqrt(bestSq)) : max;
}
