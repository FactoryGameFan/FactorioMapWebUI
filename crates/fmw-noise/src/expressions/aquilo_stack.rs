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
use crate::tiles::aquilo_catalog::{resolve_tile, AquiloTile};

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

impl AquiloFields {
    /// The tile at this position: the argmax of the nine probabilities.
    #[must_use]
    pub fn tile(&self) -> AquiloTile {
        resolve_tile(&self.terrain)
    }
}

/// The map-generation position of the tile whose integer corner `(x, y)` falls
/// in: `At::tile` of the floor, on the chunk grid.
///
/// Both Aquilo overlays (`resources::aquilo_wells`, `rocks::aquilo_icebergs`)
/// read the stack here. `PlacementSet` hands them whole-tile positions, so the
/// floor only matters for a direct caller.
#[must_use]
pub fn tile_at(x: f64, y: f64) -> At {
    #[allow(clippy::cast_possible_truncation)]
    At::tile(x.floor() as i32, y.floor() as i32)
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

/// Tier 2's field selector for the Aquilo graph: one named expression, by index.
///
/// The order is `AquiloResourceFields` (11), then `AquiloTerrainFields` (8),
/// then the nine tile scores in `TILE_ORDER`, 28 in all. The spec's
/// `FIELD_NAMES` block lists them in the same order, and `native_parity.rs`
/// scans that block, so the mapping cannot drift.
///
/// Every call evaluates the whole stack at the point and picks one value. The
/// redundancy is free: tier 2 runs it a few thousand times, and it keeps each
/// field reached through the one entry point its consumers use.
pub struct AquiloParity<'a> {
    stack: &'a mut AquiloStack,
}

impl<'a> AquiloParity<'a> {
    /// How many named fields [`Self::field`] can select, `0..FIELD_COUNT`.
    pub const FIELD_COUNT: u32 = 28;

    #[must_use]
    pub fn new(stack: &'a mut AquiloStack) -> Self {
        Self { stack }
    }

    /// One field at world position `(x, y)`, evaluated as a point (tier 2
    /// sweeps a zoomed-out window, which the renderer also treats as points).
    /// An index past the end gives 0.
    pub fn field(&mut self, i: u32, x: f64, y: f64) -> f64 {
        let f = self.stack.eval_at(At::point(x, y));
        let r = &f.resources;
        let t = &f.terrain;
        match i {
            0 => r.starting_crude_oil,
            1 => r.starting_lithium_brine,
            2 => r.starting_fluorine_vent,
            3 => r.starting_fluorine_vent_tiny,
            4 => r.starting_mask,
            5 => r.crude_oil_spots,
            6 => r.lithium_brine_spots,
            7 => r.fluorine_vent_spots,
            8 => r.crude_oil_probability,
            9 => r.lithium_brine_probability,
            10 => r.fluorine_vent_probability,
            11 => t.wobble_x,
            12 => t.wobble_y,
            13 => t.aux,
            14 => t.island_peaks,
            15 => t.elevation,
            16 => t.high_frequency_peaks,
            17 => t.snow_ice,
            18 => t.tile_variant,
            19..=27 => crate::tiles::aquilo_catalog::probabilities(t)[(i - 19) as usize],
            _ => 0.0,
        }
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
    /// every field, and EVERY raw-coordinate field really takes that path: the
    /// grid and point kernels round differently, so each one disagrees with
    /// its point twin somewhere. A field that dropped its `At` and always used
    /// the point kernel would agree everywhere and go red here. The billows
    /// have no field of their own; they reach the grid through `elevation`.
    /// `aquilo_aux` runs the point kernel on a warped coordinate, but the warp
    /// reads the wobbles, which follow the `At`, so it differs too.
    #[test]
    fn a_tile_sweep_is_finite_and_every_raw_field_reaches_the_grid_kernel() {
        let mut on_grid = stack();
        let mut on_points = stack();
        // Differing positions per field, in `AquiloTerrainFields` order.
        let mut differ = [0usize; 8];
        let mut land = 0;
        for j in 0..40 {
            for i in 0..40 {
                let (x, y) = (i * 23 - 460, j * 19 - 380);
                let g = on_grid.eval_at(At::tile(x, y)).terrain;
                let p = on_points
                    .eval_at(At::point(f64::from(x), f64::from(y)))
                    .terrain;
                let pairs = |f: &AquiloTerrainFields| {
                    [
                        f.wobble_x,
                        f.wobble_y,
                        f.aux,
                        f.island_peaks,
                        f.elevation,
                        f.high_frequency_peaks,
                        f.snow_ice,
                        f.tile_variant,
                    ]
                };
                for (n, (gv, pv)) in pairs(&g).into_iter().zip(pairs(&p)).enumerate() {
                    assert!(gv.is_finite(), "non-finite {gv} at ({x}, {y})");
                    if gv.to_bits() != pv.to_bits() {
                        differ[n] += 1;
                    }
                }
                if g.elevation > 0.0 {
                    land += 1;
                }
            }
        }
        // `island_peaks` is the spot arm alone (cones and spot fields, which are
        // distance maths) and reads no raw-coordinate noise, so it is the one
        // field that must agree. The random peaks and the billows reach the
        // grid only through `elevation`; the terrain module's own test grades
        // each of them directly.
        assert_eq!(differ[3], 0, "island_peaks is not a noise field");
        differ[3] = 1;
        let names = [
            "wobble_x",
            "wobble_y",
            "aux",
            "island_peaks",
            "elevation",
            "high_frequency_peaks",
            "snow_ice",
            "tile_variant",
        ];
        eprintln!("grid-vs-point differing positions of 1600: {names:?} {differ:?}");
        for (name, n) in names.iter().zip(differ) {
            assert!(n > 0, "{name} never differed from its point twin");
        }
        // Non-vacuity: the sweep is not all ocean.
        assert!(land > 0, "the sweep saw no land");
    }
}
