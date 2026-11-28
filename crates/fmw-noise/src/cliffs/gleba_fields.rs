//! Gleba's two cliff fields (#454, the cliffs slice).
//!
//! From `space-age/prototypes/planet/planet-gleba-map-gen.lua` and
//! `planet-map-gen.lua` at 2.1.23: the surface maps `cliffiness` to
//! `gleba_cliffiness` and leaves `cliff_elevation` at
//! `cliff_elevation_from_elevation`, which is `elevation`, which Gleba maps to
//! `gleba_elevation`. Gleba's map gen has no `multisample`, so unlike
//! Vulcanus the cliff lattice reads the same elevation the tiles do.
//!
//! ```text
//! gleba_cliffiness = max(0.95 * cliffiness_basic, 0.99 * (gleba_rockpools > 0))
//! ```
//!
//! `cliffiness_basic` takes `log2(cliff_richness)`, and Gleba's cliff richness
//! is 0.8, not Vulcanus's 1. See [`CliffinessBasic::new`] for why a `log2`
//! inside the module is a hazard; the tier-1 test grades it.

use crate::at::At;
use crate::cliffs::placement::CliffFields;
use crate::cliffs::vulcanus_fields::CliffinessBasic;
use crate::eval::math::{f32r, max2};
use crate::expressions::gleba_stack::GlebaStack;

/// `cliff_settings` on a Gleba surface, as the game reads them back:
/// `cliff_elevation_0`, `cliff_elevation_interval`, `richness` (an f32 0.8)
/// and `cliff_smoothing`.
pub const GLEBA_CLIFF_ELEVATION_0: f64 = 40.0;
pub const GLEBA_CLIFF_ELEVATION_INTERVAL: f64 = 60.0;
pub const GLEBA_CLIFF_RICHNESS: f64 = 0.800_000_011_920_929;
pub const GLEBA_CLIFF_SMOOTHING: f64 = 0.0;

/// Both fields the placement pass needs, for one Gleba stack.
pub struct GlebaCliffFields<'a> {
    stack: &'a GlebaStack,
    basic: CliffinessBasic,
}

impl<'a> GlebaCliffFields<'a> {
    /// `cliff_richness` is the surface's cliff richness times the
    /// `gleba_cliff` control's richness lever.
    #[must_use]
    pub fn new(stack: &'a GlebaStack, seed0: u32, cliff_richness: f64) -> Self {
        Self {
            stack,
            basic: CliffinessBasic::new(seed0, cliff_richness),
        }
    }

    /// `cliffiness_basic` at a point.
    #[must_use]
    pub fn cliffiness_basic(&self, x: f64, y: f64) -> f64 {
        self.basic.eval(x, y)
    }
}

impl CliffFields for GlebaCliffFields<'_> {
    fn cliff_elevation(&self, x: f64, y: f64) -> f64 {
        self.stack.eval_at(At::point(x, y)).elevation
    }

    fn cliffiness(&self, x: f64, y: f64) -> f64 {
        let rockpools = self.stack.eval_at(At::point(x, y)).rockpools;
        let pool = if rockpools > 0.0 { 1.0 } else { 0.0 };
        max2(
            f32r(f32r(0.95) * self.basic.eval(x, y)),
            f32r(f32r(0.99) * pool),
        )
    }
}
