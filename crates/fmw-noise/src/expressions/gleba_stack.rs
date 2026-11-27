//! The whole Gleba field graph, built once per render and evaluated one
//! position at a time.
//!
//! The shape is `AquiloStack`'s: no memo, because the chain is evaluated top to
//! bottom at one position and its intermediates live in locals. The per-render
//! state (every multioctave table, the starting cones and the spot-region cache)
//! lives in [`GlebaTerrain`].
//!
//! Slice 1 graded the terrain fields and the 41-tile choice at tier 1; slice 2
//! adds [`GlebaStack::corrected_tiles`], the terrain view. No resource or entity layer yet.

use crate::at::At;
use crate::expressions::gleba_terrain::{GlebaControls, GlebaTerrain, GlebaTerrainFields};
use crate::tiles::correction::correct_window;
use crate::tiles::gleba_catalog::{resolve_tile, GlebaTile, TILE_ORDER};

/// What a render fixes: the map seed (the Gleba surface seed, which a preview
/// derives and a tier-1 capture forces) and the terrain controls.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlebaCtx {
    pub seed0: u32,
    pub controls: GlebaControls,
}

/// The per-render state of the Gleba graph.
pub struct GlebaStack {
    terrain: GlebaTerrain,
}

impl GlebaStack {
    #[must_use]
    pub fn new(ctx: &GlebaCtx) -> Self {
        Self {
            terrain: GlebaTerrain::new(ctx.seed0, &ctx.controls),
        }
    }

    /// Evaluate every terrain field at one position.
    #[must_use]
    pub fn eval_at(&self, at: At) -> GlebaTerrainFields {
        self.terrain.eval_at(at)
    }

    /// The tile at one position: the argmax of the 41 probabilities.
    #[must_use]
    pub fn tile_at(&self, at: At) -> GlebaTile {
        resolve_tile(&self.eval_at(at))
    }

    /// The tiles of a window as a real surface holds them: the raw argmax at
    /// every whole tile (the chunk-grid kernel), then tile correction run over
    /// every chunk the window touches plus `margin_chunks` on each side, in
    /// columns order (see `tiles::correction`). Row-major, `y` outer.
    ///
    /// The margin stands in for the chunks a real map has generated around the
    /// window. Correction writes into neighbouring chunks, so a chunk's result
    /// depends on its neighbours' tasks; `CORRECTION_MARGIN_CHUNKS` is the
    /// margin measured to reproduce the real surface.
    #[must_use]
    pub fn corrected_tiles(
        &self,
        origin: (i32, i32),
        size: (u32, u32),
        margin_chunks: i32,
    ) -> Vec<GlebaTile> {
        let layers = gleba_layers();
        let mut raw = |x: i32, y: i32| tile_id(self.tile_at(At::tile(x, y)));
        correct_window(&mut raw, &layers, None, origin, size, margin_chunks)
            .into_iter()
            .map(|id| TILE_ORDER[usize::from(id) - 1])
            .collect()
    }
}

/// The margin, in chunks, [`GlebaStack::corrected_tiles`] corrects around a
/// window for the renderer. See `gleba_corrected_tiles_against_the_real_surface`
/// in `fixtures.rs` for the measurement behind it.
pub const CORRECTION_MARGIN_CHUNKS: i32 = 1;

/// A tile's id for `tiles::correction`: its index in `TILE_ORDER`, plus one (0
/// is the game's empty id).
fn tile_id(t: GlebaTile) -> u8 {
    let i = TILE_ORDER.iter().position(|o| *o == t).unwrap_or(0);
    (i + 1) as u8
}

/// The layer of each correction id; index 0 is unused.
fn gleba_layers() -> Vec<u16> {
    std::iter::once(0)
        .chain(TILE_ORDER.iter().map(|t| t.layer()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sweep gives finite fields everywhere, and elevation, moisture and aux
    /// take a spread of values (the sweep is not all one biome).
    #[test]
    fn a_point_sweep_is_finite_and_spans_the_biomes() {
        let stack = GlebaStack::new(&GlebaCtx {
            seed0: 123_456,
            controls: GlebaControls::default(),
        });
        let (mut low, mut high) = (f64::INFINITY, f64::NEG_INFINITY);
        for j in 0..24 {
            for i in 0..24 {
                let f = stack.eval_at(At::point(
                    f64::from(i * 97 - 1100),
                    f64::from(j * 89 - 1000),
                ));
                for v in [f.elevation, f.moisture, f.aux, f.temperature, f.rockpools] {
                    assert!(v.is_finite(), "non-finite {v}");
                }
                low = low.min(f.elevation);
                high = high.max(f.elevation);
            }
        }
        assert!(low < 0.0 && high > 120.0, "elevation spanned {low}..{high}");
    }
}
