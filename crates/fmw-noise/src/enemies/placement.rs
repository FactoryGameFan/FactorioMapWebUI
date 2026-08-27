//! Where the Nauvis enemy overlay actually places spawners: the roll against a
//! penalised probability, gated by the water restriction and by collision.
//!
//! Ported from `makeNauvisEnemyPlacement` in
//! `src/noise/preview/renderEnemies.ts`.
//!
//! # The probability is not the field's
//!
//! `EnemyBaseField::probability` is the clamped field. What the roll sees is
//! that MINUS a random penalty:
//!
//! ```text
//! max(0, probability - 0.1 * min(U_biter, U_spitter))
//! ```
//!
//! The two `U` are independent per-tile uniforms under their own salts,
//! standing in for the game's two spawner prototypes each carrying a
//! `random_penalty`. The `min` is the game's arbitration - the winner is the
//! prototype with the highest probability, so the smallest penalty wins - and
//! the floor at 0 is because a penalty can drive a small source negative, where
//! a negative probability simply never wins the roll.

use crate::enemies::catalog::{ENEMY_RANDOM_PENALTY_AMPLITUDE, ENEMY_SPAWNER_MAP_GEN_BOX};
use crate::enemies::field::EnemyBaseField;
use crate::eval::math::{max2, min2};
use crate::expressions::nauvis_stack::NauvisStack;
use crate::placement::roll::{
    salt, PlacementCollisionBox, PlacementRoll, PlacementSet, PlacementSource,
};
use crate::tiles::nauvis_catalog::NauvisTileCatalog;
use crate::tiles::nauvis_resolve::{is_water_tile, nauvis_tile_at};

/// The spawner's map-gen collision box, 7.4 x 6.4 tiles.
///
/// Constant rather than per-position: unlike the rock overlay, which picks
/// between three prototype boxes by argmax, every enemy prototype this overlay
/// models shares one box.
pub const SPAWNER_BOX: PlacementCollisionBox = PlacementCollisionBox {
    w: ENEMY_SPAWNER_MAP_GEN_BOX.0,
    h: ENEMY_SPAWNER_MAP_GEN_BOX.1,
};

/// The Nauvis enemy placement source.
pub struct NauvisEnemyPlacement<'a> {
    field: &'a EnemyBaseField,
    biter_penalty: PlacementRoll,
    spitter_penalty: PlacementRoll,
    stack: &'a NauvisStack,
    catalog: &'a NauvisTileCatalog,
}

impl<'a> NauvisEnemyPlacement<'a> {
    #[must_use]
    pub fn new(
        field: &'a EnemyBaseField,
        stack: &'a NauvisStack,
        catalog: &'a NauvisTileCatalog,
    ) -> Self {
        Self {
            field,
            biter_penalty: PlacementRoll::new(salt::ENEMY_BITER_PENALTY),
            spitter_penalty: PlacementRoll::new(salt::ENEMY_SPITTER_PENALTY),
            stack,
            catalog,
        }
    }

    /// The penalised probability the roll is tested against.
    ///
    /// Exported so a test can reach it without going through a placement set,
    /// the way `makeNauvisEnemyProbability` is exported on the TypeScript side.
    #[must_use]
    pub fn penalised_probability(&self, x: f64, y: f64) -> f64 {
        let penalty = min2(
            self.biter_penalty.roll(x, y),
            self.spitter_penalty.roll(x, y),
        );
        max2(
            0.0,
            self.field.probability(x, y) - ENEMY_RANDOM_PENALTY_AMPLITUDE * penalty,
        )
    }

    /// The placement set for this overlay, ready to be asked `placed(x, y)`.
    #[must_use]
    pub fn placement_set(&self) -> PlacementSet<'_> {
        PlacementSet::new(salt::ENEMY_BASES, self)
    }
}

impl PlacementSource for NauvisEnemyPlacement<'_> {
    fn probability(&self, x: f64, y: f64) -> f64 {
        self.penalised_probability(x, y)
    }

    fn tile_allowed(&self, x: f64, y: f64) -> bool {
        !is_water_tile(nauvis_tile_at(self.stack, self.catalog, x, y))
    }

    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        Some(SPAWNER_BOX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enemies::field::EnemyFieldParams;
    use crate::expressions::nauvis_stack::{NauvisCtx, NauvisStack};

    fn placement_parts() -> (EnemyBaseField, NauvisStack, NauvisTileCatalog) {
        let ctx = NauvisCtx::defaults(123_456);
        let stack = NauvisStack::new(&ctx);
        let catalog = NauvisTileCatalog::new(123_456);
        let field = EnemyBaseField::new(&EnemyFieldParams::defaults(123_456));
        (field, stack, catalog)
    }

    /// The penalty subtracts, is floored at 0, and never exceeds its amplitude.
    ///
    /// Three properties in one sweep, because each is cheap and each fails
    /// differently: a penalty applied with the wrong SIGN would raise the
    /// probability, a missing floor would let it go negative, and a `max`
    /// where the TypeScript has a `min` would roughly double the penalty's
    /// reach. The last is the one no rendered image would obviously show.
    #[test]
    fn the_random_penalty_only_ever_lowers_the_probability_and_never_below_zero() {
        let (field, stack, catalog) = placement_parts();
        let placement = NauvisEnemyPlacement::new(&field, &stack, &catalog);
        let mut lowered = 0usize;
        let mut positive = 0usize;
        for j in 0..64 {
            for i in 0..64 {
                let x = 2000.5 + f64::from(i) * 8.0;
                let y = -2000.25 + f64::from(j) * 8.0;
                let raw = field.probability(x, y);
                let got = placement.penalised_probability(x, y);
                assert!(got >= 0.0, "({x}, {y}): {got} is negative");
                assert!(
                    got <= raw,
                    "({x}, {y}): {got} exceeds the unpenalised {raw}"
                );
                assert!(
                    raw - got <= ENEMY_RANDOM_PENALTY_AMPLITUDE,
                    "({x}, {y}): penalty {} exceeds its amplitude",
                    raw - got
                );
                if got < raw {
                    lowered += 1;
                }
                if got > 0.0 {
                    positive += 1;
                }
            }
        }
        // Anti-vacuity. Every assertion above holds trivially over a window
        // where the field is flat zero, which is most of Nauvis - the enemy
        // field is 96% basement on `oracle-enemy-base`. This window is chosen
        // to carry bases, and these two counts are what say so.
        assert!(lowered > 0, "the penalty must actually lower something");
        assert_eq!(positive, 448, "positive probabilities in the graded window");
    }

    /// The spawner box is one constant, unlike the rock overlay's argmax.
    #[test]
    fn every_position_gets_the_same_spawner_box() {
        let (field, stack, catalog) = placement_parts();
        let placement = NauvisEnemyPlacement::new(&field, &stack, &catalog);
        for (x, y) in [(0.0, 0.0), (2000.5, -2000.25), (-6000.5, 6000.25)] {
            let got = placement
                .collision_box(x, y)
                .expect("a box at every position");
            assert!(
                (got.w - SPAWNER_BOX.w).abs() < f64::EPSILON
                    && (got.h - SPAWNER_BOX.h).abs() < f64::EPSILON,
                "({x}, {y}): {got:?}"
            );
        }
    }
}
