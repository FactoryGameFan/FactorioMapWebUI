import { describe, expect, it } from "vite-plus/test";

import nauvis from "./fixtures/oracle-cliff-entities.seed123456.json";
import vulcanus from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import {
  CLIFF_CELL_CENTER_X,
  CLIFF_CELL_CENTER_Y,
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_GRID_SIZE,
  CLIFF_ORIENTATION_NAMES,
} from "../src/noise/cliffs/cliffCatalog";

interface Cliff {
  readonly x: number;
  readonly y: number;
  readonly name?: string;
  readonly orientation: string;
}

/** Orientation name -> the 8-bit crossing code, inverting the placing half of the table. */
const inverseTable = (swap?: readonly [number, number]): Map<string, number> => {
  const names = [...CLIFF_ORIENTATION_NAMES];
  if (swap !== undefined) {
    const [a, b] = swap;
    [names[a], names[b]] = [names[b], names[a]];
  }
  const m = new Map<string, number>();
  for (const [codeStr, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
    m.set(names[id], Number(codeStr));
  return m;
};

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

interface Tally {
  onLattice: number;
  offLattice: number;
  hPairs: number;
  vPairs: number;
  mismatches: string[];
}

/**
 * Rebuild each case's cliff cells from the game's own `cliff_orientation`, then
 * check that every two adjacent cells agree on the edge they share.
 *
 * Cases are tallied **separately** and never merged. Nauvis's cases are the same
 * region at different seeds, so a shared map would collide two unrelated cliffs
 * at one cell and invent mismatches - measured, it invents four.
 */
const tally = (cases: { readonly cliffs: readonly Cliff[] }[], only?: string): Tally => {
  const table = inverseTable();
  const out: Tally = { onLattice: 0, offLattice: 0, hPairs: 0, vPairs: 0, mismatches: [] };
  for (const c of cases) {
    const cells = new Map<string, number>();
    for (const p of c.cliffs) {
      if (only !== undefined && p.name !== only) continue;
      const cx = Math.round((p.x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE);
      const cy = Math.round((p.y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE);
      if (
        Math.abs(cx * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_X - p.x) > 1e-9 ||
        Math.abs(cy * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_Y - p.y) > 1e-9
      ) {
        out.offLattice++;
        continue;
      }
      out.onLattice++;
      const code = table.get(p.orientation);
      if (code !== undefined) cells.set(key(cx, cy), code);
    }
    for (const [k, code] of cells) {
      const [cx, cy] = k.split(",").map(Number);
      const right = cells.get(key(cx + 1, cy));
      if (right !== undefined) {
        out.hPairs++;
        // R of the left cell is L of the right cell: the same vertical edge.
        if (((code >> 4) & 3) !== ((right >> 6) & 3)) out.mismatches.push(`h ${k}`);
      }
      const below = cells.get(key(cx, cy + 1));
      if (below !== undefined) {
        out.vPairs++;
        // B of the upper cell is T of the lower cell.
        if ((code & 3) !== ((below >> 2) & 3)) out.mismatches.push(`v ${k}`);
      }
    }
  }
  return out;
};

/**
 * **The game's own cliffs, checked against each other** (issue #18).
 *
 * Every other cliff oracle in this repo compares the port's output against the
 * game's. This one uses *no field, no rule and no port output at all*: it takes
 * the game's `cliff_orientation` for each cliff, inverts
 * `CLIFF_CODE_TO_ORIENTATION` to recover the 8-bit crossing code the engine must
 * have held, and asserts that two cliffs sitting in adjacent cells agree about
 * the edge between them - the engine stores one value per edge, so they must.
 *
 * What that pins, which nothing else did:
 *
 * - **The code packing** (`L R T B`, two bits each, in that order). A transposed
 *   or reordered packing makes neighbours disagree immediately.
 * - **The position -> cell mapping** (`cx * 4 + 2`, `cy * 4 + 2.5`). Every real
 *   cliff must land exactly on that lattice.
 * - **The orientation table**, in the inverse direction.
 *
 * It matters because these three were the last unmeasured links in the Vulcanus
 * orientation residual. `cliffOrientationOracle.spec.ts` shows Nauvis matching
 * 334/334, which argues the table is right; but Nauvis exercises neither
 * `cliff_smoothing` nor a continuous cliffiness field, so "Nauvis is exact"
 * could not by itself clear the packing for Vulcanus. This does, and it does it
 * from the fixture alone - measured 2026-08-01, both planets agree on **every**
 * shared edge.
 */
describe("the game's cliffs agree with each other on shared edges", () => {
  const n = tally(nauvis.cases);
  const v = tally(vulcanus.cases, "cliff-vulcanus");

  it("puts every real cliff exactly on the 4-tile placement lattice", () => {
    // Measured 2026-08-01. Pinned exactly: these are the full fixture contents,
    // so a shrinking comparison set cannot pass unnoticed.
    expect(n.onLattice).toBe(334);
    expect(n.offLattice).toBe(0);
    expect(v.onLattice).toBe(1569);
    expect(v.offLattice).toBe(0);
  });

  it("finds the 8 crater-cliffs OFF the lattice, which is what makes that test sharp", () => {
    // `crater-cliff` is placed by the entity autoplace with jitter, not by
    // `generateCliffs`, so its positions are fractional. Without this the
    // lattice assertion above could pass vacuously against a rounding that
    // accepted anything.
    const all = tally(vulcanus.cases);
    expect(all.offLattice).toBe(8);
    expect(all.onLattice).toBe(1569);
  });

  it("agrees on every shared edge, on both planets", () => {
    expect(n.mismatches).toEqual([]);
    expect(v.mismatches).toEqual([]);
    // Non-vacuity: without these the loop would pass by comparing nothing.
    // Measured 2026-08-01.
    expect(n.hPairs).toBe(147);
    expect(n.vPairs).toBe(166);
    expect(v.hPairs).toBe(805);
    expect(v.vPairs).toBe(834);
  });

  it("FAILS when the orientation table is corrupted - the guard discriminates", () => {
    // Swap two orientations in the inverse table and the same data must stop
    // being self-consistent. Without this, a check that trivially passed
    // (say, because every code decoded to the same edges) would look like
    // confirmation. `north-to-south` (5) and `east-to-west` (7) are both common
    // in the fixtures, so the swap is guaranteed to be exercised.
    const table = inverseTable([5, 7]);
    let pairs = 0;
    let bad = 0;
    for (const c of vulcanus.cases) {
      const cells = new Map<string, number>();
      for (const p of c.cliffs) {
        if (p.name !== "cliff-vulcanus") continue;
        const cx = Math.round((p.x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE);
        const cy = Math.round((p.y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE);
        const code = table.get(p.orientation);
        if (code !== undefined) cells.set(key(cx, cy), code);
      }
      for (const [k, code] of cells) {
        const [cx, cy] = k.split(",").map(Number);
        const right = cells.get(key(cx + 1, cy));
        if (right === undefined) continue;
        pairs++;
        if (((code >> 4) & 3) !== ((right >> 6) & 3)) bad++;
      }
    }
    expect(pairs).toBe(805);
    expect(bad).toBeGreaterThan(0);
  });
});
