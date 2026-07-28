import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
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

      // Drift guards, pinned BELOW the measured values so a regression fails and
      // noise does not. Cliff placement is deterministic given the seed - there
      // is no roll here - so these numbers are exactly reproducible; the slack is
      // to leave room for the port to IMPROVE without editing the test.
      //
      // | region | game | ours | recall | precision | over-placement |
      // | --- | --- | --- | --- | --- | --- |
      // | 0 `[0,0]` | 283 | 422 | 0.569 | 0.382 | 1.49x |
      // | 1 `[1500,1500]` | 885 | 1399 | 0.694 | 0.439 | 1.58x |
      // | 2 `[-1200,800]` | 401 | 455 | 0.646 | 0.569 | 1.14x |
      //
      // **Do not read these as Nauvis-grade.** `test/cliffPlacement.spec.ts`
      // guards Nauvis at >= 85% recall; Vulcanus reproduces 57-69% of real cliffs
      // and, more importantly, places 1.1-1.6x too MANY. Issue #18 tracks the
      // diagnosis. The bands exist to catch a regression from here, not to
      // certify the current state as good.
      expect(recall).toBeGreaterThan(0.5);
      expect(precision).toBeGreaterThan(0.3);
      expect(predicted.size / actual.size).toBeLessThan(2);
    }, 120000);
  }
});
