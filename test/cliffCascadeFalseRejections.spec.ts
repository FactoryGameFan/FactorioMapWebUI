import { describe, expect, it } from "vite-plus/test";

import batch from "./fixtures/oracle-vulcanus-cliff-entities-border-batch.seed123456.json";
import more from "./fixtures/oracle-vulcanus-cliff-entities-more-regions.seed123456.json";
import oreRegions from "./fixtures/oracle-vulcanus-cliff-ore-direction-regions.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
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
 * **The destruction cascade costs NOTHING of its own: conditional on a correct
 * root kill its precision is 1.000, 27 for 27** (#84). The "2 more false
 * rejections" #143 priced into the shipping gain are not a cascade defect at
 * all - they are two pre-existing precision defects being propagated.
 *
 * #143 measured that applying the cascade to the port's own kill set trades 10
 * missed cells for 2 new false rejections, a net 8, and left the gain untaken
 * with an explicit instruction: **look at the 2 new false rejections before the
 * 10 wins**, because #134 recorded a gate the port does not model
 * (`Cliff::destroyEnd` refuses to `forceDestroy` when entity flag bit 4 of
 * `+0x6e` is set, leaving the orientation UNCHANGED). This is that look.
 *
 * ## The gate is not needed to explain either cell
 *
 * Splitting every SECONDARY removal - a cell the cascade took that was never
 * directly killed - by whether the game also destroyed the **root** of its
 * chain:
 *
 * | root kill | removals | wrong |
 * | --- | --- | --- |
 * | the game destroyed it too (correct root) | **27** | **0** |
 * | the game KEPT it (our false rejection) | 2 | **2** |
 *
 * The two rows are the whole story. Every removal descending from a correct
 * kill agrees with the game; both disagreements descend from a kill that was
 * already wrong. One root was falsely rejected by the ORE rule, the other by
 * the LAVA rule, so this is not one rule's problem either.
 *
 * So #134's gate is **unsupported here rather than refuted** - there is simply
 * nothing left for it to explain in this sample. A cascade that force-destroys
 * every single-ended neighbour reproduces the game exactly, 27 times out of 27,
 * whenever it is fed a correct kill.
 *
 * ## What that does to the adoption decision
 *
 * The net-8 gain is real and its cost is **not** intrinsic. Adopting the
 * cascade does not make the port worse at anything; it makes two existing
 * precision defects visible at two extra cells. Fixing either root removes its
 * knock-on for free, and neither root needs the cascade to be fixed.
 *
 * ## The control that nearly went the wrong way
 *
 * The root of the second cell sits at `y = 2998.5`, **outside** its region's
 * `y0 = 3000`. Checking it against the region-filtered game set reports "the
 * game destroyed it" for every root that merely sits outside the window, which
 * would have made that cell look like a genuine cascade defect. `gameAll` below
 * is deliberately UNFILTERED for exactly that reason - the dump carries cliffs
 * beyond the region, and the root is present in it. Same family as the clamped
 * comparison #139 hit and `clamped-comparison-is-vacuous`.
 *
 * Note also what the orientations do NOT prove. Both surviving cells are
 * single-ended (`none-to-south`, `north-to-none`), so "kept with orientation
 * unchanged" is the only alternative to "destroyed" - there is no third state
 * to observe, and the unchanged orientation is therefore consistent with the
 * gate without being evidence for it. The root check is what carries the
 * argument; this is recorded so the orientation column is not over-read.
 *
 * ## Coverage, measured by planting rather than claimed
 *
 * | planted into the cascade | this spec |
 * | --- | --- |
 * | the neighbour loop never runs | **fails 4** |
 * | every trim destroys (`next = -1`) | **fails 4** - 908 false after, not 14 |
 * | the `isCliffConnected` parity guard is dropped | **PASSES** |
 *
 * That last row is a real gap, not a formality. `destroyEnd` is already a no-op
 * on a side the orientation does not have, so the guard only bites when a
 * neighbour presents the facing side with the WRONG PARITY - and no cell in
 * these 14 regions does. **So this spec does not cover the parity rule**, and a
 * green run here must not be read as evidence for it. `cliffConnections.spec.ts`
 * is what pins that, from the orientation tables directly.
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
  label?: string;
  region: { x0: number; y0: number; x1: number; y1: number };
  cliffs: { x: number; y: number; name: string; orientation: string }[];
}
/** Cases are ON/OFF pairs in capture order, which is what the `i += 2` relies on. */
const PAIRS: Case[] = [
  ...(batch.cases as unknown as Case[]),
  ...(more.cases as unknown as Case[]),
  ...(oreRegions.cases as unknown as Case[]),
];

interface Victim {
  x: number;
  y: number;
  onChunkBorder: boolean;
  placedOrientation: string;
  gameOrientation: string;
  rootReason: string;
  rootInRegion: boolean;
  rootGameKept: boolean;
  rootPlacedOrientation: string;
  rootGameOrientation: string;
}

interface Tally {
  regions: number;
  falseBefore: number;
  falseAfter: number;
  /** Cascade removals whose root the game ALSO destroyed. */
  goodRootTotal: number;
  goodRootFalse: number;
  /** Cascade removals descending from a kill the game did not make. */
  badRootTotal: number;
  badRootFalse: number;
  victims: Victim[];
}

function audit(cases: Case[]): Tally {
  const t: Tally = {
    regions: cases.length / 2,
    falseBefore: 0,
    falseAfter: 0,
    goodRootTotal: 0,
    goodRootFalse: 0,
    badRootTotal: 0,
    badRootFalse: 0,
    victims: [],
  };
  for (let i = 0; i < cases.length; i += 2) {
    const on = cases[i];
    const r = on.region;
    const inR = (p: { x: number; y: number }): boolean =>
      p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
    const gameOri = new Map<string, string>();
    for (const e of on.cliffs)
      if (e.name === "cliff-vulcanus" && inR(e)) gameOri.set(K(e.x, e.y), e.orientation);
    const game = new Set(gameOri.keys());
    // UNFILTERED - see the header. A root just outside the region is still in
    // the dump, and testing it against `game` would call every such root
    // "destroyed by the game" purely because of the window.
    const gameAllOri = new Map<string, string>();
    for (const e of on.cliffs)
      if (e.name === "cliff-vulcanus") gameAllOri.set(K(e.x, e.y), e.orientation);

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
    const killReason = new Map<string, string>();
    for (const p of all) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      const code = cliffCodeForOrientation(o);
      const box = cliffCollisionTileBox(code, p.x, p.y);
      let lava = false;
      if (box !== undefined)
        for (let tx = box.left; tx <= box.right; tx++)
          for (let ty = box.top; ty <= box.bottom; ty++) if (isLava(tx, ty)) lava = true;
      if (lava || oreRejects(code, p.x, p.y)) {
        kills.push([p.x, p.y]);
        killReason.set(K(p.x, p.y), lava ? "lava" : "ore");
      }
    }

    /** Every removed cell records the ROOT kill its chain descended from. */
    const rootOf = new Map<string, string>();
    const destroy = (x: number, y: number, root: string): void => {
      const mine = cells.get(K(x, y));
      if (mine === undefined) return;
      cells.delete(K(x, y));
      rootOf.set(K(x, y), root);
      for (const side of connectedSides(mine)) {
        const st = STEP[side];
        if (st === undefined) continue;
        const nx = x + st[0];
        const ny = y + st[1];
        const theirs = cells.get(K(nx, ny));
        if (theirs === undefined) continue;
        if (!isCliffConnected(side, mine, theirs)) continue;
        const next = destroyEnd(theirs, oppositeSide(side));
        if (next === -1) destroy(nx, ny, root);
        else cells.set(K(nx, ny), next);
      }
    };
    for (const [x, y] of kills) destroy(x, y, K(x, y));
    const killSet = new Set(kills.map(([x, y]) => K(x, y)));

    for (const [k, placedOri] of raw) {
      const parts = k.split(",");
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!inR({ x, y })) continue;
      const gameKept = game.has(k);
      if (gameKept && killSet.has(k)) t.falseBefore++;
      if (gameKept && !cells.has(k)) t.falseAfter++;
      if (cells.has(k) || killSet.has(k)) continue;

      // A SECONDARY removal: the cascade took it, nothing killed it directly.
      const root = rootOf.get(k) ?? "?";
      const rootGameKept = gameAllOri.has(root);
      if (rootGameKept) {
        t.badRootTotal++;
        if (gameKept) t.badRootFalse++;
      } else {
        t.goodRootTotal++;
        if (gameKept) t.goodRootFalse++;
      }
      if (!gameKept) continue;

      const rp = root.split(",");
      const rx = Number(rp[0]);
      const ry = Number(rp[1]);
      t.victims.push({
        x,
        y,
        onChunkBorder: onChunkBorder(x, y),
        placedOrientation: CLIFF_ORIENTATION_NAMES[placedOri],
        gameOrientation: gameOri.get(k) ?? "(absent)",
        rootReason: killReason.get(root) ?? "?",
        rootInRegion: rx >= r.x0 && rx < r.x1 && ry >= r.y0 && ry < r.y1,
        rootGameKept,
        rootPlacedOrientation:
          raw.get(root) === undefined ? "?" : CLIFF_ORIENTATION_NAMES[raw.get(root) as number],
        rootGameOrientation: gameAllOri.get(root) ?? "(absent)",
      });
    }
  }
  return t;
}

const T = audit(PAIRS);

describe("Vulcanus cliffs: the cascade's 2 false rejections are knock-ons, not cascade defects (#84)", () => {
  it("reproduces #143's ledger - 12 false before, 14 after, over 14 regions", () => {
    // The tie to the run that priced the gain. Without this the split below
    // could be measuring a different kill set.
    expect(T.regions).toBe(14);
    expect(T.falseBefore).toBe(12);
    expect(T.falseAfter).toBe(14);
  }, 900000);

  describe("splitting every secondary removal by whether its ROOT was a correct kill", () => {
    it("is right 27 times out of 27 when the root was correct", () => {
      expect(T.goodRootTotal).toBe(27);
      expect(T.goodRootFalse).toBe(0);
      // Not vacuous: "0 wrong" would also be satisfied by a cascade that never
      // fired, so the sample size is asserted alongside it.
      expect(T.goodRootTotal).toBeGreaterThan(0);
    }, 900000);

    it("and wrong both times the root was a false rejection", () => {
      expect(T.badRootTotal).toBe(2);
      expect(T.badRootFalse).toBe(2);
      // Which is the whole of the cascade's measured cost: every cell in the
      // `falseAfter - falseBefore` increment sits in this row.
      expect(T.falseAfter - T.falseBefore).toBe(T.badRootFalse);
    }, 900000);
  });

  it("names the two, and neither root was destroyed by the game", () => {
    expect(T.victims).toHaveLength(2);
    const [a, b] = [...T.victims].sort((p, q) => p.x - q.x);

    expect(a).toMatchObject({
      x: 1318,
      y: 2618.5,
      placedOrientation: "none-to-south",
      // Single-ended, so "kept unchanged" is the only alternative to destroyed.
      gameOrientation: "none-to-south",
      rootReason: "ore",
      rootInRegion: true,
      rootGameKept: true,
      rootGameOrientation: "north-to-east",
    });
    expect(b).toMatchObject({
      x: 3134,
      y: 3002.5,
      placedOrientation: "north-to-none",
      gameOrientation: "north-to-none",
      rootReason: "lava",
      // OUTSIDE its region - the reason the root check must not be filtered.
      rootInRegion: false,
      rootGameKept: true,
      rootGameOrientation: "east-to-south",
    });

    // Both roots survive in the game with the orientation we placed them at, so
    // neither was trimmed either - they were not touched at all.
    for (const v of T.victims) expect(v.rootGameOrientation).toBe(v.rootPlacedOrientation);
    // One ore, one lava: this is not a single rule's precision problem.
    expect(new Set(T.victims.map((v) => v.rootReason))).toEqual(new Set(["ore", "lava"]));
  }, 900000);
});
