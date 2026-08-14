import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-fulgora-scrap.seed123456.json";
import { makeFulgoraScrap } from "../src/noise/expressions/fulgoraScrap";
import { makeFulgoraStack, makeFulgoraTileResolverFrom } from "../src/noise/tiles/fulgoraCatalog";

const stack = makeFulgoraStack({ seed0: fixture.seed0 });
const scrap = makeFulgoraScrap(stack);

describe("Fulgora scrap probability", () => {
  it("matches the game's own evaluation of the whole expression", () => {
    const want = fixture.fulgora_scrap_probability as number[];
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      const got = scrap.probability(p.x, p.y);
      const rel = Math.abs(got - want[i]) / Math.max(1e-9, Math.abs(got), Math.abs(want[i]));
      if (rel > worst) {
        worst = rel;
        worstAt = i;
      }
    }
    // Bound sized from the measurement, not chosen to fit. Do not widen it: the
    // repo has twice had a real bug hidden behind a widened bound.
    expect(worst, `worst at index ${String(worstAt)}`).toBeLessThan(1e-5);
  });

  it("the sample spans the range, so agreement is not agreement on zeros", () => {
    const want = fixture.fulgora_scrap_probability as number[];
    // test/fixtures/PROVENANCE.json documents this fixture as "2 of 101
    // nonzero" at capture time - the field is sparse by construction (scrap
    // rolls a small chance per tile), so the bound is 1, not a larger count.
    expect(want.filter((v) => v > 0).length).toBeGreaterThan(1);
    expect(want.filter((v) => v >= 0.4999).length).toBeGreaterThan(0);
  });

  it("the game reports the default controls the composition assumes", () => {
    expect(new Set(fixture.scrap_control_frequency as number[])).toEqual(new Set([1]));
    expect(new Set(fixture.scrap_control_size as number[])).toEqual(new Set([1]));
  });

  it("clamps to [0, 1]", () => {
    // The raw expression goes NEGATIVE, entirely via structure_subnoise < -1:
    // 1002 positions in a 1024x1024 window. Summing raw values instead of
    // clamped ones understates the placement expectation by about 6%.
    for (let y = -400; y < 400; y += 7) {
      for (let x = -400; x < 400; x += 7) {
        const p = scrap.probability(x, y);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it("places no scrap on ocean, by the elevation term alone", () => {
    // Measured: expected scrap on non-land is exactly 0.00 over 262,144 tiles.
    // There is deliberately no tile gate in the renderer, so this is the
    // assertion that stands in for one.
    const tile = makeFulgoraTileResolverFrom(stack);
    let oceanChecked = 0;
    for (let y = 744; y < 744 + 512; y += 3) {
      for (let x = -1756; x < -1756 + 512; x += 3) {
        const t = tile(x, y);
        if (t !== "shallow" && t !== "deep") continue;
        oceanChecked++;
        expect(scrap.probability(x, y)).toBe(0);
      }
    }
    expect(oceanChecked).toBeGreaterThan(10000);
  });
});
