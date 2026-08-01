import { describe, expect, it } from "vite-plus/test";

import sweep from "./fixtures/oracle-vulcanus-cliff-smoothing.seed123456.json";
import { CLIFF_ORIENTATION_NAMES, cliffOrientationForCode } from "../src/noise/cliffs/cliffCatalog";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (p: { x: number; y: number }): string => `${String(p.x)},${String(p.y)}`;

const ctx = withCtxDefaults({ seed0: sweep.seed, startingPositions: [{ x: 0, y: 0 }] });
const fields = makeVulcanusCliffFields(ctx);

const score = (
  smoothing: number,
  cliffs: readonly { x: number; y: number; name: string; orientation: string }[],
) => {
  const r = sweep.region;
  const game = new Map<string, string>();
  for (const p of cliffs.filter((q) => q.name === "cliff-vulcanus"))
    game.set(key(p), p.orientation);
  const cells = makeCliffPlacementFromFields(fields, {
    elevation0: VULCANUS_CLIFF_ELEVATION_0,
    interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
    smoothing,
  }).placedCells(r.x0, r.y0, r.x1, r.y1);
  let matched = 0;
  let wrong = 0;
  for (const p of cells) {
    const want = game.get(key(p));
    if (want === undefined) continue;
    matched++;
    if (CLIFF_ORIENTATION_NAMES[cliffOrientationForCode(p.code) as number] !== want) wrong++;
  }
  return { game: game.size, ours: cells.length, matched, wrong };
};

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

  it("reports the settings Vulcanus actually generates with", () => {
    // Read off the surface, not out of planet-map-gen.lua.
    const eff = sweep.cases[sweep.cases.length - 1].effective;
    expect(eff?.name).toBe("cliff-vulcanus");
    expect(eff?.cliff_elevation_0).toBe(VULCANUS_CLIFF_ELEVATION_0);
    expect(eff?.cliff_elevation_interval).toBe(VULCANUS_CLIFF_ELEVATION_INTERVAL);
    expect(eff?.cliff_smoothing).toBe(VULCANUS_CLIFF_SMOOTHING);
  });

  it("agrees with the default-preset fixture at s = 1", () => {
    // The sweep's s=1 arm is the same surface every other Vulcanus cliff fixture
    // samples, so it must reproduce that region's 283 cliffs. This is what ties
    // the new fixture to the existing ones.
    const s1 = sweep.cases.find((c) => c.cliffSmoothing === 1);
    expect(s1?.cliffs.filter((c) => c.name === "cliff-vulcanus").length).toBe(283);
  });

  it("is WRONG at s = 0, which is what clears the smoothing of causing #18", () => {
    const s0 = sweep.cases.find((c) => c.cliffSmoothing === 0);
    const r = score(0, s0?.cliffs ?? []);
    // Measured 289 matched / 83 wrong. With smoothing off the elevation is the
    // raw field and the rule is the one that scores Nauvis 334/334, so a port
    // whose only defect were the smoothing would be EXACT here.
    expect(r.matched).toBeGreaterThan(250);
    expect(r.wrong).toBeGreaterThan(50);
    // An upper bound as well, so this cannot silently rot in either direction.
    expect(r.wrong).toBeLessThanOrEqual(83);
  });

  it("is no better at any other smoothing value - the error is flat in s", () => {
    const rates = sweep.cases.map((c) => {
      const r = score(c.cliffSmoothing, c.cliffs);
      return r.wrong / r.matched;
    });
    // Measured 0.287 / 0.273 / 0.298. Pinned as a band rather than three numbers:
    // the claim is that nothing in this range is exact, not the exact values.
    for (const rate of rates) {
      expect(rate).toBeGreaterThan(0.2);
      expect(rate).toBeLessThan(0.35);
    }
  });
});
