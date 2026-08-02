import { describe, expect, it } from "vite-plus/test";

import corners from "./fixtures/oracle-vulcanus-cliff-corner-fields-entity-regions.seed123456.json";
import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  crossesCliff,
  makeCliffPlacementFromFields,
  smoothingKnots,
} from "../src/noise/cliffs/cliffPlacement";
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
} from "../src/noise/cliffs/cliffCatalog";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeVulcanusStack } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

interface Ent {
  x: number;
  y: number;
  name: string;
  orientation?: string | null;
}
interface Case {
  region: { x0: number; y0: number; x1: number; y1: number };
  cliffs: Ent[];
}

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const E0 = VULCANUS_CLIFF_ELEVATION_0;
const INTERVAL = VULCANUS_CLIFF_ELEVATION_INTERVAL;
const S = VULCANUS_CLIFF_SMOOTHING;

const rawE = new Map<string, number>();
const rawElev = (i: number, j: number): number => {
  const k = `${String(i)},${String(j)}`;
  let v = rawE.get(k);
  if (v === undefined) {
    v = fields.cliffElevation(i * CLIFF_GRID_SIZE, j * CLIFF_GRID_SIZE);
    rawE.set(k, v);
  }
  return v;
};
const elevAt = (i: number, j: number): number => {
  const kx = smoothingKnots(i);
  const ky = smoothingKnots(j);
  const bil =
    (1 - kx.t) * (1 - ky.t) * rawElev(kx.lo, ky.lo) +
    kx.t * (1 - ky.t) * rawElev(kx.hi, ky.lo) +
    (1 - kx.t) * ky.t * rawElev(kx.lo, ky.hi) +
    kx.t * ky.t * rawElev(kx.hi, ky.hi);
  return S === 1 ? bil : (1 - S) * rawElev(i, j) + S * bil;
};
interface Corner {
  elev: number;
  cliff: number;
}
const corner = (i: number, j: number): Corner => ({
  elev: elevAt(i, j),
  cliff: fields.cliffiness(i * CLIFF_GRID_SIZE, j * CLIFF_GRID_SIZE),
});

/** How far the two endpoints sit from the band boundary `crossesCliff` uses. */
const margin = (a: number, b: number): number => {
  const boundary = E0 + INTERVAL * Math.floor((Math.max(a, b) - E0) / INTERVAL);
  return Math.min(Math.abs(a - boundary), Math.abs(b - boundary));
};

const edgesOf = (cx: number, cy: number): [Corner, Corner][] => {
  const a = corner(cx, cy);
  const b = corner(cx, cy + 1);
  const d = corner(cx + 1, cy);
  const f = corner(cx + 1, cy + 1);
  return [
    [a, b],
    [d, f],
    [a, d],
    [b, f],
  ];
};

const crossingMarginsIn = (cx: number, cy: number): number[] =>
  edgesOf(cx, cy)
    .filter(([u, v]) => crossesCliff(u.elev, v.elev, (u.cliff + v.cliff) / 2, E0, INTERVAL) !== 0)
    .map(([u, v]) => margin(u.elev, v.elev));

/**
 * **The orientation residual is not a floating-point tie at the band boundary.**
 *
 * `test/cliffOrientationResidual.spec.ts` pins the residual's shape: every wrong
 * cell differs from the game in exactly ONE edge, and it is always an
 * OVER-detection - the game finds no crossing there and the port finds one.
 *
 * That shape has an obvious cheap explanation which turns out to be wrong, and
 * ruling it out is worth a spec because it eliminates a whole class of cause.
 * `crossesCliff` decides by the SIGN of `elevation - boundary` on each endpoint,
 * so if an endpoint sat within float noise of a band boundary, a difference of
 * 1e-6 between our field and the game's would flip the crossing - and the port's
 * fields agree with the game's to about that order. Under that story the residual
 * would be an irreducible precision limit and there would be nothing to fix.
 *
 * **It is not that.** Every crossing edge in a wrong cell sits at least **0.2**
 * from its boundary, with a median near 10 - four to seven orders of magnitude
 * clear of float noise. For the game to disagree, its elevation at that corner
 * must differ from ours by more than 0.2, which is a real field difference, not
 * a rounding one.
 *
 * So the residual is a genuine disagreement about a value or a rule, and it is
 * worth continuing to hunt.
 */
describe("the orientation over-detections are not boundary ties", () => {
  const wrongCellMargins: number[] = [];
  const allCrossingMargins: number[] = [];

  for (const c of entities.cases as unknown as Case[]) {
    const r = c.region;
    const byPos = new Map<string, string>();
    for (const e of c.cliffs)
      if (e.name === "cliff-vulcanus" && typeof e.orientation === "string")
        byPos.set(`${String(e.x)},${String(e.y)}`, e.orientation);

    for (const p of makeCliffPlacementFromFields(fields, {
      elevation0: E0,
      interval: INTERVAL,
      smoothing: S,
    }).placedCells(r.x0, r.y0, r.x1, r.y1)) {
      const gameOrient = byPos.get(`${String(p.x)},${String(p.y)}`);
      if (gameOrient === undefined) continue;
      const cx = (p.x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE;
      const cy = (p.y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE;
      const ms = crossingMarginsIn(cx, cy);
      allCrossingMargins.push(...ms);
      const id = CLIFF_CODE_TO_ORIENTATION[p.code];
      const oursName = id === undefined ? "?" : CLIFF_ORIENTATION_NAMES[id];
      if (oursName !== gameOrient) wrongCellMargins.push(...ms);
    }
  }

  it("compares a real population, not a handful", () => {
    // ~37 wrong cells carrying two crossing edges each, against every crossing
    // edge of every matched cell.
    expect(wrongCellMargins.length).toBeGreaterThan(50);
    expect(allCrossingMargins.length).toBeGreaterThan(2000);
  }, 120000);

  it("puts every crossing edge in a wrong cell far from its band boundary", () => {
    const min = Math.min(...wrongCellMargins);
    // Measured 0.205. Asserted as a bound rather than the exact value so a field
    // change that keeps the conclusion does not fail the spec spuriously.
    expect(min).toBeGreaterThan(0.1);
    // Four orders of magnitude clear of the ~1e-6 the fields agree to.
    expect(min).toBeGreaterThan(1e-4 * 1000);
  }, 120000);

  /**
   * Non-vacuity, and it matters here: the bound above would be unremarkable if
   * NO edge anywhere sat near a boundary. Some do - the overall minimum is about
   * 6e-3, thirty times tighter than the worst wrong cell - so "far from the
   * boundary" is a property of the wrong cells rather than of the sample.
   */
  it("is a property of the wrong cells, not of every edge", () => {
    expect(Math.min(...allCrossingMargins)).toBeLessThan(Math.min(...wrongCellMargins) / 10);
  }, 120000);
});

/**
 * **The corner fixture is the TILE channel, and this pins it so.**
 *
 * `test/vulcanusCliffCornerFields.spec.ts` says so in prose at the top, and its
 * substitution deliberately feeds `vulcanus_elevation` into `cliffElevation` to
 * preserve the history of how the wrong channel stayed hidden. Prose is not a
 * guard, and this is the single most expensive mistake this subsystem has made
 * (#83) - so the identification is asserted here as a number.
 *
 * The gap it leaves is the important part: **the grid-4 cliff-elevation channel
 * has no per-corner oracle at all.** It is the one input to the placement rule
 * that has never been checked against the game corner by corner, and after the
 * measurement above it is also the only remaining candidate that could move an
 * endpoint by the required 0.2. Capturing it is the next concrete step.
 */
describe("which elevation channel the corner fixture holds", () => {
  it("matches the per-tile channel and NOT the grid-4 cliff channel", () => {
    const stack = makeVulcanusStack(INPUT);
    const cliffFields = makeVulcanusCliffFields(stack.ctx, stack);
    const keys = corners.corners;
    const elev = corners.elevation;

    let maxVsTile = 0;
    let maxVsCliff = 0;
    for (let i = 0; i < keys.length; i++) {
      const [is, js] = keys[i].split(",");
      const x = Number(is) * CLIFF_GRID_SIZE;
      const y = Number(js) * CLIFF_GRID_SIZE;
      maxVsTile = Math.max(maxVsTile, Math.abs(stack.elevation.elevation(x, y) - elev[i]));
      maxVsCliff = Math.max(maxVsCliff, Math.abs(cliffFields.cliffElevation(x, y) - elev[i]));
    }

    expect(keys.length).toBe(12675);
    // Measured: 4.8e-2 against the tile channel, 96.09 against the cliff channel.
    expect(maxVsTile).toBeLessThan(0.1);
    expect(maxVsCliff).toBeGreaterThan(50);
  }, 120000);
});
