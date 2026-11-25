//! Fulgora's ruins layer, ported from `src/noise/expressions/fulgoraRuins.ts`.
//!
//! Two noise fields and the four expressions that decide which artificial tile
//! a position gets. Transcribed from
//! `space-age/prototypes/planet/planet-fulgora-map-gen.lua` lines 383-402 (the
//! noise) and 539-578 (the four outputs).
//!
//! Each of the four is a probability fed straight to a tile's
//! `probability_expression`, so they are compared against each other and
//! against the four natural tiles by the argmax in `tiles::fulgora_catalog` -
//! not thresholded here.
//!
//! `paving` and `walls` each have TWO terms under a `max`: one gated by
//! `natural_and_mesa_mask` (ruins scattered on natural ground) and one gated by
//! `artificial_mask` (the built city). `conduit` and `machinery` have only the
//! artificial term, and both subtract `road_paving_2c` a SECOND time outside
//! the mask product - so they go negative on open ground rather than to zero.

use crate::at::At;
use crate::eval::math::{f32r, max2};
use crate::expressions::fulgora_cells::CellFields;
use crate::expressions::fulgora_masks::MaskFields;
use crate::expressions::fulgora_roads::RoadFields;
use crate::expressions::fulgora_shared::FulgoraCtx;
use crate::multioctave_noise::MultioctaveParams;
use crate::multioctave_noise::Prepared;

const SEED1_RUINS_WALLS: u32 = 2_307_136_174; // crc32("fulgora_ruins_walls")  = 0x89841AAE
const SEED1_RUINS_PAVING: u32 = 3_946_133_559; // crc32("fulgora_ruins_paving") = 0xEB353837

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RuinFields {
    /// `0.66 - abs(multioctave)` - ridged, the same shape as `fulgora_dunes`.
    pub ruins_walls: f64,
    /// `abs(multioctave)` - billows, no offset.
    pub ruins_paving: f64,
    pub tile_ruin_paving: f64,
    pub tile_ruin_walls: f64,
    pub tile_ruin_conduit: f64,
    pub tile_ruin_machinery: f64,
}

/// The ruins layer's two noise fields.
pub struct FulgoraRuins {
    walls: Prepared,
    paving: Prepared,
}

impl FulgoraRuins {
    #[must_use]
    pub fn new(ctx: &FulgoraCtx) -> Self {
        let common = |seed1: u32, input_scale: f64| MultioctaveParams {
            seed0: ctx.seed0,
            seed1,
            octaves: 3.0,
            persistence: 0.7,
            input_scale,
            output_scale: 1.0,
        };
        Self {
            walls: Prepared::new(&common(SEED1_RUINS_WALLS, 1.0 / 6.0)),
            paving: Prepared::new(&common(SEED1_RUINS_PAVING, 1.0 / 16.0)),
        }
    }

    /// Evaluate every field of this layer at one position.
    ///
    /// Every step is one f32 operation, as the game evaluates it (#521).
    #[must_use]
    pub fn eval(
        &self,
        x: f64,
        y: f64,
        cells: &CellFields,
        masks: &MaskFields,
        roads: &RoadFields,
    ) -> RuinFields {
        self.eval_at(At::point(x, y), cells, masks, roads)
    }

    /// [`Self::eval`] at an [`At`]: on a grid tile both octave fields, walls
    /// and paving, take the grid path, since both read the raw coordinates
    /// (#451).
    #[must_use]
    pub fn eval_at(
        &self,
        at: At,
        cells: &CellFields,
        masks: &MaskFields,
        roads: &RoadFields,
    ) -> RuinFields {
        // The same `0.66 - abs(v)` shape as `fulgora_dunes`, on a different
        // seed, and it failed the same way: 19/101 with the f64 literal,
        // **101/101** with it typed, residual exactly 0. Two fields with one
        // shape failing identically is what turned #273 from three edits into a
        // sweep of the whole chain.
        //
        // The subtraction is its own f32 operation, so its result is rounded
        // before anything reads it (#521). `f32` minus `f32` needs more than 24
        // bits, so an unrounded f64 here would carry bits the game has dropped.
        let ruins_walls = f32r(f64::from(0.66f32) - f64::from(self.walls.eval_at(at)).abs());
        let ruins_paving = f64::from(self.paving.eval_at(at)).abs();

        // Every step is one f32 operation, in the Lua's order, and every
        // non-exact literal is narrowed before it meets a value (#521). The
        // intermediates of `3 * ruins_paving * thin - 0.5` are left to right.
        let paving_natural = f32r(
            masks.natural_and_mesa
                * f32r(f32r(f32r(3.0 * ruins_paving) * roads.road_paving_thin) - 0.5),
        );
        let paving_artificial = f32r(
            masks.artificial * f32r(f32r(f32r(4.0 * roads.road_paving_2c) + ruins_paving) - 1.0),
        );
        let tile_ruin_paving = max2(paving_natural, paving_artificial);

        // Per-operation narrowing throughout, matching the engine's evaluation
        // order: 88/101 -> **101/101**, residual exactly 0 (#273). Every literal
        // in this arm (0.5, 0.25, 4, 2, 2.5) is already exact at f32.
        //
        // `max2` keeps the Lua's argument order, which is load-bearing:
        // `f64::max` follows IEEE 754-2019 `maximumNumber` and may return either
        // input when both compare equal, so a swapped pair can diverge on signed
        // zero and no tolerance would show it.
        let a = f32r(2.0 * ruins_walls);
        let arm_natural = f32r(masks.natural_and_mesa * f32r(f32r(a + ruins_paving) - 0.5));

        let t3 = f32r(f32r(0.25 * ruins_walls) + f32r(0.25 * roads.structure_subnoise));
        let t5 = f32r(t3 - f32r(4.0 * roads.structure_facets));
        let t7 = f32r(f32r(t5 - roads.road_paving_2c) + 2.5);
        let arm_artificial = f32r(masks.artificial * t7);

        let tile_ruin_walls = max2(arm_natural, arm_artificial);

        // The second `- road_paving_2c` sits OUTSIDE the mask product, which is
        // what lets these two go negative on open ground rather than to zero.
        // The Lua sums left to right: `((((w + s) + 2f) - c) + 0.2) + 0.3v`.
        let conduit_sum = f32r(
            f32r(
                f32r(
                    f32r(
                        f32r(ruins_walls + roads.structure_subnoise)
                            + f32r(2.0 * roads.structure_facets),
                    ) - roads.road_paving_2c,
                ) + f32r(0.2),
            ) + f32r(f32r(0.3) * cells.vaults_and_starting_vault),
        );
        let tile_ruin_conduit = f32r(f32r(masks.artificial * conduit_sum) - roads.road_paving_2c);

        // `((((-w + 1.25s) + 2.5f) - c) - 0.2) + 0.3v) + 2 * (prebanding < 1)`.
        let machinery_sum = f32r(
            f32r(
                f32r(
                    f32r(
                        f32r(-ruins_walls + f32r(1.25 * roads.structure_subnoise))
                            + f32r(2.5 * roads.structure_facets),
                    ) - roads.road_paving_2c,
                ) - f32r(0.2),
            ) + f32r(f32r(0.3) * cells.vaults_and_starting_vault),
        );
        let machinery_sum =
            f32r(machinery_sum + 2.0 * f64::from(u8::from(roads.spots_prebanding < 1.0)));
        let tile_ruin_machinery =
            f32r(f32r(masks.artificial * machinery_sum) - roads.road_paving_2c);

        RuinFields {
            ruins_walls,
            ruins_paving,
            tile_ruin_paving,
            tile_ruin_walls,
            tile_ruin_conduit,
            tile_ruin_machinery,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `conduit` and `machinery` subtract `road_paving_2c` OUTSIDE the mask, so
    /// they go negative on open ground. `paving` and `walls` do not - their
    /// terms are entirely inside a mask product, so a zero mask gives zero.
    ///
    /// That asymmetry is easy to lose when transcribing four similar formulas,
    /// and it changes which tile wins the argmax on open ground.
    #[test]
    fn only_conduit_and_machinery_go_negative_off_the_mask() {
        let ruins = FulgoraRuins::new(&FulgoraCtx::new(2_967_702_466));
        let cells = CellFields::default();
        // Both masks off: every masked term is multiplied by zero.
        let masks = MaskFields {
            natural: 0.0,
            natural_and_mesa: 0.0,
            artificial: 0.0,
        };
        let roads = RoadFields {
            // An f32 value, as the game holds it: the fields now round to f32.
            road_paving_2c: f64::from(0.9f32),
            spots_prebanding: 2.0,
            ..RoadFields::default()
        };
        let f = ruins.eval(10.0, 20.0, &cells, &masks, &roads);
        assert_eq!(f.tile_ruin_paving, 0.0);
        assert_eq!(f.tile_ruin_walls, 0.0);
        assert_eq!(f.tile_ruin_conduit, -f64::from(0.9f32));
        assert_eq!(f.tile_ruin_machinery, -f64::from(0.9f32));
    }
}
