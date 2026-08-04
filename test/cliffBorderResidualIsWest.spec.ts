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
  CLIFF_ORIENTATION_NAMES,
  cliffCollisionTileBox,
} from "../src/noise/cliffs/cliffCatalog";
import {
  applyCliffConnections,
  cliffCodeForOrientation,
  connectedSides,
  onChunkBorder,
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
 * **The border residual is a WEST-edge residual, and `updateConnections` -
 * the last unapplied engine pass - explains NONE of it** (#84).
 *
 * Three mechanisms have now failed to explain the chunk-border enrichment: the
 * orientation-reach rival (#134), cascade double-counting (#143), and the
 * cross-chunk destroy cascade (#149, which got 2 of 25). This stops proposing
 * mechanisms and describes the 23 survivors instead. No capture.
 *
 * ## 1. `updateConnections` removes ZERO of the 23
 *
 * It is the one engine pass that runs **exclusively on the chunk's outer ring**
 * (`applyCliffs` gates it on the fifth argument of `tryToAddCliff`), and no audit
 * had ever applied it - #143 excluded it deliberately as an upper bound. It is
 * therefore the most natural remaining candidate for a border-shaped defect, and
 * it accounts for **none** of them: 23 survive the cascade alone and the same 23
 * survive cascade + `updateConnections`. A fourth mechanism ruled out, and the
 * one that had the best prior.
 *
 * ## 2. The survivors are not evenly spread around the ring - they are WEST
 *
 * 17 of the 23 are on a chunk border, 6 are interior. Splitting those 17 by
 * which edge they sit on, against the base rate MEASURED over every raw border
 * cell in the same regions rather than an assumed uniform one:
 *
 * | edge | survivors | expected | base rate | z |
 * | --- | --- | --- | --- | --- |
 * | **west** | **9** | 3.82 | 22.5% | **+3.01** |
 * | north | 5 | 3.81 | 22.4% | +0.69 |
 * | east | 2 | 4.81 | 28.3% | -1.51 |
 * | south | 1 | 4.57 | 26.9% | -1.95 |
 *
 * **The base rate is what makes this a finding rather than a shape of the
 * lattice.** West carries the FEWEST border cells (22.5%, against east's 28.3%)
 * and the MOST survivors. Four edges were tested, so a Bonferroni-corrected
 * two-sided p for west is ~0.005 - still significant, and stated because
 * scoring four bins and reporting the biggest is exactly how a 3-sigma result
 * becomes noise.
 *
 * This is a sharper localisation than the border enrichment itself (z = 2.67):
 * "on a chunk border" is now "on the WEST edge of a chunk", which is a
 * DIRECTIONAL signature and therefore points at a mechanism with a direction.
 *
 * ## 3. The lead that suggests, and why it is not asserted here
 *
 * `fixImpossibleCellsSweep` clears the first **clearable** edge in the order
 * `L, T, R, B` - west first, north second - and an edge is clearable only if it
 * is **not on the chunk's outer boundary**. West + north is 14 of the 17. That
 * is the only rule in the port whose asymmetry matches the observed one, and it
 * is already known to be the named cause of Nauvis's ~6% residual.
 *
 * It is recorded as a LEAD, not a finding: this spec measures where the
 * survivors are, not why. Testing it needs a discriminator that separates the
 * sweep's edge-order from anything else west-flavoured - and note
 * `ore-recall-gap-is-six-cells` independently found all six of its cells with
 * their nearest resource to the west, so "something is west-flavoured" has more
 * than one possible source here.
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
const SIDE_NAMES = ["north", "east", "south", "west"];

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

/** Which chunk edges the cell sits on, by cell index within its 8x8 chunk. */
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

interface Survivor {
  region: string;
  x: number;
  y: number;
  orientation: string;
  ends: string[];
  chunkEdges: string[];
  isCorner: boolean;
  onBorder: boolean;
  endsCrossingBoundary: string[];
  removedByUpdateConnections: boolean;
}

function measure() {
  const survivors: unknown[] = [];
  const edgeBase: Record<string, number> = {};
  let unkShipped = 0;
  let unkCascade = 0;
  let unkFull = 0;
  let unkFullBorder = 0;
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
    const rawOri = new Map<string, number>();
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o !== undefined) rawOri.set(K(p.x, p.y), o);
    }
    const killSet = new Set<string>();
    const collides = (orientation: number, x: number, y: number): boolean => {
      const code = cliffCodeForOrientation(orientation);
      const box = cliffCollisionTileBox(code, x, y);
      if (box !== undefined)
        for (let tx = box.left; tx <= box.right; tx++)
          for (let ty = box.top; ty <= box.bottom; ty++) if (tileCollides(tx, ty)) return true;
      return oreRejects(code, x, y);
    };
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o !== undefined && collides(o, p.x, p.y)) killSet.add(K(p.x, p.y));
    }

    // cascade only (no updateConnections)
    const cascadeCells = new Set(
      applyCliffConnections(all, { collides, noUpdateConnections: true }).map((c) => K(c.x, c.y)),
    );
    // cascade + updateConnections on the chunk's outer ring - the engine pass
    // no audit has applied yet.
    const fullCells = new Set(applyCliffConnections(all, { collides }).map((c) => K(c.x, c.y)));

    // BASE RATE: how the raw placement's own border cells split by edge, which
    // is the null the survivors' split must be read against.
    for (const p of all) {
      if (!inR(p)) continue;
      if (CLIFF_CODE_TO_ORIENTATION[p.code] === undefined) continue;
      for (const e of edgesOf(p.x, p.y)) edgeBase[e] = (edgeBase[e] ?? 0) + 1;
    }
    for (const p of all) {
      if (!inR(p)) continue;
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      const k = K(p.x, p.y);
      if (game.has(k)) continue;
      if (killSet.has(k) || oreSuppressed.has(k)) continue;
      if (shipped.has(k)) unkShipped++;
      if (cascadeCells.has(k)) unkCascade++;
      if (fullCells.has(k)) {
        unkFull++;
        if (onChunkBorder(p.x, p.y)) unkFullBorder++;
      }
      // characterise the cascade-only survivors (the published 23)
      if (cascadeCells.has(k)) {
        const sides = connectedSides(o).map((s) => SIDE_NAMES[s]);
        const edges = edgesOf(p.x, p.y);
        survivors.push({
          region: on.label ?? K(r.x0, r.y0),
          x: p.x,
          y: p.y,
          orientation: CLIFF_ORIENTATION_NAMES[o],
          ends: sides,
          chunkEdges: edges,
          isCorner: edges.length > 1,
          onBorder: onChunkBorder(p.x, p.y),
          // does an end point ACROSS a chunk boundary?
          endsCrossingBoundary: sides.filter((s) => edges.includes(s)),
          removedByUpdateConnections: !fullCells.has(k),
        });
      }
    }
  }
  return { unkShipped, unkCascade, unkFull, unkFullBorder, edgeBase, survivors };
}

const M = measure();
const S = M.survivors as Survivor[];
const edgeTotal = Object.values(M.edgeBase).reduce((a, b) => a + b, 0);
const byEdge = (e: string): number => S.filter((s) => s.chunkEdges.includes(e)).length;
const nBorder = S.filter((s) => s.onBorder).length;
const zFor = (e: string): number => {
  const p = M.edgeBase[e] / edgeTotal;
  return (byEdge(e) - nBorder * p) / Math.sqrt(nBorder * p * (1 - p));
};

describe("Vulcanus cliffs: the border residual is a WEST-edge residual (#84)", () => {
  it("carries the published residual forward - 25 shipped, 23 after the cascade", () => {
    // The control tying this to #149 and #143.
    expect(M.unkShipped).toBe(25);
    expect(M.unkCascade).toBe(23);
    expect(S).toHaveLength(23);
  }, 900000);

  it("shows updateConnections explains NONE of them", () => {
    // The pass that runs exclusively on the chunk's outer ring, never applied by
    // any prior audit, and the best remaining prior for a border-shaped defect.
    expect(M.unkFull).toBe(23);
    expect(M.unkFull).toBe(M.unkCascade);
    expect(S.filter((s) => s.removedByUpdateConnections)).toHaveLength(0);
  }, 900000);

  it("splits 17 border / 6 interior", () => {
    expect(nBorder).toBe(17);
    expect(S.length - nBorder).toBe(6);
    expect(M.unkFullBorder).toBe(17);
  }, 900000);

  it("concentrates on the WEST edge at z = 3.0, against a MEASURED base rate", () => {
    expect(byEdge("west")).toBe(9);
    expect(byEdge("north")).toBe(5);
    expect(byEdge("east")).toBe(2);
    expect(byEdge("south")).toBe(1);

    // West carries the FEWEST border cells and the MOST survivors - which is
    // what rules out "the lattice just has more west cells".
    const westBase = M.edgeBase.west / edgeTotal;
    const eastBase = M.edgeBase.east / edgeTotal;
    expect(westBase).toBeLessThan(eastBase);
    expect(westBase).toBeCloseTo(0.225, 3);

    expect(zFor("west")).toBeGreaterThan(3);
    // And it is the only edge that is high: nothing else clears 1 sigma.
    for (const e of ["east", "south"]) expect(zFor(e)).toBeLessThan(0);
    expect(zFor("north")).toBeLessThan(1);

    // Not vacuous: a real sample, not a handful.
    expect(nBorder).toBeGreaterThan(15);
  }, 900000);
});
