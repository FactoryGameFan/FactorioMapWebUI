import { describe, expect, it, vi } from "vite-plus/test";
import fixture from "./fixtures/basis-noise.seed123456.json";
import measured from "./fixtures/basis-gradient-table.json";
import { GRADIENT_X, GRADIENT_Y } from "../src/noise/basisGradientTable";
import { basisNoise, type BasisNoiseTables } from "../src/noise/basisNoise";

// This whole FILE runs the real kernel against the OLD formula table.
//
// `vi.mock` is hoisted and file-scoped, so the swap cannot be confined to one
// test - which is why this lives apart from basisNoise.spec.ts rather than
// beside the tests it is the counterweight to. Everything imported here,
// `GRADIENT_X` included, is the formula's, not the shipped table's.
//
// The point is to keep "473 versus 512" a measurement. Until 2026-08-18 the
// table was derived from `f32(cos(f32(2*pi*h/256)) * 4.2)`, picked by sweeping
// 384 variants (see scripts/gen-gradient-table.ts), and it scored 473 of 512.
// The measured table scores 512. Deleting the formula would leave that
// comparison as prose in a header that nothing can check; scoring it here means
// a change to the kernel moves BOTH numbers, and a change to the fixture is
// caught by whichever moves first.
vi.mock("../src/noise/basisGradientTable", () => {
  const f = Math.fround;
  const angle = (h: number): number => f((2 * Math.PI * h) / 256);
  return {
    GRADIENT_X: new Float32Array(
      Array.from({ length: 256 }, (_, h) => f(Math.cos(angle(h)) * 4.2)),
    ),
    GRADIENT_Y: new Float32Array(
      Array.from({ length: 256 }, (_, h) => f(Math.sin(angle(h)) * 4.2)),
    ),
  };
});

const tables: BasisNoiseTables = {
  sigma: fixture.sigma,
  a: fixture.a,
  b: fixture.b,
};

describe("the formula the gradient table used to come from", () => {
  it("scores 473 of 512, which is why the table is measured instead", () => {
    let exact = 0;
    for (const p of fixture.points) {
      const got = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
      if (Math.fround(got) === p.v) exact++;
    }
    // Also the control on the mock above. If the swap ever silently stopped
    // applying, this file would be scoring the shipped table and reading 512.
    expect(exact).toBe(473);
  });

  it("differs from the measured table in 28 of the 256 slots", () => {
    let differing = 0;
    for (let h = 0; h < 256; h++) {
      const same =
        GRADIENT_X[h] === Math.fround(measured.gradientX[h]) &&
        GRADIENT_Y[h] === Math.fround(measured.gradientY[h]);
      if (!same) differing++;
    }
    expect(differing).toBe(28);
  });

  it("misses by at most ~1e-7, which is why an error bound never caught it", () => {
    // The reason this went unnoticed for a year. 39 of 512 points were wrong
    // bit for bit while the worst absolute error stayed at 1.1921e-7 - inside
    // every bound this repo has ever set on basis noise. Counting exact
    // matches is what separated "very close" from "identical" (#214).
    let worst = 0;
    for (const p of fixture.points) {
      const got = basisNoise(p.x * fixture.inputScale, p.y * fixture.inputScale, tables);
      worst = Math.max(worst, Math.abs(got - p.v));
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1.3e-7);
  });
});
