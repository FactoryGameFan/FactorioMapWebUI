//! Aquilo's three wells as one rolled overlay: crude oil, lithium brine and
//! fluorine vent.
//!
//! The probabilities are `expressions::aquilo_resources`' three
//! `aquilo_*_probability` fields, graded exact against the game. This module
//! is the thin layer above them: which well wins a tile, the roll, the
//! collision box and the colours. There is no TypeScript counterpart; Aquilo
//! is ported Rust-first.
//!
//! ## One stream, winner by largest probability
//!
//! The three wells share one [`PlacementSet`] and one salt,
//! [`salt::AQUILO_WELLS`], the way `rocks::nauvis_placement` shares one for
//! its three rocks. The overlay's probability is the largest of the three,
//! clamped to [0, 1], and the winner is the well that gives it. An exact tie
//! goes to the first in [`WELL_ORDER`], which sorts the prototypes by their
//! autoplace `order` strings: fluorine vent `a[resources]-a[fluorine]`,
//! lithium brine `a[resources]-b[lithium]`, then crude oil `c` (the base
//! prototype's; Aquilo swaps in its probability and richness through the
//! planet's `property_expression_names`, `planet-map-gen.lua:439-440`, and
//! leaves the order alone). **That tie rule is
//! ours.** The game's rule for an exact tie is not established. A NaN loses,
//! as in the tile argmax.
//!
//! The three probabilities are evaluated at the tile's integer corner, the
//! position `PlacementSet` hands every overlay, through the chunk-grid kernel
//! ([`At::tile`]). None of them reads a noise primitive, so the kernel does not
//! change their values.
//!
//! ## The guaranteed vent near spawn
//!
//! `aquilo_starting_flourine_vent_tiny` is a cone of radius 1 at distance 80,
//! and the fluorine probability holds `tiny > 0` as a term, so the probability
//! is exactly 1 at every integer corner strictly inside that unit disk. The
//! corner nearest the cone's centre is at most `sqrt(2) / 2` from it, so at
//! least one tile always has probability 1 and its roll always passes. Two to
//! four corners can share the disk; the 2.8-tile box then lets only the first
//! of them in the chunk's processing order through, unless they sit in
//! different chunks (`PlacementSet` does not model cross-chunk collision).
//! At the derived seed 3111923328 the game's own census puts the vent at
//! tile (-41, -68); `the_tiny_vent_lands_where_the_game_puts_it` (in
//! `fixtures`) checks it.
//!
//! ## Against the census
//!
//! Every census well stands on a tile where our probability for its own
//! prototype is above 0 (19 of 19, in
//! `aquilo_census_entities_stand_inside_our_footprint_on_the_census_tile`).
//! Read at the tile centre instead of the corner, the tiny vent falls outside.
//! The count is close but the salt is ours, so the positions are not: over the
//! census window (tiles -256..255) the game places 19 wells (11 crude oil, 4
//! lithium brine, 4 fluorine vents) and this overlay 24 (8, 10 and 6),
//! measured 2026-10-23.
//!
//! ## `tile_allowed`: every tile
//!
//! The census (`test/fixtures/oracle-aquilo-entities.seed123456.json`,
//! derived seed 3111923328, tiles -256..255) has 19 wells. Read on its
//! `tileWithoutEffect` column (the shipped `tile` column shows the wells' own
//! later rewrite of the ocean under them), they stand on:
//!
//! | tile | crude oil | lithium brine | fluorine vent |
//! | --- | ---: | ---: | ---: |
//! | `ice-rough` | 3 | 2 | 0 |
//! | `ice-smooth` | 3 | 1 | 0 |
//! | `snow-crests` | 1 | 0 | 0 |
//! | `ammoniacal-ocean` | 2 | 0 | 2 |
//! | `ammoniacal-ocean-2` | 2 | 1 | 2 |
//!
//! So wells stand on land and on both oceans. None stands on `snow-flat`,
//! `snow-lumpy`, `snow-patchy` or `brash-ice`, but 19 wells cannot show that a
//! tile is barred. The prototypes say none is: a resource's default
//! `collision_mask` is `{layers = {resource = true}}`, and on Aquilo no tile
//! mask carries `resource`. `tile_collision_masks.ammoniacal_ocean()`
//! (`base/prototypes/tile/tile-collision-masks.lua:30-40` at 2.1.23) comments
//! it out (`--resource=true`), and that mask is the one both oceans and
//! `brash-ice` use (`space-age/prototypes/tile/tiles-aquilo.lua:135`, `:147`
//! and `:500`). The snow tiles use `ground()` and the ice tiles
//! `meltable_tile()`, neither of which lists `resource`. None of the three
//! prototypes declares a `tile_restriction`. So the gate is the trait's
//! default, true everywhere.
//!
//! ## Colours
//!
//! Each well's `map_color` times 255, truncated: crude oil `{0.78, 0.2, 0.77}`
//! (`base/prototypes/entity/resources.lua:334`), lithium brine
//! `{0.7, 1.0, 0.6}` and fluorine vent `{0.0, 0.8, 1.0}`
//! (`space-age/prototypes/entity/resources.lua:382` and `:511`). The game's
//! full preview (`test/fixtures/oracle-preview-aquilo-full.seed123456.png`)
//! draws exactly these three triples and no other well colour:
//!
//! | well | from `map_color` | in the PNG | pixels |
//! | --- | --- | --- | ---: |
//! | crude oil | (198, 51, 196) | (198, 51, 196) | 475 |
//! | lithium brine | (178, 255, 153) | (178, 255, 153) | 451 |
//! | fluorine vent | (0, 204, 255) | (0, 204, 255) | 157 |
//!
//! Crude oil's 198 (from 198.9) is what shows the channels are truncated, not
//! rounded.

use crate::at::At;
use crate::expressions::aquilo_resources::AquiloResourceFields;
use crate::expressions::aquilo_stack::AquiloStack;
use crate::placement::roll::{salt, PlacementCollisionBox, PlacementSet, PlacementSource};
use core::cell::RefCell;

/// Every well's `collision_box`, `{{-1.4, -1.4}, {1.4, 1.4}}`: 2.8 x 2.8
/// tiles. None of the three declares a `map_generator_bounding_box`.
pub const WELL_COLLISION_BOX: PlacementCollisionBox = PlacementCollisionBox { w: 2.8, h: 2.8 };

/// One of Aquilo's three wells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AquiloWell {
    CrudeOil,
    LithiumBrine,
    FluorineVent,
}

/// The tie-break order, by autoplace `order` string. See the module docs.
pub const WELL_ORDER: [AquiloWell; 3] = [
    AquiloWell::FluorineVent,
    AquiloWell::LithiumBrine,
    AquiloWell::CrudeOil,
];

impl AquiloWell {
    /// The prototype's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::CrudeOil => "crude-oil",
            Self::LithiumBrine => "lithium-brine",
            Self::FluorineVent => "fluorine-vent",
        }
    }

    /// The prototype's `map_color`, as the game's preview draws it. See the
    /// module docs for the table.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        match self {
            Self::CrudeOil => [198, 51, 196],
            Self::LithiumBrine => [178, 255, 153],
            Self::FluorineVent => [0, 204, 255],
        }
    }

    /// This well's probability field.
    #[must_use]
    pub fn probability(self, f: &AquiloResourceFields) -> f64 {
        match self {
            Self::CrudeOil => f.crude_oil_probability,
            Self::LithiumBrine => f.lithium_brine_probability,
            Self::FluorineVent => f.fluorine_vent_probability,
        }
    }
}

/// The winning well and its probability clamped to [0, 1], or `None` when no
/// well's probability is above 0.
///
/// First maximum in [`WELL_ORDER`] wins and a NaN loses: `v > best` is false
/// for a NaN, and `best` starts at 0, so a well must be strictly positive to
/// win at all.
#[must_use]
pub fn pick_well(f: &AquiloResourceFields) -> Option<(AquiloWell, f64)> {
    let mut best: Option<(AquiloWell, f64)> = None;
    let mut best_value = 0.0;
    for well in WELL_ORDER {
        let v = well.probability(f);
        if v > best_value {
            best_value = v;
            best = Some((well, v));
        }
    }
    best.map(|(well, v)| (well, v.min(1.0)))
}

/// The tile whose integer corner `(x, y)` falls in, on the chunk grid.
///
/// `PlacementSet` hands every overlay whole-tile positions, so the floor only
/// matters for a direct caller.
pub(crate) fn tile_at(x: f64, y: f64) -> At {
    #[allow(clippy::cast_possible_truncation)]
    At::tile(x.floor() as i32, y.floor() as i32)
}

/// The well overlay's placement source.
///
/// The stack sits behind a `RefCell` because [`AquiloStack::eval_at`] needs
/// `&mut self` while [`PlacementSource::probability`] gets `&self`, the
/// pattern `resources::fulgora_catalog` uses. Each borrow is taken and dropped
/// inside one statement, so no borrow spans `PlacementSet`'s callbacks.
pub struct AquiloWellPlacement<'a> {
    stack: &'a RefCell<AquiloStack>,
}

impl<'a> AquiloWellPlacement<'a> {
    #[must_use]
    pub fn new(stack: &'a RefCell<AquiloStack>) -> Self {
        Self { stack }
    }

    fn pick(&self, x: f64, y: f64) -> Option<(AquiloWell, f64)> {
        let fields = self.stack.borrow_mut().eval_at(tile_at(x, y)).resources;
        pick_well(&fields)
    }

    /// The well that wins the tile containing `(x, y)`, or `None` where no
    /// well's probability is above 0. A renderer asks this only of tiles the
    /// set placed, to pick the mark's colour.
    #[must_use]
    pub fn winner(&self, x: f64, y: f64) -> Option<AquiloWell> {
        self.pick(x, y).map(|(well, _)| well)
    }

    /// The placement set for this overlay, ready to be asked `placed(x, y)`.
    #[must_use]
    pub fn placement_set(&self) -> PlacementSet<'_> {
        PlacementSet::new(salt::AQUILO_WELLS, self)
    }
}

impl PlacementSource for AquiloWellPlacement<'_> {
    fn probability(&self, x: f64, y: f64) -> f64 {
        self.pick(x, y).map_or(0.0, |(_, p)| p)
    }

    // `tile_allowed` keeps the trait's default, true everywhere: see the
    // module docs for why no Aquilo tile bars a well.

    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        Some(WELL_COLLISION_BOX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::aquilo_resources::{AquiloBearings, AquiloResourceControls};
    use crate::expressions::aquilo_stack::AquiloCtx;

    fn stack(seed0: u32) -> RefCell<AquiloStack> {
        RefCell::new(AquiloStack::with_host_trig(&AquiloCtx {
            seed0,
            controls: AquiloResourceControls::default(),
        }))
    }

    /// The tiny vent's centre, `(80 sin a, -80 cos a)` with the cone's own
    /// f32 products, as `starting_spot_at_angle` forms it.
    fn tiny_vent_centre(seed0: u32) -> (f64, f64) {
        let trig = AquiloBearings::from_host(seed0).fluorine_vent;
        (
            f64::from((80.0 * trig.sin) as f32),
            f64::from((-80.0 * trig.cos) as f32),
        )
    }

    /// The corners of the 5x5 tiles around the rounded centre that the set
    /// places, with their winners.
    fn placed_near(
        placement: &AquiloWellPlacement<'_>,
        centre: (f64, f64),
    ) -> Vec<(i32, i32, Option<AquiloWell>)> {
        let set = placement.placement_set();
        let mut out = Vec::new();
        #[allow(clippy::cast_possible_truncation)]
        let (rx, ry) = (centre.0.round() as i32, centre.1.round() as i32);
        for ty in ry - 2..=ry + 2 {
            for tx in rx - 2..=rx + 2 {
                let (x, y) = (f64::from(tx), f64::from(ty));
                if set.placed(x, y) {
                    out.push((tx, ty, placement.winner(x, y)));
                }
            }
        }
        out
    }

    /// One vent near spawn on every seed while the fluorine slider is above 0.
    ///
    /// For each seed: the corner nearest the cone's centre (the rounded centre)
    /// has fluorine probability exactly 1, and the set places exactly one well
    /// among the 25 tiles around it, a fluorine vent on a corner inside the
    /// unit disk. On these three seeds that well is on the rounded corner
    /// itself; that is measured per seed, not a rule. At the derived seed
    /// 3111923328 the rounded corner is (-42, -68) and the vent lands on
    /// (-41, -68), as the game's does (`the_tiny_vent_lands_where_the_game_puts_it`
    /// in `fixtures`), because the chunk's processing order picks it first.
    #[test]
    fn the_tiny_vent_is_placed_on_every_seed() {
        for seed in [123_456_u32, 1, 4_000_000_000] {
            let (cx, cy) = tiny_vent_centre(seed);
            let s = stack(seed);
            let placement = AquiloWellPlacement::new(&s);
            let (rx, ry) = (cx.round(), cy.round());
            assert_eq!(placement.probability(rx, ry), 1.0, "seed {seed}");
            assert_eq!(
                placement.winner(rx, ry),
                Some(AquiloWell::FluorineVent),
                "seed {seed}"
            );

            let placed = placed_near(&placement, (cx, cy));
            assert_eq!(placed.len(), 1, "seed {seed}: {placed:?}");
            let (tx, ty, winner) = placed[0];
            assert_eq!(winner, Some(AquiloWell::FluorineVent), "seed {seed}");
            let d = (f64::from(tx) - cx).hypot(f64::from(ty) - cy);
            assert!(d < 1.0, "seed {seed}: ({tx}, {ty}) is {d} from the centre");
            #[allow(clippy::cast_possible_truncation)]
            let rounded = (rx as i32, ry as i32);
            assert_eq!((tx, ty), rounded, "seed {seed}");
        }
    }

    /// At fluorine size 0 the probability is gated to 0, so the tiny vent goes
    /// too. The control for the test above: the same tiles, one lever moved.
    #[test]
    fn a_zero_fluorine_size_removes_the_tiny_vent() {
        let seed = 123_456;
        let mut controls = AquiloResourceControls::default();
        controls.fluorine_vent.size = 0.0;
        let s = RefCell::new(AquiloStack::with_host_trig(&AquiloCtx {
            seed0: seed,
            controls,
        }));
        let placement = AquiloWellPlacement::new(&s);
        let centre = tiny_vent_centre(seed);
        assert_eq!(
            placement.probability(centre.0.round(), centre.1.round()),
            0.0
        );
        assert_eq!(placed_near(&placement, centre), vec![]);
    }

    /// Two sets, asked in opposite orders over the same 64x64 tiles, agree at
    /// all 4,096. They share one stack, so a stack cache whose answer depended
    /// on the order of the questions would show here as well as a
    /// window-dependent chunk resolve.
    ///
    /// The window holds crude oil's starting cone at seed 123456 (radius 24,
    /// centred near (0, -40)), so wells do place in it.
    #[test]
    fn the_well_overlay_is_a_pure_function_of_position() {
        let s = stack(123_456);
        let placement = AquiloWellPlacement::new(&s);
        let forward = placement.placement_set();
        let backward = placement.placement_set();
        let (x0, y0) = (-32, -72);
        let mut first = Vec::new();
        for ty in y0..y0 + 64 {
            for tx in x0..x0 + 64 {
                first.push(forward.placed(f64::from(tx), f64::from(ty)));
            }
        }
        let mut second = Vec::new();
        for ty in (y0..y0 + 64).rev() {
            for tx in (x0..x0 + 64).rev() {
                second.push(backward.placed(f64::from(tx), f64::from(ty)));
            }
        }
        second.reverse();
        assert_eq!(first.len(), 4096);
        assert_eq!(first, second);
        let placed = first.iter().filter(|p| **p).count();
        eprintln!("wells placed in the window: {placed}");
        assert!(
            placed > 1,
            "only {placed} wells placed, so this grades little"
        );
    }

    /// The tie-break and the NaN rule of [`pick_well`], and the clamp.
    #[test]
    fn the_first_well_in_order_wins_a_tie_and_a_nan_loses() {
        let mut f = AquiloResourceFields::default();
        assert_eq!(pick_well(&f), None, "all zero places nothing");
        f.crude_oil_probability = 0.01;
        f.lithium_brine_probability = 0.01;
        assert_eq!(pick_well(&f), Some((AquiloWell::LithiumBrine, 0.01)));
        f.fluorine_vent_probability = f64::NAN;
        assert_eq!(pick_well(&f), Some((AquiloWell::LithiumBrine, 0.01)));
        f.crude_oil_probability = 2.5;
        assert_eq!(pick_well(&f), Some((AquiloWell::CrudeOil, 1.0)));
    }
}
