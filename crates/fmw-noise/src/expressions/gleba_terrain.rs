//! Gleba's terrain fields: `gleba_elevation`, `gleba_aux`, `gleba_moisture`,
//! `gleba_temperature`, and every named expression the 41 tiles read.
//!
//! Transcribed from `space-age/prototypes/planet/planet-gleba-map-gen.lua` and
//! `entity/plants.lua` (`gleba_plants_noise`, `gleba_plants_noise_b`) at 2.1.23.
//! The tier-1 fixture reads bit-identical on 2.0.77. Ported Rust-first: there
//! is no TypeScript counterpart.
//!
//! ## Every constant is an f32 slot, and every op narrows
//!
//! The noise machine holds each constant in f32 and rounds each op to f32, so
//! every step below goes through [`f32r`], in the order the Lua writes it (left
//! to right, so `a - b - c` is `(a - b) - c`). Constant sub-expressions fold one
//! op at a time in f32 as well, which is why [`select`] narrows `from - slope`
//! and `to + slope` rather than computing them in f64.
//!
//! ## Which kernel each field reaches
//!
//! A multioctave on the raw `x` and `y` follows the [`At`] it is given (the
//! chunk-grid kernel on a tile, #451). One on a WARPED coordinate (`x +
//! gleba_wobble_x * 15 + ...`) is always a point. The tier-1 capture is all
//! points, so it grades the point kernel only.
//!
//! ## The property variables
//!
//! `elevation` and `aux` in the Lua are the surface's property variables, which
//! Gleba's `property_expression_names` bind to `gleba_elevation` and
//! `gleba_aux`. They are wired through here: `gleba_rockpools_pitrock` and
//! `gleba_fertile_spots_coastal` read the elevation, and the biome masks read the
//! aux.
//!
//! ## `distance` and `x_from_start` read a preview's one spawn, at the origin.
//!
//! ## Controls
//!
//! `control:gleba_water:frequency`, `control:gleba_water:size` and
//! `control:gleba_plants:frequency` are wired through [`GlebaControls`]. Only the
//! default (1) is graded by a fixture.

use crate::at::At;
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{
    clamp, f32r, lerp_f32, max, max2, min2, slider_rescale, terrace, vm_cos, vm_sin,
};
use crate::expressions::gleba_starting::{area_multiplier, GlebaSeedVars, GlebaStarting};
use crate::multioctave_noise::{MultioctaveParams, Prepared};
use crate::poison;
use crate::spot_candidates::SpotRegionKey;
use crate::spot_field::{spot_cone_max, ConeArithmetic, SpotGeometry, SpotRegionCache};
use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};

/// The slider levers Gleba's terrain reads. Neutral is 1 for all three.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlebaControls {
    /// `control:gleba_water:frequency`.
    pub water_frequency: f64,
    /// `control:gleba_water:size`.
    pub water_size: f64,
    /// `control:gleba_plants:frequency`.
    pub plants_frequency: f64,
}

impl Default for GlebaControls {
    fn default() -> Self {
        Self {
            water_frequency: 1.0,
            water_size: 1.0,
            plants_frequency: 1.0,
        }
    }
}

/// `gleba_select(input, from, to, slope, min, max)`:
/// `clamp(min(input - (from - slope), to + slope - input) / slope, min, max)`.
///
/// The five constants are narrowed first, then `from - slope` and `to + slope`
/// fold as f32 ops. Used by the terrain here and by every tile in the catalog.
#[must_use]
pub fn select(input: f64, from: f64, to: f64, slope: f64, lo: f64, hi: f64) -> f64 {
    let (from, to, slope, lo, hi) = (f32r(from), f32r(to), f32r(slope), f32r(lo), f32r(hi));
    let lower = f32r(from - slope);
    let upper = f32r(to + slope);
    let m = min2(f32r(input - lower), f32r(upper - input));
    clamp(f32r(m / slope), lo, hi)
}

/// `gleba_pos_peak(input, point, range) = max(0, 1 - abs(input - point) / range)`.
fn pos_peak(input: f64, point: f64, range: f64) -> f64 {
    max2(0.0, f32r(1.0 - f32r(f32r(input - point).abs() / range)))
}

/// `rotate_x` and `rotate_y`: `angle_rad = angle / 180 * pi`, and the game's
/// own sine and cosine of it. Returns `(cos, sin)`.
fn rotation(angle: f64) -> (f64, f64) {
    let pi32 = f64::from(std::f64::consts::PI as f32);
    let radians = f32r(f32r(angle / 180.0) * pi32);
    (vm_cos(radians), vm_sin(radians))
}

/// `x * cos(a) + y * sin(a)`.
fn rotate_x(x: f64, y: f64, angle: f64) -> f64 {
    let (c, s) = rotation(angle);
    f32r(f32r(x * c) + f32r(y * s))
}

/// `y * cos(a) - x * sin(a)`.
fn rotate_y(x: f64, y: f64, angle: f64) -> f64 {
    let (c, s) = rotation(angle);
    f32r(f32r(y * c) - f32r(x * s))
}

/// Every terrain expression the tiles and the four property fields read, at
/// one position. All values are f32-valued.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct GlebaTerrainFields {
    /// `gleba_elevation`, which is the `elevation` property.
    pub elevation: f64,
    /// `gleba_moisture`.
    pub moisture: f64,
    /// `gleba_aux`, which is the `aux` property.
    pub aux: f64,
    /// `gleba_temperature`.
    pub temperature: f64,
    /// `gleba_temperature_normalised`.
    pub temperature_normalised: f64,
    /// `gleba_plants_noise`.
    pub plants_noise: f64,
    /// `gleba_plants_noise_b`.
    pub plants_noise_b: f64,
    /// `gleba_rockpools`.
    pub rockpools: f64,
    /// `gleba_rockpools_pitrock`, which carries the `(elevation > 20)` factor.
    pub rockpools_pitrock: f64,
    /// `gleba_fertile_solid`.
    pub fertile_solid: f64,
    /// `gleba_fertile_spots_coastal`.
    pub fertile_spots_coastal: f64,
}

/// A multioctave noise with Gleba's usual `output_scale = 1`.
fn noise(
    seed0: u32,
    seed1: u32,
    octaves: f64,
    persistence: f64,
    input_scale: f64,
    output_scale: f64,
) -> Prepared {
    Prepared::new(&MultioctaveParams {
        seed0,
        seed1,
        octaves,
        persistence: f32r(persistence),
        input_scale: f32r(input_scale),
        output_scale: f32r(output_scale),
    })
}

/// `seed1 = 1000000`, shared by seven of the noises.
const SEED1_SHARED: u32 = 1_000_000;

/// The per-render state of the terrain fields: every multioctave table, the
/// starting cones and the spot-region cache of `gleba_fertile_spots_coastal_raw`.
pub struct GlebaTerrain {
    seed0: u32,
    vars: GlebaSeedVars,
    water_size: f64,
    starting: GlebaStarting,
    starting_positions: Vec<Point>,

    wobble_x: Prepared,
    wobble_y: Prepared,
    wobble_small_x: Prepared,
    wobble_small_y: Prepared,
    aux_pattern: Prepared,
    aux_mutator_large: Prepared,
    cover_a: Prepared,
    cover_b: Prepared,
    rockpools_main: Prepared,
    rockpools_mask: Prepared,
    temperature: Prepared,
    tri: [Prepared; 3],
    high_frequency: Prepared,
    peaks: Prepared,
    ridges_small: Prepared,
    mud_basins: Prepared,
    mud_channels: Prepared,
    fertile_wobble_x: Prepared,
    fertile_wobble_y: Prepared,
    fertile_solid: Prepared,
    plants_a: Prepared,
    plants_b: Prepared,
    plants_b_a: Prepared,
    plants_b_b: Prepared,

    spot_cache: SpotRegionCache<()>,
}

impl GlebaTerrain {
    #[must_use]
    pub fn new(seed0: u32, controls: &GlebaControls) -> Self {
        let vars = GlebaSeedVars::new(seed0);
        let n = |seed1, octaves, persistence, input_scale| {
            noise(seed0, seed1, octaves, persistence, input_scale, 1.0)
        };
        let f32div = |a: f64, b: f64| f32r(a / b);
        // `input_scale = 1/300*control:gleba_water:frequency`.
        let tri_scale = f32r(f32div(1.0, 300.0) * controls.water_frequency);
        let tri = |seed1| n(seed1, 3.0, 0.65, tri_scale);
        // `1/60*slider_rescale(gleba_water_frequency, 3)` with
        // `gleba_water_frequency = slider_rescale(control:gleba_water:frequency, 2)`.
        let water_frequency = f64::from(slider_rescale(controls.water_frequency, 2.0));
        let peaks_scale = f32r(f32div(1.0, 60.0) * f64::from(slider_rescale(water_frequency, 3.0)));
        // `1/20 * control:gleba_plants:frequency` and `1/6 * ...`.
        let pf = controls.plants_frequency;
        let plants_20 = f32r(f32div(1.0, 20.0) * pf);
        let plants_6 = f32r(f32div(1.0, 6.0) * pf);
        Self {
            seed0,
            vars,
            water_size: controls.water_size,
            starting: GlebaStarting::new(&vars),
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],

            wobble_x: n(2000, 3.0, 0.7, f32div(1.0, 20.0)),
            wobble_y: n(3000, 3.0, 0.7, f32div(1.0, 20.0)),
            wobble_small_x: n(2000, 2.0, 0.7, f32div(1.0, 6.0)),
            wobble_small_y: n(3000, 2.0, 0.7, f32div(1.0, 6.0)),
            aux_pattern: n(7000, 7.0, 0.75, f32div(1.0, 70.0)),
            aux_mutator_large: n(8000, 4.0, 0.75, f32div(1.0, 30.0)),
            // `gleba_cover_noise`: the first term has `output_scale = 0.5`.
            cover_a: noise(seed0, 3500, 2.0, 0.7, f32div(1.0, 10.0), 0.5),
            cover_b: n(4500, 2.0, 0.7, f32div(1.0, 16.0)),
            rockpools_main: n(SEED1_SHARED, 4.0, 0.75, f32div(1.0, 45.0)),
            rockpools_mask: n(SEED1_SHARED, 3.0, 0.7, f32div(1.0, 75.0)),
            temperature: n(18000, 4.0, 0.65, f32div(1.0, 4.0)),
            tri: [tri(10000), tri(20000), tri(30000)],
            high_frequency: n(1, 3.0, 0.7, f32div(1.0, 18.0)),
            peaks: n(SEED1_SHARED, 3.0, 0.7, peaks_scale),
            ridges_small: n(SEED1_SHARED, 3.0, 0.7, f32div(1.0, 60.0)),
            mud_basins: n(SEED1_SHARED, 3.0, 0.7, f32div(1.0, 10.0)),
            mud_channels: n(SEED1_SHARED, 3.0, 0.5, f32div(1.0, 9.0)),
            fertile_wobble_x: n(3_000_000, 2.0, 0.5, f32div(1.0, 20.0)),
            fertile_wobble_y: n(4_000_000, 2.0, 0.5, f32div(1.0, 20.0)),
            fertile_solid: n(2_000_000, 2.0, 0.7, f32div(1.0, 16.0)),
            plants_a: n(700_000, 3.0, 0.8, plants_20),
            plants_b: n(200_000, 3.0, 0.8, plants_6),
            plants_b_a: n(750_000, 3.0, 0.8, plants_20),
            plants_b_b: n(250_000, 3.0, 0.8, plants_6),

            spot_cache: SpotRegionCache::new(),
        }
    }

    /// `gleba_fertile_spots_coastal_raw`'s `spot_noise` at a (warped) position.
    ///
    /// 80 candidates, spacing 128, region 1024, skip span 1, density 80, spot
    /// quantity 1000, radius 32, favorability 60, basement -0.5, basement radius
    /// 128. The density (80 per tile) puts the regional target at over 8e7, so
    /// the 80 spots of 1000 each are all kept.
    fn fertile_spot_noise(&self, sx: f64, sy: f64) -> f64 {
        let geometry = SpotGeometry {
            region_size: 1024.0,
            max_basement_radius: 128.0,
            basement_value: -0.5,
            cone: ConeArithmetic::GameBinary,
        };
        spot_cone_max(
            &geometry,
            sx,
            sy,
            |region_x, region_y| {
                self.spot_cache.get_or_select((), region_x, region_y, || {
                    let key = SpotRegionKey {
                        seed0: self.seed0,
                        seed1: 1,
                        region_x,
                        region_y,
                    };
                    select_spots(
                        &key,
                        &SpotSelectParams {
                            region_size: 1024,
                            candidate_spot_count: 80,
                            spacing: 128.0,
                            skip_span: 1,
                            skip_offset: 0,
                            hard_region_target_quantity: false,
                            density: &|_, _| 80.0,
                            quantity: &|_, _| 1000.0,
                            favorability: &|_, _| 60.0,
                            quantity_batch: None,
                        },
                    )
                })
            },
            |_: &SelectedSpot| 32.0,
        )
    }

    /// Evaluate every field at one position, in dependency order.
    #[must_use]
    pub fn eval_at(&self, at: At) -> GlebaTerrainFields {
        let (x, y) = (at.x(), at.y());
        let mult = area_multiplier();
        let direction = self.vars.direction;
        let start_angle = self.vars.angle;
        // `distance`, `x_from_start` and `y_from_start` at the origin spawn.
        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        let (xfs, yfs) = (x, y);
        // `distance / gleba_starting_area_multiplier`, which every spiral reads.
        let distance_over_mult = f32r(distance / mult);

        let wobble_x = f64::from(self.wobble_x.eval_at(at));
        let wobble_y = f64::from(self.wobble_y.eval_at(at));
        let wobble_small_x = f64::from(self.wobble_small_x.eval_at(at));
        let wobble_small_y = f64::from(self.wobble_small_y.eval_at(at));
        // `x + gleba_wobble_x * k`, in the Lua's order. Always a point.
        let warp = |v: f64, w: f64, k: f64| f32r(v + f32r(w * k));

        let cones = self.starting.eval(xfs, yfs, wobble_x);

        // --- gleba_fertile_spots_coastal_raw
        let fertile_wobble_x = f64::from(self.fertile_wobble_x.eval_at(at));
        let fertile_wobble_y = f64::from(self.fertile_wobble_y.eval_at(at));
        let spot_x = warp(x, fertile_wobble_x, 15.0);
        let spot_y = warp(y, fertile_wobble_y, 15.0);
        let fertile_raw = self.fertile_spot_noise(spot_x, spot_y);

        // --- gleba_rockpools
        let rockpools_mask_noise = f64::from(self.rockpools_mask.eval_at(at)).abs();
        let rockpools_main = clamp(
            f32r(1.0 - f32r(2.0 * f64::from(self.rockpools_main.eval_at(at)).abs())),
            0.0,
            1.0,
        );
        let rockpools_input = f32r(
            f32r(rockpools_mask_noise + min2(0.0, f32r(f32r(f32r(distance / 150.0)) - 2.0)))
                - max2(0.0, fertile_raw),
        );
        let rockpools_select = select(rockpools_input, 1.4, 3.0, 0.4, 0.0, 1.0);
        let rockpools = f32r(
            f32r(rockpools_main * rockpools_select)
                * f32r(1.0 + f32r(f32r(rockpools_mask_noise - 1.0) / 10.0)),
        );

        // --- gleba_cover_noise: `0.6 * a + 0.3 - abs(b)`
        let cover_noise = f32r(
            f32r(f32r(f32r(0.6) * f64::from(self.cover_a.eval_at(at))) + f32r(0.3))
                - f64::from(self.cover_b.eval_at(at)).abs(),
        );

        // --- gleba_aux
        let aux_pattern = f64::from(self.aux_pattern.eval(
            warp(warp(x, wobble_x, 15.0), wobble_small_x, 5.0),
            warp(warp(y, wobble_y, 15.0), wobble_small_y, 5.0),
        ));
        let starting_radius = clamp(
            f32r(1.0 - f32r(f32r(distance / mult) / 900.0)),
            0.0,
            f32r(0.9),
        );
        // `gleba_starting_angle - direction * (distance / 20 / mult - 15)`.
        let aux_angle =
            f32r(start_angle - f32r(direction * f32r(f32r(f32r(distance / 20.0) / mult) - 15.0)));
        let aux_rotated_y = f32r(rotate_y(xfs, yfs, aux_angle) + f32r(wobble_x * 10.0));
        let starting_aux = clamp(f32r(f32r(-aux_rotated_y / mult) / 200.0), -2.0, 2.0);
        let aux_mutator_large = f64::from(self.aux_mutator_large.eval_at(at));
        let aux_mutator = f32r(aux_mutator_large + f32r(f32r(0.1) * cover_noise));
        let aux_mutator_multiplier = f32r(
            f32r(1.0 + f32r(4.0 * select(aux_mutator, 1.4, 3.0, 0.5, 0.0, 1.0)))
                - f32r(f32r(0.9) * select(aux_mutator, -3.0, -1.4, 0.5, 0.0, 1.0)),
        );
        let aux_mutated = clamp(f32r(aux_pattern * aux_mutator_multiplier), -3.0, 3.0);
        let aux_blend = lerp_f32(aux_mutated, starting_aux, starting_radius);
        let aux = clamp(
            f32r(f32r(0.5 + f32r(0.5 * aux_blend)) - min2(f32r(0.2), rockpools)),
            0.0,
            1.0,
        );

        // --- gleba_temperature_normalised, gleba_temperature
        let temperature_noise = f64::from(
            self.temperature
                .eval(warp(x, wobble_x, 6.0), warp(y, wobble_y, 6.0)),
        );
        let temperature_normalised = clamp(f32r(f32r(0.8) * temperature_noise), -1.0, 1.0);
        let temperature = f32r(10.0 + f32r(temperature_normalised * 10.0));

        // --- gleba_tri_ridge
        let tri_x = warp(x, wobble_x, 6.0);
        let tri_y = warp(y, wobble_y, 6.0);
        let tri_value = |p: &Prepared| f32r(1.0 + f64::from(p.eval(tri_x, tri_y)));
        let (tri_a, tri_b, tri_c) = (
            tri_value(&self.tri[0]),
            tri_value(&self.tri[1]),
            tri_value(&self.tri[2]),
        );
        let (tri_ab, tri_ac, tri_bc) = (max2(tri_a, tri_b), max2(tri_a, tri_c), max2(tri_b, tri_c));
        let flag = |b: bool| if b { 1.0 } else { 0.0 };
        let tri_ridge = f32r(
            f32r(0.5)
                * f32r(
                    f32r(
                        f32r(flag(tri_bc < tri_a) * f32r(tri_a - tri_bc))
                            + f32r(flag(tri_ac < tri_b) * f32r(tri_b - tri_ac)),
                    ) + f32r(flag(tri_ab < tri_c) * f32r(tri_c - tri_ab)),
                ),
        );

        // --- the starting bridges
        let bridge = |sign: f64| {
            // `gleba_starting_angle +- direction * (distance / mult / 16 - 15)`.
            let angle = f32r(
                start_angle
                    + f32r(sign * f32r(direction * f32r(f32r(distance_over_mult / 16.0) - 15.0))),
            );
            let rx = f32r(rotate_x(xfs, yfs, angle) + f32r(wobble_x * 10.0));
            let ry = f32r(rotate_y(xfs, yfs, angle) + f32r(wobble_y * 10.0));
            // `sin(ry / 64 / mult)`, then `direction * sin * 64 * mult`.
            let sine = vm_sin(f32r(f32r(ry / 64.0) / mult));
            let swing = f32r(f32r(f32r(direction * sine) * 64.0) * mult);
            let across = f32r(f32r(rx / mult) - swing).abs();
            min2(
                f32r(1.0 - f32r(across / 110.0)),
                f32r(2.0 - f32r(distance_over_mult / 700.0)),
            )
        };
        // `spiral_angle` subtracts the direction term and `spiral_angle_b` adds it.
        let starting_bridge = bridge(-1.0);
        let starting_bridge_b = bridge(1.0);
        let starting_bridges = max2(starting_bridge, starting_bridge_b);

        // --- ridges and peaks
        let ridges_small_noise = f64::from(self.ridges_small.eval_at(at)).abs();
        let ridges = f32r(
            f32r(
                max2(
                    f32r(-tri_ridge * f32r(f32r(0.6) + f32r(f32r(self.water_size) / 3.0))),
                    f32r(starting_bridges - f32r(0.8)),
                ) * f32r(2.4),
            ) + f32r(f32r(0.2) * ridges_small_noise),
        );
        let peaks_noise = f64::from(
            self.peaks
                .eval(warp(x, wobble_x, 10.0), warp(y, wobble_y, 10.0)),
        );
        let peaks = f32r(peaks_noise + ridges);
        let peaks_terrace = terrace(
            min2(150.0, f32r(-25.0 + f32r(peaks * 250.0))),
            40.0,
            20.0,
            0.2,
        );
        let ridge_terrace = terrace(
            min2(80.0, f32r(110.0 + f32r(ridges * 500.0))),
            40.0,
            20.0,
            0.2,
        );
        let terraces_combined = max(&[
            ridge_terrace,
            peaks_terrace,
            f32r(25.0 + f32r(22.0 * ridges)),
        ]);

        // --- gleba_elevation_common
        let starting_area = f32r(
            max(&[
                f32r(-30.0 * clamp(f32r(cones.lakes * 2.0), 0.0, 1.0)),
                f32r(5.0 * min2(f32r(cones.lowlands * 2.0), 1.0)),
                f32r(130.0 * min2(f32r(cones.highlands * 2.0), 1.0)),
                f32r(80.0 * min2(f32r(cones.midlands * 2.0), 1.0)),
                f32r(70.0 * min2(f32r(f32r(starting_bridges - 0.5) * 3.0), 1.0)),
            ]) + f32r(6.0 * ridges_small_noise),
        );
        let rockpool_elevation = lerp_f32(
            lerp_f32(20.0, 80.0, flag(rockpools < f32r(0.3))),
            250.0,
            flag(rockpools < f32r(0.01)),
        );
        let blend = clamp(
            f32r(f32r(1.7) - f32r(f32r(distance_over_mult) / 500.0)),
            0.0,
            1.0,
        );
        let high_frequency = f64::from(self.high_frequency.eval_at(at));
        let main_blend = f32r(
            min2(
                rockpool_elevation,
                lerp_f32(terraces_combined, starting_area, blend),
            ) + f32r(3.0 * f32r(0.5 - high_frequency.abs())),
        );
        let knockout = clamp(
            f32r(max2(cones.enemies_safe, cones.enemies) * 2.0),
            0.0,
            1.0,
        );
        let elevation_common = lerp_f32(main_blend, -1.0, knockout);

        // --- gleba_elevation
        let aux_high_contrast = clamp(f32r(f32r(10.0 * f32r(aux - 0.5)) + 0.5), 0.0, 1.0);
        let aux_adjustment_peak = pos_peak(aux_high_contrast, 0.5, 0.5);
        let mud_basins = f32r(1.0 - f64::from(self.mud_basins.eval_at(at)).abs());
        let mud_channels = f64::from(self.mud_channels.eval_at(at)).abs();
        let mixed_mud_noise = lerp_f32(
            f32r(-8.0 + f32r(16.0 * mud_basins)),
            f32r(-12.0 + f32r(16.0 * mud_channels)),
            aux_high_contrast,
        );
        let transition_adjusted_mud_noise = f32r(
            f32r(mixed_mud_noise * f32r(1.0 + f32r(f32r(0.3) * aux_adjustment_peak)))
                + f32r(f32r(0.1) * aux_adjustment_peak),
        );
        let lowland_elevation = f32r(
            clamp(
                f32r(f32r(elevation_common * f32r(0.5)) + transition_adjusted_mud_noise),
                -1.5,
                f32r(19.9),
            ) + f32r(f32r(0.15) * transition_adjusted_mud_noise),
        );
        let lowland_mask = select(elevation_common, -5.0, 20.0, 1.0, 0.0, 1.0);
        let elevation =
            poison::f64_result(lerp_f32(elevation_common, lowland_elevation, lowland_mask));

        // --- gleba_moisture
        let pitrock = f32r(select(rockpools, 0.05, 0.6, 0.05, 0.0, 1.0) * flag(elevation > 20.0));
        let moisture_base = clamp(
            f32r(
                1.0 - min2(
                    f32r(f32r(0.25) + f32r(elevation_common / 80.0)),
                    f32r(f32r(0.5) + f32r(f32r(elevation_common - 20.0) / 400.0)),
                ),
            ),
            0.0,
            1.0,
        );
        let moisture = lerp_f32(moisture_base, f32r(0.35), min2(1.0, f32r(pitrock * 5.0)));

        // --- gleba_fertile_spots_coastal and gleba_fertile_solid
        let exclude_middle = f32r(f32r(distance_over_mult / 150.0) - f32r(2.2));
        let below = max2(0.0, f32r(f32r(-f32r(elevation + 2.0)) / 5.0));
        let above = max2(0.0, f32r(f32r(elevation - 10.0) / 5.0));
        let fertile_spots_coastal = max2(
            min2(1.0, f32r(cones.fertile * 4.0)),
            f32r(f32r(min2(exclude_middle, fertile_raw) - below) - above),
        );
        let fertile_solid = f32r(
            f32r(2.0 * f64::from(self.fertile_solid.eval_at(at)).abs()) * fertile_spots_coastal,
        );

        // --- gleba_plants_noise and gleba_plants_noise_b
        let plants_noise = f32r(
            f32r(f64::from(self.plants_a.eval_at(at)) * f64::from(self.plants_b.eval_at(at))).abs(),
        );
        let plants_noise_b = f32r(
            f32r(f64::from(self.plants_b_a.eval_at(at)) * f64::from(self.plants_b_b.eval_at(at)))
                .abs(),
        );

        GlebaTerrainFields {
            elevation,
            moisture: poison::f64_result(moisture),
            aux: poison::f64_result(aux),
            temperature: poison::f64_result(temperature),
            temperature_normalised,
            plants_noise,
            plants_noise_b,
            rockpools,
            rockpools_pitrock: pitrock,
            fertile_solid,
            fertile_spots_coastal,
        }
    }
}
