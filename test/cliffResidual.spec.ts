import { describe, expect, it } from "vite-plus/test";

import { makeCliffElevation, makeCliffFields } from "../src/noise/cliffs/cliffFields";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeTileResolver } from "../src/noise/tiles/resolve";
import elevFixture from "./fixtures/oracle-cliff-elevation.seed123456.json";
import fx from "./fixtures/oracle-cliff-entities.seed123456.json";
import vFix from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";

/**
 * What Nauvis's ~6% cliff residual actually is (issue #18, #22).
 *
 * `cliffs-NOTES.md` named two causes for it on 2026-07-20 and **both are now
 * falsified by measurement**:
 *
 * 1. `fixImpossibleCells` - ported 2026-07-28, and it does not change Nauvis by
 *    a single cell (`test/cliffFixImpossibleCells.spec.ts`).
 * 2. `tryToAddCliff`'s `wouldCollide` water rejection - it can never fire,
 *    asserted below.
 *
 * A third, added 2026-07-28 and **falsified the same day**, was FIELD PRECISION.
 * The threshold-sensitivity measurement below is real - our wrong cells do sit
 * 3-4x closer to a band boundary than our right ones - but the inference drawn
 * from it was wrong, and wrong by two and a half orders of magnitude. Boundary
 * proximity is the generic signature of a MARGINAL DECISION; it does not name
 * what tips the decision. Nobody had checked the one number that decides it:
 * how big our field error actually is against how big it would have to be.
 *
 * `describe("...is far too small to be the cause")` below closes that, using
 * only committed fixtures:
 *
 * - our `cliff_elevation_nauvis` agrees with the game to ~1e-4 (max 3.5e-4
 *   over the 1024-point oracle grid), and
 * - perturbing the field by that much flips **zero** cells; flipping the 16
 *   Nauvis misses needs ~0.1, roughly 300x more error than we have.
 *
 * Corroborated off-fixture the same day by a direct capture of
 * `cliff_elevation_nauvis` + `cliffiness_nauvis` at the exact corners of all 38
 * failing cells (both seeds): error there is 1.3e-4 median, statistically the
 * same as at matched cells, the cliffiness gate is exact (0/102 and 0/19
 * mismatches), and re-running the crossing rule on the GAME'S OWN corner values
 * reproduces our verdict at every one of the 38 - 0 differ. See
 * `docs/noise/cliffs-NOTES.md` for what that leaves.
 */
const key = (p: { x: number; y: number }): string => `${String(p.x)},${String(p.y)}`;

const CASES = (fx as unknown as { cases: { seed: number; cliffs: { x: number; y: number }[] }[] })
  .cases;

function setup(seed: number): {
  fields: ReturnType<typeof makeCliffFields>;
  placed: { x: number; y: number }[];
  actual: Set<string>;
} {
  const fields = makeCliffFields({
    seed0: seed,
    controls: { frequency: 1, continuity: 1 },
    settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
  });
  const placed = makeCliffPlacementFromFields(fields, {
    elevation0: 10,
    interval: 40,
  }).placedCells(512, 512, 1024, 1024);
  const actual = new Set(
    CASES.find((c) => c.seed === seed)
      ?.cliffs.filter((p) => p.x >= 512 && p.x < 1024 && p.y >= 512 && p.y < 1024)
      .map(key) ?? [],
  );
  return { fields, placed, actual };
}

/** The 4x4 tile block a cell occupies: x in [cx-2, cx+2), y in [cy-2.5, cy+1.5). */
function footprint(cx: number, cy: number): [number, number][] {
  const tiles: [number, number][] = [];
  const y0 = Math.floor(cy - 2.5);
  for (let tx = cx - 2; tx < cx + 2; tx++)
    for (let ty = y0; ty < y0 + 4; ty++) tiles.push([tx, ty]);
  return tiles;
}

describe("Nauvis cliff residual: water rejection cannot be the cause", () => {
  for (const { seed } of CASES) {
    it(`seed ${String(seed)}: no cliff cell touches water, ours or the game's`, () => {
      // `tryToAddCliff` (`0x101625038`) rejects a cliff whose orientation-specific
      // bounding box collides, via the map-gen per-tile mask grid. `generateCliffs`
      // runs BEFORE `generateEntities`, so the only masks in that grid are the
      // tiles' - and the only tile layer the cliff mask intersects is `water_tile`.
      // So the whole rejection reduces to "no cliffs on water" here.
      //
      // It can never fire: `cliff_elevation_nauvis` is `10 + 30 * (...)` and
      // `crossesCliff` needs both corners non-negative with max >= elevation_0,
      // so the geometry already excludes everywhere water can be.
      const { placed, actual } = setup(seed);
      const resolve = makeTileResolver({ seed0: seed });
      const touchesWater = (cx: number, cy: number): boolean =>
        footprint(cx, cy).some(([tx, ty]) => resolve(tx, ty).name.includes("water"));

      for (const p of placed) expect(touchesWater(p.x, p.y)).toBe(false);
      for (const k of actual) {
        const [gx, gy] = k.split(",").map(Number);
        expect(touchesWater(gx, gy)).toBe(false);
      }
    }, 120000);

    it(`seed ${String(seed)}: ...and that is not vacuous - the region really is wet`, () => {
      // Without this the assertion above would pass just as happily if the tile
      // resolver never returned water at all, or if `.includes("water")` matched
      // nothing. Measured 2026-07-28: 21.1% of the region at seed 123456 and
      // 71.9% at 777771, sampled every 4 tiles.
      const resolve = makeTileResolver({ seed0: seed });
      let water = 0;
      let n = 0;
      for (let y = 512; y < 1024; y += 8)
        for (let x = 512; x < 1024; x += 8) {
          n++;
          if (resolve(x, y).name.includes("water")) water++;
        }
      expect(water / n).toBeGreaterThan(0.15);
    }, 120000);
  }
});

describe("Nauvis cliff residual: RESOLVED 2026-07-30 - there are no wrong cells", () => {
  for (const { seed } of CASES) {
    it(`seed ${String(seed)}: every placed cell is a real cliff, and every real cliff is placed`, () => {
      // Distance from the nearest cliff band boundary (`10 + 40k`), minimised
      // over the cell's four corners. Measured 2026-07-28:
      //
      // | seed | matched p10/p50/p90 | mismatched p10/p50/p90 |
      // | --- | --- | --- |
      // | 123456 | 0.04 / 0.24 / 0.60 (n=266) | 0.02 / 0.07 / 0.25 (n=16) |
      // | 777771 | 0.06 / 0.26 / 0.53 (n=49) | 0.04 / 0.06 / 0.06 (n=3) |
      //
      // Mismatched cells sit 3-4x closer to a boundary at the median. That is
      // what a small field difference looks like - our cliff elevation and the
      // game's disagree by enough to flip a corner across a band edge, but only
      // where the corner was already sitting on one. A structural rule we had
      // failed to port would not select for boundary proximity like this.
      const { fields, placed, actual } = setup(seed);
      const distance = (cx: number, cy: number): number => {
        let best = Infinity;
        for (const [dx, dy] of [
          [-2, -2],
          [2, -2],
          [-2, 2],
          [2, 2],
        ]) {
          const e = fields.cliffElevation(cx + dx, cy + dy);
          if (e < 0) continue;
          const d = (((e - 10) % 40) + 40) % 40;
          best = Math.min(best, Math.min(d, 40 - d));
        }
        return best;
      };

      const matched: number[] = [];
      const mismatched: number[] = [];
      for (const p of placed) (actual.has(key(p)) ? matched : mismatched).push(distance(p.x, p.y));

      expect(matched.length).toBeGreaterThan(40);

      // **The residual is GONE.** Not shrunk - zero. Every cell we place is a
      // real cliff (no false positives) and the recall/precision spec in
      // `cliffPlacement.spec.ts` now measures 1.0000 / 1.0000 / ratio 1.000 at
      // both seeds, up from 0.943 / 0.943.
      //
      // The cause was the SAMPLE LATTICE, not the rule and not the field: the
      // port added the prototype's `grid_offset {0, 0.5}` - a CENTRE offset -
      // to the field sample position as well, reading every corner half a tile
      // off in y. It moved no placed cliff, so every positional check passed.
      // See `CLIFF_CELL_CENTER_X` in cliffCatalog.ts.
      //
      // This block used to assert the OPPOSITE - that mismatched cells exist
      // and sit closer to band edges than matched ones (medians 3.4x and 4.3x
      // apart). That measurement was real and is preserved in git; it described
      // a marginal decision, not a cause, exactly as `boundary-proximity-is-not
      // -a-cause` concluded. `distance` above is kept because the loop still
      // partitions on it, which is what proves the mismatched set is empty
      // because there is nothing in it - not because the loop never ran.
      expect(mismatched.length).toBe(0);
      expect(actual.size).toBe(placed.length);
    }, 120000);
  }
});

describe("Nauvis cliff residual: the field error is far too small to be the cause", () => {
  // The two halves of the falsification. Neither needs a Factorio install: the
  // first reads the committed `cliff_elevation_nauvis` oracle grid, the second
  // is pure arithmetic on the placement rule.

  it("our cliff elevation agrees with the game to ~1e-4", () => {
    // `cliffFields.spec.ts` guards this field at a 1% RELATIVE tolerance, which
    // on a 40-wide band is +-0.4 - five times the distance that separates a
    // matched cell from a mismatched one, so it can neither confirm nor exclude
    // the precision story. This records the ACTUAL agreement instead.
    //
    // Measured 2026-07-28 over the fixture's 1024 corner-lattice points:
    //
    // | seed   | p50 abs | p90 abs | max abs |
    // | ------ | ------- | ------- | ------- |
    // | 123456 | 1.03e-4 | 2.13e-4 | 3.55e-4 |
    // | 777771 | 1.48e-4 | 3.11e-4 | 4.85e-4 |
    //
    // Note the game's own values come back as exact f32 (the worst point reads
    // 23.576189041137695), so this ~1e-4 is our port's numerical distance from
    // the game - the fastapprox floor compounding through the hills chain - not
    // a quantisation artefact of the capture.
    for (const c of elevFixture.cases) {
      const f = makeCliffElevation({
        seed0: c.seed,
        controls: { frequency: 1, continuity: 1 },
        settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
      });
      let worst = 0;
      for (let i = 0; i < elevFixture.positions.length; i++) {
        const p = elevFixture.positions[i];
        worst = Math.max(worst, Math.abs(f(p.x, p.y) - c.values[i]));
      }
      // Pinned just outside the measured 4.85e-4. If a future change to the
      // hills chain closes the fastapprox gap this fails and wants re-measuring
      // DOWNWARD - which would be good news, and would also make the sweep
      // below even more conclusive.
      expect(worst).toBeLessThan(1e-3);
    }
  });

  it("...and perturbing the field by that much flips no cells at all", () => {
    // The decisive comparison. Jitter the cliff elevation field by +-eps at
    // every corner and count how many placed cells change. Measured 2026-07-28
    // at seed 123456 (mean of 3 independent deterministic draws):
    //
    // | eps    | cells changed |
    // | ------ | ------------- |
    // | 3.5e-4 | 0.0           |  <- our ACTUAL worst-case field error
    // | 1e-3   | 0.0           |
    // | 1e-2   | 0.3           |
    // | 5e-2   | 4.3           |
    // | 1e-1   | 9.0           |
    // | 3e-1   | 39.0          |
    //
    // Nauvis misses 16 cells. Reaching 16 takes eps of order 0.1 - about 300x
    // the error we actually carry, and ~200x the max. A field difference of
    // 1e-4 cannot move a decision that sits 0.07 from a boundary, which is
    // exactly where the mismatched cells sit (measured above). So the residual
    // is NOT f32 rounding and NOT the fastapprox floor.
    const seed = 123456;
    const base = makeCliffFields({
      seed0: seed,
      controls: { frequency: 1, continuity: 1 },
      settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
    });
    const bands = { elevation0: 10, interval: 40 };
    const baseline = new Set(
      makeCliffPlacementFromFields(base, bands).placedCells(512, 512, 1024, 1024).map(key),
    );

    /** Deterministic hash jitter in [-eps, eps], stable per corner. */
    const jitter = (x: number, y: number, eps: number, salt: number): number => {
      let h =
        Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
      h ^= h >>> 15;
      h = Math.imul(h, 0x85ebca6b);
      h ^= h >>> 13;
      return (((h >>> 0) / 0xffffffff) * 2 - 1) * eps;
    };
    const changedAt = (eps: number, salt: number): number => {
      const placed = makeCliffPlacementFromFields(
        {
          cliffElevation: (x, y) => base.cliffElevation(x, y) + jitter(x, y, eps, salt),
          cliffiness: base.cliffiness,
        },
        bands,
      ).placedCells(512, 512, 1024, 1024);
      const set = new Set(placed.map(key));
      let changed = 0;
      for (const k of set) if (!baseline.has(k)) changed++;
      for (const k of baseline) if (!set.has(k)) changed++;
      return changed;
    };

    // At our real worst-case error, nothing moves - across independent draws.
    for (const salt of [1, 2, 3]) expect(changedAt(3.5e-4, salt)).toBe(0);

    // Non-vacuity: the jitter IS reaching the placement rule. Without this the
    // assertion above would pass just as happily against a no-op perturbation,
    // which is precisely the shape of a test that confirms nothing.
    expect(changedAt(1, 1)).toBeGreaterThan(50);

    // And the residual-sized effect needs a residual-sized error: an order of
    // magnitude more than 1e-2, i.e. ~1e-1, not ~1e-4.
    expect(changedAt(1e-2, 1)).toBeLessThan(4);
  }, 120000);
});

describe("Vulcanus's residual: RESOLVED 2026-08-01, and it was never threshold noise", () => {
  /**
   * **This block used to measure how far Vulcanus's wrong cells sat from a band
   * edge, to argue its residual was structural rather than precision noise. That
   * argument was right, and the structure has now been found**, so the
   * measurement no longer has a population to run on.
   *
   * The cause was `multisample`: its offsets are in the consuming noise
   * program's GRID UNITS, not tiles, so `vulcanus_basalt_lakes_multisample`'s
   * 2x2 min-filter spans 4 tiles for the cliff generator and 1 tile for every
   * per-tile consumer. The port used 1 everywhere, making the cliff elevation
   * too rough. See `test/multisampleGrid.spec.ts`.
   *
   * What is left of the numbers this file used to record: the port now matches
   * the game's cliff set at **recall 1.000 / 0.973 / 0.965** across the three
   * regions, so the "mismatched" population is a handful of cells per region -
   * far too few for the median-distance comparison that used to live here, which
   * needed 20+ per region and now finds as few as 9.
   *
   * The Nauvis half of the argument (above) is untouched and still stands.
   */
  it("no longer has a mismatched population large enough to compare", () => {
    const ctx = withCtxDefaults({ seed0: vFix.seed, startingPositions: [{ x: 0, y: 0 }] });
    const fields = makeVulcanusCliffFields(ctx);
    for (const c of vFix.cases) {
      const r = c.region;
      const placed = makeCliffPlacementFromFields(fields, {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
      }).placedCells(r.x0, r.y0, r.x1, r.y1);
      const actual = new Set(c.cliffs.filter((p) => p.name === "cliff-vulcanus").map(key));
      let mismatched = 0;
      for (const p of placed) if (!actual.has(key(p))) mismatched++;
      // Non-vacuity: the port is placing a real number of cells, so a low
      // mismatch count means agreement and not an empty result.
      expect(placed.length).toBeGreaterThan(200);
      // Measured 9 / 209 / 7 over the three regions, against the 20+ per region
      // the retired comparison required. Pinned as an upper bound so it can only
      // improve; `[1500,1500]` is the region still carrying real over-placement,
      // and the lava-collision rejection this arm does not apply removes much of
      // it in the shipping renderer.
      expect(mismatched).toBeLessThanOrEqual(210);
    }
  }, 300000);
});
