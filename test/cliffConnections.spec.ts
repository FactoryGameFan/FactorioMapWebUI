import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import levers from "./fixtures/oracle-vulcanus-cliff-suppressor-levers.seed123456.json";
import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_ORIENTATION_NAMES,
  cliffCollisionTileBox,
} from "../src/noise/cliffs/cliffCatalog";
import {
  CLIFF_ORIENTATION_ENDS,
  applyCliffConnections,
  cliffCodeForOrientation,
  connectedSides,
  destroyEnd,
  isCliffConnected,
  oppositeSide,
} from "../src/noise/cliffs/cliffConnections";
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
 * **`EntityMapGenerationTask::applyCliffs` - the stage the port had never
 * read** (#84), and what it costs to leave it out.
 *
 * #111 handed over the sharpest statement the residual has had: with neither
 * ore nor lava in the world at `[1500,1500]`, recall is **1.0000**, so the port
 * is a strict SUPERSET of the game's cells and everything left is
 * over-placement. That reframed the question from "what do we miss" to "what
 * else does the game refuse", and named the exclusion list as still open on
 * principle.
 *
 * The answer was not another suppressor. It is that `generateCliffs` does not
 * place cliffs at all - it QUEUES them - and the code that drains the queue was
 * never read:
 *
 * ```
 * for each queued CliffAddition:
 *     collided = Surface::wouldCollide(proto, position, orientation)
 *     addEntityToSurface(surface, proto->createEntity(spec))
 *     if (collided)          -> list A
 *     else if (!record.bool) -> list B          // record.bool is !onChunkBorder
 * for e in list A: e->forceDestroy()            // -> Cliff::onDestroy
 * for e in list B: e->updateConnections()
 * ```
 *
 * Three findings come out of that, in ascending order of what they are worth.
 *
 * 1. **`tryToAddCliff` runs NO collision test during map generation.** It tests
 *    only when the task's mode byte is 2, and the constructors say mode 2 is
 *    `MapPreviewGenerator` (`0x101622348`) while real map generation is mode 1
 *    (`0x101622238`). `cliffs-NOTES.md` had these the wrong way round. So every
 *    rejection on a real map happens in `applyCliffs`, on an entity that has
 *    already been created and added to the surface, by destroying it.
 * 2. **Destroying a cliff takes its neighbours' facing ends with it.**
 *    `Cliff::onDestroy` calls `destroyEnd(opposite(side))` on each connected
 *    neighbour, and `destroyEnd` rewrites the orientation - or destroys again,
 *    which is why this cascades. That is the mechanism `rejectAtCrossingStage`
 *    (#108) was an empirical stand-in for.
 * 3. **The wrong orientations were never an independent defect.** They are that
 *    cascade's fallout, and the arm below reproduces the game's entire cliff set
 *    at `[1500,1500]` - 1058 cells, positions AND orientations, zero errors -
 *    from destroying 12 cells and letting the rule do the rest.
 *
 * `Cliff::updateConnections` itself, the other half of the drain, is ported here
 * and **fires zero times** on this data. It is recorded as read-and-inert rather
 * than as confirmed; see the arm that says so.
 */

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);
const oreRejects = makeVulcanusOreRejection(buildResources(ctx), ctx.vulcanusResourceControls);
const tileCollides = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);
const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const K = (x: number, y: number): string => `${String(x)},${String(y)}`;

const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};

/**
 * `Surface::wouldCollide`'s tile half for a Vulcanus cliff: the orientation's
 * box against the lava tiles, which is the same geometry `tileCollides` already
 * drives through `cliffPlacement` - only the STAGE it runs at is different.
 */
const lavaCollides = (orientation: number, x: number, y: number): boolean => {
  const box = cliffCollisionTileBox(cliffCodeForOrientation(orientation), x, y);
  if (box === undefined) return false;
  for (let tx = box.left; tx <= box.right; tx++)
    for (let ty = box.top; ty <= box.bottom; ty++) if (tileCollides(tx, ty)) return true;
  return false;
};
const lavaAndOre = (orientation: number, x: number, y: number): boolean =>
  lavaCollides(orientation, x, y) || oreRejects(cliffCodeForOrientation(orientation), x, y);

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
const gameSet = (cliffs: Ent[], r: Region): Map<string, number> => {
  const m = new Map<string, number>();
  for (const e of cliffs) {
    if (e.name !== "cliff-vulcanus") continue;
    if (e.x < r.x0 || e.x >= r.x1 || e.y < r.y0 || e.y >= r.y1) continue;
    const id = nameToId.get(e.orientation ?? "");
    if (id !== undefined) m.set(K(e.x, e.y), id);
  }
  return m;
};

interface Score {
  matched: number;
  wrong: number;
  surplus: number;
  missing: number;
}
const score = (port: Map<string, number>, game: Map<string, number>): Score => {
  const s: Score = { matched: 0, wrong: 0, surplus: 0, missing: 0 };
  for (const [k, id] of port) {
    const t = game.get(k);
    if (t === undefined) s.surplus++;
    else if (t === id) s.matched++;
    else s.wrong++;
  }
  for (const k of game.keys()) if (!port.has(k)) s.missing++;
  return s;
};

/** The crossing field and the repair alone - no rejection of any kind. */
const rawCells = (
  r: Region,
  pad: number,
): ReturnType<ReturnType<typeof makeCliffPlacementFromFields>["placedCells"]> =>
  makeCliffPlacementFromFields(fields, BANDS).placedCells(
    r.x0 - pad,
    r.y0 - pad,
    r.x1 + pad,
    r.y1 + pad,
  );

/**
 * **The four tables, each re-derived from the orientation NAMES and asserted
 * against the bytes transcribed from the arm64 slice.**
 *
 * This is the check that they were read in the right order rather than assumed.
 * `CLIFF_ORIENTATION_ENDS` is written in the source as a name derivation, so
 * without these arms it would be a restatement of `CLIFF_ORIENTATION_NAMES` with
 * no tie to the binary at all - the literals below are that tie, and a
 * transcription slip fails here rather than quietly shifting the model.
 */
describe("the connection tables, against the bytes", () => {
  /** `0x102ed8ff8` and `0x102ed9020`, the two byte tables `isCliffConnected` indexes. */
  const ENDS_FROM = [3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 4, 1, 4, 0, 4, 2, 4];
  const ENDS_TO = [1, 2, 3, 0, 0, 1, 2, 3, 2, 3, 0, 1, 4, 1, 4, 3, 4, 2, 4, 0];

  it("matches the two end tables entry for entry", () => {
    expect(CLIFF_ORIENTATION_ENDS.map((e) => e[0])).toEqual(ENDS_FROM);
    expect(CLIFF_ORIENTATION_ENDS.map((e) => e[1])).toEqual(ENDS_TO);
    // Non-vacuity: `none` (4) appears only on the eight half orientations, so
    // the tables are not trivially satisfiable by a constant.
    expect(ENDS_FROM.filter((v) => v === 4).length).toBe(4);
    expect(ENDS_TO.filter((v) => v === 4).length).toBe(4);
  });

  /** The immediate `0x01000302`, shared by `isCliffConnected` and `onDestroy`. */
  it("matches the opposite-side immediate", () => {
    expect([0, 1, 2, 3].map(oppositeSide)).toEqual([2, 3, 0, 1]);
    expect(oppositeSide(4)).toBe(4);
  });

  /**
   * `Cliff::destroyEnd`'s four jump tables under `0x102cfc9db`, evaluated for
   * every (side, orientation) pair. `-1` is the `forceDestroy` landing block at
   * `0x1007a8e3c`; an entry equal to the input orientation is the "this side is
   * not one of my ends" no-op arm at `0x1007a8e64`.
   */
  const DESTROY_END_TABLE: readonly (readonly number[])[] = [
    [0, 17, 2, 18, 12, 13, 6, 7, 8, 15, 14, 11, 12, 13, 14, 15, -1, 17, 18, -1], // north
    [12, 1, 15, 3, 4, 16, 17, 7, 8, 9, 19, 18, 12, -1, -1, 15, 16, 17, 18, 19], // east
    [0, 16, 2, 19, 4, 5, 14, 15, 12, 9, 10, 13, 12, 13, 14, 15, 16, -1, -1, 19], // south
    [13, 1, 14, 3, 19, 5, 6, 18, 17, 16, 10, 11, -1, 13, 14, -1, 16, 17, 18, 19], // west
  ];

  it("matches destroyEnd for all 80 (side, orientation) pairs", () => {
    for (let side = 0; side < 4; side++)
      for (let o = 0; o < CLIFF_ORIENTATION_NAMES.length; o++)
        expect([side, o, destroyEnd(o, side)]).toEqual([side, o, DESTROY_END_TABLE[side][o]]);
    // Non-vacuity: the table really does all three things, so a rule that only
    // ever kept, or only ever destroyed, would fail rather than pass.
    // 8 of the 80 destroy (the half orientations asked to lose their one end),
    // 24 rewrite (12 full orientations, two ends each), 48 are the no-op arm.
    const flat = DESTROY_END_TABLE.flat();
    expect(flat.filter((v) => v === -1).length).toBe(8);
    expect(flat.filter((v, i) => v === i % 20).length).toBe(48);
    expect(flat.filter((v, i) => v !== -1 && v !== i % 20).length).toBe(24);
  });

  /**
   * `neighborSidesForOrientation`'s 20-entry jump table collapses onto 10
   * blocks, pairing each orientation with its reverse - `west-to-east` with
   * `east-to-west` and so on. That is the binary saying outright that only the
   * SET of ends matters there, which is why `connectedSides` is direction-blind
   * while `isCliffConnected` is not.
   */
  it("gives direction-blind neighbour sides, as the shared jump blocks say", () => {
    const REVERSE_PAIRS = [
      [0, 2],
      [1, 3],
      [4, 9],
      [5, 10],
      [6, 11],
      [7, 8],
      [12, 15],
      [13, 14],
      [16, 19],
      [17, 18],
    ];
    for (const [a, b] of REVERSE_PAIRS)
      expect([...connectedSides(a)].sort((p, q) => p - q)).toEqual(
        [...connectedSides(b)].sort((p, q) => p - q),
      );
    // The twelve full orientations have two ends, the eight halves have one.
    expect(CLIFF_ORIENTATION_NAMES.map((_, o) => connectedSides(o).length)).toEqual([
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
  });

  /**
   * **`isCliffConnected` is a PARITY test, not a "do they touch" test**, and
   * that is the part a plausible reimplementation gets wrong. A cliff run is
   * directed: `A-to-B` leaves through `B`, so the next cell must ENTER through
   * `opposite(B)` - that side must be its `from`. A neighbour presenting the
   * right side with the wrong parity is NOT connected.
   */
  it("requires opposite parity, not just a shared side", () => {
    const id = (n: string): number => nameToId.get(n) ?? -1;
    const EAST = 1;
    // west-to-east leaves east; its neighbour must enter from the west.
    expect(isCliffConnected(EAST, id("west-to-east"), id("west-to-east"))).toBe(true);
    expect(isCliffConnected(EAST, id("west-to-east"), id("west-to-north"))).toBe(true);
    // Same shared side, wrong parity: the neighbour ENDS at west instead of
    // starting there. Touching, not connected.
    expect(isCliffConnected(EAST, id("west-to-east"), id("east-to-west"))).toBe(false);
    expect(isCliffConnected(EAST, id("west-to-east"), id("none-to-west"))).toBe(false);
    // And a neighbour with no west end at all.
    expect(isCliffConnected(EAST, id("west-to-east"), id("north-to-south"))).toBe(false);
    // The other arm: my `from` end pairs with their `to` end.
    expect(isCliffConnected(3, id("west-to-east"), id("north-to-east"))).toBe(true);
    expect(isCliffConnected(3, id("west-to-east"), id("east-to-north"))).toBe(false);
  });
});

/**
 * **The result: the residual at `[1500,1500]` is 12 DESTRUCTIONS, and nothing
 * else.**
 *
 * Scored in #111's cleanest arm - resources and lava both removed from the world
 * on both sides - where the port was 1049 matched, 9 wrong orientations, 12
 * surplus, 0 missing against 1058 game cells.
 *
 * Destroy those 12 through `Cliff::onDestroy` and the answer is **exact**: 1058
 * of 1058, positions and orientations, nothing wrong, nothing surplus, nothing
 * missing. Only the 12 are fitted; the 9 orientation outcomes are PREDICTED, and
 * so is the absence of any further destruction - a cascade that ran one step too
 * far would have shown up as `missing`.
 */
describe("the wrong orientations are the cascade, not a second defect", () => {
  const R = levers.region;
  const game = gameSet(
    (levers.cases.find((c) => c.label === "resources OFF, LAVA TILES OFF")?.cliffs ?? []) as Ent[],
    R,
  );

  const cells = (): ReturnType<typeof applyCliffConnections> =>
    applyCliffConnections(
      makeCliffPlacementFromFields(fields, { ...BANDS, rejectAtCrossingStage: true }).placedCells(
        R.x0 - 64,
        R.y0 - 64,
        R.x1 + 64,
        R.y1 + 64,
      ),
    );
  const inR = (p: { x: number; y: number }): boolean =>
    p.x >= R.x0 && p.x < R.x1 && p.y >= R.y0 && p.y < R.y1;

  it("starts from #111's 9 wrong and 12 surplus", () => {
    expect(game.size).toBe(1058);
    const port = new Map(
      cells()
        .filter(inR)
        .map((p) => [K(p.x, p.y), p.orientation] as const),
    );
    expect(score(port, game)).toEqual({ matched: 1049, wrong: 9, surplus: 12, missing: 0 });
  }, 120000);

  it("reproduces the game EXACTLY once those 12 are destroyed", () => {
    const before = cells();
    const doomed = new Set(
      before.filter((p) => inR(p) && !game.has(K(p.x, p.y))).map((p) => K(p.x, p.y)),
    );
    expect(doomed.size).toBe(12);

    const after = applyCliffConnections(before, {
      collides: (_o, x, y) => doomed.has(K(x, y)),
    });
    const port = new Map(after.filter(inR).map((p) => [K(p.x, p.y), p.orientation] as const));
    expect(score(port, game)).toEqual({ matched: 1058, wrong: 0, surplus: 0, missing: 0 });
  }, 120000);

  /**
   * **The arm that makes the one above mean something.** Removing the same 12
   * cells WITHOUT telling their neighbours leaves all 9 wrong orientations
   * standing - so the exact result is the cascade's doing and not an artifact of
   * deleting cells the game happens not to have.
   *
   * `updateConnections` is switched off here as well, and it has to be: with the
   * cascade gone the dangling ends it looks for finally exist, and it repairs 7
   * of the 9 by itself. Worth knowing - the two mechanisms overlap, and the
   * cascade is the one that gets all 9 - but it would confound this control.
   */
  it("leaves all 9 wrong when the cascade is switched off", () => {
    const before = cells();
    const doomed = new Set(
      before.filter((p) => inR(p) && !game.has(K(p.x, p.y))).map((p) => K(p.x, p.y)),
    );
    const bare = applyCliffConnections(before, {
      collides: (_o, x, y) => doomed.has(K(x, y)),
      noCascade: true,
      noUpdateConnections: true,
    });
    const port = new Map(bare.filter(inR).map((p) => [K(p.x, p.y), p.orientation] as const));
    expect(score(port, game)).toEqual({ matched: 1049, wrong: 9, surplus: 0, missing: 0 });

    // The overlap, measured rather than asserted away.
    const withConn = applyCliffConnections(before, {
      collides: (_o, x, y) => doomed.has(K(x, y)),
      noCascade: true,
    });
    const port2 = new Map(withConn.filter(inR).map((p) => [K(p.x, p.y), p.orientation] as const));
    expect(score(port2, game).wrong).toBe(2);
  }, 120000);
});

/**
 * **Scored against the shipping model over all three oracle regions.**
 *
 * `rejectAtCrossingStage` zeroes a rejected cell's four edges. The real stage
 * destroys the entity and lets `Cliff::onDestroy` take the facing end of each
 * CONNECTED neighbour - one or two sides, not four, and by rewriting the
 * orientation rather than by clearing a crossing. Running the same lava and ore
 * predicates through the real stage instead:
 *
 * | model | matched | wrong | surplus | missing |
 * | --- | --- | --- | --- | --- |
 * | `rejectAtCrossingStage` (ships) | 1504 | 21 | 22 | 6 |
 * | `applyCliffs`, lava + ore | **1508** | **18** | 22 | **5** |
 * | `applyCliffs`, no cascade | 1500 | 25 | 22 | 6 |
 *
 * Better on three of four counts and worse on none, and the no-cascade row is
 * what says the cascade rather than the re-staging is doing it.
 *
 * **It is deliberately NOT wired into `renderVulcanusCliffs`.** The renderer
 * paints positions and ignores orientation, and on positions alone the two
 * models are a wash - 1526 against 1525 matched of 1531, one cell. Adopting it
 * there means running the pass over a padded query and filtering afterwards,
 * which is a change to the geometry `test/renderTiling` pins byte-identical
 * between the whole render and 64 tiles. That is worth doing on its own evidence,
 * not smuggled in for one cell.
 */
describe("the apply stage against rejectAtCrossingStage", () => {
  interface Row {
    label: string;
    total: Score;
  }

  const run = (): Row[] => {
    const rows: Row[] = [
      { label: "rejectAtCrossingStage", total: { matched: 0, wrong: 0, surplus: 0, missing: 0 } },
      { label: "applyCliffs", total: { matched: 0, wrong: 0, surplus: 0, missing: 0 } },
      { label: "applyCliffs-noCascade", total: { matched: 0, wrong: 0, surplus: 0, missing: 0 } },
    ];
    for (const c of entities.cases as unknown as { region: Region; cliffs: Ent[] }[]) {
      const r = c.region;
      const game = gameSet(c.cliffs, r);
      const inR = (p: { x: number; y: number }): boolean =>
        p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;

      const shipped = new Map(
        makeCliffPlacementFromFields(fields, {
          ...BANDS,
          tileCollides,
          cellRejects: oreRejects,
          rejectAtCrossingStage: true,
        })
          .placedCells(r.x0, r.y0, r.x1, r.y1)
          .map((p) => [K(p.x, p.y), CLIFF_CODE_TO_ORIENTATION[p.code] ?? -1] as const),
      );
      const raw = rawCells(r, 64);
      const ported = (noCascade: boolean): Map<string, number> =>
        new Map(
          applyCliffConnections(raw, { collides: lavaAndOre, noCascade })
            .filter(inR)
            .map((p) => [K(p.x, p.y), p.orientation] as const),
        );

      const each = [shipped, ported(false), ported(true)];
      each.forEach((port, i) => {
        const s = score(port, game);
        rows[i].total.matched += s.matched;
        rows[i].total.wrong += s.wrong;
        rows[i].total.surplus += s.surplus;
        rows[i].total.missing += s.missing;
      });
    }
    return rows;
  };

  it("beats it on three counts and loses on none", () => {
    const [shipped, apply, noCascade] = run();
    expect(shipped.total).toEqual({ matched: 1504, wrong: 21, surplus: 22, missing: 6 });
    expect(apply.total).toEqual({ matched: 1508, wrong: 18, surplus: 22, missing: 5 });
    expect(noCascade.total).toEqual({ matched: 1500, wrong: 25, surplus: 22, missing: 6 });

    expect(apply.total.matched).toBeGreaterThan(shipped.total.matched);
    expect(apply.total.wrong).toBeLessThan(shipped.total.wrong);
    expect(apply.total.missing).toBeLessThan(shipped.total.missing);
    expect(apply.total.surplus).toBe(shipped.total.surplus);
    // ...and on POSITION alone it is one cell, which is why the renderer is
    // left alone. Both are 22 surplus; the gain is entirely in orientation.
    expect(apply.total.matched + apply.total.wrong).toBe(1526);
    expect(shipped.total.matched + shipped.total.wrong).toBe(1525);
  }, 300000);
});

/**
 * **`Cliff::updateConnections` is ported and INERT, and that is recorded rather
 * than dressed up.**
 *
 * It was the lead that opened all of this: it runs only on the chunk's outer
 * ring (`applyCliffs` gates it on `tryToAddCliff`'s fifth argument, which is
 * `!onChunkBorder`), it only ever removes, and 9 of the 12 surplus cells at
 * `[1500,1500]` sit on that ring against a 44% base rate. Ported exactly, it
 * finds a dangling end **zero** times.
 *
 * That is a real negative result and it is worth keeping: the port's own cell
 * set is already connection-consistent, so nobody needs to re-derive this pass
 * hoping it explains a surplus. It also means the chunk-border gate cannot be
 * SCORED here - `everyCell` gives the identical answer, because neither fires.
 * Do not read that as evidence the gate was read wrongly; read it as unscored.
 *
 * **The one place it does fire is the outer rim of whatever was computed**,
 * where the neighbour is missing only because nobody asked for it. That is the
 * halo artifact `applyCliffConnections` warns about rather than a finding, and
 * it is what these arms hold apart: inside the region the pass is a no-op at
 * every halo, and the count of cells it touches at the rim falls to zero as the
 * halo grows past them.
 */
describe("updateConnections is read, ported, and fires zero times", () => {
  const R = levers.region;
  const inR = (p: { x: number; y: number }): boolean =>
    p.x >= R.x0 && p.x < R.x1 && p.y >= R.y0 && p.y < R.y1;

  it("changes nothing inside the region, at any halo, gate on or off", () => {
    const asKeys = (cells: ReturnType<typeof applyCliffConnections>): string[] =>
      cells
        .filter(inR)
        .map((p) => `${K(p.x, p.y)}:${String(p.orientation)}`)
        .sort((a, b) => a.localeCompare(b));

    let reference: string[] | undefined;
    for (const pad of [16, 64, 128]) {
      const raw = makeCliffPlacementFromFields(fields, {
        ...BANDS,
        rejectAtCrossingStage: true,
      }).placedCells(R.x0 - pad, R.y0 - pad, R.x1 + pad, R.y1 + pad);

      const untouched = asKeys(applyCliffConnections(raw, { noUpdateConnections: true }));
      expect(asKeys(applyCliffConnections(raw, {}))).toEqual(untouched);
      expect(asKeys(applyCliffConnections(raw, { everyCell: true }))).toEqual(untouched);
      reference ??= untouched;
      // ...and the halo does not change the answer inside the region either.
      expect(untouched).toEqual(reference);
      expect(untouched.length).toBe(1070);
    }
  }, 300000);

  /**
   * The rim firings, counted so the "zero times" above cannot be read as "the
   * pass never runs". At a 16-tile halo the query's own edge cells still have
   * neighbours the pass cannot see; at 128 the disturbance no longer reaches
   * the region. If both counts were zero, the arm above would be vacuous.
   */
  it("does fire at the edge of what was computed, and that reach is finite", () => {
    const touched = (pad: number): number => {
      const raw = makeCliffPlacementFromFields(fields, {
        ...BANDS,
        rejectAtCrossingStage: true,
      }).placedCells(R.x0 - pad, R.y0 - pad, R.x1 + pad, R.y1 + pad);
      const before = applyCliffConnections(raw, { noUpdateConnections: true });
      const after = applyCliffConnections(raw, {});
      const b = new Map(before.map((p) => [K(p.x, p.y), p.orientation] as const));
      let n = 0;
      for (const p of after) if (b.get(K(p.x, p.y)) !== p.orientation) n++;
      return n + (before.length - after.length);
    };
    expect(touched(0)).toBeGreaterThan(0);
    expect(touched(128)).toBeGreaterThan(0);
  }, 300000);
});
