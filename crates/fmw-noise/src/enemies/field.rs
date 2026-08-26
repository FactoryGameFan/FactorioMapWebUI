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

use crate::basis_noise::{basis_noise, tables_from_seed, BasisNoiseTables};
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{clamp, min2};
use crate::spot_candidates::SpotRegionKey;
use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};

use super::catalog::{
    enemy_density, enemy_spot_quantity, enemy_spot_radius, EnemyControls, ENEMY_BASEMENT,
    ENEMY_CANDIDATE_SPOT_COUNT, ENEMY_MAX_SPOT_BASEMENT_RADIUS, ENEMY_PLACEMENT_CAP,
    ENEMY_REGION_SIZE, ENEMY_SEED1, ENEMY_SPACING, STARTING_AREA_RADIUS,
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
    tables: BasisNoiseTables,
    region_cache: RefCell<BTreeMap<(i64, i64), Vec<SelectedSpot>>>,
}

/// Region index for a coordinate - regions are centred on multiples of
/// [`ENEMY_REGION_SIZE`].
///
/// `floor((c + size/2) / size)`, written exactly as the TypeScript writes it.
fn region_index(c: f64) -> i64 {
    #[allow(clippy::cast_precision_loss)]
    let size = ENEMY_REGION_SIZE as f64;
    #[allow(clippy::cast_possible_truncation)]
    let index = ((c + size / 2.0) / size).floor() as i64;
    index
}

/// One f32 narrowing, kept as a named function so the cone below reads
/// token-for-token against the `f32(...)` calls in the TypeScript.
///
/// The alternative - typing the whole chain `f32` - is NOT the same
/// computation, and CLAUDE.md records the case where writing it that way made a
/// count worse. Narrow where the reference narrows, nowhere else.
#[inline]
fn n(v: f64) -> f64 {
    f64::from(v as f32)
}

impl EnemyBaseField {
    #[must_use]
    pub fn new(params: &EnemyFieldParams) -> Self {
        Self {
            seed0: params.seed0,
            controls: params.controls,
            starting_positions: params.starting_positions.clone(),
            tables: tables_from_seed(params.seed0, ENEMY_SEED1),
            region_cache: RefCell::new(BTreeMap::new()),
        }
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
        let quantity = |x: f64, y: f64| enemy_spot_quantity(self.distance_at(x, y), &self.controls);
        // Constant 1 - every candidate is equally favoured, so the trim runs in
        // acceptance order. That is a legitimate expression, not a stub.
        let favorability = |_x: f64, _y: f64| 1.0;
        let spots = select_spots(
            &key,
            &SpotSelectParams {
                region_size: ENEMY_REGION_SIZE,
                candidate_spot_count: ENEMY_CANDIDATE_SPOT_COUNT,
                spacing: ENEMY_SPACING,
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
    /// **There is no `min(32, ...)` radius cap here.** That clamp is
    /// resource-only, and the TypeScript says so at this line. `cone_scale` is
    /// always 1 because `hard_region_target_quantity` is `false`.
    ///
    /// The cone arithmetic is f32 per operation, exactly where the TypeScript
    /// narrows it.
    #[must_use]
    pub fn spot_field(&self, x: f64, y: f64) -> f64 {
        let mut best = ENEMY_BASEMENT;
        let r = ENEMY_MAX_SPOT_BASEMENT_RADIUS;
        let rx_lo = region_index(x - r);
        let rx_hi = region_index(x + r);
        let ry_lo = region_index(y - r);
        let ry_hi = region_index(y + r);
        for region_x in rx_lo..=rx_hi {
            for region_y in ry_lo..=ry_hi {
                for s in self.region_spots(region_x, region_y) {
                    #[allow(clippy::cast_precision_loss)]
                    let (sx, sy) = (s.x as f64, s.y as f64);
                    let dx = x - sx;
                    let dy = y - sy;
                    let d2 = dx * dx + dy * dy;
                    if d2 > r * r {
                        continue;
                    }
                    let radius =
                        n(enemy_spot_radius(self.distance_at(sx, sy), &self.controls)
                            * s.cone_scale);
                    if radius <= 0.0 {
                        continue;
                    }
                    let q = s.quantity;
                    let peak = n(n(3.0 * q) / n(n(std::f64::consts::PI * radius) * radius));
                    let cone = n(peak - n(n(d2.sqrt()) * n(peak / radius)));
                    if cone > best {
                        best = cone;
                    }
                }
            }
        }
        best
    }

    /// The blob term.
    ///
    /// Three `basis_noise` calls at plain divided coordinates, through the
    /// low-level op rather than through `basis_noise_expr`. The `2 *` on the
    /// third is an `output_scale` of 2 written at the call site.
    ///
    /// **The coordinates are NOT narrowed on the way in, deliberately.**
    /// `basis_noise` is the op #191 left alone, and its remaining direct callers
    /// are exactly these un-narrowed Nauvis chains. Ported as written; narrowing
    /// it here would be a unilateral change with no fixture to grade it.
    #[must_use]
    pub fn blob_term(&self, x: f64, y: f64) -> f64 {
        // Each `basis_noise` returns f32; the TypeScript sums them as JavaScript
        // numbers, so the additions and the `2 *` happen in f64 on f32-valued
        // operands. Widen at each term rather than summing in f32.
        let b = f64::from(basis_noise(x / 8.0, y / 8.0, &self.tables))
            + f64::from(basis_noise(x / 24.0, y / 24.0, &self.tables))
            + 2.0 * f64::from(basis_noise(x / 64.0, y / 64.0, &self.tables));
        let d = self.distance_at(x, y);
        (b - 0.5)
            * (enemy_spot_radius(d, &self.controls) / 150.0)
            * (0.1 + 0.9 * clamp(d / 3000.0, 0.0, 1.0))
    }

    /// `enemy_base_probability` - the raw field.
    #[must_use]
    pub fn field(&self, x: f64, y: f64) -> f64 {
        let d = self.distance_at(x, y);
        self.spot_field(x, y) + self.blob_term(x, y) - 0.3
            + min2(0.0, (20.0 / STARTING_AREA_RADIUS) * d - 20.0)
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
