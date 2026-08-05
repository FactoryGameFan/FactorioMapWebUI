import { describe, expect, it } from "vite-plus/test";

import { expressionInRangeBase, makeNoiseLayerNoise, waterBase } from "../src/noise/tiles/helpers";

// Task 8: the three tile-autoplace helper functions that the 21-tile catalog
// (Task 9) is built from. Pure composition over Task 1's expressionInRange and
// the multioctave primitive - no oracle capture needed here (the underlying
// primitives are already validated against the game).

describe("waterBase", () => {
  // Game: water_base(max_elevation, influence) =
  //   if(max_elevation >= elevation, influence * min(max_elevation - elevation, 1), -inf)
  // Signature here puts elevation (the runtime value) first, then the tile's
  // max_elevation/influence constants.
  it("returns influence * 1 when elevation is well below max_elevation (clamped headroom)", () => {
    // elevation=-3, maxElevation=-2: -2 >= -3 is true; headroom = -2-(-3) = 1, min(1,1)=1.
    expect(waterBase(-3, -2, 200)).toBe(200);
  });

  it("returns -Infinity once elevation exceeds max_elevation", () => {
    // elevation=0, maxElevation=-2: -2 >= 0 is false.
    expect(waterBase(0, -2, 200)).toBe(-Infinity);
  });

  it("scales influence by the (sub-1) headroom near the boundary", () => {
    // elevation=-2.5, maxElevation=-2: headroom = -2-(-2.5) = 0.5, min(0.5,1)=0.5.
    expect(waterBase(-2.5, -2, 200)).toBe(100);
  });

  it("treats elevation exactly at max_elevation as still water (boundary inclusive)", () => {
    // elevation == maxElevation: headroom = 0, min(0,1) = 0.
    expect(waterBase(-2, -2, 200)).toBe(0);
  });
});

describe("expressionInRangeBase", () => {
  // Game: expression_in_range_base(aux_from, moisture_from, aux_to, moisture_to)
  //   = expression_in_range(20, 1, aux, moisture, aux_from, moisture_from, aux_to, moisture_to)
  // i.e. peakMultiplier=20, peakMaximum=1, dims regrouped as [aux, moisture].
  it("is delegation over expressionInRange(20, 1, [aux, moisture], froms, tos)", () => {
    // Well inside both ranges (center) should hit the pmax=1 plateau.
    const inside = expressionInRangeBase(0, 0, -0.5, -0.5, 0.5, 0.5);
    expect(inside).toBe(1);
  });

  it("returns a value inside the range that exceeds a value outside the range", () => {
    const inside = expressionInRangeBase(0, 0, -0.5, -0.5, 0.5, 0.5);
    const outside = expressionInRangeBase(2, 2, -0.5, -0.5, 0.5, 0.5);
    expect(inside).toBeGreaterThan(outside);
  });

  it("falls off linearly with slope 20 just outside an edge (unclamped, negative)", () => {
    // aux=0.6 is 0.1 past the aux_to=0.5 edge; moisture stays centered (inside).
    // m = min(edgeDist_aux, edgeDist_moisture) = min(-0.1, 0.5) = -0.1 -> 20 * -0.1 = -2.
    //
    // Precision 6, not 10: `expressionInRange` rounds every step to f32 (#162), and
    // `0.5 - 0.6` is not representable there, so this returns -2.000000476837158.
    // The exact decimal is the wrong target for an f32 computation - see the note
    // in `expressionInRange.spec.ts`. Bit-exactness lives in that file's oracle
    // sweeps, which are exactly 0; this one guards the slope and the sign.
    expect(expressionInRangeBase(0.6, 0, -0.5, -0.5, 0.5, 0.5)).toBeCloseTo(-2, 6);
  });
});

describe("makeNoiseLayerNoise", () => {
  // Game: noise_layer_noise(seed) = multioctave_noise{persistence=0.7, seed1=seed,
  //   octaves=4, input_scale=1/6, output_scale=2/3}
  it("returns finite values at various coordinates", () => {
    const noise = makeNoiseLayerNoise(123456, 19);
    const samples: Array<[number, number]> = [
      [0, 0],
      [100, 0],
      [0, 100],
      [-50, 37.5],
      [1234, -987],
    ];
    for (const [x, y] of samples) {
      const v = noise(x, y);
      expect(Number.isFinite(v), `noise(${x}, ${y}) should be finite`).toBe(true);
    }
  });

  it("stays within a generous bound derived from the output scale (roughly [-8/3, 8/3])", () => {
    const noise = makeNoiseLayerNoise(123456, 19);
    // outputScale = 2/3; the normalised sum is not hard-bounded, but basis noise
    // is roughly unit-range, so a factor-of-4 margin over 2/3 is a sane sanity net.
    const bound = (2 / 3) * 4;
    for (let x = -200; x <= 200; x += 47) {
      for (let y = -200; y <= 200; y += 53) {
        const v = noise(x, y);
        expect(Math.abs(v), `|noise(${x}, ${y})|`).toBeLessThan(bound);
      }
    }
  });

  it("is deterministic for the same seed pair and differs across seed1", () => {
    const noiseA = makeNoiseLayerNoise(123456, 19);
    const noiseA2 = makeNoiseLayerNoise(123456, 19);
    const noiseB = makeNoiseLayerNoise(123456, 20);
    expect(noiseA(10, 10)).toBe(noiseA2(10, 10));
    expect(noiseA(10, 10)).not.toBe(noiseB(10, 10));
  });
});
