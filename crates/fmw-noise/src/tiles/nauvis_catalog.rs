//! Nauvis's 21 autoplace tiles and the argmax that picks between them. Ported
//! from `src/noise/tiles/catalog.ts` and `src/noise/tiles/resolve.ts`.
//!
//! Transcribed from the game's `base/prototypes/tile/tiles.lua`
//! `probability_expression` and `map_color` fields.
//!
//! ## The order is data, not decoration
//!
//! Tile selection is a pure argmax over the 21 probabilities, ties keeping the
//! FIRST tile in catalog order. Catalog order is the data file's registration
//! order, so [`TILE_ORDER`] is ground truth: rearranging it changes which tile
//! the game places at a tie. A strict `>` never displaces the running winner,
//! which is what makes "first" mean first.
//!
//! ## Two shapes, and the asymmetry between them
//!
//! The two water tiles are [`water_base`] alone - no noise layer and no climate
//! dependence at all. The nineteen land tiles are all
//! `expression_in_range_base(...) + noise_layer_noise(N)`, some with the range
//! term being a `max` of two climate boxes. Only `sand-1` breaks the pattern,
//! with an unbounded coastal term over (elevation, aux) rather than a second
//! (aux, moisture) box.
//!
//! ## Every probability is a COMPOSITE, so the argmax alone cannot grade them
//!
//! A mis-transcribed `max` arity, a swapped `from`/`to`, or a wrong noise-layer
//! seed can still produce a plausible winner. [`NauvisTileCatalog::probabilities`]
//! therefore returns the whole vector rather than only the winner, and the
//! formulas live here once and are never copied into a test.

use crate::eval::math::max2;
use crate::multioctave_noise::Prepared;
use crate::tiles::expression_in_range::expression_in_range;
use crate::tiles::helpers::{expression_in_range_base, noise_layer_noise, water_base};

/// Every tile Nauvis can place through autoplace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NauvisTile {
    Deepwater,
    Water,
    Grass1,
    Grass2,
    Grass3,
    Grass4,
    DryDirt,
    Dirt1,
    Dirt2,
    Dirt3,
    Dirt4,
    Dirt5,
    Dirt6,
    Dirt7,
    Sand1,
    Sand2,
    Sand3,
    RedDesert0,
    RedDesert1,
    RedDesert2,
    RedDesert3,
}

/// The 21 tiles in the data file's REGISTRATION order.
///
/// This is the argmax's tie-break, so it is ground truth rather than a listing.
pub const TILE_ORDER: [NauvisTile; 21] = [
    NauvisTile::Deepwater,
    NauvisTile::Water,
    NauvisTile::Grass1,
    NauvisTile::Grass2,
    NauvisTile::Grass3,
    NauvisTile::Grass4,
    NauvisTile::DryDirt,
    NauvisTile::Dirt1,
    NauvisTile::Dirt2,
    NauvisTile::Dirt3,
    NauvisTile::Dirt4,
    NauvisTile::Dirt5,
    NauvisTile::Dirt6,
    NauvisTile::Dirt7,
    NauvisTile::Sand1,
    NauvisTile::Sand2,
    NauvisTile::Sand3,
    NauvisTile::RedDesert0,
    NauvisTile::RedDesert1,
    NauvisTile::RedDesert2,
    NauvisTile::RedDesert3,
];

impl NauvisTile {
    /// The tile's prototype name, which is what the oracle fixture records.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Deepwater => "deepwater",
            Self::Water => "water",
            Self::Grass1 => "grass-1",
            Self::Grass2 => "grass-2",
            Self::Grass3 => "grass-3",
            Self::Grass4 => "grass-4",
            Self::DryDirt => "dry-dirt",
            Self::Dirt1 => "dirt-1",
            Self::Dirt2 => "dirt-2",
            Self::Dirt3 => "dirt-3",
            Self::Dirt4 => "dirt-4",
            Self::Dirt5 => "dirt-5",
            Self::Dirt6 => "dirt-6",
            Self::Dirt7 => "dirt-7",
            Self::Sand1 => "sand-1",
            Self::Sand2 => "sand-2",
            Self::Sand3 => "sand-3",
            Self::RedDesert0 => "red-desert-0",
            Self::RedDesert1 => "red-desert-1",
            Self::RedDesert2 => "red-desert-2",
            Self::RedDesert3 => "red-desert-3",
        }
    }

    /// The tile's `map_color`, 0-255 verbatim from the data file.
    ///
    /// `sand-2` and `red-desert-3` share `[128, 93, 52]`, which is why a
    /// name-level fixture grades this layer and a rendered image cannot.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        match self {
            Self::Deepwater => [38, 64, 73],
            Self::Water => [51, 83, 95],
            Self::Grass1 => [55, 53, 11],
            Self::Grass2 => [66, 57, 15],
            Self::Grass3 => [65, 52, 28],
            Self::Grass4 => [59, 40, 18],
            Self::DryDirt => [94, 66, 37],
            Self::Dirt1 => [141, 104, 60],
            Self::Dirt2 => [136, 96, 59],
            Self::Dirt3 => [133, 92, 53],
            Self::Dirt4 => [103, 72, 43],
            Self::Dirt5 => [91, 63, 38],
            Self::Dirt6 => [80, 55, 31],
            Self::Dirt7 => [80, 54, 28],
            Self::Sand1 => [138, 103, 58],
            Self::Sand2 => [128, 93, 52],
            Self::Sand3 => [115, 83, 47],
            Self::RedDesert0 => [103, 70, 32],
            Self::RedDesert1 => [116, 81, 39],
            Self::RedDesert2 => [116, 84, 43],
            Self::RedDesert3 => [128, 93, 52],
        }
    }
}

/// The field values the 21 probability expressions read, at one position.
///
/// `elevation` is `elevation_nauvis` - the cliff-carrying tree, not
/// `elevation_nauvis_no_cliff`, and not the 4-tile cliff channel. Wiring the
/// wrong one is issue #83's category error, and it is invisible to any bound.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct NauvisTileFields {
    pub x: f64,
    pub y: f64,
    pub elevation: f64,
    pub aux: f64,
    pub moisture: f64,
}

/// The nineteen `noise_layer_noise` generators the land tiles read, built once
/// per seed.
///
/// The seeds are 6-13, 19-22, 30-33 and 36-38 - not a contiguous range, because
/// they are the game's own global noise-layer ids and other prototypes hold the
/// gaps. Getting one wrong yields a plausible but wrong jitter, which is why
/// they are named individually rather than generated from a range.
pub struct NauvisTileCatalog {
    layer6: Prepared,
    layer7: Prepared,
    layer8: Prepared,
    layer9: Prepared,
    layer10: Prepared,
    layer11: Prepared,
    layer12: Prepared,
    layer13: Prepared,
    layer19: Prepared,
    layer20: Prepared,
    layer21: Prepared,
    layer22: Prepared,
    layer30: Prepared,
    layer31: Prepared,
    layer32: Prepared,
    layer33: Prepared,
    layer36: Prepared,
    layer37: Prepared,
    layer38: Prepared,
}

impl NauvisTileCatalog {
    /// Build the nineteen noise layers for one map seed.
    #[must_use]
    pub fn new(seed0: u32) -> Self {
        Self {
            layer6: noise_layer_noise(seed0, 6),
            layer7: noise_layer_noise(seed0, 7),
            layer8: noise_layer_noise(seed0, 8),
            layer9: noise_layer_noise(seed0, 9),
            layer10: noise_layer_noise(seed0, 10),
            layer11: noise_layer_noise(seed0, 11),
            layer12: noise_layer_noise(seed0, 12),
            layer13: noise_layer_noise(seed0, 13),
            layer19: noise_layer_noise(seed0, 19),
            layer20: noise_layer_noise(seed0, 20),
            layer21: noise_layer_noise(seed0, 21),
            layer22: noise_layer_noise(seed0, 22),
            layer30: noise_layer_noise(seed0, 30),
            layer31: noise_layer_noise(seed0, 31),
            layer32: noise_layer_noise(seed0, 32),
            layer33: noise_layer_noise(seed0, 33),
            layer36: noise_layer_noise(seed0, 36),
            layer37: noise_layer_noise(seed0, 37),
            layer38: noise_layer_noise(seed0, 38),
        }
    }

    /// All 21 probabilities at one position, in [`TILE_ORDER`].
    ///
    /// The whole vector rather than the winner, so a mis-transcribed formula
    /// can be caught by the field it belongs to rather than only when it
    /// happens to change an argmax.
    #[must_use]
    #[allow(clippy::too_many_lines)]
    pub fn probabilities(&self, f: &NauvisTileFields) -> [f64; 21] {
        let (x, y) = (f.x, f.y);
        let (a, m) = (f.aux, f.moisture);

        // water_base(-2, 200)
        let deepwater = water_base(f.elevation, -2.0, 200.0);
        // water_base(0, 100)
        let water = water_base(f.elevation, 0.0, 100.0);

        // expression_in_range_base(-10,0.7,11,11) + noise_layer_noise(19)
        let grass_1 = expression_in_range_base(a, m, -10.0, 0.7, 11.0, 11.0)
            + f64::from(self.layer19.eval(x, y));
        // expression_in_range_base(0.45,0.45,11,0.8) + noise_layer_noise(20)
        let grass_2 = expression_in_range_base(a, m, 0.45, 0.45, 11.0, 0.8)
            + f64::from(self.layer20.eval(x, y));
        // expression_in_range_base(-10,0.6,0.65,0.9) + noise_layer_noise(21)
        let grass_3 = expression_in_range_base(a, m, -10.0, 0.6, 0.65, 0.9)
            + f64::from(self.layer21.eval(x, y));
        // expression_in_range_base(-10,0.5,0.55,0.7) + noise_layer_noise(22)
        let grass_4 = expression_in_range_base(a, m, -10.0, 0.5, 0.55, 0.7)
            + f64::from(self.layer22.eval(x, y));

        // expression_in_range_base(0.45,-10,0.55,0.35) + noise_layer_noise(13)
        let dry_dirt = expression_in_range_base(a, m, 0.45, -10.0, 0.55, 0.35)
            + f64::from(self.layer13.eval(x, y));

        // max(expression_in_range_base(-10,0.25,0.45,0.3),
        //     expression_in_range_base(0.4,-10,0.45,0.25)) + noise_layer_noise(6)
        let dirt_1 = max2(
            expression_in_range_base(a, m, -10.0, 0.25, 0.45, 0.3),
            expression_in_range_base(a, m, 0.4, -10.0, 0.45, 0.25),
        ) + f64::from(self.layer6.eval(x, y));
        // expression_in_range_base(-10,0.3,0.45,0.35) + noise_layer_noise(7)
        let dirt_2 = expression_in_range_base(a, m, -10.0, 0.3, 0.45, 0.35)
            + f64::from(self.layer7.eval(x, y));
        // expression_in_range_base(-10,0.35,0.55,0.4) + noise_layer_noise(8)
        let dirt_3 = expression_in_range_base(a, m, -10.0, 0.35, 0.55, 0.4)
            + f64::from(self.layer8.eval(x, y));
        // max(expression_in_range_base(0.55,-10,0.6,0.35),
        //     expression_in_range_base(0.6,0.3,11,0.35)) + noise_layer_noise(9)
        let dirt_4 = max2(
            expression_in_range_base(a, m, 0.55, -10.0, 0.6, 0.35),
            expression_in_range_base(a, m, 0.6, 0.3, 11.0, 0.35),
        ) + f64::from(self.layer9.eval(x, y));
        // expression_in_range_base(-10,0.4,0.55,0.45) + noise_layer_noise(10)
        let dirt_5 = expression_in_range_base(a, m, -10.0, 0.4, 0.55, 0.45)
            + f64::from(self.layer10.eval(x, y));
        // expression_in_range_base(-10,0.45,0.55,0.5) + noise_layer_noise(11)
        let dirt_6 = expression_in_range_base(a, m, -10.0, 0.45, 0.55, 0.5)
            + f64::from(self.layer11.eval(x, y));
        // expression_in_range_base(-10,0.5,0.55,0.55) + noise_layer_noise(12)
        let dirt_7 = expression_in_range_base(a, m, -10.0, 0.5, 0.55, 0.55)
            + f64::from(self.layer12.eval(x, y));

        // max(expression_in_range_base(-10,-10,0.25,0.15),
        //     expression_in_range(5, inf, elevation, aux, -1.5, 0.5, 1.5, 1)) + noise_layer_noise(36)
        //
        // The one tile whose second term is NOT an (aux, moisture) box: it is an
        // unbounded coastal term over (elevation, aux), and its `inf` peak
        // maximum is what lets sand-1 beat a saturated climate box on a shore.
        let sand_1 = max2(
            expression_in_range_base(a, m, -10.0, -10.0, 0.25, 0.15),
            expression_in_range(
                5.0,
                f64::INFINITY,
                &[f.elevation, a],
                &[-1.5, 0.5],
                &[1.5, 1.0],
            ),
        ) + f64::from(self.layer36.eval(x, y));
        // max(expression_in_range_base(-10,0.15,0.3,0.2),
        //     expression_in_range_base(0.25,-10,0.3,0.15)) + noise_layer_noise(37)
        let sand_2 = max2(
            expression_in_range_base(a, m, -10.0, 0.15, 0.3, 0.2),
            expression_in_range_base(a, m, 0.25, -10.0, 0.3, 0.15),
        ) + f64::from(self.layer37.eval(x, y));
        // max(expression_in_range_base(-10,0.2,0.4,0.25),
        //     expression_in_range_base(0.3,-10,0.4,0.2)) + noise_layer_noise(38)
        let sand_3 = max2(
            expression_in_range_base(a, m, -10.0, 0.2, 0.4, 0.25),
            expression_in_range_base(a, m, 0.3, -10.0, 0.4, 0.2),
        ) + f64::from(self.layer38.eval(x, y));

        // expression_in_range_base(0.55,0.35,11,0.5) + noise_layer_noise(30)
        let red_desert_0 = expression_in_range_base(a, m, 0.55, 0.35, 11.0, 0.5)
            + f64::from(self.layer30.eval(x, y));
        // max(expression_in_range_base(0.6,-10,0.7,0.3),
        //     expression_in_range_base(0.7,0.25,11,0.3)) + noise_layer_noise(31)
        let red_desert_1 = max2(
            expression_in_range_base(a, m, 0.6, -10.0, 0.7, 0.3),
            expression_in_range_base(a, m, 0.7, 0.25, 11.0, 0.3),
        ) + f64::from(self.layer31.eval(x, y));
        // max(expression_in_range_base(0.7,-10,0.8,0.25),
        //     expression_in_range_base(0.8,0.2,11,0.25)) + noise_layer_noise(32)
        let red_desert_2 = max2(
            expression_in_range_base(a, m, 0.7, -10.0, 0.8, 0.25),
            expression_in_range_base(a, m, 0.8, 0.2, 11.0, 0.25),
        ) + f64::from(self.layer32.eval(x, y));
        // expression_in_range_base(0.8,-10,11,0.2) + noise_layer_noise(33)
        let red_desert_3 = expression_in_range_base(a, m, 0.8, -10.0, 11.0, 0.2)
            + f64::from(self.layer33.eval(x, y));

        [
            deepwater,
            water,
            grass_1,
            grass_2,
            grass_3,
            grass_4,
            dry_dirt,
            dirt_1,
            dirt_2,
            dirt_3,
            dirt_4,
            dirt_5,
            dirt_6,
            dirt_7,
            sand_1,
            sand_2,
            sand_3,
            red_desert_0,
            red_desert_1,
            red_desert_2,
            red_desert_3,
        ]
    }

    /// The tile the game would place here: the argmax over
    /// [`Self::probabilities`], ties keeping the first in [`TILE_ORDER`].
    ///
    /// `>` rather than `>=` is what "first wins" means, and it is not a style
    /// choice: two of these tiles share a colour and every land tile shares the
    /// same shape of climate box, so exact ties are reachable.
    ///
    /// A NaN loses rather than poisoning, for free: `v > best` is false for a
    /// NaN `v`. `water_base` returns `-inf` above its level, and `-inf` times a
    /// zero mask is NaN, so this is reachable rather than hypothetical.
    #[must_use]
    pub fn resolve(&self, f: &NauvisTileFields) -> NauvisTile {
        let p = self.probabilities(f);
        let mut best_index = 0usize;
        let mut best = p[0];
        for (i, &v) in p.iter().enumerate().skip(1) {
            if v > best {
                best = v;
                best_index = i;
            }
        }
        // A numeric hook cannot reach a DISCRETE output - measured in phase 3,
        // where a one-ULP nudge left the Fulgora tile test green. This is the
        // argmax's own control.
        TILE_ORDER[crate::poison::index_result(best_index, TILE_ORDER.len())]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Names and colours must be a bijection onto the 21 variants, and the
    /// order must be the registration order. A duplicated arm in either `match`
    /// is a one-token slip that renders plausibly.
    #[test]
    fn the_catalog_is_twenty_one_distinct_tiles_in_registration_order() {
        assert_eq!(TILE_ORDER.len(), 21);

        let mut names: Vec<&str> = TILE_ORDER.iter().map(|t| t.name()).collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "two tiles share a prototype name");

        // The two water tiles lead, because the data file registers them first
        // and the argmax's tie-break is that order.
        assert_eq!(TILE_ORDER[0].name(), "deepwater");
        assert_eq!(TILE_ORDER[1].name(), "water");
        assert_eq!(TILE_ORDER[20].name(), "red-desert-3");
    }

    /// Colours are NOT distinct, and that is the reason this layer is graded by
    /// name. Pinned so the collision is a recorded fact rather than a surprise.
    #[test]
    fn two_tiles_share_a_map_color_so_a_png_cannot_grade_this() {
        assert_eq!(NauvisTile::Sand2.color(), NauvisTile::RedDesert3.color());
        let mut colors: Vec<[u8; 3]> = TILE_ORDER.iter().map(|t| t.color()).collect();
        colors.sort_unstable();
        colors.dedup();
        assert_eq!(colors.len(), 20, "expected exactly one colour collision");
    }

    /// Deep water excludes every land tile outright, so the argmax has to pick
    /// `deepwater` regardless of climate.
    #[test]
    fn deep_elevation_resolves_to_deepwater() {
        let catalog = NauvisTileCatalog::new(123_456);
        let f = NauvisTileFields {
            x: 0.0,
            y: 0.0,
            elevation: -50.0,
            aux: 0.5,
            moisture: 0.5,
        };
        assert_eq!(catalog.resolve(&f), NauvisTile::Deepwater);

        // Between -2 and 0 only `water` survives: deepwater is excluded and the
        // land tiles are still far below water's influence of 100.
        let shallow = NauvisTileFields {
            elevation: -1.0,
            ..f
        };
        assert_eq!(catalog.resolve(&shallow), NauvisTile::Water);
    }

    /// Above sea level the water tiles are `-inf`, so a land tile must win.
    #[test]
    fn land_elevation_never_resolves_to_a_water_tile() {
        let catalog = NauvisTileCatalog::new(123_456);
        for aux in [0.0_f64, 0.25, 0.5, 0.75, 1.0] {
            for moisture in [0.0_f64, 0.25, 0.5, 0.75, 1.0] {
                let f = NauvisTileFields {
                    x: 17.0,
                    y: -23.0,
                    elevation: 10.0,
                    aux,
                    moisture,
                };
                let tile = catalog.resolve(&f);
                assert!(
                    tile != NauvisTile::Water && tile != NauvisTile::Deepwater,
                    "aux={aux} moisture={moisture} resolved to {}",
                    tile.name()
                );
            }
        }
    }

    /// The nineteen noise layers must be nineteen DIFFERENT generators. A
    /// copy-paste slip that builds two tiles on the same seed is invisible to
    /// the argmax most of the time, and this is the cheap way to catch it.
    #[test]
    fn the_nineteen_noise_layers_are_all_distinct() {
        let catalog = NauvisTileCatalog::new(123_456);
        let layers = [
            &catalog.layer6,
            &catalog.layer7,
            &catalog.layer8,
            &catalog.layer9,
            &catalog.layer10,
            &catalog.layer11,
            &catalog.layer12,
            &catalog.layer13,
            &catalog.layer19,
            &catalog.layer20,
            &catalog.layer21,
            &catalog.layer22,
            &catalog.layer30,
            &catalog.layer31,
            &catalog.layer32,
            &catalog.layer33,
            &catalog.layer36,
            &catalog.layer37,
            &catalog.layer38,
        ];
        assert_eq!(layers.len(), 19);
        let mut bits: Vec<u32> = layers
            .iter()
            .map(|l| l.eval(31.5, -17.25).to_bits())
            .collect();
        let count = bits.len();
        bits.sort_unstable();
        bits.dedup();
        assert_eq!(count, bits.len(), "two noise layers share a seed");
    }

    /// The probability vector must be 21 long and in `TILE_ORDER`, so index `i`
    /// really is `TILE_ORDER[i]`'s probability. The water pair is the check that
    /// cannot be satisfied by accident: they are the only two entries with no
    /// noise term, so they are exactly `water_base` and nothing else.
    #[test]
    fn the_probability_vector_is_indexed_by_tile_order() {
        let catalog = NauvisTileCatalog::new(123_456);
        let f = NauvisTileFields {
            x: 3.0,
            y: 5.0,
            elevation: -3.0,
            aux: 0.5,
            moisture: 0.5,
        };
        let p = catalog.probabilities(&f);
        assert_eq!(p.len(), TILE_ORDER.len());
        assert_eq!(p[0], water_base(f.elevation, -2.0, 200.0));
        assert_eq!(p[1], water_base(f.elevation, 0.0, 100.0));
    }

    /// An exact tie resolves to the EARLIER tile in [`TILE_ORDER`], and this is
    /// the test that sees `poison::index_result` rather than an inherited hook.
    ///
    /// The tie is real arithmetic, not a contrived pair of numbers.
    /// `water_base` gives `deepwater = 200 * min(-2 - e, 1)` and
    /// `water = 100 * min(0 - e, 1)`, which cross at `e = -2.5`: 200 * 0.5 and
    /// 100 * 1, both exactly 100. Every land tile is capped near 1 there, so
    /// the argmax really is between those two.
    ///
    /// **`poison::index_result` is the ONLY thing that can redden this, and
    /// that is measured.** Deleting that call and re-running under
    /// `--features poison` leaves this test green - and leaves the end-to-end
    /// fixture test green too, which is the surprising half: numeric poison
    /// applied to every field beneath the catalog does not move one of the 153
    /// tiles the game placed. The argmax absorbs it completely.
    #[test]
    fn an_exact_tie_resolves_to_the_earlier_tile_in_order() {
        let catalog = NauvisTileCatalog::new(123_456);
        let f = NauvisTileFields {
            x: 0.0,
            y: 0.0,
            elevation: -2.5,
            aux: 0.5,
            moisture: 0.5,
        };
        let p = catalog.probabilities(&f);
        assert_eq!(p[0], p[1], "the tie this test rests on has moved");
        assert_eq!(p[0], 100.0);
        // Anti-vacuity: no land tile is anywhere near, so the argmax is
        // genuinely deciding between the tied pair.
        for (i, &v) in p.iter().enumerate().skip(2) {
            assert!(v < 100.0, "land tile {i} reached {v}, breaking the setup");
        }

        // deepwater is index 0 and water is index 1, so first wins.
        assert_eq!(catalog.resolve(&f), NauvisTile::Deepwater);
    }

    /// `sand-1`'s coastal term is the only uncapped one, and it must be able to
    /// exceed the 1.0 plateau every other range term is capped at. Without the
    /// `inf` peak maximum this tile would never win on a shore.
    #[test]
    fn sand_1s_coastal_term_is_uncapped() {
        // Deep inside the (elevation, aux) box: elevation 0, aux 0.75 is 0.25
        // from the aux edge, so 5 * 0.25 = 1.25 > 1.
        let coastal =
            expression_in_range(5.0, f64::INFINITY, &[0.0, 0.75], &[-1.5, 0.5], &[1.5, 1.0]);
        assert!(coastal > 1.0, "expected an uncapped plateau, got {coastal}");

        // And a capped climate box at the same depth cannot exceed 1.
        assert_eq!(
            expression_in_range_base(0.5, 0.5, -10.0, -10.0, 11.0, 11.0),
            1.0
        );
    }
}
