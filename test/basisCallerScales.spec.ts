import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-basis-caller-scales.seed123456.json";
import {
  basisNoise,
  basisNoiseTablesFromSeed,
  type BasisNoiseTables,
} from "../src/noise/basisNoise";
import { f32 } from "../src/noise/eval/f32";

/**
 * #290 graded at the REAL call sites, with both narrowings applied together.
 *
 * `basisOutputScale.spec.ts` settled the output side with `input_scale` held
 * f32-exact. `basisInputScale.spec.ts` settled the input side with
 * `output_scale` pinned at 1. **Neither graded the two together**, and every
 * real call pairs a non-trivial input scale with a non-trivial output scale.
 *
 * This file closes that gap, and it exists because applying the input-side
 * model naively made three fields WORSE - `vulcanus_hairline_cracks`,
 * `vulcanus_flood_basalts_func` and `mountain_plasma` all breached their bounds
 * - while `vulcanus_elev` improved sharply, 116 to 136 of 434. A model that is
 * exact at 196 of 196 does not make a field worse by accident, so the question
 * was whether the model was wrong at the real scales or the port's COMPOSITION
 * was carrying the error.
 *
 * **It is the composition.** All five leaves below are 196 of 196 under the
 * full model. These are not sampled scales; they are the exact
 * `(input_scale, output_scale)` pairs the three fields use, at full f64
 * precision:
 *
 *   0.20512820512820512  x 0.6    hairline_cracks term A
 *   0.10256410256410256  x 1      hairline_cracks term B
 *   0.008                x 125    mountain_plasma term A
 *   0.002                x 625    mountain_plasma term B
 *   0.002                x 250    mountain_basis_noise
 *
 * `hairline_cracks` is `abs(A - B)` of the first two and `mountain_plasma` is
 * `abs(A - B)` of the next two, so between them these five leaves are the whole
 * of both regressing fields, plus the elevation term that improved.
 *
 * A detail worth keeping: `basisInputScale.spec.ts` grades the truncated
 * literal `0.205128205128`, while the real caller passes
 * `1 / 50 / (0.3 * 0.325)` = `0.20512820512820512`. Those are different f64
 * values and the SAME f32 - so they agree only once the constant is narrowed,
 * which is part of what this file checks.
 *
 * **Exact f64 equality, never a bound** (#162).
 */
const tablesFor = (seed1: number): BasisNoiseTables =>
  basisNoiseTablesFromSeed(fixture.seed0, seed1);

/** The four combined candidates. `os` is always narrowed - #269 settled that. */
const MODELS = {
  /** What ships today: the output side narrowed, the input side not. */
  outputOnly: (x: number, y: number, is: number, os: number, t: BasisNoiseTables) =>
    f32(f32(os) * basisNoise(x * is, y * is, t)),
  /** Add the input PRODUCT but not the input constant. */
  plusInputProduct: (x: number, y: number, is: number, os: number, t: BasisNoiseTables) =>
    f32(f32(os) * basisNoise(f32(x * is), f32(y * is), t)),
  /** Add the input CONSTANT but not the input product. */
  plusInputConstant: (x: number, y: number, is: number, os: number, t: BasisNoiseTables) =>
    f32(f32(os) * basisNoise(x * f32(is), y * f32(is), t)),
  /** Everything narrowed, on both sides. */
  full: (x: number, y: number, is: number, os: number, t: BasisNoiseTables) =>
    f32(f32(os) * basisNoise(f32(x * f32(is)), f32(y * f32(is)), t)),
} as const;

function score(model: (typeof MODELS)[keyof typeof MODELS], caseIndex: number): number {
  const c = fixture.cases[caseIndex];
  const t = tablesFor(c.seed1);
  let exact = 0;
  for (let i = 0; i < fixture.positions.length; i++) {
    const p = fixture.positions[i];
    if (c.values[i] === f32(model(p.x, p.y, c.inputScale, c.outputScale, t))) exact++;
  }
  return exact;
}

describe("basis_noise at the real caller scales (#290)", () => {
  const N = fixture.positions.length;

  it("the fixture is the shape the grade needs", () => {
    expect(N).toBe(196);
    expect(fixture.cases.map((c) => c.name)).toEqual([
      "hairline_cracks A",
      "hairline_cracks B",
      "mountain_plasma A",
      "mountain_plasma B",
      "mountain_basis_noise",
    ]);
    // The scales are the callers' own, not round numbers chosen for the probe.
    expect(fixture.cases[0].inputScale).toBe(1 / 50 / (0.3 * 0.325));
    expect(fixture.cases[0].outputScale).toBe(0.6);
  });

  /**
   * **The answer.** Narrowing both sides reproduces the game at every position
   * of every leaf. There is no call site in this group where the combined model
   * is anything less than complete.
   */
  it("the full narrowing reproduces the game at every real caller scale", () => {
    for (let i = 0; i < fixture.cases.length; i++) {
      expect(score(MODELS.full, i), fixture.cases[i].name).toBe(N);
    }
  });

  /**
   * And the three partial models, frozen. The shipped one is worst everywhere,
   * and neither half of the input narrowing gets close on its own - the same
   * two-case shape as both halves of #269, now measured where it matters.
   *
   * Frozen exact counts. If one moves: read it, do not adjust it.
   */
  it("no partial model reaches the game", () => {
    expect(fixture.cases.map((_c, i) => score(MODELS.outputOnly, i))).toEqual([3, 4, 27, 74, 77]);
    expect(fixture.cases.map((_c, i) => score(MODELS.plusInputProduct, i))).toEqual([
      99, 99, 75, 104, 102,
    ]);
    expect(fixture.cases.map((_c, i) => score(MODELS.plusInputConstant, i))).toEqual([
      5, 7, 64, 121, 112,
    ]);
  });

  /**
   * The reading that matters for whoever writes #290's fix.
   *
   * `outputOnly` is what `basisNoiseExpr` computes today. It scores 3, 4, 27,
   * 74 and 77 here - so the LEAVES of `hairline_cracks` and `mountain_plasma`
   * are already badly wrong, before those fields compose anything.
   *
   * Fixing them does NOT make the composed fields exact. Measured separately
   * against `oracle-vulcanus-cracks`: with both leaves exact,
   * `hairline_cracks` goes from 2 to 6 of 61 - better, but nowhere near 61, and
   * its worst residual barely moves (1.853e-3 to 1.886e-3). Narrowing the
   * `abs(A - B)` subtraction, or the `abs` itself, changes nothing at all.
   *
   * So the remaining error in those fields is NOT in the basis leaves and NOT
   * in the subtraction. That is a separate finding with a separate cause, and
   * the useful consequence is that #290's fix should be graded on the LEAVES,
   * where it is provably complete, rather than blamed for what the composed
   * fields still get wrong.
   */
  it("the shipped model is worst at every real caller scale", () => {
    for (let i = 0; i < fixture.cases.length; i++) {
      const shipped = score(MODELS.outputOnly, i);
      expect(shipped, `${fixture.cases[i].name} shipped vs full`).toBeLessThan(N);
      expect(shipped, `${fixture.cases[i].name} shipped vs product-narrowed`).toBeLessThanOrEqual(
        score(MODELS.plusInputProduct, i),
      );
    }
  });
});
