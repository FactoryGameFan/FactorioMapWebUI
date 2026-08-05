import { describe, expect, it } from "vite-plus/test";

import batch from "./fixtures/oracle-vulcanus-cliff-entities-border-batch.seed123456.json";
import more from "./fixtures/oracle-vulcanus-cliff-entities-more-regions.seed123456.json";
import oreRegions from "./fixtures/oracle-vulcanus-cliff-ore-direction-regions.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  cliffCollisionTileBox,
} from "../src/noise/cliffs/cliffCatalog";
import { cliffCodeForOrientation } from "../src/noise/cliffs/cliffConnections";
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
 * **The two WEST observations in #84 are INDEPENDENT.** The west-edge residual
 * is not a resource-proximity effect, and the apparent proximity signal that
 * does show up is a regional-clustering artifact.
 *
 * #150 localised the border residual to the west chunk edge; #142 separately
 * found all six ore-recall cells with their nearest resource to the WEST. If
 * those were one phenomenon, two open threads would collapse into one. They are
 * not. No capture - the resources here are the game's own dumped entities, not
 * the port's model.
 *
 * ## The west edge is not about ore
 *
 * | | within 32 tiles of a resource | nearest resource lies WEST |
 * | --- | --- | --- |
 * | base (8,393 raw cells) | 21.3% | 47.1% |
 * | west-edge survivors (9) | 2 of 9 | **44.4%** |
 * | other survivors (15) | 3 of 15 | 60.0% |
 *
 * West-edge survivors are no closer to resources than the other survivors, and
 * their nearest resource points west slightly LESS often than the base rate.
 * Whatever produces the west edge concentration, it is not the ore.
 *
 * ## The proximity signal that looks real, and why it is not
 *
 * At a 64-tile radius the survivors do look resource-proximate: 70.8% against a
 * 40.2% base, **z = 3.06**. Two things kill it:
 *
 * - **The scale is wrong for a cell-level cause.** Nothing appears at 16 tiles
 *   (z = 0.81) or 32 (z = -0.05). An effect absent at short range and present at
 *   64 tiles is describing a REGION, not a cell.
 * - **n_eff is ~9, not 24.** The 24 survivors sit in 9 regions and the
 *   within-64 outcome is nearly all-or-nothing per region - four regions have
 *   ALL their survivors inside 64 tiles, two have NONE. The cells are not
 *   independent draws, so the binomial z is inflated. Same failure as
 *   `below-chance-needs-a-clustered-null`, which this investigation has hit
 *   before.
 *
 * Reported as a refuted signal rather than a finding, and asserted below so it
 * cannot be rediscovered and believed.
 */

const K = (x: number, y: number): string => `${String(x)},${String(y)}`;
const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
const tileCollides = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);
const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};
const SHIPPED = { ...BANDS, tileCollides, cellRejects: oreRejects, rejectAtCrossingStage: true };

interface Res {
  x: number;
  y: number;
  name: string;
}
interface Case {
  label?: string;
  region: { x0: number; y0: number; x1: number; y1: number };
  cliffs: { x: number; y: number; name: string; orientation: string }[];
  resources?: Res[];
}
const PAIRS: Case[] = [
  ...(batch.cases as unknown as Case[]),
  ...(more.cases as unknown as Case[]),
  ...(oreRegions.cases as unknown as Case[]),
];

function edgesOf(x: number, y: number): string[] {
  const cx = (x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE;
  const cy = (y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE;
  const ix = ((cx % 8) + 8) % 8;
  const iy = ((cy % 8) + 8) % 8;
  const out: string[] = [];
  if (iy === 0) out.push("north");
  if (ix === 7) out.push("east");
  if (iy === 7) out.push("south");
  if (ix === 0) out.push("west");
  return out;
}

function measure() {
  const survivorRows: unknown[] = [];
  const baseDists: number[] = [];
  const baseWestward: number[] = [];
  let regionsWithRes = 0;
  let regionsTotal = 0;

  for (let i = 0; i < PAIRS.length; i += 2) {
    const on = PAIRS[i];
    const off = PAIRS[i + 1];
    const r = on.region;
    regionsTotal++;
    const res = on.resources ?? [];
    if (res.length > 0) regionsWithRes++;
    const inR = (p: { x: number; y: number }): boolean =>
      p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
    const game = new Set(
      on.cliffs.filter((e) => e.name === "cliff-vulcanus" && inR(e)).map((e) => K(e.x, e.y)),
    );
    const gameOff = new Set(
      off.cliffs.filter((e) => e.name === "cliff-vulcanus" && inR(e)).map((e) => K(e.x, e.y)),
    );
    const oreSuppressed = new Set([...gameOff].filter((k) => !game.has(k)));

    const shipped = new Set(
      makeCliffPlacementFromFields(fields, SHIPPED)
        .placedCells(r.x0, r.y0, r.x1, r.y1)
        .map((p) => K(p.x, p.y)),
    );
    const all = makeCliffPlacementFromFields(fields, BANDS).placedCells(
      r.x0 - 64,
      r.y0 - 64,
      r.x1 + 64,
      r.y1 + 64,
    );
    const killSet = new Set<string>();
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      const code = cliffCodeForOrientation(o);
      const box = cliffCollisionTileBox(code, p.x, p.y);
      let hit = false;
      if (box !== undefined)
        for (let tx = box.left; tx <= box.right && !hit; tx++)
          for (let ty = box.top; ty <= box.bottom && !hit; ty++)
            if (tileCollides(tx, ty)) hit = true;
      if (hit || oreRejects(code, p.x, p.y)) killSet.add(K(p.x, p.y));
    }

    /** Nearest dumped resource: distance, and whether it lies to the west. */
    const nearest = (x: number, y: number): { d: number; west: boolean } | undefined => {
      let best = Infinity;
      let bx = 0;
      for (const q of res) {
        const d = Math.hypot(q.x - x, q.y - y);
        if (d < best) {
          best = d;
          bx = q.x;
        }
      }
      if (!Number.isFinite(best)) return undefined;
      return { d: best, west: bx < x };
    };

    for (const p of all) {
      if (!inR(p)) continue;
      if (CLIFF_CODE_TO_ORIENTATION[p.code] === undefined) continue;
      const n = nearest(p.x, p.y);
      if (n !== undefined) {
        baseDists.push(n.d);
        baseWestward.push(n.west ? 1 : 0);
      }
      const k = K(p.x, p.y);
      if (game.has(k)) continue;
      if (killSet.has(k) || oreSuppressed.has(k)) continue;
      if (!shipped.has(k)) continue;
      const es = edgesOf(p.x, p.y);
      survivorRows.push({
        region: on.label ?? K(r.x0, r.y0),
        x: p.x,
        y: p.y,
        edges: es,
        isWest: es.includes("west"),
        onBorder: es.length > 0,
        nearestDist: n?.d ?? null,
        nearestIsWest: n?.west ?? null,
        nRes: res.length,
      });
    }
  }
  const sorted = [...baseDists].sort((a, b) => a - b);
  const under = (t: number): number => baseDists.filter((d) => d < t).length / baseDists.length;
  return {
    regionsTotal,
    regionsWithRes,
    baseN: baseDists.length,
    baseMedian: sorted[Math.floor(sorted.length / 2)],
    baseWestShare: baseWestward.reduce((a, b) => a + b, 0) / baseWestward.length,
    baseUnder: { 16: under(16), 32: under(32), 64: under(64) },
    survivors: survivorRows as Survivor[],
  };
}

interface Survivor {
  region: string;
  x: number;
  y: number;
  edges: string[];
  isWest: boolean;
  onBorder: boolean;
  nearestDist: number | null;
  nearestIsWest: boolean | null;
  nRes: number;
}

const M = measure();
const S = M.survivors.filter((s) => s.nearestDist !== null);
const WEST = S.filter((s) => s.isWest);
const OTHER = S.filter((s) => !s.isWest);
const within = (a: Survivor[], t: number): number =>
  a.filter((s) => (s.nearestDist as number) < t).length;
const westShare = (a: Survivor[]): number =>
  a.filter((s) => s.nearestIsWest === true).length / a.length;
const z = (k: number, n: number, p: number): number => (k - n * p) / Math.sqrt(n * p * (1 - p));

describe("Vulcanus cliffs: the west-edge residual is NOT a resource-proximity effect (#84)", () => {
  it("scores 24 survivors against 8,393 raw cells from the game's own dumps", () => {
    expect(M.regionsTotal).toBe(14);
    expect(M.regionsWithRes).toBe(12);
    expect(M.baseN).toBe(8393);
    expect(S).toHaveLength(24);
    expect(WEST).toHaveLength(9);
  }, 900000);

  it("finds west-edge survivors no closer to ore than the others", () => {
    // 2 of 9 against 3 of 15 - indistinguishable, and both near the 21.3% base.
    expect(within(WEST, 32)).toBe(2);
    expect(within(OTHER, 32)).toBe(3);
    expect(M.baseUnder[32]).toBeCloseTo(0.213, 3);
  }, 900000);

  it("and their nearest resource points west LESS often than the base rate", () => {
    expect(M.baseWestShare).toBeCloseTo(0.471, 3);
    expect(westShare(WEST)).toBeCloseTo(0.444, 3);
    // The direction #142 saw in its six cells does not reappear here, so the
    // two west observations are independent.
    expect(westShare(WEST)).toBeLessThan(M.baseWestShare);
  }, 900000);

  describe("the 64-tile proximity signal is a clustering artifact", () => {
    it("looks significant taken at face value", () => {
      expect(within(S, 64)).toBe(17);
      expect(z(within(S, 64), S.length, M.baseUnder[64])).toBeGreaterThan(3);
    }, 900000);

    it("but is absent at the scales a cell-level cause would act on", () => {
      expect(Math.abs(z(within(S, 16), S.length, M.baseUnder[16]))).toBeLessThan(1);
      expect(Math.abs(z(within(S, 32), S.length, M.baseUnder[32]))).toBeLessThan(1);
    }, 900000);

    it("and the cells are not independent - n_eff is ~9 regions, not 24 cells", () => {
      const byRegion = new Map<string, Survivor[]>();
      for (const s of S) byRegion.set(s.region, [...(byRegion.get(s.region) ?? []), s]);
      expect(byRegion.size).toBe(9);
      // Nearly all-or-nothing per region, which is what makes the binomial z
      // over 24 cells wrong.
      const allOrNothing = [...byRegion.values()].filter(
        (v) => within(v, 64) === 0 || within(v, 64) === v.length,
      );
      expect(allOrNothing.length).toBeGreaterThanOrEqual(6);
    }, 900000);
  });
});
