import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import { planTiles, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";
import { compileEngine, instantiateEngine, type EngineExports } from "../src/noise/wasm/engine";

// Tiled equality at the app's OWN geometry (#566): the 1024 x 1024 preview at
// one tile per pixel, centred on the spawn, cut into the worker tiles the app
// really uses. `tiledEquality.spec.ts` grades small windows with 24 and 32 px
// tiles, which is cheap and finds most seam bugs, but no case there rendered
// 1024 at 128 or 256 px tiles, so the switch to 256 had nothing to stand on.
//
// The two seeds are the ones that failed before the fix. The Nauvis rock
// pass's pre-roll water test read the painted buffer at `py * width + px`,
// which for a rock one pixel outside the tile wraps to the far edge of the
// same tile. At 256 px tiles seeds 123456 and 7 each lost one 3 px rock column
// at a seam; at 128 px they happened to match. Both sizes are graded, because
// a seam bug that one tile width hides is still a bug.
//
// `rocks` rather than `all`, because rocks are the overlay that broke and the
// `all` composite costs about twice as much for no more seam coverage here.

const PREVIEW_PX = 1024;
const SEEDS = [123456, 7] as const;
const TILE_SIZES = [128, 256] as const;

let engine: EngineExports;

beforeAll(async () => {
  const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
  engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
});

function appReq(seed0: number): ElevationRenderRequest {
  return {
    id: 0,
    seed0,
    width: PREVIEW_PX,
    height: PREVIEW_PX,
    originX: -PREVIEW_PX / 2,
    originY: -PREVIEW_PX / 2,
    tilesPerPixel: 1,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    mapType: "nauvis",
    view: "rocks",
  };
}

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

/**
 * The pixels that differ, as `(x, y)`, so a failure names WHERE rather than
 * dumping two 4 MiB arrays. An empty list is the pass.
 */
function differingPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      const p = i / 4;
      out.push(`(${p % PREVIEW_PX}, ${Math.floor(p / PREVIEW_PX)})`);
    }
  }
  return out;
}

describe("tiled render equals untiled render at the app's 1024 geometry, Gleba", () => {
  // Gleba's `all` view places stone and stromatolites with the game's
  // per-chunk generator and the apply step's collision (#454, slice 3). Each
  // worker tile generates its own chunks plus a one-chunk ring, so a seam that
  // dropped or doubled an entity would show here. The seed is the derived
  // Gleba surface seed for map seed 123456.
  it("Gleba all, at 128 and 256 px worker tiles", () => {
    const req: ElevationRenderRequest = {
      ...appReq(surfaceSeedForPlanet("gleba", 123456)),
      planet: "gleba",
      view: "all",
    };
    const whole = new Uint8ClampedArray(runRenderRequest(req, engine).buffer);
    const terrain = new Uint8ClampedArray(
      runRenderRequest({ ...req, view: "terrain" }, engine).buffer,
    );
    // Not vacuous: thousands of entity pixels, so a seam has some to lose.
    expect(differingPixels(whole, terrain).length).toBeGreaterThan(10000);
    for (const size of TILE_SIZES) {
      expect(differingPixels(renderTiled(req, size), whole), `${size} px tiles`).toEqual([]);
    }
  }, 600_000);
});

describe("tiled render equals untiled render at the app's 1024 geometry (#566)", () => {
  for (const seed0 of SEEDS) {
    it(`Nauvis rocks, seed ${seed0}, at 128 and 256 px worker tiles`, () => {
      const req = appReq(seed0);
      const whole = new Uint8ClampedArray(runRenderRequest(req, engine).buffer);
      // Not vacuous: the window must hold rock marks for a seam to lose one.
      const terrain = new Uint8ClampedArray(
        runRenderRequest({ ...req, view: "terrain" }, engine).buffer,
      );
      expect(differingPixels(whole, terrain).length).toBeGreaterThan(0);
      for (const size of TILE_SIZES) {
        expect(differingPixels(renderTiled(req, size), whole), `${size} px tiles`).toEqual([]);
      }
    }, 300_000);
  }
});
