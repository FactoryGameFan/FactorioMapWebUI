//! The native `expression_in_range` builtin, ported from
//! `src/noise/tiles/expressionInRange.ts`.

use crate::eval::math::min2;

/// The native Factorio `expression_in_range(peak_multiplier, peak_maximum,
/// expr_1..N, from_1..N, to_1..N)` builtin. The tile-autoplace system uses it to
/// make a tile probable only inside an N-dimensional box of climate values, with
/// a linear falloff outside.
///
/// ```text
/// per dim i:  half_i   = (to_i - from_i) / 2      (constants, folded in f64)
///             center_i = (from_i + to_i) / 2
///             d_i      = min(peak_maximum, peak_multiplier * (half_i - |value_i - center_i|))
/// result    = min over all dims of d_i
/// ```
///
/// `half - |value - center|` is the signed distance to the nearer edge of
/// `[from, to]`: positive inside, zero on an edge, negative outside. Taking the
/// min across dims makes the box a hard AND. There is **no lower clamp**.
///
/// # The game builds it from a CENTER and a HALF-WIDTH, and that is not cosmetic
///
/// Read off the 2.1.23 binary with Ghidra (`NoiseExpressions::expressionInRange`,
/// file 0x1542990): the builder folds `(to - from) * 0.5` and `(from + to) * 0.5`
/// into two constants, then emits `subtract(value, center)`, an absolute value,
/// `subtract(half, ...)`, `multiply(..., peak_multiplier)` (skipped at 1) and
/// `clamp(..., -inf, peak_maximum)` (skipped at +inf) per dim, and folds the dims
/// with `clamp(acc, -inf, d_i)`, starting from +inf.
///
/// In exact math it equals `min(value - from, to - value)`, which this function
/// used to compute. In f32 it does not: `value - center` subtracts a far-away
/// center, so the low bits round differently. At the last differing Nauvis
/// pixel, (229, -19), the game's grass scores came back exact under this form at
/// all 36 values in its 3x3 neighbourhood, and the edge form matched 11 (#521).
///
/// # Every step is f32
///
/// `half` and `center` are folded from the f64 constants and then held as f32,
/// like every noise-machine constant. Every operation after that is one f32
/// step.
///
/// # Two things that look like tidying and are not
///
/// - **The accumulator loop uses a strict `<`, not [`min2`].** A NaN dim
///   compares false against everything, so it never becomes the running minimum
///   and NaN does **not** propagate out of the loop. That is the TypeScript's
///   behaviour and was kept.
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
    let multiplier = peak_multiplier as f32;
    let mut m = f64::INFINITY;
    for i in 0..values.len() {
        let v = values[i] as f32;
        let half = ((tos[i] - froms[i]) * 0.5) as f32;
        let center = ((froms[i] + tos[i]) * 0.5) as f32;
        let distance = half - (v - center).abs();
        // `min2` and not `f64::min`: this feeds an argmax whose tie-break is
        // order-sensitive, and the two differ on signed zero.
        let d = min2(f64::from(multiplier * distance), peak_maximum);
        if d < m {
            m = d;
        }
    }
    m
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

    /// The center form against the game's own numbers at (229, -19), read with
    /// `calculate_tile_properties` on 2.1.23: aux, moisture, `noise_layer_noise(19)`
    /// and the `grass-1` score. The edge form `min(v - from, to - v)` is equal in
    /// exact math and lands 60 f32 steps low here; this is the control that it
    /// does not come back.
    #[test]
    fn the_center_form_reproduces_the_games_grass_1_score() {
        let (aux, moisture) = (0.603_208_422_660_827_6, 0.737_899_124_622_345);
        let layer = 0.553_787_469_863_891_6;
        let game = 1.311_777_353_286_743_2;
        let box_ = expression_in_range(20.0, 1.0, &[aux, moisture], &[-10.0, 0.7], &[11.0, 11.0]);
        assert_eq!(f64::from((box_ + layer) as f32), game);

        let edge = {
            let v = moisture as f32;
            f64::from(20.0f32 * (v - 0.7f32))
        };
        assert_ne!(
            f64::from((edge + layer) as f32),
            game,
            "the edge form must miss"
        );
    }

    /// No dimensions at all leaves the accumulator at its starting value, +inf,
    /// as the game's builder starts it; the cap is applied per dim, so it never
    /// runs. Not reachable: the game refuses fewer than 5 arguments (one dim).
    /// Pinned because the starting value is otherwise invisible.
    #[test]
    fn no_dimensions_gives_the_starting_infinity() {
        assert_eq!(expression_in_range(20.0, 1.0, &[], &[], &[]), f64::INFINITY);
    }
}
