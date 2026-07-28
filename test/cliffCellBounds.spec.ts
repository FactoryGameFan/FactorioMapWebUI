// Guards the cliff cell-enumeration bounds in `cliffPlacement.ts`.
//
// The chunk loop rounds the requested cell range out to whole 8-cell chunks, so
// a bounds expression that overshoots by a single cell costs a whole extra
// chunk on each side - a FIXED +2 chunks per axis per call. On a whole-image
// render that is a modest constant; tiled across the app's 64-worker pool it is
// paid 64 times over, and it was the entire Vulcanus tiled-vs-whole penalty
// (docs/noise/vulcanus-cliffs-NOTES.md).
//
// This counts FIELD EVALUATIONS rather than timing anything, so it is exact and
// fast. The fields are cheap stand-ins: the enumeration calls `corner()` for
// every lattice point in range regardless of what the fields return, so the
// counts do not depend on using the real Vulcanus noise - but the cells do, and
// they are compared whole-vs-tiled to prove the tightening changed no output.
import { expect, it } from "vite-plus/test";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";

const V = 512;
const TILE = 128;

/** A ramp with many band crossings, so the cell set is large and non-trivial. */
function counted(): {
  cells: (x0: number, y0: number, x1: number, y1: number) => string[];
  evals: () => { elevation: number; cliffiness: number };
} {
  let elevation = 0;
  let cliffiness = 0;
  const placement = makeCliffPlacementFromFields(
    {
      cliffElevation: (x, y) => {
        elevation++;
        return 200 * Math.sin(x / 40) * Math.cos(y / 40);
      },
      cliffiness: () => {
        cliffiness++;
        return 1;
      },
    },
    { elevation0: 70, interval: 120, smoothing: 1 },
  );
  return {
    cells: (x0, y0, x1, y1) => placement.placedCells(x0, y0, x1, y1).map((c) => `${c.x},${c.y}`),
    evals: () => ({ elevation, cliffiness }),
  };
}

function tiled(): { cells: string[]; evals: { elevation: number; cliffiness: number } } {
  const c = counted();
  const cells: string[] = [];
  for (let dy = 0; dy < V; dy += TILE)
    for (let dx = 0; dx < V; dx += TILE) cells.push(...c.cells(dx, dy, dx + TILE, dy + TILE));
  return { cells, evals: c.evals() };
}

it("enumerates the same cells whole and tiled", () => {
  const w = counted();
  const whole = w.cells(0, 0, V, V);
  const t = tiled();

  // Non-vacuity: a bounds bug that emitted nothing would pass a set comparison.
  expect(whole.length).toBeGreaterThan(900);
  expect([...t.cells].sort()).toEqual([...whole].sort());
});

it("costs no more per unit area when tiled", () => {
  const w = counted();
  w.cells(0, 0, V, V);
  const whole = w.evals();
  const t = tiled().evals;

  // Measured 2026-07-28 with the tightened bounds: cliffiness 16,641 whole
  // (a 129^2 corner lattice) against 17,424 tiled (33^2 per tile x 16), a
  // 1.047x overhead that is the genuine seam cost of 16 independent tiles.
  // With the old floor/ceil bounds the same pair measured 21,025 against
  // 38,416 - 1.83x - so this threshold discriminates by a wide margin. Checked
  // by reverting the bounds and watching this fail, not assumed.
  const ratio = t.cliffiness / whole.cliffiness;
  expect(ratio).toBeLessThan(1.1);

  // Pinned exactly, because the ratio alone would also pass if BOTH sides
  // regressed together - which is what a widened whole-image bound would do.
  expect(whole).toEqual({ elevation: 2500, cliffiness: 16641 });
  expect(t).toEqual({ elevation: 3136, cliffiness: 17424 });
});
