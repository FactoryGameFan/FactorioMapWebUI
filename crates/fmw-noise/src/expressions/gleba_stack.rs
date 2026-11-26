//! The whole Gleba field graph, built once per render and evaluated one
//! position at a time.
//!
//! The shape is `AquiloStack`'s: no memo, because the chain is evaluated top to
//! bottom at one position and its intermediates live in locals. The per-render
//! state (every multioctave table, the starting cones and the spot-region cache)
//! lives in [`GlebaTerrain`].
//!
//! This slice grades the terrain fields and the 41-tile choice at tier 1. There
//! is no ABI, render, resource or entity layer yet.

use crate::at::At;
use crate::expressions::gleba_terrain::{GlebaControls, GlebaTerrain, GlebaTerrainFields};
use crate::tiles::gleba_catalog::{resolve_tile, GlebaTile};

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
