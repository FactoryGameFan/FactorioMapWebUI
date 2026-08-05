import { describe, expect, it } from "vite-plus/test";

import bandsFx from "./fixtures/oracle-vulcanus-cliff-bands.seed123456.json";
import sweep from "./fixtures/oracle-vulcanus-cliff-fine-sweep.seed123456.json";
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
} from "../src/noise/cliffs/cliffCatalog";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import { makeVulcanusCliffFields } from "../src/noise/cliffs/vulcanusCliffFields";
import { makeVulcanusOreRejection } from "../src/noise/cliffs/vulcanusOreRejection";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { buildResources } from "../src/noise/preview/renderVulcanusResources";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

/**
 * **What the game's grid-4 cliff elevation actually IS, per corner** (#84) - and
 * the measurement that **refutes the conclusion of `vulcanusCliffBands.spec.ts`.**
 *
 * That spec found the port's placement disagreeing with the game at
 * `[1500,1500]`'s high bands with the smoothing off, the gate a constant and the
 * repair ruled out, and concluded the remaining suspect had to be the FIELD -
 * the port's value sits a median 18.8 and a maximum 69.0 units from the level at
 * the disputed edges, so a field difference of that order would explain it. That
 * inference was sound about what it excluded and **wrong about what it implied**,
 * because it never measured the game's field; it only measured that *something*
 * differs.
 *
 * This does measure it. Sweeping `cliff_elevation_0` across `[700, 900]` step 5
 * under the same collapsed rule turns each placed cell into one-sided
 * constraints on its corners: a crossing edge at level `L` says "this corner
 * > L, that one < L", and its sign says which is which. Accumulated over 41
 * levels that brackets a corner to the step.
 *
 * **Only POSITIVE observations are used.** An absent cliff is ambiguous - the
 * lava and ore rejections drop whole cells - but a PRESENT crossing is not,
 * because `fixImpossibleCellsSweep` only ever writes `0` (verified line by line)
 * and so can delete a crossing but never invent one, and the rejections are
 * post-filters that never touch the edge registers.
 *
 * The verdict: **the port's grid-4 field is right.** 997 of 998 two-sided
 * brackets contain it, at a mean bracket width of 5.72, in the worst region -
 * and the one exception misses by **2.6e-5**, i.e. the port's value sits
 * essentially exactly ON a swept level, where `crossesCliff`'s strict test
 * yields no crossing and so no observation. That is the bracket's open endpoint,
 * not a field error. At the disputed-edge corners specifically, every bracketed
 * one contains the port's value.
 *
 * (Was 996 of 998 missing by 6.7e-4 until the `multioctave_noise` octave-offset
 * fix; that primitive feeds `cliff_elevation`, so tightening it by 164x moved one
 * borderline corner inside its bracket and shrank the remaining miss 26x. The
 * conclusion was already right - this only sharpens it.)
 *
 * So the field is exonerated by direct measurement, and #84's residual is
 * somewhere else. What the sweep also shows is where to look: the corners
 * involved in the crossings the game DROPS are systematically the ones it gives
 * no two-sided bracket for, i.e. the ones sitting where the game emits no
 * entities at all.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const base = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
const G = CLIFF_GRID_SIZE;

const codeForOrientation = new Map<number, number>();
for (const [c, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
  codeForOrientation.set(id, Number(c));
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const gameCodeOf = (orientation: string): number | undefined => {
  const id = nameToId.get(orientation);
  return id === undefined ? undefined : codeForOrientation.get(id);
};
const bitsOf = (code: number): number[] => [
  (code >> 6) & 3,
  (code >> 4) & 3,
  (code >> 2) & 3,
  code & 3,
];

/**
 * Per edge (L, R, T, B): the corner index offsets of `(a, b)` as `cross(a, b)`
 * saw them, so the crossing's SIGN can be read as "which corner is the high one".
 * `+1` is `a < boundary < b` and `-1` is `a > boundary > b`.
 */
const EDGE: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 1],
  [1, 0, 1, 1],
  [0, 0, 1, 0],
  [0, 1, 1, 1],
];

interface Bracket {
  /** `v > lo`, from levels where the game made this corner the HIGH side. */
  lo: number;
  /** `v < hi`, from levels where the game made it the LOW side. */
  hi: number;
}

/** Every one-sided constraint the game asserted, folded into per-corner brackets. */
const reconstruct = (): Map<string, Bracket> => {
  const bounds = new Map<string, Bracket>();
  const bump = (i: number, j: number, high: boolean, L: number): void => {
    const k = `${String(i)},${String(j)}`;
    const b = bounds.get(k) ?? { lo: -Infinity, hi: Infinity };
    if (high) b.lo = Math.max(b.lo, L);
    else b.hi = Math.min(b.hi, L);
    bounds.set(k, b);
  };
  for (const c of sweep.cases)
    for (const e of c.cliffs) {
      if (e.name !== "cliff-vulcanus") continue;
      const code = gameCodeOf(e.orientation);
      if (code === undefined) continue;
      const ci = (e.x - CLIFF_CELL_CENTER_X) / G;
      const cj = (e.y - CLIFF_CELL_CENTER_Y) / G;
      const bits = bitsOf(code);
      for (let i = 0; i < 4; i++) {
        if (bits[i] === 0) continue;
        const [ax, ay, bx, by] = EDGE[i];
        const aHigh = bits[i] === 3;
        bump(ci + ax, cj + ay, aHigh, c.level);
        bump(ci + bx, cj + by, !aHigh, c.level);
      }
    }
  return bounds;
};

const twoSided = (b: Bracket): boolean => Number.isFinite(b.lo) && Number.isFinite(b.hi);

const place = (level: number, repair = true): Map<string, number> =>
  new Map(
    makeCliffPlacementFromFields(
      { cliffElevation: base.cliffElevation, cliffiness: (): number => 1 },
      {
        elevation0: level,
        interval: 1000000,
        smoothing: 0,
        fixImpossibleCells: repair,
        tileCollides: (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
        cellRejects: oreRejects,
      },
    )
      .placedCells(sweep.region.x0, sweep.region.y0, sweep.region.x1, sweep.region.y1)
      .map((p) => [`${String(p.x)},${String(p.y)}`, p.code] as const),
  );

const gameCells = (cliffs: (typeof sweep.cases)[number]["cliffs"]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const e of cliffs) {
    if (e.name !== "cliff-vulcanus") continue;
    if (e.x < sweep.region.x0 || e.x >= sweep.region.x1) continue;
    if (e.y < sweep.region.y0 || e.y >= sweep.region.y1) continue;
    const code = gameCodeOf(e.orientation);
    if (code !== undefined) m.set(`${String(e.x)},${String(e.y)}`, code);
  }
  return m;
};

describe("the game's grid-4 cliff elevation, measured per corner", () => {
  it("covers 700..900 step 5 with every override applied", () => {
    expect(sweep.cases.length).toBe(41);
    for (const c of sweep.cases) {
      expect(c.effective?.cliff_smoothing).toBe(0);
      expect(c.effective?.cliff_elevation_interval).toBe(1000000);
      expect(c.effective?.cliff_elevation_0).toBe(c.level);
    }
  });

  /**
   * The two captures overlap at `L = 790`, and the same settings produce the
   * same world - so the generator is deterministic across runs and the two
   * fixtures can be reasoned about together rather than as two experiments.
   */
  it("agrees cell-for-cell with the bands fixture where they overlap", () => {
    const b = bandsFx.cases.find(
      (c) => c.gate === "constant1" && c.region.x0 === 1500 && c.level === 790,
    );
    const s = sweep.cases.find((c) => c.level === 790);
    const setOf = (cs: (typeof sweep.cases)[number]["cliffs"]): Set<string> =>
      new Set(
        cs
          .filter((e) => e.name === "cliff-vulcanus")
          .map((e) => `${String(e.x)},${String(e.y)}|${e.orientation}`),
      );
    const A = setOf(b?.cliffs ?? []);
    const B = setOf(s?.cliffs ?? []);
    expect(A.size).toBe(494);
    expect([...A].filter((k) => B.has(k)).length).toBe(A.size);
  });

  /**
   * **The headline, and the correction.** The port's grid-4 field lands inside
   * the game's own bracket at 997 of 998 corners, in the region where the
   * placement disagrees most. The field is not the defect.
   *
   * The one that falls outside misses by **2.6e-5** - the port's value lands on
   * the bracket's endpoint to within float noise. The interval is open because
   * `crossesCliff` tests `dA < 0 && dB > 0` strictly, so a corner sitting on the
   * level produces no crossing and therefore no observation. That is the
   * convention, not an error: at 4e-4 of a 5-unit bracket there is no room for
   * it to be anything else.
   */
  it("the port's field is inside the game's own bracket at 997 of 998 corners", () => {
    const bounds = reconstruct();
    let both = 0;
    let inside = 0;
    let width = 0;
    let worstMiss = 0;
    for (const [k, b] of bounds) {
      if (!twoSided(b)) continue;
      both++;
      width += b.hi - b.lo;
      const [is, js] = k.split(",");
      const port = base.cliffElevation(Number(is) * G, Number(js) * G);
      if (port > b.lo && port < b.hi) inside++;
      else worstMiss = Math.max(worstMiss, port >= b.hi ? port - b.hi : b.lo - port);
    }
    expect(both).toBe(998);
    expect(inside).toBe(997);
    expect(worstMiss).toBeLessThan(0.01);
    // The brackets are tight enough for that to mean something: at the sweep's
    // step of 5, a field wrong by more than a few units could not hide.
    expect(width / both).toBeLessThan(6);
  });

  /**
   * The population that matters: the corners of the edges the two sides actually
   * argue about. Where the game constrains them from both sides, it agrees with
   * the port every time - so the 69.0-unit "lower bound on the field error" from
   * `vulcanusCliffBands.spec.ts` is not a field error.
   *
   * Note the coverage, because it is the lead: only 26 of the 72 disputed corner
   * slots get a two-sided bracket at all. The rest are corners the game never
   * puts a crossing beside anywhere in 700..900 - it emits nothing there - which
   * is where the residual now points.
   */
  it("every bracketed corner of a disputed edge contains the port's value", () => {
    const bounds = reconstruct();
    let slots = 0;
    let bracketed = 0;
    let contained = 0;
    for (const c of bandsFx.cases) {
      if (c.gate !== "constant1" || c.region.x0 !== 1500) continue;
      if (c.level < 700 || c.level > 900) continue;
      const ours = place(c.level);
      const game = gameCells(c.cliffs);
      for (const [k, ourCode] of ours) {
        const theirCode = game.get(k);
        if (theirCode === undefined || theirCode === ourCode) continue;
        const mine = bitsOf(ourCode);
        const theirs = bitsOf(theirCode);
        const [xs, ys] = k.split(",");
        const ci = (Number(xs) - CLIFF_CELL_CENTER_X) / G;
        const cj = (Number(ys) - CLIFF_CELL_CENTER_Y) / G;
        for (let i = 0; i < 4; i++) {
          if (mine[i] === theirs[i]) continue;
          const [ax, ay, bx, by] = EDGE[i];
          for (const [ii, jj] of [
            [ci + ax, cj + ay],
            [ci + bx, cj + by],
          ]) {
            slots++;
            const b = bounds.get(`${String(ii)},${String(jj)}`);
            if (b === undefined || !twoSided(b)) continue;
            bracketed++;
            const port = base.cliffElevation(ii * G, jj * G);
            if (port > b.lo && port < b.hi) contained++;
          }
        }
      }
    }
    expect(slots).toBe(72);
    expect(bracketed).toBe(26);
    expect(contained).toBe(26);
  }, 120000);

  /**
   * **The shape of what is left.** Across all 41 levels the game's cell code is
   * the port's code with edges REMOVED, essentially always - the port finds
   * crossings the game does not, and never the reverse. With the field now
   * measured right, the smoothing off, the gate a constant and the repair shown
   * not to touch these cells, that asymmetry is the whole of #84's residual.
   */
  it("the game's code is the port's minus edges, 1231 of 1233 times", () => {
    let disputed = 0;
    let subset = 0;
    for (const c of sweep.cases) {
      const ours = place(c.level);
      const game = gameCells(c.cliffs);
      for (const [k, ourCode] of ours) {
        const theirCode = game.get(k);
        if (theirCode === undefined || theirCode === ourCode) continue;
        disputed++;
        const mine = bitsOf(ourCode);
        const theirs = bitsOf(theirCode);
        if (theirs.every((t, i) => t === mine[i] || t === 0)) subset++;
      }
    }
    expect(disputed).toBe(1233);
    expect(subset).toBe(1231);
  }, 300000);
});
