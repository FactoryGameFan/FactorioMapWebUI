import { describe, expect, it } from "vite-plus/test";
import { clamp, lerp, max, min, log2, sliderToLinear } from "../../src/noise/eval/math";

describe("eval/math", () => {
  it("clamps into [lo, hi]", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.3, 0, 1)).toBe(0.3);
  });

  it("lerps endpoints and midpoint", () => {
    expect(lerp(2, 4, 0)).toBe(2);
    expect(lerp(2, 4, 1)).toBe(4);
    expect(lerp(2, 4, 0.5)).toBe(3);
  });

  it("min/max take varargs", () => {
    expect(min(3, 1, 2)).toBe(1);
    expect(max(3, 1, 2)).toBe(3);
    expect(min(-1)).toBe(-1);
  });

  it("log2 matches Math.log2 (default size => 0)", () => {
    expect(log2(1)).toBe(0);
    expect(log2(8)).toBeCloseTo(3, 12);
    expect(log2(0.5)).toBeCloseTo(-1, 12);
  });

  it("sliderToLinear: s=1 is the midpoint, s=6 is hi", () => {
    expect(sliderToLinear(1, -0.5, 0.5)).toBeCloseTo(0, 12);
    expect(sliderToLinear(6, -0.5, 0.5)).toBeCloseTo(0.5, 12);
  });

  it("sliderToLinear: s -> 0 approaches lo (log2(s) -> -inf)", () => {
    expect(sliderToLinear(1 / 64, -0.5, 0.5)).toBeLessThan(-0.5);
  });

  it("sliderToLinear scales with an arbitrary [lo, hi]", () => {
    expect(sliderToLinear(1, 0, 10)).toBeCloseTo(5, 12);
    expect(sliderToLinear(6, 0, 10)).toBeCloseTo(10, 12);
  });

  // Moved here from test/cliffCatalog.spec.ts by #324, which deleted the
  // second, plain-f64 `sliderToLinear` that used to live in the cliff catalog.
  // These are anchors, not the grading - what settles which form is right is
  // test/sliderToLinearOracle.spec.ts, against the game's own values.
  it("sliderToLinear anchors on the cliff gate's own two ranges", () => {
    expect(sliderToLinear(1, -1, 1)).toBeCloseTo(0, 12);
    expect(sliderToLinear(6, -1, 1)).toBeCloseTo(1, 12);
    expect(sliderToLinear(1 / 6, -1, 1)).toBeCloseTo(-1, 12);
    // EXACT, not toBeCloseTo. The f64 copy this replaced also returned 0 here,
    // so a tolerance would accept either and the anchor would be blind to the
    // one range in the game data whose bounds f32 cannot hold. Narrowing the
    // bounds first is what makes this exactly 0 rather than 4.77e-8.
    expect(sliderToLinear(1, -1.7, 1.7)).toBe(0);
    expect(sliderToLinear(6, -1.7, 1.7)).toBe(Math.fround(1.7));
  });
});
