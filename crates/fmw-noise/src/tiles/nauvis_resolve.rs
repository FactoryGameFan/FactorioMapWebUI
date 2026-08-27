//! One Nauvis pixel's tile, with the water early-out.
//!
//! Ported from `makeTileResolver` in `src/noise/tiles/resolve.ts`, and lifted
//! out of `fmw-wasm`'s `render.rs` when the rock overlay landed: the terrain
//! sweep is no longer the only caller. A placement roll's `tile_allowed` gate
//! has to ask the same question - "is this tile water" - about tiles OUTSIDE
//! the render window, since a chunk straddles the edge, so it cannot read
//! painted pixels and needs the resolver itself.
//!
//! # The early-out is an optimisation with a proof
//!
//! `makeTileResolver` runs the full 21-way argmax at every position. This runs
//! it only where water is not already winning by enough, which skips 19
//! `noise_layer_noise` evaluations over open water. The two agree at every
//! position, which `render.rs`'s
//! `the_water_early_out_picks_the_same_tile_as_the_full_argmax` measures rather
//! than assumes.

use crate::expressions::nauvis_stack::NauvisStack;
use crate::tiles::helpers::water_base;
use crate::tiles::nauvis_catalog::{NauvisTile, NauvisTileCatalog, NauvisTileFields};

/// The water early-out threshold, from `src/noise/preview/renderTerrain.ts`.
///
/// Whenever `water_base(elevation, 0, 100) >= 5`, water or deepwater beats every
/// land tile, so the land argmax can be skipped and the winner picked from the
/// two water tiles directly.
pub const WATER_EARLY_OUT_THRESHOLD: f64 = 5.0;

/// One pixel's tile.
#[must_use]
pub fn nauvis_tile_at(
    stack: &NauvisStack,
    catalog: &NauvisTileCatalog,
    x: f64,
    y: f64,
) -> NauvisTile {
    let elevation = stack.elevation_nauvis.eval(x, y);
    let water_influence = water_base(elevation, 0.0, 100.0);
    if water_influence >= WATER_EARLY_OUT_THRESHOLD {
        // Deepwater is first in `TILE_ORDER`, so the full argmax's strict `>`
        // never lets water displace it on an exact tie. `>=` here reproduces
        // that tie-break rather than merely resembling it.
        let deep_influence = water_base(elevation, -2.0, 200.0);
        return if deep_influence >= water_influence {
            NauvisTile::Deepwater
        } else {
            NauvisTile::Water
        };
    }
    catalog.resolve(&NauvisTileFields {
        x,
        y,
        elevation,
        aux: stack.aux.eval(x, y),
        moisture: stack.moisture.eval(x, y),
    })
}

/// Whether a tile is one of the two water tiles.
///
/// The overlays' `tile_allowed` gate, matching `WATER_TILE_NAMES` in
/// `renderRocks.ts` / `renderEnemies.ts` / `renderResources.ts` - all three
/// spell the same two-name set by hand on that side.
#[must_use]
pub fn is_water_tile(tile: NauvisTile) -> bool {
    matches!(tile, NauvisTile::Water | NauvisTile::Deepwater)
}
