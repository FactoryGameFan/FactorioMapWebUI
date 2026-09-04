import { describe, expect, it } from "vite-plus/test";

import sweep from "./fixtures/oracle-vulcanus-cliff-smoothing.seed123456.json";

/**
 * **`cliff_smoothing` swept in the GAME, which is what exonerates it** (issue #18).
 *
 * `cliff_smoothing` is the one code path that runs on Vulcanus and not on
 * Nauvis - Nauvis sets 0, Vulcanus takes the prototype default of 1 - so it was
 * the natural home for a residual that Nauvis does not have. On 2026-08-01 it was
 * swept exhaustively *inside the port*: knot span, clamp, lattice anchor, blend
 * strength, per-axis, and the interpolation family. Every parameter came back at
 * a sharp optimum on the shipping value, which was read as "the model is right,
 * so the difference must be somewhere inside it".
 *
 * That reading was wrong, and only the game could say so. Overriding
 * `map_gen_settings.cliff_settings.cliff_smoothing` turns one data point into a
 * family, and **`s = 0` is decisive**: with smoothing off the cliff elevation IS
 * the raw field, which agrees with ours to a maximum of 4.8e-2 over a rule that
 * reproduces Nauvis 334/334. If the smoothing were the residual, `s = 0` would be
 * exact.
 *
 * It is not. Measured 2026-08-01, region `[0,0]`:
 *
 * | `cliff_smoothing` | game | ours | matched | wrong |
 * | --- | --- | --- | --- | --- |
 * | 0 | 352 | 432 | 289 | 83 = **28.7%** |
 * | 0.5 | 315 | 374 | 267 | 73 = 27.3% |
 * | 1 | 283 | 335 | 228 | 68 = 29.8% |
 *
 * **The error is flat in `s`.** Turning the suspect off does not move it, so the
 * residual is not in the smoothing at all and the whole in-port sweep was
 * searching the wrong transform. What it does confirm is that the smoothing
 * model is *good* - the placement counts track the game's across all three
 * values - which is why the parameter optimum was real and still misleading.
 *
 * The dumped `effective` settings are also the only direct evidence, outside the
 * .lua data files, that Vulcanus runs `cliff_elevation_0 = 70`,
 * `cliff_elevation_interval = 120` and `cliff_smoothing = 1`.
 */
describe("Vulcanus cliffs across a cliff_smoothing sweep", () => {
  it("captured three distinct smoothing values, and the override actually applied", () => {
    // Non-vacuity, and the whole point of dumping `effective`: without this an
    // override that silently failed would be indistinguishable from a setting
    // that does not matter - and "it does not matter" is exactly the conclusion
    // this fixture is used to draw.
    expect(sweep.cases.map((c) => c.cliffSmoothing)).toEqual([0, 0.5, 1]);
    for (const c of sweep.cases) expect(c.effective?.cliff_smoothing).toBe(c.cliffSmoothing);
    // The game placed materially different cliffs at each value.
    const counts = sweep.cases.map((c) => c.cliffs.length);
    expect(new Set(counts).size).toBe(3);
  });

  it("agrees with the default-preset fixture at s = 1", () => {
    // The sweep's s=1 arm is the same surface every other Vulcanus cliff fixture
    // samples, so it must reproduce that region's 283 cliffs. This is what ties
    // the new fixture to the existing ones.
    const s1 = sweep.cases.find((c) => c.cliffSmoothing === 1);
    expect(s1?.cliffs.filter((c) => c.name === "cliff-vulcanus").length).toBe(283);
  });
});
