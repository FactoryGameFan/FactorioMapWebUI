import { describe, expect, it } from "vite-plus/test";

import more from "./fixtures/oracle-vulcanus-cliff-entities-more-regions.seed123456.json";
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
 * **Four fresh regions: the port generalises, and the unexplained cells are
 * enriched on CHUNK BORDERS - replicated out of sample** (#84).
 *
 * Two things were stuck at a sample size rather than at an idea. The residual's
 * unexplained population was **14** cells, and every structural test on it -
 * chunk-border status, orientation, distance to the region rim - landed at 1.4
 * to 1.9 sigma against its base rate, which is what a partition looks like at
 * n = 14 whether or not a cause exists. And the shipped accuracy figure was
 * measured on **three** regions, chosen years into the investigation for reasons
 * that had nothing to do with sampling.
 *
 * Four more regions, each with the ore lever, at ~2.5s a capture.
 *
 * ## The port generalises
 *
 * | | original 3 regions | these 4 |
 * | --- | --- | --- |
 * | raw cells | 1756 | 2789 |
 * | game cliffs | 1531 | 2590 |
 * | raw is a strict superset | yes | **yes, all four** |
 * | destruction predicate precision | 0.971 | **0.9877** |
 * | destruction predicate recall | 0.889 | **0.8090** |
 *
 * Measured somewhere it was never fitted. `[3000,3000]` is **exact** - 362 raw,
 * 362 game, zero residual - and it is also the one region with no resources at
 * all, which is consistent with everything #123 to #129 established.
 *
 * ## The chunk-border enrichment, replicated
 *
 * | | unexplained | on chunk border | base rate |
 * | --- | --- | --- | --- |
 * | original 3 regions | 14 | 9 (64.3%) | 45.0% |
 * | **these 4** | 13 | **9 (69.2%)** | 47.2% |
 * | combined | **27** | 18 (66.7%) | ~46.3% |
 *
 * **This is a lead, not a result, and the distinction matters.** The replication
 * is 1.59 sigma on its own and the combined figure ~2.1 sigma - short of
 * decisive. What changed is its STATUS: the border hypothesis was formed on the
 * first 14 and is here tested on 13 cells captured afterwards, in regions chosen
 * before the cells were known. That is a pre-registered test on fresh data, not
 * the post-hoc slice that the same 64% would have been worth nothing as.
 *
 * Why it is worth pursuing: **chunk borders are `updateConnections`' entire
 * domain.** It is the one rule in the whole pipeline that treats border cells
 * differently, our port measures it firing zero times, and `applyCliffConnections`
 * documents its model of it as an UPPER bound on how much the rule removes.
 * #122 promoted its gate from inert to load-bearing; #127 showed the gate cannot
 * be scored from map-generation output at all. An enrichment pointing at the
 * same rule from a third direction is the first independent evidence that it
 * does something.
 *
 * The unexplained population is now **27**, which is what actually unblocks the
 * next person: every structural test just doubled its power.
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
  effectiveAutoplace: Record<string, { frequency: number; size: number; richness: number }>;
  cliffs: Ent[];
  resources: Ent[];
}
const CASES = more.cases as unknown as Case[];

interface Score {
  label: string;
  raw: number;
  game: number;
  superset: boolean;
  oreSuppressed: number;
  ourKill: number;
  gameKill: number;
  agree: number;
  falseRejections: number;
  missed: number;
  ore: number;
  unknown: number;
  unknownOnBorder: number;
  rawOnBorder: number;
}

const SCORES: Score[] = (() => {
  const out: Score[] = [];
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
    const raw = makeCliffPlacementFromFields(fields, BANDS)
      .placedCells(r.x0 - 64, r.y0 - 64, r.x1 + 64, r.y1 + 64)
      .filter(inR);

    const s: Score = {
      label: on.label.replace(", resources ON", ""),
      raw: raw.length,
      game: game.size,
      superset: true,
      oreSuppressed: oreSuppressed.size,
      ourKill: 0,
      gameKill: 0,
      agree: 0,
      falseRejections: 0,
      missed: 0,
      ore: 0,
      unknown: 0,
      unknownOnBorder: 0,
      rawOnBorder: 0,
    };
    for (const p of raw) {
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
      if (onChunkBorder(p.x, p.y)) s.rawOnBorder++;
      if (ourKill) s.ourKill++;
      if (gameKill) s.gameKill++;
      if (ourKill && gameKill) s.agree++;
      else if (ourKill) s.falseRejections++;
      else if (gameKill) {
        s.missed++;
        if (oreSuppressed.has(k)) s.ore++;
        else {
          s.unknown++;
          if (onChunkBorder(p.x, p.y)) s.unknownOnBorder++;
        }
      }
    }
    const have = new Set(raw.map((p) => K(p.x, p.y)));
    for (const k of game) if (!have.has(k)) s.superset = false;
    out.push(s);
  }
  return out;
})();

const sum = (f: (s: Score) => number): number => SCORES.reduce((n, s) => n + f(s), 0);

describe("the port on four regions it was never fitted to", () => {
  /**
   * **The raw queue is a strict superset in every one.** Nothing the port must
   * explain anywhere in these regions is a failure to GENERATE a cliff - it is
   * all over-generation, the same property #114 established on the original
   * three.
   */
  it("contains every game cliff in all four regions", () => {
    expect(SCORES.map((s) => s.label)).toEqual([
      "[3000,3000]",
      "[-2000,-2000]",
      "[800,-1500]",
      "[-2600,1200]",
    ]);
    expect(SCORES.every((s) => s.superset)).toBe(true);
    expect(sum((s) => s.raw)).toBe(2789);
    expect(sum((s) => s.game)).toBe(2590);
  }, 300000);

  /**
   * The destruction predicate holds up out of sample: **precision 0.9877,
   * recall 0.8090**, against 0.971 and 0.889 on the original three. Two false
   * rejections in 2789 cells.
   */
  it("scores precision 0.988 and recall 0.809 out of sample", () => {
    expect(sum((s) => s.ourKill)).toBe(163);
    expect(sum((s) => s.gameKill)).toBe(199);
    expect(sum((s) => s.agree)).toBe(161);
    expect(sum((s) => s.agree) / sum((s) => s.ourKill)).toBeCloseTo(0.9877, 4);
    expect(sum((s) => s.agree) / sum((s) => s.gameKill)).toBeCloseTo(0.809, 3);
    expect(sum((s) => s.falseRejections)).toBe(2);
  }, 300000);

  /**
   * **`[3000,3000]` is exact** - 362 raw, 362 game, nothing to explain. It is
   * also the only region with no resource entity at all, which is what every
   * result from #123 onward would predict.
   */
  it("reproduces [3000,3000] exactly, and it has no resources", () => {
    const s = SCORES[0];
    expect(s.raw).toBe(362);
    expect(s.game).toBe(362);
    expect(s.gameKill).toBe(0);
    expect(s.missed).toBe(0);
    expect(CASES[0].resources.length).toBe(0);
  }, 300000);

  /**
   * The missed destructions split the same way #123 found: mostly ore, with a
   * residue no lever reaches. The ore attribution comes from the paired OFF arm,
   * not from our own predicate - the circularity #123 corrected.
   */
  it("splits 38 missed destructions into 25 ore and 13 unexplained", () => {
    expect(sum((s) => s.missed)).toBe(38);
    expect(sum((s) => s.ore)).toBe(25);
    expect(sum((s) => s.unknown)).toBe(13);
  }, 300000);
});

describe("the chunk-border enrichment replicates out of sample", () => {
  /**
   * **The pre-registered test.** The hypothesis was formed on the original 14
   * unexplained cells (9 on a border, 64.3%, against a 45.0% base rate - 1.45
   * sigma, correctly dismissed as noise at that n). These 13 cells were captured
   * afterwards, in regions chosen before any of them was known.
   *
   * They come back at **9 of 13, 69.2%**, against a 47.2% base rate here. Same
   * direction, same magnitude.
   *
   * On its own that is 1.59 sigma and combined about 2.1 - **still short of
   * decisive, and this file does not claim otherwise.** What changed is that it
   * is now a prediction that survived fresh data rather than a slice of the data
   * that suggested it.
   */
  it("finds 9 of 13 unexplained cells on a chunk border, against 47.2%", () => {
    expect(sum((s) => s.unknown)).toBe(13);
    expect(sum((s) => s.unknownOnBorder)).toBe(9);
    const base = sum((s) => s.rawOnBorder) / sum((s) => s.raw);
    expect(base).toBeCloseTo(0.472, 3);
    // The enrichment, and the base rate that makes it mean something.
    expect(sum((s) => s.unknownOnBorder) / sum((s) => s.unknown)).toBeCloseTo(0.692, 3);
  }, 300000);

  /**
   * The combined population, which is what actually unblocks the next attempt:
   * **27 unexplained cells, 18 on a border**. Every structural test on this
   * residual just doubled its power.
   */
  it("brings the unexplained population to 27", () => {
    // 14 from the original three regions (#126), 13 here.
    expect(14 + sum((s) => s.unknown)).toBe(27);
    expect(9 + sum((s) => s.unknownOnBorder)).toBe(18);
  }, 300000);
});
