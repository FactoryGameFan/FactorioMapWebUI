//! Fulgora's shared layer, ported from
//! `src/noise/expressions/fulgoraShared.ts`.
//!
//! The Voronoi grid constant, the wobble fields that distort the grid's input
//! coordinates, the offset and distorted coordinates the cell layer samples at,
//! and the two starting cones that carve out spawn. Transcribed from
//! `space-age/prototypes/planet/planet-fulgora-map-gen.lua` lines 22-124, which
//! is byte-identical 2.1.12 -> 2.1.14.
//!
//! ## No memo, because the whole chain is evaluated at one point
//!
//! The TypeScript wraps every field in `memoXY`, and it has to: it builds a DAG
//! of lazy closures, and `wobbleX` alone is read by `wx`, by both starting
//! cones, and - through `wobbleMask` - by `wy`, so an unmemoized read would run
//! its four octaves several times per pixel.
//!
//! This port evaluates the whole chain top to bottom in one pass and keeps the
//! intermediates in locals. That is what the memo achieves, with no cache, no
//! `&mut` plumbing and no borrow dance - and it is bit-identical, because a memo
//! hit returns the value the function computed rather than recomputing it.
//! Every read in this layer is at the SAME `(x, y)` as the point being
//! evaluated, checked field by field, which is what makes the substitution
//! legitimate; a field that read a neighbour would need the cache back.

use crate::basis_noise::{tables_from_seed, BasisNoiseTables};
use crate::eval::math::{clamp, slider_to_linear};
use crate::expressions::starting_spot_at_angle::{starting_spot_at_angle, AngleTrig, StartingSpot};
use crate::multioctave_noise::{octave_terms, sum_octaves, MultioctaveParams, OctaveTerms};
use crate::poison;

/// `seed1` for `fulgora_wobble_x`: `crc32(utf8("fulgora_wobble_x"))`.
///
/// The game hashes a string `seed1` with a standard CRC32. Resolved once and
/// written down rather than computed, the way the TypeScript does it - and
/// **computed, never guessed**: a wrong seed produces a perfectly plausible map
/// that no residual-size check would flag, because it is a different noise
/// field rather than a slightly wrong one.
const SEED1_WOBBLE_X: u32 = 686_434_221; // 0x28EA27AD
/// `crc32(utf8("fulgora_wobble_y"))`.
const SEED1_WOBBLE_Y: u32 = 1_609_373_499; // 0x5FED173B

/// The free variables Fulgora's shared layer reads.
///
/// `seed0` is `map_seed` as the noise program sees it - the FULGORA SURFACE
/// seed, not the user's map seed. Derive it with `surface_seed_for_planet`
/// before constructing. Getting this wrong scores 0.5% overlap against the
/// preview PNGs where the right one scores 99.9%, and nothing about the wrong
/// run announces itself as a seed problem.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FulgoraCtx {
    pub seed0: u32,
    /// `control:fulgora_islands:frequency` (wire value). Neutral is 1.
    pub islands_frequency: f64,
    /// `control:fulgora_islands:size` (wire value). Neutral is 1.
    pub islands_size: f64,
}

impl FulgoraCtx {
    /// Neutral sliders at a given surface seed.
    #[must_use]
    pub fn new(seed0: u32) -> Self {
        Self {
            seed0,
            islands_frequency: 1.0,
            islands_size: 1.0,
        }
    }
}

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SharedFields {
    pub wobble_influence: f64,
    pub wobble_mask: f64,
    pub wobble_x: f64,
    pub wobble_y: f64,
    pub ox: f64,
    pub oy: f64,
    pub wx: f64,
    pub wy: f64,
    pub starting_cone: f64,
    pub starting_vault_cone: f64,
    pub starting_mask: f64,
    pub starting_vault_mask: f64,
}

/// One multioctave call with its seed tables and octave terms already derived.
///
/// **This is the shape every renderer needs, and its absence was a measured
/// bug.** `multioctave_noise(x, y, &params)` re-derives both on every call, and
/// `tables_from_seed` runs a PRNG over three 256-byte tables; Fulgora's chain
/// makes eight such calls per pixel. Building them per point measured **1.15x**
/// against the TypeScript, which builds them once in a closure. Hoisting is
/// what the ratio in phase 3's pull request is.
///
/// Results are identical either way, so nothing in tiers 1 to 3 could see it.
///
/// No `Debug` or `Clone`: `OctaveTerms` has neither, and deriving them here
/// would mean giving them to derived state whose shape is an implementation
/// detail.
pub struct Prepared {
    terms: OctaveTerms,
    tables: BasisNoiseTables,
}

impl Prepared {
    #[must_use]
    pub fn new(params: &MultioctaveParams) -> Self {
        Self {
            terms: octave_terms(params),
            tables: tables_from_seed(params.seed0, params.seed1),
        }
    }

    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f32 {
        sum_octaves(x, y, &self.terms, &self.tables)
    }
}

/// The per-render constants of Fulgora's shared layer.
pub struct FulgoraShared {
    /// `fulgora_grid` - the Voronoi cell size in tiles.
    ///
    /// **A program CONSTANT, not a field**: it depends only on the islands
    /// frequency slider. Held as the f64 widening of an f32 value, because the
    /// TypeScript writes `Math.fround(175 - sliderToLinear(...))`. That
    /// narrowing matters more than its size suggests - `grid` is the
    /// denominator of every input scale below, so an un-narrowed grid would
    /// push a small error into every noise field at once.
    pub grid: f64,
    wobble_influence: Prepared,
    wobble_x: Prepared,
    wobble_y: Prepared,
    /// The wide disc of `fulgora_starting_cone`.
    starting_wide: StartingSpot,
    /// The tight disc of `fulgora_starting_cone`, whose distortion is damped.
    starting_tight: StartingSpot,
    /// `fulgora_starting_vault_cone`, placed opposite the starting cone.
    starting_vault: StartingSpot,
}

impl FulgoraShared {
    /// Build the layer, taking the two bearings' trig from the caller.
    ///
    /// `starting_trig` is the sine and cosine of `seed0 / 360` degrees, and
    /// `vault_trig` of that plus 180. They are inputs rather than computed here
    /// for the reason
    /// [`starting_spot_at_angle`](crate::expressions::starting_spot_at_angle)
    /// documents at length: a runtime `sin` is the one thing the determinism
    /// policy forbids, and the angle is a per-render constant so nothing is
    /// lost by lifting it out.
    ///
    /// [`FulgoraShared::with_host_trig`] computes them with Rust's own libm,
    /// for tests.
    #[must_use]
    pub fn new(ctx: &FulgoraCtx, starting_trig: AngleTrig, vault_trig: AngleTrig) -> Self {
        let seed0 = ctx.seed0;

        // "175 - slider_to_linear(control:fulgora_islands:frequency, -50, 50)".
        // A higher frequency slider subtracts more, shrinking the cell - more
        // islands, which is the direction the control's name implies.
        let grid = f64::from(
            (175.0 - f64::from(slider_to_linear(ctx.islands_frequency, -50.0, 50.0))) as f32,
        );

        // The three multioctave calls, verbatim from the Lua. The two wobble
        // fields differ ONLY in their string seed1, so they are independent
        // noise at identical parameters - the x/y asymmetry comes from the seed
        // and nothing else.
        let wobble_influence = MultioctaveParams {
            seed0,
            seed1: 1,
            octaves: 3.0,
            persistence: 0.5,
            input_scale: 128.0 / grid / 20.0,
            output_scale: 3.0,
        };
        let wobble_common = |seed1: u32| MultioctaveParams {
            seed0,
            seed1,
            octaves: 4.0,
            persistence: 0.7,
            input_scale: 5.0 / grid,
            output_scale: grid * 0.07,
        };

        Self {
            grid,
            wobble_influence: Prepared::new(&wobble_influence),
            wobble_x: Prepared::new(&wobble_common(SEED1_WOBBLE_X)),
            wobble_y: Prepared::new(&wobble_common(SEED1_WOBBLE_Y)),
            // The wide disc is offset a little way out; the tight one sits at
            // distance 1 with its distortion damped to a quarter, which is what
            // keeps the very centre of spawn solid when the wobble runs at full
            // strength.
            starting_wide: StartingSpot {
                trig: starting_trig,
                distance: f64::from((grid / 30.0) as f32),
                radius: f64::from((grid / 1.8) as f32),
            },
            starting_tight: StartingSpot {
                trig: starting_trig,
                distance: 1.0,
                radius: f64::from((grid / 4.0) as f32),
            },
            starting_vault: StartingSpot {
                trig: vault_trig,
                distance: f64::from((grid / 1.8) as f32),
                radius: f64::from((grid / 1.8) as f32),
            },
        }
    }

    /// As [`FulgoraShared::new`], but computing both bearings with Rust's libm.
    ///
    /// For tier-1 tests and for anything that is not the shipped engine. The
    /// bearing is `seed0 / 360` degrees, and the vault sits opposite it.
    #[must_use]
    pub fn with_host_trig(ctx: &FulgoraCtx) -> Self {
        // f32 at both points, mirroring `const angle = f32(seed0 / 360)` and
        // `angle: f32(angle + 180)` in `fulgoraShared.ts` (#279).
        let angle = f64::from((f64::from(ctx.seed0) / 360.0) as f32);
        Self::new(
            ctx,
            AngleTrig::from_degrees(angle),
            AngleTrig::from_degrees(f64::from((angle + 180.0) as f32)),
        )
    }

    /// Evaluate every field of this layer at one position.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> SharedFields {
        let wobble_influence = f64::from(self.wobble_influence.eval(x, y));
        let wobble_x = f64::from(self.wobble_x.eval(x, y));
        let wobble_y = f64::from(self.wobble_y.eval(x, y));

        // "We usually want a lot of wobble or none at all, so influence has a
        // high output scale and then we clamp it." The +0.6 biases most of the
        // map to fully on rather than centring the mask.
        //
        // `0.6f32` is case 2 from the `eval` module docs - the engine holds the
        // literal as 0.60000002384185791016 and the f64 one is
        // 0.59999999999999997780. 96/101 exact before, **101/101 at a residual
        // of exactly 0** after, and it is what takes `wx`, `wy`,
        // `fulgora_basis`, `fulgora_pyramids` and `fulgora_pyramids_banding` to
        // 101/101 as well. See #273.
        let wobble_mask = clamp(wobble_influence + f64::from(0.6f32), 0.0, 1.0);

        // Offset the grid by half a cell so spawn sits in the MIDDLE of a cell
        // rather than on a corner where four islands meet.
        let ox = x + self.grid / 2.0;
        let oy = y + self.grid / 2.0;

        let wx = ox + wobble_x * wobble_mask;
        let wy = oy + wobble_y * wobble_mask;

        let wide = starting_spot_at_angle(&self.starting_wide, x, y, wobble_x, wobble_y);
        let tight =
            starting_spot_at_angle(&self.starting_tight, x, y, 0.25 * wobble_x, 0.25 * wobble_y);
        let starting_cone = crate::eval::math::max(&[0.0, wide, tight]);

        let starting_vault_cone = crate::eval::math::max(&[
            0.0,
            starting_spot_at_angle(&self.starting_vault, x, y, wobble_x, wobble_y),
        ]);

        // Complementary comparisons of the same pair, so exactly one can be 1
        // where the cones differ, and both are 0 where they are equal - which
        // is everywhere both clamp to 0, i.e. most of the map.
        let starting_mask = f64::from(u8::from(starting_cone - starting_vault_cone > 0.0));
        let starting_vault_mask = f64::from(u8::from(starting_vault_cone - starting_cone > 0.0));

        SharedFields {
            wobble_influence: poison::f64_result(wobble_influence),
            wobble_mask,
            wobble_x,
            wobble_y,
            ox,
            oy,
            wx,
            wy,
            starting_cone,
            starting_vault_cone,
            starting_mask,
            starting_vault_mask,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default slider puts the grid at exactly 175, which is the value the
    /// oracle fixture carries at every position.
    #[test]
    fn the_default_grid_is_exactly_175() {
        let shared = FulgoraShared::with_host_trig(&FulgoraCtx::new(123_456));
        assert_eq!(shared.grid, 175.0);
    }

    /// The frequency slider shrinks the cell, which is the direction the
    /// control's name implies. A sign error here is invisible in a residual.
    #[test]
    fn a_higher_frequency_slider_shrinks_the_grid() {
        let ctx = |f: f64| FulgoraCtx {
            seed0: 123_456,
            islands_frequency: f,
            islands_size: 1.0,
        };
        let low = FulgoraShared::with_host_trig(&ctx(0.5)).grid;
        let high = FulgoraShared::with_host_trig(&ctx(2.0)).grid;
        assert!(high < 175.0 && low > 175.0, "low={low} high={high}");
    }

    /// The two masks cannot both be 1, and are both 0 where the cones agree.
    #[test]
    fn the_two_starting_masks_are_mutually_exclusive() {
        let shared = FulgoraShared::with_host_trig(&FulgoraCtx::new(123_456));
        for k in 0..200 {
            let (x, y) = (f64::from(k) * 7.5 - 400.0, f64::from(k) * -3.25 + 120.0);
            let f = shared.eval(x, y);
            assert!(f.starting_mask + f.starting_vault_mask <= 1.0);
        }
    }

    /// The offsets are half a cell on BOTH axes, and each reads only its own
    /// coordinate. A copy-paste that read `x` twice shows here.
    #[test]
    fn the_offsets_are_half_a_cell_on_each_axis() {
        let shared = FulgoraShared::with_host_trig(&FulgoraCtx::new(123_456));
        let f = shared.eval(10.0, -20.0);
        assert_eq!(f.ox, 10.0 + 175.0 / 2.0);
        assert_eq!(f.oy, -20.0 + 175.0 / 2.0);
    }
}
