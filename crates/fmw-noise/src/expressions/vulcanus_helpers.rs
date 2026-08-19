//! Vulcanus's reusable helper closures, ported from
//! `src/noise/expressions/vulcanusHelpers.ts`.
//!
//! `vulcanus_detail_noise`, `vulcanus_plasma`, `vulcanus_threshold`,
//! `vulcanus_contrast`, `vulcanus_biome_noise`, the `vulcanus_scale_multiplier`
//! program constant, and the six `vulcanus_wobble_*` fields built from
//! `vulcanus_detail_noise`. Transcribed from
//! `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` (helper section,
//! lines ~48-94 and ~399-425).
//!
//! These are the building blocks the rest of the Vulcanus tree calls, so they
//! land first: climate, biomes, elevation and the resource stack all read them,
//! and a transcription error here would arrive blended into every one of those
//! rather than localised.
//!
//! ## The two seed constants are one digit apart, and confusing them is silent
//!
//! `vulcanus_detail_noise` offsets its `seed1` parameter by `+ 12243`.
//! `vulcanus_plasma`'s FIRST basis term has a hardcoded `seed1 = 12643` that
//! does NOT depend on the function's `seed` parameter at all - only the SECOND
//! term uses `13423 + seed`. The two constants differ by a transposed digit.
//!
//! Getting either wrong produces a perfectly plausible noise field rather than
//! a slightly wrong one, so no residual-size check would flag it. They are
//! written down here and pinned by their own tests rather than trusted.
//!
//! ## No memo, for the reason the Fulgora layer records
//!
//! The TypeScript wraps each wobble in `memoXY` because both the biome offsets
//! and the spawn distortion sums read them, and it builds a DAG of lazy
//! closures. This port hands out a [`Prepared`] per wobble and lets the caller
//! evaluate it once per point into a local, which is what the memo achieves,
//! bit-identically and with no cache. Every read is at the SAME `(x, y)`.

use crate::basis_noise::{tables_from_seed, BasisNoiseTables};
use crate::eval::ctx::EvalCtx;
use crate::eval::math::{clamp, slider_rescale};
use crate::eval::primitives::{basis_noise_expr, BasisExprParams};
use crate::multioctave_noise::{MultioctaveParams, Prepared};
use crate::poison;

/// `vulcanus_detail_noise` adds this to the `seed1` it is given.
const DETAIL_NOISE_SEED_OFFSET: u32 = 12_243;
/// `vulcanus_plasma`'s first basis term, hardcoded and independent of `seed`.
const PLASMA_SEED1_A: u32 = 12_643;
/// `vulcanus_plasma`'s second basis term adds this to `seed`.
const PLASMA_SEED1_B_BASE: u32 = 13_423;

/// `vulcanus_threshold(value, threshold) = (value - (1 - threshold)) * (1 / threshold)`.
///
/// Pure arithmetic with no noise and no seed dependency, so there is no oracle
/// risk and no fixture grades it directly. Written in f64 exactly as the
/// TypeScript writes it, including the reciprocal-then-multiply rather than a
/// divide, because those are not the same operation once a narrowing lands
/// between them and this expression feeds fields that are graded.
#[must_use]
pub fn threshold(value: f64, threshold: f64) -> f64 {
    (value - (1.0 - threshold)) * (1.0 / threshold)
}

/// `vulcanus_contrast(value, c) = clamp(value, c, 1) - c`.
///
/// Note the clamp's LOWER bound is `c` and the subtraction is of the same `c`,
/// so the result is zero below the knee rather than negative. A version that
/// clamped to `[0, 1]` and then subtracted would be a different function that
/// still looked plausible everywhere above the knee.
#[must_use]
pub fn contrast(value: f64, c: f64) -> f64 {
    clamp(value, c, 1.0) - c
}

/// `vulcanus_plasma(seed, scale, scale2, magnitude1, magnitude2)`, with both
/// basis terms' tables derived once.
///
/// `abs(A - B)` of two `basis_noise` calls at different scales and seeds. The
/// subtraction and the absolute value are f64, matching the TypeScript's
/// `Math.abs(a - b)` on two `basisNoiseExpr` results - and `basisNoiseExpr`
/// itself returns an un-narrowed f64 product, which is #269. This port carries
/// the same approximation deliberately; see
/// [`basis_noise_expr`](crate::eval::primitives::basis_noise_expr).
pub struct Plasma {
    a: BasisExprParams,
    b: BasisExprParams,
    tables_a: BasisNoiseTables,
    tables_b: BasisNoiseTables,
}

impl Plasma {
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f64 {
        let a = basis_noise_expr(x, y, &self.a, &self.tables_a);
        let b = basis_noise_expr(x, y, &self.b, &self.tables_b);
        poison::f64_result((a - b).abs())
    }
}

/// Vulcanus's shared helper layer, with every per-render table already derived.
pub struct VulcanusHelpers {
    seed0: u32,
    /// `vulcanus_scale_multiplier = slider_rescale(control:vulcanus_volcanism:frequency, 3)`.
    ///
    /// A program CONSTANT, not a field. Held as the f64 widening of the f32
    /// `slider_rescale` returns, because it is the numerator of
    /// `vulcanus_biome_noise`'s input scale and every biome field divides it.
    ///
    /// The neutral slider is `1`, giving exactly `1` here - confirmed against
    /// the oracle at the game's default preset, and NOT `0`.
    pub scale_multiplier: f64,
    wobble_x: Prepared,
    wobble_y: Prepared,
    wobble_large_x: Prepared,
    wobble_large_y: Prepared,
    wobble_huge_x: Prepared,
    wobble_huge_y: Prepared,
}

impl VulcanusHelpers {
    /// Build the layer for one evaluation context.
    #[must_use]
    pub fn new(ctx: &EvalCtx) -> Self {
        let seed0 = ctx.seed0;
        let scale_multiplier = f64::from(slider_rescale(ctx.vulcanus_volcanism_frequency, 3.0));
        let detail = |seed1: u32, scale: f64, octaves: f64, magnitude: f64| {
            Prepared::new(&detail_noise_params(
                seed0, seed1, scale, octaves, magnitude,
            ))
        };
        Self {
            seed0,
            scale_multiplier,
            // The six wobbles, verbatim from the Lua. Each pair differs ONLY in
            // its seed1 (`n` against `1000 + n`), so x and y are independent
            // noise at identical parameters.
            wobble_x: detail(10, 1.0 / 8.0, 2.0, 4.0),
            wobble_y: detail(1010, 1.0 / 8.0, 2.0, 4.0),
            wobble_large_x: detail(20, 1.0 / 2.0, 2.0, 50.0),
            wobble_large_y: detail(1020, 1.0 / 2.0, 2.0, 50.0),
            wobble_huge_x: detail(30, 2.0, 2.0, 800.0),
            wobble_huge_y: detail(1030, 2.0, 2.0, 800.0),
        }
    }

    /// `vulcanus_detail_noise(seed1, scale, octaves, magnitude)`.
    #[must_use]
    pub fn detail_noise(&self, seed1: u32, scale: f64, octaves: f64, magnitude: f64) -> Prepared {
        Prepared::new(&detail_noise_params(
            self.seed0, seed1, scale, octaves, magnitude,
        ))
    }

    /// `vulcanus_biome_noise(seed1, scale)`.
    ///
    /// The Lua gives this no `output_scale`, so it takes the native op's
    /// default of 1. Its `seed1` is used RAW - unlike
    /// [`detail_noise`](Self::detail_noise), there is no `+ 12243` here.
    #[must_use]
    pub fn biome_noise(&self, seed1: u32, scale: f64) -> Prepared {
        Prepared::new(&MultioctaveParams {
            seed0: self.seed0,
            seed1,
            octaves: 5.0,
            persistence: 0.65,
            input_scale: self.scale_multiplier / scale,
            output_scale: 1.0,
        })
    }

    /// `vulcanus_plasma(seed, scale, scale2, magnitude1, magnitude2)`.
    #[must_use]
    pub fn plasma(
        &self,
        seed: u32,
        scale: f64,
        scale2: f64,
        magnitude1: f64,
        magnitude2: f64,
    ) -> Plasma {
        Plasma {
            a: BasisExprParams {
                seed0: self.seed0,
                seed1: PLASMA_SEED1_A,
                input_scale: 1.0 / 50.0 / scale,
                output_scale: magnitude1,
                offset_x: 0.0,
            },
            b: BasisExprParams {
                seed0: self.seed0,
                seed1: PLASMA_SEED1_B_BASE + seed,
                input_scale: 1.0 / 50.0 / scale2,
                output_scale: magnitude2,
                offset_x: 0.0,
            },
            tables_a: tables_from_seed(self.seed0, PLASMA_SEED1_A),
            tables_b: tables_from_seed(self.seed0, PLASMA_SEED1_B_BASE + seed),
        }
    }

    /// `vulcanus_wobble_x`.
    #[must_use]
    pub fn wobble_x(&self, x: f64, y: f64) -> f64 {
        f64::from(self.wobble_x.eval(x, y))
    }
    /// `vulcanus_wobble_y`.
    #[must_use]
    pub fn wobble_y(&self, x: f64, y: f64) -> f64 {
        f64::from(self.wobble_y.eval(x, y))
    }
    /// `vulcanus_wobble_large_x`.
    #[must_use]
    pub fn wobble_large_x(&self, x: f64, y: f64) -> f64 {
        f64::from(self.wobble_large_x.eval(x, y))
    }
    /// `vulcanus_wobble_large_y`.
    #[must_use]
    pub fn wobble_large_y(&self, x: f64, y: f64) -> f64 {
        f64::from(self.wobble_large_y.eval(x, y))
    }
    /// `vulcanus_wobble_huge_x`.
    #[must_use]
    pub fn wobble_huge_x(&self, x: f64, y: f64) -> f64 {
        f64::from(self.wobble_huge_x.eval(x, y))
    }
    /// `vulcanus_wobble_huge_y`.
    #[must_use]
    pub fn wobble_huge_y(&self, x: f64, y: f64) -> f64 {
        f64::from(self.wobble_huge_y.eval(x, y))
    }
}

/// The `multioctave_noise{...}` parameters `vulcanus_detail_noise` expands to.
///
/// Free rather than a method so the `+ 12243` offset has exactly one home; both
/// [`VulcanusHelpers::new`] and [`VulcanusHelpers::detail_noise`] go through it.
fn detail_noise_params(
    seed0: u32,
    seed1: u32,
    scale: f64,
    octaves: f64,
    magnitude: f64,
) -> MultioctaveParams {
    MultioctaveParams {
        seed0,
        seed1: seed1 + DETAIL_NOISE_SEED_OFFSET,
        octaves,
        persistence: 0.6,
        input_scale: 1.0 / 50.0 / scale,
        output_scale: magnitude,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> EvalCtx {
        EvalCtx::new(123_456)
    }

    /// The neutral volcanism slider puts the multiplier at exactly 1, which is
    /// what the oracle fixture carries at every position. If the ctx neutral
    /// were 0 in slider space this would not be 1.
    #[test]
    fn the_default_scale_multiplier_is_exactly_one() {
        assert_eq!(VulcanusHelpers::new(&ctx()).scale_multiplier, 1.0);
    }

    /// The detail-noise offset is `+ 12243` and the plasma constants are
    /// `12643` and `13423 + seed`. Asserted against the numbers rather than
    /// left to the fixture, because a wrong seed is a DIFFERENT field rather
    /// than a slightly wrong one and no residual check would see it.
    #[test]
    fn the_seed_constants_are_the_ones_the_lua_writes() {
        let p = detail_noise_params(123_456, 10, 1.0 / 8.0, 2.0, 4.0);
        assert_eq!(p.seed1, 12_253);

        let plasma = VulcanusHelpers::new(&ctx()).plasma(102, 2.5, 10.0, 125.0, 625.0);
        assert_eq!(plasma.a.seed1, 12_643);
        assert_eq!(plasma.b.seed1, 13_525);
    }

    /// The plasma's FIRST term ignores `seed` entirely. A port that threaded
    /// `seed` into both terms would still produce plausible noise, so this is
    /// the assertion that pins it.
    #[test]
    fn only_the_second_plasma_term_depends_on_the_seed() {
        let h = VulcanusHelpers::new(&ctx());
        let one = h.plasma(102, 2.5, 10.0, 125.0, 625.0);
        let two = h.plasma(777, 2.5, 10.0, 125.0, 625.0);
        assert_eq!(one.a.seed1, two.a.seed1);
        assert_ne!(one.b.seed1, two.b.seed1);
    }

    /// `1/50/scale` is not `scale/50`, and the two agree only at `scale = 1`.
    /// The wobbles use 1/8, 1/2 and 2, where they do not.
    #[test]
    fn the_input_scale_is_the_reciprocal_of_fifty_times_scale() {
        let p = detail_noise_params(1, 0, 1.0 / 8.0, 2.0, 4.0);
        assert_eq!(p.input_scale, 1.0 / 50.0 / (1.0 / 8.0));
        assert_ne!(p.input_scale, (1.0 / 8.0) / 50.0);
    }

    /// `threshold` maps its own threshold to 0 and 1 to 1, which is the
    /// property every caller relies on.
    #[test]
    fn threshold_maps_the_knee_to_zero_and_one_to_one() {
        for t in [0.1, 0.25, 0.5, 0.9] {
            assert!(threshold(1.0 - t, t).abs() < 1e-12);
            assert!((threshold(1.0, t) - 1.0).abs() < 1e-12);
        }
    }

    /// `contrast` is zero at and below the knee and never negative, which a
    /// clamp to `[0, 1]` followed by `- c` would get wrong.
    #[test]
    fn contrast_is_zero_below_the_knee_and_never_negative() {
        let c = 0.3;
        assert_eq!(contrast(0.0, c), 0.0);
        assert_eq!(contrast(c, c), 0.0);
        assert_eq!(contrast(-5.0, c), 0.0);
        assert!((contrast(1.0, c) - 0.7).abs() < 1e-12);
        for k in 0..100 {
            assert!(contrast(f64::from(k) * 0.02 - 0.5, c) >= 0.0);
        }
    }

    /// The x and y members of each wobble pair are independent fields, not the
    /// same field read twice. A copy-paste that built both from one seed shows
    /// here.
    ///
    /// A count rather than "differs at every point": `basis_noise` returns
    /// exactly zero on integer lattice points, so two independent fields CAN
    /// agree, and an all-or-nothing assertion would be measuring the sample
    /// grid rather than the seeds.
    #[test]
    fn each_wobble_pair_is_two_different_fields() {
        let h = VulcanusHelpers::new(&ctx());
        let mut differ = 0usize;
        for k in 0..64 {
            let (x, y) = (f64::from(k) * 13.5 - 300.0, f64::from(k) * -7.25 + 90.0);
            differ += usize::from(h.wobble_x(x, y) != h.wobble_y(x, y));
            differ += usize::from(h.wobble_large_x(x, y) != h.wobble_large_y(x, y));
            differ += usize::from(h.wobble_huge_x(x, y) != h.wobble_huge_y(x, y));
        }
        assert!(differ > 180, "only {differ} of 192 wobble readings differ");
    }

    /// `biome_noise` uses its `seed1` RAW, where `detail_noise` offsets by
    /// 12243. Reading the same number into both would be an easy and silent
    /// mistake, so it is pinned.
    #[test]
    fn biome_noise_does_not_apply_the_detail_noise_seed_offset() {
        let h = VulcanusHelpers::new(&ctx());
        let biome = h.biome_noise(10, 1.0);
        let detail = h.detail_noise(10, 1.0, 5.0, 1.0);
        let mut differ = 0usize;
        for k in 1..33 {
            let (x, y) = (f64::from(k) * 5.5, f64::from(k) * -3.0);
            differ += usize::from(biome.eval(x, y) != detail.eval(x, y));
        }
        assert!(differ > 28, "only {differ} of 32 readings differ");
    }
}
