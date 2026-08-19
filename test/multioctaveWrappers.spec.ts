import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-multioctave-wrappers.seed123456.json";
import { quickMultioctaveNoisePersistence } from "../src/noise/quickMultioctaveNoise";
import { amplitudeCorrectedMultioctaveNoise } from "../src/noise/variablePersistenceMultioctaveNoise";

interface QuickCase {
  octaves: number;
  inputScale: number;
  outputScale: number;
  oism: number;
  persistence: number;
  seed1: number;
  values: number[];
}
interface AcCase {
  octaves: number;
  inputScale: number;
  offsetX: number;
  persistence: number;
  amplitude: number;
  seed1: number;
  values: number[];
}

describe("the multioctave Lua wrappers reproduce the game", () => {
  // Ground truth: test/fixtures/oracle-multioctave-wrappers.seed123456.json.
  // Regenerate with `test/oracle/capture.ts multioctave-wrappers`.
  it("quick_multioctave_noise_persistence matches the game bit-for-bit", () => {
    let worst = 0;
    let exact = 0;
    let n = 0;
    for (const c of fixture.quick as QuickCase[]) {
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const got = quickMultioctaveNoisePersistence(p.x, p.y, {
          seed0: fixture.seed0,
          seed1: c.seed1,
          octaves: c.octaves,
          inputScale: c.inputScale,
          outputScale: c.outputScale,
          octaveInputScaleMultiplier: c.oism,
          persistence: c.persistence,
        });
        n++;
        if (got === c.values[i]) exact++;
        worst = Math.max(worst, Math.abs(got - c.values[i]));
      }
    }
    // Bit-exact: 152/152, worst 0. The bound here was `< 3e-3` and blamed "the
    // f32 coordinate floor at the far fixture points"; there was no such floor.
    // Two separate f64 evaluations were, and both are fixed:
    //
    // | | worst | exact |
    // | --- | --- | --- |
    // | the op itself in f64 | 1.964e-3 | 38/152 |
    // | op fixed, transform still f64 | 1.964e-3 | 114/152 |
    // | **both in f32** | **0** | **152/152** |
    //
    // The second row is the interesting one. This wrapper is a `noise-function`
    // whose body is an expression STRING, so the game's noise machine folds it
    // in f32 - "Lua wrapper" does not mean "Lua doubles". See
    // quick-multioctave-noise-NOTES.md.
    expect(n).toBe(152);
    expect(worst).toBe(0);
    expect(exact).toBe(152);
  });

  it("amplitude_corrected_multioctave_noise matches the game", () => {
    let worst = 0;
    for (const c of fixture.amplitudeCorrected as AcCase[]) {
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const got = amplitudeCorrectedMultioctaveNoise(p.x, p.y, {
          seed0: fixture.seed0,
          seed1: c.seed1,
          octaves: c.octaves,
          inputScale: c.inputScale,
          offsetX: c.offsetX,
          persistence: c.persistence,
          amplitude: c.amplitude,
        });
        worst = Math.max(worst, Math.abs(got - c.values[i]));
      }
    }
    // Measured 1.7881e-7, against a bound that was `< 5e-3` - roughly 28,000x
    // slack, inherited from the era when the ops underneath were f64. Tightened
    // to the measurement.
    //
    // **This one is NOT bit-exact and is not yet explained: 81/152.** Its sibling
    // above reached 152/152 by running the wrapper's transform in the noise
    // machine's f32, and the same treatment here does NOT fix it - f32 per-op
    // with the game's integral `^` scores 84/152 with worst 3.576e-7, no better
    // than the f64 form it would replace. So the shipped f64 transform stays
    // until there is evidence for a different one, and this bound records what
    // ships. Open question, deliberately not closed by guesswork.
    expect(worst).toBeLessThan(2.5e-7);
  });
});
