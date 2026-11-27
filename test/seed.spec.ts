import { describe, it, expect } from "vite-plus/test";
import { randomU32 } from "../src/util/seed";

describe("randomU32", () => {
  it("returns a non-negative 32-bit integer", () => {
    for (let i = 0; i < 100; i++) {
      const n = randomU32();
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("returns a different seed on different calls", () => {
    // The range test above passes for a function that always returns 0
    // (test-pruning audit, 2026-11-26). 100 draws from 2^32 values repeat
    // with probability about 1e-6, so a set of at least 90 distinct values
    // fails only when the source is not random.
    const draws = new Set(Array.from({ length: 100 }, () => randomU32()));
    expect(draws.size).toBeGreaterThanOrEqual(90);
  });
});
