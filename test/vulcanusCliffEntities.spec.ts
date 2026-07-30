import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
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
      const tileAt = makeVulcanusTileResolver({
        seed0: fixture.seed,
        startingPositions: [{ x: 0, y: 0 }],
      });
      const placement = makeCliffPlacementFromFields(makeVulcanusCliffFields(ctx), {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
        tileCollides: (x, y) => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
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
      // **Updated 2026-07-30 again, with `tileCollides` (the lava rejection).**
      // `tryToAddCliff` tests the orientation's collision box against the tile
      // mask grid and drops the entity on a hit; the cliff mask holds
      // `water_tile` and `tile_collision_masks.lava()` sets it. See
      // `CLIFF_ORIENTATION_COLLISION_BOX`.
      //
      // | region | game | ours | recall | precision | ratio | before rejection |
      // | --- | --- | --- | --- | --- | --- | --- |
      // | 0 `[0,0]` | 283 | 317 | 0.784 | 0.700 | 1.120 | 335 / 0.806 / 0.681 / 1.184 |
      // | 1 `[1500,1500]` | 885 | 888 | 0.933 | 0.930 | **1.003** | 1065 / 0.938 / 0.779 / 1.203 |
      // | 2 `[-1200,800]` | 401 | 371 | 0.853 | 0.922 | 0.925 | 375 / 0.853 / 0.912 / 0.935 |
      //
      // Region 1 is the case this rule was found on and it lands almost exactly:
      // 173 false positives dropped against 4 true ones, ratio 1.203 -> 1.003.
      //
      // **Reported rather than smoothed over: recall gets WORSE in two regions.**
      // Region 0 loses 6 true positives (0.806 -> 0.784) and region 1 loses 4.
      // Those are cells where the game placed a cliff and our tile resolver puts
      // lava inside its box. The resolver is ~98.2% accurate overall
      // (`vulcanusTiles.spec.ts`) and is plausibly worse at a lava boundary, but
      // that is a hypothesis and has not been measured - it is the first thing to
      // check before concluding the collision geometry is wrong.
      //
      // A control run pins that the rejection is not just deleting cells at the
      // background lava rate: sampling the same lava field 10,000 tiles away
      // rejects 111 TP / 40 FP at `[0,0]` and 361 TP / 82 FP at `[1500,1500]` -
      // indiscriminate, ratio collapsing to 0.65 / 0.70. The real arm rejects
      // almost only false positives.
      //
      // **Still not Nauvis-grade, and the remaining gap is no longer one thing.**
      // `test/cliffPlacement.spec.ts` measures Nauvis at 1.0000 recall AND
      // precision. Region 1 is now within 0.3% on count; regions 0 and 2 barely
      // moved and are +12% and -7.5%. The residual is not one-directional - region
      // 2 UNDER-places - which is why the ratio is guarded on both sides below.
      expect(recall).toBeGreaterThan(0.77);
      expect(precision).toBeGreaterThan(0.68);
      expect(predicted.size / actual.size).toBeLessThan(1.15);
      expect(predicted.size / actual.size).toBeGreaterThan(0.9);
    }, 120000);
  }
});
