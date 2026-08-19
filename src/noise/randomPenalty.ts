/**
 * Factorio's `random_penalty` noise operation (`NoiseOperations::RandomPenalty`),
 * reverse-engineered from the non-stripped 2.1.11 binary
 * (`RandomPenalty.cpp` / `RandomPenalty::run`) and verified against the headless
 * oracle. See docs/noise/random-penalty-NOTES.md.
 *
 *   output[i] = source[i] - amplitude * (taus88_next() / 2^32)      // U in [0,1)
 *
 * Two facts make this a BATCH op, not a pure per-position function:
 *
 * 1. The RNG is seeded ONCE, from the FIRST position in the batch:
 *      word = max(341, 0x3FBE2C + 7919*trunc(x0) + 7907*trunc(y0 + seed))   (u32)
 *    (same RNG family as spot_noise: base 0x3FBE2C, primes 7919/7907, the 341
 *    clamp; no map_seed dependence; `seed` is folded into y before truncation.)
 *    taus88 state s1=s2=s3=word.
 * 2. The taus88 stream is then consumed across the batch, processed from the LAST
 *    element to the FIRST (the game's index counts down). A tile whose `source` is
 *    <= 0 is passed through unchanged and consumes NO draw (the documented
 *    "source must be > 0" guard).
 *
 * So the value at a given (x, y) depends on the whole batch and its order - which
 * is why a bare `calculate_tile_properties` probe cannot oracle this in isolation.
 * Callers must supply the batch in the same order the game evaluates it.
 *
 * ## This op computes in f64 and narrows ONCE - it is the exception to the f32 rule
 *
 * Everywhere else in `src/noise/` the rule is f32 after every operation (see
 * `eval/f32.ts`). Here it would produce a WRONG answer. `RandomPenalty::run`
 * widens both f32 inputs to double, runs the whole chain in double, and narrows
 * a single time at the store:
 *
 *   +348  ldr   s6, [x11, x8, lsl #2]   // source, f32 in the register buffer
 *   +352  fcvt  d5, s6                  // widened to DOUBLE
 *   +416  ucvtf d6, w14                 // the u32 draw -> DOUBLE
 *   +424  fmul  d6, d6, d7              // * -2^-32 (a DOUBLE constant, 0xBDF0...)
 *   +432  fcvt  d7, s7                  // amplitude, f32 constant -> DOUBLE
 *   +436  fmul  d6, d6, d7              // * amplitude, in DOUBLE
 *   +440  fadd  d5, d5, d6              // + source, in DOUBLE
 *   +328  fcvt  s5, d5                  // narrowed to f32 exactly once
 *   +332  str   s5, [x10, x8, lsl #2]   // and stored as f32
 *
 * So a Rust port must use `f64` internally and cast to `f32` on the way out.
 * Writing this one in f32 throughout is the mistake this comment exists to stop.
 *
 * The `f32` on the store is load-bearing and was missing until 2026-08-18: 36 of
 * the fixture's 40 values are not f32 without it, worst gap 1.668e-5, and the
 * only consumer (`resources/regularPatches.ts`) multiplies the returned value.
 * Narrowing first changes that product in 1240 of 5840 swept cases, worst 1.19e-7
 * relative. `test/randomPenalty.spec.ts` asserts the return is f32 directly, so
 * removing the narrowing goes red rather than being absorbed by a bound.
 *
 * Two narrowings the binary also does are deliberately NOT reproduced, because
 * nothing can currently observe them and an unobservable change is
 * indistinguishable from a mistake (the rule #191 sets out):
 *
 * - `source` is read as f32 at +348. Every shipped source value is f32-exact.
 * - `amplitude` is read as f32 at +428. `random_penalty_between(min, max, 1)`
 *   gives 2-0.25, 1-1 and 4-2 across the whole resource catalog, and
 *   `random_penalty_at(6, 1)` gives 6 - all f32-exact. Only
 *   `random_penalty_inverse`, whose amplitude is `1/penalty`, could produce a
 *   non-f32 amplitude, and nothing in base or space-age calls it. Measured: at
 *   amplitude 1/3 the two readings differ on 1 of 8 outputs by 5.96e-8.
 */
import { f32 } from "./eval/f32";
import { seededState, taus88Next } from "./taus88";

/** 2^32, the normalization the binary applies (int32 draw * 2^-32 -> [0,1)). */
const TWO_POW_32 = 4294967296;
/** taus88 all-zero fixed-point guard, applied to the final word (unsigned). */
const WORD_FLOOR = 0x155; // 341

/** A batch position, in world tiles (fractional allowed; truncated toward zero). */
export interface RandomPenaltyPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * The per-region/per-batch seed word: `max(341, 0x3FBE2C + 7919*trunc(x0) +
 * 7907*trunc(y0 + seed))` in unsigned 32-bit arithmetic, from the first batch
 * position's coordinates. Exposed for tests and for callers that reproduce the
 * stream directly.
 */
export function randomPenaltyWord(x0: number, y0: number, seed: number): number {
  const xi = Math.trunc(x0) | 0;
  const yi = Math.trunc(y0 + seed) | 0;
  const w = (0x3fbe2c + Math.imul(xi, 7919) + Math.imul(yi, 7907)) >>> 0;
  return (w > WORD_FLOOR ? w : WORD_FLOOR) >>> 0;
}

/**
 * Evaluate `random_penalty{source, amplitude, seed}` over an ordered batch,
 * reproducing `RandomPenalty::run` bit-for-bit. `source[i]` is the (already
 * evaluated) source value at `positions[i]`; the result aligns with `positions`.
 *
 * The RNG is seeded from `positions[0]` and streamed from the last element to the
 * first; a `source[i] <= 0` element passes through unchanged and consumes no draw.
 */
export function randomPenaltyBatch(
  positions: readonly RandomPenaltyPosition[],
  source: readonly number[],
  params: { seed: number; amplitude: number },
): number[] {
  const { seed, amplitude } = params;
  const out: number[] = Array.from({ length: positions.length }, () => 0);
  if (positions.length === 0) return out;

  const st = seededState(randomPenaltyWord(positions[0].x, positions[0].y, seed));
  // Processed last element -> first, matching the binary's descending index.
  for (let i = positions.length - 1; i >= 0; i--) {
    const s = source[i];
    if (s > 0) {
      const u = taus88Next(st) / TWO_POW_32;
      // The chain above is f64 on purpose (see the header). The `f32` here is
      // the op's single narrowing - `fcvt s5, d5` at +328, then `str s5`.
      out[i] = f32(s - amplitude * u);
    } else {
      // The pass-through path stores `source` unchanged, and `source` was read
      // from an f32 register slot, so this needs no narrowing of its own.
      out[i] = s;
    }
  }
  return out;
}
