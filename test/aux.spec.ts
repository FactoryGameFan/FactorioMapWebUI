import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-aux.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { makeAux } from "../src/noise/expressions/aux";

describe("makeAux reproduces the game's aux (aux_nauvis) tree", () => {
  const evalAt = makeAux({ seed0: fixture.seed0 });

  it("matches the game at every position, scored by exact f32 match count", () => {
    // Scored by exact match count, not a bound: every value in this fixture
    // satisfies `Math.fround(v) === v`, so a bound cannot tell "close" from
    // "identical" (#256).
    //
    // The sample coordinates are snapped onto the game's 1/256 `MapPosition`
    // grid first. This replaces a `< 2e-5` bound and a second on-grid-only
    // assertion that together blamed 14 off-grid positions and asked for a
    // re-capture. No re-capture was needed - see `test/captureGrid.ts` for the
    // evidence, the trunc-vs-floor control and the full 17-fixture table.
    // Snapping took this fixture from 10/26 at worst 1.262e-5 to 14/26 at
    // worst 5.960e-8.
    //
    // **The remaining 12 misses are unexplained**, and they are NOT the snap's
    // doing: they sit 1 and 4 f32 ulps out, and 3 of them are at positions that
    // were already on the grid. Narrowing the incoming coordinates in
    // `basisNoise` and `variablePersistenceMultioctaveNoise` (the remaining
    // scope of #191) was measured against this and moved the count not at all.
    // Tracked in #255.
    //
    // The old comment here called (-2332.95, -2333.20) "the deep-field point".
    // It is not - the deep-field point is (12345.75, 6789.125), which is ON the
    // 1/256 grid. That was an off-grid ring point, which is exactly why it
    // carried the worst residual.
    //
    // `Math.fround` on the port's output is the house convention for an exact
    // comparison (test/voronoiNoise.spec.ts:85), not slack: the tree evaluates
    // in f32 internally but the entry point returns a JS number.
    let exact = 0;
    let worst = 0;
    let worstLabel = "";
    for (const [i, p] of fixture.positions.entries()) {
      const s = snapPosition(p);
      const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - fixture.aux[i]);
      if (err === 0) exact++;
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    expect(fixture.positions.length).toBe(26); // a regen cannot empty the loop
    expect(exact, `worst ${worstLabel}`).toBe(14);
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

describe("makeAux bias and frequency parameters", () => {
  const GRID: Array<[number, number]> = [
    [0.5, 0.25],
    [2200.5, 0.25],
    [-1600.5, 1200.25],
    [12345.75, 6789.125],
  ];

  it("defaults bias to 0 (omitted === explicit 0)", () => {
    const def = makeAux({ seed0: 123456 });
    const explicit = makeAux({ seed0: 123456, bias: 0 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("shifts the result by exactly the bias, until clamped", () => {
    const def = makeAux({ seed0: 123456 });
    const biased = makeAux({ seed0: 123456, bias: 0.1 });
    for (const [x, y] of GRID) {
      expect(biased(x, y)).toBeCloseTo(Math.min(def(x, y) + 0.1, 1), 9);
    }
  });

  it("defaults frequency to 1 (omitted === explicit 1)", () => {
    const def = makeAux({ seed0: 123456 });
    const explicit = makeAux({ seed0: 123456, frequency: 1 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("defaults segmentationMultiplier to 1 (omitted === explicit 1)", () => {
    const def = makeAux({ seed0: 123456 });
    const explicit = makeAux({ seed0: 123456, segmentationMultiplier: 1 });
    for (const [x, y] of GRID) expect(def(x, y)).toBe(explicit(x, y));
  });

  it("stays within the [0, 1] clamp bounds", () => {
    const evalHigh = makeAux({ seed0: 123456, bias: 1000 });
    for (const [x, y] of GRID) {
      expect(evalHigh(x, y)).toBeLessThanOrEqual(1);
      expect(evalHigh(x, y)).toBeGreaterThanOrEqual(0);
    }
    const evalLow = makeAux({ seed0: 123456, bias: -1000 });
    for (const [x, y] of GRID) {
      expect(evalLow(x, y)).toBeGreaterThanOrEqual(0);
    }
  });
});
