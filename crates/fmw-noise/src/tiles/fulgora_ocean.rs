//! Fulgora's ocean test, ported from the `oceanTileFrom` half of
//! `src/noise/tiles/fulgoraCatalog.ts`.
//!
//! **This is the land mask's whole question.** `view: "landmask"` paints one
//! colour where this returns an ocean tile and another where it does not, and
//! the island finder is built on it.
//!
//! It costs an elevation-chain evaluation and nothing more. Measured at radius
//! 1024 over 40 real candidate windows, `chain.elevation` alone is 81% of a full
//! tile pixel (16.41 of 20.14 us at 8 tiles/px), so skipping the eight-way land
//! argmax is the remaining ~18% at most; end to end through the renderer it is
//! 15.7% at 8 tiles/px and 13.8% at 2.
//!
//! The eight land formulas and the argmax between them are phase 4 (#224).

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

/// The ocean test.
///
/// `None` means "not ocean" - the position falls through to the land argmax,
/// which phase 4 will supply.
///
/// **`> 0` rather than `>= 0` on the early-out, and that is not a nicety.** A
/// probability of exactly 0 does not place a tile, and `-inf` (above the tile's
/// water level) fails it too. Both are reachable - the mask being off makes
/// every term exactly 0 - so an ocean probability of exactly 0 correctly falls
/// through to land rather than taking this branch.
#[must_use]
pub fn ocean_tile(fields: &ElevationFields) -> Option<Ocean> {
    let e = fields.elevation;
    let mask = fields.oil_mask;

    // `s`'s SIGN is what picks between the two shallow variants: `shallow`
    // takes `max(-s, 0)` and `shallow2` takes `max(s, 0)`, so exactly one of
    // them is non-zero away from `s == 0`.
    let s = fields.scrap_medium + fields.dunes;

    let shallow_base = 50.0 * mask * water_base(e, COASTLINE, 1000.0);
    let shallow = shallow_base * (-s).max(0.0);
    let shallow2 = shallow_base * s.max(0.0);

    let deep_base = 100.0 * mask * water_base(e, DEEP_LEVEL, 2000.0);
    let deep2_scale = -(e - 60.0).min(0.0) / 100.0 + (fields.dunes - (e / 100.0).max(0.0)).max(0.0);
    let deep2 = deep2_scale * deep_base;

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
