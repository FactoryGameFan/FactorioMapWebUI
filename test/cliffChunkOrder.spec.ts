import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliff-chunk-order.seed123456.json";

/**
 * **CHUNK-GENERATION ORDER is CLOSED as a route from the ore to a cliff (#84).**
 *
 * The ore moves cliffs - 885 vs 916 `cliff-vulcanus` in `[1500,1500]` - and
 * every direct route was already closed: the field (both properties),
 * `Surface::wouldCollide`'s entity half and tile half, and a structural
 * perturbation of the settings object. `vulcanus-cliffs-NOTES.md` then listed
 * three ideas no measurement touched. This is the first of them, and it is not
 * an idle one: `Surface::getEffectiveTileID` returns **0 for an absent chunk**
 * and `checkTileCollisions` skips that tile, so whether a neighbouring chunk
 * exists yet is a real input to whether a cliff survives.
 *
 * The hypothesis has two links and this closes **both**:
 *
 * - **ore -> order.** The generated chunk SET is the same 81 chunks in all six
 *   arms, resources on or off.
 * - **order -> cliffs.** Three different generation orders over that identical
 *   set produce **identical cliffs - cell for cell and orientation for
 *   orientation**, not merely identical counts.
 *
 * Closing the second link is what makes this decisive, because it holds
 * whatever the ore does to the order.
 *
 * **Why the order perturbation is measured rather than assumed.** The first
 * pass read generation order from `on_chunk_generated` and got a ZERO-length
 * sequence in every arm while 81 chunks generated - Factorio dispatches no
 * events raised during `on_init`. So each two-drain arm snapshots the chunks
 * that exist BETWEEN its drains, and the two arms split on different axes: the
 * x-split reports columns 51-54, the y-split reports rows 51-54. Two different
 * sets, so two different orders, resting on nothing about how the game drains a
 * queue. `sequence is 0` is asserted below rather than dropped, so the next
 * person to want an order out of this probe reads a measured zero.
 *
 * **A second result falls out.** Every committed cliff fixture is captured with
 * the forward order, and nothing had ever checked that the capture's own
 * request loop was not shaping its ground truth. It is not: all three orders
 * agree exactly.
 */

interface Cliff {
  x: number;
  y: number;
  name: string;
  orientation: string | null;
}
interface Chunk {
  x: number;
  y: number;
}
interface Case {
  label: string;
  chunkOrder: string;
  effectiveAutoplace?: Record<string, { frequency: number; size: number; richness: number }>;
  cliffs: Cliff[];
  resourceCount: number;
  chunkSequenceLength: number;
  chunksAtEnd: Chunk[];
  chunksAfterFirstDrain?: Chunk[];
}

const cases = fixture.cases as unknown as Case[];
const byLabel = (label: string): Case => {
  const found = cases.find((c) => c.label === label);
  if (found === undefined) throw new Error(`no arm labelled ${label}`);
  return found;
};
const ORDERS = ["forward", "right-half-first", "bottom-half-first"] as const;
const arm = (order: string, on: boolean): Case =>
  byLabel(`${order} order, ${on ? "resources ON" : "ALL resources OFF"}`);

/** Cliffs as a sorted, fully-qualified key list - position, name AND orientation. */
const cliffKeys = (c: Case): string[] =>
  c.cliffs
    .map((e) => `${String(e.x)},${String(e.y)}:${e.name}:${e.orientation ?? "-"}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const chunkKeys = (chunks: readonly Chunk[]): string[] =>
  chunks.map((c) => `${String(c.x)},${String(c.y)}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("Vulcanus cliffs: chunk-generation order (#84)", () => {
  it("captures all six arms of the crossed levers", () => {
    expect(cases).toHaveLength(6);
    expect(cases.map((c) => c.label).sort()).toEqual(
      ORDERS.flatMap((o) => [`${o} order, ALL resources OFF`, `${o} order, resources ON`]).sort(),
    );
  });

  describe("the arms are on target - without these, a null result says nothing", () => {
    it("reproduces the studied world: the ON arms are the 885 every prior fixture reports", () => {
      for (const order of ORDERS) {
        const on = arm(order, true);
        expect(on.cliffs.filter((c) => c.name === "cliff-vulcanus")).toHaveLength(885);
      }
    });

    it("shows the ORE EFFECT is present in this very capture, 885 -> 916", () => {
      for (const order of ORDERS) {
        expect(arm(order, false).cliffs.filter((c) => c.name === "cliff-vulcanus")).toHaveLength(
          916,
        );
        expect(cliffKeys(arm(order, true))).not.toEqual(cliffKeys(arm(order, false)));
      }
    });

    it("shows the resources lever APPLIED - 3933 entities against 0", () => {
      for (const order of ORDERS) {
        expect(arm(order, true).resourceCount).toBe(3933);
        expect(arm(order, false).resourceCount).toBe(0);
        // The surface's own read-back, so "the ore vanished" cannot be an
        // override that silently failed to apply. Only the four controls the
        // lever touches: the surface reports EVERY control, and the untouched
        // ones (cliffs, rocks, enemy bases) correctly still read size 1.
        const applied = arm(order, false).effectiveAutoplace ?? {};
        for (const name of ["tungsten_ore", "calcite", "vulcanus_coal", "sulfuric_acid_geyser"])
          expect(applied[name]?.size, name).toBe(0);
      }
    });

    it("shows the ORDER really changed: the two splits hold DIFFERENT halves mid-run", () => {
      const x = arm("right-half-first", true).chunksAfterFirstDrain ?? [];
      const y = arm("bottom-half-first", true).chunksAfterFirstDrain ?? [];
      expect(x).toHaveLength(36);
      expect(y).toHaveLength(36);
      expect(chunkKeys(x)).not.toEqual(chunkKeys(y));
      // The x-split's first drain is a column band, the y-split's a row band.
      expect([...new Set(x.map((c) => c.x))].sort((a, b) => a - b)).toEqual([51, 52, 53, 54]);
      expect([...new Set(y.map((c) => c.y))].sort((a, b) => a - b)).toEqual([51, 52, 53, 54]);
      // The single-drain arm has no midpoint to observe, by construction.
      expect(arm("forward", true).chunksAfterFirstDrain).toBeUndefined();
    });

    it("records that `on_chunk_generated` NEVER FIRES during on_init - a measured zero", () => {
      // Kept as an assertion rather than dropped: it is why the mid-run
      // snapshot exists, and a Factorio that started dispatching these should
      // be noticed rather than assumed.
      for (const c of cases) expect(c.chunkSequenceLength).toBe(0);
    });
  });

  describe("LINK A - the ore does not change WHICH chunks are generated", () => {
    it("generates the same 81 chunks in every arm", () => {
      const expected = chunkKeys(arm("forward", true).chunksAtEnd);
      expect(expected).toHaveLength(81);
      for (const c of cases) expect(chunkKeys(c.chunksAtEnd)).toEqual(expected);
    });
  });

  describe("LINK B - generation ORDER moves no cliff at all", () => {
    it("places identical cliffs across all three orders, resources ON", () => {
      const expected = cliffKeys(arm("forward", true));
      for (const order of ORDERS) expect(cliffKeys(arm(order, true))).toEqual(expected);
    });

    it("places identical cliffs across all three orders, resources OFF", () => {
      // The OFF arms matter as much as the ON ones: if order interacted with
      // the ore rather than acting alone, this is the arm it would show in.
      const expected = cliffKeys(arm("forward", false));
      for (const order of ORDERS) expect(cliffKeys(arm(order, false))).toEqual(expected);
    });

    it("agrees on the ore effect's SIZE in every order - no interaction", () => {
      const delta = (order: string): number =>
        arm(order, false).cliffs.filter((c) => c.name === "cliff-vulcanus").length -
        arm(order, true).cliffs.filter((c) => c.name === "cliff-vulcanus").length;
      for (const order of ORDERS) expect(delta(order)).toBe(31);
    });
  });
});
