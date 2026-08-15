import { describe, expect, it } from "vite-plus/test";
import { chainComponents, minGapTiles, type PlacedMask } from "../src/noise/islands/chainGraph";

/** A solid `size` x `size` block of land whose top-left tile is at (ox, oy). */
function block(ox: number, oy: number, size: number, tpp = 1): PlacedMask {
  return {
    mask: new Uint8Array(size * size).fill(1),
    width: size,
    height: size,
    originX: ox,
    originY: oy,
    tilesPerPixel: tpp,
  };
}

describe("minGapTiles", () => {
  it("is 0 for touching blocks", () => {
    expect(minGapTiles(block(0, 0, 4), block(4, 0, 4))).toBe(0);
  });

  it("measures the tile gap between the nearest land of each", () => {
    // Left block occupies x 0..3; right starts at x 14. Nearest land is 3 and
    // 14, so the gap is 10 tiles.
    expect(minGapTiles(block(0, 0, 4), block(14, 0, 4))).toBe(10);
  });

  it("respects tilesPerPixel when converting pixels to tiles", () => {
    // At 2 tiles/px a 4px block spans 8 tiles: x 0..7. The other starts at 17,
    // so the gap is 10 tiles.
    expect(minGapTiles(block(0, 0, 4, 2), block(17, 0, 4, 2))).toBe(10);
  });
});

describe("chainComponents", () => {
  it("joins at a 30-tile gap and not at 31", () => {
    // block(0,0,4) spans x 0..3. block(33,...) starts at 33, so the nearest
    // land is 30 tiles away - exactly the reach, which must join.
    const joined = chainComponents([block(0, 0, 4), block(33, 0, 4)]);
    expect(joined[0]).toBe(joined[1]);
    // block(34,...) is 31 away - one past the reach, which must not join.
    const apart = chainComponents([block(0, 0, 4), block(34, 0, 4)]);
    expect(apart[0]).not.toBe(apart[1]);
  });

  it("chains transitively - A near B near C is one chain even if A and C are far", () => {
    const ids = chainComponents([block(0, 0, 4), block(30, 0, 4), block(60, 0, 4)]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(minGapTiles(block(0, 0, 4), block(60, 0, 4))).toBeGreaterThan(30);
  });

  it("gives an isolated island its own component", () => {
    const ids = chainComponents([block(0, 0, 4), block(500, 500, 4)]);
    expect(new Set(ids).size).toBe(2);
  });
});
