import { describe, expect, it } from "vite-plus/test";
import { renderEnemies } from "../src/noise/preview/renderEnemies";
import { WATER_TILE_COLORS } from "../src/noise/preview/renderResources";
import { ENEMY_MAP_COLOR } from "../src/noise/enemies/enemyCatalog";

const LAND: readonly [number, number, number] = [90, 120, 60];

/** An `w`x`h` ImageData pre-filled with `color`. */
function filled(w: number, h: number, color: readonly [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = 255;
  }
  return { width: w, height: h, data } as ImageData;
}

describe("renderEnemies", () => {
  it("leaves the starting area unpainted", () => {
    const img = filled(1, 1, LAND);
    renderEnemies(img, {
      seed0: 123456,
      originX: 0,
      originY: 0,
      tilesPerPixel: 1,
      controls: { frequency: 1, size: 1 },
    });
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([...LAND]); // untouched
  });

  /**
   * The overlay places spawners now instead of shading the base's cone, so this
   * asserts PLACEMENT rather than a footprint: some pixels paint, every painted
   * pixel is exactly `ENEMY_MAP_COLOR`, and coverage is a small fraction of what
   * the old `probability >= 0.05` threshold drew.
   *
   * The 32x32 window at (1000, 1040) is the same spot the old 1x1 test used - it
   * sits inside a base spot - widened so that a roll-based render has something
   * to hit. Measured there: 5 placements, 45 painted pixels (4.39% of the
   * window), against 265 pixels (25.9%) for the old threshold. The assertions
   * below are inequalities, not those counts, so they survive a re-measure.
   */
  it("places marks inside a base spot, far sparser than the old footprint", () => {
    const img = filled(32, 32, LAND);
    renderEnemies(img, {
      seed0: 123456,
      originX: 1000,
      originY: 1040,
      tilesPerPixel: 1,
      controls: { frequency: 1, size: 1 },
    });
    let painted = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const px = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (px[0] === LAND[0] && px[1] === LAND[1] && px[2] === LAND[2]) continue;
      expect(px).toEqual([...ENEMY_MAP_COLOR]);
      painted++;
    }
    expect(painted).toBeGreaterThan(0);
    // The old threshold render covered 25.9% of this window; a roll covers a few
    // percent. 15% is a ceiling well clear of both, so it fails loudly if the
    // overlay ever reverts to shading the cone.
    expect(painted / (32 * 32)).toBeLessThan(0.15);
  });

  /**
   * The paint guard, which is now a SEPARATE thing from the placement gate.
   * (1007, 1041) is a placed tile on `dirt-1`, so the water tile-restriction lets
   * it through; painting it as water here proves `paintMark`'s `skipPixel` still
   * keeps the mark off a pixel the terrain drew as water.
   */
  it("never paints over a water pixel", () => {
    const [wr, wg, wb] = WATER_TILE_COLORS[0];
    const img = filled(1, 1, [wr, wg, wb]);
    renderEnemies(img, {
      seed0: 123456,
      originX: 1007,
      originY: 1041,
      tilesPerPixel: 1,
      controls: { frequency: 1, size: 1 },
    });
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([wr, wg, wb]); // still water
  });

  it("paints the tile it places on when that tile is land", () => {
    const img = filled(1, 1, LAND);
    renderEnemies(img, {
      seed0: 123456,
      originX: 1007,
      originY: 1041,
      tilesPerPixel: 1,
      controls: { frequency: 1, size: 1 },
    });
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([...ENEMY_MAP_COLOR]);
  });

  it("map color drift guard", () => expect([...ENEMY_MAP_COLOR]).toEqual([255, 26, 26]));
});
