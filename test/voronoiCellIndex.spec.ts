import { describe, expect, it } from "vite-plus/test";
import { makeVoronoi } from "../src/noise/voronoiNoise";

/**
 * Fulgora's own `cells` parameters - see `src/noise/expressions/fulgoraCells.ts`.
 * Using the real ones rather than invented values keeps this test honest about
 * the configuration the island finder actually groups by.
 */
const FULGORA = {
  seed0: 2967702466,
  seed1: 1512814397,
  gridSize: 175,
  distanceType: "manhattan",
  jitter: 0.6,
} as const;

describe("Voronoi.cellIndex", () => {
  it("returns the same integer pair for two positions in the same cell", () => {
    const v = makeVoronoi(FULGORA);
    const a = v.cellIndex(1000, 1000);
    const b = v.cellIndex(1002, 1001);
    expect(b).toEqual(a);
    expect(Number.isInteger(a.cellX)).toBe(true);
    expect(Number.isInteger(a.cellY)).toBe(true);
  });

  it("returns a different pair for positions a full grid apart", () => {
    const v = makeVoronoi(FULGORA);
    const a = v.cellIndex(1000, 1000);
    const b = v.cellIndex(1000 + 175 * 2, 1000);
    expect(b).not.toEqual(a);
  });

  it("agrees with cellId - same index implies same id", () => {
    // The float id is a pure hash of the integer pair, so this must hold at
    // every position. It is what licenses grouping by index instead of by id.
    const v = makeVoronoi(FULGORA);
    const byIndex = new Map<string, number>();
    for (let x = 0; x < 2000; x += 37) {
      for (let y = 0; y < 2000; y += 41) {
        const { cellX, cellY } = v.cellIndex(x, y);
        const key = `${cellX},${cellY}`;
        const id = v.cellId(x, y);
        const seen = byIndex.get(key);
        if (seen === undefined) byIndex.set(key, id);
        else expect(id).toBe(seen);
      }
    }
    expect(byIndex.size).toBeGreaterThan(50);
  });
});
