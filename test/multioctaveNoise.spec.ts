import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-multioctave.seed123456.json";
import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";
import {
  fastLog2,
  fastPow2,
  makeMultioctaveNoise,
  multioctaveNoise,
  type MultioctaveParams,
} from "../src/noise/multioctaveNoise";

describe("fastapprox helpers reproduce Factorio's Math::log2 / Math::exp2f", () => {
  it("fastPow2(fastLog2(x)) round-trips within the fastapprox floor", () => {
    for (const x of [0.1, 0.5, 1, 2, 3.7, 10, 100]) {
      const got = fastPow2(fastLog2(x));
      expect(Math.abs(got - x) / x).toBeLessThan(0.02);
    }
  });
});

describe("multioctaveNoise reproduces the game", () => {
  // Ground truth: test/fixtures/oracle-multioctave.seed123456.json, captured via
  // the oracle harness. Regenerate with test/oracle/capture.ts.
  const params = (c: (typeof fixture.cases)[number]): MultioctaveParams => ({
    seed0: fixture.seed0,
    seed1: c.seed1,
    octaves: c.octaves,
    persistence: c.persistence,
    inputScale: c.inputScale,
    outputScale: c.outputScale,
  });

  /** Worst absolute error of an evaluator over the whole fixture, and where. */
  function sweep(evaluate: (x: number, y: number, p: MultioctaveParams) => number): {
    worst: number;
    label: string;
  } {
    let worst = 0;
    let label = "";
    for (const c of fixture.cases) {
      const p = params(c);
      for (let i = 0; i < fixture.positions.length; i++) {
        const pos = fixture.positions[i];
        const err = Math.abs(evaluate(pos.x, pos.y, p) - c.values[i]);
        if (err > worst) {
          worst = err;
          label = `octaves=${c.octaves} p=${c.persistence} seed1=${c.seed1} @(${pos.x},${pos.y})`;
        }
      }
    }
    return { worst, label };
  }

  it("matches multioctave_noise across octaves / persistence / scales / seeds", () => {
    // One domain, not two. This used to carry separate near-field (5e-5) and
    // far-field (2e-4) tolerances, because the shipped per-octave x offset was an
    // alias 100x too large and its f32 error therefore grew with |coordinate|.
    // With the true +17.17 the error no longer depends on distance at all: the
    // fixture's extreme point (12345.75, 6789.125) is no worse than the origin.
    const { worst, label } = sweep((x, y, p) => multioctaveNoise(x, y, p));
    // 4.7684e-7, measured after #214 gave basisNoise the game's own arithmetic.
    // #162 predicted this: it recorded 7.153e-7 here and said basisNoise's f64
    // evaluation was "the entire residual" for this op. It was - the number
    // moved 1.5x on a change that touched nothing in this file.
    expect(worst, `worst at ${label}`).toBeLessThan(5e-7);
  });

  it("reproduces most of the fixture bit-exactly, not merely within tolerance", () => {
    // #162 exists because almost nothing here compares f32-exact, which is how
    // a real bug stayed green for a year. ALL 266 now match bit for bit, up
    // from 231 on 2026-08-18 when the gradient table was recovered from the
    // game instead of derived from a formula (#234). The kernel did not change.
    //
    // `toBe`, not `toBeGreaterThanOrEqual`: the standing instruction on this
    // number was to raise it whenever it rose and never let it fall, and it has
    // now reached the whole fixture, so there is nothing left to rise to. Any
    // movement at all is a regression.
    let exact = 0;
    let n = 0;
    for (const c of fixture.cases) {
      const p = params(c);
      for (let i = 0; i < fixture.positions.length; i++) {
        const pos = fixture.positions[i];
        n++;
        if (Math.fround(multioctaveNoise(pos.x, pos.y, p)) === c.values[i]) exact++;
      }
    }
    expect(n).toBe(266);
    expect(exact).toBe(266);
  });

  it("agrees with the prebuilt-closure form bit for bit", () => {
    for (const c of fixture.cases) {
      const p = params(c);
      const closure = makeMultioctaveNoise(p);
      for (const pos of fixture.positions) {
        expect(closure(pos.x, pos.y)).toBe(multioctaveNoise(pos.x, pos.y, p));
      }
    }
  });

  // Guard: without this the tolerance above could be met by a model that is wrong
  // in a way the fixture cannot see. Both defects the fix addresses must still be
  // detectable, and - the point of the finding - NEITHER fix works alone.
  describe("the pre-fix models are still rejected", () => {
    const f32 = Math.fround;

    /** The old f64 composition, parameterised on the octave offset. */
    function legacyF64(x: number, y: number, p: MultioctaveParams, offset: number): number {
      const invP = 1 / p.persistence;
      const invP2 = 1 / (p.persistence * p.persistence);
      const norm =
        p.persistence === 1
          ? 1 / Math.sqrt(p.octaves)
          : Math.sqrt((invP2 - 1) / (fastPow2(fastLog2(invP2) * p.octaves) - 1));
      let sum = 0;
      let scale = p.inputScale;
      let amp = norm;
      for (let k = 0; k < p.octaves; k++) {
        sum += amp * basisNoise(x * scale + k * offset, y * scale, tablesFor(p));
        scale *= 0.5;
        amp *= invP;
      }
      return p.outputScale * sum;
    }

    /** The current f32 op order, but with the aliased offset restored. */
    function f32WithAliasedOffset(x: number, y: number, p: MultioctaveParams): number {
      const n = Math.ceil(p.octaves);
      const invP = f32(1 / p.persistence);
      const invP2 = f32(invP * invP);
      const pow = f32(fastPow2(f32(fastLog2(invP2) * f32(n))));
      let amp =
        invP === 1
          ? f32(p.outputScale / Math.sqrt(n))
          : f32(Math.sqrt(f32(f32(invP2 - 1) / f32(pow - 1))) * p.outputScale);
      let scale = f32(p.inputScale);
      let out = 0;
      for (let k = 0; k < n; k++) {
        const xk = f32(k * -1774.83 + f32(x * scale));
        out = f32(out + f32(amp * basisNoise(xk, f32(y * scale), tablesFor(p))));
        scale = f32(scale * 0.5);
        amp = f32(invP * amp);
      }
      return out;
    }

    const cache = new Map<string, ReturnType<typeof basisNoiseTablesFromSeed>>();
    function tablesFor(p: MultioctaveParams) {
      const key = `${p.seed0}/${p.seed1}`;
      let t = cache.get(key);
      if (!t) {
        t = basisNoiseTablesFromSeed(p.seed0, p.seed1);
        cache.set(key, t);
      }
      return t;
    }

    it("rejects the shipped f64 model (aliased offset -1774.83)", () => {
      // ~1.2e-4: the alias' f32 quantisation, which used to be called an
      // irreducible floor.
      expect(sweep((x, y, p) => legacyF64(x, y, p, -1774.83)).worst).toBeGreaterThan(1e-5);
    });

    it("rejects f32 arithmetic while the offset is still aliased", () => {
      // ~1.4e-3 - WORSE than the f64 model it replaces. This is why five earlier
      // attempts at "reproduce the game's f32 order" all regressed.
      expect(sweep(f32WithAliasedOffset).worst).toBeGreaterThan(1e-4);
    });

    it("rejects the true offset while the arithmetic is still f64", () => {
      // The constant alone changes nothing: +17.17 and -1774.83 differ by 7 basis
      // periods, so in f64 they are the same field. Fixing one without the other
      // is not an improvement, it is a no-op.
      expect(sweep((x, y, p) => legacyF64(x, y, p, 17.17)).worst).toBeGreaterThan(1e-5);
    });
  });
});

describe("makeMultioctaveNoise (hoisted) matches multioctaveNoise exactly", () => {
  const CONFIGS: MultioctaveParams[] = [
    {
      seed0: 123456,
      seed1: 700,
      octaves: 4,
      persistence: 0.5,
      inputScale: 1 / 150,
      outputScale: 1,
    },
    { seed0: 123456, seed1: 900, octaves: 4, persistence: 0.5, inputScale: 1 / 90, outputScale: 1 },
    {
      seed0: 123456,
      seed1: 1000,
      octaves: 2,
      persistence: 0.6,
      inputScale: 1 / 1600,
      outputScale: 1,
    },
    {
      seed0: 123456,
      seed1: 1100,
      octaves: 1,
      persistence: 0.6,
      inputScale: 1 / 1600,
      outputScale: 1,
    },
    { seed0: 42, seed1: 3, octaves: 6, persistence: 0.75, inputScale: 0.2, outputScale: 0.5 },
  ];
  it("is identical across a grid for every config", () => {
    for (const cfg of CONFIGS) {
      const made = makeMultioctaveNoise(cfg);
      for (let gx = -2; gx <= 2; gx++) {
        for (let gy = -2; gy <= 2; gy++) {
          const x = gx * 37 + 0.5;
          const y = gy * 41 + 0.25;
          expect(made(x, y)).toBe(multioctaveNoise(x, y, cfg));
        }
      }
    }
  });
});
