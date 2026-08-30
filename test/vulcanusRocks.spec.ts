import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-rocks.seed123456.json";

describe("Vulcanus rocks", () => {
  const v = fixture.values;

  it("probabilities stay well under 1, so no threshold yields a solid footprint", () => {
    // Both expressions are capped at 0.2 * (1 - k * ashlands_biome), so the
    // overlay cannot use the ores' `>= 0.5` rule - it rolls per tile against
    // this capped density instead (renderVulcanusRocks.ts). This is the same
    // shape of problem as the sulfuric-acid geyser and Nauvis rocks. If a
    // future version raises the cap, this fails and the roll's behavior
    // (heavier clustering from a higher-density field) should be revisited.
    // The cap is exactly 0.2, but the game evaluates it in f32, so the observed
    // peak is 0.20000000298023224 - f32(0.2) rounded up. Compare with a tick of
    // slack rather than pretending the constant comes back exact.
    const peak = Math.max(...v.vulcanus_rock_huge, ...v.vulcanus_rock_big);
    expect(peak).toBeLessThanOrEqual(0.2 + 1e-6);
    // ...and the field is not trivially empty over the sample.
    expect(peak).toBeGreaterThan(0.05);
  });
});
