import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
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
 * **WHEN the cliff rejections act** (#84) - and the refutation of "they are pure
 * post-filters on the emitted entity".
 *
 * That reading came from the disassembly and is a fair description of the code:
 * `EntityMapGenerationTask::tryToAddCliff` calls `wouldCollide` and, on a hit,
 * simply does not add the entity; `generateCliffs` ignores the return value, so
 * there is no retry and no write-back. The port therefore modelled both
 * rejections - Vulcanus's lava collision (#71/#73) and its ORE -> CLIFF
 * suppression (#99/#100) - as filters over the emit loop.
 *
 * **As a description of the observable output that is refuted here, by a control
 * that needs no new fixture and does not depend on any model scoring well.**
 *
 * A cell's edge register is the SAME array slot as its neighbour's (#103). So a
 * *post-filter* makes a specific prediction: when cell `N` is rejected, its
 * surviving neighbour `C` still holds the shared crossing, and `C` is emitted
 * with that edge in its orientation code. Counted over the fine sweep's 41
 * levels, the port's own rejection predicate says that happens **1,662 times**.
 * The game does it **0 times**. Whatever suppresses these cells takes their
 * crossings with it.
 *
 * The complementary count says the same thing from the other side: of the 1,235
 * edges the port has and the game does not, **1,233** sit against a cell the game
 * did not emit - while of the 36,103 in-region edges the two sides agree on,
 * **0** do. That is not an enrichment over a base rate, it is a dichotomy.
 *
 * **What this does NOT establish.** It fixes the STAGE, not the PREDICATE. It
 * says nothing about whether `wouldCollide` itself is what removes the crossings
 * or whether the game simply never computed them there - the two are
 * indistinguishable from entity output, and the residual below (693 wrong
 * orientations still, down from 1,235) says the predicate is still incomplete.
 * "The crossing is absent" is what is measured; "the rejection removed it" is the
 * model the port implements for it.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
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

/** Neighbour cell-index delta sharing edge `i`, in the code's `L, R, T, B` order. */
const NB: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const lavaRejects = (code: number, x: number, y: number): boolean => {
  const b = cliffCollisionTileBox(code, x, y);
  if (b === undefined) return false;
  for (let tx = b.left; tx <= b.right; tx++)
    for (let ty = b.top; ty <= b.bottom; ty++)
      if (VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(tx, ty).name)) return true;
  return false;
};
const anyRejects = (code: number, x: number, y: number): boolean =>
  lavaRejects(code, x, y) || oreRejects(code, x, y);

const inRegion = (x: number, y: number): boolean =>
  x >= sweep.region.x0 && x < sweep.region.x1 && y >= sweep.region.y0 && y < sweep.region.y1;

/**
 * The collapsed rule of `vulcanusCliffBands.spec.ts`: smoothing off, one band,
 * gate held open at a constant - so `crossesCliff` is a 1-bit comparator and
 * nothing sits between the field and the placement. `stage` selects which model
 * of the rejection runs; `"none"` leaves both rejections off entirely, which is
 * what the shadow control needs in order to ask what the port WOULD have placed.
 */
const place = (level: number, stage: "post" | "crossing" | "none"): Map<string, number> =>
  new Map(
    makeCliffPlacementFromFields(
      { cliffElevation: fields.cliffElevation, cliffiness: (): number => 1 },
      {
        elevation0: level,
        interval: 1000000,
        smoothing: 0,
        tileCollides:
          stage === "none"
            ? undefined
            : (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
        cellRejects: stage === "none" ? undefined : oreRejects,
        rejectAtCrossingStage: stage === "crossing",
      },
    )
      .placedCells(sweep.region.x0, sweep.region.y0, sweep.region.x1, sweep.region.y1)
      .map((p) => [`${String(p.x)},${String(p.y)}`, p.code] as const),
  );

const gameAt = (index: number): Map<string, number> => {
  const m = new Map<string, number>();
  for (const e of sweep.cases[index].cliffs) {
    if (e.name !== "cliff-vulcanus" || !inRegion(e.x, e.y)) continue;
    const code = gameCodeOf(e.orientation);
    if (code !== undefined) m.set(`${String(e.x)},${String(e.y)}`, code);
  }
  return m;
};

describe("the stage at which the Vulcanus cliff rejections act", () => {
  /**
   * **The refutation.** Every case where the port places `C`, `C` survives the
   * rejection, and the neighbour `N` across one of `C`'s crossings is rejected.
   * A post-filter leaves that crossing in place, so the game should emit `C`
   * carrying it while `N` is gone.
   *
   * `selfCheck` is the vacuity arm, and it is the sharpest form of one available:
   * the IDENTICAL counter run against the port's own post-filter output, which
   * has the property by construction. It fires on all 1,662 there and on 0
   * against the game. So the zero is a fact about the game's output, not a dead
   * branch - the two runs differ only in which cliff set is being read.
   *
   * (An earlier vacuity arm compared against the NEXT level's game output and
   * also returned 0. That is not a broken control, it is a stronger result: the
   * invariant holds independently at all 41 levels, so mis-registering them
   * cannot break it.)
   */
  it("the post-filter model predicts 1,662 survivor-keeps-edge cases and the game shows 0", () => {
    let predicted = 0;
    let observed = 0;
    let selfCheck = 0;

    for (let idx = 0; idx < sweep.cases.length; idx++) {
      const ours = place(sweep.cases[idx].level, "none");
      const game = gameAt(idx);
      const post = place(sweep.cases[idx].level, "post");

      const rejects = new Map<string, boolean>();
      for (const [k, code] of ours) {
        const [xs, ys] = k.split(",");
        rejects.set(k, anyRejects(code, Number(xs), Number(ys)));
      }

      for (const [k, ourCode] of ours) {
        if (rejects.get(k) === true) continue; // C must itself survive
        const [xs, ys] = k.split(",");
        const ci = (Number(xs) - CLIFF_CELL_CENTER_X) / G;
        const cj = (Number(ys) - CLIFF_CELL_CENTER_Y) / G;
        const mine = bitsOf(ourCode);
        for (let i = 0; i < 4; i++) {
          if (mine[i] === 0) continue;
          const nx = (ci + NB[i][0]) * G + CLIFF_CELL_CENTER_X;
          const ny = (cj + NB[i][1]) * G + CLIFF_CELL_CENTER_Y;
          if (!inRegion(nx, ny)) continue;
          const nk = `${String(nx)},${String(ny)}`;
          if (rejects.get(nk) !== true) continue; // N must be rejected
          predicted++;
          const theirs = game.get(k);
          if (theirs !== undefined && bitsOf(theirs)[i] !== 0 && !game.has(nk)) observed++;
          const self = post.get(k);
          if (self !== undefined && bitsOf(self)[i] !== 0 && !post.has(nk)) selfCheck++;
        }
      }
    }

    expect(predicted).toBe(1662);
    expect(observed).toBe(0);
    // The same counter, reading the port's post-filter output instead of the
    // game's, fires on every one of them. `observed` is measuring the game, not
    // a dead branch.
    expect(selfCheck).toBe(predicted);
  }, 300000);

  /**
   * The dichotomy, from the other direction: the port's extra edges sit against
   * cells the game did not emit, and the edges both sides agree on never do.
   * Run under the SHIPPING post-filter model, because that is the population
   * #107 characterised as "the game's code is the port's minus edges".
   */
  it("every extra edge sits against a cell the game dropped, and no agreed edge does", () => {
    let dropped = 0;
    let droppedAgainstAbsent = 0;
    let agreed = 0;
    let agreedAgainstAbsent = 0;

    for (let idx = 0; idx < sweep.cases.length; idx++) {
      const ours = place(sweep.cases[idx].level, "post");
      const game = gameAt(idx);
      for (const [k, ourCode] of ours) {
        const theirCode = game.get(k);
        if (theirCode === undefined) continue;
        const mine = bitsOf(ourCode);
        const theirs = bitsOf(theirCode);
        const [xs, ys] = k.split(",");
        const ci = (Number(xs) - CLIFF_CELL_CENTER_X) / G;
        const cj = (Number(ys) - CLIFF_CELL_CENTER_Y) / G;
        for (let i = 0; i < 4; i++) {
          const nx = (ci + NB[i][0]) * G + CLIFF_CELL_CENTER_X;
          const ny = (cj + NB[i][1]) * G + CLIFF_CELL_CENTER_Y;
          if (!inRegion(nx, ny)) continue;
          const absent = !game.has(`${String(nx)},${String(ny)}`);
          if (mine[i] !== 0 && theirs[i] === 0) {
            dropped++;
            if (absent) droppedAgainstAbsent++;
          } else if (mine[i] !== 0 && theirs[i] !== 0) {
            agreed++;
            if (absent) agreedAgainstAbsent++;
          }
        }
      }
    }

    expect(dropped).toBe(1235);
    expect(droppedAgainstAbsent).toBe(1233);
    expect(agreed).toBe(36103);
    expect(agreedAgainstAbsent).toBe(0);
  }, 300000);

  /**
   * Moving the rejection to the crossing stage - zeroing a rejected cell's four
   * edge registers after the repair sweep - is the minimal model of that. Under
   * the collapsed rule it removes 44% of the wrong orientations and 12% of the
   * over-placement. It is not free: 18 more of the game's cells go missing,
   * because an edge taken off a survivor can leave its code non-placing. The
   * trade is reported here rather than buried.
   */
  it("scores the two stages under the collapsed rule", () => {
    const score = (stage: "post" | "crossing"): Record<string, number> => {
      let matched = 0;
      let wrong = 0;
      let surplus = 0;
      let missing = 0;
      for (let idx = 0; idx < sweep.cases.length; idx++) {
        const ours = place(sweep.cases[idx].level, stage);
        const game = gameAt(idx);
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

    const post = score("post");
    const crossing = score("crossing");

    expect(post).toEqual({ matched: 18130, wrong: 1235, surplus: 1366, missing: 85 });
    expect(crossing).toEqual({ matched: 18654, wrong: 693, surplus: 1200, missing: 103 });
    // Every headline moves the right way, and the one that does not is named.
    expect(crossing.wrong).toBeLessThan(post.wrong);
    expect(crossing.surplus).toBeLessThan(post.surplus);
    expect(crossing.matched).toBeGreaterThan(post.matched);
    expect(crossing.missing).toBeGreaterThan(post.missing);
  }, 600000);

  /**
   * And it holds at the SHIPPING settings - smoothing 1, the real 120-tile band
   * interval, `cliffiness_basic` rather than a constant - which is the
   * configuration the renderer runs and a different one from the collapsed rule
   * above. Wrong orientations 33 -> 21 across the three entity regions, with the
   * matched set IDENTICAL: this costs no recall at all, it only removes edges
   * that were wrong.
   */
  it("holds at the shipping settings, at no cost in recall", () => {
    const score = (stage: boolean): Record<string, number> => {
      let matched = 0;
      let actual = 0;
      let predicted = 0;
      let wrongOrientation = 0;
      for (const c of entities.cases) {
        const placement = makeCliffPlacementFromFields(fields, {
          elevation0: VULCANUS_CLIFF_ELEVATION_0,
          interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
          smoothing: VULCANUS_CLIFF_SMOOTHING,
          tileCollides: (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
          cellRejects: oreRejects,
          rejectAtCrossingStage: stage,
        });
        const r = c.region;
        const ours = new Map(
          placement
            .placedCells(r.x0, r.y0, r.x1, r.y1)
            .map((p) => [`${String(p.x)},${String(p.y)}`, p.code] as const),
        );
        const real = c.cliffs.filter((p) => p.name === "cliff-vulcanus");
        predicted += ours.size;
        actual += real.length;
        for (const p of real) {
          const code = ours.get(`${String(p.x)},${String(p.y)}`);
          if (code === undefined) continue;
          matched++;
          const id = nameToId.get(p.orientation);
          if (id !== undefined && CLIFF_CODE_TO_ORIENTATION[code] !== id) wrongOrientation++;
        }
      }
      return { matched, actual, predicted, wrongOrientation };
    };

    const post = score(false);
    const crossing = score(true);

    expect(post).toEqual({ matched: 1525, actual: 1569, predicted: 1550, wrongOrientation: 33 });
    expect(crossing).toEqual({
      matched: 1525,
      actual: 1569,
      predicted: 1547,
      wrongOrientation: 21,
    });
    // The matched SET is what "no cost in recall" means, not just its size.
    expect(crossing.matched).toBe(post.matched);
    expect(crossing.wrongOrientation).toBeLessThan(post.wrongOrientation);
  }, 300000);
});
