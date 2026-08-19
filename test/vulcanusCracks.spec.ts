import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cracks.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";

describe("makeVulcanusCracks", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const positions = fixture.positions;

  // Each bound is the measured worst residual (rounded up with modest headroom),
  // dominated by the 21 of 61 positions that were CAPTURED off the game's 1/256
  // MapPosition grid, so the game evaluated at a different point than the fixture
  // records (#186). The sample coordinate is snapped the way the game does before
  // evaluation - see test/captureGrid.ts - which took these five arrays from
  // 1.853e-3 / 4.440e-4 / 1.122e-4 / 5.460e-4 / 6.387e-4 down to
  // 2.067e-4 / 1.354e-5 / 6.593e-6 / 4.548e-5 / 5.542e-5.
  //
  // The old comment named "the deep-field point (index 60, (12345.75, 6789.125))"
  // and "the far-from-origin f32 coordinate floor". Index 60 is ON the 1/256 grid,
  // so the snap is the identity there, and it was not the worst point before the
  // snap in any of the five arrays - the worst sat on the off-grid rings.
  const check = (name: keyof typeof cracks, want: number[], bound: number): void => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = snapPosition(positions[i]);
      const got = (cracks[name] as (x: number, y: number) => number)(p.x, p.y);
      worst = Math.max(worst, Math.abs(got - want[i]));
    }
    expect(worst, `worst ${worst.toExponential(4)}`).toBeLessThan(bound);
  };

  it("vulcanus_hairline_cracks matches the oracle to the f32 floor", () => {
    check("hairlineCracks", fixture.hairlineCracks, 3e-4);
  });

  it("vulcanus_flood_cracks_a matches the oracle to the f32 floor", () => {
    check("floodCracksA", fixture.floodCracksA, 2e-5);
  });

  it("vulcanus_flood_cracks_b matches the oracle to the f32 floor", () => {
    check("floodCracksB", fixture.floodCracksB, 8e-6);
  });

  it("vulcanus_flood_paths matches the oracle to the f32 floor", () => {
    check("floodPaths", fixture.floodPaths, 6e-5);
  });

  it("vulcanus_flood_basalts_func matches the oracle to the f32 floor", () => {
    check("floodBasaltsFunc", fixture.floodBasaltsFunc, 7e-5);
  });
});

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-vulcanus-cracks still has off-grid positions", () => {
    expect(countOffGrid(fixture.positions)).toBe(21);
  });
});
