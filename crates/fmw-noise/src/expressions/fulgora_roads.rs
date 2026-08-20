//! Fulgora's road and structure layer, ported from
//! `src/noise/expressions/fulgoraRoads.ts`.
//!
//! Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
//! lines 403-512.
//!
//! The shape: two more Voronoi tilings on top of the island tiling, one at a
//! third of the island grid for the main roads and one at an eighth for
//! individual structure blocks. `road_cells` gives each road block an id that
//! picks WHICH of three small-road patterns fills it, and the paving stages
//! composite the patterns, then cut structure blocks and district centres back
//! out.
//!
//! ## Two things here are easy to get wrong by reading, and they need OPPOSITE
//! fixes
//!
//! 1. **`structure_cells` and `structure_facets` sample at `y * 0.8f32`**, not
//!    at `y`, and the CONSTANT carries the narrowing. The engine's `0.8` is the
//!    f32 0.80000001192092895508; an f64 `0.8` is 0.80000000000000004441, and
//!    those are different numbers. Measured over the 101-position fixture:
//!    `y * 0.8` in f64 misses by 7.629e-6, narrowing the PRODUCT still misses by
//!    7.629e-6 - no help at all - and narrowing the constant reaches **exactly
//!    0**. In Rust that is literal typing rather than a call, which is the one
//!    thing about the two-case rule that changes shape in the port.
//! 2. **`structure_subnoise` reads `x + f32(10000 * structure_cells)`, and the
//!    MULTIPLY is its own f32 operation.** Narrowing only where the sum reaches
//!    the noise call is a coarser rounding than the game performs, and at this
//!    field's coordinate magnitudes (up to ~17460, where one f32 ULP is
//!    2.08e-3) the two disagree by a lot: 3.910e-5 that way against 2.980e-7
//!    with the product narrowed - **131x**.
//!
//! These are the port's worked examples of the same rule needing opposite
//! fixes. `crates/fmw-noise/src/eval/mod.rs` carries the general form.

use crate::eval::math::lerp;
use crate::expressions::fulgora_cells::CellFields;
use crate::expressions::fulgora_shared::{FulgoraCtx, SharedFields};
use crate::multioctave_noise::MultioctaveParams;
use crate::multioctave_noise::Prepared;
use crate::voronoi_noise::{Voronoi, VoronoiDistanceType, VoronoiParams};

/// `seed1` values, computed with CRC32 over the UTF-8 bytes of the name in the
/// Lua, never guessed.
///
/// Note `structure_facets` uses the string `fulgora_structure_cells` - it is the
/// SAME field read through a different op, exactly as `pyramids` shares `cells`'
/// seed in `fulgora_cells`.
const SEED1_ROAD_CELLS: u32 = 2_103_387_040; // crc32("fulgora_road_cells")        = 0x7D5F23A0
const SEED1_STRUCTURE_CELLS: u32 = 2_736_009_210; // crc32("fulgora_structure_cells")   = 0xA3142FFA
const SEED1_STRUCTURE_SUBNOISE: u32 = 1_886_976_824; // crc32("fulgora_structure_subnoise") = 0x7078FB38

/// `fulgora_road_jitter` and `fulgora_structure_jitter` - named constants.
const ROAD_JITTER: f64 = 1.0;
const STRUCTURE_JITTER: f64 = 0.8;

/// A comparison yields 1 or 0, matching the engine's boolean-to-number
/// convention.
fn gt(a: f64, b: f64) -> f64 {
    f64::from(u8::from(a > b))
}
fn lt(a: f64, b: f64) -> f64 {
    f64::from(u8::from(a < b))
}

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RoadFields {
    pub road_cells: f64,
    pub road_pyramids: f64,
    pub pyramids_banding: f64,
    pub spots_prebanding: f64,
    pub spots_banding: f64,
    pub structure_cells: f64,
    pub structure_subnoise: f64,
    pub structure_facets: f64,
    pub road_paving_thin: f64,
    pub road_paving_2: f64,
    pub road_paving_2b: f64,
    pub road_paving_2c: f64,
    pub road_dust: f64,
}

/// The road layer's two Voronoi fields and its subnoise.
pub struct FulgoraRoads {
    /// `road_cells` and `road_pyramids` are one field read through two ops, so
    /// they share an instance and therefore one point cache.
    road: Voronoi,
    /// `structure_cells` and `structure_facets`, likewise - and both sampled at
    /// the stretched `y`.
    structure: Voronoi,
    subnoise: Prepared,
}

impl FulgoraRoads {
    #[must_use]
    pub fn new(ctx: &FulgoraCtx, grid: f64) -> Self {
        Self {
            road: Voronoi::new(&VoronoiParams {
                seed0: ctx.seed0,
                seed1: SEED1_ROAD_CELLS,
                grid_size: grid / 3.0,
                jitter: ROAD_JITTER,
                distance_type: VoronoiDistanceType::Chebyshev,
                search_range_override: None,
            }),
            structure: Voronoi::new(&VoronoiParams {
                seed0: ctx.seed0,
                seed1: SEED1_STRUCTURE_CELLS,
                grid_size: grid / 8.0,
                jitter: STRUCTURE_JITTER,
                distance_type: VoronoiDistanceType::Minkowski3,
                search_range_override: None,
            }),
            subnoise: Prepared::new(&MultioctaveParams {
                seed0: ctx.seed0,
                seed1: SEED1_STRUCTURE_SUBNOISE,
                octaves: 3.0,
                persistence: 0.7,
                input_scale: 1.0 / 12.0,
                output_scale: 1.0,
            }),
        }
    }

    /// Evaluate every field of this layer at one position.
    pub fn eval(
        &mut self,
        x: f64,
        y: f64,
        shared: &SharedFields,
        cells: &CellFields,
    ) -> RoadFields {
        let road_cells = f64::from(self.road.cell_id(x, y));
        let road_pyramids = f64::from(self.road.pyramid_noise(x, y));

        // `y * 0.8f32`, NOT `(y * 0.8f64) as f32`. See the module docs - the
        // second form is measured at no help whatsoever.
        let stretched_y = y * f64::from(0.8f32);
        let structure_cells = f64::from(self.structure.cell_id(x, stretched_y));
        let structure_facets = f64::from(self.structure.facet_noise(x, stretched_y));

        // The multiply is its own f32 operation. Narrowing only the sum is
        // 131x worse - again, see the module docs.
        let subnoise_x = x + f64::from((10_000.0 * structure_cells) as f32);
        let structure_subnoise = f64::from(self.subnoise.eval(subnoise_x, y));

        // `%` is a truncated remainder in both languages and both take the sign
        // of the dividend, so this needs no adjustment.
        let pyramids_banding = (cells.pyramids * 8.0) % 1.0;
        let spots_prebanding =
            cells.spots.min((1.0 - shared.starting_vault_cone) / 2.0) * 9.0 + 0.5;
        let spots_banding = spots_prebanding % 1.0;

        let road_paving_thin =
            (lt(road_pyramids, 0.03) * 0.9).max(lt(structure_facets, 0.06) * 0.5);

        let road_paving_2 = crate::eval::math::max(&[
            lt(road_pyramids, 0.05) * 0.9,
            lt(pyramids_banding, 0.1) * 0.85 * lt(road_cells, 0.6) * gt(road_cells, 0.25),
            lt(spots_banding, 0.1) * 0.85 * lt(road_cells, 0.25),
            lt(structure_facets, 0.1) * 0.85 * gt(road_cells, 0.6),
        ]);

        let road_paving_2b = lerp(
            road_paving_2,
            lt(structure_facets, 0.2) * 0.9,
            gt(structure_cells, 0.8),
        );
        let road_paving_2c = lerp(
            road_paving_2b,
            gt(spots_prebanding, 1.0) * 0.9,
            lt(spots_prebanding, 1.3),
        );
        let road_dust = lt(road_pyramids, 0.08) * 0.9 - road_paving_2c;

        RoadFields {
            road_cells,
            road_pyramids,
            pyramids_banding,
            spots_prebanding,
            spots_banding,
            structure_cells,
            structure_subnoise,
            structure_facets,
            road_paving_thin,
            road_paving_2,
            road_paving_2b,
            road_paving_2c,
            road_dust,
        }
    }
}

#[cfg(test)]
mod tests {

    /// The stretch is on `y` only, and it is the CONSTANT that is narrowed.
    /// `y * 0.8f32` and `(y * 0.8f64) as f32` are different numbers, which is
    /// the whole finding - so this pins that they are, rather than trusting the
    /// comment.
    #[test]
    fn the_y_stretch_narrows_the_constant_not_the_product() {
        let mut differing = 0;
        for k in 1..500 {
            let y = f64::from(k) * 13.25 - 2000.0;
            let constant_first = y * f64::from(0.8f32);
            let product_first = f64::from((y * 0.8f64) as f32);
            if constant_first != product_first {
                differing += 1;
            }
        }
        assert!(
            differing > 400,
            "only {differing} of 499 points tell the two forms apart, so the \
             distinction this module rests on is not observable here"
        );
    }

    /// `%` is a TRUNCATED remainder and keeps the dividend's sign in both Rust
    /// and JavaScript, so the banding fields need no adjustment in the port.
    ///
    /// The values are read out of a loop rather than written as literals, or
    /// the compiler folds them and clippy is right that the assertion proves
    /// nothing.
    #[test]
    fn the_banding_fields_are_a_truncated_remainder() {
        let mut negatives = 0;
        let mut in_unit_interval = 0;
        for k in -50..=50i32 {
            let pyramids = f64::from(k) / 100.0;
            let band = (pyramids * 8.0) % 1.0;
            if pyramids < 0.0 && band < 0.0 {
                negatives += 1;
            }
            if pyramids >= 0.0 && (0.0..1.0).contains(&band) {
                in_unit_interval += 1;
            }
        }
        // A floored remainder would put every negative input in [0, 1) instead.
        assert!(negatives > 30, "only {negatives} negatives kept their sign");
        assert!(
            in_unit_interval > 45,
            "only {in_unit_interval} stayed in [0,1)"
        );
    }
}
