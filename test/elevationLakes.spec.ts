import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-elevation-lakes.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { makeElevationLakes } from "../src/noise/expressions/elevationLakes";

// Task 0 confirmed: starting_positions = origin spawn (distance == hypot), so the
// EvalCtx defaults are faithful. starting_lake_positions is non-empty near spawn,
// so we parity-test only where the game's own starting_lake_distance saturated at
// 1024 (the empty-lake far-from-spawn ctx is exact there).
const SATURATED = (i: number) => fixture.startingLakeDistance[i] >= 1024;

describe("elevationLakes reproduces the game's elevation_lakes tree (far from spawn)", () => {
  const evalAt = makeElevationLakes({ seed0: fixture.seed0 });

  it("has parity-testable points (guards against a fixture regen dropping them)", () => {
    expect(fixture.positions.filter((_p, i) => SATURATED(i)).length).toBeGreaterThanOrEqual(12);
  });

  it("matches the water mask (elevation < 0) away from the coastline", () => {
    for (let i = 0; i < fixture.positions.length; i++) {
      if (!SATURATED(i)) continue;
      const exp = fixture.elevation[i];
      if (Math.abs(exp) < 1e-3) continue; // coastline: sign is ambiguous within the floor
      const s = snapPosition(fixture.positions[i]);
      expect(evalAt(s.x, s.y) < 0).toBe(exp < 0);
    }
  });

  it("matches the numeric elevation to the f32 coordinate floor", () => {
    let worst = 0;
    let worstLabel = "";
    for (let i = 0; i < fixture.positions.length; i++) {
      if (!SATURATED(i)) continue;
      const p = fixture.positions[i];
      const s = snapPosition(p);
      const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - fixture.elevation[i]);
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    // This bound was 8e-3, explained as "the game's f32 coordinate pipeline
    // diverges from our f64". That explanation was wrong. The 14 far-ring
    // positions were CAPTURED off the game's 1/256 MapPosition grid, so the game
    // sampled a different point than the fixture recorded (#186). Snapping the
    // sample coordinate the way the game does takes this set from 6/17 exact at
    // worst 7.372e-3 to 13/17 at worst 3.815e-6 - a 1,933x drop, and the largest
    // single correction of the 17 affected fixtures after rock-density and the
    // vulcanus resources. See `test/captureGrid.ts`.
    //
    // Calibrated just above the measured post-snap worst. The 4 remaining misses
    // are unexplained and tracked in #255; do not raise this to accommodate them.
    expect(worst, `worst ${worstLabel}`).toBeLessThan(4e-6);
  });

  it("now matches near-spawn elevation too (computed starting lakes)", () => {
    // evalAt uses the computed starting_lake_positions default, so the near-spawn
    // band the M1 test could not assert (starting_lake_distance < 1024) is now
    // faithful. This is the payoff of porting getStartingLakePositions.
    let worst = 0;
    let worstLabel = "";
    let checked = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      if (SATURATED(i)) continue; // the previously-unassertable near-spawn band
      const p = fixture.positions[i];
      const s = snapPosition(p);
      const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - fixture.elevation[i]);
      checked++;
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(9);
    // All 9 near-spawn positions are already ON the 1/256 grid, so the snap is
    // the identity here and this number is unchanged by it - which is the control
    // that says the snap only moved rows it should have. The old bound was the
    // far field's 8e-3, which was ~16,000x the measured worst; it is now
    // calibrated to that worst instead. The point of the test is unchanged: terms
    // 2-4 consume starting_lake_distance, so this asserts they use the CORRECT
    // near-spawn lakes rather than diverging as they did with [].
    expect(worst, `worst ${worstLabel}`).toBeLessThan(5e-7);
  });

  it("still has off-grid positions for the snap to correct", () => {
    // Anti-vacuity for the snap. All 14 are in the far set; if a re-capture ever
    // lands them on the grid this reaches 0 and `snapPosition` should be deleted
    // here rather than left looking load-bearing.
    expect(countOffGrid(fixture.positions)).toBe(14);
  });
});

describe("makeElevationLakes bias parameter", () => {
  const GRID: Array<[number, number]> = [
    [0.5, 0.25],
    [2200.5, 0.25],
    [-1600.5, 1200.25],
    [12345.75, 6789.125],
  ];

  it("defaults bias to 20 (omitted === explicit 20)", () => {
    const def = makeElevationLakes({ seed0: 123456 });
    const explicit = makeElevationLakes({ seed0: 123456, bias: 20 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("is monotonic non-decreasing in bias and actually takes effect", () => {
    const def = makeElevationLakes({ seed0: 123456 });
    const low = makeElevationLakes({ seed0: 123456, bias: -1000 });
    let strictlyLowerSomewhere = false;
    for (const [x, y] of GRID) {
      // Lowering bias can only lower or keep max(branch1, branch2) -> lower or keep the tree.
      expect(low(x, y)).toBeLessThanOrEqual(def(x, y) + 1e-9);
      if (low(x, y) < def(x, y) - 1e-6) strictlyLowerSomewhere = true;
    }
    expect(strictlyLowerSomewhere).toBe(true);
  });
});
