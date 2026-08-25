//! The native `expression_in_range` builtin, ported from
//! `src/noise/tiles/expressionInRange.ts`.

use crate::eval::math::min2;

/// The native Factorio `expression_in_range(peak_multiplier, peak_maximum,
/// expr_1..N, from_1..N, to_1..N)` builtin, reverse-engineered from the headless
/// oracle (see `docs/noise/expression-in-range-NOTES.md`). The tile-autoplace
/// system uses it to make a tile probable only inside an N-dimensional box of
/// climate values, with a linear falloff outside.
///
/// ```text
/// m      = min over all dims i of min(value_i - from_i, to_i - value_i)
/// result = min(peak_maximum, peak_multiplier * m)
/// ```
///
/// Per dimension, `min(value - from, to - value)` is the signed distance to the
/// nearer edge of `[from, to]`: positive inside, zero on an edge, negative
/// outside. Taking the min across dims makes the box a hard AND. Scaling by
/// `peak_multiplier` sets the falloff slope; clamping at `peak_maximum` caps the
/// in-range plateau. There is **no lower clamp** - the value falls linearly
/// without bound outside the range.
///
/// # Every step is f32, and that is what makes it exact
///
/// The TypeScript spells this with 5 `Math.fround` calls because JavaScript
/// computes in f64; here the narrowing is the type. It is not decoration. The
/// arithmetic used to run in f64 and round once at the end, which left a worst
/// residual of ~9.5e-7 that a spec accepted under an `8e-3` floor - a ceiling
/// ~8400x looser than the actual error (#162). Per-operation f32 takes the
/// residual to **exactly 0 on all 404 committed oracle samples**, where the f64
/// form matched only 285.
///
/// **The `from`/`to` CONSTANTS are narrowed too, not just the products.** The
/// catalog passes literals like `0.7`, `0.45` and `0.35`, none of which is
/// f32-exact, so this is the `narrow the CONSTANT` half of the rule in
/// `eval/mod.rs` rather than the `narrow the PRODUCT` half.
///
/// # Two things that look like tidying and are not
///
/// - **The accumulator loop uses a strict `<`, not [`min2`].** A NaN
///   `edge_distance` compares false against everything, so it never becomes the
///   running minimum and NaN does **not** propagate out of the loop - which is
///   the opposite of what `min2` does. That is the TypeScript's behaviour and
///   the engine's, so it is reproduced rather than cleaned up.
/// - **`peak_maximum` stays unrounded.** It is `f64::INFINITY` at `sand-1`'s
///   call site, where the plateau is deliberately uncapped and in-range values
///   exceed 1. Do not clamp that case.
#[must_use]
pub fn expression_in_range(
    peak_multiplier: f64,
    peak_maximum: f64,
    values: &[f64],
    froms: &[f64],
    tos: &[f64],
) -> f64 {
    let mut m = f64::INFINITY;
    for i in 0..values.len() {
        let v = values[i] as f32;
        let from = froms[i] as f32;
        let to = tos[i] as f32;
        // `min2` and not `f64::min`: this feeds an argmax whose tie-break is
        // order-sensitive, and the two differ on signed zero.
        let edge_distance = min2(f64::from(v - from), f64::from(to - v));
        if edge_distance < m {
            m = edge_distance;
        }
    }
    min2(peak_maximum, f64::from(peak_multiplier as f32 * m as f32))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plateau, the edges, and the unbounded falloff outside, on one axis.
    #[test]
    fn it_plateaus_inside_and_falls_without_bound_outside() {
        // peak_multiplier 20, peak_maximum 1: 0.05 of headroom saturates.
        let inside = expression_in_range(20.0, 1.0, &[0.5], &[0.0], &[1.0]);
        assert_eq!(inside, 1.0, "deep inside the box saturates at peak_maximum");

        // Exactly on an edge: distance 0, so the result is 0 rather than the
        // plateau. This is the boundary the tile argmax ties on.
        assert_eq!(expression_in_range(20.0, 1.0, &[1.0], &[0.0], &[1.0]), 0.0);

        // Outside: NO lower clamp. One unit out at slope 20 is -20.
        assert_eq!(
            expression_in_range(20.0, 1.0, &[2.0], &[0.0], &[1.0]),
            -20.0
        );
    }

    /// The box is a hard AND across dimensions: any axis out of range pulls the
    /// whole result down, even when the others are deep inside.
    #[test]
    fn a_single_out_of_range_axis_pulls_the_result_down() {
        let both_in = expression_in_range(20.0, 1.0, &[0.5, 0.5], &[0.0, 0.0], &[1.0, 1.0]);
        let one_out = expression_in_range(20.0, 1.0, &[0.5, 2.0], &[0.0, 0.0], &[1.0, 1.0]);
        assert_eq!(both_in, 1.0);
        assert_eq!(one_out, -20.0);
        // And it does not matter which axis is the bad one.
        assert_eq!(
            expression_in_range(20.0, 1.0, &[2.0, 0.5], &[0.0, 0.0], &[1.0, 1.0]),
            one_out
        );
    }

    /// `sand-1` passes `peak_maximum = inf`, and the plateau must NOT be capped
    /// at 1 there. Without this the coastal term would be clamped and sand-1
    /// would lose arguments it should win.
    #[test]
    fn an_infinite_peak_maximum_leaves_the_plateau_uncapped() {
        // sand-1's own call: expression_in_range(5, inf, elevation, aux, ...).
        let v = expression_in_range(5.0, f64::INFINITY, &[0.0, 0.75], &[-1.5, 0.5], &[1.5, 1.0]);
        assert!(v > 1.0, "expected an uncapped plateau, got {v}");
        // The binding axis is aux, 0.25 from either edge: 5 * 0.25 = 1.25.
        assert_eq!(v, 1.25);
    }

    /// The `from`/`to` constants are held at f32, which is the half of the fix
    /// that is easy to miss. `0.7` has no exact f32 form, so an f64 `from`
    /// gives a different answer - this is the planted control for that.
    #[test]
    fn the_range_constants_are_held_at_f32() {
        let value = 0.7_f64;
        let ours = expression_in_range(1.0, f64::INFINITY, &[value], &[0.7], &[11.0]);

        // The same expression with the constant left at f64 width.
        let f64_form = {
            let v = value as f32;
            let edge = min2(v as f64 - 0.7_f64, f64::from(11.0_f32 - v));
            min2(f64::INFINITY, f64::from(1.0_f32 * edge as f32))
        };

        assert_ne!(
            ours, f64_form,
            "if these agree the test cannot discriminate the constant's width"
        );
        // Ours is the f32 difference of two identical f32 values: exactly 0.
        assert_eq!(ours, 0.0);
    }

    /// A NaN does NOT propagate out of the accumulator loop, because the loop
    /// uses a strict `<`. Pinned so nobody "simplifies" the loop into `min2`,
    /// which propagates and would change the argmax's input.
    #[test]
    fn a_nan_axis_does_not_propagate_out_of_the_loop() {
        let v = expression_in_range(20.0, 1.0, &[f64::NAN, 0.5], &[0.0, 0.0], &[1.0, 1.0]);
        assert!(!v.is_nan(), "expected the NaN axis to be skipped, got {v}");
        assert_eq!(v, 1.0, "the remaining axis decides the result");
    }

    /// No dimensions at all leaves the accumulator at its starting value, so
    /// the result is `peak_maximum`. Not reachable from the catalog; pinned
    /// because the starting value is otherwise invisible.
    #[test]
    fn no_dimensions_gives_the_peak_maximum() {
        assert_eq!(expression_in_range(20.0, 1.0, &[], &[], &[]), 1.0);
    }
}
