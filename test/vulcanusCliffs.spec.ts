import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliffs.seed123456.json";

describe("Vulcanus cliffs", () => {
  const v = fixture.values;

  it("cliffiness_basic stays in [0.5, 1.5], the range the placement gate assumes", () => {
    // crossesCliff gates on the AVERAGE of two corners' cliffiness being > 0.5.
    // On Nauvis cliffiness is a hard 0-or-10, so that reads as "either corner is
    // cliffy"; here it is continuous, and the +0.5 floor is what makes the gate
    // fire wherever the clamp is above zero. Pinning the range keeps that
    // reasoning honest.
    const lo = Math.min(...v.cliffiness_basic);
    const hi = Math.max(...v.cliffiness_basic);
    expect(lo).toBeGreaterThanOrEqual(0.5);
    expect(hi).toBeLessThanOrEqual(1.5);
    // The sample must actually exercise both ends, or the bound above is vacuous.
    expect(lo).toBeLessThan(0.51);
    expect(hi).toBeGreaterThan(1.4);
  });
});
