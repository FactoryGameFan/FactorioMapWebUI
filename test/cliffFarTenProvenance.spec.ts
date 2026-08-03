import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_ORIENTATION_NAMES,
  cliffCollisionTileBox,
} from "../src/noise/cliffs/cliffCatalog";
import {
  CLIFF_ORIENTATION_ENDS,
  applyCliffConnections,
  cliffCodeForOrientation,
  connectedSides,
  onChunkBorder,
  oppositeSide,
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
 * **The far ten are DESTROYED cliffs, not cliffs the game never queued** (#84).
 *
 * `test/cliffDestructionResidual.spec.ts` (#114) reduced the whole Vulcanus cliff
 * residual to 31 cells where `Surface::wouldCollide` and our stand-in disagree,
 * and `test/cliffCollisionResidualShape.spec.ts` (#115) split the 25 missed
 * destructions into a near group that a lava box could plausibly reach and a far
 * group of ten with no lava within twelve tiles. #115's handoff named the first
 * thread to pull and named it unmeasured:
 *
 * > The whole `applyCliffs` framing assumes destruction. #114's exact result is
 * > consistent with destruction but does not prove it - a strict superset says
 * > nothing about whether the game's crossing field emitted them at all.
 *
 * It is measurable, from a fixture already on disk, because the two hypotheses
 * leave **different marks on the neighbours** - and `cliffConnections.ts` already
 * carries both rules off the disassembly:
 *
 * | hypothesis | what happens to a connected neighbour |
 * | --- | --- |
 * | **destroyed** by `applyCliffs` | `Cliff::onDestroy` calls `destroyEnd(opposite(side))` on it - **unconditionally** |
 * | **never queued** by `generateCliffs` | the cell is simply absent; the neighbour loses its end only if `updateConnections` runs on it, and that is gated on the neighbour sitting on its chunk's OUTER RING |
 *
 * So a disputed cell is **decidable** whenever it has a neighbour that is (a) in
 * the game's kept set, so the fixture records its orientation, (b) **not** on a
 * chunk border, so `updateConnections` cannot trim it either way, and (c) queued
 * with an end facing the disputed cell, so there is an end to lose. Then the
 * game's own recorded orientation settles it: end **gone** means the cascade ran,
 * which only destruction can do; end **still dangling** would mean the cell was
 * never there.
 *
 * **Result: 2 of the far ten are decidable and both say DESTROYED**, and across
 * all 225 cells the game destroys, the never-queued signature appears **zero**
 * times. The other eight are not evidence for the other hypothesis - they are
 * cells this fixture cannot speak about at all, which is the second finding here
 * and is why #114's exactness must not be read as covering them.
 *
 * **What the verdict rests on, stated up front: the chunk-border gate.** Row two
 * of that table is the whole discriminator, and it is a reading of
 * `applyCliffs`' fifth-argument test, which `test/cliffConnections.spec.ts`
 * records as **unscored** - `updateConnections` finds a dangling end zero times
 * on the port's own set, so `everyCell` has never changed an answer. It changes
 * one here: the last block below runs the same counterfactual with the gate off
 * and the difference vanishes. So this is the first place the gate does any
 * work, and if it was read wrongly, these two cells go back to undecidable
 * rather than becoming never-queued. That is a conditional result, not a hedge -
 * see `## The far ten are DESTROYED` in `docs/noise/vulcanus-cliffs-NOTES.md`.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const K = (x: number, y: number): string => `${String(x)},${String(y)}`;
const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};
const isLava = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);

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
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const cases = entities.cases as unknown as { region: Region; cliffs: Ent[] }[];

const inRegion =
  (i: number) =>
  (p: { x: number; y: number }): boolean => {
    const r = cases[i].region;
    return p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
  };

/** The game's kept cliffs per region, position -> orientation id. */
const GAME = cases.map((c, i) => {
  const m = new Map<string, number>();
  for (const e of c.cliffs) {
    if (e.name !== "cliff-vulcanus") continue;
    if (!inRegion(i)({ x: e.x, y: e.y })) continue;
    const id = nameToId.get(e.orientation ?? "");
    if (id !== undefined) m.set(K(e.x, e.y), id);
  }
  return m;
});

/**
 * `generateCliffs`' queue - crossings and the repair pass, no rejection of any
 * kind - with the same 64-tile halo #114 uses. Hoisted to module scope because a
 * `placedCells` call inside a per-cell callback turns this file into a hang.
 */
const RAW = cases.map((c) =>
  makeCliffPlacementFromFields(fields, BANDS).placedCells(
    c.region.x0 - 64,
    c.region.y0 - 64,
    c.region.x1 + 64,
    c.region.y1 + 64,
  ),
);
const RAWMAP = RAW.map((cells) => {
  const m = new Map<string, number>();
  for (const p of cells) {
    const o = CLIFF_CODE_TO_ORIENTATION[p.code];
    if (o !== undefined) m.set(K(p.x, p.y), o);
  }
  return m;
});

/** Cell-centre delta, in tiles, of the neighbour on each `CellSide`. */
const SIDE_STEP: readonly (readonly [number, number])[] = [
  [0, -4],
  [4, 0],
  [0, 4],
  [-4, 0],
];

const boxOf = (o: number, x: number, y: number): Box | undefined =>
  cliffCollisionTileBox(cliffCodeForOrientation(o), x, y);

const lavaCollides = (o: number, x: number, y: number): boolean => {
  const box = boxOf(o, x, y);
  if (box === undefined) return false;
  for (let tx = box.left; tx <= box.right; tx++)
    for (let ty = box.top; ty <= box.bottom; ty++) if (isLava(tx, ty)) return true;
  return false;
};

/** Chebyshev distance from the box to the nearest tile our model calls lava. */
const lavaDistance = (box: Box): number => {
  for (let d = 0; d <= 12; d++)
    for (let tx = box.left - d; tx <= box.right + d; tx++)
      for (let ty = box.top - d; ty <= box.bottom + d; ty++) {
        const onRing =
          tx <= box.left - d || tx >= box.right + d || ty <= box.top - d || ty >= box.bottom + d;
        if ((d === 0 || onRing) && isLava(tx, ty)) return d;
      }
  return 99;
};

const hasEnd = (o: number, side: number): boolean => {
  const e = CLIFF_ORIENTATION_ENDS[o];
  return e !== undefined && (e[0] === side || e[1] === side);
};

type Group = "far" | "near" | "mid" | "agreed";

interface Verdict {
  region: number;
  key: string;
  group: Group;
  /** Neighbours that decide it: kept by the game, non-border, queued facing us. */
  decisive: { neighbour: string; gameOrientation: number; endGone: boolean }[];
}

/** Every cell the game destroys, tagged by whether our predicate agrees. */
const DESTROYED_BY_GAME: { region: number; x: number; y: number; group: Group }[] = (() => {
  const out: { region: number; x: number; y: number; group: Group }[] = [];
  for (let i = 0; i < cases.length; i++) {
    for (const p of RAW[i].filter(inRegion(i))) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined || GAME[i].has(K(p.x, p.y))) continue;
      const ourKill = lavaCollides(o, p.x, p.y) || oreRejects(cliffCodeForOrientation(o), p.x, p.y);
      if (ourKill) {
        out.push({ region: i, x: p.x, y: p.y, group: "agreed" });
        continue;
      }
      const box = boxOf(o, p.x, p.y);
      const d = box === undefined ? 99 : lavaDistance(box);
      out.push({ region: i, x: p.x, y: p.y, group: d === 99 ? "far" : d <= 2 ? "near" : "mid" });
    }
  }
  return out;
})();

/** Apply the decision rule above to one cell the game destroyed. */
const verdictFor = (c: { region: number; x: number; y: number; group: Group }): Verdict => {
  const i = c.region;
  const v: Verdict = { region: i, key: K(c.x, c.y), group: c.group, decisive: [] };
  const o = RAWMAP[i].get(v.key);
  if (o === undefined) return v;
  for (const s of connectedSides(o)) {
    const [dx, dy] = SIDE_STEP[s];
    const nx = c.x + dx;
    const ny = c.y + dy;
    const nk = K(nx, ny);
    const facing = oppositeSide(s);
    const queued = RAWMAP[i].get(nk);
    const game = GAME[i].get(nk);
    // (c) queued with an end facing us, (a) kept by the game, (b) not on a border.
    if (queued === undefined || !hasEnd(queued, facing)) continue;
    if (game === undefined || onChunkBorder(nx, ny)) continue;
    v.decisive.push({ neighbour: nk, gameOrientation: game, endGone: !hasEnd(game, facing) });
  }
  return v;
};

const VERDICTS = DESTROYED_BY_GAME.map(verdictFor);
const decisiveIn = (g: Group): Verdict[] =>
  VERDICTS.filter((v) => v.group === g && v.decisive.length > 0);

/** Score the port against the game for one region, under the game's own kill set. */
const scoreRegion = (
  i: number,
  cells: readonly { x: number; y: number; code: number }[],
  everyCell = false,
): { matched: number; wrong: number; surplus: number; missing: number; wrongAt: string[] } => {
  const out = applyCliffConnections(cells, {
    collides: (_o, x, y) => inRegion(i)({ x, y }) && !GAME[i].has(K(x, y)),
    everyCell,
  });
  const port = new Map(out.filter(inRegion(i)).map((p) => [K(p.x, p.y), p.orientation] as const));
  let matched = 0;
  let wrong = 0;
  let surplus = 0;
  let missing = 0;
  const wrongAt: string[] = [];
  for (const [k, id] of port) {
    const t = GAME[i].get(k);
    if (t === undefined) surplus++;
    else if (t === id) matched++;
    else {
      wrong++;
      wrongAt.push(k);
    }
  }
  for (const k of GAME[i].keys()) if (!port.has(k)) missing++;
  return { matched, wrong, surplus, missing, wrongAt };
};

describe("the game's orientations decide destroyed-vs-never-queued for only 14 cells", () => {
  /**
   * **How much the oracle can ever say.** Of the 225 cells the game destroys,
   * only **14** have a neighbour that discriminates - the rest have neighbours
   * the game also destroyed, or neighbours on a chunk border where
   * `updateConnections` trims the end under either hypothesis, or no facing end
   * at all. That number is not incidental: it is the reason #114's exact
   * 1531/1531 must not be read as having confirmed destruction for all 225.
   */
  it("finds 14 decidable cells among the 225, spread across all four groups", () => {
    expect(DESTROYED_BY_GAME.length).toBe(225);
    expect(DESTROYED_BY_GAME.filter((c) => c.group === "far").length).toBe(10);
    expect(DESTROYED_BY_GAME.filter((c) => c.group === "near").length).toBe(9);
    expect(DESTROYED_BY_GAME.filter((c) => c.group === "mid").length).toBe(6);
    expect(DESTROYED_BY_GAME.filter((c) => c.group === "agreed").length).toBe(200);

    expect(decisiveIn("far").length).toBe(2);
    expect(decisiveIn("near").length).toBe(2);
    expect(decisiveIn("mid").length).toBe(0);
    expect(decisiveIn("agreed").length).toBe(10);
    expect(VERDICTS.filter((v) => v.decisive.length > 0).length).toBe(14);
    // Each decidable cell is decided by exactly one neighbour, so the 14 cells
    // and the 14 decisive pairs are the same 14.
    expect(VERDICTS.reduce((n, v) => n + v.decisive.length, 0)).toBe(14);
  }, 300000);

  /**
   * **Every one of the 14 says DESTROYED, and none says never-queued.** The
   * never-queued verdict is reachable by this code - the counterfactual block
   * below produces it on demand - so a zero here is a measurement, not a branch
   * that never runs.
   */
  it("returns DESTROYED for all 14 and never-queued for none", () => {
    const all = VERDICTS.flatMap((v) => v.decisive);
    expect(all.length).toBe(14);
    expect(all.filter((d) => d.endGone).length).toBe(14);
    expect(all.filter((d) => !d.endGone).length).toBe(0);
  }, 300000);

  /**
   * The two far cells that carry the finding, pinned with the neighbour and the
   * game's own orientation for it. Both are the trimmed `*-to-none` half of a
   * run whose other end pointed at the disputed cell - which is exactly the mark
   * `Cliff::onDestroy` leaves and nothing else does.
   *
   * They also sit one in each of the far group's two multi-cell clusters -
   * `1546,1550.5` in the `1542/1546, 1550.5..1558.5` knot and `1746,1538.5` in
   * the `1746, 1530.5..1538.5` vertical run. That is the argument for reading
   * the clusters as destruction events; the two singletons (`1590,1618.5` and
   * `1602,1622.5`) are in neither and remain untouched by this measurement.
   */
  it("names the two far cells the game's own orientations prove destroyed", () => {
    const far = decisiveIn("far");
    expect(
      far
        .map((v) => ({
          cell: v.key,
          neighbour: v.decisive[0].neighbour,
          game: CLIFF_ORIENTATION_NAMES[v.decisive[0].gameOrientation],
          endGone: v.decisive[0].endGone,
        }))
        .sort((a, b) => a.cell.localeCompare(b.cell)),
    ).toEqual([
      { cell: "1546,1550.5", neighbour: "1546,1546.5", game: "north-to-none", endGone: true },
      { cell: "1746,1538.5", neighbour: "1746,1542.5", game: "east-to-none", endGone: true },
    ]);
  }, 300000);
});

/**
 * **The counterfactual, which is what makes the verdict above more than a
 * reading of a table.**
 *
 * Re-run the whole `applyCliffs` model with the cell removed from the QUEUE
 * rather than destroyed in it - the never-queued hypothesis, expressed exactly -
 * and the game disagrees. Its neighbour keeps the end that the game trimmed,
 * because a non-border cell never runs `updateConnections`.
 *
 * The contrast arm is what makes it non-vacuous in the other direction: doing
 * the same to a far cell with no decisive neighbour changes **nothing**, so this
 * is a property of those two cells and not something removing any cell would do.
 */
describe("removing the two decidable far cells from the QUEUE contradicts the game", () => {
  const DECISIVE = ["1546,1550.5", "1746,1538.5"];
  /** Both live in region 1, the `[1500,1500]` capture. */
  const R = 1;

  it("reproduces the game exactly when they are destroyed instead", () => {
    expect(cases.map((_, i) => scoreRegion(i, RAW[i]).matched)).toEqual([283, 861, 387]);
    expect(cases.map((_, i) => scoreRegion(i, RAW[i]).wrong)).toEqual([0, 0, 0]);
    for (const d of DECISIVE) expect(RAWMAP[R].has(d)).toBe(true);
  }, 300000);

  it("leaves the neighbour's end dangling when either is never queued", () => {
    for (const [cell, neighbour] of [
      ["1546,1550.5", "1546,1546.5"],
      ["1746,1538.5", "1746,1542.5"],
    ]) {
      const s = scoreRegion(
        R,
        RAW[R].filter((p) => K(p.x, p.y) !== cell),
      );
      expect(s.wrong).toBe(1);
      expect(s.wrongAt).toEqual([neighbour]);
      // Not a disappearing cliff - the neighbour is still placed, with the end
      // the game trimmed still attached.
      expect(s.missing).toBe(0);
      expect(s.surplus).toBe(0);
    }
  }, 300000);

  it("costs both orientations at once when both are never queued", () => {
    const s = scoreRegion(
      R,
      RAW[R].filter((p) => !DECISIVE.includes(K(p.x, p.y))),
    );
    expect(s).toMatchObject({ matched: 859, wrong: 2, surplus: 0, missing: 0 });
    expect([...s.wrongAt].sort((a, b) => a.localeCompare(b))).toEqual([
      "1546,1546.5",
      "1746,1542.5",
    ]);
  }, 300000);

  /**
   * **The contrast arm.** Four far cells with no decisive neighbour, removed the
   * same way, cost nothing at all - so the fixture is genuinely silent about
   * them, and "no evidence of never-queued" is not the same claim there as it is
   * for the two above.
   */
  it("changes nothing when a far cell with no decisive neighbour is never queued", () => {
    for (const cell of ["1542,1554.5", "1590,1618.5", "1602,1622.5", "1746,1530.5"]) {
      expect(RAWMAP[R].has(cell)).toBe(true);
      const s = scoreRegion(
        R,
        RAW[R].filter((p) => K(p.x, p.y) !== cell),
      );
      expect(s).toMatchObject({ matched: 861, wrong: 0, surplus: 0, missing: 0 });
    }
  }, 300000);
});

/**
 * **The chunk-border gate is what makes any of this decidable, and this is the
 * first thing that has ever depended on it.**
 *
 * `test/cliffConnections.spec.ts` ports `Cliff::updateConnections` exactly and
 * measures it firing **zero** times: the port's own cell set has no dangling
 * ends, so the pass never removes anything, and it records outright that the
 * gate "cannot be SCORED here - `everyCell` gives the identical answer, because
 * neither fires. Do not read that as evidence the gate was read wrongly; read it
 * as unscored."
 *
 * It stays unscored. What changes is that it is no longer inert: removing a cell
 * from the queue CREATES the dangling end that the port's own set never has, and
 * then the gate decides whether the neighbour trims it. With the gate off, both
 * counterfactuals above stop disagreeing with the game and the two hypotheses
 * become indistinguishable.
 *
 * So the honest form of the finding is conditional: **given that `applyCliffs`
 * really does skip `updateConnections` off the chunk's outer ring, those two
 * cells were destroyed.** If that reading is wrong they revert to undecidable -
 * they do not become never-queued. Scoring the gate against the game is now
 * worth doing on its own account, and was not before.
 */
describe("the verdict depends on the chunk-border gate, which remains unscored", () => {
  const R = 1;

  it("is invisible in the baseline - both gate settings reproduce the game", () => {
    for (let i = 0; i < cases.length; i++) {
      const gated = scoreRegion(i, RAW[i], false);
      const ungated = scoreRegion(i, RAW[i], true);
      expect(gated.wrong).toBe(0);
      expect(ungated.wrong).toBe(0);
      expect(ungated.matched).toBe(gated.matched);
    }
  }, 300000);

  it("erases the counterfactual's signal when the gate is switched off", () => {
    for (const cell of ["1546,1550.5", "1746,1538.5"]) {
      const without = RAW[R].filter((p) => K(p.x, p.y) !== cell);
      // With the gate (the game's rule as read): the neighbour keeps its end and
      // contradicts the game.
      expect(scoreRegion(R, without, false).wrong).toBe(1);
      // Without it: `updateConnections` trims the dangling end itself, the game
      // is reproduced either way, and nothing distinguishes the hypotheses.
      expect(scoreRegion(R, without, true).wrong).toBe(0);
    }
  }, 300000);
});

/**
 * **Cross-check against #114's own control.** That file destroys the same 225
 * cells with `noCascade` and gets 14 wrong orientations. Those 14 must be
 * precisely the neighbours this file calls decisive - a neighbour is observable
 * exactly when the cascade is the only thing that would have trimmed it - and
 * they are, cell for cell. Two independent routes to the same 14 is what says
 * the decision rule was read out of `cliffConnections.ts` correctly rather than
 * fitted to the answer.
 */
describe("the 14 decisive neighbours are #114's 14 no-cascade rewrites", () => {
  it("matches cell for cell", () => {
    const fromCascade: string[] = [];
    for (let i = 0; i < cases.length; i++) {
      const out = applyCliffConnections(RAW[i], {
        collides: (_o, x, y) => inRegion(i)({ x, y }) && !GAME[i].has(K(x, y)),
        noCascade: true,
      });
      for (const p of out.filter(inRegion(i))) {
        const t = GAME[i].get(K(p.x, p.y));
        if (t !== undefined && t !== p.orientation) fromCascade.push(K(p.x, p.y));
      }
    }
    const fromVerdicts = VERDICTS.flatMap((v) => v.decisive.map((d) => d.neighbour));
    expect(fromCascade.length).toBe(14);
    expect([...fromCascade].sort((a, b) => a.localeCompare(b))).toEqual(
      [...fromVerdicts].sort((a, b) => a.localeCompare(b)),
    );
  }, 300000);
});
