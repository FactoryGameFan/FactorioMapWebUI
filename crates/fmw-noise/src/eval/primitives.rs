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
/// **The coordinate arithmetic stays in f64**, matching the TypeScript exactly:
/// JavaScript numbers are f64, so `(x + offsetX) * inputScale` is an f64 product
/// there, and narrowing it here would evaluate a DIFFERENT point. This is the
/// same reading `fixtures::score` records for the raw kernel.
///
/// ## It returns f64, and the missing narrowing is DELIBERATE (#269)
///
/// The game's noise machine evaluates `output_scale * basis_noise(...)` as one
/// f32 operation. The TypeScript does not narrow it - it returns the plain f64
/// product - and neither do any of its five callers: `nauvis_shared` writes
/// `0.65 + basisNoiseExpr(...)`, `elevation_lakes` writes
/// `basisNoiseExpr(...) + sld/4 - 4`, both in f64.
///
/// So this port returns f64 too. **Narrowing here would be a silent behaviour
/// change to five shipped expression files**, every one of them currently
/// passing its own oracle fixture, and this phase has no fixture that can grade
/// the difference. The two-case rule in [`super`] says isolate the term and
/// measure before fixing it; #269 tracks doing exactly that against those five
/// fixtures. Until then the port carries the same approximation the TypeScript
/// carries, on purpose, because tier 2 compares the two ports and a unilateral
/// "fix" here would read as a port bug.
#[must_use]
pub fn basis_noise_expr(
    x: f64,
    y: f64,
    params: &BasisExprParams,
    tables: &BasisNoiseTables,
) -> f64 {
    let v = basis_noise(
        (x + params.offset_x) * params.input_scale,
        y * params.input_scale,
        tables,
    );
    params.output_scale * f64::from(v)
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

    /// `output_scale` multiplies the RESULT, in f64, with NO narrowing - see
    /// the docblock and #269.
    ///
    /// The second half is what makes this test say something: it picks an
    /// output scale whose product is NOT f32-representable, so a port that
    /// narrowed would return a different number. Without it the assertion would
    /// hold for either reading.
    #[test]
    fn the_output_scale_multiplies_the_result_once() {
        let tables = tables_from_seed(123_456, 123);
        let mut p = params();
        p.output_scale = 7.5;
        let raw = basis_noise((3.25) / 32.0, (-7.5) / 32.0, &tables);
        assert_eq!(
            basis_noise_expr(3.25, -7.5, &p, &tables),
            7.5 * f64::from(raw)
        );

        // And the discriminating half. A single hand-picked point is not
        // enough: at (3.25, -7.5) with a scale of 0.1 the f64 product happens
        // to land exactly on an f32, so it cannot tell the two readings apart.
        // That was found by the assertion below failing, not by reading the
        // code, which is why this scans instead.
        p.output_scale = 1.0 / 3.0;
        let mut discriminating = 0usize;
        for k in 0..64 {
            let (x, y) = (f64::from(k) * 3.25 - 40.0, f64::from(k) * -1.75 + 11.0);
            let want = p.output_scale
                * f64::from(basis_noise(
                    (x + p.offset_x) * p.input_scale,
                    y * p.input_scale,
                    &tables,
                ));
            assert_eq!(basis_noise_expr(x, y, &p, &tables), want);
            if want != f64::from(want as f32) {
                discriminating += 1;
            }
        }
        assert!(
            discriminating > 32,
            "only {discriminating} of 64 points can tell the un-narrowed f64 \
             product from its f32 narrowing, so the assertions above mostly \
             hold for either reading"
        );
    }
}
