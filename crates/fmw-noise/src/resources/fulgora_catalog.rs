//! Fulgora's one resource: scrap, and the roll that turns its probability into
//! placed entities.
//!
//! Ported from `src/noise/resources/fulgoraResourceCatalog.ts`.
//!
//! **There is no `threshold` mode here and no `region` function**, unlike the
//! Nauvis and Vulcanus catalogs, because scrap does not use
//! `resource_autoplace_all_patches`. Its autoplace is a bare
//! `probability_expression` + `richness_expression` pair, and
//! `expressions::fulgora_scrap` caps the probability at 0.5 with the Lua's own
//! `min`, so it never saturates into a patch. It ROLLS.
//!
//! ## This is NOT the scrap footprint
//!
//! `fmw-wasm`'s `VIEW_SCRAP_FOOTPRINT` paints every tile where
//! `probability > 0`. This module paints the subset a random draw accepts,
//! which is the smaller set the app's `"all"` composite draws. The two answer
//! different questions and the footprint view's own doc comment explains why it
//! is deliberately not this: diffing rolled pixels against the game's drawn
//! pixels measures the salt rather than the model.
//!
//! **The gap is large enough to see.** Measured 2026-08-31 by
//! [`places_a_strict_nonempty_subset_of_the_footprint`], over a 128x128 window
//! at the origin, seed 123456, neutral sliders: 708 of 16,384 tiles are in the
//! footprint and 177 of those are placed, so the roll accepts 25.0% of it.
//! Substituting one view for the other would move 531 pixels in that window.
//!
//! ## The collision box is carried and is inert
//!
//! Passing an inert gate looks like an oversight, so it is stated here and
//! asserted in this module's own test rather than left to be rediscovered. The
//! TypeScript passes it for the same reason, and
//! `test/fulgoraScrapDensity.spec.ts` makes the same assertion on that side.

use crate::expressions::fulgora_stack::FulgoraStack;
use crate::placement::roll::{salt, PlacementCollisionBox, PlacementSet, PlacementSource};
use core::cell::RefCell;

/// `map_color = {0.9, 0.9, 0.9}` from the prototype, times 255.
///
/// Confirmed against the game's own preview pixels rather than from the Lua
/// alone: 1098 of 1825 changed pixels are exactly this triple.
pub const SCRAP_MAP_COLOR: [u8; 3] = [229, 229, 229];

/// Scrap's `collision_box`, read off the RUNNING GAME rather than from the Lua.
///
/// The shared `resource()` helper declares `{{-0.1,-0.1},{0.1,0.1}}`, and the
/// game snaps it to the 1/256 grid, so the half-extent is 0.09765625 and the
/// full extent is twice that.
///
/// **It cannot reject anything**, against the Vulcanus geyser's 1.4 half-extent
/// where collision did all of the work. `PlacementSet`'s overlap test asks
/// whether two centre separations are both under `(w + w) / 2`, which here is
/// 0.1953125; centres sit on integer tiles and no tile is visited twice, so the
/// smallest separation any pair can have is 1. It is passed anyway, to match
/// the TypeScript operation for operation, and
/// [`the_collision_box_cannot_reject_anything`] pins that it is inert.
pub const SCRAP_COLLISION_BOX: PlacementCollisionBox = PlacementCollisionBox {
    w: 0.097_656_25 * 2.0,
    h: 0.097_656_25 * 2.0,
};

/// The shipped scrap placement source.
///
/// **No `tile_allowed` gate**, and that is a finding rather than an omission.
/// The `fulgora_elevation > fulgora_coastline + 10` term inside the probability
/// already puts expected scrap on ocean at exactly 0.00 over 262,144 tiles, so
/// a water gate would reject nothing. `test/fulgoraScrap.spec.ts` asserts it on
/// the TypeScript side.
///
/// **The controls are already inside the stack.** `FulgoraStack::new` takes the
/// `ScrapControls` and hands them to `FulgoraScrap`, so this type takes none of
/// its own - which keeps the frequency and size levers with exactly one owner
/// rather than two that could disagree.
///
/// The stack is held behind a `RefCell` because `FulgoraStack::eval` needs
/// `&mut self` while [`PlacementSource::probability`] gets `&self`. The borrow
/// never spans a callback: it is taken and dropped inside one statement, which
/// is the same discipline `PlacementSet::placed` applies to its own cache.
pub struct FulgoraScrapPlacement<'a> {
    stack: &'a RefCell<FulgoraStack>,
}

impl<'a> FulgoraScrapPlacement<'a> {
    #[must_use]
    pub fn new(stack: &'a RefCell<FulgoraStack>) -> Self {
        Self { stack }
    }

    /// The placement set for this overlay, ready to be asked `placed(x, y)`.
    #[must_use]
    pub fn placement_set(&self) -> PlacementSet<'_> {
        PlacementSet::new(salt::FULGORA_SCRAP, self)
    }
}

impl PlacementSource for FulgoraScrapPlacement<'_> {
    fn probability(&self, x: f64, y: f64) -> f64 {
        self.stack.borrow_mut().eval(x, y).scrap.probability
    }

    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        Some(SCRAP_COLLISION_BOX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::fulgora_scrap::ScrapControls;
    use crate::expressions::fulgora_shared::FulgoraCtx;

    /// The seed every Fulgora oracle fixture in this repo was captured at.
    const SEED: u32 = 123_456;

    /// A 128x128 window, 16,384 tiles - big enough to cross 16 chunks, so the
    /// per-chunk roll seeding is exercised rather than one chunk's stream.
    const WINDOW: i64 = 128;

    fn stack() -> RefCell<FulgoraStack> {
        let ctx = FulgoraCtx::new(SEED);
        RefCell::new(FulgoraStack::with_host_trig(
            &ctx,
            &ScrapControls::default(),
        ))
    }

    /// Sweep the window and count `(footprint, placed)`.
    fn counts(collision: bool) -> (usize, usize) {
        let cell = stack();
        let placement = FulgoraScrapPlacement::new(&cell);
        let no_collision = NoCollision(&placement);
        let source: &dyn PlacementSource = if collision { &placement } else { &no_collision };
        let set = PlacementSet::new(salt::FULGORA_SCRAP, source);
        let (mut footprint, mut placed) = (0usize, 0usize);
        for y in 0..WINDOW {
            for x in 0..WINDOW {
                #[allow(clippy::cast_precision_loss)]
                let (fx, fy) = (x as f64, y as f64);
                if placement.probability(fx, fy) > 0.0 {
                    footprint += 1;
                }
                if set.placed(fx, fy) {
                    placed += 1;
                }
            }
        }
        (footprint, placed)
    }

    /// The same source with the collision box removed, so the two can be
    /// compared rather than the box's inertness argued from its size.
    struct NoCollision<'a>(&'a FulgoraScrapPlacement<'a>);

    impl PlacementSource for NoCollision<'_> {
        fn probability(&self, x: f64, y: f64) -> f64 {
            self.0.probability(x, y)
        }
    }

    /// The overlay draws something, and draws strictly less than the footprint.
    ///
    /// Both halves matter. A roll that placed nothing would fold zeros and
    /// agree with anything; a roll that placed the whole footprint would not be
    /// a roll at all, and `VIEW_SCRAP_FOOTPRINT` would already be the answer.
    ///
    /// Measured 2026-08-31: 708 footprint tiles and 177 placed. Neither bound
    /// is close, which is what makes this a weak gate on its own - it is listed
    /// in `scripts/verify-rust.sh`'s poison set because the perturbation drives
    /// `placed` to 16,207 and trips the upper bound, not because 177 is a
    /// precise number. The byte-identity spec against the TypeScript composite
    /// is the real grading, and it lands with the render arm.
    #[test]
    fn places_a_strict_nonempty_subset_of_the_footprint() {
        let (footprint, placed) = counts(true);
        println!("MEASURED footprint={footprint} placed={placed}");
        assert!(placed > 0, "the roll placed nothing, so it grades nothing");
        assert!(
            placed < footprint,
            "the roll placed the whole footprint ({placed} of {footprint}), \
             so it is not rolling"
        );
    }

    /// The collision box is carried and rejects nothing.
    ///
    /// Measured rather than argued from the box's size, because the argument
    /// depends on `PlacementSet`'s overlap test staying centre-to-centre, which
    /// this test would catch changing and a comment would not.
    ///
    /// **Deliberately NOT in the poison set**, and the reason is the one
    /// `poison.rs` records for the capture-grid snap test: both arms run
    /// through the same poisoned `resolve_chunk`, so the perturbation applies
    /// to each and cancels. Confirmed 2026-08-31 - under `--features poison`
    /// this test stays green while its sibling goes red. A relational test
    /// listed in that set would fail the gate for being correct.
    #[test]
    fn the_collision_box_cannot_reject_anything() {
        let (_, with_box) = counts(true);
        let (_, without_box) = counts(false);
        assert_eq!(
            with_box,
            without_box,
            "the 0.1953125-tile collision box rejected {} placements, so it is \
             no longer inert and the doc comment above is wrong",
            without_box.saturating_sub(with_box)
        );
    }
}
