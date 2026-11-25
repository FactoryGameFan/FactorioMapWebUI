//! The native `multisample(expression, offset_x, offset_y)` builtin, ported
//! from `src/noise/eval/multisample.ts`.
//!
//! The rule is a plain integer coordinate shift, NOT a half-tile supersample:
//! `multisample(e, dx, dy)` at `(x, y)` equals `e` evaluated at
//! `(x + dx, y + dy)`. Recovered from the headless oracle
//! (`test/fixtures/oracle-multisample.seed123456.json`) and confirmed EXACT -
//! residual 0, not merely under the f32 floor - across a 15-offset sweep at 5
//! points on both axes, with no cross term between them. See
//! `docs/noise/vulcanus-multisample-NOTES.md`.
//!
//! ## The offsets are in the CONSUMING PROGRAM's grid units (#83, closed)
//!
//! The rule above is right **for a 1-tile noise program**, which is what
//! `LuaSurface.calculate_tile_properties` and the tile renderer use. The
//! builtin's own documentation says it evaluates "in a separate noise program
//! with a larger grid", and in the cliff generator, whose grid is the 4-tile
//! corner lattice, the offset is scaled by the grid step:
//!
//! | arm | cliff column | |
//! | --- | --- | --- |
//! | `x` | 70 | baseline |
//! | `multisample(x, 0, 0)` | 70 | identical to baseline |
//! | `multisample(x, 4, 0)` | **54** | shifted **16** tiles, not 4 |
//! | `multisample(x, 0, 4)` | 70 | null control holds |
//!
//! (`test/fixtures/oracle-multisample-grid.seed123456.json`.) A `dx` of 4 moves
//! the field by 4 x the 4-tile grid step.
//!
//! **This function stays the plain shift, and the grid is the CALLER's job.**
//! The consumer that runs in the cliff generator,
//! `vulcanus_elevation::VulcanusElevation`, passes the grid step as the offset
//! (`CLIFF_MULTISAMPLE_GRID = 4.0`, against `TILE_MULTISAMPLE_GRID = 1.0`), so
//! the shift lands 16 tiles away as the game does. A test in `fixtures.rs`
//! (`the_multisample_port_implements_the_one_tile_channel_only`) pins that this
//! function alone does not scale, so nothing can lean on it to.
//!
//! A 2.1.23 disassembly pass found the game's list branch adds the offset
//! unscaled, `(x, y) + (dx, dy)` in f32, and only the grid branch scales it.
//! That agrees with this function whenever the sum is exact in f32, which holds
//! for every integer or 1/256-grid coordinate below 32,768 tiles.
//!
//! `sample_at` stands in for the game's separate noise program - the caller's
//! inner-expression port, evaluated at the shifted point.

/// Evaluate `sample_at` at `(x + dx, y + dy)`.
///
/// Generic over the closure rather than taking a `&dyn Fn` so the shift
/// inlines away; there is no arithmetic here to get wrong beyond the two adds,
/// and those are f64 exactly as in the TypeScript.
#[must_use]
pub fn multisample<F>(sample_at: F, x: f64, y: f64, dx: f64, dy: f64) -> f64
where
    F: FnOnce(f64, f64) -> f64,
{
    // The poison hook acts on the value the gate compares, which for this op is
    // the inner expression's reading at the shifted point. See `poison.rs`.
    crate::poison::f64_result(sample_at(x + dx, y + dy))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Argument order, with an inner expression that is not the identity - an
    /// x/y swap survives an identity probe and dies here.
    #[test]
    fn passes_the_shifted_coordinates_in_the_right_order() {
        let inner = |x: f64, y: f64| 1000.0 * x + y;
        assert_eq!(
            multisample(inner, 100.125, -300.875, 2.0, -1.0),
            1000.0 * (100.125 + 2.0) + (-300.875 - 1.0)
        );
    }

    /// No cross term: `dx` alone never moves the sampled y, and the reverse.
    #[test]
    fn has_no_cross_term_between_the_axes() {
        let x_of = |x: f64, _y: f64| x;
        let y_of = |_x: f64, y: f64| y;
        assert_eq!(multisample(y_of, 0.5, 0.25, 2.0, 0.0), 0.25);
        assert_eq!(multisample(x_of, 0.5, 0.25, 0.0, 2.0), 0.5);
        // Sanity: the offset that SHOULD move the axis does move it, so the two
        // assertions above are comparing something.
        assert_eq!(multisample(x_of, 0.5, 0.25, 2.0, 0.0), 2.5);
    }
}
