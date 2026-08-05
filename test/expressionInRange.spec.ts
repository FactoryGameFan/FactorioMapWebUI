import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-expression-in-range.seed123456.json";
import { expressionInRange } from "../src/noise/tiles/expressionInRange";

// Ground truth: test/fixtures/oracle-expression-in-range.seed123456.json, captured
// via the oracle harness (test/oracle/capture.ts expression-in-range). The native
// builtin's peak/falloff math, RE'd from these sweeps - see
// docs/noise/expression-in-range-NOTES.md for the derivation.
//
// Derived formula:
//   m = min over all dims i of min(value_i - from_i, to_i - value_i)
//   result = min(peak_maximum, peak_multiplier * m)
// (no lower clamp; peak_maximum may be Infinity.)
//
// The observed worst residual over every sweep is ~9.5e-7 (pure f32 noise), well
// under the 8e-3 elevation f32 floor.
const f32 = Math.fround;

describe("expressionInRange reproduces the native builtin", () => {
  it("matches the bounded 1-D sweep (pm=20, pmax=1) to the f32 floor", () => {
    const s = fixture.sweeps.oneD_20_1;
    let worst = 0;
    for (let i = 0; i < s.positions.length; i++) {
      const p = s.positions[i];
      const got = expressionInRange(20, 1, [p.x / 1000], [-0.5], [0.5]);
      expect(f32(got), `bounded 1-D @ ${String(p.x)}`).toBe(f32(s.values[i]));
      worst = Math.max(worst, Math.abs(got - s.values[i]));
    }
    expect(worst, "worst bounded 1-D residual").toBe(0);
  });

  it("matches the unbounded 1-D sweep (pm=5, pmax=inf) and does NOT clamp in range", () => {
    const s = fixture.sweeps.oneD_5_inf;
    let worst = 0;
    let maxInRange = -Infinity;
    for (let i = 0; i < s.positions.length; i++) {
      const p = s.positions[i];
      const expr = p.x / 1000;
      const got = expressionInRange(5, Infinity, [expr], [-0.5], [0.5]);
      expect(f32(got), `unbounded 1-D @ ${String(p.x)}`).toBe(f32(s.values[i]));
      worst = Math.max(worst, Math.abs(got - s.values[i]));
      if (expr >= -0.5 && expr <= 0.5) maxInRange = Math.max(maxInRange, got);
    }
    expect(worst, "worst unbounded 1-D residual").toBe(0);
    // The whole point of pmax=inf: in-range values exceed 1 (peak ~2.5 at center).
    // A hard clamp to 1 would silently kill sand-1's coastal boost.
    expect(maxInRange, "in-range peak must exceed 1 (no clamp)").toBeGreaterThan(1);
  });

  it("matches the 2-D sweep with the min combination rule (pm=20, pmax=1)", () => {
    const s = fixture.sweeps.twoD;
    let worst = 0;
    for (let i = 0; i < s.positions.length; i++) {
      const p = s.positions[i];
      const got = expressionInRange(20, 1, [p.x / 1000, p.y / 1000], [-0.5, -0.5], [0.5, 0.5]);
      expect(f32(got), `2-D @ (${String(p.x)},${String(p.y)})`).toBe(f32(s.values[i]));
      worst = Math.max(worst, Math.abs(got - s.values[i]));
    }
    expect(worst, "worst 2-D residual").toBe(0);
  });

  /**
   * **The f64 form must FAIL the fixture**, or the three exact tests above are
   * just recording whatever the implementation happens to do.
   *
   * This is the same guard shape `fastApprox.spec.ts` uses. It matters more than
   * usual here because the exact assertions replaced a `toBeLessThan(8e-3)`
   * ceiling that the f64 implementation passed comfortably - the actual worst
   * residual was ~9.5e-7, so that ceiling was ~8400x too loose and would have
   * accepted almost any regression.
   */
  it("rejects the pre-f32 f64 arithmetic", () => {
    const eirF64 = (
      pm: number,
      pmax: number,
      values: number[],
      froms: number[],
      tos: number[],
    ): number => {
      let m = Infinity;
      for (let i = 0; i < values.length; i++) {
        const d = Math.min(values[i] - froms[i], tos[i] - values[i]);
        if (d < m) m = d;
      }
      return Math.min(pmax, pm * m);
    };
    const s = fixture.sweeps.oneD_20_1;
    let wrong = 0;
    for (let i = 0; i < s.positions.length; i++) {
      const p = s.positions[i];
      if (f32(eirF64(20, 1, [p.x / 1000], [-0.5], [0.5])) !== f32(s.values[i])) wrong++;
    }
    expect(wrong, "f64 arithmetic should disagree with the game at many positions").toBeGreaterThan(
      10,
    );
  });

  // Formula-consistency guard for sand-1's real production call:
  //   expression_in_range(5, inf, elevation, aux, -1.5, 0.5, 1.5, 1)
  // Every oracle sweep above uses symmetric ranges [-0.5, 0.5] on both axes; sand-1
  // uses asymmetric, wider-than-1 ranges and pmax=inf. This is NOT an oracle test
  // (no fixture covers this shape) - it asserts the implementation against the
  // derived formula computed by hand:
  //   m = min(min(elev - (-1.5), 1.5 - elev), min(aux - 0.5, 1 - aux))
  //   result = min(inf, 5 * m)  ==  5 * m  (never clamped)
  //
  // **Precision here is 6, not 10, and that is deliberate.** These asserted
  // `toBeCloseTo(v, 10)` while the implementation worked in f64. It now rounds
  // every step to f32 (see the module header), and intermediates like `1 - 1.2`
  // are not representable there, so -1.0 comes back as -1.000000238418579. The
  // f64 decimal is simply the wrong target for an f32 computation.
  //
  // The alternative - asserting the exact f32 result - would mean recomputing
  // `f32(5 * f32(f32(1) - f32(1.2)))` in the test, i.e. re-implementing the
  // function and then checking it against itself. So this stays a FORMULA-SHAPE
  // guard: which axis drives the `min`, and that pmax=inf does not clamp.
  // Bit-exactness is the three oracle sweeps above, which are now exactly 0.
  it("matches the hand-derived formula for sand-1's asymmetric, unbounded 2-D shape", () => {
    // Inside both ranges: elev=0 (edge dist 1.5), aux=0.75 (edge dist 0.25).
    // m = min(1.5, 0.25) = 0.25 -> result = 5 * 0.25 = 1.25 (exceeds 1, not clamped).
    expect(expressionInRange(5, Infinity, [0, 0.75], [-1.5, 0.5], [1.5, 1])).toBeCloseTo(1.25, 6);

    // Outside on the aux axis only: elev=0 (edge dist 1.5, still inside),
    // aux=1.2 (edge dist min(0.7, -0.2) = -0.2, outside the high edge).
    // m = min(1.5, -0.2) = -0.2 -> result = 5 * -0.2 = -1.0, driven by aux via min.
    expect(expressionInRange(5, Infinity, [0, 1.2], [-1.5, 0.5], [1.5, 1])).toBeCloseTo(-1.0, 6);

    // Outside on the elev axis only: elev=2 (edge dist min(3.5, -0.5) = -0.5,
    // outside the high edge), aux=0.75 (edge dist 0.25, still inside).
    // m = min(-0.5, 0.25) = -0.5 -> result = 5 * -0.5 = -2.5, driven by elev via min.
    expect(expressionInRange(5, Infinity, [2, 0.75], [-1.5, 0.5], [1.5, 1])).toBeCloseTo(-2.5, 6);

    // The in-range point must NOT be clamped to 1 - that's the whole point of
    // pmax=inf letting sand-1's coastal term win over land tiles topping out near 1.
    expect(expressionInRange(5, Infinity, [0, 0.75], [-1.5, 0.5], [1.5, 1])).toBeGreaterThan(1);
  });
});
