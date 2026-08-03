import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_GRID_SIZE,
} from "../src/noise/cliffs/cliffCatalog";
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
/**
 * **This must mirror `renderVulcanusCliffs.ts` exactly, or the budget below
 * describes a model the app does not run.** It drifted once already:
 * `rejectAtCrossingStage` landed in the renderer with #108 and was not added
 * here, so for a day this file pinned 25 surplus and precision 0.9839 while the
 * shipping path was at 22 and 0.9858 - a spec named SHIPPED measuring something
 * else. If a flag is added to the renderer's call, add it here in the same
 * change.
 */
const SHIPPED = {
  ...BANDS,
  tileCollides,
  cellRejects: makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls),
  rejectAtCrossingStage: true,
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
 * | `[1500,1500]` | 861 | 877 | 858 | 19 | 3 |
 * | `[-1200,800]` | 387 | 387 | 386 | 1 | 1 |
 * | **total** | **1531** | **1547** | **1525** | **22** | **6** |
 *
 * **Recall 0.9961, precision 0.9858.** The long-standing 0.972 recall figure in
 * `vulcanus-cliffs-NOTES.md` was this artifact: it divided the same 1525 matches
 * by 1569 rather than 1531.
 *
 * `matched` here is a POSITION match: 21 of those 1525 carry the wrong
 * orientation, so scored on position and orientation together the same three
 * regions give recall 0.9824 and precision 0.9722. Both numbers are worth
 * knowing and they answer different questions - this file scores positions,
 * because that is what the surplus/missing split is about.
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
      ["1500,1500", 861, 877, 19, 3],
      ["-1200,800", 387, 387, 1, 1],
    ]);

    const sum = (f: (b: Budget) => number): number => budgets.reduce((a, b) => a + f(b), 0);
    expect(sum((b) => b.matched)).toBe(1525);
    expect(sum((b) => b.game)).toBe(1531);
    expect(sum((b) => b.port)).toBe(1547);
    expect(sum((b) => b.surplus)).toBe(22);
    expect(sum((b) => b.missing)).toBe(6);

    // Every missing cell is one OUR OWN lava rejection removed. There is no
    // cell left that the port simply fails to generate.
    expect(sum((b) => b.lavaKilled)).toBe(6);
    expect(sum((b) => b.oreKilled)).toBe(0);

    expect(sum((b) => b.matched) / sum((b) => b.game)).toBeCloseTo(0.9961, 4);
    expect(sum((b) => b.matched) / sum((b) => b.port)).toBeCloseTo(0.9858, 4);
  }, 120000);

  /**
   * **So precision is the remaining defect, not recall** - 22 surplus cells
   * against 6 missing, and #111 identified all 6: three are our lava rejection
   * firing where the game's does not, measured against the lava lever rather
   * than inferred.
   *
   * The guard is `x3` rather than the `x4` it was at 25 surplus. That is not a
   * weakened test - the gap narrowed because #108's crossing stage removed 3
   * surplus cells and no missing ones, which is the improvement working. Do not
   * raise it back without re-measuring.
   */
  it("leaves precision as the dominant defect", () => {
    const budgets = cases.map(budget);
    const surplus = budgets.reduce((a, b) => a + b.surplus, 0);
    const missing = budgets.reduce((a, b) => a + b.missing, 0);
    expect(surplus).toBeGreaterThan(missing * 3);
  }, 120000);
});

/**
 * **Item 3 of #84 - the entity half of `Surface::wouldCollide` - is CLOSED, and
 * these two arms are how it looked on the way there.**
 *
 * The history is worth keeping because the item was closed twice on bad grounds
 * before it was closed on a measurement. An early draft closed it by size (a
 * rejection only removes cells, so it could not help a 44-cell recall gap); that
 * reasoning died when the gap turned out to be the query-window artifact above,
 * and the item re-opened as the leading candidate. The arms below then closed
 * the crater half exactly and argued the rock half down from the mechanism's own
 * geometry.
 *
 * **#111 settled it outright with a lever instead.** Switching the whole
 * `entity` autoplace category off through `map_gen_settings.autoplace_settings`
 * removes 409 rocks, 115 chimneys and all 8 craters from `[1500,1500]`, and the
 * game's cliff set does not move by one cell - so no placed entity suppresses a
 * Vulcanus cliff, the whole class at once. See
 * `test/vulcanusCliffSuppressorLevers.spec.ts`.
 *
 * These arms are kept rather than deleted because they are independent
 * corroboration from a different direction, and because the reasoning they
 * document - closing a suspect on the geometry it is confined to rather than on
 * a score - is the part worth reusing. The one thing NOT to reuse is the
 * overlap-count statistic in the rock arm's comment: it was measured at 25
 * surplus cells, before #108 removed 3 of them, and has not been re-measured
 * under the shipping config. The chunk-border arm below is re-measured and does
 * assert.
 */
describe("the entity collision half: craters are worth zero, rocks are refuted", () => {
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

  it("records that no fixture carries the rock entities the arm needs", () => {
    const names = new Set(cases.flatMap((c) => c.cliffs.map((e) => e.name)));
    expect([...names].sort()).toEqual(["cliff-vulcanus", "crater-cliff"]);
  });

  /**
   * **The rock arm fails a test that does not depend on our rock model at all.**
   *
   * `computeInternal` runs `generateCliffs` before `generateEntities`, and
   * `apply` runs `applyCliffs` (`+124`) before `applyEntities` (`+164`) - so
   * within a chunk no rock exists when the cliff is applied. A rock can only
   * ever block a cliff from an ALREADY-GENERATED NEIGHBOUR, which confines the
   * whole mechanism to cells near a 32-tile chunk border.
   *
   * The port's surplus cells sit near a chunk border at **44.0%**, against
   * **44.1%** for the cells it gets right. That is the base rate to three
   * significant figures: the surplus has no chunk-border character whatever, so
   * the one geometry this mechanism is confined to is not where the errors are.
   *
   * A direct overlap test agreed and was the weaker arm, which is why it was not
   * leaned on: at the time, 3 of 25 surplus cells overlapped a modelled rock
   * against a 6.6% base rate, i.e. ~1.7 expected - nothing, and our rock
   * placement is a salt-dependent roll, so individual positions are unreliable
   * exactly as the geyser's were in #100. That count is NOT re-measured here;
   * treat it as history, not as a current figure.
   *
   * **So item 3 explains approximately none of the surplus**, argued from the
   * mechanism's own geometry rather than from the ceiling argument that died
   * with the recall gap, and without needing a rock capture. #111 then confirmed
   * it directly by removing every rock from the game.
   */
  it("finds no chunk-border character in the surplus, which is where rocks must act", () => {
    const nearBorder = (x: number, y: number): boolean => {
      const cx = (x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE;
      const cy = (y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE;
      const ix = ((cx % 8) + 8) % 8;
      const iy = ((cy % 8) + 8) % 8;
      return ix === 0 || ix === 7 || iy === 0 || iy === 7;
    };

    let surplus = 0;
    let surplusBorder = 0;
    let matched = 0;
    let matchedBorder = 0;
    for (const c of cases) {
      const game = new Set(inBox(c).map((p) => key(p.x, p.y)));
      for (const k of placed(c.region, SHIPPED)) {
        const [xs, ys] = k.split(",");
        const border = nearBorder(Number(xs), Number(ys));
        if (game.has(k)) {
          matched++;
          if (border) matchedBorder++;
        } else {
          surplus++;
          if (border) surplusBorder++;
        }
      }
    }

    expect(surplus).toBe(22);
    expect(matched).toBe(1525);
    // Within a percentage point of each other - no enrichment at all.
    const sRate = surplusBorder / surplus;
    const mRate = matchedBorder / matched;
    expect(Math.abs(sRate - mRate)).toBeLessThan(0.02);
    // Non-vacuity: "near a border" is a real subset, not everything or nothing.
    expect(mRate).toBeGreaterThan(0.3);
    expect(mRate).toBeLessThan(0.6);
  }, 120000);
});
