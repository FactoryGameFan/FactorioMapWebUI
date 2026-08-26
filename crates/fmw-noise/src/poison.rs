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
//!
//! Phase 6 (#226) adds a third of the relational kind:
//!
//! - `the_cliff_elevation_term_moves_the_tree_where_the_outer_min_does_not_mask_it`
//!   counts positions where `elevation_nauvis` and `elevation_nauvis_no_cliff`
//!   DISAGREE, on the game's own two columns and on our two trees. A
//!   perturbation applies to both sides of each comparison and cancels, so it
//!   stays green - checked rather than predicted. Its discriminating power is
//!   the relation: the two trees must differ at 17 of 26 and agree at the other
//!   9, which a port ignoring the flag entirely cannot do.
//!
//! And a fourth of the STRUCTURAL kind, from the cliff and rock fields:
//!
//! - `the_rock_fixture_grades_the_intermediate_because_the_shipped_field_is_zero_there`
//!   asserts that all 26 `oracle-rock-density` positions have every rock
//!   probability negative, so the clamped density is 0 at each of them. It
//!   exists to say why tier 1 grades `rock_density` and not the field above it.
//!   A one-ULP nudge does not move a -0.097 probability across zero, so it
//!   stays green - correctly, because its content is a fact about where the
//!   fixture sits rather than a claim about any computed value.
//!
//! The enemy layer (#226) adds two more, one of each kind:
//!
//! - `every_enemy_distance_scalar_saturates_at_2400_tiles` compares
//!   `enemy_spot_radius` and friends against hand-computed constants, and
//!   asserts they are FLAT past `distance = 2400`. Nothing beneath them carries
//!   a hook - `eval::math` poisons only `slider_to_linear` and `slider_rescale`,
//!   which these never call - and the equalities cancel a perturbation anyway.
//!   The scalars are still graded, by the field test that composes them: a
//!   wrong radius moves every cone, and that test goes red.
//! - `the_spot_quantity_cube_is_powf_and_a_plain_product_would_diverge`
//!   compares `r.powf(3.0)` against `r * r * r`, both unpoisoned. Its content is
//!   that two ways of writing the same thing disagree, which a perturbation can
//!   only strengthen.

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

/// Flip a binary CLASSIFICATION.
///
/// Used by the ops whose output is a choice rather than a number. Fulgora's
/// ocean test is one: it returns "deep", "shallow" or "not ocean", and its
/// tier-1 test counts how often that choice disagrees with the tile the game
/// actually placed across 5,057 positions.
///
/// **A numeric hook does not reach it, and that was measured rather than
/// assumed** (2026-08-19). With only the elevation hook live, the whole chain
/// underneath moved by one ULP and
/// `puts_fulgora_land_and_ocean_where_the_game_puts_them` stayed GREEN at 7 and
/// 11 - because the decision is a comparison, and a one-ULP nudge changes which
/// side of it a value falls on essentially never. Same reason `voronoi_cell_id`
/// is exact where `pyramid_noise` is not: a discrete lookup absorbs a sub-ULP
/// input error.
///
/// So the perturbation has to act on the choice. This is the smallest wrong
/// answer a classifier can give, the way `i64_result`'s one-tile shift is for a
/// coordinate.
///
/// **Nauvis's `cliffiness` gate reproduced that result on new ground in #226**,
/// which is worth recording because the measurement was run rather than the
/// rule applied. `cliffiness_nauvis` is
/// `(main_cliffiness >= cliff_cutoff) * 10`; with no hook on it the tier-1 gate
/// test stayed GREEN at 0 mismatches, while the sibling field sharing its whole
/// `NauvisShared` chain fell from 355 exact to 227. The margins say why: the
/// closest of 2,048 positions sits 2.344133e-4 from the cutoff and one f32 ULP
/// there is about 6e-8, so a bent leaf is some 3,900 ULPs short.
#[inline]
#[must_use]
pub fn bool_result(value: bool) -> bool {
    #[cfg(feature = "poison")]
    return !value;
    #[cfg(not(feature = "poison"))]
    value
}

/// Rotate a winning INDEX to the next candidate.
///
/// The counterpart of [`bool_result`] for an argmax rather than a two-way
/// choice. Fulgora's land layer picks one of eight tiles, and a one-ULP nudge
/// to any of the eight probabilities changes the winner essentially never - the
/// same reason a numeric hook cannot reach the ocean test.
///
/// **It needs its own hook even though the tile test already goes red**, and
/// that distinction is the doctrine this module exists for: under poison the
/// ocean hook flips every position's land-versus-ocean answer, so
/// `puts_every_fulgora_tile_where_the_game_puts_it` would be red whether or not
/// the argmax had a control. A gate satisfiable by an unrelated part of the
/// system is not a gate for the new part.
///
/// `tiles::fulgora_catalog::tests::an_exact_tie_resolves_to_the_earlier_tile_in_land_order`
/// is the test that sees THIS hook and not the ocean one, because it calls
/// `land_argmax` directly.
#[inline]
#[must_use]
pub fn index_result(index: usize, len: usize) -> usize {
    #[cfg(feature = "poison")]
    if len > 1 {
        return (index + 1) % len;
    }
    #[cfg(not(feature = "poison"))]
    let _ = len;
    index
}

/// Rotate a tri-state CROSSING to the next value.
///
/// `CliffGenerator::crossesCliff` answers "no crossing", "crossing up" or
/// "crossing down", and four of those answers assemble into the cell code the
/// orientation table keys on. That is a classification, so the numeric hooks
/// cannot reach it for the reason [`bool_result`] and [`index_result`] record:
/// a one-ULP nudge to an elevation changes which side of a band boundary it
/// falls on essentially never.
///
/// It rotates rather than negating because negating `0` is `0` - the answer
/// most edges give - so a sign flip would leave most of the lattice untouched
/// and the end-to-end cliff test could stay green. Rotating moves every edge.
#[inline]
#[must_use]
pub fn crossing_result(value: i8) -> i8 {
    #[cfg(feature = "poison")]
    return match value {
        0 => 1,
        1 => -1,
        _ => 0,
    };
    #[cfg(not(feature = "poison"))]
    value
}

/// Rotate the edge order the cliff repair sweep tries.
///
/// `fixImpossibleCellsSweep` has no numeric output to bend and no single choice
/// to flip: it is an algorithm over discrete inputs whose only observable is
/// which edge it cleared. The engine's order is `L, T, R, B`, and clearing a
/// different one leaves a different - usually still legal - cell code, which is
/// precisely the wrong answer a mis-ported sweep gives.
///
/// **It needs its own hook even though the end-to-end cliff test already goes
/// red**, for the reason [`index_result`] records: under poison
/// [`crossing_result`] moves every edge in the lattice, so
/// `places_every_vulcanus_cliff_where_the_game_places_it` would be red whether
/// or not the sweep had a control at all. A gate satisfiable by an unrelated
/// part of the system is not a gate for the new part.
#[inline]
#[must_use]
pub fn sweep_order(order: [usize; 4]) -> [usize; 4] {
    #[cfg(feature = "poison")]
    return [order[1], order[2], order[3], order[0]];
    #[cfg(not(feature = "poison"))]
    order
}
