import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-fastpow.seed123456.json";
import { fastCbrt, fastPow } from "../src/noise/fastApprox";

/**
 * `fastApprox` compared to the game **f32-exact**, with no tolerance anywhere.
 *
 * Ground truth: `test/fixtures/oracle-fastpow.seed123456.json` - the noise
 * machine's own `^` operator sampled as `x ^ <exponent>`, so the comparison is
 * against the operator itself rather than through a downstream chain. See
 * `captureFastPow` in `test/oracle/capture.ts` for how `^` reaches
 * `Math::powSafe` and why the positions are adversarial.
 *
 * **This file exists because the rest of the suite could not answer two open
 * questions about a shipped file** (#161, #163). Every other fixture that
 * touches `fastApprox` compares with a tolerance - `multioctaveNoise.spec.ts`
 * asserts `< 5e-5`, `regularPatches.spec.ts` asserts `ABS_TOL < 1.0` - and the
 * effects in question are ~1e-5. A tolerance that wide cannot tell a better
 * model from a worse one, which is how a double-accumulation bug lived here for
 * about a year. #162 tracks the same weakness across the other 38 specs.
 */

const f32 = Math.fround;

const seriesFor = (exponent: string): { expression: string; values: number[] } => {
  const s = fixture.series.find((x) => x.exponent === exponent);
  if (s === undefined) throw new Error(`fixture has no series for exponent ${exponent}`);
  return s;
};

const XS = fixture.positions.map((p) => p.x);

describe("fastPow reproduces the game's `^` exactly", () => {
  /**
   * 2.5 is exactly representable at f32, so no exponent-precision question
   * arises - this series isolates the log2/exp2 polynomial and its ROUNDING. It
   * is what makes commit `9b49ebb` (per-operation rounding instead of one
   * rounding at the end) a measured result rather than a reading of the
   * disassembly: the two implementations disagree on ~30% of inputs, and the
   * fixture's positions include points where they do.
   */
  it("matches x ^ 2.5 at every position", () => {
    const { values } = seriesFor("2.5");
    for (const [i, x] of XS.entries()) {
      expect(f32(fastPow(x, 2.5)), `x = ${String(x)}`).toBe(f32(values[i]));
    }
  });

  /**
   * **An exponent of 0.5 is an EXACT square root, not fastapprox** - 123 of 123
   * positions match `Math.sqrt` and 0 of 123 match `fastPow(x, 0.5)`.
   *
   * This was not predicted. The spec first asserted `fastPow(x, 0.5)` here, on
   * the assumption that any non-integral exponent reaches the fastapprox pair,
   * and the game refuted it at the first position (`x = 1.5`: ours
   * `1.224700927734375`, the game's `1.2247449159622192`, which is exactly
   * `f32(Math.sqrt(1.5))`).
   *
   * Together with the integral case below, the noise machine's `^` has THREE
   * behaviours, and only one of them is the file this spec is named after:
   *
   * | exponent | model | matches |
   * | --- | --- | --- |
   * | `1/3`, `2.5` | fastapprox via `Math::powSafe` | 123/123 |
   * | `0.5` | exact `sqrt` | 123/123 |
   * | integral | exact exponentiation by squaring | 123/123 |
   *
   * **The consequence for porting: a Lua `^ 0.5` or `^ <integer>` must NOT be
   * ported as `fastPow`.** Both existing sites are already correct -
   * `resourceMath.ts` writes `regular_rq_factor ^ 2` as a plain multiplication -
   * but nothing recorded why until this fixture.
   */
  it("uses an exact square root for x ^ 0.5, not fastapprox", () => {
    const { values } = seriesFor("0.5");
    let fastapproxWrong = 0;
    for (const [i, x] of XS.entries()) {
      expect(f32(Math.sqrt(x)), `x = ${String(x)}`).toBe(f32(values[i]));
      if (f32(fastPow(x, 0.5)) !== f32(values[i])) fastapproxWrong++;
    }
    expect(
      fastapproxWrong,
      "if fastPow now matches x^0.5, the sqrt special case has been misread",
    ).toBeGreaterThan(10);
  });

  /**
   * **The cube root, which is the one that ships.** `fastCbrt` feeds
   * `regular_spot_height_typical`, `regular_blob_amplitude`,
   * `starting_blob_amplitude` and the spot-selection cone radius.
   *
   * The game's exponent is a **float** - `Math::powSafe(float, float)`, and the
   * multiply is `fmul s0, s0, s1` at single precision - so it computes with
   * `f32(1/3) = 0.3333333432674408`, not the double `0.3333333333333333`. The
   * two differ on ~3.0% of inputs, and 24 of this fixture's positions were
   * chosen because they do.
   *
   * Measured verdict at those 24: a double exponent scores **0/24**, `f32(1/3)`
   * scores **24/24**. This test fails on the pre-fix `fastCbrt`.
   */
  it("matches x ^ (1/3) at every position", () => {
    const { values } = seriesFor("1/3");
    for (const [i, x] of XS.entries()) {
      expect(f32(fastCbrt(x)), `x = ${String(x)}`).toBe(f32(values[i]));
    }
  });

  /**
   * **The guard that stops the test above being self-satisfied.** A double
   * exponent must FAIL, and fail at more than one position - otherwise the
   * fixture has drifted onto positions that no longer discriminate and the
   * assertion above endorses nothing.
   */
  it("rejects a double 1/3 exponent at many positions", () => {
    const { values } = seriesFor("1/3");
    let wrong = 0;
    for (const [i, x] of XS.entries()) {
      if (f32(fastPow(x, 1 / 3)) !== f32(values[i])) wrong++;
    }
    expect(wrong, "a double 1/3 should disagree with the game at many positions").toBeGreaterThan(
      10,
    );
  });

  /**
   * **The pre-`9b49ebb` implementation must FAIL this fixture** - which is what
   * turns the fixture from a confirmation of the current code into an
   * adjudication between the two.
   *
   * `9b49ebb` changed `fastLog2`/`fastPow2` from evaluating the whole polynomial
   * in double and rounding once, to rounding after every operation as the binary
   * does. It was adopted on the strength of the disassembly, because no
   * tolerance-based fixture could resolve the ~1e-5 difference (#161). This
   * fixture can: the two implementations disagree on ~30% of inputs and the
   * committed positions include many of them.
   *
   * The old implementation is reproduced verbatim from `9b49ebb^` rather than
   * imported, because it no longer exists in `src/`. If it ever starts passing,
   * either the fixture has drifted onto non-discriminating positions or the
   * per-operation rounding has been undone.
   *
   * **It runs on both fastapprox series, and supplies the CORRECT exponent in
   * each.** That separation is the point: with `f32(1/3)` handed to it, the only
   * thing left for the `1/3` series to reject is the rounding, so this guard
   * cannot be satisfied by the exponent fix that landed alongside it. The two
   * failure modes are pinned independently. Measured margins: the old
   * implementation misses **71 of 123** on `2.5` and **50 of 123** on `1/3`.
   *
   * **`0.5` is deliberately excluded, and not by oversight.** The game computes
   * that series with an exact `sqrt`, so *every* fastapprox implementation fails
   * it - old and new alike. A guard there would pass regardless of what the
   * rounding did, which is exactly the kind of assertion that looks like
   * coverage and proves nothing.
   */
  it("rejects the pre-9b49ebb single-rounding implementation", () => {
    const i32 = new Int32Array(1);
    const view = new Float32Array(i32.buffer);
    const bitsToFloat = (b: number): number => {
      i32[0] = b;
      return view[0];
    };
    const floatToBits = (x: number): number => {
      view[0] = x;
      return i32[0];
    };
    const oldLog2 = (x: number): number => {
      const bits = floatToBits(x) >>> 0;
      const y = f32(bits * 1.1920928955078125e-7);
      const mx = bitsToFloat((bits & 0x007fffff) | 0x3f000000);
      return f32(y - 124.22551499 - 1.498030302 * mx - 1.72587999 / (0.3520887068 + mx));
    };
    const oldPow2 = (p: number): number => {
      const clipp = p < -126 ? -126 : p;
      const z = f32(clipp - Math.trunc(clipp) + (clipp < 0 ? 1 : 0));
      const v = f32(
        (1 << 23) * f32(clipp + 121.2740575 + 27.7280233 / f32(4.84252568 - z) - 1.49012907 * z),
      );
      return bitsToFloat(v | 0);
    };
    const oldPow = (x: number, p: number): number => oldPow2(f32(p * oldLog2(x)));

    // Each fastapprox series, with the exponent the game actually uses, so the
    // only thing under test here is the rounding.
    for (const [exponent, p] of [
      ["2.5", 2.5],
      ["1/3", f32(1 / 3)],
    ] as const) {
      const { values } = seriesFor(exponent);
      let wrong = 0;
      for (const [i, x] of XS.entries()) {
        if (f32(oldPow(x, p)) !== f32(values[i])) wrong++;
      }
      expect(
        wrong,
        `x ^ ${exponent}: the old single-rounding fastapprox should disagree with the game at many positions`,
      ).toBeGreaterThan(10);
    }
  });

  /**
   * **An INTEGRAL exponent does not go through fastapprox at all**, and this is
   * the only place that is recorded behaviourally.
   *
   * `Math::powSafe` tests the exponent with an `fcvtzs`/`scvtf` round-trip
   * (`0x102955ab0`) and, when it is integral, uses exponentiation by squaring -
   * an exact result. `regular_rq_factor ^ 2` on the same Lua lines as the cube
   * root takes that path.
   *
   * This matters because `fastPow`'s other two call sites pass an integer
   * `octaves` (`multioctaveNoise.ts`, `trees/treeField.ts`), which makes "the
   * game uses squaring for integers, so those are wrong too" a very natural
   * inference. It is FALSE - swapping the multioctave norm to squaring makes its
   * oracle error 20x worse - so the normalisation does not route through
   * `powSafe`. Both halves are pinned here: squaring matches, fastapprox does not.
   */
  it("takes powSafe's exact squaring path for an integral exponent", () => {
    const { values } = seriesFor("2");
    let squaringWrong = 0;
    let fastapproxWrong = 0;
    for (const [i, x] of XS.entries()) {
      if (f32(f32(x) * f32(x)) !== f32(values[i])) squaringWrong++;
      if (f32(fastPow(x, 2)) !== f32(values[i])) fastapproxWrong++;
    }
    expect(squaringWrong, "x^2 should be exact squaring").toBe(0);
    expect(
      fastapproxWrong,
      "if fastPow now matches x^2, the integral fast path has been misread",
    ).toBeGreaterThan(10);
  });
});
