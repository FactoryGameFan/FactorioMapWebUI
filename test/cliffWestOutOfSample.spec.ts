import { describe, expect, it } from "vite-plus/test";

import batch from "./fixtures/oracle-vulcanus-cliff-entities-border-batch.seed123456.json";
import more from "./fixtures/oracle-vulcanus-cliff-entities-more-regions.seed123456.json";
import oreRegions from "./fixtures/oracle-vulcanus-cliff-ore-direction-regions.seed123456.json";
import oos from "./fixtures/oracle-vulcanus-cliff-entities-west-oos.seed123456.json";
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
 * **The WEST-edge concentration REPLICATES out of sample.** Eight regions
 * captured fresh for this test, disjoint from the fourteen every previous west
 * measurement used (#84).
 *
 * This is the check that six mechanism hunts were spent without: #150's z = 3.01
 * edge split and #151's four sweep-order arms all reuse the SAME 14 regions, so
 * every one of them was a re-slice of one sample. This repo has been burned by
 * exactly that shape before - a partition that looked solid at n = 14 and needed
 * n raised rather than sliced again.
 *
 * `oracle-vulcanus-cliff-entities-west-oos` is eight new Vulcanus regions with
 * the same paired ON / ALL-resources-OFF ore lever, spread away from spawn and
 * from each other and from all fifteen already in use.
 *
 * The measurement is identical in every other respect: the SHIPPED model's
 * unexplained residual (a cell the game killed that neither our own kill set nor
 * the game's ore lever accounts for), split by which chunk edge it sits on,
 * against a base rate measured over that sample's own raw border cells.
 *
 * ## The result: half replicates, half does not
 *
 * | | unexplained | on border | W | N | E | S | z(W) | z(N) | z(E) |
 * | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 * | in sample (14 regions) | 25 | 19 | 9 | 5 | 3 | 2 | **2.60** | 0.41 | -1.21 |
 * | **out of sample (8 new)** | 34 | 23 | 10 | 9 | 4 | 7 | **2.29** | **1.79** | -1.04 |
 *
 * **What replicates:** west is the most enriched edge again (z = 2.29), and east
 * is the depleted edge in both. The concentration is real and is not an artifact
 * of re-slicing one sample - which is what six mechanism hunts were spent
 * without ever checking.
 *
 * **What does NOT:** "west specifically". In sample north sat at its base rate
 * (z = 0.41) and west led it by more than 2 sigma; out of sample north is 1.79
 * and trails west by half a sigma. The claim that survives both samples is the
 * weaker and differently-shaped one: **the low-coordinate edges (west and north)
 * are enriched and east is depleted**, not west alone.
 *
 * That matters for mechanism hunting, because "west" and "west + north" point at
 * different things - and note #151 already refuted the one rule whose asymmetry
 * is literally west-then-north, the repair sweep's `L, T, R, B` clear order, by
 * permutation. So this widens the target rather than narrowing it.
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
const EDGES = ["north", "east", "south", "west"] as const;
type Edge = (typeof EDGES)[number];

interface Case {
  label?: string;
  region: { x0: number; y0: number; x1: number; y1: number };
  cliffs: { x: number; y: number; name: string; orientation: string }[];
}
const IN_SAMPLE: Case[] = [
  ...(batch.cases as unknown as Case[]),
  ...(more.cases as unknown as Case[]),
  ...(oreRegions.cases as unknown as Case[]),
];
const OUT_OF_SAMPLE: Case[] = oos.cases as unknown as Case[];

function edgesOf(x: number, y: number): Edge[] {
  const cx = (x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE;
  const cy = (y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE;
  const ix = ((cx % 8) + 8) % 8;
  const iy = ((cy % 8) + 8) % 8;
  const out: Edge[] = [];
  if (iy === 0) out.push("north");
  if (ix === 7) out.push("east");
  if (iy === 7) out.push("south");
  if (ix === 0) out.push("west");
  return out;
}

interface Arm {
  unexplained: number;
  border: number;
  byEdge: Record<Edge, number>;
  z: Record<Edge, number>;
}

/** The #150 edge-split measurement over a given set of ON/OFF region pairs. */
function arm(order: readonly number[], PAIRS: Case[]): Arm {
  const bands = { ...BANDS, sweepEdgeOrder: order };
  const shippedBands = {
    ...bands,
    tileCollides,
    cellRejects: oreRejects,
    rejectAtCrossingStage: true,
  };
  const byEdge: Record<Edge, number> = { north: 0, east: 0, south: 0, west: 0 };
  const base: Record<Edge, number> = { north: 0, east: 0, south: 0, west: 0 };
  let unexplained = 0;
  let border = 0;

  for (let i = 0; i < PAIRS.length; i += 2) {
    const on = PAIRS[i];
    const off = PAIRS[i + 1];
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

    const shipped = new Set(
      makeCliffPlacementFromFields(fields, shippedBands)
        .placedCells(r.x0, r.y0, r.x1, r.y1)
        .map((p) => K(p.x, p.y)),
    );
    const all = makeCliffPlacementFromFields(fields, bands).placedCells(
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

    for (const p of all) {
      if (!inR(p)) continue;
      if (CLIFF_CODE_TO_ORIENTATION[p.code] === undefined) continue;
      for (const e of edgesOf(p.x, p.y)) base[e]++;
      const k = K(p.x, p.y);
      if (game.has(k)) continue;
      if (killSet.has(k) || oreSuppressed.has(k)) continue;
      if (!shipped.has(k)) continue;
      unexplained++;
      const es = edgesOf(p.x, p.y);
      if (es.length > 0) border++;
      for (const e of es) byEdge[e]++;
    }
  }

  const baseTotal = EDGES.reduce((a, e) => a + base[e], 0);
  const z = {} as Record<Edge, number>;
  for (const e of EDGES) {
    const p = base[e] / baseTotal;
    z[e] = (byEdge[e] - border * p) / Math.sqrt(border * p * (1 - p));
  }
  return { unexplained, border, byEdge, z };
}

const IN = arm([0, 1, 2, 3], IN_SAMPLE);
const OOS = arm([0, 1, 2, 3], OUT_OF_SAMPLE);
const topEdge = (a: Arm): Edge =>
  EDGES.reduce((best, e) => (a.z[e] > a.z[best] ? e : best), "north");

describe("Vulcanus cliffs: the WEST concentration replicates out of sample (#84)", () => {
  it("reproduces the in-sample split as the control", () => {
    expect(IN_SAMPLE.length / 2).toBe(14);
    expect(IN.unexplained).toBe(25);
    expect(IN.byEdge).toEqual({ west: 9, north: 5, east: 3, south: 2 });
    expect(IN.z.west).toBeCloseTo(2.6, 1);
  }, 900000);

  it("covers eight genuinely new regions", () => {
    expect(OUT_OF_SAMPLE.length / 2).toBe(8);
    // Disjoint from every region the in-sample set uses.
    const originsOf = (c: Case[]): Set<string> =>
      new Set(c.map((k) => `${String(k.region.x0)},${String(k.region.y0)}`));
    const a = originsOf(IN_SAMPLE);
    for (const o of originsOf(OUT_OF_SAMPLE)) expect(a.has(o)).toBe(false);
  }, 900000);

  it("finds WEST the most enriched edge again - the signal replicates", () => {
    expect(OOS.unexplained).toBe(34);
    expect(OOS.border).toBe(23);
    expect(OOS.byEdge).toEqual({ west: 10, north: 9, south: 7, east: 4 });
    expect(topEdge(OOS)).toBe("west");
    expect(OOS.z.west).toBeCloseTo(2.29, 1);
    // East stays the DEPLETED edge in both samples, which is the other half of
    // the pattern surviving.
    expect(OOS.z.east).toBeLessThan(0);
    expect(IN.z.east).toBeLessThan(0);
  }, 900000);

  it("but NORTH rises sharply, so 'west specifically' does NOT replicate", () => {
    // The honest half. In sample north sat at the base rate (z = 0.41); out of
    // sample it is 1.79 and only half a sigma behind west. The replicated claim
    // is the WEST/NORTH pair being high and east low - not west alone.
    expect(IN.z.north).toBeLessThan(0.5);
    expect(OOS.z.north).toBeGreaterThan(1.5);
    expect(OOS.z.west - OOS.z.north).toBeLessThan(0.6);
    // And in sample the gap was more than 2 sigma, so this is a real change in
    // the shape of the result, not noise around one number.
    expect(IN.z.west - IN.z.north).toBeGreaterThan(2);
  }, 900000);
});
