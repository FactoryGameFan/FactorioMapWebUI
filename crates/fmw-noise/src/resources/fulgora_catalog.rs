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
//! `places_a_strict_nonempty_subset_of_the_footprint`, over a 128x128 window
//! at the origin, seed 123456, neutral sliders: 708 of 16,384 tiles are in the
//! footprint and 177 of those are placed, so the roll accepts 25.0% of it.
//! Substituting one view for the other would move 531 pixels in that window.
//!
//! ## The collision box is carried and is inert
//!
//! Passing an inert gate looks like an oversight, so it is stated here and
//! asserted in this module's own test rather than left to be rediscovered. The
//! TypeScript passed it for the same reason, and
//! `test/fulgoraScrapDensity.spec.ts` makes the same assertion on that side.

use crate::expressions::fulgora_stack::FulgoraStack;
use crate::placement::roll::{salt, PlacementCollisionBox, PlacementSet, PlacementSource};
use crate::tiles::fulgora_catalog::FulgoraTile;
use core::cell::RefCell;

/// `map_color = {0.9, 0.9, 0.9}` from the prototype, times 255.
///
/// Confirmed against the game's own preview pixels rather than from the Lua
/// alone: all 1855 changed pixels are exactly this triple.
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
/// `the_collision_box_cannot_reject_anything` pins that it is inert.
pub const SCRAP_COLLISION_BOX: PlacementCollisionBox = PlacementCollisionBox {
    w: 0.097_656_25 * 2.0,
    h: 0.097_656_25 * 2.0,
};

/// The shipped scrap placement source.
///
/// **The tile gate rejects the oil ocean**, and the comment that stood here
/// before said the opposite and was wrong (#201).
///
/// It claimed the `fulgora_elevation > fulgora_coastline + 10` term already
/// puts expected scrap on ocean at "exactly 0.00 over 262,144 tiles". That
/// holds only at the PREVIEW's derived surface seed 2967702466. At the seed the
/// density fixture forces (123456) the expectation on ocean tiles is 140.20,
/// all of it in chunk (0, 4). The spec that asserted the 0.00,
/// `test/fulgoraScrap.spec.ts`, is gone and read the other seed.
///
/// The game's rule, read from `generateEntities` (Factorio 2.1.23, 0x1989a3d):
/// a tile whose collision mask overlaps the prototype's `collision_mask` is
/// skipped before arbitration. Scrap's mask is `[resource]` (the shared
/// `resource()` helper's default), and all four oil-ocean tiles carry the
/// `resource` layer (`tile-collision-masks.lua`), while the land tiles are
/// `[ground_tile]`. So no ocean tile is ever a scrap candidate.
///
/// **That runs inside the game's map PREVIEW as well**, not only on a real
/// surface: `MapPreviewGenerator::Worker::computeEntities` fills the same task
/// from the preview's own chunk tiles and calls `computeInternal`. Measured in
/// the preview at map seed 1327511742 (Fulgora surface seed 123456): chunk
/// (0, 4) has 0 scrap-coloured pixels, against 17 in (0, 3). So the gate is the
/// same in both modes and there is no preview/save switch to make.
///
/// Effect over the three regions of `oracle-fulgora-scrap-entities`
/// (expected placements, summed probability): the first region 357.75 -> 217.55 (game
/// 222), total 706.15 -> 565.95 (game 562). The other two stay
/// 185.25 (game 191) and 163.15 (game 149, +9.5%, a separate open question).
///
/// The gate asks the tile resolver, `StackFields::tile`, rather than
/// restating the ocean rule, so it follows the resolver if that changes.
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

    /// Scrap cannot stand on the oil ocean: see the type's doc comment.
    fn tile_allowed(&self, x: f64, y: f64) -> bool {
        !is_oil_ocean(self.stack.borrow_mut().eval(x, y).tile())
    }

    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        Some(SCRAP_COLLISION_BOX)
    }
}

/// The oil-ocean tiles, the only Fulgora tiles whose collision mask carries the
/// `resource` layer that scrap's own mask collides with.
///
/// The game has four: `oil-ocean-shallow`, `oil-ocean-shallow-2` and the two
/// deep ones.
fn is_oil_ocean(tile: FulgoraTile) -> bool {
    tile.is_ocean()
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

        /// Forwarded, so the two arms differ ONLY in the collision box.
        fn tile_allowed(&self, x: f64, y: f64) -> bool {
            self.0.tile_allowed(x, y)
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

    /// The game's own scrap, graded against the model with and without the
    /// ocean gate (#201).
    ///
    /// `oracle-fulgora-scrap-entities` holds every scrap entity the game placed
    /// in three regions at surface seed 123456 (2.1.14; 2.1.23 places the same
    /// 222 / 191 / 149, probe E4). The model's expectation is the sum of
    /// `probability` over the region's tiles, counted only where the placement
    /// source lets a roll stand.
    ///
    /// Measured 2026-11-25, gated against ungated against the game:
    ///
    /// | region | game | gated  | ungated |
    /// | ------ | ---- | ------ | ------- |
    /// | 0      | 222  | 217.55 | 357.75  |
    /// | 1      | 191  | 185.25 | 185.25  |
    /// | 2      | 149  | 163.15 | 163.15  |
    /// | total  | 562  | 565.95 | 706.15  |
    ///
    /// (Rows follow the fixture's case order; the 140.20 the gate removes sits
    /// wholly in chunk (0, 4), inside case 0.) Region 2's +9.5% is a separate,
    /// open residual and is bounded here, not explained.
    ///
    /// **The control is the ungated total**, summed through the same loop with
    /// the gate switched off. It must miss the game's total by more than 20%,
    /// so a gate that did nothing would turn this red.
    #[test]
    fn the_ocean_gate_brings_scrap_density_to_the_games_counts() {
        let fixture =
            crate::test_json::load("test/fixtures/oracle-fulgora-scrap-entities.seed123456.json");
        assert_eq!(fixture.get("seed0").as_f64(), f64::from(SEED));
        let cases = fixture.get("cases").as_array();
        assert_eq!(cases.len(), 3, "the fixture changed shape");

        let cell = stack();
        let placement = FulgoraScrapPlacement::new(&cell);
        let (mut game_total, mut gated_total, mut ungated_total) = (0.0f64, 0.0f64, 0.0f64);
        let mut per_region = Vec::new();
        for case in cases {
            let region = case.get("region");
            let bound = |k: &str| region.get(k).as_f64() as i64;
            let (x0, y0, x1, y1) = (bound("x0"), bound("y0"), bound("x1"), bound("y1"));
            let game = case.get("resources").as_array().len() as f64;
            let (mut gated, mut ungated) = (0.0f64, 0.0f64);
            for y in y0..y1 {
                for x in x0..x1 {
                    let (fx, fy) = (x as f64, y as f64);
                    let p = placement.probability(fx, fy);
                    if p > 0.0 {
                        ungated += p;
                        if placement.tile_allowed(fx, fy) {
                            gated += p;
                        }
                    }
                }
            }
            println!(
                "MEASURED region ({x0},{y0}) game={game} gated={gated:.2} ungated={ungated:.2}"
            );
            per_region.push((game, gated, ungated));
            game_total += game;
            gated_total += gated;
            ungated_total += ungated;
        }
        println!(
            "MEASURED total game={game_total} gated={gated_total:.2} ungated={ungated_total:.2}"
        );

        assert_eq!(game_total, 562.0, "the fixture's own count moved");
        // Frozen to 0.01: the sums are f64 over f32-exact terms, so a drift of
        // that size would be a real change, not host noise.
        assert!(
            (gated_total - 565.95).abs() < 0.01,
            "gated expectation {gated_total} is not the frozen 565.95"
        );
        assert!(
            (ungated_total - 706.15).abs() < 0.01,
            "ungated expectation {ungated_total} is not the frozen 706.15"
        );
        // The gate lands within 1% of the game's total.
        assert!((gated_total / game_total - 1.0).abs() < 0.01);
        // The control: with the gate off the total is 25.7% over, so a gate
        // that rejected nothing could not pass the assertion above.
        assert!(ungated_total / game_total > 1.2);
        // Region 0 is where the ocean is, and the gate closes its whole gap
        // (357.75 against 222 -> 217.55).
        let (game0, gated0, ungated0) = per_region[0];
        assert!(
            (gated0 / game0 - 1.0).abs() < 0.03,
            "region 0 gated {gated0}"
        );
        assert!(ungated0 / game0 > 1.5, "region 0 ungated {ungated0}");
    }

    /// Chunk (0, 4) holds 140.2 of expected scrap on the oil ocean at seed
    /// 123456, and the game places none of it. Rolled through the real
    /// placement set, the gate must place nothing there; the ungated source,
    /// the control, places 162 (the "phantom scrap" `fulgora-elevation-NOTES`
    /// Task 17 measured).
    #[test]
    fn chunk_zero_four_places_no_scrap_on_the_ocean() {
        struct NoGate<'a>(&'a FulgoraScrapPlacement<'a>);
        impl PlacementSource for NoGate<'_> {
            fn probability(&self, x: f64, y: f64) -> f64 {
                self.0.probability(x, y)
            }
        }
        let cell = stack();
        let placement = FulgoraScrapPlacement::new(&cell);
        let ungated_source = NoGate(&placement);
        let gated = PlacementSet::new(salt::FULGORA_SCRAP, &placement);
        let ungated = PlacementSet::new(salt::FULGORA_SCRAP, &ungated_source);
        let (mut with_gate, mut without_gate) = (0usize, 0usize);
        for y in 128..160 {
            for x in 0..32 {
                let (fx, fy) = (f64::from(x), f64::from(y));
                with_gate += usize::from(gated.placed(fx, fy));
                without_gate += usize::from(ungated.placed(fx, fy));
            }
        }
        println!("MEASURED chunk (0,4) gated={with_gate} ungated={without_gate}");
        assert_eq!(with_gate, 0, "scrap stood on the oil ocean");
        assert!(
            without_gate > 100,
            "the control no longer places on the ocean"
        );
    }
}
