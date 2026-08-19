//! Tile-autoplace helper functions, ported from `src/noise/tiles/helpers.ts`.
//!
//! Phase 3 needs two of them.

/// The game's `water_base(max_elevation, influence)`:
///
/// ```text
/// water_base(max_elevation, influence) =
///   if(max_elevation >= elevation, influence * min(max_elevation - elevation, 1), -inf)
/// ```
///
/// `elevation` is the runtime per-tile value, so it is the first parameter here;
/// `max_elevation` and `influence` are the tile's constants. Below
/// `max_elevation` the result ramps up linearly over the last 1 unit of headroom
/// to a plateau of `influence`; at or above it the tile is excluded entirely
/// with `-inf`, which the argmax can never select.
///
/// **The `-inf` is load-bearing and it is what makes NaN reachable.** A mask of
/// exactly 0 multiplied by `-inf` is NaN, which is how the ocean branch can
/// produce one. A NaN must LOSE the argmax rather than poison it - see
/// [`best_probability`].
#[must_use]
pub fn water_base(elevation: f64, max_elevation: f64, influence: f64) -> f64 {
    if max_elevation >= elevation {
        influence * (max_elevation - elevation).min(1.0)
    } else {
        f64::NEG_INFINITY
    }
}

/// The argmax over tile probabilities, as the engine performs it.
///
/// **A NaN LOSES rather than poisoning the result**, which is the whole reason
/// this is a hand-written loop rather than `f64::max` or a `Math.max`
/// equivalent. `v > best` is false for a NaN `v`, so a NaN never becomes the
/// best - matching the engine, and matching the TypeScript's
/// `bestProbability`. `f64::max` would return the non-NaN operand too, but
/// `Math.max` in JavaScript propagates NaN, so the TypeScript could not use its
/// built-in either.
///
/// Starting at `-inf` rather than at the first element means an empty slice
/// gives `-inf`, which is "no tile here" rather than a panic.
#[must_use]
pub fn best_probability(values: &[f64]) -> f64 {
    let mut best = f64::NEG_INFINITY;
    for &v in values {
        if v > best {
            best = v;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn water_base_ramps_over_the_last_unit_and_then_plateaus() {
        // 2 units of headroom: full influence.
        assert_eq!(water_base(78.0, 80.0, 1000.0), 1000.0);
        // Half a unit of headroom: half influence.
        assert_eq!(water_base(79.5, 80.0, 1000.0), 500.0);
        // Exactly at the level: zero, not -inf. `>=` includes equality.
        assert_eq!(water_base(80.0, 80.0, 1000.0), 0.0);
        // Above it: excluded entirely.
        assert_eq!(water_base(80.5, 80.0, 1000.0), f64::NEG_INFINITY);
    }

    /// The `-inf` times a zero mask really is NaN, which is the case
    /// `best_probability` exists to survive. Pinned so nobody "simplifies" the
    /// `-inf` into a large negative number and quietly removes the NaN.
    #[test]
    fn a_zero_mask_times_the_exclusion_is_nan() {
        assert!((0.0 * water_base(100.0, 80.0, 1000.0)).is_nan());
    }

    /// A NaN must LOSE the argmax, not poison it.
    #[test]
    fn a_nan_loses_the_argmax_rather_than_poisoning_it() {
        assert_eq!(best_probability(&[1.0, f64::NAN, 2.0]), 2.0);
        assert_eq!(best_probability(&[f64::NAN, -5.0]), -5.0);
        // All-NaN falls through to the starting value, which is "no tile".
        assert_eq!(best_probability(&[f64::NAN, f64::NAN]), f64::NEG_INFINITY);
        assert_eq!(best_probability(&[]), f64::NEG_INFINITY);
    }
}
