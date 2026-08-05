import { describe, expect, it } from "vite-plus/test";

import bandsFx from "./fixtures/oracle-vulcanus-cliff-bands.seed123456.json";
import sweep from "./fixtures/oracle-vulcanus-cliff-fine-sweep.seed123456.json";
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
  cliffCollisionTileBox,
} from "../src/noise/cliffs/cliffCatalog";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  makeCliffinessBasic,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeVulcanusOreRejection } from "../src/noise/cliffs/vulcanusOreRejection";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { makeVulcanusRockPlacement } from "../src/noise/preview/renderVulcanusRocks";
import { buildResources } from "../src/noise/preview/renderVulcanusResources";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

/**
 * **What is left of #84 after #108 is a SUPPRESSION, and it is not the field** -
 * plus the measurement that says a wider level sweep would be wasted effort.
 *
 * #108's handoff proposed exactly that sweep: "where the game emits nothing at
 * any level those corners get no bracket, so the field there is still
 * unmeasured; a sweep well outside `[700,900]` is the measurement that would
 * close it." Before spending ~40 headless captures on it, the constraints
 * already on disk were folded together - `oracle-vulcanus-cliff-bands`'s
 * `constant1` arm covers the SAME region under the SAME collapsed rule at
 * 70..1150, so its observations combine with the fine sweep's directly. They
 * answer the question for free, and the answer is that the sweep would find
 * nothing.
 *
 * Three results, in order of how much they constrain:
 *
 * 1. **The field's exoneration is much wider than #107 stated.** That PR checked
 *    998 two-sided brackets. There are also 1,711 corners the game constrains
 *    from ONE side only, and a one-sided bound falsifies just as well as a
 *    bracket - "this corner is above 910" is refuted by a port value of 800.
 *    **0 of the 1,711 contradict the port.**
 * 2. **The silence is not the field running out of range.** 294 corners whose
 *    port value sits in `[700,900]` get no constraint of any kind across all 50
 *    levels from 70 to 1150 - while the port asserts **8,906** crossings on
 *    their edges over those same levels, and there is not one of the 294 where
 *    the port is silent too. A field error would have to move those corners
 *    outside `[70, 1150]` entirely AND leave every one-sided bound elsewhere
 *    satisfied. The game is simply not emitting there.
 * 3. **Two candidate suppressors are refuted with their base rates.** Rocks
 *    (`wouldCollide`'s unported entity half) and the default `cliffiness_basic`
 *    gate both fail to separate the surplus from the matched population.
 *
 * The last one carries a control worth more than the refutation it came from:
 * the game places **8,588** cells where the DEFAULT gate would be fully shut, so
 * the `constant1` routing really did open it. The collapsed-rule oracle that
 * #106, #107 and #108 all rest on is not confounded by the gate it claims to
 * have removed.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
const rockAt = makeVulcanusRockPlacement(ctx);
const cliffiness = makeCliffinessBasic(ctx.seed0);
const G = CLIFF_GRID_SIZE;

const codeForOrientation = new Map<number, number>();
for (const [c, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
  codeForOrientation.set(id, Number(c));
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const gameCodeOf = (o: string): number | undefined => {
  const id = nameToId.get(o);
  return id === undefined ? undefined : codeForOrientation.get(id);
};
const bitsOf = (c: number): number[] => [(c >> 6) & 3, (c >> 4) & 3, (c >> 2) & 3, c & 3];

/** Corner offsets of `(a, b)` as `cross(a, b)` saw them, per edge L, R, T, B. */
const EDGE: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 1],
  [1, 0, 1, 1],
  [0, 0, 1, 0],
  [0, 1, 1, 1],
];

interface Bracket {
  lo: number;
  hi: number;
}
interface SweepCase {
  level: number;
  cliffs: { x: number; y: number; name: string; orientation: string }[];
}

const fineCases = sweep.cases as unknown as SweepCase[];
const bandCases = bandsFx.cases.filter(
  (c) => c.gate === "constant1" && c.region.x0 === 1500,
) as unknown as SweepCase[];
/** Both fixtures hold `[1500,1500]` under `smoothing 0, interval 1e6, gate 1`. */
const allCases = [...fineCases, ...bandCases];
const allLevels = [...new Set(allCases.map((c) => c.level))].sort((a, b) => a - b);

/** Every one-sided constraint the game asserted, folded per corner. */
const reconstruct = (cases: SweepCase[]): Map<string, Bracket> => {
  const bounds = new Map<string, Bracket>();
  const bump = (i: number, j: number, high: boolean, L: number): void => {
    const k = `${String(i)},${String(j)}`;
    const b = bounds.get(k) ?? { lo: -Infinity, hi: Infinity };
    if (high) b.lo = Math.max(b.lo, L);
    else b.hi = Math.min(b.hi, L);
    bounds.set(k, b);
  };
  for (const c of cases)
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

const CI0 = Math.ceil((sweep.region.x0 - CLIFF_CELL_CENTER_X) / G);
const CJ0 = Math.ceil((sweep.region.y0 - CLIFF_CELL_CENTER_Y) / G);
const portAt = (i: number, j: number): number => fields.cliffElevation(i * G, j * G);

describe("what suppresses the cliffs the port still over-places", () => {
  /**
   * One-sided bounds are evidence too, and #107 left them on the table. A corner
   * the game only ever made the HIGH side of a crossing at level `L` is asserted
   * to be above `L`; the port's value must clear it. Across every corner the two
   * fixtures constrain from one side, none is contradicted.
   */
  it("no one-sided bound from the game contradicts the port's field", () => {
    const bounds = reconstruct(allCases);
    let oneSided = 0;
    let contradicting = 0;
    for (let j = CJ0; j <= CJ0 + 64; j++)
      for (let i = CI0; i <= CI0 + 64; i++) {
        const b = bounds.get(`${String(i)},${String(j)}`);
        if (b === undefined || twoSided(b)) continue;
        oneSided++;
        const port = portAt(i, j);
        if ((Number.isFinite(b.lo) && port <= b.lo) || (Number.isFinite(b.hi) && port >= b.hi))
          contradicting++;
      }
    expect(oneSided).toBe(1711);
    expect(contradicting).toBe(0);
  }, 120000);

  /**
   * **Why the wider sweep is not worth capturing.** Adding the bands' 10 levels
   * spans 70..1150 instead of 700..900 - a 5x wider window at 24x the spacing -
   * and it rescues exactly ONE of the 681 corners the fine sweep left
   * unbracketed. If those corners were unobserved because the game's field puts
   * them somewhere the fine sweep does not reach, levels that far out would have
   * caught a great many of them.
   *
   * The complementary half is what makes it conclusive: at the 294 corners the
   * game never constrains at all, the PORT asserts 8,906 crossings over the same
   * levels, and there is no corner among them where the port is also silent. The
   * two sides are not disagreeing about a value, they are disagreeing about
   * whether anything is emitted.
   */
  it("10 more levels spanning 70..1150 rescue 1 of 681 unbracketed corners", () => {
    const fine = reconstruct(fineCases);
    const all = reconstruct(allCases);
    let inRange = 0;
    let unbracketedByFine = 0;
    let noObservation = 0;
    let oneSidedOnly = 0;
    let gained = 0;
    let gainedContainingPort = 0;
    let portCrossingsAtSilent = 0;
    let silentWherePortAlsoSilent = 0;

    for (let j = CJ0; j <= CJ0 + 64; j++)
      for (let i = CI0; i <= CI0 + 64; i++) {
        const port = portAt(i, j);
        if (port < 700 || port > 900) continue;
        inRange++;
        const f = fine.get(`${String(i)},${String(j)}`);
        if (f !== undefined && twoSided(f)) continue;
        unbracketedByFine++;

        const a = all.get(`${String(i)},${String(j)}`);
        if (a === undefined) {
          noObservation++;
          // What the port claims at this corner's four edges, same levels.
          let n = 0;
          for (const [di, dj] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const q = portAt(i + di, j + dj);
            if (q < 0 || port < 0) continue;
            for (const L of allLevels) if (Math.min(port, q) < L && L <= Math.max(port, q)) n++;
          }
          portCrossingsAtSilent += n;
          if (n === 0) silentWherePortAlsoSilent++;
          continue;
        }
        if (!twoSided(a)) {
          oneSidedOnly++;
          continue;
        }
        gained++;
        if (port > a.lo && port < a.hi) gainedContainingPort++;
      }

    expect(inRange).toBe(1659);
    expect(unbracketedByFine).toBe(681);
    expect(noObservation).toBe(294);
    expect(oneSidedOnly).toBe(386);
    expect(gained).toBe(1);
    expect(gainedContainingPort).toBe(1);
    // The port is loudly asserting crossings exactly where the game says nothing.
    expect(portCrossingsAtSilent).toBe(8906);
    expect(silentWherePortAlsoSilent).toBe(0);
  }, 120000);

  /**
   * Two suppressor candidates, each scored against the matched population's own
   * base rate rather than against zero.
   *
   * **Rocks** - `Surface::wouldCollide` also tests entities and the port only
   * models the tile half, so a rock standing where a cliff would go is the
   * obvious unported suppressor. It does not survive: the surplus is at 10.6%
   * against a 7.0% base, and the wrong-orientation cells sit BELOW base at 5.1%.
   * A real suppressor cannot be anti-correlated with half the defect.
   *
   * **The default `cliffiness_basic` gate** - a confound check, not a candidate.
   * The collapsed oracle routes `cliffiness` at a literal 1 so the gate should be
   * gone; if the routing had silently not taken, the residual would just be the
   * gate. It has not: the three populations are flat at 46.0 / 51.4 / 44.9% fully
   * shut, and the game emits 8,588 cells the default gate would have blocked
   * outright. The oracle #106 to #108 rest on is sound on this axis.
   */
  it("neither rocks nor the default cliffiness gate separates the surplus", () => {
    const rockInBox = (code: number, x: number, y: number): boolean => {
      const b = cliffCollisionTileBox(code, x, y);
      if (b === undefined) return false;
      for (let tx = b.left; tx <= b.right; tx++)
        for (let ty = b.top; ty <= b.bottom; ty++) if (rockAt(tx, ty)) return true;
      return false;
    };
    /** Fraction of the cell's four edges the DEFAULT gate would leave open. */
    const gateOpen = (x: number, y: number): number => {
      const ci = (x - CLIFF_CELL_CENTER_X) / G;
      const cj = (y - CLIFF_CELL_CENTER_Y) / G;
      const c = (i: number, j: number): number => cliffiness(i * G, j * G);
      const q = [c(ci, cj), c(ci + 1, cj), c(ci, cj + 1), c(ci + 1, cj + 1)];
      return (
        [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2, (q[0] + q[1]) / 2, (q[2] + q[3]) / 2].filter(
          (e) => e > 0.5,
        ).length / 4
      );
    };

    const tally = {
      matched: { n: 0, rock: 0, shut: 0 },
      surplus: { n: 0, rock: 0, shut: 0 },
      wrong: { n: 0, rock: 0, shut: 0 },
    };

    for (const c of fineCases) {
      const ours = new Map(
        makeCliffPlacementFromFields(
          { cliffElevation: fields.cliffElevation, cliffiness: (): number => 1 },
          {
            elevation0: c.level,
            interval: 1000000,
            smoothing: 0,
            tileCollides: (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
            cellRejects: oreRejects,
            rejectAtCrossingStage: true,
          },
        )
          .placedCells(sweep.region.x0, sweep.region.y0, sweep.region.x1, sweep.region.y1)
          .map((p) => [`${String(p.x)},${String(p.y)}`, p.code] as const),
      );
      const game = new Map<string, number>();
      for (const e of c.cliffs) {
        if (e.name !== "cliff-vulcanus") continue;
        if (e.x < sweep.region.x0 || e.x >= sweep.region.x1) continue;
        if (e.y < sweep.region.y0 || e.y >= sweep.region.y1) continue;
        const code = gameCodeOf(e.orientation);
        if (code !== undefined) game.set(`${String(e.x)},${String(e.y)}`, code);
      }
      for (const [k, code] of ours) {
        const [xs, ys] = k.split(",");
        const x = Number(xs);
        const y = Number(ys);
        const t = game.get(k);
        const bucket = t === undefined ? tally.surplus : t === code ? tally.matched : tally.wrong;
        bucket.n++;
        if (rockInBox(code, x, y)) bucket.rock++;
        if (gateOpen(x, y) === 0) bucket.shut++;
      }
    }

    expect(tally.matched).toEqual({ n: 18657, rock: 1312, shut: 8591 });
    expect(tally.surplus).toEqual({ n: 1199, rock: 127, shut: 616 });
    expect(tally.wrong).toEqual({ n: 691, rock: 35, shut: 309 });

    const rate = (b: { n: number; rock: number }): number => b.rock / b.n;
    // Refuted BY the base rate, not by a bare count: the wrong-code population
    // is anti-correlated with rocks, which no suppressor of it could be.
    expect(rate(tally.wrong)).toBeLessThan(rate(tally.matched));
    expect(rate(tally.surplus) / rate(tally.matched)).toBeLessThan(1.6);

    // The confound control: the game emits thousands of cells the DEFAULT gate
    // would block, so the constant-1 routing genuinely opened it.
    expect(tally.matched.shut).toBeGreaterThan(8000);
  }, 600000);
});
