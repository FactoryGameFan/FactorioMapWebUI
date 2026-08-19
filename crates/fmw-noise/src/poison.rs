//! The anti-vacuity control for the whole gate.
//!
//! A parity test that passes against a deliberately broken port is worth
//! nothing, so `scripts/verify-rust.sh` builds once with `--features poison`
//! and asserts the tier-1 tests go RED. Without the feature every function here
//! is the identity and the optimiser removes it.
//!
//! **The perturbation must act where nothing can round it away**, which is the
//! value the gate compares - not an internal constant. That is measured rather
//! than assumed (2026-08-18): bending `GRADIENT_X[0]` by one ULP left
//! `basis-noise.seed123456.json` at 512 of 512 exact, even though direction 0
//! is selected at 4 of the 2,048 corners those 512 points evaluate and 3 of
//! those 4 go on to multiply by it. One ULP of a 4.2 is about 4.8e-7, and it
//! rounds away in `dx * g`, then again in `dot * falloff`, before it ever
//! reaches the pairwise sum.
//!
//! Two things follow from that, and the second is the one worth carrying:
//!
//! 1. The control has to act on the returned value itself.
//! 2. **A fixture cannot resolve a one-ULP error in a single internal slot**,
//!    so "the tables are right because the fixtures are green" is a weaker
//!    statement than it looks. Anything with internal constants needs its own
//!    direct test against them, which is why `basis_gradient_table` has one.
//!
//! Every op in the crate needs its own hook. `basis_noise` used to be the only
//! one and that was enough while every ported op composed it; the phase-1
//! primitives added in #220's second batch do not, so a single hook would have
//! left five tier-1 tests green under `--features poison`.
//! `scripts/verify-rust.sh` now asserts a NAMED list of tier-1 tests goes red
//! rather than just the suite, so that gap cannot reopen silently.
//!
//! ## Two tier-1 tests stay green under poison, and both should
//!
//! Recorded so nobody reads them as a hole:
//!
//! - `the_random_penalty_seed_word_matches_the_measured_formula` compares a
//!   `u32` against constants worked out on paper. There is no ULP to bend, and
//!   a wrong seed word fails it with or without the feature.
//! - `the_capture_grid_snap_is_inert_on_starting_lake_distance_and_that_is_measured`
//!   compares the snapped and unsnapped readings of the SAME op, so a
//!   perturbation applies to both sides and cancels by construction. That is
//!   what a relational assertion is; its discriminating power comes from the
//!   relation, not from a value.
//!
//! Phase 2 (#221) added two more of the same two kinds:
//!
//! - `the_from_start_vars_are_the_identity_at_the_default_spawn` reads the
//!   fixture and nothing else. `x_from_start` needed no port - at the default
//!   spawn it IS `x` - so there is no op to perturb. It exists to notice a
//!   fixture that stops saying that.
//! - `the_pow_fixture_still_discriminates_between_the_three_branches` asserts
//!   that the WRONG models of `^` disagree with the game at many positions.
//!   Poisoning makes them disagree MORE, so it stays green by construction -
//!   which is correct for a guard whose whole content is a negative.

/// Bend an f32 result by one ULP. Zero is left alone, because several ops
/// legitimately return exactly zero and the point is to perturb a computed
/// value rather than to break a documented identity.
#[inline]
#[must_use]
pub fn f32_result(value: f32) -> f32 {
    #[cfg(feature = "poison")]
    if value != 0.0 {
        return f32::from_bits(value.to_bits() + 1);
    }
    value
}

/// Bend an f64 result by one ULP **of its f32 narrowing**.
///
/// One f64 ULP would be invisible: every tier-1 test that grades an f64-valued
/// op compares it narrowed to f32, exactly as its TypeScript counterpart's spec
/// does, and an f64 ULP rounds away in that narrowing. This is the same lesson
/// as the gradient slot above - poison what the gate can see.
#[inline]
#[must_use]
pub fn f64_result(value: f64) -> f64 {
    #[cfg(feature = "poison")]
    {
        let narrowed = value as f32;
        if narrowed != 0.0 {
            return f64::from(f32::from_bits(narrowed.to_bits() + 1));
        }
    }
    value
}

/// Bend an integer result by one.
///
/// Used by the ops whose output is a whole number of tiles - the spot candidate
/// and spot selection coordinates, and the starting lake positions. There is no
/// ULP to bend there and a one-tile shift is the smallest wrong answer those ops
/// can give.
#[inline]
#[must_use]
pub fn i64_result(value: i64) -> i64 {
    #[cfg(feature = "poison")]
    return value + 1;
    #[cfg(not(feature = "poison"))]
    value
}

/// Bend a `u32` result by one.
///
/// Used by `map_seed_small`, whose only consumer downstream is its PARITY
/// (`vulcanus_starting_direction = -1 + 2*(map_seed_small & 1)`). Adding one
/// flips that parity, so the smallest perturbation available is also the one
/// the consumer can see.
#[inline]
#[must_use]
pub fn u32_result(value: u32) -> u32 {
    #[cfg(feature = "poison")]
    return value.wrapping_add(1);
    #[cfg(not(feature = "poison"))]
    value
}
