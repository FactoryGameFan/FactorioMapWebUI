//! The noise DSL's math operators, ported from `src/noise/eval/math.ts`.
//!
//! These exist so a hand-ported named expression reads 1:1 with the Lua -
//! `min(a, b, c)`, `clamp(x, lo, hi)` - rather than being rewritten into Rust
//! idiom at the same time as it is ported. A port that also refactors is two
//! changes graded by one fixture.
//!
//! ## `sin` and `cos` are NOT ported here, and that is deliberate
//!
//! The TypeScript exports them as plain `Math.sin`/`Math.cos`. They are read by
//! `starting_spot_at_angle`, `spot_at_angle` and `rotate_x`/`rotate_y`, none of
//! which land before phase 5 (#225). Porting them now would mean shipping a
//! transcendental with **no fixture in this phase's gate to grade it against**,
//! and the determinism policy (spec section 5) says trig must be committed
//! constants or a compiled polynomial, never a runtime `sin`/`cos` - WebAssembly
//! has neither, and V8 and libm disagree in the last bit.
//!
//! `starting_lakes` already carries the shape that answer takes: a minimax
//! polynomial transcribed from the game's own inlined approximation, with the
//! coefficients written as `f64::from_bits` so a decimal round-trip cannot move
//! them. Do the same when the consumer arrives, against that consumer's fixture.
//!
//! ## `log2` and `2^x` ARE ported, and the residual risk is stated
//!
//! `slider_to_linear` and `slider_rescale` need both. Unlike the noise machine's
//! `^`, they resolve on the PROTOTYPE side - Lua, not the noise VM - so they use
//! exact math rather than `fast_approx`, which is measured rather than assumed:
//! fastapprox misses 6 of the 7 probe points, including breaking the exact `1`
//! at the default slider.
//!
//! So this module calls `f64::log2` and `f64::powf`, which reach libm - the same
//! class of function the game itself reaches from Lua. **What is graded is 7
//! probe points and a tier-2 sweep, not every input.**
//!
//! **That risk was OBSERVED, and the f32 narrowing is what contains it** (#270,
//! measured 2026-08-19). Sweeping 600 slider positions through the WASM module:
//! both per-operation forms agree with V8 600/600, and a third form that
//! evaluated the whole chain in f64 and rounded ONCE agreed only 599/600 - one
//! position each at `s = 3.5435` (n = 2) and `s = 6.3657` (n = 3). Native Rust
//! matched V8 at both, same 64 bits, so the divergence belonged to the
//! `wasm32-unknown-unknown` libm rather than to this source.
//!
//! Two consequences worth keeping separate. `cargo test` runs on the HOST libm
//! and cannot see this class of bug at all, so only a spec that instantiates the
//! WASM can find it. And the per-operation forms survive **because** they
//! narrow: one f64 ULP is about 29 bits below what an f32 narrowing keeps. The
//! un-narrowed form had nothing to absorb it - and the oracle says it also
//! disagreed with the game - so it was deleted rather than worked around.
//! Anything new here that reaches a transcendental needs a tier-2 sweep, not
//! just a fixture.

use crate::poison;

/// Ratio of a circle's circumference to its diameter (the DSL's `pi`).
pub const PI: f64 = std::f64::consts::PI;

/// Clamp `v` into `[lo, hi]`.
///
/// Written as the TypeScript's two comparisons rather than `f64::clamp`,
/// because they differ on NaN: `f64::clamp` panics when `lo > hi` and this
/// returns `v` unchanged for a NaN `v`, exactly as `v < lo ? lo : v > hi ? hi
/// : v` does in JavaScript.
#[must_use]
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Linear interpolate: `a` at `t = 0`, `b` at `t = 1`.
///
/// **`lerp(a, b, 1.0)` is NOT exactly `b`**, and code downstream has been
/// written on the assumption that it is. The form is `a + (b - a) * t`, so at
/// `t = 1` it is `a + (b - a)` - two roundings, not zero. Measured on Fulgora:
/// `fulgora_mix_oil` is `lerp(s, min(-0.01, ...), oil_mask)`, and inside the
/// mask (`oil_mask == 1`) it returns `-0.009999999999999995` rather than the
/// `-0.01` the `min` appears to guarantee.
///
/// That is faithful - the TypeScript has the same form and lands on the same
/// number - so do NOT "fix" it to `if t == 1.0 { b }`. It would change the
/// output of every field that lerps to a bound.
#[must_use]
pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// [`lerp`] with per-operation f32 rounding, for expressions the noise machine
/// evaluates one operation at a time.
///
/// **Same FORM, three roundings instead of none.** It is still `a + (b - a) * t`,
/// so `lerp_f32(a, b, 1.0)` is still not exactly `b` - that is the game's own
/// shape and must not be "fixed" to `if t == 1.0 { b }`. See [`lerp`].
///
/// Both of Fulgora's lerps read this (`fulgora_mix_moats` and `fulgora_mix_oil`).
/// Mirrors `lerpF32` in `src/noise/eval/math.ts`; keep the two in step.
#[must_use]
pub fn lerp_f32(a: f64, b: f64, t: f64) -> f64 {
    f64::from((a + f64::from((f64::from((b - a) as f32) * t) as f32)) as f32)
}

/// Variadic `min(...)`, with JavaScript's `Math.min` semantics.
///
/// **NaN poisons the result and `Rust`'s `f64::min` does not**, which is the
/// whole reason this is written out. `f64::min` returns the non-NaN operand, so
/// a NaN field value would silently vanish into a neighbour's number instead of
/// propagating. An empty slice gives `+Infinity`, again as `Math.min()` does.
///
/// The signed-zero case is handled too: `Math.min(0, -0)` is `-0`, and a plain
/// `<` comparison keeps `+0` because the two compare equal.
#[must_use]
pub fn min(xs: &[f64]) -> f64 {
    let mut acc = f64::INFINITY;
    for &x in xs {
        if x.is_nan() {
            return f64::NAN;
        }
        if x < acc || (x == 0.0 && acc == 0.0 && x.is_sign_negative()) {
            acc = x;
        }
    }
    acc
}

/// Variadic `max(...)`, with JavaScript's `Math.max` semantics. See [`min`].
///
/// `Math.max(-0, 0)` is `+0`, which is the mirror of the signed-zero case
/// there.
#[must_use]
pub fn max(xs: &[f64]) -> f64 {
    let mut acc = f64::NEG_INFINITY;
    for &x in xs {
        if x.is_nan() {
            return f64::NAN;
        }
        if x > acc || (x == 0.0 && acc == 0.0 && acc.is_sign_negative()) {
            acc = x;
        }
    }
    acc
}

/// Two-argument `Math.min`, the form almost every ported expression uses.
///
/// **NOT `f64::min`.** The two differ in two ways that a raw-bits comparison
/// can see and a tolerance cannot:
///
/// - NaN. `f64::min` returns the non-NaN operand; `Math.min` propagates.
/// - **Signed zero.** `Math.min(+0, -0)` is `-0`, and `f64::min` follows IEEE
///   754-2019 `minimumNumber`, whose result for two operands that compare equal
///   is explicitly *either input, non-deterministically*.
///
/// That second one is not theoretical. It was measured on 2026-08-19: Fulgora's
/// `tile_ruin_paving` folded to a different checksum than the TypeScript in
/// tier 2, because both of its `max` arms were zero with different signs. Every
/// `min`/`max` in the ported expressions goes through these, and the ARGUMENT
/// ORDER is kept as the TypeScript writes it for the same reason.
#[must_use]
pub fn min2(a: f64, b: f64) -> f64 {
    min(&[a, b])
}

/// Two-argument `Math.max`. See [`min2`] - `Math.max(-0, +0)` is `+0`.
#[must_use]
pub fn max2(a: f64, b: f64) -> f64 {
    max(&[a, b])
}

/// Base-2 log (the DSL's `log2`).
///
/// Exact math, not `fast_approx::fast_log2`. The noise machine's own `log2` IS
/// the fastapprox one, but nothing that reaches this function is evaluated by
/// the noise machine - see the module docs.
#[must_use]
pub fn log2(x: f64) -> f64 {
    x.log2()
}

/// Map a geometric slider `s` onto a linear `[lo, hi]` range.
///
/// `slider_to_linear(s, lo, hi) = lo + 0.5*(hi-lo) * (1 + log2(s)/log2(6))`, so
/// `s = 1` (the un-adjusted slider) lands at the midpoint and `s = 6` at `hi`.
/// Read by `moisture_nauvis`'s starting-area bias, `fulgora_grid` and
/// `fulgora_scrap`.
///
/// **Evaluated with per-operation f32 rounding, which is measured rather than
/// stylistic.** `fulgora_grid` is `175 - slider_to_linear(freq, -50, 50)`, and
/// the game was sampled at five slider positions on a real Fulgora surface
/// (2.1.14, seed 123456). An f64 chain rounded once at the end misses at
/// `s = 3` by exactly one f32 ULP - 144.34263610839844 against the game's
/// 144.3426513671875 - and rounding every operation matches all five exactly.
///
/// **Only `s = 3` can see it.** The other probes (0.5, 1, 2) have power-of-two
/// numerators, and at `s = 6` the ratio is exactly 1 whatever `log2(6)` is, so
/// a four-point sweep that skipped 3 would have "confirmed" the f64 form.
///
/// The `f64` -> `f32` casts are written out at each step rather than by typing
/// the whole chain `f32`, so this reads token-for-token against the TypeScript
/// it is graded against.
#[must_use]
pub fn slider_to_linear(s: f64, lo: f64, hi: f64) -> f32 {
    let ratio = slider_ratio(s);
    let half_span = (0.5 * f64::from((hi - lo) as f32)) as f32;
    let scaled = (f64::from(half_span) * f64::from((1.0 + f64::from(ratio)) as f32)) as f32;
    poison::f32_result((lo + f64::from(scaled)) as f32)
}

/// Map the same geometric slider `s` onto a GEOMETRIC range of `1/n` to `n`:
/// `2^(log2(s)/log2(6) * log2(n))` (`core/prototypes/noise-functions.lua:16`).
///
/// Read by `fulgora_natural` as `slider_rescale(control:fulgora_islands:size,
/// 2)` and by Nauvis's rock size. `s = 1` gives exactly 1 for every `n`,
/// `s = 6` gives `n`, `s = 1/6` gives `1/n`.
///
/// **Two properties here are measured against the game, and the DEFAULT slider
/// can see neither** - at `s = 1` the exponent is exactly 0 and the whole call
/// is a multiply by one, so `fulgora_natural` at default settings accepts any
/// implementation at all. `sliderRescaleProbe` in
/// `oracle-fulgora-elevation.seed123456.json` samples `slider_rescale(s, 2)` at
/// literal `s` of 0.5, 1, 2, 3, 4, 5 and 6 instead:
///
/// - **Per-operation f32 rounding matches all 7 exactly.** An f64 chain rounded
///   once at the end misses `s = 0.5` and `s = 5` by one ULP each - the same
///   shape `slider_to_linear` was corrected for, and again invisible at most
///   slider positions, since 2, 3 and 4 agree between the two forms.
/// - **The `^` is EXACT, not the noise machine's fastapprox**, which misses 6
///   of the 7. This resolves on the prototype side, so `Math::powSafe` never
///   enters it - which is why exact `powf` is right here while
///   `fast_approx::fast_pow` is right inside `multioctave_noise`.
#[must_use]
pub fn slider_rescale(s: f64, n: f64) -> f32 {
    let ratio = slider_ratio(s);
    let exponent = (f64::from(ratio) * f64::from(log2(n) as f32)) as f32;
    poison::f32_result(2.0f64.powf(f64::from(exponent)) as f32)
}

/// `f32(f32(log2(s)) / f32(log2(6)))`, shared by the two functions above.
///
/// The division is written in f64 on two f32-valued operands and narrowed once,
/// which is what `f(f(a) / f(b))` does in JavaScript. It agrees with a direct
/// f32 division for every input - binary64 carries 53 bits against the 2p+2 = 50
/// that makes double rounding safe for a quotient - but it is written the
/// faithful way rather than the way that needs that theorem to be read.
fn slider_ratio(s: f64) -> f32 {
    (f64::from(log2(s) as f32) / f64::from(log2(6.0) as f32)) as f32
}

/// `slider_rescale` evaluated in f64 with a single rounding - **TEST-ONLY, and
/// deliberately not part of this crate's surface** (#270, resolved).
///
/// Two implementations of one Lua function used to ship. This one
/// short-circuits `v == 1` to exactly 1 and otherwise rounds once at the end;
/// [`slider_rescale`] rounds every operation, which is what the noise machine
/// does - `slider_rescale` is a **noise-function** in
/// `core/prototypes/noise-functions.lua:16`, not a Lua function, so the machine
/// evaluates it. The oracle settles which is the game's: the per-operation form
/// matches all 7 probe points and this one misses `s = 0.5` and `s = 5` by one
/// ULP each.
///
/// It was ported originally because its consumers shipped -
/// `vulcanus_resources`, `vulcanus_biomes` and `vulcanus_helpers` on the
/// TypeScript side, plus Nauvis rock size. Those all moved onto the
/// per-operation form, `src/noise/eval/sliderRescale.ts` is deleted, and this
/// is what is left: a control. Keeping it lets
/// `the_two_slider_rescale_forms_disagree_at_the_measured_points` below, and
/// the fixture test in `fixtures.rs`, show that the shipped form is the one the
/// game matches - rather than asserting that against nothing.
///
/// **Do not make this `pub` again.** It is the form the
/// `wasm32-unknown-unknown` libm disagreed with V8 on, at 1 of 600 slider
/// positions, and it is also the form that disagrees with the game. There is no
/// configuration in which shipping it is right.
#[cfg(test)]
#[must_use]
pub(crate) fn slider_rescale_rounded_once(v: f64, n: f64) -> f64 {
    if v == 1.0 {
        return 1.0;
    }
    2.0f64.powf((log2(v) / log2(6.0)) * log2(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_holds_the_bounds_and_passes_nan_through() {
        assert_eq!(clamp(5.0, 0.0, 1.0), 1.0);
        assert_eq!(clamp(-5.0, 0.0, 1.0), 0.0);
        assert_eq!(clamp(0.25, 0.0, 1.0), 0.25);
        // Both comparisons are false for NaN, so `v` falls through unchanged -
        // matching JavaScript. `f64::clamp` would panic on some inputs instead.
        assert!(clamp(f64::NAN, 0.0, 1.0).is_nan());
    }

    #[test]
    fn lerp_hits_the_left_endpoint_exactly() {
        assert_eq!(lerp(3.0, 7.0, 0.0), 3.0);
        assert_eq!(lerp(3.0, 7.0, 0.5), 5.0);
    }

    /// **`t = 1` does not return `b` exactly**, and downstream code has assumed
    /// it does. See the docblock - this is the Fulgora `mix_oil` case, reduced.
    #[test]
    fn lerp_at_one_is_not_exactly_the_right_endpoint() {
        // Exact where the arithmetic happens to be exact...
        assert_eq!(lerp(3.0, 7.0, 1.0), 7.0);
        // ...and not, where it is not. These are the real Fulgora values.
        let a = -0.4066666666666666;
        let b = -0.01f64;
        assert_ne!(lerp(a, b, 1.0), b);
        assert_eq!(lerp(a, b, 1.0), a + (b - a));
    }

    /// **The reason `min`/`max` are written out.** `f64::min` discards NaN;
    /// JavaScript's `Math.min` propagates it. Planting `xs.iter().copied().fold(
    /// f64::INFINITY, f64::min)` makes this fail and nothing else in the crate
    /// notices.
    #[test]
    fn min_and_max_propagate_nan_where_f64_min_would_discard_it() {
        assert!(min(&[1.0, f64::NAN, 2.0]).is_nan());
        assert!(max(&[1.0, f64::NAN, 2.0]).is_nan());
        // The control: `f64::min` is the thing being avoided, and it really
        // does return the other operand.
        assert_eq!(1.0f64.min(f64::NAN), 1.0);
    }

    /// The two-argument helpers inherit the slice versions' semantics, which is
    /// the point of routing every ported expression through them.
    #[test]
    fn the_two_argument_helpers_are_not_f64_min_and_f64_max() {
        assert!(min2(0.0, -0.0).is_sign_negative());
        assert!(min2(-0.0, 0.0).is_sign_negative());
        assert!(max2(0.0, -0.0).is_sign_positive());
        assert!(max2(-0.0, 0.0).is_sign_positive());
        assert!(min2(1.0, f64::NAN).is_nan());
        assert!(max2(1.0, f64::NAN).is_nan());
        // The control: `f64::min`/`f64::max` do neither, which is why this
        // module exists.
        assert_eq!(1.0f64.min(f64::NAN), 1.0);
        assert_eq!(1.0f64.max(f64::NAN), 1.0);
    }

    #[test]
    fn min_and_max_match_javascript_on_the_empty_slice_and_signed_zero() {
        assert_eq!(min(&[]), f64::INFINITY);
        assert_eq!(max(&[]), f64::NEG_INFINITY);
        assert!(min(&[0.0, -0.0]).is_sign_negative());
        assert!(min(&[-0.0, 0.0]).is_sign_negative());
        assert!(max(&[0.0, -0.0]).is_sign_positive());
        assert!(max(&[-0.0, 0.0]).is_sign_positive());
    }

    /// The identities the Lua guarantees, at both ends of the slider.
    #[test]
    fn slider_rescale_hits_its_three_exact_identities() {
        assert_eq!(slider_rescale(1.0, 2.0), 1.0);
        assert_eq!(slider_rescale(1.0, 3.0), 1.0);
        assert_eq!(slider_rescale(6.0, 2.0), 2.0);
        assert_eq!(slider_rescale(6.0, 3.0), 3.0);
        assert_eq!(slider_rescale(1.0 / 6.0, 2.0), 0.5);
    }

    #[test]
    fn slider_to_linear_hits_the_midpoint_and_the_top() {
        assert_eq!(slider_to_linear(1.0, -50.0, 50.0), 0.0);
        assert_eq!(slider_to_linear(6.0, -50.0, 50.0), 50.0);
        assert_eq!(slider_to_linear(1.0, -0.5, 0.5), 0.0);
    }

    /// The two shipped `slider_rescale` forms are NOT interchangeable, and the
    /// probe points where they differ are named in the oracle's own provenance.
    /// Pinned so a future "unify these" reads as the behaviour change it is.
    #[test]
    fn the_two_slider_rescale_forms_disagree_at_the_measured_points() {
        for s in [0.5, 5.0] {
            assert_ne!(
                slider_rescale(s, 2.0),
                slider_rescale_rounded_once(s, 2.0) as f32,
                "s = {s} is one of the two points the oracle says discriminates"
            );
        }
        // And they agree where the oracle says they agree, so the assertion
        // above is about those two points rather than about everything.
        for s in [1.0, 2.0, 3.0, 4.0, 6.0] {
            assert_eq!(
                slider_rescale(s, 2.0),
                slider_rescale_rounded_once(s, 2.0) as f32
            );
        }
    }
}
