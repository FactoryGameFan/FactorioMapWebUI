/**
 * A reimplementation of Factorio's `multioctave_noise` primitive (the plain
 * `NoiseOperations::MultioctaveNoise`), reverse-engineered against Factorio 2.1.11
 * - partly by disassembling `Noise::multioctaveNoise`, partly by fitting the
 * oracle. See docs/noise/multioctave-noise-NOTES.md. Built on top of
 * {@link basisNoise}.
 *
 * The shape:
 *
 *   multioctave(x, y) = SUM_{k=0}^{N-1} amp_k *
 *                       basis( f32(k*OCTAVE_OFFSET_X + f32(x*IS_k)) , f32(y*IS_k) )
 *
 *   IS_0  = input_scale,  IS_{k+1} = f32(IS_k * 1/2)
 *   amp_0 = output_scale * norm,  amp_{k+1} = f32(amp_k / P)
 *
 * i.e. N octaves of `basis_noise` sharing ONE (seed0, seed1): each octave halves
 * the input scale (lacunarity 1/2), scales amplitude by 1/persistence, and shifts
 * x by a fixed per-octave offset (this is what decorrelates same-seed octaves -
 * the comment "'x' variables are shifted to avoid 'fractal similarity'" in the
 * game's noise programs). The whole sum is RMS-normalised by `norm` so its
 * variance is ~1 regardless of octave count / persistence.
 *
 * **The arithmetic is f32, and the octave offset is small.** Both matter and they
 * only pay off together - see {@link OCTAVE_OFFSET_X} and
 * docs/noise/multioctave-noise-NOTES.md. Worst error against the committed oracle
 * is 7.2e-7 over 266 samples; the remainder is {@link basisNoise}'s own f64
 * evaluation, not this composition (a single octave already carries it).
 *
 * The normalisation uses Factorio's approximate `log2`/`exp2` (Paul Mineiro
 * fastapprox), replicated here as {@link fastLog2} / {@link fastPow2}; with a real
 * `pow` the error would be ~1e-4 for non-power-of-two persistence.
 *
 * NOT wired into the app. Building block for a client-side map preview.
 */

import { basisNoise, basisNoiseTablesFromSeed, type BasisNoiseTables } from "./basisNoise";
// The fastapprox log2/exp2/pow primitives moved to ./fastApprox (the resource
// spot-height/blob-amplitude expressions need the same fast cbrt); re-exported here
// for the existing importers and tests.
import { fastLog2, fastPow2 } from "./fastApprox";

export { fastLog2, fastPow2 };

/** Each octave halves the input scale (doubles the wavelength). */
const LACUNARITY = 0.5;

/**
 * Per-octave x shift in noise space, added as `k * OCTAVE_OFFSET_X` for octave k.
 * The literal double immediate in `Noise::fastVectorMultioctaveNoise`
 * (`0x40312b851eb851ec`), which is exactly `17.17`.
 *
 * **This used to be `-1774.83`, and the difference is the whole bug.** The basis
 * lattice has period 256 on each axis, and `17.17 - 1774.83 == -1792 == -7*256`,
 * so the two are the *same field value* - a wide oracle fit cannot tell them
 * apart, and it landed on the alias. In f64 they are interchangeable (measured:
 * bit-identical over the whole fixture). In f32 they are not remotely: by octave
 * 5 the aliased coordinate is ~-8874, where a f32 ulp is 1.1e-3, against 2.0e-6
 * for the true +85.85. Since the game rounds each octave's x to f32, the alias
 * capped the achievable accuracy at ~1e-4 - which the notes recorded as an
 * irreducible "f32 floor" and it never was one.
 *
 * That is also why reproducing the game's f32 op order kept making things *worse*
 * (five variants, 12x-27x): with the alias in place, rounding to f32 is exactly
 * the wrong move. The two fixes only pay off together.
 *
 * The `quick`/`variable_persistence` variants take an `offset_x` parameter with
 * different semantics - see their own notes. NOTE `variablePersistenceMultioctaveNoise`
 * carries a fitted `-7936 == -31*256`, which is an alias of 0 and so is very
 * likely the same defect; it is untouched here and tracked separately.
 */
const OCTAVE_OFFSET_X = 17.17;

/**
 * Upper clamp on the fractional-octave frequency boost. The binary compares the
 * widened result against the double `1.99999` and substitutes the f32 nearest
 * `1.99999` (`0x3FFFFFAC`) when it is not below; the lower clamp is a plain 1.0.
 */
const FRAC_OCTAVE_MAX = Math.fround(1.99999);

export interface MultioctaveParams {
  /** Map seed. */
  readonly seed0: number;
  /** Per-call seed selector (distinguishes the many multioctave calls a program makes). */
  readonly seed1: number;
  /** Octave count (>= 1). */
  readonly octaves: number;
  /** Amplitude ratio between successive octaves' contributions (0 < P < 1 typical). */
  readonly persistence: number;
  /** Base input scale (noise units per world tile) for the finest octave. */
  readonly inputScale: number;
  /** Overall output multiplier. */
  readonly outputScale: number;
}

const f32 = Math.fround;

/**
 * The per-octave input scales and amplitudes, derived exactly as
 * `Noise::fastVectorMultioctaveNoise` derives them before its octave loop.
 *
 * Three details are read off the arm64 rather than inferred:
 *
 * - **The octave count is `ceil(octaves)`** (`frintp`), and a fractional octave
 *   count multiplies the *input scale* - not the amplitude - by
 *   `clamp(fastPow2(ceil(N) - N), 1, 2)`. Inert for integral `octaves`, which is
 *   all the oracle fixture covers; implemented because the binary does it.
 * - **The RMS ratio is computed in f32, but its `sqrt` and the `output_scale`
 *   multiply are done in f64** and rounded once (`fcvt d0,s0; fsqrt d0; fmul d0,d1;
 *   fcvt s10,d0`). Doing the whole thing in one precision is wrong either way.
 * - **`output_scale` is folded into the starting amplitude**, not applied to the
 *   finished sum - so it takes part in the f32 amplitude chain.
 *
 * The game branches on `1/P`, not on `P`: `1/P == 1` takes the `1/sqrt(N)` branch
 * (the ratio would be 0/0), and `1/P == 0` skips normalisation entirely.
 */
function octaveTerms(params: MultioctaveParams): {
  n: number;
  scales: number[];
  amps: number[];
} {
  const { octaves, persistence, inputScale, outputScale } = params;
  const n = Math.ceil(octaves);
  const invP = f32(1 / persistence);

  let amp: number;
  if (invP === 1) {
    amp = f32(outputScale / Math.sqrt(n));
  } else if (invP !== 0) {
    const invP2 = f32(invP * invP);
    const pow = f32(fastPow2(f32(fastLog2(invP2) * f32(n))));
    const ratio = f32(f32(invP2 - 1) / f32(pow - 1));
    amp = f32(Math.sqrt(ratio) * outputScale);
  } else {
    amp = f32(outputScale);
  }

  // A fractional octave count boosts the base frequency; exactly 1 when integral.
  const frac = Math.min(Math.max(f32(fastPow2(f32(n - octaves))), 1), FRAC_OCTAVE_MAX);
  let scale = f32(f32(inputScale) * frac);

  const scales: number[] = [];
  const amps: number[] = [];
  for (let k = 0; k < n; k++) {
    scales.push(scale);
    amps.push(amp);
    scale = f32(scale * LACUNARITY);
    amp = f32(invP * amp);
  }
  return { n, scales, amps };
}

/**
 * Sum the octaves in the game's order: each octave's contribution is rounded to
 * f32 and added to an f32 running total (`out[i] = out[i] + amp*basis(...)` in
 * `Noise::noise`'s vector kernel), never accumulated in f64 and rounded at the end.
 *
 * The x coordinate is the one place f64 appears inside the loop, and it is
 * deliberate: the offset is `(double)k * 17.17` added to the *widened* f32 product
 * `f32(x*scale)`, with the sum narrowed back to f32.
 */
function sumOctaves(
  x: number,
  y: number,
  n: number,
  scales: number[],
  amps: number[],
  tables: BasisNoiseTables,
): number {
  let out = 0;
  for (let k = 0; k < n; k++) {
    const scale = scales[k];
    const xk = f32(k * OCTAVE_OFFSET_X + f32(x * scale));
    const yk = f32(y * scale);
    out = f32(out + f32(amps[k] * basisNoise(xk, yk, tables)));
  }
  return out;
}

/**
 * Evaluate `multioctave_noise` at world coordinates `(x, y)`. Pass a prebuilt
 * `tables` to skip the per-call seed derivation when sweeping many points at one
 * seed (the common case for rendering).
 */
export function multioctaveNoise(
  x: number,
  y: number,
  params: MultioctaveParams,
  tables: BasisNoiseTables = basisNoiseTablesFromSeed(params.seed0, params.seed1),
): number {
  const { n, scales, amps } = octaveTerms(params);
  return sumOctaves(x, y, n, scales, amps, tables);
}

/**
 * Build a closure that evaluates `multioctave_noise` for a fixed parameter set,
 * with the basis tables, the RMS normalisation, and the per-octave input scales /
 * amplitudes derived once up front (the common case for rendering a grid at one
 * seed). Returns `(x, y) => number`, numerically identical to {@link multioctaveNoise}
 * - both route through the same {@link octaveTerms} / {@link sumOctaves} pair so they
 * cannot drift apart.
 */
export function makeMultioctaveNoise(params: MultioctaveParams): (x: number, y: number) => number {
  const tables = basisNoiseTablesFromSeed(params.seed0, params.seed1);
  const { n, scales, amps } = octaveTerms(params);
  return (x: number, y: number): number => sumOctaves(x, y, n, scales, amps, tables);
}
