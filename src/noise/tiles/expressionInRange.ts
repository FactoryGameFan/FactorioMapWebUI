import { f32 } from "../eval/f32";

/**
 * The native Factorio `expression_in_range(peak_multiplier, peak_maximum,
 * expr_1..N, from_1..N, to_1..N)` builtin, reverse-engineered from the headless
 * oracle (see docs/noise/expression-in-range-NOTES.md). Used by the tile-autoplace
 * system to make a tile probable only inside an N-dimensional box of climate
 * values, with a linear falloff outside.
 *
 * Derived formula:
 *
 *   m      = min over all dims i of min(value_i - from_i, to_i - value_i)
 *   result = min(peak_maximum, peak_multiplier * m)
 *
 * **Every step is rounded to f32, and that makes this EXACT** (issue #162). The
 * arithmetic used to run in f64 and rounded once at the end, which left a worst
 * residual of ~9.5e-7 that the spec accepted under an `8e-3` floor - a ceiling
 * ~8400x looser than the actual error, so it endorsed almost anything. The noise
 * machine evaluates in f32 registers; reproducing that takes the residual to
 * **exactly 0 on all 404 committed oracle samples** (three sweeps, 121 + 121 +
 * 162), where the f64 form matched only 285 of them.
 *
 * This is the same class of fix as `fastApprox`'s per-operation rounding: the
 * formula was right all along and the precision of the intermediate steps was
 * the whole error. Do not "simplify" these `f32` calls away.
 *
 * Per dimension, `min(value - from, to - value)` is the signed distance to the
 * nearer edge of `[from, to]`: positive inside, zero on an edge, negative outside.
 * Taking the min across dims makes the box a hard AND (any dim out of range pulls
 * the result down). Scaling by `peak_multiplier` sets the falloff slope; clamping
 * at `peak_multiplier * m` <= `peak_maximum` caps the in-range plateau. There is NO
 * lower clamp - the value falls linearly without bound outside the range.
 *
 * `peak_maximum` may be `Infinity` (sand-1's unbounded coastal term
 * `expression_in_range(5, inf, ...)`), in which case the plateau is uncapped and
 * in-range values exceed 1 (~`peak_multiplier * halfWidth`). Do NOT clamp that case.
 */
export function expressionInRange(
  peakMultiplier: number,
  peakMaximum: number,
  values: number[],
  froms: number[],
  tos: number[],
): number {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = f32(values[i]);
    const edgeDistance = Math.min(f32(v - f32(froms[i])), f32(f32(tos[i]) - v));
    if (edgeDistance < m) m = edgeDistance;
  }
  // peakMaximum stays unrounded: it is `Infinity` at sand-1's call site, and
  // Math.fround(Infinity) is Infinity, but leaving it alone keeps that obvious.
  return Math.min(peakMaximum, f32(f32(peakMultiplier) * m));
}
