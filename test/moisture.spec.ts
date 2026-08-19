import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-moisture.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { makeMoisture } from "../src/noise/expressions/moisture";

describe("makeMoisture reproduces the game's moisture (moisture_nauvis) tree", () => {
  const evalAt = makeMoisture({ seed0: fixture.seed0 });

  it("matches the game at every position, scored by exact f32 match count", () => {
    // Scored by exact match count, not a bound: every value in this fixture
    // satisfies `Math.fround(v) === v`, so a bound cannot tell "close" from
    // "identical" (#256).
    //
    // The sample coordinates are snapped onto the game's 1/256 `MapPosition`
    // grid first. This replaces a `< 4e-5` bound and a second on-grid-only
    // assertion that together blamed 14 off-grid positions and asked for a
    // re-capture. No re-capture was needed - see `test/captureGrid.ts` for the
    // evidence, the trunc-vs-floor control and the full 17-fixture table.
    // Snapping took this fixture from 15/26 at worst 3.070e-5 to
    // 18/26 at worst 5.960e-8.
    //
    // **The remaining 8 misses are unexplained**, and they are NOT the snap's
    // doing: they sit 1, 2 and 4 f32 ulps out, and 3 of them are at positions
    // that were already on the grid. Narrowing the incoming coordinates in
    // `basisNoise` and `variablePersistenceMultioctaveNoise` (the remaining
    // scope of #191) was measured against this and moved the count not at all.
    // Tracked in #255.
    //
    // `Math.fround` on the port's output is the house convention for an exact
    // comparison (test/voronoiNoise.spec.ts:85), not slack: the tree evaluates
    // in f32 internally but the entry point returns a JS number.
    let exact = 0;
    let worst = 0;
    let worstLabel = "";
    for (const [i, p] of fixture.positions.entries()) {
      const s = snapPosition(p);
      const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - fixture.moisture[i]);
      if (err === 0) exact++;
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    expect(fixture.positions.length).toBe(26); // a regen cannot empty the loop
    expect(exact, `worst ${worstLabel}`).toBe(18);
    // 2^-24 is one f32 ulp for a value in [0.5, 1). Do not raise it.
    expect(worst, `worst ${worstLabel}`).toBeLessThanOrEqual(2 ** -24);
  });

  it("still has off-grid positions for the snap to correct", () => {
    // Anti-vacuity for the snap. If a re-capture lands every position on the
    // 1/256 grid this reaches 0, and `snapPosition` should then be deleted here
    // rather than left looking load-bearing.
    expect(countOffGrid(fixture.positions)).toBe(14);
  });
});

describe("makeMoisture parameters", () => {
  const GRID: Array<[number, number]> = [
    [0.5, 0.25],
    [2200.5, 0.25],
    [-1600.5, 1200.25],
    [12345.75, 6789.125],
  ];

  it("defaults moistureBias to 0 (omitted === explicit 0)", () => {
    const def = makeMoisture({ seed0: 123456 });
    const explicit = makeMoisture({ seed0: 123456, moistureBias: 0 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("defaults moistureFrequency to 1 (omitted === explicit 1)", () => {
    const def = makeMoisture({ seed0: 123456 });
    const explicit = makeMoisture({ seed0: 123456, moistureFrequency: 1 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("defaults segmentationMultiplier to 1 (omitted === explicit 1)", () => {
    const def = makeMoisture({ seed0: 123456 });
    const explicit = makeMoisture({ seed0: 123456, segmentationMultiplier: 1 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("defaults startingAreaMoistureSize to 1 and startingAreaMoistureFrequency to 1 (omitted === explicit)", () => {
    const def = makeMoisture({ seed0: 123456 });
    const explicit = makeMoisture({
      seed0: 123456,
      startingAreaMoistureSize: 1,
      startingAreaMoistureFrequency: 1,
    });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("defaults startingPositions to a single origin spawn (omitted === explicit)", () => {
    const def = makeMoisture({ seed0: 123456 });
    const explicit = makeMoisture({ seed0: 123456, startingPositions: [{ x: 0, y: 0 }] });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("at default startingAreaMoistureSize=1, slider_to_linear degenerates to 0 so bias shifts the result directly (away from the cutout/cap)", () => {
    // Pick a point far from the origin spawn so startingBiasRegion ~ 0 and the
    // moistureMain isn't already pinned at the 0.45 cap or clamped at an edge.
    const def = makeMoisture({ seed0: 123456 });
    const biased = makeMoisture({ seed0: 123456, moistureBias: -0.2 });
    const [x, y] = [12345.75, 6789.125];
    // moistureMain shifts by exactly the bias (both unclamped here); the final
    // max/min wrapper only pulls the result down further when moistureMain is
    // clamped or when the cutout term bites, so a negative bias shift should
    // propagate through unless it hits the [0,1] clamp.
    const d = def(x, y);
    const b = biased(x, y);
    expect(b).toBeLessThanOrEqual(d);
  });

  it("stays within [0, 1] even under an extreme bias", () => {
    const evalHigh = makeMoisture({ seed0: 123456, moistureBias: 1000 });
    for (const [x, y] of GRID) {
      expect(evalHigh(x, y)).toBeLessThanOrEqual(1);
      expect(evalHigh(x, y)).toBeGreaterThanOrEqual(0);
    }
    const evalLow = makeMoisture({ seed0: 123456, moistureBias: -1000 });
    for (const [x, y] of GRID) {
      expect(evalLow(x, y)).toBeGreaterThanOrEqual(0);
    }
  });
});
