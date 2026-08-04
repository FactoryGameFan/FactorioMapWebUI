import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliff-destroy-probe.seed123456.json";
import { CLIFF_GRID_SIZE, CLIFF_ORIENTATION_NAMES } from "../src/noise/cliffs/cliffCatalog";
import {
  connectedSides,
  destroyEnd,
  isCliffConnected,
  onChunkBorder,
  oppositeSide,
} from "../src/noise/cliffs/cliffConnections";

/**
 * **The runtime destroy probe (#127) - `Cliff::onDestroy`'s cascade, observed.**
 *
 * #127 established that the cliff connection rules cannot be scored from map
 * generation output *at all*: the game's output is always connection-consistent,
 * so there is never a dangling end for the rules to act on, and both readings of
 * the gate predict exactly what the game shows. It named a runtime probe that
 * destroys a cliff outside map generation as one of the two kinds of evidence
 * that could work; #135 then read all four of the cascade's gates on the Lua
 * path and showed such a probe reproduces map generation's cascade. This is it.
 *
 * A cheaper route was tried first and failed, which is worth recording:
 * **#137's chunk-order lever builds arms where a border chunk is applied with
 * its neighbour chunk PROVABLY ungenerated** - exactly the gate's input. But on
 * the `[1500,1500]` west seam, all five cliffs carrying a west end have a
 * neighbour that `isCliffConnected` accepts, so there is still nothing to drop.
 * The counterfactual has to be constructed, not found.
 *
 * **What this settles, and what it does not.** It settles `onDestroy`: the
 * cascade is real, it is gated by `do_cliff_correction`, and its effect on a
 * neighbour is exactly the port's `destroyEnd`. It does **not** settle
 * `updateConnections`, which is not reachable from Lua at all - that gate
 * remains unscored.
 *
 * **`do_cliff_correction` DEFAULTS TO FALSE**, and that fact is why every target
 * set is run both ways. A probe calling a bare `destroy()` would have found
 * neighbours untouched, and that null reads exactly like "the game does not
 * cascade". The OFF arms below are that near-miss, kept as the control: they
 * change *nothing* but the targets, in both regions.
 *
 * **The counts alone would have misled**, which is why this spec asserts
 * orientations. A cliff is only *removed* when a trim leaves it with nothing, so
 * a removal count measures how many neighbours were single-ended, not where the
 * rule runs. On an earlier target set the border arm showed 8 extra removals
 * against the interior's 1, which reads like a border-only cascade and is not -
 * the changed-orientation counts are 13 and 12, i.e. the interior cascades just
 * as hard.
 *
 * **And the model only matched once the comparison stopped being clamped.** The
 * first target set was picked in scan order, so all eight landed on the region's
 * top edge, and the port appeared to under-destroy by 7 cliffs. Every one of
 * those mismatches was an edge artifact: a cliff at `y = 1498.5` is in the dump
 * only through bounding-box overlap, while ITS neighbours at `y = 1494.5` are
 * outside the dump entirely, so the game cascades through cliffs the comparison
 * cannot see. With targets 48 tiles inside the region the agreement is exact,
 * and the earlier "defect" was in the window, not the model.
 *
 * **There is no unconnected-target arm**, and that is a finding: exactly ONE
 * cliff of the 885 has no connected neighbour at all, and it sits outside the
 * margin - which is itself a restatement of the connection-consistency #127
 * measured. The correction-OFF arms carry the control role instead.
 */

interface Cliff {
  x: number;
  y: number;
  name: string;
  orientation: string | null;
}
interface Target {
  x: number;
  y: number;
  found: boolean;
  orientation: string | null;
  destroyed: boolean;
}
interface Case {
  label: string;
  correction: boolean;
  targets: { x: number; y: number }[];
  cliffsBefore: Cliff[];
  cliffsAfter: Cliff[];
  destroyReport: Target[];
}

const cases = fixture.cases as unknown as Case[];
const arm = (label: string): Case => {
  const c = cases.find((x) => x.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};
const ON_ARMS = ["border targets, correction ON", "interior targets, correction ON"];
const OFF_ARMS = ["border targets, correction OFF", "interior targets, correction OFF"];

const oi = (name: string | null): number =>
  name === null ? -1 : CLIFF_ORIENTATION_NAMES.indexOf(name);
const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
const SIDE_STEP: readonly (readonly [number, number])[] = [
  [0, -CLIFF_GRID_SIZE],
  [CLIFF_GRID_SIZE, 0],
  [0, CLIFF_GRID_SIZE],
  [-CLIFF_GRID_SIZE, 0],
];

/** The cells of an arm's before-state, as `pos -> orientation id`. */
function cellsOf(c: Case): Map<string, number> {
  return new Map(c.cliffsBefore.map((e) => [key(e.x, e.y), oi(e.orientation)]));
}

/**
 * `Cliff::onDestroy`'s cascade, run over the port's own model: destroying a
 * cliff calls `destroyEnd(opposite(side))` on every CONNECTED neighbour, and a
 * neighbour left with nothing is force-destroyed, which cascades in turn.
 */
function predictDestroy(cells: Map<string, number>, x: number, y: number): void {
  const mine = cells.get(key(x, y));
  if (mine === undefined) return;
  cells.delete(key(x, y));
  for (const side of connectedSides(mine)) {
    const step = SIDE_STEP[side];
    if (step === undefined) continue;
    const nx = x + step[0];
    const ny = y + step[1];
    const theirs = cells.get(key(nx, ny));
    if (theirs === undefined) continue;
    if (!isCliffConnected(side, mine, theirs)) continue;
    const next = destroyEnd(theirs, oppositeSide(side));
    if (next === -1) predictDestroy(cells, nx, ny);
    else cells.set(key(nx, ny), next);
  }
}

/** The arm's after-state as the fixture reports it, in the same shape. */
function actualOf(c: Case): Map<string, number> {
  return new Map(c.cliffsAfter.map((e) => [key(e.x, e.y), oi(e.orientation)]));
}

describe("Vulcanus cliffs: the runtime destroy probe (#127, #84)", () => {
  it("captures all four arms", () => {
    expect(cases).toHaveLength(4);
    expect(cases.every((c) => c.cliffsBefore.length === 885)).toBe(true);
  });

  describe("the probe actually did what it claims - without these, every null is empty", () => {
    it("FOUND and DESTROYED every target in every arm", () => {
      // This is not bookkeeping. The first run of this probe found only 4 of 8
      // targets: `find_entities_filtered{area}` selects on the BOUNDING BOX,
      // and a cliff's box is the per-orientation `rotbb` rectangle, which is
      // offset from the cell centre and need not contain it. A lookup miss and
      // a cascade removal are the same observation without this assertion.
      for (const c of cases) {
        expect(
          c.destroyReport.every((r) => r.found),
          `${c.label}: all found`,
        ).toBe(true);
        expect(
          c.destroyReport.every((r) => r.destroyed),
          `${c.label}: all destroyed`,
        ).toBe(true);
        expect(c.destroyReport).toHaveLength(c.targets.length);
      }
    });

    it("targets are where the capture says they are - re-derived from the PORT", () => {
      // The capture picks targets with predicates re-derived inside
      // `capture.ts` (it runs under bare Node and cannot import
      // `cliffConnections`). These assertions are what stop that duplicate from
      // drifting: the real functions must agree with the selection.
      const before = cellsOf(arm(ON_ARMS[0]));
      const connectedCount = (x: number, y: number): number => {
        const mine = before.get(key(x, y));
        if (mine === undefined) return 0;
        return connectedSides(mine).filter((side) => {
          const step = SIDE_STEP[side];
          if (step === undefined) return false;
          const theirs = before.get(key(x + step[0], y + step[1]));
          return theirs !== undefined && isCliffConnected(side, mine, theirs);
        }).length;
      };
      for (const t of arm(ON_ARMS[0]).targets) {
        expect(onChunkBorder(t.x, t.y), `${key(t.x, t.y)} on border`).toBe(true);
        expect(connectedCount(t.x, t.y)).toBeGreaterThan(0);
      }
      for (const t of arm(ON_ARMS[1]).targets) {
        expect(onChunkBorder(t.x, t.y), `${key(t.x, t.y)} interior`).toBe(false);
        expect(connectedCount(t.x, t.y)).toBeGreaterThan(0);
      }
      // The population that would have made an unconnected-target arm: one
      // cliff in 885. Pinned so that "there was no control" stays a measured
      // statement rather than an omission.
      expect((fixture as { unconnectedCliffsRegionWide: number }).unconnectedCliffsRegionWide).toBe(
        1,
      );
    });

    it("the ON arms MOVED something - a passing model over a still world proves nothing", () => {
      for (const label of ON_ARMS) {
        const c = arm(label);
        const before = cellsOf(c);
        const after = actualOf(c);
        const changed = [...after].filter(([k, o]) => before.has(k) && before.get(k) !== o);
        expect(changed.length, `${label}: changed orientations`).toBeGreaterThan(0);
      }
    });
  });

  describe("do_cliff_correction gates the cascade COMPLETELY", () => {
    it("with it OFF, nothing but the targets changes - the near-miss null", () => {
      for (const label of OFF_ARMS) {
        const c = arm(label);
        const before = cellsOf(c);
        const after = actualOf(c);
        const targets = new Set(c.targets.map((t) => key(t.x, t.y)));
        const gone = [...before.keys()].filter((k) => !after.has(k));
        expect(new Set(gone), `${label}: only the targets are gone`).toEqual(targets);
        const changed = [...after].filter(([k, o]) => before.get(k) !== o);
        expect(changed, `${label}: no neighbour was touched`).toEqual([]);
      }
    });

    it("is the ONLY difference between the paired arms - same targets, same world", () => {
      for (const [on, off] of [
        [ON_ARMS[0], OFF_ARMS[0]],
        [ON_ARMS[1], OFF_ARMS[1]],
      ]) {
        expect(arm(on).targets).toEqual(arm(off).targets);
        expect(arm(on).cliffsBefore).toEqual(arm(off).cliffsBefore);
      }
    });
  });

  describe("the cascade IS the port's `destroyEnd`, cell for cell", () => {
    it.each(ON_ARMS)("reproduces %s exactly", (label) => {
      const c = arm(label);
      const cells = cellsOf(c);
      for (const t of c.targets) predictDestroy(cells, t.x, t.y);
      const actual = actualOf(c);
      const norm = (m: Map<string, number>): [string, number][] =>
        [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      expect(norm(cells)).toEqual(norm(actual));
    });

    it("and it is NOT border-only - the interior cascades just as hard", () => {
      // The removal counts say 8 extra at the border against 1 in the interior,
      // which reads like a border-only rule. The orientation counts say
      // otherwise, and they are the ones that measure where the rule runs.
      const changedIn = (label: string): number => {
        const before = cellsOf(arm(label));
        const after = actualOf(arm(label));
        return [...after].filter(([k, o]) => before.has(k) && before.get(k) !== o).length;
      };
      expect(changedIn(ON_ARMS[0])).toBeGreaterThan(5);
      expect(changedIn(ON_ARMS[1])).toBeGreaterThan(5);
    });

    it("removes MORE than the targets, so the exact match is not a trivial one", () => {
      // Both ON arms cascade past their own targets - 9 and 10 removals for 8
      // destroys. Without this, "the model reproduces the game" could be true
      // of a world where the cascade never reached anything.
      for (const label of ON_ARMS) {
        const c = arm(label);
        expect(c.cliffsBefore.length - c.cliffsAfter.length).toBeGreaterThan(c.targets.length);
      }
    });
  });
});
