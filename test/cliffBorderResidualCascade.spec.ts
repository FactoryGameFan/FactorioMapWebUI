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
 * **The cross-chunk cascade is NOT the explanation for the border enrichment.**
 * It is real, it is border-exclusive, and it accounts for **2 of the 25**
 * unexplained cells. The enrichment survives at z = 2.67 (#84).
 *
 * #148 found that the port's only systematic cross-chunk error is the missing
 * destroy cascade, and that every cell it touches is on a chunk border - which
 * made it the first candidate that PREDICTED border-only errors rather than
 * merely being consistent with them. This is that candidate tested against the
 * residual directly, on the 14 regions the enrichment is measured over. No
 * capture.
 *
 * | model | unexplained | on border | z |
 * | --- | --- | --- | --- |
 * | shipped (`rejectAtCrossingStage`, chunk-local) | 25 | 19 | **2.99** |
 * | cross-chunk destroy cascade | 23 | 17 | **2.67** |
 *
 * Adopting the cascade would explain **2** of the 25, both of them border cells,
 * and leave a residual still enriched at 2.67. So the mechanism is a real but
 * small contributor, not the cause. **The border enrichment remains open.**
 *
 * ## Why the answer was nearly assumed instead of measured
 *
 * #143's published "after cascade" row already had a CROSS-CHUNK cascade in it -
 * its harness works on a flat cell map with a 64-tile halo and never restricts
 * propagation to a chunk. So its 23 / 17 / 2.67 was, unrecognised at the time,
 * already the post-cascade number, and the honest read of #148's candidate was
 * available in data committed a day earlier. What was missing was the OTHER row:
 * nobody had measured the residual under the model that actually ships.
 *
 * That row is the contribution here, and it is why the test was still worth
 * running: 25 / 19 / 2.99 is new, and the 25 -> 23 delta is the exact size of
 * the mechanism's claim on the residual.
 *
 * ## The control, and why it is load-bearing
 *
 * The cascade row reproduces `cliffResidualCascadeAudit`'s published **23
 * unexplained, 17 on border** on the same 14 regions. Without that, the shipped
 * row could be measuring a different quantity and the 2-cell delta would mean
 * nothing - the two models must be scored by one definition of "unexplained",
 * which here is #143's: a cell the game killed that neither our own kill set nor
 * the game's own ore lever accounts for.
 *
 * At the plain surplus level (no attribution filter) the same run gives 90 -> 84,
 * and **all 6 cells the cascade removes are on chunk borders** - the #148 result
 * reproduced on a second, larger fixture set.
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
const STEP: readonly (readonly [number, number])[] = [
  [0, -CLIFF_GRID_SIZE],
  [CLIFF_GRID_SIZE, 0],
  [0, CLIFF_GRID_SIZE],
  [-CLIFF_GRID_SIZE, 0],
];

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

function measure() {
  let rawTotal = 0;
  let rawBorder = 0;
  let sSurplus = 0;
  let sSurplusBorder = 0;
  let cSurplus = 0;
  let cSurplusBorder = 0;
  let unkShipped = 0;
  let unkShippedBorder = 0;
  let unkCascade = 0;
  let unkCascadeBorder = 0;
  let fixedByCascade = 0;
  let fixedByCascadeBorder = 0;
  for (let i = 0; i < PAIRS.length; i += 2) {
    const on = PAIRS[i];
    const r = on.region;
    const inR = (p: { x: number; y: number }): boolean =>
      p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
    const off = PAIRS[i + 1];
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
    const cells = new Map<string, number>();
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o !== undefined) cells.set(K(p.x, p.y), o);
    }
    const kills: [number, number][] = [];
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      const code = cliffCodeForOrientation(o);
      const box = cliffCollisionTileBox(code, p.x, p.y);
      let lava = false;
      if (box !== undefined)
        for (let tx = box.left; tx <= box.right; tx++)
          for (let ty = box.top; ty <= box.bottom; ty++) if (tileCollides(tx, ty)) lava = true;
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
    const cascade = new Set(
      [...cells.keys()].filter((k) => {
        const q = k.split(",");
        return inR({ x: Number(q[0]), y: Number(q[1]) });
      }),
    );

    // base rate over the raw placement restricted to the region
    for (const p of all) {
      if (!inR(p)) continue;
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      rawTotal++;
      if (onChunkBorder(p.x, p.y)) rawBorder++;
    }

    for (const k of shipped) {
      if (game.has(k)) continue;
      const q = k.split(",");
      const b = onChunkBorder(Number(q[0]), Number(q[1]));
      sSurplus++;
      if (b) sSurplusBorder++;
      if (!cascade.has(k)) {
        fixedByCascade++;
        if (b) fixedByCascadeBorder++;
      }
    }
    // #143's stricter definition: cells the game killed, that our OWN kill set
    // and the game's ore lever both fail to explain.
    const killSet = new Set(kills.map(([x, y]) => K(x, y)));
    for (const p2 of all) {
      if (!inR(p2)) continue;
      const o = CLIFF_CODE_TO_ORIENTATION[p2.code];
      if (o === undefined) continue;
      const k = K(p2.x, p2.y);
      if (game.has(k)) continue;
      if (killSet.has(k) || oreSuppressed.has(k)) continue;
      const b = onChunkBorder(p2.x, p2.y);
      if (shipped.has(k)) {
        unkShipped++;
        if (b) unkShippedBorder++;
      }
      if (cascade.has(k)) {
        unkCascade++;
        if (b) unkCascadeBorder++;
      }
    }
    for (const k of cascade) {
      if (game.has(k)) continue;
      cSurplus++;
      const q = k.split(",");
      if (onChunkBorder(Number(q[0]), Number(q[1]))) cSurplusBorder++;
    }
  }
  const p = rawBorder / rawTotal;
  const z = (k: number, n: number): number => (k - n * p) / Math.sqrt(n * p * (1 - p));
  return {
    baseRate: p,
    rawTotal,
    surplus: {
      shipped: { n: sSurplus, onBorder: sSurplusBorder },
      cascade: { n: cSurplus, onBorder: cSurplusBorder },
      fixed: fixedByCascade,
      fixedOnBorder: fixedByCascadeBorder,
    },
    unexplained: {
      shipped: { n: unkShipped, onBorder: unkShippedBorder, z: z(unkShippedBorder, unkShipped) },
      cascade: { n: unkCascade, onBorder: unkCascadeBorder, z: z(unkCascadeBorder, unkCascade) },
    },
  };
}

const M = measure();

describe("Vulcanus cliffs: the cross-chunk cascade does NOT explain the border enrichment (#84)", () => {
  it("reproduces the published post-cascade residual - 23 unexplained, 17 on a border", () => {
    // THE CONTROL. Without it the shipped row below could be measuring a
    // different quantity and the 2-cell delta would mean nothing.
    expect(M.rawTotal).toBe(9056);
    expect(M.baseRate).toBeCloseTo(0.4617, 4);
    expect(M.unexplained.cascade.n).toBe(23);
    expect(M.unexplained.cascade.onBorder).toBe(17);
    expect(M.unexplained.cascade.z).toBeCloseTo(2.67, 2);
  }, 900000);

  it("measures the residual under the model that SHIPS - 25 unexplained, z 2.99", () => {
    // New: #143 never scored the chunk-local model, only a post-filter one.
    expect(M.unexplained.shipped.n).toBe(25);
    expect(M.unexplained.shipped.onBorder).toBe(19);
    expect(M.unexplained.shipped.z).toBeCloseTo(2.99, 2);
  }, 900000);

  it("so the cascade explains 2 of the 25, and the enrichment SURVIVES", () => {
    const explained = M.unexplained.shipped.n - M.unexplained.cascade.n;
    expect(explained).toBe(2);
    // Both are border cells, so it does bite where the signal lives...
    expect(M.unexplained.shipped.onBorder - M.unexplained.cascade.onBorder).toBe(2);
    // ...and it is still nowhere near enough. THE REFUTATION: a mechanism that
    // explained the enrichment would drive this toward the base rate, not leave
    // it above 2.6.
    expect(M.unexplained.cascade.z).toBeGreaterThan(2.6);
    expect(explained / M.unexplained.shipped.n).toBeLessThan(0.1);
  }, 900000);

  it("reproduces #148's border-exclusivity on this larger fixture set", () => {
    expect(M.surplus.shipped.n).toBe(90);
    expect(M.surplus.cascade.n).toBe(84);
    expect(M.surplus.fixed).toBe(6);
    // Every cell the cascade removes is on a chunk border - 6 for 6, on 14
    // regions here against 3 in #148.
    expect(M.surplus.fixedOnBorder).toBe(M.surplus.fixed);
  }, 900000);
});
