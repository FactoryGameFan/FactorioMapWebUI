//! The ORE -> CLIFF removal: a placed resource entity destroys every cliff
//! whose collision box reaches it.
//!
//! Ported from `src/noise/cliffs/vulcanusOreRejection.ts`, whose module comment
//! carries the evidence trail up to the point where the geometry was read off
//! the binary. What a reader of this port needs:
//!
//! ## The mechanism is named, and so is the geometry
//!
//! **The mechanism is `ResourceEntityPrototype::cliff_removal_probability`**,
//! settled 2026-08-14 by a PROTOTYPE lever rather than a surface one. It
//! defaults to `1.0` and no shipped prototype overrides it, so it is invisible
//! from the data alone. Zeroing that one field - leaving all 945 resource
//! entities exactly where they are - is indistinguishable from switching the
//! resources off entirely. At 1.0 the removal is unconditional, so no roll is
//! modelled here.
//!
//! **The geometry is `ResourceEntity::postSetup`'s** (2.0.77,
//! ResourceEntity.cpp:103-137; read 2026-09-12, #84, and landed here in
//! #414). It runs when the resource entity is added to the surface, in
//! `applyEntities`, after `applyCliffs`:
//!
//! 1. The resource's own positioned collision box is widened OUTWARD to whole
//!    tiles - `and w, w, #0xffffff00` on the left and top edges, that plus
//!    `#0x100` on the right and bottom. A solid ore's box (`+/-25/256`) stays
//!    inside its tile, so its search box is exactly the tile's square; the
//!    geyser's `2.8 x 2.8` box widens to the 3x3 of tiles around it.
//! 2. `EntitySearch<Cliff>` over that box keeps each cliff for which
//!    `BoundingBox::collide(cliff.box, search)` is true - the oriented
//!    separating-axis test of [`super::collision::box_collide`], with the
//!    cliff's positioned per-orientation box as the first argument and its
//!    `rotbb` word kept. So the reach is the CLIFF's box, up to 4.5 tiles,
//!    not the resource's.
//! 3. Every cliff found is `forceDestroy`ed.
//!
//! This module is that search from the cliff's side. For one cell it lists
//! the tiles whose search box the cell's oriented box reaches, and asks the
//! port's ore field ([`VulcanusOreFootprint`]) whether a solid ore stands on
//! any of them. Graded on the game's own resource entities, so the port's ore
//! field is out of the comparison, the engine geometry takes the apply-stage
//! table from 1627/26/56/3 to 1634/17/22/5 (matched/wrong/surplus/missing)
//! and the crossing-stage table from 1620/34/59/2 to 1628/24/25/4; the test
//! is `the_removal_box_is_the_resources_tile_widened_aabb_against_the_cliffs_oriented_box`
//! in `fixtures.rs`, and `docs/noise/vulcanus-cliffs-NOTES.md` (2026-09-12)
//! holds the disassembly notes and the three controls that each lose the way
//! their omission predicts.
//!
//! ## What shipped before, and why it was kept as a control
//!
//! Until #414 the rule tested the prototype's BASE `collision_box`
//! ([`VULCANUS_CLIFF_BASE_COLLISION_BOX`], `+/-0.988 x +/-0.488`) for a strict
//! overlap with the ore's own box at the tile centre - an empirical fit that
//! reached exactly two tiles per cell and explained 21 of the 31 cells the
//! lever attributed to the ore, precision 1.000 and recall 0.710. On the
//! game's entities it keeps 50 of the 56 surplus the engine geometry removes,
//! because a tile-sized box cannot reach past a tile. The constant stays so
//! the fixtures can still run that arm beside the engine's.
//!
//! ## Timing: the removal reads the LIVE orientation
//!
//! `postSetup` runs after `applyCliffs` and its cascades, and `EntitySearch`
//! reads the cliff's box as it THEN stands. `Surface::wouldCollide` reads the
//! queued one (#407). At the crossing stage, where the shipping renderer
//! rejects, the code is the queued code and the distinction has no home; the
//! apply-stage harness in [`super::connections`] runs this removal as its own
//! phase after the collision destroys, through
//! [`super::connections::CliffRemoval`].
//!
//! **Measured, not adopted:** the apply-stage harness can run this removal as
//! its own phase after the collision destroys, reading each cliff's LIVE
//! orientation ([`super::connections::CliffRemoval`]), which is the engine's
//! order. Graded on the game's entities it scores WORSE than reading the
//! queued orientation at the collision phase - 1633/18/27/5 against
//! 1634/17/22/5 - because it keeps none of the four timing cells (each is
//! trimmed later, by `updateConnections` or a later chunk's cascade) and
//! spares five cells the game removed whose queued box reached a resource and
//! whose live box did not. The game's answer depends on its chunk generation
//! order, which the port cannot know; the queued reading is the better model
//! of it, and the phase stays as a control the removal test can re-run.
//!
//! ## The field's boundary is the game's own roll
//!
//! The game's ore probability is `1000 * ((1 + region) * rp - 1)` with
//! `rp = random_penalty_between(0.9, 1, 1)`, a batch-op roll per tile. The
//! port used to take `rp` as 1, which made its footprint one ring fatter than
//! the game's entities, and the oriented box reaches that ring constantly.
//! Before the roll landed, against the game's 1,190 calcite tiles at frequency
//! 0.5, over the 11,362 tiles the rule reads there
//! (`the_ore_field_where_the_cliff_rule_reads_it_at_frequency_half`):
//!
//! | `1000 * region >=` | the `rp` it assumes | game-only | port-only |
//! | -----------------: | ------------------- | --------: | --------: |
//! |              `0.5` | 1, the overlay's    |         0 |        83 |
//! |             `53.2` | 0.95, the midpoint  |        43 |        27 |
//! |            `111.7` | 0.9, the floor      |       226 |         0 |
//!
//! No threshold reproduces a roll, so the rule shipped at the midpoint. The
//! roll itself is now reproduced -
//! [`VulcanusOreRoll`](crate::resources::vulcanus_ore_roll::VulcanusOreRoll),
//! one chunk batch per tile, which places every one of those 1,190 tiles and
//! no other - and [`VulcanusOreFootprint`] reads it, so this rule and the ore
//! overlay now ask the same question.
//!
//! What that is worth on the shipping path, both regions of the removal test
//! at the crossing stage, matched/wrong/surplus/missing: the base box scored
//! 1620/34/59/2; the engine geometry at the overlay's threshold
//! 1608/35/49/13; at the midpoint 1618/33/51/5; with the roll
//! 1620/32/50/4. The rest of the gap to the game's entities, 1628/24/25/4,
//! is the sulfuric-acid geyser. The port's own geyser roll wired in through
//! [`GeyserPlacement`] was measured too, at the midpoint: 1591/35/38/30. It
//! halves the surplus and more than doubles the missing, since the roll's
//! positions are not the game's, so the geyser stays out. Seeding that roll
//! the way the game seeds `generateEntities` does not fix it: 0 to 1 of the
//! game's 44 geysers in the two regions, with or without the solid ores
//! competing for the tile.
//!
//! The rival candidate stays refuted: cliffs are both computed and placed
//! BEFORE any resource entity exists, and the masks are disjoint anyway, so no
//! collision test can see an entity that is not there yet. Where the rule DOES
//! act is at the destroy stage, which is what a field named
//! `cliff_removal_probability` predicts.

use crate::cliffs::catalog::{cliff_orientation_for_code, CliffCollisionBox};
use crate::cliffs::collision::{
    box_collide, get_aabb, placed_box, rotation_word, FixedBox, RotationWord, NO_ROTATION,
};
use crate::cliffs::placement::CellRejection;
use crate::eval::ctx::VulcanusResourceControls;
use crate::expressions::vulcanus_stack::VulcanusStack;
use crate::poison;
use crate::resources::vulcanus_catalog::VulcanusOreFootprint;

/// `cliff-vulcanus`'s prototype `collision_box`, read off a running game
/// (`LuaEntityPrototype.collision_box`).
///
/// Quantised to `1/256` because `MapPosition` is 8-bit fixed point:
/// `0.98828125 = 253/256`, `0.48828125 = 125/256`.
///
/// **Not the box this module tests with** since #414 - that is the
/// per-orientation box the engine's search reads. Kept for the fixture arm
/// that grades the old shape as a control; see the module docs.
pub const VULCANUS_CLIFF_BASE_COLLISION_BOX: CliffCollisionBox =
    [-0.988_281_25, -0.488_281_25, 0.988_281_25, 0.488_281_25];

/// The three solid ores' collision half-extent, `0.09765625 = 25/256`,
/// identical across `tungsten-ore`, `calcite` and `coal`.
pub const VULCANUS_ORE_COLLISION_HALF: f64 = 0.097_656_25;

/// `sulfuric-acid-geyser`'s collision half-extent, `1.3984375 = 358/256` - the
/// 2.8 x 2.8 box from `space-age/prototypes/entity/resources.lua:182`.
///
/// More than fourteen times the ores' in each axis. Under the engine geometry
/// that only matters through the tile widening: an ore's search box is its
/// own tile, the geyser's is the 3x3 around it.
pub const VULCANUS_GEYSER_COLLISION_HALF: f64 = 1.398_437_5;

/// A geyser placement predicate, for the arm that includes the geyser.
///
/// Injected rather than built here because the geyser ROLLS: reproducing it
/// needs the placement machinery, which is the resource overlay's, not this
/// module's.
pub trait GeyserPlacement {
    fn geyser_at(&self, x: i64, y: i64) -> bool;
}

/// The ore -> cliff removal for one Vulcanus stack.
pub struct VulcanusOreRejection<'a, 'b> {
    stack: &'a VulcanusStack<'b>,
    footprint: VulcanusOreFootprint,
    /// Include the sulfuric-acid geyser as a removing entity. **Off unless a
    /// predicate is supplied**, and that default is a measurement rather than
    /// caution for its own sake.
    ///
    /// The three solid ores THRESHOLD off region fields the oracle validates to
    /// ~1e-3, and the region saturates, so their footprint boundary is sharp and
    /// essentially deterministic. The geyser ROLLS: its placements are
    /// salt-dependent, and re-running one region over eight salts gives 46-63
    /// entities against the game's 56. A geyser our model puts in the wrong
    /// place, with a 3x3 search box, removes a cliff the game KEPT - a false
    /// removal, which costs recall. This rule is otherwise pure precision, so
    /// recall loss is the one outcome worth gating against. What leaving it
    /// out costs is measured: 23 of the 28 cells the game's rule removed in
    /// the frequency-0.5 region and the port's did not were geyser removals
    /// (`the_ore_field_where_the_cliff_rule_reads_it_at_frequency_half`).
    geyser: Option<&'a dyn GeyserPlacement>,
}

impl<'a, 'b> VulcanusOreRejection<'a, 'b> {
    #[must_use]
    pub fn new(stack: &'a VulcanusStack<'b>, controls: &VulcanusResourceControls) -> Self {
        Self {
            stack,
            footprint: VulcanusOreFootprint::new(controls),
            geyser: None,
        }
    }

    #[must_use]
    pub fn with_geyser(mut self, g: &'a dyn GeyserPlacement) -> Self {
        self.geyser = Some(g);
        self
    }

    /// `ResourceEntity::postSetup`'s search, from the cliff's side: whether a
    /// cliff of `orientation` centred at `(x, y)` has a resource whose search
    /// box its ORIENTED box reaches - a solid ore of the port's field, or a
    /// geyser when one is wired in.
    ///
    /// The orientation is the caller's to choose, and the choice is the
    /// timing question in the module docs: the game reads the LIVE one.
    #[must_use]
    pub fn removes(&self, orientation: u8, x: f64, y: f64) -> bool {
        let cliff = placed_box(orientation, x, y);
        let rot = rotation_word(orientation);
        let aabb = get_aabb(&cliff, rot);
        if !self.footprint.is_empty()
            && reaches_an_occupied_tile(
                &cliff,
                rot,
                &aabb,
                VULCANUS_ORE_COLLISION_HALF,
                |tx, ty| self.footprint.occupies(self.stack, tx, ty),
            )
        {
            return poison::bool_result(true);
        }
        if let Some(g) = self.geyser {
            if reaches_an_occupied_tile(
                &cliff,
                rot,
                &aabb,
                VULCANUS_GEYSER_COLLISION_HALF,
                |tx, ty| g.geyser_at(tx, ty),
            ) {
                return poison::bool_result(true);
            }
        }
        poison::bool_result(false)
    }
}

/// The search box a resource of collision half-extent `half` standing on tile
/// `(tx, ty)` removes cliffs with, in 1/256 units: its positioned box widened
/// outward to whole tiles the way `postSetup` widens it.
///
/// The entity stands at the tile centre and `half` is a `1/256` multiple, so
/// the products are exact. `& !0xff` on a two's-complement edge floors it to
/// its tile, which is the `and w, w, #0xffffff00` in the binary, and the high
/// edges then take one whole tile more.
fn search_box(tx: i64, ty: i64, half: f64) -> FixedBox {
    let (lo, hi) = search_extent(half);
    #[allow(clippy::cast_possible_truncation)]
    let (tx, ty) = (tx as i32 * 256, ty as i32 * 256);
    [tx + lo, ty + lo, tx + hi, ty + hi]
}

/// The widened search box's two edges relative to the tile's origin, in
/// 1/256 units - `lo <= 0` and `hi >= 256`.
fn search_extent(half: f64) -> (i32, i32) {
    #[allow(clippy::cast_possible_truncation)]
    let raw_lo = ((0.5 - half) * 256.0) as i32;
    #[allow(clippy::cast_possible_truncation)]
    let raw_hi = ((0.5 + half) * 256.0) as i32;
    (raw_lo & !0xff, (raw_hi & !0xff) + 0x100)
}

/// The inclusive tile range on one axis whose search boxes can touch the
/// cliff's AABB span `[lo, hi]`, given the search box's relative extent
/// `(ext_lo, ext_hi)`.
///
/// Derived, not written down: a tile `t`'s search box spans
/// `[t*256 + ext_lo, t*256 + ext_hi]`, and [`box_collide`] counts a touching
/// edge, so the box can reach the span when `t*256 + ext_lo <= hi` and
/// `t*256 + ext_hi >= lo` - then ONE TILE MORE on each side, because the
/// AABB is not quite the oriented box: [`get_aabb`] truncates each rotated
/// vertex toward zero, while the separating-axis test runs in f64 on the
/// untruncated rectangle, so a corner box can touch a tile edge one unit past
/// its AABB. `east-to-north` at the origin cell reaches tile `(3, 3)` that way,
/// and `tests::no_tile_outside_the_range_can_reach_the_oriented_box` keeps
/// both halves of that: nothing outside the widened range is reached, and
/// something outside the tight one is.
fn tile_range(lo: i32, hi: i32, ext: (i32, i32)) -> (i64, i64) {
    let (min, max) = tight_tile_range(lo, hi, ext);
    (min - 1, max + 1)
}

/// The range of tiles whose search box touches the AABB span itself - the
/// closed form [`tile_range`] widens. Only that test reads it directly.
fn tight_tile_range(lo: i32, hi: i32, ext: (i32, i32)) -> (i64, i64) {
    let min = i64::from(lo - ext.1).div_euclid(256) + i64::from((lo - ext.1).rem_euclid(256) != 0);
    let max = i64::from(hi - ext.0).div_euclid(256);
    (min, max)
}

/// Walk the tiles whose search box the oriented cliff box reaches, asking
/// `occupied` about each in turn, and stop at the first hit.
///
/// The geometry runs first and the field second, because the field is the
/// expensive half: [`VulcanusOreFootprint::occupies`] evaluates the ore
/// regions at that tile, and a corner box's 45-degree rectangle reaches
/// fewer tiles than its square AABB scans.
fn reaches_an_occupied_tile(
    cliff: &FixedBox,
    rot: RotationWord,
    aabb: &FixedBox,
    half: f64,
    mut occupied: impl FnMut(i64, i64) -> bool,
) -> bool {
    let ext = search_extent(half);
    let (tx0, tx1) = tile_range(aabb[0], aabb[2], ext);
    let (ty0, ty1) = tile_range(aabb[1], aabb[3], ext);
    for ty in ty0..=ty1 {
        for tx in tx0..=tx1 {
            if box_collide(cliff, rot, &search_box(tx, ty, half), NO_ROTATION) && occupied(tx, ty) {
                return true;
            }
        }
    }
    false
}

impl CellRejection for VulcanusOreRejection<'_, '_> {
    /// The removal at the CROSSING stage, by cell code - the shipping
    /// renderer's plug-in point, which has only the queued orientation.
    fn rejects(&self, code: u8, x: f64, y: f64) -> bool {
        cliff_orientation_for_code(code).is_some_and(|o| self.removes(o, x, y))
    }
}

/// Test-only: sits AFTER every reachable item so a line added here shifts no
/// `core::panic::Location` in the module above it and `engine.wasm` stays
/// byte-identical. `#[cfg(test)]` code never reaches the wasm build at all.
#[cfg(test)]
impl VulcanusOreRejection<'_, '_> {
    /// The tiles the ORE arm of [`VulcanusOreRejection::removes`] asks the
    /// footprint about for a cell at `(x, y)` with orientation `code` - the
    /// tiles whose search box the oriented box reaches, in scan order, so a
    /// grading that uses it looks exactly where the rule looks and nowhere
    /// else.
    pub(crate) fn ore_tiles(&self, code: u8, x: f64, y: f64) -> Vec<(i64, i64)> {
        tiles_for(code, x, y, VULCANUS_ORE_COLLISION_HALF)
    }

    /// The GEYSER arm's tiles for the same cell - the ones whose 3x3 the
    /// oriented box reaches.
    pub(crate) fn geyser_tiles(&self, code: u8, x: f64, y: f64) -> Vec<(i64, i64)> {
        tiles_for(code, x, y, VULCANUS_GEYSER_COLLISION_HALF)
    }
}

#[cfg(test)]
fn tiles_for(code: u8, x: f64, y: f64, half: f64) -> Vec<(i64, i64)> {
    let Some(orientation) = cliff_orientation_for_code(code) else {
        return Vec::new();
    };
    let cliff = placed_box(orientation, x, y);
    let rot = rotation_word(orientation);
    let aabb = get_aabb(&cliff, rot);
    let mut out = Vec::new();
    reaches_an_occupied_tile(&cliff, rot, &aabb, half, |tx, ty| {
        out.push((tx, ty));
        false
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cliffs::catalog::{cliff_code_for_orientation, CLIFF_ORIENTATION_NAMES};

    /// A solid ore's search box is exactly its own tile, and the geyser's is
    /// the 3x3 around its tile - the widening is what `postSetup` does to the
    /// entity's box, restated on the two shapes this module ships.
    #[test]
    fn an_ores_search_box_is_its_tile_and_a_geysers_is_the_three_by_three() {
        assert_eq!(
            search_box(3, -2, VULCANUS_ORE_COLLISION_HALF),
            [768, -512, 1024, -256]
        );
        assert_eq!(
            search_box(3, -2, VULCANUS_GEYSER_COLLISION_HALF),
            [512, -768, 1280, 0]
        );
    }

    /// The tile range is DERIVED, and the derivation is what this guards: over
    /// all twenty orientations and both search shapes, no tile outside the
    /// range has a search box the oriented cliff box reaches - and the extra
    /// tile on each side is load-bearing, because the tight range from the
    /// AABB alone misses tiles a corner box's untruncated rectangle touches.
    #[test]
    fn no_tile_outside_the_range_can_reach_the_oriented_box() {
        let mut outside_the_tight_range = 0;
        for orientation in 0..20u8 {
            let (x, y) = (2.0, 2.5);
            let cliff = placed_box(orientation, x, y);
            let rot = rotation_word(orientation);
            let aabb = get_aabb(&cliff, rot);
            for half in [VULCANUS_ORE_COLLISION_HALF, VULCANUS_GEYSER_COLLISION_HALF] {
                let ext = search_extent(half);
                let (tx0, tx1) = tile_range(aabb[0], aabb[2], ext);
                let (ty0, ty1) = tile_range(aabb[1], aabb[3], ext);
                let (sx0, sx1) = tight_tile_range(aabb[0], aabb[2], ext);
                let (sy0, sy1) = tight_tile_range(aabb[1], aabb[3], ext);
                for tx in (tx0 - 2)..=(tx1 + 2) {
                    for ty in (ty0 - 2)..=(ty1 + 2) {
                        let inside = (tx0..=tx1).contains(&tx) && (ty0..=ty1).contains(&ty);
                        let tight = (sx0..=sx1).contains(&tx) && (sy0..=sy1).contains(&ty);
                        let reached =
                            box_collide(&cliff, rot, &search_box(tx, ty, half), NO_ROTATION);
                        assert!(
                            inside || !reached,
                            "{}: tile ({tx}, {ty}) outside the range is reached",
                            CLIFF_ORIENTATION_NAMES[usize::from(orientation)]
                        );
                        if reached && !tight {
                            outside_the_tight_range += 1;
                        }
                    }
                }
            }
        }
        assert!(
            outside_the_tight_range > 0,
            "the extra tile buys nothing - the tight range would do"
        );
    }

    /// The straight `west-to-east` box is `4 x 3` tiles centred on a cell,
    /// and against an ore it reaches exactly the tiles its own rectangle
    /// touches: six across, because both vertical edges land on tile
    /// boundaries and a touching edge counts, and five down for the same
    /// reason at the half-tile centre.
    #[test]
    fn a_straight_box_reaches_every_tile_its_rectangle_touches() {
        let code = cliff_code_for_orientation(0).expect("west-to-east has a code");
        let reached = tiles_for(code, 2.0, 2.5, VULCANUS_ORE_COLLISION_HALF);
        assert_eq!(reached.len(), 30);
        assert_eq!(reached.first(), Some(&(-1, 0)));
        assert_eq!(reached.last(), Some(&(4, 4)));
    }

    /// A corner box reaches FEWER tiles than its square AABB scans - the
    /// separating-axis test is doing work the AABB alone would not, which is
    /// the `AabbOnly` control's 13 missing against the engine's 5.
    #[test]
    fn a_corner_box_reaches_fewer_tiles_than_its_aabb() {
        let orientation = 7; // south-to-west
        let code = cliff_code_for_orientation(orientation).expect("a code");
        let cliff = placed_box(orientation, 2.0, 2.5);
        let rot = rotation_word(orientation);
        let aabb = get_aabb(&cliff, rot);
        let ext = search_extent(VULCANUS_ORE_COLLISION_HALF);
        let (tx0, tx1) = tile_range(aabb[0], aabb[2], ext);
        let (ty0, ty1) = tile_range(aabb[1], aabb[3], ext);
        let scanned = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
        let reached = tiles_for(code, 2.0, 2.5, VULCANUS_ORE_COLLISION_HALF).len();
        assert!(
            (reached as i64) < scanned,
            "reached {reached} of {scanned} scanned"
        );
        assert!(reached > 0);
    }

    /// Both half-extents and every base-box edge are exact `1/256` multiples,
    /// because `MapPosition` is 8-bit fixed point. A transcription slip that
    /// dropped a digit would land off the grid.
    #[test]
    fn every_collision_constant_lands_on_the_eight_bit_fixed_point_grid() {
        let mut all: Vec<f64> = VULCANUS_CLIFF_BASE_COLLISION_BOX.to_vec();
        all.push(VULCANUS_ORE_COLLISION_HALF);
        all.push(VULCANUS_GEYSER_COLLISION_HALF);
        for v in all {
            let scaled = v * 256.0;
            assert_eq!(scaled, scaled.trunc(), "{v} is not a 1/256 multiple");
        }
        assert_eq!(VULCANUS_ORE_COLLISION_HALF * 256.0, 25.0);
        assert_eq!(VULCANUS_GEYSER_COLLISION_HALF * 256.0, 358.0);
    }
}
