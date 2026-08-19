//! Factorio's `starting_lake_positions`
//! (`MapGenSettings::getStartingLakePositions() const`, non-stripped 2.1.11
//! arm64 `0x10160a2fc`), ported from `src/noise/startingLakes.ts`. See
//! `docs/superpowers/specs/2026-07-18-starting-lake-positions-design.md`.
//!
//! One lake per starting position, in order, off one continuous taus88 stream:
//! a single draw picks an angle and the lake sits at a FIXED radius of 75
//! tiles. Nothing else is random - the radius, the phase quantisation and the
//! fast-sine polynomial are all fixed, and there is no rejection or separation
//! loop. Empty input gives empty output.
//!
//! Seeding is the simplest of the three variants in the port:
//! `word = max(seed0, 0x155)`, all three state words set to it, seeded ONCE
//! outside the loop. No `seed1` combine (unlike basis noise) and no `^ seed0`
//! (unlike spot noise).
//!
//! ## Precision: f64, with exactly ONE f32 round-trip
//!
//! The disassembly reads as one `fcvt s,d; fcvt d,s` pair, on the angle, and
//! everything else in double. That is transcribed below at `t`, and the rest of
//! `sinlike` stays f64.
//!
//! **The fixture cannot check that reading, and the gap is measured rather than
//! assumed.** Sweeping seeds 0..200,000 with a single origin spawn:
//!
//! | variant | lakes differing from this port |
//! | --- | --- |
//! | `sinlike` evaluated in f32 throughout | **44** |
//! | libm `cos`/`sin` instead of the polynomial | **0** |
//!
//! Both readings were then PLANTED in this file and the suite run, because a
//! break table that nobody executes is a list of guesses:
//!
//! - **f32 throughout: caught, by one test only.** Seed 39,716 returned
//!   `(0, 75)` against the correct `(0, 74)`, and
//!   `an_f32_throughout_polynomial_picks_a_different_lake` was the single
//!   failure. The tier-1 fixture test stayed GREEN at 26 of 26, which is the
//!   point - `startingLakeDistance` cannot see this, so the discriminating
//!   seeds have to be pinned directly.
//! - **libm `cos`/`sin`: NOT caught, by anything.** Substituting
//!   `(t * TAU).cos()` for the whole polynomial passed all 39 tests in this
//!   crate. The polynomial's ~6e-9 error never survives truncation to a whole
//!   tile, so there is no fixture and no seed sweep that will catch it.
//!
//! That second result is why the polynomial stays even though nothing measures
//! it: the reason is the determinism policy, not a difference in output. V8 and
//! libm disagree in the last bit, and WebAssembly has no `sin` or `cos` at all,
//! so a runtime call would have to be code we compiled and could drift from the
//! TypeScript. See spec section 5. Treat this module as one where review, not
//! the gate, is the control.
//!
//! The truncation direction is `fcvtzs` - toward zero, not flooring. That
//! differs on negative coordinates, which is most of the map.

use crate::distance_from_nearest_point::Point;
use crate::poison;
use crate::taus88::{seeded_state, taus88_next};

/// taus88's all-zero fixed point, guarded by clamping the seed word from below.
const MIN_SEED_WORD: u32 = 0x155;

// Written as `f64::from_bits` of the immediates in the arm64 disassembly rather
// than as decimals, so they cannot drift through a decimal round-trip - the
// same discipline `fast_approx` uses. Each one was checked to round-trip
// against the decimal in `src/noise/startingLakes.ts`.
/// `2^-32`, the draw normalisation.
const TWO_POW_NEG32: f64 = f64::from_bits(0x3DF0_0000_0000_0000);
/// `2*pi`.
const TWO_PI: f64 = f64::from_bits(0x4019_21FB_5444_2D18);
/// `1/(2*pi)`.
const INV_TWO_PI: f64 = f64::from_bits(0x3FC4_5F30_6DC9_C883);
/// The lake radius, in tiles. Fixed, not random.
const RADIUS: f64 = f64::from_bits(0x4052_C000_0000_0000);

// The fast-sine minimax coefficients.
const C1: f64 = f64::from_bits(0x4044_ABBC_0232_9376);
const C2: f64 = f64::from_bits(0x4019_21FB_51BF_1614);
const C3: f64 = f64::from_bits(0x4053_2468_7A27_A35E);
const C4: f64 = f64::from_bits(0x4054_6687_6B29_F494);
const C5: f64 = f64::from_bits(0x4043_D424_3780_214B);

/// The game's inlined fast approximation of `cos(2*pi*t)`, with `t` in turns.
///
/// The term order is the TypeScript's, which is the disassembly's:
/// `(C2 - x2*C1) + x4*(C4 - x2*C3)`, then `x8*C5 + that`. Do not fold these
/// into one expression or reassociate them - `clippy::suboptimal_flops` would
/// recommend `mul_add` here, which rounds once instead of twice and is exactly
/// the contraction the crate-level `allow` exists to prevent.
fn sinlike(t: f64) -> f64 {
    let r = (t + if t > 0.0 { 0.5 } else { -0.5 }).trunc();
    let x = 0.25 - (t - r).abs();
    let x2 = x * x;
    let x4 = x2 * x2;
    let x8 = x4 * x4;
    let poly = C2 - x2 * C1 + x4 * (C4 - x2 * C3);
    let poly = x8 * C5 + poly;
    x * poly
}

/// The game's `starting_lake_positions`: one lake per starting position,
/// computed from `(seed0, starting_positions)` alone, in world tiles.
///
/// `starting_positions` are already in tiles - do NOT re-apply the game's
/// `/256` fixed-point read, which is what turned an int32 `MapPosition` into
/// these coordinates in the first place.
#[must_use]
pub fn starting_lake_positions(seed0: u32, starting_positions: &[Point]) -> Vec<Point> {
    let mut st = seeded_state(seed0.max(MIN_SEED_WORD));
    let mut lakes = Vec::with_capacity(starting_positions.len());
    for spawn in starting_positions {
        let u = f64::from(taus88_next(&mut st)) * TWO_POW_NEG32;
        // The single f32 round-trip, on the angle. `Math.fround(u * TWO_PI)` in
        // the TypeScript.
        let t = f64::from((u * TWO_PI) as f32) * INV_TWO_PI;
        lakes.push(Point {
            // `fcvtzs`: truncate toward zero, NOT floor. The two differ on
            // negative coordinates, which is most of the map.
            x: poison::f64_result((spawn.x + RADIUS * sinlike(t)).trunc()),
            y: poison::f64_result((spawn.y + RADIUS * sinlike(t - 0.25)).trunc()),
        });
    }
    lakes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_origin(seed0: u32) -> Point {
        starting_lake_positions(seed0, &[Point { x: 0.0, y: 0.0 }])[0]
    }

    /// One lake per starting position, in order, off ONE stream.
    ///
    /// Ground truth taken by RUNNING `src/noise/startingLakes.ts`, not by
    /// reading it and not from this port - a test that checks a port against
    /// itself proves nothing. The same discipline as `taus88`'s stream test.
    /// Reproduce with `startingLakePositions(123456, [{x:0,y:0}, {x:1000,y:0},
    /// {x:-500,y:250}])`.
    #[test]
    fn returns_one_lake_per_starting_position_from_a_continuous_stream() {
        let spawns = [
            Point { x: 0.0, y: 0.0 },
            Point { x: 1000.0, y: 0.0 },
            Point {
                x: -500.0,
                y: 250.0,
            },
        ];
        assert_eq!(
            starting_lake_positions(123_456, &spawns),
            vec![
                Point { x: 45.0, y: -59.0 },
                Point { x: 996.0, y: 74.0 },
                Point {
                    x: -516.0,
                    y: 176.0
                },
            ]
        );
        // The first lake is the same one a single-spawn call produces, which is
        // what makes "seeded once, outside the loop" observable.
        assert_eq!(at_origin(123_456), Point { x: 45.0, y: -59.0 });
    }

    /// The discriminating control for the f64 reading of `sinlike`.
    ///
    /// Evaluating the polynomial in f32 throughout - the house rule everywhere
    /// else in this crate - moves the lake on 44 of the first 200,000 seeds.
    /// This is one of them: the f32 reading gives `(0, 75)`. Watched failing
    /// against an f32 transcription before being committed.
    #[test]
    fn an_f32_throughout_polynomial_picks_a_different_lake() {
        assert_eq!(at_origin(39_716), Point { x: 0.0, y: 74.0 });
        assert_eq!(at_origin(55_600), Point { x: 0.0, y: -74.0 });
    }

    /// The radius is fixed at 75 and only the angle is random, so every lake
    /// lands just inside a circle of 75 - an oracle-independent invariant that
    /// a second RNG draw, or a random radius, would break.
    #[test]
    fn every_lake_sits_at_radius_75_from_its_spawn_before_truncation() {
        for seed in [999u32, 1, 123_456, 0xffff_ffff, 7] {
            let p = at_origin(seed);
            let r = (p.x * p.x + p.y * p.y).sqrt();
            assert!(r > 73.0 && r <= 75.0, "seed {seed} put a lake at {r}");
        }
        assert_eq!(at_origin(999), Point { x: 73.0, y: 14.0 });
    }

    /// The seed word is clamped from below, so every seed under 341 behaves as
    /// 341 - the all-zero taus88 state is a fixed point.
    #[test]
    fn the_seed_word_is_clamped_from_below() {
        assert_eq!(at_origin(0), at_origin(340));
        assert_eq!(at_origin(0), at_origin(0x155));
        // And the clamp must stop mattering above the threshold, or the
        // assertions above would pass on a function that ignored its seed.
        //
        // The obvious probe - `0x156`, one past the floor - does NOT
        // discriminate, and that is measured rather than guessed: seeds 342
        // through 350 all land on `(74, 4)`. The angle does move, but the
        // truncation to a whole tile absorbs it, so a seed has to be far
        // enough above the floor for the lake to cross a tile boundary. 0x160
        // is the first that does.
        assert_ne!(at_origin(0), at_origin(0x160));
    }

    #[test]
    fn empty_starting_positions_give_no_lakes() {
        assert!(starting_lake_positions(123_456, &[]).is_empty());
    }
}
