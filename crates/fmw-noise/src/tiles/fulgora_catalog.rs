//! Fulgora's tile catalog: the eight land probabilities and the ONE argmax that
//! picks among them and the four oil-ocean probabilities. Ported from
//! `src/noise/tiles/fulgoraCatalog.ts`.
//!
//! The game has no ocean-first gate. `generateBasicTiles` runs a single argmax
//! over every candidate tile, ocean included, so a position where an ocean score
//! is positive but a land score is higher is land (reverse-engineered from 2.1.23,
//! 2026-11-25). Phase 3 landed the ocean formulas, because the land mask is all
//! the island finder needs; this is the rest (#224).

use crate::eval::math::f32r;
use crate::expressions::fulgora_cells::CellFields;
use crate::expressions::fulgora_elevation::ElevationFields;
use crate::expressions::fulgora_roads::RoadFields;
use crate::expressions::fulgora_ruins::RuinFields;
use crate::tiles::fulgora_ocean::ocean_probabilities;

/// Every tile Fulgora can place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FulgoraTile {
    FulgoranDust,
    FulgoranDunes,
    FulgoranSand,
    FulgoranRock,
    FulgoranPaving,
    FulgoranWalls,
    FulgoranConduit,
    FulgoranMachinery,
    /// `oil-ocean-shallow`.
    Shallow,
    /// `oil-ocean-shallow-2`: the same map colour as [`Self::Shallow`], one
    /// layer lower, so tile correction sees a boundary between them.
    Shallow2,
    /// `oil-ocean-deep`.
    Deep,
    /// `oil-ocean-deep-2`: the same map colour as [`Self::Deep`], one layer
    /// higher.
    Deep2,
}

/// Every Fulgora tile, in the order the game's candidate list holds them: the
/// tile names sorted. [`resolve_tile`] keeps the first of an exact tie in this
/// order, as Gleba's does (`gleba_catalog::TIE_ORDER`).
pub const NAME_ORDER: [FulgoraTile; 12] = [
    FulgoraTile::FulgoranConduit,
    FulgoraTile::FulgoranDunes,
    FulgoraTile::FulgoranDust,
    FulgoraTile::FulgoranMachinery,
    FulgoraTile::FulgoranPaving,
    FulgoraTile::FulgoranRock,
    FulgoraTile::FulgoranSand,
    FulgoraTile::FulgoranWalls,
    FulgoraTile::Deep,
    FulgoraTile::Deep2,
    FulgoraTile::Shallow,
    FulgoraTile::Shallow2,
];

/// The eight land probabilities in a FIXED order, so the tie-break is stable.
///
/// The order is the game's, and it is load-bearing rather than cosmetic: the
/// argmax below keeps the FIRST maximum, so two tiles at an identical
/// probability resolve by this order.
pub const LAND_ORDER: [FulgoraTile; 8] = [
    FulgoraTile::FulgoranDust,
    FulgoraTile::FulgoranDunes,
    FulgoraTile::FulgoranSand,
    FulgoraTile::FulgoranRock,
    FulgoraTile::FulgoranPaving,
    FulgoraTile::FulgoranWalls,
    FulgoraTile::FulgoranConduit,
    FulgoraTile::FulgoranMachinery,
];

/// The eight land `probability_expression`s, in [`LAND_ORDER`].
///
/// **Four of the eight are COMPOSITES**, not bare named expressions the game
/// reports directly: `fulgoran-dust`, `-dunes`, `-sand` and `-rock` are
/// arithmetic over several named expressions, written out in `tiles-fulgora.lua`
/// and transcribed here. A composite can be mis-transcribed - a `max` arity, an
/// operator precedence, a sign - in a way that still produces a plausible
/// argmax, so **the argmax alone is not a check on it**. That is why the
/// probabilities are returned rather than only the winner.
///
/// **Every step is f32**, left to right as the Lua writes it, constants
/// included (`0.9` and `0.8` are narrowed before they meet a field). The game
/// compares these against the f32 ocean scores in one argmax, so they have to
/// be rounded the same way.
///
/// Keep this the only place the formulas are written. A copy in a test would be
/// checking the copy.
#[must_use]
pub fn land_probabilities(
    cells: &CellFields,
    elevation: &ElevationFields,
    roads: &RoadFields,
    ruins: &RuinFields,
) -> [f64; 8] {
    // `fulgoran-dust` reads `max(0, natural, 2 * mesa * pyramids)` - a THREE
    // argument max, not `max(0, natural)` times something. The whole sum is
    // `((((scrap_medium + max(..) * 2) - 0.9) + rock) + road_dust * sprawl)`.
    let mesa_pyramids = f32r(f32r(2.0 * cells.mesa) * cells.pyramids);
    let peak = crate::eval::math::max(&[0.0, elevation.natural, mesa_pyramids]);
    let dust = f32r(
        f32r(f32r(f32r(elevation.scrap_medium + f32r(peak * 2.0)) - f32r(0.9)) + elevation.rock)
            + f32r(roads.road_dust * cells.sprawl),
    );

    // `0.8 + rock * 2 - max(0, mix_oil) * 6`.
    let rock =
        f32r(f32r(f32r(0.8) + f32r(elevation.rock * 2.0)) - f32r(elevation.mix_oil.max(0.0) * 6.0));

    [
        dust,
        f32r(1.0 + elevation.dunes),
        f32r(1.0 - elevation.dunes),
        rock,
        ruins.tile_ruin_paving,
        ruins.tile_ruin_walls,
        ruins.tile_ruin_conduit,
        ruins.tile_ruin_machinery,
    ]
}

/// Resolve a position to a tile: ONE twelve-way argmax over the four ocean
/// scores and the eight land scores, as the game's `generateBasicTiles` does.
///
/// **There is no ocean-first gate.** An ocean tile wins only when its score is
/// the largest of the twelve, so a small positive ocean score loses to a larger
/// land one. At seed 123456 that is the 20 pixels where the old gate painted
/// shallow ocean over what the game paints as rock; the old rule cost nothing
/// else at the fixture positions (5,057 of 5,057 agree on land versus ocean).
///
/// **Candidate order.** The scores are visited in [`NAME_ORDER`], tile names
/// sorted, and the first maximum wins, so the order decides only EXACT f32
/// ties. Gleba's ties measured that order (#454); on Fulgora no exact tie at
/// the maximum was seen in the real-surface window or in a 16,384-point sweep
/// (`fixtures/fulgora_real_surface.rs`), so the order changes no
/// tile there. The scores themselves are still computed as the four ocean
/// scores (`oil-ocean-shallow`, `-shallow-2`, `-deep`, `-deep-2`) and then
/// [`LAND_ORDER`].
///
/// **A NaN loses rather than poisoning the argmax.** `v > best` is false for a
/// NaN, so a NaN never becomes the best - matching the engine, which starts the
/// best at `-inf` and compares with a strict `>`. The loop is hand-written
/// rather than a `max` fold because it needs the winning INDEX, not the winning
/// value. The `-inf` scores of a position above the water level lose the same
/// way.
///
/// **If all twelve are NaN or `-inf` the fallback is `LAND_ORDER[0]`.** The game
/// falls back to `getDefaultCandidateTileID`, which is a fixed tile it chose
/// elsewhere, so this is a stand-in for a case that has not been observed: land
/// always scores at least 1 on one of `dunes`/`sand` unless `dunes` is NaN, and
/// none of the eight formulas divides or multiplies a mask by `-inf`. Measured
/// at zero all-NaN positions across the 5,057 `oracle-fulgora-tiles` positions
/// and a dense 169,303-point sweep of `[-8000, 8000]^2`.
#[must_use]
pub fn resolve_tile(
    cells: &CellFields,
    elevation: &ElevationFields,
    roads: &RoadFields,
    ruins: &RuinFields,
) -> FulgoraTile {
    let ocean = ocean_probabilities(elevation);
    let land = land_probabilities(cells, elevation, roads, ruins);

    let mut scores = [0.0; CANDIDATES];
    for (s, v) in scores.iter_mut().zip(ocean.iter().chain(land.iter())) {
        *s = *v;
    }
    // `None` is the all-NaN-or-`-inf` fallback; the poison hook still rotates
    // it so the control sees the choice either way.
    let winner = crate::poison::index_result(
        candidate_argmax(&scores).unwrap_or(OCEAN_CANDIDATES),
        CANDIDATES,
    );
    candidate_tile(winner)
}

/// The first maximum of the twelve scores (`[shallow, shallow-2, deep,
/// deep-2, LAND_ORDER..]`), visited in [`NAME_ORDER`]; `None` if every score is
/// NaN or `-inf`.
fn candidate_argmax(scores: &[f64; CANDIDATES]) -> Option<usize> {
    let mut best_index: Option<usize> = None;
    let mut best_value = f32::NEG_INFINITY;
    for &i in &NAME_ORDER_CANDIDATES {
        // Both sides are f32 in the game; every score above is already rounded
        // to f32, so this narrowing is exact.
        let v = scores[i] as f32;
        if v > best_value {
            best_value = v;
            best_index = Some(i);
        }
    }
    best_index
}

/// Four ocean scores in front of the eight land ones.
const OCEAN_CANDIDATES: usize = 4;
const CANDIDATES: usize = OCEAN_CANDIDATES + LAND_ORDER.len();

/// [`NAME_ORDER`] as indices into the score array
/// `[shallow, shallow-2, deep, deep-2, LAND_ORDER..]`.
const NAME_ORDER_CANDIDATES: [usize; CANDIDATES] = [10, 5, 4, 11, 8, 7, 6, 9, 2, 3, 0, 1];

/// Index into `[shallow, shallow-2, deep, deep-2, LAND_ORDER..]` to its tile.
/// The `-2` variants share a map colour with their base tile but not a layer.
fn candidate_tile(index: usize) -> FulgoraTile {
    match index {
        0 => FulgoraTile::Shallow,
        1 => FulgoraTile::Shallow2,
        2 => FulgoraTile::Deep,
        3 => FulgoraTile::Deep2,
        i => LAND_ORDER[i - OCEAN_CANDIDATES],
    }
}

/// The eight-way land argmax on its own, without the ocean scores beside it.
///
/// Split out so it can be tested - and POISONED - independently of the
/// twelve-way argmax in [`resolve_tile`], which carries its own hook. A test that
/// went through [`resolve_tile`] would be red whether or not this had a control
/// of its own.
#[must_use]
pub fn land_argmax(probabilities: &[f64; 8]) -> FulgoraTile {
    let mut best_index = 0usize;
    let mut best_value = f64::NEG_INFINITY;
    for (i, v) in probabilities.iter().enumerate() {
        if *v > best_value {
            best_value = *v;
            best_index = i;
        }
    }
    LAND_ORDER[crate::poison::index_result(best_index, LAND_ORDER.len())]
}

impl FulgoraTile {
    /// The tile's name in the game's own vocabulary, for comparing against a
    /// `get_tile` capture.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::FulgoranDust => "fulgoran-dust",
            Self::FulgoranDunes => "fulgoran-dunes",
            Self::FulgoranSand => "fulgoran-sand",
            Self::FulgoranRock => "fulgoran-rock",
            Self::FulgoranPaving => "fulgoran-paving",
            Self::FulgoranWalls => "fulgoran-walls",
            Self::FulgoranConduit => "fulgoran-conduit",
            Self::FulgoranMachinery => "fulgoran-machinery",
            Self::Shallow => "oil-ocean-shallow",
            Self::Shallow2 => "oil-ocean-shallow-2",
            Self::Deep => "oil-ocean-deep",
            Self::Deep2 => "oil-ocean-deep-2",
        }
    }

    /// Whether this is one of the four oil-ocean tiles.
    #[must_use]
    pub fn is_ocean(self) -> bool {
        matches!(
            self,
            Self::Shallow | Self::Shallow2 | Self::Deep | Self::Deep2
        )
    }

    /// The `-2` variants folded onto their base tile: what a picture, or a
    /// fixture captured before the split was modelled, can tell apart.
    #[must_use]
    pub fn folded(self) -> Self {
        match self {
            Self::Shallow2 => Self::Shallow,
            Self::Deep2 => Self::Deep,
            t => t,
        }
    }

    /// The tile's effective layer (layer group plus offset), as the game
    /// reports it at runtime (the `oracle-fulgora-real-surface-*` fixtures,
    /// checked by `fulgora_layers_match_the_game`). Tile correction compares
    /// nothing else about a tile.
    #[must_use]
    pub fn layer(self) -> u16 {
        match self {
            Self::Deep => 66,
            Self::Deep2 => 67,
            Self::Shallow2 => 147,
            Self::Shallow => 148,
            Self::FulgoranPaving => 149,
            Self::FulgoranDust => 150,
            Self::FulgoranDunes => 151,
            Self::FulgoranSand => 152,
            Self::FulgoranRock => 153,
            Self::FulgoranWalls => 154,
            Self::FulgoranConduit => 155,
            Self::FulgoranMachinery => 156,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tie-break is the FIRST maximum, in `LAND_ORDER`. Two tiles at an
    /// identical probability must resolve to the earlier one.
    #[test]
    fn an_exact_tie_resolves_to_the_earlier_tile_in_land_order() {
        // Dunes and sand are `1 + dunes` and `1 - dunes`, so `dunes == 0` ties
        // them exactly - and dunes comes first.
        let elevation = ElevationFields {
            dunes: 0.0,
            // Everything else pushed below 1 so those two win the argmax.
            scrap_medium: -10.0,
            natural: -10.0,
            rock: -10.0,
            mix_oil: 0.0,
            oil_mask: 0.0,
            elevation: 1000.0,
            ..ElevationFields::default()
        };
        let probabilities = land_probabilities(
            &CellFields::default(),
            &elevation,
            &RoadFields::default(),
            &RuinFields::default(),
        );
        assert_eq!(probabilities[1], probabilities[2], "the tie must be exact");
        // `land_argmax` directly, NOT `resolve_tile`: under the poison feature
        // the ocean test flips every answer, so going through the resolver here
        // would make this test red for the ocean hook's reason rather than the
        // argmax's. This is the test that sees `poison::index_result`.
        assert_eq!(land_argmax(&probabilities), FulgoraTile::FulgoranDunes);
        // And the resolver agrees on the same input, so splitting them out has
        // not left the two able to disagree.
        assert_eq!(
            resolve_tile(
                &CellFields::default(),
                &elevation,
                &RoadFields::default(),
                &RuinFields::default()
            ),
            FulgoraTile::FulgoranDunes
        );
    }

    /// An exact tie goes to the tile whose name sorts first, whatever order
    /// the scores are computed in: land before oil ocean, `deep` before
    /// `deep-2` before `shallow`.
    #[test]
    fn an_exact_tie_goes_to_the_name_that_sorts_first() {
        let tie = |pairs: &[(usize, f64)]| {
            let mut s = [f64::NEG_INFINITY; CANDIDATES];
            for &(i, v) in pairs {
                s[i] = v;
            }
            candidate_tile(candidate_argmax(&s).expect("a winner"))
        };
        // shallow (index 0) against dust (4): dust sorts first.
        assert_eq!(tie(&[(0, 2.0), (4, 2.0)]), FulgoraTile::FulgoranDust);
        // deep-2 (3) against shallow (0): deep-2 sorts first.
        assert_eq!(tie(&[(0, 2.0), (3, 2.0)]), FulgoraTile::Deep2);
        // conduit (10) against dunes (5): conduit sorts first.
        assert_eq!(tie(&[(5, 1.0), (10, 1.0)]), FulgoraTile::FulgoranConduit);
        // Control: without the tie, the larger score wins.
        assert_eq!(tie(&[(0, 2.5), (4, 2.0)]), FulgoraTile::Shallow);
        // Every index is visited exactly once.
        let mut seen = NAME_ORDER_CANDIDATES;
        seen.sort_unstable();
        assert_eq!(seen, std::array::from_fn(|i| i));
        for (k, &i) in NAME_ORDER_CANDIDATES.iter().enumerate() {
            assert_eq!(candidate_tile(i), NAME_ORDER[k]);
        }
    }

    /// A NaN must LOSE, not poison. Reachable in principle through the ocean
    /// branch, and the guard costs nothing.
    #[test]
    fn a_nan_probability_loses_the_argmax() {
        let elevation = ElevationFields {
            dunes: f64::NAN,
            rock: 5.0,
            elevation: 1000.0,
            ..ElevationFields::default()
        };
        // `dunes` and `sand` are both NaN; `rock` at 0.8 + 10 wins.
        assert_eq!(
            resolve_tile(
                &CellFields::default(),
                &elevation,
                &RoadFields::default(),
                &RuinFields::default()
            ),
            FulgoraTile::FulgoranRock
        );
    }

    /// A POSITIVE ocean score does not by itself make a position ocean: the game
    /// runs one argmax over all twelve tiles, so a larger land score wins. This
    /// is the test that pins the joint argmax - the old ocean-first rule answered
    /// shallow ocean here (the 20 pixels of #521's last Fulgora residual).
    #[test]
    fn a_positive_ocean_score_loses_to_a_larger_land_score() {
        use crate::tiles::fulgora_ocean::{ocean_probabilities, ocean_tile, Ocean};
        // Inside the oil mask, just under the coastline, with `s` a hair below 0:
        // the shallow score is small and positive (about 2.5).
        let elevation = ElevationFields {
            oil_mask: 1.0,
            elevation: 79.5,
            scrap_medium: -1e-4,
            dunes: 0.0,
            // Rock scores `0.8 + 5 * 2 = 10.8`, well above the ocean.
            rock: 5.0,
            ..ElevationFields::default()
        };
        let ocean = ocean_probabilities(&elevation);
        let best_ocean = ocean.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let land = land_probabilities(
            &CellFields::default(),
            &elevation,
            &RoadFields::default(),
            &RuinFields::default(),
        );
        assert!(best_ocean > 0.0, "the control needs a positive ocean score");
        assert!(land[3] > best_ocean, "and a land score that beats it");
        // The control that can fail: the ocean-only test answers `Some`, which
        // is what the old ocean-first resolver would have returned.
        assert_eq!(ocean_tile(&elevation), Some(Ocean::Shallow));
        assert_eq!(
            resolve_tile(
                &CellFields::default(),
                &elevation,
                &RoadFields::default(),
                &RuinFields::default()
            ),
            FulgoraTile::FulgoranRock
        );
    }

    /// And an ocean score that IS the largest wins, shallow or deep.
    #[test]
    fn an_ocean_score_that_beats_every_land_score_wins() {
        let resolve = |elevation: &ElevationFields| {
            resolve_tile(
                &CellFields::default(),
                elevation,
                &RoadFields::default(),
                &RuinFields::default(),
            )
        };
        // `s = -1`: shallow is `50 * 500 * 1 = 25,000`, land is below 2.
        let shallow = ElevationFields {
            oil_mask: 1.0,
            elevation: 79.5,
            scrap_medium: -1.0,
            ..ElevationFields::default()
        };
        assert_eq!(resolve(&shallow), FulgoraTile::Shallow);
        // Deep water: `100 * 2000 = 200,000` at elevation 0, with `s = 0`.
        let deep = ElevationFields {
            oil_mask: 1.0,
            elevation: 0.0,
            ..ElevationFields::default()
        };
        assert_eq!(resolve(&deep), FulgoraTile::Deep);
    }
}
