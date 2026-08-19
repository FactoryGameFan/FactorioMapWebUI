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

/// `map_seed_normalized`: `f32(seed0 / 2^32)`.
///
/// **The f32 rounding is the noise VM's arithmetic and it matters at the top of
/// the range.** `seed_normalized(0xFFFF_FFFF)` is exactly `1`, not the
/// `0.999_999_999_767...` plain f64 division gives - verified against the
/// oracle, not assumed. So the honest range is the CLOSED `[0, 1]`, not the
/// half-open `[0, 1)` that "normalize a 32-bit uint" would suggest.
///
/// The division is done in f64 and narrowed once, exactly as
/// `Math.fround(seed0 / 4294967296)` does. `2^32` is a power of two, so the
/// quotient is exact in f64 and this is a single rounding.
#[must_use]
pub fn seed_normalized(seed0: u32) -> f32 {
    poison::f32_result((f64::from(seed0) / 4_294_967_296.0) as f32)
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

    /// The discriminating row, stated on its own because the fixture sweep
    /// would pass with plain f64 division at 11 of its 12 seeds.
    ///
    /// Plain division gives `0.999_999_999_767_169_4`, which is not 1. Only the
    /// f32 narrowing reaches the oracle's exact `1`.
    #[test]
    fn the_top_of_the_range_narrows_to_exactly_one() {
        assert_eq!(seed_normalized(0xffff_ffff), 1.0);
        assert_ne!(f64::from(0xffff_ffffu32) / 4_294_967_296.0, 1.0);
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
