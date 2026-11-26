//! The noise DSL's math operators, ported from `src/noise/eval/math.ts`.
//!
//! These exist so a hand-ported named expression reads 1:1 with the Lua -
//! `min(a, b, c)`, `clamp(x, lo, hi)` - rather than being rewritten into Rust
//! idiom at the same time as it is ported. A port that also refactors is two
//! changes graded by one fixture.
//!
//! ## `sin` and `cos` are the GAME's polynomial, not libm (#531)
//!
//! [`vm_sin`] and [`vm_cos`] are the noise machine's own `sin` and `cos`: a short
//! f64 polynomial transcribed from the 2.1.23 binary, which touches no libm. It
//! differs from a correctly rounded f32 sine on about 5.2% of inputs, by one ULP
//! each time, so `f64::sin` narrowed to f32 is a different function. The
//! TypeScript copy is `src/noise/gameTrig.ts` and the two must stay token for
//! token alike. Only f64 add, multiply and abs, an exact round-half-even and
//! the f32 narrowing are used, so a host and `wasm32` return the same bits. No
//! `mul_add`.
//!
//! The shipped engine still takes its bearings as values computed in V8 (#270),
//! and the TypeScript side calls the polynomial too. This copy serves tier 1.
//!
//! ## `log2` and `2^x` ARE ported, and the residual risk is stated
//!
//! `slider_to_linear` and `slider_rescale` need both, and they use exact math
//! rather than `fast_approx`. That is measured rather than assumed: fastapprox
//! misses 6 of the 7 probe points, including breaking the exact `1` at the
//! default slider.
//!
//! **The REASON given here used to be wrong.** This said the two "resolve on the
//! PROTOTYPE side - Lua, not the noise VM". They do not: both are declared
//! `type = "noise-function"` in `core/prototypes/noise-functions.lua`, so they
//! are inlined into their callers and evaluated by the machine like anything
//! else. The conclusion survives and is now better supported - #324's probe
//! passes `x`, a position variable, so nothing can be constant-folded, and exact
//! `log2` still takes all 39 captured cells. Do not restate the old reason.
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

/// `range_select_base` (`core/prototypes/noise-functions.lua`): select a
/// `from`-`to` range, at or above 0 inside it and descending outside when `min`
/// is negative.
///
/// ```text
/// clamp(min(input - from, to - input) / slope, min, max)
/// ```
///
/// The TypeScript keeps this in `src/noise/rocks/rockCatalog.ts`, where it
/// arrived first. It is a core noise function rather than a rock one - the
/// Vulcanus tile catalog is its heaviest consumer - so it lives here, and the
/// rock port will read it from here rather than restating it.
///
/// `min2` rather than `f64::min` for the reason [`min2`] records: this feeds an
/// argmax whose tie-break is order-sensitive.
#[must_use]
pub fn range_select_base(input: f64, from: f64, to: f64, slope: f64, lo: f64, hi: f64) -> f64 {
    clamp(min2(input - from, to - input) / slope, lo, hi)
}

/// Base-2 log (the DSL's `log2`).
///
/// Exact math, not `fast_approx::fast_log2`. The game's `log2` op is a
/// double-precision log2 narrowed to f32, not fastapprox (#531, read from the
/// 2.1.23 binary), so exact math is the right function, not a compromise.
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
/// **The BOUNDS are narrowed first, and that is the whole of #324.** The
/// measurement above was made at `(-50, 50)`, and 50 is exactly representable
/// in f32 - as are `(-1, 1)` and `(-0.5, 0.5)`, the only other ranges the game
/// data uses anywhere except the cliff gate. On such a range narrowing the
/// bounds is a no-op, so no capture ever made before #324 could see whether it
/// happens. `(-1.7, 1.7)` is the one non-dyadic range in the whole of
/// `factorio-data`, and it is read by `cliffiness_nauvis`
/// (`noise-programs.lua:358`).
///
/// `scripts/probes/cliff-slider-to-linear` sampled the game across three ranges
/// and 13 sliders. Narrowing the bounds scores **39 of 39** exact; not
/// narrowing them scores 31 of 39, losing 8 of the 13 cells on `(-1.7, 1.7)`
/// alone. See `test/sliderToLinearOracle.spec.ts`.
///
/// This is the same class as the `structure_subnoise` finding: an f64 literal
/// has to be narrowed to f32 BEFORE it is used, and narrowing the product
/// afterwards buys nothing.
///
/// The `f64` -> `f32` casts are written out at each step rather than by typing
/// the whole chain `f32`, so this reads token-for-token against the TypeScript
/// it is graded against.
#[must_use]
pub fn slider_to_linear(s: f64, lo: f64, hi: f64) -> f32 {
    let lo = f64::from(lo as f32);
    let hi = f64::from(hi as f32);
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

/// Narrow to f32 and back: one step of the noise machine.
///
/// The game evaluates a noise expression one operation at a time, and every
/// value in it, literals included, is an f32. So `0.06 * (plateaus - 0.4)` is
/// `f32r(f32r(0.06) * f32r(plateaus - f32r(0.4)))`, rounded at each step in the
/// order the Lua writes it. An f64 operation on two f32 values, rounded once,
/// is exactly the f32 operation, so the values can stay `f64` between steps.
///
/// Measured on Nauvis (#452): with the arithmetic around the noise ops in f64,
/// `aux`, `moisture`, `elevation_lakes` and `elevation_nauvis` matched the game
/// at 14, 18, 21 and 8 of 26 points. Rounded per step they match at all 26.
#[must_use]
pub fn f32r(v: f64) -> f64 {
    f64::from(v as f32)
}

const ONE_OVER_TAU: f64 = 0.159_154_943_091_895_35;
const K5: f64 = -41.341_675_066_657_37;
const K6: f64 = 6.283_185_269_630_412;
const K7: f64 = -76.568_876_780_232_56;
const K8: f64 = 81.602_015_295_955_71;
const K11: f64 = 39.657_355_248_988_63;

/// The shared half of the game's `sin` and `cos`: `t` is the argument already
/// scaled by `1 / 2pi` (and shifted by `-0.25` for sine).
///
/// Written one operation per line in the game's order, with no fused
/// multiply-add, because the order is what the bits depend on.
fn vm_polynomial(t: f64) -> f64 {
    let f = (t - t.round_ties_even()).abs();
    let u = 0.25 - f;
    let u2 = u * u;
    let u4 = u2 * u2;
    let lo = u2 * K5 + K6;
    let hi = u2 * K7 + K8;
    let p = hi * u4 + lo;
    let u8 = u4 * u4;
    f64::from(((u8 * K11 + p) * u) as f32)
}

/// The game's `sin(x)` for an f32-valued `x`, returned as an f32-valued f64.
///
/// See the module docs. Mirrors `gameSin` in `src/noise/gameTrig.ts`.
#[must_use]
pub fn vm_sin(x: f64) -> f64 {
    vm_polynomial(f64::from(x as f32) * ONE_OVER_TAU + -0.25)
}

/// The game's `cos(x)` for an f32-valued `x`, returned as an f32-valued f64.
///
/// See the module docs. Mirrors `gameCos` in `src/noise/gameTrig.ts`.
#[must_use]
pub fn vm_cos(x: f64) -> f64 {
    vm_polynomial(f64::from(x as f32) * ONE_OVER_TAU)
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

    /// The bounds are narrowed to f32 BEFORE use, and only a range whose bounds
    /// f32 cannot hold exactly can tell (#324).
    ///
    /// `(-1.7, 1.7)` is that range, and it is the only one in the whole of
    /// `factorio-data`; `cliffiness_nauvis` reads it
    /// (`noise-programs.lua:358`). The game's own values live in
    /// `test/fixtures/oracle-slider-to-linear.seed123456.json` and are graded at
    /// all 39 points by `reproduces_the_games_slider_to_linear_at_all_39_points`
    /// in `fixtures.rs` - this test pins the two cells that discriminate beside
    /// the function, so a "simplify the casts" edit reads as the behaviour
    /// change it would be.
    #[test]
    fn slider_to_linear_narrows_its_bounds_before_using_them() {
        // s = 1 makes the ratio exactly 0, so the result is the midpoint. With
        // the bounds narrowed first that midpoint is exactly 0, which is what
        // the game returns; without, it is 4.7683716e-8.
        assert_eq!(slider_to_linear(1.0, -1.7, 1.7), 0.0);
        // s = 6 makes the ratio exactly 1, so the result is `hi` AS F32.
        assert_eq!(slider_to_linear(6.0, -1.7, 1.7), 1.7f32);
        // The control: on a range whose bounds ARE f32-exact the narrowing is a
        // no-op, so it must change nothing. If this ever fails, the fix leaked
        // past the one call site it was measured for.
        assert_eq!(slider_to_linear(6.0, -1.0, 1.0), 1.0);
        assert_eq!(slider_to_linear(3.0, -50.0, 50.0), 30.657_356);
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
