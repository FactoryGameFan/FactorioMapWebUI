import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_ORIENTATION_NAMES,
  cliffCollisionTileBox,
} from "../src/noise/cliffs/cliffCatalog";
import {
  applyCliffConnections,
  cliffCodeForOrientation,
} from "../src/noise/cliffs/cliffConnections";
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
 * **The whole Vulcanus cliff residual is 31 DESTRUCTION DECISIONS, and nothing
 * else** (#84).
 *
 * #113 read `EntityMapGenerationTask::applyCliffs`, the consumer of the queue
 * `generateCliffs` fills, and showed at `[1500,1500]` with neither ore nor lava
 * in the world that destroying the 12 cells the game lacks reproduces the game's
 * set exactly - 1058 of 1058, positions AND orientations. It left one question
 * open and named it as unmeasured: are the 5 surviving wrong orientations the
 * cascade fallout of the 5 false rejections, or a separate defect?
 *
 * They are the fallout. This file measures it the direct way - hand the port the
 * game's OWN destruction set in place of our lava and ore predicates, over all
 * three oracle regions and with the real ore and lava world - and the answer is
 * **1531 of 1531, zero wrong, zero surplus, zero missing**.
 *
 * So there is no orientation defect, no crossing defect, no field defect and no
 * missing suppressor left anywhere in the Vulcanus cliff port. Every disagreement
 * with the game is one of 31 cells where `Surface::wouldCollide` and our stand-in
 * for it return different booleans.
 *
 * **What is fitted and what is predicted**, because that is the whole weight of
 * the result. FITTED: the 225-cell destruction set, chosen as the raw cells the
 * game lacks - 225 booleans. PREDICTED: all 1531 orientations, including the 14
 * that the cascade actively rewrites (each with 19 ways to be wrong, see the
 * no-cascade control); that the cascade destroys no cell beyond the 225, which
 * would have shown as `missing`; and that the answer does not depend on what the
 * halo outside the region does.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
const tileCollides = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const K = (x: number, y: number): string => `${String(x)},${String(y)}`;

const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};

/** The tile half of `Surface::wouldCollide` as the port models it. */
const lavaCollides = (orientation: number, x: number, y: number): boolean => {
  const box = cliffCollisionTileBox(cliffCodeForOrientation(orientation), x, y);
  if (box === undefined) return false;
  for (let tx = box.left; tx <= box.right; tx++)
    for (let ty = box.top; ty <= box.bottom; ty++) if (tileCollides(tx, ty)) return true;
  return false;
};
const oreCollides = (orientation: number, x: number, y: number): boolean =>
  oreRejects(cliffCodeForOrientation(orientation), x, y);
const lavaAndOre = (orientation: number, x: number, y: number): boolean =>
  lavaCollides(orientation, x, y) || oreCollides(orientation, x, y);

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
interface Score {
  matched: number;
  wrong: number;
  surplus: number;
  missing: number;
}

const cases = entities.cases as unknown as { region: Region; cliffs: Ent[] }[];

const gameSet = (i: number): Map<string, number> => {
  const r = cases[i].region;
  const m = new Map<string, number>();
  for (const e of cases[i].cliffs) {
    if (e.name !== "cliff-vulcanus") continue;
    if (e.x < r.x0 || e.x >= r.x1 || e.y < r.y0 || e.y >= r.y1) continue;
    const id = nameToId.get(e.orientation ?? "");
    if (id !== undefined) m.set(K(e.x, e.y), id);
  }
  return m;
};
const GAME = cases.map((_, i) => gameSet(i));

const inRegion =
  (i: number) =>
  (p: { x: number; y: number }): boolean => {
    const r = cases[i].region;
    return p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
  };

/**
 * The un-rejected placed set with a 64-tile halo, per region, computed once.
 * This is `generateCliffs`' queue - crossings and the repair pass, no rejection
 * of any kind - which is what `applyCliffs` is handed.
 */
const RAW = cases.map((c) =>
  makeCliffPlacementFromFields(fields, BANDS).placedCells(
    c.region.x0 - 64,
    c.region.y0 - 64,
    c.region.x1 + 64,
    c.region.y1 + 64,
  ),
);

const score = (port: Map<string, number>, game: Map<string, number>): Score => {
  const s: Score = { matched: 0, wrong: 0, surplus: 0, missing: 0 };
  for (const [k, id] of port) {
    const t = game.get(k);
    if (t === undefined) s.surplus++;
    else if (t === id) s.matched++;
    else s.wrong++;
  }
  for (const k of game.keys()) if (!port.has(k)) s.missing++;
  return s;
};

type Collides = (orientation: number, x: number, y: number) => boolean;

/** Score one `collides` model over all three regions and sum. */
const runAll = (make: (i: number) => Collides, noCascade = false): Score => {
  const total: Score = { matched: 0, wrong: 0, surplus: 0, missing: 0 };
  for (let i = 0; i < cases.length; i++) {
    const out = applyCliffConnections(RAW[i], { collides: make(i), noCascade });
    const port = new Map(out.filter(inRegion(i)).map((p) => [K(p.x, p.y), p.orientation] as const));
    const s = score(port, GAME[i]);
    total.matched += s.matched;
    total.wrong += s.wrong;
    total.surplus += s.surplus;
    total.missing += s.missing;
  }
  return total;
};

/** The game's own destruction set: a raw cell inside the region the game lacks. */
const oracleKill =
  (i: number): Collides =>
  (_o, x, y) =>
    inRegion(i)({ x, y }) && !GAME[i].has(K(x, y));

describe("the game's own destruction set reproduces the game EXACTLY", () => {
  /**
   * **The result.** Replace our lava and ore predicates with the game's own
   * answer - destroy the raw cells the game does not have - and the `applyCliffs`
   * model reproduces every one of the 1531 game cliffs across the three oracle
   * regions, orientations included.
   *
   * The 225 destruction booleans are the only fitted quantity. Every orientation
   * is predicted, and so is `missing: 0`: the cascade is free to run past the 225
   * and destroy a cell the game keeps, and it does not.
   */
  it("gives 1531 of 1531, positions and orientations, over all three regions", () => {
    expect(runAll(oracleKill)).toEqual({ matched: 1531, wrong: 0, surplus: 0, missing: 0 });
  }, 300000);

  /**
   * **The halo does not decide it.** The arm above destroys nothing outside the
   * region, because no fixture says what the game did there; running our own
   * lava + ore predicate out there instead gives the identical answer. Without
   * this, "exact" could be an artifact of a quiet halo.
   */
  it("is unchanged when the halo runs our own predicate instead", () => {
    const mixed =
      (i: number): Collides =>
      (o, x, y) =>
        inRegion(i)({ x, y }) ? !GAME[i].has(K(x, y)) : lavaAndOre(o, x, y);
    expect(runAll(mixed)).toEqual({ matched: 1531, wrong: 0, surplus: 0, missing: 0 });
  }, 300000);

  /**
   * **The control that makes it mean something.** Destroy exactly the same 225
   * cells without telling their neighbours and 14 orientations come out wrong -
   * so the exact result above is the `Cliff::onDestroy` cascade predicting 14
   * rewrites, not an artifact of deleting the cells the game happens to lack.
   * Each of the 14 had 19 other orientations available to be wrong with.
   */
  it("leaves 14 wrong orientations when the cascade is switched off", () => {
    expect(runAll(oracleKill, true)).toEqual({
      matched: 1517,
      wrong: 14,
      surplus: 0,
      missing: 0,
    });
  }, 300000);

  /**
   * A prerequisite of all of the above, and a fact in its own right: the port's
   * un-rejected cell set is a strict SUPERSET of the game's in every region, not
   * just at `[1500,1500]` where #111 measured it with the levers. 1756 raw cells
   * contain all 1531 the game keeps, so nothing the port must explain is a
   * failure to GENERATE a cliff - it is all over-generation.
   */
  it("confirms the raw set is a strict superset in all three regions", () => {
    const raw = cases.map((_, i) => RAW[i].filter(inRegion(i)));
    expect(raw.map((r) => r.length)).toEqual([292, 1070, 394]);
    expect(GAME.map((g) => g.size)).toEqual([283, 861, 387]);
    for (let i = 0; i < cases.length; i++) {
      const have = new Set(raw[i].map((p) => K(p.x, p.y)));
      expect([...GAME[i].keys()].filter((k) => !have.has(k))).toEqual([]);
    }
  });
});

/**
 * **The 18 wrong orientations split cleanly into the two destruction errors**,
 * which is the question #113 left open.
 *
 * | `collides` | matched | wrong | surplus | missing |
 * | --- | --- | --- | --- | --- |
 * | lava + ore (what #113 scored) | 1508 | 18 | 22 | 5 |
 * | ...plus the 22 the game destroys | 1521 | **5** | 0 | 5 |
 * | ...instead sparing the cells the game keeps | 1517 | 14 | 22 | 0 |
 * | the game's set (both fixed) | **1531** | **0** | **0** | **0** |
 *
 * Row 2 is #113's prediction confirmed: closing the surplus takes `wrong` from 18
 * to 5. Row 3 is the other half - sparing the false rejections alone takes it to
 * 14. Neither error is a separate orientation defect; each carries its own
 * cascade fallout, and fixing both leaves nothing.
 */
describe("each residual orientation is the fallout of a destruction error", () => {
  it("closes the surplus and 13 of the 18 wrong go with it", () => {
    const alsoKillSurplus =
      (i: number): Collides =>
      (o, x, y) =>
        lavaAndOre(o, x, y) || (inRegion(i)({ x, y }) && !GAME[i].has(K(x, y)));
    expect(runAll(() => lavaAndOre)).toEqual({
      matched: 1508,
      wrong: 18,
      surplus: 22,
      missing: 5,
    });
    expect(runAll(alsoKillSurplus)).toEqual({ matched: 1521, wrong: 5, surplus: 0, missing: 5 });
  }, 300000);

  it("spares the false rejections and the other 4 go with them", () => {
    const spareGameCells =
      (i: number): Collides =>
      (o, x, y) =>
        lavaAndOre(o, x, y) && !(inRegion(i)({ x, y }) && GAME[i].has(K(x, y)));
    expect(runAll(spareGameCells)).toEqual({
      matched: 1517,
      wrong: 14,
      surplus: 22,
      missing: 0,
    });
  }, 300000);
});

/**
 * **The target, restated as the predicate's own confusion matrix.**
 *
 * Scoring `lava + ore` against the game's destruction set directly - one boolean
 * per raw cell, before any cascade - is a sharper measurement than the
 * surplus/missing counts, because those are outcomes that the cascade has already
 * blurred. 6 false rejections become 5 `missing` (one of the six is destroyed by
 * a neighbour's cascade before its own test runs) and 25 missed destructions
 * become 22 `surplus` (three are cascade casualties anyway).
 *
 * | | count |
 * | --- | --- |
 * | raw cells inside the three regions | 1756 |
 * | the game destroys | 225 |
 * | we destroy | 206 |
 * | agree | 200 |
 * | we destroy, the game keeps | **6** |
 * | the game destroys, we keep | **25** |
 *
 * So the predicate is **precision 200/206 = 0.971, recall 200/225 = 0.889**, and
 * the errors point BOTH WAYS - which is #111's finding restated on the stage that
 * actually does the rejecting, and is still what rules out any uniform dilation
 * or shrink of the collision box. #88 stands: do not tune the box until it fits.
 */
describe("the destruction predicate, scored on its own terms", () => {
  interface Split {
    key: string;
    orientation: number;
    lava: boolean;
    ore: boolean;
  }
  const audit = (): { agree: number; ours: number; theirs: number; wrongWay: Split[] } => {
    let agree = 0;
    let ours = 0;
    let theirs = 0;
    const wrongWay: Split[] = [];
    for (let i = 0; i < cases.length; i++) {
      for (const c of RAW[i].filter(inRegion(i))) {
        const o = CLIFF_CODE_TO_ORIENTATION[c.code];
        if (o === undefined) continue;
        const k = K(c.x, c.y);
        const gameKill = !GAME[i].has(k);
        const lava = lavaCollides(o, c.x, c.y);
        const ore = oreCollides(o, c.x, c.y);
        const ourKill = lava || ore;
        if (gameKill) theirs++;
        if (ourKill) ours++;
        if (gameKill && ourKill) agree++;
        else if (gameKill !== ourKill) wrongWay.push({ key: k, orientation: o, lava, ore });
      }
    }
    return { agree, ours, theirs, wrongWay };
  };

  it("pins the confusion matrix", () => {
    const a = audit();
    const total = cases.reduce((n, _, i) => n + RAW[i].filter(inRegion(i)).length, 0);
    expect(total).toBe(1756);
    expect(a.theirs).toBe(225);
    expect(a.ours).toBe(206);
    expect(a.agree).toBe(200);
    expect(a.wrongWay.filter((w) => w.lava || w.ore).length).toBe(6);
    expect(a.wrongWay.filter((w) => !w.lava && !w.ore).length).toBe(25);
    // Errors both ways, which is what forbids a one-parameter fix.
    expect(a.ours - a.agree).toBe(6);
    expect(a.theirs - a.agree).toBe(25);
  }, 300000);

  /**
   * **Every false rejection is the LAVA box; the ore rule invents none.**
   *
   * That narrows the two-sided error set to one predicate. The ore rule is a
   * clean subset here - it never destroys a cell the game keeps - so the six
   * cells the port removes wrongly are all the tile half of
   * `Surface::wouldCollide`, and the shape being wrong is the lava box's shape.
   *
   * The positions are listed because they are the input to the next measurement:
   * `Surface::wouldCollide` runs `constCollideWithTile` against the REAL surface,
   * while this test resolves tiles from our own Vulcanus tile model. A
   * disagreement between the two inside these boxes would produce exactly this
   * two-sided error set, and it has not been checked.
   */
  it("finds all 6 false rejections are lava, none of them ore", () => {
    const wrong = audit().wrongWay.filter((w) => w.lava || w.ore);
    expect(wrong.filter((w) => w.lava).length).toBe(6);
    expect(wrong.filter((w) => w.ore).length).toBe(0);
    expect(wrong.map((w) => w.key).sort((a, b) => a.localeCompare(b))).toEqual([
      "-1054,1018.5",
      "1638,1598.5",
      "1638,1602.5",
      "1662,1634.5",
      "22,178.5",
      "86,38.5",
    ]);
  }, 300000);
});
