//! The three masks that divide Fulgora's land into natural and artificial,
//! ported from `src/noise/expressions/fulgoraMasks.ts`.
//!
//! Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
//! lines 250-292. They are defined in the middle of the elevation block, which
//! makes them look like part of the mix chain; nothing in that chain reads
//! them, which is why phase 3 left them out and why they live here.
//!
//! `fulgora_sprawl_mask` sits in the same run of definitions and is NOT ported -
//! no tile probability reads it.
//!
//! Stateless: every mask is a pure function of fields the layers below already
//! produced, so there is nothing to build and nothing to cache.

use crate::eval::math::{max2, min2};
use crate::expressions::fulgora_cells::CellFields;
use crate::expressions::fulgora_elevation::ElevationFields;
use crate::expressions::fulgora_shared::SharedFields;

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MaskFields {
    /// `max(min(natural > mix_pyramids, 1 - vaults_and_starting_vault), starting_mask)`.
    pub natural: f64,
    /// `max(natural_mask, mesa)` - the mask the two natural-side ruin terms use.
    pub natural_and_mesa: f64,
    /// `1 - max(oil_mask, natural_and_mesa_mask)` - not oil, not natural.
    pub artificial: f64,
}

/// Evaluate all three at one position.
#[must_use]
pub fn eval(shared: &SharedFields, cells: &CellFields, elevation: &ElevationFields) -> MaskFields {
    // The comparison yields 1 or 0, matching the engine's boolean-to-number
    // convention.
    let is_natural = f64::from(u8::from(elevation.natural > elevation.mix_pyramids));
    // `min`/`max` in the TypeScript's own argument order, through the helpers
    // that carry JavaScript's signed-zero and NaN semantics. See `eval::math::min2`.
    let natural = max2(
        min2(is_natural, 1.0 - cells.vaults_and_starting_vault),
        shared.starting_mask,
    );
    let natural_and_mesa = max2(natural, cells.mesa);
    let artificial = 1.0 - max2(elevation.oil_mask, natural_and_mesa);
    MaskFields {
        natural,
        natural_and_mesa,
        artificial,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three are a partition-ish family: `artificial` is what is left after
    /// oil and natural, so it can never be positive where either of those is 1.
    #[test]
    fn artificial_is_what_neither_oil_nor_natural_claims() {
        let shared = SharedFields {
            starting_mask: 0.0,
            ..SharedFields::default()
        };
        let cells = CellFields {
            mesa: 1.0,
            vaults_and_starting_vault: 0.0,
            ..CellFields::default()
        };
        let elevation = ElevationFields {
            natural: 1.0,
            mix_pyramids: 0.0,
            oil_mask: 0.0,
            ..ElevationFields::default()
        };
        let m = eval(&shared, &cells, &elevation);
        assert_eq!(m.natural, 1.0);
        assert_eq!(m.natural_and_mesa, 1.0);
        assert_eq!(m.artificial, 0.0);
    }

    /// `starting_mask` overrides the `min`, which is what the outer `max` is
    /// for - spawn is natural whatever the vault flag says.
    #[test]
    fn the_starting_mask_forces_natural_over_the_vault_term() {
        let shared = SharedFields {
            starting_mask: 1.0,
            ..SharedFields::default()
        };
        let cells = CellFields {
            vaults_and_starting_vault: 1.0,
            ..CellFields::default()
        };
        let elevation = ElevationFields::default();
        // Without the outer max this would be 0: the comparison is false and
        // `1 - 1` is 0.
        assert_eq!(eval(&shared, &cells, &elevation).natural, 1.0);
    }
}
