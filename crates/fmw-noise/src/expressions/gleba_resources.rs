//! Gleba's resource fields: the two stromatolites' probabilities and stone's
//! richness and probability (#454, slice 3).
//!
//! Transcribed from `space-age/prototypes/planet/planet-gleba-map-gen.lua` and
//! `decorative/decoratives-gleba.lua` at 2.1.23. Ported Rust-first.
//! FactMapGen (`factorio_gleba_features.go`, AGPL-3.0, which credits this
//! repo) holds the same expressions and was read alongside the Lua; every rule
//! here is graded against the game, not against it.
//!
//! - **The stromatolites** are `simple-entity`s whose autoplace probability is
//!   `gleba_select(gleba_<metal>_stromatolite - clamp(gleba_decorative_knockout,
//!   0, 1), 1.3, 2, 0.2, 0, 1)`, with `gleba_<metal>_stromatolite =
//!   gleba_select(gleba_aux, ...) - 1 - gleba_scrub_noise`. No control reaches
//!   them.
//! - **Stone** is `4000 * max(starting, gleba_simple_spot(1000, 6 * size ^ 0.5,
//!   80 / frequency ^ 0.5, gleba_highland) * max(gleba_highland,
//!   gleba_midland_aux_2)) * richness / size`, and its probability is
//!   `(size > 0) * (richness > 1)`, so exactly 0 or 1.
//! - **`gleba_simple_spot`** is `spot_noise` at a coordinate warped by
//!   `gleba_wobble_small_* * 0.5 * radius`, with `skip_span = 1` and
//!   `skip_offset = 1`: the first accepted spot of each region is dropped
//!   (#489), and the regional target is the mean of `gleba_highland` over the
//!   other 21, times the region area. Density and favorability are both
//!   `gleba_highland`, read at the spot's own (unwarped) position.
//!
//! Every step is f32, in the Lua's order, like the terrain fields.

use crate::at::At;
use crate::eval::math::{clamp, f32r, max2};
use crate::expressions::gleba_starting::{area_multiplier, GlebaSeedVars};
use crate::expressions::gleba_terrain::{noise, select, GlebaTerrain, GlebaTerrainFields};
use crate::expressions::starting_spot_at_angle::{starting_spot_at_angle, AngleTrig, StartingSpot};
use crate::multioctave_noise::Prepared;
use crate::poison;
use crate::spot_candidates::SpotRegionKey;
use crate::spot_field::{spot_cone_max, ConeArithmetic, SpotGeometry, SpotRegionCache};
use crate::spot_selection::{select_spots, SpotSelectParams};

/// The `gleba_stone` control. Neutral is 1 for all three.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlebaStoneControls {
    /// `control:gleba_stone:frequency`.
    pub frequency: f64,
    /// `control:gleba_stone:size`.
    pub size: f64,
    /// `control:gleba_stone:richness`.
    pub richness: f64,
}

impl Default for GlebaStoneControls {
    fn default() -> Self {
        Self {
            frequency: 1.0,
            size: 1.0,
            richness: 1.0,
        }
    }
}

/// The resource fields at one position. All values are f32-valued.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct GlebaResourceFields {
    /// `gleba_scrub_noise`.
    pub scrub_noise: f64,
    /// `gleba_decorative_knockout`.
    pub knockout: f64,
    /// `gleba_iron_stromatolite`.
    pub iron_stromatolite: f64,
    /// `gleba_copper_stromatolite`.
    pub copper_stromatolite: f64,
    /// `entity:iron-stromatolite:probability`.
    pub iron_probability: f64,
    /// `entity:copper-stromatolite:probability`.
    pub copper_probability: f64,
    /// `gleba_highland`.
    pub highland: f64,
    /// `gleba_midland_aux_2`.
    pub midland_aux_2: f64,
    /// `gleba_stone_richness`, which is `entity:stone:richness`.
    pub stone_richness: f64,
    /// `gleba_stone_probability`, which is `entity:stone:probability`: 0 or 1.
    pub stone_probability: f64,
}

/// The eight terrain fields the resource and plant fields read at a
/// position. Small, so a render can keep them for every tile tile correction
/// evaluates (`GlebaStack::corrected_tiles_keeping`) instead of evaluating
/// the terrain a second time.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ResourceInputs {
    pub elevation: f64,
    pub aux: f64,
    pub wobble_x: f64,
    pub wobble_small_x: f64,
    pub wobble_small_y: f64,
    /// `gleba_moisture`, which the plants read.
    pub moisture: f64,
    /// `gleba_plants_noise` and `gleba_plants_noise_b`, which the plants read.
    pub plants_noise: f64,
    pub plants_noise_b: f64,
}

impl From<&GlebaTerrainFields> for ResourceInputs {
    fn from(t: &GlebaTerrainFields) -> Self {
        Self {
            elevation: t.elevation,
            aux: t.aux,
            wobble_x: t.wobble_x,
            wobble_small_x: t.wobble_small_x,
            wobble_small_y: t.wobble_small_y,
            moisture: t.moisture,
            plants_noise: t.plants_noise,
            plants_noise_b: t.plants_noise_b,
        }
    }
}

impl ResourceInputs {
    /// The inputs as f32s, which hold them exactly: every one is f32-valued.
    #[must_use]
    #[allow(clippy::cast_possible_truncation)]
    pub fn pack(&self) -> [f32; 8] {
        [
            self.elevation as f32,
            self.aux as f32,
            self.wobble_x as f32,
            self.wobble_small_x as f32,
            self.wobble_small_y as f32,
            self.moisture as f32,
            self.plants_noise as f32,
            self.plants_noise_b as f32,
        ]
    }

    /// The inverse of [`ResourceInputs::pack`].
    #[must_use]
    pub fn unpack(p: &[f32; 8]) -> Self {
        Self {
            elevation: f64::from(p[0]),
            aux: f64::from(p[1]),
            wobble_x: f64::from(p[2]),
            wobble_small_x: f64::from(p[3]),
            wobble_small_y: f64::from(p[4]),
            moisture: f64::from(p[5]),
            plants_noise: f64::from(p[6]),
            plants_noise_b: f64::from(p[7]),
        }
    }
}

/// `gleba_highland`.
#[must_use]
pub fn highland(elevation: f64) -> f64 {
    select(elevation, 120.0, 1000.0, 0.5, 0.0, 1.0)
}

/// The per-render state of the resource fields.
pub struct GlebaResources {
    seed0: u32,
    scrub_a: Prepared,
    scrub_b: Prepared,
    knockout: Prepared,
    /// `control:gleba_stone:size` and `:richness`, in their f32 slots.
    stone_size: f64,
    stone_richness: f64,
    /// `6 * size ^ 0.5`.
    stone_radius: f64,
    /// `80 / frequency ^ 0.5`.
    stone_spacing: f64,
    /// `spacing * 5`.
    stone_region_size: f64,
    /// The starting stone cone.
    stone_start: StartingSpot,
    spot_cache: SpotRegionCache<()>,
}

impl GlebaResources {
    #[must_use]
    pub fn new(seed0: u32, vars: &GlebaSeedVars, stone: &GlebaStoneControls) -> Self {
        let size = f32r(stone.size);
        let frequency = f32r(stone.frequency);
        // `^ 0.5` is the noise machine's exact square root.
        let size_root = f32r(size.sqrt());
        let stone_spacing = f32r(80.0 / f32r(frequency.sqrt()));
        let mult = area_multiplier();
        Self {
            seed0,
            // `gleba_scrub_noise`: the first term has `output_scale = 0.5`.
            scrub_a: noise(seed0, 7500, 2.0, 0.7, f32r(1.0 / 8.0), 0.5),
            scrub_b: noise(seed0, 8500, 2.0, 0.7, f32r(1.0 / 8.0), 1.0),
            knockout: noise(seed0, 1_300_000, 2.0, 0.7, f32r(1.0 / 3.0), 1.0),
            stone_size: size,
            stone_richness: f32r(stone.richness),
            stone_radius: f32r(6.0 * size_root),
            stone_spacing,
            stone_region_size: f32r(stone_spacing * 5.0),
            stone_start: StartingSpot {
                // `gleba_starting_angle + 85 * gleba_starting_direction`.
                trig: AngleTrig::from_degrees(f32r(vars.angle + f32r(85.0 * vars.direction))),
                distance: f32r(80.0 * mult),
                radius: f32r(7.0 * size_root),
            },
            spot_cache: SpotRegionCache::new(),
        }
    }

    /// `control:gleba_stone:size`, in its f32 slot.
    #[must_use]
    pub fn stone_size(&self) -> f64 {
        self.stone_size
    }

    /// `gleba_simple_spot(1000, radius, spacing, gleba_highland)` at the
    /// already warped position `(sx, sy)`.
    fn stone_spot(&self, sx: f64, sy: f64, terrain: &GlebaTerrain) -> f64 {
        let radius = self.stone_radius;
        // A frequency at or below 0 makes the spacing and the region size
        // infinite or NaN. No slider reaches it (the app's least frequency is
        // 1/6) and what the game does there was not read, so the field is the
        // basement rather than a region walk over an unbounded region.
        if !(self.stone_region_size.is_finite() && self.stone_region_size >= 1.0) {
            return -1.0;
        }
        let geometry = SpotGeometry {
            region_size: self.stone_region_size,
            max_basement_radius: f32r(radius * 2.0),
            basement_value: -1.0,
            cone: ConeArithmetic::GameBinary,
        };
        let region_size = geometry.floored_region_size();
        spot_cone_max(
            &geometry,
            sx,
            sy,
            |region_x, region_y| {
                self.spot_cache.get_or_select((), region_x, region_y, || {
                    let key = SpotRegionKey {
                        seed0: self.seed0,
                        seed1: 1000,
                        region_x,
                        region_y,
                    };
                    // Density and favorability are both `gleba_highland`,
                    // read at the spot's own position with the point kernel.
                    let highland_at =
                        |x: f64, y: f64| highland(terrain.eval_at(At::point(x, y)).elevation);
                    let quantity = f32r(radius * radius);
                    #[allow(clippy::cast_sign_loss)]
                    select_spots(
                        &key,
                        &SpotSelectParams {
                            region_size: region_size as u64,
                            candidate_spot_count: 22,
                            spacing: self.stone_spacing,
                            skip_span: 1,
                            skip_offset: 1,
                            hard_region_target_quantity: false,
                            density: &highland_at,
                            quantity: &|_, _| quantity,
                            favorability: &highland_at,
                            quantity_batch: None,
                        },
                    )
                })
            },
            |_| radius,
        )
    }

    /// Every resource field at one position, given the terrain fields there.
    #[must_use]
    pub fn eval(&self, at: At, t: &ResourceInputs, terrain: &GlebaTerrain) -> GlebaResourceFields {
        let (x, y) = (at.x(), at.y());

        // --- gleba_scrub_noise: `0.6 * a + 0.3 - abs(b)`, and the knockout.
        let scrub_noise = f32r(
            f32r(f32r(f32r(0.6) * f64::from(self.scrub_a.eval_at(at))) + f32r(0.3))
                - f64::from(self.scrub_b.eval_at(at)).abs(),
        );
        let knockout = f64::from(self.knockout.eval_at(at));

        // --- the stromatolites
        let iron_box = f32r(select(t.aux, 0.6, 2.0, 0.1, -10.0, 1.0) - 1.0);
        let copper_box = f32r(select(t.aux, -1.0, 0.4, 0.1, -10.0, 1.0) - 1.0);
        let iron_stromatolite = f32r(iron_box - scrub_noise);
        let copper_stromatolite = f32r(copper_box - scrub_noise);
        let knocked = clamp(knockout, 0.0, 1.0);
        let probability = |v: f64| select(f32r(v - knocked), 1.3, 2.0, 0.2, 0.0, 1.0);
        let iron_probability = probability(iron_stromatolite);
        let copper_probability = probability(copper_stromatolite);

        // --- gleba_highland and gleba_midland_aux_2
        let highland = highland(t.elevation);
        let midland = select(t.elevation, 20.0, 120.0, 0.5, 0.0, 1.0);
        let midland_aux_2 = f32r(midland * select(t.aux, 0.45, 0.55, 0.0025, 0.0, 1.0));

        // --- gleba_stone_richness
        let radius = self.stone_radius;
        let warp = |v: f64, w: f64| f32r(v + f32r(f32r(w * 0.5) * radius));
        let spot = self.stone_spot(
            warp(x, t.wobble_small_x),
            warp(y, t.wobble_small_y),
            terrain,
        );
        let distortion = f32r(t.wobble_x * 8.0);
        // `x_from_start` and `y_from_start` at a preview's one spawn, the origin.
        let starting = starting_spot_at_angle(&self.stone_start, x, y, distortion, distortion);
        let stone_richness = f32r(
            f32r(
                f32r(4000.0 * max2(starting, f32r(spot * max2(highland, midland_aux_2))))
                    * self.stone_richness,
            ) / self.stone_size,
        );
        let flag = |b: bool| if b { 1.0 } else { 0.0 };
        let stone_probability = flag(self.stone_size > 0.0) * flag(stone_richness > 1.0);

        GlebaResourceFields {
            scrub_noise,
            knockout,
            iron_stromatolite,
            copper_stromatolite,
            iron_probability: poison::f64_result(iron_probability),
            copper_probability,
            highland,
            midland_aux_2,
            stone_richness: poison::f64_result(stone_richness),
            stone_probability,
        }
    }
}
