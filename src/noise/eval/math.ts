/**
 * Tiny math helpers matching the game's noise DSL operators, so a hand-ported
 * named expression reads 1:1 with the Lua (`min(a, b, c)`, `clamp(x, lo, hi)`, ...).
 */

import { f32 } from "./f32";

/** Clamp `v` into `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolate: `a` at `t=0`, `b` at `t=1`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * {@link lerp} with per-operation f32 rounding, for expressions the noise
 * machine evaluates one operation at a time.
 *
 * **Same FORM, three roundings instead of none.** It is still `a + (b - a) * t`,
 * so `lerpF32(a, b, 1)` is still not exactly `b` - that is the game's own shape
 * and must not be "fixed" to `if (t === 1) return b`. See {@link lerp}.
 *
 * Both of Fulgora's lerps read this (`fulgora_mix_moats` and `fulgora_mix_oil`).
 * Written here rather than inline at each call site so there is ONE definition
 * to keep in step with `fmw_noise::eval::math::lerp_f32`.
 */
export function lerpF32(a: number, b: number, t: number): number {
  return f32(a + f32(f32(b - a) * t));
}

/** Variadic min (the DSL's `min(...)`). */
export function min(...xs: number[]): number {
  return Math.min(...xs);
}

/** Variadic max (the DSL's `max(...)`). */
export function max(...xs: number[]): number {
  return Math.max(...xs);
}

/**
 * Base-2 log (the DSL's `log2`, used by `water_level = 10 * log2(control:water:size)`).
 * Plain `Math.log2`; the game's fastapprox variant only matters once the
 * water-coverage slider is wired (default size = 1 => 0, exact either way).
 */
export function log2(x: number): number {
  return Math.log2(x);
}

/** Ratio of a circle's circumference to its diameter (the DSL's `pi`). */
export const PI = Math.PI;

/**
 * Sine, radians in (the DSL's `sin`, used by `starting_spot_at_angle` /
 * `spot_at_angle` / `rotate_x`/`rotate_y`). Plain `Math.sin`; validated against
 * the oracle in `test/startingSpotAtAngle.spec.ts` to the f32 floor, so revisit
 * only if that diff demands it.
 */
export function sin(x: number): number {
  return Math.sin(x);
}

/**
 * Cosine, radians in (the DSL's `cos`, see {@link sin}).
 */
export function cos(x: number): number {
  return Math.cos(x);
}

/**
 * Maps a geometric "slider" value `s` (the same 1..6-ish scale the game's
 * frequency/size/richness sliders use) onto a linear `[lo, hi]` range:
 *
 *   slider_to_linear(s, lo, hi) = lo + 0.5*(hi-lo) * (1 + log2(s)/log2(6))
 *
 * `s = 1` (the default, un-adjusted slider position) lands at the midpoint of
 * `[lo, hi]`; `s = 6` lands at `hi`. Used by `moisture_nauvis`'s starting-area
 * bias term (`starting_area_moisture_size` -> `startingBiasChange`) and by
 * `fulgora_grid`; reused by any other lever built on the same slider convention.
 *
 * **Evaluated with per-operation f32 rounding, and that is measured, not
 * stylistic.** `fulgora_grid` is `175 - slider_to_linear(freq, -50, 50)`, and
 * the game was sampled at five slider positions on a real Fulgora surface
 * (2.1.14, seed 123456). An f64 chain rounded once at the end misses at
 * `s = 3` by exactly one f32 ulp (144.34263610839844 against the game's
 * 144.3426513671875); rounding every operation matches all five EXACTLY.
 *
 * Only `s = 3` can see it: the other probes (0.5, 1, 2) have power-of-two
 * numerators, and at `s = 6` the ratio is exactly 1 whatever `log2(6)` is - so
 * a four-point sweep that skipped 3 would have "confirmed" the f64 form.
 *
 * `log2` here stays EXACT (`Math.log2`). The fastapprox variant was tried and
 * is refuted: it misses all five, including breaking the exact 175 at the
 * default `s = 1` (it gives 175.00005). `slider_to_linear` is evaluated on the
 * prototype side, not by the noise machine, so `Math::log2` never enters it.
 */
export function sliderToLinear(s: number, lo: number, hi: number): number {
  const f = Math.fround;
  const ratio = f(f(log2(s)) / f(log2(6)));
  return f(lo + f(f(0.5 * f(hi - lo)) * f(1 + ratio)));
}

/**
 * Maps the same geometric slider `s` onto a GEOMETRIC range of `1/n` to `n`
 * (`core/prototypes/noise-functions.lua:16`):
 *
 *   slider_rescale(s, n) = 2^(log2(s)/log2(6) * log2(n))
 *
 * Read by `fulgora_natural` as `slider_rescale(control:fulgora_islands:size, 2)`
 * and by Nauvis's rock size. `s = 1` gives exactly 1 for every `n`, `s = 6`
 * gives `n`, and `s = 1/6` gives `1/n`.
 *
 * **Two properties here are measured against the game, and the default slider
 * can see neither.** At `s = 1` the exponent is exactly 0 and the whole call is
 * a multiply by one, so `fulgora_natural` at default settings would accept any
 * implementation at all. The probe in `oracle-fulgora-elevation.seed123456.json`
 * samples `slider_rescale(s, 2)` at literal s of 0.5, 1, 2, 3, 4, 5 and 6
 * instead (2.1.14, on a real Fulgora surface):
 *
 * - **Per-operation f32 rounding matches all 7 exactly.** An f64 chain rounded
 *   once at the end misses `s = 0.5` and `s = 5` by one ulp each - the same
 *   shape `sliderToLinear` was corrected for, and again invisible at most
 *   slider positions (2, 3 and 4 agree between the two forms).
 * - **The `^` is EXACT, not the noise machine's fastapprox.** `fastPow` misses
 *   6 of the 7. Like `slider_to_linear`, this resolves on the prototype side,
 *   so `Math::powSafe` never enters it - which is why `Math.pow` is correct
 *   here while `fastPow` is correct inside `multioctaveNoise`.
 */
export function sliderRescale(s: number, n: number): number {
  const f = Math.fround;
  const ratio = f(f(log2(s)) / f(log2(6)));
  return f(Math.pow(2, f(ratio * f(log2(n)))));
}
