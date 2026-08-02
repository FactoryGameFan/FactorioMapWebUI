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

  it("matches the game ABOVE the basalt-lakes saturation point of 120", () => {
    const high = rows.filter((r) => r.level >= 120);
    expect(high.length).toBe(9);
    for (const r of high) {
      // Measured 1.00 - 1.04.
      expect(r.ours / r.game).toBeLessThanOrEqual(1.1);
      // And it is the same cells, not merely the same count.
      expect(r.both / r.game).toBeGreaterThan(0.9);
    }
  });

  it("over-places BELOW it, where 120 * vulcanus_basalt_lakes_multisample governs", () => {
    const low = rows.filter((r) => r.level <= 110);
    expect(low.length).toBe(10);
    for (const r of low) {
      // Measured 1.20 - 1.49. The separation from the >= 120 arm is clean:
      // the worst high level is 1.04 and the best low level is 1.20.
      expect(r.ours / r.game).toBeGreaterThan(1.15);
    }
  });

  it("separates the two regimes with no overlap - the edge is real, not a trend", () => {
    const worstHigh = Math.max(...rows.filter((r) => r.level >= 120).map((r) => r.ours / r.game));
    const bestLow = Math.min(...rows.filter((r) => r.level <= 110).map((r) => r.ours / r.game));
    // Measured 1.04 vs 1.20. Asserting the gap rather than the two bounds
    // separately is what makes this a statement about a THRESHOLD: a smooth
    // drift in accuracy with elevation would not produce a gap.
    expect(bestLow).toBeGreaterThan(worstHigh);
    expect(bestLow - worstHigh).toBeGreaterThan(0.1);
  });
});
