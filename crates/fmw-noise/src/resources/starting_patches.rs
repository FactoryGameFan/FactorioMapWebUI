//! The `starting_patches` branch of `resource_autoplace_all_patches` - the
//! near-spawn ore patches - ported from
//! `src/noise/resources/startingPatches.ts`.
//!
//! ```text
//! starting_patches = spotField + (blobs0 - 1/4) * startingBlobAmplitude
//! spotField        = max(basement_value, max over nearby spots of (peak - dist*slope))
//! blobs0           = basis_noise{1/8,1} + basis_noise{1/24,1}
//! ```
//!
//! A close sibling of [`super::regular_patches`] over the same primitives, plus
//! the map's `elevation` property for the favorability coupling.
//!
//! ## Six differences from the regular set, every one oracle-verified
//!
//! An earlier TypeScript draft had several of them wrong, which is why they are
//! listed rather than left to be read out of the code:
//!
//! 1. `region_size` 450 (= radius * 3), `candidate_spot_count` 32,
//!    `spacing` 48, and `hard_region_target_quantity` TRUE - the last kept
//!    spot's cone shrinks self-similarly to hit the budget exactly.
//! 2. The candidate stream keys on **`seed1 + 1`**, a distinct stream from the
//!    regular set, while the blob noise still uses the **bare `seed1`**.
//! 3. Spot quantity is the CONSTANT `starting_area_spot_quantity`; favorability
//!    is deterministic, with no `random_penalty` term.
//! 4. The cone radius base uses that constant quantity and then `cone_scale`.
//!    Using the spot's own quantity would double-apply the shrink to the last
//!    kept spot.
//! 5. No `min(32, ...)` cap on the radius, and `max_basement_radius` is a HARD
//!    cull rather than a safe over-cull - the starting cone (radius ~10.5) is
//!    still above basement at the ~29.5-tile cutoff, so the cutoff produces a
//!    real discontinuous drop to basement. That is the game's behaviour.
//! 6. The blob has no `basis_noise{1/64, 1.5}` octave and subtracts `1/4`, not
//!    `1/3`.
//!
//! ## The lake mask reads `elevation_nauvis`, not `elevation_lakes`
//!
//! `starting_resources_lake_mask = clamp((elevation - 1)/10, 0, 1)` couples to
//! the map's `elevation` PROPERTY, which on the default Nauvis map is
//! `elevation_nauvis`. An earlier draft read the literal `elevation_lakes`;
//! the game oracle refutes it - the `has_starting = 1` fixture keeps
//! `elevation_nauvis`'s favorability picks. A non-default map type would feed
//! its own elevation here; that generalisation is deferred with the TypeScript's.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::basis_noise::{basis_noise, tables_from_seed, BasisNoiseTables};
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::PI;
use crate::expressions::elevation_nauvis::{ElevationNauvis, ElevationNauvisParams};
use crate::fast_approx::fast_cbrt;
use crate::spot_candidates::SpotRegionKey;
use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};

use super::nauvis_catalog::ResourceParams;
use super::resource_math::{
    basement_value, starting_area_spot_quantity, starting_blob_amplitude, starting_density_at,
    starting_favorability_base_at, ResourceControlLevers, ResourceControls,
};

/// `suggested_minimum_candidate_point_spacing` for the starting set.
///
/// 48 since 2.1.9; it was 32 through 2.0.77.
const STARTING_SPACING: f64 = 48.0;
/// `region_size = starting_resource_placement_radius * 3`.
///
/// The `* 3` is a 2.1.9 change too - it was `* 2`, so 240.
const STARTING_REGION_SIZE: u64 = 450;
const STARTING_CANDIDATE_SPOT_COUNT: usize = 32;

/// Region index for a coordinate. Regions are centred on multiples of the size.
fn region_index(c: f64) -> i64 {
    ((c + STARTING_REGION_SIZE as f64 / 2.0) / STARTING_REGION_SIZE as f64).floor() as i64
}

/// Everything one `starting_patches` field needs.
#[derive(Clone, Debug)]
pub struct StartingPatchesCtx {
    pub seed0: u32,
    pub controls: ResourceControlLevers,
    /// Spawn points for `distance`.
    pub starting_positions: Vec<Point>,
    /// `control:water:frequency`, for the elevation the lake mask reads.
    pub segmentation_multiplier: f64,
    /// `10 * log2(control:water:size)`.
    pub water_level: f64,
    /// Lake points. `None` derives the game's real positions.
    pub starting_lake_positions: Option<Vec<Point>>,
    /// `starting_patch_set_count` (`skip_span`). 1 for the isolated oracle; 4
    /// in the app.
    pub skip_span: usize,
    /// `starting_patch_set_index` (`skip_offset`).
    pub skip_offset: usize,
}

impl StartingPatchesCtx {
    /// One resource at the game's default controls, spawning at the origin,
    /// with the set unpartitioned - the isolated-oracle configuration.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            controls: ResourceControlLevers::defaults(),
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            segmentation_multiplier: 1.0,
            water_level: 0.0,
            starting_lake_positions: None,
            skip_span: 1,
            skip_offset: 0,
        }
    }
}

/// The compiled `starting_patches` field for one resource at one seed.
pub struct StartingPatches {
    params: ResourceParams,
    controls: ResourceControls,
    spawn: Vec<Point>,
    /// The heaviest construction in the layer, and the reason a
    /// `StartingPatches` is expensive to build.
    elevation: ElevationNauvis,
    tables: BasisNoiseTables,
    basement: f64,
    skip_span: usize,
    skip_offset: usize,
    seed0: u32,
    /// `starting_area_spot_quantity` - a constant, the same for every spot.
    quantity: f64,
    /// `maximum_spot_basement_radius = 2 * rq * saq^(1/3)`. f64 and NOT
    /// narrowed: it is only a cull threshold.
    max_basement_radius: f64,
    /// `starting_rq_factor * saq^(1/3)`, narrowed.
    ///
    /// The TypeScript recomputes this inside the cone loop. It is a pure
    /// function of constants, so hoisting it is value-identical; it is hoisted
    /// here because the loop reads it once per spot and it is the same number
    /// every time. **The `cone_scale` multiply stays in the loop** - that part
    /// is per spot.
    cone_radius_base: f64,
    region_cache: RefCell<BTreeMap<(i64, i64), Vec<SelectedSpot>>>,
}

impl StartingPatches {
    #[must_use]
    pub fn new(params: &ResourceParams, ctx: &StartingPatchesCtx) -> Self {
        let controls = ctx.controls.controls();
        let quantity = starting_area_spot_quantity(params, &controls);
        Self {
            params: *params,
            controls,
            spawn: ctx.starting_positions.clone(),
            elevation: ElevationNauvis::new(&ElevationNauvisParams {
                seed0: ctx.seed0,
                water_level: ctx.water_level,
                segmentation_multiplier: ctx.segmentation_multiplier,
                starting_positions: ctx.starting_positions.clone(),
                starting_lake_positions: ctx.starting_lake_positions.clone(),
                with_cliff_elevation: true,
            }),
            // The bare `seed1`, NOT `seed1 + 1` - that offset is
            // candidate-stream only.
            tables: tables_from_seed(ctx.seed0, params.seed1),
            basement: basement_value(params, &controls),
            skip_span: ctx.skip_span,
            skip_offset: ctx.skip_offset,
            seed0: ctx.seed0,
            quantity,
            max_basement_radius: 2.0
                * params.starting_rq_factor
                * f64::from(fast_cbrt(quantity as f32)),
            cone_radius_base: f64::from(
                (params.starting_rq_factor * f64::from(fast_cbrt(quantity as f32))) as f32,
            ),
            region_cache: RefCell::new(BTreeMap::new()),
        }
    }

    fn distance_at(&self, x: f64, y: f64) -> f64 {
        f64::from(distance_from_nearest_point(
            x,
            y,
            &self.spawn,
            f64::INFINITY,
        ))
    }

    /// The selected spots of one region, computed once and cached.
    fn region_spots(&self, region_x: i64, region_y: i64) -> Vec<SelectedSpot> {
        if let Some(hit) = self.region_cache.borrow().get(&(region_x, region_y)) {
            return hit.clone();
        }
        let key = SpotRegionKey {
            seed0: self.seed0,
            // A distinct candidate stream from the regular set.
            seed1: self.params.seed1 + 1,
            region_x,
            region_y,
        };
        let density = |x: f64, y: f64| {
            starting_density_at(self.distance_at(x, y), &self.params, &self.controls)
        };
        let quantity = |_x: f64, _y: f64| self.quantity;
        let favorability = |x: f64, y: f64| {
            starting_favorability_base_at(
                self.distance_at(x, y),
                self.elevation.eval(x, y),
                &self.params,
                &self.controls,
            )
        };
        let spots = select_spots(
            &key,
            &SpotSelectParams {
                region_size: STARTING_REGION_SIZE,
                candidate_spot_count: STARTING_CANDIDATE_SPOT_COUNT,
                spacing: STARTING_SPACING,
                skip_span: self.skip_span,
                skip_offset: self.skip_offset,
                hard_region_target_quantity: true,
                density: &density,
                quantity: &quantity,
                favorability: &favorability,
                quantity_batch: None,
            },
        );
        self.region_cache
            .borrow_mut()
            .insert((region_x, region_y), spots.clone());
        spots
    }

    /// `max(basement_value, max over nearby spots of the cone)`.
    #[must_use]
    pub(crate) fn spot_field_at(&self, x: f64, y: f64) -> f64 {
        let mut best = self.basement;
        let r = self.max_basement_radius;
        for region_x in region_index(x - r)..=region_index(x + r) {
            for region_y in region_index(y - r)..=region_index(y + r) {
                for s in self.region_spots(region_x, region_y) {
                    let dx = x - s.x as f64;
                    let dy = y - s.y as f64;
                    let d2 = dx * dx + dy * dy;
                    // A HARD cull, not a scan bound - see the module header.
                    if d2 > r * r {
                        continue;
                    }
                    // No `min(32, ...)` cap here; the hard-target trim's
                    // `cone_scale` shrinks the last kept spot's radius and peak
                    // self-similarly. The radius base is the CONSTANT quantity,
                    // and `s.quantity` appears only in the peak - using it for
                    // the radius too would double-apply the shrink.
                    let radius = f64::from((self.cone_radius_base * s.cone_scale) as f32);
                    let numerator = f64::from((3.0 * s.quantity) as f32);
                    let area = f64::from((f64::from((PI * radius) as f32) * radius) as f32);
                    let peak = f64::from((numerator / area) as f32);
                    let slope = f64::from((peak / radius) as f32);
                    let cone = f64::from(
                        (peak - f64::from((f64::from(d2.sqrt() as f32) * slope) as f32)) as f32,
                    );
                    // NOT `max2`: the strict `>` keeps `basement` on a NaN or a
                    // tie.
                    if cone > best {
                        best = cone;
                    }
                }
            }
        }
        best
    }

    /// `(blobs0 - 1/4) * starting_blob_amplitude`.
    ///
    /// No `basis_noise{1/64, 1.5}` octave, and `1/4` rather than `1/3` - both
    /// regular-set-only.
    #[must_use]
    pub(crate) fn blob_term_at(&self, x: f64, y: f64) -> f64 {
        let blobs0 = f64::from(basis_noise(x / 8.0, y / 8.0, &self.tables))
            + f64::from(basis_noise(x / 24.0, y / 24.0, &self.tables));
        (blobs0 - 1.0 / 4.0) * starting_blob_amplitude(&self.params, &self.controls)
    }

    /// The raw `starting_patches` field value.
    ///
    /// There is no `probability` or `richness` here, deliberately: the starting
    /// field is only ever read through the outer `max` in
    /// [`super::resource_patches`], which owns both wrappers.
    #[must_use]
    pub fn field(&self, x: f64, y: f64) -> f64 {
        self.spot_field_at(x, y) + self.blob_term_at(x, y)
    }

    /// The constant floor this field is built over. Test-only, as on
    /// [`super::regular_patches::RegularPatches`].
    #[cfg(test)]
    #[must_use]
    pub(crate) fn basement(&self) -> f64 {
        self.basement
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::nauvis_catalog::resource_by_name;

    fn iron() -> &'static ResourceParams {
        resource_by_name("iron-ore").expect("iron is in the catalog")
    }

    fn built(seed0: u32) -> StartingPatches {
        StartingPatches::new(iron(), &StartingPatchesCtx::defaults(seed0))
    }

    #[test]
    fn the_region_grid_is_450_and_not_the_regular_sets_1024() {
        // A region size wrong by a factor of two still produces spots, just the
        // wrong ones, and nothing about the output announces the cause.
        assert_eq!(STARTING_REGION_SIZE, 450);
        assert_eq!(region_index(0.0), 0);
        assert_eq!(region_index(224.0), 0);
        assert_eq!(region_index(225.0), 1);
        assert_eq!(region_index(-225.0), 0);
        assert_eq!(region_index(-226.0), -1);
    }

    #[test]
    fn the_candidate_stream_and_the_blob_noise_use_different_seeds() {
        // `seed1 + 1` for the candidates, bare `seed1` for the blob. Pinned
        // because the two are one character apart and swapping either produces
        // a perfectly plausible field.
        let p = built(123_456);
        assert_eq!(p.tables, tables_from_seed(123_456, iron().seed1));
        assert_ne!(p.tables, tables_from_seed(123_456, iron().seed1 + 1));
    }

    #[test]
    fn the_cull_radius_is_hard_and_the_cone_is_still_above_basement_at_it() {
        // The difference from the regular set that produces a real
        // discontinuity rather than a safe over-cull. If the cone had already
        // fallen below basement by the cutoff this would be an over-cull too,
        // and widening it would be free - it is not.
        let p = built(123_456);
        let radius = p.cone_radius_base;
        let at_cull = {
            let numerator = f64::from((3.0 * p.quantity) as f32);
            let area = f64::from((f64::from((PI * radius) as f32) * radius) as f32);
            let peak = f64::from((numerator / area) as f32);
            let slope = f64::from((peak / radius) as f32);
            peak - p.max_basement_radius * slope
        };
        assert!(
            at_cull > p.basement(),
            "cone {at_cull} is already below basement {} at the cull",
            p.basement()
        );
        // And the cull really is about 2.8x the cone radius, so the drop is
        // from a small positive value rather than from the peak.
        assert!(p.max_basement_radius > radius * 2.0);
    }

    #[test]
    fn the_cone_radius_base_uses_the_constant_quantity_and_not_a_spots_own() {
        // The documented double-shrink trap. Every spot but the last has
        // `cone_scale == 1` and `quantity == the constant`, so the two forms
        // agree everywhere EXCEPT on the trimmed spot - which is why reading
        // it off `s.quantity` looks right until a patch edge is measured.
        let p = built(123_456);
        assert_eq!(
            p.cone_radius_base,
            f64::from((iron().starting_rq_factor * f64::from(fast_cbrt(p.quantity as f32))) as f32)
        );
        // Every selected spot near spawn turns out to be the TRIMMED one - the
        // regional target is small enough that the first kept spot already
        // overshoots it - which is exactly the case where the two forms differ,
        // and exactly why reading the radius off `s.quantity` looks right until
        // a patch edge is measured.
        let mut scaled = 0;
        let mut full = 0;
        for rx in -1..=1 {
            for ry in -1..=1 {
                for s in p.region_spots(rx, ry) {
                    if s.cone_scale == 1.0 {
                        full += 1;
                        assert_eq!(s.quantity, p.quantity, "an untrimmed spot's quantity");
                    } else {
                        scaled += 1;
                        assert!(s.quantity < p.quantity, "a trimmed spot is smaller");
                        // The trap itself: the shrink is already in
                        // `cone_scale`, so applying `s.quantity` to the radius
                        // too would apply it twice.
                        let correct = f64::from((p.cone_radius_base * s.cone_scale) as f32);
                        let double_shrunk = f64::from(
                            (f64::from(
                                (iron().starting_rq_factor
                                    * f64::from(fast_cbrt(s.quantity as f32)))
                                    as f32,
                            ) * s.cone_scale) as f32,
                        );
                        assert_ne!(
                            correct, double_shrunk,
                            "the double shrink is invisible here"
                        );
                    }
                }
            }
        }
        assert!(
            scaled > 0,
            "the hard-target trim never fired, so this test is vacuous"
        );
        // Not asserted to be non-zero: near spawn there are none, and that is
        // the measurement rather than a gap. Recorded so a later change that
        // starts producing full spots is noticed.
        assert_eq!(full, 0, "no untrimmed spot within one region of spawn");
    }

    #[test]
    fn the_blob_has_no_third_octave_and_subtracts_a_quarter() {
        // Both regular-set-only differences, in one assertion against a
        // hand-rebuilt term. A third octave here would raise every starting
        // patch by a few hundred units.
        let p = built(123_456);
        let (x, y) = (77.5, -122.25);
        let blobs0 = f64::from(basis_noise(x / 8.0, y / 8.0, &p.tables))
            + f64::from(basis_noise(x / 24.0, y / 24.0, &p.tables));
        assert_eq!(
            p.blob_term_at(x, y),
            (blobs0 - 0.25) * starting_blob_amplitude(iron(), &p.controls)
        );
        // And the octave the regular set has really would move it.
        assert_ne!(basis_noise(x / 64.0, y / 64.0, &p.tables), 0.0);
    }

    #[test]
    fn the_field_is_the_spot_field_plus_the_blob_term() {
        let p = built(123_456);
        for &(x, y) in &[(0.5, 0.25), (60.5, 60.25), (-140.5, 88.75)] {
            assert_eq!(p.field(x, y), p.spot_field_at(x, y) + p.blob_term_at(x, y));
        }
    }

    #[test]
    fn spots_land_near_spawn_and_avoid_the_crash_site() {
        // The favorability's `origin_excluder` in action, end to end rather
        // than as arithmetic: no selected spot centre sits within 40 tiles of
        // spawn, and the set is not empty.
        let p = built(123_456);
        let mut n = 0;
        for rx in -1..=1 {
            for ry in -1..=1 {
                for s in p.region_spots(rx, ry) {
                    n += 1;
                    let d = ((s.x * s.x + s.y * s.y) as f64).sqrt();
                    assert!(d > 40.0, "spot at ({}, {}) is {d} from spawn", s.x, s.y);
                }
            }
        }
        assert!(n > 0, "no spots selected at all");
    }

    #[test]
    fn the_elevation_the_lake_mask_reads_is_elevation_nauvis() {
        // `elevation_lakes` is the wrong tree and an earlier TypeScript draft
        // used it. The two disagree at almost every point, so a swap would be a
        // different set of favourite spots - and nothing else would look wrong.
        use crate::expressions::elevation_lakes::{ElevationLakes, ElevationLakesParams};
        let p = built(123_456);
        let lakes = ElevationLakes::new(&ElevationLakesParams {
            seed0: 123_456,
            water_level: 0.0,
            segmentation_multiplier: 1.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            starting_lake_positions: None,
            bias: 20.0,
        });
        let differs = (0..40).any(|i| {
            let x = f64::from(i) * 11.5 - 200.0;
            p.elevation.eval(x, 60.25) != lakes.eval(x, 60.25)
        });
        assert!(differs, "the two elevation trees agree, so this is vacuous");
    }

    #[test]
    fn the_region_cache_does_not_change_any_value() {
        let cold = built(123_456);
        let warm = built(123_456);
        for i in 0..30 {
            let _ = warm.field(f64::from(i) * 17.5 - 250.0, 40.25);
        }
        for i in 0..30 {
            let x = f64::from(i) * 17.5 - 250.0;
            assert_eq!(cold.field(x, 40.25), warm.field(x, 40.25), "at x = {x}");
        }
    }
}
