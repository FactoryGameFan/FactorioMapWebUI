import { describe, expect, it } from "vite-plus/test";

import fx from "./fixtures/oracle-vulcanus-elevation-levels.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  makeCliffinessBasic,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

const ctx = withCtxDefaults({ seed0: fx.seed, startingPositions: [{ x: 0, y: 0 }] });
const base = makeVulcanusCliffFields(ctx);
const fields = {
  cliffElevation: base.cliffElevation,
  // richness 4 in the capture, so cliffiness_basic saturates and its gate is open.
  cliffiness: makeCliffinessBasic(fx.seed, 4),
};

/**
 * The lava rejection, the same predicate `renderVulcanusCliffs` passes. Off by
 * default here: this file's job is to invert the elevation FIELD, and the
 * rejection brings the tile resolver - a different subsystem - into the answer.
 * The last test turns it on deliberately, to attribute a residual to it.
 */
const tileAt = makeVulcanusTileResolver({ seed0: fx.seed, startingPositions: [{ x: 0, y: 0 }] });
const lavaCollides = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);

/** Per level: how many cells the game placed, how many we place, and the overlap. */
const atLevel = (
  index: number,
  reject = false,
): { level: number; game: number; ours: number; both: number } => {
  const c = fx.cases[index];
  const r = fx.region;
  const game = new Set<string>();
  for (const p of c.cliffs.filter((q) => q.name === "cliff-vulcanus"))
    game.add(key(Math.round((p.x - 2) / 4), Math.round((p.y - 2.5) / 4)));
  const cells = makeCliffPlacementFromFields(fields, {
    elevation0: c.elevation0,
    interval: c.effective?.cliff_elevation_interval ?? 1000000,
    smoothing: 0,
    tileCollides: reject ? lavaCollides : undefined,
  }).placedCells(r.x0, r.y0, r.x1, r.y1);
  let both = 0;
  const ours = new Set<string>();
  for (const p of cells) {
    const k = key(Math.round((p.x - 2) / 4), Math.round((p.y - 2.5) / 4));
    if (ours.has(k)) continue;
    ours.add(k);
    if (game.has(k)) both++;
  }
  return { level: c.elevation0, game: game.size, ours: ours.size, both };
};

/**
 * **The elevation LEVEL SET, which localises #18 to a single term of
 * `vulcanus_elev`.**
 *
 * With the rule collapsed (`cliff_smoothing = 0`, one contour via
 * `cliff_elevation_interval = 1e6`, the cliffiness gate held open by
 * `richness = 4`) a cell carries a cliff exactly when its corner elevations
 * straddle `cliff_elevation_0`. Sweeping that threshold therefore measures the
 * elevation field **the generator itself reads** - something no expression
 * sample can do, because `calculate_tile_properties` answers for a different
 * channel and the open question was precisely whether the two agree.
 *
 * The answer has a sharp edge at **120**:
 *
 * | `cliff_elevation_0` | game | ours | ours/game |
 * | --- | --- | --- | --- |
 * | 20 - 110 | 658 -> 142 | 979 -> 200 | **1.20 - 1.49** |
 * | 120 - 200 | 122 -> 97 | 126 -> 97 | **1.00 - 1.04** |
 *
 * Above 120 the port reproduces the game essentially exactly; below it we
 * over-place by 20-50%. That edge is not arbitrary. `vulcanus_elev` is
 *
 * ```
 * vulcanus_elevation_offset
 *   + lerp(lerp(120 * vulcanus_basalt_lakes_multisample,
 *               20 + vulcanus_mountains_func * vulcanus_mountains_elevation_multiplier,
 *               vulcanus_mountains_biome),
 *          vulcanus_ashlands_func,
 *          vulcanus_ashlands_biome)
 * ```
 *
 * and `vulcanus_basalt_lakes` is a `min(1, ...)`, so the basalt-lakes branch
 * **saturates at exactly 120**. Elevations above 120 come from the mountains and
 * ashlands branches, which contain no `multisample`; elevations below it are
 * governed by `vulcanus_basalt_lakes_multisample`, the only `multisample` in the
 * chain and the only term with no counterpart on Nauvis - which the port
 * reproduces 334/334.
 *
 * So the residual is in that one term, and the mechanism to suspect is the one
 * its own documentation describes: `multisample` evaluates "in a separate noise
 * program with a larger grid" whose "sub-grids are copied to the main program".
 * The cliff generator's program walks the 4-tile corner lattice;
 * `calculate_tile_properties` - the channel
 * `docs/noise/vulcanus-multisample-NOTES.md` measured the primitive through, and
 * the channel every elevation fixture was captured through - does not. A `min()`
 * of four samples is an erosion operator, so a coarser effective grid in the
 * generator would smooth the field exactly the way this over-placement implies.
 */
describe("Vulcanus elevation, inverted through a cliff_elevation_0 sweep", () => {
  const rows = fx.cases.map((_, i) => atLevel(i));

  it("swept 19 levels and every override applied", () => {
    expect(rows.map((r) => r.level)).toEqual(fx.cases.map((c) => c.elevation0));
    for (const c of fx.cases) {
      expect(c.effective?.cliff_elevation_0).toBe(c.elevation0);
      expect(c.effective?.cliff_smoothing).toBe(0);
      expect(c.effective?.richness).toBe(4);
    }
    // Non-vacuity: every level placed a substantial number of cliffs, so no row
    // below is comparing empty sets.
    for (const r of rows) expect(r.game).toBeGreaterThan(90);
  });

  it("reproduces the game's whole cliff set at EVERY level - recall 1.000", () => {
    // **The threshold this file was written to document is GONE, and that is the
    // point.** Before the grid fix the ratio was 1.20-1.49 below an elevation of
    // 120 and 1.00-1.04 above it - a clean edge exactly where
    // `120 * vulcanus_basalt_lakes_multisample` saturates, which is what
    // identified `multisample` as the cause (test/multisampleGrid.spec.ts).
    // With its offsets scaled to the consuming program's grid, every level
    // matches.
    for (const r of rows) {
      expect(r.both).toBe(r.game);
      // Non-vacuity: every level compared a substantial set.
      expect(r.game).toBeGreaterThan(90);
    }
  });

  it("has no regime split left - the edge at 120 is gone", () => {
    const high = rows.filter((r) => r.level >= 120).map((r) => r.ours / r.game);
    const low = rows.filter((r) => r.level <= 110).map((r) => r.ours / r.game);
    expect(high.length).toBe(9);
    expect(low.length).toBe(10);
    // Measured: every ratio now lies in 1.000 - 1.085, against 1.20 - 1.49
    // below the edge before. Asserting a single band across BOTH regimes is the
    // inversion of the old test, which asserted a gap between them.
    for (const v of [...high, ...low]) expect(v).toBeLessThanOrEqual(1.09);
    // A small split does survive here - worst low ratio 1.085 against worst
    // high 1.018, a gap of 0.067 where it used to be 0.16 - and #84 item 2
    // recorded it as a suspected second-order error in the same `multisample`
    // term. **It is not. See the next test**, which attributes it.
    const gap = Math.max(...low) - Math.max(...high);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(0.1);
  });

  /**
   * **The surviving split is a MEASUREMENT artefact, not a second-order error
   * in `multisample`** (measured 2026-08-01, closing #84 item 2).
   *
   * Everything above compares our placement, which does not run the lava
   * rejection, against the game's, which always does. `tryToAddCliff` drops any
   * cliff whose collision box touches a lava tile - and on Vulcanus the lava is
   * the basalt lakes, i.e. exactly the low-elevation range where the excess sat.
   * So the arm reading "we over-place below 120" was really reading "we do not
   * delete what the game deletes, and there is more to delete down there."
   *
   * Running both sides with the rejection collapses it:
   *
   * | `cliff_elevation_0` | ours/game, no rejection | with rejection |
   * | --- | --- | --- |
   * | 20 | 1.085 | 0.988 |
   * | 40 | 1.048 | 1.022 |
   * | 60 | 1.044 | **1.027** |
   * | 90 - 130 | 1.008 - 1.018 | 0.991 - 1.000 |
   * | 140 - 200 | 1.000 - 1.009 | 1.000 - 1.009 |
   *
   * Worst-low 1.027 against worst-high 1.009: the gap goes 0.067 -> 0.018, and
   * the low regime now straddles 1.0 rather than sitting above it.
   *
   * **What remains at low levels is a boundary error in the TILES, not the
   * elevation.** The rejection also costs recall, and it costs it in the same
   * regime: 0.951 at level 20 rising to 1.000 at 140 and above. Every one of
   * those losses is a real cliff whose box hits our lava at Chebyshev depth 1 -
   * our own perimeter - never deeper: 32/32 at level 20, 52/52 across the sweep,
   * 13/13 at default settings. A sub-tile disagreement about where lava stops.
   *
   * **Stated carefully, because depth only discriminates in one of the two
   * places it was checked.** At default settings it does: region `[1500,1500]`'s
   * 170 CORRECT rejections span depth 1 to 9 with 45 bottomed out deep in lava,
   * against wrong rejections that are 100% perimeter. At level 20 it does not -
   * there the correct rejections are 32/32 perimeter as well, because the
   * contour has walked down onto the lake edges and every candidate is near a
   * boundary. So the honest claim is that the low-level errors are
   * boundary-SITED in both directions, and that at level 20 we get about half of
   * them right; not that depth alone proves the perimeter is one tile fat.
   */
  it("attributes the split to the lava rejection, not to the elevation field", () => {
    const withRejection = fx.cases.map((_, i) => atLevel(i, true));
    // Non-vacuity: the rejection must actually remove cells, or "the split went
    // away" and "the predicate never fired" are the same observation.
    const removed = rows.reduce((n, r, i) => n + (r.ours - withRejection[i].ours), 0);
    expect(removed).toBeGreaterThan(100);

    const ratios = (rs: typeof rows, pick: (level: number) => boolean): number[] =>
      rs.filter((r) => pick(r.level)).map((r) => r.ours / r.game);
    const low = Math.max(...ratios(withRejection, (l) => l <= 110));
    const high = Math.max(...ratios(withRejection, (l) => l >= 120));
    // Measured 1.0266 and 1.0085. Both bounds are upper, so the port may improve
    // without editing them.
    expect(low).toBeLessThanOrEqual(1.03);
    expect(high).toBeLessThanOrEqual(1.01);
    // The gap is what #84 item 2 was about: 0.067 without the rejection, 0.018
    // with it. Guarded as an upper bound only - it may shrink to zero or invert.
    expect(low - high).toBeLessThan(0.03);

    // And the low regime no longer sits entirely ABOVE the game, which is the
    // part that read as over-placement: level 20 goes 1.085 -> 0.988.
    expect(withRejection[0].ours / withRejection[0].game).toBeLessThan(1);
  }, 120000);
});
