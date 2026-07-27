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
  /** When true, `placedCells` returns nothing (continuity or richness is 0). */
  readonly disabled?: boolean;
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

  return {
    placedCells(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
      if (bands.disabled === true) return [];

      const corners = new Map<string, CornerSample>();
      const corner = (i: number, j: number): CornerSample => {
        const key = `${i},${j}`;
        let sample = corners.get(key);
        if (sample === undefined) {
          const wx = i * CLIFF_GRID_SIZE;
          const wy = j * CLIFF_GRID_SIZE + CLIFF_CORNER_OFFSET_Y;
          sample = { elev: cliffElevation(wx, wy), cliff: cliffiness(wx, wy) };
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
