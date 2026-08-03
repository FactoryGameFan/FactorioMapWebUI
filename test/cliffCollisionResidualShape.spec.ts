import { describe, expect, it } from "vite-plus/test";

import boundary from "./fixtures/oracle-vulcanus-lava-boundary.seed123456.json";
import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { CLIFF_CODE_TO_ORIENTATION, cliffCollisionTileBox } from "../src/noise/cliffs/cliffCatalog";
import { cliffCodeForOrientation } from "../src/noise/cliffs/cliffConnections";
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
 * **The 31 destruction disagreements are not one defect** (#84).
 *
 * `test/cliffDestructionResidual.spec.ts` reduced the whole Vulcanus cliff
 * residual to 31 cells where `Surface::wouldCollide` and our stand-in disagree:
 * 6 the port destroys and the game keeps, 25 the game destroys and the port
 * keeps. #113 left the obvious next question open and named it untested -
 * `Surface::wouldCollide` runs `constCollideWithTile` against the REAL surface
 * while the port resolves tiles from our own Vulcanus model, so a disagreement
 * between the two inside a cliff's box would produce exactly this two-sided error
 * set.
 *
 * It needed no new capture. `oracle-vulcanus-lava-boundary` is a committed
 * 994-position dense capture of `surface.get_tile(x, y).name` on a real 2.1.12
 * Vulcanus surface, and it happens to cover **every tile of all six** false
 * rejections' collision boxes. Our tile model agrees with the game on all 70 of
 * them. The tile half is exonerated in that direction: the game saw the same lava
 * we see and kept the cliff anyway.
 *
 * The 25 in the other direction then split into two populations that cannot share
 * a cause, which is the finding that actually moves #84 - see the second block.
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

/** `surface.get_tile(x, y).name` from the game, at the 994 captured positions. */
const GAME_TILE = new Map<string, string>();
boundary.positions.forEach((p, i) => {
  GAME_TILE.set(K(p.x, p.y), boundary.tileNames[i]);
});

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
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Disputed {
  key: string;
  box: Box;
  /** True when the port destroys and the game keeps; false for the reverse. */
  ourKill: boolean;
}

const cases = entities.cases as unknown as { region: Region; cliffs: Ent[] }[];

/** Every raw cell whose destruction verdict disagrees with the game's. */
const DISPUTED: Disputed[] = (() => {
  const out: Disputed[] = [];
  for (const c of cases) {
    const r = c.region;
    const game = new Set(
      c.cliffs
        .filter(
          (e) =>
            e.name === "cliff-vulcanus" && e.x >= r.x0 && e.x < r.x1 && e.y >= r.y0 && e.y < r.y1,
        )
        .map((e) => K(e.x, e.y)),
    );
    const raw = makeCliffPlacementFromFields(fields, BANDS)
      .placedCells(r.x0, r.y0, r.x1, r.y1)
      .filter((p) => p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1);
    for (const p of raw) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      const box = cliffCollisionTileBox(cliffCodeForOrientation(o), p.x, p.y);
      if (box === undefined) continue;
      let ourLava = false;
      for (let tx = box.left; tx <= box.right; tx++)
        for (let ty = box.top; ty <= box.bottom; ty++) if (isLava(tx, ty)) ourLava = true;
      const ourKill = ourLava || oreRejects(cliffCodeForOrientation(o), p.x, p.y);
      if (ourKill !== !game.has(K(p.x, p.y))) out.push({ key: K(p.x, p.y), box, ourKill });
    }
  }
  return out;
})();

describe("the tile resolver is exonerated where the port over-rejects", () => {
  const falseRejections = DISPUTED.filter((d) => d.ourKill);

  /**
   * **Fold the fixtures you already have before capturing more.** The dense
   * capture was made for a different question - the 35 tiles our mask called lava
   * inside a real cliff's box, back when the collision box was the defect - and
   * it covers every tile of all six of today's false rejections anyway.
   */
  it("has game ground truth for every tile of all 6 boxes", () => {
    expect(falseRejections.length).toBe(6);
    let covered = 0;
    let uncovered = 0;
    for (const d of falseRejections)
      for (let tx = d.box.left; tx <= d.box.right; tx++)
        for (let ty = d.box.top; ty <= d.box.bottom; ty++)
          if (GAME_TILE.has(K(tx, ty))) covered++;
          else uncovered++;
    expect(uncovered).toBe(0);
    expect(covered).toBe(70);
  }, 300000);

  /**
   * **Zero disagreements.** So the game read the same lava out of those boxes
   * that we do, and placed the cliff regardless - which rules out the tile
   * resolver as the cause of the six and leaves the BOX, or the rule, holding it.
   *
   * The vacuity arms matter here more than usual, because "0 mismatches" is also
   * what a comparison that never ran would print: every one of the six boxes does
   * contain lava by our model (that is why they are rejections at all), and the
   * fixture carries both lava and non-lava tiles, so there was something to
   * disagree about at every box.
   */
  it("agrees with the game on all 70 tiles, both directions", () => {
    let mismatches = 0;
    let lavaTilesInBoxes = 0;
    for (const d of falseRejections)
      for (let tx = d.box.left; tx <= d.box.right; tx++)
        for (let ty = d.box.top; ty <= d.box.bottom; ty++) {
          const g = GAME_TILE.get(K(tx, ty));
          if (g === undefined) continue;
          const gLava = VULCANUS_CLIFF_BLOCKING_TILES.has(g);
          if (gLava) lavaTilesInBoxes++;
          if (gLava !== isLava(tx, ty)) mismatches++;
        }
    expect(mismatches).toBe(0);
    // Non-vacuity: the boxes really do contain lava, on both sides.
    expect(lavaTilesInBoxes).toBeGreaterThan(0);
    const names = new Set(boundary.tileNames);
    expect([...names].some((n) => VULCANUS_CLIFF_BLOCKING_TILES.has(n))).toBe(true);
    expect([...names].some((n) => !VULCANUS_CLIFF_BLOCKING_TILES.has(n))).toBe(true);
  }, 300000);
});

/**
 * **The 25 missed destructions are two populations, not one.**
 *
 * Measured as the Chebyshev distance from the cell's collision box to the nearest
 * tile our own model calls lava - no capture needed, and the comparison is
 * against the 1525 cells the port gets right, which supplies the base rate:
 *
 * | distance to our lava | missed (25) | matched (1525) |
 * | --- | --- | --- |
 * | within 2 tiles | **9 (36%)** | 52 (**3.4%**) |
 * | 4 to 11 tiles | 6 | 436 |
 * | none within 12 | 10 | 1037 |
 *
 * The near group is enriched **10.5x** over the base rate, which is the signature
 * of a lava boundary or box that is a tile short - a real, quantified lead, and
 * the one place where a one-tile change to the box could be right.
 *
 * **But ten of the 25 have no lava within twelve tiles**, so no adjustment to a
 * lava collision box can ever reach them, and neither can the ore rule (all 25
 * are `ore = false`) nor any entity (#111's `autoplace_settings` lever moved zero
 * cliffs). They also cluster - `1746,{1530,1534,1538}` is a vertical run of
 * three, `1542/1546,{1550..1558}` a knot, `1622/1626,1614` a pair - where the
 * near group does not.
 *
 * That is worth saying plainly because it contradicts the framing #113 handed
 * over. "Which cells does `Surface::wouldCollide` reject that ours does not" is
 * the right question for at most 15 of the 25; for the other 10 the mechanism is
 * unidentified, and treating all 25 as one collision-box shape problem would be
 * fitting a rule to two causes at once - exactly the failure #88 records.
 */
describe("the 25 missed destructions split by distance to our own lava", () => {
  /** Chebyshev distance from the box to the nearest tile our model calls lava. */
  const lavaDistance = (box: Box): number => {
    for (let d = 0; d <= 12; d++)
      for (let tx = box.left - d; tx <= box.right + d; tx++)
        for (let ty = box.top - d; ty <= box.bottom + d; ty++) {
          const onRing =
            tx <= box.left - d || tx >= box.right + d || ty <= box.top - d || ty >= box.bottom + d;
          if ((d === 0 || onRing) && isLava(tx, ty)) return d;
        }
    return 99;
  };

  /** The same measurement over the cells the port gets right, for the base rate. */
  const matchedDistances = (): number[] => {
    const out: number[] = [];
    for (const c of cases) {
      const r = c.region;
      const game = new Set(
        c.cliffs
          .filter(
            (e) =>
              e.name === "cliff-vulcanus" && e.x >= r.x0 && e.x < r.x1 && e.y >= r.y0 && e.y < r.y1,
          )
          .map((e) => K(e.x, e.y)),
      );
      for (const p of makeCliffPlacementFromFields(fields, BANDS)
        .placedCells(r.x0, r.y0, r.x1, r.y1)
        .filter((q) => q.x >= r.x0 && q.x < r.x1 && q.y >= r.y0 && q.y < r.y1)) {
        const o = CLIFF_CODE_TO_ORIENTATION[p.code];
        if (o === undefined || !game.has(K(p.x, p.y))) continue;
        const box = cliffCollisionTileBox(cliffCodeForOrientation(o), p.x, p.y);
        if (box === undefined) continue;
        let ourLava = false;
        for (let tx = box.left; tx <= box.right; tx++)
          for (let ty = box.top; ty <= box.bottom; ty++) if (isLava(tx, ty)) ourLava = true;
        if (!ourLava && !oreRejects(cliffCodeForOrientation(o), p.x, p.y))
          out.push(lavaDistance(box));
      }
    }
    return out;
  };

  it("finds a near group enriched 10x and a far group lava cannot reach", () => {
    const missed = DISPUTED.filter((d) => !d.ourKill);
    expect(missed.length).toBe(25);
    const md = missed.map((d) => lavaDistance(d.box));
    const near = md.filter((d) => d <= 2).length;
    const far = md.filter((d) => d === 99).length;
    expect(near).toBe(9);
    expect(far).toBe(10);

    const base = matchedDistances();
    expect(base.length).toBe(1525);
    const baseNear = base.filter((d) => d <= 2).length;
    expect(baseNear).toBe(52);

    // The enrichment, and the base rate that makes it mean something.
    const nearRate = near / md.length;
    const baseRate = baseNear / base.length;
    expect(baseRate).toBeCloseTo(0.034, 3);
    expect(nearRate / baseRate).toBeGreaterThan(8);

    // ...and the far group is NOT a rounding artifact of a sparse map: more than
    // two thirds of the cells the port gets right are also far from lava, so
    // "far from lava" is the common case and carries no signal by itself. It is
    // the NEAR group that is unusual.
    expect(base.filter((d) => d === 99).length).toBe(1037);
  }, 300000);

  /**
   * The far group's positions, listed because they are the input to whatever
   * comes next. They fall into three clusters rather than scattering, which is
   * the part that argues against a per-cell collision rule; the clustering is
   * visible in the coordinates and is NOT measured against a base rate here, so
   * read it as the reason to look next, not as a result.
   */
  it("pins the far group's positions", () => {
    const far = DISPUTED.filter((d) => !d.ourKill && lavaDistance(d.box) === 99).map((d) => d.key);
    expect(far.sort((a, b) => a.localeCompare(b))).toEqual([
      "1542,1554.5",
      "1542,1558.5",
      "1546,1550.5",
      "1546,1554.5",
      "1590,1618.5",
      "1602,1622.5",
      "1742,1530.5",
      "1746,1530.5",
      "1746,1534.5",
      "1746,1538.5",
    ]);
  }, 300000);

  /**
   * **CLIFF-versus-CLIFF collision is REFUTED, and it is the first thing anyone
   * will think of, so the refutation is recorded here rather than left to be
   * re-derived.**
   *
   * The reasoning that makes it attractive: `applyCliffs` adds each cliff to the
   * surface immediately after testing it, so cliff N+1's `Surface::wouldCollide`
   * sees cliffs 1..N already there - and #111's `autoplace_settings` lever, which
   * closed the entity half of `wouldCollide`, **cannot remove cliffs**, so this
   * one case was never covered by it. The far ten also sit in tight clusters,
   * which is what a neighbour-versus-neighbour rule would produce.
   *
   * It dies on the base rate. **9 of the far 10 overlap another cliff's box - and
   * so do 1405 of the 1531 cliffs the game KEEPS, 91.8%.** The far group is not
   * enriched; it is marginally below the base rate. A rule that destroyed on box
   * overlap would have destroyed nearly every cliff on the map.
   *
   * There is an independent a-priori reason too, from `factorio-data` @ 2.1.12:
   * the cliff prototype's generic `collision_box` is `{{-0.99,-0.49},{0.99,0.49}}`
   * - `entity-util.lua` calls it "intentionally small" - and cliff cells sit on a
   * 4-tile grid, so two cliffs' generic boxes cannot overlap at all. Only the
   * per-orientation `rotbb` rectangle overlaps, and that is the one this arm
   * scores.
   */
  it("refutes cliff-versus-cliff overlap on the base rate", () => {
    const boxesFor = (c: { region: Region; cliffs: Ent[] }): Map<string, Box> => {
      const m = new Map<string, Box>();
      for (const p of makeCliffPlacementFromFields(fields, BANDS).placedCells(
        c.region.x0 - 8,
        c.region.y0 - 8,
        c.region.x1 + 8,
        c.region.y1 + 8,
      )) {
        const o = CLIFF_CODE_TO_ORIENTATION[p.code];
        if (o === undefined) continue;
        const b = cliffCollisionTileBox(cliffCodeForOrientation(o), p.x, p.y);
        if (b !== undefined) m.set(K(p.x, p.y), b);
      }
      return m;
    };
    const far = new Set(
      DISPUTED.filter((d) => !d.ourKill && lavaDistance(d.box) === 99).map((d) => d.key),
    );

    let farOverlap = 0;
    let kept = 0;
    let keptOverlap = 0;
    for (const c of cases) {
      const r = c.region;
      const game = new Set(
        c.cliffs
          .filter(
            (e) =>
              e.name === "cliff-vulcanus" && e.x >= r.x0 && e.x < r.x1 && e.y >= r.y0 && e.y < r.y1,
          )
          .map((e) => K(e.x, e.y)),
      );
      const boxes = boxesFor(c);
      for (const [k, a] of boxes) {
        const [xs, ys] = k.split(",");
        const x = Number(xs);
        const y = Number(ys);
        if (x < r.x0 || x >= r.x1 || y < r.y0 || y >= r.y1) continue;
        let hits = 0;
        for (const [k2, b] of boxes) {
          if (k2 === k) continue;
          const [xs2, ys2] = k2.split(",");
          if (Math.abs(Number(xs2) - x) > 8 || Math.abs(Number(ys2) - y) > 8) continue;
          if (a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom)
            hits++;
        }
        if (far.has(k)) {
          if (hits > 0) farOverlap++;
        } else if (game.has(k)) {
          kept++;
          if (hits > 0) keptOverlap++;
        }
      }
    }

    expect(farOverlap).toBe(9);
    expect(kept).toBe(1531);
    expect(keptOverlap).toBe(1405);
    // 91.8% of the cliffs the game KEEPS also overlap, so overlap predicts
    // nothing. The far group sits marginally BELOW that rate, not above it.
    const keptRate = keptOverlap / kept;
    expect(keptRate).toBeGreaterThan(0.9);
    expect(farOverlap / 10).toBeLessThan(keptRate + 0.02);
  }, 300000);
});
