/**
 * A reimplementation of Factorio's `quick_multioctave_noise` primitive
 * (`NoiseExpressions::QuickMultioctaveNoise`), reverse-engineered against Factorio
 * 2.1.11 - by disassembling `QuickMultioctaveNoise::run` and fitting the committed
 * oracle. See docs/noise/quick-multioctave-noise-NOTES.md. Built on {@link basisNoise}.
 *
 * The shape:
 *
 *   quick(x, y) = SUM_{k=0}^{N-1}  OS*OOSM^k *
 *                 basis( (x + offset_x) * IS*OISM^k ,  y * IS*OISM^k ;
 *                        tables(octaveSeed0(seed0, seed1, k), seed1) )
 *
 * i.e. N octaves of `basis_noise`, each with input scale multiplied by
 * `octave_input_scale_multiplier` (OISM) and output contribution multiplied by
 * `octave_output_scale_multiplier` (OOSM). Unlike the plain `multioctave_noise`
 * op there is NO RMS normalisation (it is the "raw" building block; the
 * `quick_multioctave_noise_persistence` Lua wrapper pre-scales `input_scale` and
 * `output_scale` to compensate) and NO per-octave x offset in noise space - octaves
 * are decorrelated by re-seeding instead: each octave gets its own distinct basis
 * seed word, a flat `seed0 + k`; see {@link octaveSeed0} for the exact derivation
 * and the low-bit subtlety that once masked this.
 * `offset_x` is a single world-space x translation applied to every octave
 * (`(x + offset_x)` before scaling), NOT the k*17.17/offset_x per-octave shift the
 * plain / variable-persistence ops use.
 *
 * The temperature / moisture / aux climate trees use this op (each passes
 * `offset_x = <big> / var('control:<name>:frequency')`).
 *
 * **The arithmetic is f32, rounded after every operation.** This op used to
 * evaluate in pure f64 and score 38 of 190 exact against the committed oracle,
 * with a near/far split its spec blamed on "the game's f32 coordinate pipeline
 * diverges from our f64 - the documented f32 floor". There was no floor. The op
 * is now **190/190 bit-exact, worst error exactly 0**, and the near/far split is
 * gone with it - the same correction the plain and variable-persistence relatives
 * already took (see their notes, and `src/noise/eval/f32.ts`).
 *
 * Four ingredients, each measured load-bearing by turning it off alone and
 * re-scoring the whole fixture:
 *
 * | leave one out | exact |
 * | --- | --- |
 * | all four | **190/190** |
 * | params not narrowed to f32 | 109/190 |
 * | `amp * basis` not rounded before the add | 132/190 |
 * | scale/amp by `OISM**k` instead of a running chain | 143/190 |
 * | scale/amp chain steps not rounded | 137/190 |
 * | none of them (the old f64 shape) | 38/190 |
 *
 * Narrowing params matters because the callers' values have no exact f32 form -
 * `octave_output_scale_multiplier` 0.6/0.65/0.7, `input_scale` 0.1/0.08/(1/6),
 * `octave_input_scale_multiplier` 0.55. That is `f32.ts`'s "narrow the CONSTANT"
 * case, and no amount of rounding the result recovers it.
 *
 * Note what an error bound could not see here: dropping only the `amp * basis`
 * rounding leaves the worst residual at 4.8e-7 - visually perfect - while 58
 * points stop being bit-exact. Exact-match counting is the only scoring that
 * discriminates, which is why this op's spec now asserts counts and zeros.
 *
 * NOT wired into the app - a building block for a client-side map preview.
 */

import { basisNoise, basisNoiseTablesFromSeed, type BasisNoiseTables } from "./basisNoise";
import { f32 } from "./eval/f32";
import { fastPow } from "./fastApprox";

export interface QuickMultioctaveParams {
  /** Map seed (basis seed word). */
  readonly seed0: number;
  /** Per-call seed selector (distinguishes the many multioctave calls a program makes). */
  readonly seed1: number;
  /** Octave count (>= 1). */
  readonly octaves: number;
  /** Base input scale (noise units per world tile) for octave 0. */
  readonly inputScale: number;
  /** Overall output multiplier applied to octave 0. */
  readonly outputScale: number;
  /** Amplitude ratio between successive octaves (`octave_output_scale_multiplier`). */
  readonly octaveOutputScaleMultiplier: number;
  /** Input-scale ratio between successive octaves (`octave_input_scale_multiplier`). */
  readonly octaveInputScaleMultiplier: number;
  /** World-space x translation applied to every octave (`(x + offsetX)` before scaling). */
  readonly offsetX: number;
}

/**
 * The `seed0` to feed {@link basisNoiseTablesFromSeed} for octave `k`: a simple
 * per-octave `+1` on top of the map seed, `seed0 + k` (`>>> 0` keeps it an
 * unsigned 32-bit word). `seed1` is not part of this derivation - it is only
 * `basisNoiseTablesFromSeed`'s own `+ 7*(seed1>>8)` term (applied once there)
 * that folds `seed1` into the final basis word.
 *
 * An earlier version of this function derived a `phase = (7*(seed1>>8)) & 1`
 * and a "+2 every pair of octaves" cadence instead of a flat `+1`. That was a
 * mistaken over-fit: `taus88`'s `s1` update masks its input with
 * `0xfffffffe` (clears the low bit) before the first left-shift, so for an
 * EVEN starting word `W`, `basisNoiseTablesFromSeed(W, seed1)` and
 * `basisNoiseTablesFromSeed(W + 1, seed1)` happen to produce byte-identical
 * tables - which makes "+2 per pair" and "+1 per octave" numerically
 * indistinguishable whenever the pair's base word is even. Every prior oracle
 * capture used `seed0 = 123456` (even), so the coincidence was never exposed.
 * Task 10's tile-resolver parity test (3 seeds, one of them ODD - 654321)
 * caught it: per-octave isolation against the live game (quick_multioctave_noise
 * sampled at octaves=1..4 and differenced) showed octave 0 and 2 matching the
 * old formula but octaves 1 and 3 diverging by ~0.02-0.05 - exactly the two
 * octaves the old formula reused an even-derived word for, when the true word
 * for an ODD seed0 is one higher (odd) and does NOT collide. The flat `+1`
 * reproduces the live game to the basis floor for both parities, and remains
 * bit-identical to the old formula's output at seed 123456 (validated against
 * the full `oracle-quick-multioctave` fixture, including its one phase>=1
 * case, seed1=999).
 */
function octaveSeed0(seed0: number, _seed1: number, k: number): number {
  return (seed0 + k) >>> 0;
}

/** The per-octave tables, input scales and amplitudes, plus the f32 x offset. */
interface QuickOctaves {
  readonly tables: BasisNoiseTables[];
  readonly scales: number[];
  readonly amps: number[];
  readonly offsetX: number;
}

/**
 * Derive the per-octave terms exactly as `QuickMultioctaveNoise::run` emits them.
 *
 * `run` is a register-program builder, not a runtime loop: it unrolls N explicit
 * `BasisNoise` ops, multiplying the running input scale (`s8 *= s12`) and output
 * scale (`s9 *= s13`) per octave. Those registers are **f32**, so the chain is a
 * chain - each step rounds, and the k-th scale is not `input_scale * OISM**k`.
 * That distinction is worth 143/190 against 190/190, so it is measured rather
 * than stylistic; see the table in the module header.
 *
 * The four incoming parameters are narrowed here because the game holds them in
 * f32 constant slots, and the values callers actually pass (0.6, 0.65, 0.7, 0.1,
 * 0.08, 1/6, 0.55) have no exact f32 form.
 *
 * Every octave gets its own distinct seed word (flat `seed0 + k`), so the tables
 * are built once per octave here rather than cached against the previous word -
 * consecutive octaves never share one. See {@link octaveSeed0}.
 */
function octaveTerms(params: QuickMultioctaveParams): QuickOctaves {
  const { seed0, seed1, octaves } = params;
  const oism = f32(params.octaveInputScaleMultiplier);
  const oosm = f32(params.octaveOutputScaleMultiplier);

  const tables: BasisNoiseTables[] = [];
  const scales: number[] = [];
  const amps: number[] = [];
  let scale = f32(params.inputScale);
  let amp = f32(params.outputScale);
  for (let k = 0; k < octaves; k++) {
    tables.push(basisNoiseTablesFromSeed(octaveSeed0(seed0, seed1, k), seed1));
    scales.push(scale);
    amps.push(amp);
    scale = f32(scale * oism);
    amp = f32(amp * oosm);
  }
  return { tables, scales, amps, offsetX: f32(params.offsetX) };
}

/**
 * Sum the octaves in the game's order, rounding to f32 after every operation.
 *
 * Two roundings here carry the bulk of the fix, and both were confirmed by
 * removing them one at a time and re-scoring the whole fixture:
 *
 * - **`amp * basis(...)` is rounded before it is added.** Each is its own
 *   register op, so the product lands in f32 before the accumulate. Dropping
 *   just this one costs 58 exact matches (190 -> 132) while leaving the worst
 *   residual at 4.768e-7 - which is exactly why this op is scored by exact
 *   count and not by a bound.
 * - **The running total is f32.** `out[i] = out[i] + ...` in the vector kernel,
 *   never an f64 accumulator narrowed once on return.
 *
 * `x + offset_x` is hoisted out of the loop because it does not depend on k;
 * that is the same arithmetic, not a shortcut. **Whether the game rounds that
 * add before the multiply is NOT resolved by this fixture** - narrowing only
 * the product scores 190/190 and worst 0 as well, because every
 * `(position + offset_x)` the fixture uses is already exact in f32. The inner
 * narrowing is kept because it is what a register machine does and what
 * {@link variablePersistenceMultioctaveNoise}'s identical `(x + offset_x)`
 * step does; a caller passing a derived x is where the two forms would part,
 * and no fixture covers that yet.
 *
 * The incoming `x`/`y` are narrowed for the reason #191 gives - the noise
 * machine hands every expression an f32 - but note this fixture cannot see
 * that either: all 38 of its positions are already on the f32 grid, and
 * turning the narrowing off leaves the score at 190/190.
 */
function sumOctaves(x: number, y: number, t: QuickOctaves): number {
  const xo = f32(f32(x) + t.offsetX);
  const yf = f32(y);
  let sum = 0;
  for (let k = 0; k < t.scales.length; k++) {
    const s = t.scales[k];
    sum = f32(sum + f32(t.amps[k] * basisNoise(f32(xo * s), f32(yf * s), t.tables[k])));
  }
  return sum;
}

/**
 * Evaluate `quick_multioctave_noise` at world coordinates `(x, y)`. Bit-exact
 * against the committed oracle: 190/190, worst error 0.
 */
export function quickMultioctaveNoise(
  x: number,
  y: number,
  params: QuickMultioctaveParams,
): number {
  return sumOctaves(x, y, octaveTerms(params));
}

/**
 * Build a closure that evaluates `quick_multioctave_noise` for a fixed parameter set,
 * with the per-octave basis tables, input scales and amplitudes derived once up front
 * (the common case for rendering a grid at one seed). Returns `(x, y) => number`,
 * numerically identical to {@link quickMultioctaveNoise} - both route through the same
 * {@link octaveTerms} / {@link sumOctaves} pair, so they cannot drift apart.
 */
export function makeQuickMultioctaveNoise(
  params: QuickMultioctaveParams,
): (x: number, y: number) => number {
  const t = octaveTerms(params);
  return (x: number, y: number): number => sumOctaves(x, y, t);
}

/**
 * The noise machine's `^`, in f32.
 *
 * It is **three different functions**, dispatched on the exponent - exact
 * exponentiation by squaring for an integer, exact `sqrt` for 0.5, and
 * fastapprox (`Math::powSafe`) otherwise. That was settled against
 * `oracle-fastpow.seed123456.json` at 123/123 per branch (#161, #163), and the
 * 0.5 case was a refutation of the then-current model rather than a
 * confirmation - do not collapse these back into one call.
 *
 * Only the integral branch is exercised by anything here (`octaves` is a whole
 * number in every base-game caller), but the other two are spelled out because
 * a wrong branch is silent: it returns a plausible number.
 */
function noiseMachinePow(base: number, exponent: number): number {
  if (exponent === 0.5) return f32(Math.sqrt(f32(base)));
  if (!Number.isInteger(exponent) || exponent < 0) return f32(fastPow(f32(base), f32(exponent)));
  let result = 1;
  let b = f32(base);
  let e = exponent;
  while (e > 0) {
    if (e & 1) result = f32(result * b);
    b = f32(b * b);
    e >>= 1;
  }
  return result;
}

export interface QuickMultioctavePersistenceParams {
  /** Map seed (basis seed word). */
  readonly seed0: number;
  /** Per-call seed selector. */
  readonly seed1: number;
  /** Octave count (>= 1). */
  readonly octaves: number;
  /** Base input scale (noise units per world tile). */
  readonly inputScale: number;
  /** Overall output multiplier. */
  readonly outputScale: number;
  /** Input-scale ratio between successive octaves. */
  readonly octaveInputScaleMultiplier: number;
  /** Amplitude ratio between successive octaves. */
  readonly persistence: number;
}

/**
 * `quick_multioctave_noise_persistence` - the Lua wrapper
 * (`core/prototypes/noise-functions.lua`) over {@link quickMultioctaveNoise}. It
 * normalises the raw quick op by pre-scaling `input_scale` and `output_scale`, and
 * maps `persistence` to the octave output multiplier:
 *
 *   input_scale  = input_scale * octave_input_scale_multiplier^(octaves - 1)
 *   output_scale = output_scale * 2^(octaves - 1)
 *   octave_output_scale_multiplier = persistence
 *   octave_input_scale_multiplier  = 1 / octave_input_scale_multiplier
 *
 * so the finest octave lands at `input_scale` and the sum is `2^(N-1)`-scaled. The
 * elevation tree's `starting_lake_noise` uses this. `offset_x` defaults to 0.
 *
 * **The transform is f32, not f64, and that is worth 1.964e-3.** It is tempting
 * to read "Lua wrapper" as "Lua arithmetic, therefore doubles". It is not: the
 * wrapper is a `noise-function` whose body is an *expression string*
 * (`core/prototypes/noise-functions.lua`), which the game's noise machine
 * compiles and folds - in f32, one operation at a time, like everything else it
 * evaluates. Doing the transform in f64 left this wrapper at 114/152 exact and
 * worst 1.964e-3 even after the op underneath it became bit-exact; doing it in
 * f32 makes it **152/152, worst 0**.
 *
 * `^` here has an integral exponent, and the noise machine's `^` is three
 * different functions selected by that exponent - exact exponentiation by
 * squaring for integers, exact `sqrt` for 0.5, fastapprox otherwise (#161,
 * #163). {@link noiseMachinePow} implements that dispatch. **This fixture cannot
 * discriminate the integral branch**: `Math.pow` narrowed to f32 also scores
 * 152/152 here, because the only bases are 0.5 and 0.6 at exponents 0, 2, 3 and
 * 4. Squaring is used because it is what the game does, not because the fixture
 * chose it.
 */
export function quickMultioctaveNoisePersistence(
  x: number,
  y: number,
  params: QuickMultioctavePersistenceParams,
): number {
  return makeQuickMultioctaveNoisePersistence(params)(x, y);
}

/**
 * Build a closure that evaluates `quick_multioctave_noise_persistence` for a fixed
 * parameter set, with the per-octave basis tables derived once up front (the common
 * case for rendering a grid at one seed). Applies the same param transform as
 * {@link quickMultioctaveNoisePersistence} but delegates to
 * {@link makeQuickMultioctaveNoise} so the tables are hoisted. Returns `(x, y) => number`.
 */
export function makeQuickMultioctaveNoisePersistence(
  params: QuickMultioctavePersistenceParams,
): (x: number, y: number) => number {
  const { octaves, octaveInputScaleMultiplier: oism } = params;
  const oismF = f32(oism);
  return makeQuickMultioctaveNoise({
    seed0: params.seed0,
    seed1: params.seed1,
    octaves,
    inputScale: f32(f32(params.inputScale) * noiseMachinePow(oismF, octaves - 1)),
    outputScale: f32(f32(params.outputScale) * noiseMachinePow(2, octaves - 1)),
    octaveOutputScaleMultiplier: f32(params.persistence),
    octaveInputScaleMultiplier: f32(1 / oismF),
    offsetX: 0,
  });
}
