import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
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
  cliffCodeForOrientation,
  onChunkBorder,
  connectedSides,
  destroyEnd,
  isCliffConnected,
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
 * **The port's ONLY systematic cross-chunk error is the missing destroy
 * cascade, and every cell it touches is on a CHUNK BORDER** (#84).
 *
 * #143 priced adopting the cascade at a net **+8** and left it untaken. That
 * figure does not survive being measured against the model that actually ships.
 * It was scored against a POST-FILTER baseline - kills applied, no cascade -
 * but `renderVulcanusCliffs` ships `rejectAtCrossingStage`, which zeroes a
 * rejected cell's four edge registers so its neighbours lose the shared edge.
 * That already reproduces most of the cascade. Scored on the error budget's own
 * three regions:
 *
 * | model | port | surplus | missing | wrong orientation |
 * | --- | --- | --- | --- | --- |
 * | shipped (`rejectAtCrossingStage`) | 1547 | 22 | 6 | 21 |
 * | **destroy cascade** | 1545 | **20** | 6 | **18** |
 * | cascade, forbidden to cross a chunk | 1547 | 22 | 6 | 21 |
 *
 * So the real gain is **+2 positions and +3 orientations**, not +8 - and the
 * third row is the finding. **Restricting the cascade to within a chunk
 * reproduces the shipped model exactly**, on all four counts. Everything the
 * cascade buys is a cascade that CROSSES A CHUNK BOUNDARY, which
 * `rejectAtCrossingStage` cannot do by construction: each chunk owns a private
 * copy of its shared edges, which is exactly what keeps that pass chunk-local
 * and worker tiling byte-identical.
 *
 * ## Why this matters more than the two cells
 *
 * All **six** cells where the two models disagree are `onChunkBorder`, and
 * every one the game has an opinion about is a correction - 2 surplus removals,
 * and 3 orientations that move to the game's exact value (`none-to-east`,
 * `north-to-none`, `none-to-west`).
 *
 * That is the same place the residual's unexplained cells concentrate. The
 * chunk-border enrichment has survived both of its plausible deflations - the
 * orientation-reach rival (#134) and cascade double-counting (#143) - and stands
 * at z = 2.67. **A chunk-local rejection model that cannot cascade across a
 * chunk boundary is a mechanism of exactly that shape**, and it is the first
 * candidate that predicts border-only errors rather than merely being
 * consistent with them.
 *
 * This spec does NOT claim the enrichment is explained: 6 cells here against 23
 * unexplained there, and these are scored on different fixtures. It establishes
 * the mechanism exists and is border-exclusive, which is what makes it worth
 * testing against the residual directly.
 *
 * ## Adoption, and what it costs
 *
 * Not adopted here. The gain IS the cross-chunk part, so it needs a one-chunk
 * halo in the placement pass - and `test/cliffCellBounds.spec.ts` pins the
 * tiled-to-whole noise ratio below **1.1** precisely to stop that kind of
 * inflation. A 128px worker tile is 4x4 chunks and would become 6x6, ~2.25x the
 * cliff-pass cell work by geometry (not measured). Buying +2 positions for that
 * is a trade to make deliberately, with a benchmark, not as a side effect.
 *
 * The cascade's reach is bounded at **one hop** (`maxDepth` 1, `maxDist` 4
 * tiles = one grid step), so the halo would only ever need to be one chunk -
 * that part is not the obstacle.
 */

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
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
const SHIPPED = {
  ...BANDS,
  tileCollides,
  cellRejects: oreRejects,
  rejectAtCrossingStage: true,
};
const STEP: readonly (readonly [number, number])[] = [
  [0, -CLIFF_GRID_SIZE],
  [CLIFF_GRID_SIZE, 0],
  [0, CLIFF_GRID_SIZE],
  [-CLIFF_GRID_SIZE, 0],
];

interface Ent {
  x: number;
  y: number;
  name: string;
  orientation: string;
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
const cases = entities.cases as unknown as Case[];

interface Score {
  port: number;
  matched: number;
  surplus: number;
  missing: number;
  wrongOri: number;
}
interface Row {
  at: string;
  game: number;
  shipped: Score;
  cascade: Score;
  intra: Score;
}
interface Diff {
  kind: string;
  x: number;
  y: number;
  onChunkBorder: boolean;
  wasSurplus?: boolean;
  shipped?: string;
  cascade?: string;
  game?: string;
}

function measure() {
  const rows: Row[] = [];
  const diffs: Diff[] = [];
  let maxDepth = 0;
  let maxDist = 0;
  for (const c of cases) {
    const r = c.region;
    const inR = (p: { x: number; y: number }): boolean =>
      p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
    const gameOri = new Map<string, string>();
    for (const e of c.cliffs)
      if (e.name === "cliff-vulcanus" && inR(e)) gameOri.set(key(e.x, e.y), e.orientation);
    const game = new Set(gameOri.keys());

    // --- Model A: what ships today.
    const shippedOri = new Map<string, string>();
    for (const p of makeCliffPlacementFromFields(fields, SHIPPED).placedCells(
      r.x0,
      r.y0,
      r.x1,
      r.y1,
    )) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      shippedOri.set(key(p.x, p.y), o === undefined ? "?" : CLIFF_ORIENTATION_NAMES[o]);
    }
    const shipped = new Set(shippedOri.keys());

    // --- Model B: raw placement, explicit kills, destroy cascade. Halo so a
    // cascade entering the region from outside is modelled.
    const all = makeCliffPlacementFromFields(fields, BANDS).placedCells(
      r.x0 - 64,
      r.y0 - 64,
      r.x1 + 64,
      r.y1 + 64,
    );
    const cells = new Map<string, number>();
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o !== undefined) cells.set(key(p.x, p.y), o);
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
    const destroy = (x: number, y: number, depth = 0, rx = x, ry = y): void => {
      maxDepth = Math.max(maxDepth, depth);
      maxDist = Math.max(maxDist, Math.max(Math.abs(x - rx), Math.abs(y - ry)));
      const mine = cells.get(key(x, y));
      if (mine === undefined) return;
      cells.delete(key(x, y));
      for (const side of connectedSides(mine)) {
        const st = STEP[side];
        if (st === undefined) continue;
        const nx = x + st[0];
        const ny = y + st[1];
        const theirs = cells.get(key(nx, ny));
        if (theirs === undefined) continue;
        if (!isCliffConnected(side, mine, theirs)) continue;
        const next = destroyEnd(theirs, oppositeSide(side));
        if (next === -1) destroy(nx, ny, depth + 1, rx, ry);
        else cells.set(key(nx, ny), next);
      }
    };
    for (const [x, y] of kills) destroy(x, y);

    // --- Model C: identical, but the cascade may not cross a chunk boundary.
    const cells2 = new Map<string, number>();
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o !== undefined) cells2.set(key(p.x, p.y), o);
    }
    const chOf = (vx: number, vy: number): string => {
      const ix = Math.floor((vx - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE / 8);
      const iy = Math.floor((vy - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE / 8);
      return `${String(ix)},${String(iy)}`;
    };
    const destroy2 = (x: number, y: number): void => {
      const mine = cells2.get(key(x, y));
      if (mine === undefined) return;
      cells2.delete(key(x, y));
      for (const side of connectedSides(mine)) {
        const st = STEP[side];
        if (st === undefined) continue;
        const nx = x + st[0];
        const ny = y + st[1];
        if (chOf(nx, ny) !== chOf(x, y)) continue;
        const theirs = cells2.get(key(nx, ny));
        if (theirs === undefined) continue;
        if (!isCliffConnected(side, mine, theirs)) continue;
        const next = destroyEnd(theirs, oppositeSide(side));
        if (next === -1) destroy2(nx, ny);
        else cells2.set(key(nx, ny), next);
      }
    };
    for (const [x, y] of kills) destroy2(x, y);
    const intraOri = new Map<string, string>();
    for (const [k, o] of cells2) {
      const p = k.split(",");
      if (inR({ x: Number(p[0]), y: Number(p[1]) })) intraOri.set(k, CLIFF_ORIENTATION_NAMES[o]);
    }
    const intra = new Set(intraOri.keys());
    const cascadeOri = new Map<string, string>();
    for (const [k, o] of cells) {
      const p = k.split(",");
      if (inR({ x: Number(p[0]), y: Number(p[1]) })) cascadeOri.set(k, CLIFF_ORIENTATION_NAMES[o]);
    }
    const cascade = new Set(cascadeOri.keys());

    const score = (port: Set<string>, ori: Map<string, string>) => {
      const hits = [...port].filter((k) => game.has(k));
      const wrongOri = hits.filter((k) => ori.get(k) !== gameOri.get(k)).length;
      return {
        port: port.size,
        matched: hits.length,
        surplus: port.size - hits.length,
        missing: [...game].filter((k) => !port.has(k)).length,
        wrongOri,
      };
    };
    // cells where shipped and cascade disagree
    for (const k of shipped) {
      if (!cascade.has(k)) {
        const q = k.split(",");
        diffs.push({
          kind: "removed",
          x: Number(q[0]),
          y: Number(q[1]),
          onChunkBorder: onChunkBorder(Number(q[0]), Number(q[1])),
          wasSurplus: !game.has(k),
        });
      }
    }
    for (const k of cascade) {
      if (shipped.has(k) && cascadeOri.get(k) !== shippedOri.get(k)) {
        const q = k.split(",");
        diffs.push({
          kind: "reoriented",
          x: Number(q[0]),
          y: Number(q[1]),
          onChunkBorder: onChunkBorder(Number(q[0]), Number(q[1])),
          shipped: shippedOri.get(k),
          cascade: cascadeOri.get(k),
          game: gameOri.get(k),
        });
      }
    }
    rows.push({
      at: key(r.x0, r.y0),
      game: game.size,
      shipped: score(shipped, shippedOri),
      cascade: score(cascade, cascadeOri),
      intra: score(intra, intraOri),
    });
  }
  const tot = (
    m: "shipped" | "cascade" | "intra",
    f: "surplus" | "missing" | "matched" | "port" | "wrongOri",
  ): number => rows.reduce((a: number, b: Row) => a + b[m][f], 0);
  const summary = {
    game: rows.reduce((a: number, b: Row) => a + b.game, 0),
    shipped: {
      port: tot("shipped", "port"),
      matched: tot("shipped", "matched"),
      surplus: tot("shipped", "surplus"),
      missing: tot("shipped", "missing"),
      wrongOri: tot("shipped", "wrongOri"),
    },
    intra: {
      port: tot("intra", "port"),
      matched: tot("intra", "matched"),
      surplus: tot("intra", "surplus"),
      missing: tot("intra", "missing"),
      wrongOri: tot("intra", "wrongOri"),
    },
    cascade: {
      port: tot("cascade", "port"),
      matched: tot("cascade", "matched"),
      surplus: tot("cascade", "surplus"),
      missing: tot("cascade", "missing"),
      wrongOri: tot("cascade", "wrongOri"),
    },
  };
  return { summary, reach: { maxDepth, maxDist }, diffs };
}

const M = measure();

describe("Vulcanus cliffs: the cascade's whole gain is CROSS-CHUNK (#84)", () => {
  it("prices the cascade against the model that SHIPS, not a post-filter", () => {
    expect(M.summary.game).toBe(1531);
    expect(M.summary.shipped).toEqual({
      port: 1547,
      matched: 1525,
      surplus: 22,
      missing: 6,
      wrongOri: 21,
    });
    expect(M.summary.cascade).toEqual({
      port: 1545,
      matched: 1525,
      surplus: 20,
      missing: 6,
      wrongOri: 18,
    });
    // +2 positions and +3 orientations - NOT #143's +8, which was scored
    // against a post-filter baseline this repo does not ship.
    expect(M.summary.shipped.surplus - M.summary.cascade.surplus).toBe(2);
    expect(M.summary.shipped.wrongOri - M.summary.cascade.wrongOri).toBe(3);
    // Recall is untouched: nothing the game kept is lost.
    expect(M.summary.cascade.missing).toBe(M.summary.shipped.missing);
  }, 900000);

  it("is byte-identical to the shipped model when forbidden to cross a chunk", () => {
    // THE FINDING. Every count, not just the headline one.
    expect(M.summary.intra).toEqual(M.summary.shipped);
  }, 900000);

  it("reaches exactly one hop, so a one-chunk halo would suffice", () => {
    expect(M.reach.maxDepth).toBe(1);
    expect(M.reach.maxDist).toBe(4);
  }, 900000);

  it("changes only chunk-border cells, and every scoreable change is a correction", () => {
    expect(M.diffs).toHaveLength(6);
    // Border-EXCLUSIVE, not merely border-enriched.
    expect(M.diffs.filter((d) => d.onChunkBorder)).toHaveLength(6);

    const removed = M.diffs.filter((d) => d.kind === "removed");
    expect(removed).toHaveLength(2);
    // Both removals took a cell the game does not have.
    expect(removed.every((d) => d.wasSurplus === true)).toBe(true);

    const reoriented = M.diffs.filter((d) => d.kind === "reoriented");
    expect(reoriented).toHaveLength(4);
    // Of those, the ones the game has an opinion on all move TO its value, and
    // none moves away from it.
    const scoreable = reoriented.filter((d) => d.game !== undefined);
    expect(scoreable).toHaveLength(3);
    expect(scoreable.every((d) => d.cascade === d.game)).toBe(true);
    expect(scoreable.every((d) => d.shipped !== d.game)).toBe(true);
  }, 900000);
});
