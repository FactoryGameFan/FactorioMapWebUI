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
    //
    // This is also what makes the port itself non-vacuous, not the term
    // checks below: it calls scrap.probability at every position, including
    // indices 46 and 53 - the only two where the expression is nonzero (see
    // the next test) - so a stub that always returned 0 would fail HERE,
    // with relative error 1.0 at each of those two indices.
    //
    // This 101-point fixture CANNOT catch a one-unit drift in the COASTLINE
    // constant below: only 2 of 101 positions are nonzero (index 46 and 53),
    // and neither position's elevation falls in the (90, 91] band a
    // COASTLINE 80 -> 81 change would move. Measured directly: planting
    // COASTLINE = 81 leaves the worst relative error unchanged at this
    // fixture's precision. Planting COASTLINE = 200 does move it, to a worst
    // relative error of 1.0 - so the elevation gate is read by this
    // composition, just not resolved at one-unit granularity by this sample.
    // The elevation gate's real guards are this file's own ocean test below
    // (10,000+ ocean tiles, every one required to read exactly 0) and Task
    // 6's footprint comparison against the game's own preview.
    expect(worst, `worst at index ${String(worstAt)}`).toBeLessThan(1e-5);
  });

  it("both additive terms are exercised, so agreement is not agreement on one branch of the +", () => {
    // This test never calls scrap.probability - it reads the fixture's own
    // diagnostic rows, so it cannot discriminate the PORT (that is test 1's
    // job, and it does: see the comment there). What this guards is the
    // FIXTURE: fulgora_scrap_probability has exactly 2 of 101 nonzero
    // entries, so a future re-capture that silently landed all zeros - a
    // dead RNG seed, a wrong surface, a broken sampling harness - would still
    // let test 1 pass vacuously (0 against 0 everywhere). Asserting each
    // additive term has its own nonzero witness makes that failure mode
    // visible here instead. Measured: struct_term is nonzero only at index 53
    // (1.292399525642395) and vault_term is nonzero only at index 46 (10) -
    // disjoint positions, so each branch of the `+` has its own witness.
    const structTerm = fixture.fulgora_scrap_struct_term as number[];
    const vaultTerm = fixture.fulgora_scrap_vault_term as number[];
    expect(structTerm.filter((v) => v > 0).length).toBeGreaterThan(0);
    expect(vaultTerm.filter((v) => v > 0).length).toBeGreaterThan(0);

    // The cap: min(struct_term + vault_term, 0.5) reaches its ceiling at
    // index 53 (struct_term 1.29 alone already exceeds 0.5).
    const want = fixture.fulgora_scrap_probability as number[];
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
