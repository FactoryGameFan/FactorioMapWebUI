/**
 * Paul Mineiro's `fastapprox` `log2` / `exp2` / `pow`, exactly as Factorio's
 * `Math::log2` / `Math::exp2f`. (`Math::log2`, not `Math::log2f` - the symbols are
 * `__ZN4Math4log2Ef` and `__ZN4Math5exp2fEf`, so only exp2 carries the `f`. This
 * header briefly said `log2f`; nothing named that exists in the binary.)
 *
 * The game's noise machine evaluates powers and cube roots through these, so any
 * ported noise expression that takes a `pow`/`cbrt` must go through them too -
 * matching them is what closes the last ~1e-4 relative error.
 *
 * Originally lived in `multioctaveNoise.ts` (for its RMS normalisation power); moved
 * here once the resource `spot_height`/`blob_amplitude` expressions needed the same
 * `cbrt` (see docs/noise/random-penalty-NOTES.md, the fastapprox-cbrt residual).
 *
 * **The rounding is per-operation, and that is the whole point of the rewrite on
 * 2026-08-04.** The polynomial and its coefficients were right from the start, but
 * both functions used to evaluate the whole expression in double and round to f32
 * once at the end. The binary rounds after every `fadd`/`fmul`/`fdiv`, and the
 * difference is worth ~1e-5 relative - invisible to every tolerance-based fixture
 * here, and decisive for `voronoi_spot_noise` with `distance_type = 'minkowski3'`,
 * which is compared f32-EXACT and goes 96/175 -> 175/175 with it.
 *
 * The constants below are therefore written as the exact f32 values of the
 * immediates in the **2.1.12** `arm64` disassembly (`Math::log2` at the
 * `0x3f000000` / `0xc2f87377` / `0xbfbfbf75` / `0x3eb444f9` / `0xbfdce9a3` sequence,
 * `Math::exp2f` at `0x42f28c51` / `0x409af5f8` / `0x41ddd2fe` / `0xbfbebc8d`), not as
 * the decimal approximations they carried when this was read out of 2.1.11. Do not
 * "tidy" them back into a single expression: that reintroduces the double
 * accumulation this comment exists to prevent.
 */

const f32 = Math.fround;
const i32 = new Int32Array(1);
const f32view = new Float32Array(i32.buffer);
const bitsToFloat = (bits: number): number => {
  i32[0] = bits;
  return f32view[0];
};
const floatToBits = (x: number): number => {
  f32view[0] = x;
  return i32[0];
};

/** Paul Mineiro `fastlog2`, matching Factorio's `Math::log2`. */
export function fastLog2(x: number): number {
  const bits = floatToBits(x) >>> 0;
  const y = f32(bits * 1.1920928955078125e-7); // bits * 2^-23
  const mx = bitsToFloat((bits & 0x007fffff) | 0x3f000000);
  let acc = f32(y + -124.22551727294922);
  acc = f32(acc + f32(mx * -1.4980303049087524));
  return f32(acc + f32(-1.7258800268173218 / f32(mx + 0.35208871960639954)));
}

/** Paul Mineiro `fastpow2`, matching Factorio's `Math::exp2f`. */
export function fastPow2(p: number): number {
  const clipp = p < -126 ? -126 : p;
  const z = f32(f32(clipp - f32(Math.trunc(clipp))) + (p < 0 ? 1 : 0));
  let acc = f32(clipp + 121.27405548095703);
  acc = f32(acc + f32(27.728023529052734 / f32(4.842525482177734 - z)));
  acc = f32(acc + f32(z * -1.4901291131973267));
  return bitsToFloat(Math.trunc(acc * 8388608) | 0);
}

/** `x^p` via the fastapprox pair, as the game computes powers in noise programs. */
export function fastPow(x: number, p: number): number {
  return fastPow2(f32(p * fastLog2(x)));
}

/** f32(1/3) - bit pattern `0x3eaaaaab`, the exact multiplier the binary uses. */
const ONE_THIRD_F32 = f32(1 / 3);

/**
 * `x^(1/3)` via the fastapprox pair - the cube root the game's noise machine uses in
 * `regular_spot_height_typical` / `regular_blob_amplitude` / `starting_blob_amplitude`
 * (and the spot-selection cone radius). `x` must be > 0 (all resource quantities are).
 *
 * **The exponent is `f32(1/3)`, not the double `1/3`, and that is worth 3.0% of all
 * inputs** (issue #163). The game reaches this through `Math::powSafe(float, float)` -
 * both parameters are `float`, and the multiply by the exponent is `fmul s0, s0, s1`
 * at single precision - so `0.3333333333333333` never appears; `0.3333333432674408`
 * does. Passing the double was wrong on ~3.0% of inputs, by up to 7.8e-3 absolute.
 *
 * Settled against the game, not just the disassembly: at the 24 positions in
 * `oracle-fastpow.seed123456.json` chosen because the two candidates differ, the
 * double scores **0/24** and this scores **24/24**. `test/fastApprox.spec.ts`
 * compares all 123 positions f32-exact and carries a guard that fails if a double
 * exponent ever starts agreeing.
 */
export function fastCbrt(x: number): number {
  return fastPow(x, ONE_THIRD_F32);
}
