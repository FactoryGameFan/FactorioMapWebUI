//! Gleba's two pentapod nests: each one's autoplace probability (#454, slice
//! 6).
//!
//! Transcribed from `space-age/prototypes/planet/planet-gleba-map-gen.lua`
//! (2.1.23, lines 279-285) and `enemy_autoplace_base` in
//! `base/prototypes/noise-expressions.lua`:
//!
//! ```text
//! gleba_spawner = max(0.01 * gleba_starting_enemies,
//!                     max(min(0.02, enemy_autoplace_base(0, 8)),
//!                         min(0.001, gleba_fertile_spots_coastal * 5000
//!                                    - gleba_biome_mask_green * 25000))
//!                     * (distance > 500 * gleba_starting_area_multiplier))
//!                 * gleba_above_deep_water_mask
//! gleba_spawner_small = max(0.02 * gleba_starting_enemies,
//!                           0.02 * gleba_starting_enemies_safe,
//!                           min(0.02, enemy_autoplace_base(0, 8)),
//!                           min(0.001, gleba_fertile_spots_coastal * 5000
//!                                      - gleba_biome_mask_green * 25000))
//!                       * gleba_above_deep_water_mask
//!
//! enemy_autoplace_base(df, seed) = random_penalty{x = x + seed, y = y,
//!     source = min(enemy_base_probability * max(0, 1 + 0.002 * df * (...)),
//!                  0.25 + df * 0.05),
//!     amplitude = 0.1}
//! ```
//!
//! **`enemy_base_probability` is the Nauvis field with Gleba's frequency.**
//! Gleba's `property_expression_names` replace `enemy_base_frequency` with
//! `(0.00002 + 0.000006 * enemy_base_intensity) * control:gleba_enemy_base:frequency`,
//! exactly twice the Nauvis formula (doubling is exact), and
//! `enemy_base_radius` with the Nauvis formula over the Gleba control's size.
//! So [`EnemyBaseField`] with its frequency control doubled is the Gleba
//! field, unchanged; the Nauvis code is not touched.
//!
//! **At `distance_factor = 0` the source is `min(enemy_base_probability, 0.25)`**
//! (`max(0, 1 + 0) = 1`, and `0.25 + 0 = 0.25`), and `random_penalty` is a
//! BATCH op ([`crate::random_penalty`]). In the per-chunk generator the batch
//! is the chunk's 1,024 tiles, row-major, at integer tile corners, at the
//! positions `(x + 8, y)`: [`chunk_penalties`]. A tile whose source is `<= 0`
//! passes through and spends no draw, so a tile's penalty depends on how many
//! tiles after it in the batch have a positive source.
//!
//! Every other step is f32, in the Lua's order, like the terrain fields.

use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::enemies::catalog::EnemyControls;
use crate::enemies::field::{EnemyBaseField, EnemyFieldParams};
use crate::eval::math::{f32r, max, max2, min2};
use crate::expressions::gleba_starting::area_multiplier;
use crate::random_penalty::{random_penalty_batch, RandomPenaltyParams, RandomPenaltyPosition};

/// The `gleba_enemy_base` control. Neutral is 1 for all three; the richness
/// is read by nothing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlebaEnemyControls {
    /// `control:gleba_enemy_base:frequency`.
    pub frequency: f64,
    /// `control:gleba_enemy_base:size`. 0 turns the nests off: the generator
    /// skips an autoplacer whose control is at size 0 (`placement::gleba`).
    pub size: f64,
}

impl GlebaEnemyControls {
    /// The control at size 0: no nests, and their groups skipped.
    #[must_use]
    pub fn off() -> Self {
        Self {
            frequency: 1.0,
            size: 0.0,
        }
    }
}

impl Default for GlebaEnemyControls {
    fn default() -> Self {
        Self {
            frequency: 1.0,
            size: 1.0,
        }
    }
}

/// `enemy_autoplace_base(0, 8)`'s `seed`: the batch reads `x + 8`.
pub const NEST_PENALTY_X_OFFSET: f64 = 8.0;

/// `random_penalty`'s parameters as `enemy_autoplace_base` passes them: the
/// op's own `seed` defaults to 1, and the amplitude 0.1 is the f32 the noise
/// program holds (the op reads it as an f32).
#[must_use]
pub fn nest_penalty_params() -> RandomPenaltyParams {
    RandomPenaltyParams {
        seed: 1.0,
        amplitude: f32r(0.1),
    }
}

/// The terrain values the nest probabilities read at one tile, besides the
/// penalised enemy-base value.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct NestInputs {
    /// `distance` from the nearest starting position.
    pub distance: f64,
    /// `gleba_starting_enemies` and `gleba_starting_enemies_safe`.
    pub starting_enemies: f64,
    pub starting_enemies_safe: f64,
    /// `gleba_fertile_spots_coastal`.
    pub fertile_spots_coastal: f64,
    /// `aux`, for `gleba_biome_mask_green = aux > 0.375`.
    pub aux: f64,
    /// `elevation`, for `gleba_above_deep_water_mask = elevation > -10`.
    pub elevation: f64,
}

/// Both nest probabilities at one tile.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct NestProbabilities {
    /// `gleba_spawner`.
    pub spawner: f64,
    /// `gleba_spawner_small`.
    pub spawner_small: f64,
}

/// The per-render state of the nest fields: the enemy-base field and the
/// control.
pub struct GlebaNests {
    field: EnemyBaseField,
    controls: GlebaEnemyControls,
    starting_positions: Vec<Point>,
}

impl GlebaNests {
    #[must_use]
    pub fn new(seed0: u32, controls: &GlebaEnemyControls) -> Self {
        // The control is an f32 slot; doubling it is exact.
        let frequency = f32r(controls.frequency);
        Self {
            field: EnemyBaseField::new(&EnemyFieldParams {
                seed0,
                controls: EnemyControls {
                    frequency: 2.0 * frequency,
                    size: f32r(controls.size),
                },
                ..EnemyFieldParams::defaults(seed0)
            }),
            controls: *controls,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
        }
    }

    /// `control:gleba_enemy_base:size`.
    #[must_use]
    pub fn size(&self) -> f64 {
        self.controls.size
    }

    /// `enemy_base_probability` at a position.
    #[must_use]
    pub fn enemy_base_probability(&self, x: f64, y: f64) -> f64 {
        self.field.field(x, y)
    }

    /// `random_penalty`'s source at a position:
    /// `min(enemy_base_probability * 1, 0.25)`.
    #[must_use]
    pub fn penalty_source(&self, x: f64, y: f64) -> f64 {
        min2(self.enemy_base_probability(x, y), 0.25)
    }

    /// `distance` at a position, as the terrain computes it.
    #[must_use]
    pub fn distance(&self, x: f64, y: f64) -> f64 {
        f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ))
    }
}

/// `min(0.001, gleba_fertile_spots_coastal * 5000 - gleba_biome_mask_green * 25000)`.
fn fertile_term(t: &NestInputs) -> f64 {
    let green = if t.aux > f32r(0.375) { 1.0 } else { 0.0 };
    min2(
        f32r(0.001),
        f32r(f32r(t.fertile_spots_coastal * 5000.0) - f32r(green * 25000.0)),
    )
}

/// Both nest probabilities from `penalised`, `enemy_autoplace_base(0, 8)` at
/// the tile, and the terrain values there.
#[must_use]
pub fn nest_probabilities(penalised: f64, t: &NestInputs) -> NestProbabilities {
    let deep = if t.elevation > -10.0 { 1.0 } else { 0.0 };
    let base = min2(f32r(0.02), penalised);
    let fertile = fertile_term(t);
    let far = if t.distance > f32r(500.0 * area_multiplier()) {
        1.0
    } else {
        0.0
    };
    let spawner = f32r(
        max2(
            f32r(f32r(0.01) * t.starting_enemies),
            f32r(max2(base, fertile) * far),
        ) * deep,
    );
    let spawner_small = f32r(
        max(&[
            f32r(f32r(0.02) * t.starting_enemies),
            f32r(f32r(0.02) * t.starting_enemies_safe),
            base,
            fertile,
        ]) * deep,
    );
    NestProbabilities {
        spawner,
        spawner_small,
    }
}

/// `enemy_autoplace_base(0, 8)` over one chunk, as the per-chunk generator
/// evaluates it: one `random_penalty` batch of the chunk's 1,024 tiles,
/// row-major from the top-left tile, at `(x + 8, y)`. `source[i]` is
/// [`GlebaNests::penalty_source`] at tile `i` (`dy * 32 + dx`).
///
/// # Panics
///
/// If `source` does not hold 1,024 values.
#[must_use]
pub fn chunk_penalties(cx: i64, cy: i64, source: &[f64]) -> Vec<f64> {
    assert_eq!(source.len(), 1024, "one source per tile of the chunk");
    #[allow(clippy::cast_precision_loss)]
    let positions: Vec<RandomPenaltyPosition> = (0..1024_i64)
        .map(|i| RandomPenaltyPosition {
            x: (cx * 32 + i % 32) as f64 + NEST_PENALTY_X_OFFSET,
            y: (cy * 32 + i / 32) as f64,
        })
        .collect();
    random_penalty_batch(&positions, source, &nest_penalty_params())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Off every spot the field sits near its -1000 basement, so the source
    /// is the field itself and passes through the penalty unchanged.
    #[test]
    fn a_non_positive_source_passes_through_the_chunk_batch() {
        let mut source = vec![-1.0; 1024];
        source[5] = 0.1;
        let rp = chunk_penalties(0, 0, &source);
        assert_eq!(rp[0], -1.0);
        assert!(rp[5] < 0.1 && rp[5] >= 0.1 - f32r(0.1));
    }

    /// The large nest needs `distance > 350`; the small one does not.
    #[test]
    fn the_large_nest_stays_out_of_the_starting_area() {
        let t = NestInputs {
            distance: 300.0,
            elevation: 0.0,
            ..NestInputs::default()
        };
        let p = nest_probabilities(0.25, &t);
        assert_eq!(p.spawner, 0.0);
        assert_eq!(p.spawner_small, f32r(0.02));
        let far = nest_probabilities(
            0.25,
            &NestInputs {
                distance: 400.0,
                ..t
            },
        );
        assert_eq!(far.spawner, f32r(0.02));
        let deep = nest_probabilities(
            0.25,
            &NestInputs {
                distance: 400.0,
                elevation: -10.0,
                ..t
            },
        );
        assert_eq!((deep.spawner, deep.spawner_small), (0.0, 0.0));
    }
}
