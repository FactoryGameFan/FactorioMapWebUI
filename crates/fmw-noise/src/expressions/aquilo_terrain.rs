//! Aquilo's terrain fields: the wobbles, `aquilo_aux`, the three tile-variety
//! fields, `aquilo_island_peaks` and `aquilo_elevation`.
//!
//! Transcribed from `space-age/prototypes/planet/planet-aquilo-map-gen.lua` at
//! 2.1.23 (the tier-1 fixtures read bit-identical on 2.0.77). There is no
//! TypeScript counterpart: Aquilo is ported Rust-first.
//!
//! `aquilo_temperature` and `moisture_basic` are not ported. No Aquilo tile,
//! well or iceberg reads them.
//!
//! ## The shape of the elevation
//!
//! Two formations are mixed. `formation_clumped` is the island peaks (spawn,
//! starting cones and spot fields, or a random multioctave, whichever is
//! higher) cut by `tri_crack`, the minimum of three billowed noises.
//! `formation_broken` is the same peaks pushed down, plus a Voronoi crack
//! pattern: the large cells (grid 24) where their cell id is above 1/6, and
//! the small cells (grid 10) where `aux` is above -0.1. The result is
//! `lerp(lerp(clumped, broken, 0.4), max(clumped, broken), 0.4)`.
//!
//! ## Every constant is an f32 slot, and every op narrows
//!
//! The noise machine holds each constant in f32 and rounds each op to f32. Two
//! of the constants decide counts on their own: the wobbles' `output_scale`
//! `0.35` (as a double, the wobbles score 144 and 99 of 632) and the lerp
//! weight `0.4` (as a double, the elevation drops to 601 of 632). Constant
//! expressions fold one op at a time in f32 too: `segmentation_mult / 1.5` is
//! `f32(f32(1 / 25) / 1.5)`, and folding `1 / 25 / 1.5` in f64 first drops the
//! elevation to 187 of 632.
//!
//! ## `random_island_peaks` is the game's form of the amplitude-corrected op
//!
//! The shipped `amplitude_corrected_multioctave_noise` is 81 of 152 against the
//! game (#254), and here it scores 608, 434 and 602 of the elevation (default,
//! size 0, moved) and 911 of 1,024. This layer uses
//! [`AmplitudeCorrectedGame`], which closes both. See its docs.
//!
//! ## Which kernel each field reaches
//!
//! The plain multioctave fields, the billows and `random_island_peaks` read the
//! raw coordinates, so they follow the [`At`] they are given: the chunk-grid
//! kernel on a tile (#451). `aquilo_aux` and the three Voronoi fields read a
//! WARPED coordinate, so they are always points, as in the game. The tier-1
//! fixtures are all point captures, so they grade the point path only; the
//! grid path is graded by the render.

use crate::at::At;
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{lerp_f32, max, max2, min2};
use crate::expressions::aquilo_resources::AquiloResourceFields;
use crate::multioctave_noise::{MultioctaveParams, Prepared};
use crate::poison;
use crate::quick_multioctave_noise::{
    octave_terms, sum_octaves_at, QuickMultioctaveParams, QuickOctaves,
};
use crate::variable_persistence_multioctave_noise::{
    AmplitudeCorrectedGame, AmplitudeCorrectedParams,
};
use crate::voronoi_noise::{Voronoi, VoronoiDistanceType, VoronoiParams};

/// `seed1` of the three Voronoi fields.
const SEED1_CRACKS: u32 = 1_475_573_916; // crc32("aquilo-cracks") = 0x57F3789C

/// `aquilo_aux_scale = aquilo_segmentation_multiplier * 1.5`, with the
/// multiplier the constant 1.
const AUX_SCALE: f64 = 1.5;

/// Narrow to f32 and back, the noise machine's per-op rounding.
fn f32r(v: f64) -> f64 {
    f64::from(v as f32)
}

/// Every terrain expression this layer grades, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AquiloTerrainFields {
    pub wobble_x: f64,
    pub wobble_y: f64,
    pub aux: f64,
    pub island_peaks: f64,
    pub elevation: f64,
    pub high_frequency_peaks: f64,
    pub snow_ice: f64,
    pub tile_variant: f64,
}

/// The per-render state of the terrain fields: the multioctave tables, the
/// billow octaves and the two Voronoi fields with their caches.
///
/// `&mut` to evaluate, because the Voronoi caches live inside [`Voronoi`].
pub struct AquiloTerrain {
    wobble_x: Prepared,
    wobble_y: Prepared,
    aux: Prepared,
    high_frequency_peaks: Prepared,
    snow_ice: Prepared,
    tile_variant: Prepared,
    random_island_peaks: AmplitudeCorrectedGame,
    /// `aquilo_simple_billows` at seeds 2000, 3000 and 4000.
    billows: [QuickOctaves; 3],
    /// `voronoi_large` and `voronoi_large_cell` read the SAME field (seed,
    /// grid 24, euclidean, jitter 1) through two ops, so they share one
    /// instance and its one-entry search cache.
    voronoi_large: Voronoi,
    /// `voronoi_small`: grid 10, otherwise the same.
    voronoi_small: Voronoi,
}

impl AquiloTerrain {
    #[must_use]
    pub fn new(seed0: u32) -> Self {
        // `aquilo_wobble_x|y`: 3 octaves, persistence 0.65,
        // `aquilo_aux_scale / 100`, output scale 0.35.
        let wobble = |seed1| {
            Prepared::new(&MultioctaveParams {
                seed0,
                seed1,
                octaves: 3.0,
                persistence: f32r(0.65),
                input_scale: f32r(AUX_SCALE / 100.0),
                output_scale: f32r(0.35),
            })
        };
        // `aquilo_high_frequency_peaks`, `aquilo_snow_ice` and
        // `aquilo_tile_variant`: 3 octaves, persistence 0.85, output scale 1.
        let variety = |seed1, input_scale: f64| {
            Prepared::new(&MultioctaveParams {
                seed0,
                seed1,
                octaves: 3.0,
                persistence: f32r(0.85),
                input_scale: f32r(input_scale),
                output_scale: 1.0,
            })
        };
        // `segmentation_mult = aquilo_segmentation_multiplier / 25`.
        let segmentation_mult = f32r(1.0 / 25.0);
        // `aquilo_simple_billows`: `offset_x = 10000`, octave input scale
        // multiplier 0.5, persistence (output multiplier) 0.75.
        let billow = |seed1, input_scale| {
            octave_terms(&QuickMultioctaveParams {
                seed0,
                seed1,
                octaves: 3,
                input_scale,
                output_scale: 1.0,
                octave_output_scale_multiplier: 0.75,
                octave_input_scale_multiplier: 0.5,
                offset_x: 10000.0,
            })
        };
        let voronoi = |grid_size| {
            Voronoi::new(&VoronoiParams {
                seed0,
                seed1: SEED1_CRACKS,
                grid_size,
                jitter: 1.0,
                distance_type: VoronoiDistanceType::Euclidean,
                search_range_override: None,
            })
        };
        Self {
            wobble_x: wobble(12243),
            wobble_y: wobble(13243),
            aux: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 14243,
                octaves: 3.0,
                persistence: f32r(0.7),
                input_scale: f32r(AUX_SCALE / 25.0),
                output_scale: 1.0,
            }),
            high_frequency_peaks: variety(1, 1.0 / 6.0),
            snow_ice: variety(1, 1.0 / 12.0),
            tile_variant: variety(100, 1.0 / 6.0),
            random_island_peaks: AmplitudeCorrectedGame::new(&AmplitudeCorrectedParams {
                seed0,
                seed1: 1000,
                octaves: 6,
                input_scale: f32r(segmentation_mult / 1.2),
                offset_x: -10000.0,
                persistence: 0.8,
                amplitude: 1.0,
            }),
            billows: [
                billow(2000, f32r(segmentation_mult / 1.5)),
                billow(3000, f32r(segmentation_mult / 1.2)),
                billow(4000, segmentation_mult),
            ],
            voronoi_large: voronoi(24.0),
            voronoi_small: voronoi(10.0),
        }
    }

    /// Evaluate every field of this layer at one position, in dependency
    /// order. `r` is the resource layer at the same position:
    /// `aquilo_island_peaks` reads its starting cones and spot fields.
    pub fn eval_at(&mut self, at: At, r: &AquiloResourceFields) -> AquiloTerrainFields {
        let (x, y) = (at.x(), at.y());
        let wobble_x = f64::from(self.wobble_x.eval_at(at));
        let wobble_y = f64::from(self.wobble_y.eval_at(at));

        // `0.5 + multioctave_noise{x = x + aquilo_wobble_x * 300 /
        // aquilo_aux_scale, ...}`: the multiply, then the divide, then the add,
        // each in f32. Folding `300 / 1.5` to 200 first drops it to 525 of 632.
        // A warped coordinate, so always the point kernel.
        let warp = |v: f64, w: f64| f32r(v + f32r(f32r(w * 300.0) / AUX_SCALE));
        let aux_noise = self
            .aux
            .eval_at(At::point(warp(x, wobble_x), warp(y, wobble_y)));
        let aux = f32r(0.5 + f64::from(aux_noise));

        let high_frequency_peaks = f64::from(self.high_frequency_peaks.eval_at(at)).abs();
        let snow_ice = f64::from(self.snow_ice.eval_at(at));
        let tile_variant = f64::from(self.tile_variant.eval_at(at));

        // `aquilo_starting_island = 1 - distance * (multiplier / 100)`, at the
        // origin spawn.
        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &[Point { x: 0.0, y: 0.0 }],
            f64::INFINITY,
        ));
        let starting_island = f32r(1.0 - f32r(distance * f32r(1.0 / 100.0)));
        // `max(1.7 * (0.3 + starting_island), 1.5 * (0.5 + max(<six spots>)))`.
        // Far from every spot, the six are at the basement -1 (or below it,
        // for a starting cone) and the field sits at -0.75.
        let spots = max(&[
            r.starting_crude_oil,
            r.crude_oil_spots,
            r.starting_lithium_brine,
            r.lithium_brine_spots,
            r.starting_fluorine_vent,
            r.fluorine_vent_spots,
        ]);
        let island_peaks = max2(
            f32r(f32r(1.7) * f32r(f32r(0.3) + starting_island)),
            f32r(1.5 * f32r(0.5 + spots)),
        );

        let random_island_peaks = f64::from(self.random_island_peaks.eval_at(at)).abs();

        // The Voronoi fields read `x + aquilo_wobble_x * 2`. Warped, so points.
        let vx = f32r(x + f32r(wobble_x * 2.0));
        let vy = f32r(y + f32r(wobble_y * 2.0));
        let voronoi_large = f64::from(self.voronoi_large.facet_noise(vx, vy));
        let voronoi_large_cell = f64::from(self.voronoi_large.cell_id(vx, vy));
        let voronoi_small = f64::from(self.voronoi_small.facet_noise(vx, vy));

        // `min(billows 2000, billows 3000, billows 4000)`, each `abs(...)`.
        let billow = |terms: &QuickOctaves| f64::from(sum_octaves_at(at, terms)).abs();
        let tri_crack = min2(
            min2(billow(&self.billows[0]), billow(&self.billows[1])),
            billow(&self.billows[2]),
        );

        // `-25 + 12 * max(aquilo_island_peaks, random_island_peaks) + 15 * tri_crack`.
        let formation_clumped = f32r(
            f32r(-25.0 + f32r(12.0 * max2(island_peaks, random_island_peaks)))
                + f32r(15.0 * tri_crack),
        );

        // `pow(voronoi_large * max(0, voronoi_large_cell * 1.2 - 0.2)
        //      + 0.5 * voronoi_small * max(0, aux + 0.1), 0.5)`.
        // `pow(x, 0.5)` is an exact f32 square root of the f32 sum
        // (`oracle-native-ops.json`); taking the root of the unrounded sum
        // costs 12 of 632.
        let large =
            f32r(voronoi_large * max2(0.0, f32r(f32r(voronoi_large_cell * f32r(1.2)) - f32r(0.2))));
        let small = f32r(f32r(0.5 * voronoi_small) * max2(0.0, f32r(aux + f32r(0.1))));
        let cracks = f32r(f32r(large + small).sqrt());

        // `-20 + 8 * max(aquilo_island_peaks * 1.1, min(0., random_island_peaks - 0.2))
        //  + 13 * cracks`.
        let formation_broken = f32r(
            f32r(
                -20.0
                    + f32r(
                        8.0 * max2(
                            f32r(island_peaks * f32r(1.1)),
                            min2(0.0, f32r(random_island_peaks - f32r(0.2))),
                        ),
                    ),
            ) + f32r(13.0 * cracks),
        );

        // `lerp(blended, maxed, 0.4)` with `blended = lerp(clumped, broken,
        // 0.4)` and `maxed = max(clumped, broken)`. `lerp` is the noise
        // function `a + (b - a) * alpha`, and `0.4` is an f32 constant.
        let weight = f32r(0.4);
        let blended = lerp_f32(formation_clumped, formation_broken, weight);
        let maxed = max2(formation_clumped, formation_broken);
        let elevation = lerp_f32(blended, maxed, weight);

        AquiloTerrainFields {
            wobble_x,
            wobble_y,
            aux,
            island_peaks,
            elevation: poison::f64_result(elevation),
            high_frequency_peaks,
            snow_ice,
            tile_variant,
        }
    }
}
