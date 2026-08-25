//! The three climate expressions, ported from `src/noise/expressions/aux.ts`,
//! `moisture.ts` and `temperature.ts`.
//!
//! `aux` (= `aux_nauvis`, the "terrain type" axis), `moisture` (=
//! `moisture_nauvis`) and `temperature` (= `temperature_basic`). Together with
//! an elevation they are what the tile catalog argmaxes over, so all three have
//! to land before any Nauvis tile can be resolved.
//!
//! ## One module for three expressions, and the reason is Windows
//!
//! The TypeScript keeps them in three files and this port otherwise mirrors
//! that 1:1. It cannot here: `aux` is a reserved device name on Windows, so
//! `aux.rs` is a file that cannot be checked out there at all. Grouping the
//! three is the cheapest way around it, and they are the natural group anyway.
//!
//! `temperature_basic` is NOT Nauvis-specific despite the module's name - it is
//! a shared program, and Nauvis is simply the only planet in this port that
//! reaches it today. If a second one does, move it rather than duplicating it.
//!
//! ## Two of the three read the shared layer, and one reads nothing
//!
//! `aux` needs `nauvis_plateaus`; `moisture` needs that plus `nauvis_hills`,
//! `nauvis_bridge_billows` and `forest_path_billows`. `temperature` composes
//! nothing at all, which is why it is the one field in the Nauvis port that
//! reaches the game bit-exactly.
//!
//! ## `moisture`'s starting-area levers are DEGENERATE at their defaults
//!
//! `slider_to_linear(1, -0.5, 0.5)` is 0, so `starting_bias_change` is 0 and
//! the whole starting-area blend collapses to `base_bias` everywhere. That is a
//! real path rather than dead code - it is what the fixture exercises - but it
//! means the fixture grades none of the blend. Anything changed in there has to
//! be graded by moving the slider, not by the oracle.

use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{clamp, lerp, max2, min, min2, slider_to_linear};
use crate::expressions::nauvis_shared::{NauvisShared, NauvisSharedParams};
use crate::quick_multioctave_noise::{
    octave_terms as quick_octave_terms, sum_octaves as quick_sum_octaves, QuickMultioctaveParams,
    QuickOctaves,
};

/// `sea_level_temperature`.
const SEA_LEVEL_TEMPERATURE: f64 = 15.0;

// ---------------------------------------------------------------------------
// aux
// ---------------------------------------------------------------------------

/// Free variables of `aux_nauvis`.
#[derive(Clone, Copy, Debug)]
pub struct AuxParams {
    /// Map seed.
    pub seed0: u32,
    /// `control:water:frequency`; threads into `nauvis_plateaus`.
    pub segmentation_multiplier: f64,
    /// `control:aux:frequency`.
    pub frequency: f64,
    /// `control:aux:bias`.
    pub bias: f64,
}

impl AuxParams {
    /// The game's default controls.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            segmentation_multiplier: 1.0,
            frequency: 1.0,
            bias: 0.0,
        }
    }
}

/// `clamp(0.5 + bias + 0.06 * (plateaus - 0.4) + noise, 0, 1)`.
pub struct Aux {
    bias: f64,
    shared: NauvisShared,
    noise: QuickOctaves,
}

impl Aux {
    #[must_use]
    pub fn new(params: &AuxParams) -> Self {
        Self {
            bias: params.bias,
            shared: NauvisShared::new(&NauvisSharedParams {
                seed0: params.seed0,
                segmentation_multiplier: params.segmentation_multiplier,
            }),
            noise: quick_octave_terms(&QuickMultioctaveParams {
                seed0: params.seed0,
                seed1: 7,
                octaves: 4,
                input_scale: params.frequency / 2048.0,
                output_scale: 0.25,
                offset_x: 20_000.0 / params.frequency,
                octave_output_scale_multiplier: 0.5,
                // Three, not a half. `aux` is the one climate expression whose
                // octaves get COARSER as they go, which is why its noise reads
                // as continent-scale banding rather than as detail.
                octave_input_scale_multiplier: 3.0,
            }),
        }
    }

    /// Evaluate at one point.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f64 {
        clamp(
            0.5 + self.bias
                + 0.06 * (self.shared.plateaus(x, y) - 0.4)
                + f64::from(quick_sum_octaves(x, y, &self.noise)),
            0.0,
            1.0,
        )
    }
}

// ---------------------------------------------------------------------------
// moisture
// ---------------------------------------------------------------------------

/// Free variables of `moisture_nauvis`.
#[derive(Clone, Debug)]
pub struct MoistureParams {
    /// Map seed.
    pub seed0: u32,
    /// `control:water:frequency`; threads into the shared layer.
    pub segmentation_multiplier: f64,
    /// `control:moisture:frequency`.
    pub moisture_frequency: f64,
    /// `control:moisture:bias`.
    pub moisture_bias: f64,
    /// `control:starting_area_moisture:size`. Degenerate at 1 - see the module
    /// note.
    pub starting_area_moisture_size: f64,
    /// `control:starting_area_moisture:frequency`.
    pub starting_area_moisture_frequency: f64,
    /// Spawn points for the starting-area region distance (UNCAPPED, unlike the
    /// elevation tree's `starting_lake_distance`).
    pub starting_positions: Vec<Point>,
}

impl MoistureParams {
    /// The game's default controls, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            segmentation_multiplier: 1.0,
            moisture_frequency: 1.0,
            moisture_bias: 0.0,
            starting_area_moisture_size: 1.0,
            starting_area_moisture_frequency: 1.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
        }
    }
}

/// The most composed of the three: a base noise term, a starting-area bias
/// blend, and a cutout that pulls moisture down near cliffs and forest paths so
/// they are not swallowed by high-moisture biomes.
pub struct Moisture {
    base_bias: f64,
    starting_bias: f64,
    starting_area_moisture_frequency: f64,
    starting_positions: Vec<Point>,
    shared: NauvisShared,
    noise: QuickOctaves,
}

impl Moisture {
    #[must_use]
    pub fn new(params: &MoistureParams) -> Self {
        let base_bias = params.moisture_bias;
        // `slider_to_linear` is f32 per operation, so this is narrowed once
        // here and widened - not evaluated in f64 (#186, #270).
        let starting_bias_change = f64::from(slider_to_linear(
            params.starting_area_moisture_size,
            -0.5,
            0.5,
        ));
        Self {
            base_bias,
            starting_bias: lerp(
                base_bias,
                starting_bias_change,
                (2.0 * starting_bias_change).abs() * 1.1,
            ),
            starting_area_moisture_frequency: params.starting_area_moisture_frequency,
            starting_positions: params.starting_positions.clone(),
            shared: NauvisShared::new(&NauvisSharedParams {
                seed0: params.seed0,
                segmentation_multiplier: params.segmentation_multiplier,
            }),
            noise: quick_octave_terms(&QuickMultioctaveParams {
                seed0: params.seed0,
                seed1: 6,
                octaves: 4,
                input_scale: params.moisture_frequency / 256.0,
                output_scale: 0.125,
                offset_x: 30_000.0 / params.moisture_frequency,
                octave_output_scale_multiplier: 1.5,
                octave_input_scale_multiplier: 1.0 / 3.0,
            }),
        }
    }

    /// Evaluate at one point.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f64 {
        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        let starting_bias_region = clamp(
            2.0 - (self.starting_area_moisture_frequency / 400.0) * distance,
            0.0,
            1.0,
        );
        let moisture_adjusted_bias = lerp(self.base_bias, self.starting_bias, starting_bias_region);

        let moisture_main = clamp(
            0.4 + moisture_adjusted_bias + f64::from(quick_sum_octaves(x, y, &self.noise))
                - 0.08 * (self.shared.plateaus(x, y) - 0.6),
            0.0,
            1.0,
        );

        // Three different fields, three different knees and three different
        // gains. The smallest wins, so any one of them can open the cutout.
        let trees_forest_path_cutout = min(&[
            (self.shared.bridge_billows(x, y) - 0.07) * 5.0,
            (self.shared.hills(x, y) - 0.1) * 3.0,
            (self.shared.forest_path_billows(x, y) - 0.07) * 3.0,
        ]);

        max2(
            min2(moisture_main, 0.45),
            moisture_main - 0.2 * max2(0.0, 1.0 - trees_forest_path_cutout * 1.5),
        )
    }
}

// ---------------------------------------------------------------------------
// temperature
// ---------------------------------------------------------------------------

/// Free variables of `temperature_basic`.
#[derive(Clone, Copy, Debug)]
pub struct TemperatureParams {
    /// Map seed.
    pub seed0: u32,
    /// `control:temperature:frequency`.
    pub frequency: f64,
    /// `control:temperature:bias`.
    pub bias: f64,
}

impl TemperatureParams {
    /// The game's default controls.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            frequency: 1.0,
            bias: 0.0,
        }
    }
}

/// `clamp(15 + bias + noise, -20, 50)`.
pub struct Temperature {
    bias: f64,
    noise: QuickOctaves,
}

impl Temperature {
    #[must_use]
    pub fn new(params: &TemperatureParams) -> Self {
        Self {
            bias: params.bias,
            noise: quick_octave_terms(&QuickMultioctaveParams {
                seed0: params.seed0,
                seed1: 5,
                octaves: 4,
                input_scale: params.frequency / 32.0,
                output_scale: 1.0 / 20.0,
                offset_x: 40_000.0 / params.frequency,
                octave_output_scale_multiplier: 3.0,
                octave_input_scale_multiplier: 1.0 / 3.0,
            }),
        }
    }

    /// Evaluate at one point.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f64 {
        clamp(
            SEA_LEVEL_TEMPERATURE + self.bias + f64::from(quick_sum_octaves(x, y, &self.noise)),
            -20.0,
            50.0,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_starting_area_moisture_levers_are_inert_at_their_defaults() {
        // `slider_to_linear(1, -0.5, 0.5) == 0`, so the blend collapses and the
        // fixture grades none of it. Asserted so that the degeneracy is a
        // recorded property rather than something a later reader rediscovers
        // by finding the blend untested.
        assert_eq!(slider_to_linear(1.0, -0.5, 0.5), 0.0);
        let default = Moisture::new(&MoistureParams::defaults(123_456));
        assert_eq!(default.starting_bias, 0.0);

        let mut moved = MoistureParams::defaults(123_456);
        moved.starting_area_moisture_size = 4.0;
        let moved = Moisture::new(&moved);
        assert_ne!(
            moved.starting_bias, default.starting_bias,
            "moving the slider must reach the blend"
        );
        // And it must reach the OUTPUT near spawn, or the lever is wired to
        // nothing. Far away the region clamp is 0 and the two agree by design.
        assert_ne!(moved.eval(0.0, 0.0), default.eval(0.0, 0.0));
        assert_eq!(moved.eval(50_000.0, 0.0), default.eval(50_000.0, 0.0));
    }

    #[test]
    fn the_moisture_cutout_reads_all_three_fields() {
        // The cutout is a `min` of three terms with three different knees, so a
        // port that dropped one would still produce a plausible moisture map.
        // Each must be the winner somewhere on this grid.
        let m = Moisture::new(&MoistureParams::defaults(123_456));
        let (mut a, mut b, mut c) = (0usize, 0usize, 0usize);
        for i in -25i32..25 {
            for j in -25i32..25 {
                let (x, y) = (f64::from(i) * 53.5, f64::from(j) * 61.25);
                let terms = [
                    (m.shared.bridge_billows(x, y) - 0.07) * 5.0,
                    (m.shared.hills(x, y) - 0.1) * 3.0,
                    (m.shared.forest_path_billows(x, y) - 0.07) * 3.0,
                ];
                let lowest = min(&terms);
                if terms[0] == lowest {
                    a += 1;
                }
                if terms[1] == lowest {
                    b += 1;
                }
                if terms[2] == lowest {
                    c += 1;
                }
            }
        }
        // Frozen at the measured split. All three win a substantial share, so
        // dropping any one of them would move the field - which is the point:
        // a `min` of three terms is indistinguishable from a `min` of two
        // wherever the third never wins.
        assert_eq!((a, b, c), (541, 993, 966), "which cutout term wins");
    }

    #[test]
    fn aux_and_temperature_shift_by_exactly_their_bias_where_neither_clamp_bites() {
        // The biases are user controls that no oracle fixture moves off zero,
        // so this is the only thing grading them.
        //
        // The identity holds only where the UNBIASED field is off both bounds:
        // at a position `aux` already clamps to 0, adding a bias may leave it
        // at 0, and `min(base + bias, 1)` would be wrong. That is the
        // expression behaving correctly, so the test states the narrower true
        // thing and freezes how much of the grid it covers.
        let base_aux = Aux::new(&AuxParams::defaults(123_456));
        let mut biased = AuxParams::defaults(123_456);
        biased.bias = 0.1;
        let biased_aux = Aux::new(&biased);

        let base_t = Temperature::new(&TemperatureParams::defaults(123_456));
        let mut biased_tp = TemperatureParams::defaults(123_456);
        biased_tp.bias = 5.0;
        let biased_t = Temperature::new(&biased_tp);

        let mut interior = 0usize;
        let mut saturated = 0usize;
        for i in -20i32..20 {
            for j in -20i32..20 {
                let (x, y) = (f64::from(i) * 71.5, f64::from(j) * 83.25);
                let a = base_aux.eval(x, y);
                let t = base_t.eval(x, y);
                if a > 0.0 && a + 0.1 < 1.0 && t > -20.0 && t + 5.0 < 50.0 {
                    interior += 1;
                    assert!((biased_aux.eval(x, y) - (a + 0.1)).abs() < 1e-9);
                    assert!((biased_t.eval(x, y) - (t + 5.0)).abs() < 1e-9);
                } else {
                    saturated += 1;
                }
                // Monotonic everywhere, clamps included.
                assert!(biased_aux.eval(x, y) >= a);
                assert!(biased_t.eval(x, y) >= t);
            }
        }
        // Frozen both ways. 1,501 of 1,600 grid points are off both bounds, so
        // the identity is graded over nearly all of them; the other 99 are the
        // clamp doing its job and are the reason the identity is stated
        // narrowly rather than as `min(base + bias, hi)`.
        assert_eq!(interior, 1501, "points where neither clamp bites");
        assert_eq!(saturated, 99, "points where one of the clamps bites");
    }

    #[test]
    fn every_field_stays_inside_its_clamp_under_an_extreme_bias() {
        let mut hot = TemperatureParams::defaults(123_456);
        hot.bias = 1000.0;
        let mut cold = TemperatureParams::defaults(123_456);
        cold.bias = -1000.0;
        let (hot, cold) = (Temperature::new(&hot), Temperature::new(&cold));
        let mut wet = AuxParams::defaults(123_456);
        wet.bias = 10.0;
        let wet = Aux::new(&wet);
        for i in -10i32..10 {
            let (x, y) = (f64::from(i) * 101.5, f64::from(i) * -97.25);
            assert_eq!(hot.eval(x, y), 50.0);
            assert_eq!(cold.eval(x, y), -20.0);
            assert_eq!(wet.eval(x, y), 1.0);
        }
    }
}
