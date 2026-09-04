import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, it, expect } from "vite-plus/test";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { planTiles, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";
import { compileEngine, instantiateEngine, type EngineExports } from "../src/noise/wasm/engine";

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

/**
 * The engine every render below goes through.
 *
 * **This spec used to pass none at all**, which meant it graded the TypeScript
 * renderers and could not see the WASM gate: a tiling bug that existed only on
 * the engine path was invisible here. #227 deleted those renderers, so the
 * engine is now the only thing to render with - and the gate this spec could
 * never reach is the one it now tests. One instance for the file: renders are
 * sequential and synchronous, which is exactly how the worker drives it.
 */
let engine: EngineExports;

beforeAll(async () => {
  const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
  engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
});

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
    const out = runRenderRequest(
      {
        ...req,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
        fullImage,
      },
      engine,
    );
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
  return new Uint8ClampedArray(runRenderRequest(req, engine).buffer);
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

  // Enemy bases are the only Nauvis overlay that paints a mark WIDER than one
  // pixel from a swept position (3x3, `PLACEMENT_MARK_RADIUS_PX`), so they are
  // the only one that needs `placementMarkSweepBox`'s halo: a placement one pixel outside
  // a worker tile still owes that tile the edge of its mark. The `enemies` case
  // in the VIEWS loop above cannot catch a missing halo - it sits at (320, 64)
  // near spawn, where the starting-area exclusion leaves ZERO placements in the
  // window, so it passes on empty pixels.
  //
  // This window was chosen by collecting every placement in [512, 1536)^2 (311 of
  // them) and sweeping ragged 70x70 windows on a 7-tile grid for the one with the
  // most placements that ALSO has placements within 1 pixel of an interior seam
  // at 24-pixel tiles: origin (974, 1331), 50 placements, 9 of them seam-adjacent.
  // Drop the halo and this case fails.
  it("matches on Nauvis where enemy-base marks straddle worker-tile seams", () => {
    const req = baseReq({
      view: "all",
      originX: 974,
      originY: 1331,
      width: 70,
      height: 70,
    });
    expect(renderTiled(req, 24)).toEqual(renderWhole(req));
  });

  // ...and the same thing again at tilesPerPixel != 1, which is what pins the
  // halo's `* tpp` SCALING rather than merely its existence. The `tilesPerPixel is
  // not 1` case above has zero enemy placements anywhere in its box, so it cannot
  // tell a halo of `r` world tiles from one of `r * tpp`; only cliffs constrain it
  // there. Found the same way as the case above - sweeping 50x50-pixel windows at
  // 2 tiles/px on a 3-tile grid over the same dense neighbourhood, scoring
  // placements that the pixel grid actually SAMPLES (at tpp 2 only every other
  // tile is looked at) and requiring some within 1 pixel of a 16-pixel tile seam:
  // origin (975, 1287), 24 sampled placements, 7 seam-adjacent. ~0.7s of renders.
  it("matches on Nauvis enemy marks at tilesPerPixel > 1", () => {
    const req = baseReq({
      view: "all",
      originX: 975,
      originY: 1287,
      width: 50,
      height: 50,
      tilesPerPixel: 2,
    });
    expect(renderTiled(req, 16)).toEqual(renderWhole(req));
  });

  // The five Vulcanus cases above all sit on 32-tile boundaries with 32-pixel
  // tiles, so every worker tile is exactly one chunk. That is the easy case for
  // the rock overlay's collision gate, which is resolved a chunk at a time
  // (`makePlacementSet`): a window-scoped greedy would agree with a chunk-scoped
  // one there by coincidence. This case is deliberately ragged - origin -50 and
  // 24-pixel tiles put every seam in the middle of a chunk - so a collision pass
  // that leaked the render window into its answer differs here.
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

  // The sulfuric-acid geyser is the Vulcanus counterpart of the enemy-base case
  // above: it rolls per tile and paints a 3x3 mark, so it needs the same
  // `placementMarkSweepBox` halo, and NONE of the six Vulcanus cases above can
  // catch a missing one - all of them sit in windows with ZERO geyser
  // placements (measured: the (-64,-64) 64x64 window and the (-50,-50) 70x70
  // ragged window both have 0), so they would pass on empty pixels.
  //
  // Chosen by the gate's own assertion, the same way the Nauvis enemy case was:
  // every geyser placement in [-400, 400)^2 was collected (81 of them) and
  // ragged 70x70 windows swept on a 7-tile grid for the one with the most
  // placements that ALSO has placements within 1 pixel of an interior seam at
  // 24-pixel tiles - origin (-267, 146), 30 placements, 6 seam-adjacent. That
  // origin is also 21 tiles into a chunk in x and 18 in y, so it exercises the
  // chunk-scoped collision purity too. `view: "resources"` rather than "all" so
  // a failure here is unambiguously the geyser rather than cliffs or rocks.
  // Drop the halo and this case fails.
  it("matches on Vulcanus where geyser marks straddle worker-tile seams", () => {
    const req = baseReq({
      view: "resources",
      planet: "vulcanus",
      originX: -267,
      originY: 146,
      width: 70,
      height: 70,
    });
    expect(renderTiled(req, 24)).toEqual(renderWhole(req));
  });

  // Crude oil is the third 3x3-mark overlay and needs the same halo, and it is
  // the hardest of the three to catch: the game places single digits of wells per
  // 512x512 region, so almost any window has zero and would pass on empty pixels.
  // The Nauvis `resources` case in the VIEWS loop is exactly that - it sits near
  // spawn where the fade-in radius leaves no regular patches at all.
  //
  // Chosen the same way as the other two: every oil placement in [-1200, 1200)^2
  // was collected (102 of them - oil clusters inside its patches, so they are far
  // from uniform) and ragged 70x70 windows swept on a 7-tile grid for the one
  // with the most placements within 1 pixel of an interior seam at 24-pixel
  // tiles. Origin (1055, 1121): 12 placements, 7 seam-adjacent. The origin is 31
  // tiles into a chunk in x and 1 in y, so it exercises chunk-scoped collision
  // purity as well. `view: "resources"` so a failure is unambiguously oil rather
  // than rocks or enemies. Drop the halo and this case fails.
  it("matches on Nauvis where crude-oil marks straddle worker-tile seams", () => {
    const req = baseReq({
      view: "resources",
      originX: 1055,
      originY: 1121,
      width: 70,
      height: 70,
    });
    expect(renderTiled(req, 24)).toEqual(renderWhole(req));
  });

  // Fulgora goes through its own dispatch branch too, and scrap is the one
  // overlay it has. Unlike the Vulcanus/Nauvis 3x3-mark overlays above, scrap
  // paints a single pixel per roll, so it cannot straddle a worker-tile seam
  // and needs no `sweepBox` halo - this is the case that proves that, rather
  // than assuming it.
  //
  // Origin (-256, 872), 64x64: `test/fulgoraScrapDensity.spec.ts`'s own dense
  // regions sit near (0,0)-(256,256) and (-1200,800)-(-944,1056), and this
  // window was checked directly against `makeFulgoraScrapPlacement` before
  // use - it holds 205 rolled placements in the 4096-pixel box, not the
  // suppressed empty chunk at (0,128)-(32,160) that
  // `fulgoraScrapDensity.spec.ts` documents. The `resources` case below
  // re-checks this at the pixel level: its output must differ from the
  // `terrain` render of the same window, or the tiled-equality assertion
  // would be comparing two identical, scrap-free images and proving nothing.
  const FULGORA_VIEWS = ["terrain", "resources", "all"] as const;
  for (const view of FULGORA_VIEWS) {
    it(`matches byte for byte on Fulgora, ${view} view`, () => {
      const req = baseReq({
        view,
        planet: "fulgora",
        originX: -256,
        originY: 872,
        width: 64,
        height: 64,
      });
      expect(renderTiled(req, 32)).toEqual(renderWhole(req));
    });
  }

  it("the Fulgora resources window is not vacuous: scrap actually changes pixels", () => {
    const terrainReq = baseReq({
      view: "terrain",
      planet: "fulgora",
      originX: -256,
      originY: 872,
      width: 64,
      height: 64,
    });
    const resourcesReq = { ...terrainReq, view: "resources" as const };
    expect(renderWhole(resourcesReq)).not.toEqual(renderWhole(terrainReq));
  });
});
