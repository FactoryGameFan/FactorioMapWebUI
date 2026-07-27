import { describe, expect, it } from "vite-plus/test";
import { makeNauvisRockPlacement, renderRocks } from "../src/noise/preview/renderRocks";
import { ROCK_MAP_COLOR } from "../src/noise/rocks/rockCatalog";
import { WATER_TILE_COLORS } from "../src/noise/preview/renderResources";

function solidImage(w: number, h: number, rgb: readonly [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, colorSpace: "srgb" } as ImageData;
}

describe("renderRocks", () => {
  const seed0 = 123456;
  // 128x128 rather than the 48x48 this test used while the render thresholded.
  // The roll places ~0.08% of tiles (measured in entityDensity.spec.ts), so a
  // 48x48 window would expect ~2 rocks and could plausibly hold none, leaving
  // the "painted > 0" guard below one seed away from vacuous.
  const W = 128;
  const H = 128;
  const originX = 288;
  const originY = -216;

  it("paints ROCK_MAP_COLOR exactly where the placement roll and both gates accept", () => {
    const placed = makeNauvisRockPlacement({ seed0, startingPositions: [{ x: 0, y: 0 }] });
    const img = solidImage(W, H, [100, 100, 100]); // non-water land
    renderRocks(img, { seed0, originX, originY, startingPositions: [{ x: 0, y: 0 }] });
    let painted = 0;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const o = (py * W + px) * 4;
        const isRock =
          img.data[o] === ROCK_MAP_COLOR[0] &&
          img.data[o + 1] === ROCK_MAP_COLOR[1] &&
          img.data[o + 2] === ROCK_MAP_COLOR[2];
        expect(isRock).toBe(placed(originX + px, originY + py));
        if (isRock) painted++;
      }
    }
    // Sparse but present in this region (guards against "painted nothing"/"painted all").
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(W * H);
  });

  it("never paints over water pixels", () => {
    const water = WATER_TILE_COLORS[0];
    const img = solidImage(W, H, water);
    renderRocks(img, { seed0, originX, originY, startingPositions: [{ x: 0, y: 0 }] });
    for (let i = 0; i < W * H; i++) {
      expect(img.data[i * 4]).toBe(water[0]);
      expect(img.data[i * 4 + 1]).toBe(water[1]);
      expect(img.data[i * 4 + 2]).toBe(water[2]);
    }
  });
});
