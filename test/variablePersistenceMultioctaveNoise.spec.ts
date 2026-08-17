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
    // 3.8147e-6, measured after #214. #162 recorded 1.144e-5 here and named
    // basisNoise's f64 evaluation as the whole residual; the number moved 3x on
    // a change that touched nothing in this file, which is that prediction
    // being confirmed rather than merely restated.
    expect(worst, `worst at ${label}`).toBeLessThan(4e-6);
  });

  /**
   * The residual is `basisNoise`'s f32 floor multiplied by this op's `2^N *
   * output_scale` gain, not a modelling gap - so the meaningful bound is relative
   * to that gain, and it is one to two f32 ulps in every case. Asserting this
   * rather than only the absolute worst is what keeps a future regression that
   * scales with gain from hiding inside a loose absolute tolerance.
   */
  it("the residual is the basis floor times the gain, at 1-2 f32 ulps per case", () => {
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
        worst / gain,
        `octaves=${c.octaves} offset=${c.offsetX} seed1=${c.seed1} (gain ${gain})`,
      ).toBeLessThan(1.3e-7);
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
