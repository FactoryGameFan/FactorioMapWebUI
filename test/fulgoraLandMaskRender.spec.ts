import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { landMaskFromImage } from "../src/noise/islands/islandMask";
import { surveyIslands } from "../src/noise/islands/cellSurvey";
import { runRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import {
  compileEngine,
  instantiateEngine,
  renderThroughWasm,
  type EngineExports,
} from "../src/noise/wasm/engine";

const SEED0 = 2967702466;

/** The engine, compiled once for the file. Fulgora renders through nothing else since #371. */
let engine: EngineExports;
beforeAll(async () => {
  const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
  engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
});

/**
 * Real island-centred windows, in `findIslands`'s own geometry: a 256x256-tile
 * box around a candidate centroid, origin snapped down to `tpp`. Taken from
 * `surveyIslands` rather than hardcoded so these stay windows the finder would
 * really ask for, not coordinates that happened to work once.
 */
function windows(tpp: number, count: number) {
  const found = surveyIslands({ seed0: SEED0 }, { x0: -600, y0: -600, x1: 600, y1: 600 }, engine);
  return found.slice(0, count).map((c) => ({
    width: 256 / tpp,
    height: 256 / tpp,
    originX: Math.floor((c.centroidX - 128) / tpp) * tpp,
    originY: Math.floor((c.centroidY - 128) / tpp) * tpp,
    tilesPerPixel: tpp,
    seed0: SEED0,
    islandsFrequency: 1,
    islandsSize: 1,
  }));
}

describe("Fulgora land-mask render", () => {
  // The finder used to render a full terrain image and then throw away which
  // of the eight land tiles each pixel is, collapsing it to one bit against
  // FULGORA_OCEAN_RGB. The land-mask view is the cheap path that never computes
  // the eight in the first place. It is only correct if the bit is IDENTICAL -
  // a faster render that disagreed anywhere would silently change every
  // reported rectangle, area and ranking. Both views come from the module now
  // (#371), so this grades the module's two arms against each other.
  it("produces a byte-identical land mask to the full terrain render", () => {
    for (const tpp of [8, 2]) {
      for (const w of windows(tpp, 3)) {
        const terrain = renderThroughWasm(engine, { view: "terrain", ...w }).slice();
        const viaTerrain = landMaskFromImage(terrain, w.width, w.height);
        const mask = renderThroughWasm(engine, { view: "landmask", ...w });
        const direct = landMaskFromImage(mask, w.width, w.height);

        // Not vacuous: a window that were all ocean (or all land) would make
        // any two masks agree. Both classes must be present for the comparison
        // to have discriminated anything.
        const land = viaTerrain.reduce((n, v) => n + v, 0);
        expect(land, `tpp=${tpp} window at ${w.originX},${w.originY} has no land`).toBeGreaterThan(
          0,
        );
        expect(land, `tpp=${tpp} window at ${w.originX},${w.originY} is all land`).toBeLessThan(
          viaTerrain.length,
        );

        expect(direct).toEqual(viaTerrain);
      }
    }
  }, 300000);

  // The finder reaches the renderer through `execute` -> `runRenderRequest`,
  // which dispatches on `req.view`, so the cheap path is only reachable if the
  // request can name it. Asserted through that entry point rather than the
  // render function directly, because that is the seam the Worker uses.
  it("is reachable as view 'landmask' through runRenderRequest", () => {
    const w = windows(8, 1)[0]!;
    const base = {
      id: 0,
      planet: "fulgora" as const,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      ...w,
    };

    const terrain = runRenderRequest({ ...base, view: "terrain" }, engine);
    const landmask = runRenderRequest({ ...base, view: "landmask" }, engine);

    const a = landMaskFromImage(new Uint8ClampedArray(terrain.buffer), w.width, w.height);
    const b = landMaskFromImage(new Uint8ClampedArray(landmask.buffer), w.width, w.height);

    const land = a.reduce((n, v) => n + v, 0);
    expect(land).toBeGreaterThan(0);
    expect(land).toBeLessThan(a.length);
    expect(b).toEqual(a);
  }, 300000);
});
