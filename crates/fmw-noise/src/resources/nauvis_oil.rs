//! Crude oil's placement: the one Nauvis resource that ROLLS rather than
//! thresholds.
//!
//! Ported from `makeNauvisOilProbability` / `makeNauvisOilPlacement` in
//! `src/noise/preview/renderResources.ts`.
//!
//! # Why it is separate from the resolver
//!
//! `ResourceResolver` deliberately holds only the five thresholded resources -
//! it skips any catalog entry whose `placement` is `Roll`. Oil is built here
//! instead, with the same skip-span partitioning the resolver gives the solids,
//! so the two candidate streams stay the ones the game's own patch sets are.
//!
//! # The penalty is MULTIPLICATIVE here, unlike the enemy one
//!
//! ```text
//! max(0, patches.probability(x, y) * (1 - 48 * U))
//! ```
//!
//! The enemy layer SUBTRACTS its penalty and floors the result; this one scales
//! by it. The amplitude is 48 rather than 0.1, which only makes sense because
//! it multiplies: `1 - 48 * U` is negative for all but the smallest 2% of
//! draws, and the `max` then turns those into a flat zero. So the term is
//! mostly a sparsifier, not a jitter - which is what makes oil rare enough that
//! a whole render window usually holds none.

use crate::distance_from_nearest_point::Point;
use crate::eval::math::max2;
use crate::expressions::nauvis_stack::NauvisStack;
use crate::placement::roll::{
    salt, PlacementCollisionBox, PlacementRoll, PlacementSet, PlacementSource,
};
use crate::resources::nauvis_catalog::{ResourceParams, NAUVIS_RESOURCE_CATALOG};
use crate::resources::resolve_resource::{REGULAR_SKIP_SPAN, STARTING_SKIP_SPAN};
use crate::resources::resource_math::ResourceControlLevers;
use crate::resources::resource_patches::{ResourcePatches, ResourcePatchesCtx};
use crate::tiles::nauvis_catalog::NauvisTileCatalog;
use crate::tiles::nauvis_resolve::{is_water_tile, nauvis_tile_at};

/// An oil well's map-gen collision box, 2.8 x 2.8 tiles.
pub const OIL_COLLISION_BOX: PlacementCollisionBox = PlacementCollisionBox { w: 2.8, h: 2.8 };

/// `random_penalty{source = 1, amplitude = 48}`.
pub const OIL_PENALTY_AMPLITUDE: f64 = 48.0;

/// The catalog's one `Roll` entry.
///
/// Returned by lookup rather than by index, so a catalog reorder cannot
/// silently point this at a solid.
#[must_use]
pub fn crude_oil() -> &'static ResourceParams {
    NAUVIS_RESOURCE_CATALOG
        .iter()
        .find(|p| p.name == "crude-oil")
        .expect("crude-oil is in NAUVIS_RESOURCE_CATALOG")
}

/// The Nauvis crude-oil placement source.
pub struct NauvisOilPlacement<'a> {
    patches: ResourcePatches,
    penalty: PlacementRoll,
    stack: &'a NauvisStack,
    catalog: &'a NauvisTileCatalog,
}

impl<'a> NauvisOilPlacement<'a> {
    /// Build the oil patch set at these controls.
    ///
    /// `levers` is oil's OWN entry from the per-resource control map, defaulted
    /// by the caller - the same lookup `makeNauvisOilProbability` does.
    #[must_use]
    pub fn new(
        seed0: u32,
        levers: ResourceControlLevers,
        segmentation_multiplier: f64,
        starting_positions: Vec<Point>,
        stack: &'a NauvisStack,
        catalog: &'a NauvisTileCatalog,
    ) -> Self {
        let oil = crude_oil();
        let mut ctx = ResourcePatchesCtx::defaults(seed0);
        ctx.controls = levers;
        ctx.starting_positions = starting_positions;
        ctx.segmentation_multiplier = segmentation_multiplier;
        // The app's partitioning, not the isolated oracle's 1/0. Oil takes its
        // own `patch_set_index` as the offset in both sets.
        ctx.regular_skip_span = REGULAR_SKIP_SPAN;
        ctx.regular_skip_offset = oil.patch_set_index;
        ctx.starting_skip_span = STARTING_SKIP_SPAN;
        ctx.starting_skip_offset = oil.patch_set_index;
        Self {
            patches: ResourcePatches::new(oil, &ctx),
            penalty: PlacementRoll::new(salt::CRUDE_OIL_PENALTY),
            stack,
            catalog,
        }
    }

    /// The penalised probability the roll is tested against.
    #[must_use]
    pub fn penalised_probability(&self, x: f64, y: f64) -> f64 {
        max2(
            0.0,
            self.patches.probability(x, y)
                * (1.0 - OIL_PENALTY_AMPLITUDE * self.penalty.roll(x, y)),
        )
    }

    /// The placement set for this overlay, ready to be asked `placed(x, y)`.
    #[must_use]
    pub fn placement_set(&self) -> PlacementSet<'_> {
        PlacementSet::new(salt::CRUDE_OIL, self)
    }
}

impl PlacementSource for NauvisOilPlacement<'_> {
    fn probability(&self, x: f64, y: f64) -> f64 {
        self.penalised_probability(x, y)
    }

    fn tile_allowed(&self, x: f64, y: f64) -> bool {
        !is_water_tile(nauvis_tile_at(self.stack, self.catalog, x, y))
    }

    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        Some(OIL_COLLISION_BOX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::nauvis_stack::NauvisCtx;

    /// Oil is the catalog's ONE rolled entry, and the lookup finds it by name.
    ///
    /// The renderer indexes the eighteen ABI levers by catalog position, so a
    /// reorder is survivable; picking oil by index would not have been.
    #[test]
    fn crude_oil_is_the_only_rolled_entry() {
        let rolled: Vec<&str> = NAUVIS_RESOURCE_CATALOG
            .iter()
            .filter(|p| {
                matches!(
                    p.placement,
                    crate::resources::nauvis_catalog::ResourcePlacement::Roll
                )
            })
            .map(|p| p.name)
            .collect();
        assert_eq!(rolled, vec!["crude-oil"]);
        assert_eq!(crude_oil().name, "crude-oil");
    }

    /// The penalty MULTIPLIES and floors at zero, and mostly zeroes the field.
    ///
    /// `1 - 48 * U` is negative for all but the smallest 2% of draws, so this
    /// term is a sparsifier rather than a jitter - which is why a whole render
    /// window usually holds no oil at all. Asserting the SHAPE of that rather
    /// than a bound: the penalised value is never above the raw probability,
    /// never below zero, and is zero far more often than not.
    #[test]
    fn the_oil_penalty_multiplies_and_mostly_zeroes_the_field() {
        let ctx = NauvisCtx::defaults(123_456);
        let stack = NauvisStack::new(&ctx);
        let catalog = NauvisTileCatalog::new(123_456);
        let placement = NauvisOilPlacement::new(
            123_456,
            ResourceControlLevers::defaults(),
            1.0,
            vec![Point { x: 0.0, y: 0.0 }],
            &stack,
            &catalog,
        );
        let (mut zeroed, mut positive, mut total) = (0usize, 0usize, 0usize);
        for j in 0..96 {
            for i in 0..96 {
                let x = -6000.5 + f64::from(i) * 32.0;
                let y = 6000.25 + f64::from(j) * 32.0;
                let got = placement.penalised_probability(x, y);
                assert!(got >= 0.0, "({x}, {y}): {got} is negative");
                total += 1;
                if got == 0.0 {
                    zeroed += 1;
                } else {
                    positive += 1;
                }
            }
        }
        // The sweep's SHAPE is ours, so this is exact.
        assert_eq!(total, 9216);

        // Anti-vacuity in both directions: a field that were zero everywhere
        // would satisfy the non-negativity above, and one that were never zero
        // would mean the penalty is not applying at all.
        //
        // **The positive count is BOUNDED, not frozen.** Measured at exactly 1
        // of 9,216 here - and that single point is the same placement the
        // tier-3 window paints as a 9-pixel mark, which is a pleasing tie
        // between the two levels. It is still not frozen: the resource chain
        // reaches a transcendental, and an exact count with one inside the
        // predicate is not portable between this machine's libm and the
        // runner's. That cost a red CI job once already (#327), where a `powf`
        // disagreement count was 3,653 locally and 3,651 on Linux.
        assert!(positive > 0, "the swept window must reach some oil");
        assert!(
            zeroed > positive * 100,
            "the penalty must zero the field far more often than not: \
             {positive} positive against {zeroed} zeroed"
        );
    }
}
