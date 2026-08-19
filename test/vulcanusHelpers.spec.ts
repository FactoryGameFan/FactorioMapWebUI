import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-helpers.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { sliderRescale } from "../src/noise/eval/math";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";

describe("makeVulcanusHelpers", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const positions = fixture.positions;

  // Each bound is the measured worst residual (rounded up with modest headroom),
  // NOT an arbitrarily loosened tolerance - see the file-level note below on why
  // the deep-field point (index 37, (12345.75, 6789.125)) dominates every bound
  // here: the same "far-from-origin f32 coordinate floor" this codebase's other
  // oracle specs document (e.g. elevationLakes/elevationNauvis/elevationIsland's
  // 8e-3, multioctaveNoise's near/far 5e-5/2e-4 split). Near-grid (index < 36)
  // residuals alone are far tighter (~1e-5 to ~1e-4) for all three.

  it("vulcanus_wobble_x matches the oracle to the f32 floor", () => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const got = helpers.wobbleX(p.x, p.y);
      const want = fixture.wobbleX[i];
      worst = Math.max(worst, Math.abs(got - want));
    }
    // Measured worst 2.32e-4 (deep-field point); near-grid worst 8.9e-6.
    expect(worst).toBeLessThan(4e-4);
  });

  it("mountain_plasma = vulcanus_plasma(102, 2.5, 10, 125, 625) matches the oracle to the f32 floor", () => {
    const mountainPlasma = helpers.plasma(102, 2.5, 10, 125, 625);
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const got = mountainPlasma(p.x, p.y);
      const want = fixture.mountainPlasma[i];
      worst = Math.max(worst, Math.abs(got - want));
    }
    // Measured worst 2.78e-3 (deep-field point, output_scale up to 625 amplifies
    // the coordinate floor); near-grid worst 1.13e-4.
    expect(worst).toBeLessThan(4e-3);
  });

  it("vulcanus_detail_noise(837, 1/40, 4, 1.25) matches the oracle to the f32 floor", () => {
    const detail = helpers.detailNoise(837, 1 / 40, 4, 1.25);
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const got = detail(p.x, p.y);
      const want = fixture.detailNoise[i];
      worst = Math.max(worst, Math.abs(got - want));
    }
    // Measured worst 4.81e-5 (deep-field point); near-grid worst 9.7e-6.
    expect(worst).toBeLessThan(1e-4);
  });

  it("vulcanus_scale_multiplier reproduces the DEFAULT preset (neutral control = 1, not 0)", () => {
    // The oracle sampled this at the game's default preset (no autoplace_controls
    // override) - if the ctx neutral default were wrong (e.g. 0 in slider space),
    // this would be off by more than a rounding error.
    expect(helpers.scaleMultiplier).toBeCloseTo(fixture.scaleMultiplier[0], 5);
    for (const v of fixture.scaleMultiplier) expect(v).toBe(fixture.scaleMultiplier[0]);
    expect(sliderRescale(1, 3)).toBe(1);
    expect(ctx.vulcanusVolcanismFrequency).toBe(1);
  });
});
