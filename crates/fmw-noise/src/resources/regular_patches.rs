//! The `regular_patches` branch of `resource_autoplace_all_patches` - the
//! whole-map ore patches - ported from `src/noise/resources/regularPatches.ts`.
//!
//! ```text
//! regular_patches = spotField + (blobs0 + basis_noise{1/64,1.5} - 1/3) * blobAmplitude(distance)
//! spotField       = max(basement_value, max over nearby spots of (peak - dist*slope))
//! blobs0          = basis_noise{1/8,1} + basis_noise{1/24,1}
//! ```
//!
//! ## The batched spot quantity, resolved against the oracle
//!
//! A spot's `regular_spot_quantity_expression` is
//! `random_penalty_between(min, max, 1) * quantityBase(distance)`.
//! `random_penalty` is a BATCH op, and the game evaluates that expression over
//! all skip-set accepted spots as ONE batch - in acceptance order, seeded from
//! the first spot, streamed - **before** the trim, not per spot. So a spot's
//! jitter depends on the whole spot list rather than only on itself. It is
//! supplied through [`SpotSelectParams::quantity_batch`]. See
//! `docs/noise/random-penalty-NOTES.md`, "Composition inside spot selection".
//!
//! ## Precision
//!
//! The game's `spot_noise` op renders the cone in the f32 noise machine, with
//! the radius cube root through its fastapprox `pow`. Matching that pins the
//! field to the game within ~0.7 units everywhere; an exact `cbrt` in f64 left
//! a ~3-unit / 4.8e-2-relative residual at cone edges.
//!
//! What is left of that ~0.7 is one term, and it is not in this file: it is the
//! `fast_cbrt` inside `basement_value` (#261). See
//! [`super::resource_math::basement_value`].

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::basis_noise::{basis_noise, tables_from_seed, BasisNoiseTables};
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{max2, min2, PI};
use crate::fast_approx::fast_cbrt;
use crate::random_penalty::{random_penalty_batch, RandomPenaltyParams, RandomPenaltyPosition};
use crate::spot_candidates::{SpotPoint, SpotRegionKey};
use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};

use super::nauvis_catalog::ResourceParams;
use super::resource_math::{
    basement_value, regular_blob_amplitude_at, regular_density_at, regular_spot_quantity_base_at,
    ResourceControlLevers, ResourceControls, DOUBLE_DENSITY_DISTANCE,
    REGULAR_PATCH_FADE_IN_DISTANCE,
};

/// `suggested_minimum_candidate_point_spacing` for the regular set.
///
/// This is `32 * sqrt(2)`, and it is hard-coded as the literal rather than
/// computed, because the TypeScript hard-codes it. `32.0 * f64::sqrt(2.0)` is
/// the same number today; writing the literal keeps the two ports transcribing
/// the same source rather than each computing it.
const REGULAR_SPACING: f64 = 45.254_833_995_939_045;
const REGION_SIZE: u64 = 1024;
/// `maximum_spot_basement_radius` - the per-query cone cull radius.
///
/// A SAFE OVER-CULL, unlike the starting set's. The cone radius caps at 32, so
/// a cone is far below basement well before 128 tiles. Measured: dropping this
/// to 120 changes not one of the 31,400 fixture values.
const MAX_SPOT_BASEMENT_RADIUS: f64 = 128.0;
/// `spot_radius_expression` cap: `min(32, rq * quantity^(1/3))`.
const MAX_SPOT_RADIUS: f64 = 32.0;

/// Region index for a coordinate. Regions are centred on multiples of the size.
fn region_index(c: f64) -> i64 {
    ((c + REGION_SIZE as f64 / 2.0) / REGION_SIZE as f64).floor() as i64
}

/// Everything one `regular_patches` field needs.
#[derive(Clone, Debug)]
pub struct RegularPatchesCtx {
    pub seed0: u32,
    /// `control:<x>:frequency`, `size`, `richness`.
    pub controls: ResourceControlLevers,
    /// Spawn points for `distance`.
    pub starting_positions: Vec<Point>,
    /// `regular_patch_set_count` (`skip_span`). 1 for the isolated oracle; 6 in
    /// the app.
    pub skip_span: usize,
    /// `regular_patch_set_index` (`skip_offset`).
    pub skip_offset: usize,
}

impl RegularPatchesCtx {
    /// One resource at the game's default controls, spawning at the origin,
    /// with the set unpartitioned - the isolated-oracle configuration.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            controls: ResourceControlLevers::defaults(),
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            skip_span: 1,
            skip_offset: 0,
        }
    }
}

/// The compiled `regular_patches` field for one resource at one seed.
pub struct RegularPatches {
    params: ResourceParams,
    controls: ResourceControls,
    levers: ResourceControlLevers,
    spawn: Vec<Point>,
    tables: BasisNoiseTables,
    basement: f64,
    skip_span: usize,
    skip_offset: usize,
    seed0: u32,
    /// `random_penalty`'s `source` operand: `random_spot_size_max`.
    penalty_source: f64,
    /// `random_penalty`'s `amplitude`: `max - min`.
    penalty_amplitude: f64,
    /// Selected spots per region.
    ///
    /// A real cache, not the memo the rest of the port drops: `spot_field_at`
    /// reads spots from up to nine neighbouring regions, which is cross-position
    /// state. `RefCell` so `field` can stay `&self` while the closures handed to
    /// `select_spots` borrow `self` immutably alongside; `BTreeMap` because a
    /// determinism-critical port should not carry a container whose iteration
    /// order is unspecified.
    region_cache: RefCell<BTreeMap<(i64, i64), Vec<SelectedSpot>>>,
}

impl RegularPatches {
    #[must_use]
    pub fn new(params: &ResourceParams, ctx: &RegularPatchesCtx) -> Self {
        let controls = ctx.controls.controls();
        Self {
            params: *params,
            controls,
            levers: ctx.controls,
            spawn: ctx.starting_positions.clone(),
            tables: tables_from_seed(ctx.seed0, params.seed1),
            basement: basement_value(params, &controls),
            skip_span: ctx.skip_span,
            skip_offset: ctx.skip_offset,
            seed0: ctx.seed0,
            penalty_source: params.random_spot_size_max,
            penalty_amplitude: params.random_spot_size_max - params.random_spot_size_min,
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

    /// `regular_spot_quantity_expression` over a whole skip set at once.
    ///
    /// Two SEPARATE narrowings, both required: the quantity base is narrowed,
    /// and so is its product with the jitter.
    fn spot_quantity_batch(&self, spots: &[SpotPoint]) -> Vec<f64> {
        let positions: Vec<RandomPenaltyPosition> = spots
            .iter()
            .map(|s| RandomPenaltyPosition {
                x: s.x as f64,
                y: s.y as f64,
            })
            .collect();
        let source = vec![self.penalty_source; spots.len()];
        let jitter = random_penalty_batch(
            &positions,
            &source,
            &RandomPenaltyParams {
                seed: 1.0,
                amplitude: self.penalty_amplitude,
            },
        );
        spots
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let base = f64::from(regular_spot_quantity_base_at(
                    self.distance_at(s.x as f64, s.y as f64),
                    &self.params,
                    &self.controls,
                ) as f32);
                f64::from((jitter[i] * base) as f32)
            })
            .collect()
    }

    /// The selected spots of one region, computed once and cached.
    fn region_spots(&self, region_x: i64, region_y: i64) -> Vec<SelectedSpot> {
        if let Some(hit) = self.region_cache.borrow().get(&(region_x, region_y)) {
            return hit.clone();
        }
        let key = SpotRegionKey {
            seed0: self.seed0,
            seed1: self.params.seed1,
            region_x,
            region_y,
        };
        let density = |x: f64, y: f64| {
            regular_density_at(self.distance_at(x, y), &self.params, &self.controls)
        };
        // Unused: `quantity_batch` overrides it.
        let quantity = |_x: f64, _y: f64| 0.0;
        let favorability = |_x: f64, _y: f64| 1.0;
        let batch = |spots: &[SpotPoint]| self.spot_quantity_batch(spots);
        let spots = select_spots(
            &key,
            &SpotSelectParams {
                region_size: REGION_SIZE,
                candidate_spot_count: self.params.candidate_spot_count,
                spacing: REGULAR_SPACING,
                skip_span: self.skip_span,
                skip_offset: self.skip_offset,
                hard_region_target_quantity: false,
                density: &density,
                quantity: &quantity,
                favorability: &favorability,
                quantity_batch: Some(&batch),
            },
        );
        self.region_cache
            .borrow_mut()
            .insert((region_x, region_y), spots.clone());
        spots
    }

    /// `max(basement_value, max over nearby spots of the cone)`.
    ///
    /// Exposed to the crate so the fixture tests can count the positions no
    /// cone reaches. That count is a discrete structural fact about spot
    /// selection, the cull and the cone geometry, and it is the one thing in
    /// this layer a frozen residual against the game can still see.
    #[must_use]
    pub(crate) fn spot_field_at(&self, x: f64, y: f64) -> f64 {
        let mut best = self.basement;
        for region_x in
            region_index(x - MAX_SPOT_BASEMENT_RADIUS)..=region_index(x + MAX_SPOT_BASEMENT_RADIUS)
        {
            for region_y in region_index(y - MAX_SPOT_BASEMENT_RADIUS)
                ..=region_index(y + MAX_SPOT_BASEMENT_RADIUS)
            {
                for s in self.region_spots(region_x, region_y) {
                    let dx = x - s.x as f64;
                    let dy = y - s.y as f64;
                    let d2 = dx * dx + dy * dy;
                    if d2 > MAX_SPOT_BASEMENT_RADIUS * MAX_SPOT_BASEMENT_RADIUS {
                        continue;
                    }
                    // The cap 32 first, as the TypeScript writes it. Regular
                    // patches have no hard-target shrink, so `cone_scale` is
                    // always 1 and is not read here.
                    let radius = min2(
                        MAX_SPOT_RADIUS,
                        f64::from(
                            (self.params.regular_rq_factor
                                * f64::from(fast_cbrt(s.quantity as f32)))
                                as f32,
                        ),
                    );
                    let peak = cone_peak(s.quantity, radius);
                    let cone = cone_at(peak, radius, d2);
                    // NOT `max2`: the strict `>` keeps `basement` on a NaN or a
                    // tie, and `f64::max` would not.
                    if cone > best {
                        best = cone;
                    }
                }
            }
        }
        best
    }

    /// `(blobs0 + basis_noise{1/64,1.5} - 1/3) * regular_blob_amplitude_at(distance)`.
    #[must_use]
    pub(crate) fn blob_term_at(&self, x: f64, y: f64) -> f64 {
        let blobs0 = f64::from(basis_noise(x / 8.0, y / 8.0, &self.tables))
            + f64::from(basis_noise(x / 24.0, y / 24.0, &self.tables));
        let extra = 1.5 * f64::from(basis_noise(x / 64.0, y / 64.0, &self.tables));
        (blobs0 + extra - 1.0 / 3.0)
            * regular_blob_amplitude_at(self.distance_at(x, y), &self.params, &self.controls)
    }

    /// The raw `regular_patches` field value.
    #[must_use]
    pub fn field(&self, x: f64, y: f64) -> f64 {
        self.spot_field_at(x, y) + self.blob_term_at(x, y)
    }

    /// `clamp(field, 0, 1)` - the solid-footprint probability.
    #[must_use]
    pub fn probability(&self, x: f64, y: f64) -> f64 {
        if self.levers.size > 0.0 {
            min2(max2(self.field(x, y), 0.0), 1.0)
        } else {
            0.0
        }
    }

    /// The autoplace richness at `(x, y)`, 0 where `size <= 0`.
    #[must_use]
    pub fn richness(&self, x: f64, y: f64) -> f64 {
        if self.levers.size <= 0.0 {
            return 0.0;
        }
        let mut r = self.field(x, y) / self.params.random_probability;
        r += self.params.additional_richness;
        if self.params.minimum_richness > 0.0 {
            r = max2(r, self.params.minimum_richness);
        }
        self.params.richness_post_multiplier
            * self.levers.richness
            * r
            * richness_distance_factor(self.distance_at(x, y))
    }

    /// The constant floor this field is built over.
    ///
    /// Test-only: nothing on a render path needs the basement apart from the
    /// field it is already inside. `#[cfg(test)]` rather than `pub`, so it
    /// cannot drift into being API.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn basement(&self) -> f64 {
        self.basement
    }
}

/// `3q / (pi r^2)`, per operation in f32.
///
/// **`PI * radius` is narrowed as a PRODUCT, and `PI` is not pre-narrowed.**
/// Those are different computations, and the difference is invisible to every
/// residual this layer is graded by - measured: pre-narrowing `PI` here changes
/// field values (an order-sensitive fold of all 31,400 fixture values moves) and
/// shifts the worst absolute residual in 0 of 8 cases.
fn cone_peak(quantity: f64, radius: f64) -> f64 {
    let numerator = f64::from((3.0 * quantity) as f32);
    let area = f64::from((f64::from((PI * radius) as f32) * radius) as f32);
    f64::from((numerator / area) as f32)
}

/// `peak - sqrt(d2) * (peak / radius)`, per operation in f32.
fn cone_at(peak: f64, radius: f64, d2: f64) -> f64 {
    let slope = f64::from((peak / radius) as f32);
    f64::from((peak - f64::from((f64::from(d2.sqrt() as f32) * slope) as f32)) as f32)
}

/// `max((double_density_distance - fade_in + distance) / (double_density_distance * 2), 1)`.
///
/// The fade-in term applies because none of the base resources pass
/// `has_starting = nil`. The expression comes first in the `max`, as written.
pub(crate) fn richness_distance_factor(distance: f64) -> f64 {
    max2(
        (DOUBLE_DENSITY_DISTANCE - REGULAR_PATCH_FADE_IN_DISTANCE + distance)
            / (DOUBLE_DENSITY_DISTANCE * 2.0),
        1.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::nauvis_catalog::resource_by_name;

    fn iron() -> &'static ResourceParams {
        resource_by_name("iron-ore").expect("iron is in the catalog")
    }

    fn built(seed0: u32) -> RegularPatches {
        RegularPatches::new(iron(), &RegularPatchesCtx::defaults(seed0))
    }

    #[test]
    fn regions_are_centred_on_multiples_of_the_region_size() {
        // Regions are CENTRED on multiples of 1024, not cornered at them, which
        // is why the index offsets by half before dividing. Getting this wrong
        // shifts every patch by half a region and still produces patches.
        assert_eq!(region_index(0.0), 0);
        assert_eq!(region_index(511.0), 0);
        assert_eq!(region_index(512.0), 1);
        assert_eq!(region_index(-512.0), 0);
        assert_eq!(region_index(-513.0), -1);
    }

    #[test]
    fn the_field_is_the_spot_field_plus_the_blob_term() {
        // The decomposition the fixture tests count `at basement` with. If
        // these ever stop summing to `field`, that count is measuring something
        // else and the frozen numbers beside it are meaningless.
        let p = built(123_456);
        for &(x, y) in &[(0.5, 0.25), (512.0, 512.0), (-1337.5, 880.25)] {
            assert_eq!(p.field(x, y), p.spot_field_at(x, y) + p.blob_term_at(x, y));
        }
    }

    #[test]
    fn the_spot_field_never_goes_below_the_basement() {
        let p = built(123_456);
        for i in 0..200 {
            let x = f64::from(i) * 37.5 - 2000.0;
            let y = f64::from(i) * -21.25 + 700.0;
            assert!(p.spot_field_at(x, y) >= p.basement(), "at ({x}, {y})");
        }
    }

    #[test]
    fn some_positions_are_at_basement_and_some_are_not() {
        // Anti-vacuity for the test above and for the fixture tests' count: a
        // spot field that was ALWAYS the basement would satisfy it trivially,
        // and that is exactly what a broken candidate stream produces.
        let p = built(123_456);
        let mut at = 0;
        let mut above = 0;
        for i in 0..400 {
            let x = f64::from(i) * 13.5 - 1000.0;
            let y = f64::from(i) * 7.25 - 400.0;
            if p.spot_field_at(x, y) == p.basement() {
                at += 1;
            } else {
                above += 1;
            }
        }
        assert!(at > 0 && above > 0, "at basement {at}, above {above}");
    }

    #[test]
    fn the_region_cache_does_not_change_any_value() {
        // A cache keyed wrongly would return another region's spots and still
        // render a plausible patch. Compare a cold instance against a warm one
        // at the same point, in both orders.
        let cold = built(123_456);
        let warm = built(123_456);
        for i in 0..40 {
            let x = f64::from(i) * 61.5 - 900.0;
            let _ = warm.field(x, 250.0);
        }
        for i in 0..40 {
            let x = f64::from(i) * 61.5 - 900.0;
            assert_eq!(cold.field(x, 250.0), warm.field(x, 250.0), "at x = {x}");
        }
        assert!(!warm.region_cache.borrow().is_empty(), "the cache was used");
    }

    #[test]
    fn the_skip_offset_partitions_the_stream_into_different_fields() {
        // `skip_span`/`skip_offset` is how six resources share one candidate
        // stream. Two offsets over the same span must not produce the same
        // field, or the partition is not happening.
        let ctx = |offset: usize| RegularPatchesCtx {
            skip_span: 6,
            skip_offset: offset,
            ..RegularPatchesCtx::defaults(123_456)
        };
        let a = RegularPatches::new(iron(), &ctx(0));
        let b = RegularPatches::new(iron(), &ctx(1));
        let differs = (0..60).any(|i| {
            let x = f64::from(i) * 47.5 + 300.0;
            a.spot_field_at(x, 120.25) != b.spot_field_at(x, 120.25)
        });
        assert!(differs, "skip offsets 0 and 1 gave the same spot field");
    }

    #[test]
    fn the_jitter_batch_depends_on_the_whole_spot_list_and_not_only_on_each_spot() {
        // The empirical result the header records: `random_penalty` is seeded
        // from the FIRST spot and streamed, so dropping a spot from the front
        // of the batch changes every later spot's quantity. A per-spot
        // implementation would leave the tail unchanged.
        let p = built(123_456);
        let spots: Vec<SpotPoint> = (0..8)
            .map(|i| SpotPoint {
                x: 400 + i * 53,
                y: 900 - i * 31,
            })
            .collect();
        let all = p.spot_quantity_batch(&spots);
        let tail = p.spot_quantity_batch(&spots[1..]);
        assert_eq!(tail.len(), all.len() - 1);
        assert!(
            (0..tail.len()).any(|i| tail[i] != all[i + 1]),
            "the batch is behaving per-spot"
        );
    }

    #[test]
    fn the_cone_is_a_linear_ramp_from_the_peak_down_to_zero_at_the_radius() {
        // The geometry, independent of any seed: peak at the centre, zero at
        // the radius, negative past it. A sign slip in the slope term is
        // otherwise absorbed by the `max` against the basement.
        let radius = 12.0;
        let peak = cone_peak(500.0, radius);
        assert_eq!(cone_at(peak, radius, 0.0), peak);
        let at_edge = cone_at(peak, radius, radius * radius);
        assert!(at_edge.abs() < peak * 1e-6, "at the radius: {at_edge}");
        assert!(cone_at(peak, radius, (radius * 2.0).powi(2)) < 0.0);
    }

    #[test]
    fn pre_narrowing_pi_in_the_cone_is_a_different_computation() {
        // The narrow-the-product versus narrow-the-constant rule, pinned where
        // it applies. A residual against the game cannot see this (measured: 0
        // of 8 fixture cases move), so it needs its own assertion or nothing
        // guards it.
        //
        // Swept rather than asserted at one point, and that is not caution: the
        // two forms AGREE on about three quarters of the inputs, so a single
        // hand-picked pair is likely to be vacuous - the first pair tried here
        // was. The counts are frozen so this cannot decay into a sweep that
        // discriminates nowhere.
        let pre_narrow_pi = |quantity: f64, radius: f64| {
            let numerator = f64::from((3.0 * quantity) as f32);
            let area =
                f64::from((f64::from((f64::from(PI as f32) * radius) as f32) * radius) as f32);
            f64::from((numerator / area) as f32)
        };
        let mut differ = 0;
        let mut total = 0;
        for i in 1..400 {
            let radius = f64::from(i) * 0.0817 + 0.5;
            for j in 1..40 {
                let quantity = f64::from(j) * 137.75 + 3.5;
                total += 1;
                if cone_peak(quantity, radius) != pre_narrow_pi(quantity, radius) {
                    differ += 1;
                }
            }
        }
        assert_eq!((differ, total), (4031, 15561));
        // And one named pair, so a reader can reproduce it by hand.
        assert_ne!(
            cone_peak(141.25, 1.0718999999999999),
            pre_narrow_pi(141.25, 1.0718999999999999)
        );
    }

    #[test]
    fn a_disabled_size_control_zeroes_the_probability_and_the_richness_but_not_the_field() {
        // `size <= 0` is checked on the LEVERS, not on the field, so the raw
        // field still has a value. A port that gated `field` too would break
        // `max(starting, regular)` for a resource whose other branch is live.
        let ctx = RegularPatchesCtx {
            controls: ResourceControlLevers {
                frequency: 1.0,
                size: 0.0,
                richness: 1.0,
            },
            ..RegularPatchesCtx::defaults(123_456)
        };
        let p = RegularPatches::new(iron(), &ctx);
        assert_eq!(p.probability(700.5, -300.25), 0.0);
        assert_eq!(p.richness(700.5, -300.25), 0.0);
        assert!(p.field(700.5, -300.25).is_finite());
    }

    #[test]
    fn the_richness_distance_factor_is_clamped_up_to_one_and_never_below() {
        // `max(expr, 1)` with the expression first. The expression is below 1
        // for every distance under 1300, so this is a floor over most of the
        // map and the `max` is doing all the work there.
        assert_eq!(richness_distance_factor(0.0), 1.0);
        assert_eq!(richness_distance_factor(1000.0), 1.0);
        assert!(richness_distance_factor(3000.0) > 1.0);
    }

    #[test]
    fn oils_random_probability_divides_its_richness_and_its_additional_richness_lands() {
        // Oil is the only entry with `random_probability != 1` and the only one
        // with `additional_richness`, so both wrapper terms are dead for every
        // other resource and would go untested without it.
        let oil = resource_by_name("crude-oil").expect("oil");
        let p = RegularPatches::new(oil, &RegularPatchesCtx::defaults(123_456));
        let (x, y) = (1500.5, 220.25);
        let expected = (p.field(x, y) / (1.0 / 48.0) + 220_000.0)
            * richness_distance_factor(p.distance_at(x, y));
        assert_eq!(p.richness(x, y), expected);
    }
}
