//! The Vulcanus resource catalog, ported from
//! `src/noise/resources/vulcanusResourceCatalog.ts`.
//!
//! **Partial by design.** The cliff stack needs the solid-ore footprint and
//! nothing else; the map colours, the entry ordering and the geyser's rolled
//! probability serve the resource overlay and land with it. What is here is the
//! whole of what the cliff rejection reads.

use crate::eval::ctx::VulcanusResourceControls;
use crate::expressions::vulcanus_stack::VulcanusStack;

/// The threshold a solid ore's probability must clear for the game to have
/// placed an entity on that tile: `probability >= 0.5`.
///
/// **This lives in the catalog rather than in a renderer because it has two
/// consumers.** The resource overlay paints with it, and the ore -> cliff
/// rejection asks the same question to decide whether an ore suppresses a
/// cliff. Two copies of the number could drift apart, and the cliff overlay
/// would then reject against a footprint the ore overlay does not draw - a
/// disagreement invisible in both renders.
pub const RESOURCE_PROBABILITY_THRESHOLD: f64 = 0.5;

/// Does the game hold a solid-ore entity on the tile whose centre is
/// `(x + 0.5, y + 0.5)`?
///
/// The three solid ores THRESHOLD, so their footprint is exactly
/// `1000 * region >= RESOURCE_PROBABILITY_THRESHOLD` over the entries whose
/// `size` lever is positive. A disabled ore occupies nothing, which is not a
/// special case bolted on: it is the same `size = 0` lever the game itself was
/// driven with to establish that ore suppresses cliffs (#99).
///
/// The geyser is deliberately absent - it ROLLS rather than thresholds, so it
/// has no footprint expressible this way. Callers that want it pass their own
/// predicate.
///
/// **The field is sampled at the tile's integer coordinate, not at its centre.**
/// That is what the TypeScript does and what the measurement was made with; the
/// doc comment above describes which tile the answer is about, not where the
/// sample is taken.
pub struct VulcanusOreFootprint {
    tungsten: bool,
    coal: bool,
    calcite: bool,
}

impl VulcanusOreFootprint {
    #[must_use]
    pub fn new(controls: &VulcanusResourceControls) -> Self {
        Self {
            tungsten: controls.tungsten_ore.size > 0.0,
            coal: controls.vulcanus_coal.size > 0.0,
            calcite: controls.calcite.size > 0.0,
        }
    }

    /// True when no ore is enabled, so the whole rejection can be skipped.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        !self.tungsten && !self.coal && !self.calcite
    }

    /// Whether a solid ore stands on tile `(tx, ty)`.
    #[must_use]
    pub fn occupies(&self, stack: &VulcanusStack<'_>, tx: i64, ty: i64) -> bool {
        if self.is_empty() {
            return false;
        }
        #[allow(clippy::cast_precision_loss)]
        let r = stack.ore_regions(tx as f64, ty as f64);
        (self.tungsten && 1000.0 * r.tungsten >= RESOURCE_PROBABILITY_THRESHOLD)
            || (self.calcite && 1000.0 * r.calcite >= RESOURCE_PROBABILITY_THRESHOLD)
            || (self.coal && 1000.0 * r.coal >= RESOURCE_PROBABILITY_THRESHOLD)
    }
}
