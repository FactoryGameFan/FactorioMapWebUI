/**
 * The game's own `sin` and `cos` for noise expressions (#531).
 *
 * `sin()` and `cos()` in a noise expression are NOT libm. In the 2.1.23 binary
 * they are `NoiseOperations::Functions::sin` and `cos`, a short f64 polynomial
 * made of adds, multiplies, one `abs` and one round-half-even. It differs from
 * a correctly rounded f32 sine on about 5.2% of inputs, always by one ULP, so
 * `Math.fround(Math.sin(x))` is a different function. The polynomial matches
 * the game on all 4,096 rows of `test/fixtures/oracle-native-ops.json` and on
 * the bearings probed in `test/fixtures/oracle-bearing-chain.seeds606.json`;
 * `fround(Math.sin)` matches 964 to 987 of each row's 1,024.
 *
 * Steps, per the binary:
 *
 * 1. Widen the f32 argument to f64.
 * 2. `t = x * (1 / 2pi)`; for sin only, `t += -0.25`.
 * 3. `n = round_half_even(t)`, `f = |t - n|`, `u = 0.25 - f`.
 * 4. `u2 = u*u`, `u4 = u2*u2`, `lo = u2*K5 + K6`, `hi = u2*K7 + K8`,
 *    `p = hi*u4 + lo`.
 * 5. `r = (u4*u4*K11 + p) * u`, narrowed to f32.
 *
 * Only f64 `+ - *`, `abs` and the rounding are used, and JavaScript defines
 * each of them exactly, so every host returns the same bits with no libm. The
 * Rust copy is `vm_sin` and `vm_cos` in `crates/fmw-noise/src/eval/math.rs`.
 * Keep the two token for token alike: no fused multiply-add in Rust.
 */

const f32 = Math.fround;

const ONE_OVER_TAU = 0.15915494309189535;
const SIN_PHASE = -0.25;
const QUARTER = 0.25;
const K5 = -41.34167506665737;
const K6 = 6.283185269630412;
const K7 = -76.56887678023256;
const K8 = 81.60201529595571;
const K11 = 39.65735524898863;

/**
 * Round to nearest, ties to even - what `cvtpd2dq` does under the default
 * rounding mode. `Math.round` sends ties upward, so `2.5` would give 3.
 *
 * Exact for `|t| < 2^52`, where `t - floor(t)` is exact. Larger values have no
 * fractional part, and `Math.floor` returns them unchanged.
 */
export function roundTiesToEven(t: number): number {
  const floor = Math.floor(t);
  const fraction = t - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function polynomial(t: number): number {
  const f = Math.abs(t - roundTiesToEven(t));
  const u = QUARTER - f;
  const u2 = u * u;
  const u4 = u2 * u2;
  const lo = u2 * K5 + K6;
  const hi = u2 * K7 + K8;
  const p = hi * u4 + lo;
  const u8 = u4 * u4;
  return f32((u8 * K11 + p) * u);
}

/** The game's `sin(x)` for an f32 `x`, returned as an f32 value. */
export function gameSin(x: number): number {
  return polynomial(f32(x) * ONE_OVER_TAU + SIN_PHASE);
}

/** The game's `cos(x)` for an f32 `x`, returned as an f32 value. */
export function gameCos(x: number): number {
  return polynomial(f32(x) * ONE_OVER_TAU);
}
