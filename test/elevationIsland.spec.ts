import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-elevation-island.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { makeElevationIsland, elevationIsland } from "../src/noise/expressions/elevationIsland";
import { makeElevationLakes } from "../src/noise/expressions/elevationLakes";

const GRID: Array<[number, number]> = [
  [0.5, 0.25],
  [2200.5, 0.25],
  [-1600.5, 1200.25],
  [12345.75, 6789.125],
];

describe("makeElevationIsland delegates to lakes with bias=-1000 and seg/4", () => {
  it("equals makeElevationLakes with bias -1000 and segmentation/4 (default seg 1)", () => {
    const island = makeElevationIsland({ seed0: 123456 });
    const lakes = makeElevationLakes({ seed0: 123456, bias: -1000, segmentationMultiplier: 0.25 });
    for (const [x, y] of GRID) expect(island(x, y)).toBe(lakes(x, y));
  });

  it("divides an explicit segmentationMultiplier by 4", () => {
    const island = makeElevationIsland({ seed0: 123456, segmentationMultiplier: 2 });
    const lakes = makeElevationLakes({ seed0: 123456, bias: -1000, segmentationMultiplier: 0.5 });
    for (const [x, y] of GRID) expect(island(x, y)).toBe(lakes(x, y));
  });

  it("passes waterLevel and startingPositions through", () => {
    const opts = { seed0: 123456, waterLevel: 15, startingPositions: [{ x: 300, y: -400 }] };
    const island = makeElevationIsland(opts);
    const lakes = makeElevationLakes({ ...opts, bias: -1000, segmentationMultiplier: 0.25 });
    for (const [x, y] of GRID) expect(island(x, y)).toBe(lakes(x, y));
  });

  it("elevationIsland(ctx) matches makeElevationIsland(...)(x, y)", () => {
    const at = makeElevationIsland({ seed0: 123456 });
    expect(elevationIsland({ seed0: 123456, x: 2200.5, y: 0.25 })).toBe(at(2200.5, 0.25));
  });
});

// Parity is asserted only where the game's own starting_lake_distance saturated at
// 1024 (the empty-lake far-from-spawn ctx is exact there); plus a near-spawn block
// that uses the computed starting lakes. Mirrors elevationLakes.spec.ts.
const SATURATED = (i: number) => fixture.startingLakeDistance[i] >= 1024;

describe("elevationIsland reproduces the game's elevation_island tree", () => {
  const evalAt = makeElevationIsland({ seed0: fixture.seed0 });

  it("has parity-testable (saturated) points", () => {
    expect(fixture.positions.filter((_p, i) => SATURATED(i)).length).toBeGreaterThanOrEqual(12);
  });

  it("matches the water mask (elevation < 0) away from the coastline", () => {
    for (let i = 0; i < fixture.positions.length; i++) {
      if (!SATURATED(i)) continue;
      const exp = fixture.elevation[i];
      if (Math.abs(exp) < 1e-3) continue; // coastline: sign ambiguous within the floor
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
    // Was 8e-3, blamed on "the same f32 regime as lakes (offset_x=10000)". The
    // real cause was the off-grid capture coordinates: snapping them takes this
    // set from 4/17 exact at worst 6.673e-3 to 10/17 at worst 3.052e-5, a 219x
    // drop. Calibrated just above the measured post-snap worst.
    expect(worst, `worst ${worstLabel}`).toBeLessThan(4e-5);
  });

  it("matches near-spawn elevation too (computed starting lakes)", () => {
    let worst = 0;
    let worstLabel = "";
    let checked = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      if (SATURATED(i)) continue;
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
    expect(worst, `worst ${worstLabel}`).toBeLessThan(5e-7);
  });

  it("still has off-grid positions for the snap to correct", () => {
    // Anti-vacuity for the snap: if a re-capture lands every position on the
    // 1/256 grid this reaches 0 and `snapPosition` should be deleted here.
    expect(countOffGrid(fixture.positions)).toBe(14);
  });
});
