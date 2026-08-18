import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/basis-noise.seed123456.json";
import table from "./fixtures/basis-gradient-table.json";
import { GRADIENT_X, GRADIENT_Y } from "../src/noise/basisGradientTable";
import { basisNoise, type BasisNoiseTables } from "../src/noise/basisNoise";

// Ground truth captured from Factorio 2.1.11 via calculate_tile_properties, and
// re-verified bit-for-bit on 2.1.12 (see PROVENANCE.json).
// See docs/noise/basis-noise-NOTES.md for how the tables were recovered.
const tables: BasisNoiseTables = {
  sigma: fixture.sigma,
  a: fixture.a,
  b: fixture.b,
};

describe("basisNoise", () => {
  it("reproduces the game's own values at 512 independent points", () => {
    let worst = 0;
    for (const p of fixture.points) {
      const got = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
      worst = Math.max(worst, Math.abs(got - p.v));
    }
    // Measured EXACTLY 0 since 2026-08-18, when the gradient table stopped
    // being derived from a formula and started being recovered from the game
    // (#234). It was 1.1921e-7 before that (#214), and 1e-5 before THAT - 84x
    // slack that passed the whole time the kernel was evaluating in f64 with
    // the wrong falloff and the wrong summation order, which is exactly the
    // defect a loose bound cannot see.
    //
    // Zero is not a bound at all any more, which is the point: the sharp test
    // below is now the only one carrying weight, and this one is kept because
    // a regression would show up here as a number rather than as a count.
    expect(worst).toBe(0);
  });

  it("reproduces ALL 512 of those values EXACTLY, bit for bit", () => {
    // The sharp instrument, and the reason the defect above survived a year of
    // green tests. Every `v` in this fixture is exactly f32 (asserted below),
    // so a bit-exact port reproduces it exactly and a tolerance cannot tell
    // "very close" from "identical". Under an error bound the old f64 kernel
    // looked fine; under this one it scores 132.
    //
    // 473 until 2026-08-18. The 39 that missed were read as "the game's minimax
    // gradient table, not our arithmetic", and that reading was right: the 39
    // went away when the table was recovered from the game instead of derived
    // from `f32(cos(f32(2*pi*h/256)) * 4.2)`, which differs in 28 of 256 slots
    // (#234). The kernel did not change.
    //
    // Not a number to lower. It is now the whole fixture, so any drop at all
    // means the arithmetic or the table changed, and the fix is to find out
    // which. `basisGradientTable.spec.ts` scores the old formula so the
    // 473-versus-512 comparison stays reproducible rather than a claim here.
    let exact = 0;
    for (const p of fixture.points) {
      expect(Math.fround(p.v)).toBe(p.v);
      const got = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
      if (Math.fround(got) === p.v) exact++;
    }
    expect(exact).toBe(512);
  });

  it("returns an f32-representable value, because the kernel is f32 throughout", () => {
    // Guards the narrowing itself. Drop a single `Math.fround` from the corner
    // sum and results start landing between f32 values, which this catches and
    // the error bound above does not.
    for (const p of fixture.points.slice(0, 64)) {
      const got = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
      expect(Math.fround(got)).toBe(got);
    }
  });

  it("returns exactly 0 on integer lattice points, as the game documents", () => {
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        expect(basisNoise(i, j, tables)).toBe(0);
      }
    }
  });

  it("is periodic with period 256 on both axes", () => {
    for (const [x, y] of [
      [0.5, 0.25],
      [11.125, 7.75],
      [-3.5, 2.125],
    ]) {
      expect(basisNoise(x + 256, y, tables)).toBeCloseTo(basisNoise(x, y, tables), 12);
      expect(basisNoise(x, y + 256, tables)).toBeCloseTo(basisNoise(x, y, tables), 12);
    }
  });

  it("the committed gradient table still matches the capture it came from", () => {
    // scripts/gen-gradient-table.ts is the only thing allowed to write
    // src/noise/basisGradientTable.ts, and nothing else re-derives it at load.
    // Without this, a hand-edit or a drifted generator is silent: the fixture
    // scores above would sag by a few points and look like noise.
    //
    // Until 2026-08-18 this recomputed the table with `Math.cos` and so was
    // engine-sensitive by construction - a known cost of committing constants
    // derived from trig (#214). The reference is now the measured JSON, so the
    // check no longer depends on the runtime's libm at all. That is a strict
    // improvement, and it is why #214's warning is gone rather than moved.
    for (let h = 0; h < 256; h++) {
      expect(GRADIENT_X[h]).toBe(Math.fround(table.gradientX[h]));
      expect(GRADIENT_Y[h]).toBe(Math.fround(table.gradientY[h]));
    }
  });

  it("the measured table is 256 f32 slots, from the seed the fixture uses", () => {
    // Guards the fixture itself rather than the generated file. Every value the
    // generator emits must already be f32, or the literals it writes would
    // round and the shipped table would not be the measured one.
    expect(table.gradientX.length).toBe(256);
    expect(table.gradientY.length).toBe(256);
    expect(GRADIENT_X.length).toBe(256);
    expect(GRADIENT_Y.length).toBe(256);
    for (const v of [...table.gradientX, ...table.gradientY]) {
      expect(Math.fround(v)).toBe(v);
    }
    // The recovery ran against the same seed pair the fixture was captured
    // with, which is what makes scoring one against the other meaningful.
    expect(table.seed0).toBe(fixture.seed);
    expect(table.seed1).toBe(0);
    expect(table.gradientX.length).toBe(fixture.gradientDirections);
  });

  it("every gradient has the measured 4.2 magnitude", () => {
    // The one property the fixture cannot check directly, and the reason the
    // magnitude is folded into the table at all. 4.19999919 +/- 1.4e-6 was
    // measured across 9216 lattice points; f32 storage moves each component by
    // up to half a ULP, so the length lands within ~1e-6 of 4.2.
    for (let h = 0; h < 256; h++) {
      const mag = Math.hypot(GRADIENT_X[h], GRADIENT_Y[h]);
      expect(Math.abs(mag - 4.2)).toBeLessThan(1e-6);
    }
  });

  it("stays within the measured output range", () => {
    // Hanodest's widely-quoted [-sqrt(3), sqrt(3)] is ~2% low; the real bound is
    // near 1.77. Guard the measured envelope, not the folklore one.
    let peak = 0;
    for (let i = 0; i < 4000; i++) {
      const x = (i * 7.13) % 251.7;
      const y = (i * 3.37) % 197.3;
      peak = Math.max(peak, Math.abs(basisNoise(x, y, tables)));
    }
    expect(peak).toBeGreaterThan(Math.sqrt(3));
    expect(peak).toBeLessThan(1.78);
  });
});
