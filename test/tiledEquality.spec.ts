import { describe, it, expect } from "vite-plus/test";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { planTiles, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";

// The definitive correctness gate for region tiling: rendering an area as tiles
// must reproduce the single whole-image render byte for byte. The renderer is
// validated point-by-point against headless Factorio as an oracle, so any pixel
// change here is a regression against the game itself, not a matter of taste.
//
// The region below was not picked by hand. A search over the seed's world grid
// rendered every candidate both ways and kept the one where haloless tiling
// differed MOST from the whole render (84 bytes across the cliff seams). Picking
// the region by the gate's own assertion is what guarantees the gate can fail:
// before the cliff halo existed, this case failed with exactly that difference.
const SEAM_SEED = 123456;
const SEAM_ORIGIN_X = 320;
const SEAM_ORIGIN_Y = 64;

function baseReq(over: Partial<ElevationRenderRequest> = {}): ElevationRenderRequest {
  return {
    id: 0,
    seed0: SEAM_SEED,
    width: 64,
    height: 64,
    originX: SEAM_ORIGIN_X,
    originY: SEAM_ORIGIN_Y,
    tilesPerPixel: 1,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    mapType: "nauvis",
    ...over,
  };
}

/** Render `req` as a grid of `tileSize` tiles and stitch the result. */
function renderTiled(req: ElevationRenderRequest, tileSize: number): Uint8ClampedArray {
  const full: ImageBox = {
    originX: req.originX,
    originY: req.originY,
    width: req.width,
    height: req.height,
    tilesPerPixel: req.tilesPerPixel,
  };
  const fullImage = {
    originX: full.originX,
    originY: full.originY,
    width: full.width,
    height: full.height,
  };
  const tiles = planTiles(full, tileSize).map((t) => {
    const out = runRenderRequest({
      ...req,
      originX: t.originX,
      originY: t.originY,
      width: t.width,
      height: t.height,
      fullImage,
    });
    return {
      dx: t.dx,
      dy: t.dy,
      width: t.width,
      height: t.height,
      data: new Uint8ClampedArray(out.buffer),
    };
  });
  return stitchTiles(full, tiles);
}

function renderWhole(req: ElevationRenderRequest): Uint8ClampedArray {
  return new Uint8ClampedArray(runRenderRequest(req).buffer);
}

describe("tiled render equals untiled render", () => {
  it("matches byte for byte on the cliffs view across a seam", () => {
    const req = baseReq({ view: "cliffs" });
    expect(renderTiled(req, 32)).toEqual(renderWhole(req));
  });

  // Cliffs were the suspected seam case. These prove the other renderers really
  // are per-pixel pure functions of world coordinates, with no hidden dependence
  // on the extent of the box they are handed.
  const VIEWS = [
    "elevation",
    "terrain",
    "resources",
    "enemies",
    "cliffs",
    "trees",
    "rocks",
    "all",
  ] as const;

  for (const view of VIEWS) {
    it(`matches byte for byte on the ${view} view`, () => {
      const req = baseReq({ view });
      expect(renderTiled(req, 32)).toEqual(renderWhole(req));
    });
  }

  it("matches on a ragged grid where the tile size does not divide the image", () => {
    const req = baseReq({ view: "all", width: 100, height: 70 });
    expect(renderTiled(req, 32)).toEqual(renderWhole(req));
  });

  it("matches at a tile size of 1 pixel", () => {
    const req = baseReq({ view: "all", width: 8, height: 8 });
    expect(renderTiled(req, 1)).toEqual(renderWhole(req));
  });

  // The only case where the cliff halo is not 2 world tiles, so the one that
  // catches a halo scaled wrongly. It does NOT exercise the floating-point
  // precondition documented in tiling.ts - integer origins times an integer
  // scale stay exact, and nothing in the app produces a fractional scale.
  it("matches when tilesPerPixel is not 1", () => {
    const req = baseReq({ view: "all", width: 32, height: 32, tilesPerPixel: 4 });
    expect(renderTiled(req, 8)).toEqual(renderWhole(req));
  });

  // Vulcanus goes through a separate dispatch branch in runRenderRequest with
  // its own renderers, so the Nauvis cases above prove nothing about it. Cliffs
  // are the one Vulcanus overlay that can seam - it paints a 5x5 mark around a
  // cell center, so a cell just outside a tile still owes that tile pixels, and
  // renderVulcanusCliffs relies on the same cliffCellQueryBox halo to supply
  // them. The window is near spawn where Vulcanus cliffs are dense, so a missing
  // halo shows up rather than landing in empty terrain.
  const VULCANUS_VIEWS = ["terrain", "resources", "cliffs", "rocks", "all"] as const;
  for (const view of VULCANUS_VIEWS) {
    it(`matches byte for byte on Vulcanus, ${view} view`, () => {
      const req = baseReq({
        view,
        planet: "vulcanus",
        originX: -64,
        originY: -64,
        width: 64,
        height: 64,
      });
      expect(renderTiled(req, 32)).toEqual(renderWhole(req));
    });
  }

  // The five cases above all sit on 32-tile boundaries with 32-pixel tiles, so
  // every worker tile is exactly one chunk. That is the easy case for the rock
  // overlay's collision gate, which is resolved a chunk at a time
  // (`makePlacementSet`): a window-scoped greedy would agree with a chunk-scoped
  // one there by coincidence. This case is deliberately ragged - origin -50 and
  // 24-pixel tiles put every seam in the middle of a chunk - so a collision pass
  // that leaked the render window into its answer differs here.
  // The Nauvis cases at the top of this file all sit at origin (320, 64) with
  // 32-pixel tiles, so every worker tile is exactly one 32-tile chunk - the easy
  // case for the rocks overlay's collision gate, which is resolved a chunk at a
  // time (`makePlacementSet`). This origin was found by sweeping every ragged
  // 70x70 window of the [0, 512) region for the one with the most rocks that
  // ALSO has collision rejections: 22 rocks placed and 11 rejected by the
  // collision gate, at an origin 12 tiles into a chunk in x and 9 in y, with
  // 24-pixel tiles so no seam lands on a chunk boundary either. A collision pass
  // that leaked the render window into its answer differs here.
  it("matches on Nauvis with worker tiles that straddle chunk boundaries", () => {
    const req = baseReq({
      view: "all",
      originX: 204,
      originY: 105,
      width: 70,
      height: 70,
    });
    expect(renderTiled(req, 24)).toEqual(renderWhole(req));
  });

  it("matches on Vulcanus with worker tiles that straddle chunk boundaries", () => {
    const req = baseReq({
      view: "all",
      planet: "vulcanus",
      originX: -50,
      originY: -50,
      width: 70,
      height: 70,
    });
    expect(renderTiled(req, 24)).toEqual(renderWhole(req));
  });
});
