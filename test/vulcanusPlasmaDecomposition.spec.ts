import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-plasma-decomposition.seed123456.json";
import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { f32 } from "../src/noise/eval/f32";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";

/**
 * `vulcanus_hairline_cracks` decomposed into its two `basis_noise` leaves, at
 * the SAME positions, so the port can be graded a layer at a time (#293).
 *
 * ## Why a decomposition fixture exists at all
 *
 * `basisCallerScales.spec.ts` graded the two leaves at 196 positions on a
 * +/-400 grid and got 196 of 196. `oracle-vulcanus-cracks` graded the composed
 * field at 61 DIFFERENT positions and got 2 of 61. Nothing measured a single
 * position end to end, so "the leaves are right and the composition is wrong"
 * was an inference across two disjoint sample sets.
 *
 * Capturing the leaves and the composed field together settled it in two steps,
 * and both are asserted below:
 *
 * 1. **Game against game, with the port removed entirely.** `abs(leafA - leafB)`
 *    of the GAME's own leaves reproduces the game's own `hairline_cracks` at
 *    only 7 of 61. So the port was reconstructing the wrong expression, and that
 *    conclusion needs none of our code to be right.
 * 2. **Our leaf model against the game's own leaves.** 61 of 61, worst residual
 *    exactly 0, on both leaves - near field and far.
 *
 * Leaves provably exact plus composed field provably wrong means the fault was
 * in the ARGUMENTS feeding the leaves, which is what sent us to the game's Lua
 * and found `vulcanus_cracks_scale` is a noise-EXPRESSION rather than a Lua
 * number. See `src/noise/expressions/vulcanusCracks.ts`.
 *
 * ## A note on the version, which matters here
 *
 * This fixture is captured from **2.1.14**;
 * `oracle-vulcanus-cracks.seed123456.json` is from **2.1.12**. The solved model
 * scores 61 of 61 here and 50 of 61 there, at identical positions. Those 11
 * are a GAME VERSION difference, not port error (#295). This file is the
 * current-version grade for this field; the older fixture's count is kept as it
 * is rather than chased.
 *
 * **Exact f64 equality, never a bound** (#162).
 */
const tablesA = basisNoiseTablesFromSeed(fixture.seed0, fixture.leafA.seed1);
const tablesB = basisNoiseTablesFromSeed(fixture.seed0, fixture.leafB.seed1);

/** The leaf model #290 settled: f32 input scale, f32 coordinate product. */
const leaf = (
  p: { inputScale: number; outputScale: number },
  tables: ReturnType<typeof basisNoiseTablesFromSeed>,
  x: number,
  y: number,
): number => {
  const is = f32(p.inputScale);
  return f32(f32(p.outputScale) * basisNoise(f32(x * is), f32(y * is), tables));
};

describe("vulcanus_plasma decomposed (#293)", () => {
  const N = fixture.positions.length;

  it("the fixture is the shape the grade needs", () => {
    expect(N).toBe(61);
    expect(fixture.leafA.seed1).toBe(12643);
    expect(fixture.leafB.seed1).toBe(13423 + 15223);
    expect(fixture.leafA.outputScale).toBe(0.6);
    expect(fixture.leafB.outputScale).toBe(1);
  });

  /**
   * **Step one, with the port removed.** The game's own `hairline_cracks` is
   * NOT `abs(A - B)` of the game's own leaves at the scales the port asked for.
   * Only 7 of 61 agree, worst 5.272e-4.
   *
   * That number is not incidental: 5.272e-4 is exactly what breached
   * `vulcanusCracks.spec.ts`'s 3e-4 bound when #290's leaf fix was first tried
   * on its own, which is what made this findable. Fixing the leaves converged
   * the port onto `abs(gameA - gameB)` - and that was the wrong target.
   *
   * Frozen. If it moves, the capture or the leaf parameters changed.
   */
  it("the game's own leaves do not compose to the game's own hairline_cracks", () => {
    let exact = 0;
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const got = f32(Math.abs(fixture.leafAValues[i] - fixture.leafBValues[i]));
      if (got === fixture.hairlineCracks[i]) exact++;
      worst = Math.max(worst, Math.abs(got - fixture.hairlineCracks[i]));
    }
    expect(exact).toBe(7);
    expect(worst).toBeGreaterThan(5e-4);
    expect(worst).toBeLessThan(6e-4);
  });

  /**
   * **Step two.** Our leaf model reproduces the game's own leaves exactly, at
   * every position, on both leaves - including r = 3300 and the deep-field
   * point (12345.75, 6789.125), which the +/-400 grid in
   * `basisCallerScales.spec.ts` could not reach.
   *
   * A residual of exactly 0 is the confirmation standard here, not "it got
   * closer" - see `src/noise/eval/f32.ts`.
   */
  it("the leaf model reproduces the game's own leaves exactly, near field and far", () => {
    for (const [name, p, tables, want] of [
      ["leafA", fixture.leafA, tablesA, fixture.leafAValues],
      ["leafB", fixture.leafB, tablesB, fixture.leafBValues],
    ] as const) {
      let exact = 0;
      let worst = 0;
      for (let i = 0; i < N; i++) {
        const pos = fixture.positions[i];
        const got = f32(leaf(p, tables, pos.x, pos.y));
        if (got === want[i]) exact++;
        worst = Math.max(worst, Math.abs(got - want[i]));
      }
      expect(exact, `${name} exact`).toBe(N);
      expect(worst, `${name} worst residual`).toBe(0);
    }

    // Non-vacuity: these positions really do reach the far field, so the line
    // above is not a near-origin result wearing a wider label.
    //
    // Exactly 5 clear 3000, and the count is worth pinning rather than bounding
    // because it is easy to over-estimate: the r = 3300 ring has 8 points but
    // its four DIAGONALS sit at 3300 * cos(pi/4) ~ 2333, so only the four
    // axis-aligned ones qualify, plus the deep-field point at 12345.75.
    const far = fixture.positions.filter((p) => Math.max(Math.abs(p.x), Math.abs(p.y)) >= 3000);
    expect(far.length).toBe(5);
    expect(Math.max(...fixture.positions.map((p) => Math.abs(p.x)))).toBeGreaterThan(12000);
  });

  /**
   * **And the shipped port, end to end.** `makeVulcanusCracks` carries both
   * fixes - #290's leaf narrowing and #293's f32 scale chain - and reproduces
   * the game at every one of the 61 positions.
   *
   * It was 2 of 61 before. Frozen at a full house: if this ever drops, read it,
   * do not adjust it.
   */
  it("the shipped hairlineCracks reproduces the game at every position", () => {
    const ctx = withCtxDefaults({ seed0: fixture.seed0 });
    const cracks = makeVulcanusCracks(ctx, makeVulcanusHelpers(ctx));
    let exact = 0;
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const p = fixture.positions[i];
      const got = f32(cracks.hairlineCracks(p.x, p.y));
      if (got === fixture.hairlineCracks[i]) exact++;
      worst = Math.max(worst, Math.abs(got - fixture.hairlineCracks[i]));
    }
    expect(exact).toBe(N);
    expect(worst).toBe(0);
  });
});
