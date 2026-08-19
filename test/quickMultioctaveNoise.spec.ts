import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-quick-multioctave.seed123456.json";
import {
  makeQuickMultioctaveNoise,
  makeQuickMultioctaveNoisePersistence,
  quickMultioctaveNoise,
} from "../src/noise/quickMultioctaveNoise";

interface QuickCase {
  octaves: number;
  inputScale: number;
  outputScale: number;
  oosm: number;
  oism: number;
  offsetX: number;
  seed1: number;
  values: number[];
}

function paramsFor(seed0: number, c: QuickCase) {
  return {
    seed0,
    seed1: c.seed1,
    octaves: c.octaves,
    inputScale: c.inputScale,
    outputScale: c.outputScale,
    octaveOutputScaleMultiplier: c.oosm,
    octaveInputScaleMultiplier: c.oism,
    offsetX: c.offsetX,
  };
}

describe("quickMultioctaveNoise reproduces the game", () => {
  // Ground truth: test/fixtures/oracle-quick-multioctave.seed123456.json, captured
  // via the oracle harness. Regenerate with test/oracle/capture.ts.
  //
  // Scored by EXACT f32 match count, not by an error bound. Every one of the 190
  // values in the fixture is exactly representable in f32 (asserted below, so the
  // scoring cannot quietly stop being valid), which makes "identical" a question
  // the fixture can answer - and a bound cannot.
  //
  // This spec used to assert `worstNear < 5e-5` and `worstFar < 3e-3`, and
  // explained the gap as "the game's f32 coordinate pipeline diverges from our
  // f64 - the documented f32 floor". There was no floor: the op was evaluating in
  // f64 and the game evaluates in f32. It scored 38/190 then and scores 190/190
  // now, so the near/far split those two bounds described no longer exists and
  // both are gone. Do not reintroduce a bound here; a miss is a finding.
  it("matches quick_multioctave_noise bit-for-bit across octaves / multipliers / offset / seeds", () => {
    let exact = 0;
    let total = 0;
    let worst = 0;
    let worstLabel = "";
    for (const c of fixture.cases as QuickCase[]) {
      const params = paramsFor(fixture.seed0, c);
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const got = quickMultioctaveNoise(p.x, p.y, params);
        total++;
        if (got === c.values[i]) exact++;
        const err = Math.abs(got - c.values[i]);
        if (err > worst) {
          worst = err;
          worstLabel = `octaves=${c.octaves} offset=${c.offsetX} seed1=${c.seed1} @(${p.x},${p.y})`;
        }
      }
    }
    expect(total).toBe(190);
    expect(worst, `worst residual at ${worstLabel}`).toBe(0);
    expect(exact).toBe(190);
  });

  // The exact-count assertion above is only meaningful if the fixture really is
  // all-f32; against an f64 ground truth a bit-exact f32 port could never reach
  // it, and the temptation would be to loosen the score instead of reading it.
  it("every fixture value is exactly representable in f32", () => {
    for (const c of fixture.cases as QuickCase[]) {
      for (const v of c.values) expect(Math.fround(v)).toBe(v);
    }
  });

  it("makeQuickMultioctaveNoise (prebuilt tables) agrees with the direct form", () => {
    for (const c of fixture.cases as QuickCase[]) {
      const params = paramsFor(fixture.seed0, c);
      const fn = makeQuickMultioctaveNoise(params);
      for (const p of fixture.positions) {
        expect(fn(p.x, p.y)).toBe(quickMultioctaveNoise(p.x, p.y, params));
      }
    }
  });

  it("makeQuickMultioctaveNoisePersistence agrees with the raw quickMultioctaveNoise transform", () => {
    // The elevation tree's starting_lake_noise parameters (seed1: 14, octaves: 5).
    // Independent check: rather than comparing against quickMultioctaveNoisePersistence
    // (which now just delegates to makeQuickMultioctaveNoisePersistence, making that
    // comparison a tautology), compare against the raw quickMultioctaveNoise op fed the
    // param transform spelled out explicitly here.
    const params = {
      seed0: fixture.seed0,
      seed1: 14,
      octaves: 5,
      inputScale: 1 / 8,
      outputScale: 1,
      octaveInputScaleMultiplier: 0.5,
      persistence: 0.75,
    };
    const rawParams = {
      seed0: fixture.seed0,
      seed1: 14,
      octaves: 5,
      inputScale: (1 / 8) * 0.5 ** (5 - 1),
      outputScale: 1 * 2 ** (5 - 1),
      octaveOutputScaleMultiplier: 0.75,
      octaveInputScaleMultiplier: 1 / 0.5,
      offsetX: 0,
    };
    const fn = makeQuickMultioctaveNoisePersistence(params);
    for (const p of fixture.positions) {
      expect(fn(p.x, p.y)).toBe(quickMultioctaveNoise(p.x, p.y, rawParams));
    }
  });
});
