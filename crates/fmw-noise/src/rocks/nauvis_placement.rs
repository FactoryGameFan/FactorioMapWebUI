//! Where the Nauvis rock overlay actually places rocks: the roll against
//! `rock_density`, gated by the water restriction and by collision against
//! rocks already placed in the same chunk.
//!
//! Ported from `makeNauvisRockPlacement` in
//! `src/noise/preview/renderRocks.ts`, whose doc block carries the validation
//! against the game's own per-region entity counts.

use crate::expressions::nauvis_stack::NauvisStack;
use crate::placement::roll::{salt, PlacementCollisionBox, PlacementSet, PlacementSource};
use crate::rocks::catalog::{lattice_snap, ROCK_FIELD_LATTICE};
use crate::rocks::field::NauvisRockFields;
use crate::tiles::nauvis_catalog::NauvisTileCatalog;
use crate::tiles::nauvis_resolve::{is_water_tile, nauvis_tile_at};

/// `huge-rock`'s collision box, 3 x 2.2 tiles.
pub const HUGE_ROCK_BOX: PlacementCollisionBox = PlacementCollisionBox { w: 3.0, h: 2.2 };
/// `big-rock`'s collision box, 2 x 1.9 tiles.
pub const BIG_ROCK_BOX: PlacementCollisionBox = PlacementCollisionBox { w: 2.0, h: 1.9 };
/// `big-sand-rock`'s collision box, 1.5 x 1.5 tiles.
pub const BIG_SAND_ROCK_BOX: PlacementCollisionBox = PlacementCollisionBox { w: 1.5, h: 1.5 };

/// The collision box of whichever prototype has the highest probability here.
///
/// **The argmax rule, unlike Vulcanus's.** There the rule is degenerate - one
/// prototype provably never wins, so `vulcanus_placement` uses the huge box
/// everywhere and says why. Here it is only PARTLY degenerate: `huge-rock`
/// still cannot win (`big = 0.17*(T - 1.6)` beats `huge = 0.07*(T - 1.7)`
/// wherever either is positive at all), but `big-sand-rock` genuinely can, so
/// the argmax picks between two live boxes rather than one.
///
/// The comparison order and the `>=` are the TypeScript's exactly: sand needs
/// to beat BOTH strictly, and a big/huge tie goes to big.
#[must_use]
pub fn rock_collision_box_for(huge: f64, big: f64, sand: f64) -> PlacementCollisionBox {
    if sand > big && sand > huge {
        return BIG_SAND_ROCK_BOX;
    }
    if big >= huge {
        return BIG_ROCK_BOX;
    }
    HUGE_ROCK_BOX
}

/// The Nauvis rock placement source: the density, the water gate and the box.
pub struct NauvisRockPlacement<'a> {
    fields: &'a NauvisRockFields,
    stack: &'a NauvisStack,
    catalog: &'a NauvisTileCatalog,
}

impl<'a> NauvisRockPlacement<'a> {
    #[must_use]
    pub fn new(
        fields: &'a NauvisRockFields,
        stack: &'a NauvisStack,
        catalog: &'a NauvisTileCatalog,
    ) -> Self {
        Self {
            fields,
            stack,
            catalog,
        }
    }

    /// The placement set for this overlay, ready to be asked `placed(x, y)`.
    #[must_use]
    pub fn placement_set(&self) -> PlacementSet<'_> {
        PlacementSet::new(salt::NAUVIS_ROCKS, self)
    }
}

impl PlacementSource for NauvisRockPlacement<'_> {
    fn probability(&self, x: f64, y: f64) -> f64 {
        // Snapped to `ROCK_FIELD_LATTICE`, which ships at 1 and makes this the
        // identity. The wrapper stays so the lattice is a one-constant
        // experiment on both sides at once - see `catalog::ROCK_FIELD_LATTICE`.
        // `density`, NOT `rock_density`. The latter is the game's named
        // expression that `oracle-rock-density` holds; the placement rolls
        // against the CLAMPED max of the three prototype probabilities, which
        // is what `density` is. Rolling the named expression instead placed
        // about 35x too many rocks, because it is unclamped and much larger.
        self.fields.density(
            lattice_snap(x, ROCK_FIELD_LATTICE),
            lattice_snap(y, ROCK_FIELD_LATTICE),
        )
    }

    fn tile_allowed(&self, x: f64, y: f64) -> bool {
        // Derived from the tile resolver, NOT from rendered pixel colours: the
        // chunk resolver asks about tiles outside the render window, and reading
        // the image would make the answer window-dependent.
        !is_water_tile(nauvis_tile_at(self.stack, self.catalog, x, y))
    }

    fn collision_box(&self, x: f64, y: f64) -> Option<PlacementCollisionBox> {
        let p = self.fields.at(x, y);
        Some(rock_collision_box_for(p.huge, p.big, p.sand))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The argmax rule's three branches, including the two ties.
    ///
    /// Written as a table because the TypeScript's shape is easy to mirror
    /// wrongly in a way nothing else catches: `sand` needs to beat BOTH
    /// strictly, and a `big`/`huge` tie goes to `big`. A collision box is only
    /// visible in placement DENSITY, so a wrong branch here shifts rock counts
    /// slightly and nothing points at this function.
    #[test]
    fn the_collision_box_argmax_matches_the_typescripts_branches() {
        let cases: [(f64, f64, f64, PlacementCollisionBox, &str); 6] = [
            (0.0, 0.0, 1.0, BIG_SAND_ROCK_BOX, "sand wins outright"),
            (0.0, 1.0, 0.0, BIG_ROCK_BOX, "big wins outright"),
            (1.0, 0.0, 0.0, HUGE_ROCK_BOX, "huge wins outright"),
            // Sand must beat both STRICTLY, so a tie with big is not a sand win.
            (0.0, 1.0, 1.0, BIG_ROCK_BOX, "sand ties big: big wins"),
            // ...and a tie with huge alone is still not enough.
            (1.0, 0.0, 1.0, HUGE_ROCK_BOX, "sand ties huge: huge wins"),
            // A big/huge tie goes to big, because the test is `big >= huge`.
            (1.0, 1.0, 0.0, BIG_ROCK_BOX, "big ties huge: big wins"),
        ];
        for (huge, big, sand, want, why) in cases {
            let got = rock_collision_box_for(huge, big, sand);
            assert!(
                (got.w - want.w).abs() < f64::EPSILON && (got.h - want.h).abs() < f64::EPSILON,
                "{why}: got {got:?}, want {want:?}"
            );
        }
    }

    /// The three boxes are distinct, or the table above grades nothing.
    #[test]
    fn the_three_collision_boxes_differ() {
        let boxes = [HUGE_ROCK_BOX, BIG_ROCK_BOX, BIG_SAND_ROCK_BOX];
        for i in 0..boxes.len() {
            for j in (i + 1)..boxes.len() {
                assert!(
                    (boxes[i].w - boxes[j].w).abs() > f64::EPSILON
                        || (boxes[i].h - boxes[j].h).abs() > f64::EPSILON,
                    "boxes {i} and {j} are equal, so the argmax test cannot discriminate"
                );
            }
        }
    }
}
