/**
 * The one DSL math helper the TypeScript side still calls. The rest (`clamp`,
 * `lerp`, `min`, `max`, `slider_to_linear` and friends) live only in
 * `crates/fmw-noise/src/eval/math.rs`; nothing shipped here read them once
 * #371 deleted the last TypeScript noise arms.
 */

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
 *   shape `slider_to_linear` was corrected for, and again invisible at most
 *   slider positions (2, 3 and 4 agree between the two forms).
 * - **The `^` is EXACT, not the noise machine's fastapprox.** `fastPow` misses
 *   6 of the 7. Like `slider_to_linear`, this resolves on the prototype side,
 *   so `Math::powSafe` never enters it - which is why `Math.pow` is correct
 *   here while `fastPow` is correct inside `multioctaveNoise`.
 */
export function sliderRescale(s: number, n: number): number {
  const f = Math.fround;
  const ratio = f(f(Math.log2(s)) / f(Math.log2(6)));
  return f(Math.pow(2, f(ratio * f(Math.log2(n)))));
}
