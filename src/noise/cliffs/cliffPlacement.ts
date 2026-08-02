/**
 * Cliff placement: turns the two cliff fields (`cliffElevation`, `cliffiness`,
 * from `makeCliffFields`) into placed cliff cell centers on the game's 4-tile
 * placement grid, via `CliffGenerator::crossesCliff` and
 * `CellCliffCrossing::toMaybeCliffOrientation` (see `cliffCatalog.ts` and
 * `docs/noise/cliffs-NOTES.md` "Placement rule" / "Cell -> cliff (orientation
 * code)" sections for the disasm-confirmed rule this ports).
 */

import type { CliffFieldCtx } from "./cliffFields";
import { makeCliffFields } from "./cliffFields";
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_GRID_SIZE,
  cliffBoxCoversTile,
  cliffCollisionTileBox,
  cliffOrientationForCode,
  getModifiedElevationInterval,
  isCliffPlaced,
} from "./cliffCatalog";

/**
 * `CliffGenerator::crossesCliff(a, b, cliffinessAvg, elevation_0, interval)`
 * (`0x101606d08`): does the edge between two corners with elevations `a`/`b`
 * cross a cliff band, and if so, which way? Returns `0` (no crossing), `+1`
 * (crossing up, low->high as a/b order), or `-1` (crossing down).
 *
 * Both elevations must be non-negative and their max must reach `elevation_0`;
 * the cliffiness gate compares the AVERAGE of the two corners' cliffiness to
 * `0.5` (not `> 0`) - see cliffs-NOTES.md for why this makes sense given
 * `cliffiness_nauvis in {0,10}`.
 */
export function crossesCliff(
  a: number,
  b: number,
  cliffAvg: number,
  e0: number,
  interval: number,
): -1 | 0 | 1 {
  if (a < 0 || b < 0) return 0;
  const boundary = e0 + interval * Math.floor((Math.max(a, b) - e0) / interval);
  if (boundary < e0) return 0;
  const dA = a - boundary;
  const dB = b - boundary;
  if (cliffAvg > 0.5) {
    if (dA < 0 && dB > 0) return 1;
    if (dA > 0 && dB < 0) return -1;
  }
  return 0;
}

/** 2-bit edge-crossing encoding used to assemble a cell's `code`: -1 -> 3. */
function enc(v: -1 | 0 | 1): number {
  return v < 0 ? 3 : v;
}

interface CornerSample {
  elev: number;
  cliff: number;
}

/**
 * The two fields the placement pass samples at the corner lattice. Nauvis builds
 * these from `makeCliffFields`, Vulcanus from `makeVulcanusCliffFields`; the
 * geometry below does not care which, because `crossesCliff` and the 4-tile
 * lattice are engine behaviour, not planet behaviour.
 */
export interface CliffFields {
  readonly cliffElevation: (x: number, y: number) => number;
  readonly cliffiness: (x: number, y: number) => number;
}

/** Band phase and spacing, after the frequency lever has been applied. */
export interface CliffBands {
  /** `cliff_elevation_0`: the elevation of the first cliff band. */
  readonly elevation0: number;
  /** `cliff_elevation_interval`, already divided by the frequency lever. */
  readonly interval: number;
  /**
   * `cliff_smoothing`, 0..1. Defaults to **0** here, which is Nauvis's value -
   * NOT the prototype default of 1. See `smoothedElevation` below: this is a
   * planet-level constant, and getting it wrong is invisible on Nauvis and
   * catastrophic on Vulcanus.
   */
  readonly smoothing?: number;
  /**
   * Run `CellEdgeCliffCrossingArray::fixImpossibleCells`, the game's per-chunk
   * repair sweep. Defaults to **true**, because the game always runs it -
   * `crossingsForChunk` calls it unconditionally at its tail. Pass `false` only
   * to measure what it changes.
   */
  readonly fixImpossibleCells?: boolean;
  /** When true, `placedCells` returns nothing (continuity or richness is 0). */
  readonly disabled?: boolean;
  /**
   * The game's tile-collision rejection: return `true` for a tile a cliff cannot
   * occupy. Omit it and no rejection runs, which is what every caller did before
   * 2026-07-30.
   *
   * `EntityMapGenerationTask::tryToAddCliff` (`0x101625038`) looks up the cell's
   * orientation, takes that orientation's `collision_bounding_box`, and calls
   * `wouldCollide` (`0x101625468`) against the tile mask grid; on a hit the
   * cliff is simply **not added**. `generateCliffs` ignores the return value
   * entirely - there is no retry, no alternative orientation, and no effect on
   * the neighbouring cells - so this is a pure post-filter on the emit loop,
   * which is why it can run per-cell in any order and leaves tiling
   * byte-identical.
   *
   * Which tiles collide is planet-specific but the rule is not: a tile collides
   * when its `CollisionMask` shares a layer with the cliff's. The cliff mask
   * holds `water_tile`, so on Nauvis that is water and on Vulcanus it is
   * `lava` / `lava-hot` (whose `tile_collision_masks.lava()` sets `water_tile`).
   *
   * The predicate is called with **integer tile coordinates**, up to ~30 per
   * placed cell, and only for cells that are actually placed.
   */
  readonly tileCollides?: (x: number, y: number) => boolean;
}

/** Cells per chunk axis: a 32-tile chunk over the 4-tile placement grid. */
const CHUNK_CELLS = 32 / CLIFF_GRID_SIZE;

/** Packs the four edge crossings into the cell code the orientation table keys on. */
function cellCode(l: number, r: number, t: number, b: number): number {
  return ((l & 3) << 6) | ((r & 3) << 4) | ((t & 3) << 2) | (b & 3);
}

/**
 * `CellEdgeCliffCrossingArray::fixImpossibleCells` (`0x10160c550`), the pass
 * that runs at the tail of `crossingsForChunk` and is the named cause of the
 * ~6% residual Nauvis's port has carried since M4.
 *
 * It is a **single forward sweep** over one chunk's `8x8` cells (row-major, `cy`
 * outer), not a fixpoint over the whole array: clearing an edge changes the two
 * cells that share it, and cells already visited are never revisited. Porting it
 * as a relax-until-stable loop would be a different algorithm.
 *
 * Per cell it clears edges until the cell's code is one the orientation table
 * accepts, choosing the first **clearable** edge in the order `L, T, R, B`. An
 * edge is clearable only if it is not on the chunk's outer boundary, so the
 * chunk cannot disturb its neighbours - which is what keeps the pass chunk-local
 * and lets this run without a chunk-ordering dependency.
 *
 * The legality predicate needs no new table. The disassembly splits on
 * `code <= 0x50` (a 0x51-byte jump table at `0x102d00115` / `0x102d00166`, one
 * per branch, both encoding the same accept/reject split) and `code >= 0xC0` (a
 * bitmask `0x0001000000001003`, whose set bits are offsets 0, 1, 12 and 48 ->
 * codes `0xC0`, `0xC1`, `0xCC`, `0xF0`). Extracting both and comparing against
 * `CLIFF_PLACED_TABLE`: the accepted set is exactly `isCliffPlaced(code)` plus
 * code `0`. Codes in `0x51..0xBF` are all rejected.
 *
 * Note the binary is a **universal** Mach-O; raw byte reads of those tables need
 * the arm64 slice offset added, or they silently return x86_64 bytes.
 *
 * The `bool` parameter gates an extra step that zeroes the outer edges of the
 * chunk's four CORNER cells (8 edges). `crossingsForChunk` passes `false`
 * (`mov w1, #0x0` at `0x10160d0c8`), so it never runs in this path and is not
 * ported. An earlier note in cliffs-NOTES.md described this pass as zeroing the
 * whole chunk border; it does not, and it does not run at all here.
 */
export function fixImpossibleCellsSweep(v: Int8Array, h: Int8Array, w: number, hh: number): void {
  const vIndex = (cx: number, cy: number): number => cy * (w + 1) + cx;
  const hIndex = (cx: number, cy: number): number => cy * w + cx;

  /**
   * The `bool` parameter, and it is a **retry flag the function sets on
   * itself** - not a caller-supplied mode, which is how it was read until
   * 2026-07-30. `crossingsForChunk` passes `false`, and an earlier note here
   * concluded from that alone that the corner step "never runs in this path".
   * It does. When the sweep reaches a cell it cannot fix, the disassembly does
   *
   *     uVar10 = param_2 & 1;  param_2 = 1;
   *     if (uVar10 != 0) { log(...); return; }
   *     goto <top of function>;
   *
   * i.e. it turns the flag on and **restarts the whole pass**, which this time
   * begins by zeroing the eight outer edges of the chunk's four corner cells.
   * A second failure logs "Unable to remove excess cliff cell edge crossings"
   * and abandons the rest of the chunk outright.
   *
   * Note the restart re-sweeps the arrays **as already mutated** by the
   * abandoned pass - it is not a fresh start from the raw crossings.
   */
  for (let retry = 0; ; retry++) {
    if (retry > 0) {
      // The eight edges: the two outer edges of each corner cell. Zeroing these
      // is what can make an otherwise unfixable corner cell legal, since its
      // only remaining crossings were the ones the sweep is forbidden to clear.
      v[vIndex(0, 0)] = 0;
      h[hIndex(0, 0)] = 0;
      v[vIndex(w, 0)] = 0;
      h[hIndex(w - 1, 0)] = 0;
      v[vIndex(0, hh - 1)] = 0;
      h[hIndex(0, hh)] = 0;
      v[vIndex(w, hh - 1)] = 0;
      h[hIndex(w - 1, hh)] = 0;
    }

    let stuck = false;
    for (let cy = 0; cy < hh && !stuck; cy++) {
      for (let cx = 0; cx < w && !stuck; cx++) {
        const li = vIndex(cx, cy);
        const ri = vIndex(cx + 1, cy);
        const ti = hIndex(cx, cy);
        const bi = hIndex(cx, cy + 1);

        for (;;) {
          const code = cellCode(v[li], v[ri], h[ti], h[bi]);
          // The engine first counts non-zero edges and only consults the table
          // when the count is below 3. That is pure optimisation: every one of
          // the 20 placing codes has one or two crossings, so a count of 3 or 4
          // can never be legal. Checking the table directly is equivalent.
          if (code === 0 || isCliffPlaced(code)) break;
          if (v[li] !== 0 && cx !== 0) v[li] = 0;
          else if (h[ti] !== 0 && cy !== 0) h[ti] = 0;
          else if (v[ri] !== 0 && cx < w - 1) v[ri] = 0;
          else if (h[bi] !== 0 && cy < hh - 1) h[bi] = 0;
          else {
            stuck = true;
            break;
          }
        }
      }
    }

    // Not stuck -> the pass completed. Stuck on the retry -> the engine logs and
    // abandons the chunk, leaving the arrays as they are.
    if (!stuck || retry > 0) return;
  }
}

/** Corners per chunk axis: a 32-tile chunk over the 4-tile grid. */
const CHUNK_CORNERS = 32 / CLIFF_GRID_SIZE;

/**
 * The knot pair and blend fraction that `cliff_smoothing` interpolates a corner
 * between, for one axis. `crossingsForChunk` (`0x10160cdec`) walks each chunk's
 * own `9x9` corner block and, per axis, takes
 *
 * ```
 * lo = i & ~3                     // i is the IN-CHUNK corner index, 0..8
 * hi = min(lo + 4, CHUNK_CORNERS - 1)
 * t  = (i & 3) / (hi - lo)
 * ```
 *
 * so the knots land at in-chunk indices **0, 4 and 7** - the second span is
 * three corners wide, not four, because `hi` is clamped to `CHUNK_CORNERS - 1`
 * (7) rather than to the block edge (8). Index 8 falls out with `t = 0` on
 * itself, which is the same world point as the next chunk's index 0, also a
 * knot - so the two chunks agree there and this reduces cleanly to a function
 * of the GLOBAL corner index, with no chunk loop needed.
 *
 * That asymmetry is not a misreading: it is what makes smoothing "inaccurate"
 * in the prototype docs' own words, and it is anchored to the chunk grid, so
 * the smoothed field is deliberately discontinuous every 32 tiles.
 */
export function smoothingKnots(index: number): { lo: number; hi: number; t: number } {
  const i = ((index % CHUNK_CORNERS) + CHUNK_CORNERS) % CHUNK_CORNERS;
  const base = index - i;
  const lo = i & ~3;
  const hi = Math.min(lo + 4, CHUNK_CORNERS - 1);
  return { lo: base + lo, hi: base + hi, t: (i & 3) / (hi - lo) };
}

/**
 * A placed cliff: the cell centre, plus the 8-bit edge-crossing `code` it was
 * placed by. The code is carried out rather than discarded because it is the
 * only thing that names the cliff's ORIENTATION, and therefore its collision
 * box - `cliffOrientationForCode(code)`. Every consumer that only wants
 * positions can ignore it; `test/cliffOrientationOracle.spec.ts` compares it
 * against the game's own `LuaEntity.cliff_orientation`, which is what makes
 * `CLIFF_CODE_TO_ORIENTATION` checkable against something outside this port.
 */
export interface PlacedCliffCell {
  readonly x: number;
  readonly y: number;
  readonly code: number;
}

export interface CliffPlacement {
  placedCells(x0: number, y0: number, x1: number, y1: number): PlacedCliffCell[];
}

/**
 * Builds the placed-cliff-cell query for a given cliff config: `placedCells`
 * enumerates the 4-tile placement grid over a world box and returns the
 * center `{x,y}` of every cell whose crossing code places a cliff.
 */
export function makeCliffPlacement(
  ctx: CliffFieldCtx,
  opts: Pick<CliffBands, "tileCollides"> = {},
): CliffPlacement {
  return makeCliffPlacementFromFields(makeCliffFields(ctx), {
    elevation0: ctx.settings.cliffElevation0,
    interval: getModifiedElevationInterval(
      ctx.settings.cliffElevationInterval,
      ctx.controls.frequency,
    ),
    disabled: ctx.controls.continuity === 0 || ctx.settings.richness === 0,
    tileCollides: opts.tileCollides,
  });
}

/**
 * The planet-agnostic half: the corner lattice, `crossesCliff` on the four cell
 * edges, and the `toMaybeCliffOrientation` not-none predicate. Everything
 * planet-specific lives in the two fields and the two band numbers.
 */
export function makeCliffPlacementFromFields(
  fields: CliffFields,
  bands: CliffBands,
): CliffPlacement {
  const { cliffElevation, cliffiness } = fields;
  const { elevation0: e0, interval } = bands;
  const smoothing = bands.smoothing ?? 0;
  const tileCollides = bands.tileCollides;

  /**
   * `tryToAddCliff`'s rejection, as a predicate on an already-placed cell: scan
   * the orientation's collision box and drop the cell if any tile in it collides.
   * With no `tileCollides` supplied this is a constant `false` and costs nothing.
   *
   * **Two phases, because sixteen of the twenty boxes are rotated.**
   * `cliffCollisionTileBox` is the BROAD phase - the axis-aligned tile rectangle
   * `wouldCollide` derives with `(box + position) >> 8`. For the four straight
   * orientations that is the whole shape. For the sixteen `rotbb` ones the real
   * shape is that rectangle turned 45 degrees, so `cliffBoxCoversTile` runs a
   * narrow phase and discards the AABB's four empty corners. Skipping it drops
   * 13 real Vulcanus cliffs whose corners happen to overhang lava.
   */
  const rejected = (code: number, x: number, y: number): boolean => {
    if (tileCollides === undefined) return false;
    const box = cliffCollisionTileBox(code, x, y);
    // `undefined` only for a code that places nothing, which cannot reach here.
    if (box === undefined) return false;
    const id = cliffOrientationForCode(code);
    if (id === undefined) return false;
    for (let tx = box.left; tx <= box.right; tx++)
      for (let ty = box.top; ty <= box.bottom; ty++)
        if (tileCollides(tx, ty) && cliffBoxCoversTile(id, x, y, tx, ty)) return true;
    return false;
  };

  return {
    placedCells(x0: number, y0: number, x1: number, y1: number): PlacedCliffCell[] {
      if (bands.disabled === true) return [];

      const raw = new Map<string, number>();
      /**
       * Sampled at the BARE lattice `(i*4, j*4)`. The prototype's `grid_offset`
       * is a CENTRE offset, not a sample offset - see `CLIFF_CELL_CENTER_X` -
       * and `crossingsForChunk` never reads it. Adding it here (as this did
       * until 2026-07-30) moves no cliff and costs ~7 points of recall.
       */
      const rawElevation = (i: number, j: number): number => {
        const key = `${i},${j}`;
        let value = raw.get(key);
        if (value === undefined) {
          value = cliffElevation(i * CLIFF_GRID_SIZE, j * CLIFF_GRID_SIZE);
          raw.set(key, value);
        }
        return value;
      };

      /**
       * `cliff_smoothing` applied to the cliff ELEVATION register only -
       * cliffiness is read unsmoothed (`crossingsForChunk` smooths the register
       * at `[settings+0x1e0]`, then reads `[+0x1e4]` raw). The blend is
       *
       *     (1 - s) * E(i,j) + s * bilerp(E at the four surrounding knots)
       *
       * At `s = 1` the `E(i,j)` term vanishes exactly, so the raw elevation
       * sample is skipped and only the knot corners are ever evaluated. That
       * makes smoothing slightly cheaper than no smoothing rather than dearer,
       * but only slightly: measured over `placedCells(0,0,1024,1024)` on
       * Vulcanus, 6.95s at `s = 0` vs 6.26s at `s = 1` (~10%, three paired runs,
       * 2026-07-28). Cliffiness is still sampled at every corner and dominates,
       * so do not expect the knot ratio to show up as a speedup.
       */
      const smoothedElevation = (i: number, j: number): number => {
        const kx = smoothingKnots(i);
        const ky = smoothingKnots(j);
        const bilinear =
          (1 - kx.t) * (1 - ky.t) * rawElevation(kx.lo, ky.lo) +
          kx.t * (1 - ky.t) * rawElevation(kx.hi, ky.lo) +
          (1 - kx.t) * ky.t * rawElevation(kx.lo, ky.hi) +
          kx.t * ky.t * rawElevation(kx.hi, ky.hi);
        if (smoothing === 1) return bilinear;
        return (1 - smoothing) * rawElevation(i, j) + smoothing * bilinear;
      };

      const elevationAt = smoothing === 0 ? rawElevation : smoothedElevation;

      const corners = new Map<string, CornerSample>();
      const corner = (i: number, j: number): CornerSample => {
        const key = `${i},${j}`;
        let sample = corners.get(key);
        if (sample === undefined) {
          const wx = i * CLIFF_GRID_SIZE;
          const wy = j * CLIFF_GRID_SIZE;
          sample = { elev: elevationAt(i, j), cliff: cliffiness(wx, wy) };
          corners.set(key, sample);
        }
        return sample;
      };

      const cross = (p: CornerSample, q: CornerSample): -1 | 0 | 1 =>
        crossesCliff(p.elev, q.elev, (p.cliff + q.cliff) / 2, e0, interval);

      /**
       * The INCLUSIVE cell-index range whose centres land in the query box.
       * Cell `cx` sits at `cx * G + CX`, and the emit filter below keeps it when
       * that is in `[x0, x1)`, so the exact range is
       *
       *     cx >= (x0 - CX) / G          ->  ceil((x0 - CX) / G)
       *     cx <  (x1 - CX) / G          ->  ceil((x1 - CX) / G) - 1
       *
       * (`ceil(v) - 1` is right at an integer `v` too: `cx < k` means `k - 1`.)
       *
       * These used to be `floor` / `ceil`, which overshot by one cell at each
       * end. Every extra cell was discarded by the emit filter, so the OUTPUT
       * was correct - but the chunk loop below rounds this range out to whole
       * chunks, and one extra cell is enough to pull in a whole extra 8-cell
       * chunk on each side. That is a FIXED +2 chunks per axis per call, which
       * is minor on a whole-image render and severe when tiled: measured at
       * 512x512 vs 16 x 128x128, the cliff pass evaluated 21,025 cliffiness
       * samples whole against 38,416 tiled - 1.83x the noise for identical
       * output. See `test/cliffCellBounds.spec.ts`, which pins the ratio.
       */
      const cxMin = Math.ceil((x0 - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE);
      const cxMax = Math.ceil((x1 - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE) - 1;
      const cyMin = Math.ceil((y0 - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE);
      const cyMax = Math.ceil((y1 - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE) - 1;

      if (bands.fixImpossibleCells !== false) {
        // Chunk-structured path. Each chunk builds its own edge arrays and runs
        // the repair sweep in isolation, exactly as the game does - including
        // recomputing the edges it shares with its neighbours, which both
        // chunks own a private copy of. That is what makes the result
        // independent of the query box, so worker tiling stays byte-identical.
        const result: PlacedCliffCell[] = [];
        const chunkX0 = Math.floor(cxMin / CHUNK_CELLS);
        const chunkX1 = Math.floor(cxMax / CHUNK_CELLS);
        const chunkY0 = Math.floor(cyMin / CHUNK_CELLS);
        const chunkY1 = Math.floor(cyMax / CHUNK_CELLS);
        const n = CHUNK_CELLS;
        const v = new Int8Array((n + 1) * n);
        const hEdges = new Int8Array(n * (n + 1));

        for (let chY = chunkY0; chY <= chunkY1; chY++) {
          for (let chX = chunkX0; chX <= chunkX1; chX++) {
            const baseX = chX * n;
            const baseY = chY * n;

            for (let cy = 0; cy < n; cy++) {
              for (let cx = 0; cx <= n; cx++) {
                v[cy * (n + 1) + cx] = cross(
                  corner(baseX + cx, baseY + cy),
                  corner(baseX + cx, baseY + cy + 1),
                );
              }
            }
            for (let cy = 0; cy <= n; cy++) {
              for (let cx = 0; cx < n; cx++) {
                hEdges[cy * n + cx] = cross(
                  corner(baseX + cx, baseY + cy),
                  corner(baseX + cx + 1, baseY + cy),
                );
              }
            }

            fixImpossibleCellsSweep(v, hEdges, n, n);

            for (let cy = 0; cy < n; cy++) {
              for (let cx = 0; cx < n; cx++) {
                const code = cellCode(
                  v[cy * (n + 1) + cx],
                  v[cy * (n + 1) + cx + 1],
                  hEdges[cy * n + cx],
                  hEdges[(cy + 1) * n + cx],
                );
                if (!isCliffPlaced(code)) continue;
                const x = (baseX + cx) * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_X;
                const y = (baseY + cy) * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_Y;
                // Bounds-test BEFORE the collision test: the rejection is the
                // expensive half (it resolves tiles), and a chunk always
                // overhangs the query box.
                if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
                if (rejected(code, x, y)) continue;
                result.push({ x, y, code });
              }
            }
          }
        }
        return result;
      }

      const result: PlacedCliffCell[] = [];
      for (let cy = cyMin; cy <= cyMax; cy++) {
        for (let cx = cxMin; cx <= cxMax; cx++) {
          const cx0y0 = corner(cx, cy);
          const cx0y1 = corner(cx, cy + 1);
          const cx1y0 = corner(cx + 1, cy);
          const cx1y1 = corner(cx + 1, cy + 1);

          const l = cross(cx0y0, cx0y1);
          const r = cross(cx1y0, cx1y1);
          const t = cross(cx0y0, cx1y0);
          const b = cross(cx0y1, cx1y1);

          const code = (enc(l) << 6) | (enc(r) << 4) | (enc(t) << 2) | enc(b);
          if (!isCliffPlaced(code)) continue;

          const x = cx * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_X;
          const y = cy * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_Y;
          if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
          if (rejected(code, x, y)) continue;
          result.push({ x, y, code });
        }
      }
      return result;
    },
  };
}
