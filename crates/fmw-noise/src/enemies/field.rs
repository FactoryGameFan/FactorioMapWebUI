//! `enemy_base_probability`, ported from `src/noise/enemies/enemyBaseField.ts`.
//!
//! ```text
//! enemy_base_probability =
//!     spot_field + blob_term - 0.3
//!     + min(0, (20 / starting_area_radius) * distance - 20)
//!
//! spot_field = max(basement, max over nearby spots of (peak - dist*slope))
//! blob_term  = (basis(1/8) + basis(1/24) + 2*basis(1/64) - 0.5)
//!                * (spot_radius(distance) / 150)
//!                * (0.1 + 0.9*clamp(distance/3000, 0, 1))
//! ```
//!
//! ## This is the one Nauvis layer that needs a real cache
//!
//! Every other Nauvis chain in this crate evaluates top to bottom in one pass
//! and keeps intermediates in locals, because every read is at the same
//! `(x, y)`. This one reads selected spots from up to four neighbouring
//! regions, so it keeps a `RefCell<BTreeMap>` - the same shape
//! [`crate::expressions::vulcanus_biomes`] uses, and for the same two reasons.
//! `RefCell` so the eval methods stay `&self` while the closures handed to
//! `select_spots` borrow it, and `BTreeMap` rather than `HashMap` because a
//! determinism-critical port should not carry a container whose iteration order
//! is unspecified.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::basis_noise::{tables_from_seed, BasisNoiseTables};
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{clamp, f32r, max2, min2};
use crate::eval::primitives::{basis_noise_expr, BasisExprParams};
use crate::spot_candidates::SpotRegionKey;
use crate::spot_field::{spot_cone_max, ConeArithmetic, SpotGeometry};
use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};

use super::catalog::{
    enemy_density, enemy_spacing, EnemyControls, ENEMY_BASEMENT, ENEMY_CANDIDATE_SPOT_COUNT,
    ENEMY_MAX_SPOT_BASEMENT_RADIUS, ENEMY_PLACEMENT_CAP, ENEMY_REGION_SIZE, ENEMY_SEED1,
    STARTING_AREA_RADIUS,
};

/// Free variables of the enemy-base field.
pub struct EnemyFieldParams {
    /// Map seed (= `map_seed` / `seed0`).
    pub seed0: u32,
    /// The `enemy-base` autoplace control.
    pub controls: EnemyControls,
    /// Spawn points for `distance`.
    pub starting_positions: Vec<Point>,
}

impl EnemyFieldParams {
    /// The game's defaults, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            controls: EnemyControls::defaults(),
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
        }
    }
}

/// The enemy-base field, with its tables derived once and its regions cached.
pub struct EnemyBaseField {
    seed0: u32,
    controls: EnemyControls,
    starting_positions: Vec<Point>,
    /// The spot-noise candidate spacing. [`enemy_spacing`] unless a test sets it.
    spacing: f64,
    tables: BasisNoiseTables,
    region_cache: RefCell<BTreeMap<(i64, i64), Vec<SelectedSpot>>>,
}

impl EnemyBaseField {
    #[must_use]
    pub fn new(params: &EnemyFieldParams) -> Self {
        Self {
            seed0: params.seed0,
            controls: params.controls,
            starting_positions: params.starting_positions.clone(),
            spacing: enemy_spacing(),
            tables: tables_from_seed(params.seed0, ENEMY_SEED1),
            region_cache: RefCell::new(BTreeMap::new()),
        }
    }

    /// The same field with another candidate spacing: the control for the tests
    /// that grade the game's default, which reproduces the old 45.25.
    #[cfg(test)]
    pub(crate) fn with_spacing(mut self, spacing: f64) -> Self {
        self.spacing = spacing;
        self.region_cache = RefCell::new(BTreeMap::new());
        self
    }

    /// `distance_from_nearest_point{points = starting_positions}`, uncapped.
    fn distance_at(&self, x: f64, y: f64) -> f64 {
        f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
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
            seed1: ENEMY_SEED1,
            region_x,
            region_y,
        };
        let density = |x: f64, y: f64| enemy_density(self.distance_at(x, y), &self.controls);
        let quantity = |x: f64, y: f64| self.quantity_f32(self.distance_at(x, y));
        // Constant 1 - every candidate is equally favoured, so the trim runs in
        // acceptance order. That is a legitimate expression, not a stub.
        let favorability = |_x: f64, _y: f64| 1.0;
        let spots = select_spots(
            &key,
            &SpotSelectParams {
                region_size: ENEMY_REGION_SIZE,
                candidate_spot_count: ENEMY_CANDIDATE_SPOT_COUNT,
                spacing: self.spacing,
                skip_span: 1,
                skip_offset: 0,
                // `false`, so `cone_scale` is always 1 and no spot is shrunk.
                hard_region_target_quantity: false,
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

    /// The spot field: `max(basement, max over nearby spots of the cone)`.
    ///
    /// **There is no resource-style `min(32, ...)` radius cap here.** The game's
    /// `min(maximum_spot_basement_radius, radius)` is applied by the shared
    /// cone walk and is inert: the largest enemy radius is about 44.5, under
    /// the 128 cull. `cone_scale` is always 1 because
    /// `hard_region_target_quantity` is `false`.
    ///
    /// The cone is the GAME's arithmetic, read from the 2.1.23 binary and
    /// shared with Aquilo ([`ConeArithmetic::GameBinary`]): the game's pi
    /// `3.1416`, an f32 distance, and the peak narrowed once (#521). The port's
    /// own per-step f32 chain it replaces used the f64 pi and an f64 distance.
    #[must_use]
    pub fn spot_field(&self, x: f64, y: f64) -> f64 {
        spot_cone_max(
            &SpotGeometry {
                region_size: ENEMY_REGION_SIZE as f64,
                max_basement_radius: ENEMY_MAX_SPOT_BASEMENT_RADIUS,
                basement_value: ENEMY_BASEMENT,
                cone: ConeArithmetic::GameBinary,
            },
            x,
            y,
            |region_x, region_y| self.region_spots(region_x, region_y),
            |s| self.radius_f32(self.distance_at(s.x as f64, s.y as f64)),
        )
    }

    /// `pi / 90 * spot_radius ^ 3`, one f32 step at a time. The cube is two f32
    /// multiplies: a `powf` narrowed once misses 11 and 142 mid-bucket
    /// positions of the tier-1 fixture.
    fn quantity_f32(&self, d: f64) -> f64 {
        let r = self.radius_f32(d);
        f32r(f32r(std::f64::consts::PI / 90.0) * f32r(f32r(r * r) * r))
    }

    /// `max(0, sqrt(size) * (15 + 4 * intensity))` one f32 step at a time.
    fn radius_f32(&self, d: f64) -> f64 {
        let intensity = f32r(clamp(d, 0.0, 2400.0) / 325.0);
        max2(
            0.0,
            f32r(f32r(self.controls.size.sqrt()) * f32r(15.0 + f32r(4.0 * intensity))),
        )
    }

    /// The Lua's `blob(input_scale, output_scale)`, a `basis_noise` at
    /// `seed1 = 123`, through the expression adapter so the coordinates are
    /// narrowed and scaled in f32 as the game does (#521).
    fn blob(&self, x: f64, y: f64, input_scale: f64, output_scale: f64) -> f64 {
        basis_noise_expr(
            x,
            y,
            &BasisExprParams {
                seed0: self.seed0,
                seed1: ENEMY_SEED1,
                input_scale,
                output_scale,
                offset_x: 0.0,
            },
            &self.tables,
        )
    }

    /// The blob term, one f32 step at a time in the Lua's order (#521):
    ///
    /// `(blob(1/8, 1) + blob(1/24, 1) + blob(1/64, 2) - 0.5)
    ///   * spot_radius / 150 * (0.1 + 0.9 * clamp(distance / 3000, 0, 1))`
    ///
    /// The sum adds left to right, then `- 0.5`, then `* radius`, then `/ 150`,
    /// then `* (...)`.
    #[must_use]
    pub fn blob_term(&self, x: f64, y: f64) -> f64 {
        let b = f32r(
            f32r(
                f32r(self.blob(x, y, 1.0 / 8.0, 1.0) + self.blob(x, y, 1.0 / 24.0, 1.0))
                    + self.blob(x, y, 1.0 / 64.0, 2.0),
            ) - 0.5,
        );
        let d = self.distance_at(x, y);
        let radius = self.radius_f32(d);
        let ramp = f32r(f32r(0.1) + f32r(f32r(0.9) * clamp(f32r(d / 3000.0), 0.0, 1.0)));
        f32r(f32r(f32r(b * radius) / 150.0) * ramp)
    }

    /// `enemy_base_probability` - the raw field.
    #[must_use]
    pub fn field(&self, x: f64, y: f64) -> f64 {
        let d = self.distance_at(x, y);
        // `20 / starting_area_radius * distance - 20`, with the constant
        // quotient folded to f32 first.
        let start = f32r(f32r(f32r(20.0 / STARTING_AREA_RADIUS) * d) - 20.0);
        // `spot + blob - 0.3 + min(0, ...)`, left to right.
        f32r(
            f32r(f32r(self.spot_field(x, y) + self.blob_term(x, y)) - f32r(0.3)) + min2(0.0, start),
        )
    }

    /// `clamp(min(field, cap), 0, 1)` - what the deterministic spawner reads.
    ///
    /// Almost always 0: measured on `oracle-enemy-base`, only 42 and 48 of 1032
    /// positions are above it. Grade [`Self::field`], not this.
    #[must_use]
    pub fn probability(&self, x: f64, y: f64) -> f64 {
        clamp(min2(self.field(x, y), ENEMY_PLACEMENT_CAP), 0.0, 1.0)
    }
}
