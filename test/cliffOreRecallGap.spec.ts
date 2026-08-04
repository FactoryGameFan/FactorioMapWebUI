import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import {
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_COLLISION_BOX,
  CLIFF_ORIENTATION_NAMES,
} from "../src/noise/cliffs/cliffCatalog";
import {
  connectedSides,
  destroyEnd,
  isCliffConnected,
  oppositeSide,
} from "../src/noise/cliffs/cliffConnections";
import {
  VULCANUS_CLIFF_BASE_COLLISION_BOX,
  VULCANUS_GEYSER_COLLISION_HALF,
  VULCANUS_ORE_COLLISION_HALF,
} from "../src/noise/cliffs/vulcanusOreRejection";

/**
 * **The ore recall gap is SIX cells, not thirty-one** (#84). The direct
 * follow-on from #141, and it needs no capture either.
 *
 * #141 showed the ore effect is exactly *rejections plus their cascade*, which
 * turned the open question from "what pathway reaches a cliff" into "which cells
 * get rejected". This measures that gap against the game's **real** resource
 * entities rather than the port's footprint model, so a shortfall in the rule's
 * geometry cannot be confused with a shortfall in where the port puts the ore.
 *
 * | | cells |
 * | --- | --- |
 * | the ore provably rejects | **31** |
 * | explained by base-box overlap with a real resource | **21** |
 * | additionally removed as CASCADE casualties of those 21 | **4** |
 * | still unexplained | **6** |
 *
 * **Four of the ten apparent misses were never geometry failures at all.** They
 * are single-ended cliffs (`X-to-none` / `none-to-X`) whose one end is trimmed
 * when a neighbour is rejected, so the cascade force-destroys them. Counting
 * them as recall misses - which is what "the rule explains 21 of 31" does -
 * charges the rule for cells no rejection rule should ever have to name. This is
 * the same shape as #114/#115's "count the defect at the RULE, not the output".
 *
 * **And the remaining 6 are NOT near-misses, which is the load-bearing
 * negative.** Measured as the factor the base box's half-extents would need to
 * be scaled by to reach the nearest resource - distance is the wrong metric,
 * since the box is asymmetric (0.988 x 0.488) - five of the six need **1.42x to
 * 3.28x**. So **no plausible widening of the box fixes this**, and anyone
 * arriving here should not try: #110 already measured that the higher-catching
 * variant LOSES, because a wider box buys true cells at the price of false
 * rejections elsewhere.
 *
 * The sixth sits at 1.11x, and it is exactly the geyser cell the per-orientation
 * `rotbb` box catches - so the one marginal case is accounted for rather than
 * waved at. That box catching it is a fact about the variant, not a fix; the
 * same #110 result applies, and it leaves five.
 *
 * **Zero over-removal is what makes the 21 trustworthy.** Destroying only those
 * 21 and cascading removes nothing the game kept. The rule is still pure
 * precision; it is recall that is short, and now by six.
 */

interface Cliff {
  x: number;
  y: number;
  name: string;
  orientation: string;
}
interface Res {
  x: number;
  y: number;
  name: string;
}
interface Box {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}
interface Case {
  label: string;
  cliffs: Cliff[];
  resources?: Res[];
  protos?: Record<string, { box: Box }>;
}

const cases = fixture.cases as unknown as Case[];
const arm = (label: string): Case => {
  const c = cases.find((x) => x.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};
const ON = arm("entity region, resources ON");
const OFF = arm("entity region, ALL resources OFF");

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
const oi = (n: string): number => CLIFF_ORIENTATION_NAMES.indexOf(n);
const cellsOf = (c: Case): Map<string, number> =>
  new Map(
    c.cliffs
      .filter((e) => e.name === "cliff-vulcanus")
      .map((e) => [key(e.x, e.y), oi(e.orientation)]),
  );
const parse = (k: string): [number, number] => {
  const [x, y] = k.split(",");
  return [Number(x), Number(y)];
};
const SIDE_STEP: readonly (readonly [number, number])[] = [
  [0, -CLIFF_GRID_SIZE],
  [CLIFF_GRID_SIZE, 0],
  [0, CLIFF_GRID_SIZE],
  [-CLIFF_GRID_SIZE, 0],
];

const onCells = cellsOf(ON);
const offCells = cellsOf(OFF);
/** The cells the ore provably rejects: present without ore, absent with it. */
const REJECTED = [...offCells.keys()].filter((k) => !onCells.has(k));
const RESOURCES = ON.resources ?? [];
const halfOf = (name: string): number =>
  name === "sulfuric-acid-geyser" ? VULCANUS_GEYSER_COLLISION_HALF : VULCANUS_ORE_COLLISION_HALF;

/** Strict overlap of a cliff rectangle at `(cx, cy)` with a resource's square. */
function overlaps(
  cx: number,
  cy: number,
  box: readonly [number, number, number, number],
  r: Res,
): boolean {
  const h = halfOf(r.name);
  const dx = r.x - cx;
  const dy = r.y - cy;
  return dx > box[0] - h && dx < box[2] + h && dy > box[1] - h && dy < box[3] + h;
}
const nearby = (cx: number, cy: number): Res[] =>
  RESOURCES.filter((r) => Math.abs(r.x - cx) <= 8 && Math.abs(r.y - cy) <= 8);

const BASE = VULCANUS_CLIFF_BASE_COLLISION_BOX;
const directHits = REJECTED.filter((k) => {
  const [x, y] = parse(k);
  return nearby(x, y).some((r) => overlaps(x, y, BASE, r));
});

function destroy(cells: Map<string, number>, x: number, y: number): void {
  const mine = cells.get(key(x, y));
  if (mine === undefined) return;
  cells.delete(key(x, y));
  for (const side of connectedSides(mine)) {
    const step = SIDE_STEP[side];
    if (step === undefined) continue;
    const nx = x + step[0];
    const ny = y + step[1];
    const theirs = cells.get(key(nx, ny));
    if (theirs === undefined) continue;
    if (!isCliffConnected(side, mine, theirs)) continue;
    const next = destroyEnd(theirs, oppositeSide(side));
    if (next === -1) destroy(cells, nx, ny);
    else cells.set(key(nx, ny), next);
  }
}

/** The world after destroying only the direct hits, cascaded. */
function afterDirectOnly(): Map<string, number> {
  const cells = cellsOf(OFF);
  for (const k of directHits) {
    const [x, y] = parse(k);
    destroy(cells, x, y);
  }
  return cells;
}

describe("Vulcanus cliffs: the ore recall gap is SIX cells (#84)", () => {
  it("starts from the 31 cells the ore provably rejects", () => {
    expect(REJECTED).toHaveLength(31);
    expect(RESOURCES.length).toBeGreaterThan(0);
  });

  it("explains 21 by base-box overlap with the game's REAL resource entities", () => {
    // Against the dumped entities, not the port's footprint model - so a gap in
    // the rule's geometry is never confused with a gap in where the port thinks
    // the ore is.
    expect(directHits).toHaveLength(21);
  });

  describe("four of the ten apparent misses are CASCADE casualties, not geometry failures", () => {
    it("removes 25 of the 31 from the direct hits alone, and over-removes NOTHING", () => {
      const cells = afterDirectOnly();
      const missing = [...onCells.keys()].filter((k) => !cells.has(k));
      const surplus = [...cells.keys()].filter((k) => !onCells.has(k));
      // Zero over-removal is what keeps the rule pure-precision: destroying the
      // 21 and cascading never removes a cell the game kept.
      expect(missing, "cells we removed that the game kept").toEqual([]);
      expect(surplus).toHaveLength(6);
      expect(REJECTED.length - surplus.length).toBe(25);
    });

    it("and the four are single-ended cliffs, which is WHY the cascade takes them", () => {
      const cells = afterDirectOnly();
      const cascaded = REJECTED.filter((k) => !directHits.includes(k) && !cells.has(k));
      expect(cascaded).toHaveLength(4);
      for (const k of cascaded) {
        const ends = CLIFF_ORIENTATION_NAMES[offCells.get(k) ?? -1] ?? "";
        expect(ends, `${k} should be single-ended`).toContain("none");
      }
    });
  });

  describe("the remaining six are NOT near-misses - do not widen the box", () => {
    it("would need the box GROWN by 42% to 228% to reach five of them", () => {
      // Distance is the wrong metric - the box is asymmetric (0.988 x 0.488), so
      // a cell can be close in Chebyshev terms and far outside it. The honest
      // measure is the factor the box's half-extents would have to be scaled by
      // to reach the nearest resource: below 1 it already overlaps.
      const growth = (k: string): number => {
        const [x, y] = parse(k);
        return Math.min(
          ...nearby(x, y).map((r) => {
            const h = halfOf(r.name);
            return Math.max((Math.abs(r.x - x) - h) / BASE[2], (Math.abs(r.y - y) - h) / BASE[3]);
          }),
        );
      };
      const cells = afterDirectOnly();
      const surplus = [...cells.keys()].filter((k) => !onCells.has(k));
      const factors = surplus.map(growth).sort((a, b) => a - b);
      // Five of the six need 1.42x to 3.28x. No plausible box correction gets
      // there, and #110 measured what chasing it costs.
      expect(factors.filter((f) => f >= 1.4)).toHaveLength(5);
      expect(Math.max(...factors)).toBeGreaterThan(3);
      // The sixth sits at 1.11x, and it is precisely the geyser cell the
      // per-orientation box catches below - so the one marginal case is
      // accounted for rather than waved at.
      expect(factors[0]).toBeGreaterThan(1.1);
      expect(factors[0]).toBeLessThan(1.2);
    });

    it("is not rescued by the per-orientation rotbb box either - it catches ONE", () => {
      // A fact about that variant, not a fix. #110 measured the higher-catching
      // variant as LOSING overall, because a wider box buys true cells at the
      // price of false rejections elsewhere.
      const cells = afterDirectOnly();
      const surplus = [...cells.keys()].filter((k) => !onCells.has(k));
      const caught = surplus.filter((k) => {
        const [x, y] = parse(k);
        const id = offCells.get(k);
        if (id === undefined) return false;
        const box = CLIFF_ORIENTATION_COLLISION_BOX[id];
        return nearby(x, y).some((r) => overlaps(x, y, box, r));
      });
      expect(caught).toHaveLength(1);
    });
  });
});
