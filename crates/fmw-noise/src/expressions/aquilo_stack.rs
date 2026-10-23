//! The whole Aquilo field graph, built once per render and evaluated in one
//! pass.
//!
//! The shape is `FulgoraStack`'s: no memo, because the chain is evaluated top
//! to bottom at one position and its intermediates live in locals. What needs
//! state is per-render: the multioctave tables, the billow octaves, the two
//! Voronoi fields and their caches (in [`AquiloTerrain`]), and the spot-region
//! cache (in [`AquiloResources`]). Building them per position would rebuild
//! the seed tables and re-select every spot region at every pixel.

use crate::at::At;
use crate::expressions::aquilo_resources::{
    AquiloBearings, AquiloResourceControls, AquiloResourceFields, AquiloResources,
};
use crate::expressions::aquilo_terrain::{AquiloTerrain, AquiloTerrainFields};

/// What a render fixes: the map seed (the Aquilo surface seed, which a preview
/// derives and a tier-1 capture forces) and the three resource controls.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AquiloCtx {
    pub seed0: u32,
    pub controls: AquiloResourceControls,
}

/// Every named expression on Aquilo that this port grades, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AquiloFields {
    pub resources: AquiloResourceFields,
    pub terrain: AquiloTerrainFields,
}

/// The per-render state of the Aquilo graph.
pub struct AquiloStack {
    resources: AquiloResources,
    terrain: AquiloTerrain,
}

impl AquiloStack {
    /// Build the graph, taking the starting cones' bearing trig from the
    /// caller. The shipped engine passes V8's values; see
    /// `starting_spot_at_angle`'s module docs for why.
    #[must_use]
    pub fn new(ctx: &AquiloCtx, bearings: AquiloBearings) -> Self {
        Self {
            resources: AquiloResources::new(ctx.seed0, &ctx.controls, bearings),
            terrain: AquiloTerrain::new(ctx.seed0),
        }
    }

    /// As [`AquiloStack::new`], with the bearings from Rust's libm. For tier-1
    /// tests and anything that is not the shipped engine.
    #[must_use]
    pub fn with_host_trig(ctx: &AquiloCtx) -> Self {
        Self::new(ctx, AquiloBearings::from_host(ctx.seed0))
    }

    /// Evaluate every layer at one position, in dependency order: the
    /// resource layer first, because `aquilo_island_peaks` reads it.
    pub fn eval_at(&mut self, at: At) -> AquiloFields {
        let resources = self.resources.eval_at(at);
        let terrain = self.terrain.eval_at(at, &resources);
        AquiloFields { resources, terrain }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stack() -> AquiloStack {
        AquiloStack::with_host_trig(&AquiloCtx {
            seed0: 123_456,
            controls: AquiloResourceControls::default(),
        })
    }

    /// A sweep of whole tiles on the chunk-grid path gives finite values in
    /// every field, and the raw-coordinate fields really take that path: the
    /// grid and point kernels round differently, so they disagree somewhere.
    /// A stack that dropped the `At` and always used the point kernel would
    /// agree everywhere.
    #[test]
    fn a_tile_sweep_is_finite_and_reaches_the_grid_kernel() {
        let mut on_grid = stack();
        let mut on_points = stack();
        let mut differ = 0;
        let mut land = 0;
        for j in 0..40 {
            for i in 0..40 {
                let (x, y) = (i * 23 - 460, j * 19 - 380);
                let g = on_grid.eval_at(At::tile(x, y)).terrain;
                let p = on_points
                    .eval_at(At::point(f64::from(x), f64::from(y)))
                    .terrain;
                for v in [
                    g.wobble_x,
                    g.wobble_y,
                    g.aux,
                    g.island_peaks,
                    g.elevation,
                    g.high_frequency_peaks,
                    g.snow_ice,
                    g.tile_variant,
                ] {
                    assert!(v.is_finite(), "non-finite {v} at ({x}, {y})");
                }
                if g.tile_variant.to_bits() != p.tile_variant.to_bits() {
                    differ += 1;
                }
                if g.elevation > 0.0 {
                    land += 1;
                }
            }
        }
        assert!(
            differ > 0,
            "the grid path never differed from the point path"
        );
        // Non-vacuity: the sweep is not all ocean.
        assert!(land > 0, "the sweep saw no land");
    }
}
