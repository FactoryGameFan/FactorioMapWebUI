import { describe, expect, it } from "vite-plus/test";

import batch from "./fixtures/oracle-vulcanus-cliff-entities-border-batch.seed123456.json";
import { CLIFF_CODE_TO_ORIENTATION, cliffCollisionTileBox } from "../src/noise/cliffs/cliffCatalog";
import { cliffCodeForOrientation, onChunkBorder } from "../src/noise/cliffs/cliffConnections";
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
 * **The unexplained residual sits on CHUNK BORDERS - 2.91 sigma over 15 regions,
 * with the prediction registered before the data** (#84).
 *
 * This closes a question that has been open in three stages, and the way it
 * closed matters as much as the answer.
 *
 * | batch | unexplained | on chunk border | base rate | z |
 * | --- | --- | --- | --- | --- |
 * | original 3 regions | 14 | 9 (64.3%) | 45.0% | 1.45 |
 * | +4 regions (#131) | 13 | 9 (69.2%) | 47.2% | 1.59 |
 * | **+8 regions (here)** | 17 | **12 (70.6%)** | 46.0% | **2.03** |
 * | **combined** | **44** | **30 (68.2%)** | ~46.3% | **2.91** |
 *
 * The first row was correctly **dismissed as noise** - at n = 14 any partition
 * lands near there. The second was the same hypothesis on fresh data. This third
 * batch was captured against a prediction written into
 * `captureVulcanusCliffEntitiesBorderBatch`'s doc comment **before it ran**:
 * roughly 26 more unexplained cells with about 17 on a border, taking the
 * combined figure to ~2.9 sigma - and a fall back toward the base rate if the
 * effect was noise.
 *
 * It came back at 12 of 17 and a combined **2.91 sigma**. The effect size is
 * stable across all three batches (64-71%) and so is the base rate it is
 * measured against (45-47%), which is what says the comparison is sound rather
 * than the numerator being lucky.
 *
 * ## Why this points somewhere
 *
 * **Chunk borders are `Cliff::updateConnections`' entire domain.** `applyCliffs`
 * gates it on `tryToAddCliff`'s fifth argument, which is `!onChunkBorder`, so it
 * runs on the chunk's outer ring and nowhere else.
 *
 * > **CORRECTION, 2026-08-03 (#84):** this paragraph used to end "It is the only
 * > rule in the pipeline that treats border cells differently at all." That was
 * > wrong. A cliff's collision box reaches up to 3.371 tiles and a border cell's
 * > centre is 1.5-2.5 tiles from the chunk edge, so 16 of the 20 orientations
 * > reach across an edge from the outer ring and none can from anywhere else -
 * > a second border-only channel. `cliffResidualBoxCrossesChunkEdge.spec.ts`
 * > scores it and finds it **inert**: 7 of 1407 crossing border cells are
 * > unexplained against 14 of 2479 non-crossing, where no-information predicts
 * > 7.6. That strengthens the conclusion below rather than weakening it - the
 * > enrichment is orientation-BLIND, which is what a cell-index gate looks like.
 *
 * And it is exactly the rule the port has the weakest grip on:
 *
 * - `test/cliffConnections.spec.ts` measures it firing **zero** times on our own
 *   cell set, and `applyCliffConnections` documents its model of the rule as an
 *   **UPPER bound** on how much it removes - the one place the port is knowingly
 *   not a transcription.
 * - #122 promoted its gate from inert to load-bearing.
 * - #127 showed the gate cannot be scored from map-generation output at all,
 *   because destruction, `updateConnections` and the crossing field all preserve
 *   connection consistency.
 *
 * So the port models this rule approximately, cannot observe it directly, and
 * the residual it cannot explain is enriched 1.47x on precisely its domain.
 * **That is the first positive evidence that `updateConnections` does anything**,
 * and it is where the next attempt should go.
 *
 * ## What it does NOT say
 *
 * It does not say the 30 border cells are destroyed BY `updateConnections`. The
 * enrichment is a correlation with the rule's domain, not a demonstration of the
 * rule firing - and 14 of the 44 are not on a border at all, so if this is one
 * cause it is not the only one. p is about 0.002, which is a strong hint and not
 * a proof of mechanism.
 *
 * ## The port also generalises, across fifteen regions now
 *
 * | | this batch |
 * | --- | --- |
 * | raw cells / game cliffs | 5581 / 5134 |
 * | raw is a strict superset | **yes, all eight** |
 * | destruction predicate precision | **0.9818** |
 * | destruction predicate recall | **0.8434** |
 *
 * Two of the eight regions have **no unexplained cells at all**, and
 * `[-1600,3200]` reproduces the game exactly - 686 raw, 686 game.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
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
interface Case {
  label: string;
  region: Region;
  cliffs: Ent[];
}
const CASES = batch.cases as unknown as Case[];

interface Totals {
  raw: number;
  game: number;
  rawOnBorder: number;
  ourKill: number;
  gameKill: number;
  agree: number;
  falseRejections: number;
  missed: number;
  ore: number;
  unknown: number;
  unknownOnBorder: number;
  superset: boolean;
  perRegionUnknown: number[];
}

const T: Totals = (() => {
  const t: Totals = {
    raw: 0,
    game: 0,
    rawOnBorder: 0,
    ourKill: 0,
    gameKill: 0,
    agree: 0,
    falseRejections: 0,
    missed: 0,
    ore: 0,
    unknown: 0,
    unknownOnBorder: 0,
    superset: true,
    perRegionUnknown: [],
  };
  for (let i = 0; i < CASES.length; i += 2) {
    const on = CASES[i];
    const off = CASES[i + 1];
    const r = on.region;
    const inR = (p: { x: number; y: number }): boolean =>
      p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
    const game = new Set(
      on.cliffs.filter((e) => e.name === "cliff-vulcanus" && inR(e)).map((e) => K(e.x, e.y)),
    );
    const gameOff = new Set(
      off.cliffs.filter((e) => e.name === "cliff-vulcanus" && inR(e)).map((e) => K(e.x, e.y)),
    );
    const oreSuppressed = new Set([...gameOff].filter((k) => !game.has(k)));
    const cells = makeCliffPlacementFromFields(fields, BANDS)
      .placedCells(r.x0 - 64, r.y0 - 64, r.x1 + 64, r.y1 + 64)
      .filter(inR);
    let regionUnknown = 0;
    for (const p of cells) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      const k = K(p.x, p.y);
      const code = cliffCodeForOrientation(o);
      const box = cliffCollisionTileBox(code, p.x, p.y);
      let lava = false;
      if (box !== undefined)
        for (let tx = box.left; tx <= box.right; tx++)
          for (let ty = box.top; ty <= box.bottom; ty++) if (isLava(tx, ty)) lava = true;
      const ourKill = lava || oreRejects(code, p.x, p.y);
      const gameKill = !game.has(k);
      const border = onChunkBorder(p.x, p.y);
      t.raw++;
      if (border) t.rawOnBorder++;
      if (ourKill) t.ourKill++;
      if (gameKill) t.gameKill++;
      if (ourKill && gameKill) t.agree++;
      else if (ourKill) t.falseRejections++;
      else if (gameKill) {
        t.missed++;
        if (oreSuppressed.has(k)) t.ore++;
        else {
          t.unknown++;
          regionUnknown++;
          if (border) t.unknownOnBorder++;
        }
      }
    }
    const have = new Set(cells.map((p) => K(p.x, p.y)));
    for (const k of game) if (!have.has(k)) t.superset = false;
    t.game += game.size;
    t.perRegionUnknown.push(regionUnknown);
  }
  return t;
})();

/** One-sample binomial z, the same statistic quoted in the doc comment. */
const z = (k: number, n: number, p: number): number => (k - n * p) / Math.sqrt(n * p * (1 - p));

describe("the pre-registered chunk-border test, on eight fresh regions", () => {
  /**
   * The sample and the base rate first, because the enrichment is only worth
   * anything against them. The base rate is stable at 46.0% here against 45.0%
   * and 47.2% in the two earlier batches, so the denominator is not drifting.
   */
  it("captures 5581 raw cells at a 46.0% border base rate", () => {
    expect(CASES.length).toBe(16);
    expect(T.raw).toBe(5581);
    expect(T.game).toBe(5134);
    expect(T.rawOnBorder / T.raw).toBeCloseTo(0.46, 2);
  }, 900000);

  /**
   * **The prediction, and the result.** Registered before the capture: roughly
   * 26 more unexplained cells with about 17 on a border. It came back 17 and 12
   * - fewer cells than predicted, at a HIGHER rate than predicted, and the
   * combined figure landed on the predicted 2.9 sigma.
   */
  it("finds 12 of 17 unexplained cells on a chunk border", () => {
    expect(T.unknown).toBe(17);
    expect(T.unknownOnBorder).toBe(12);
    expect(T.unknownOnBorder / T.unknown).toBeCloseTo(0.706, 3);
    // On its own this batch clears 2 sigma.
    expect(z(T.unknownOnBorder, T.unknown, T.rawOnBorder / T.raw)).toBeGreaterThan(2);
  }, 900000);

  /**
   * **Combined over all fifteen regions: 30 of 44, 2.91 sigma.** Three
   * independent batches, two of them pre-registered, with a stable effect size
   * (64.3%, 69.2%, 70.6%) against a stable base rate (45.0%, 47.2%, 46.0%).
   */
  it("brings the combined figure to 30 of 44 at 2.91 sigma", () => {
    const combinedN = 27 + T.unknown;
    const combinedK = 18 + T.unknownOnBorder;
    expect(combinedN).toBe(44);
    expect(combinedK).toBe(30);
    expect(combinedK / combinedN).toBeCloseTo(0.682, 3);
    expect(z(combinedK, combinedN, 0.463)).toBeCloseTo(2.91, 2);
  }, 900000);

  /**
   * **And the honest limit.** 14 of the 44 are NOT on a border, so if this is one
   * cause it is not the only one - and an enrichment on a rule's domain is not
   * the rule firing. This arm exists so the count cannot be quietly rounded to
   * "the residual is updateConnections".
   */
  it("leaves 14 of the 44 off the border", () => {
    expect(27 + T.unknown - (18 + T.unknownOnBorder)).toBe(14);
  }, 900000);
});

describe("the port on eight more regions it was never fitted to", () => {
  it("keeps the superset property and scores 0.982 / 0.843", () => {
    expect(T.superset).toBe(true);
    expect(T.ourKill).toBe(384);
    expect(T.gameKill).toBe(447);
    expect(T.agree).toBe(377);
    expect(T.agree / T.ourKill).toBeCloseTo(0.9818, 4);
    expect(T.agree / T.gameKill).toBeCloseTo(0.8434, 4);
    expect(T.falseRejections).toBe(7);
  }, 900000);

  /**
   * A quarter of the regions have nothing to explain at all, which is worth
   * pinning: the residual is not a uniform background rate, it is concentrated.
   */
  it("finds two of the eight regions completely explained", () => {
    expect(T.perRegionUnknown).toEqual([0, 2, 4, 0, 1, 4, 3, 3]);
    expect(T.perRegionUnknown.filter((n) => n === 0).length).toBe(2);
    expect(T.missed).toBe(70);
    expect(T.ore).toBe(53);
    expect(T.unknown).toBe(17);
  }, 900000);
});
