import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/basis-noise.seed123456.json";
import { GRADIENT_X, GRADIENT_Y } from "../src/noise/basisGradientTable";
import { basisNoise, type BasisNoiseTables } from "../src/noise/basisNoise";

// Ground truth captured from Factorio 2.1.11 via calculate_tile_properties.
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
    // Measured 1.1921e-7 (#214). The old bound here was 1e-5, which is 84x
    // slack - it passed the whole time the kernel was evaluating in f64 with
    // the wrong falloff and the wrong summation order, which is exactly the
    // defect a loose bound cannot see.
    expect(worst).toBeLessThan(1.3e-7);
  });

  it("reproduces 473 of those 512 values EXACTLY, bit for bit", () => {
    // The sharp instrument, and the reason the defect above survived a year of
    // green tests. Every `v` in this fixture is exactly f32 (asserted below),
    // so a bit-exact port reproduces it exactly and a tolerance cannot tell
    // "very close" from "identical". Under an error bound the old f64 kernel
    // looked fine; under this one it scores 132.
    //
    // Not a bound to widen. A drop means the kernel's arithmetic changed, and
    // the fix is to find out why, not to lower the number. The 39 that miss
    // are 18 at 1 ULP, 11 at 2 ULP and a tail of near-zero cancellations; they
    // are the game's minimax gradient table, not our arithmetic.
    let exact = 0;
    for (const p of fixture.points) {
      expect(Math.fround(p.v)).toBe(p.v);
      const got = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
      if (Math.fround(got) === p.v) exact++;
    }
    expect(exact).toBe(473);
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

  it("the committed gradient table still matches the formula that generated it", () => {
    // scripts/gen-gradient-table.ts is the only thing allowed to write
    // src/noise/basisGradientTable.ts, and nothing else re-derives it at load.
    // Without this, a hand-edit or a drifted generator is silent: the fixture
    // scores above would sag by a few points and look like noise.
    //
    // This recomputes with `Math.cos`, so it is engine-sensitive by
    // construction - which is the POINT of committing the table, not a flaw in
    // the test. If it ever fails on a new runtime with the file untouched,
    // that runtime's trig differs from the one the constants were built on,
    // and the constants are what ship. Do not "fix" it by regenerating on the
    // new engine without reading #214 first.
    const f = Math.fround;
    expect(GRADIENT_X.length).toBe(256);
    expect(GRADIENT_Y.length).toBe(256);
    for (let h = 0; h < 256; h++) {
      const angle = f((2 * Math.PI * h) / 256);
      expect(GRADIENT_X[h]).toBe(f(Math.cos(angle) * 4.2));
      expect(GRADIENT_Y[h]).toBe(f(Math.sin(angle) * 4.2));
    }
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
