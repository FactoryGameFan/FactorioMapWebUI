import { describe, expect, it } from "vite-plus/test";

import { makeCliffFields } from "../src/noise/cliffs/cliffFields";
import { makeCliffPlacementFromFields, smoothingKnots } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeTileResolver } from "../src/noise/tiles/resolve";
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
 * What is left is threshold sensitivity, also asserted below: the cells we get
 * wrong sit far closer to a cliff band boundary than the cells we get right, so
 * a small difference between our cliff-elevation field and the game's flips
 * them. That points the residual at FIELD PRECISION, not at a missing rule -
 * which is a different kind of follow-up from the two that were assumed before.
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

describe("Nauvis cliff residual: the wrong cells sit on band boundaries", () => {
  for (const { seed } of CASES) {
    it(`seed ${String(seed)}: mismatched cells are closer to a band edge than matched ones`, () => {
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
      const median = (vals: number[]): number => {
        const s = [...vals].sort((a, b) => a - b);
        return s[Math.floor(0.5 * (s.length - 1))];
      };

      const matched: number[] = [];
      const mismatched: number[] = [];
      for (const p of placed) (actual.has(key(p)) ? matched : mismatched).push(distance(p.x, p.y));

      expect(matched.length).toBeGreaterThan(40);
      expect(mismatched.length).toBeGreaterThan(0);
      // Pinned loosely: the measured gap is 3.4x and 4.3x, so 1.8x leaves room
      // for the port to improve (which would SHRINK the mismatched set and could
      // move its median either way) without going green on a regression that
      // erased the effect entirely.
      expect(median(matched) / median(mismatched)).toBeGreaterThan(1.8);

      // Nauvis's wrong cells are on a KNIFE EDGE: the median sits 0.07 out of a
      // 40-wide band, 0.18% of an interval. That is the number to compare
      // Vulcanus against below - not the raw distance, since the two planets run
      // different intervals (40 vs 120).
      expect(median(mismatched) / 40).toBeLessThan(0.005);
    }, 120000);
  }
});

describe("Vulcanus's residual is NOT the same threshold effect", () => {
  it("its wrong cells sit an order of magnitude further from a band edge", () => {
    // Same measurement as above, run on Vulcanus against the smoothed field the
    // gate actually sees, and normalised by each planet's own interval so the
    // 40-vs-120 difference does not do the talking. Measured 2026-07-28:
    //
    // | | matched (median / interval) | mismatched | separation |
    // | --- | --- | --- | --- |
    // | Nauvis 123456 | 0.60% | 0.18% | 3.4x |
    // | Vulcanus `[0,0]` | 3.7% | 1.5% | 2.4x |
    // | Vulcanus `[1500,1500]` | 5.4% | 3.9% | 1.4x |
    // | Vulcanus `[-1200,800]` | 5.3% | 2.2% | 2.4x |
    //
    // The effect is present on Vulcanus - mismatched cells are consistently
    // closer to a boundary than matched ones - but it is far weaker, and its
    // wrong cells are not knife-edge at all: 1.5-3.9% of an interval against
    // Nauvis's 0.18%. **So Vulcanus's much larger residual is mostly NOT
    // threshold noise, and improving field precision would not close it.**
    // Whatever is left there is structural and still unidentified.
    //
    // This test exists to stop the Nauvis conclusion being generalised to both
    // planets, which is exactly the mistake that made `cliff_smoothing` cost two
    // months ("a no-op in this path" - true of Nauvis only).
    const ctx = withCtxDefaults({ seed0: vFix.seed, startingPositions: [{ x: 0, y: 0 }] });
    const fields = makeVulcanusCliffFields(ctx);
    const raw = (i: number, j: number): number => fields.cliffElevation(i * 4, j * 4 + 0.5);
    const smoothed = (i: number, j: number): number => {
      const kx = smoothingKnots(i);
      const ky = smoothingKnots(j);
      return (
        (1 - kx.t) * (1 - ky.t) * raw(kx.lo, ky.lo) +
        kx.t * (1 - ky.t) * raw(kx.hi, ky.lo) +
        (1 - kx.t) * ky.t * raw(kx.lo, ky.hi) +
        kx.t * ky.t * raw(kx.hi, ky.hi)
      );
    };
    const I = VULCANUS_CLIFF_ELEVATION_INTERVAL;
    const distance = (cx: number, cy: number): number => {
      let best = Infinity;
      const i = (cx - 2) / 4;
      const j = (cy - 2.5) / 4;
      for (const [di, dj] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const e = smoothed(i + di, j + dj);
        if (e < 0) continue;
        const d = (((e - VULCANUS_CLIFF_ELEVATION_0) % I) + I) % I;
        best = Math.min(best, Math.min(d, I - d));
      }
      return best;
    };
    const median = (vals: number[]): number => {
      const s = [...vals].sort((a, b) => a - b);
      return s[Math.floor(0.5 * (s.length - 1))];
    };

    for (const c of vFix.cases) {
      const r = c.region;
      const placed = makeCliffPlacementFromFields(fields, {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: I,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
      }).placedCells(r.x0, r.y0, r.x1, r.y1);
      const actual = new Set(c.cliffs.filter((p) => p.name === "cliff-vulcanus").map(key));

      const matched: number[] = [];
      const mismatched: number[] = [];
      for (const p of placed) (actual.has(key(p)) ? matched : mismatched).push(distance(p.x, p.y));

      expect(mismatched.length).toBeGreaterThan(20);
      // The effect exists...
      expect(median(matched)).toBeGreaterThan(median(mismatched));
      // ...but nowhere near Nauvis's knife edge. Nauvis is under 0.5% of an
      // interval; every Vulcanus region measures above 1.2%.
      expect(median(mismatched) / I).toBeGreaterThan(0.012);
    }
  }, 300000);
});
