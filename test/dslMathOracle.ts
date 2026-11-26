/**
 * Test-only reference implementations of the DSL math operators the Rust
 * engine ships, used as the TypeScript side of a bit-for-bit comparison.
 *
 * These used to be `src/noise/eval/math.ts`. Nothing shipped called them once
 * #371 deleted the last TypeScript noise arms, so they moved here: the two
 * specs that fold them against `engine.wasm` (`wasmEvalParity.spec.ts`,
 * `surveyThroughWasm.spec.ts`) still need an independent implementation to
 * compare with, and nothing else does.
 *
 * Correctness against the GAME is graded elsewhere - `slider_to_linear` at all
 * 39 probe points in `crates/fmw-noise/src/fixtures.rs`. This file only has to
 * agree with the Rust, which is why it is allowed to be this plain.
 */

/** Clamp `v` into `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolate: `a` at `t=0`, `b` at `t=1`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Variadic min (the DSL's `min(...)`); propagates NaN like `Math.min`. */
export function min(...xs: number[]): number {
  return Math.min(...xs);
}

/** Variadic max (the DSL's `max(...)`); propagates NaN like `Math.max`. */
export function max(...xs: number[]): number {
  return Math.max(...xs);
}

/**
 * `slider_to_linear(s, lo, hi) = lo + 0.5*(hi-lo) * (1 + log2(s)/log2(6))`
 * (`core/prototypes/noise-functions.lua:10`), evaluated one f32 operation at a
 * time with the BOUNDS narrowed to f32 first (#324). Mirrors
 * `fmw_noise::eval::math::slider_to_linear`.
 */
export function sliderToLinear(s: number, lo: number, hi: number): number {
  const f = Math.fround;
  const l = f(lo);
  const h = f(hi);
  const ratio = f(f(Math.log2(s)) / f(Math.log2(6)));
  return f(l + f(f(0.5 * f(h - l)) * f(1 + ratio)));
}
