import { describe, expect, it } from "vite-plus/test";

import regions from "./fixtures/oracle-vulcanus-cliff-ore-direction-regions.seed123456.json";
import { CLIFF_CODE_TO_ORIENTATION } from "../src/noise/cliffs/cliffCatalog";
import { cliffCodeForOrientation } from "../src/noise/cliffs/cliffConnections";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeVulcanusOreRejection } from "../src/noise/cliffs/vulcanusOreRejection";
import { buildResources } from "../src/noise/preview/renderVulcanusResources";
import { withCtxDefaults } from "../src/noise/eval/ctx";

/**
 * **The ore rule, tested OUT OF SAMPLE for the first time - and precision 1.000
 * survives** (#84).
 *
 * Everything known about the ore -> cliff rule was measured on `[1500,1500]`,
 * because that is the only region `oracle-vulcanus-cliff-ore-direction` re-runs
 * with the resources off. Three merged results rest on that one region: #123's
 * split of the 25 missed destructions into 11 ore and 11 unknown, #125's finding
 * that the `onDestroy` cascade closes 4 of the 10 remainders, and precision
 * 1.000. **A rule characterised on one region and never tested on another is
 * fitted until proven otherwise.**
 *
 * `oracle-vulcanus-cliff-ore-direction-regions` adds the paired ON /
 * ALL-resources-OFF arms for the two regions the entities fixture covers and the
 * lever never did, at real cliff settings.
 *
 * | region | resources present | cliffs ON | cliffs OFF | suppressed |
 * | --- | --- | --- | --- | --- |
 * | `[0,0]` | 945 tungsten-ore | 283 | 283 | **0** |
 * | `[-1200,800]` | 1047 coal | 387 | 387 | **0** |
 *
 * Two things follow, and one of them changes a merged count.
 *
 * **Precision holds.** Our predicate fires on **zero** cells in both regions, so
 * 1992 resource entities across two fresh regions produce no false positive. The
 * rule is not merely right on the region it was built from.
 *
 * **The three "undetermined" missed destructions are NOT ore.** #123 could only
 * say that the lever's region did not cover `106,26.5`, `90,38.5` and
 * `-1050,1022.5`. It does now, and the ore suppresses nothing there, so those
 * three join the unexplained population: **11 ore, 14 unknown**, not 11/11/3.
 *
 * It also re-confirms #110's per-control attribution - 27 calcite, 4 geyser,
 * **0 tungsten and coal** - at a far larger scale than the arm that produced it.
 *
 * **The non-vacuity check is in the fixture rather than argued.** "0 suppressed"
 * is also what a lever that never reached the generator would print. The OFF
 * arms read back **0** resources against 945 and 1047, so the override provably
 * applied.
 *
 * What this does NOT establish: that the rule would hold on a region containing
 * calcite or geysers other than `[1500,1500]`. Neither of these two has any, so
 * the rule's POSITIVE evidence is still one region. This is a precision test,
 * not a recall test.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const resources = buildResources(ctx);
const oreRejects = makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls);
const K = (x: number, y: number): string => `${String(x)},${String(y)}`;
const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};

interface Ent {
  x: number;
  y: number;
  name: string;
  orientation?: string;
}
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const cases = regions.cases as unknown as {
  label: string;
  region: Region;
  cliffs: Ent[];
  resources: Ent[];
}[];

interface Pair {
  name: string;
  region: Region;
  on: Set<string>;
  off: Set<string>;
  resourceCounts: Record<string, number>;
  offResourceCount: number;
  ourFires: number;
}

const PAIRS: Pair[] = (() => {
  const out: Pair[] = [];
  for (let i = 0; i < cases.length; i += 2) {
    const on = cases[i];
    const off = cases[i + 1];
    const r = on.region;
    const inR = (p: { x: number; y: number }): boolean =>
      p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
    const set = (c: (typeof cases)[number]): Set<string> =>
      new Set(
        c.cliffs.filter((e) => e.name === "cliff-vulcanus" && inR(e)).map((e) => K(e.x, e.y)),
      );
    const counts: Record<string, number> = {};
    for (const q of on.resources) counts[q.name] = (counts[q.name] ?? 0) + 1;

    let fires = 0;
    for (const p of makeCliffPlacementFromFields(fields, BANDS)
      .placedCells(r.x0 - 64, r.y0 - 64, r.x1 + 64, r.y1 + 64)
      .filter(inR)) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o !== undefined && oreRejects(cliffCodeForOrientation(o), p.x, p.y)) fires++;
    }
    out.push({
      name: on.label.replace(", resources ON", ""),
      region: r,
      on: set(on),
      off: set(off),
      resourceCounts: counts,
      offResourceCount: off.resources.length,
      ourFires: fires,
    });
  }
  return out;
})();

describe("the ore lever on the two regions it had never covered", () => {
  /**
   * **The non-vacuity arm, first, because "0 suppressed" is also what a lever
   * that never reached the generator prints.** The OFF arms read back zero
   * resources against 945 and 1047 - so the `autoplace_controls` override did
   * apply, and the zero below is a measurement.
   */
  it("proves the override reached the generator", () => {
    expect(PAIRS.map((p) => p.name)).toEqual(["[0,0]", "[-1200,800]"]);
    expect(PAIRS.map((p) => p.resourceCounts)).toEqual([{ "tungsten-ore": 945 }, { coal: 1047 }]);
    expect(PAIRS.map((p) => p.offResourceCount)).toEqual([0, 0]);
  });

  /**
   * **Zero cliffs move in either region**, in either direction - which also
   * re-confirms #99's one-way property and #110's attribution of the 31 to
   * calcite and geyser with nothing from tungsten or coal, now against 1992
   * resource entities rather than the handful that arm carried.
   */
  it("finds the ore suppresses nothing outside [1500,1500]", () => {
    for (const p of PAIRS) {
      expect([...p.off].filter((k) => !p.on.has(k))).toEqual([]);
      expect([...p.on].filter((k) => !p.off.has(k))).toEqual([]);
    }
    expect(PAIRS.map((p) => p.on.size)).toEqual([283, 387]);
    expect(PAIRS.map((p) => p.off.size)).toEqual([283, 387]);
  }, 300000);

  /**
   * **Precision 1.000 survives out of sample.** Our predicate fires on zero
   * cells in both regions, so it invents no rejection where the game has none.
   * This is the arm that would have caught a rule fitted to `[1500,1500]`.
   */
  it("fires on no cell in either region", () => {
    expect(PAIRS.map((p) => p.ourFires)).toEqual([0, 0]);
  }, 300000);

  /**
   * **The three missed destructions #123 had to leave undetermined are not
   * ore.** They sit in these two regions, and the lever now covers them, so the
   * unexplained population is **14**, not 11 with 3 unknown-status.
   */
  it("resolves the three cells #123 could not attribute", () => {
    const undetermined = ["106,26.5", "90,38.5", "-1050,1022.5"];
    for (const k of undetermined) {
      const p = PAIRS.find((q) => {
        const [xs, ys] = k.split(",");
        const x = Number(xs);
        const y = Number(ys);
        return x >= q.region.x0 && x < q.region.x1 && y >= q.region.y0 && y < q.region.y1;
      });
      expect(p).toBeDefined();
      // Absent with the resources ON and absent with them OFF: the game destroys
      // it either way, so no resource is responsible.
      expect(p?.on.has(k)).toBe(false);
      expect(p?.off.has(k)).toBe(false);
    }
  }, 300000);
});
