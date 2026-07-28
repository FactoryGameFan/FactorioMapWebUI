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
  CLIFF_CORNER_OFFSET_Y,
  CLIFF_GRID_SIZE,
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
function fixImpossibleCellsSweep(v: Int8Array, h: Int8Array, w: number, hh: number): void {
  const vIndex = (cx: number, cy: number): number => cy * (w + 1) + cx;
  const hIndex = (cx: number, cy: number): number => cy * w + cx;

  for (let cy = 0; cy < hh; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const li = vIndex(cx, cy);
      const ri = vIndex(cx + 1, cy);
      const ti = hIndex(cx, cy);
      const bi = hIndex(cx, cy + 1);

      for (;;) {
        const code = cellCode(v[li], v[ri], h[ti], h[bi]);
        if (code === 0 || isCliffPlaced(code)) break;
        if (v[li] !== 0 && cx !== 0) v[li] = 0;
        else if (h[ti] !== 0 && cy !== 0) h[ti] = 0;
        else if (v[ri] !== 0 && cx < w - 1) v[ri] = 0;
        else if (h[bi] !== 0 && cy < hh - 1) h[bi] = 0;
        // The game logs "Unable to remove excess cliff cell edge crossings" and
        // gives up here; every remaining crossing is on the chunk boundary and
        // is not ours to clear.
        else break;
      }
    }
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

export interface CliffPlacement {
  placedCells(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[];
}

/**
 * Builds the placed-cliff-cell query for a given cliff config: `placedCells`
 * enumerates the 4-tile placement grid over a world box and returns the
 * center `{x,y}` of every cell whose crossing code places a cliff.
 */
export function makeCliffPlacement(ctx: CliffFieldCtx): CliffPlacement {
  return makeCliffPlacementFromFields(makeCliffFields(ctx), {
    elevation0: ctx.settings.cliffElevation0,
    interval: getModifiedElevationInterval(
      ctx.settings.cliffElevationInterval,
      ctx.controls.frequency,
    ),
    disabled: ctx.controls.continuity === 0 || ctx.settings.richness === 0,
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

  return {
    placedCells(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
      if (bands.disabled === true) return [];

      const raw = new Map<string, number>();
      const rawElevation = (i: number, j: number): number => {
        const key = `${i},${j}`;
        let value = raw.get(key);
        if (value === undefined) {
          value = cliffElevation(i * CLIFF_GRID_SIZE, j * CLIFF_GRID_SIZE + CLIFF_CORNER_OFFSET_Y);
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
          const wy = j * CLIFF_GRID_SIZE + CLIFF_CORNER_OFFSET_Y;
          sample = { elev: elevationAt(i, j), cliff: cliffiness(wx, wy) };
          corners.set(key, sample);
        }
        return sample;
      };

      const cross = (p: CornerSample, q: CornerSample): -1 | 0 | 1 =>
        crossesCliff(p.elev, q.elev, (p.cliff + q.cliff) / 2, e0, interval);

      const cxMin = Math.floor((x0 - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE);
      const cxMax = Math.ceil((x1 - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE);
      const cyMin = Math.floor((y0 - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE);
      const cyMax = Math.ceil((y1 - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE);

      if (bands.fixImpossibleCells !== false) {
        // Chunk-structured path. Each chunk builds its own edge arrays and runs
        // the repair sweep in isolation, exactly as the game does - including
        // recomputing the edges it shares with its neighbours, which both
        // chunks own a private copy of. That is what makes the result
        // independent of the query box, so worker tiling stays byte-identical.
        const result: { x: number; y: number }[] = [];
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
                if (x >= x0 && x < x1 && y >= y0 && y < y1) result.push({ x, y });
              }
            }
          }
        }
        return result;
      }

      const result: { x: number; y: number }[] = [];
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
          if (x >= x0 && x < x1 && y >= y0 && y < y1) {
            result.push({ x, y });
          }
        }
      }
      return result;
    },
  };
}
