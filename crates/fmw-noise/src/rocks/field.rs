//! The Nauvis rock probability field, ported from
//! `src/noise/rocks/rockField.ts`.
//!
//! Three prototypes compete per tile - `huge-rock`, `big-rock` and
//! `big-sand-rock` - and the overlay rolls against
//! `clamp(max of the three, 0, 1)`.
//!
//! **Why exactly three.** `base/prototypes/decorative/decoratives.lua` gives
//! eight prototypes `autoplace.control = "rocks"`, but five of them are
//! `type = "optimized-decorative"`. Decoratives come from a different pass and
//! are not entities, so they neither appear in the game's entity counts nor
//! compete in the entity placement arbitration. The three that are
//! `type = "simple-entity"` are exactly these.
//!
//! ## What the fixture grades, and what it cannot
//!
//! `oracle-rock-density` holds the game's named `rock_density` expression -
//! [`NauvisRockFields::rock_density`] - and NOT the clamped max above it. That
//! distinction has teeth: at all 26 fixture positions the clamped field returns
//! exactly 0, because every one of the three probabilities is negative there
//! (the largest is about -0.097). So tier 1 grades the intermediate and the
//! probabilities above it belong to tier 2. See
//! `docs/nauvis-cliff-rock-fields-port-survey.md`.

use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{clamp, f32r, max, min2, slider_rescale};
use crate::expressions::nauvis_climate::{Aux, AuxParams, Moisture, MoistureParams};
use crate::multioctave_noise::{MultioctaveParams, Prepared};

use super::catalog::{RockControls, ROCK_SEED1};

/// Free variables of the Nauvis rock field.
pub struct RockFieldParams {
    /// Map seed (= `map_seed` / `seed0`).
    pub seed0: u32,
    /// The `rocks` autoplace control.
    pub controls: RockControls,
    /// `control:water:frequency`; 1 at the default. Threads into the shared
    /// noise under `moisture` and `aux`.
    pub segmentation_multiplier: f64,
    /// `control:moisture:frequency`.
    pub moisture_frequency: f64,
    /// `control:moisture:bias`.
    pub moisture_bias: f64,
    /// `control:aux:frequency`.
    pub aux_frequency: f64,
    /// `control:aux:bias`.
    pub aux_bias: f64,
    /// `control:starting_area_moisture:size`.
    pub starting_area_moisture_size: f64,
    /// `control:starting_area_moisture:frequency`.
    pub starting_area_moisture_frequency: f64,
    /// Spawn points for `distance`.
    pub starting_positions: Vec<Point>,
}

impl RockFieldParams {
    /// The game's defaults, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            controls: RockControls::defaults(),
            segmentation_multiplier: 1.0,
            moisture_frequency: 1.0,
            moisture_bias: 0.0,
            aux_frequency: 1.0,
            aux_bias: 0.0,
            starting_area_moisture_size: 1.0,
            starting_area_moisture_frequency: 1.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
        }
    }
}

/// The three prototypes' autoplace probabilities at one tile, unclamped.
///
/// A small `Copy` struct rather than the TypeScript's closure-scratch trick.
/// That shape exists there so `density` allocates nothing on the per-tile hot
/// path; returning this by value costs nothing and needs no scratch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RockProbabilities {
    /// `huge-rock`.
    pub huge: f64,
    /// `big-rock`.
    pub big: f64,
    /// `big-sand-rock`.
    pub sand: f64,
}

/// The Nauvis rock fields, with every table and octave stack derived once.
pub struct NauvisRockFields {
    noise: Prepared,
    moisture: Moisture,
    aux: Aux,
    starting_positions: Vec<Point>,
    /// `control:rocks:size`, the OUTER multiplier.
    size: f64,
    /// `0.75 * (slider_rescale(size, 1.5) - 1)` - the size-dependent,
    /// position-independent tail of `rock_noise`, hoisted out of the per-pixel
    /// loop. The `0.25` is NOT folded into it: the Lua is
    /// `multioctave + 0.25 + 0.75 * (...)`, which adds left to right, so the
    /// `0.25` meets the noise first (#521).
    size_term: f64,
}

impl NauvisRockFields {
    #[must_use]
    pub fn new(params: &RockFieldParams) -> Self {
        let seed0 = params.seed0;
        let freq = params.controls.frequency;
        let size = params.controls.size;

        Self {
            // `control:rocks:frequency` scales the noise INPUT, not the
            // probability, and nothing else reads it.
            noise: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: ROCK_SEED1,
                octaves: 4.0,
                persistence: 0.9,
                input_scale: f32r(f32r(0.15) * f32r(freq)),
                output_scale: 1.0,
            }),
            moisture: Moisture::new(&MoistureParams {
                seed0,
                segmentation_multiplier: params.segmentation_multiplier,
                moisture_frequency: params.moisture_frequency,
                moisture_bias: params.moisture_bias,
                starting_area_moisture_size: params.starting_area_moisture_size,
                starting_area_moisture_frequency: params.starting_area_moisture_frequency,
                starting_positions: params.starting_positions.clone(),
            }),
            aux: Aux::new(&AuxParams {
                seed0,
                segmentation_multiplier: params.segmentation_multiplier,
                frequency: params.aux_frequency,
                bias: params.aux_bias,
            }),
            starting_positions: params.starting_positions.clone(),
            size,
            size_term: f32r(0.75 * f32r(f64::from(slider_rescale(size, 1.5)) - 1.0)),
        }
    }

    /// The game's named `rock_density` expression:
    /// `rock_noise - max(0, 1.1 - distance/32)`.
    ///
    /// This is what `oracle-rock-density` holds, and it is NOT
    /// [`Self::density`].
    #[must_use]
    pub fn rock_density(&self, x: f64, y: f64) -> f64 {
        // One f32 step at a time, in the Lua's order (#521).
        let rock_noise = f32r(f32r(f64::from(self.noise.eval(x, y)) + 0.25) + self.size_term);
        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        f32r(rock_noise - max(&[0.0, f32r(f32r(1.1) - f32r(distance / 32.0))]))
    }

    /// The three probabilities at one tile, unclamped.
    #[must_use]
    pub fn at(&self, x: f64, y: f64) -> RockProbabilities {
        let rock_density = self.rock_density(x, y);
        let size = self.size;

        let m = self.moisture.eval(x, y);
        let moist_band = range_select_base_f32(m, 0.35, 1.0, 0.2, -10.0, 0.0);

        let a = self.aux.eval(x, y);
        let sand_band = min2(
            range_select_base_f32(a, 0.3, 1.0, 0.3, -10.0, 0.0),
            range_select_base_f32(m, 0.0, 0.3, 0.2, -10.0, 0.0),
        );

        // `multiplier * control * (region_box + rock_density - penalty)`, each
        // operation an f32 step: the two multipliers first, then the sum.
        let probability = |multiplier: f64, band: f64, penalty: f64| {
            f32r(
                f32r(f32r(multiplier) * f32r(size))
                    * f32r(f32r(band + rock_density) - f32r(penalty)),
            )
        };
        RockProbabilities {
            huge: probability(0.07, moist_band, 1.7),
            big: probability(0.17, moist_band, 1.6),
            sand: probability(0.1, sand_band, 1.6),
        }
    }

    /// `clamp(max(huge, big, sand), 0, 1)` - what the overlay's placement roll
    /// rolls against.
    #[must_use]
    pub fn density(&self, x: f64, y: f64) -> f64 {
        let p = self.at(x, y);
        // `max` in the TypeScript's own argument order, for the signed-zero
        // reason `eval::math::max` records.
        clamp(max(&[p.huge, p.big, p.sand]), 0.0, 1.0)
    }
}

/// `range_select_base(input, from, to, slope, min, max)` one f32 step at a
/// time: `clamp(min(input - from, to - input) / slope, min, max)`.
///
/// The shared [`crate::eval::math::range_select_base`] rounds nothing between
/// steps; Vulcanus owns its callers, so the f32 form lives here (#521).
fn range_select_base_f32(input: f64, from: f64, to: f64, slope: f64, lo: f64, hi: f64) -> f64 {
    let rising = f32r(input - f32r(from));
    let falling = f32r(f32r(to) - input);
    clamp(
        f32r(min2(rising, falling) / f32r(slope)),
        f32r(lo),
        f32r(hi),
    )
}
