import { describe, expect, it } from "vite-plus/test";

import batch from "./fixtures/oracle-vulcanus-cliff-entities-border-batch.seed123456.json";
import more from "./fixtures/oracle-vulcanus-cliff-entities-more-regions.seed123456.json";
import oreRegions from "./fixtures/oracle-vulcanus-cliff-ore-direction-regions.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  cliffCollisionTileBox,
} from "../src/noise/cliffs/cliffCatalog";
import {
  cliffCodeForOrientation,
  connectedSides,
  destroyEnd,
  isCliffConnected,
  onChunkBorder,
  oppositeSide,
} from "../src/noise/cliffs/cliffConnections";
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
 * **The chunk-border enrichment is NOT a cascade artifact - it survives, and
 * STRENGTHENS** (#84). And a shipping accuracy gain is measured and left on the
 * table deliberately.
 *
 * #142 found that four of the ten apparent misses in the ORE recall gap were
 * never geometry failures: they were cascade casualties, cells the game removed
 * because a neighbour we correctly rejected took their only end. That is the
 * most natural deflationary explanation for the border residual too - the
 * residual is counted at the OUTPUT (cells the game killed that our predicates
 * do not), so a cascade casualty of a correct kill counts as an independent
 * defect. If the 44 were largely such casualties, the enrichment could be an
 * artifact of counting.
 *
 * **It is not.** Applying the destruction cascade - the one #139 confirmed
 * against the game with a runtime probe, and #141 confirmed again against
 * ordinary map-generation output - to the port's OWN kill set:
 *
 * | | unknown | on border | z | false rejections |
 * | --- | --- | --- | --- | --- |
 * | before cascade | 33 | 22 | 2.36 | 12 |
 * | after cascade | **23** | 17 | **2.67** | **14** |
 *
 * The cascade explains 10 of the 33, and the enrichment does not dissolve - it
 * concentrates. So the border signal has now survived its two most plausible
 * deflations: the orientation-reach rival (#134) and cascade double-counting
 * here.
 *
 * ## The accuracy gain, measured and NOT taken
 *
 * The same run says the port is leaving cells on the table: **10 fewer missed
 * for 2 more false rejections**, a net 8 over these regions. `renderVulcanusCliffs`
 * does not cascade at all today - `applyCliffConnections` exists but is used only
 * by specs.
 *
 * It is recorded rather than adopted on purpose. Adopting it changes rendered
 * ORIENTATIONS as well as positions, needs `cliffErrorBudget.spec.ts` moved in
 * lockstep (that file's own header records the day it drifted), and
 * `applyCliffConnections` additionally bundles the `updateConnections` model,
 * which is an explicit UPPER BOUND and is not what this audit applied. Whoever
 * takes it should apply the destroy cascade alone first and re-measure the whole
 * budget.
 *
 * **The 2 new false rejections are the thing to look at first**, not the 10
 * wins: they are cells the game KEPT that our cascade removes, and #134 recorded
 * a gate the port does not model - `Cliff::destroyEnd` refuses to `forceDestroy`
 * when entity flag bit 4 of `+0x6e` is set, returning with the orientation
 * UNCHANGED rather than merely undestroyed.
 *
 * ## Scope, stated because the headline number differs from the published one
 *
 * This pairs **14 regions** across three fixtures, not the 15 the published
 * 44-cell figure covers: `[1500,1500]`'s ON/OFF pair lives in
 * `oracle-vulcanus-cliff-ore-direction`, a fixture with a different case shape.
 * The overlap is the check that this harness is measuring the same thing - on
 * the eight-region border batch it reproduces **17 unknown, 12 on a border**,
 * which is exactly what `cliffResidualBorderEnrichment` publishes for that batch.
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
const STEP: readonly (readonly [number, number])[] = [
  [0, -CLIFF_GRID_SIZE],
  [CLIFF_GRID_SIZE, 0],
  [0, CLIFF_GRID_SIZE],
  [-CLIFF_GRID_SIZE, 0],
];

interface Case {
  region: { x0: number; y0: number; x1: number; y1: number };
  cliffs: { x: number; y: number; name: string }[];
}
/** Cases are ON/OFF pairs in capture order, which is what the `i += 2` relies on. */
const PAIRS: Case[] = [
  ...(batch.cases as unknown as Case[]),
  ...(more.cases as unknown as Case[]),
  ...(oreRegions.cases as unknown as Case[]),
];

interface Tally {
  regions: number;
  raw: number;
  rawOnBorder: number;
  before: number;
  beforeOnBorder: number;
  after: number;
  afterOnBorder: number;
  cascadeExplained: number;
  falseBefore: number;
  falseAfter: number;
}

/** `batchOnly` restricts to the eight-region border batch, for the overlap check. */
function audit(cases: Case[]): Tally {
  const t: Tally = {
    regions: cases.length / 2,
    raw: 0,
    rawOnBorder: 0,
    before: 0,
    beforeOnBorder: 0,
    after: 0,
    afterOnBorder: 0,
    cascadeExplained: 0,
    falseBefore: 0,
    falseAfter: 0,
  };
  for (let i = 0; i < cases.length; i += 2) {
    const on = cases[i];
    const off = cases[i + 1];
    const r = on.region;
    const inR = (p: { x: number; y: number }): boolean =>
      p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
    const game = new Set(
      on.cliffs.filter((e) => e.name === "cliff-vulcanus" && inR(e)).map((e) => K(e.x, e.y)),
    );
    const gameOff = new Set(
      off.cliffs.filter((e) => e.name === "cliff-vulcanus" && inR(e)).map((e) => K(e.x, e.y)),
    );
    const oreSuppressed = new Set([...gameOff].filter((k) => !game.has(k)));
    // The 64-tile halo is what lets a cascade entering the region from outside
    // be modelled; without it the edge cells would show the clamped-window
    // artifact #139 hit.
    const all = makeCliffPlacementFromFields(fields, BANDS).placedCells(
      r.x0 - 64,
      r.y0 - 64,
      r.x1 + 64,
      r.y1 + 64,
    );
    const cells = new Map<string, number>();
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o !== undefined) cells.set(K(p.x, p.y), o);
    }
    const raw = new Map(cells);
    const kills: [number, number][] = [];
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      const code = cliffCodeForOrientation(o);
      const box = cliffCollisionTileBox(code, p.x, p.y);
      let lava = false;
      if (box !== undefined)
        for (let tx = box.left; tx <= box.right; tx++)
          for (let ty = box.top; ty <= box.bottom; ty++) if (isLava(tx, ty)) lava = true;
      if (lava || oreRejects(code, p.x, p.y)) kills.push([p.x, p.y]);
    }
    const destroy = (x: number, y: number): void => {
      const mine = cells.get(K(x, y));
      if (mine === undefined) return;
      cells.delete(K(x, y));
      for (const side of connectedSides(mine)) {
        const st = STEP[side];
        if (st === undefined) continue;
        const nx = x + st[0];
        const ny = y + st[1];
        const theirs = cells.get(K(nx, ny));
        if (theirs === undefined) continue;
        if (!isCliffConnected(side, mine, theirs)) continue;
        const next = destroyEnd(theirs, oppositeSide(side));
        if (next === -1) destroy(nx, ny);
        else cells.set(K(nx, ny), next);
      }
    };
    for (const [x, y] of kills) destroy(x, y);
    const killSet = new Set(kills.map(([x, y]) => K(x, y)));

    for (const k of raw.keys()) {
      const parts = k.split(",");
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!(x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)) continue;
      const gameKill = !game.has(k);
      const border = onChunkBorder(x, y);
      t.raw++;
      if (border) t.rawOnBorder++;
      const attributed = killSet.has(k) || oreSuppressed.has(k);
      if (gameKill && !attributed) {
        t.before++;
        if (border) t.beforeOnBorder++;
        if (!cells.has(k)) t.cascadeExplained++;
        else {
          t.after++;
          if (border) t.afterOnBorder++;
        }
      }
      if (!gameKill && killSet.has(k)) t.falseBefore++;
      if (!gameKill && !cells.has(k)) t.falseAfter++;
    }
  }
  return t;
}

const T = audit(PAIRS);
const BATCH = audit(batch.cases as unknown as Case[]);
const baseRate = T.rawOnBorder / T.raw;
const z = (k: number, n: number, p: number): number => (k - n * p) / Math.sqrt(n * p * (1 - p));

describe("Vulcanus cliffs: the border residual is not a cascade artifact (#84)", () => {
  it("reproduces the published border-batch figures - 17 unknown, 12 on a border", () => {
    // The overlap check. If this harness disagreed with
    // `cliffResidualBorderEnrichment` on the batch they share, every other
    // number here would be measuring something else.
    expect(BATCH.regions).toBe(8);
    expect(BATCH.before).toBe(17);
    expect(BATCH.beforeOnBorder).toBe(12);
  }, 900000);

  it("covers 14 regions at a stable ~46% border base rate", () => {
    expect(T.regions).toBe(14);
    expect(T.raw).toBe(9056);
    expect(baseRate).toBeCloseTo(0.46, 2);
  }, 900000);

  describe("the cascade explains some of the residual, but not the enrichment", () => {
    it("removes 10 of the 33 unknown cells", () => {
      expect(T.before).toBe(33);
      expect(T.cascadeExplained).toBe(10);
      expect(T.after).toBe(23);
      // Not idle: without this the null below would be satisfied by a cascade
      // that never fired.
      expect(T.cascadeExplained).toBeGreaterThan(0);
    }, 900000);

    it("leaves the border enrichment STRONGER, not weaker", () => {
      const zBefore = z(T.beforeOnBorder, T.before, baseRate);
      const zAfter = z(T.afterOnBorder, T.after, baseRate);
      expect(zBefore).toBeGreaterThan(2.3);
      expect(zAfter).toBeGreaterThan(zBefore);
      expect(zAfter).toBeGreaterThan(2.6);
      // The share rises too, so this is not the z moving on sample size alone.
      expect(T.afterOnBorder / T.after).toBeGreaterThan(T.beforeOnBorder / T.before);
    }, 900000);
  });

  describe("the accuracy gain, measured and deliberately NOT taken", () => {
    it("would trade 10 missed cells for 2 false rejections", () => {
      expect(T.falseBefore).toBe(12);
      expect(T.falseAfter).toBe(14);
      // Net 8 cells better. Recorded so the decision to adopt is deliberate;
      // see this file's header for what adopting would require.
      expect(T.cascadeExplained - (T.falseAfter - T.falseBefore)).toBe(8);
    }, 900000);
  });
});
