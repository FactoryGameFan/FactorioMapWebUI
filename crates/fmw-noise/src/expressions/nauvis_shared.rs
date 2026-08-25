//! Nauvis's reusable sub-tree, ported from
//! `src/noise/expressions/nauvisShared.ts`.
//!
//! `nauvis_hills`, `nauvis_hills_cliff_level`, `nauvis_plateaus`,
//! `nauvis_bridge_billows`, `forest_path_billows`, and the domain-warped
//! `nauvis_hills_offset` / `nauvis_cliff_ringbreak` pair. Transcribed from
//! `core/prototypes/noise-programs.lua`.
//!
//! It lands first for the reason `vulcanus_helpers` did: `elevation_nauvis`,
//! `aux_nauvis`, `moisture_nauvis` and the cliff field all read it, so a
//! transcription error here would arrive blended into every one of those rather
//! than localised to one.
//!
//! ## The two warp seeds are hashed NAMES, and nothing downstream can tell
//!
//! `nauvis_hills_offset_raw_x` and `_raw_y` are `basis_noise` nodes whose
//! `seed1` the game supplies as the STRING `'nauvis_offset_x'` / `'nauvis_offset_y'`,
//! hashed with standard CRC32 - the same function `src/codec/crc32.ts`
//! implements. They are the only seeds in this port that come from a name.
//!
//! A wrong constant seeds a different permutation table, which produces a
//! perfectly plausible warp field rather than a visibly broken one, so no
//! residual-size check would flag it. Both are pinned by their own assertion in
//! `fixtures.rs` rather than trusted to be graded through the fields above them.
//!
//! ## `segmentation_multiplier` is scaled here, and only here
//!
//! `nauvis_segmentation_multiplier = 1.5 * control:water:frequency`. EVERY
//! noise sub-node below scales by THAT, never by the plain user value, so the
//! multiply lives in [`NauvisShared::new`] and callers pass the raw control.
//!
//! ## No `offset_x` reaches this layer
//!
//! `elevation_nauvis` carries an `offset_x = 10000 / nauvis_seg` on its own
//! `detail` and `persistance` terms. It is specific to those two nodes and must
//! not be routed in here - the TypeScript says so at the same place, because
//! adding it would shift five fields that are graded and three that are not.
//!
//! ## No memo, for the reason the Fulgora and Vulcanus layers record
//!
//! The TypeScript hands out closures and its consumers wrap them in `memoXY`,
//! because it builds a DAG of lazy nodes. This port hands out accessors and
//! lets each consumer evaluate the subset it needs into locals - which is what
//! the memo achieves, bit-identically and with no cache, because every read in
//! these chains is at the SAME `(x, y)`.
//!
//! The accessors are deliberately NOT collapsed into one `eval` returning every
//! field, the way the Vulcanus layers are. The three consumers read genuinely
//! different subsets - `aux_nauvis` needs only `plateaus`, the cliff field only
//! `cliff_ringbreak` - and a combined struct would evaluate four octave stacks
//! per point to hand back one number.

use crate::basis_noise::{basis_noise, tables_from_seed, BasisNoiseTables};
use crate::eval::math::clamp;
use crate::eval::primitives::{basis_noise_expr, BasisExprParams};
use crate::multioctave_noise::{MultioctaveParams, Prepared};
use crate::poison;

/// `basis_noise` `seed1` for `nauvis_hills_offset_raw_x`:
/// `crc32(utf8("nauvis_offset_x"))` = 0x2360_A1D4.
pub const NAUVIS_OFFSET_X_SEED1: u32 = 593_691_028;
/// `basis_noise` `seed1` for `nauvis_hills_offset_raw_y`:
/// `crc32(utf8("nauvis_offset_y"))` = 0x5460_AAC2.
pub const NAUVIS_OFFSET_Y_SEED1: u32 = 1_415_852_290;

/// `nauvis_hills_cliff_level`'s `basis_noise` seed.
const CLIFF_LEVEL_SEED1: u32 = 99_584;

/// How far the warp displaces the hills field, in world tiles.
const WARP_DISTANCE: f64 = 12.0;

/// Free variables of the shared layer.
pub struct NauvisSharedParams {
    /// Map seed (= `map_seed` / `seed0`).
    pub seed0: u32,
    /// `control:water:frequency`; 1 at the default.
    pub segmentation_multiplier: f64,
}

/// The shared Nauvis noise internals, with every table and octave stack derived
/// once.
pub struct NauvisShared {
    /// `1.5 * segmentation_multiplier` - the scale every sub-node below uses.
    pub nauvis_seg: f64,
    hills: Prepared,
    bridge_billows: Prepared,
    forest_path_billows: Prepared,
    cliff_level: BasisExprParams,
    cliff_level_tables: BasisNoiseTables,
    offset_x_tables: BasisNoiseTables,
    offset_y_tables: BasisNoiseTables,
    offset_input_scale: f64,
}

impl NauvisShared {
    #[must_use]
    pub fn new(params: &NauvisSharedParams) -> Self {
        let seed0 = params.seed0;
        let nauvis_seg = 1.5 * params.segmentation_multiplier;
        Self {
            nauvis_seg,
            hills: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 900,
                octaves: 4.0,
                persistence: 0.5,
                input_scale: nauvis_seg / 90.0,
                output_scale: 1.0,
            }),
            bridge_billows: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 700,
                octaves: 4.0,
                persistence: 0.5,
                input_scale: nauvis_seg / 150.0,
                output_scale: 1.0,
            }),
            forest_path_billows: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 1800,
                octaves: 4.0,
                persistence: 0.5,
                input_scale: nauvis_seg / 100.0,
                output_scale: 1.0,
            }),
            cliff_level: BasisExprParams {
                seed0,
                seed1: CLIFF_LEVEL_SEED1,
                input_scale: nauvis_seg / 500.0,
                output_scale: 0.6,
                offset_x: 0.0,
            },
            cliff_level_tables: tables_from_seed(seed0, CLIFF_LEVEL_SEED1),
            offset_x_tables: tables_from_seed(seed0, NAUVIS_OFFSET_X_SEED1),
            offset_y_tables: tables_from_seed(seed0, NAUVIS_OFFSET_Y_SEED1),
            offset_input_scale: nauvis_seg / 500.0,
        }
    }

    /// `nauvis_hills`: `abs` of the seed1 = 900 four-octave field.
    #[must_use]
    pub fn hills(&self, x: f64, y: f64) -> f64 {
        f64::from(self.hills.eval(x, y)).abs()
    }

    /// `nauvis_bridge_billows`: `abs` of the seed1 = 700 four-octave field.
    #[must_use]
    pub fn bridge_billows(&self, x: f64, y: f64) -> f64 {
        f64::from(self.bridge_billows.eval(x, y)).abs()
    }

    /// `forest_path_billows`: `abs` of the seed1 = 1800 four-octave field.
    #[must_use]
    pub fn forest_path_billows(&self, x: f64, y: f64) -> f64 {
        f64::from(self.forest_path_billows.eval(x, y)).abs()
    }

    /// `nauvis_hills_cliff_level`: a basis term clamped to `[0.15, 1.15]`.
    #[must_use]
    pub fn cliff_level(&self, x: f64, y: f64) -> f64 {
        clamp(
            0.65 + basis_noise_expr(x, y, &self.cliff_level, &self.cliff_level_tables),
            0.15,
            1.15,
        )
    }

    /// `nauvis_plateaus`: `0.5 + clamp((hills - cliff_level) * 10, -0.5, 0.5)`.
    #[must_use]
    pub fn plateaus(&self, x: f64, y: f64) -> f64 {
        0.5 + clamp(
            (self.hills(x, y) - self.cliff_level(x, y)) * 10.0,
            -0.5,
            0.5,
        )
    }

    /// `nauvis_hills_offset_raw_x`: bare `basis_noise` at `nauvis_seg / 500`.
    ///
    /// The coordinate products are f64, matching the TypeScript, which calls
    /// the raw primitive rather than the expression adapter here - so there is
    /// no `output_scale` and no narrowing of the products.
    #[must_use]
    pub fn hills_offset_raw_x(&self, x: f64, y: f64) -> f64 {
        f64::from(basis_noise(
            x * self.offset_input_scale,
            y * self.offset_input_scale,
            &self.offset_x_tables,
        ))
    }

    /// `nauvis_hills_offset_raw_y`.
    #[must_use]
    pub fn hills_offset_raw_y(&self, x: f64, y: f64) -> f64 {
        f64::from(basis_noise(
            x * self.offset_input_scale,
            y * self.offset_input_scale,
            &self.offset_y_tables,
        ))
    }

    /// `nauvis_hills_offset`: the seed1 = 900 field re-evaluated at a
    /// domain-warped coordinate.
    ///
    /// It re-evaluates the OCTAVE field at the warped point, not the abs-wrapped
    /// [`Self::hills`] - the TypeScript flags the same thing, because there the
    /// wrapper is memoized at the unwarped `(x, y)` and reusing it would return
    /// the wrong point's value.
    #[must_use]
    pub fn hills_offset(&self, x: f64, y: f64) -> f64 {
        let raw_x = self.hills_offset_raw_x(x, y);
        let raw_y = self.hills_offset_raw_y(x, y);
        let nx = normalize(raw_x, raw_y);
        let ny = normalize(raw_y, raw_x);
        f64::from(
            self.hills
                .eval(x + WARP_DISTANCE * nx, y + WARP_DISTANCE * ny),
        )
        .abs()
    }

    /// `nauvis_cliff_ringbreak`: `abs(hills - hills_offset)`, the
    /// `base_cliffiness` input.
    ///
    /// This is the layer's poison hook, and it is a BACKSTOP rather than the
    /// control the tier-1 test actually trips. That was measured rather than
    /// claimed: with this `poison::f64_result` deleted,
    /// `reproduces_the_nauvis_cliff_offset_chain_at_every_captured_position`
    /// still goes red under `--features poison`, at 5 of 30 on `raw_x` - so
    /// `basis_noise`'s own hook reaches every field in this layer, because
    /// every field in this layer composes it.
    ///
    /// It is kept because it costs nothing and every other expression layer in
    /// the port carries one, but nobody should read its presence as evidence
    /// that this layer's own arithmetic - the warp and the difference - has an
    /// independent control. It does not, and no test in the crate could give it
    /// one: there is no path to `cliff_ringbreak` that avoids `basis_noise`.
    #[must_use]
    pub fn cliff_ringbreak(&self, x: f64, y: f64) -> f64 {
        poison::f64_result((self.hills(x, y) - self.hills_offset(x, y)).abs())
    }
}

/// `normalize(primary, secondary)` from `noise-programs.lua`, with the
/// program's `bias = 0.001`.
///
/// `primary / sqrt(bias + primary^2 + secondary^2)`. The bias is what keeps it
/// finite where both inputs are zero, so it is not a tolerance and must not be
/// dropped.
fn normalize(a: f64, b: f64) -> f64 {
    a / (0.001 + a * a + b * b).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_the_segmentation_multiplier_by_one_and_a_half() {
        let one = NauvisShared::new(&NauvisSharedParams {
            seed0: 123_456,
            segmentation_multiplier: 1.0,
        });
        assert_eq!(one.nauvis_seg, 1.5);
        let two = NauvisShared::new(&NauvisSharedParams {
            seed0: 123_456,
            segmentation_multiplier: 2.0,
        });
        assert_eq!(two.nauvis_seg, 3.0);
    }

    #[test]
    fn clamps_cliff_level_and_plateaus_to_their_stated_ranges() {
        // The clamps are what make `plateaus` a plateau rather than a ramp, and
        // both saturate over most of the map - so a dropped clamp would change
        // the field almost everywhere while still looking like noise.
        let shared = NauvisShared::new(&NauvisSharedParams {
            seed0: 123_456,
            segmentation_multiplier: 1.0,
        });
        let mut saturated = 0usize;
        for i in -20i32..20 {
            for j in -20i32..20 {
                let (x, y) = (f64::from(i) * 37.0, f64::from(j) * 41.0);
                let level = shared.cliff_level(x, y);
                assert!(
                    (0.15..=1.15).contains(&level),
                    "cliff_level {level} at ({x},{y})"
                );
                let p = shared.plateaus(x, y);
                assert!((0.0..=1.0).contains(&p), "plateaus {p} at ({x},{y})");
                if p == 0.0 || p == 1.0 {
                    saturated += 1;
                }
            }
        }
        // Anti-vacuity: a range assertion over a field that never approaches
        // its bounds asserts nothing. Most of this grid saturates.
        assert!(saturated > 1200, "only {saturated} of 1600 points saturate");
    }

    #[test]
    fn normalize_stays_finite_where_both_inputs_vanish() {
        // The `0.001` bias is the only thing standing between this and 0/0.
        assert_eq!(normalize(0.0, 0.0), 0.0);
        assert!(normalize(1e-300, 1e-300).is_finite());
    }

    #[test]
    fn the_warp_moves_the_hills_field_everywhere_except_its_fixed_point() {
        // `hills_offset` differing from `hills` is what makes `cliff_ringbreak`
        // anything other than identically zero, so it is asserted rather than
        // assumed: a warp wired to the unwarped coordinate would leave every
        // ringbreak at 0 and still pass every range check above.
        let shared = NauvisShared::new(&NauvisSharedParams {
            seed0: 123_456,
            segmentation_multiplier: 1.0,
        });
        let mut nonzero = 0usize;
        for i in 1i32..64 {
            let (x, y) = (f64::from(i) * 13.0, f64::from(i) * -7.0);
            if shared.cliff_ringbreak(x, y) > 0.0 {
                nonzero += 1;
            }
        }
        assert_eq!(
            nonzero, 63,
            "the ringbreak is zero somewhere it should not be"
        );
    }

    #[test]
    fn the_origin_is_a_fixed_point_of_the_warp() {
        // `basis_noise` returns exactly 0 at a lattice corner, and (0, 0) is one
        // for both warp fields - so `normalize(0, 0)` is 0, the displacement is
        // 0, and `cliff_ringbreak(0, 0)` is exactly 0. That is the expression
        // behaving correctly, not a degenerate port, and the loop above starts
        // at 1 because of it.
        //
        // Pinned because it is the one input where a warp wired to the WRONG
        // coordinate would still agree with the right one, so anybody reading a
        // zero here should find out it is expected rather than debug it.
        let shared = NauvisShared::new(&NauvisSharedParams {
            seed0: 123_456,
            segmentation_multiplier: 1.0,
        });
        assert_eq!(shared.hills_offset_raw_x(0.0, 0.0), 0.0);
        assert_eq!(shared.hills_offset_raw_y(0.0, 0.0), 0.0);
        assert_eq!(shared.hills_offset(0.0, 0.0), shared.hills(0.0, 0.0));
        assert_eq!(shared.cliff_ringbreak(0.0, 0.0), 0.0);
    }
}
