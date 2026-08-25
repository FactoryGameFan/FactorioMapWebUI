import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-plasma-decomposition.seed123456.json";
import cracksFixture from "./fixtures/oracle-vulcanus-cracks.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
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
 * ## A note on the version, and the claim this file used to make
 *
 * This fixture is captured from **2.1.14**;
 * `oracle-vulcanus-cracks.seed123456.json` is from **2.1.12**. This file used
 * to say the model scored 61 of 61 here and 50 of 61 there "at identical
 * positions", and read those 11 as a GAME VERSION difference (#295). Both
 * halves are wrong, and the second one is why the first looked true.
 *
 * **The positions are not identical.** The older fixture records 21 of its 61
 * coordinates off the 1/256 `MapPosition` grid and its sweep scored them raw,
 * so a third of that grade happened at points the game never evaluated.
 * Snapped, it scores 61 of 61 as well.
 *
 * **And the two captures share only 52 of their 61 points**, which is a
 * property of the harness rather than of either version. A capture PRODUCES a
 * grid coordinate with `Math.floor` (`snapToMapPosition` in
 * `test/oracle/capture.ts`); `test/captureGrid.ts` RECOVERS one with
 * `Math.trunc`, because truncation toward zero is what the game does to a
 * coordinate handed to it off the grid. Both are right for their own job, and
 * they differ by one cell on a coordinate that is both NEGATIVE and off the
 * grid - true at exactly 9 of these 61 positions, which is why nothing near the
 * origin ever showed it. So a re-capture of an off-grid fixture cannot land on
 * the points that snapping the old one produces, and comparing two captures'
 * COUNTS compares two different sample sets.
 *
 * At the 52 points they do share, the two captures record bit-identical values.
 * `the two captures agree wherever they sample the same point` asserts it. The
 * game did not change.
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

  /**
   * **Game against game, across two versions, with the port removed.**
   *
   * This is the measurement that settles #295's headline reading. Neither side
   * is ours: both arrays are values Factorio itself produced, one at 2.1.12 and
   * one at 2.1.14. The only transformation is snapping the older fixture's
   * recorded coordinates onto the grid the game evaluated them at.
   *
   * A version difference and a capture-grid difference look identical from
   * inside a count, so the grid has to be ruled out first - and unlike a
   * re-capture, it is free. Re-capturing to test a version hypothesis will
   * confirm that hypothesis whether or not it is true, because the new fixture
   * is snapped and the old one is not, so the count rises either way.
   *
   * Backed by the data as well: every Lua file behind this chain -
   * `planet-vulcanus-map-gen.lua`, `noise-programs.lua`, `noise-functions.lua`,
   * `base/prototypes/noise-expressions.lua`, `tiles-vulcanus.lua` - is
   * byte-identical from 2.1.12 through 2.1.16.
   *
   * This asserts one field, because `hairlineCracks` is the only one the two
   * committed fixtures have in common. The same comparison was run against a
   * fresh **2.1.16** capture across all five crack fields on 2026-08-25 and
   * came back bit-identical at every shared point there too; that capture is
   * deliberately not committed, since adopting it would move frozen counts for
   * a difference now measured to be zero. `load_captured_at` in
   * `crates/fmw-noise/src/fixtures.rs` records the full result and the reason
   * only 52 of the 61 points are shared.
   */
  it("the two captures agree wherever they sample the same point", () => {
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    const atPoint = new Map<string, number>();
    fixture.positions.forEach((p, i) => atPoint.set(key(p), fixture.hairlineCracks[i]));

    let shared = 0;
    let identical = 0;
    let control = 0;
    for (let i = 0; i < cracksFixture.positions.length; i++) {
      const k = key(snapPosition(cracksFixture.positions[i]));
      const want = atPoint.get(k);
      if (want === undefined) continue;
      shared++;
      if (Object.is(cracksFixture.hairlineCracks[i], want)) identical++;
      // Control: the same comparison against a DIFFERENT field of the same
      // fixture must fail everywhere, or "identical" is measuring nothing.
      if (Object.is(cracksFixture.floodCracksA[i], want)) control++;
    }

    // Anti-vacuity, both directions. If a re-capture ever lands the older
    // fixture on the grid, the snap becomes the identity and this stops being
    // a statement about anything; and if the two position sets ever drift
    // fully apart the loop empties while still reporting success.
    expect(countOffGrid(cracksFixture.positions), "off-grid positions").toBe(21);
    expect(shared, "points the two captures share").toBe(52);
    expect(control, "control - a different field must not match").toBe(0);

    expect(identical).toBe(shared);
  });
});
