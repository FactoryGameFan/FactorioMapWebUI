import { describe, expect, it } from "vite-plus/test";
import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";
import {
  BASIS_ABS_MAX,
  makeTreeDensity,
  makeTreeSpeciesFields,
} from "../src/noise/trees/treeField";
import { TREE_SPECIES } from "../src/noise/trees/treeCatalog";

/** The reference: full evaluation of every species, no skipping. */
const fullDensity =
  (seed0: number) =>
  (x: number, y: number): number => {
    const fields = makeTreeSpeciesFields({ seed0 });
    return Math.min(1, Math.max(0, ...fields.map((f) => f.evalAt(x, y))));
  };

describe("tree density early-out", () => {
  it("is bit-identical to full evaluation across seeds and regions", () => {
    for (const seed0 of [123456, 777771, 1]) {
      const fast = makeTreeDensity({ seed0 });
      const slow = fullDensity(seed0);
      for (let x = -3000; x <= 3000; x += 271) {
        for (let y = -3000; y <= 3000; y += 293) {
          const wx = x + 0.5;
          const wy = y + 0.25;
          expect(fast(wx, wy), `seed ${seed0} @(${wx},${wy})`).toBe(slow(wx, wy));
        }
      }
    }
  }, 120000);

  it("is bit-identical at non-default control levers too", () => {
    const params = { seed0: 123456, treesFrequency: 3, treesSize: 2 };
    const fast = makeTreeDensity(params);
    const fields = makeTreeSpeciesFields(params);
    for (let x = -1500; x <= 1500; x += 173) {
      for (let y = -1500; y <= 1500; y += 181) {
        const wx = x + 0.5;
        const wy = y + 0.25;
        const slow = Math.min(1, Math.max(0, ...fields.map((f) => f.evalAt(wx, wy))));
        expect(fast(wx, wy), `@(${wx},${wy})`).toBe(slow);
      }
    }
  });

  it("bounds basisNoise conservatively", () => {
    // The early-out is only sound if no octave can exceed BASIS_ABS_MAX. Sample
    // the actual tree seeds hard and assert headroom remains.
    let observed = 0;
    for (const s of TREE_SPECIES.slice(0, 5)) {
      const t = basisNoiseTablesFromSeed(123456, s.seed1);
      for (let i = 0; i < 200000; i++) {
        const x = (i % 991) * 0.31 - 150;
        const y = Math.floor(i / 991) * 0.43 - 150;
        observed = Math.max(observed, Math.abs(basisNoise(x, y, t)));
      }
    }
    expect(observed).toBeLessThan(BASIS_ABS_MAX);
  });
});
