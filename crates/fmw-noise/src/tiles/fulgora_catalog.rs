//! Fulgora's tile catalog: the eight land probabilities and the argmax that
//! picks between them and the ocean branch. Ported from
//! `src/noise/tiles/fulgoraCatalog.ts`.
//!
//! Phase 3 landed the ocean half, because the land mask is all the island
//! finder needs. This is the rest (#224).

use crate::expressions::fulgora_cells::CellFields;
use crate::expressions::fulgora_elevation::ElevationFields;
use crate::expressions::fulgora_roads::RoadFields;
use crate::expressions::fulgora_ruins::RuinFields;
use crate::tiles::fulgora_ocean::{ocean_tile, Ocean};

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
    Shallow,
    Deep,
}

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
    // argument max, not `max(0, natural)` times something.
    let dust = elevation.scrap_medium
        + crate::eval::math::max(&[0.0, elevation.natural, 2.0 * cells.mesa * cells.pyramids])
            * 2.0
        - 0.9
        + elevation.rock
        + roads.road_dust * cells.sprawl;

    [
        dust,
        1.0 + elevation.dunes,
        1.0 - elevation.dunes,
        0.8 + elevation.rock * 2.0 - elevation.mix_oil.max(0.0) * 6.0,
        ruins.tile_ruin_paving,
        ruins.tile_ruin_walls,
        ruins.tile_ruin_conduit,
        ruins.tile_ruin_machinery,
    ]
}

/// Resolve a position to a tile: ocean first, then the eight-way land argmax.
///
/// **A NaN loses rather than poisoning the argmax.** `v > best` is false for a
/// NaN, so a NaN never becomes the best - matching the engine. The loop is
/// hand-written rather than a `max` fold because it needs the winning INDEX,
/// not the winning value.
///
/// The all-NaN case would fall through to `LAND_ORDER[0]`, and it has not been
/// observed: none of the eight formulas divides, and none multiplies a mask by
/// `-inf` the way `water_base` does, so none can produce a NaN from `0 * -inf`
/// the way the ocean branch's `deep`/`deep2` can. Measured at zero NaNs across
/// all 5,057 `oracle-fulgora-tiles` positions and a dense 169,303-point sweep
/// of `[-8000, 8000]^2`.
#[must_use]
pub fn resolve_tile(
    cells: &CellFields,
    elevation: &ElevationFields,
    roads: &RoadFields,
    ruins: &RuinFields,
) -> FulgoraTile {
    match ocean_tile(elevation) {
        Some(Ocean::Deep) => return FulgoraTile::Deep,
        Some(Ocean::Shallow) => return FulgoraTile::Shallow,
        None => {}
    }
    land_argmax(&land_probabilities(cells, elevation, roads, ruins))
}

/// The eight-way argmax on its own, without the ocean branch in front of it.
///
/// Split out so it can be tested - and POISONED - independently. Under the
/// `poison` feature the ocean test flips every position's answer, so a test that
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
            // The game distinguishes `-2` variants of both; they share a map
            // colour and this port does not model the split. See
            // `tiles::fulgora_ocean`.
            Self::Shallow => "oil-ocean-shallow",
            Self::Deep => "oil-ocean-deep",
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

    /// The ocean branch wins before the land argmax is even evaluated - a land
    /// probability cannot outbid a placed ocean tile.
    #[test]
    fn ocean_short_circuits_the_land_argmax() {
        let elevation = ElevationFields {
            oil_mask: 1.0,
            elevation: 0.0,
            dunes: 1000.0,
            ..ElevationFields::default()
        };
        let tile = resolve_tile(
            &CellFields::default(),
            &elevation,
            &RoadFields::default(),
            &RuinFields::default(),
        );
        assert!(matches!(tile, FulgoraTile::Deep | FulgoraTile::Shallow));
    }
}
