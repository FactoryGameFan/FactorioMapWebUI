//! The two Nauvis cliff fields, ported from `src/noise/cliffs/cliffFields.ts`.
//!
//! - `cliff_elevation_nauvis` decides which band a cliff sits on.
//! - `cliffiness_nauvis` is the 0/10 gate for whether a cell may carry a cliff
//!   at all.
//!
//! Both are compositions of parts this crate already carries and already
//! grades, so nothing new is derived here. See
//! `docs/nauvis-cliff-rock-fields-port-survey.md` for the dependency inventory
//! and the measurements behind the tests.
//!
//! ## The gate is DISCRETE, and its margins were measured
//!
//! `cliffiness_nauvis` is `(main_cliffiness >= cliff_cutoff) * 10`, so every
//! output is exactly 0 or 10 and a mismatch against the game is a real term or
//! cutoff bug rather than f32 drift. That also means CLAUDE.md's discrete-output
//! rule applies: a one-ULP numeric perturbation changes which side of a
//! comparison a value falls on essentially never.
//!
//! How near it comes was measured on 2026-08-26 over all 1024 fixture positions
//! at both seeds, rather than assumed. The closest any position sits to the
//! cutoff is **2.344133e-4** (seed 777771) and **3.402456e-3** (seed 123456);
//! nothing at either seed is within 1e-5. One f32 ULP at the cutoff's 0.707 is
//! about 6e-8, so a single bent leaf is some 3,900 ULPs short of flipping the
//! gate. See [`crate::poison`] and `scripts/verify-rust.sh` for what
//! that meant for the hook.

use crate::basis_noise::{tables_from_seed, BasisNoiseTables};
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{min, min2};
use crate::eval::primitives::{basis_noise_expr, BasisExprParams};
use crate::expressions::elevation_nauvis::{ElevationNauvis, ElevationNauvisParams};
use crate::expressions::nauvis_shared::{NauvisShared, NauvisSharedParams};

use super::catalog::{
    cliff_slider_to_linear, modified_elevation_interval, modified_richness, CliffControls,
    CliffSettings, LOW_FREQ_CLIFFINESS_SEED1,
};

/// Free variables of the Nauvis cliff fields.
pub struct CliffFieldParams {
    /// Map seed (= `map_seed` / `seed0`).
    pub seed0: u32,
    /// The `nauvis_cliff` autoplace control.
    pub controls: CliffControls,
    /// The cliff-related `MapGenSettings` fields.
    pub settings: CliffSettings,
    /// `control:water:frequency`; 1 at the default. The RAW control.
    pub segmentation_multiplier: f64,
    /// `10 * log2(control:water:size)`; 0 at the default. Reaches the tree
    /// through `elevation_nauvis_no_cliff`.
    pub water_level: f64,
    /// Spawn points for `distance`.
    pub starting_positions: Vec<Point>,
    /// Lake points for `starting_lake_distance`. `None` derives the game's own.
    pub starting_lake_positions: Option<Vec<Point>>,
}

impl CliffFieldParams {
    /// The game's defaults, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            controls: CliffControls::defaults(),
            settings: CliffSettings::defaults(),
            segmentation_multiplier: 1.0,
            water_level: 0.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            starting_lake_positions: None,
        }
    }
}

/// `cliff_elevation_nauvis` and `cliffiness_nauvis`, with every table and
/// octave stack derived once.
///
/// Built together because they share a [`NauvisShared`]: the elevation reads
/// `hills` and `cliff_level`, and the gate reads `cliff_ringbreak`,
/// `forest_path_billows`, `bridge_billows` and `nauvis_seg` off the same layer.
/// Building two would derive every table twice for no gain.
pub struct NauvisCliffFields {
    shared: NauvisShared,
    no_cliff_elevation: ElevationNauvis,
    low_freq_tables: BasisNoiseTables,
    low_freq_params: BasisExprParams,
    starting_positions: Vec<Point>,
    segmentation_multiplier: f64,
    /// `min(slider_to_linear(cliff_frequency, -1.7, 1.7),
    ///      slider_to_linear(cliff_richness, -1, 1))` - position-independent.
    low_freq_lever: f64,
    /// `2 * (0.5 - 0.5*slider_to_linear(cliff_richness, -1, 1))^1.5`.
    cliff_cutoff: f64,
}

impl NauvisCliffFields {
    #[must_use]
    pub fn new(params: &CliffFieldParams) -> Self {
        let seed0 = params.seed0;
        let seg = params.segmentation_multiplier;
        let shared = NauvisShared::new(&NauvisSharedParams {
            seed0,
            segmentation_multiplier: seg,
        });
        let nauvis_seg = shared.nauvis_seg;

        // Effective levers.
        let interval = modified_elevation_interval(
            params.settings.cliff_elevation_interval,
            params.controls.frequency,
        );
        let cliff_richness =
            modified_richness(params.settings.richness, params.controls.continuity);
        let cliff_frequency = 40.0 / interval;

        // `min2`, not `f64::min`, and in the TypeScript's own argument order -
        // see `eval::math::min2` for why that matters on signed zero.
        let low_freq_lever = min2(
            cliff_slider_to_linear(cliff_frequency, -1.7, 1.7),
            cliff_slider_to_linear(cliff_richness, -1.0, 1.0),
        );
        let cliff_gap_size = 0.5 - 0.5 * cliff_slider_to_linear(cliff_richness, -1.0, 1.0);
        // `**` in the TypeScript, which is `Math.pow` - exact, not the noise
        // machine's fastapprox. This resolves on the prototype side, the same
        // place `slider_rescale`'s `^` does.
        let cliff_cutoff = 2.0 * cliff_gap_size.powf(1.5);

        Self {
            shared,
            no_cliff_elevation: ElevationNauvis::new(&ElevationNauvisParams {
                seed0,
                water_level: params.water_level,
                segmentation_multiplier: seg,
                starting_positions: params.starting_positions.clone(),
                starting_lake_positions: params.starting_lake_positions.clone(),
                with_cliff_elevation: false,
            }),
            low_freq_tables: tables_from_seed(seed0, LOW_FREQ_CLIFFINESS_SEED1),
            low_freq_params: BasisExprParams {
                seed0,
                seed1: LOW_FREQ_CLIFFINESS_SEED1,
                input_scale: nauvis_seg / 500.0,
                output_scale: 0.51,
                offset_x: 0.0,
            },
            starting_positions: params.starting_positions.clone(),
            segmentation_multiplier: seg,
            low_freq_lever,
            cliff_cutoff,
        }
    }

    /// `cliff_elevation_nauvis(x, y) = 10 + 30 * (hills - cliff_level)`.
    #[must_use]
    pub fn cliff_elevation(&self, x: f64, y: f64) -> f64 {
        10.0 + 30.0 * (self.shared.hills(x, y) - self.shared.cliff_level(x, y))
    }

    /// `main_cliffiness`, the `min` of the six sub-terms.
    ///
    /// `pub(crate)` rather than `pub`: the gate above it is what every consumer
    /// wants, and the only reader of this is
    /// `the_cliffiness_gate_sits_far_enough_from_its_cutoff_that_a_bent_leaf_cannot_flip_it`,
    /// which measures how far these values sit from the cutoff. Widening it to
    /// `pub` would put a method on the crate's surface for one test's sake.
    #[must_use]
    pub(crate) fn main_cliffiness(&self, x: f64, y: f64) -> f64 {
        let base = (self.shared.cliff_ringbreak(x, y) - 0.01) * 60.0;
        let forest = (self.shared.forest_path_billows(x, y) - 0.03) * 12.0;
        let bridge = (self.shared.bridge_billows(x, y) - 0.05) * 15.0;
        let elev = (self.no_cliff_elevation.eval(x, y) - 4.0) / 2.0;

        // The PLAIN segmentation multiplier, not `nauvis_seg`, and an UNCAPPED
        // distance: the game's expression carries no `maximum_distance`, which
        // the TypeScript records as oracle-confirmed past 14,000 tiles.
        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        let start_area = -2.0 + distance * self.segmentation_multiplier / 120.0;

        // This term reads `nauvis_seg / 500` (baked into `low_freq_params`),
        // where `start_area` above reads the plain multiplier. The two really
        // do disagree on which one they take.
        let low_freq = 1.5
            + basis_noise_expr(x, y, &self.low_freq_params, &self.low_freq_tables)
            + self.low_freq_lever;

        // The variadic form, because the TypeScript is one six-argument
        // `Math.min` rather than a fold - and `min` carries JavaScript's NaN
        // and signed-zero semantics, which `f64::min` does not.
        min(&[base, forest, bridge, elev, start_area, 4.0 * low_freq])
    }

    /// `cliffiness_nauvis(x, y)` - exactly 0 or 10.
    ///
    /// **The [`crate::poison::bool_result`] hook here is load-bearing, and that
    /// was measured rather than argued from the rule.** Built with
    /// `--features poison` and no hook on this line,
    /// `reproduces_the_games_nauvis_cliffiness_gate_exactly_at_both_seeds`
    /// stayed GREEN at 0 mismatches while its sibling
    /// `..._nauvis_cliff_elevation_at_both_seeds`, which shares
    /// [`NauvisShared`], fell from 355 exact to 227. So the whole chain beneath
    /// this really does move under numeric poison, and not one of the 2,048
    /// gate answers changes with it - the margin table in the module docs says
    /// why. That is CLAUDE.md's discrete-output rule reproduced on a new field
    /// rather than assumed from it.
    #[must_use]
    pub fn cliffiness(&self, x: f64, y: f64) -> f64 {
        if crate::poison::bool_result(self.main_cliffiness(x, y) >= self.cliff_cutoff) {
            10.0
        } else {
            0.0
        }
    }

    /// The cutoff this instance's levers produce. Read by the tests.
    #[must_use]
    pub fn cliff_cutoff(&self) -> f64 {
        self.cliff_cutoff
    }
}
