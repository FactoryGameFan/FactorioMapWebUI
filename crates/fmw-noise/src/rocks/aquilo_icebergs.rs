//! Aquilo's lithium icebergs as one rolled overlay: `lithium-iceberg-huge` and
//! `lithium-iceberg-big`.
//!
//! Both are `simple-entity` prototypes in
//! `space-age/prototypes/decorative/decoratives-aquilo.lua` (2.1.23), with
//! probabilities that read only `aquilo_high_frequency_peaks`:
//!
//! | | `lithium-iceberg-huge` | `lithium-iceberg-big` |
//! | --- | --- | --- |
//! | probability | `(aquilo_high_frequency_peaks - 0.8) * 0.1` | `(aquilo_high_frequency_peaks - 0.7) * 0.8` |
//! | `collision_box` | `{{-1.85, -1.25}, {1.85, 1.25}}`: 3.7 x 2.5 | `{{-1.0, -0.75}, {1.0, 0.75}}`: 2.0 x 1.5 |
//! | autoplace `order` | `a[rock]-a[huge]` | `a[rock]-b[big]` |
//! | `collision_mask` | `item`, `object`, `player`, `water_tile` | the same |
//! | `map_color` | `lithium_rock_map_colour` = `{168, 188, 211}` | the same |
//!
//! There is no TypeScript counterpart; Aquilo is ported Rust-first. The
//! `lithium-iceberg-medium` and smaller kin are `optimized-decorative`s, which
//! the map preview does not draw.
//!
//! Where the icebergs land is not yet the game's: the density is close, but
//! individual icebergs fall in other places (#492).
//!
//! ## One stream, winner by largest probability
//!
//! The two share one [`PlacementSet`] and one salt,
//! [`salt::AQUILO_ICEBERGS`], as `rocks::nauvis_placement` does for its three
//! rocks. The overlay's probability is the larger of the two, clamped to
//! [0, 1], and the winner is the prototype that gives it. An exact tie goes to
//! the first in [`ICEBERG_ORDER`], huge then big, by autoplace `order`. **That
//! tie rule is ours.** A NaN loses.
//!
//! **Under that rule huge never wins.** `huge > big` means
//! `0.1 h - 0.08 > 0.8 h - 0.56`, so `h < 0.6857`, where huge is negative. So
//! wherever either probability is above 0, big is the larger, and the overlay's
//! probability is big's everywhere. `rocks::vulcanus_placement` is the matching
//! precedent: two rock prototypes, the huge one provably never the argmax.
//! (Nauvis keeps an argmax box because its `big-sand-rock` can win.) The
//! game's census at the derived seed has 21 huge icebergs against 159 big, so
//! the game does NOT arbitrate this way; `docs/noise/placement-roll-NOTES.md`
//! records the same finding for the Vulcanus and Nauvis rocks (issue #22,
//! item 1).
//!
//! ## The box: huge's, everywhere
//!
//! **The collision box is `lithium-iceberg-huge`'s 3.7 x 2.5 at every tile**,
//! the rule `vulcanus_placement` ships, not the box of the winning prototype.
//! The argmax box would be big's 2.0 x 1.5 everywhere, and that roughly doubles
//! the game's density. Measured 2026-10-23 over the census window (tiles
//! -256..255, derived seed 3111923328, default levers):
//!
//! | box rule | icebergs | against the game's 180 |
//! | --- | ---: | ---: |
//! | **shipped: huge's 3.7 x 2.5 box everywhere** | **195** | **+8%** |
//! | argmax, so big's 2.0 x 1.5 box everywhere | 357 | +98% |
//! | no collision at all | 718 | +299% |
//! | big's box, and all 3x3 tiles around the iceberg on land | 234 | +30% |
//! | huge's box, and all 3x3 tiles on land | 132 | -27% |
//!
//! The probabilities sum to 724 over the window's 7,420 land tiles, so the
//! box, not the field, decides the count.
//!
//! **What that settles and what it does not**, as for Vulcanus: the box was
//! CHOSEN by comparing candidates against the game's count, not derived. The
//! tile-level huge/big identity is known WRONG (the model gives 0% huge, the
//! game about 12%); the claim this overlay makes is density, and huge's box
//! everywhere is the rule measured closest in count. Both icebergs draw the
//! same colour, so identity is not visible in the preview. [`winner`] still
//! reports the argmax, which is always big.
//!
//! [`winner`]: AquiloIcebergPlacement::winner

//! ## Where the probability is evaluated
//!
//! At the tile's integer corner on the chunk grid
//! ([`At::tile`](crate::at::At::tile)), the position `PlacementSet` hands
//! every overlay. `aquilo_high_frequency_peaks` is a raw-coordinate noise
//! field, so a map-generation read takes the grid kernel. Each op is narrowed
//! to f32, constants included, as the noise machine does. In `fixtures`,
//! `aquilo_iceberg_probabilities_match_the_game` grades both probabilities
//! against the game on the point kernel through our field, and
//! `the_aquilo_iceberg_formula_reproduces_the_game_from_its_own_peaks` grades
//! the formula alone on the game's own field. Both are full houses.
//!
//! ## `tile_allowed`: the six land tiles
//!
//! The census (`test/fixtures/oracle-aquilo-entities.seed123456.json`,
//! derived seed 3111923328, tiles -256..255) has all 180 icebergs on land
//! (`tileWithoutEffect`, the same as `tile` for icebergs):
//!
//! | tile | big | huge |
//! | --- | ---: | ---: |
//! | `snow-flat` | 31 | 6 |
//! | `snow-crests` | 20 | 3 |
//! | `snow-lumpy` | 33 | 4 |
//! | `snow-patchy` | 13 | 2 |
//! | `ice-rough` | 28 | 2 |
//! | `ice-smooth` | 34 | 4 |
//! | `brash-ice`, both oceans | 0 | 0 |
//!
//! The prototypes say why: both `collision_mask`s carry `water_tile`, and
//! `tile_collision_masks.ammoniacal_ocean()`
//! (`base/prototypes/tile/tile-collision-masks.lua:30-40` at 2.1.23) lists
//! `water_tile = true`. That mask is the one both oceans and `brash-ice` use
//! (`space-age/prototypes/tile/tiles-aquilo.lua:135`, `:147` and `:500`). The
//! snow tiles use `ground()` and the ice tiles `meltable_tile()`, which do not.
//!
//! **The gate reads the tile at the iceberg's own tile only.** The game tests
//! the mask against every tile under the box, so an iceberg whose box reaches
//! over the shore is refused there and allowed here. Reading more tiles would
//! still be a pure function of position; it is left out because the census
//! cannot show its size.
//!
//! ## Colour
//!
//! `lithium_rock_map_colour = {168, 188, 211}` (`decoratives-aquilo.lua:9`)
//! is already in 0-255 units. The game's full preview
//! (`test/fixtures/oracle-preview-aquilo-full.seed123456.png`) draws 4,609
//! pixels of exactly (168, 188, 211), the one non-tile colour there besides
//! the three wells' (see `resources::aquilo_wells`).

use crate::expressions::aquilo_stack::{tile_at, AquiloStack};
use crate::placement::roll::{salt, PlacementCollisionBox, PlacementSet, PlacementSource};
use crate::poison;
use crate::tiles::aquilo_catalog::AquiloTile;
use core::cell::RefCell;

/// `lithium-iceberg-huge`'s `collision_box`, 3.7 x 2.5 tiles.
pub const HUGE_ICEBERG_BOX: PlacementCollisionBox = PlacementCollisionBox { w: 3.7, h: 2.5 };
/// `lithium-iceberg-big`'s `collision_box`, 2.0 x 1.5 tiles.
pub const BIG_ICEBERG_BOX: PlacementCollisionBox = PlacementCollisionBox { w: 2.0, h: 1.5 };

/// `lithium_rock_map_colour`, shared by both prototypes, as the game's preview
/// draws it.
pub const ICEBERG_COLOR: [u8; 3] = [168, 188, 211];

/// One of the two iceberg prototypes the preview draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AquiloIceberg {
    Huge,
    Big,
}

/// The tie-break order, by autoplace `order` string.
pub const ICEBERG_ORDER: [AquiloIceberg; 2] = [AquiloIceberg::Huge, AquiloIceberg::Big];

impl AquiloIceberg {
    /// The prototype's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::Huge => "lithium-iceberg-huge",
            Self::Big => "lithium-iceberg-big",
        }
    }

    /// The prototype's `map_color`. Both share one.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        ICEBERG_COLOR
    }

    /// The prototype's `collision_box`.
    #[must_use]
    pub fn collision_box(self) -> PlacementCollisionBox {
        match self {
            Self::Huge => HUGE_ICEBERG_BOX,
            Self::Big => BIG_ICEBERG_BOX,
        }
    }
}

/// Narrow to f32 and back, the noise machine's per-op rounding.
fn f32r(v: f64) -> f64 {
    f64::from(v as f32)
}

/// The two probabilities in [`ICEBERG_ORDER`], unclamped, each op in f32:
/// `(h - 0.8) * 0.1` and `(h - 0.7) * 0.8`.
#[must_use]
pub fn iceberg_probabilities(high_frequency_peaks: f64) -> [f64; 2] {
    let h = f32r(high_frequency_peaks);
    let huge = f32r(f32r(h - f64::from(0.8f32)) * f64::from(0.1f32));
    let big = f32r(f32r(h - f64::from(0.7f32)) * f64::from(0.8f32));
    [huge, big].map(poison::f64_result)
}

/// The winning iceberg and its probability clamped to [0, 1], or `None` when
/// neither is above 0. First maximum in [`ICEBERG_ORDER`] wins and a NaN
/// loses.
#[must_use]
pub fn pick_iceberg(high_frequency_peaks: f64) -> Option<(AquiloIceberg, f64)> {
    let mut best: Option<(AquiloIceberg, f64)> = None;
    let mut best_value = 0.0;
    for (iceberg, v) in ICEBERG_ORDER
        .into_iter()
        .zip(iceberg_probabilities(high_frequency_peaks))
    {
        if v > best_value {
            best_value = v;
            best = Some((iceberg, v));
        }
    }
    best.map(|(iceberg, v)| (iceberg, v.min(1.0)))
}

/// Whether an iceberg may stand on this tile: the six land tiles.
#[must_use]
pub fn iceberg_tile_allowed(tile: AquiloTile) -> bool {
    !matches!(
        tile,
        AquiloTile::BrashIce | AquiloTile::AmmoniacalOcean | AquiloTile::AmmoniacalOcean2
    )
}

/// The iceberg overlay's placement source. The stack sits behind a `RefCell`
/// for the reason `resources::aquilo_wells::AquiloWellPlacement` gives.
pub struct AquiloIcebergPlacement<'a> {
    stack: &'a RefCell<AquiloStack>,
}

impl<'a> AquiloIcebergPlacement<'a> {
    #[must_use]
    pub fn new(stack: &'a RefCell<AquiloStack>) -> Self {
        Self { stack }
    }

    fn pick(&self, x: f64, y: f64) -> Option<(AquiloIceberg, f64)> {
        let peaks = self
            .stack
            .borrow_mut()
            .eval_at(tile_at(x, y))
            .terrain
            .high_frequency_peaks;
        pick_iceberg(peaks)
    }

    /// The iceberg that wins the tile containing `(x, y)`, or `None` where
    /// neither probability is above 0.
    #[must_use]
    pub fn winner(&self, x: f64, y: f64) -> Option<AquiloIceberg> {
        self.pick(x, y).map(|(iceberg, _)| iceberg)
    }

    /// The placement set for this overlay, ready to be asked `placed(x, y)`.
    #[must_use]
    pub fn placement_set(&self) -> PlacementSet<'_> {
        PlacementSet::new(salt::AQUILO_ICEBERGS, self)
    }
}

impl PlacementSource for AquiloIcebergPlacement<'_> {
    fn probability(&self, x: f64, y: f64) -> f64 {
        self.pick(x, y).map_or(0.0, |(_, p)| p)
    }

    /// Derived from the tile resolver at this tile, never from rendered pixels,
    /// so it is a pure function of world position.
    fn tile_allowed(&self, x: f64, y: f64) -> bool {
        let tile = self.stack.borrow_mut().eval_at(tile_at(x, y)).tile();
        iceberg_tile_allowed(tile)
    }

    /// `lithium-iceberg-huge`'s box at every tile, whichever prototype wins:
    /// see "The box: huge's, everywhere" in the module docs.
    fn collision_box(&self, _x: f64, _y: f64) -> Option<PlacementCollisionBox> {
        Some(HUGE_ICEBERG_BOX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::aquilo_resources::AquiloResourceControls;
    use crate::expressions::aquilo_stack::AquiloCtx;
    use crate::resources::aquilo_wells::AquiloWellPlacement;
    use crate::tiles::aquilo_catalog::TILE_ORDER;

    /// The derived Aquilo surface seed for map seed 123456.
    const DERIVED_SEED: u32 = 3_111_923_328;

    fn stack(seed0: u32) -> RefCell<AquiloStack> {
        RefCell::new(AquiloStack::with_host_trig(&AquiloCtx {
            seed0,
            controls: AquiloResourceControls::default(),
        }))
    }

    /// Wherever either probability is above 0, big is strictly the larger, so
    /// huge never wins: the theorem in the module docs, swept in f32 steps of
    /// 1/1024 over the field's whole positive range and past it.
    #[test]
    fn huge_never_wins_where_either_iceberg_can_place() {
        let mut positive = 0;
        for i in 0..4096 {
            let h = f64::from(i) / 1024.0;
            let [huge, big] = iceberg_probabilities(h);
            if huge > 0.0 || big > 0.0 {
                positive += 1;
                assert!(big > huge, "h = {h}: huge {huge} against big {big}");
                assert_eq!(pick_iceberg(h).map(|(i, _)| i), Some(AquiloIceberg::Big));
            } else {
                assert_eq!(pick_iceberg(h), None, "h = {h}");
            }
        }
        // Non-vacuity: the sweep crosses big's zero at h = 0.7.
        assert!(positive > 3000, "{positive}");
    }

    /// The clamp holds at large `h`, and a NaN places nothing.
    #[test]
    fn the_overlay_probability_is_clamped_and_a_nan_loses() {
        assert_eq!(pick_iceberg(10.0), Some((AquiloIceberg::Big, 1.0)));
        assert_eq!(pick_iceberg(f64::NAN), None);
        assert_eq!(pick_iceberg(0.7), None, "big is exactly 0 at 0.7");
    }

    /// The box is huge's at a tile big wins, and at a tile neither wins: the
    /// R7 rule, pinned because only density can show it otherwise, and the
    /// argmax box (big's) roughly doubles the count (357 against 195 in the
    /// census window).
    #[test]
    fn the_box_is_huges_at_every_tile_whichever_iceberg_wins() {
        let s = stack(DERIVED_SEED);
        let placement = AquiloIcebergPlacement::new(&s);
        let mut big_wins = 0;
        for ty in -16..16 {
            for tx in -16..16 {
                let (x, y) = (f64::from(tx), f64::from(ty));
                if placement.winner(x, y) == Some(AquiloIceberg::Big) {
                    big_wins += 1;
                }
                assert_eq!(placement.collision_box(x, y), Some(HUGE_ICEBERG_BOX));
            }
        }
        assert!(
            big_wins > 0,
            "no tile where big wins, so this grades little"
        );
    }

    /// The gate is the six land tiles, and only those.
    #[test]
    fn icebergs_stand_on_the_six_land_tiles_only() {
        let allowed: Vec<&str> = TILE_ORDER
            .iter()
            .filter(|t| iceberg_tile_allowed(**t))
            .map(|t| t.game_name())
            .collect();
        assert_eq!(
            allowed,
            vec![
                "snow-flat",
                "snow-crests",
                "snow-lumpy",
                "snow-patchy",
                "ice-rough",
                "ice-smooth"
            ]
        );
    }

    /// A 512x512 window at the derived seed, the census's own tiles -256..255,
    /// places at least one of each overlay. Each placed tile has a winner, and
    /// each placed iceberg stands on land.
    ///
    /// The scan stops at the first of each, which keeps it cheap: a full scan
    /// costs about 4 s per overlay in a debug build, and under `poison` the
    /// flipped roll would make it place on nearly every tile. Scanned in full
    /// on 2026-10-23, the window holds 24 wells (8 crude oil, 10 lithium
    /// brine, 6 fluorine vents) against the game's 19 (11, 4, 4), and 195
    /// icebergs, all big by `winner`, against the game's 180 (159 big, 21
    /// huge); see the module docs.
    #[test]
    fn wells_and_icebergs_place_on_a_real_window() {
        let s = stack(DERIVED_SEED);
        let wells = AquiloWellPlacement::new(&s);
        let icebergs = AquiloIcebergPlacement::new(&s);
        let (well_set, iceberg_set) = (wells.placement_set(), icebergs.placement_set());
        let (mut well, mut iceberg) = (None, None);
        'scan: for ty in -256..256 {
            for tx in -256..256 {
                let (x, y) = (f64::from(tx), f64::from(ty));
                if well.is_none() && well_set.placed(x, y) {
                    well = Some((tx, ty, wells.winner(x, y)));
                }
                if iceberg.is_none() && iceberg_set.placed(x, y) {
                    let tile = s.borrow_mut().eval_at(tile_at(x, y)).tile();
                    iceberg = Some((tx, ty, icebergs.winner(x, y), tile));
                }
                if well.is_some() && iceberg.is_some() {
                    break 'scan;
                }
            }
        }
        let (_, _, well_winner) = well.expect("no well placed in the window");
        assert!(well_winner.is_some(), "{well:?}");
        let (_, _, iceberg_winner, tile) = iceberg.expect("no iceberg placed in the window");
        assert_eq!(iceberg_winner, Some(AquiloIceberg::Big), "{iceberg:?}");
        assert!(iceberg_tile_allowed(tile), "{iceberg:?}");
    }

    /// Two sets, asked in opposite orders over the same 64x64 tiles, agree at
    /// all 4,096, as for the wells. This overlay also reads the tile gate and a
    /// per-tile box, both through the shared stack.
    #[test]
    fn the_iceberg_overlay_is_a_pure_function_of_position() {
        let s = stack(DERIVED_SEED);
        let placement = AquiloIcebergPlacement::new(&s);
        let forward = placement.placement_set();
        let backward = placement.placement_set();
        let (x0, y0) = (-32, -32);
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
        eprintln!("icebergs placed in the window: {placed}");
        assert!(
            placed > 1,
            "only {placed} icebergs placed, so this grades little"
        );
    }
}
