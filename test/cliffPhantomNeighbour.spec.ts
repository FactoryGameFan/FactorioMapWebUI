import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
} from "../src/noise/cliffs/cliffCatalog";
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

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

/** code = (enc(L)<<6)|(enc(R)<<4)|(enc(T)<<2)|enc(B); enc: 0->0, +1->1, -1->3. */
const edgesOf = (code: number): number[] => [
  (code >> 6) & 3,
  (code >> 4) & 3,
  (code >> 2) & 3,
  code & 3,
];

/**
 * Per edge index (L, R, T, B): the world offset to the cell that SHARES it.
 *
 * `placedCells` builds one edge register per chunk - `v[cy][cx]` is cell `cx`'s
 * left edge and cell `cx-1`'s right edge, the same array slot - so two adjacent
 * cells do not merely agree about the edge between them, they read the identical
 * value. That is what makes the test below a test and not a coincidence hunt.
 */
const ACROSS: readonly (readonly [number, number])[] = [
  [-CLIFF_GRID_SIZE, 0],
  [CLIFF_GRID_SIZE, 0],
  [0, -CLIFF_GRID_SIZE],
  [0, CLIFF_GRID_SIZE],
];

const codeForOrientation = new Map<number, number>();
for (const [c, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
  codeForOrientation.set(id, Number(c));
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));

/** The game's orientation name -> the cell code that produces it (a bijection). */
const gameCodeOf = (orientation: string): number | undefined => {
  const id = nameToId.get(orientation);
  return id === undefined ? undefined : codeForOrientation.get(id);
};

interface Ent {
  x: number;
  y: number;
  name: string;
  orientation: string;
}
interface Case {
  region: { x0: number; y0: number; x1: number; y1: number };
  cliffs: Ent[];
}

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);

const place = (
  r: Case["region"],
  withRejections: boolean,
): { x: number; y: number; code: number }[] =>
  makeCliffPlacementFromFields(fields, {
    elevation0: VULCANUS_CLIFF_ELEVATION_0,
    interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
    smoothing: VULCANUS_CLIFF_SMOOTHING,
    tileCollides: withRejections
      ? (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name)
      : undefined,
    cellRejects: withRejections ? oreRejects : undefined,
  }).placedCells(r.x0, r.y0, r.x1, r.y1);

interface Scored {
  matched: number;
  /** Cells the game also places, where our orientation differs. */
  wrong: number;
  /** Cells we place that the game does not. */
  surplus: string[];
  /** Distinct neighbours across a disputed edge. */
  phantoms: Set<string>;
  /** Disputed edges whose neighbour the GAME places. Expected: none. */
  phantomPlacedByGame: number;
}

const score = (c: Case, withRejections: boolean): Scored => {
  const ours = new Map(place(c.region, withRejections).map((p) => [key(p.x, p.y), p.code]));
  const game = new Map<string, string>();
  for (const e of c.cliffs) if (e.name === "cliff-vulcanus") game.set(key(e.x, e.y), e.orientation);

  const phantoms = new Set<string>();
  let matched = 0;
  let wrong = 0;
  let phantomPlacedByGame = 0;
  for (const [k, ourCode] of ours) {
    const want = game.get(k);
    if (want === undefined) continue;
    matched++;
    const gameCode = gameCodeOf(want);
    if (gameCode === undefined || gameCode === ourCode) continue;
    wrong++;
    const a = edgesOf(ourCode);
    const b = edgesOf(gameCode);
    const [xs, ys] = k.split(",");
    for (let i = 0; i < 4; i++) {
      if (a[i] === b[i]) continue;
      const nk = key(Number(xs) + ACROSS[i][0], Number(ys) + ACROSS[i][1]);
      phantoms.add(nk);
      if (game.has(nk)) phantomPlacedByGame++;
    }
  }
  return {
    matched,
    wrong,
    surplus: [...ours.keys()].filter((k) => !game.has(k)),
    phantoms,
    phantomPlacedByGame,
  };
};

/**
 * **The orientation residual and the over-placement are ONE defect** (issue #84).
 *
 * `cliffOrientationResidual.spec.ts` pins the residual's shape - every wrong cell
 * differs from the game in exactly one edge, and always by finding a crossing the
 * game does not - and `cliffOrientationMargin.spec.ts` rules out a boundary tie.
 * Both treat the wrong orientations as their own defect, separate from the
 * surplus cells counted in `cliffOreExclusion.spec.ts`. **They are not separate.**
 *
 * A cell's four edges are shared with its four neighbours - literally the same
 * slot in the chunk's edge register, see `ACROSS` above - so a spurious crossing
 * is never confined to one cell. It corrupts the orientation of the real cell on
 * one side AND, on the other, manufactures a whole cliff the game never placed.
 * Measured over all three oracle regions, without the rejections so the geometry
 * is not masked:
 *
 * | | |
 * | --- | --- |
 * | matched cells | 1531 |
 * | wrong orientations | 37 |
 * | of those whose disputed-edge neighbour the GAME places | **0** |
 * | distinct phantom neighbours | 34 |
 * | of those the PORT places (i.e. that are surplus cells) | **34 of 34** |
 *
 * Not one of the 37 has a neighbour the game agrees about, and not one phantom
 * fails to be a surplus cell. So the residual is not a cosmetic orientation
 * mismatch to be chased after the placement is right - it IS part of the
 * placement error, and one root cause retires both.
 *
 * **Why this reframes the hunt.** The open lead is the grid-4 cliff-elevation
 * channel, which has no per-corner oracle (see `cliffOrientationMargin.spec.ts`).
 * The value of capturing it was previously scored against 33 wrong orientations -
 * about 1.6% of cells, easy to read as a rounding-error chase. It is worth more
 * than that: on the shipping path it also owns 12 of the surplus cells, and at
 * `[0,0]` it owns **every** surplus cell there is. (That 12 was measured when
 * the shipping surplus was 25; #108 has since taken it to 22 and the share has
 * not been re-measured. The assertions below all run with the rejections OFF, so
 * none of them depends on it.)
 */
describe("the wrong orientations and the surplus cells are the same defect", () => {
  const bare = (entities.cases as unknown as Case[]).map((c) => score(c, false));

  it("compares a real population, not a handful", () => {
    // Non-vacuity. If the residual is ever fixed these two lines are what will
    // fail, and the correct response is to delete this file's premise, not to
    // relax them - every assertion below is vacuous at `wrong === 0`.
    expect(bare.reduce((n, s) => n + s.matched, 0)).toBeGreaterThan(1500);
    expect(bare.reduce((n, s) => n + s.wrong, 0)).toBeGreaterThan(0);
  }, 120000);

  it("never has the game placing the neighbour across the disputed edge", () => {
    for (const s of bare) expect(s.phantomPlacedByGame).toBe(0);
  }, 120000);

  /**
   * The other half, and the one that makes it a shared defect rather than a
   * shared symptom: every phantom is a cell the port really does emit. A
   * disputed edge that produced no cliff on either side would be a discrepancy
   * with no cost.
   */
  it("makes every phantom neighbour a surplus cell of our own", () => {
    let phantoms = 0;
    for (const [i, s] of bare.entries()) {
      const surplus = new Set(s.surplus);
      for (const p of s.phantoms) {
        phantoms++;
        expect({ region: i, cell: p, surplus: surplus.has(p) }).toEqual({
          region: i,
          cell: p,
          surplus: true,
        });
      }
    }
    // Measured 34 distinct phantoms behind 37 wrong cells - a few are shared,
    // where one spurious crossing sits between two cells the game both places.
    expect(phantoms).toBe(34);
  }, 120000);
});

/**
 * **What that costs on the path the renderer actually runs.**
 *
 * The bare arm above is the right control for the geometry - the lava and ore
 * rejections drop cells for reasons unrelated to the crossings, and they drop
 * phantoms and honest cliffs alike. But the arm that matters for accuracy is the
 * one `renderVulcanusCliffs` runs, and the split there is worth pinning because
 * it is not obvious from the bare numbers:
 *
 * | region | matched | wrong | surplus | phantoms | surplus that ARE phantoms |
 * | --- | --- | --- | --- | --- | --- |
 * | `[0,0]` | 281 | 5 | 2 | 5 | **2 of 2** |
 * | `[1500,1500]` | 858 | 25 | 22 | 23 | 10 of 22 |
 * | `[-1200,800]` | 386 | 3 | 1 | 3 | 0 of 1 |
 *
 * Two things follow. **At `[0,0]` the spurious crossings are the whole of the
 * over-placement** - fix them and that region is exact. And the reason 33 wrong
 * cells do not imply 33 surplus is that the rejections already remove 19 of the
 * phantoms; the rejection hides the phantom while leaving the neighbouring cell's
 * orientation wrong, which is why the two counts drifted apart and were read as
 * unrelated in the first place.
 */
describe("the same defect, on the shipping path", () => {
  const shipped = (entities.cases as unknown as Case[]).map((c) => score(c, true));

  it("owns every surplus cell at [0,0]", () => {
    const s = shipped[0];
    expect(s.surplus.length).toBeGreaterThan(0);
    for (const k of s.surplus) expect(s.phantoms.has(k)).toBe(true);
  }, 120000);

  it("owns a substantial minority of the surplus overall", () => {
    const surplus = shipped.reduce((n, s) => n + s.surplus.length, 0);
    const explained = shipped.reduce(
      (n, s) => n + s.surplus.filter((k) => s.phantoms.has(k)).length,
      0,
    );
    // Measured 12 of 25. Bounds rather than equalities: a fix should move both
    // down, and this file should not have to be edited to let it.
    expect(surplus).toBeLessThanOrEqual(25);
    expect(explained).toBeGreaterThanOrEqual(Math.min(12, surplus));
  }, 120000);
});
