import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import {
  VULCANUS_CLIFF_BASE_COLLISION_BOX,
  makeVulcanusOreRejection,
} from "../src/noise/cliffs/vulcanusOreRejection";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { buildResources } from "../src/noise/preview/renderVulcanusResources";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

interface Ent {
  x: number;
  y: number;
  name: string;
}
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface Case {
  region: Region;
  cliffs: Ent[];
}

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const resources = buildResources(ctx);
const tileCollides = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);
const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};
const SHIPPED = {
  ...BANDS,
  tileCollides,
  cellRejects: makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls),
};

const cases = entities.cases as unknown as Case[];
const allCliffs = (c: Case): Ent[] => c.cliffs.filter((e) => e.name === "cliff-vulcanus");
const inBox = (c: Case): Ent[] =>
  allCliffs(c).filter(
    (p) => p.x >= c.region.x0 && p.x < c.region.x1 && p.y >= c.region.y0 && p.y < c.region.y1,
  );
const placed = (
  r: Region,
  bands: Parameters<typeof makeCliffPlacementFromFields>[1],
  pad = 0,
): Set<string> =>
  new Set(
    makeCliffPlacementFromFields(fields, bands)
      .placedCells(r.x0 - pad, r.y0 - pad, r.x1 + pad, r.y1 + pad)
      .map((p) => key(p.x, p.y)),
  );

/**
 * **The recall gap was a comparison artifact, and it is worth reading how it
 * hid.**
 *
 * `find_entities_filtered` returns every entity whose BOUNDING BOX touches the
 * query area; `placedCells` emits every cell whose CENTRE lies inside it. Those
 * are different inclusion rules, so the game's list carries cliffs centred just
 * outside the box that the port was never asked about - and scoring one against
 * the other counts each of them as a miss.
 *
 * It is worth 38 cells, which is the entire apparent recall gap:
 *
 * | region | game rows | centred inside | centred OUTSIDE |
 * | --- | --- | --- | --- |
 * | `[0,0]` | 283 | 283 | **0** |
 * | `[1500,1500]` | 885 | 861 | **24** |
 * | `[-1200,800]` | 401 | 387 | **14** |
 *
 * And the port places **38 of 38** of them once the query box is widened enough
 * to include their centres - so every one is an agreement being scored as a
 * failure.
 *
 * This is the same failure as #86, where a 187-cell "excess" turned out to be
 * 185 cells of a rule only one side was applying. Before believing a gap,
 * check both sides are being asked the same question.
 */
describe("the apparent recall gap is a query-window artifact", () => {
  it("finds 38 game cliffs centred outside the box they were captured for", () => {
    const outside = cases.map((c) => allCliffs(c).length - inBox(c).length);
    expect(outside).toEqual([0, 24, 14]);
    expect(outside.reduce((a, b) => a + b, 0)).toBe(38);
  });

  /**
   * **The decisive arm.** Widening the query so those centres ARE asked about
   * places every one of them. Without this the finding would only be "we never
   * looked there", which is consistent with the port being wrong as well as with
   * it being right.
   */
  it("places 38 of 38 once the query box includes their centres", () => {
    let found = 0;
    let total = 0;
    for (const c of cases) {
      const inside = new Set(inBox(c).map((p) => key(p.x, p.y)));
      const outside = allCliffs(c).filter((p) => !inside.has(key(p.x, p.y)));
      const wide = placed(c.region, SHIPPED, 8);
      total += outside.length;
      found += outside.filter((p) => wide.has(key(p.x, p.y))).length;
    }
    expect(total).toBe(38);
    expect(found).toBe(38);
  }, 120000);
});

/**
 * **The corrected budget.** Scored with both sides on the same inclusion rule:
 * the game set restricted to cliffs centred in the box, against the pipeline the
 * renderer actually runs (lava rejection + ore rejection).
 *
 * | region | game | port | matched | surplus | missing |
 * | --- | --- | --- | --- | --- | --- |
 * | `[0,0]` | 283 | 283 | 281 | 2 | 2 |
 * | `[1500,1500]` | 861 | 880 | 858 | 22 | 3 |
 * | `[-1200,800]` | 387 | 387 | 386 | 1 | 1 |
 * | **total** | **1531** | **1550** | **1525** | **25** | **6** |
 *
 * **Recall 0.9961, precision 0.9839.** The long-standing 0.972 recall figure in
 * `vulcanus-cliffs-NOTES.md` was this artifact: it divided the same 1525 matches
 * by 1569 rather than 1531.
 */
describe("the remaining error budget, both sides scored alike", () => {
  interface Budget {
    at: string;
    game: number;
    port: number;
    matched: number;
    surplus: number;
    missing: number;
    lavaKilled: number;
    oreKilled: number;
  }

  const budget = (c: Case): Budget => {
    const game = new Set(inBox(c).map((p) => key(p.x, p.y)));
    const raw = placed(c.region, BANDS);
    const lava = placed(c.region, { ...BANDS, tileCollides });
    const full = placed(c.region, SHIPPED);
    const missing = [...game].filter((k) => !full.has(k));
    const matched = [...full].filter((k) => game.has(k)).length;
    return {
      at: key(c.region.x0, c.region.y0),
      game: game.size,
      port: full.size,
      matched,
      surplus: full.size - matched,
      missing: missing.length,
      lavaKilled: missing.filter((k) => raw.has(k) && !lava.has(k)).length,
      oreKilled: missing.filter((k) => lava.has(k) && !full.has(k)).length,
    };
  };

  it("pins the corrected composition", () => {
    const budgets = cases.map(budget);
    expect(budgets.map((b) => [b.at, b.game, b.port, b.surplus, b.missing])).toEqual([
      ["0,0", 283, 283, 2, 2],
      ["1500,1500", 861, 880, 22, 3],
      ["-1200,800", 387, 387, 1, 1],
    ]);

    const sum = (f: (b: Budget) => number): number => budgets.reduce((a, b) => a + f(b), 0);
    expect(sum((b) => b.matched)).toBe(1525);
    expect(sum((b) => b.game)).toBe(1531);
    expect(sum((b) => b.port)).toBe(1550);
    expect(sum((b) => b.surplus)).toBe(25);
    expect(sum((b) => b.missing)).toBe(6);

    // Every missing cell is one OUR OWN lava rejection removed. There is no
    // cell left that the port simply fails to generate.
    expect(sum((b) => b.lavaKilled)).toBe(6);
    expect(sum((b) => b.oreKilled)).toBe(0);

    expect(sum((b) => b.matched) / sum((b) => b.game)).toBeCloseTo(0.9961, 4);
    expect(sum((b) => b.matched) / sum((b) => b.port)).toBeCloseTo(0.9839, 4);
  }, 120000);

  /**
   * **So precision is the remaining defect, not recall** - 25 surplus cells
   * against 6 missing, and the 6 are all attributable to one rule we already
   * implement being slightly too aggressive rather than to anything unported.
   */
  it("leaves precision as the dominant defect", () => {
    const budgets = cases.map(budget);
    const surplus = budgets.reduce((a, b) => a + b.surplus, 0);
    const missing = budgets.reduce((a, b) => a + b.missing, 0);
    expect(surplus).toBeGreaterThan(missing * 4);
  }, 120000);
});

/**
 * **Item 3 of #84 - the entity half of `Surface::wouldCollide` - stays OPEN, and
 * the crater arm is worth zero.**
 *
 * An earlier draft of this file closed item 3 by size, reasoning that a
 * rejection can only remove cells and so could not help a 44-cell recall gap.
 * That reasoning died with the gap: recall is 0.9961 and the dominant defect is
 * now the 25 surplus cells, which is exactly what a rejection removes. The
 * entity half is therefore the leading candidate rather than a closed one.
 *
 * The crater arm can still be settled exactly, and it is worth nothing.
 */
describe("the entity collision half: craters are worth zero, rocks are the lead", () => {
  it("finds no crater touching any cell the port over-places", () => {
    const [l, t, r, b] = VULCANUS_CLIFF_BASE_COLLISION_BOX;
    let craters = 0;
    let touching = 0;

    for (const c of cases) {
      const game = new Set(inBox(c).map((p) => key(p.x, p.y)));
      const cr = c.cliffs.filter((e) => e.name === "crater-cliff");
      craters += cr.length;
      for (const k of [...placed(c.region, SHIPPED)].filter((s) => !game.has(s))) {
        const [xs, ys] = k.split(",");
        const cx = Number(xs);
        const cy = Number(ys);
        // `crater-cliff` carries the same box as `cliff-vulcanus` in the fixture
        // protos, so two of them overlap within the summed half-extents.
        if (cr.some((q) => Math.abs(q.x - cx) < r - l && Math.abs(q.y - cy) < b - t)) touching++;
      }
    }

    // Non-vacuity: there really are craters to have found.
    expect(craters).toBe(8);
    expect(touching).toBe(0);
  }, 120000);

  /**
   * The rock arm is unmeasurable from the fixtures - no oracle capture carries
   * `big-volcanic-rock` / `huge-volcanic-rock` - so capturing one is the next
   * concrete step, and it now has a 25-cell target to aim at rather than a
   * ceiling argument against it.
   */
  it("records that no fixture carries the rock entities the arm needs", () => {
    const names = new Set(cases.flatMap((c) => c.cliffs.map((e) => e.name)));
    expect([...names].sort()).toEqual(["cliff-vulcanus", "crater-cliff"]);
  });
});
