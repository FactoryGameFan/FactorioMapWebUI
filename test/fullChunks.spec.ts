import { describe, expect, it } from "vite-plus/test";
import { CHUNK_TILES, countFullChunks } from "../src/noise/islands/fullChunks";

/** A solid all-land mask of `w` x `h` pixels. */
function solid(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h).fill(1);
}

describe("countFullChunks", () => {
  it("counts a chunk-aligned solid block", () => {
    // 64x64 tiles at 2 tiles/px = 32x32 px; a chunk is 16 px a side, so 2x2.
    const tpp = 2;
    const side = CHUNK_TILES / tpp;
    expect(countFullChunks(solid(2 * side, 2 * side), 2 * side, 2 * side, 0, 0, tpp)).toBe(4);
  });

  it("counts the same area at the coarse step", () => {
    // Same 64x64 tiles at 8 tiles/px = 8x8 px, chunk = 4 px a side, still 2x2.
    const tpp = 8;
    const side = CHUNK_TILES / tpp;
    expect(countFullChunks(solid(2 * side, 2 * side), 2 * side, 2 * side, 0, 0, tpp)).toBe(4);
  });

  it("does not count a chunk with a single water pixel in it", () => {
    const tpp = 2;
    const side = CHUNK_TILES / tpp;
    const w = 2 * side;
    const mask = solid(w, w);
    // Poke one hole in the top-left chunk only.
    mask[3 * w + 3] = 0;
    expect(countFullChunks(mask, w, w, 0, 0, tpp)).toBe(3);
  });

  it("ALIGNS to the world chunk grid, not to the window", () => {
    // The discriminating case, and the reason this is not just "area / 1024".
    // A window exactly one chunk wide holds a whole chunk when its origin sits
    // on the chunk grid, and NO whole chunk when it straddles two of them -
    // same pixels, same land, different answer. A window-relative
    // implementation would return 1 for both.
    const tpp = 2;
    const side = CHUNK_TILES / tpp;
    const mask = solid(side, side);
    expect(countFullChunks(mask, side, side, 0, 0, tpp)).toBe(1);
    expect(countFullChunks(mask, side, side, CHUNK_TILES, -CHUNK_TILES, tpp)).toBe(1);
    // Offset by half a chunk in x: the block now spans two chunks and
    // completes neither.
    expect(countFullChunks(mask, side, side, CHUNK_TILES / 2, 0, tpp)).toBe(0);
  });

  it("handles a negative origin, which every window left or above spawn has", () => {
    const tpp = 2;
    const side = CHUNK_TILES / tpp;
    const w = 2 * side;
    expect(countFullChunks(solid(w, w), w, w, -CHUNK_TILES * 3, -CHUNK_TILES * 5, tpp)).toBe(4);
    // Negative AND unaligned: 64 tiles of span starting mid-chunk covers only
    // one whole chunk, not two.
    expect(countFullChunks(solid(w, w), w, w, -CHUNK_TILES * 3 + 16, -CHUNK_TILES * 5, tpp)).toBe(
      2,
    );
  });

  it("counts zero for an all-water mask and for a window smaller than a chunk", () => {
    const tpp = 2;
    const side = CHUNK_TILES / tpp;
    expect(countFullChunks(new Uint8Array(side * side), side, side, 0, 0, tpp)).toBe(0);
    expect(countFullChunks(solid(side - 1, side - 1), side - 1, side - 1, 0, 0, tpp)).toBe(0);
  });

  it("throws if a step would not divide a chunk into whole pixels", () => {
    // Cannot happen from `findIslands` (it uses 8 and 2), so this is a guard
    // against a future caller silently getting misaligned counts.
    expect(() => countFullChunks(solid(4, 4), 4, 4, 0, 0, 48)).toThrow(/does not divide/);
  });

  it("is NOT land tiles divided by 1024 - that is the whole point", () => {
    // A cross shape: plenty of land, no whole chunk anywhere. Counting tiles
    // and dividing would claim buildable area that no blueprint can use.
    const tpp = 2;
    const side = CHUNK_TILES / tpp;
    const w = 3 * side;
    const mask = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const inArm = (x >= side && x < 2 * side) || (y >= side && y < 2 * side);
        if (inArm) mask[y * w + x] = 1;
      }
    }
    const landPx = mask.reduce((n, v) => n + v, 0);
    expect(landPx * tpp * tpp).toBeGreaterThan(4 * CHUNK_TILES * CHUNK_TILES);
    // The centre chunk plus the four arm chunks are each solid, so five - and
    // the four corners are empty. Tiles/1024 would say nine.
    expect(countFullChunks(mask, w, w, 0, 0, tpp)).toBe(5);
  });
});
