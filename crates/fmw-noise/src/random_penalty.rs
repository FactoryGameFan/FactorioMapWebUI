//! Factorio's `random_penalty` noise operation
//! (`NoiseOperations::RandomPenalty::run`), ported from
//! `src/noise/randomPenalty.ts`. See `docs/noise/random-penalty-NOTES.md`.
//!
//! ```text
//! output[i] = source[i] - amplitude * (taus88_next() / 2^32)      // U in [0,1)
//! ```
//!
//! Two facts make this a BATCH op rather than a pure per-position function:
//!
//! 1. The RNG is seeded ONCE, from the FIRST position in the batch.
//! 2. The stream is then consumed from the LAST element to the FIRST (the
//!    game's index counts down), and an element whose `source` is `<= 0` passes
//!    through unchanged and consumes NO draw.
//!
//! So the value at a given `(x, y)` depends on the whole batch and its order.
//! Callers must supply the batch in the order the game evaluates it.
//!
//! ## This op computes in f64 and narrows ONCE - the exception to the f32 rule
//!
//! Everywhere else in this crate the rule is f32 after every operation. Here
//! that gives a WRONG answer. `RandomPenalty::run` widens both f32 inputs to
//! double, runs the whole chain in double, and narrows a single time at the
//! store:
//!
//! ```text
//! +348  ldr   s6, [x11, x8, lsl #2]   // source, f32 in the register buffer
//! +352  fcvt  d5, s6                  // widened to DOUBLE
//! +416  ucvtf d6, w14                 // the u32 draw -> DOUBLE
//! +420  fmov  d7, x12                 // x12 = 0xBDF0000000000000 = -2^-32, a DOUBLE
//! +424  fmul  d6, d6, d7              // in DOUBLE
//! +428  ldr   s7, [x19, #0x1c]        // amplitude, an f32 constant
//! +432  fcvt  d7, s7                  // widened to DOUBLE
//! +436  fmul  d6, d6, d7              // in DOUBLE
//! +440  fadd  d5, d5, d6              // in DOUBLE
//! +328  fcvt  s5, d5                  // ONE narrowing
//! +332  str   s5, [x10, x8, lsl #2]   // stored as f32
//! ```
//!
//! **Writing this one in f32 throughout is the mistake this header exists to
//! stop.** It is the only op in the phase-1 set where that is true.
//!
//! The store narrowing is load-bearing and was missing from the TypeScript
//! until 2026-08-18: 36 of the fixture's 40 values are not f32 without it,
//! worst gap 1.668e-5. It was invisible because the spec did the narrowing
//! instead - `Math.fround(got[i])` scored 40/40 while the raw return scored
//! 4/40 (#260).
//!
//! The arithmetic here follows the TypeScript's arrangement
//! (`s - amplitude * u`) rather than the binary's (`s + (draw * -2^-32) *
//! amplitude`), because that is the form graded at 40/40. The two are
//! bit-identical: dividing by `2^32` and multiplying by `2^-32` are both exact,
//! multiplication commutes exactly in IEEE-754, and a sign flip is exact, so
//! `s - a*u` and `s + ((-u)*a)` produce the same bits.
//!
//! Two narrowings the binary also does are deliberately NOT reproduced, because
//! nothing observable reaches them and an unobservable change is
//! indistinguishable from a mistake:
//!
//! - `source` is read as f32 at +348. Every shipped source value is f32-exact.
//! - `amplitude` is read as f32 at +428. Across the whole resource catalog the
//!   amplitudes are `2-0.25`, `1-1`, `4-2` and `6`, all f32-exact. Only
//!   `random_penalty_inverse` could produce a non-f32 one and nothing in base
//!   or space-age calls it. Measured: at amplitude `1/3` the two readings
//!   differ on 1 of 8 outputs by 5.96e-8.

use crate::poison;
use crate::taus88::{seeded_state, taus88_next};

/// 2^32, the normalization the binary applies (`u32` draw -> `[0, 1)`).
const TWO_POW_32: f64 = 4_294_967_296.0;

/// taus88's all-zero fixed-point guard, applied to the final word.
const WORD_FLOOR: u32 = 0x155; // 341

/// A batch position, in world tiles. Fractional coordinates are allowed and
/// truncate toward zero.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RandomPenaltyPosition {
    pub x: f64,
    pub y: f64,
}

/// `random_penalty{seed = ..., amplitude = ...}`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RandomPenaltyParams {
    pub seed: f64,
    pub amplitude: f64,
}

/// The per-batch seed word: `max(341, 0x3FBE2C + 7919*trunc(x0) +
/// 7907*trunc(y0 + seed))` in unsigned 32-bit arithmetic, from the first batch
/// position. Same RNG family as `spot_noise` - base `0x3FBE2C`, primes
/// 7919/7907, the 341 clamp - with no map-seed dependence, and `seed` folded
/// into y BEFORE truncation.
#[must_use]
pub fn random_penalty_word(x0: f64, y0: f64, seed: f64) -> u32 {
    // The TypeScript writes `Math.trunc(x0) | 0`. JavaScript's `| 0` is
    // ToInt32, which WRAPS modulo 2^32; Rust's `as i32` from a float
    // SATURATES. Going through `i64` first reproduces the wrap for everything
    // that fits in 64 bits, which is every coordinate a Factorio map can hold -
    // the two readings could only differ past 2^63 tiles. Recorded because it
    // IS a difference, not because it is reachable.
    let xi = x0.trunc() as i64 as i32;
    let yi = (y0 + seed).trunc() as i64 as i32;
    // `Math.imul` is a 32-bit signed multiply that wraps, so these are wrapping
    // `u32` products. The TypeScript's `+` then `>>> 0` is the same reduction.
    let w = 0x003f_be2c_u32
        .wrapping_add((xi as u32).wrapping_mul(7919))
        .wrapping_add((yi as u32).wrapping_mul(7907));
    w.max(WORD_FLOOR)
}

/// Evaluate `random_penalty` over an ordered batch, reproducing
/// `RandomPenalty::run`.
///
/// `source[i]` is the already-evaluated source value at `positions[i]`, and the
/// result aligns with `positions`.
///
/// The return type is `f64` rather than `f32` because the pass-through path
/// stores `source` unchanged, and the TypeScript hands back a JavaScript number
/// array holding both kinds. Penalised entries are the f32 the op narrows to,
/// widened; pass-through entries are the source as given. Every shipped source
/// value is f32-exact anyway (see the header), so in practice the whole array
/// is f32.
///
/// # Panics
///
/// If `source` is shorter than `positions`.
#[must_use]
pub fn random_penalty_batch(
    positions: &[RandomPenaltyPosition],
    source: &[f64],
    params: &RandomPenaltyParams,
) -> Vec<f64> {
    assert!(
        source.len() >= positions.len(),
        "source must cover every position"
    );
    let mut out = vec![0.0f64; positions.len()];
    if positions.is_empty() {
        return out;
    }

    let mut st = seeded_state(random_penalty_word(
        positions[0].x,
        positions[0].y,
        params.seed,
    ));
    // Processed last element -> first, matching the binary's descending index.
    for i in (0..positions.len()).rev() {
        let s = source[i];
        if s > 0.0 {
            let u = f64::from(taus88_next(&mut st)) / TWO_POW_32;
            // The chain above is f64 on purpose (see the header). The cast here
            // is the op's single narrowing - `fcvt s5, d5` at +328, then
            // `str s5`.
            out[i] = poison::f64_result(f64::from((s - params.amplitude * u) as f32));
        } else {
            // The pass-through path stores `source` unchanged, and `source` was
            // read from an f32 register slot, so it needs no narrowing here.
            out[i] = s;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn positions(pairs: &[(f64, f64)]) -> Vec<RandomPenaltyPosition> {
        pairs
            .iter()
            .map(|&(x, y)| RandomPenaltyPosition { x, y })
            .collect()
    }

    /// The documented "source must be > 0" guard: a non-positive element is
    /// passed through untouched.
    #[test]
    fn passes_non_positive_source_through_unchanged() {
        let p = positions(&[(0.0, 0.0), (5.0, 5.0)]);
        let out = random_penalty_batch(
            &p,
            &[-2.0, 3.0],
            &RandomPenaltyParams {
                seed: 1.0,
                amplitude: 1.0,
            },
        );
        assert_eq!(out[0], -2.0);
        assert!(out[1] < 3.0, "penalised");
        assert!(out[1] >= 2.0, "amplitude 1 means U in [0, 1)");
    }

    /// And it consumes no draw, which is the half of the guard a value check
    /// alone cannot see: the survivor must get draw 0.
    #[test]
    fn a_suppressed_element_consumes_no_draw() {
        let p = positions(&[(2.0, 3.0), (2.0, 3.0)]);
        let params = RandomPenaltyParams {
            seed: 1.0,
            amplitude: 1.0,
        };
        let both = random_penalty_batch(&p, &[0.0, 1.0], &params);
        // Same coordinates, so the seed word is identical in both batches.
        let lone = random_penalty_batch(&p[1..], &[1.0], &params);
        assert_eq!(both[1], lone[0]);
        assert_eq!(both[0], 0.0);
    }

    /// The op is order- and batch-dependent, which is what makes it a batch op
    /// rather than a function of position. Seeding comes from `positions[0]`.
    #[test]
    fn the_same_tile_gets_a_different_draw_in_a_different_batch() {
        let a = (0.0, 0.0);
        let b = (5.0, 7.0);
        let params = RandomPenaltyParams {
            seed: 1.0,
            amplitude: 1.0,
        };
        let forward = random_penalty_batch(&positions(&[a, b]), &[1.0, 1.0], &params);
        let reversed = random_penalty_batch(&positions(&[b, a]), &[1.0, 1.0], &params);
        assert_ne!(forward[0], reversed[1]);
    }

    #[test]
    fn an_empty_batch_returns_an_empty_result() {
        let out = random_penalty_batch(
            &[],
            &[],
            &RandomPenaltyParams {
                seed: 1.0,
                amplitude: 1.0,
            },
        );
        assert!(out.is_empty());
    }

    /// Every penalised value LEAVES the op as f32. This is the guard for the
    /// single narrowing: drop the cast in `random_penalty_batch` and 36 of the
    /// fixture's 40 values stop being f32, which no bound can see - the only
    /// consumer grades at 1e-2 relative and the change is worth 1.19e-7.
    #[test]
    fn penalised_values_are_exactly_f32() {
        let p = positions(&[(0.0, 0.0), (1.0, 0.0), (-3.0, 2.0), (5.5, 7.25)]);
        let out = random_penalty_batch(
            &p,
            &[1.0, 1.0, 1.0, 1.0],
            &RandomPenaltyParams {
                seed: 13.0,
                amplitude: 0.5,
            },
        );
        for (i, v) in out.iter().enumerate() {
            assert_eq!(f64::from(*v as f32), *v, "value {i} is not exactly f32");
        }
    }
}
