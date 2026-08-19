//! The whole Fulgora field graph, built once and evaluated in one pass.
//!
//! The TypeScript counterpart is `FulgoraStack` in
//! `src/noise/tiles/fulgoraCatalog.ts`, which exists so three call sites - the
//! tile resolver, the land probabilities and the scrap field - share one DAG
//! rather than building three.
//!
//! The Rust shape is different for the reason
//! [`super::fulgora_shared`](super::fulgora_shared) records: there is no memo,
//! because the chain is evaluated top to bottom at one point and its
//! intermediates live in locals. That is bit-identical to memoising and needs no
//! cache - legitimate only because every read is at the SAME `(x, y)`, checked
//! layer by layer.
//!
//! What still needs state is the four `Voronoi` fields and their point caches,
//! and the eight `Prepared` multioctave tables. Those are per-render, and
//! rebuilding them per pixel is the 20x mistake #275 measured.

use crate::expressions::fulgora_cells::{CellFields, FulgoraCells};
use crate::expressions::fulgora_elevation::{ElevationFields, FulgoraElevation};
use crate::expressions::fulgora_masks::{self, MaskFields};
use crate::expressions::fulgora_roads::{FulgoraRoads, RoadFields};
use crate::expressions::fulgora_ruins::{FulgoraRuins, RuinFields};
use crate::expressions::fulgora_scrap::{FulgoraScrap, ScrapControls, ScrapFields};
use crate::expressions::fulgora_shared::{FulgoraCtx, FulgoraShared, SharedFields};
use crate::expressions::starting_spot_at_angle::AngleTrig;
use crate::tiles::fulgora_catalog::{land_probabilities, resolve_tile, FulgoraTile};

/// Every named expression on Fulgora, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StackFields {
    pub shared: SharedFields,
    pub cells: CellFields,
    pub elevation: ElevationFields,
    pub masks: MaskFields,
    pub roads: RoadFields,
    pub ruins: RuinFields,
    pub scrap: ScrapFields,
}

impl StackFields {
    /// The eight land probabilities, in `LAND_ORDER`.
    #[must_use]
    pub fn land_probabilities(&self) -> [f64; 8] {
        land_probabilities(&self.cells, &self.elevation, &self.roads, &self.ruins)
    }

    /// The tile the game would place here.
    #[must_use]
    pub fn tile(&self) -> FulgoraTile {
        resolve_tile(&self.cells, &self.elevation, &self.roads, &self.ruins)
    }
}

/// The per-render state: four Voronoi fields, eight multioctave table sets, and
/// the slider-derived constants.
pub struct FulgoraStack {
    pub ctx: FulgoraCtx,
    shared: FulgoraShared,
    cells: FulgoraCells,
    elevation: FulgoraElevation,
    roads: FulgoraRoads,
    ruins: FulgoraRuins,
    scrap: FulgoraScrap,
}

impl FulgoraStack {
    /// Build the graph, taking the two bearings' trig from the caller.
    ///
    /// See `starting_spot_at_angle`'s module docs for why the trig is an input:
    /// the expression has no f32 narrowing to absorb a one-ULP `sin` difference,
    /// and #270 measured that the wasm libm and V8 really do disagree.
    #[must_use]
    pub fn new(
        ctx: &FulgoraCtx,
        scrap_controls: &ScrapControls,
        starting_trig: AngleTrig,
        vault_trig: AngleTrig,
    ) -> Self {
        let shared = FulgoraShared::new(ctx, starting_trig, vault_trig);
        let grid = shared.grid;
        Self {
            ctx: *ctx,
            cells: FulgoraCells::new(ctx, grid),
            elevation: FulgoraElevation::new(ctx, grid),
            roads: FulgoraRoads::new(ctx, grid),
            ruins: FulgoraRuins::new(ctx),
            scrap: FulgoraScrap::new(scrap_controls),
            shared,
        }
    }

    /// As [`FulgoraStack::new`], with both bearings computed from Rust's libm.
    ///
    /// For tier-1 tests and anything that is not the shipped engine.
    #[must_use]
    pub fn with_host_trig(ctx: &FulgoraCtx, scrap_controls: &ScrapControls) -> Self {
        let angle = f64::from(ctx.seed0) / 360.0;
        Self::new(
            ctx,
            scrap_controls,
            AngleTrig::from_degrees(angle),
            AngleTrig::from_degrees(angle + 180.0),
        )
    }

    /// Evaluate every layer at one position, in dependency order.
    pub fn eval(&mut self, x: f64, y: f64) -> StackFields {
        let shared = self.shared.eval(x, y);
        let cells = self.cells.eval(&shared);
        let elevation = self.elevation.eval(x, y, &shared, &cells);
        let masks = fulgora_masks::eval(&shared, &cells, &elevation);
        let roads = self.roads.eval(x, y, &shared, &cells);
        let ruins = self.ruins.eval(x, y, &cells, &masks, &roads);
        let scrap = self.scrap.eval(&shared, &cells, &elevation, &masks, &roads);
        StackFields {
            shared,
            cells,
            elevation,
            masks,
            roads,
            ruins,
            scrap,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The layers are evaluated in dependency order, so a field can only read
    /// what is already computed. Asserted by checking that a real sweep
    /// produces finite values everywhere rather than the NaN a use-before-set
    /// would give.
    #[test]
    fn a_real_sweep_produces_finite_values_in_every_layer() {
        let ctx = FulgoraCtx::new(2_967_702_466);
        let mut stack = FulgoraStack::with_host_trig(&ctx, &ScrapControls::default());
        let mut tiles = std::collections::BTreeSet::new();
        for j in 0..24 {
            for i in 0..24 {
                let (x, y) = (f64::from(i) * 37.0 - 444.0, f64::from(j) * 37.0 - 444.0);
                let f = stack.eval(x, y);
                for v in [
                    f.shared.wx,
                    f.cells.cells,
                    f.elevation.elevation,
                    f.masks.artificial,
                    f.roads.road_paving_2c,
                    f.ruins.tile_ruin_walls,
                    f.scrap.probability,
                ] {
                    assert!(v.is_finite(), "non-finite {v} at ({x}, {y})");
                }
                tiles.insert(f.tile().game_name());
            }
        }
        // Non-vacuity: a sweep that only ever saw ocean would say nothing about
        // the land layers above.
        assert!(tiles.len() >= 4, "sweep saw only {tiles:?}");
    }
}
