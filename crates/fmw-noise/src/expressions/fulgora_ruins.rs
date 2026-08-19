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

use crate::eval::math::max2;
use crate::expressions::fulgora_cells::CellFields;
use crate::expressions::fulgora_masks::MaskFields;
use crate::expressions::fulgora_roads::RoadFields;
use crate::expressions::fulgora_shared::{FulgoraCtx, Prepared};
use crate::multioctave_noise::MultioctaveParams;

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
    /// **`0.66` is an f64 literal here, matching the TypeScript**, and it is one
    /// of the constants #273 is about - `fulgora_dunes` has the identical shape
    /// and scores 26/101 because of it. Left as it is for the same reason: the
    /// port reproduces the TypeScript, and fixing this is a behaviour change to
    /// shipped terrain that needs its own measurement.
    #[must_use]
    pub fn eval(
        &self,
        x: f64,
        y: f64,
        cells: &CellFields,
        masks: &MaskFields,
        roads: &RoadFields,
    ) -> RuinFields {
        let ruins_walls = 0.66 - f64::from(self.walls.eval(x, y)).abs();
        let ruins_paving = f64::from(self.paving.eval(x, y)).abs();

        let tile_ruin_paving = max2(
            masks.natural_and_mesa * (3.0 * ruins_paving * roads.road_paving_thin - 0.5),
            masks.artificial * (4.0 * roads.road_paving_2c + ruins_paving - 1.0),
        );

        let tile_ruin_walls = max2(
            masks.natural_and_mesa * (2.0 * ruins_walls + ruins_paving - 0.5),
            masks.artificial
                * (0.25 * ruins_walls + 0.25 * roads.structure_subnoise
                    - 4.0 * roads.structure_facets
                    - roads.road_paving_2c
                    + 2.5),
        );

        // The second `- road_paving_2c` sits OUTSIDE the mask product, which is
        // what lets these two go negative on open ground rather than to zero.
        let tile_ruin_conduit = masks.artificial
            * (ruins_walls + roads.structure_subnoise + 2.0 * roads.structure_facets
                - roads.road_paving_2c
                + 0.2
                + 0.3 * cells.vaults_and_starting_vault)
            - roads.road_paving_2c;

        let tile_ruin_machinery = masks.artificial
            * (-ruins_walls + 1.25 * roads.structure_subnoise + 2.5 * roads.structure_facets
                - roads.road_paving_2c
                - 0.2
                + 0.3 * cells.vaults_and_starting_vault
                + 2.0 * f64::from(u8::from(roads.spots_prebanding < 1.0)))
            - roads.road_paving_2c;

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
            road_paving_2c: 0.9,
            spots_prebanding: 2.0,
            ..RoadFields::default()
        };
        let f = ruins.eval(10.0, 20.0, &cells, &masks, &roads);
        assert_eq!(f.tile_ruin_paving, 0.0);
        assert_eq!(f.tile_ruin_walls, 0.0);
        assert_eq!(f.tile_ruin_conduit, -0.9);
        assert_eq!(f.tile_ruin_machinery, -0.9);
    }
}
