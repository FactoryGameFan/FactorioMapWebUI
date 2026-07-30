import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (p: { x: number; y: number }): string => `${String(p.x)},${String(p.y)}`;

/**
 * End-to-end validation of the VULCANUS cliff placement against the game's real
 * cliff entities (issue #18). Until this existed, the Vulcanus cliff overlay had
 * no entity-level check at all: what was proven was that `cliffiness_basic`
 * matches the game to under 5e-6 and that the placement geometry is literally the
 * same code that scores ~90% on Nauvis. "Same code path" is an argument, not a
 * measurement - and this repo has a specific history of that argument failing.
 *
 * **This measures precision as well as recall, which the Nauvis spec does not.**
 * `test/cliffPlacement.spec.ts` asserts only that >=85% of real cliffs are
 * reproduced, and a model that placed a cliff on every lattice cell would score
 * 100% on that. Over-placement is exactly the failure mode the render made
 * plausible here - the mark-size work measured 34.2% cliff-pixel coverage in the
 * `[1500,1500]` window - so both directions are reported.
 */
describe("Vulcanus cliff placement vs find_entities", () => {
  for (const [index, c] of fixture.cases.entries()) {
    it(`agrees with the game's cliffs in region ${String(index)} [${String(c.region.x0)},${String(c.region.y0)}]`, () => {
      const ctx = withCtxDefaults({ seed0: fixture.seed, startingPositions: [{ x: 0, y: 0 }] });
      const placement = makeCliffPlacementFromFields(makeVulcanusCliffFields(ctx), {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
      });
      const r = c.region;
      const placed = placement.placedCells(r.x0, r.y0, r.x1, r.y1);

      // **`find_entities_filtered{type = "cliff"}` is not a clean proxy for
      // "cliff lattice output" on Vulcanus.** The dump also catches
      // `crater-cliff`, which the planet definition lists under its ENTITY
      // autoplace settings (`space-age/prototypes/planet/planet-map-gen.lua:122`,
      // beside the rocks and the geyser) rather than placing on the cliff grid.
      // It is placed by the entity generator, jitter draws and all, so its
      // positions are fractional - 8 of region 2's 409 sit at coordinates like
      // (-1184.375, 814.988). Comparing them against a lattice would be a
      // category error, and they are excluded here rather than absorbed into the
      // rates. This is also why the capture now dumps entity names.
      const realCliffs = c.cliffs.filter((p) => p.name === "cliff-vulcanus");
      expect(realCliffs.length).toBeGreaterThan(0);

      // Sanity on the oracle dump itself: every real `cliff-vulcanus` sits on the
      // same 4-tile lattice Nauvis's cliffs do (x mod 4 == 2, y mod 4 == 2.5). If
      // this ever fails, the planets do NOT share a grid and the shared placement
      // module is the wrong abstraction - a much bigger finding than the rates.
      for (const p of realCliffs) {
        expect(((p.x % 4) + 4) % 4).toBe(2);
        expect(((p.y % 4) + 4) % 4).toBeCloseTo(2.5, 9);
      }

      const predicted = new Set(placed.map(key));
      const actual = new Set(realCliffs.map(key));
      let matched = 0;
      for (const k of actual) if (predicted.has(k)) matched++;
      const recall = matched / actual.size;
      const precision = matched / predicted.size;

      console.log(
        `vulcanus cliffs region ${String(index)} [${String(r.x0)},${String(r.y0)}]: ` +
          `game=${String(actual.size)} ours=${String(predicted.size)} matched=${String(matched)} ` +
          `recall=${recall.toFixed(4)} precision=${precision.toFixed(4)} ` +
          `ratio=${(predicted.size / actual.size).toFixed(3)}`,
      );

      // Drift guards, pinned just OUTSIDE the measured values so a regression
      // fails and noise does not. Cliff placement is deterministic given the
      // seed - there is no roll here - so these numbers are exactly
      // reproducible; the slack is to leave room for the port to IMPROVE
      // without editing the test.
      //
      // Measured 2026-07-28, after `cliff_smoothing = 1` was ported (issue #18);
      // the "was" column is the same code with smoothing left at Nauvis's 0.
      //
      // Updated 2026-07-28 again, after `fixImpossibleCells` was ported. That
      // pass moves these only slightly - recall +0.25 to +1.5 points, precision
      // a shade up, count a shade WORSE.
      //
      // **Updated 2026-07-30: the fields were being sampled half a tile off in
      // y.** The prototype's `grid_offset {0, 0.5}` is a CENTRE offset
      // (`entity-util.lua:305`), and `crossingsForChunk` never reads it - the
      // fields come from the bare `(i*4, j*4)` lattice. The port added it to the
      // sample position as well, which moves NO placed cliff (centres are
      // derived independently) and so was invisible to the mod-4 checks, to the
      // preview agreement, and to PR #57's field substitution - that fixture had
      // been captured at the port's own assumed site. See `CLIFF_CELL_CENTER_X`.
      //
      // | region | game | ours | recall | precision | ratio | was (y+0.5) |
      // | --- | --- | --- | --- | --- | --- | --- |
      // | 0 `[0,0]` | 283 | 335 | 0.806 | 0.681 | 1.184 | 0.792 / 0.685 / 1.155 |
      // | 1 `[1500,1500]` | 885 | 1065 | 0.938 | 0.779 | 1.203 | 0.870 / 0.719 / 1.210 |
      // | 2 `[-1200,800]` | 401 | 375 | 0.853 | 0.912 | 0.935 | 0.803 / 0.866 / 0.928 |
      //
      // Recall improves in all three regions (+1.4, +6.8, +5.0 points) and
      // precision in two of three; region 0's precision is flat-to-slightly-down
      // (-0.4) because it also places 8 more cells. Reported rather than
      // smoothed over: this fixes a real sampling error, it does not fix
      // over-placement.
      //
      // **Still not Nauvis-grade.** `test/cliffPlacement.spec.ts` measures Nauvis
      // at 1.0000 recall AND precision with a ratio of exactly 1.000 - the same
      // sampling fix took it from 0.943 to EXACT. Vulcanus now
      // reproduces 81-94% and its count is within 7-20%. The residual is not
      // one-directional - region 2 UNDER-places - which is why the ratio is
      // guarded on both sides below. Issue #18 tracks what is left, which is now
      // over-placement rather than recall.
      //
      // Nauvis's cliff prototype is also `scale = 1.0` and carries the same
      // `grid_offset`, which is why one fix moved both planets - but only Nauvis
      // went exact. Whatever is left here is Vulcanus-specific and is
      // over-placement, not recall.
      expect(recall).toBeGreaterThan(0.75);
      expect(precision).toBeGreaterThan(0.65);
      expect(predicted.size / actual.size).toBeLessThan(1.25);
      expect(predicted.size / actual.size).toBeGreaterThan(0.85);
    }, 120000);
  }
});
