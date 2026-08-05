import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-resource-regular.seed123456.json";
import { RESOURCE_CATALOG } from "../src/noise/resources/resourceCatalog";
import { makeRegularPatches } from "../src/noise/resources/regularPatches";

// Ground truth: resource_autoplace_all_patches with has_starting_area_placement=0
// and regular_patch_set_count=1 (pure, unpartitioned regular field), routed onto
// elevation. See docs/superpowers/plans/2026-07-19-milestone3a-regular-patches.md T3/T4.

const paramsByName = new Map(RESOURCE_CATALOG.map((r) => [r.name, r]));

/** Relative error against a game value, floored so basement magnitudes don't dominate. */
function relErr(port: number, game: number): number {
  return Math.abs(port - game) / Math.max(1, Math.abs(game));
}

// M3a Task 4: the regular resource field, validated point-by-point against the
// game. Two facts about the metric:
//
//   * ABSOLUTE error is the honest floor. The field spans ~[-14000, +thousands]
//     (deep basement -> patch peaks), and the game's spot_noise machine evaluates
//     the whole selection/cone/blob chain in f32 - cube roots via its fastapprox
//     `pow` (src/noise/fastApprox.ts). Matching that (fastCbrt + f32 cone render)
//     pins the port to the game within ~0.7 units EVERYWHERE. We assert < 1.0.
//   * RELATIVE error stays < 1e-3 across the smooth patch interiors, but at cone
//     edges / basement zero-crossings (where |field| is a handful of units) the
//     ~0.7-unit f32 noise inflates to ~9e-3 relative - the same f32 floor M1
//     (elevation_lakes, 7.4e-3) and the Island map type (6.66e-3) documented. We
//     assert < 1e-2, matching that precedent.
//
// Before the f32/fastCbrt work the absolute error was ~3 units and the relative
// worst was 4.8e-2 (exact Math.cbrt); see docs/noise/random-penalty-NOTES.md
// "Composition inside spot selection" and the fastapprox-cbrt residual.
//
// **2026-08-04: `fastApprox`'s log2/exp2 became bit-exact (per-operation f32
// rounding instead of one rounding at the end), and it moved these numbers - in
// BOTH directions.** Values change on 4093-4105 of the 4105 points in every case,
// so nothing here is untouched. Measured, before -> after:
//
//   iron-ore/123456     abs 0.6898 -> 0.8159    rel 4.875e-4 -> 1.276e-4
//   uranium-ore/123456  abs 0.3788 -> 0.4790    rel 7.103e-5 -> 8.302e-5
//   iron-ore/777771     abs 0.6860 -> 0.8096    rel 8.849e-3 -> 1.273e-4
//   uranium-ore/777771  abs 0.6135 -> 0.4755    rel 4.090e-4 -> 7.562e-5
//
// Relative error improved sharply (iron/777771 by 70x, which is what dominated
// REL_TOL's headroom), but worst-ABSOLUTE regressed on three of the four cases,
// cutting the ABS_TOL margin from 0.31 to 0.18. That looked like the price of a
// change the binary requires, and it was recorded here as such.
//
// **2026-08-05: most of that absolute regression was a SECOND bug, now fixed**
// (issue #163). `fastCbrt` passed a double `1/3` where the game's
// `Math::powSafe(float, float)` takes an f32 exponent, wrong on ~3.0% of cube
// roots. Fixing it moves these numbers again, and this time only downwards:
//
//   iron-ore/123456     abs 0.8159 -> 0.6491    rel 1.276e-4 -> 1.182e-4
//   uranium-ore/123456  abs 0.4790 -> 0.4790    rel 8.302e-5 -> 8.302e-5
//   iron-ore/777771     abs 0.8096 -> 0.6493    rel 1.273e-4 -> 1.071e-4
//   uranium-ore/777771  abs 0.4755 -> 0.4724    rel 7.562e-5 -> 7.562e-5
//
// So against the ORIGINAL pre-2026-08-04 baseline, three of the four cases are
// now better on absolute error as well as relative (iron/123456 0.6898 ->
// 0.6491, iron/777771 0.6860 -> 0.6493, uranium/777771 0.6135 -> 0.4724); only
// uranium/123456 remains above it (0.3788 -> 0.4790). ABS_TOL headroom is back
// to 0.35 from 0.18.
//
// **The lesson is about the metric, not the numbers.** "Relative improves,
// absolute regresses" read as an inherent trade-off of the rounding change. It
// was not - it was two independent bugs in the same file, one fixed and one
// still present, and the mixed signal was the second one showing through. A
// tolerance-based suite cannot tell those apart.
//
// These tolerances CANNOT police any of it, and that is the point worth
// keeping: at 1.0 absolute and 1e-2 relative they cannot resolve a ~1e-5 shift in
// either direction. A green run of this file is not evidence that a numerics
// change was neutral - `pnpm run verify` passed at every step above. The
// f32-exact guards are `test/fastApprox.spec.ts` (the operator itself),
// `test/voronoiNoise.spec.ts` and `test/voronoiSearchRange.spec.ts` - all compare
// with `toBe` after `f32`, no tolerance. Go there to police a numerics change,
// not here. #162 tracks converting more of this suite to that standard.
const ABS_TOL = 1.0;
const REL_TOL = 1e-2;

describe("makeRegularPatches (regular resource field vs oracle)", () => {
  for (const c of fixture.cases) {
    it(`matches the game for ${c.resource} seed=${c.seed}`, () => {
      const params = paramsByName.get(c.resource)!;
      const patches = makeRegularPatches(params, {
        seed0: c.seed,
        controls: { frequency: 1, size: 1, richness: 1 },
        skipSpan: 1,
        skipOffset: 0,
      });

      let worstAbs = 0;
      let worstRel = 0;
      const mism: { x: number; y: number; game: number; port: number; abs: number; rel: number }[] =
        [];
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const game = c.values[i];
        const port = patches.field(p.x, p.y);
        const abs = Math.abs(port - game);
        const rel = relErr(port, game);
        if (abs > worstAbs) worstAbs = abs;
        if (rel > worstRel) worstRel = rel;
        mism.push({ x: p.x, y: p.y, game, port, abs, rel });
      }

      if (worstAbs >= ABS_TOL || worstRel >= REL_TOL) {
        const top = [...mism]
          .sort((a, b) => b.abs - a.abs)
          .slice(0, 8)
          .map(
            (m) =>
              `  (${m.x},${m.y}) game=${m.game.toFixed(2)} port=${m.port.toFixed(2)} abs=${m.abs.toFixed(3)} rel=${m.rel.toExponential(2)}`,
          )
          .join("\n");
        throw new Error(
          `${c.resource} seed=${c.seed}: worstAbs=${worstAbs.toFixed(3)} (tol ${ABS_TOL}) ` +
            `worstRel=${worstRel.toExponential(3)} (tol ${REL_TOL.toExponential(0)})\n` +
            `largest-absolute mismatches:\n${top}`,
        );
      }
      expect(worstAbs).toBeLessThan(ABS_TOL);
      expect(worstRel).toBeLessThan(REL_TOL);
    });
  }
});
