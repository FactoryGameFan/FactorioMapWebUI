import { describe, expect, it } from "vite-plus/test";
import { renderCliffs, paintMark } from "../src/noise/preview/renderCliffs";
import { WATER_TILE_COLORS } from "../src/noise/preview/renderResources";
import { CLIFF_MAP_COLOR } from "../src/noise/cliffs/cliffCatalog";

const land = (w: number, h: number): ImageData =>
  ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(90) }) as ImageData;
const settings = { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 };

describe("renderCliffs", () => {
  it("paints cliff cells the cliff color", () => {
    // Render a 64x64 window known to contain cliffs (dense sub-window of the Task 8
    // fixture region [512,1024)^2, which has ~282 cliffs at seed 123456; this window
    // has 39) at tpp 1.
    const img = land(64, 64);
    renderCliffs(img, {
      seed0: 123456,
      originX: 960,
      originY: 512,
      tilesPerPixel: 1,
      controls: { frequency: 1, continuity: 1 },
      settings,
    });
    // At least one pixel became the cliff color.
    let painted = 0;
    for (let i = 0; i < img.data.length; i += 4)
      if (
        img.data[i] === CLIFF_MAP_COLOR[0] &&
        img.data[i + 1] === CLIFF_MAP_COLOR[1] &&
        img.data[i + 2] === CLIFF_MAP_COLOR[2]
      )
        painted++;
    expect(painted).toBeGreaterThan(0);
  });
  it("continuity 0 paints nothing", () => {
    const img = land(64, 64);
    renderCliffs(img, {
      seed0: 123456,
      originX: 512,
      originY: 512,
      tilesPerPixel: 1,
      controls: { frequency: 1, continuity: 0 },
      settings,
    });
    for (let i = 0; i < img.data.length; i += 4) expect(img.data[i]).toBe(90);
  });
  it("never paints water", () => {
    const [wr, wg, wb] = WATER_TILE_COLORS[0];
    const img = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) } as ImageData;
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = wr;
      img.data[i + 1] = wg;
      img.data[i + 2] = wb;
      img.data[i + 3] = 255;
    }
    renderCliffs(img, {
      seed0: 123456,
      originX: 960,
      originY: 512,
      tilesPerPixel: 1,
      controls: { frequency: 1, continuity: 1 },
      settings,
    });
    for (let i = 0; i < img.data.length; i += 4)
      expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([wr, wg, wb]);
  });
  it("thickens each cell to a block so cliff lines read at preview scale", () => {
    // Cells sit on a 4-tile grid, so at tpp 1 painted cells are >= 4px apart; if
    // each cell painted a single pixel, no two cliff pixels could be orthogonally
    // adjacent. A thicker per-cell mark makes some cliff pixel have a cliff-colored
    // right or down neighbor.
    const img = land(64, 64);
    renderCliffs(img, {
      seed0: 123456,
      originX: 960,
      originY: 512,
      tilesPerPixel: 1,
      controls: { frequency: 1, continuity: 1 },
      settings,
    });
    const isCliff = (px: number, py: number): boolean => {
      const o = (py * 64 + px) * 4;
      return (
        img.data[o] === CLIFF_MAP_COLOR[0] &&
        img.data[o + 1] === CLIFF_MAP_COLOR[1] &&
        img.data[o + 2] === CLIFF_MAP_COLOR[2]
      );
    };
    let adjacentPair = false;
    for (let py = 0; py < 64 && !adjacentPair; py++)
      for (let px = 0; px < 64 && !adjacentPair; px++)
        if (
          isCliff(px, py) &&
          ((px < 63 && isCliff(px + 1, py)) || (py < 63 && isCliff(px, py + 1)))
        )
          adjacentPair = true;
    expect(adjacentPair).toBe(true);
  });
  it("map color drift guard", () => expect([...CLIFF_MAP_COLOR]).toEqual([144, 119, 87]));
});

describe("paintMark", () => {
  const blank = (w: number, h: number): ImageData =>
    ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData;

  it("paints a (2r+1) square centred on the pixel", () => {
    const img = blank(7, 7);
    paintMark(img, 3, 3, [10, 20, 30], 1);
    let painted = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] === 255) painted++;
    expect(painted).toBe(9);
    const o = (3 * 7 + 3) * 4;
    expect([img.data[o], img.data[o + 1], img.data[o + 2]]).toEqual([10, 20, 30]);
  });

  it("clips at the image edge instead of wrapping", () => {
    const img = blank(7, 7);
    paintMark(img, 0, 0, [10, 20, 30], 1);
    let painted = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] === 255) painted++;
    expect(painted).toBe(4); // the in-image quadrant of a 3x3
    const bottomRightWrapped = (6 + 6 * 7) * 4; // position that would wrap if clipping weren't enforced
    expect(img.data[bottomRightWrapped + 3]).toBe(0);
  });

  it("honours skipPixel per painted pixel", () => {
    const img = blank(3, 3);
    const o = (1 * 3 + 1) * 4;
    img.data[o] = 99;
    paintMark(img, 1, 1, [10, 20, 30], 1, (r) => r === 99);
    expect(img.data[o]).toBe(99); // skipped
    expect(img.data[0]).toBe(10); // neighbour painted
  });
});
