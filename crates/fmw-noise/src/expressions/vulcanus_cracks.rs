//! Vulcanus's crack and flood helpers, ported from
//! `src/noise/expressions/vulcanusCracks.ts`.
//!
//! `vulcanus_hairline_cracks`, `vulcanus_flood_cracks_a`,
//! `vulcanus_flood_cracks_b`, `vulcanus_flood_paths` and
//! `vulcanus_flood_basalts_func`, transcribed from
//! `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` lines ~490-523.
//!
//! This is the lava and plate pattern the elevation chain samples. It is pure
//! noise with no spawn dependency, stacked entirely on
//! [`VulcanusHelpers`](super::vulcanus_helpers::VulcanusHelpers)'s `plasma` and
//! `detail_noise`.
//!
//! ## Every `min` and `max` here goes through `min2`/`max2`
//!
//! Not `f64::min`/`f64::max`, and the argument order is kept exactly as the
//! TypeScript writes it. The two differ on NaN and on signed zero, where IEEE
//! 754-2019 `maximumNumber` is explicitly allowed to return either operand -
//! and Fulgora's `tile_ruin_paving` folded to a different tier-2 checksum for
//! precisely that reason, with both arms zero at different signs. A tolerance
//! cannot see it and neither can tier 1; only an order-sensitive fold over raw
//! bits can.
//!
//! `flood_basalts_func` nests `min(max(a, b), c)` and `flood_paths` takes
//! `min(0, ...)`, so this layer has four such sites.
//!
//! ## No memo, evaluated top to bottom in one pass
//!
//! The TypeScript memoizes each field because `flood_basalts_func` reads all
//! four of the others and it builds a DAG of lazy closures. [`CrackFields`]
//! computes them in dependency order into locals instead, which is what the
//! memo achieves bit-identically. Every read is at the SAME `(x, y)`.

use crate::at::At;
use crate::eval::math::{clamp, f32r, lerp_f32, max2, min2};
use crate::expressions::vulcanus_helpers::{Plasma, VulcanusHelpers};
use crate::multioctave_noise::Prepared;
use crate::poison;

/// `vulcanus_cracks_scale`.
///
/// A bare number literal in the Lua - the file's "used to be
/// segmentation_multiplier" constant. Every scale argument in this layer is
/// this constant times a per-call factor, transcribed as written.
pub const VULCANUS_CRACKS_SCALE: f64 = 0.325;

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CrackFields {
    pub hairline_cracks: f64,
    pub flood_cracks_a: f64,
    pub flood_cracks_b: f64,
    pub flood_paths: f64,
    pub flood_basalts_func: f64,
}

/// The per-render constants of Vulcanus's crack layer.
pub struct VulcanusCracks {
    hairline: Plasma,
    crack_a1: Plasma,
    crack_a2: Plasma,
    crack_a_mix: Prepared,
    crack_b1: Plasma,
    crack_b2: Plasma,
    crack_b_mix: Prepared,
    path_plasma: Plasma,
    path_detail: Prepared,
}

impl VulcanusCracks {
    /// Build the layer from the helper closures it stacks on.
    #[must_use]
    pub fn new(helpers: &VulcanusHelpers) -> Self {
        // `vulcanus_cracks_scale` is a noise-EXPRESSION, not a Lua number, so
        // every `k * vulcanus_cracks_scale` below is an f32 multiply inside the
        // noise machine (#293). 0.325 has no exact f32 form, so holding it and
        // narrowing each product is what takes `hairline_cracks` from 2 of 61 to
        // 61 of 61 with worst residual exactly 0.
        let cs = VULCANUS_CRACKS_SCALE as f32;
        let scaled = |k: f64| f64::from((k as f32) * cs);
        Self {
            hairline: helpers.plasma(15_223, scaled(0.3), scaled(0.6), 0.6, 1.0),
            crack_a1: helpers.plasma(7_543, scaled(2.5), scaled(4.0), 0.5, 1.0),
            crack_a2: helpers.plasma(7_443, scaled(1.5), scaled(3.5), 0.5, 1.0),
            crack_a_mix: helpers.detail_noise(241, scaled(2.0), 2.0, 0.25),
            crack_b1: helpers.plasma(12_223, scaled(2.0), scaled(3.0), 0.5, 1.0),
            crack_b2: helpers.plasma(152, scaled(1.0), scaled(1.5), 0.25, 0.5),
            crack_b_mix: helpers.detail_noise(821, scaled(6.0), 2.0, 0.5),
            path_plasma: helpers.plasma(1_543, scaled(1.5), scaled(3.0), 0.5, 1.0),
            path_detail: helpers.detail_noise(121, scaled(4.0), 2.0, 0.5),
        }
    }

    /// Evaluate every field of this layer at one position.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> CrackFields {
        self.eval_at(At::point(x, y))
    }

    /// [`Self::eval`] at an [`At`] (#451).
    #[must_use]
    pub fn eval_at(&self, at: At) -> CrackFields {
        let hairline_cracks = self.hairline.eval_at(at);

        // `lerp` toward 1, so a high mix value floods the cracks shut. Every
        // step is an f32 operation in the game, so the lerp is `lerp_f32` and
        // each literal is narrowed first (#521).
        let flood_cracks_a = lerp_f32(
            min2(self.crack_a1.eval_at(at), self.crack_a2.eval_at(at)),
            1.0,
            clamp(f64::from(self.crack_a_mix.eval_at(at)), 0.0, 1.0),
        );

        // The other way round: `lerp` FROM 1 toward the crack pattern, and the
        // `- 0.5` applies to the min rather than to the lerp's result.
        let flood_cracks_b = lerp_f32(
            1.0,
            f32r(min2(self.crack_b1.eval_at(at), self.crack_b2.eval_at(at)) - 0.5),
            clamp(
                f32r(f32r(0.2) + f64::from(self.crack_b_mix.eval_at(at))),
                0.0,
                1.0,
            ),
        );

        // `min(0, detail)` only ever subtracts, so the detail term deepens the
        // paths and never fills them. `0.4 - plasma` rounds before the detail
        // term is added.
        let flood_paths = f32r(
            f32r(f32r(0.4) - self.path_plasma.eval_at(at))
                + min2(0.0, f64::from(self.path_detail.eval_at(at))),
        );

        let flood_basalts_func = f32r(
            min2(
                max2(f32r(flood_cracks_a - 0.125), flood_paths),
                flood_cracks_b,
            ) + f32r(f32r(0.3) * min2(0.5, hairline_cracks)),
        );

        CrackFields {
            hairline_cracks,
            flood_cracks_a,
            flood_cracks_b,
            flood_paths,
            flood_basalts_func: poison::f64_result(flood_basalts_func),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::ctx::EvalCtx;

    fn layer() -> (VulcanusHelpers, VulcanusCracks) {
        let helpers = VulcanusHelpers::new(&EvalCtx::new(123_456));
        let cracks = VulcanusCracks::new(&helpers);
        (helpers, cracks)
    }

    fn grid() -> impl Iterator<Item = (f64, f64)> {
        (0..80).map(|k| (f64::from(k) * 11.5 - 400.0, f64::from(k) * -6.25 + 150.0))
    }

    /// The scale constant is 0.325 and every call multiplies it rather than
    /// replacing it. Pinned because it is a bare literal in the Lua with no
    /// name to check it against.
    #[test]
    fn the_cracks_scale_is_the_literal_the_lua_carries() {
        assert_eq!(VULCANUS_CRACKS_SCALE, 0.325);
    }

    /// `flood_paths`'s detail term is `min(0, d)`, so it can only subtract.
    /// Writing `max` there would brighten the paths and still look plausible.
    #[test]
    fn the_flood_path_detail_term_never_adds() {
        let (helpers, cracks) = layer();
        // Rebuild the two terms with the SAME f32 scale chain the layer uses
        // (#293). Reconstructing them in f64 samples a different point, which
        // is what this test caught when the chain changed.
        let cs = VULCANUS_CRACKS_SCALE as f32;
        let scaled = |k: f64| f64::from((k as f32) * cs);
        let detail = helpers.detail_noise(121, scaled(4.0), 2.0, 0.5);
        let plasma = helpers.plasma(1_543, scaled(1.5), scaled(3.0), 0.5, 1.0);
        let mut saw_negative_detail = 0usize;
        for (x, y) in grid() {
            let d = f64::from(detail.eval(x, y));
            let got = cracks.eval(x, y).flood_paths;
            // f32 arithmetic (#521), so the slack is f32 rounding.
            assert!(got <= 0.4 - plasma.eval(x, y) + 1e-6);
            if d < 0.0 {
                saw_negative_detail += 1;
            }
        }
        // Non-vacuity: the clamp is actually reached, so the assertion above is
        // not holding for want of a negative sample.
        assert!(
            saw_negative_detail > 10,
            "only {saw_negative_detail} of 80 samples had a negative detail term"
        );
    }

    /// `flood_cracks_a` lerps TOWARD 1 and `flood_cracks_b` lerps FROM it. The
    /// two are easy to transcribe the same way round, and the fixture would
    /// catch it - but not say why.
    ///
    /// The audit (2026-11-26) changed this: it used to count how often
    /// `flood_cracks_a > flood_cracks_b`, a bound that holds with the lerps
    /// either way round. It now rebuilds the crack and mix terms with the
    /// layer's own scale chain and checks the product's two fields against
    /// them. Where a mix clamp is saturated the direction shows without any
    /// formula (to a lerp's f32 rounding): `a` is the crack pattern at mix 0 and 1 at mix 1, `b` is 1 at
    /// mix 0 and the pattern at mix 1.
    #[test]
    fn the_two_flood_cracks_lerp_in_opposite_directions() {
        let (helpers, cracks) = layer();
        let cs = VULCANUS_CRACKS_SCALE as f32;
        let scaled = |k: f64| f64::from((k as f32) * cs);
        let a1 = helpers.plasma(7_543, scaled(2.5), scaled(4.0), 0.5, 1.0);
        let a2 = helpers.plasma(7_443, scaled(1.5), scaled(3.5), 0.5, 1.0);
        let a_mix = helpers.detail_noise(241, scaled(2.0), 2.0, 0.25);
        let b1 = helpers.plasma(12_223, scaled(2.0), scaled(3.0), 0.5, 1.0);
        let b2 = helpers.plasma(152, scaled(1.0), scaled(1.5), 0.25, 0.5);
        let b_mix = helpers.detail_noise(821, scaled(6.0), 2.0, 0.5);

        let (mut a_open, mut a_shut, mut b_shut, mut b_open) = (0usize, 0, 0, 0);
        for k in 0..1200 {
            let (x, y) = (f64::from(k) * 11.5 - 400.0, f64::from(k) * -6.25 + 150.0);
            let f = cracks.eval(x, y);
            let pattern_a = min2(a1.eval(x, y), a2.eval(x, y));
            let t_a = clamp(f64::from(a_mix.eval(x, y)), 0.0, 1.0);
            assert_eq!(
                f.flood_cracks_a,
                lerp_f32(pattern_a, 1.0, t_a),
                "flood_cracks_a at ({x}, {y})"
            );
            if t_a == 0.0 {
                assert!(
                    (f.flood_cracks_a - pattern_a).abs() < 1e-6,
                    "mix 0 leaves the pattern"
                );
                a_open += 1;
            }
            if t_a == 1.0 {
                assert!(
                    (f.flood_cracks_a - 1.0).abs() < 1e-6,
                    "mix 1 floods it shut"
                );
                a_shut += 1;
            }

            let pattern_b = f32r(min2(b1.eval(x, y), b2.eval(x, y)) - 0.5);
            let t_b = clamp(f32r(f32r(0.2) + f64::from(b_mix.eval(x, y))), 0.0, 1.0);
            assert_eq!(
                f.flood_cracks_b,
                lerp_f32(1.0, pattern_b, t_b),
                "flood_cracks_b at ({x}, {y})"
            );
            if t_b == 0.0 {
                assert!(
                    (f.flood_cracks_b - 1.0).abs() < 1e-6,
                    "mix 0 leaves it flooded"
                );
                b_shut += 1;
            }
            if t_b == 1.0 {
                assert!(
                    (f.flood_cracks_b - pattern_b).abs() < 1e-6,
                    "mix 1 shows the pattern"
                );
                b_open += 1;
            }
        }
        // Non-vacuity. `a`'s mix never reaches 1 on this path, so only its 0
        // end is required; that end alone tells the two directions apart,
        // because the pattern is not 1 there.
        assert!(
            a_open > 0 && b_shut > 0 && b_open > 0,
            "clamp ends reached: a {a_open}/{a_shut}, b {b_shut}/{b_open}"
        );
    }

    /// `flood_basalts_func`'s hairline term is capped at `0.3 * 0.5`, which is
    /// what keeps the hairline pattern a texture rather than a feature.
    #[test]
    fn the_hairline_contribution_is_capped() {
        let (_, cracks) = layer();
        for (x, y) in grid() {
            let f = cracks.eval(x, y);
            let base = min2(
                max2(f.flood_cracks_a - 0.125, f.flood_paths),
                f.flood_cracks_b,
            );
            assert!(f.flood_basalts_func - base <= 0.3 * 0.5 + 1e-6);
        }
    }
}
