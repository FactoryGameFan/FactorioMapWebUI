import { describe, expect, it } from "vite-plus/test";

import calcite from "./fixtures/oracle-vulcanus-cliff-corner-fields.seed123456.json";
import cf from "./fixtures/oracle-vulcanus-cliff-corner-fields-entity-regions.seed123456.json";
import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { CLIFF_ORIENTATION_NAMES, cliffOrientationForCode } from "../src/noise/cliffs/cliffCatalog";
import type { CliffFields } from "../src/noise/cliffs/cliffPlacement";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

/**
 * **The Vulcanus cliff FIELDS are exact at the regions the port is scored on -
 * including `[0,0]`, where it is worst** (issue #18).
 *
 * PR #57 established this by substituting the game's own `vulcanus_elevation`
 * and `cliffiness_basic` into our placement and finding it moved not one cell.
 * That result had two limits, both invisible until the orientation oracle landed
 * (2026-07-30):
 *
 * 1. **It scored PLACEMENT** - one bit per cell. A cell can land in the right
 *    place off the wrong crossings, and 175 of them do.
 * 2. **Its regions were the wrong ones.** `oracle-vulcanus-cliff-corner-fields`
 *    covers `[1500,1500]`, `[1100,2600]` and `[-1700,1900]`, chosen for issue
 *    #24 and all calcite-dominated. Only the first is a region the cliff port is
 *    scored on, and it is the region the port already handles best - 8.1%
 *    orientation error. `[0,0]`, at **29.8%**, had never had its fields checked
 *    at all.
 *
 * This closes both. `oracle-vulcanus-cliff-corner-fields-entity-regions` samples
 * both fields at every corner of all three cliff-entity regions, and the
 * substitution is scored on ORIENTATION - four bits per cell, against the game's
 * own `cliff_orientation`.
 *
 * **The answer is the same, and now it is load-bearing: not the fields.**
 * Measured 2026-07-30, the game's values reproduce ours to the unit in every
 * region - same cells placed, same cells matched, same cells wrong:
 *
 * | region | placed | matched | wrong orientation | with a +3 bias |
 * | --- | --- | --- | --- | --- |
 * | `[0,0]` | 335 | 228 | 68 = 29.8% | 78 = 36.4% (347 placed) |
 * | `[1500,1500]` | 1065 | 830 | 67 = 8.1% | 122 = 15.4% (1070 placed) |
 * | `[-1200,800]` | 375 | 342 | 40 = 11.7% | 60 = 18.9% (358 placed) |
 *
 * So the whole residual lives in the RULE as ported - `crossingsForChunk`'s
 * sampling geometry, the `cliff_smoothing` knot model, or `crossesCliff` - and
 * no longer in any input to it.
 */
describe("Vulcanus cliff corner fields at the entity regions", () => {
  const elevation = new Map<string, number>();
  const cliffiness = new Map<string, number>();
  cf.corners.forEach((k, i) => {
    elevation.set(k, cf.elevation[i]);
    cliffiness.set(k, cf.cliffiness[i]);
  });
  const cornerIndex = (x: number, y: number): string =>
    key(x / cf.grid, Math.round((y - cf.cornerOffsetY) / cf.grid));

  const ctx = withCtxDefaults({ seed0: cf.seed, startingPositions: [{ x: 0, y: 0 }] });
  const ours = makeVulcanusCliffFields(ctx);

  /**
   * Out-of-lattice corners fall back to our own field. The chunk-structured
   * placement path rounds the query box out to whole 32-tile chunks, so it reads
   * a fringe outside the captured region; a sentinel there would inject a fake
   * result rather than measure one.
   */
  const build = (source: "ours" | "game" | "game+3"): CliffFields => {
    if (source === "ours") return ours;
    const bias = source === "game+3" ? 3 : 0;
    return {
      cliffElevation: (x: number, y: number): number => {
        const v = elevation.get(cornerIndex(x, y));
        return v === undefined ? ours.cliffElevation(x, y) : v + bias;
      },
      cliffiness: (x: number, y: number): number =>
        cliffiness.get(cornerIndex(x, y)) ?? ours.cliffiness(x, y),
    };
  };

  const score = (
    source: "ours" | "game" | "game+3",
    regionIndex: number,
  ): { placed: string[]; matched: number; wrong: number } => {
    const ec = entities.cases[regionIndex];
    const r = ec.region;
    const game = new Map<string, string>();
    for (const p of ec.cliffs.filter((q) => q.name === "cliff-vulcanus"))
      game.set(key(p.x, p.y), p.orientation);
    const cells = makeCliffPlacementFromFields(build(source), {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing: VULCANUS_CLIFF_SMOOTHING,
    }).placedCells(r.x0, r.y0, r.x1, r.y1);
    let matched = 0;
    let wrong = 0;
    for (const p of cells) {
      const want = game.get(key(p.x, p.y));
      if (want === undefined) continue;
      matched++;
      if (CLIFF_ORIENTATION_NAMES[cliffOrientationForCode(p.code) as number] !== want) wrong++;
    }
    return { placed: cells.map((p) => key(p.x, p.y)).sort(), matched, wrong };
  };

  /**
   * The capture's own correctness check, and it has to come first: an error in
   * this fixture's corner indexing would look exactly like a field error at
   * `[0,0]`. `[1500,1500]` is the one region both corner-field fixtures cover,
   * deliberately, so the overlap is directly comparable.
   */
  it("agrees corner-for-corner with the calcite capture on the region they share", () => {
    const other = new Map<string, [number, number]>();
    calcite.corners.forEach((k, i) => other.set(k, [calcite.elevation[i], calcite.cliffiness[i]]));
    let shared = 0;
    for (const [k, v] of elevation) {
      const w = other.get(k);
      if (w === undefined) continue;
      shared++;
      expect(v).toBe(w[0]);
      expect(cliffiness.get(k)).toBe(w[1]);
    }
    // Non-vacuity: 65x65 corners of `[1500,1500]`. Without this the loop would
    // pass by comparing nothing if the two fixtures ever stopped overlapping.
    expect(shared).toBe(4225);
    expect(cf.corners.length).toBe(12675);
  });

  for (const [index, ec] of entities.cases.entries()) {
    const label = `[${String(ec.region.x0)},${String(ec.region.y0)}]`;

    it(`substituting the game's own fields changes nothing at ${label}`, () => {
      const a = score("ours", index);
      const b = score("game", index);
      expect(b.placed).toEqual(a.placed);
      expect(b.matched).toBe(a.matched);
      // The orientation count is the point: it is four bits per cell where the
      // placement comparison is one, and it is unchanged too.
      expect(b.wrong).toBe(a.wrong);
      expect(a.matched).toBeGreaterThan(200);
    }, 120000);

    it(`and the substitution is live at ${label} - a +3 elevation bias moves it`, () => {
      // Guards the assertion above against passing vacuously, e.g. if every
      // lookup silently fell through to our own field. Both the placement and
      // the orientation score must move, or the metric is not measuring what
      // the previous test claims it measures.
      const b = score("game", index);
      const c = score("game+3", index);
      expect(c.placed).not.toEqual(b.placed);
      expect(c.wrong).toBeGreaterThan(b.wrong);
    }, 120000);
  }
});
