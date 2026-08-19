import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-temperature.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { makeTemperature } from "../src/noise/expressions/temperature";

describe("makeTemperature reproduces the game's temperature (temperature_basic) tree", () => {
  const evalAt = makeTemperature({ seed0: fixture.seed0 });

  it("matches the game bit-for-bit at every position", () => {
    // Compared by exact f32 match count, not a bound. Every value in this
    // fixture satisfies `Math.fround(v) === v`, so a bound could not tell
    // "close" from "identical" (#256).
    //
    // This used to be two assertions behind a `< 1e-4` bound, with a long
    // comment blaming 14 off-grid positions and calling for a re-capture. No
    // re-capture was needed: the game truncated those coordinates onto its
    // 1/256 `MapPosition` grid, and snapping them the same way grades the port
    // at the point the game actually sampled. That took this fixture from
    // 17/26 exact at worst 5.817e-5 to 26/26 at worst 0 - watched failing with
    // the snap removed, reporting exactly 17. See `test/captureGrid.ts` for the
    // evidence and the controls.
    //
    // `Math.fround` on the port's output is the house convention for an
    // exact-match comparison (test/voronoiNoise.spec.ts:85): the tree evaluates
    // in f32 internally but the entry point returns a JS number, so the
    // narrowing belongs at the boundary. It is not slack - every fixture value
    // is already f32, so this compares bit patterns.
    let exact = 0;
    let worst = 0;
    let worstLabel = "";
    for (const [i, p] of fixture.positions.entries()) {
      const s = snapPosition(p);
      const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - fixture.temperature[i]);
      if (err === 0) exact++;
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    expect(fixture.positions.length).toBe(26); // a regen cannot empty the loop
    expect(exact, `worst ${worstLabel}`).toBe(26);
    expect(worst).toBe(0);
  });

  it("still has off-grid positions for the snap to correct", () => {
    // Anti-vacuity for the snap itself. If a future re-capture lands every
    // position on the 1/256 grid, `snapPosition` becomes the identity here and
    // should be deleted rather than left looking load-bearing.
    expect(countOffGrid(fixture.positions)).toBe(14);
  });
});

describe("makeTemperature bias and frequency parameters", () => {
  const GRID: Array<[number, number]> = [
    [0.5, 0.25],
    [2200.5, 0.25],
    [-1600.5, 1200.25],
    [12345.75, 6789.125],
  ];

  it("defaults bias to 0 (omitted === explicit 0)", () => {
    const def = makeTemperature({ seed0: 123456 });
    const explicit = makeTemperature({ seed0: 123456, bias: 0 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("shifts the result by exactly the bias, until clamped", () => {
    const def = makeTemperature({ seed0: 123456 });
    const biased = makeTemperature({ seed0: 123456, bias: 5 });
    for (const [x, y] of GRID) {
      expect(biased(x, y)).toBeCloseTo(Math.min(def(x, y) + 5, 50), 9);
    }
  });

  it("defaults frequency to 1 (omitted === explicit 1)", () => {
    const def = makeTemperature({ seed0: 123456 });
    const explicit = makeTemperature({ seed0: 123456, frequency: 1 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("stays within the [-20, 50] clamp bounds", () => {
    const evalAt = makeTemperature({ seed0: 123456, bias: 1000 });
    for (const [x, y] of GRID) {
      expect(evalAt(x, y)).toBeLessThanOrEqual(50);
      expect(evalAt(x, y)).toBeGreaterThanOrEqual(-20);
    }
    const evalLow = makeTemperature({ seed0: 123456, bias: -1000 });
    for (const [x, y] of GRID) {
      expect(evalLow(x, y)).toBeGreaterThanOrEqual(-20);
    }
  });
});
