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

use crate::at::At;
use crate::basis_noise::{
    basis_noise, basis_noise_grid, basis_noise_grid_chunk, grid_coordinate, tables_from_seed,
    BasisNoiseTables,
};
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

    let mut scale = (params.input_scale as f32) * frac_boost(params);

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

/// The fractional-octave frequency boost, `clamp(fastPow2(ceil(N) - N), 1,
/// 1.99999)`: exactly 1 when `octaves` is integral.
///
/// `clamp` rather than `max().min()`, and that is not merely clippy's
/// preference: the two differ on NaN and only `clamp` matches the
/// TypeScript. Rust's `f32::max(NaN, 1.0)` returns 1.0 - it IGNORES a NaN
/// operand - while JavaScript's `Math.max(NaN, 1)` is NaN. `f32::clamp`
/// propagates NaN, like JavaScript does. It panics only when the BOUNDS are
/// unordered, and both of those are constants here.
fn frac_boost(params: &MultioctaveParams) -> f32 {
    fast_pow2((params.octaves.ceil() - params.octaves) as f32).clamp(1.0, FRAC_OCTAVE_MAX)
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

/// One multioctave call with its seed tables and octave terms already derived.
///
/// **This is the shape every renderer needs, and its absence was a measured
/// bug.** [`multioctave_noise`] re-derives both on every call, and
/// [`tables_from_seed`] runs a PRNG over three 256-byte tables; Fulgora's chain
/// makes eight such calls per pixel. Building them per point measured **1.15x**
/// against the TypeScript, which builds them once in a closure. Hoisting is
/// what the ratio in phase 3's pull request is.
///
/// Results are identical either way, so nothing in tiers 1 to 3 could see it.
///
/// No `Debug` or `Clone`: [`OctaveTerms`] has neither, and deriving them here
/// would mean giving them to derived state whose shape is an implementation
/// detail.
///
/// Lives here rather than beside the first planet that needed it. It landed in
/// `expressions::fulgora_shared` in phase 3 and four Fulgora modules already
/// imported it from there; Vulcanus (#225) needs it too, and a Vulcanus module
/// reaching into a Fulgora one for a general multioctave utility would be the
/// wrong shape. Nothing about it is planet-specific.
pub struct Prepared {
    terms: OctaveTerms,
    grid: GridOctaveTerms,
    tables: BasisNoiseTables,
}

impl Prepared {
    #[must_use]
    pub fn new(params: &MultioctaveParams) -> Self {
        Self {
            terms: octave_terms(params),
            grid: grid_octave_terms(params),
            tables: tables_from_seed(params.seed0, params.seed1),
        }
    }

    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f32 {
        sum_octaves(x, y, &self.terms, &self.tables)
    }

    /// [`Self::eval`] at an [`At`]: the chunk-grid path for a tile, the point
    /// path otherwise. No offsets, because no caller of `Prepared` passes any.
    #[must_use]
    pub fn eval_at(&self, at: At) -> f32 {
        match at {
            At::Point { x, y } => self.eval(x, y),
            At::Grid { cx, cy, i, r } => {
                sum_octaves_grid((cx, cy), (i, r), (0.0, 0.0), &self.grid, &self.tables)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The chunk-grid path (#451). Read off Factorio 2.1.20's
// `NoiseOperations::MultioctaveNoise::run` (0x2525320) and graded against
// `test/fixtures/oracle-multioctave-grid.seed123456.json`.
// ---------------------------------------------------------------------------

/// The per-octave terms of the chunk-grid path.
///
/// **Not [`OctaveTerms`] with another name.** The scattered path folds the
/// octave's frequency into one f32 input scale, `input_scale * frac * 0.5^k`,
/// and multiplies the coordinate by it. The grid path keeps `input_scale` as
/// the kernel's own scale and carries the octave's factor in the kernel's
/// STEP and ORIGIN instead, so the coordinate is
/// `f32(f32(i * step + x0) * input_scale)` - a different rounding of the same
/// algebra. The amplitudes are the same chain.
pub struct GridOctaveTerms {
    input_scale: f32,
    steps: Vec<f32>,
    amps: Vec<f32>,
}

/// Derive the grid path's per-octave steps and amplitudes.
///
/// The step starts at the fractional-octave boost and halves each octave, in
/// f32; the amplitudes are [`octave_terms`]'s, unchanged. Both measured
/// against every octave call in the fixture, as the game passed them.
#[must_use]
pub fn grid_octave_terms(params: &MultioctaveParams) -> GridOctaveTerms {
    let OctaveTerms { amps, .. } = octave_terms(params);
    let mut step = frac_boost(params);
    let steps = amps
        .iter()
        .map(|_| {
            let s = step;
            step *= LACUNARITY;
            s
        })
        .collect();
    GridOctaveTerms {
        input_scale: params.input_scale as f32,
        steps,
        amps,
    }
}

/// Octave `k`'s kernel origin, from the op's origin (the chunk's world
/// origin plus `offset_x`/`offset_y`, added in f32).
///
/// `x = f32((k * 17.17) / f64(input_scale) + f64(f32(origin_x * step)))`.
/// The 17.17 shift is in NOISE units, so the grid path divides it by the input
/// scale to move it into the origin's world units - in f64, like the
/// scattered path's addition, and narrowed once. `y` carries no shift.
fn octave_origin(origin: (f32, f32), k: usize, step: f32, input_scale: f32) -> (f32, f32) {
    let shift = (k as f64) * OCTAVE_OFFSET_X / f64::from(input_scale);
    ((shift + f64::from(origin.0 * step)) as f32, origin.1 * step)
}

/// One chunk of `multioctave_noise` through the grid path, ADDED into `out`.
///
/// One [`basis_noise_grid_chunk`] call per octave, all into the same buffer,
/// which is the game's call sequence. `origin` is the chunk's world origin
/// plus the op's offsets, added in f32.
///
/// # Panics
///
/// If `out` holds fewer than `w * h` values.
pub fn multioctave_grid_chunk(
    origin: (f32, f32),
    w: u32,
    h: u32,
    terms: &GridOctaveTerms,
    tables: &BasisNoiseTables,
    out: &mut [f32],
) {
    for call in grid_kernel_calls(origin, terms) {
        basis_noise_grid_chunk(
            call.origin,
            w,
            h,
            call.step,
            terms.input_scale,
            call.amp,
            tables,
            out,
        );
    }
}

/// One grid-kernel call the multioctave grid path makes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GridKernelCall {
    pub origin: (f32, f32),
    pub step: f32,
    pub amp: f32,
}

/// The kernel calls, in order, for one chunk. Its own function so the
/// fixture can grade the arguments the game passed separately from the values
/// they produced.
pub(crate) fn grid_kernel_calls(
    origin: (f32, f32),
    terms: &GridOctaveTerms,
) -> Vec<GridKernelCall> {
    terms
        .steps
        .iter()
        .zip(terms.amps.iter())
        .enumerate()
        .map(|(k, (&step, &amp))| GridKernelCall {
            origin: octave_origin(origin, k, step, terms.input_scale),
            step,
            amp,
        })
        .collect()
}

/// One grid point of `multioctave_noise` through the grid path: what map
/// generation computes at column/row `index` of `chunk`.
///
/// The same arithmetic as [`multioctave_grid_chunk`] for the one grid point
/// the tile is, so a renderer can ask for a pixel without building a chunk.
/// `chunk` is the tile's chunk origin and `index` its column and row in it -
/// usually below 32, but a `multisample` reads the 33rd (see [`At::Grid`]).
#[must_use]
pub fn sum_octaves_grid(
    chunk: (i32, i32),
    index: (u32, u32),
    offset: (f32, f32),
    terms: &GridOctaveTerms,
    tables: &BasisNoiseTables,
) -> f32 {
    let ((cx, cy), (i, r)) = (chunk, index);
    let origin = (cx as f32 + offset.0, cy as f32 + offset.1);
    let mut out = 0.0f32;
    for (k, (&step, &amp)) in terms.steps.iter().zip(terms.amps.iter()).enumerate() {
        let (x0, y0) = octave_origin(origin, k, step, terms.input_scale);
        let nx = grid_coordinate(i, step, x0, terms.input_scale);
        let ny = grid_coordinate(r, step, y0, terms.input_scale);
        out += basis_noise_grid(nx, ny, tables) * amp;
    }
    out
}
