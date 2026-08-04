import { describe, expect, it } from "vite-plus/test";

import ore from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import { CLIFF_ORIENTATION_NAMES } from "../src/noise/cliffs/cliffCatalog";
import {
  applyCliffConnections,
  cliffCodeForOrientation,
} from "../src/noise/cliffs/cliffConnections";
import {
  VULCANUS_CLIFF_BASE_COLLISION_BOX,
  VULCANUS_GEYSER_COLLISION_HALF,
  VULCANUS_ORE_COLLISION_HALF,
} from "../src/noise/cliffs/vulcanusOreRejection";

/**
 * **Four of the ten ore "run remainders" are the `Cliff::onDestroy` cascade, and
 * nobody had tested that because the cascade did not exist yet when they were
 * measured** (#84).
 *
 * `vulcanusOreRejection.ts` records that box overlap accounts for 21 of the 31
 * cells the ore suppresses and that the other ten are "run remainders", with two
 * candidate explanations - "a cascade along cliff connections **or** a wider
 * box" - and it records the cascade half as REFUTED by `cliffOreCascade.spec.ts`.
 *
 * **That refutation is about a different cascade.** It tested #108's
 * CROSSING-stage mechanism: a rejection zeroes the cell's edge registers, a
 * neighbour's code changes, re-test to a fixpoint. The `applyCliffs` cascade -
 * `Cliff::onDestroy` taking the facing end of every connected neighbour, and
 * destroying a neighbour left with no end at all - was only read out of the
 * binary later, in #113. Nothing re-ran the remainder question against it.
 *
 * Running it closes four of the ten, at **zero** cost in precision.
 *
 * ## The experiment uses only the GAME's data on both sides
 *
 * This is what makes it worth trusting: nothing of the port's own field, ore
 * model or geyser roll appears anywhere in it.
 *
 * - **Start** from the game's `ALL resources OFF` cliff set - 892 cells with the
 *   game's own orientations.
 * - **Destroy** the cells whose base collision box overlaps one of the game's
 *   own resource entity positions, with the prototype half-extents the fixture
 *   itself carries.
 * - **Compare** against the game's `resources ON` set - 861 cells.
 *
 * The only modelled things are the overlap rule and the ported cascade.
 *
 * | arm | matched | wrong | surplus |
 * | --- | --- | --- | --- |
 * | control - destroy the lever's own 31 | **861** | **0** | **0** |
 * | direct overlap only, no cascade | 856 | 5 | 10 |
 * | direct overlap + `onDestroy` cascade | **859** | **2** | **6** |
 *
 * The control is what validates the whole setup: the ore-off world minus those
 * 31 cells IS the ore-on world, orientations included. Getting that exactly is
 * also why the second `updateConnections` pass has to be suppressed - the game's
 * dumped set is POST-pipeline, so running the pass again double-applies it and
 * trims ends that legitimately survive (it scores `wrong = 13` if you forget).
 *
 * Recall on the lever's 31 goes **21/31 = 0.677 to 25/31 = 0.806** with no new
 * parameter and no wider box - which matters because #124 established that
 * widening the box would be fitting a shape to an effect the engine's collision
 * system provably does not produce.
 */

const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const K = (x: number, y: number): string => `${String(x)},${String(y)}`;

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

const oreCases = ore.cases as unknown as {
  label: string;
  region: Region;
  cliffs: Ent[];
  resources: Ent[];
}[];
const arm = (label: string): { label: string; region: Region; cliffs: Ent[]; resources: Ent[] } => {
  const c = oreCases.find((q) => q.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};
const cliffMap = (label: string): Map<string, number> => {
  const c = arm(label);
  const m = new Map<string, number>();
  for (const e of c.cliffs)
    if (
      e.name === "cliff-vulcanus" &&
      e.x >= c.region.x0 &&
      e.x < c.region.x1 &&
      e.y >= c.region.y0 &&
      e.y < c.region.y1
    ) {
      const id = nameToId.get(e.orientation ?? "");
      if (id !== undefined) m.set(K(e.x, e.y), id);
    }
  return m;
};

const ON = cliffMap("entity region, resources ON");
const ALL_OFF = cliffMap("entity region, ALL resources OFF");
const REG = arm("entity region, resources ON").region;
const inR = (p: { x: number; y: number }): boolean =>
  p.x >= REG.x0 && p.x < REG.x1 && p.y >= REG.y0 && p.y < REG.y1;
const RES = arm("entity region, resources ON").resources;
const SUPPRESSED = new Set([...ALL_OFF.keys()].filter((k) => !ON.has(k)));

/** The game's own ore-off cliffs, as an `applyCliffConnections` input. */
const START = [...ALL_OFF.entries()].map(([k, o]) => {
  const [xs, ys] = k.split(",");
  return { x: Number(xs), y: Number(ys), code: cliffCodeForOrientation(o) };
});

const [bl, bt, br, bb] = VULCANUS_CLIFF_BASE_COLLISION_BOX;
const halfOf = (name: string): number =>
  name === "sulfuric-acid-geyser" ? VULCANUS_GEYSER_COLLISION_HALF : VULCANUS_ORE_COLLISION_HALF;

/** Bucketed so the overlap test is not 892 x 3933. */
const BUCKET = 8;
const BUCKETS = new Map<string, Ent[]>();
for (const r of RES) {
  const k = K(Math.floor(r.x / BUCKET), Math.floor(r.y / BUCKET));
  const a = BUCKETS.get(k);
  if (a === undefined) BUCKETS.set(k, [r]);
  else a.push(r);
}

/** Does the cell's base box overlap any of the GAME's resource entity boxes? */
const overlapsGameResource = (cx: number, cy: number): boolean => {
  const left = cx + bl;
  const top = cy + bt;
  const right = cx + br;
  const bottom = cy + bb;
  for (let gx = Math.floor((left - 2) / BUCKET); gx <= Math.floor((right + 2) / BUCKET); gx++)
    for (let gy = Math.floor((top - 2) / BUCKET); gy <= Math.floor((bottom + 2) / BUCKET); gy++) {
      const a = BUCKETS.get(K(gx, gy));
      if (a === undefined) continue;
      for (const r of a) {
        const h = halfOf(r.name);
        if (r.x - h < right && left < r.x + h && r.y - h < bottom && top < r.y + h) return true;
      }
    }
  return false;
};

const DIRECT = new Set(START.filter((c) => overlapsGameResource(c.x, c.y)).map((c) => K(c.x, c.y)));

interface Score {
  matched: number;
  wrong: number;
  surplus: number;
  missing: number;
}
const run = (kill: Set<string>, noCascade: boolean): { score: Score; left: string[] } => {
  const out = applyCliffConnections(START, {
    collides: (_o, x, y) => kill.has(K(x, y)),
    noCascade,
    // The dumped set is POST-pipeline; running `updateConnections` again would
    // double-apply it. See the module comment.
    noUpdateConnections: true,
  });
  const survivors = new Map(out.filter(inR).map((p) => [K(p.x, p.y), p.orientation] as const));
  const score: Score = { matched: 0, wrong: 0, surplus: 0, missing: 0 };
  for (const [k, id] of survivors) {
    const t = ON.get(k);
    if (t === undefined) score.surplus++;
    else if (t === id) score.matched++;
    else score.wrong++;
  }
  for (const k of ON.keys()) if (!survivors.has(k)) score.missing++;
  return { score, left: [...SUPPRESSED].filter((k) => survivors.has(k)) };
};

describe("the ore lever, replayed entirely on the game's own data", () => {
  /**
   * **The control that validates the harness.** The ore-off world minus the 31
   * cells the lever attributes to the ore is exactly the ore-on world -
   * positions and orientations. If this ever stops being 861/0/0/0 the arms
   * below mean nothing.
   */
  it("reproduces the resources-ON world exactly from the OFF world", () => {
    expect(ALL_OFF.size).toBe(892);
    expect(ON.size).toBe(861);
    expect(SUPPRESSED.size).toBe(31);
    expect(run(SUPPRESSED, false).score).toEqual({
      matched: 861,
      wrong: 0,
      surplus: 0,
      missing: 0,
    });
  }, 300000);

  /**
   * Box overlap against the game's own resource positions fires on 21 cells and
   * **every one of them is in the lever's set** - precision 1.000 with nothing
   * of ours in the measurement. That is the half of `vulcanusOreRejection.ts`'s
   * rule that was never in doubt, re-derived without the port's ore field or
   * geyser roll.
   */
  it("finds 21 directly overlapped cells and no false positives", () => {
    expect(DIRECT.size).toBe(21);
    expect([...DIRECT].filter((k) => !SUPPRESSED.has(k))).toEqual([]);
  }, 300000);
});

describe("the onDestroy cascade explains four of the ten remainders", () => {
  /**
   * The comparison that carries the finding. Destroying the same 21 cells
   * differs only in whether `Cliff::onDestroy` runs, and the cascade removes
   * four more - each one a cell left with no end at all once its neighbours'
   * facing ends went - plus three of the five orientation errors.
   *
   * **No cell the lever keeps is ever removed**, in either arm, so this costs no
   * precision. That is the property that distinguishes a mechanism from a wider
   * box: a box big enough to reach these four would also reach cells the game
   * kept.
   */
  it("takes the remainder from 10 to 6 with no precision cost", () => {
    const withoutCascade = run(DIRECT, true);
    const withCascade = run(DIRECT, false);

    expect(withoutCascade.score).toEqual({ matched: 856, wrong: 5, surplus: 10, missing: 0 });
    expect(withCascade.score).toEqual({ matched: 859, wrong: 2, surplus: 6, missing: 0 });

    // Recall on the lever's own 31, before and after.
    expect((31 - withoutCascade.left.length) / 31).toBeCloseTo(0.677, 3);
    expect((31 - withCascade.left.length) / 31).toBeCloseTo(0.806, 3);

    // ...and neither arm removes a cell the game kept - `missing` is 0 in both.
    expect(withoutCascade.score.missing).toBe(0);
    expect(withCascade.score.missing).toBe(0);
  }, 300000);

  /**
   * The six that remain, pinned as the input to whatever comes next. Two of them
   * (`1546,1550.5`, `1546,1554.5`) are the pair that #123 attributed to the
   * geyser and #124 used for its n=1 destroy-stage proof - so the one cell in
   * this whole residual whose destruction is directly witnessed by the game's
   * own orientations is still unexplained by any rule.
   */
  it("pins the six the cascade does not reach", () => {
    expect(run(DIRECT, false).left.sort((a, b) => a.localeCompare(b))).toEqual([
      "1546,1550.5",
      "1546,1554.5",
      "1606,1590.5",
      "1606,1594.5",
      "1622,1614.5",
      "1626,1614.5",
    ]);
  }, 300000);
});
