//! Fulgora's ocean probabilities, ported from the `oceanTileFrom` half of
//! `src/noise/tiles/fulgoraCatalog.ts`.
//!
//! [`ocean_probabilities`] is the four oil-ocean `probability_expression`s, and
//! it is the ONLY place their formulas are written. The game does not test the
//! ocean before the land: `generateBasicTiles` runs one argmax over all twelve
//! candidate tiles, so
//! [`resolve_tile`](crate::tiles::fulgora_catalog::resolve_tile) feeds these four
//! numbers into that argmax beside the eight land scores. [`ocean_tile`] is the
//! ocean-only question on its own - "is the best ocean score positive, and which
//! ocean is it" - and it is NOT what picks a rendered tile any more. A position
//! where an ocean score is positive but a land score is higher is land.
//!
//! Costs an elevation-chain evaluation and nothing more. Measured at radius
//! 1024 over 40 real candidate windows, `chain.elevation` alone is 81% of a full
//! tile pixel (16.41 of 20.14 us at 8 tiles/px), so the eight land formulas are
//! the remaining ~18% at most.

use crate::eval::math::f32r;
use crate::expressions::fulgora_elevation::{ElevationFields, COASTLINE};
use crate::tiles::helpers::{best_probability, water_base};

/// `fulgora_deep_level` - `coastline - 50 - coastline_drop/2` = 20.
///
/// Written as the arithmetic rather than as `20.0` so it moves with
/// `COASTLINE` if that ever does, which is how the Lua writes it.
const DEEP_LEVEL: f64 = COASTLINE - 50.0 - 20.0 / 2.0;

/// Which ocean tile, if any, sits at a position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ocean {
    Deep,
    Shallow,
}

/// The four oil-ocean probabilities, in the game's tile order: `oil-ocean-shallow`,
/// `oil-ocean-shallow-2`, `oil-ocean-deep`, `oil-ocean-deep-2`.
///
/// `-inf` (above the tile's water level) and 0 (the mask is off) both mean "this
/// tile is not placed here"; the argmax treats a `-inf` as losing and a 0 as a
/// score like any other, which a land tile beats whenever it is higher.
///
/// `s`'s SIGN is what picks between the two shallow variants: `shallow` takes
/// `max(-s, 0)` and `shallow2` takes `max(s, 0)`, so exactly one of them is
/// non-zero away from `s == 0`.
///
/// Every step is f32, left to right as `tiles-fulgora.lua` writes it (#521):
/// `50 * mask * water_base(...) * max(...)` is three products.
#[must_use]
pub fn ocean_probabilities(fields: &ElevationFields) -> [f64; 4] {
    let e = fields.elevation;
    let mask = fields.oil_mask;

    let s = f32r(fields.scrap_medium + fields.dunes);

    let shallow_base = f32r(f32r(50.0 * mask) * water_base(e, COASTLINE, 1000.0));
    let shallow = f32r(shallow_base * (-s).max(0.0));
    let shallow2 = f32r(shallow_base * s.max(0.0));

    let deep_base = f32r(f32r(100.0 * mask) * water_base(e, DEEP_LEVEL, 2000.0));
    let deep2_scale = f32r(
        f32r(-f32r(e - 60.0).min(0.0) / 100.0)
            + (f32r(fields.dunes - f32r(e / 100.0).max(0.0))).max(0.0),
    );
    let deep2 = f32r(deep2_scale * deep_base);

    [shallow, shallow2, deep_base, deep2]
}

/// The ocean-only test: which ocean tile has the best score, if that score is
/// positive.
///
/// **This is not the game's tile choice.** `None` means "no ocean tile scores
/// above 0", and `Some` means only that an ocean tile scores above 0 - a land
/// tile can still score higher and win the single twelve-way argmax in
/// [`resolve_tile`](crate::tiles::fulgora_catalog::resolve_tile). It stays for
/// the `get_tile` fixture's land-versus-ocean grading, where it measures the
/// ocean formulas on their own.
///
/// **`> 0` rather than `>= 0`, and that is not a nicety.** A probability of
/// exactly 0 is not a placed tile, and `-inf` (above the tile's water level)
/// fails it too. Both are reachable - the mask being off makes every term
/// exactly 0.
#[must_use]
pub fn ocean_tile(fields: &ElevationFields) -> Option<Ocean> {
    let [shallow, shallow2, deep_base, deep2] = ocean_probabilities(fields);

    let best_shallow = best_probability(&[shallow, shallow2]);
    let best_deep = best_probability(&[deep_base, deep2]);
    let best_ocean = best_probability(&[best_shallow, best_deep]);

    // The poison hook acts on the CHOICE, not on a probability. A one-ULP nudge
    // to any number above changes which side of this comparison a value falls
    // on essentially never, so a numeric hook leaves the tier-1 test green -
    // measured, see `poison::bool_result`.
    if crate::poison::bool_result(best_ocean > 0.0) {
        return Some(if best_deep > best_shallow {
            Ocean::Deep
        } else {
            Ocean::Shallow
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::fulgora_cells::FulgoraCells;
    use crate::expressions::fulgora_elevation::FulgoraElevation;
    use crate::expressions::fulgora_shared::{FulgoraCtx, FulgoraShared};

    /// A position outside the oil mask cannot be ocean, whatever its elevation:
    /// the mask multiplies every term, so all of them are exactly 0 and the
    /// `> 0` early-out correctly declines.
    #[test]
    fn a_zero_oil_mask_is_never_ocean() {
        let mut fields = ElevationFields {
            oil_mask: 0.0,
            elevation: 0.0,
            scrap_medium: 0.5,
            dunes: 0.5,
            ..ElevationFields::default()
        };
        assert_eq!(ocean_tile(&fields), None);
        // And with the mask ON at the same elevation it IS ocean, so the
        // assertion above is about the mask rather than about the elevation.
        fields.oil_mask = 1.0;
        assert!(ocean_tile(&fields).is_some());
    }

    /// The sign of `scrap_medium + dunes` picks the shallow variant, and both
    /// variants share a base - so it cannot change whether the position is
    /// ocean, only which shallow formula wins.
    #[test]
    fn the_shallow_variants_are_selected_by_sign_and_never_both() {
        for s in [-1.0f64, 1.0] {
            let fields = ElevationFields {
                oil_mask: 1.0,
                elevation: 79.5,
                scrap_medium: s,
                dunes: 0.0,
                ..ElevationFields::default()
            };
            assert_eq!(ocean_tile(&fields), Some(Ocean::Shallow), "s = {s}");
        }
    }

    /// Both ocean kinds are reachable on a real sweep, so a test that only ever
    /// saw one of them would not be checking the deep/shallow decision at all.
    #[test]
    fn a_real_sweep_reaches_both_ocean_kinds_and_land() {
        let ctx = FulgoraCtx::new(123_456);
        let shared = FulgoraShared::with_host_trig(&ctx);
        let mut cells = FulgoraCells::new(&ctx, shared.grid);
        let elev = FulgoraElevation::new(&ctx, shared.grid);

        let (mut deep, mut shallow, mut land) = (0, 0, 0);
        for j in 0..48 {
            for i in 0..48 {
                let (x, y) = (f64::from(i) * 24.0 - 576.0, f64::from(j) * 24.0 - 576.0);
                let s = shared.eval(x, y);
                let c = cells.eval(&s);
                match ocean_tile(&elev.eval(x, y, &s, &c)) {
                    Some(Ocean::Deep) => deep += 1,
                    Some(Ocean::Shallow) => shallow += 1,
                    None => land += 1,
                }
            }
        }
        assert!(
            deep > 0 && shallow > 0 && land > 0,
            "deep={deep} shallow={shallow} land={land}"
        );
    }
}
