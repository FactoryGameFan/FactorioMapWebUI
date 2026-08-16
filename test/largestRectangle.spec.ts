import { describe, expect, it } from "vite-plus/test";
import { largestRectangle, type Rect } from "../src/noise/islands/largestRectangle";

/** Build a mask from an ASCII picture. "#" is land, "." is not. */
function mask(rows: string[]): { m: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const m = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    expect(row.length).toBe(w);
    for (let x = 0; x < w; x++) m[y * w + x] = row[x] === "#" ? 1 : 0;
  });
  return { m, w, h };
}

/**
 * O(n^4) reference. Deliberately the dumbest correct thing: it enumerates every
 * rectangle and checks every cell. It exists so the fast version has something
 * independent to disagree with.
 */
function bruteForce(m: Uint8Array, w: number, h: number): Rect {
  let best: Rect = { x: 0, y: 0, width: 0, height: 0 };
  for (let y0 = 0; y0 < h; y0++)
    for (let x0 = 0; x0 < w; x0++)
      for (let y1 = y0; y1 < h; y1++)
        for (let x1 = x0; x1 < w; x1++) {
          let ok = true;
          for (let y = y0; y <= y1 && ok; y++)
            for (let x = x0; x <= x1 && ok; x++) if (!m[y * w + x]) ok = false;
          if (!ok) continue;
          const area = (x1 - x0 + 1) * (y1 - y0 + 1);
          if (area > best.width * best.height)
            best = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
        }
  return best;
}

describe("largestRectangle", () => {
  it("finds a full rectangle in an all-land mask", () => {
    const { m, w, h } = mask(["####", "####", "####"]);
    const r = largestRectangle(m, w, h);
    expect(r.width * r.height).toBe(12);
  });

  it("returns zero area for an all-ocean mask", () => {
    const { m, w, h } = mask(["....", "....", "...."]);
    expect(largestRectangle(m, w, h)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("finds the 2x3 block rather than the longer thin row", () => {
    // The top row has area 5; the 2-wide block on the left has area 6.
    const { m, w, h } = mask(["#####", "##...", "##..."]);
    const r = largestRectangle(m, w, h);
    expect(r.width * r.height).toBe(6);
    expect({ w: r.width, h: r.height }).toEqual({ w: 2, h: 3 });
  });

  it("handles a single row and a single column", () => {
    const row = mask(["###"]);
    expect(
      largestRectangle(row.m, row.w, row.h).width * largestRectangle(row.m, row.w, row.h).height,
    ).toBe(3);
    const col = mask(["#", "#", "#", "#"]);
    expect(
      largestRectangle(col.m, col.w, col.h).width * largestRectangle(col.m, col.w, col.h).height,
    ).toBe(4);
  });

  it("returns a rectangle that is actually all land", () => {
    const { m, w, h } = mask(["..##.", ".###.", "####.", ".##.."]);
    const r = largestRectangle(m, w, h);
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) expect(m[y * w + x]).toBe(1);
  });

  it("agrees with a brute-force reference over 400 random masks", () => {
    // A deterministic LCG - no Math.random, so a failure is reproducible.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 400; t++) {
      const w = 1 + Math.floor(rnd() * 9);
      const h = 1 + Math.floor(rnd() * 9);
      const density = 0.2 + rnd() * 0.7;
      const m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = rnd() < density ? 1 : 0;
      const fast = largestRectangle(m, w, h);
      const slow = bruteForce(m, w, h);
      expect(
        fast.width * fast.height,
        `trial ${t} (${w}x${h}) fast=${JSON.stringify(fast)} slow=${JSON.stringify(slow)}`,
      ).toBe(slow.width * slow.height);
    }
  });
});
