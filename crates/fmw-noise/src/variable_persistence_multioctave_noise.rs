//! `variable_persistence_multioctave_noise` -
//! `NoiseOperations::VariablePersistenceMultioctaveNoise`.
//!
//! Ported from `src/noise/variablePersistenceMultioctaveNoise.ts`; derivation
//! in `docs/noise/variable-persistence-multioctave-noise-NOTES.md`. This is the
//! op the elevation tree uses (nauvis `make_0_12like_lakes`). Its defining
//! feature: `persistence` is spatially varying - a noise expression the game
//! evaluates per tile - so the caller supplies it per point.
//!
//! N octaves of `basis_noise` sharing one `(seed0, seed1)`, each halving the
//! input scale and weighted by a power of the per-tile persistence, combined in
//! Horner order so octave k carries weight `p^(N-1-k)`, every step rounded to
//! f32. No RMS normalisation - it is the raw weighted sum times a `2^N` gain.
//!
//! **There is NO per-octave x shift.** The port once carried a fitted `-7936`,
//! which is `-31 * 256` and so names the same field as zero; `::run`'s octave
//! loop reloads the x/y offsets from the same two constant slots every
//! iteration and has no counter-scaled term. In f64 removing it changes
//! nothing; in f32 it is the difference between 3.6e-1 and bit-exact.

use crate::basis_noise::{basis_noise, tables_from_seed, BasisNoiseTables};

/// Parameters for [`variable_persistence_multioctave_noise`]. `f64` for the
/// same reason as [`crate::multioctave_noise::MultioctaveParams`].
#[derive(Clone, Copy, Debug)]
pub struct VariablePersistenceParams {
    /// Map seed.
    pub seed0: u32,
    /// Per-call seed selector.
    pub seed1: u32,
    /// Octave count (>= 1).
    pub octaves: u32,
    /// Base input scale; octave 0 uses `input_scale / 2`.
    pub input_scale: f64,
    /// Overall output multiplier (the op additionally applies a `2^octaves` gain).
    pub output_scale: f64,
    /// World-space x translation applied to every octave.
    pub offset_x: f64,
}

/// The per-octave scales and the folded output gain.
pub struct VariablePersistenceTerms {
    scales: Vec<f32>,
    gain: f32,
    offset_x: f64,
}

/// Derive the per-octave input scales and the `output_scale * 2^N` gain.
#[must_use]
pub fn terms(params: &VariablePersistenceParams) -> VariablePersistenceTerms {
    // `2^octaves` is exact in f64 for every reachable octave count, so the
    // product is one f64 multiply narrowed once - matching the TypeScript,
    // where both operands are JavaScript numbers.
    let gain = (params.output_scale * f64::from(2u32.pow(params.octaves))) as f32;

    let mut scale = (params.input_scale as f32) * 0.5;
    let mut scales = Vec::with_capacity(params.octaves as usize);
    for _ in 0..params.octaves {
        scales.push(scale);
        scale *= 0.5;
    }
    VariablePersistenceTerms {
        scales,
        gain,
        offset_x: params.offset_x,
    }
}

/// Evaluate the op at `(x, y)` with a per-tile `persistence`.
///
/// Horner order exactly as the game's `run` does it: add the octave, then
/// multiply the running accumulator by the tile's persistence - except after
/// the last octave.
///
/// Note the two coordinates are NOT symmetric, and that mirrors the
/// TypeScript rather than being an oversight. `x + offset_x` is a sum of two
/// f64s narrowed to f32 before the scale multiply, while `y * scale` is an f64
/// multiply of the un-narrowed `y` that is narrowed afterwards. Making them
/// match would change which point is evaluated.
#[must_use]
pub fn eval(
    x: f64,
    y: f64,
    persistence: f32,
    terms: &VariablePersistenceTerms,
    tables: &BasisNoiseTables,
) -> f32 {
    let xo = (x + terms.offset_x) as f32;
    let last = terms.scales.len().saturating_sub(1);
    let mut acc = 0.0f32;
    for (k, &scale) in terms.scales.iter().enumerate() {
        let xk = xo * scale;
        let yk = (y * f64::from(scale)) as f32;
        acc += basis_noise(f64::from(xk), f64::from(yk), tables);
        if k < last {
            acc *= persistence;
        }
    }
    acc * terms.gain
}

/// Evaluate `variable_persistence_multioctave_noise`, deriving tables and terms
/// per call. Use [`terms`] plus [`eval`] when sweeping a grid.
#[must_use]
pub fn variable_persistence_multioctave_noise(
    x: f64,
    y: f64,
    persistence: f32,
    params: &VariablePersistenceParams,
) -> f32 {
    let tables = tables_from_seed(params.seed0, params.seed1);
    eval(x, y, persistence, &terms(params), &tables)
}
