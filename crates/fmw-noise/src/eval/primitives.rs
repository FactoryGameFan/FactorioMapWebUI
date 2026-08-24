//! `basis_noise` in expression form, ported from
//! `src/noise/eval/primitives.ts`.
//!
//! The raw [`basis_noise`](crate::basis_noise::basis_noise) takes noise-space
//! coordinates and has no output scale. The game's DSL writes
//! `basis_noise{input_scale, output_scale, offset_x}`, which maps world
//! `(x, y)` through `((x + offset_x) * input_scale, y * input_scale)` and
//! multiplies the result by `output_scale`. This adapter is that mapping and
//! nothing else.

use crate::basis_noise::{basis_noise, BasisNoiseTables};

/// The DSL's `basis_noise{...}` parameters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BasisExprParams {
    /// Map seed (basis seed word).
    pub seed0: u32,
    /// Per-call seed selector, e.g. 123 for `finish_elevation`'s basis term.
    pub seed1: u32,
    /// Noise units per world tile.
    pub input_scale: f64,
    /// Overall output multiplier.
    pub output_scale: f64,
    /// World-space x translation applied BEFORE `input_scale`.
    pub offset_x: f64,
}

/// Evaluate `basis_noise{...}` at world `(x, y)`.
///
/// The tables are passed in rather than derived per call, which is what the
/// TypeScript's optional `tables` argument is for when sweeping a grid.
///
/// **The coordinate arithmetic does NOT stay in f64, and this comment used to
/// say it did.** It read "narrowing it here would evaluate a DIFFERENT point,
/// matching the TypeScript exactly" - which #290 made false when it narrowed
/// `x` below, and which nobody noticed because no fixture can tell the two
/// apart. That stale sentence is part of why the divergence in the next
/// paragraph survived three shipped PRs.
///
/// **The TypeScript has NOT been narrowed to match, and that is issue #309.**
/// It computes `f32((x + offset_x) * input_scale)` - the product formed in f64
/// and narrowed once - where this narrows `x` first and multiplies two f32s.
/// The two agree at every f32-exact coordinate and differ everywhere else, and
/// every position the game evaluates is on its own 1/256 MapPosition grid,
/// which is f32-exact. So no fixture can grade it: both forms score
/// `hairline_cracks` 61 of 61 with worst residual exactly 0. Vulcanus tier 2
/// found it off-grid, where 32 of its 74 folded fields disagree, and pins it.
///
/// ## The output scale is narrowed twice, and both are needed (#269)
///
/// The game evaluates this as `f32(f32(output_scale) * basis)`. That is BOTH
/// cases of the two-case rule at one call site, which is why neither half alone
/// reaches the game:
///
/// - **The CONSTANT.** `output_scale` is a program literal the engine holds at
///   f32. The f64 `0.6` is 0.59999999999999997780 and no amount of rounding the
///   product recovers the difference.
/// - **The PRODUCT.** `basis_noise` returns an f32 and the multiply is its own
///   f32 operation, so its result is f32 before anything downstream reads it.
///
/// Graded against the game at 196 positions and five output scales in
/// `test/basisOutputScale.spec.ts`. Exact equality, never a bound (#162):
///
/// ```text
/// f32(f32(output_scale) * basis)   196/196 at all five scales   <- the game
/// f32(output_scale * basis)        196, 110, 151, 196, 196      <- #269's proposal
/// output_scale * basis             196,  28,   6,  96,   1      <- what shipped
/// f32(output_scale) * basis        196,   0,   0,   0,   1
/// ```
///
/// **A power-of-two `output_scale` is immune** and cannot grade this: multiplying
/// an f32 by one is a pure exponent shift, so the product can never leave the
/// f32 grid. That is why the older `oracle-basis` fixture, captured at
/// `output_scale = 1`, could not answer the question and a new capture had to.
///
/// An earlier revision of this comment argued at length that NOT narrowing was
/// deliberate, because no fixture could grade the difference and a unilateral
/// change here would read as a port bug against the TypeScript. That reasoning
/// was sound and it is now spent: #287 captured the discriminating fixture, the
/// TypeScript changed in the same commit as this, and the two ports still agree.
///
/// The `input_scale` product is deliberately NOT narrowed. It decides which
/// point gets sampled rather than what the product rounds to. Whether the game
/// holds `input_scale` at f32 too is a separate, unmeasured question on #269.
#[must_use]
pub fn basis_noise_expr(
    x: f64,
    y: f64,
    params: &BasisExprParams,
    tables: &BasisNoiseTables,
) -> f64 {
    // The input scale is held at f32 and each coordinate product is narrowed,
    // because the noise machine evaluates them as f32 operations (#290).
    // Graded against the game's own leaves at 61 positions, near field and far,
    // with worst residual exactly 0.
    let input_scale = params.input_scale as f32;
    let v = basis_noise(
        f64::from(((x + params.offset_x) as f32) * input_scale),
        f64::from((y as f32) * input_scale),
        tables,
    );
    // f32 * f32 in one operation IS `f32(f32(os) * basis)`: the exact product of
    // two f32s fits in an f64 mantissa, so there is no double rounding to dodge
    // and this matches `Math.fround(Math.fround(os) * basis)` bit for bit.
    f64::from((params.output_scale as f32) * v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::basis_noise::tables_from_seed;

    fn params() -> BasisExprParams {
        BasisExprParams {
            seed0: 123_456,
            seed1: 123,
            input_scale: 1.0 / 32.0,
            output_scale: 1.0,
            offset_x: 0.0,
        }
    }

    /// With a neutral scale and no offset the adapter is the raw kernel, so a
    /// mistake in the mapping cannot hide behind the kernel's own agreement.
    #[test]
    fn a_neutral_adapter_is_the_raw_kernel() {
        let tables = tables_from_seed(123_456, 123);
        let mut p = params();
        p.input_scale = 1.0;
        for (x, y) in [(3.25, -7.5), (0.5, 0.5), (-100.125, 40.75)] {
            assert_eq!(
                basis_noise_expr(x, y, &p, &tables),
                f64::from(basis_noise(x, y, &tables))
            );
        }
    }

    /// `offset_x` is applied BEFORE `input_scale`, and `input_scale` reaches
    /// both axes. Both are directional, so an inverted one shows here.
    #[test]
    fn the_offset_is_applied_before_the_input_scale() {
        let tables = tables_from_seed(123_456, 123);
        let mut p = params();
        p.offset_x = 10.0;
        let got = basis_noise_expr(4.0, -6.0, &p, &tables);
        let want = f64::from(basis_noise((4.0 + 10.0) / 32.0, -6.0 / 32.0, &tables));
        assert_eq!(got, want);
        // The wrong order - scaling first, then offsetting - lands elsewhere.
        let wrong = f64::from(basis_noise(4.0 / 32.0 + 10.0, -6.0 / 32.0, &tables));
        assert_ne!(got, wrong);
    }

    /// `output_scale` is narrowed to f32 and so is the product: the game
    /// evaluates `f32(f32(output_scale) * basis)` (#269).
    ///
    /// The scans are what make this test say something. A hand-picked point
    /// proves nothing here - at (3.25, -7.5) with a scale of 0.1 the f64 product
    /// happens to land exactly on an f32, so it cannot tell the readings apart.
    /// That was found by an assertion failing, not by reading the code, which is
    /// why both halves scan and then assert they FOUND discriminating points.
    #[test]
    fn the_output_scale_and_the_product_are_both_narrowed() {
        let tables = tables_from_seed(123_456, 123);
        let mut p = params();

        // Half one: an f32-exact scale, so only the PRODUCT narrowing can show.
        p.output_scale = 7.5;
        let raw = basis_noise(3.25 / 32.0, -7.5 / 32.0, &tables);
        assert_eq!(
            basis_noise_expr(3.25, -7.5, &p, &tables),
            f64::from(7.5_f32 * raw)
        );

        // Half two: a scale that is NOT f32-exact, so the CONSTANT narrowing
        // shows too. `vs_unnarrowed` counts points that separate the shipped
        // model from this one; `vs_product_only` counts points that separate
        // narrowing the product ALONE from narrowing the constant as well -
        // which is the half #269 itself does not say.
        p.output_scale = 1.0 / 3.0;
        let mut vs_unnarrowed = 0usize;
        let mut vs_product_only = 0usize;
        for k in 0..64 {
            let (x, y) = (f64::from(k) * 3.25 - 40.0, f64::from(k) * -1.75 + 11.0);
            let basis = basis_noise((x + p.offset_x) * p.input_scale, y * p.input_scale, &tables);
            let want = f64::from((p.output_scale as f32) * basis);
            assert_eq!(basis_noise_expr(x, y, &p, &tables), want);

            let unnarrowed = p.output_scale * f64::from(basis);
            if want != unnarrowed {
                vs_unnarrowed += 1;
            }
            if want != f64::from((p.output_scale * f64::from(basis)) as f32) {
                vs_product_only += 1;
            }
        }
        assert!(
            vs_unnarrowed > 32,
            "only {vs_unnarrowed} of 64 points separate this from the un-narrowed              f64 product, so the assertions above mostly hold for either reading"
        );
        assert!(
            vs_product_only > 0,
            "no point separates narrowing the product alone from also holding              output_scale at f32, so this scan cannot see the second half of #269"
        );
    }

    /// A power-of-two `output_scale` cannot grade any of this: multiplying an
    /// f32 by one is a pure exponent shift, so every candidate model coincides.
    /// This is why the older `oracle-basis` fixture, captured at
    /// `output_scale = 1`, could not answer #269.
    #[test]
    fn a_power_of_two_output_scale_is_blind_to_the_narrowing() {
        let tables = tables_from_seed(123_456, 123);
        let mut p = params();
        for os in [1.0, 0.5, 0.25, 2.0, 4.0, 64.0] {
            p.output_scale = os;
            for k in 0..64 {
                let (x, y) = (f64::from(k) * 3.25 - 40.0, f64::from(k) * -1.75 + 11.0);
                let basis =
                    basis_noise((x + p.offset_x) * p.input_scale, y * p.input_scale, &tables);
                // The un-narrowed product and the fully narrowed one are the
                // same number here, so the adapter matches both at once.
                assert_eq!(basis_noise_expr(x, y, &p, &tables), os * f64::from(basis));
            }
        }
    }
}
