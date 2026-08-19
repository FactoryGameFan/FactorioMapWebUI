import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-temperature.seed123456.json";
import { makeTemperature } from "../src/noise/expressions/temperature";

describe("makeTemperature reproduces the game's temperature (temperature_basic) tree", () => {
  const evalAt = makeTemperature({ seed0: fixture.seed0 });

  it("matches the numeric temperature to the f32 coordinate floor", () => {
    let worst = 0;
    let worstLabel = "";
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      const err = Math.abs(evalAt(p.x, p.y) - fixture.temperature[i]);
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    // Starting floor for this milestone is 8e-3 (the elevation f32-coordinate
    // floor), but temperature's output_scale of 1/20 shrinks any f32 divergence
    // by the same factor, so the observed worst here (~7.07e-5) is far tighter.
    // Calibrated just above that observed worst - never loosen this without a
    // new observed-worst measurement to justify it.
    expect(worst, `worst ${worstLabel}`).toBeLessThan(1e-4);
  });

  // **14 of this fixture's 26 positions are NOT on the 1/256 grid, and they carry
  // essentially the whole residual above.** A capture coordinate that is not a
  // multiple of 1/256 makes the game sample a slightly different point than the
  // fixture records (#186), so those 14 rows grade the capture as much as the
  // port and no port can ever be exact on them. Split out, measured 2026-08-18:
  //
  // | subset | worst |
  // | --- | --- |
  // | on the 1/256 grid (12 points) | 9.537e-7 |
  // | off it (14 points) | 5.805e-5 |
  //
  // So the 1e-4 bound above is calibrated against a capture artifact. It stays,
  // because the off-grid rows are still in the fixture - but it is not a
  // statement about this tree's accuracy, and reading it as one is how the
  // gradeable half stayed invisible. This second assertion is the real one: on
  // the points the fixture can legitimately grade, temperature sits ~104x tighter than
  // the headline bound suggests.
  //
  // The right repair is to re-capture on the 1/256 grid, which needs a Factorio
  // install and is separate work. Until then, do not tighten the bound above and
  // do not loosen this one.
  it("matches the game on the positions the fixture can actually grade", () => {
    let worst = 0;
    let worstLabel = "";
    let graded = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      if (Math.round(p.x * 256) !== p.x * 256 || Math.round(p.y * 256) !== p.y * 256) continue;
      graded++;
      const err = Math.abs(evalAt(p.x, p.y) - fixture.temperature[i]);
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    // Anti-vacuity: if a future re-capture puts every position on the grid this
    // still grades them all, but if one puts NONE on it the loop would silently
    // assert nothing.
    expect(graded).toBe(12);
    expect(worst, `worst on-grid ${worstLabel}`).toBeLessThan(2e-6);
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
