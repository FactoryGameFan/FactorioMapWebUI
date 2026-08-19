import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-trees.seed123456.json";
import controlFixture from "./fixtures/oracle-trees-controls.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { makeTreeShared } from "../src/noise/trees/treeShared";
import { makeTreeSpeciesFields } from "../src/noise/trees/treeField";

const { seed0, positions, values } = fixture as {
  seed0: number;
  positions: Array<{ x: number; y: number }>;
  values: Record<string, number[]>;
};

/**
 * Tolerance idiom borrowed from test/resourcePatches.spec.ts: an absolute bound
 * plus a relative escape, so a large-magnitude point cannot mask a small one.
 *
 * The "far-field basisNoise f32 floor" this used to guard against was mostly not
 * a precision floor at all. 14 of these 26 positions were CAPTURED off the game's
 * 1/256 MapPosition grid, so the game evaluated at a different point than the
 * fixture records (#186). Every sample coordinate below is snapped the way the
 * game does before evaluation - see test/captureGrid.ts - and the bounds fell by
 * 76x to 356x as a result.
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
    positions.forEach((raw, i) => {
      const p = snapPosition(raw);
      const err = Math.abs(evalAt(p.x, p.y) - values[name][i]);
      if (err > worst) {
        worst = err;
        label = `@(${p.x},${p.y})`;
      }
    });
    // Re-measured 2026-08-18 with the sample coordinate snapped onto the game's
    // 1/256 grid: **tree_small_noise is now bit-exact at all 26 positions, worst
    // 0**, and trees_forest_path_cutout_faded is 4.071e-8. Before the snap they
    // were 9.233e-4 and 6.012e-5, and the worst sat on an off-grid ring point -
    // which the old comment read as "where the f32 coordinate floor inside
    // basisNoise bites hardest". It was the capture, not basisNoise.
    expect(worst, `${name} worst ${label}`).toBeLessThan(6e-8);
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
      positions.forEach((raw, i) => {
        const p = snapPosition(raw);
        const err = Math.abs(field.evalAt(p.x, p.y) - values[name][i]);
        if (err > worst) {
          worst = err;
          label = `@(${p.x},${p.y})`;
        }
      });
      // Species values live in roughly [-3, 0.45]; the dominant error source is
      // Re-measured 2026-08-18 with the sample coordinate snapped onto the
      // game's 1/256 grid (test/captureGrid.ts): worst across all 15 species is
      // 2.593e-6 (tree_05), against 7.443e-4 before. For every one of the 17
      // arrays in this fixture the pre-snap worst sat on an off-grid row; the
      // per-species on-grid worst ran 4.1e-7 to 2.2e-6 while the off-grid worst
      // ran 2.0e-4 to 7.4e-4. Calibrated just above the measured worst; do not
      // loosen without a new measurement.
      expect(worst, `${name} worst ${label}`).toBeLessThan(4e-6);
    },
  );

  it("agrees on the composed max at every sampled point", () => {
    positions.forEach((raw, i) => {
      const p = snapPosition(raw);
      const expected = Math.min(1, Math.max(0, ...fields.map((f) => values[f.species.name][i])));
      const actual = Math.min(1, Math.max(0, ...fields.map((f) => f.evalAt(p.x, p.y))));
      // Observed worst absolute gap (2026-07-21, all 15 species incl. tree_05/
      // tree_07): 1.03e-4 (@(-1696.6,1697.3)); the relative escape guards the
      // far-ring basisNoise f32 floor the same way as the per-species checks
      // above. Calibrated just above the observed worst; do not loosen the
      // absolute bound above 2e-4 without a new observed-worst measurement.
      expect(agrees(actual, expected, 3e-7, 1e-2), `@(${p.x},${p.y})`).toBe(true);
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
    f.positions.forEach((raw, i) => {
      const p = snapPosition(raw);
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
    expect(worst, `${name} worst ${label}`).toBeLessThan(2e-5);
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

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-trees still has off-grid positions", () => {
    expect(countOffGrid(positions)).toBe(14);
  });
  it("oracle-trees-controls still has off-grid positions", () => {
    expect(countOffGrid(controlFixture.positions)).toBe(7);
  });
});
