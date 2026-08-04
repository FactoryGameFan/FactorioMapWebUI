import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import { CLIFF_GRID_SIZE, CLIFF_ORIENTATION_NAMES } from "../src/noise/cliffs/cliffCatalog";
import {
  connectedSides,
  destroyEnd,
  isCliffConnected,
  oppositeSide,
} from "../src/noise/cliffs/cliffConnections";

/**
 * **The ore effect is FULLY decomposed: N rejections plus their cascade, and
 * nothing else** (#84). No capture - this is a fold of fixtures already on disk,
 * and it reframes the open question rather than answering it.
 *
 * The premise under audit was "the ore suppresses 31 cliffs at `[1500,1500]`",
 * which every route and every idea has now failed to explain (#129, #137, #138,
 * #140). When that many candidates close, the premise itself is the suspect -
 * the lesson of #136. It survives, and comes out sharper than it went in:
 *
 * - **It is pure SUPPRESSION.** The resources-ON cliff set is a *strict subset*
 *   of the resources-OFF set in all three arms: **zero** cells are lost when the
 *   ore is removed. A perturbed field would move cells both ways; only a
 *   rejection can move them one way, which is the shape test #99 wanted.
 * - **It is exactly ADDITIVE.** 27 (calcite only) + 4 (geyser only) = 31 (all
 *   resources), cell for cell.
 * - **The surviving cells' orientation changes are the destruction CASCADE.**
 *   Take the ore-OFF world, destroy exactly the cells the ore rejects, run the
 *   port's `destroyEnd` cascade, and you get the ore-ON world **exactly** -
 *   positions AND orientations, in all three arms.
 *
 * That last one is the result. It says there is no unexplained *component* of
 * the ore effect at all: every difference between the two worlds, including the
 * 5 / 4 / 1 orientation changes among cells that survive in both, is accounted
 * for by rejection-plus-cascade.
 *
 * **What that does to the open question.** "What mechanism lets the ore reach a
 * cliff?" was the wrong framing to be stuck on: the mechanism is a rejection at
 * the apply stage, exactly as #108 and #113 said, and the cascade is its only
 * secondary effect. What remains open is narrower and much more tractable -
 * **which cells get rejected, and by what criterion.** The shipping rule
 * (`makeVulcanusOreRejection`) already reproduces that criterion at precision
 * 1.000 but does not reach recall 1, so the gap is a geometry question about
 * specific cells, not a missing pathway through the generator.
 *
 * **It is also a second, independent confirmation of the cascade model.** #139
 * confirmed it against the game with a runtime probe that destroys cliffs
 * through Lua; this confirms the same model against ordinary map-generation
 * output, through a completely different instrument. The two agree.
 *
 * **How much of the cascade this fold actually exercises, measured rather than
 * assumed.** Planting a `destroyEnd` that refuses to trim one side each:
 *
 * | planted no-op | this spec |
 * | --- | --- |
 * | every side | fails 3 |
 * | south | fails 3 |
 * | west | fails 2 |
 * | **north** | **passes** |
 * | **east** | **passes** |
 *
 * So the 31 rejections here only ever trim SOUTH and WEST ends, and this fold
 * confirms two of the four directions - it is not a whole-model guard on its
 * own. `test/cliffDestroyProbe.spec.ts` is, and covers north (a `side === 0`
 * plant fails both of its ON arms). Do not read a green run here as the cascade
 * being verified end to end; read the two specs together.
 */

interface Cliff {
  x: number;
  y: number;
  name: string;
  orientation: string;
}
interface Case {
  label: string;
  cliffs: Cliff[];
}

const cases = fixture.cases as unknown as Case[];
const arm = (label: string): Case => {
  const c = cases.find((x) => x.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};
const ON = "entity region, resources ON";
const OFF_ARMS = [
  { label: "entity region, ALL resources OFF", extras: 31 },
  { label: "entity region, calcite OFF", extras: 27 },
  { label: "entity region, geyser OFF", extras: 4 },
];

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
const oi = (name: string): number => CLIFF_ORIENTATION_NAMES.indexOf(name);
/** `pos -> orientation id`, `cliff-vulcanus` only - `crater-cliff` is off-lattice. */
const cellsOf = (c: Case): Map<string, number> =>
  new Map(
    c.cliffs
      .filter((e) => e.name === "cliff-vulcanus")
      .map((e) => [key(e.x, e.y), oi(e.orientation)]),
  );
const SIDE_STEP: readonly (readonly [number, number])[] = [
  [0, -CLIFF_GRID_SIZE],
  [CLIFF_GRID_SIZE, 0],
  [0, CLIFF_GRID_SIZE],
  [-CLIFF_GRID_SIZE, 0],
];
const parse = (k: string): [number, number] => {
  const [x, y] = k.split(",");
  return [Number(x), Number(y)];
};

/** `Cliff::onDestroy`'s cascade over the port's model - the same one #139 confirmed. */
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

const sorted = (m: Map<string, number>): [string, number][] =>
  [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

describe("Vulcanus cliffs: the ore effect decomposes into rejections + cascade (#84)", () => {
  it("reproduces the studied world - 885 cliff-vulcanus with resources ON", () => {
    expect(cellsOf(arm(ON)).size).toBe(885);
  });

  describe("the effect is pure SUPPRESSION, not a perturbed field", () => {
    it.each(OFF_ARMS)("loses ZERO cells when the ore is removed: $label", ({ label, extras }) => {
      const on = cellsOf(arm(ON));
      const off = cellsOf(arm(label));
      const lost = [...on.keys()].filter((k) => !off.has(k));
      const gained = [...off.keys()].filter((k) => !on.has(k));
      // A field perturbation moves cells BOTH ways; a rejection cannot. This is
      // the arm that tells them apart, and it is the direction #99 established
      // by switching the resources off in the game.
      expect(lost, `${label}: cells present with ore and absent without`).toEqual([]);
      expect(gained).toHaveLength(extras);
    });

    it("is exactly additive across the two resources: 27 + 4 = 31", () => {
      const on = cellsOf(arm(ON));
      const extrasOf = (label: string): Set<string> =>
        new Set([...cellsOf(arm(label)).keys()].filter((k) => !on.has(k)));
      const all = extrasOf("entity region, ALL resources OFF");
      const calcite = extrasOf("entity region, calcite OFF");
      const geyser = extrasOf("entity region, geyser OFF");
      expect(calcite.size + geyser.size).toBe(all.size);
      // Not merely equal counts - the same cells, and the two sets are disjoint.
      expect([...calcite].filter((k) => geyser.has(k))).toEqual([]);
      expect([...calcite, ...geyser].sort()).toEqual([...all].sort());
    });
  });

  describe("the ON world IS the OFF world minus the rejected cells, cascaded", () => {
    it.each(OFF_ARMS)("reproduces resources-ON exactly from $label", ({ label }) => {
      const on = cellsOf(arm(ON));
      const cells = cellsOf(arm(label));
      for (const k of [...cells.keys()].filter((k) => !on.has(k))) {
        const [x, y] = parse(k);
        destroy(cells, x, y);
      }
      expect(sorted(cells)).toEqual(sorted(on));
    });

    it("and the cascade is NOT idle - surviving cells really do change orientation", () => {
      // Without this the exact match above would be satisfied by a world where
      // the cascade never fired, and the agreement would say nothing about it.
      const on = cellsOf(arm(ON));
      const changed = (label: string): number => {
        const off = cellsOf(arm(label));
        return [...on].filter(([k, o]) => off.has(k) && off.get(k) !== o).length;
      };
      expect(changed("entity region, ALL resources OFF")).toBe(5);
      expect(changed("entity region, calcite OFF")).toBe(4);
      expect(changed("entity region, geyser OFF")).toBe(1);
    });
  });
});
