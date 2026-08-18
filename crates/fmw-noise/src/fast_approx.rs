//! Paul Mineiro's `fastapprox` `log2` / `exp2` / `pow`, as Factorio's
//! `Math::log2` / `Math::exp2f` / `Math::powSafe`.
//!
//! Ported from `src/noise/fastApprox.ts`. The game's noise machine evaluates
//! every power and cube root through these, so a ported expression that takes
//! a `pow` must too - matching them is what closes the last ~1e-4 relative
//! error.
//!
//! **The rounding is per operation.** Both functions used to evaluate the whole
//! polynomial in double and round once at the end; the binary rounds after
//! every `fadd`/`fmul`/`fdiv`. The difference is ~1e-5 relative - invisible to
//! every tolerance-based fixture, and decisive for `voronoi_spot_noise` with
//! `distance_type = 'minkowski3'`, which goes 96/175 to 175/175 with it.
//!
//! The constants are written as `f32::from_bits` of the immediates in the
//! 2.1.12 arm64 disassembly rather than as decimals, so they cannot drift
//! through a decimal round-trip. Do not fold them into single expressions -
//! that reintroduces the double accumulation this module exists to prevent.

/// The one place this port's arithmetic could have differed from the
/// TypeScript's, and it is measured rather than assumed.
///
/// JavaScript has no f32 divide, so `src/noise/fastApprox.ts` writes
/// `f32(a / b)` - an f64 division narrowed afterwards. That is a DOUBLE
/// rounding, and in general it is not the same as the single-precision `fdiv`
/// the game issues and that this file writes. It cannot differ here, which was
/// established by brute force rather than by argument: both divisions have a
/// bounded divisor range (`mx + 0.35208871` lands in [0.852, 1.352] because
/// `mx` is a mantissa forced into [0.5, 1.0), and `4.842525 - z` lands in
/// (3.842, 4.843] because `z` is a fraction), so every reachable f32 divisor
/// can be enumerated.
///
/// All 5,435,075 divisors for `fast_log2` and all 2,427,401 for `fast_pow2`
/// give bit-identical results either way. Zero differences.
///
/// If a future primitive adds a division whose divisor range is not bounded,
/// re-run that enumeration before assuming the same holds.
const _DIVISION_ROUNDING_IS_MEASURED: () = ();

/// Paul Mineiro `fastlog2`, matching Factorio's `Math::log2`.
///
/// (`Math::log2`, not `Math::log2f` - the symbols are `__ZN4Math4log2Ef` and
/// `__ZN4Math5exp2fEf`, so only exp2 carries the `f`.)
#[must_use]
pub fn fast_log2(x: f32) -> f32 {
    let bits = x.to_bits();
    // `bits * 2^-23`. Done in f64 and narrowed, exactly as the TypeScript: the
    // product is exact in f64 (a power-of-two scale), so this is one rounding,
    // and casting `bits` to f32 first would round the mantissa away.
    let y = (f64::from(bits) * f64::from(f32::from_bits(0x3400_0000))) as f32;
    let mx = f32::from_bits((bits & 0x007f_ffff) | 0x3f00_0000);

    let mut acc = y + f32::from_bits(0xc2f8_7377);
    acc += mx * f32::from_bits(0xbfbf_bf75);
    acc + f32::from_bits(0xbfdc_e9a3) / (mx + f32::from_bits(0x3eb4_44f9))
}

/// Paul Mineiro `fastpow2`, matching Factorio's `Math::exp2f`.
#[must_use]
pub fn fast_pow2(p: f32) -> f32 {
    let clipp = if p < -126.0 { -126.0 } else { p };
    let z = (clipp - clipp.trunc()) + if p < 0.0 { 1.0 } else { 0.0 };

    let mut acc = clipp + f32::from_bits(0x42f2_8c51);
    acc += f32::from_bits(0x41dd_d2fe) / (f32::from_bits(0x409a_f5f8) - z);
    acc += z * f32::from_bits(0xbfbe_bc8d);

    // `Math.trunc(acc * 8388608) | 0` in the TypeScript. The multiply is f64
    // there (2^23 is exact, so it loses nothing), and `| 0` is JavaScript's
    // ToInt32, which WRAPS modulo 2^32 where Rust's `as i32` saturates.
    //
    // Reachable inputs cannot tell them apart: `clipp` is clamped at -126
    // below, and above, `acc` would have to exceed 2^31/2^23 = 256 for the
    // casts to differ, which needs `p` past 128 - beyond f32's exponent range
    // for the result anyway. Recorded because it IS a difference, not because
    // it is reachable.
    let scaled = (f64::from(acc) * 8_388_608.0).trunc();
    f32::from_bits(scaled as i64 as u32)
}

/// `x^p` via the fastapprox pair, as the game computes powers in noise programs.
#[must_use]
pub fn fast_pow(x: f32, p: f32) -> f32 {
    fast_pow2(p * fast_log2(x))
}

/// `f32(1/3)`, bit pattern `0x3eaaaaab` - the exact multiplier the binary uses.
pub const ONE_THIRD_F32: f32 = f32::from_bits(0x3eaa_aaab);

/// `x^(1/3)` via the fastapprox pair. `x` must be > 0.
///
/// **The exponent is `f32(1/3)`, not the double `1/3`, and that is worth 3.0%
/// of all inputs** (#163). The game reaches this through
/// `Math::powSafe(float, float)` - both parameters are `float` and the multiply
/// by the exponent is `fmul s0, s0, s1` - so `0.3333333333333333` never
/// appears; `0.3333333432674408` does. At the 24 positions in
/// `oracle-fastpow.seed123456.json` chosen because the two differ, the double
/// scores 0/24 and this scores 24/24.
#[must_use]
pub fn fast_cbrt(x: f32) -> f32 {
    fast_pow(x, ONE_THIRD_F32)
}

/// The noise machine's `^`, in f32.
///
/// It is **three different functions**, dispatched on the exponent: exact
/// exponentiation by squaring for an integer, exact `sqrt` for 0.5, and
/// fastapprox (`Math::powSafe`) otherwise. Settled against
/// `oracle-fastpow.seed123456.json` at 123/123 per branch (#161, #163), where
/// the 0.5 case was a refutation of the then-current model rather than a
/// confirmation. Do not collapse these into one call.
#[must_use]
pub fn noise_machine_pow(base: f32, exponent: f32) -> f32 {
    if exponent == 0.5 {
        return base.sqrt();
    }
    if exponent.fract() != 0.0 || exponent < 0.0 {
        return fast_pow(base, exponent);
    }
    let mut result = 1.0f32;
    let mut b = base;
    // Exact for every exponent this is reachable with: `octaves` is a whole
    // number and small.
    let mut e = exponent as u32;
    while e > 0 {
        if e & 1 == 1 {
            result *= b;
        }
        b *= b;
        e >>= 1;
    }
    result
}
