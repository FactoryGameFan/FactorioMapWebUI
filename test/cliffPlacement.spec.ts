import { describe, expect, it } from "vite-plus/test";
import { crossesCliff, makeCliffPlacement } from "../src/noise/cliffs/cliffPlacement";
import { NAUVIS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderCliffs";
import { makeTileResolver } from "../src/noise/tiles/resolve";
import entFixture from "./fixtures/oracle-cliff-entities.seed123456.json";

const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

describe("crossesCliff", () => {
  const I = 40,
    E0 = 10;
  it("no crossing within a band", () => expect(crossesCliff(12, 20, 10, E0, I)).toBe(0)); // both band 0
  it("negative elevation never crosses", () => expect(crossesCliff(-1, 60, 10, E0, I)).toBe(0));
  it("below elevation_0 never crosses", () => expect(crossesCliff(5, 8, 10, E0, I)).toBe(0)); // max<E0
  it("crossing gated OFF when cliffiness avg <= 0.5", () =>
    expect(crossesCliff(45, 55, 0, E0, I)).toBe(0));
  it("signed crossing up", () => {
    // max=55 -> boundary = 10 + 40*floor((55-10)/40)=10+40=50; a=45<50, b=55>50, avg>0.5 -> +1
    expect(crossesCliff(45, 55, 10, E0, I)).toBe(1);
  });
  it("signed crossing down", () => expect(crossesCliff(55, 45, 10, E0, I)).toBe(-1));
});

describe("makeCliffPlacement lattice", () => {
  it("all placed cliffs sit on x≡2, y≡2.5 (mod 4)", () => {
    const pl = makeCliffPlacement({
      seed0: 123456,
      controls: { frequency: 1, continuity: 1 },
      settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
    });
    const cells = pl.placedCells(0, 0, 512, 512);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(((c.x % 4) + 4) % 4).toBe(2);
      expect(((c.y % 4) + 4) % 4).toBeCloseTo(2.5, 9);
    }
  });
  it("continuity 0 places no cliffs", () => {
    const pl = makeCliffPlacement({
      seed0: 123456,
      controls: { frequency: 1, continuity: 0 },
      settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
    });
    expect(pl.placedCells(0, 0, 512, 512).length).toBe(0);
  });
});

// End-to-end validation of the whole placement rule (both cliff fields +
// crossesCliff + the orientation-code table) against the game's REAL cliff
// entities, dumped over a 16x16-chunk region at the default preset via
// find_entities_filtered{type="cliff"} (oracle-cliff-entities.seed123456.json).
// The residual is the DEFERRED fixImpossibleCells + water rejection
// (docs/noise/cliffs-NOTES.md). The bounds are drift guards, NOT thresholds to
// tune down - a large drop means the field port or the crossing rule regressed.
//
// **Measured 2026-07-28, and better than the "~89-90%" this comment used to
// claim: 94.33% (seed 123456) and 94.23% (777771).** The old figure came from the
// original spike and was never re-measured after the port improved.
//
// **PRECISION is asserted as well as recall, added after the Vulcanus port was
// measured (issue #18).** Recall alone cannot see over-placement - a model that
// placed a cliff on every lattice cell would score 100% on it - and that is
// exactly how Vulcanus fails (recall 57-69% but 1.1-1.6x too many cliffs). Nauvis
// does not have that problem at all: it places EXACTLY the game's count at both
// seeds (282 vs 282, 52 vs 52, ratio 1.000), which is what cleared the shared
// placement machinery and localised #18 to Vulcanus's own fields and band
// constants. Neither planet's dump has duplicate positions, so set and array
// counting agree.
describe("cliff placement vs find_entities (~94% drift guard)", () => {
  for (const c of entFixture.cases) {
    it(`reproduces >=85% of real cliffs, without over-placing, seed=${c.seed}`, () => {
      const r = entFixture.region;
      const pl = makeCliffPlacement({
        seed0: c.seed,
        controls: { frequency: 1, continuity: 1 },
        settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
      });
      const placed = pl.placedCells(r.x0, r.y0, r.x1, r.y1);

      // Sanity on the oracle dump itself: every real cliff sits on the 4-tile
      // cliff lattice (x mod 4 == 2, y mod 4 == 2.5).
      for (const p of c.cliffs) {
        expect(((p.x % 4) + 4) % 4).toBe(2);
        expect(((p.y % 4) + 4) % 4).toBeCloseTo(2.5, 9);
      }

      const predicted = new Set(placed.map(key));
      const actual = c.cliffs.map(key);
      const matched = actual.filter((k) => predicted.has(k)).length;
      const frac = matched / actual.length;
      const precision = matched / predicted.size;

      // **EXACT since 2026-07-30.** 282/282 at seed 123456 and 52/52 at 777771 -
      // every real cliff placed, nothing invented. The long-standing ~6%
      // residual was the port sampling the fields at `j*4 + 0.5`: it added the
      // prototype's `grid_offset {0, 0.5}`, which is a CENTRE offset, to the
      // SAMPLE position (see `CLIFF_CELL_CENTER_X`).
      //
      // Pinned at equality on purpose. Placement is deterministic given the seed
      // - there is no roll - so an inequality here would let a real regression
      // hide inside the slack, which is how the 0.943 sat unexplained for two
      // months while five different causes were proposed for it.
      expect(frac).toBe(1);
      expect(precision).toBe(1);
      expect(predicted.size).toBe(actual.length);
    });

    /**
     * The same run with the game's tile-collision rejection turned on, which the
     * Nauvis renderer does NOT ship (it skips water-coloured pixels at paint
     * time instead - cheaper, and visually identical while this holds).
     *
     * The claim being guarded is "no Nauvis cliff's collision box touches water",
     * which is why skipping the rejection there is safe. That was measured once,
     * in passing, while ruling `wouldCollide` moot for Nauvis; a remembered
     * measurement is exactly the kind of thing this project has been burned by,
     * so it is now a standing check. If a future change to the elevation tree or
     * to water's autoplace makes it stop holding, this fails and the Nauvis
     * renderer needs the rejection wiring in for real.
     */
    it(`stays exact with the tile-collision rejection enabled, seed=${c.seed}`, () => {
      const r = entFixture.region;
      const resolveTile = makeTileResolver({ seed0: c.seed });
      let calls = 0;
      let waterHits = 0;
      const isWater = (x: number, y: number): boolean => {
        calls++;
        const water = NAUVIS_CLIFF_BLOCKING_TILES.has(resolveTile(x, y).name);
        if (water) waterHits++;
        return water;
      };
      const settings = {
        seed0: c.seed,
        controls: { frequency: 1, continuity: 1 },
        settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
      };
      const plain = makeCliffPlacement(settings).placedCells(r.x0, r.y0, r.x1, r.y1);
      const gated = makeCliffPlacement(settings, { tileCollides: isWater }).placedCells(
        r.x0,
        r.y0,
        r.x1,
        r.y1,
      );

      expect(gated.map(key)).toEqual(plain.map(key));

      // **Non-vacuity, three ways.** "The gated and ungated lists are equal"
      // would also pass if `tileCollides` were silently ignored, if the
      // predicate were never called, or if this seed's region simply had no
      // water. So: the predicate ran (at least one box tile per placed cell),
      // it found no water under any cliff, and the SAME resolver does find
      // water elsewhere in the region.
      expect(calls).toBeGreaterThanOrEqual(plain.length);
      expect(waterHits).toBe(0);
      let waterInRegion = 0;
      for (let x = r.x0; x < r.x1; x += 8)
        for (let y = r.y0; y < r.y1; y += 8)
          if (NAUVIS_CLIFF_BLOCKING_TILES.has(resolveTile(x, y).name)) waterInRegion++;
      expect(waterInRegion).toBeGreaterThan(0);
    }, 120000);
  }
});
