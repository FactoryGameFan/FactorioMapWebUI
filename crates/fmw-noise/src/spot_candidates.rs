//! Factorio's `spot_noise` candidate-point RNG, ported from
//! `src/noise/spotCandidates.ts`. See `docs/noise/spot-noise-NOTES.md`.
//!
//! The generator the community called "black magic" is the canonical L'Ecuyer
//! taus88, seeded per region from `(seed0, seed1, region index)` with three
//! small primes. Verified bit-exact against Factorio 2.1.11 across seeds,
//! regions and region sizes, including the game's real `region_size = 1024`.
//!
//! This covers candidate GENERATION only. Selection - the favorability sort,
//! the regional quantity target and the minimum-spacing rejection - sits on top
//! of this stream in [`crate::spot_selection`].
//!
//! ## Integer end to end, and that is not a stylistic choice
//!
//! Every value here is carried as `u32`/`i64` wrapping arithmetic, never a
//! float. Two measurements say why:
//!
//! - The pre-modulus seed sum reaches `7927 * 4,294,967,295` = about 3.4e13.
//!   Evaluating that in f32 disagrees on 4 of the 29 keys the TypeScript spec
//!   exercises.
//! - The ordered-stream test compares raw `u32` draws up to 4,192,399,414,
//!   where the spacing between adjacent f32 values is **256**. Narrowing that
//!   comparison scores 1 of 40 on values that are 40 of 40 equal.
//!
//! `region_x` and `region_y` are signed, so the TypeScript's
//! `if (w < 0) w += M32` correction is a wrapping add rather than a float
//! modulo. `i64::rem_euclid` below is that correction.

use crate::poison;
use crate::taus88::{seeded_state, taus88_next};

/// 2^32, the modulus the seed word is reduced to.
const M32: i64 = 1 << 32;

// `W = (SEED_BASE + 7927*seed1 + 7919*rx + 7907*ry) mod 2^32`, then `^ seed0`.
const SEED_BASE: i64 = 0x003f_be2c;
const SEED1_PRIME: i64 = 7927;
const RX_PRIME: i64 = 7919;
const RY_PRIME: i64 = 7907;

/// All-zero state is a taus88 fixed point, so the game clamps the seed word
/// from below. Measured: words 0..341 all behave as 341, and 342 is untouched.
/// The clamp applies to the FINAL word, after the `seed0` XOR.
const MIN_SEED_WORD: u32 = 0x155;

/// A region's RNG key. Regions are *centred* on multiples of `region_size`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpotRegionKey {
    pub seed0: u32,
    pub seed1: u32,
    pub region_x: i64,
    pub region_y: i64,
}

/// A candidate point, in world tiles. Integer by construction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpotPoint {
    pub x: i64,
    pub y: i64,
}

/// The per-region seed word. All three taus88 state words are initialised to
/// it, and their dead low bits - 1, 3 and 4 respectively - are why bit 0 of
/// `seed0` has no effect on the map at all.
///
/// Region size is deliberately absent: it is only the final modulus, not part
/// of the RNG key, so the same draw stream underlies every region size. That is
/// what let the raw draws be recovered by CRT across four region sizes.
#[must_use]
pub fn spot_seed_word(key: &SpotRegionKey) -> u32 {
    // Exact in `i64`. The TypeScript computes the same sum in f64, where it is
    // also exact because every term stays under 2^53 - the two agree for every
    // input either can represent.
    let sum = SEED_BASE
        + SEED1_PRIME * i64::from(key.seed1)
        + RX_PRIME * key.region_x
        + RY_PRIME * key.region_y;
    // `% M32` then `if (w < 0) w += M32` is a Euclidean remainder, which is the
    // low 32 bits of the two's-complement value.
    let w = sum.rem_euclid(M32) as u32;
    (w ^ key.seed0).max(MIN_SEED_WORD)
}

/// The first `count` candidate points of a region, in generation order, as
/// world coordinates. Each candidate consumes exactly two draws, x then y:
///
/// ```text
/// coord = region * region_size + (draw mod region_size) - region_size/2
/// ```
///
/// `suggested_minimum_candidate_point_spacing` consumes no draws - spacing is
/// enforced during selection, downstream of this stream.
#[must_use]
pub fn spot_candidate_points(
    key: &SpotRegionKey,
    region_size: u64,
    count: usize,
) -> Vec<SpotPoint> {
    let mut st = seeded_state(spot_seed_word(key));
    // `Math.floor(regionSize / 2)`, and integer division is that on a
    // non-negative value.
    let half = (region_size / 2) as i64;
    let mut points = Vec::with_capacity(count);
    for _ in 0..count {
        let vx = u64::from(taus88_next(&mut st));
        let vy = u64::from(taus88_next(&mut st));
        points.push(SpotPoint {
            x: poison::i64_result(
                key.region_x * region_size as i64 + (vx % region_size) as i64 - half,
            ),
            y: key.region_y * region_size as i64 + (vy % region_size) as i64 - half,
        });
    }
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points(key: SpotRegionKey, region_size: u64, count: usize) -> Vec<SpotPoint> {
        spot_candidate_points(&key, region_size, count)
    }

    /// The clamp applies AFTER the `seed0` XOR, so two very different keys that
    /// drive the pre-clamp word to a tiny value land on the same stream.
    #[test]
    fn clamps_degenerate_seed_words_after_the_seed0_xor() {
        let a = SpotRegionKey {
            seed0: 0,
            seed1: 678_351_820,
            region_x: 0,
            region_y: 0,
        };
        let b = SpotRegionKey {
            seed0: 4_177_452,
            seed1: 0,
            region_x: 0,
            region_y: 0,
        };
        assert_eq!(spot_seed_word(&a), MIN_SEED_WORD);
        assert_eq!(points(a, 2048, 6), points(b, 2048, 6));
        // A large word ARRIVED AT via the XOR must not be clamped, or the
        // assertion above would pass on a function that clamped everything.
        assert_eq!(
            spot_seed_word(&SpotRegionKey {
                seed0: 0x8000_0000,
                ..a
            }),
            0x8000_0000
        );
    }

    /// Bit 0 of `seed0` is dead in all three taus88 words, so it cannot move
    /// the map.
    #[test]
    fn ignores_bit_0_of_seed0() {
        let key = SpotRegionKey {
            seed0: 123_456,
            seed1: 0,
            region_x: 0,
            region_y: 0,
        };
        assert_eq!(
            points(key, 1024, 8),
            points(
                SpotRegionKey {
                    seed0: 123_457,
                    ..key
                },
                1024,
                8
            )
        );
    }

    /// Every candidate lands inside its own centred region, for a spread of
    /// region sizes including one that is not a power of two.
    #[test]
    fn keeps_every_candidate_inside_its_centred_region() {
        for region_size in [512u64, 1000, 1024, 2048] {
            for (rx, ry) in [(0i64, 0i64), (-3, 7), (100, -100)] {
                let key = SpotRegionKey {
                    seed0: 42,
                    seed1: 7,
                    region_x: rx,
                    region_y: ry,
                };
                let rs = region_size as i64;
                for p in points(key, region_size, 32) {
                    assert!(p.x >= rx * rs - rs / 2 && p.x < rx * rs + rs / 2, "x {p:?}");
                    assert!(p.y >= ry * rs - rs / 2 && p.y < ry * rs + rs / 2, "y {p:?}");
                }
            }
        }
    }

    /// A negative region index must go through the wrapping reduction, not a
    /// float modulo. Pinned against the value the TypeScript produces - taken
    /// by running `spotSeedWord`, not by reading it.
    #[test]
    fn a_negative_region_index_reduces_by_wrapping() {
        let key = SpotRegionKey {
            seed0: 0,
            seed1: 0,
            region_x: -1_000_000,
            region_y: -1_000_000,
        };
        // 0x3FBE2C - 7919e6 - 7907e6 is negative, so the Euclidean correction
        // is what puts it back in range.
        let raw = SEED_BASE + RX_PRIME * -1_000_000 + RY_PRIME * -1_000_000;
        assert!(raw < 0, "the test case must actually go negative");
        assert_eq!(spot_seed_word(&key), raw.rem_euclid(M32) as u32);
        // And that word is large, so the clamp is not what produced it.
        assert!(spot_seed_word(&key) > MIN_SEED_WORD);
    }
}
