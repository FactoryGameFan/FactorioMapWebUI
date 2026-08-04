import { describe, expect, it } from "vite-plus/test";

import batch from "./fixtures/oracle-vulcanus-cliff-entities-border-batch.seed123456.json";
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
 * **A SECOND border-only mechanism exists, and it is measured to be INERT - so
 * the border enrichment is orientation-blind, which is `updateConnections`'
 * signature and not the collision box's** (#84).
 *
 * `cliffResidualBorderEnrichment.spec.ts` reports the residual sitting on chunk
 * borders at 2.91 sigma and says, in its own words, that `updateConnections` "is
 * the only rule in the pipeline that treats border cells differently at all".
 * **That sentence was false**, and the counter-example is arithmetic rather than
 * a new reading:
 *
 * | | distance from the cell centre to the nearest chunk edge |
 * | --- | --- |
 * | border ring (`ix` or `iy` is 0 or 7) | 1.5 - 2.5 tiles |
 * | every interior ring | 5.5 - 6.5 tiles |
 *
 * and the largest half-extent in `CLIFF_ORIENTATION_COLLISION_BOX` is **3.371**
 * tiles. So 16 of the 20 orientations reach across a chunk edge from the outer
 * ring, and none of them can from anywhere else - a border-only channel with
 * nothing to do with `updateConnections`. The first `describe` asserts both
 * halves of that against the real cell population rather than leaving it as
 * arithmetic.
 *
 * There is a specific rule on the far side of it, read out of the binary on
 * 2026-08-03. `applyCliffs` rejects through `Surface::wouldCollide`
 * (`0x10160c088`), whose tile half is `Surface::constCollideWithTile`
 * (`0x100732eec`) -> `Surface::checkTileCollisions` (`0x101b579e0`), which per
 * tile calls `Surface::getEffectiveTileID` (`0x10049399c`) and **skips the tile
 * when the id is 0** (`tst w0, #0xffff; b.eq`). `getEffectiveTileID` returns
 * exactly 0 when the chunk is absent - the range and null arms from
 * `0x100493a60` onwards all fall through to `mov w27, #0x0`. So a box reaching
 * into a chunk that is not generated yet reads **no tile there and does not
 * collide**, while this port reads the real tile everywhere.
 *
 * ## What was discriminated, and the losing condition, both registered first
 *
 * Two mechanisms both predict a border enrichment and differ in one observable:
 * whether the ORIENTATION matters.
 *
 * - `updateConnections` is orientation-blind about the border. Its gate is
 *   `!onChunkBorder` from `generateCliffs`, a pure cell-index test. Under it a
 *   border cell whose box stays inside its chunk is exactly as suspect as one
 *   whose box crosses.
 * - The box mechanism fires only when the box actually crosses, so the crossing
 *   cells carry the whole effect and the rest fall back to the base rate.
 *
 * The losing condition was written down before the run: **a non-crossing border
 * rate that is not lower than the crossing one refutes the box mechanism.**
 *
 * ## The result: refuted, and by the margin that leaves no room
 *
 * | population | unexplained | rate |
 * | --- | --- | --- |
 * | interior | 9 / 4484 | 0.20% |
 * | border, box crosses a chunk edge | 7 / 1407 | **0.50%** |
 * | border, box does not cross | 14 / 2479 | **0.56%** |
 *
 * Under "crossing carries no information beyond `border`" the expected crossing
 * count is `21 * 1407/3886 = 7.6`. **Observed 7.** The sharper predicate is not
 * merely weaker than hoped, it is indistinguishable from the null, and the
 * non-crossing rate is if anything the higher of the two.
 *
 * The mechanism's own direction fails too. An absent neighbour chunk makes the
 * game KEEP a cliff this port destroys - a FALSE REJECTION, not a missed
 * destruction - so its signature is a false rejection whose blocking tile lies
 * across a chunk edge. There are 9 false rejections here and **zero** of them
 * have any blocking tile on the far side of an edge.
 *
 * ## Why a refutation is the useful outcome
 *
 * The border enrichment now has one fewer competing explanation, and the
 * surviving one gained a property it did not have: the effect is **orientation-
 * blind**, which is what a cell-index gate looks like and not what a geometric
 * reach looks like. Every border-only channel this port can currently name has
 * been scored, and only `updateConnections` is left unscored - because #127
 * showed it cannot be scored from map-generation output at all.
 *
 * ## The sample
 *
 * The twelve regions captured in #131 and #132 - every region whose ON and
 * resources-OFF arms sit in one fixture, so the ore split is computed exactly as
 * in the two specs above. The three original regions are not here; their
 * unexplained cells are classified in `cliffMissedDestructionsLever.spec.ts`
 * against different fixtures. n is 30 of the 44, and it is the OUT-OF-SAMPLE 30
 * - the border counts reproduce #131's 9 of 13 and #132's 12 of 17 exactly,
 * which is the arm saying this harness is the same measurement.
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

/** Chunk index of a tile index. Chunks are 32 tiles and the origin is a corner. */
const chunkOfTile = (t: number): number => Math.floor(t / 32);

interface Ent {
  x: number;
  y: number;
  name: string;
}
interface Case {
  label: string;
  region: { x0: number; y0: number; x1: number; y1: number };
  cliffs: Ent[];
}
const CASES = [...(more.cases as unknown as Case[]), ...(batch.cases as unknown as Case[])];

interface Cell {
  border: boolean;
  crosses: boolean;
  ourKill: boolean;
  gameKill: boolean;
  ore: boolean;
  /** A blocking tile inside the box that sits in a different chunk than the centre. */
  lavaAcrossEdge: boolean;
}

const CELLS: Cell[] = (() => {
  const out: Cell[] = [];
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
    for (const p of cells) {
      const o = CLIFF_CODE_TO_ORIENTATION[p.code];
      if (o === undefined) continue;
      const code = cliffCodeForOrientation(o);
      const box = cliffCollisionTileBox(code, p.x, p.y);
      if (box === undefined) continue;
      const cx = chunkOfTile(Math.floor(p.x));
      const cy = chunkOfTile(Math.floor(p.y));
      const crosses =
        chunkOfTile(box.left) !== cx ||
        chunkOfTile(box.right) !== cx ||
        chunkOfTile(box.top) !== cy ||
        chunkOfTile(box.bottom) !== cy;
      let lava = false;
      let lavaAcrossEdge = false;
      for (let tx = box.left; tx <= box.right; tx++)
        for (let ty = box.top; ty <= box.bottom; ty++)
          if (isLava(tx, ty)) {
            lava = true;
            if (chunkOfTile(tx) !== cx || chunkOfTile(ty) !== cy) lavaAcrossEdge = true;
          }
      const k = K(p.x, p.y);
      out.push({
        border: onChunkBorder(p.x, p.y),
        crosses,
        ourKill: lava || oreRejects(code, p.x, p.y),
        gameKill: !game.has(k),
        ore: oreSuppressed.has(k),
        lavaAcrossEdge,
      });
    }
  }
  return out;
})();

/** The unexplained residual: the game destroyed it, we kept it, and it is not ore. */
const isUnknown = (c: Cell): boolean => c.gameKill && !c.ourKill && !c.ore;

interface Rate {
  k: number;
  n: number;
}
const rate = (pick: (c: Cell) => boolean): Rate => ({
  k: CELLS.filter((c) => pick(c) && isUnknown(c)).length,
  n: CELLS.filter(pick).length,
});

const ALL = rate(() => true);
const INTERIOR = rate((c) => !c.border);
const BORDER = rate((c) => c.border);
const CROSS = rate((c) => c.border && c.crosses);
const NOCROSS = rate((c) => c.border && !c.crosses);

describe("the collision box singles out the border ring by geometry", () => {
  /**
   * The arithmetic the whole comparison rests on, asserted against the real cell
   * population rather than left in prose. If an interior cell ever crosses an
   * edge the discrimination below stops meaning anything.
   */
  it("lets only border cells cross a chunk edge", () => {
    const crossing = CELLS.filter((c) => c.crosses);
    expect(crossing.length).toBe(1407);
    expect(crossing.every((c) => c.border)).toBe(true);
  });

  it("leaves most border cells NOT crossing, so the two are separable", () => {
    expect(CROSS.n).toBe(1407);
    expect(NOCROSS.n).toBe(2479);
  });

  /**
   * The harness reproduces the two published batches cell for cell - #131's
   * 9 of 13 and #132's 12 of 17 - which is what says this is the same
   * measurement partitioned differently rather than a new one.
   */
  it("reproduces the published border counts, 21 of 30", () => {
    expect(ALL.k).toBe(30);
    expect(BORDER.k).toBe(21);
    expect(ALL.n).toBe(8370);
    expect(BORDER.n).toBe(3886);
  });
});

describe("REFUTED: crossing carries no information beyond `border`", () => {
  /**
   * The registered losing condition was "a non-crossing border rate that is not
   * lower than the crossing one refutes the box mechanism". It came back
   * slightly HIGHER, so the refutation is not marginal.
   */
  it("finds the non-crossing border rate no lower than the crossing one", () => {
    const cross = CROSS.k / CROSS.n;
    const nocross = NOCROSS.k / NOCROSS.n;
    expect(CROSS.k).toBe(7);
    expect(NOCROSS.k).toBe(14);
    expect(nocross).toBeGreaterThanOrEqual(cross);
  });

  /**
   * The same thing as a count rather than a ratio: spread the 21 border cells
   * over the two populations in proportion and the crossing share is 7.6.
   * Observed 7 - inside one cell of the null, which is as close to "this
   * predicate is noise" as a sample of 21 can get.
   */
  it("lands within one cell of the no-information expectation", () => {
    const expected = (BORDER.k * CROSS.n) / BORDER.n;
    expect(expected).toBeGreaterThan(7);
    expect(expected).toBeLessThan(8);
    expect(Math.abs(CROSS.k - expected)).toBeLessThan(1);
  });

  /**
   * And the enrichment that IS real survives the partition unchanged, which is
   * the arm proving the comparison had something to find. Border cells are
   * 2.7x the interior rate whether or not their box crosses.
   */
  it("keeps the border-versus-interior enrichment in both halves", () => {
    const interior = INTERIOR.k / INTERIOR.n;
    expect(CROSS.k / CROSS.n).toBeGreaterThan(2 * interior);
    expect(NOCROSS.k / NOCROSS.n).toBeGreaterThan(2 * interior);
  });
});

describe("the absent-chunk tile read explains no false rejection either", () => {
  /**
   * Its signature is the opposite of the residual: the game KEEPS a cliff this
   * port destroys, because the tile that made us destroy it sits in a chunk that
   * was not generated when `applyCliffs` ran. So every false rejection it could
   * explain must have a blocking tile across a chunk edge. None does.
   */
  it("finds zero of the 9 false rejections with a blocking tile across an edge", () => {
    const fr = CELLS.filter((c) => c.ourKill && !c.gameKill);
    expect(fr.length).toBe(9);
    expect(fr.filter((c) => c.lavaAcrossEdge).length).toBe(0);
  });

  /**
   * Non-vacuity: cells whose blocking tile IS across an edge exist in the
   * population, so "zero" above is a measurement and not an empty predicate.
   */
  it("is not vacuous - the predicate fires elsewhere in the population", () => {
    expect(CELLS.filter((c) => c.lavaAcrossEdge).length).toBeGreaterThan(0);
  });
});
