import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-climate.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusClimate } from "../src/noise/expressions/vulcanusClimate";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";

describe("makeVulcanusClimate", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const climate = makeVulcanusClimate(ctx, helpers, cracks);
  const positions = fixture.positions;

  // Each bound is the measured worst residual, rounded up with modest headroom.
  //
  // The sample coordinate is snapped onto the game's 1/256 MapPosition grid first
  // (see test/captureGrid.ts). 21 of these 61 positions were captured off it, so
  // the game evaluated at a different point than the fixture records (#186), and
  // those rows carried the whole excess: aux went from 4.584e-4 to 3.359e-6 and
  // moisture from 1.117e-4 to 2.714e-6 - 136x and 41x.
  //
  // The old comment blamed "the deep-field point ((12345.75, 6789.125)) - the same
  // far-from-origin f32 coordinate floor". Both halves were wrong. That point is
  // ON the 1/256 grid (12345.75*256 = 3160512, 6789.125*256 = 1738016), so the
  // snap cannot touch it, and it was not the worst point before the snap - aux
  // measures exactly 0 there. The worst sat on the off-grid r=1500/3000 rings.
  const check = (fn: (x: number, y: number) => number, want: number[], bound: number): void => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = snapPosition(positions[i]);
      worst = Math.max(worst, Math.abs(fn(p.x, p.y) - want[i]));
    }
    expect(worst, `worst ${worst.toExponential(4)}`).toBeLessThan(bound);
  };

  it("vulcanus_aux matches the oracle to the f32 floor", () => {
    check(climate.aux, fixture.aux, 4e-6);
  });

  it("vulcanus_moisture matches the oracle to the f32 floor", () => {
    check(climate.moisture, fixture.moisture, 3e-6);
  });
});

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-vulcanus-climate still has off-grid positions", () => {
    expect(countOffGrid(fixture.positions)).toBe(21);
  });
});
