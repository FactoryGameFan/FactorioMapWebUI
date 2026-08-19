import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-aux.seed123456.json";
import { makeAux } from "../src/noise/expressions/aux";

describe("makeAux reproduces the game's aux (aux_nauvis) tree", () => {
  const evalAt = makeAux({ seed0: fixture.seed0 });

  it("matches the numeric aux to the f32 coordinate floor", () => {
    let worst = 0;
    let worstLabel = "";
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      const err = Math.abs(evalAt(p.x, p.y) - fixture.aux[i]);
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    // Starting floor for this milestone is 8e-3 (the elevation f32-coordinate
    // floor), but aux's noise term has output_scale 0.25 and the whole result
    // is clamped to [0,1], so any f32 divergence is shrunk well below that.
    // Observed worst here is ~1.01e-5 (@(-2332.95, -2333.20), the deep-field
    // far ring); calibrated just above it - never loosen this without a new
    // observed-worst measurement to justify it.
    expect(worst, `worst ${worstLabel}`).toBeLessThan(2e-5);
  });

  // **14 of this fixture's 26 positions are NOT on the 1/256 grid, and they carry
  // essentially the whole residual above.** A capture coordinate that is not a
  // multiple of 1/256 makes the game sample a slightly different point than the
  // fixture records (#186), so those 14 rows grade the capture as much as the
  // port and no port can ever be exact on them. Split out, measured 2026-08-18:
  //
  // | subset | worst |
  // | --- | --- |
  // | on the 1/256 grid (12 points) | 6.923e-8 |
  // | off it (14 points) | 1.262e-5 |
  //
  // So the 2e-5 bound above is calibrated against a capture artifact. It stays,
  // because the off-grid rows are still in the fixture - but it is not a
  // statement about this tree's accuracy, and reading it as one is how the
  // gradeable half stayed invisible. This second assertion is the real one: on
  // the points the fixture can legitimately grade, aux sits ~288x tighter than
  // the headline bound suggests.
  //
  // The right repair is to re-capture on the 1/256 grid, which needs a Factorio
  // install and is separate work. Until then, do not tighten the bound above and
  // do not loosen this one.
  //
  // **Do not try to make this bound discriminate `quick_multioctave_noise`'s
  // precision - measured, it cannot.** Reverting that op to f64 entirely moves
  // aux's on-grid worst from 6.9231e-8 to 7.1443e-8, a 3% change, where the same
  // revert moves moisture 17x and temperature 154x past their bounds. The reason
  // is structural rather than lucky: all four parameters aux passes are already
  // exactly representable in f32 (input_scale 1/2048, output_scale 0.25,
  // octave_output_scale_multiplier 0.5, octave_input_scale_multiplier 3), its
  // output_scale is small, and the result is clamped to [0,1]. So this assertion
  // is a genuine bound with modest headroom, NOT a guard on that op - the guards
  // that bite live in test/quickMultioctaveNoise.spec.ts, test/moisture.spec.ts
  // and test/vulcanusCliffs.spec.ts.
  it("matches the game on the positions the fixture can actually grade", () => {
    let worst = 0;
    let worstLabel = "";
    let graded = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      if (Math.round(p.x * 256) !== p.x * 256 || Math.round(p.y * 256) !== p.y * 256) continue;
      graded++;
      const err = Math.abs(evalAt(p.x, p.y) - fixture.aux[i]);
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
