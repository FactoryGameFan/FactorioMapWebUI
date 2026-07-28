import { describe, expect, it } from "vite-plus/test";

import {
  makePlacementRoll,
  makePlacementSet,
  PLACEMENT_SALT,
} from "../src/noise/placement/placementRoll";

/**
 * The two arbitration gates the game applies around the placement roll, on
 * hand-checkable synthetic fields rather than real noise.
 *
 * `makePlacementSet` resolves a whole 32x32 chunk at once - the containment that
 * lets collision rejection (which is order-dependent by nature) stay a pure
 * function of world position. Every assertion here is about that contract; the
 * agreement-with-the-game measurement lives in `entityDensity.spec.ts`.
 */
describe("makePlacementSet: tile restriction", () => {
  it("removes exactly the disallowed tiles and nothing else", () => {
    const placed = makePlacementSet({
      salt: PLACEMENT_SALT.vulcanusRocks,
      probability: () => 1,
      tileAllowed: (x) => x % 2 === 0,
    });
    // `probability = 1` places everywhere (U is in [0, 1)), so the accepted set
    // is exactly the allowed set.
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) expect(placed(x, y)).toBe(x % 2 === 0);
    }
  });
});

describe("makePlacementSet: collision rejection", () => {
  // A w=h=3 box against another w=h=3 box overlaps when |dx| < (3+3)/2 = 3, so
  // one accepted tile blocks the 5x5 neighbourhood centred on it.
  const box = { w: 3, h: 3 };
  const placedAll = (): ((x: number, y: number) => boolean) =>
    makePlacementSet({
      salt: PLACEMENT_SALT.vulcanusRocks,
      probability: () => 1,
      collisionBox: () => box,
    });

  it("walks the chunk in DECREASING tile index, so tile 1023 is accepted first", () => {
    const placed = placedAll();
    // tile 1023 = (y & 31) * 32 + (x & 31) with x = y = 31.
    expect(placed(31, 31)).toBe(true);
    // Its whole 5x5 exclusion (clipped to the chunk) is rejected.
    for (let dy = -2; dy <= 0; dy++) {
      for (let dx = -2; dx <= 0; dx++) {
        if (dx === 0 && dy === 0) continue;
        expect(placed(31 + dx, 31 + dy)).toBe(false);
      }
    }
    // The next tile in decreasing index that clears it is (28, 31): tiles 1022
    // and 1021 are inside the box, 1020 is exactly 3 away.
    expect(placed(28, 31)).toBe(true);
  });

  it("greedily fills the top row every 3 tiles, then skips two whole rows", () => {
    const placed = placedAll();
    const rowAccepted = (y: number): number[] => {
      const out: number[] = [];
      for (let x = 0; x < 32; x++) if (placed(x, y)) out.push(x);
      return out;
    };
    // Row 31 is processed first, right to left, so acceptances land at
    // 31, 28, 25, ... 1.
    const expectedRow: number[] = [];
    for (let x = 31; x >= 0; x -= 3) expectedRow.push(x);
    expectedRow.reverse();
    expect(rowAccepted(31)).toEqual(expectedRow);
    // Rows 30 and 29 are within |dy| < 3 of row 31, and row 31's 3-tile spacing
    // leaves no gap wider than the 5-tile exclusion, so both are empty.
    expect(rowAccepted(30)).toEqual([]);
    expect(rowAccepted(29)).toEqual([]);
    // Row 28 is exactly 3 away, so it repeats row 31.
    expect(rowAccepted(28)).toEqual(expectedRow);
  });

  it("contains rejection inside the chunk - a neighbouring chunk starts fresh", () => {
    const placed = placedAll();
    // (32, 31) is tile 1023's immediate right neighbour in world space but tile
    // 1023 of the NEXT chunk, which is resolved independently.
    expect(placed(31, 31)).toBe(true);
    expect(placed(32, 31)).toBe(false); // (32,31) is local (0,31), not first
    expect(placed(63, 31)).toBe(true); // local (31,31) of chunk (1,0)
  });
});

describe("makePlacementSet: purity", () => {
  it("gives the same answer regardless of query order or window", () => {
    const opts = {
      salt: PLACEMENT_SALT.vulcanusGeyser,
      probability: (x: number, y: number) => ((x * 7 + y * 13) & 15) / 16,
      tileAllowed: (x: number, y: number) => (x + y) % 5 !== 0,
      collisionBox: () => ({ w: 2.5, h: 1.5 }),
    };
    const pts: [number, number][] = [];
    for (let y = -40; y < 40; y++) for (let x = -40; x < 40; x++) pts.push([x, y]);

    const rowMajor = makePlacementSet(opts);
    const forward = pts.map(([x, y]) => rowMajor(x, y));

    const reverse = makePlacementSet(opts);
    const backward = [...pts]
      .reverse()
      .map(([x, y]) => reverse(x, y))
      .reverse();
    expect(backward).toEqual(forward);

    // Sparse, chunk-hopping access: every 37th point, which never visits a chunk
    // contiguously.
    const sparse = makePlacementSet(opts);
    for (let i = 0; i < pts.length; i += 37) {
      expect(sparse(pts[i][0], pts[i][1])).toBe(forward[i]);
    }
  });
});

describe("makePlacementSet: no gates", () => {
  it("reduces to the bare roll when neither gate is supplied", () => {
    const salt = PLACEMENT_SALT.crudeOil;
    const probability = (x: number, y: number): number => (((x * 31 + y * 17) & 63) + 1) / 128;
    const placed = makePlacementSet({ salt, probability });
    const roll = makePlacementRoll(salt);
    for (let y = -33; y < 33; y++) {
      for (let x = -33; x < 33; x++) {
        expect(placed(x, y)).toBe(roll(x, y) < probability(x, y));
      }
    }
  });
});
