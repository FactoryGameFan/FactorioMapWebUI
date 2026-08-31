//! The two cliff fields for Vulcanus, ported from
//! `src/noise/cliffs/vulcanusCliffFields.ts`.
//!
//! Vulcanus does not reuse Nauvis's cliff expressions. `planet-map-gen.lua:13`
//! overrides both properties:
//!
//! ```lua
//! cliffiness      = "cliffiness_basic",
//! cliff_elevation = "cliff_elevation_from_elevation",   -- = "elevation"
//! cliff_settings  = { name = "cliff-vulcanus",
//!                     cliff_elevation_interval = 120,
//!                     cliff_elevation_0 = 70 }
//! ```
//!
//! so this port is much smaller than the Nauvis one will be: `cliff_elevation`
//! is the planet's own elevation, and `cliffiness_basic` is a single clamp over
//! a 2-octave `quick_multioctave_noise`. None of the Nauvis hills / ringbreak /
//! billows machinery is involved.
//!
//! **There are no Vulcanus cliff sliders.**
//! `space-age/prototypes/autoplace-controls.lua` defines `gleba_cliff` and
//! `fulgora_cliff` but no Vulcanus equivalent, and the planet's
//! `autoplace_controls` list has no cliff entry - so frequency and continuity
//! are fixed at 1 and `cliff_richness` is fixed at 1. The interval and
//! elevation-0 below are planet constants for the same reason: they come from
//! the planet definition, not from the user's preset, which describes a Nauvis
//! surface.

use crate::cliffs::placement::{CliffFields, TileCollision};
use crate::eval::math::{log2, max2, min2};
use crate::expressions::vulcanus_stack::VulcanusStack;
use crate::poison;
use crate::quick_multioctave_noise::{
    octave_terms, sum_octaves, QuickMultioctaveParams, QuickOctaves,
};

/// `cliff_elevation_0` from `planet_map_gen.vulcanus()`'s `cliff_settings`.
pub const VULCANUS_CLIFF_ELEVATION_0: f64 = 70.0;

/// `cliff_elevation_interval` from the same `cliff_settings`.
pub const VULCANUS_CLIFF_ELEVATION_INTERVAL: f64 = 120.0;

/// `cliff_smoothing` on Vulcanus - **1, and it is load-bearing.**
///
/// Vulcanus's `cliff_settings` sets only `name`, `cliff_elevation_interval` and
/// `cliff_elevation_0`, so smoothing takes the `CliffPlacementSettings`
/// prototype default of `1` (full smoothing), not 0. Vulcanus is the odd planet
/// out: Nauvis, Fulgora and Gleba all set `cliff_smoothing = 0` explicitly,
/// Fulgora with the comment "This is critical for correct cliff placement."
///
/// The prototype docs say smoothing "makes cliffs straighter on rough elevation
/// but makes placement inaccurate", and that is exactly what it did: left at
/// Nauvis's 0, Vulcanus reproduced 57-69% of real cliffs while placing 1.1-1.6x
/// too many (#18).
pub const VULCANUS_CLIFF_SMOOTHING: f64 = 1.0;

/// `cliff_richness` on Vulcanus: `getModifiedRichness(richness, size)` with no
/// cliff autoplace control to move either lever, so it is pinned at 1 and the
/// `0.5 * log2(cliff_richness)` term of `cliffiness_basic` vanishes.
///
/// Kept as a named constant rather than folded away so the expression still
/// reads like the Lua it ports - and so the one place a `log2` enters this
/// layer stays visible. See [`CliffinessBasic::new`] for why that matters.
pub const VULCANUS_CLIFF_RICHNESS: f64 = 1.0;

/// `seed1` of `cliffiness_basic`'s `quick_multioctave_noise` call.
pub const CLIFFINESS_BASIC_SEED1: u32 = 123;

/// `cliffiness_basic` (`core/prototypes/noise-programs.lua:310`):
///
/// ```text
/// clamp(0.5 * log2(cliff_richness) +
///       quick_multioctave_noise{x = x, y = y, seed0 = map_seed, seed1 = 123,
///                               input_scale = 1/32, output_scale = 1, octaves = 2,
///                               octave_output_scale_multiplier = 1,
///                               octave_input_scale_multiplier = 1/3},
///       0, 1) + 0.5
/// ```
///
/// Range `[0.5, 1.5]`. That matters for the placement gate: `crosses_cliff`
/// compares the AVERAGE of two corners' cliffiness against `0.5`, so on Vulcanus
/// an edge is cliffy whenever the clamp is above zero at either corner - a
/// continuous field, unlike Nauvis's `cliffiness_nauvis`, which is a hard 0-or-10
/// gate. Same comparison, different shape of input.
pub struct CliffinessBasic {
    richness_term: f64,
    octaves: QuickOctaves,
}

impl CliffinessBasic {
    /// Prepare the field for one seed.
    ///
    /// **The octave terms are hoisted, and that is not an optimisation to take
    /// or leave.** `octave_terms` runs a PRNG over three 256-byte permutation
    /// tables per octave; rebuilding them per call is what cost
    /// `multioctave_noise` 20x before it was measured. Cliffiness is evaluated
    /// at every corner of every chunk the query touches and dominates the
    /// placement pass, so it is the worst place in this layer to rebuild.
    ///
    /// **The `log2` is evaluated here, once, and only because Vulcanus pins its
    /// argument at 1.** A transcendental inside the module is the #270 hazard:
    /// the libm `wasm32-unknown-unknown` links is not V8's, and only a tier-2
    /// sweep can see the difference. `log2(1)` is exactly 0 on any conforming
    /// libm, so there is nothing to disagree about - and
    /// [`tests::the_richness_term_is_exactly_zero_at_vulcanuss_pinned_richness`]
    /// pins that rather than leaving it as an argument. A planet that ever moves
    /// this lever must send the term across the ABI the way the bearings' trig
    /// is sent, not compute it here.
    #[must_use]
    pub fn new(seed0: u32, cliff_richness: f64) -> Self {
        Self {
            richness_term: 0.5 * log2(cliff_richness),
            octaves: octave_terms(&QuickMultioctaveParams {
                seed0,
                seed1: CLIFFINESS_BASIC_SEED1,
                octaves: 2,
                input_scale: 1.0 / 32.0,
                output_scale: 1.0,
                octave_output_scale_multiplier: 1.0,
                octave_input_scale_multiplier: 1.0 / 3.0,
                offset_x: 0.0,
            }),
        }
    }

    /// Vulcanus's own richness, which is the only one that exists today.
    #[must_use]
    pub fn for_vulcanus(seed0: u32) -> Self {
        Self::new(seed0, VULCANUS_CLIFF_RICHNESS)
    }

    /// Evaluate the field.
    ///
    /// `min2`/`max2` rather than `f64::min`/`f64::max`, in the TypeScript's own
    /// argument order: the two disagree on NaN and on signed zero, and only an
    /// order-sensitive raw-bits fold can see it.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f64 {
        let n = f64::from(sum_octaves(x, y, &self.octaves));
        poison::f64_result(min2(1.0, max2(0.0, self.richness_term + n)) + 0.5)
    }
}

/// Both fields the placement pass needs, for one Vulcanus stack.
///
/// `cliff_elevation` is `vulcanus_elevation` itself (`max(-500, vulcanus_elev)`),
/// which is what `cliff_elevation_from_elevation` resolves to once the planet
/// has routed the `elevation` property at `vulcanus_elevation`.
pub struct VulcanusCliffFields<'a, 'b> {
    stack: &'a VulcanusStack<'b>,
    cliffiness: CliffinessBasic,
}

impl<'a, 'b> VulcanusCliffFields<'a, 'b> {
    #[must_use]
    pub fn new(stack: &'a VulcanusStack<'b>, seed0: u32) -> Self {
        Self {
            stack,
            cliffiness: CliffinessBasic::for_vulcanus(seed0),
        }
    }
}

impl CliffFields for VulcanusCliffFields<'_, '_> {
    /// **`cliff_elevation`, not `elevation`** - the cliff generator and the tile
    /// generator read genuinely different fields.
    ///
    /// `multisample`'s offsets are in the consuming noise program's GRID UNITS,
    /// and the cliff generator walks the 4-tile corner lattice while every
    /// per-tile consumer walks 1, so `vulcanus_basalt_lakes_multisample`'s 2x2
    /// min-filter spans 4 tiles here and 1 there. Using the per-tile field made
    /// the cliff elevation too rough and was issue #18's root cause (#83).
    fn cliff_elevation(&self, x: f64, y: f64) -> f64 {
        self.stack.cliff_elevation(x, y)
    }

    fn cliffiness(&self, x: f64, y: f64) -> f64 {
        self.cliffiness.eval(x, y)
    }
}

/// The Vulcanus tiles whose `CollisionMask` shares a layer with the cliff's, so
/// a cliff whose collision box touches one is never placed.
///
/// **Which tiles those are is not a rule of its own.** It is
/// [`VulcanusTile::is_cliff_blocking`](crate::tiles::vulcanus_catalog::VulcanusTile::is_cliff_blocking),
/// which is also where the measurement behind the set is written down. This
/// used to inline `Lava | LavaHot` and restate that measurement in its own
/// words, one of four copies (#364).
///
/// It resolves the tile through the ported argmax rather than reading back a
/// rendered pixel, and that is load-bearing for tiled rendering: the collision
/// box reaches tiles outside the render window, so reading pixels would make
/// the answer depend on the window.
pub struct VulcanusLavaTiles<'a, 'b> {
    stack: &'a VulcanusStack<'b>,
}

impl<'a, 'b> VulcanusLavaTiles<'a, 'b> {
    #[must_use]
    pub fn new(stack: &'a VulcanusStack<'b>) -> Self {
        Self { stack }
    }
}

impl TileCollision for VulcanusLavaTiles<'_, '_> {
    fn collides(&self, x: i64, y: i64) -> bool {
        #[allow(clippy::cast_precision_loss)]
        let tile = self.stack.tile(x as f64, y as f64);
        tile.is_cliff_blocking()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one `log2` in this layer is inert at Vulcanus's pinned richness, so
    /// no libm disagreement can reach the field. Asserted rather than argued.
    #[test]
    fn the_richness_term_is_exactly_zero_at_vulcanuss_pinned_richness() {
        let f = CliffinessBasic::new(123_456, VULCANUS_CLIFF_RICHNESS);
        assert_eq!(f.richness_term.to_bits(), 0.0f64.to_bits());
    }

    /// The clamp puts the field on `[0.5, 1.5]`, which is what makes the
    /// placement gate's `> 0.5` comparison mean "the clamp cleared zero".
    #[test]
    fn the_field_stays_inside_the_half_to_one_and_a_half_band() {
        let f = CliffinessBasic::for_vulcanus(123_456);
        let mut saw_below_one = false;
        let mut saw_above_one = false;
        for i in 0..400 {
            let x = f64::from(i) * 7.0 - 1400.0;
            let v = f.eval(x, x * 0.5 - 300.0);
            assert!(
                (0.5..=1.5).contains(&v),
                "cliffiness {v} at x={x} left the band"
            );
            if v < 1.0 {
                saw_below_one = true;
            } else {
                saw_above_one = true;
            }
        }
        // Without both halves the bound above would pass on a constant field.
        assert!(saw_below_one && saw_above_one, "the field did not vary");
    }
}
