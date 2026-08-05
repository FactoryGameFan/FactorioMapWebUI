/**
 * A reimplementation of Factorio's `variable_persistence_multioctave_noise`
 * primitive (`NoiseOperations::VariablePersistenceMultioctaveNoise`),
 * reverse-engineered against Factorio 2.1.11 - by disassembling its register
 * `run` (`NoiseOperations::VariablePersistenceMultioctaveNoise::run` @0x10174a318)
 * and fitting the committed oracle. See
 * docs/noise/variable-persistence-multioctave-noise-NOTES.md. Built on
 * {@link basisNoise}.
 *
 * This is the op the **elevation** tree uses (nauvis `make_0_12like_lakes`). Its
 * defining feature: `persistence` is a spatially-varying value (a noise
 * *expression* the game evaluates per tile), so successive octaves are attenuated
 * by a persistence that changes across the map. Here the caller supplies that
 * per-tile `persistence` scalar.
 *
 * The shape:
 *
 *   varPers(x, y) = f32( gain * HORNER_{k=0..N-1} basis( f32(f32(x + offset_x)*S_k) ,
 *                                                        f32(y*S_k) ) )
 *
 *     S_0   = f32(input_scale * 0.5)     (finest octave scale = input_scale/2)
 *     S_k+1 = f32(S_k * 0.5)
 *     gain  = output_scale * 2^N
 *     p     = persistence at this tile
 *     N     = octaves
 *
 * i.e. N octaves of `basis_noise` sharing ONE (seed0, seed1) - each octave halves
 * the input scale (lacunarity 1/2) and is weighted by a power of the per-tile
 * persistence, combined in Horner order (finest octave gets the smallest weight
 * p^(N-1), coarsest gets 1), with every step rounded to f32. Two things
 * distinguish it from the relatives:
 *
 * 1. **No RMS normalisation.** It is the raw weighted sum times a `2^N` gain. The
 *    `amplitude_corrected_multioctave_noise` Lua wrapper is what normalises, by
 *    passing `output_scale = (1 - p)/2^N/(1 - p^N) * amplitude`. (The RMS-norm
 *    branch in the `Noise::multioctaveNoise(...,float const*,...)` float overload
 *    is a *different* entry point; the register `run` path the game evaluates via
 *    `calculate_tile_properties` has none.)
 * 2. **`offset_x` is a single world-space x translation** `(x + offset_x)*scale`,
 *    applied identically to every octave - like `quick_multioctave_noise`.
 *
 * **There is NO per-octave x shift.** This file used to carry a fitted
 * `k*(-7936)`; `::run`'s octave loop reloads the x/y offsets from the same two
 * constant slots every iteration and has no counter-scaled term at all. See the
 * comment on the removal below - the fitted value was an alias of zero.
 *
 * Verified against the game at **1.1e-5 worst over all 266 oracle samples**, and
 * that residual is `basisNoise`'s own f32 floor amplified by this op's gain, not a
 * modelling gap: `worst/gain` is 1.2e-7 to 2.4e-7 - one to two f32 ulps - in every
 * one of the seven cases, including the two with `offset_x` of 5000 and 40000.
 * NOT wired into the app - a building block for a client-side map preview.
 */

import { basisNoise, basisNoiseTablesFromSeed, type BasisNoiseTables } from "./basisNoise";

/**
 * `OCTAVE_SHIFT` is GONE, and its absence is the fix.
 *
 * It was `-7936`, fitted as "independent of seed, input_scale, offset_x and
 * persistence to the noise floor". The fit was not measuring a shift - it was
 * measuring nothing. The basis lattice has period 256 per axis, and
 * `-7936 == -31 * 256`, so it names the same field as a shift of **zero**. The
 * old comment's own "false minima near -4864 / -3840" are `-19*256` and `-15*256`
 * - every candidate the scan surfaced was a multiple of 256, which is what a
 * completely flat fit direction looks like from the inside.
 *
 * `VariablePersistenceMultioctaveNoise::run`'s octave loop settles it: it reloads
 * the x and y offsets from the same two constant slots (`+0xa2c`, `+0xa30`) on
 * every iteration and contains no counter-scaled term. There is no per-octave
 * shift; octaves decorrelate through lacunarity alone.
 *
 * In f64 removing it changes nothing (measured: identical worst and identical
 * f32-exact count). In f32 it is the difference between **3.6e-1 and 1.1e-5** -
 * a shift of -7936*5 lands where an f32 ulp is ~3.9e-3. Same defect and same
 * pairing as the plain op's `-1774.83`; see docs/noise/multioctave-noise-NOTES.md.
 */
const f32 = Math.fround;

export interface VariablePersistenceMultioctaveParams {
  /** Map seed (basis seed word). */
  readonly seed0: number;
  /** Per-call seed selector (distinguishes the many multioctave calls a program makes). */
  readonly seed1: number;
  /** Octave count (>= 1). */
  readonly octaves: number;
  /** Base input scale (noise units per world tile); octave 0 uses `input_scale/2`. */
  readonly inputScale: number;
  /** Overall output multiplier (the op additionally applies a `2^octaves` gain). */
  readonly outputScale: number;
  /** World-space x translation applied to every octave (`(x + offsetX)` before scaling). */
  readonly offsetX: number;
}

/**
 * Evaluate `variable_persistence_multioctave_noise` at world coordinates `(x, y)`
 * with a per-tile `persistence`. Pass a prebuilt `tables` to skip the seed
 * derivation when sweeping many points at one seed (the common case for rendering);
 * the seed is shared across octaves, so a single tables object serves them all.
 *
 * The octaves are combined in Horner order exactly as the game's `run` does (add
 * the octave, then multiply the running accumulator by the tile's persistence -
 * except after the last octave), so octave k carries weight `p^(N-1-k)`.
 */
export function variablePersistenceMultioctaveNoise(
  x: number,
  y: number,
  persistence: number,
  params: VariablePersistenceMultioctaveParams,
  tables: BasisNoiseTables = basisNoiseTablesFromSeed(params.seed0, params.seed1),
): number {
  const { octaves, inputScale, outputScale, offsetX } = params;

  let acc = 0;
  let scale = f32(f32(inputScale) * 0.5); // octave 0 = input_scale / 2
  for (let k = 0; k < octaves; k++) {
    acc = f32(acc + basisNoise(f32(f32(x + offsetX) * scale), f32(y * scale), tables));
    if (k < octaves - 1) acc = f32(acc * persistence);
    scale = f32(scale * 0.5);
  }
  return f32(acc * f32(outputScale * 2 ** octaves));
}

/**
 * Build a closure that evaluates `variable_persistence_multioctave_noise` for a
 * fixed parameter set, with the per-octave scales (and the shared basis tables)
 * derived once up front (the common case for rendering a grid at one seed). The
 * returned function takes `(x, y, persistence)` - persistence still varies per tile.
 */
export function makeVariablePersistenceMultioctaveNoise(
  params: VariablePersistenceMultioctaveParams,
): (x: number, y: number, persistence: number) => number {
  const { seed0, seed1, octaves, inputScale, outputScale, offsetX } = params;
  const tables = basisNoiseTablesFromSeed(seed0, seed1);
  const gain = f32(outputScale * 2 ** octaves);

  const octaveScale: number[] = [];
  let scale = f32(f32(inputScale) * 0.5);
  for (let k = 0; k < octaves; k++) {
    octaveScale.push(scale);
    scale = f32(scale * 0.5);
  }

  return (x: number, y: number, persistence: number): number => {
    let acc = 0;
    for (let k = 0; k < octaves; k++) {
      const s = octaveScale[k];
      acc = f32(acc + basisNoise(f32(f32(x + offsetX) * s), f32(y * s), tables));
      if (k < octaves - 1) acc = f32(acc * persistence);
    }
    return f32(acc * gain);
  };
}

export interface AmplitudeCorrectedMultioctaveParams {
  /** Map seed (basis seed word). */
  readonly seed0: number;
  /** Per-call seed selector. */
  readonly seed1: number;
  /** Octave count (>= 1). */
  readonly octaves: number;
  /** Base input scale (noise units per world tile); octave 0 uses `input_scale/2`. */
  readonly inputScale: number;
  /** World-space x translation applied to every octave. */
  readonly offsetX: number;
  /** Constant persistence (amplitude ratio between successive octaves). */
  readonly persistence: number;
  /** Target output amplitude (the corrected sum is scaled to roughly this). */
  readonly amplitude: number;
}

/**
 * `amplitude_corrected_multioctave_noise` - the Lua wrapper
 * (`core/prototypes/noise-functions.lua`) over
 * {@link variablePersistenceMultioctaveNoise}. It just chooses the op's
 * `output_scale` so the `2^N`-gained geometric sum ends up at roughly `amplitude`:
 *
 *   output_scale = (1 - p) / 2^N / (1 - p^N) * amplitude
 *
 * (the `1 - p^N` is the geometric-series sum of the octave weights; the `/2^N`
 * cancels the op's gain). The wrapper's `persistence` is a constant here - and the
 * game's degenerate constant-persistence path yields the same math as the variable
 * op (verified against the oracle to the basis floor), so this is a direct call.
 *
 * At `p == 1` the `(1 - p)/(1 - p^N)` ratio is 0/0; its limit is `1/N`, so
 * `output_scale = amplitude / (N * 2^N)`.
 *
 * The elevation tree uses this to build the *persistence field* it then feeds to
 * `make_0_12like_lakes` (`persistence = clamp(amplitude_corrected... + 0.3, 0.1, 0.9)`).
 */
export function amplitudeCorrectedMultioctaveNoise(
  x: number,
  y: number,
  params: AmplitudeCorrectedMultioctaveParams,
  tables: BasisNoiseTables = basisNoiseTablesFromSeed(params.seed0, params.seed1),
): number {
  const { octaves, persistence: p, amplitude } = params;
  const ratio = p === 1 ? 1 / octaves : (1 - p) / (1 - p ** octaves);
  const outputScale = (ratio / 2 ** octaves) * amplitude;
  return variablePersistenceMultioctaveNoise(
    x,
    y,
    p,
    {
      seed0: params.seed0,
      seed1: params.seed1,
      octaves,
      inputScale: params.inputScale,
      outputScale,
      offsetX: params.offsetX,
    },
    tables,
  );
}
