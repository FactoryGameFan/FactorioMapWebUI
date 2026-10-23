//! Aquilo's starting spots, spot fields and well probabilities.
//!
//! Transcribed from `space-age/prototypes/planet/planet-aquilo-map-gen.lua` at
//! 2.1.23 (the file is the same at 2.0.77 for every expression here: the
//! tier-1 fixture reads bit-identical on both). There is no TypeScript
//! counterpart: Aquilo is ported Rust-first.
//!
//! Three wells - crude oil, lithium brine and fluorine vent - each have a
//! starting cone near spawn, a field of random spots further out, and a
//! probability that mixes the two. Fluorine has a second, tiny starting cone
//! (radius 1, at distance 80), "a single vent as a taste", which makes one vent
//! near spawn on every seed while its slider is above zero.
//!
//! Richness is not ported. The preview renders placement, not yield.
//!
//! ## The three spot fields share `seed1`, so the cache key is the whole spec
//!
//! All three call `aquilo_spot_noise` with `seed1 = 567`, skip span 3 and
//! spacing 128, and at default sliders all three region sizes are
//! `600 + 400 / 1 = 1000`. They differ only in count (4, 3, 2), skip offset
//! (0, 1, 2) and radius. So the cache key ([`AquiloSpotKey`]) holds every one
//! of those, not just `seed1`; `the_three_wells_share_seed1_and_do_not_share_cached_spots`
//! is the test that sees a key that drops one.
//!
//! ## Where this narrows to f32
//!
//! The noise machine evaluates one op at a time in f32, so every op here is
//! narrowed, constants included (`1.2`, `0.8`, `0.6`, `0.02`, `0.015`, `0.012`
//! and `0.008` are f32 literals). `aquilo_spot_size * 1.2 * sqrt(size)` is
//! `(30 * 1.2) * sqrt(size)`, left to right, each op in f32.
//!
//! ## The size gate is a constant fold, not a multiply
//!
//! Each probability is `(control:<x>:size > 0) * max(...)`. Read literally,
//! `0 * max(...)` is `-0` wherever the `max` is negative, which is almost
//! everywhere. The game returns `+0` at every position of the fixture's size-0
//! case. The control is a constant, so the game folds the comparison and the
//! product away: the field is the `max(...)` itself when the slider is above
//! zero, and the constant `0` when it is not. [`gated`] does exactly that.

use crate::at::At;
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{clamp, max, max2, min2};
use crate::expressions::starting_spot_at_angle::{starting_spot_at_angle, AngleTrig, StartingSpot};
use crate::expressions::vulcanus_seed::seed_normalized;
use crate::spot_candidates::SpotRegionKey;
use crate::spot_field::{spot_cone_max, ConeArithmetic, SpotGeometry, SpotRegionCache};
use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};

/// `aquilo_spot_size`.
const SPOT_SIZE: f64 = 30.0;

/// `seed` for every `aquilo_spot_noise` call. All three wells share it.
const SEED1: u32 = 567;

/// `skip_span` in `aquilo_spot_noise`.
const SKIP_SPAN: usize = 3;

/// `suggested_minimum_candidate_point_spacing` in `aquilo_spot_noise`.
const SPACING: f64 = 128.0;

/// `basement_value` in `aquilo_spot_noise`.
const BASEMENT_VALUE: f64 = -1.0;

/// Narrow to f32 and back, the noise machine's per-op rounding.
fn f32r(v: f64) -> f64 {
    f64::from(v as f32)
}

/// `control:<x>:frequency|size` for one Aquilo well.
///
/// Use the values the game reads back, which are f32: a fluorine size of 1/6
/// is `0.1666666716337204` to the game, not 1/6.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AquiloLevers {
    pub frequency: f64,
    pub size: f64,
}

impl Default for AquiloLevers {
    /// The neutral slider is 1, not 0.
    fn default() -> Self {
        Self {
            frequency: 1.0,
            size: 1.0,
        }
    }
}

/// The three Aquilo resource controls: `aquilo_crude_oil`, `lithium_brine` and
/// `fluorine_vent`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AquiloResourceControls {
    pub crude_oil: AquiloLevers,
    pub lithium_brine: AquiloLevers,
    pub fluorine_vent: AquiloLevers,
}

/// The sine and cosine of each starting cone's bearing.
///
/// An input for the reason `starting_spot_at_angle`'s module docs give: the
/// cone has no narrowing below the trig, so the shipped engine takes V8's
/// values across the boundary. Both fluorine cones use the same bearing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AquiloBearings {
    pub crude_oil: AngleTrig,
    pub lithium_brine: AngleTrig,
    pub fluorine_vent: AngleTrig,
}

impl AquiloBearings {
    /// All three bearings through Rust's libm. **For tests, not the shipped
    /// engine** - see `AngleTrig::from_degrees`.
    ///
    /// `aquilo_angle = map_seed_normalized * 3600`, narrowed, then `+ 120` and
    /// `+ 240`, each narrowed.
    #[must_use]
    pub fn from_host(seed0: u32) -> Self {
        let base = f32r(f64::from(seed_normalized(seed0)) * 3600.0);
        Self {
            crude_oil: AngleTrig::from_degrees(base),
            lithium_brine: AngleTrig::from_degrees(f32r(base + 120.0)),
            fluorine_vent: AngleTrig::from_degrees(f32r(base + 240.0)),
        }
    }
}

/// Every named expression this layer grades, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AquiloResourceFields {
    pub starting_crude_oil: f64,
    pub starting_lithium_brine: f64,
    pub starting_fluorine_vent: f64,
    pub starting_fluorine_vent_tiny: f64,
    pub starting_mask: f64,
    pub crude_oil_spots: f64,
    pub lithium_brine_spots: f64,
    pub fluorine_vent_spots: f64,
    pub crude_oil_probability: f64,
    pub lithium_brine_probability: f64,
    pub fluorine_vent_probability: f64,
}

/// One `aquilo_spot_noise` call.
#[derive(Debug, Clone, Copy)]
struct WellSpec {
    candidate_spot_count: usize,
    skip_offset: usize,
    /// `600 + 400 / frequency`, BEFORE the floor.
    region_size: f64,
    /// `aquilo_spot_size * <scale> * sqrt(size)`, already f32.
    radius: f64,
}

/// The cache key of one spot stream: every spec field, not `seed1` alone.
///
/// The three wells share `seed1` 567 and, at default sliders, region size
/// 1000. `region_size` is kept UNFLOORED (as bits), so two frequencies that
/// floor to the same size stay apart. `seed1`, `skip_span` and the spacing are
/// module constants today; they are in the key so a future spec that varies one
/// cannot collide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct AquiloSpotKey {
    seed1: u32,
    region_size_bits: u64,
    spacing_bits: u64,
    skip_span: u32,
    skip_offset: u32,
    candidate_spot_count: u32,
    radius_bits: u64,
}

impl WellSpec {
    /// Build one well's spec from its levers.
    ///
    /// `scale` is `None` for crude oil, whose radius is `30 * sqrt(size)`, and
    /// `Some(1.2)` or `Some(1.5)` for the other two, whose radius is
    /// `(30 * scale) * sqrt(size)`, left to right.
    fn new(count: usize, skip_offset: usize, levers: AquiloLevers, scale: Option<f32>) -> Self {
        let root = f32r(levers.size.sqrt());
        let base = match scale {
            None => SPOT_SIZE,
            Some(s) => f32r(SPOT_SIZE * f64::from(s)),
        };
        Self {
            candidate_spot_count: count,
            skip_offset,
            region_size: f32r(600.0 + f32r(400.0 / levers.frequency)),
            radius: f32r(base * root),
        }
    }

    fn key(self) -> AquiloSpotKey {
        AquiloSpotKey {
            seed1: SEED1,
            region_size_bits: self.region_size.to_bits(),
            spacing_bits: SPACING.to_bits(),
            skip_span: SKIP_SPAN as u32,
            skip_offset: self.skip_offset as u32,
            candidate_spot_count: self.candidate_spot_count as u32,
            radius_bits: self.radius.to_bits(),
        }
    }

    /// `maximum_spot_basement_radius = radius * 2`.
    fn geometry(self) -> SpotGeometry {
        SpotGeometry {
            region_size: self.region_size,
            max_basement_radius: f32r(self.radius * 2.0),
            basement_value: BASEMENT_VALUE,
            cone: ConeArithmetic::GameBinary,
        }
    }

    /// `spot_quantity_expression = radius * radius`.
    fn quantity(self) -> f64 {
        f32r(self.radius * self.radius)
    }
}

/// `(control:<x>:size > 0) * value`, folded the way the game folds it: see the
/// module docs. A literal multiply gives `-0` where the game gives `+0`.
fn gated(size_positive: bool, value: f64) -> f64 {
    if size_positive {
        value
    } else {
        0.0
    }
}

/// The per-render constants of Aquilo's resource fields.
pub struct AquiloResources {
    seed0: u32,
    /// The spawn. The game's `distance` and `x_from_start` read it; a preview
    /// has one spawn, at the origin.
    starting_positions: Vec<Point>,

    starting_crude_oil: StartingSpot,
    starting_lithium_brine: StartingSpot,
    starting_fluorine_vent: StartingSpot,
    starting_fluorine_vent_tiny: StartingSpot,

    crude_oil_spots: WellSpec,
    lithium_brine_spots: WellSpec,
    fluorine_vent_spots: WellSpec,

    crude_oil_size_positive: bool,
    lithium_brine_size_positive: bool,
    fluorine_vent_size_positive: bool,

    region_cache: SpotRegionCache<AquiloSpotKey>,
}

impl AquiloResources {
    /// Build the layer at map seed `seed0`, with the cone bearings from the
    /// caller.
    #[must_use]
    pub fn new(seed0: u32, controls: &AquiloResourceControls, bearings: AquiloBearings) -> Self {
        let cone = |trig: AngleTrig, distance: f64, radius: f64| StartingSpot {
            trig,
            distance,
            radius,
        };
        Self {
            seed0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],

            // Radii `aquilo_spot_size * 0.8` and `* 0.6`, with f32 literals.
            // Both land on whole numbers (24 and 18), but they are computed
            // rather than written so the narrowing is visible.
            starting_crude_oil: cone(
                bearings.crude_oil,
                40.0,
                f32r(SPOT_SIZE * f64::from(0.8f32)),
            ),
            starting_lithium_brine: cone(
                bearings.lithium_brine,
                80.0,
                f32r(SPOT_SIZE * f64::from(0.6f32)),
            ),
            starting_fluorine_vent: cone(
                bearings.fluorine_vent,
                160.0,
                f32r(SPOT_SIZE * f64::from(0.6f32)),
            ),
            starting_fluorine_vent_tiny: cone(bearings.fluorine_vent, 80.0, 1.0),

            crude_oil_spots: WellSpec::new(4, 0, controls.crude_oil, None),
            lithium_brine_spots: WellSpec::new(3, 1, controls.lithium_brine, Some(1.2)),
            fluorine_vent_spots: WellSpec::new(2, 2, controls.fluorine_vent, Some(1.5)),

            crude_oil_size_positive: controls.crude_oil.size > 0.0,
            lithium_brine_size_positive: controls.lithium_brine.size > 0.0,
            fluorine_vent_size_positive: controls.fluorine_vent.size > 0.0,

            region_cache: SpotRegionCache::new(),
        }
    }

    /// The selected spots of one region of one well, selected once and cached.
    fn region_spots(&self, spec: WellSpec, region_x: i64, region_y: i64) -> Vec<SelectedSpot> {
        self.region_cache
            .get_or_select(spec.key(), region_x, region_y, || {
                let key = SpotRegionKey {
                    seed0: self.seed0,
                    seed1: SEED1,
                    region_x,
                    region_y,
                };
                let quantity = spec.quantity();
                // Density and favorability are both the constant 1, so the
                // regional target is `region_size^2` and the trim keeps every
                // spot in generation order.
                select_spots(
                    &key,
                    &SpotSelectParams {
                        region_size: spec.geometry().floored_region_size() as u64,
                        candidate_spot_count: spec.candidate_spot_count,
                        spacing: SPACING,
                        skip_span: SKIP_SPAN,
                        skip_offset: spec.skip_offset,
                        hard_region_target_quantity: false,
                        density: &|_, _| 1.0,
                        quantity: &|_, _| quantity,
                        favorability: &|_, _| 1.0,
                        quantity_batch: None,
                    },
                )
            })
    }

    /// `aquilo_spot_noise{...}` for one well, at the raw coordinate (no wobble).
    ///
    /// At size 0 the radius is 0: `select_spots` skips every spot (quantity 0)
    /// and `spot_cone_max` skips any radius at or below 0, so the field is the
    /// basement value -1 everywhere, never `0 / 0`.
    fn spot_noise_at(&self, spec: WellSpec, x: f64, y: f64) -> f64 {
        spot_cone_max(
            &spec.geometry(),
            x,
            y,
            |region_x, region_y| self.region_spots(spec, region_x, region_y),
            |_| spec.radius,
        )
    }

    /// Evaluate every field of this layer at one position.
    ///
    /// None of these expressions reads a noise primitive, so `At::Grid` and
    /// `At::Point` give the same values here; only the coordinate is read.
    #[must_use]
    pub fn eval_at(&self, at: At) -> AquiloResourceFields {
        let (x, y) = (at.x(), at.y());
        // `x_from_start` and `y_from_start` are `x` and `y` at the origin
        // spawn, and the cones have zero distortion.
        let cone = |spot: &StartingSpot| starting_spot_at_angle(spot, x, y, 0.0, 0.0);
        let starting_crude_oil = cone(&self.starting_crude_oil);
        let starting_lithium_brine = cone(&self.starting_lithium_brine);
        let starting_fluorine_vent = cone(&self.starting_fluorine_vent);
        let starting_fluorine_vent_tiny = cone(&self.starting_fluorine_vent_tiny);

        // `clamp((distance - 300) / 40, -1, 1)`.
        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        let starting_mask = clamp(f32r(f32r(distance - 300.0) / 40.0), -1.0, 1.0);

        let crude_oil_spots = self.spot_noise_at(self.crude_oil_spots, x, y);
        let lithium_brine_spots = self.spot_noise_at(self.lithium_brine_spots, x, y);
        let fluorine_vent_spots = self.spot_noise_at(self.fluorine_vent_spots, x, y);

        let term = |v: f64, k: f32| f32r(v * f64::from(k));

        // `max(starting * 0.02, min(mask, spots) * k)`, in the Lua's order.
        let crude_oil_probability = gated(
            self.crude_oil_size_positive,
            max2(
                term(starting_crude_oil, 0.02),
                term(min2(starting_mask, crude_oil_spots), 0.015),
            ),
        );
        let lithium_brine_probability = gated(
            self.lithium_brine_size_positive,
            max2(
                term(starting_lithium_brine, 0.02),
                term(min2(starting_mask, lithium_brine_spots), 0.012),
            ),
        );
        // Fluorine's `max` has a middle argument, `tiny > 0`, which is 1 or 0.
        let tiny_positive = if starting_fluorine_vent_tiny > 0.0 {
            1.0
        } else {
            0.0
        };
        let fluorine_vent_probability = gated(
            self.fluorine_vent_size_positive,
            max(&[
                term(starting_fluorine_vent, 0.02),
                tiny_positive,
                term(min2(starting_mask, fluorine_vent_spots), 0.008),
            ]),
        );

        AquiloResourceFields {
            starting_crude_oil,
            starting_lithium_brine,
            starting_fluorine_vent,
            starting_fluorine_vent_tiny,
            starting_mask,
            crude_oil_spots,
            lithium_brine_spots,
            fluorine_vent_spots,
            crude_oil_probability,
            lithium_brine_probability,
            fluorine_vent_probability,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED0: u32 = 123_456;

    fn layer(controls: &AquiloResourceControls) -> AquiloResources {
        AquiloResources::new(SEED0, controls, AquiloBearings::from_host(SEED0))
    }

    fn zero_size() -> AquiloResourceControls {
        let levers = AquiloLevers {
            frequency: 1.0,
            size: 0.0,
        };
        AquiloResourceControls {
            crude_oil: levers,
            lithium_brine: levers,
            fluorine_vent: levers,
        }
    }

    /// The selected spot centres of every well over the regions around the
    /// origin, at default sliders.
    fn default_spot_centres() -> Vec<(f64, f64)> {
        let l = layer(&AquiloResourceControls::default());
        let mut out = Vec::new();
        for spec in [
            l.crude_oil_spots,
            l.lithium_brine_spots,
            l.fluorine_vent_spots,
        ] {
            for rx in -1..=1 {
                for ry in -1..=1 {
                    for s in l.region_spots(spec, rx, ry) {
                        out.push((s.x as f64, s.y as f64));
                    }
                }
            }
        }
        out
    }

    /// Size 0 makes the spot radius 0, so the cone's `3q / (pi r^2)` is
    /// `0 / 0`. The field must come back as the basement, -1, and never NaN.
    ///
    /// The positions are where the DEFAULT sliders put spot centres, so a cone
    /// would be at its peak there if any survived.
    #[test]
    fn a_zero_size_spot_field_is_the_basement_everywhere() {
        let centres = default_spot_centres();
        assert!(
            centres.len() >= 64,
            "only {} default spot centres, need 64",
            centres.len()
        );
        let l = layer(&zero_size());
        for &(x, y) in centres.iter().take(64) {
            let f = l.eval_at(At::point(x, y));
            for (name, v) in [
                ("crude oil", f.crude_oil_spots),
                ("lithium brine", f.lithium_brine_spots),
                ("fluorine vent", f.fluorine_vent_spots),
            ] {
                assert!(v.is_finite(), "{name} spots at ({x}, {y}) is {v}");
                assert_eq!(
                    v.to_bits(),
                    (-1.0f64).to_bits(),
                    "{name} spots at ({x}, {y}) is {v}, not the basement"
                );
            }
        }
    }

    /// The three wells share `seed1` 567 and, at default sliders, region size
    /// 1000. Warm the cache with crude oil, then lithium brine must still read
    /// what a fresh layer reads. A key of `seed1` and region alone would hand
    /// lithium brine crude oil's spots.
    #[test]
    fn the_three_wells_share_seed1_and_do_not_share_cached_spots() {
        let controls = AquiloResourceControls::default();
        let fresh = layer(&controls);

        // Lithium brine's own spot centres, where its field peaks.
        let mut positions = Vec::new();
        for rx in -2..=2 {
            for ry in -2..=2 {
                for s in fresh.region_spots(fresh.lithium_brine_spots, rx, ry) {
                    positions.push((s.x as f64, s.y as f64));
                }
            }
        }
        assert!(!positions.is_empty(), "no lithium brine spot to test at");

        // Anti-vacuity: the two wells really select different spots, or a
        // shared cache entry would look correct.
        let differs = (-2..=2)
            .flat_map(|rx| (-2..=2).map(move |ry| (rx, ry)))
            .any(|(rx, ry)| {
                fresh.region_spots(fresh.crude_oil_spots, rx, ry)
                    != fresh.region_spots(fresh.lithium_brine_spots, rx, ry)
            });
        assert!(differs, "crude oil and lithium brine select the same spots");

        let expected: Vec<f64> = positions
            .iter()
            .map(|&(x, y)| layer(&controls).spot_noise_at(fresh.lithium_brine_spots, x, y))
            .collect();
        assert!(
            expected.iter().all(|&v| v > -1.0),
            "lithium brine is at the basement on its own centre"
        );

        let warm = layer(&controls);
        for &(x, y) in &positions {
            let _ = warm.spot_noise_at(warm.crude_oil_spots, x, y);
        }
        for (&(x, y), want) in positions.iter().zip(&expected) {
            let got = warm.spot_noise_at(warm.lithium_brine_spots, x, y);
            assert_eq!(
                got.to_bits(),
                want.to_bits(),
                "lithium brine at ({x}, {y}) took crude oil's cached spots"
            );
        }
    }

    /// Cold against warm for two specs: the second must read its own spots
    /// after the first has filled the cache. Also asserts the two really
    /// select different spots, or a shared entry would look correct.
    fn assert_specs_do_not_share_cached_spots(first: WellSpec, second: WellSpec, field: &str) {
        let controls = AquiloResourceControls::default();
        let regions: Vec<(i64, i64)> = (-2..=2)
            .flat_map(|x| (-2..=2).map(move |y| (x, y)))
            .collect();
        let cold = layer(&controls);
        let expected: Vec<_> = regions
            .iter()
            .map(|&(x, y)| cold.region_spots(second, x, y))
            .collect();
        assert!(
            expected.iter().any(|spots| !spots.is_empty()),
            "{field}: no region produced a spot"
        );
        let cold_first = layer(&controls);
        assert!(
            regions
                .iter()
                .zip(&expected)
                .any(|(&(x, y), want)| &cold_first.region_spots(first, x, y) != want),
            "{field}: the two specs select the same spots everywhere"
        );
        let warm = layer(&controls);
        for &(x, y) in &regions {
            let _ = warm.region_spots(first, x, y);
        }
        for (&(x, y), want) in regions.iter().zip(&expected) {
            assert_eq!(
                &warm.region_spots(second, x, y),
                want,
                "{field}: region ({x}, {y}) took the first spec's cached spots"
            );
        }
    }

    /// One pair per key field, differing in that field alone. The three wells
    /// differ in all of count, skip offset and radius at once, so the test
    /// above goes red only when all three are dropped from the key; this one
    /// goes red when any one is. Radius changes no spot position (the target
    /// keeps every spot), but it changes each cached spot's quantity, which is
    /// the cone's peak. Region size needs two sizes that floor apart.
    #[test]
    fn each_key_field_alone_keeps_two_specs_apart() {
        let base = WellSpec::new(4, 0, AquiloLevers::default(), None);
        assert_specs_do_not_share_cached_spots(
            base,
            WellSpec {
                skip_offset: 1,
                ..base
            },
            "skip_offset",
        );
        assert_specs_do_not_share_cached_spots(
            base,
            WellSpec {
                candidate_spot_count: 3,
                ..base
            },
            "candidate_spot_count",
        );
        assert_specs_do_not_share_cached_spots(
            base,
            WellSpec {
                radius: 36.0,
                ..base
            },
            "radius",
        );
        assert_specs_do_not_share_cached_spots(
            base,
            WellSpec {
                region_size: 800.0,
                ..base
            },
            "region_size",
        );
    }

    /// `(size > 0) * max(...)` folds to `+0` at size 0, not `-0`.
    #[test]
    fn a_zero_size_probability_is_positive_zero() {
        let l = layer(&zero_size());
        let f = l.eval_at(At::point(500.0, 500.0));
        for v in [
            f.crude_oil_probability,
            f.lithium_brine_probability,
            f.fluorine_vent_probability,
        ] {
            assert_eq!(v.to_bits(), 0.0f64.to_bits());
        }
    }

    /// Frequency 1.5 gives `600 + 400 / 1.5`, which is fractional. The key
    /// keeps it, the selection floors it.
    #[test]
    fn a_fractional_region_size_is_floored_only_for_the_selection() {
        let spec = WellSpec::new(
            4,
            0,
            AquiloLevers {
                frequency: 1.5,
                size: 1.0,
            },
            None,
        );
        assert!(spec.region_size.fract() != 0.0);
        assert_eq!(spec.geometry().floored_region_size(), 866);
    }
}
