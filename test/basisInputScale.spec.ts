import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-basis-input-scale.seed123456.json";
import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";
import { basisNoiseExpr } from "../src/noise/eval/primitives";
import { f32 } from "../src/noise/eval/f32";

/**
 * The discriminating grade for #269's SECOND question, against values the game
 * produced: does the game hold `input_scale` at f32, and does it narrow the
 * coordinate PRODUCT?
 *
 * `test/basisOutputScale.spec.ts` settled the output side and deliberately did
 * not ask this - it held `input_scale` at 0.125, exact in f32, so the sample
 * point was unambiguous. This is the mirror image. **`output_scale` is pinned
 * at 1** throughout, a power of two, where every output-side candidate is
 * provably the identity, so nothing that question settled can leak into this
 * one.
 *
 * **Exact f64 equality, never a bound.** The game reports f32 values and every
 * candidate here produces one, so a tolerance would pass for all four models at
 * once and measure nothing. See issue #162.
 *
 * ## The answer, and why it is bigger than the output-scale half
 *
 * `basis_noise(f32(x * f32(input_scale)), ...)` reproduces the game at 196 of
 * 196 positions at every one of the seven scales. It is the same two-case shape
 * as the output side - narrow the CONSTANT and narrow the PRODUCT, and neither
 * alone is enough - but the reach is not the same.
 *
 * #269's output-scale fix could only touch call sites whose `output_scale` was
 * not a power of two, because multiplying an f32 by one is a pure exponent
 * shift. **That shortcut does not exist here.** The coordinate is not an f32 to
 * begin with, so there is no scale that is blind by construction, and this
 * reaches EVERY `basis_noise` call in the port - including all the sites the
 * output-scale fix was blind to, such as the eleven `plasma` calls Vulcanus's
 * crack layer makes at output scales 1, 0.5 and 0.25.
 */
const tables = basisNoiseTablesFromSeed(fixture.seed0, fixture.seed1);

/** The four candidates, written as formulas rather than as calls into the port. */
const MODELS = {
  /** What the port does today: f64 constant, f64 product. */
  unnarrowed: (x: number, y: number, s: number) => basisNoise(x * s, y * s, tables),
  /** Narrow the CONSTANT only - case 2 of the two-case rule. */
  f32Scale: (x: number, y: number, s: number) => basisNoise(x * f32(s), y * f32(s), tables),
  /** Narrow the PRODUCT only - case 1 of the two-case rule. */
  f32Product: (x: number, y: number, s: number) => basisNoise(f32(x * s), f32(y * s), tables),
  /** Both, which is what an f32 machine does. */
  f32ScaleAndProduct: (x: number, y: number, s: number) =>
    basisNoise(f32(x * f32(s)), f32(y * f32(s)), tables),
} as const;

/** Exact matches against the game for one model at one input scale. */
function score(model: (x: number, y: number, s: number) => number, caseIndex: number): number {
  const c = fixture.cases[caseIndex];
  let exact = 0;
  for (let i = 0; i < fixture.positions.length; i++) {
    const p = fixture.positions[i];
    if (c.values[i] === f32(model(p.x, p.y, c.inputScale))) exact++;
  }
  return exact;
}

describe("basis_noise input_scale narrowing (#269, second question)", () => {
  const N = fixture.positions.length;

  it("the fixture is the shape the grade needs", () => {
    expect(N).toBe(196);
    expect(fixture.outputScale).toBe(1);
    expect(fixture.cases.map((c) => c.inputScale)).toEqual([
      0.125, 0.5, 0.205128205128, 0.0975, 0.195, 0.02, 0.002,
    ]);
  });

  /**
   * 0.125 and 0.5 are exact in f32, so `f32(s) === s` and the constant half of
   * every model collapses to the identity. All four must score a full house; if
   * they do not, the harness or the tables are wrong and nothing else in this
   * file means anything.
   *
   * Note what this does NOT say. It is not that these scales are immune the way
   * a power-of-two OUTPUT scale is - the product half is still live here. It is
   * that at these coordinates, which are all exact binary fractions, the
   * product happens to stay on the f32 grid too.
   */
  it("the f32-exact controls cannot discriminate, and every model reproduces the game", () => {
    for (const [name, model] of Object.entries(MODELS)) {
      expect(score(model, 0), `${name} at input_scale 0.125`).toBe(N);
      expect(score(model, 1), `${name} at input_scale 0.5`).toBe(N);
    }
  });

  /**
   * **The answer.** `basis_noise(f32(x * f32(input_scale)), ...)` is the game's
   * model, at every input scale including both controls.
   */
  it("the game narrows the coordinate product AND holds input_scale at f32", () => {
    for (let i = 0; i < fixture.cases.length; i++) {
      expect(
        score(MODELS.f32ScaleAndProduct, i),
        `case ${String(fixture.cases[i].inputScale)}`,
      ).toBe(N);
    }
  });

  /**
   * Neither half alone reaches the game, and the shape of the failure is worth
   * reading rather than just asserting.
   *
   * Narrowing the CONSTANT alone barely moves anything - 3/4/3/20/79 becomes
   * 5/8/7/17/118, and at 0.02 it goes DOWN. Narrowing the PRODUCT alone is
   * where most of the ground is, 99/71/70/104/107, but it stalls around half.
   * Only both together reach 196.
   *
   * That is the two-case rule stated in counts: the terms are independent, and
   * fixing whichever one you thought of first leaves the other's error intact.
   *
   * Frozen exact counts. If one moves: read it, do not adjust it.
   */
  it("neither narrowing alone reaches the game", () => {
    const discriminating = [2, 3, 4, 5, 6];

    expect(discriminating.map((i) => score(MODELS.unnarrowed, i))).toEqual([3, 4, 3, 20, 79]);
    expect(discriminating.map((i) => score(MODELS.f32Scale, i))).toEqual([5, 8, 7, 17, 118]);
    expect(discriminating.map((i) => score(MODELS.f32Product, i))).toEqual([99, 71, 70, 104, 107]);
  });

  /**
   * **The shipped port scores this, today.** These five scales are not
   * hypothetical: 0.0975 and 0.195 are both terms of `vulcanus_hairline_cracks`,
   * 0.02 is the base of every `vulcanus_plasma` call, and 0.002 is
   * `mountain_basis_noise`.
   *
   * This reads `basisNoiseExpr` - the function a fix would change - rather than
   * the `unnarrowed` formula above, and the distinction is not cosmetic. The
   * first version of this assertion scored the formula, which meant it would
   * have stayed GREEN through the very fix it claimed to be a tripwire for. A
   * frozen count is only a tripwire if it is wired to the thing that moves.
   *
   * The two agree today, and that is itself the point: `basisNoiseExpr` at
   * `output_scale = 1` reduces to `f32(basis_noise(x * input_scale, ...))`, so
   * the formula and the port are the same function until the coordinate
   * arithmetic changes. #290 is what separates them.
   *
   * Expected to go GREEN-to-RED when #290 lands, the same way
   * `basisOutputScale.spec.ts` froze `[196, 28, 6, 96, 1]` before #269 did.
   * When it does, replace these with a full house rather than loosening
   * anything.
   */
  it("the shipped basisNoiseExpr scores this, today", () => {
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
            inputScale: c.inputScale,
            outputScale: fixture.outputScale,
          },
          tables,
        );
        if (c.values[i] === v) exact++;
      }
      return exact;
    });
    expect(got).toEqual([196, 196, 3, 4, 3, 20, 79]);

    // The control that keeps the paragraph above honest: the port and the
    // formula ARE the same function today, so this file's other counts describe
    // the port too. #290 is what breaks the tie.
    expect(got).toEqual(fixture.cases.map((_c, i) => score(MODELS.unnarrowed, i)));
  });

  /**
   * Non-vacuity, and the reason this probe is worth more than the output-scale
   * one: there is no input scale that is blind by construction.
   *
   * A power-of-two OUTPUT scale cannot move a product off the f32 grid, which
   * is why #269's fix could not reach a `plasma` call at output scale 1. The
   * coordinate is not an f32 to begin with, so no such shortcut exists here -
   * and a power-of-two INPUT scale discriminates perfectly well. 0.5 is a
   * control only because it is f32-exact, not because it is a power of two.
   */
  it("a power-of-two input scale is not blind the way a power-of-two output scale is", () => {
    let changed = 0;
    for (const s of [0.5, 0.25, 2, 4]) {
      for (const p of fixture.positions) {
        if (p.x * s !== f32(p.x * s)) changed++;
      }
    }
    // These coordinates are exact binary fractions, so a power-of-two scale
    // keeps them on the grid - the same arithmetic the controls rely on.
    expect(changed).toBe(0);

    // But an inexact scale leaves it constantly, which is what the
    // discriminating cases above are made of.
    let changedElsewhere = 0;
    for (const s of [0.205128205128, 0.0975, 0.195, 0.02, 0.002]) {
      for (const p of fixture.positions) {
        if (p.x * s !== f32(p.x * s)) changedElsewhere++;
      }
    }
    expect(changedElsewhere).toBeGreaterThan(900);
  });
});
