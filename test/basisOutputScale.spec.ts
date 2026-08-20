import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-basis-output-scale.seed123456.json";
import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";
import { basisNoiseExpr } from "../src/noise/eval/primitives";

/**
 * The discriminating grade for #269, against values the game produced.
 *
 * `basisNoiseExpr` returns `output_scale * basis_noise(...)` as an un-narrowed
 * f64. This asks the game which of four candidate models it implements, at four
 * output scales that can tell them apart plus one control that cannot.
 *
 * **Exact f64 equality, never a bound.** The game reports f32 values and every
 * candidate here produces one, so a tolerance would pass for all four models at
 * once and measure nothing. See issue #162.
 */
const tables = basisNoiseTablesFromSeed(fixture.seed0, fixture.seed1);

/** The four candidates, written as formulas rather than as calls into the port. */
const MODELS = {
  /** What `basisNoiseExpr` does today: no narrowing anywhere. */
  unnarrowed: (os: number, raw: number) => os * raw,
  /** What #269 proposes: narrow the PRODUCT. */
  narrowProduct: (os: number, raw: number) => Math.fround(os * raw),
  /** Narrow the product AND hold the output scale itself at f32. */
  f32ScaleAndProduct: (os: number, raw: number) => Math.fround(Math.fround(os) * raw),
  /** Hold the scale at f32 but leave the product wide. The control's control. */
  f32ScaleOnly: (os: number, raw: number) => Math.fround(os) * raw,
} as const;

/** Exact matches against the game for one model at one output scale. */
function score(model: (os: number, raw: number) => number, caseIndex: number): number {
  const c = fixture.cases[caseIndex];
  let exact = 0;
  for (let i = 0; i < fixture.positions.length; i++) {
    const p = fixture.positions[i];
    const raw = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
    if (c.values[i] === model(c.outputScale, raw)) exact++;
  }
  return exact;
}

describe("basis_noise output_scale narrowing (#269)", () => {
  const N = fixture.positions.length;

  it("the fixture is the shape the grade needs", () => {
    expect(N).toBe(196);
    expect(fixture.inputScale).toBe(0.125);
    expect(fixture.cases.map((c) => c.outputScale)).toEqual([1, 0.6, 0.51, 0.75, 125]);
  });

  /**
   * `output_scale = 1` is a power of two, so multiplying an f32 by it is a pure
   * exponent shift and every model above is the same function. All four must
   * score a full house; if they do not, the harness or the tables are wrong and
   * nothing else in this file means anything.
   */
  it("the control cannot discriminate, and every model reproduces the game there", () => {
    for (const [name, model] of Object.entries(MODELS)) {
      expect(score(model, 0), `${name} at output_scale 1`).toBe(N);
    }
  });

  /**
   * **The answer.** `f32(f32(output_scale) * basis)` is the game's model, at
   * every output scale including the control.
   */
  it("the game narrows the product AND holds output_scale at f32", () => {
    for (let i = 0; i < fixture.cases.length; i++) {
      expect(score(MODELS.f32ScaleAndProduct, i), `case ${fixture.cases[i].outputScale}`).toBe(N);
    }
  });

  /**
   * Narrowing the product is necessary and NOT sufficient, which is the part
   * #269 does not say. `narrowProduct` and `f32ScaleAndProduct` coincide only
   * where `output_scale` is already f32-exact, which is why the first is
   * complete at 1 and at 125 and short at 0.6, 0.51 and 0.75.
   *
   * Frozen exact counts. If one moves: read it, do not adjust it.
   */
  it("narrowing the product alone does not reach the game", () => {
    const got = fixture.cases.map((_, i) => score(MODELS.narrowProduct, i));
    expect(got).toEqual([196, 110, 151, 196, 196]);
  });

  /**
   * **#269 is fixed, and this is the assertion that graded it.** Before the fix
   * `basisNoiseExpr` returned the un-narrowed product and scored
   * `[196, 28, 6, 96, 1]` - the worst of the four models wherever the question
   * can be asked at all. It now IS `f32ScaleAndProduct`, so it reproduces the
   * game at every position of every case.
   *
   * The count was frozen rather than bounded precisely so the change would
   * announce itself here, and it did. If it ever moves off a full house again,
   * read it - do not loosen it.
   */
  it("the shipped basisNoiseExpr reproduces the game at every output scale", () => {
    const got = fixture.cases.map((c) => {
      let exact = 0;
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const v = basisNoiseExpr(
          p.x,
          p.y,
          {
            seed0: fixture.seed0,
            seed1: fixture.seed1,
            inputScale: fixture.inputScale,
            outputScale: c.outputScale,
          },
          tables,
        );
        if (c.values[i] === v) exact++;
      }
      return exact;
    });
    expect(got).toEqual([N, N, N, N, N]);
  });

  /**
   * The rule that decides which call sites #269 can reach, asserted rather than
   * described: a power-of-two output scale cannot move a product off the f32
   * grid, so it is blind by construction. This is why `oracle-basis`, captured
   * at `output_scale = 1`, could never have answered the question.
   */
  it("a power-of-two output scale cannot change any product", () => {
    let changed = 0;
    let total = 0;
    for (const os of [1, 0.5, 0.25, 2, 4, 64]) {
      for (const p of fixture.positions) {
        const raw = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
        total++;
        if (os * raw !== Math.fround(os * raw)) changed++;
      }
    }
    expect(total).toBe(6 * 196);
    expect(changed).toBe(0);

    // Non-vacuity: the same sweep at non-powers of two DOES change products, so
    // the zero above is a property of the scale rather than of these positions.
    let changedElsewhere = 0;
    for (const os of [0.6, 0.51, 0.75, 125]) {
      for (const p of fixture.positions) {
        const raw = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
        if (os * raw !== Math.fround(os * raw)) changedElsewhere++;
      }
    }
    expect(changedElsewhere).toBeGreaterThan(400);
  });
});
