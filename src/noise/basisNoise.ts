/**
 * A reimplementation of Factorio's `basis_noise` primitive.
 *
 * Reverse-engineered against Factorio 2.1.11. See
 * docs/noise/basis-noise-NOTES.md for the derivation and the evidence.
 *
 * **Evaluates in f32 with the game's own operation order** (#214). It used to
 * evaluate in f64 with `(1 - d) ** 3` and a left-to-right sum, which is a
 * different function - measurably, not just in principle. Scored by exact f32
 * match count against the 512-point fixture, because every value in it is
 * exactly f32 and so a bound cannot tell "close" from "identical":
 *
 * | shape | exact | worst abs |
 * | --- | --- | --- |
 * | old: f64, `(1-d)**3`, left to right | 132/512 | 3.110e-7 |
 * | f32, `t*(t*t)`, row-pairwise fold, FORMULA table | 473/512 | 1.192e-7 |
 * | this: the same kernel, MEASURED table (#234) | **512/512** | **0** |
 *
 * The last 39 points were never our arithmetic. They were the game's own
 * gradient table, which #234 recovered from a running game rather than fitting
 * a formula to it; the kernel below did not change and the misses went away.
 * On the seed-derived `oracle-basis` fixture it is likewise 38/38, worst 0.
 *
 * Do not read those two zeros as slack to spend. They are asserted as `toBe(0)`
 * and `toBe(512)` in test/basisNoise.spec.ts and test/oracle/oracle.spec.ts, so
 * anything less is a regression with nowhere left to hide - the "that is the
 * game's table, not us" allowance that covered the 39 is gone.
 *
 * The `(seed0, seed1) -> tables` derivation is also solved:
 * `basisNoiseTablesFromSeed` builds `a`/`b`/`sigma` straight from the seed (no
 * game round-trip), matching the disassembly of `Noise::setSeed` and verified
 * against the game across the seed combine, the low-byte salt and the clamp.
 */
import { GRADIENT_X, GRADIENT_Y } from "./basisGradientTable";
import { seededState, taus88Next } from "./taus88";

/** Number of gradient directions, and the period of the hash on each axis. */
const TABLE_SIZE = 256;

/**
 * Narrow to f32. The game's noise machine is f32 end to end, and this kernel
 * rounds after every operation rather than once at the end - an f64 chain
 * narrowed only on return is a different function, worth 2.6x in worst error
 * here.
 */
const f = Math.fround;

/**
 * The per-seed tables. `a` and `b` are the per-axis permutation tables of
 * Kensler's "Better Gradient Noise" hash (`h = a[i] ^ b[j]`); `sigma` maps that
 * hash to a gradient direction index.
 *
 * Build them from a seed with `basisNoiseTablesFromSeed`, or hand-supply a
 * gauge-equivalent set (the three tables are only determined up to a gauge, so
 * they need not be the game's literal internals; they reproduce its output
 * exactly, which is what matters here).
 */
export interface BasisNoiseTables {
  /** Hash value -> gradient direction index. Permutation of 0..255. */
  readonly sigma: readonly number[];
  /** X-axis permutation table. */
  readonly a: readonly number[];
  /** Y-axis permutation table. */
  readonly b: readonly number[];
}

/**
 * Evaluate `basis_noise` at a point in *noise space* - callers apply
 * `input_scale` themselves (noise coords = world coords * input_scale), exactly
 * as the game's `basis_noise{input_scale = ...}` parameter does.
 *
 * Returns 0 at integer lattice points, which is the game's documented quirk and
 * falls out of the kernel rather than being special-cased.
 */
export function basisNoise(x: number, y: number, tables: BasisNoiseTables): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = f(x - ix);
  const fy = f(y - iy);

  // Summation over the 4 cell corners, simplex-style, rather than Perlin's
  // separable interpolation: the (1-d)^3 falloff reaches exactly 0 at d = 1, so
  // corners further than one unit contribute nothing.
  const corner = (cornerX: number, cornerY: number): number => {
    const dx = f(fx - cornerX);
    const dy = f(fy - cornerY);
    const d = f(f(dx * dx) + f(dy * dy));
    // The game is branchless here - two corners share a NEON register, so a
    // far corner is SELECTED to zero rather than skipped. Written as an early
    // return because the result is what matters, not the lane trick: past
    // d = 1 the falloff would go negative and SUBTRACT a contribution.
    if (!(d < 1)) return 0;

    const t = f(1 - d);
    // `t * (t * t)`, not `t ** 3`. Not the same function: #214 folded 4M
    // results and got `01efaddf3f789c57` for `x*x*x` against
    // `01efaddf3fdbc55d` for `powf(3.0)`, and the game's two `fmul`s say which
    // one it is.
    const falloff = f(t * f(t * t));

    const hash =
      tables.a[(ix + cornerX) & (TABLE_SIZE - 1)] ^ tables.b[(iy + cornerY) & (TABLE_SIZE - 1)];
    const g = tables.sigma[hash & (TABLE_SIZE - 1)];
    // The magnitude is folded into the table, which the fixture discriminates:
    // see scripts/gen-gradient-table.ts.
    const dot = f(f(dx * GRADIENT_X[g]) + f(dy * GRADIENT_Y[g]));
    return f(dot * falloff);
  };

  // Pairwise, not left to right: the game adds two corners at a time and folds
  // the pair last. Which two is measured rather than read off the disassembly -
  // pairing the corners that share a `cornerY` scores 473/512 exact against
  // 353 for the other pairing, 345 diagonally and 406 left-to-right.
  const rowY0 = f(corner(0, 0) + corner(1, 0));
  const rowY1 = f(corner(0, 1) + corner(1, 1));
  return f(rowY0 + rowY1);
}

// ---------------------------------------------------------------------------
// Seed -> tables. Straight from the disassembly of Factorio 2.1.11's
// `Noise::setSeed(uint, uchar)` and `Noise::noise` (arm64 slice). The three
// tables and the salt are built by shuffling identity permutations with one
// continuous taus88 stream seeded from the map seed; see the notes.
// ---------------------------------------------------------------------------

/**
 * All-zero state is a taus88 fixed point, so the seed word is clamped from below
 * to 0x155 (the same clamp `spot_noise` uses). This is why every seed in
 * `0..341` produces the same field, and why `seed0`'s bit 0 is dead (the taus88
 * state words drop their low bits on the first step).
 */
const MIN_SEED_WORD = 0x155;

/**
 * A backward (Durstenfeld) Fisher-Yates shuffle of `identity[0..255]`, drawing
 * 255 values from the stream: for `pos` from 255 down to 1, swap slot `pos` with
 * `next() % (pos + 1)`. This is exactly the shuffle the game applies to each of
 * its four tables, all off one continuous stream.
 */
function shuffleIdentity(next: () => number): number[] {
  const t = Array.from({ length: TABLE_SIZE }, (_, i) => i);
  for (let pos = TABLE_SIZE - 1; pos >= 1; pos--) {
    const j = next() % (pos + 1);
    const tmp = t[pos];
    t[pos] = t[j];
    t[j] = tmp;
  }
  return t;
}

/**
 * Build the `basis_noise` tables directly from `(seed0, seed1)` - `seed0` is the
 * map seed, `seed1` distinguishes the many `basis_noise` calls a map-gen program
 * makes. Reproduces the game to the ~2e-7 noise floor.
 *
 * The wiring (from `Noise::setSeed`): the effective taus88 seed word is
 * `max(seed0 + 7*(seed1>>8), 0x155)` - `seed1`'s low byte is *not* in the word -
 * and the three state words are all set to it. One continuous stream then drives
 * four identity shuffles in order: a scratch table (from which the byte
 * `scratch[seed1 & 0xff]` is taken as a salt), the Y-axis table, the X-axis
 * table, and the gradient permutation. Evaluation hashes as
 * `gradPerm[xTable[i] ^ yTable[j] ^ salt]`; folding the salt into `sigma` lets the
 * plain `a[i] ^ b[j]` evaluator above reproduce it unchanged.
 */
export function basisNoiseTablesFromSeed(seed0: number, seed1: number): BasisNoiseTables {
  const word = Math.max((seed0 + 7 * (seed1 >>> 8)) >>> 0, MIN_SEED_WORD);
  const saltIndex = seed1 & (TABLE_SIZE - 1);
  const st = seededState(word);
  const next = () => taus88Next(st);

  const scratch = shuffleIdentity(next);
  const salt = scratch[saltIndex];
  const yTable = shuffleIdentity(next);
  const xTable = shuffleIdentity(next);
  const gradPerm = shuffleIdentity(next);

  const sigma = Array.from(
    { length: TABLE_SIZE },
    (_, h) => gradPerm[(h ^ salt) & (TABLE_SIZE - 1)],
  );
  return { a: xTable, b: yTable, sigma };
}
