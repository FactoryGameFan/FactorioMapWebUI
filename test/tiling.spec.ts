import { describe, it, expect } from "vite-plus/test";
import { planForPool, planRows, planTiles, stitchTiles } from "../src/noise/preview/tiling";

const full = { originX: -512, originY: -512, width: 1024, height: 1024, tilesPerPixel: 1 };

describe("planTiles", () => {
  it("covers the image exactly once, with no overlap", () => {
    const tiles = planTiles(full, 128);
    expect(tiles).toHaveLength(64);
    const seen = new Uint8Array(full.width * full.height);
    for (const t of tiles) {
      for (let y = 0; y < t.height; y++) {
        for (let x = 0; x < t.width; x++) {
          seen[(t.dy + y) * full.width + (t.dx + x)]++;
        }
      }
    }
    expect(seen.every((c) => c === 1)).toBe(true);
  });

  it("maps each tile's pixel offset to its world origin through tilesPerPixel", () => {
    const tiles = planTiles({ ...full, tilesPerPixel: 2 }, 128);
    const t = tiles.find((q) => q.dx === 128 && q.dy === 256)!;
    expect(t.originX).toBe(-512 + 128 * 2);
    expect(t.originY).toBe(-512 + 256 * 2);
    expect(t.tilesPerPixel).toBe(2);
  });

  it("handles a ragged trailing row and column", () => {
    const tiles = planTiles({ ...full, width: 100, height: 70 }, 32);
    // 4 columns (32, 32, 32, 4) x 3 rows (32, 32, 6)
    expect(tiles).toHaveLength(12);
    expect(tiles.filter((t) => t.width === 4)).toHaveLength(3);
    expect(tiles.filter((t) => t.height === 6)).toHaveLength(4);
    const area = tiles.reduce((n, t) => n + t.width * t.height, 0);
    expect(area).toBe(100 * 70);
  });

  it("returns a single tile when the tile size exceeds the image", () => {
    const tiles = planTiles({ ...full, width: 10, height: 10 }, 4096);
    expect(tiles).toEqual([
      { originX: -512, originY: -512, width: 10, height: 10, tilesPerPixel: 1, dx: 0, dy: 0 },
    ]);
  });

  it("rejects a non-positive tile size", () => {
    expect(() => planTiles(full, 0)).toThrow(/tileSize/);
  });
});

/** How many times each pixel of `box` is covered by `tiles`. */
function coverage(
  box: { width: number; height: number },
  tiles: readonly { dx: number; dy: number; width: number; height: number }[],
): Uint8Array {
  const seen = new Uint8Array(box.width * box.height);
  for (const t of tiles) {
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) seen[(t.dy + y) * box.width + (t.dx + x)]++;
    }
  }
  return seen;
}

describe("planForPool", () => {
  it("gives every pool size from 1 to 32 a whole number of tiles per worker, at least four", () => {
    for (let n = 1; n <= 32; n++) {
      const tiles = planForPool(full, n);
      expect(tiles.length % n, `pool ${n}`).toBe(0);
      expect(tiles.length, `pool ${n}`).toBeGreaterThanOrEqual(4);
      // One tile per worker unless that would be fewer than four.
      expect(tiles.length, `pool ${n}`).toBe(n >= 4 ? n : n * Math.ceil(4 / n));
      expect(
        coverage(full, tiles).every((c) => c === 1),
        `pool ${n}`,
      ).toBe(true);
    }
  });

  it("cuts the app's preview on chunk boundaries, in tiles of about the same area", () => {
    for (let n = 1; n <= 16; n++) {
      const tiles = planForPool(full, n);
      for (const t of tiles) {
        // -512 is itself a chunk start, so every cut is a multiple of 32.
        expect(t.dx % 32, `pool ${n}`).toBe(0);
        expect(t.dy % 32, `pool ${n}`).toBe(0);
        expect(t.originX, `pool ${n}`).toBe(full.originX + t.dx);
      }
      const areas = tiles.map((t) => t.width * t.height);
      // Chunk snapping is what keeps this from 1.0: 32 chunks do not split
      // evenly five ways (15 workers: 6 or 7 chunks wide, 10 or 11 tall, so
      // 60 to 77 chunks). Larger pools than a desktop has spread wider.
      expect(Math.max(...areas) / Math.min(...areas), `pool ${n}`).toBeLessThan(1.3);
    }
  });

  it("is the 4x4 grid of 256-pixel tiles at 16 workers and 512-pixel quarters at 4", () => {
    expect(planForPool(full, 16)).toEqual(planTiles(full, 256));
    expect(planForPool(full, 4)).toEqual(planTiles(full, 512));
  });

  it("lays 15 workers out as five columns by three rows", () => {
    const tiles = planForPool(full, 15);
    expect([...new Set(tiles.map((t) => t.dx))]).toEqual([0, 192, 416, 608, 832]);
    expect([...new Set(tiles.map((t) => t.dy))]).toEqual([0, 352, 672]);
  });

  it("snaps to the chunk grid of an origin that is not itself a chunk start", () => {
    const off = { ...full, originX: -500, originY: 7 };
    const tiles = planForPool(off, 15);
    expect(coverage(off, tiles).every((c) => c === 1)).toBe(true);
    for (const t of tiles) {
      const chunkPhase = (v: number) => ((v % 32) + 32) % 32;
      if (t.dx > 0) expect(chunkPhase(off.originX + t.dx)).toBe(0);
      if (t.dy > 0) expect(chunkPhase(off.originY + t.dy)).toBe(0);
    }
  });

  it("falls back to even cuts where no pixel starts a chunk, and still covers the image once", () => {
    // At 0.75 tiles per pixel a chunk is 42.67 pixels, so no cut can snap.
    const odd = { ...full, width: 300, height: 200, tilesPerPixel: 0.75 };
    const tiles = planForPool(odd, 7);
    expect(tiles).toHaveLength(7);
    expect(coverage(odd, tiles).every((c) => c === 1)).toBe(true);
  });

  it("never makes an empty tile, even on an image smaller than the pool", () => {
    const tiny = { ...full, width: 3, height: 2 };
    const tiles = planForPool(tiny, 15);
    expect(tiles.every((t) => t.width > 0 && t.height > 0)).toBe(true);
    expect(coverage(tiny, tiles).every((c) => c === 1)).toBe(true);
  });
});

describe("planRows", () => {
  it("rejects a tile count that is not a positive integer", () => {
    expect(() => planRows(full, 0)).toThrow(/count/);
    expect(() => planRows(full, 2.5)).toThrow(/count/);
  });
});

describe("stitchTiles", () => {
  it("writes each tile's rows into the right place in the full buffer", () => {
    const target = { width: 4, height: 2 };
    const left = new Uint8ClampedArray(2 * 2 * 4).fill(1);
    const right = new Uint8ClampedArray(2 * 2 * 4).fill(2);
    const out = stitchTiles(target, [
      { dx: 0, dy: 0, width: 2, height: 2, data: left },
      { dx: 2, dy: 0, width: 2, height: 2, data: right },
    ]);
    // Row 0: two pixels of 1, then two pixels of 2.
    expect([...out.subarray(0, 8)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect([...out.subarray(8, 16)]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    // Row 1 repeats the pattern.
    expect([...out.subarray(16, 24)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect([...out.subarray(24, 32)]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  });
});
