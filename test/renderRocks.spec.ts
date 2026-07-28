import { describe, expect, it } from "vite-plus/test";
import { makeNauvisRockPlacement, renderRocks } from "../src/noise/preview/renderRocks";
import { NAUVIS_ROCK_MARK_RADIUS_PX, ROCK_MAP_COLOR } from "../src/noise/rocks/rockCatalog";
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

  it("paints ROCK_MAP_COLOR over the placement roll's accepted tiles, and only there", () => {
    // Nauvis rocks paint a 3x3 mark (`NAUVIS_ROCK_MARK_RADIUS_PX`), so this is
    // NOT a 1:1 pixel-to-placement correspondence - it used to be, while the mark
    // was a single pixel. Two directions instead, which together pin the mark
    // exactly: every placement paints its own pixel, and every painted pixel is
    // within the mark radius of some placement.
    const placed = makeNauvisRockPlacement({ seed0, startingPositions: [{ x: 0, y: 0 }] });
    const img = solidImage(W, H, [100, 100, 100]); // non-water land
    renderRocks(img, { seed0, originX, originY, startingPositions: [{ x: 0, y: 0 }] });
    const isRockAt = (px: number, py: number): boolean => {
      const o = (py * W + px) * 4;
      return (
        img.data[o] === ROCK_MAP_COLOR[0] &&
        img.data[o + 1] === ROCK_MAP_COLOR[1] &&
        img.data[o + 2] === ROCK_MAP_COLOR[2]
      );
    };
    const r = NAUVIS_ROCK_MARK_RADIUS_PX;
    let painted = 0;
    let placements = 0;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        if (placed(originX + px, originY + py)) {
          placements++;
          // Every placement paints at least its own centre pixel.
          expect(isRockAt(px, py)).toBe(true);
        }
        if (!isRockAt(px, py)) continue;
        painted++;
        // ...and nothing is painted that no placement can reach.
        let near = false;
        for (let dy = -r; dy <= r && !near; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (placed(originX + px + dx, originY + py + dy)) {
              near = true;
              break;
            }
          }
        }
        expect(near).toBe(true);
      }
    }
    // Sparse but present in this region (guards against "painted nothing"/"painted all").
    expect(placements).toBeGreaterThan(0);
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(W * H);
    // The mark really is thickening: a 3x3 over sparse, mostly non-adjacent
    // placements paints several pixels each.
    expect(painted).toBeGreaterThan(placements * 2);
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
