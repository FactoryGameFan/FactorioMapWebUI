//! `multioctave_noise` - the plain `NoiseOperations::MultioctaveNoise`.
//!
//! Ported from `src/noise/multioctaveNoise.ts`; the derivation and its evidence
//! are in `docs/noise/multioctave-noise-NOTES.md`. N octaves of `basis_noise`
//! sharing one `(seed0, seed1)`: each octave halves the input scale, scales
//! amplitude by `1/persistence`, and shifts x by a fixed per-octave offset,
//! with the whole sum RMS-normalised.
//!
//! **The arithmetic is f32 and the octave offset is small (17.17, not the
//! aliased -1774.83), and the two only pay off together.** The lattice has
//! period 256 per axis and `17.17 - 1774.83 == -7 * 256`, so a wide oracle fit
//! could not tell them apart and landed on the alias. In f64 they are
//! interchangeable; in f32 the alias caps accuracy at ~1e-4, which the notes
//! once recorded as an irreducible floor and it never was one.

use crate::basis_noise::{basis_noise, tables_from_seed, BasisNoiseTables};
use crate::fast_approx::{fast_log2, fast_pow2};

/// Each octave halves the input scale (doubles the wavelength).
const LACUNARITY: f32 = 0.5;

/// Per-octave x shift in noise space, added as `k * OCTAVE_OFFSET_X`.
///
/// The literal double immediate in `Noise::fastVectorMultioctaveNoise`
/// (`0x40312b851eb851ec`), which is exactly `17.17`. **A double, deliberately**
/// - it is not representable in f32, and the game adds it at double precision
///   to the widened f32 product. See [`sum_octaves`].
const OCTAVE_OFFSET_X: f64 = 17.17;

/// Upper clamp on the fractional-octave frequency boost. The binary compares
/// the widened result against the double `1.99999` and substitutes the f32
/// nearest when it is not below; the lower clamp is a plain 1.0.
const FRAC_OCTAVE_MAX: f32 = 1.99999;

/// Parameters for [`multioctave_noise`].
///
/// The float fields are `f64` because the TypeScript's are - JavaScript numbers
/// are f64 - and the narrowing happens at the points the game narrows, not on
/// the way in. Taking `f32` here would round earlier than the game does.
#[derive(Clone, Copy, Debug)]
pub struct MultioctaveParams {
    /// Map seed.
    pub seed0: u32,
    /// Per-call seed selector.
    pub seed1: u32,
    /// Octave count (>= 1); may be fractional.
    pub octaves: f64,
    /// Amplitude ratio between successive octaves' contributions.
    pub persistence: f64,
    /// Base input scale (noise units per world tile) for the finest octave.
    pub input_scale: f64,
    /// Overall output multiplier.
    pub output_scale: f64,
}

/// The per-octave input scales and amplitudes.
pub struct OctaveTerms {
    scales: Vec<f32>,
    amps: Vec<f32>,
}

/// Derive the per-octave terms exactly as `Noise::fastVectorMultioctaveNoise`
/// does before its octave loop.
///
/// Three details are read off the arm64 rather than inferred:
///
/// - **The octave count is `ceil(octaves)`** (`frintp`), and a fractional count
///   multiplies the INPUT SCALE - not the amplitude - by
///   `clamp(fastPow2(ceil(N) - N), 1, 2)`. Inert for integral `octaves`, which
///   is all the fixture covers; implemented because the binary does it.
/// - **The RMS ratio is computed in f32, but its `sqrt` and the `output_scale`
///   multiply are done in f64** and rounded once (`fcvt d0,s0; fsqrt d0;
///   fmul d0,d1; fcvt s10,d0`). One precision throughout is wrong either way.
/// - **`output_scale` folds into the starting amplitude**, not into the
///   finished sum, so it takes part in the f32 amplitude chain.
///
/// The game branches on `1/P`, not on `P`: `1/P == 1` takes the `1/sqrt(N)`
/// branch (the ratio would be 0/0) and `1/P == 0` skips normalisation.
#[must_use]
pub fn octave_terms(params: &MultioctaveParams) -> OctaveTerms {
    let n = params.octaves.ceil();
    let inv_p = (1.0 / params.persistence) as f32;

    let mut amp: f32 = if inv_p == 1.0 {
        (params.output_scale / n.sqrt()) as f32
    } else if inv_p != 0.0 {
        let inv_p2 = inv_p * inv_p;
        let pow = fast_pow2(fast_log2(inv_p2) * (n as f32));
        let ratio = (inv_p2 - 1.0) / (pow - 1.0);
        (f64::from(ratio).sqrt() * params.output_scale) as f32
    } else {
        params.output_scale as f32
    };

    // A fractional octave count boosts the base frequency; exactly 1 when
    // integral.
    //
    // `clamp` rather than `max().min()`, and that is not merely clippy's
    // preference: the two differ on NaN and only `clamp` matches the
    // TypeScript. Rust's `f32::max(NaN, 1.0)` returns 1.0 - it IGNORES a NaN
    // operand - while JavaScript's `Math.max(NaN, 1)` is NaN. `f32::clamp`
    // propagates NaN, like JavaScript does. It panics only when the BOUNDS are
    // unordered, and both of those are constants here.
    let frac = fast_pow2((n - params.octaves) as f32).clamp(1.0, FRAC_OCTAVE_MAX);
    let mut scale = (params.input_scale as f32) * frac;

    let count = n as usize;
    let mut scales = Vec::with_capacity(count);
    let mut amps = Vec::with_capacity(count);
    for _ in 0..count {
        scales.push(scale);
        amps.push(amp);
        scale *= LACUNARITY;
        amp *= inv_p;
    }
    OctaveTerms { scales, amps }
}

/// Sum the octaves in the game's order.
///
/// Each octave's contribution is rounded to f32 and added to an f32 running
/// total (`out[i] = out[i] + amp*basis(...)` in `Noise::noise`'s vector
/// kernel), never accumulated in f64 and rounded at the end.
///
/// The x coordinate is the one place f64 appears inside the loop, and it is
/// deliberate: `17.17` has no f32 form, and the game adds `(double)k * 17.17`
/// to the WIDENED f32 product `f32(x*scale)`, narrowing the sum back to f32.
///
/// The incoming coordinates are narrowed first because the noise machine hands
/// every expression an f32. That is a no-op for a raw world coordinate - an
/// integer or quarter tile below 2^24 is already exact in f32 - and decisive
/// for a DERIVED one: Fulgora's `fulgora_basis_oil` reaches ~15000, where an
/// f32 ulp is 9.8e-4, and narrowing moved it from 2.37e-4 to 7.15e-7 (#190,
/// #191).
#[must_use]
pub fn sum_octaves(x: f64, y: f64, terms: &OctaveTerms, tables: &BasisNoiseTables) -> f32 {
    let xf = x as f32;
    let yf = y as f32;
    let mut out = 0.0f32;
    for (k, (&scale, &amp)) in terms.scales.iter().zip(terms.amps.iter()).enumerate() {
        let xk = ((k as f64) * OCTAVE_OFFSET_X + f64::from(xf * scale)) as f32;
        let yk = yf * scale;
        out += amp * basis_noise(f64::from(xk), f64::from(yk), tables);
    }
    out
}

/// Evaluate `multioctave_noise` at world coordinates `(x, y)`.
///
/// **NOT for a per-pixel loop.** It derives the basis tables and the octave
/// terms on every call, and `tables_from_seed` runs a PRNG to fill three
/// 256-byte permutation tables. Hoist them with [`tables_from_seed`] and
/// [`octave_terms`] and call [`sum_octaves`] instead - which is what the
/// TypeScript's `makeMultioctaveNoise` closure does, and what every renderer
/// here needs.
///
/// This is not a hypothetical. Fulgora's landmask chain called it eight times
/// per pixel and measured **1.15x** against the TypeScript renderer; hoisting
/// took it to the number in that phase's pull request. Nothing failed in the
/// meantime, because the results are identical either way - only a benchmark
/// can see this, which is why it is written here rather than left to be
/// rediscovered.
#[must_use]
pub fn multioctave_noise(x: f64, y: f64, params: &MultioctaveParams) -> f32 {
    let tables = tables_from_seed(params.seed0, params.seed1);
    sum_octaves(x, y, &octave_terms(params), &tables)
}
