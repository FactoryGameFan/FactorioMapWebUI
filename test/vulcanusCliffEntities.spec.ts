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
      // **Updated 2026-08-01, after the `multisample` grid-units fix (#83).**
      // That fix is measured in `test/multisampleGrid.spec.ts`; these are its
      // end-to-end numbers on the path the renderer actually runs.
      //
      // **Updated 2026-08-02, after DISASSEMBLING the collision test.** The box
      // is the RAW stored rectangle: `tryToAddCliff` calls `wouldCollide` with
      // `Direction = 0`, and `BoundingBox(BoundingBox const&, Direction)` takes
      // its identity arm, copying `left_top`/`right_bottom` and discarding the
      // `1/8` orientation tag. See `rotbbBox` in `cliffCatalog.ts`.
      //
      // | region | game | ours | recall | precision | ratio |
      // | --- | --- | --- | --- | --- | --- |
      // | 0 `[0,0]` | 283 | 283 | 0.9929 | 0.9929 | 1.000 |
      // | 1 `[1500,1500]` | 885 | 900 | 0.9695 | 0.9533 | 1.017 |
      // | 2 `[-1200,800]` | 401 | 387 | 0.9626 | 0.9974 | 0.965 |
      // | **total** | **1569** | **1570** | **0.9720** | **0.9713** | 1.001 |
      //
      // **These are WORSE than the numbers this comment carried for one day, and
      // they are the right ones.** Three box models have shipped here:
      //
      // | box | false rejections | recall | precision | evidence |
      // | --- | --- | --- | --- | --- |
      // | AABB of the rotated rect | 13 | 0.9675 | 0.9743 | none |
      // | 45-degree oriented rect (#88) | 0 | 0.9758 | 0.9727 | empirical fit |
      // | raw stored rect (current) | 6 | 0.9720 | 0.9713 | **disassembly** |
      //
      // #88's middle row scored best on every metric and was wrong. It shrank
      // the box past what the engine uses, which ALSO absorbed the unrelated
      // orientation residual - 4 of the 6 cliffs the correct box still rejects
      // are cells where our orientation disagrees with the game's, so we load
      // the wrong box entirely. A model that scores perfectly by hiding a second
      // defect is worse than one that leaves it visible.
      //
      // **The lava rejection is what closes the over-placement, and #84 item 1
      // asked how much.** The answer is nearly all of it. Without it the same
      // code places 1756 against the game's 1569 for a precision of 0.8719; the
      // rejection drops 198 cells, of which **185 are false positives and 13 are
      // true**. Precision 0.8719 -> 0.9743 and the port goes from over-placing
      // 12% to under-placing 0.7%. So the "187-cell excess" recorded in #84 was
      // 185 cells of a rule the measurement was not applying, not a defect.
      //
      // **The rejection used to cost recall, and chasing those 13 lost true
      // positives is what found the box bug.** They were cells where the game
      // placed a cliff and our collision box found lava inside it.
      //
      // **They were NOT a lava-mask error, and this comment said they were for
      // two days.** The claim was that the resolver is "off by about one tile
      // SOMEWHERE"; a dense 994-position capture at exactly those boundaries
      // (`oracle-vulcanus-lava-boundary.seed123456.json`) found **zero** lava
      // mismatches, 35/35 correct at the very tiles that accused it. The mask
      // was innocent and the COLLISION BOX was wrong - see
      // `test/cliffOrientedBox.spec.ts`. What survives of the original reasoning:
      //
      // - The resolver is NOT worse at a lava boundary. Its binary lava/not
      //   classification - the only thing `tryToAddCliff` reads - is EXACT on
      //   all 381 oracle positions, 49 lava and 332 not, in both directions
      //   (`vulcanusTiles.spec.ts` now pins this at zero mismatches). The 42
      //   positions sitting directly on a lava boundary are 42/42 correct even
      //   on the full 19-way name.
      // - The negative-space oracle was RIGHT that something was wrong: each
      //   real cliff the game placed is a standing assertion that the game saw
      //   no lava in that box, and 13 of them contradicted ours. What the
      //   evidence could not do was name the culprit, and the depth statistic
      //   pointed at the wrong one.
      //
      // **Why "all 13 sit at Chebyshev depth 1 in our lava" misled.** It is a
      // true measurement of a real perimeter effect - and the box's four corners
      // ARE its perimeter, so a corner-shaped box error produces exactly that
      // signature. Two mechanisms, one fingerprint. The statistic could not
      // separate "our lava reaches one tile too far" from "our box reaches into
      // corners the game's does not", and only the first was ever considered.
      // Ruling out a suspect needs a measurement that would come out DIFFERENTLY
      // for each candidate; a depth histogram comes out the same for both.
      //
      // A control run pins that the rejection is not just deleting cells at the
      // background lava rate: sampling the same lava field 10,000 tiles away
      // rejects 111 TP / 40 FP at `[0,0]` and 361 TP / 82 FP at `[1500,1500]` -
      // indiscriminate, ratio collapsing to 0.65 / 0.70. The real arm rejects
      // almost only false positives.
      //
      // **Still not Nauvis-grade.** `test/cliffPlacement.spec.ts` measures Nauvis
      // at 1.0000 recall AND precision. Here 44 of the game's 1569 are missing
      // and 45 of our 1570 are spurious; 6 of the 44 are collision rejections,
      // 4 of those traceable to the orientation residual. The remainder is not
      // one-directional (region 2 UNDER-places, region 1 over-places), which is
      // why the ratio is guarded on both sides below.
      //
      // Guards sit just outside the measured values in the direction that would
      // signal a regression, and open in the direction of improvement.
      expect(recall).toBeGreaterThan(0.95);
      expect(precision).toBeGreaterThan(0.94);
      expect(predicted.size / actual.size).toBeLessThan(1.05);
      expect(predicted.size / actual.size).toBeGreaterThan(0.95);
    }, 120000);
  }
});
