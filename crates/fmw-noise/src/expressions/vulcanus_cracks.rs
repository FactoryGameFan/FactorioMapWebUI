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

use crate::eval::math::{clamp, lerp, max2, min2};
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
        let cs = VULCANUS_CRACKS_SCALE;
        Self {
            hairline: helpers.plasma(15_223, 0.3 * cs, 0.6 * cs, 0.6, 1.0),
            crack_a1: helpers.plasma(7_543, 2.5 * cs, 4.0 * cs, 0.5, 1.0),
            crack_a2: helpers.plasma(7_443, 1.5 * cs, 3.5 * cs, 0.5, 1.0),
            crack_a_mix: helpers.detail_noise(241, 2.0 * cs, 2.0, 0.25),
            crack_b1: helpers.plasma(12_223, 2.0 * cs, 3.0 * cs, 0.5, 1.0),
            crack_b2: helpers.plasma(152, 1.0 * cs, 1.5 * cs, 0.25, 0.5),
            crack_b_mix: helpers.detail_noise(821, 6.0 * cs, 2.0, 0.5),
            path_plasma: helpers.plasma(1_543, 1.5 * cs, 3.0 * cs, 0.5, 1.0),
            path_detail: helpers.detail_noise(121, cs * 4.0, 2.0, 0.5),
        }
    }

    /// Evaluate every field of this layer at one position.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> CrackFields {
        let hairline_cracks = self.hairline.eval(x, y);

        // `lerp` toward 1, so a high mix value floods the cracks shut. The
        // un-narrowed `lerp`, matching the TypeScript - this layer is not one
        // of the per-operation narrowed ones.
        let flood_cracks_a = lerp(
            min2(self.crack_a1.eval(x, y), self.crack_a2.eval(x, y)),
            1.0,
            clamp(f64::from(self.crack_a_mix.eval(x, y)), 0.0, 1.0),
        );

        // The other way round: `lerp` FROM 1 toward the crack pattern, and the
        // `- 0.5` applies to the min rather than to the lerp's result.
        let flood_cracks_b = lerp(
            1.0,
            min2(self.crack_b1.eval(x, y), self.crack_b2.eval(x, y)) - 0.5,
            clamp(0.2 + f64::from(self.crack_b_mix.eval(x, y)), 0.0, 1.0),
        );

        // `min(0, detail)` only ever subtracts, so the detail term deepens the
        // paths and never fills them.
        let flood_paths =
            0.4 - self.path_plasma.eval(x, y) + min2(0.0, f64::from(self.path_detail.eval(x, y)));

        let flood_basalts_func = min2(max2(flood_cracks_a - 0.125, flood_paths), flood_cracks_b)
            + 0.3 * min2(0.5, hairline_cracks);

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
        let detail = helpers.detail_noise(121, VULCANUS_CRACKS_SCALE * 4.0, 2.0, 0.5);
        let plasma = helpers.plasma(
            1_543,
            1.5 * VULCANUS_CRACKS_SCALE,
            3.0 * VULCANUS_CRACKS_SCALE,
            0.5,
            1.0,
        );
        let mut saw_negative_detail = 0usize;
        for (x, y) in grid() {
            let d = f64::from(detail.eval(x, y));
            let got = cracks.eval(x, y).flood_paths;
            assert!(got <= 0.4 - plasma.eval(x, y) + 1e-12);
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
    #[test]
    fn the_two_flood_cracks_lerp_in_opposite_directions() {
        let (_, cracks) = layer();
        let mut a_above_b = 0usize;
        for (x, y) in grid() {
            let f = cracks.eval(x, y);
            if f.flood_cracks_a > f.flood_cracks_b {
                a_above_b += 1;
            }
        }
        // They are different fields with different seeds, so this is a shape
        // check rather than an identity: neither dominates everywhere.
        assert!(
            a_above_b > 0 && a_above_b < 80,
            "flood_cracks_a exceeds flood_cracks_b at {a_above_b} of 80 points"
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
            assert!(f.flood_basalts_func - base <= 0.3 * 0.5 + 1e-12);
        }
    }
}
