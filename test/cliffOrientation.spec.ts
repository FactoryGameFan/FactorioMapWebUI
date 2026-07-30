import { describe, expect, it } from "vite-plus/test";

import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_ORIENTATION_COLLISION_BOX,
  CLIFF_ORIENTATION_NAMES,
  cliffOrientationForCode,
  isCliffPlaced,
} from "../src/noise/cliffs/cliffCatalog";

/**
 * The cell-code -> `CliffOrientation` mapping and the per-orientation collision
 * boxes (issue #18), both read out of the Factorio 2.1.12 arm64 slice /
 * `factorio-data` rather than inferred.
 *
 * Neither is consumed by the placement pass yet. They exist because
 * `EntityMapGenerationTask::tryToAddCliff` rejects a cliff whose orientation box
 * collides with the tile mask, and this port does not run that rejection - see
 * the doc comments in `cliffCatalog.ts` for the disassembly and the measured
 * effect. Landing the tables separately keeps the RE reviewable on its own.
 *
 * These are transcriptions, so a spec that only restated them would be vacuous.
 * What is asserted instead is everything the transcription has to satisfy: the
 * bijection against the independently-extracted `isCliffPlaced` table, a
 * from-the-geometry derivation of every orientation NAME out of its code's edge
 * crossings, and a re-derivation of the `rotbb` boxes from the Lua source's
 * rotated rectangle. Six planted single-value errors - two id swaps, two box
 * typos, a name reorder and a dropped code - were each confirmed to fail this
 * file before it landed; an earlier, weaker version missed two of them.
 */
describe("cliff cell code -> CliffOrientation", () => {
  const codes = Object.keys(CLIFF_CODE_TO_ORIENTATION).map(Number);

  it("covers exactly the codes isCliffPlaced accepts", () => {
    // `CLIFF_PLACING_CODES` came from the low word of
    // `toMaybeCliffOrientation`'s return; this table came from the high word of
    // the same 20 landing blocks. They must agree over all 256 codes - if a
    // future edit desynchronises them, the placement pass and the orientation
    // lookup would disagree about which cells exist.
    const placed: number[] = [];
    for (let code = 0; code <= 255; code++) if (isCliffPlaced(code)) placed.push(code);
    expect([...codes].sort((a, b) => a - b)).toEqual(placed);
    expect(placed).toHaveLength(20);
  });

  it("is a bijection onto the 20 orientation ids", () => {
    const ids = codes.map((c) => CLIFF_CODE_TO_ORIENTATION[c]).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("cliffOrientationForCode agrees with isCliffPlaced on every code, in and out of range", () => {
    for (let code = 0; code <= 255; code++)
      expect(cliffOrientationForCode(code) !== undefined).toBe(isCliffPlaced(code));
    for (const bad of [-1, 256, 1.5, Number.NaN])
      expect(cliffOrientationForCode(bad)).toBeUndefined();
  });

  /**
   * The whole mapping, re-derived from the geometry of the code itself.
   *
   * A cell code packs four edge crossings as `(L << 6) | (R << 4) | (T << 2) | B`,
   * each `0` (no crossing), `1` (`crossesCliff` returned +1) or `3` (-1). The
   * cliff wall passes through exactly the edges that cross, and each edge names
   * the cell side it lies on: L = west, R = east, T = north, B = south. The
   * crossing's SIGN decides which end of the name that side lands on:
   *
   * | edge | +1 | -1 |
   * | --- | --- | --- |
   * | L (west) | second | first |
   * | R (east) | first | second |
   * | T (north) | first | second |
   * | B (south) | second | first |
   *
   * A single crossing edge gives "none" for the other end.
   *
   * **Stated honestly: this rule was found by staring at the extracted table,
   * so it is not an independent source.** It is a compression - 20 arbitrary
   * `code -> id` pairs reduced to four sign rules and a side-naming convention -
   * and it reproduces all 20 exactly. That makes it a real constraint: a
   * transposition anywhere in `CLIFF_CODE_TO_ORIENTATION` or a reordering of
   * `CLIFF_ORIENTATION_NAMES` breaks it, which the weaker
   * "corners look like corners" version of this test did not.
   */
  describe("orientation names are derivable from the code's edge crossings", () => {
    const SIDES = ["north", "south", "east", "west", "none"];

    /** The name a code should carry, from its edges alone. */
    const nameFromCode = (code: number): string => {
      const edges: [number, string, "first" | "second"][] = [
        [(code >> 6) & 3, "west", "second"], // L: +1 -> second
        [(code >> 4) & 3, "east", "first"], // R: +1 -> first
        [(code >> 2) & 3, "north", "first"], // T: +1 -> first
        [code & 3, "south", "second"], // B: +1 -> second
      ];
      let from = "none";
      let to = "none";
      for (const [v, side, whenUp] of edges) {
        if (v === 0) continue;
        const slot = v === 1 ? whenUp : whenUp === "first" ? "second" : "first";
        if (slot === "first") from = side;
        else to = side;
      }
      return `${from}-to-${to}`;
    };

    it("has 20 well-formed, unique names", () => {
      expect(CLIFF_ORIENTATION_NAMES).toHaveLength(20);
      expect(new Set(CLIFF_ORIENTATION_NAMES).size).toBe(20);
      for (const name of CLIFF_ORIENTATION_NAMES) {
        const [from, to] = name.split("-to-");
        expect(SIDES).toContain(from);
        expect(SIDES).toContain(to);
        expect(from).not.toBe(to);
      }
    });

    it("reproduces the name of every placing code", () => {
      for (const code of codes)
        expect(CLIFF_ORIENTATION_NAMES[CLIFF_CODE_TO_ORIENTATION[code]]).toBe(nameFromCode(code));
    });

    it("exercises all three cell shapes, so no branch of the rule goes untested", () => {
      let straight = 0;
      let corner = 0;
      let end = 0;
      for (const code of codes) {
        const vertical = (((code >> 6) & 3) === 0 ? 0 : 1) + (((code >> 4) & 3) === 0 ? 0 : 1);
        const horizontal = (((code >> 2) & 3) === 0 ? 0 : 1) + ((code & 3) === 0 ? 0 : 1);
        if (vertical + horizontal === 1) end++;
        else if (vertical === 1 && horizontal === 1) corner++;
        else straight++;
      }
      expect([straight, corner, end]).toEqual([4, 8, 8]);
    });
  });
});

describe("cliff orientation collision boxes", () => {
  it("has one box per orientation, each a valid AABB", () => {
    expect(CLIFF_ORIENTATION_COLLISION_BOX).toHaveLength(CLIFF_ORIENTATION_NAMES.length);
    for (const [l, t, r, b] of CLIFF_ORIENTATION_COLLISION_BOX) {
      expect(r).toBeGreaterThan(l);
      expect(b).toBeGreaterThan(t);
    }
  });

  it("keeps the four straight orientations exactly as create_cliff_data_specification writes them", () => {
    // Literal transcription pin - these four are plain boxes in the Lua, not
    // `rotbb` calls, so nothing else in this file would catch a typo in them.
    expect(CLIFF_ORIENTATION_COLLISION_BOX[0]).toEqual([-2.0, -1.5, 2.0, 1.5]); // west-to-east
    expect(CLIFF_ORIENTATION_COLLISION_BOX[1]).toEqual([-1.0, -2.0, 1.0, 2.0]); // north-to-south
    expect(CLIFF_ORIENTATION_COLLISION_BOX[2]).toEqual([-2.0, -0.5, 2.0, 0.5]); // east-to-west
    expect(CLIFF_ORIENTATION_COLLISION_BOX[3]).toEqual([-1.0, -2.0, 1.0, 2.0]); // south-to-north
  });

  /**
   * Re-derives the 16 `rotbb` boxes the long way, from the Lua source's actual
   * rectangle plus its 1/8-turn orientation, and checks the result against the
   * shipped square. `cliffCatalog.ts` ships the closed form (`[x, x+size] x
   * [y, y+size]`) because it is what the engine ends up scanning; this is the
   * working that justifies dropping the `intersect` argument.
   */
  describe("the rotbb boxes are the AABB of the 45-degree rectangle", () => {
    /** `rotbb` verbatim (base/prototypes/entity/entity-util.lua:9). */
    const rotbb = (
      x: number,
      y: number,
      size: number,
      intersect: number,
    ): { cx: number; cy: number; hx: number; hy: number } => {
      const dist = (size / 2) * Math.SQRT2;
      const yRatio = intersect / size;
      const xRatio = 1 - yRatio;
      return {
        cx: x + size / 2,
        cy: y + size / 2,
        hx: xRatio * dist,
        hy: yRatio * dist,
      };
    };

    /** AABB of that rectangle after the prototype's 1/8 turn (45 degrees). */
    const rotatedAabb = (
      x: number,
      y: number,
      size: number,
      intersect: number,
    ): [number, number, number, number] => {
      const { cx, cy, hx, hy } = rotbb(x, y, size, intersect);
      const c = Math.cos(Math.PI / 4);
      const s = Math.sin(Math.PI / 4);
      const ex = Math.abs(hx * c) + Math.abs(hy * s);
      const ey = Math.abs(hx * s) + Math.abs(hy * c);
      return [cx - ex, cy - ey, cx + ex, cy + ey];
    };

    /** The 16 `rotbb(...)` call sites, in orientation-id order. */
    const CALLS: [number, [number, number, number, number]][] = [
      [4, [-3.5, -3, 4.5, 3]],
      [5, [-1, -3, 4.5, 1.5]],
      [6, [-1, -0.5, 3.5, 2.5]],
      [7, [-2.5, -0.5, 3.5, 1]],
      [8, [-3.5, -1.5, 4.5, 1.5]],
      [9, [-2.5, -3, 3.5, 2.5]],
      [10, [-1, -3, 3.5, 1]],
      [11, [-1, -1.5, 4.5, 3]],
      [12, [-3, -1.5, 3, 2]],
      [13, [0, -1.5, 3, 1]],
      [14, [0, -0.5, 2.5, 2]],
      [15, [-2.5, -0.5, 2.51, 0.5]],
      [16, [-1, -2.5, 3, 1]],
      [17, [-1, -0.5, 3, 2.5]],
      [18, [-2, -0.5, 3, 0.5]],
      [19, [-2, -2.5, 3, 2]],
    ];

    it("reproduces every shipped rotbb box", () => {
      expect(CALLS).toHaveLength(16);
      for (const [id, [x, y, size, intersect]] of CALLS) {
        const want = CLIFF_ORIENTATION_COLLISION_BOX[id];
        const got = rotatedAabb(x, y, size, intersect);
        for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i], 9);
      }
    });

    it("is independent of `intersect`, which is why the shipped form omits it", () => {
      // The claim that lets `rotbbBox` take three arguments. Sweeping the fourth
      // must not move the AABB.
      for (const [id, [x, y, size]] of CALLS) {
        for (const intersect of [0.25, 1, size / 2, size - 0.25]) {
          const got = rotatedAabb(x, y, size, intersect);
          const want = CLIFF_ORIENTATION_COLLISION_BOX[id];
          for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(want[i], 9);
        }
      }
    });

    it("differs from the UNROTATED rectangle, so the check above is not trivial", () => {
      // Without this, "the AABB equals the square" could hold because the
      // rotation was a no-op. It is not: the raw rectangle is narrower on one
      // axis for every one of the 16.
      let differing = 0;
      for (const [, [x, y, size, intersect]] of CALLS) {
        const { hx, hy } = rotbb(x, y, size, intersect);
        if (Math.abs(hx - size / 2) > 1e-9 || Math.abs(hy - size / 2) > 1e-9) differing++;
      }
      expect(differing).toBe(16);
    });
  });
});
