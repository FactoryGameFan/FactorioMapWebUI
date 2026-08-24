//! Where the Vulcanus rock overlay actually places rocks: the roll against
//! `density`, gated by tile restriction and by collision.
//!
//! Ported from `makeVulcanusRockPlacement` in
//! `src/noise/preview/renderVulcanusRocks.ts`. Rolling `density` alone
//! over-places by ~2x against the game; the two gates are what close it.

use crate::placement::roll::{salt, PlacementCollisionBox, PlacementSet, PlacementSource};
use crate::rocks::catalog::{lattice_snap, ROCK_FIELD_LATTICE};
use crate::rocks::vulcanus_field::VulcanusRockFields;
use crate::tiles::vulcanus_catalog::VulcanusTile;

/// `huge-volcanic-rock`'s collision box, 3 x 2.2 tiles.
///
/// **Why the huge box everywhere, and not the box of whichever prototype wins
/// the tile.** The obvious rule - `density` is `max(rock_huge, rock_big)`, so
/// use the box of the argmax - is degenerate, because `rock_big >= rock_huge`
/// is a theorem (see `vulcanus_field`'s own test). Measured `hugeWinShare` is
/// 0.0000 over all three oracle regions, so an argmax rule picks the small
/// 1.5 x 1.5 box at every position on the map. Relative error against the
/// game's own entity counts:
///
/// | box rule | region 2 | region 3 | region 4 |
/// | --- | --- | --- | --- |
/// | argmax, i.e. big everywhere | 23.5% | 27.1% | 13.1% |
/// | argmax with ties to huge | 18.6% | 22.3% | 10.2% |
/// | **huge everywhere** | **0.2%** | **0.6%** | **7.5%** |
///
/// **What that settles and what it does not.** It is not a derivation - the
/// exclusion radius was CHOSEN by comparing two candidates. What the counts
/// support is that the game's effective exclusion sits BETWEEN the two boxes,
/// close to the huge end: the all-huge model under-counts in all three regions
/// and the all-big model overshoots by 13-27%.
///
/// The game's own population is ~28% huge, which the max-probability
/// arbitration this port models cannot produce at all - it predicts 0% huge.
/// So the tile-level huge/big identity is known WRONG here rather than merely
/// unvalidated; the claim this overlay makes is density, not identity.
pub const VOLCANIC_ROCK_COLLISION_BOX: PlacementCollisionBox =
    PlacementCollisionBox { w: 3.0, h: 2.2 };

/// The Vulcanus rock placement source: the density, the lava gate and the box.
pub struct VulcanusRockPlacement<'a, 'b, 'c> {
    fields: &'a VulcanusRockFields<'b, 'c>,
}

impl<'a, 'b, 'c> VulcanusRockPlacement<'a, 'b, 'c> {
    #[must_use]
    pub fn new(fields: &'a VulcanusRockFields<'b, 'c>) -> Self {
        Self { fields }
    }

    /// The placement set for this overlay, ready to be asked `placed(x, y)`.
    #[must_use]
    pub fn placement_set(&self) -> PlacementSet<'_> {
        PlacementSet::new(salt::VULCANUS_ROCKS, self)
    }
}

impl PlacementSource for VulcanusRockPlacement<'_, '_, '_> {
    fn probability(&self, x: f64, y: f64) -> f64 {
        // Snapped to `ROCK_FIELD_LATTICE`, which ships at 1 and makes this the
        // identity. The wrapper stays so the lattice is a one-constant
        // experiment on both sides at once - see `catalog::ROCK_FIELD_LATTICE`.
        self.fields
            .eval(
                lattice_snap(x, ROCK_FIELD_LATTICE),
                lattice_snap(y, ROCK_FIELD_LATTICE),
            )
            .density
    }

    /// The two Vulcanus tiles no rock may sit on.
    ///
    /// All four rock prototypes restrict to `vulcanus_tiles_cold` /
    /// `vulcanus_tiles_hot`
    /// (`space-age/prototypes/decorative/decoratives-vulcanus.lua:37-60`), and
    /// the union of those two lists is every Vulcanus tile EXCEPT these.
    ///
    /// Derived from the ported tile resolver rather than from rendered pixel
    /// colours: the chunk resolver asks about tiles outside the render window,
    /// and reading the output buffer would make the answer window-dependent.
    fn tile_allowed(&self, x: f64, y: f64) -> bool {
        !matches!(
            self.fields.stack().tile(x, y),
            VulcanusTile::Lava | VulcanusTile::LavaHot
        )
    }

    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        Some(VOLCANIC_ROCK_COLLISION_BOX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::ctx::EvalCtx;
    use crate::expressions::vulcanus_stack::{VulcanusBase, VulcanusStack};

    /// The collision box is the HUGE rock's, and its two axes differ. A square
    /// box would be a plausible-looking transcription of a 3 x 2.2 prototype
    /// and would change the density.
    #[test]
    fn the_box_is_the_huge_rocks_and_is_not_square() {
        assert_eq!(VOLCANIC_ROCK_COLLISION_BOX.w, 3.0);
        assert_eq!(VOLCANIC_ROCK_COLLISION_BOX.h, 2.2);
        assert_ne!(VOLCANIC_ROCK_COLLISION_BOX.w, VOLCANIC_ROCK_COLLISION_BOX.h);
    }

    /// The lava gate rejects, and it rejects lava rather than something else.
    ///
    /// Checked by finding lava tiles through the resolver and asserting the
    /// gate refuses exactly those - so a gate wired to the wrong tile pair
    /// fails here rather than shifting a density by a few percent.
    #[test]
    fn the_tile_gate_refuses_exactly_the_two_lava_tiles() {
        let ctx = EvalCtx::new(1_249_936_247);
        let base = VulcanusBase::with_host_trig(&ctx);
        let biomes = base.biomes_with_host_trig();
        let stack = VulcanusStack::with_host_trig(&base, &biomes);
        let fields = VulcanusRockFields::new(&stack, ctx.seed0);
        let placement = VulcanusRockPlacement::new(&fields);

        // A window with lava in it. The ORIGIN has none at this seed - a
        // -80..80 square around spawn is 25,600 tiles of dry land - so a test
        // written there would assert nothing and look fine.
        let mut lava = 0usize;
        let mut land = 0usize;
        for ty in 0..64 {
            for tx in -208..-144 {
                let (x, y) = (f64::from(tx), f64::from(ty));
                let is_lava =
                    matches!(stack.tile(x, y), VulcanusTile::Lava | VulcanusTile::LavaHot);
                assert_eq!(placement.tile_allowed(x, y), !is_lava, "({x}, {y})");
                if is_lava {
                    lava += 1;
                } else {
                    land += 1;
                }
            }
        }
        // Non-vacuity: this window must contain both, or the assertion above
        // never sees a rejection.
        assert!(lava > 0 && land > 0, "lava {lava}, land {land}");
    }
}
