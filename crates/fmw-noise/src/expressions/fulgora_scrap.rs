//! Fulgora's scrap `probability_expression`, ported from
//! `src/noise/expressions/fulgoraScrap.ts`.
//!
//! **No new field.** Every term it reads was already ported, so this module is
//! composition only - which makes the COMPOSITION the one untested link, and
//! `oracle-fulgora-scrap.seed123456.json` is what closes it.
//!
//! Three properties drive everything downstream:
//!
//! - **It is capped at 0.5 and never saturates.** `min(..., 0.5)` wraps the
//!   whole inner term. Nauvis and Vulcanus solid ores saturate to about 1 and
//!   are drawn as solid patches; scrap cannot be, which is why the overlay
//!   ROLLS.
//! - **It can go negative**, entirely through `fulgora_structure_subnoise < -1`:
//!   1002 positions in a 1024x1024 window, none from `road_paving_2c > 1` or
//!   `starting_mask > 1`, and none above 1. Hence the clamp. Summing the raw
//!   values understates the placement expectation by about 6%.
//! - **It excludes water on its own.** `fulgora_elevation > fulgora_coastline +
//!   10` put expected scrap on ocean at exactly 0.00 over 262,144 tiles, so the
//!   renderer needs no tile gate.
//!
//! ## The f32 narrowings here are transcribed, not inferred
//!
//! The TypeScript spells out where each rounding happens and why, and this port
//! matches it operation for operation. Two are worth repeating because they are
//! the "narrow the CONSTANT" case and a reader will want to simplify them:
//!
//! - The two slider cuts narrow `0.1`, `0.05`, `1.2` and `0.4` BEFORE they
//!   multiply anything. At the default sliders the two forms are identical, so
//!   **no fixture here can discriminate** - the rule is what justifies it. Off
//!   the default they differ: at frequency 4/3, product-first gives
//!   0.11666666716337204 against constant-first's 0.11666667461395264.
//! - Both `1 - <field>` subtractions narrow the FIELD before subtracting.
//!   `road_paving_2c` ends on an f64 `0.9`, and `f32(1 - 0.9)` is
//!   0.10000000149011612 while the game computes `1 - f32(0.9)` =
//!   0.10000002384185791. Measured: this drops the fixture's worst relative
//!   error from 2.235e-7 to exactly 0.

use crate::eval::math::slider_to_linear;
use crate::expressions::fulgora_cells::CellFields;
use crate::expressions::fulgora_elevation::{ElevationFields, COASTLINE};
use crate::expressions::fulgora_masks::MaskFields;
use crate::expressions::fulgora_roads::RoadFields;
use crate::expressions::fulgora_shared::SharedFields;

/// `control:scrap:frequency` and `control:scrap:size`, wire values.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrapControls {
    pub frequency: f64,
    pub size: f64,
}

impl Default for ScrapControls {
    fn default() -> Self {
        Self {
            frequency: 1.0,
            size: 1.0,
        }
    }
}

/// The scrap probability and the two additive terms the game's own diagnostic
/// dump names.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ScrapFields {
    /// The per-tile placement probability, clamped to `[0, 1]`.
    pub probability: f64,
    pub struct_term: f64,
    pub vault_term: f64,
}

/// The slider-derived constants, hoisted out of the per-position path because
/// they depend only on the controls.
#[derive(Debug, Clone, Copy)]
pub struct FulgoraScrap {
    cells_cut: f64,
    spots_cut: f64,
    enabled: bool,
}

impl FulgoraScrap {
    #[must_use]
    pub fn new(controls: &ScrapControls) -> Self {
        let f = controls.frequency;
        // `min(f32(f32(0.1) * f), f32(f32(0.05) + f32(f32(0.05) * f)))`.
        let a = (f64::from(0.1f32) * f) as f32;
        let b = (f64::from(0.05f32) + f64::from((f64::from(0.05f32) * f) as f32)) as f32;
        let cells_cut = f64::from(a.min(b));

        // `f32(f32(1.2) + f32(f32(0.4) * slider_to_linear(size, -1, 1)))`.
        let scaled =
            (f64::from(0.4f32) * f64::from(slider_to_linear(controls.size, -1.0, 1.0))) as f32;
        let spots_cut = f64::from((f64::from(1.2f32) + f64::from(scaled)) as f32);

        Self {
            cells_cut,
            spots_cut,
            enabled: controls.size > 0.0,
        }
    }

    /// Evaluate the scrap probability at one position.
    #[must_use]
    pub fn eval(
        &self,
        shared: &SharedFields,
        cells: &CellFields,
        elevation: &ElevationFields,
        masks: &MaskFields,
        roads: &RoadFields,
    ) -> ScrapFields {
        let struct_term = f64::from(u8::from(roads.structure_cells < self.cells_cut))
            * f64::from((1.0 + roads.structure_subnoise) as f32)
            * f64::from(u8::from(elevation.elevation > COASTLINE + 10.0))
            * masks.artificial;
        let vault_term = f64::from(u8::from(roads.spots_prebanding < self.spots_cut))
            * f64::from((cells.vaults_and_starting_vault * 10.0) as f32);

        if !self.enabled {
            return ScrapFields {
                probability: 0.0,
                struct_term,
                vault_term,
            };
        }

        let inner = f64::from(((struct_term + vault_term) as f32).min(0.5f32));
        // Both subtractions narrow the FIELD first. See the module docs.
        let one_minus_start = (1.0 - f64::from(shared.starting_mask as f32)) as f32;
        let one_minus_paving = (1.0 - f64::from(roads.road_paving_2c as f32)) as f32;
        let raw = f64::from(
            (f64::from(one_minus_start) * f64::from((inner * f64::from(one_minus_paving)) as f32))
                as f32,
        );

        // The game rolls `U < probability`, so a negative value is simply never
        // and a value above 1 always. Clamping is what makes an expectation sum
        // meaningful and keeps the roll honest.
        // `clamp` rather than the TypeScript's ternary chain, and they are the
        // same function here: `raw` cannot be NaN (every input is finite and
        // the ops are add/multiply), which is the one case where `f64::clamp`
        // and the ternary differ.
        let probability = raw.clamp(0.0, 1.0);
        ScrapFields {
            probability,
            struct_term,
            vault_term,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// At the default sliders the cuts are the values the Lua names, and the
    /// two f32 forms coincide - which is exactly why the fixture cannot grade
    /// the narrowing and the module docs have to carry the reasoning.
    #[test]
    fn the_default_sliders_give_the_lua_constants() {
        let s = FulgoraScrap::new(&ScrapControls::default());
        assert_eq!(s.cells_cut, f64::from(0.1f32));
        assert_eq!(s.spots_cut, f64::from(1.2f32));
        assert!(s.enabled);
    }

    /// Off the default, the constant-first and product-first forms differ - the
    /// exact pair of values the TypeScript records. Pinned so "simplify this"
    /// has a number attached.
    ///
    /// **It is the SECOND cut term that discriminates**, `0.05 + 0.05*f`, not
    /// the first. A first draft of this test used `0.1*f` and both forms agreed
    /// to the bit, which would have made the assertion vacuous rather than
    /// wrong - the kind of near miss only running it catches.
    #[test]
    fn off_the_default_slider_the_two_forms_disagree() {
        let frequency = 4.0 / 3.0;
        let constant_first = f64::from(
            (f64::from(0.05f32) + f64::from((f64::from(0.05f32) * frequency) as f32)) as f32,
        );
        let product_first = f64::from((0.05f64 + 0.05f64 * frequency) as f32);
        assert_ne!(constant_first, product_first);
        assert_eq!(constant_first, 0.116_666_674_613_952_64);
        assert_eq!(product_first, 0.116_666_667_163_372_04);

        // And the FIRST cut agrees between the two forms at this frequency, so
        // a test that used it would prove nothing.
        assert_eq!(
            f64::from((f64::from(0.1f32) * frequency) as f32),
            f64::from((0.1f64 * frequency) as f32)
        );
    }

    /// A size slider of 0 turns scrap off entirely - twice over, and the second
    /// way is the interesting one.
    ///
    /// The `enabled` flag short-circuits `probability`. But `spots_cut` also
    /// collapses to `-inf`, because `slider_to_linear(0, ...)` reaches
    /// `log2(0)`, so the vault term's comparison is false everywhere on its own.
    /// A first draft of this test asserted `vault_term == 10` and was wrong
    /// about that second path.
    #[test]
    fn a_zero_size_slider_disables_placement_twice_over() {
        let s = FulgoraScrap::new(&ScrapControls {
            frequency: 1.0,
            size: 0.0,
        });
        assert!(!s.enabled);
        let f = s.eval(
            &SharedFields::default(),
            &CellFields {
                vaults_and_starting_vault: 1.0,
                ..CellFields::default()
            },
            &ElevationFields::default(),
            &MaskFields::default(),
            &RoadFields {
                spots_prebanding: 0.0,
                ..RoadFields::default()
            },
        );
        assert_eq!(f.probability, 0.0);
        assert_eq!(s.spots_cut, f64::NEG_INFINITY, "log2(0) collapses the cut");
        assert_eq!(
            f.vault_term, 0.0,
            "and the comparison against -inf is false"
        );
    }
}
