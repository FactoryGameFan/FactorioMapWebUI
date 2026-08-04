/**
 * `Cliff::updateConnections` and `Cliff::onDestroy` - the APPLY-time pass that
 * trims a cliff run back to where its connections actually resolve.
 *
 * Everything in `cliffPlacement.ts` models `CliffGenerator::crossingsForChunk`
 * and `EntityMapGenerationTask::generateCliffs`, which decide the crossings and
 * queue a cliff per placing cell. This module models what happens **after**
 * that, in `EntityMapGenerationTask::applyCliffs` (`0x101623c98`), which the
 * port did not touch at all until #84 read it:
 *
 * ```
 * for each queued CliffAddition {u16 protoId, u8 orientation, MapPosition, bool}:
 *     collided = Surface::wouldCollide(proto, position, orientation)   // 0x10160c088
 *     entity   = proto->createEntity(spec)
 *     addEntityToSurface(surface, entity)
 *     if (collided)          -> list A
 *     else if (!record.bool) -> list B          // record.bool is !onChunkBorder
 * for e in list A: e->forceDestroy()
 * for e in list B: e->updateConnections()       // vtable +0x6b0 == Cliff::updateConnections
 * ```
 *
 * Two things follow that are easy to miss and both matter here.
 *
 * **The fifth argument of `tryToAddCliff` is what selects list B.**
 * `generateCliffs` computes `onChunkBorder = (cx==0 || cy==0 || cx==7 || cy==7)`
 * over the chunk's 8x8 cells and passes `!onChunkBorder`; `applyCliffs` skips
 * `updateConnections` when that byte is set. So this whole pass runs on the
 * chunk's outer ring of cells and nowhere else. An earlier note read the flag as
 * "measured not to matter for placement" - true of `tryToAddCliff`, which stores
 * it and never reads it, and false of the queue's consumer.
 *
 * **List B is drained after the whole chunk is on the surface**, so within a
 * chunk there is no placement-order dependence: every cell of the chunk exists
 * by the time any of them checks its neighbours.
 *
 * `Cliff::updateConnections` (`0x1007a90d4`), decompiled whole 2026-08-03:
 *
 * ```
 * if (this->[0x83] == 0) return;                            // see the gate below
 * for side in neighborSidesForOrientation(orientation):     // the ORIGINAL orientation
 *     if chunk at position+4*dir(side) is absent or its status <= 0x31: continue
 *     n = getNeighbor(side)
 *     if n == null || !isCliffConnected(side, this->orientation, n->orientation):
 *         destroyEnd(side)
 * ```
 *
 * The orientation the loop ITERATES is read once, before the loop; the one it
 * COMPARES is re-read from `this+0x80` inside it (`0x1007a91e8`), so a
 * `destroyEnd` earlier in the loop is visible to the sides after it. This module
 * does the same, and that agreement is not accidental - it is why a cell can
 * lose two ends in one pass.
 *
 * **The `this+0x83` gate is `proto->place_as_crater == nullptr`.** The
 * constructor computes it in one instruction, `cmp x8, #0x0; cset w8, eq` on
 * `proto + 0xb90` (`0x1007a7b1c`), and `CliffPrototype` has exactly one optional
 * pointer-valued property, `place_as_crater`, set only by `scaled_cliff_crater`
 * in `base/prototypes/entity/entity-util.lua:325`. The same byte gates
 * `getNeighbor`, `destroyEnd`, `onDestroy`'s cascade, `connectEnd` and
 * `getConnections`. So `cliff-vulcanus` runs all of it and **`crater-cliff` runs
 * none of it** - craters are outside the connection system entirely, which is
 * worth knowing before attributing anything crater-shaped to these rules.
 *
 * `Cliff::destroyEnd(side)` (`0x1007a8d40`) rewrites the orientation to the one
 * with `side` replaced by `none`, and `forceDestroy()`s the cliff when that
 * leaves no end at all. `Cliff::onDestroy` (`0x1007a8770`) then calls
 * `destroyEnd(opposite(side))` on each connected neighbour - which is why a
 * destroyed cell can take a non-border neighbour with it, and why this is a
 * cascade rather than a filter.
 *
 * **Four conditions gate that cascade, and all four are read rather than
 * inferred.** `onDestroy` reaches its neighbour loop only when all of these hold
 * (`0x1007a8854`-`0x1007a8874`), and the right-hand column is what each is on
 * the two paths that matter - `applyCliffs` and a Lua `create_entity` +
 * `destroy`:
 *
 * | gate | cascade needs | map generation | Lua |
 * | --- | --- | --- | --- |
 * | entity flag bit 5 of `+0x6e` | clear | `params[0x80] = 0` | `params[0x80] = 0` |
 * | `this+0x82` | set | ctor writes 1 unconditionally | same ctor |
 * | `this+0x83` | set | `place_as_crater == nullptr` | same |
 * | `map->[0x240]` | zero | only `Map::~Map` writes 1 | same |
 *
 * Bit 5 is exactly `params[0x80] != 0` at construction. `applyCliffs` zeroes it
 * with `str wzr, [x26]` where `x26 = params + 0x80` (`0x101623d9c`), and
 * `LuaSurface::luaCreateEntity`'s cliff arm zeroes the same byte on both of its
 * paths (`strb wzr, [sp, #0x2a8]` at `0x1019e5ba8` and `0x1019e5c18`; that arm is
 * identifiable by the `mov w8, #0x14` sentinel it puts in `params+0x87` before
 * `LuaTable::getDefault<CliffOrientation>`). `map->[0x240]` is "the map is being
 * torn down": `Map::~Map` sets it to 1 as its first act (`0x10163461c`) and
 * `Map::resume` bails on it.
 *
 * **So a runtime probe reproduces map generation's cascade, and #134's warning
 * that it might not is withdrawn.** It was a correct risk stated before the
 * bytes were read, and reading them settles it. The one path that WOULD differ,
 * `Cliff::destroyWithoutCorrection` (`0x1007aa568`, which zeroes `+0x82` around
 * the destroy), is unreachable: zero direct callers under a scan of every `BL`
 * and `B` in `__text`, and no pointer to it in any vtable. `entity.destroy()`
 * cannot land on it by accident.
 *
 * **There is no second connection pass during map generation.**
 * `Cliff::updateAndFixConnections` (`0x1007a94d0`) looks like one and is not: a
 * scan of every `BL` in `__text` finds it called from exactly one site,
 * `CliffEditor::buildCliffs` (`0x100371948`). So a chunk generated later never
 * revisits an earlier chunk's cliffs, and the "generation order lets a later
 * pass clean up" reading is closed.
 *
 * `Cliff::getNeighbor` (`0x1007a8c58`) searches a one-tile box at the neighbour
 * position and accepts an entity only on an exact prototype-id match
 * (`0x1007a8ce4`) AND an exact position match (`0x1007a8cfc`). A `crater-cliff`
 * sitting on a neighbouring cell is therefore not a neighbour.
 *
 * **None of the four tables below is a guess.** Each was extracted from the
 * arm64 slice and each agrees exactly with what the orientation NAMES say, which
 * is the check that they were read in the right order rather than assumed:
 *
 * | table | address | what it holds |
 * | --- | --- | --- |
 * | `CLIFF_ORIENTATION_ENDS[o][0]` | `0x102ed8ff8` | the "from" side of `A-to-B` |
 * | `CLIFF_ORIENTATION_ENDS[o][1]` | `0x102ed9020` | the "to" side |
 * | `oppositeSide` | immediate `0x01000302` | `N<->S`, `E<->W` |
 * | `destroyEnd` | 4 jump tables under `0x102cfc9db` | `side -> none`, else destroy |
 *
 * `test/cliffConnections.spec.ts` re-derives all four from the names and asserts
 * they match, so a transcription slip fails rather than shifts the model.
 */

import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
} from "./cliffCatalog";
import type { PlacedCliffCell } from "./cliffPlacement";

/**
 * `CellSide`, in the engine's enum order. Read off `getNeighborPosition`
 * (`0x1007a9264`), whose four arms add `-grid.y`, `+grid.x`, `+grid.y`, `-grid.x`
 * to the cliff's position in that order. `none` is 4 and is what the end tables
 * store for the `A-to-none` half of a terminating orientation.
 */
export const CELL_SIDE = { north: 0, east: 1, south: 2, west: 3, none: 4 } as const;

/** Cells per chunk axis - a 32-tile chunk over the 4-tile placement grid. */
const CHUNK_CELLS = 32 / CLIFF_GRID_SIZE;

/**
 * `(from, to)` side per `CliffOrientation` id: the two byte tables at
 * `0x102ed8ff8` and `0x102ed9020` that `isCliffConnected` indexes.
 *
 * Written here as a derivation from `CLIFF_ORIENTATION_NAMES` rather than as 20
 * transcribed pairs, because that is exactly what the bytes turned out to be -
 * `west-to-east` is `(west, east)` and so on, all 20, with `none` for the halves.
 * The spec asserts the derivation against the transcribed bytes.
 */
export const CLIFF_ORIENTATION_ENDS: readonly (readonly [number, number])[] =
  CLIFF_ORIENTATION_NAMES.map((name) => {
    const [from, to] = name.split("-to-");
    const side = (s: string): number => CELL_SIDE[s as keyof typeof CELL_SIDE];
    return [side(from), side(to)] as const;
  });

/**
 * `N<->S`, `E<->W`. In the binary this is the immediate `0x01000302` shifted
 * right by `side * 8`, appearing identically in `isCliffConnected`
 * (`0x1007a948c`) and `Cliff::onDestroy` (`0x1007a88e0`); `none` maps to `none`.
 */
export function oppositeSide(side: number): number {
  return side < 4 ? (0x01000302 >>> (side * 8)) & 0xff : CELL_SIDE.none;
}

/**
 * `Cliff::neighborSidesForOrientation` (`0x1007a8a30`): the orientation's ends,
 * `none` dropped. Its 20-entry jump table collapses to 10 blocks - `west-to-east`
 * and `east-to-west` share one, and so on - which is the binary saying outright
 * that only the SET of ends matters here, not their direction.
 */
export function connectedSides(orientation: number): number[] {
  const ends = CLIFF_ORIENTATION_ENDS[orientation];
  if (ends === undefined) return [];
  return ends.filter((s) => s !== CELL_SIDE.none);
}

/**
 * `Cliff::destroyEnd(side)` (`0x1007a8d40`) as a pure function on the
 * orientation: `side` becomes `none`, and `-1` means the cliff is destroyed
 * because nothing is left. A side the orientation does not have is a no-op.
 */
export function destroyEnd(orientation: number, side: number): number {
  const ends = CLIFF_ORIENTATION_ENDS[orientation];
  if (ends === undefined) return orientation;
  const [from, to] = ends;
  let next: readonly [number, number];
  if (from === side) next = [CELL_SIDE.none, to];
  else if (to === side) next = [from, CELL_SIDE.none];
  else return orientation;
  if (next[0] === CELL_SIDE.none && next[1] === CELL_SIDE.none) return -1;
  return CLIFF_ORIENTATION_ENDS.findIndex((e) => e[0] === next[0] && e[1] === next[1]);
}

/**
 * `isCliffConnected(CellSide, CliffOrientation, CliffOrientation)`
 * (`0x1007a93fc`), which is a **parity** test, not a "do they touch" test.
 *
 * A cliff run is directed: `A-to-B` leaves through `B` and the next cell must
 * ENTER through `opposite(B)`, i.e. that side must be its `from`. So my `to` end
 * pairs with their `from` end and my `from` end with their `to` end, and a
 * neighbour that happens to present the right side with the wrong parity does
 * not count as connected. The `csel` at `0x1007a94c8` is what picks which of the
 * two arms applies, on whether `side` is my `from`.
 */
export function isCliffConnected(side: number, mine: number, theirs: number): boolean {
  const a = CLIFF_ORIENTATION_ENDS[mine];
  const b = CLIFF_ORIENTATION_ENDS[theirs];
  if (a === undefined || b === undefined) return false;
  const opp = oppositeSide(side);
  if (a[0] === side) return b[0] !== opp && b[1] === opp;
  return a[1] === side && b[0] === opp && b[1] !== opp;
}

/** Cell-centre delta, in tiles, of the neighbour on `side`. */
const SIDE_STEP: readonly (readonly [number, number])[] = [
  [0, -CLIFF_GRID_SIZE],
  [CLIFF_GRID_SIZE, 0],
  [0, CLIFF_GRID_SIZE],
  [-CLIFF_GRID_SIZE, 0],
];

/** A placed cell carrying the orientation the connection pass left it with. */
export interface ConnectedCliffCell extends PlacedCliffCell {
  readonly orientation: number;
}

/** Orientation id -> a cell code that produces it. The mapping is a bijection. */
const CODE_FOR_ORIENTATION = ((): readonly number[] => {
  const out: number[] = Array.from({ length: CLIFF_ORIENTATION_NAMES.length }, () => -1);
  for (const [code, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION)) out[id] = Number(code);
  return out;
})();

/** True when the cell is on its chunk's outer ring, which is list B's domain. */
export function onChunkBorder(x: number, y: number): boolean {
  const cx = (x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE;
  const cy = (y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE;
  const ix = ((cx % CHUNK_CELLS) + CHUNK_CELLS) % CHUNK_CELLS;
  const iy = ((cy % CHUNK_CELLS) + CHUNK_CELLS) % CHUNK_CELLS;
  return ix === 0 || ix === CHUNK_CELLS - 1 || iy === 0 || iy === CHUNK_CELLS - 1;
}

/** Orientation id -> a cell code that produces it; the mapping is a bijection. */
export function cliffCodeForOrientation(orientation: number): number {
  return CODE_FOR_ORIENTATION[orientation];
}

export interface CliffConnectionOptions {
  /**
   * `Surface::wouldCollide(CliffPrototype const&, MapPosition const&,
   * CliffOrientation)` (`0x10160c088`) - the collision test `applyCliffs` runs
   * per queued cliff. Return `true` to destroy it.
   *
   * **This, not `tryToAddCliff`, is where map generation rejects a cliff**, and
   * the note in `cliffs-NOTES.md` that said otherwise had the two modes the
   * wrong way round. `tryToAddCliff` tests collisions only when the task's mode
   * byte at `this+0x10` is `2`, and the constructors say which is which:
   * `EntityMapGenerationTask(Surface&, MapGenerator const&, ChunkPosition
   * const&, ...)` - real map generation - stores **1** (`0x101622238`), and
   * `EntityMapGenerationTask(MapPreviewGenerator const&, ChunkPosition const&)`
   * stores **2** (`0x101622348`). So mode 2 is the map PREVIEW generator, and on
   * a real map `tryToAddCliff` runs no collision test at all.
   *
   * That matters because the two stages differ in what they do to the
   * NEIGHBOURS. A `tryToAddCliff` rejection simply never queues the cliff, and
   * leaves the neighbour's crossing alone. The `applyCliffs` rejection creates
   * the cliff, adds it to the surface, and then `forceDestroy()`s it - which
   * runs `Cliff::onDestroy` and takes the facing end of every connected
   * neighbour with it. #108 measured that second behaviour and modelled it as
   * `rejectAtCrossingStage`; this is the mechanism it was standing in for.
   */
  readonly collides?: (orientation: number, x: number, y: number) => boolean;
  /**
   * Run `updateConnections` on every cell rather than only on the chunk's outer
   * ring. **Not the game's rule** - `applyCliffs` gates it on the fifth argument
   * of `tryToAddCliff` - and provided only so a spec can measure what the gate
   * is worth. A rule that scored the same either way would not have been read
   * out of `generateCliffs` at all.
   */
  readonly everyCell?: boolean;
  /**
   * Skip the `onDestroy` cascade, i.e. destroy a cliff without telling its
   * neighbours. Also not the game's rule - `Cliff::destroyWithoutCorrection`
   * exists precisely because the ordinary destroy DOES correct - and again only
   * here so the cascade can be scored separately from the rest.
   */
  readonly noCascade?: boolean;
  /** Skip the `updateConnections` pass, leaving only the collision destroys. */
  readonly noUpdateConnections?: boolean;
}

/**
 * Apply the connection pass to a set of placed cells and return the survivors.
 *
 * **Callers must supply a halo.** A cell on the query's outer chunk ring reads
 * its neighbour across the boundary, so cells are needed for one chunk beyond
 * whatever is to be kept, and the `onDestroy` cascade can in principle reach
 * further still. `cliffCellQueryBox`'s existing halo is not enough on its own.
 *
 * The chunk-generated test of `updateConnections` is modelled as "every chunk in
 * the supplied set is generated". That is the one place this is not a
 * transcription: the game skips a side whose neighbouring chunk has status
 * `<= 0x31`, so during a real generation sweep a cliff pointing into a
 * not-yet-generated chunk keeps its end, and this model destroys it. It is
 * therefore an UPPER bound on how much the rule removes - see
 * `test/cliffConnections.spec.ts`, which is what measures whether that bound is
 * tight.
 */
export function applyCliffConnections(
  cells: readonly PlacedCliffCell[],
  opts: CliffConnectionOptions = {},
): ConnectedCliffCell[] {
  const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
  const live = new Map<string, { x: number; y: number; orientation: number }>();
  for (const c of cells) {
    const orientation = CLIFF_CODE_TO_ORIENTATION[c.code];
    if (orientation !== undefined) live.set(key(c.x, c.y), { x: c.x, y: c.y, orientation });
  }

  const neighbour = (
    x: number,
    y: number,
    side: number,
  ): { x: number; y: number; orientation: number } | undefined => {
    const [dx, dy] = SIDE_STEP[side];
    return live.get(key(x + dx, y + dy));
  };

  /**
   * `destroyEnd` plus the `onDestroy` cascade. Recursive because that is what
   * the engine does: `forceDestroy` calls `onDestroy`, which calls `destroyEnd`
   * on the neighbours, either of which can destroy again.
   */
  const doDestroyEnd = (x: number, y: number, side: number): void => {
    const k = key(x, y);
    const cell = live.get(k);
    if (cell === undefined) return;
    const next = destroyEnd(cell.orientation, side);
    if (next === cell.orientation) return;
    if (next !== -1) {
      cell.orientation = next;
      return;
    }
    // The cliff is gone. `Cliff::onDestroy` reads the sides of the orientation
    // it still had at that moment, then tells each existing neighbour to lose
    // its facing end.
    const sides = connectedSides(cell.orientation);
    live.delete(k);
    if (opts.noCascade === true) return;
    for (const s of sides) {
      const n = neighbour(x, y, s);
      if (n !== undefined) doDestroyEnd(n.x, n.y, oppositeSide(s));
    }
  };

  /** `Entity::forceDestroy` on a cliff: it leaves, and its neighbours lose the ends facing it. */
  const forceDestroy = (x: number, y: number): void => {
    const k = key(x, y);
    const cell = live.get(k);
    if (cell === undefined) return;
    const sides = connectedSides(cell.orientation);
    live.delete(k);
    if (opts.noCascade === true) return;
    for (const s of sides) {
      const n = neighbour(x, y, s);
      if (n !== undefined) doDestroyEnd(n.x, n.y, oppositeSide(s));
    }
  };

  /**
   * Chunk order is row-major over the supplied cells, and within a chunk the
   * cells are visited in the order `generateCliffs` queues them (`cy` outer).
   * The real order is the surface's chunk-generation order, which is not
   * knowable from here; the spec's arms are what check the answer does not
   * depend on it.
   */
  const chunkOf = (v: number, centre: number): number => Math.floor((v - centre) / 32);
  const inOrder = (
    pick: (c: { x: number; y: number; orientation: number }) => boolean,
  ): { x: number; y: number; orientation: number }[] =>
    [...live.values()].filter(pick).sort((a, b) => {
      const cy = chunkOf(a.y, CLIFF_CELL_CENTER_Y) - chunkOf(b.y, CLIFF_CELL_CENTER_Y);
      if (cy !== 0) return cy;
      const cx = chunkOf(a.x, CLIFF_CELL_CENTER_X) - chunkOf(b.x, CLIFF_CELL_CENTER_X);
      if (cx !== 0) return cx;
      return a.y - b.y || a.x - b.x;
    });

  /**
   * `applyCliffs`' own two-phase shape, per chunk: every cliff is tested with
   * the orientation it was queued with, and only then are the hits destroyed -
   * so a destroy in this chunk cannot change what its neighbour was tested as.
   */
  const collides = opts.collides;
  if (collides !== undefined) {
    let chunk: string | undefined;
    let doomed: { x: number; y: number }[] = [];
    const flush = (): void => {
      for (const d of doomed) forceDestroy(d.x, d.y);
      doomed = [];
    };
    for (const c of inOrder(() => true)) {
      const id = `${String(chunkOf(c.x, CLIFF_CELL_CENTER_X))},${String(chunkOf(c.y, CLIFF_CELL_CENTER_Y))}`;
      if (id !== chunk) {
        flush();
        chunk = id;
      }
      if (live.get(key(c.x, c.y)) === c && collides(c.orientation, c.x, c.y))
        doomed.push({ x: c.x, y: c.y });
    }
    flush();
  }

  if (opts.noUpdateConnections === true) return emit(live);

  for (const c of inOrder((v) => opts.everyCell === true || onChunkBorder(v.x, v.y))) {
    // It may have been destroyed by an earlier cell's cascade.
    if (live.get(key(c.x, c.y)) !== c) continue;
    for (const side of connectedSides(c.orientation)) {
      if (live.get(key(c.x, c.y)) !== c) break;
      const n = neighbour(c.x, c.y, side);
      if (n === undefined || !isCliffConnected(side, c.orientation, n.orientation))
        doDestroyEnd(c.x, c.y, side);
    }
  }

  return emit(live);
}

const emit = (
  live: Map<string, { x: number; y: number; orientation: number }>,
): ConnectedCliffCell[] =>
  [...live.values()].map((c) => ({
    x: c.x,
    y: c.y,
    code: CODE_FOR_ORIENTATION[c.orientation],
    orientation: c.orientation,
  }));
