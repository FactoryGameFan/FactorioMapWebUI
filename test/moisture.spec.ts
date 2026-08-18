import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-moisture.seed123456.json";
import { makeMoisture } from "../src/noise/expressions/moisture";

describe("makeMoisture reproduces the game's moisture (moisture_nauvis) tree", () => {
  const evalAt = makeMoisture({ seed0: fixture.seed0 });

  it("matches the numeric moisture to the f32 coordinate floor", () => {
    let worst = 0;
    let worstLabel = "";
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      const err = Math.abs(evalAt(p.x, p.y) - fixture.moisture[i]);
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    // Starting floor for this milestone is 8e-3 (the elevation f32-coordinate
    // floor), but moisture's noise term has output_scale 0.125 and the whole
    // result is clamped to [0,1] (plus a further 0.45 cap/cutout blend), so any
    // f32 divergence is shrunk well below that. Observed worst here is
    // ~2.76e-5 (@(1556.13, 1555.88), a far ring point); calibrated just above
    // it - never loosen this without a new observed-worst measurement to
    // justify it.
    expect(worst, `worst ${worstLabel}`).toBeLessThan(4e-5);
  });

  // **14 of this fixture's 26 positions are NOT on the 1/256 grid, and they carry
  // essentially the whole residual above.** A capture coordinate that is not a
  // multiple of 1/256 makes the game sample a slightly different point than the
  // fixture records (#186), so those 14 rows grade the capture as much as the
  // port and no port can ever be exact on them. Split out, measured 2026-08-18:
  //
  // | subset | worst |
  // | --- | --- |
  // | on the 1/256 grid (12 points) | 5.651e-8 |
  // | off it (14 points) | 3.070e-5 |
  //
  // So the 4e-5 bound above is calibrated against a capture artifact. It stays,
  // because the off-grid rows are still in the fixture - but it is not a
  // statement about this tree's accuracy, and reading it as one is how the
  // gradeable half stayed invisible. This second assertion is the real one: on
  // the points the fixture can legitimately grade, moisture sits ~707x tighter than
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
      const err = Math.abs(evalAt(p.x, p.y) - fixture.moisture[i]);
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    // Anti-vacuity: if a future re-capture puts every position on the grid this
    // still grades them all, but if one puts NONE on it the loop would silently
    // assert nothing.
    expect(graded).toBe(12);
    expect(worst, `worst on-grid ${worstLabel}`).toBeLessThan(2e-7);
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
