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

use crate::eval::math::{f32r, lerp_f32, max2, min2};
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

        // Every step below is one f32 operation, in the Lua's order, literals
        // narrowed before they meet a value (#521). Comparisons read the f32
        // literal too: `road_cells < 0.6` tests against f32(0.6), which is
        // 2.4e-8 above the f64 `0.6`.
        //
        // `%` is a truncated remainder in both languages and both take the sign
        // of the dividend, so this needs no adjustment. It is exact in f32, so
        // only the operand needs rounding.
        let pyramids_banding = f32r(cells.pyramids * 8.0) % 1.0;
        let spots_prebanding = f32r(
            f32r(
                min2(
                    cells.spots,
                    f32r(f32r(1.0 - shared.starting_vault_cone) / 2.0),
                ) * 9.0,
            ) + 0.5,
        );
        let spots_banding = spots_prebanding % 1.0;

        let thin_road = lt(road_pyramids, f32r(0.03)) * f32r(0.9);
        let thin_facets = lt(structure_facets, f32r(0.06)) * 0.5;
        let road_paving_thin = max2(thin_road, thin_facets);

        // `a * 0.85 * b * c` is left to right, one f32 operation each. The
        // comparison results are 0 or 1, so every product after the first is
        // exact and only `0.85` needs narrowing.
        let road_paving_2 = crate::eval::math::max(&[
            lt(road_pyramids, f32r(0.05)) * f32r(0.9),
            lt(pyramids_banding, f32r(0.1))
                * f32r(0.85)
                * lt(road_cells, f32r(0.6))
                * gt(road_cells, 0.25),
            lt(spots_banding, f32r(0.1)) * f32r(0.85) * lt(road_cells, 0.25),
            lt(structure_facets, f32r(0.1)) * f32r(0.85) * gt(road_cells, f32r(0.6)),
        ]);

        let road_paving_2b = lerp_f32(
            road_paving_2,
            lt(structure_facets, f32r(0.2)) * f32r(0.9),
            gt(structure_cells, f32r(0.8)),
        );
        let road_paving_2c = lerp_f32(
            road_paving_2b,
            gt(spots_prebanding, 1.0) * f32r(0.9),
            lt(spots_prebanding, f32r(1.3)),
        );
        let road_dust = f32r(lt(road_pyramids, f32r(0.08)) * f32r(0.9) - road_paving_2c);

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
    use super::*;

    const GRID: f64 = 48.0;

    fn roads() -> FulgoraRoads {
        FulgoraRoads::new(&FulgoraCtx::new(123_456), GRID)
    }

    fn eval_at(r: &mut FulgoraRoads, x: f64, y: f64) -> RoadFields {
        r.eval(x, y, &SharedFields::default(), &CellFields::default())
    }

    /// The stretch is on `y` only, and it is the CONSTANT that is narrowed.
    /// `y * 0.8f32` and `(y * 0.8f64) as f32` are different numbers, which is
    /// the whole finding.
    ///
    /// The audit (2026-11-26) changed this: it used to compare the two forms of
    /// the formula against each other inside the test and never ran the roads
    /// code. It now runs `FulgoraRoads::eval` and compares its structure
    /// fields, bit for bit, with a second `Voronoi` sampled at the
    /// constant-first `y`. It also counts the points where the product-first
    /// form would give a different `structure_facets`, so the comparison
    /// cannot pass vacuously.
    #[test]
    fn the_y_stretch_narrows_the_constant_not_the_product() {
        let mut r = roads();
        let mut reference = Voronoi::new(&VoronoiParams {
            seed0: 123_456,
            seed1: SEED1_STRUCTURE_CELLS,
            grid_size: GRID / 8.0,
            jitter: STRUCTURE_JITTER,
            distance_type: VoronoiDistanceType::Minkowski3,
            search_range_override: None,
        });
        let mut distinguishable = 0;
        for k in 1..500 {
            let x = f64::from(k) * 7.5 - 1700.0;
            let y = f64::from(k) * 13.25 - 2000.0;
            let constant_first = y * f64::from(0.8f32);
            let product_first = f64::from((y * 0.8f64) as f32);
            let got = eval_at(&mut r, x, y);
            let want_facets = f64::from(reference.facet_noise(x, constant_first));
            let want_cells = f64::from(reference.cell_id(x, constant_first));
            assert_eq!(
                got.structure_facets.to_bits(),
                want_facets.to_bits(),
                "structure_facets at ({x}, {y}) is not sampled at y * f32(0.8)"
            );
            assert_eq!(got.structure_cells.to_bits(), want_cells.to_bits());
            if f64::from(reference.facet_noise(x, product_first)).to_bits() != want_facets.to_bits()
            {
                distinguishable += 1;
            }
        }
        assert!(
            distinguishable > 50,
            "only {distinguishable} of 499 points tell the two forms apart, so \
             the distinction this module rests on is not observable here"
        );
    }

    /// `%` is a TRUNCATED remainder and keeps the dividend's sign in both Rust
    /// and JavaScript, so the banding fields need no adjustment in the port.
    ///
    /// The audit (2026-11-26) changed this: it used to apply `%` to its own
    /// inputs and never ran the roads code. It now takes `pyramids_banding` and
    /// `spots_banding` from `FulgoraRoads::eval`, which sees `cells.pyramids`
    /// and `starting_vault_cone` as inputs, so negative dividends are fed in
    /// directly. A floored remainder would put those results in [0, 1).
    #[test]
    fn the_banding_fields_are_a_truncated_remainder() {
        let mut r = roads();
        let mut negative_pyramids = 0;
        let mut negative_spots = 0;
        for k in -50..=50i32 {
            let value = f64::from(k) / 100.0;
            let cells = CellFields {
                pyramids: value,
                // `spots * 9 + 0.5` goes below zero once `spots < -1/18`.
                spots: value * 0.4,
                ..CellFields::default()
            };
            let shared = SharedFields {
                starting_vault_cone: 0.0,
                ..SharedFields::default()
            };
            let got = r.eval(10.0, 20.0, &shared, &cells);
            let band = f64::from((value * 8.0) as f32) % 1.0;
            assert_eq!(got.pyramids_banding, band, "pyramids {value}");
            if value < 0.0 {
                assert!(got.pyramids_banding <= 0.0, "kept no sign at {value}");
                if got.pyramids_banding < 0.0 {
                    negative_pyramids += 1;
                }
            } else {
                assert!((0.0..1.0).contains(&got.pyramids_banding));
            }
            assert_eq!(got.spots_banding, got.spots_prebanding % 1.0);
            if got.spots_prebanding < 0.0 && got.spots_banding < 0.0 {
                negative_spots += 1;
            }
        }
        assert!(
            negative_pyramids > 30,
            "only {negative_pyramids} negatives kept their sign"
        );
        assert!(
            negative_spots > 10,
            "only {negative_spots} negative spots inputs kept their sign"
        );
    }
}
