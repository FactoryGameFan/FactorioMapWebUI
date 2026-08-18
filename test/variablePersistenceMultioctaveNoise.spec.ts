import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-variable-persistence-multioctave.seed123456.json";
import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";
import {
  makeVariablePersistenceMultioctaveNoise,
  variablePersistenceMultioctaveNoise,
} from "../src/noise/variablePersistenceMultioctaveNoise";

interface VarPersCase {
  octaves: number;
  inputScale: number;
  outputScale: number;
  offsetX: number;
  seed1: number;
  values: number[];
}

function paramsFor(seed0: number, c: VarPersCase) {
  return {
    seed0,
    seed1: c.seed1,
    octaves: c.octaves,
    inputScale: c.inputScale,
    outputScale: c.outputScale,
    offsetX: c.offsetX,
  };
}

/** Worst absolute error of an evaluator over the whole fixture, and where. */
function sweep(evaluate: (x: number, y: number, persistence: number, c: VarPersCase) => number): {
  worst: number;
  label: string;
} {
  let worst = 0;
  let label = "";
  for (const c of fixture.cases as VarPersCase[]) {
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      const err = Math.abs(evaluate(p.x, p.y, fixture.persistenceField[i], c) - c.values[i]);
      if (err > worst) {
        worst = err;
        label = `octaves=${c.octaves} offset=${c.offsetX} seed1=${c.seed1} @(${p.x},${p.y})`;
      }
    }
  }
  return { worst, label };
}

describe("variablePersistenceMultioctaveNoise reproduces the game", () => {
  // Ground truth: test/fixtures/oracle-variable-persistence-multioctave.seed123456.json,
  // captured via the oracle harness. `persistenceField` is the per-tile value of the
  // persistence expression (routed onto elevation), fed back in as the model's
  // per-tile p. Regenerate with test/oracle/capture.ts.
  it("matches variable_persistence_multioctave_noise across octaves / scales / offset / seeds", () => {
    // One domain, not two. This used to split near-field from far-field on a
    // `maxNoiseX(...) < 500` threshold computed from the fitted `k*(-7936)` shift,
    // with a 100x looser far tolerance. Both the shift and the split are gone: the
    // shift was an alias of zero, and with it removed the two cases carrying
    // offset_x of 5000 and 40000 are no worse than the ones at the origin.
    const { worst, label } = sweep((x, y, p, c) =>
      variablePersistenceMultioctaveNoise(x, y, p, paramsFor(fixture.seed0, c)),
    );
    // EXACTLY 0, over all 266 samples. This assertion has been three numbers:
    // 1.144e-5 (#162), then 4e-6 "3.8147e-6, measured after #214", and now zero.
    // Each time the residual fell it was because `basisNoise` underneath got
    // more faithful, and this op's own arithmetic never changed; #243's measured
    // gradient table took the last of it. The bound is gone rather than lowered,
    // because a bound against a true residual of zero is pure slack - room for a
    // wrong port to sit in undetected, which is exactly #162's complaint.
    //
    // That is not a theoretical worry - it was measured by planting defects in
    // the op and scoring both ways:
    //
    // | planted defect | worst | exact | old `< 4e-6` |
    // | --- | --- | --- | --- |
    // | drop f32 on the final gain multiply | 1.907e-6 | 252/266 | **passes** |
    // | drop f32 on `acc * persistence` | 7.629e-6 | 216/266 | fails |
    //
    // The first one loses 14 points of bit-exactness and the old bound never
    // notices. `toBe(0)` notices both.
    expect(worst, `worst at ${label}`).toBe(0);
  });

  // The exact-count and zero-residual assertions above are only meaningful if the
  // fixture is all-f32; against an f64 ground truth no f32 port could ever reach
  // them, and the temptation would be to loosen the score instead of reading it.
  it("every fixture value is exactly representable in f32", () => {
    for (const c of fixture.cases as VarPersCase[]) {
      for (const v of c.values) expect(Math.fround(v)).toBe(v);
    }
  });

  it("reproduces the whole fixture bit-exactly, not merely within tolerance", () => {
    let exact = 0;
    let n = 0;
    for (const c of fixture.cases as VarPersCase[]) {
      const params = paramsFor(fixture.seed0, c);
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        n++;
        if (
          variablePersistenceMultioctaveNoise(p.x, p.y, fixture.persistenceField[i], params) ===
          c.values[i]
        ) {
          exact++;
        }
      }
    }
    expect(n).toBe(266);
    expect(exact).toBe(266);
  });

  /**
   * Per-case, not just the worst over the whole sweep. The cases differ by up to
   * a `2^N * output_scale` gain, so a single aggregate figure is dominated by
   * whichever case has the largest gain and a regression confined to a low-gain
   * case could hide behind it. Every case is checked on its own here.
   *
   * This test used to assert `worst / gain < 1.3e-7` - "one to two f32 ulps" -
   * on the reasoning that the residual WAS `basisNoise`'s f32 floor amplified by
   * the gain. That reasoning was sound when written and is now void: the
   * residual is zero, so there is no floor left to normalise against and
   * dividing by the gain no longer measures anything. The per-case granularity
   * was the durable half of the idea, so it is what survives.
   */
  it("matches bit-for-bit in every case on its own, not just in aggregate", () => {
    for (const c of fixture.cases as VarPersCase[]) {
      const params = paramsFor(fixture.seed0, c);
      const gain = c.outputScale * 2 ** c.octaves;
      let worst = 0;
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const got = variablePersistenceMultioctaveNoise(
          p.x,
          p.y,
          fixture.persistenceField[i],
          params,
        );
        worst = Math.max(worst, Math.abs(got - c.values[i]));
      }
      expect(
        worst,
        `octaves=${c.octaves} offset=${c.offsetX} seed1=${c.seed1} (gain ${gain})`,
      ).toBe(0);
    }
  });

  // Guard: the tolerance above must not be reachable by the pre-fix models. As with
  // the plain op, NEITHER half of the fix does anything on its own.
  describe("the pre-fix models are still rejected", () => {
    const f = Math.fround;

    /** The old f64 model, parameterised on the octave shift. */
    function legacyF64(x: number, y: number, p: number, c: VarPersCase, shift: number): number {
      const tables = basisNoiseTablesFromSeed(fixture.seed0, c.seed1);
      let acc = 0;
      let scale = c.inputScale * 0.5;
      for (let k = 0; k < c.octaves; k++) {
        acc += basisNoise((x + c.offsetX) * scale + k * shift, y * scale, tables);
        if (k < c.octaves - 1) acc *= p;
        scale *= 0.5;
      }
      return c.outputScale * 2 ** c.octaves * acc;
    }

    /** The current f32 op order with the aliased shift restored. */
    function f32WithShift(x: number, y: number, p: number, c: VarPersCase): number {
      const tables = basisNoiseTablesFromSeed(fixture.seed0, c.seed1);
      let acc = 0;
      let scale = f(f(c.inputScale) * 0.5);
      for (let k = 0; k < c.octaves; k++) {
        acc = f(acc + basisNoise(f(k * -7936 + f(f(x + c.offsetX) * scale)), f(y * scale), tables));
        if (k < c.octaves - 1) acc = f(acc * p);
        scale = f(scale * 0.5);
      }
      return f(acc * f(c.outputScale * 2 ** c.octaves));
    }

    it("rejects the shipped f64 model (aliased shift -7936)", () => {
      expect(sweep((x, y, p, c) => legacyF64(x, y, p, c, -7936)).worst).toBeGreaterThan(1e-4);
    });

    it("rejects f32 arithmetic while the shift is still aliased", () => {
      // ~3.6e-1 - four orders of magnitude WORSE than the f64 model it replaces,
      // because k*(-7936) at octave 5 lands where an f32 ulp is ~3.9e-3.
      expect(sweep(f32WithShift).worst).toBeGreaterThan(1e-2);
    });

    it("rejects removing the shift while the arithmetic is still f64", () => {
      // A literal no-op: -7936 is -31*256 and the basis lattice has period 256, so
      // in f64 the shifted and unshifted models are the same field.
      expect(sweep((x, y, p, c) => legacyF64(x, y, p, c, 0)).worst).toBeGreaterThan(1e-4);
    });
  });

  it("makeVariablePersistenceMultioctaveNoise (prebuilt tables) agrees with the direct form", () => {
    for (const c of fixture.cases as VarPersCase[]) {
      const params = paramsFor(fixture.seed0, c);
      const fn = makeVariablePersistenceMultioctaveNoise(params);
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const persistence = fixture.persistenceField[i];
        expect(fn(p.x, p.y, persistence)).toBe(
          variablePersistenceMultioctaveNoise(p.x, p.y, persistence, params),
        );
      }
    }
  });
});
