import { describe, expect, it } from "vite-plus/test";

import ore from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { CLIFF_CODE_TO_ORIENTATION, cliffCollisionTileBox } from "../src/noise/cliffs/cliffCatalog";
import { cliffCodeForOrientation } from "../src/noise/cliffs/cliffConnections";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeVulcanusOreRejection } from "../src/noise/cliffs/vulcanusOreRejection";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { buildResources } from "../src/noise/preview/renderVulcanusResources";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

/**
 * **Eleven of the 25 missed destructions are the ORE, and the game's own lever
 * says so** (#84).
 *
 * `test/cliffCollisionResidualShape.spec.ts` (#115) split the 25 into groups by
 * distance to lava and wrote off the ore rule for all of them in one clause:
 *
 * > **But ten of the 25 have no lava within twelve tiles**, so no adjustment to a
 * > lava collision box can ever reach them, and neither can the ore rule (all 25
 * > are `ore = false`) nor any entity...
 *
 * **`ore = false` there is our own predicate's output, not the game's
 * behaviour**, and that predicate is documented in `vulcanusOreRejection.ts` as
 * "exactly right where it fires, simply too narrow" - it explains 20 of the 31
 * cells the ore actually suppresses. Using it to rule the ore out is circular,
 * and the fixture that settles it non-circularly was already on disk and already
 * covers the right region: `oracle-vulcanus-cliff-ore-direction` re-runs
 * `[1500,1500]` - where every one of the far ten lives - with the resources
 * switched off through `autoplace_controls`.
 *
 * Switch them off and **six of the far ten appear**. The correct split is:
 *
 * | of the 25 missed destructions | count |
 * | --- | --- |
 * | **ORE**, by the lever (7 calcite + 4 geyser) | **11** |
 * | **unknown** - absent even with every resource off | **11** |
 * | outside the lever's region, so undetermined here | 3 |
 *
 * So the population with an unidentified mechanism is **11, not 25**, and #115's
 * lava-distance grouping is not the causal one - ore cells land in its near, mid
 * AND far groups. What survives of #115 is its careful half: the far ten really
 * are unreachable by any lava box, and the tile resolver really is exonerated.
 * What does not survive is the parenthetical that ruled out the ore.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
const K = (x: number, y: number): string => `${String(x)},${String(y)}`;
const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};
const isLava = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);

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
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const cases = entities.cases as unknown as { region: Region; cliffs: Ent[] }[];
const inRegion =
  (i: number) =>
  (p: { x: number; y: number }): boolean => {
    const r = cases[i].region;
    return p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
  };
const GAME = cases.map((c, i) => {
  const s = new Set<string>();
  for (const e of c.cliffs)
    if (e.name === "cliff-vulcanus" && inRegion(i)({ x: e.x, y: e.y })) s.add(K(e.x, e.y));
  return s;
});

/** `generateCliffs`' queue, with the same halo #114 and #122 use. */
const RAW = cases.map((c) =>
  makeCliffPlacementFromFields(fields, BANDS).placedCells(
    c.region.x0 - 64,
    c.region.y0 - 64,
    c.region.x1 + 64,
    c.region.y1 + 64,
  ),
);

/** The lever fixture's region is the entities fixture's region 1, `[1500,1500]`. */
const LEVER_REGION = 1;

const oreCases = ore.cases as unknown as { label: string; region: Region; cliffs: Ent[] }[];
const arm = (label: string): Set<string> => {
  const c = oreCases.find((q) => q.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  const s = new Set<string>();
  for (const e of c.cliffs)
    if (
      e.name === "cliff-vulcanus" &&
      e.x >= c.region.x0 &&
      e.x < c.region.x1 &&
      e.y >= c.region.y0 &&
      e.y < c.region.y1
    )
      s.add(K(e.x, e.y));
  return s;
};
const ON = arm("entity region, resources ON");
const ALL_OFF = arm("entity region, ALL resources OFF");
const CALCITE_OFF = arm("entity region, calcite OFF");
const GEYSER_OFF = arm("entity region, geyser OFF");

const boxOf = (o: number, x: number, y: number): Box | undefined =>
  cliffCollisionTileBox(cliffCodeForOrientation(o), x, y);
const lavaIn = (box: Box | undefined): boolean => {
  if (box === undefined) return false;
  for (let tx = box.left; tx <= box.right; tx++)
    for (let ty = box.top; ty <= box.bottom; ty++) if (isLava(tx, ty)) return true;
  return false;
};
const lavaDistance = (box: Box): number => {
  for (let d = 0; d <= 12; d++)
    for (let tx = box.left - d; tx <= box.right + d; tx++)
      for (let ty = box.top - d; ty <= box.bottom + d; ty++) {
        const onRing =
          tx <= box.left - d || tx >= box.right + d || ty <= box.top - d || ty >= box.bottom + d;
        if ((d === 0 || onRing) && isLava(tx, ty)) return d;
      }
  return 99;
};

type Cause = "calcite" | "geyser" | "unknown" | "outside-lever-region";

interface Missed {
  region: number;
  key: string;
  /** #115's grouping, by distance from the box to the nearest tile we call lava. */
  group: "near" | "mid" | "far";
  cause: Cause;
}

/** The 25 cells the game destroys and our predicate keeps, each given a cause. */
const MISSED: Missed[] = (() => {
  const out: Missed[] = [];
  for (let i = 0; i < cases.length; i++) {
    for (const p of RAW[i].filter(inRegion(i))) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined || GAME[i].has(K(p.x, p.y))) continue;
      const box = boxOf(o, p.x, p.y);
      if (lavaIn(box) || oreRejects(cliffCodeForOrientation(o), p.x, p.y)) continue;
      const key = K(p.x, p.y);
      const d = box === undefined ? 99 : lavaDistance(box);
      let cause: Cause = "outside-lever-region";
      if (i === LEVER_REGION) {
        if (!ALL_OFF.has(key)) cause = "unknown";
        else if (GEYSER_OFF.has(key)) cause = "geyser";
        else cause = "calcite";
      }
      out.push({ region: i, key, group: d === 99 ? "far" : d <= 2 ? "near" : "mid", cause });
    }
  }
  return out;
})();

const withCause = (c: Cause): Missed[] => MISSED.filter((m) => m.cause === c);

describe("the lever fixture is comparable to the entities fixture at all", () => {
  /**
   * **The prerequisite nobody would notice was missing.** Two independent
   * captures of the same seed and region are being cross-referenced here, and if
   * they disagreed the whole cross-tab would be noise. They agree cell for cell:
   * 861 cliffs, zero in either fixture and not the other.
   */
  it("agrees cell for cell with the entities fixture on the resources-ON arm", () => {
    expect(ON.size).toBe(861);
    expect(GAME[LEVER_REGION].size).toBe(861);
    expect([...GAME[LEVER_REGION]].filter((k) => !ON.has(k))).toEqual([]);
    expect([...ON].filter((k) => !GAME[LEVER_REGION].has(k))).toEqual([]);
  });

  /**
   * The lever's own numbers, re-derived here rather than quoted: 31 cells the
   * resources suppress, **zero** that appear when the ore is added back (#99's
   * one-way property), and the two single-control arms are disjoint and add up
   * to the all-off arm exactly - 27 calcite + 4 geyser = 31.
   */
  it("re-derives the lever's 31 suppressed cells, additive and one-way", () => {
    const suppressed = [...ALL_OFF].filter((k) => !ON.has(k));
    expect(suppressed.length).toBe(31);
    expect([...ON].filter((k) => !ALL_OFF.has(k))).toEqual([]);

    const calcite = [...CALCITE_OFF].filter((k) => !ON.has(k));
    const geyser = [...GEYSER_OFF].filter((k) => !ON.has(k));
    expect(calcite.length).toBe(27);
    expect(geyser.length).toBe(4);
    expect(calcite.filter((k) => geyser.includes(k))).toEqual([]);
    expect(new Set([...calcite, ...geyser])).toEqual(new Set(suppressed));
  });
});

describe("our ore predicate scored at the RAW stage, where applyCliffs tests it", () => {
  /**
   * **Precision 1.000, recall 0.645** - and the recall differs from the 0.710 in
   * `## The ore rule, scored against the lever` because that one is scored on
   * PLACED cells after the crossing stage, which loses 22 where the predicate
   * fires on 20. This file scores the raw queue, which is the set `applyCliffs`
   * actually tests, and is the stage #114 established as the right one to count
   * a rule at. Neither number is wrong; they count different things, and this is
   * the one that lines up with the 31.
   */
  it("fires on 20 of the lever's 31 and on nothing outside it", () => {
    const suppressed = new Set([...ALL_OFF].filter((k) => !ON.has(k)));
    let fires = 0;
    let firesInside = 0;
    for (const p of RAW[LEVER_REGION].filter(inRegion(LEVER_REGION))) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      if (!oreRejects(cliffCodeForOrientation(o), p.x, p.y)) continue;
      fires++;
      if (suppressed.has(K(p.x, p.y))) firesInside++;
    }
    expect(fires).toBe(20);
    expect(firesInside).toBe(20);
    // precision 20/20, recall 20/31
    expect(firesInside / fires).toBe(1);
    expect(firesInside / suppressed.size).toBeCloseTo(0.645, 3);
  }, 300000);

  /**
   * All 31 are in the raw queue, so none of the 11 it misses is a cell we failed
   * to GENERATE - the same superset property #114 established, checked again on
   * the set that matters here.
   */
  it("finds all 31 present in the raw queue", () => {
    const raw = new Set(RAW[LEVER_REGION].filter(inRegion(LEVER_REGION)).map((p) => K(p.x, p.y)));
    const suppressed = [...ALL_OFF].filter((k) => !ON.has(k));
    expect(suppressed.filter((k) => !raw.has(k))).toEqual([]);
  }, 300000);
});

describe("eleven of the 25 missed destructions are the ore", () => {
  it("splits the 25 by the lever rather than by our own predicate", () => {
    expect(MISSED.length).toBe(25);
    expect(withCause("calcite").length).toBe(7);
    expect(withCause("geyser").length).toBe(4);
    expect(withCause("unknown").length).toBe(11);
    expect(withCause("outside-lever-region").length).toBe(3);
    // The ore total is exactly the 11 the predicate misses from the lever's 31.
    expect(withCause("calcite").length + withCause("geyser").length).toBe(11);
  }, 300000);

  /**
   * **Six of #115's far ten are ore**, which is the correction. Its two
   * multi-cell clusters have DIFFERENT causes - the `1542/1546` knot is the
   * geyser and the two singletons are calcite - and only the `1742/1746`
   * vertical run survives as unexplained.
   *
   * That also sharpens #122: of the two far cells whose destruction it proved
   * from the game's own orientations, `1546,1550.5` is now known to be a geyser
   * suppression, so the genuinely-unknown group's destruction rests on
   * `1746,1538.5` alone.
   */
  it("finds 6 of the far ten are ore and only 4 are unexplained", () => {
    const far = MISSED.filter((m) => m.group === "far");
    expect(far.length).toBe(10);
    const byCause = (c: Cause): string[] =>
      far
        .filter((m) => m.cause === c)
        .map((m) => m.key)
        .sort((a, b) => a.localeCompare(b));
    expect(byCause("geyser")).toEqual(["1542,1554.5", "1542,1558.5", "1546,1550.5", "1546,1554.5"]);
    expect(byCause("calcite")).toEqual(["1590,1618.5", "1602,1622.5"]);
    expect(byCause("unknown")).toEqual([
      "1742,1530.5",
      "1746,1530.5",
      "1746,1534.5",
      "1746,1538.5",
    ]);
  }, 300000);

  /**
   * **#115's lava-distance grouping is not the causal partition.** Ore cells
   * appear in all three of its groups, so "near the lava" and "caused by the
   * lava box" are not the same claim, and neither are "far from lava" and
   * "unidentified mechanism". Worth pinning, because the near/far split is what
   * the previous handoff proposed to act on.
   */
  it("shows ore and unknown cells in every one of #115's distance groups", () => {
    const tally = (g: Missed["group"], c: Cause): number =>
      MISSED.filter((m) => m.group === g && m.cause === c).length;
    expect(tally("far", "geyser") + tally("far", "calcite")).toBe(6);
    expect(tally("mid", "calcite")).toBe(4);
    expect(tally("near", "calcite")).toBe(1);
    expect(tally("far", "unknown")).toBe(4);
    expect(tally("mid", "unknown")).toBe(2);
    expect(tally("near", "unknown")).toBe(5);
  }, 300000);

  /**
   * The 11 that remain, listed because they are the input to whatever comes
   * next. Five sit within two tiles of our lava, so the box-shape question #115
   * raised is still live for those; six do not.
   */
  it("pins the 11 with no known cause", () => {
    expect(
      withCause("unknown")
        .map((m) => m.key)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      "1506,1582.5",
      "1506,1586.5",
      "1506,1634.5",
      "1658,1598.5",
      "1662,1630.5",
      "1718,1650.5",
      "1722,1630.5",
      "1742,1530.5",
      "1746,1530.5",
      "1746,1534.5",
      "1746,1538.5",
    ]);
  }, 300000);

  /**
   * The three the lever cannot speak about, so nobody counts them as either.
   * The fixture only re-ran `[1500,1500]`; these are in `[0,0]` and
   * `[-1200,800]`, and settling them would need those regions re-run with the
   * resources off.
   */
  it("pins the 3 the lever's region does not cover", () => {
    expect(
      withCause("outside-lever-region")
        .map((m) => m.key)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["-1050,1022.5", "106,26.5", "90,38.5"]);
  }, 300000);
});
