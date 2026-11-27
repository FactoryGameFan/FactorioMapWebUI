//! The whole Gleba field graph, built once per render and evaluated one
//! position at a time.
//!
//! The shape is `AquiloStack`'s: no memo, because the chain is evaluated top to
//! bottom at one position and its intermediates live in locals. The per-render
//! state (every multioctave table, the starting cones and the spot-region cache)
//! lives in [`GlebaTerrain`].
//!
//! Slice 1 graded the terrain fields and the 41-tile choice at tier 1; slice 2
//! adds [`GlebaStack::corrected_tiles`], the terrain view; slice 3 adds the
//! resource fields ([`GlebaStack::resources_at`]) that stone and the two
//! stromatolites are placed by (`placement::gleba`).

use crate::at::At;
use crate::expressions::gleba_resources::{
    GlebaResourceFields, GlebaResources, GlebaStoneControls, ResourceInputs,
};
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
    resources: GlebaResources,
}

impl GlebaStack {
    /// The graph with the `gleba_stone` control at its default.
    #[must_use]
    pub fn new(ctx: &GlebaCtx) -> Self {
        Self::with_stone(ctx, &GlebaStoneControls::default())
    }

    /// The graph with the given `gleba_stone` control.
    #[must_use]
    pub fn with_stone(ctx: &GlebaCtx, stone: &GlebaStoneControls) -> Self {
        let terrain = GlebaTerrain::new(ctx.seed0, &ctx.controls);
        let resources = GlebaResources::new(ctx.seed0, &terrain.vars, stone);
        Self { terrain, resources }
    }

    /// Every terrain field and every resource field at one position.
    #[must_use]
    pub fn resources_at(&self, at: At) -> (GlebaTerrainFields, GlebaResourceFields) {
        let t = self.terrain.eval_at(at);
        let r = self
            .resources
            .eval(at, &ResourceInputs::from(&t), &self.terrain);
        (t, r)
    }

    /// The resource fields at one position, given the terrain fields they
    /// read there (kept from an earlier evaluation at the same `at`).
    #[must_use]
    pub fn resources_from(&self, at: At, t: &ResourceInputs) -> GlebaResourceFields {
        self.resources.eval(at, t, &self.terrain)
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
        self.corrected_tiles_keeping(origin, size, margin_chunks, None)
    }

    /// [`GlebaStack::corrected_tiles`], keeping the resource inputs of every
    /// tile it evaluates inside `keep`'s chunks. Correction evaluates every
    /// tile of the chunks it corrects, so a window's chunks come back full.
    /// The output is the same either way.
    #[must_use]
    pub fn corrected_tiles_keeping(
        &self,
        origin: (i32, i32),
        size: (u32, u32),
        margin_chunks: i32,
        mut keep: Option<&mut KeptInputs>,
    ) -> Vec<GlebaTile> {
        let layers = gleba_layers();
        let mut raw = |x: i32, y: i32| {
            let f = self.eval_at(At::tile(x, y));
            if let Some(k) = keep.as_deref_mut() {
                k.put(x, y, ResourceInputs::from(&f));
            }
            tile_id(resolve_tile(&f))
        };
        correct_window(&mut raw, &layers, None, origin, size, margin_chunks)
            .into_iter()
            .map(|id| TILE_ORDER[usize::from(id) - 1])
            .collect()
    }
}

/// The resource inputs of the tiles of a rectangle of chunks, filled as a
/// correction pass evaluates them ([`GlebaStack::corrected_tiles_keeping`]).
/// About 40 KB a chunk.
pub struct KeptInputs {
    x0: i32,
    y0: i32,
    width: i32,
    height: i32,
    inputs: Vec<Option<ResourceInputs>>,
}

impl KeptInputs {
    /// Room for the tiles of chunks `cx0..=cx1` by `cy0..=cy1`.
    #[must_use]
    pub fn new((cx0, cx1): (i32, i32), (cy0, cy1): (i32, i32)) -> Self {
        let (width, height) = ((cx1 - cx0 + 1) * 32, (cy1 - cy0 + 1) * 32);
        Self {
            x0: cx0 * 32,
            y0: cy0 * 32,
            width,
            height,
            inputs: vec![None; (width * height) as usize],
        }
    }

    fn index(&self, x: i32, y: i32) -> Option<usize> {
        let (i, j) = (x - self.x0, y - self.y0);
        ((0..self.width).contains(&i) && (0..self.height).contains(&j))
            .then(|| (j * self.width + i) as usize)
    }

    fn put(&mut self, x: i32, y: i32, f: ResourceInputs) {
        if let Some(i) = self.index(x, y) {
            self.inputs[i] = Some(f);
        }
    }

    /// The kept inputs of tile `(x, y)`, if a correction pass evaluated it.
    #[must_use]
    pub fn get(&self, x: i32, y: i32) -> Option<ResourceInputs> {
        self.index(x, y).and_then(|i| self.inputs[i])
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
