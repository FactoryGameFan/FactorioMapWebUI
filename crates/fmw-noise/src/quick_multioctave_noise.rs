//! `quick_multioctave_noise` - `NoiseExpressions::QuickMultioctaveNoise`.
//!
//! Ported from `src/noise/quickMultioctaveNoise.ts`; derivation in
//! `docs/noise/quick-multioctave-noise-NOTES.md`. N octaves of `basis_noise`,
//! each scaling its input by `OISM` and its contribution by `OOSM`. Three
//! things make it "quick" and unlike the plain op: no RMS normalisation,
//! `offset_x` is a single world-space translation applied identically to every
//! octave, and octaves decorrelate by RE-SEEDING rather than by an x shift -
//! each gets its own basis seed word, a flat `seed0 + k`.
//!
//! The temperature / moisture / aux climate trees use this op.
//!
//! **The arithmetic is f32 and every part of it is load-bearing.** The
//! TypeScript evaluated in pure f64 until 2026-08-18 and scored 38 of 190; its
//! spec called the gap "the documented f32 floor" and there was no floor.
//! Leave-one-out over the fixture: 109/190 without narrowed params, 132/190
//! without the `amp * basis` rounding, 143/190 deriving scale and amplitude as
//! `OISM**k` instead of a running chain, 137/190 without the chain rounding.
//! All four together: 190/190, worst error 0.

use crate::basis_noise::{basis_noise, tables_from_seed, BasisNoiseTables};
use crate::fast_approx::noise_machine_pow;

/// Parameters for [`quick_multioctave_noise`]. `f64` for the same reason as
/// [`crate::multioctave_noise::MultioctaveParams`].
#[derive(Clone, Copy, Debug)]
pub struct QuickMultioctaveParams {
    /// Map seed (basis seed word).
    pub seed0: u32,
    /// Per-call seed selector.
    pub seed1: u32,
    /// Octave count (>= 1).
    pub octaves: u32,
    /// Base input scale for octave 0.
    pub input_scale: f64,
    /// Overall output multiplier applied to octave 0.
    pub output_scale: f64,
    /// Amplitude ratio between successive octaves.
    pub octave_output_scale_multiplier: f64,
    /// Input-scale ratio between successive octaves.
    pub octave_input_scale_multiplier: f64,
    /// World-space x translation applied to every octave.
    pub offset_x: f64,
}

/// The per-octave tables, input scales and amplitudes, plus the f32 x offset.
pub struct QuickOctaves {
    tables: Vec<BasisNoiseTables>,
    scales: Vec<f32>,
    amps: Vec<f32>,
    offset_x: f32,
}

/// The `seed0` for octave `k`: a flat `seed0 + k`.
///
/// An earlier derivation used a `phase` and a "+2 every pair of octaves"
/// cadence. That was an over-fit masked by an RNG detail: `taus88`'s `s1`
/// update clears the low bit of its input, so for an EVEN starting word `W`,
/// seeds `W` and `W + 1` produce byte-identical tables - which makes the two
/// rules indistinguishable whenever the pair's base word is even. Every oracle
/// capture used `seed0 = 123456`, which is even, so the coincidence held. A
/// three-seed parity test including an ODD seed exposed it.
fn octave_seed0(seed0: u32, k: u32) -> u32 {
    seed0.wrapping_add(k)
}

/// Derive the per-octave terms exactly as `QuickMultioctaveNoise::run` emits
/// them.
///
/// `run` is a register-program builder, not a runtime loop: it unrolls N
/// explicit `BasisNoise` ops, multiplying the running input scale (`s8 *= s12`)
/// and output scale (`s9 *= s13`) per octave. Those registers are f32, so the
/// chain is a CHAIN - each step rounds, and the k-th scale is not
/// `input_scale * OISM^k`. That distinction is worth 143/190 against 190/190.
///
/// The four incoming parameters are narrowed here because the game holds them
/// in f32 constant slots, and the values callers pass (0.6, 0.65, 0.7, 0.1,
/// 0.08, 1/6, 0.55) have no exact f32 form. That is the biggest single term of
/// the four.
#[must_use]
pub fn octave_terms(params: &QuickMultioctaveParams) -> QuickOctaves {
    let oism = params.octave_input_scale_multiplier as f32;
    let oosm = params.octave_output_scale_multiplier as f32;

    let count = params.octaves as usize;
    let mut tables = Vec::with_capacity(count);
    let mut scales = Vec::with_capacity(count);
    let mut amps = Vec::with_capacity(count);
    let mut scale = params.input_scale as f32;
    let mut amp = params.output_scale as f32;
    for k in 0..params.octaves {
        tables.push(tables_from_seed(
            octave_seed0(params.seed0, k),
            params.seed1,
        ));
        scales.push(scale);
        amps.push(amp);
        scale *= oism;
        amp *= oosm;
    }
    QuickOctaves {
        tables,
        scales,
        amps,
        offset_x: params.offset_x as f32,
    }
}

/// Sum the octaves, rounding to f32 after every operation.
///
/// Two roundings carry the bulk of the fix, both confirmed by removing them one
/// at a time and re-scoring: `amp * basis(...)` is rounded before it is added
/// (dropping only this costs 58 exact matches while leaving the worst residual
/// at 4.768e-7 - which is why this op is scored by exact count and not by a
/// bound), and the running total is f32 rather than an f64 accumulator narrowed
/// once on return.
///
/// `x + offset_x` is hoisted out of the loop because it does not depend on k;
/// that is the same arithmetic, not a shortcut. **Whether the game rounds that
/// add before the multiply is NOT resolved by the fixture** - narrowing only
/// the product also scores 190/190, because every `(position + offset_x)` it
/// uses is already exact in f32. Both narrowings are kept, matching what a
/// register machine does. Likewise the incoming `x`/`y` narrowing: all 38
/// fixture positions are already on the f32 grid, so turning it off also leaves
/// 190/190. It is kept for #191's reason - the noise machine hands every
/// expression an f32 - and a caller passing a derived x is where it would show.
#[must_use]
pub fn sum_octaves(x: f64, y: f64, terms: &QuickOctaves) -> f32 {
    let xo = (x as f32) + terms.offset_x;
    let yf = y as f32;
    let mut sum = 0.0f32;
    for ((&scale, &amp), tables) in terms
        .scales
        .iter()
        .zip(terms.amps.iter())
        .zip(terms.tables.iter())
    {
        sum += amp * basis_noise(f64::from(xo * scale), f64::from(yf * scale), tables);
    }
    sum
}

/// Evaluate `quick_multioctave_noise` at world coordinates `(x, y)`.
#[must_use]
pub fn quick_multioctave_noise(x: f64, y: f64, params: &QuickMultioctaveParams) -> f32 {
    sum_octaves(x, y, &octave_terms(params))
}

/// Parameters for [`quick_multioctave_noise_persistence`].
#[derive(Clone, Copy, Debug)]
pub struct QuickPersistenceParams {
    /// Map seed (basis seed word).
    pub seed0: u32,
    /// Per-call seed selector.
    pub seed1: u32,
    /// Octave count (>= 1).
    pub octaves: u32,
    /// Base input scale.
    pub input_scale: f64,
    /// Overall output multiplier.
    pub output_scale: f64,
    /// Input-scale ratio between successive octaves.
    pub octave_input_scale_multiplier: f64,
    /// Amplitude ratio between successive octaves.
    pub persistence: f64,
}

/// `quick_multioctave_noise_persistence` - the wrapper over the raw op.
///
/// **Its transform is f32, not f64, and that is worth 1.964e-3.** It is
/// tempting to read "Lua wrapper" as "Lua arithmetic, therefore doubles". It is
/// not: the wrapper is a `noise-function` whose body is an EXPRESSION STRING
/// (`core/prototypes/noise-functions.lua`), which the game's noise machine
/// compiles and folds - in f32, one operation at a time. Doing it in f64 left
/// this wrapper at 114/152 exact and worst 1.964e-3 even after the op beneath
/// it was bit-exact; in f32 it is 152/152, worst 0.
///
/// `^` has an integral exponent, so [`noise_machine_pow`] takes its
/// exponentiation-by-squaring branch. **The fixture cannot discriminate that
/// branch** - `Math.pow` narrowed to f32 also scores 152/152, because the only
/// bases are 0.5 and 0.6 at exponents 0, 2, 3 and 4. Squaring is used because
/// it is what the game does, not because the fixture chose it.
#[must_use]
pub fn quick_persistence_terms(params: &QuickPersistenceParams) -> QuickOctaves {
    let oism = params.octave_input_scale_multiplier as f32;
    let exponent = (params.octaves - 1) as f32;
    octave_terms(&QuickMultioctaveParams {
        seed0: params.seed0,
        seed1: params.seed1,
        octaves: params.octaves,
        input_scale: f64::from((params.input_scale as f32) * noise_machine_pow(oism, exponent)),
        output_scale: f64::from((params.output_scale as f32) * noise_machine_pow(2.0, exponent)),
        octave_output_scale_multiplier: f64::from(params.persistence as f32),
        // `1 / oism` as an f64 division narrowed after, matching the
        // TypeScript. Unlike the two divisions inside `fast_approx`, this
        // divisor is caller-supplied and unbounded, so the enumeration that
        // proved those two cannot double-round does not cover it.
        octave_input_scale_multiplier: f64::from((1.0 / f64::from(oism)) as f32),
        offset_x: 0.0,
    })
}

/// Evaluate `quick_multioctave_noise_persistence` at `(x, y)`.
#[must_use]
pub fn quick_multioctave_noise_persistence(x: f64, y: f64, params: &QuickPersistenceParams) -> f32 {
    sum_octaves(x, y, &quick_persistence_terms(params))
}
