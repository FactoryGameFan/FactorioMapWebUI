//! The ORE -> CLIFF rejection: a resource entity's collision rectangle
//! overlapping a cliff cell's suppresses that cliff.
//!
//! Ported from `src/noise/cliffs/vulcanusOreRejection.ts`, whose module comment
//! carries the full evidence trail. What a reader of this port needs:
//!
//! ## The mechanism is named, the geometry is not
//!
//! **The mechanism is `ResourceEntityPrototype::cliff_removal_probability`**,
//! settled 2026-08-14 by a PROTOTYPE lever rather than a surface one. It
//! defaults to `1.0` and no shipped prototype overrides it, so it is invisible
//! from the data alone. Zeroing that one field - leaving all 945 resource
//! entities exactly where they are - is indistinguishable from switching the
//! resources off entirely, and the difference is exactly the ten cells the
//! effect is measured on. At 1.0 the removal is unconditional, so the box
//! overlap below is correct as written.
//!
//! **What is still NOT established is the geometry the engine removes with.**
//! The base `collision_box` is an empirical fit, and naming the field licenses
//! no tuning of it. Two things here are deliberately not the shape you might
//! expect:
//!
//! 1. **The cliff rectangle is the prototype's BASE `collision_box`, not the
//!    per-orientation rotbb box** the lava rejection uses. Those are materially
//!    different shapes - the base box is `+/-0.988 x +/-0.488`, orientation 4's
//!    rotbb is `[-3.5,-3,4.5,3]`. The base box is the one the rule was measured
//!    with. [`CliffRejectionBox`] keeps both so the choice stays a recorded
//!    measurement rather than an assumption, which is the lesson #88/#90 paid
//!    for: the best-scoring collision model was the wrong one, because it also
//!    absorbed an unrelated defect.
//! 2. **It does not explain all 31 suppressed cells, and it is not tuned until
//!    it does.** Box overlap accounts for 21 with zero false alarms in the 885
//!    cliffs the game kept; the crossing STAGE explains 2 more with no tuning at
//!    all, because zeroing a rejected cell's edges leaves two neighbours with
//!    codes that no longer place. Scored against the lever, the rule is
//!    precision 1.000, recall 0.710 - exactly right where it fires, simply too
//!    narrow. Widening the box until all 31 fall out is exactly how #88 shipped
//!    a wrong model that scored perfectly.
//!
//! The rival candidate stays refuted: cliffs are both computed and placed
//! BEFORE any resource entity exists, and the masks are disjoint anyway, so no
//! collision test can see an entity that is not there yet. Where the rule DOES
//! act is at the destroy stage, which is what a field named
//! `cliff_removal_probability` predicts.

use crate::cliffs::catalog::{
    cliff_orientation_for_code, CliffCollisionBox, CLIFF_ORIENTATION_COLLISION_BOX,
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
pub const VULCANUS_CLIFF_BASE_COLLISION_BOX: CliffCollisionBox =
    [-0.988_281_25, -0.488_281_25, 0.988_281_25, 0.488_281_25];

/// The three solid ores' collision half-extent, `0.09765625 = 25/256`,
/// identical across `tungsten-ore`, `calcite` and `coal`.
pub const VULCANUS_ORE_COLLISION_HALF: f64 = 0.097_656_25;

/// `sulfuric-acid-geyser`'s collision half-extent, `1.3984375 = 358/256` - the
/// 2.8 x 2.8 box from `space-age/prototypes/entity/resources.lua:182`.
///
/// More than fourteen times the ores' in each axis, which is what makes the
/// geometry measurable at all: a point-at-tile-centre test explains the calcite
/// cells and cannot explain the geyser ones.
pub const VULCANUS_GEYSER_COLLISION_HALF: f64 = 1.398_437_5;

/// Which cliff rectangle the rejection tests with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CliffRejectionBox {
    /// The prototype's base `collision_box` - the shape the rule was measured
    /// with, and the shipping default.
    #[default]
    Base,
    /// The per-orientation rotbb box the LAVA rejection uses. Kept so the choice
    /// stays a measurement; see the module docs.
    Orientation,
}

/// A geyser placement predicate, for the arm that includes the geyser.
///
/// Injected rather than built here because the geyser ROLLS: reproducing it
/// needs the placement machinery, which is the resource overlay's, not this
/// module's.
pub trait GeyserPlacement {
    fn geyser_at(&self, x: i64, y: i64) -> bool;
}

/// The ore -> cliff rejection for one Vulcanus stack.
pub struct VulcanusOreRejection<'a, 'b> {
    stack: &'a VulcanusStack<'b>,
    footprint: VulcanusOreFootprint,
    box_kind: CliffRejectionBox,
    /// Include the sulfuric-acid geyser as a suppressing entity. **Off unless a
    /// predicate is supplied**, and that default is a measurement rather than
    /// caution for its own sake.
    ///
    /// The three solid ores THRESHOLD off region fields the oracle validates to
    /// ~1e-3, and the region saturates, so their footprint boundary is sharp and
    /// essentially deterministic. The geyser ROLLS: its placements are
    /// salt-dependent, and re-running one region over eight salts gives 46-63
    /// entities against the game's 56. A geyser our model puts in the wrong
    /// place, with a box 14x the ores', removes a cliff the game KEPT - a false
    /// rejection, which costs recall. This rule is otherwise pure precision, so
    /// recall loss is the one outcome worth gating against.
    geyser: Option<&'a dyn GeyserPlacement>,
}

impl<'a, 'b> VulcanusOreRejection<'a, 'b> {
    #[must_use]
    pub fn new(stack: &'a VulcanusStack<'b>, controls: &VulcanusResourceControls) -> Self {
        Self {
            stack,
            footprint: VulcanusOreFootprint::new(controls),
            box_kind: CliffRejectionBox::Base,
            geyser: None,
        }
    }

    #[must_use]
    pub fn with_box(mut self, kind: CliffRejectionBox) -> Self {
        self.box_kind = kind;
        self
    }

    #[must_use]
    pub fn with_geyser(mut self, g: &'a dyn GeyserPlacement) -> Self {
        self.geyser = Some(g);
        self
    }

    /// The cliff rectangle for a cell, relative to its centre. The
    /// [`CliffRejectionBox::Orientation`] variant falls back to the base box for
    /// a code that places nothing, which cannot reach the predicate anyway.
    fn cliff_box(&self, code: u8) -> CliffCollisionBox {
        match self.box_kind {
            CliffRejectionBox::Base => VULCANUS_CLIFF_BASE_COLLISION_BOX,
            CliffRejectionBox::Orientation => cliff_orientation_for_code(code)
                .map_or(VULCANUS_CLIFF_BASE_COLLISION_BOX, |id| {
                    CLIFF_ORIENTATION_COLLISION_BOX[id as usize]
                }),
        }
    }
}

/// The inclusive tile window whose CENTRES can overlap a rectangle.
///
/// An entity sits at a tile centre `(tx + 0.5, ty + 0.5)`, so the tiles that can
/// possibly overlap follow in closed form from the two rectangles - no entity
/// enumeration and no spatial index is needed. Cell centres sit at integer `x`
/// and half-integer `y`, so for the base box against an ore this window is
/// exactly TWO tiles; the geyser's larger box widens it to 4x3. Both are well
/// under the lava rejection's ~30 lookups per cell.
///
/// The overlap is strict (`<`), which is the same comparison the measurement
/// used; solving that for `tx` gives the bounds below.
fn tile_window(lo: f64, hi: f64, half: f64) -> (i64, i64) {
    let min = (lo - half - 0.5).floor() as i64 + 1;
    let max = (hi + half - 0.5).ceil() as i64 - 1;
    (min, max)
}

impl CellRejection for VulcanusOreRejection<'_, '_> {
    fn rejects(&self, code: u8, x: f64, y: f64) -> bool {
        let [l, t, r, b] = self.cliff_box(code);

        if !self.footprint.is_empty() {
            let (tx0, tx1) = tile_window(x + l, x + r, VULCANUS_ORE_COLLISION_HALF);
            let (ty0, ty1) = tile_window(y + t, y + b, VULCANUS_ORE_COLLISION_HALF);
            for tx in tx0..=tx1 {
                for ty in ty0..=ty1 {
                    if self.footprint.occupies(self.stack, tx, ty) {
                        return poison::bool_result(true);
                    }
                }
            }
        }

        if let Some(g) = self.geyser {
            let (tx0, tx1) = tile_window(x + l, x + r, VULCANUS_GEYSER_COLLISION_HALF);
            let (ty0, ty1) = tile_window(y + t, y + b, VULCANUS_GEYSER_COLLISION_HALF);
            for tx in tx0..=tx1 {
                for ty in ty0..=ty1 {
                    if g.geyser_at(tx, ty) {
                        return poison::bool_result(true);
                    }
                }
            }
        }

        poison::bool_result(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window is DERIVED, and the derivation is what this guards.
    ///
    /// The base box against an ore reaches exactly TWO TILES in total, and the
    /// two axes are not symmetric: a cell centre sits at integer `x` and
    /// half-integer `y`, so x spans two tiles and y exactly one. That asymmetry
    /// is the whole reason the window is derived rather than written down - a
    /// hardcoded square would be wrong on one axis whichever square was picked.
    #[test]
    fn the_base_box_against_an_ore_reaches_exactly_two_tiles() {
        let [l, t, r, b] = VULCANUS_CLIFF_BASE_COLLISION_BOX;
        let (x0, x1) = tile_window(2.0 + l, 2.0 + r, VULCANUS_ORE_COLLISION_HALF);
        let (y0, y1) = tile_window(2.5 + t, 2.5 + b, VULCANUS_ORE_COLLISION_HALF);
        assert_eq!((x0, x1), (1, 2), "x window at a cell centre of 2");
        assert_eq!((y0, y1), (2, 2), "y window at a cell centre of 2.5");
        assert_eq!(
            (x1 - x0 + 1) * (y1 - y0 + 1),
            2,
            "tiles the ore arm tests per cell"
        );
    }

    /// Widening the window by a tile on every side must find no additional
    /// tile whose centre can overlap - which is what says the closed form is
    /// tight rather than merely sufficient. The TypeScript's own spec asserts
    /// the same thing by re-running the whole rejection with a padded window.
    #[test]
    fn a_tile_outside_the_window_cannot_overlap_the_cliff_box() {
        let [l, t, r, b] = VULCANUS_CLIFF_BASE_COLLISION_BOX;
        let half = VULCANUS_ORE_COLLISION_HALF;
        let (x0, x1) = tile_window(2.0 + l, 2.0 + r, half);
        let (y0, y1) = tile_window(2.5 + t, 2.5 + b, half);
        // The strict overlap the measurement used, stated independently of the
        // closed form so the two can disagree.
        let overlaps = |tx: i64, ty: i64| {
            #[allow(clippy::cast_precision_loss)]
            let (ex, ey) = (tx as f64 + 0.5, ty as f64 + 0.5);
            ex - half < 2.0 + r && ex + half > 2.0 + l && ey - half < 2.5 + b && ey + half > 2.5 + t
        };
        for tx in (x0 - 1)..=(x1 + 1) {
            for ty in (y0 - 1)..=(y1 + 1) {
                let inside = (x0..=x1).contains(&tx) && (y0..=y1).contains(&ty);
                assert_eq!(overlaps(tx, ty), inside, "tile ({tx}, {ty})");
            }
        }
    }

    /// The geyser's box is fourteen times the ores', and that is what makes the
    /// two rules geometrically distinguishable at all.
    #[test]
    fn the_geyser_box_widens_the_window_to_four_by_three() {
        let [l, t, r, b] = VULCANUS_CLIFF_BASE_COLLISION_BOX;
        let (x0, x1) = tile_window(2.0 + l, 2.0 + r, VULCANUS_GEYSER_COLLISION_HALF);
        let (y0, y1) = tile_window(2.5 + t, 2.5 + b, VULCANUS_GEYSER_COLLISION_HALF);
        assert_eq!(x1 - x0 + 1, 4);
        assert_eq!(y1 - y0 + 1, 3);
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
