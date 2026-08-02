import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeVulcanusOreRejection } from "../src/noise/cliffs/vulcanusOreRejection";
import { VULCANUS_CLIFF_BASE_COLLISION_BOX } from "../src/noise/cliffs/vulcanusOreRejection";
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
interface Case {
  region: { x0: number; y0: number; x1: number; y1: number };
  cliffs: Ent[];
}

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const resources = buildResources(ctx);
const oreRejects = makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls);
const tileCollides = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);
const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};

const cellsFor = (r: Case["region"], opts: { lava?: boolean; ore?: boolean }): Set<string> =>
  new Set(
    makeCliffPlacementFromFields(fields, {
      ...BANDS,
      tileCollides: opts.lava === true ? tileCollides : undefined,
      cellRejects: opts.ore === true ? oreRejects : undefined,
    })
      .placedCells(r.x0, r.y0, r.x1, r.y1)
      .map((p) => key(p.x, p.y)),
  );

interface Budget {
  at: string;
  surplus: number;
  missing: number;
  lavaKilled: number;
  oreKilled: number;
  neverGenerated: number;
}

const budget = (c: Case): Budget => {
  const r = c.region;
  const game = new Set(
    c.cliffs.filter((e) => e.name === "cliff-vulcanus").map((e) => key(e.x, e.y)),
  );
  const raw = cellsFor(r, {});
  const lava = cellsFor(r, { lava: true });
  const full = cellsFor(r, { lava: true, ore: true });
  const missing = [...game].filter((k) => !full.has(k));
  return {
    at: key(r.x0, r.y0),
    surplus: [...full].filter((k) => !game.has(k)).length,
    missing: missing.length,
    lavaKilled: missing.filter((k) => raw.has(k) && !lava.has(k)).length,
    oreKilled: missing.filter((k) => lava.has(k) && !full.has(k)).length,
    neverGenerated: missing.filter((k) => !raw.has(k)).length,
  };
};

/**
 * **Where the remaining Vulcanus cliff error actually is**, split so that the
 * next piece of work is chosen by size rather than by which lead reads best.
 *
 * This exists because the ore rejection (#100) changed the answer. Every cliff
 * defect found since #18 has been a rule the port OVER-places without - lava
 * collision, the rotbb box shape, the ore suppression - so "find another
 * rejection" has been the shape of the work throughout. After #100 that is no
 * longer where the budget is: **the port now misses more cells than it
 * over-places**, and no rejection rule can ever fix a missed cell.
 *
 * The split below is the whole point. `missing` decomposes into cells one of our
 * own rejections killed (so the rejection is too aggressive) and cells the
 * crossings stage **never produced at all** - which is a completely different
 * defect, in a different part of the port.
 */
describe("the remaining error budget, by region and by cause", () => {
  it("pins the composition", () => {
    const budgets = (entities.cases as unknown as Case[]).map(budget);

    expect(budgets).toEqual([
      {
        at: "0,0",
        surplus: 2,
        missing: 2,
        lavaKilled: 2,
        oreKilled: 0,
        neverGenerated: 0,
      },
      {
        at: "1500,1500",
        surplus: 22,
        missing: 27,
        lavaKilled: 3,
        oreKilled: 0,
        neverGenerated: 24,
      },
      {
        at: "-1200,800",
        surplus: 1,
        missing: 15,
        lavaKilled: 1,
        oreKilled: 0,
        neverGenerated: 14,
      },
    ]);

    const sum = (f: (b: Budget) => number): number => budgets.reduce((a, b) => a + f(b), 0);
    // The headline the rest of this file is about: MISSING now outweighs
    // SURPLUS, 44 to 25, and 38 of the 44 are cells we never generate.
    expect(sum((b) => b.surplus)).toBe(25);
    expect(sum((b) => b.missing)).toBe(44);
    expect(sum((b) => b.neverGenerated)).toBe(38);
    expect(sum((b) => b.lavaKilled)).toBe(6);
    // The ore rule kills nothing the game kept, in any region - the gate #100
    // shipped under, re-asserted here against the full pipeline rather than the
    // predicate in isolation.
    expect(sum((b) => b.oreKilled)).toBe(0);
  }, 120000);

  /**
   * **`[0,0]` generates every cell the game does.** Its entire miss is two cells
   * our own lava rejection removed; `neverGenerated` is zero. The other two
   * regions account for all 38.
   *
   * That is a sharp regional signature and the strongest lead this file
   * produces: whatever fails to generate those 38 cells does not fail near
   * spawn. It is also consistent with #93, which found the port exact at `[0,0]`
   * and `[-1200,800]` with `cliff_smoothing = 0` and still wrong at
   * `[1500,1500]` - so the two are probably not one defect.
   */
  it("localises the never-generated cells away from spawn", () => {
    const budgets = (entities.cases as unknown as Case[]).map(budget);
    const spawn = budgets.find((b) => b.at === "0,0");
    expect(spawn?.neverGenerated).toBe(0);
    expect(spawn?.missing).toBe(spawn?.lavaKilled);
    // Non-vacuity: `[0,0]` is not a region where nothing happens - the raw pass
    // produces 292 cells there and the lava rejection removes 9 of them.
    const r = (entities.cases as unknown as Case[])[0].region;
    expect(cellsFor(r, {}).size).toBe(292);
    expect(cellsFor(r, { lava: true }).size).toBe(283);
  }, 120000);
});

/**
 * **Item 3 of #84 - the entity half of `Surface::wouldCollide` - is closed by
 * size, before any of it is ported.**
 *
 * `#94` established that cliffs get TWO collision tests and the port implements
 * one: `applyCliffs` re-tests through `Surface::wouldCollide`, which is
 * `constCollideWithTile` AND `collideWithEntity`. `big-volcanic-rock`,
 * `huge-volcanic-rock` and `crater-cliff` all share a layer with the cliff mask,
 * so all three can reject a cliff, and none of it is ported.
 *
 * It is still not worth porting, for a reason that has nothing to do with how
 * hard it is: **it is a rejection, and rejections can only remove cells.** The
 * entire surplus across all three oracle regions is 25 cells, so 25 is the
 * absolute ceiling on what the whole entity half could ever be worth - against a
 * 44-cell recall gap it would leave untouched and could only make worse.
 *
 * This is the same "close a candidate by SIZE first" move that retired
 * `fixImpossibleCells` as a suspect (35 cells against a 175-cell effect).
 */
describe("the entity collision half is bounded before it is built", () => {
  /**
   * The crater arm can be settled exactly, because craters are already in the
   * fixtures - and it is worth **zero**. All 8 sit in `[-1200,800]`, and not one
   * of them touches a cell the port over-places.
   */
  it("craters explain none of the surplus", () => {
    const [l, t, r, b] = VULCANUS_CLIFF_BASE_COLLISION_BOX;
    let cratersSeen = 0;
    let touchingSurplus = 0;

    for (const c of entities.cases as unknown as Case[]) {
      const game = new Set(
        c.cliffs.filter((e) => e.name === "cliff-vulcanus").map((e) => key(e.x, e.y)),
      );
      const craters = c.cliffs.filter((e) => e.name === "crater-cliff");
      cratersSeen += craters.length;
      const surplus = [...cellsFor(c.region, { lava: true, ore: true })].filter(
        (k) => !game.has(k),
      );
      for (const k of surplus) {
        const [xs, ys] = k.split(",");
        const cx = Number(xs);
        const cy = Number(ys);
        // Two cliff-shaped boxes overlap when their centres are within the sum
        // of the half-extents; `crater-cliff` carries the same box as
        // `cliff-vulcanus` (both `+/-0.988 x +/-0.488` in the fixture protos).
        if (craters.some((q) => Math.abs(q.x - cx) < r - l && Math.abs(q.y - cy) < b - t))
          touchingSurplus++;
      }
    }

    // Non-vacuity: there really are craters to have found, they simply do not
    // coincide with any cell the port gets wrong.
    expect(cratersSeen).toBe(8);
    expect(touchingSurplus).toBe(0);
  }, 120000);

  /**
   * The rock arm cannot be settled from the fixtures - no oracle capture carries
   * `big-volcanic-rock` / `huge-volcanic-rock` - but it does not need to be. The
   * ceiling below bounds the entire entity half, rocks included: a rejection
   * cannot place a cell, so it can never touch the 44 the port is missing.
   */
  it("bounds the whole entity half at 25 cells, against a 44-cell recall gap", () => {
    const budgets = (entities.cases as unknown as Case[]).map(budget);
    const surplus = budgets.reduce((a, b) => a + b.surplus, 0);
    const missing = budgets.reduce((a, b) => a + b.missing, 0);
    expect(surplus).toBe(25);
    expect(missing).toBeGreaterThan(surplus);
  }, 120000);
});
