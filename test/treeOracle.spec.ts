import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-trees.seed123456.json";
import controlFixture from "./fixtures/oracle-trees-controls.seed123456.json";
import { makeTreeShared } from "../src/noise/trees/treeShared";
import { makeTreeSpeciesFields } from "../src/noise/trees/treeField";

const { seed0, positions, values } = fixture as {
  seed0: number;
  positions: Array<{ x: number; y: number }>;
  values: Record<string, number[]>;
};

/**
 * Tolerance idiom borrowed from test/resourcePatches.spec.ts: an absolute bound
 * for near-spawn points plus a relative escape for the known far-field basisNoise
 * f32 floor, so the far ring cannot mask a real near-field error.
 */
const agrees = (actual: number, expected: number, abs: number, rel: number): boolean =>
  Math.abs(actual - expected) < abs || Math.abs(actual - expected) < rel * Math.abs(expected);

describe("tree shared fields match the game", () => {
  const { smallNoise, forestPathCutoutFaded } = makeTreeShared({ seed0 });

  it.each([
    ["tree_small_noise", smallNoise],
    ["trees_forest_path_cutout_faded", forestPathCutoutFaded],
  ] as const)("reproduces %s to the noise floor", (name, evalAt) => {
    let worst = 0;
    let label = "";
    positions.forEach((p, i) => {
      const err = Math.abs(evalAt(p.x, p.y) - values[name][i]);
      if (err > worst) {
        worst = err;
        label = `@(${p.x},${p.y})`;
      }
    });
    // Observed worst (2026-07-21, Factorio 2.1.11, seed 123456): tree_small_noise
    // 9.20e-4 (at the deepest far-ring point, where the f32 coordinate floor inside
    // basisNoise bites hardest), trees_forest_path_cutout_faded 5.65e-5. Do not
    // loosen above 1e-3.
    expect(worst, `${name} worst ${label}`).toBeLessThan(1e-3);
  });
});

describe("every tree species matches the game", () => {
  const fields = makeTreeSpeciesFields({ seed0 });

  it("covers all 15 species in the fixture", () => {
    // The count the title claims is now asserted rather than described (#144),
    // and each column is checked for LENGTH rather than mere existence -
    // `toBeDefined()` was satisfied by an empty array, which would have let a
    // fixture that covers no positions at all pass a test named "covers".
    expect(fields).toHaveLength(15);
    for (const f of fields)
      expect(values[f.species.name], f.species.name).toHaveLength(positions.length);
  });

  it.each(fields.map((f) => [f.species.name, f] as const))(
    "reproduces %s to the noise floor",
    (name, field) => {
      let worst = 0;
      let label = "";
      positions.forEach((p, i) => {
        const err = Math.abs(field.evalAt(p.x, p.y) - values[name][i]);
        if (err > worst) {
          worst = err;
          label = `@(${p.x},${p.y})`;
        }
      });
      // Species values live in roughly [-3, 0.45]; the dominant error source is
      // the f32 coordinate floor inside basisNoise. Observed worst across all 15
      // species (2026-07-21, Factorio 2.1.11, seed 123456), after fixing the
      // per-species sizeOffset (tree_05/tree_07 = 0.45, the rest = 0.5): 7.71e-4
      // (tree_02, @(0.5,-799.75)). tree_05 and tree_07 themselves land at
      // 3.15e-4 and 2.92e-4 respectively - the same noise floor as everyone
      // else. Calibrated just above the observed worst; do not loosen above
      // 9e-4 without a new observed-worst measurement to justify it.
      expect(worst, `${name} worst ${label}`).toBeLessThan(9e-4);
    },
  );

  it("agrees on the composed max at every sampled point", () => {
    positions.forEach((p, i) => {
      const expected = Math.min(1, Math.max(0, ...fields.map((f) => values[f.species.name][i])));
      const actual = Math.min(1, Math.max(0, ...fields.map((f) => f.evalAt(p.x, p.y))));
      // Observed worst absolute gap (2026-07-21, all 15 species incl. tree_05/
      // tree_07): 1.03e-4 (@(-1696.6,1697.3)); the relative escape guards the
      // far-ring basisNoise f32 floor the same way as the per-species checks
      // above. Calibrated just above the observed worst; do not loosen the
      // absolute bound above 2e-4 without a new observed-worst measurement.
      expect(agrees(actual, expected, 2e-4, 1e-2), `@(${p.x},${p.y})`).toBe(true);
    });
  });
});

describe("control:trees levers match the game", () => {
  const f = controlFixture as {
    seed0: number;
    treesFrequency: number;
    treesSize: number;
    positions: Array<{ x: number; y: number }>;
    values: Record<string, number[]>;
  };
  const fields = makeTreeSpeciesFields({
    seed0: f.seed0,
    treesFrequency: f.treesFrequency,
    treesSize: f.treesSize,
  });

  it.each(Object.keys(f.values))("reproduces %s at frequency 3 / size 2", (name) => {
    const field = fields.find((x) => x.species.name === name)!;
    let worst = 0;
    let label = "";
    f.positions.forEach((p, i) => {
      const err = Math.abs(field.evalAt(p.x, p.y) - f.values[name][i]);
      if (err > worst) {
        worst = err;
        label = `@(${p.x},${p.y})`;
      }
    });
    // Observed worst (2026-07-21, Factorio 2.1.11, seed 123456, control:trees
    // frequency=3 size=2): tree_01 8.82e-4 (@(0.5,-1199.75)), tree_08 6.12e-4,
    // tree_09_red 1.01e-4 - the same basisNoise f32-floor order of magnitude as
    // the default-lever fixture. Calibrated just above the observed worst
    // (tree_01); do not loosen above 1e-3.
    expect(worst, `${name} worst ${label}`).toBeLessThan(1e-3);
  });

  it("differs from the default-lever field, so the levers are actually live", () => {
    const base = makeTreeSpeciesFields({ seed0: f.seed0 });
    const name = "tree_01";
    const a = base.find((x) => x.species.name === name)!;
    const b = fields.find((x) => x.species.name === name)!;
    const differs = f.positions.some((p) => a.evalAt(p.x, p.y) !== b.evalAt(p.x, p.y));
    expect(differs).toBe(true);
  });
});
