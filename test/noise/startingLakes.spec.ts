import { describe, expect, it } from "vite-plus/test";
import fixture from "../fixtures/oracle-elevation-lakes.seed123456.json";
import { startingLakePositions } from "../../src/noise/startingLakes";
import { distanceFromNearestPoint } from "../../src/noise/distanceFromNearestPoint";
import { snapPosition } from "../captureGrid";

describe("startingLakePositions (RE of MapGenSettings::getStartingLakePositions)", () => {
  it("computes the game's real starting lake for seed 123456", () => {
    // Trilaterated exactly from the fixture's 9 near-spawn startingLakeDistance values.
    expect(startingLakePositions(123456, [{ x: 0, y: 0 }])).toEqual([{ x: 45, y: -59 }]);
  });

  it("reproduces every startingLakeDistance in the fixture exactly", () => {
    // This was a `toBeLessThan(2e-5)` bound until 2026-08-18, explained as
    // "f64-vs-f32 rounding is the floor here". That explanation was wrong: the
    // floor was `distanceFromNearestPoint` returning a raw f64 when the game's
    // op stores an f32 (#220). With that corrected there is no floor, so this
    // is an exact count - a bound cannot tell "close" from "identical", and
    // 17 of these 26 rows are pinned at the 1024 cap where any bound passes.
    const lakes = startingLakePositions(fixture.seed0, [{ x: 0, y: 0 }]);
    let exact = 0;
    let worst = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = snapPosition(fixture.positions[i]);
      const d = distanceFromNearestPoint(p.x, p.y, lakes, 1024);
      if (d === fixture.startingLakeDistance[i]) exact++;
      worst = Math.max(worst, Math.abs(d - fixture.startingLakeDistance[i]));
    }
    expect(fixture.positions.length).toBe(26); // a regen cannot empty the loop
    expect(exact).toBe(26);
    expect(worst).toBe(0);
  });

  it("has only 9 rows that discriminate anything - the other 17 sit at the cap", () => {
    // Worth pinning because it bounds what the test above can prove: a lake
    // placed anywhere far enough away reproduces a saturated row.
    const saturated = fixture.startingLakeDistance.filter((v) => v === 1024).length;
    expect(saturated).toBe(17);
    expect(fixture.startingLakeDistance.length - saturated).toBe(9);
  });

  it("places each lake at radius 75 from its spawn (pre-truncation invariant)", () => {
    const [lake] = startingLakePositions(999, [{ x: 0, y: 0 }]);
    expect(Math.hypot(lake.x, lake.y)).toBeGreaterThan(73);
    expect(Math.hypot(lake.x, lake.y)).toBeLessThanOrEqual(75);
  });

  it("returns one lake per starting position, in order", () => {
    const lakes = startingLakePositions(123456, [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
    ]);
    expect(lakes).toHaveLength(2);
    // second lake is near its own spawn (within radius 75)
    expect(Math.hypot(lakes[1].x - 1000, lakes[1].y)).toBeLessThanOrEqual(75);
  });

  it("returns empty for empty starting positions", () => {
    expect(startingLakePositions(123456, [])).toEqual([]);
  });
});
