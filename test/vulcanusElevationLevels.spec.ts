import { describe, expect, it } from "vite-plus/test";

import fx from "./fixtures/oracle-vulcanus-elevation-levels.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  makeCliffinessBasic,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

const ctx = withCtxDefaults({ seed0: fx.seed, startingPositions: [{ x: 0, y: 0 }] });
const base = makeVulcanusCliffFields(ctx);
const fields = {
  cliffElevation: base.cliffElevation,
  // richness 4 in the capture, so cliffiness_basic saturates and its gate is open.
  cliffiness: makeCliffinessBasic(fx.seed, 4),
};

/** Per level: how many cells the game placed, how many we place, and the overlap. */
const atLevel = (index: number): { level: number; game: number; ours: number; both: number } => {
  const c = fx.cases[index];
  const r = fx.region;
  const game = new Set<string>();
  for (const p of c.cliffs.filter((q) => q.name === "cliff-vulcanus"))
    game.add(key(Math.round((p.x - 2) / 4), Math.round((p.y - 2.5) / 4)));
  const cells = makeCliffPlacementFromFields(fields, {
    elevation0: c.elevation0,
    interval: c.effective?.cliff_elevation_interval ?? 1000000,
    smoothing: 0,
  }).placedCells(r.x0, r.y0, r.x1, r.y1);
  let both = 0;
  const ours = new Set<string>();
  for (const p of cells) {
    const k = key(Math.round((p.x - 2) / 4), Math.round((p.y - 2.5) / 4));
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
    // The regime split has NOT vanished entirely, and that is worth recording
    // rather than rounding away: the worst low-level ratio is 1.085 against the
    // worst high-level 1.018, a gap of 0.067 where it used to be 1.20 vs 1.04
    // (0.16). So it shrank ~2.4x but a small residual of the SAME SHAPE - excess
    // placement concentrated in the basalt-lakes elevation range - survives. It
    // is the remaining lead for the Vulcanus cliff follow-up.
    const gap = Math.max(...low) - Math.max(...high);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(0.1);
  });
});
