//! `asymmetric_ramps`, ported from `src/noise/trees/asymmetricRamps.ts`.

use crate::eval::math::min2;

/// `asymmetric_ramps` (`core/prototypes/noise-functions.lua:114-124`).
///
/// Two opposing linear ramps combined with `min`: the output crosses 0 at
/// `from_top` and `to_top`, and -1 at `from_bottom` and `to_bottom`. The peak
/// depends on how far apart the tops are, so it is positive when they are apart
/// and negative when they cross.
///
/// **No clamp and no upper bound, deliberately.** The game's own comment says it
/// is "designed to be used with a group of asymmetric_ramps inside a shared
/// min()", which is exactly how every tree species uses it. A port that clamped
/// it would look tidier and be wrong - the unbounded negative tail is what lets
/// the outer `min` reject a species outright.
#[must_use]
pub fn asymmetric_ramps(
    input: f64,
    from_bottom: f64,
    from_top: f64,
    to_top: f64,
    to_bottom: f64,
) -> f64 {
    // The `from` ramp first, as the TypeScript writes it.
    min2(
        (input - from_top) / (from_top - from_bottom),
        (to_top - input) / (to_bottom - to_top),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tree_01`'s temperature ramp, as a concrete case to reason about.
    const T: (f64, f64, f64, f64) = (0.0, 10.0, 14.0, 15.0);

    fn ramp(input: f64) -> f64 {
        asymmetric_ramps(input, T.0, T.1, T.2, T.3)
    }

    #[test]
    fn it_crosses_zero_at_both_tops_and_minus_one_at_both_bottoms() {
        assert_eq!(ramp(10.0), 0.0, "from_top");
        assert_eq!(ramp(14.0), 0.0, "to_top");
        assert_eq!(ramp(0.0), -1.0, "from_bottom");
        assert_eq!(ramp(15.0), -1.0, "to_bottom");
    }

    #[test]
    fn it_is_positive_between_the_tops_and_falls_away_outside_them() {
        assert!(ramp(12.0) > 0.0, "between the tops");
        assert!(ramp(5.0) < 0.0 && ramp(5.0) > -1.0, "inside the from ramp");
        assert!(ramp(14.5) < 0.0 && ramp(14.5) > -1.0, "inside the to ramp");
    }

    #[test]
    fn it_is_unbounded_below_and_that_is_the_point() {
        // Far outside the band it keeps falling. Every species relies on this:
        // the outer `min(0, temp, moist)` uses the negative tail to push a
        // species below its cap rather than merely to zero. A clamp here would
        // make every species equally likely far from its band.
        assert!(ramp(-1000.0) < -100.0, "{}", ramp(-1000.0));
        assert!(ramp(1000.0) < -100.0, "{}", ramp(1000.0));
    }

    #[test]
    fn the_peak_goes_negative_when_the_tops_cross() {
        // The game's own note: the peak depends on how far apart the tops are,
        // so a band whose tops cross is negative everywhere. No species ships
        // that way, but the function has to keep the behaviour.
        let crossed = asymmetric_ramps(12.0, 0.0, 14.0, 10.0, 15.0);
        assert!(crossed < 0.0, "{crossed}");
    }

    #[test]
    fn the_argument_order_is_the_typescripts() {
        // `min(fromRamp, toRamp)`. Both operands are ordinary finite f64 here,
        // so the order cannot bite through a signed zero - but the inventory in
        // `docs/nauvis-trees-port-survey.md` lists it, and swapping it in a
        // version that later meets a NaN would differ.
        let input = 12.0;
        let from_ramp = (input - T.1) / (T.1 - T.0);
        let to_ramp = (T.2 - input) / (T.3 - T.2);
        assert_eq!(ramp(input), min2(from_ramp, to_ramp));
    }
}
