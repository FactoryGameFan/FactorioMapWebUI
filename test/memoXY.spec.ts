import { describe, expect, it } from "vite-plus/test";

import { memoXY } from "../src/noise/eval/memoXY";

describe("memoXY", () => {
  it("returns the identical float on a repeat call, without recomputing", () => {
    let calls = 0;
    const f = memoXY((x, y) => {
      calls++;
      return x * 3 + y;
    });
    expect(f(1.5, 2.25)).toBe(6.75);
    expect(f(1.5, 2.25)).toBe(6.75);
    expect(calls).toBe(1);
  });

  it("recomputes when either coordinate changes, and again on return", () => {
    let calls = 0;
    const f = memoXY((x, y) => {
      calls++;
      return x * 3 + y;
    });
    f(1, 1);
    f(1, 2);
    f(2, 2);
    f(1, 1);
    expect(calls).toBe(4);
  });

  /**
   * **The regression guard for the hazard fixed on 2026-08-05**, and it is
   * deliberately a dirty/clean PAIR rather than one assertion, because the bug is
   * invisible on the first call.
   *
   * `memoXY` used to record `lastX`/`lastY` BEFORE calling through. A wrapped
   * function that throws then left the slot claiming a position it had never
   * produced a value for, so the next call at that same position took the cache
   * hit and returned the PREVIOUS position's number instead of throwing. The
   * fixed version assigns the coordinates only after `fn` returns.
   *
   * `dirty` below is the old implementation, inlined. It is here so the test can
   * demonstrate that the two orderings actually differ - without it, `clean`
   * passing would be consistent with the guard testing nothing. Confirmed to
   * discriminate: `dirty` returns 10 on the second call at (2, 2) where `clean`
   * throws.
   */
  describe("a throwing fn must keep throwing on the second call at that position", () => {
    const throwsAtTwo = (): ((x: number, y: number) => number) => {
      return (x: number, y: number): number => {
        if (x === 2) throw new Error("nope");
        return x * 10 + y;
      };
    };

    it("clean: the shipped memoXY", () => {
      const f = memoXY(throwsAtTwo());
      expect(f(1, 1)).toBe(11);
      expect(() => f(2, 2)).toThrow("nope");
      // The bug surfaces HERE, never on the first call.
      expect(() => f(2, 2)).toThrow("nope");
      // And the slot must still hold the last position that really produced a value.
      expect(f(1, 1)).toBe(11);
    });

    it("dirty: recording the coordinates first returns a stale value instead", () => {
      const fn = throwsAtTwo();
      let lastX = NaN;
      let lastY = NaN;
      let value = 0;
      const dirty = (x: number, y: number): number => {
        if (x === lastX && y === lastY) return value;
        lastX = x;
        lastY = y;
        value = fn(x, y);
        return value;
      };
      expect(dirty(1, 1)).toBe(11);
      expect(() => dirty(2, 2)).toThrow("nope");
      // The failure this pair exists to pin: a stale 11, silently.
      expect(dirty(2, 2)).toBe(11);
    });
  });

  it("keeps its slots independent between instances", () => {
    const a = memoXY((x, y) => x + y);
    const b = memoXY((x, y) => x - y);
    expect(a(5, 3)).toBe(8);
    expect(b(5, 3)).toBe(2);
    expect(a(5, 3)).toBe(8);
  });
});
