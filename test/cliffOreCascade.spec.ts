import { describe, expect, it } from "vite-plus/test";

import ore from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import sweep from "./fixtures/oracle-vulcanus-cliff-fine-sweep.seed123456.json";
import {
  CLIFF_CODE_TO_ORIENTATION,
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

/**
 * **The ore rule's remaining error, measured against a LEVER rather than
 * characterised** - and the refutation of the cascade half of
 * `vulcanusOreRejection.ts`'s open question.
 *
 * That file states the position this spec moves: box overlap explains most of
 * the suppressed cells, "the other 10 are run remainders - every one of the six
 * connected components of the suppressed set contains a directly overlapped cell
 * - and whether that is **a cascade along cliff connections or a wider box** is
 * open."
 *
 * #108 supplied a mechanism that makes the cascade half concrete and testable: a
 * rejection zeroes the cell's four edge registers, so its neighbours' codes -
 * and therefore their ORIENTATIONS, and therefore their collision boxes - change.
 * Re-running the rejection pass to a fixpoint is exactly "a cascade along cliff
 * connections". `rejectionCascades` in `cliffPlacement.ts` is that arm.
 *
 * **It buys nothing.** At the shipping settings it is a bit-for-bit no-op, and on
 * the collapsed rule it is net harmful. Half of the open question is now closed:
 * the remainders are not a cascade of this predicate.
 *
 * The rest of the spec is the positive measurement the lever makes possible.
 * `oracle-vulcanus-cliff-ore-direction` re-ran `[1500,1500]` with the resources
 * switched off through `autoplace_controls`, so the ore's true effect is a known
 * SET of cells rather than an inference, and the port's predicate can be scored
 * for precision and recall against it instead of by how well the totals line up.
 */

const INPUT = { seed0: ore.seed, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);

const codeForOrientation = new Map<number, number>();
for (const [c, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
  codeForOrientation.set(id, Number(c));
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const gameCodeOf = (o: string): number | undefined => {
  const id = nameToId.get(o);
  return id === undefined ? undefined : codeForOrientation.get(id);
};

/** The entity region all four `autoplace_controls` arms were captured over. */
const R = { x0: 1500, y0: 1500, x1: 1756, y1: 1756 };
const inR = (x: number, y: number): boolean => x >= R.x0 && x < R.x1 && y >= R.y0 && y < R.y1;

const gameSet = (label: string): Map<string, number> => {
  const c = ore.cases.find((k) => k.label === label);
  if (c === undefined) throw new Error(`no case ${label}`);
  const m = new Map<string, number>();
  for (const e of c.cliffs) {
    if (e.name !== "cliff-vulcanus" || !inR(e.x, e.y)) continue;
    const code = gameCodeOf(e.orientation);
    if (code !== undefined) m.set(`${String(e.x)},${String(e.y)}`, code);
  }
  return m;
};

/** Shipping settings, both rejections at the crossing stage (#108). */
const portSet = (withOre: boolean, cascade = false): Map<string, number> =>
  new Map(
    makeCliffPlacementFromFields(fields, {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing: VULCANUS_CLIFF_SMOOTHING,
      tileCollides: (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
      cellRejects: withOre ? oreRejects : undefined,
      rejectAtCrossingStage: true,
      rejectionCascades: cascade,
    })
      .placedCells(R.x0, R.y0, R.x1, R.y1)
      .map((p) => [`${String(p.x)},${String(p.y)}`, p.code] as const),
  );

const score = (ours: Map<string, number>, game: Map<string, number>): Record<string, number> => {
  let matched = 0;
  let wrong = 0;
  let surplus = 0;
  let missing = 0;
  for (const [k, c] of ours) {
    const t = game.get(k);
    if (t === undefined) surplus++;
    else if (t === c) matched++;
    else wrong++;
  }
  for (const k of game.keys()) if (!ours.has(k)) missing++;
  return { matched, wrong, surplus, missing };
};

describe("the ore rule's remainder, and whether it cascades", () => {
  /**
   * The lever gives the ore's effect as a SET, so the predicate gets a precision
   * and a recall rather than a total to match. It is **exactly right where it
   * fires and simply too narrow**: every cell it suppresses is one the game
   * suppresses, and it reaches 22 of 31.
   *
   * Note `appeared` is 0. Removing a resource only ever ADDS cliffs, never
   * removes one, which is the one-way property #99 established - re-confirmed
   * here on the entity region rather than the blob.
   */
  it("scores the ore predicate against the resources-off lever", () => {
    const on = gameSet("entity region, resources ON");
    const off = gameSet("entity region, ALL resources OFF");
    const pOn = portSet(true);
    const pOff = portSet(false);

    expect(on.size).toBe(861);
    expect(off.size).toBe(892);

    const suppressed = [...off.keys()].filter((k) => !on.has(k));
    const appeared = [...on.keys()].filter((k) => !off.has(k));
    const recoded = [...off.keys()].filter((k) => on.has(k) && on.get(k) !== off.get(k));
    expect(suppressed.length).toBe(31);
    expect(appeared.length).toBe(0);
    expect(recoded.length).toBe(5);

    const oursSuppressed = [...pOff.keys()].filter((k) => !pOn.has(k));
    const truth = new Set(suppressed);
    const hit = oursSuppressed.filter((k) => truth.has(k)).length;
    expect(oursSuppressed.length).toBe(22);
    expect(hit).toBe(22); // precision 1.000 - it never fires on a cell the game kept
    expect(hit / suppressed.length).toBeCloseTo(0.7097, 3);
  }, 120000);

  /**
   * **The crossing stage explains two of the "run remainders" for free.** The
   * predicate itself fires on 20 of the placed cells, but the placement loses
   * 22 - because zeroing a rejected cell's edges can leave a NEIGHBOUR with a
   * code that no longer places. That is not tuning; it falls out of #108's
   * mechanism, and it is the first thing to have reduced the remainder count
   * since the rule was characterised.
   */
  it("the mechanism accounts for 2 remainders the bare predicate does not", () => {
    const pOff = portSet(false);
    let predicateFires = 0;
    for (const [k, code] of pOff) {
      const [xs, ys] = k.split(",");
      if (oreRejects(code, Number(xs), Number(ys))) predicateFires++;
    }
    const pOn = portSet(true);
    const lost = [...pOff.keys()].filter((k) => !pOn.has(k)).length;

    expect(predicateFires).toBe(20);
    expect(lost).toBe(22);
    expect(lost - predicateFires).toBe(2);
  }, 120000);

  /**
   * **The cascade half of the open question, refuted.** Re-testing to a fixpoint
   * changes not one cell at the shipping settings, and on the collapsed rule it
   * loses 14 matched cells and 7 orientations to gain 4 of the over-placement.
   *
   * So a rejected cell never turns a neighbour into a rejectable orientation.
   * That leaves the "wider box" half of `vulcanusOreRejection.ts`'s question -
   * which is the one that must NOT be tuned into fitting, per #88.
   */
  it("re-testing to a fixpoint buys nothing at shipping and loses on the collapsed rule", () => {
    const on = gameSet("entity region, resources ON");
    const plain = portSet(true);
    const cascaded = portSet(true, true);

    // Bit-for-bit identical, not merely equal in total.
    expect(cascaded.size).toBe(plain.size);
    for (const [k, code] of plain) expect(cascaded.get(k)).toBe(code);
    expect(score(plain, on)).toEqual(score(cascaded, on));

    // And it is not a no-op everywhere - on the collapsed rule it is harmful,
    // which is what makes the shipping no-op a real result rather than an
    // untriggered branch.
    const collapsed = (cascade: boolean): Record<string, number> => {
      let matched = 0;
      let wrong = 0;
      let surplus = 0;
      let missing = 0;
      for (const c of sweep.cases) {
        const ours: Map<string, number> = new Map(
          makeCliffPlacementFromFields(
            { cliffElevation: fields.cliffElevation, cliffiness: (): number => 1 },
            {
              elevation0: c.level,
              interval: 1000000,
              smoothing: 0,
              tileCollides: (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
              cellRejects: oreRejects,
              rejectAtCrossingStage: true,
              rejectionCascades: cascade,
            },
          )
            .placedCells(sweep.region.x0, sweep.region.y0, sweep.region.x1, sweep.region.y1)
            .map((p) => [`${String(p.x)},${String(p.y)}`, p.code] as const),
        );
        const game = new Map<string, number>();
        for (const e of c.cliffs) {
          if (e.name !== "cliff-vulcanus" || !inR(e.x, e.y)) continue;
          const code = gameCodeOf(e.orientation);
          if (code !== undefined) game.set(`${String(e.x)},${String(e.y)}`, code);
        }
        for (const [k, code] of ours) {
          const t = game.get(k);
          if (t === undefined) surplus++;
          else if (t === code) matched++;
          else wrong++;
        }
        for (const k of game.keys()) if (!ours.has(k)) missing++;
      }
      return { matched, wrong, surplus, missing };
    };

    expect(collapsed(false)).toEqual({ matched: 18657, wrong: 691, surplus: 1199, missing: 102 });
    expect(collapsed(true)).toEqual({ matched: 18643, wrong: 698, surplus: 1195, missing: 109 });
  }, 900000);

  /**
   * **How much of `[1500,1500]`'s residual is ore at all.** Running BOTH sides
   * with the resources off answers it: 13 wrong orientations and 10 surplus
   * cells survive with the ore entirely out of the picture. So roughly half the
   * region's remaining error has nothing to do with the ore rule, and tuning
   * that rule cannot reach it.
   */
  it("isolates the non-ore residual by running both sides with resources off", () => {
    const off = gameSet("entity region, ALL resources OFF");
    const on = gameSet("entity region, resources ON");
    expect(score(portSet(false), off)).toEqual({
      matched: 876,
      wrong: 13,
      surplus: 10,
      missing: 3,
    });
    expect(score(portSet(true), on)).toEqual({ matched: 842, wrong: 16, surplus: 19, missing: 3 });
  }, 120000);
});
