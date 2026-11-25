//! Two of the four engine "seed vars", ported from
//! `src/noise/expressions/vulcanusSeed.ts`.
//!
//! They drive Vulcanus's biome rotation - `vulcanus_ashlands_angle =
//! map_seed_normalized * 3600` and `vulcanus_starting_direction = -1 +
//! 2*(map_seed_small & 1)`, from
//! `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`. Both are pure
//! functions of `seed0` (= `map_seed`, the wire seed) and both are DOCUMENTED
//! rather than merely reverse-engineered: the game's own noise-expressions
//! reference calls them "16 least significant bits from map_seed" and "0-1
//! normalized value of map_seed". Confirmed bit-exact against 12 oracle-sampled
//! seeds spanning the 32-bit range - see `docs/noise/vulcanus-seed-vars-NOTES.md`.
//!
//! `seed0` is a `u32` here rather than the TypeScript's `number`. That is the
//! type system removing a coercion question rather than a change of behaviour:
//! `seedSmall` is written `seed0 & 0xffff` in JavaScript, whose `ToInt32`
//! coercion makes it bit-identical to `seed0 % 65536` for every `seed0` in
//! `[0, 2^32)`, including the two fixture rows above `2^31`.
//!
//! **`x_from_start` and `y_from_start` are the other two seed vars in that
//! fixture and they need no port.** They resolved to `== x, y` at the default
//! spawn, which is what
//! `the_from_start_vars_are_the_identity_at_the_default_spawn` in `fixtures.rs`
//! pins. A future non-default spawn would change that, and the fixture would be
//! the place it shows up.

use crate::poison;

/// `map_seed_normalized`: `f32(seed0 / (2^32 - 1))`.
///
/// **The divisor is `4_294_967_295`, not `2^32` (#531).** The game maps the whole
/// `u32` range onto the CLOSED interval `[0, 1]`, so `seed_normalized(u32::MAX)`
/// is exactly `1`. The old `2^32` divisor also gave `1` there, because the f32
/// rounding absorbs the difference at the top of the range - which is why the 12
/// oracle seeds could not tell the two apart. Against the game's own value on 606
/// probed seeds, `2^32` matched 601 and `2^32 - 1` matches all 606
/// (`test/fixtures/oracle-bearing-chain.seeds606.json`).
///
/// The division is done in f64 and narrowed once, exactly as
/// `Math.fround(seed0 / 4294967295)` does.
#[must_use]
pub fn seed_normalized(seed0: u32) -> f32 {
    poison::f32_result((f64::from(seed0) / 4_294_967_295.0) as f32)
}

/// `map_seed_small`: the 16 least significant bits of `seed0`.
///
/// Only the parity (`seed_small(seed0) & 1`) is consumed downstream, by
/// `vulcanus_starting_direction`.
#[must_use]
pub fn seed_small(seed0: u32) -> u32 {
    poison::u32_result(seed0 & 0xffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The top of the range is exactly one, and a seed that can tell the two
    /// divisors apart agrees with the game.
    ///
    /// The old test used `0xFFFF_FFFF`, where `2^32` and `2^32 - 1` both give
    /// exactly `1`, so it could not fail (#531). `3_526_822_528` is a seed the
    /// game was read on (`reproduces_the_games_bearing_chain_on_606_seeds` has
    /// all 606): the game says 0.82115238904953, and dividing by `2^32` gives
    /// 0.8211523294448853.
    #[test]
    fn matches_the_game_on_a_seed_that_separates_the_divisors() {
        assert_eq!(seed_normalized(0xffff_ffff), 1.0);
        assert_eq!(f64::from(seed_normalized(3_526_822_528)), 0.82115238904953);
        assert_ne!(
            f64::from((f64::from(3_526_822_528u32) / 4_294_967_296.0) as f32),
            0.82115238904953
        );
    }

    /// The 16-bit mask, at the boundary rather than only in the middle.
    #[test]
    fn keeps_the_low_sixteen_bits_only() {
        assert_eq!(seed_small(0), 0);
        assert_eq!(seed_small(0xffff), 0xffff);
        assert_eq!(seed_small(0x1_0000), 0);
        assert_eq!(seed_small(0xffff_ffff), 0xffff);
        assert_eq!(seed_small(0x1234_5678), 0x5678);
    }
}
