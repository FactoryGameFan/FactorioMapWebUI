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
 * **The WEST concentration is NOT caused by the repair sweep's edge order.**
 * Permuting `L, T, R, B` does not move it - west stays the enriched edge under
 * every permutation, including the one that tries west LAST (#84).
 *
 * #150 localised the border residual to the WEST chunk edge (9 of 17 border
 * survivors, z = 3.01 against a measured base rate) and recorded one lead:
 * `fixImpossibleCellsSweep` clears the first CLEARABLE edge in the order
 * `L, T, R, B` - west first, north second - and an edge is clearable only when
 * it is not on the chunk's outer boundary. So a cell on the west edge is denied
 * its FIRST choice and a north-edge cell only its second, which is an asymmetry
 * of exactly the observed shape.
 *
 * **The discriminator is relocation, not shrinkage.** If the order causes the
 * concentration, permuting it should move the excess to whichever edge is tried
 * first; a residual that stays put under permutation is not caused by the order.
 * That is a much stronger test than "does the error get smaller", which almost
 * any perturbation achieves by accident.
 *
 * Permuting makes the port WRONG - the engine's order is `L, T, R, B` and only
 * that - so total error rises in every arm. That is expected and is not what is
 * being scored; only WHERE the residual sits is.
 *
 * ## The result
 *
 * | order | unexplained | on border | W | N | E | S | z(west) |
 * | --- | --- | --- | --- | --- | --- | --- | --- |
 * | `L, T, R, B` (engine) | 25 | 19 | 9 | 5 | 3 | 2 | **2.60** |
 * | `R, B, L, T` | 75 | 24 | 11 | 7 | 4 | 3 | **2.74** |
 * | `T, L, B, R` | 46 | 22 | 10 | 5 | 5 | 3 | **2.58** |
 * | `B, R, T, L` (west LAST) | 76 | 23 | 11 | 7 | 3 | 3 | **2.91** |
 *
 * **West is the enriched edge in every arm, and is at its STRONGEST in the arm
 * that tries west last.** The lead is refuted: #84's west signature has a cause
 * outside the sweep's choice order.
 *
 * The lever is not inert while failing to move it - that is the trap this shape
 * of test falls into. Permuting drives the unexplained count from 25 to 76, so
 * the sweep's order matters enormously to the placement; it simply does not
 * matter to WHERE the residual sits.
 *
 * Note the arm here scores the SHIPPED model, so its control is #149's 25
 * unexplained / 19 on border, not #150's 23 / 17 - those are the cascade model's
 * row. West is 9 either way, which is the point of overlap that says both are
 * looking at the same cells.
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
const PAIRS: Case[] = [
  ...(batch.cases as unknown as Case[]),
  ...(more.cases as unknown as Case[]),
  ...(oreRegions.cases as unknown as Case[]),
];

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

/** Runs the whole #150 measurement with the sweep's edge order permuted. */
function arm(order: readonly number[]): Arm {
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

const LTRB = arm([0, 1, 2, 3]);
const RBLT = arm([2, 3, 0, 1]);
const TLBR = arm([1, 0, 3, 2]);
const BRTL = arm([3, 2, 1, 0]);
const ARMS: [string, Arm][] = [
  ["L,T,R,B (engine)", LTRB],
  ["R,B,L,T", RBLT],
  ["T,L,B,R", TLBR],
  ["B,R,T,L", BRTL],
];
const topEdge = (a: Arm): Edge =>
  EDGES.reduce((best, e) => (a.z[e] > a.z[best] ? e : best), "north");

describe("Vulcanus cliffs: the WEST residual is not the sweep's edge order (#84)", () => {
  it("reproduces the shipped model's published split on the engine's own order", () => {
    // The control, tying this to #149's 25 / 19. Without it the permuted arms
    // could be a differently-scoped measurement.
    expect(LTRB.unexplained).toBe(25);
    expect(LTRB.border).toBe(19);
    expect(LTRB.byEdge).toEqual({ west: 9, north: 5, east: 3, south: 2 });
    expect(LTRB.z.west).toBeCloseTo(2.6, 1);
  }, 900000);

  it("is a real lever - permuting it changes the placement", () => {
    // Not vacuous: if `sweepEdgeOrder` were ignored every arm would be identical
    // and the null below would be satisfied by a lever that never fired.
    const counts = ARMS.map(([, a]) => a.unexplained);
    expect(new Set(counts).size).toBeGreaterThan(1);
    // And it bites HARD - 25 to 76. A lever that barely moved the placement
    // could fail to relocate the residual simply by doing nothing.
    expect(Math.max(...counts)).toBeGreaterThan(70);
    expect(Math.min(...counts)).toBe(25);
  }, 900000);

  it("but WEST stays the enriched edge under every permutation", () => {
    for (const [name, a] of ARMS) {
      expect(topEdge(a), `${name}: expected west to stay on top`).toBe("west");
    }
  }, 900000);

  it("including when west is tried LAST, which refutes the lead", () => {
    // `B, R, T, L` denies west its priority entirely. If the clear order caused
    // the concentration, this is the arm that would move it.
    expect(BRTL.z.west).toBeGreaterThan(BRTL.z.east);
    expect(BRTL.z.west).toBeGreaterThan(BRTL.z.south);
    expect(topEdge(BRTL)).toBe("west");
    // Stronger than the engine's own order, not merely surviving.
    expect(BRTL.z.west).toBeGreaterThan(LTRB.z.west);
  }, 900000);
});
