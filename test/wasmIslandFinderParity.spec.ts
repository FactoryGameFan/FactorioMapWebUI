import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { findIslands } from "../src/noise/islands/findIslands";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { compileEngine, instantiateEngine } from "../src/noise/wasm/engine";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";

/**
 * **The integration check #223 asks for: the island finder, run against the
 * Rust engine, agrees with the TypeScript one exactly.**
 *
 * `test/wasmLandmaskParity.spec.ts` already proves the two renderers produce
 * byte-identical RGBA over four windows. This is a different question and a
 * stronger one, because the finder is not a unit test: it renders candidate
 * windows, re-renders any whose island mask touches the border at a doubled
 * pad, flood-fills, chains components, and ranks the result. Every one of those
 * steps reads pixels, and a single wrong pixel at a border can change whether a
 * window is re-rendered - which changes the ranking, not just a number.
 *
 * So this asserts the whole ranked output is identical, field by field, not
 * that the images match.
 *
 * `refineCount` is small on purpose. The finder's own spec measures 240.4s at
 * the full count and cuts four of its tests the same way for identical
 * coverage; the question here is agreement between two renderers, and that does
 * not need the expensive refinement pass to be exercised at its production
 * depth.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
const SEED0 = surfaceSeedForPlanet("fulgora", 123456);
const RADIUS = 600;
const REFINE = 1;

describe("the island finder agrees between the two engines", () => {
  it("returns an identical ranked list, and really does use the WASM path", async () => {
    const engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));

    let wasmRenders = 0;
    const viaWasm = (req: ElevationRenderRequest): Promise<ReturnType<typeof runRenderRequest>> => {
      wasmRenders++;
      return Promise.resolve(runRenderRequest(req, engine));
    };
    let tsRenders = 0;
    const viaTypescript = (
      req: ElevationRenderRequest,
    ): Promise<ReturnType<typeof runRenderRequest>> => {
      tsRenders++;
      return Promise.resolve(runRenderRequest(req));
    };

    const options = {
      ctx: { seed0: SEED0 },
      radius: RADIUS,
      concurrency: 4,
      refineCount: REFINE,
    };
    const fromWasm = await findIslands({ ...options, execute: viaWasm });
    const fromTypescript = await findIslands({ ...options, execute: viaTypescript });

    // Non-vacuity, in both directions. A finder that rendered nothing would
    // return an empty list from both arms and "agree".
    expect(wasmRenders).toBeGreaterThan(0);
    expect(tsRenders).toBe(wasmRenders);
    expect(fromWasm.length).toBeGreaterThan(0);

    // The ranked output, field by field. `toEqual` on the arrays would compare
    // the same thing, but naming the fields makes a failure say WHICH one moved
    // rather than printing two large structures.
    expect(fromWasm.length).toBe(fromTypescript.length);
    for (const [i, w] of fromWasm.entries()) {
      const t = fromTypescript[i];
      expect(w.landTiles, `rank ${String(i)} landTiles`).toBe(t?.landTiles);
      expect(w.fullChunks, `rank ${String(i)} fullChunks`).toBe(t?.fullChunks);
      expect(w.rect, `rank ${String(i)} rect`).toEqual(t?.rect);
    }
    expect(fromWasm).toEqual(fromTypescript);
  }, 300000);

  it("the engine really is being used - the same request differs when it is withheld", async () => {
    // The guard that stops the test above passing on an engine that is silently
    // ignored. It cannot compare OUTPUT, because the two paths are
    // byte-identical by design; it compares whether the WASM path ran at all,
    // by asking the module for a render the TypeScript path never touches.
    const engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
    const req: ElevationRenderRequest = {
      id: 1,
      seed0: SEED0,
      width: 16,
      height: 16,
      originX: -64,
      originY: -64,
      tilesPerPixel: 4,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      planet: "fulgora",
      view: "landmask",
    };

    const before = new Uint8Array(engine.memory.buffer, engine.render_ptr(), 64).slice();
    runRenderRequest(req); // TypeScript path: must not touch the module at all
    const afterTs = new Uint8Array(engine.memory.buffer, engine.render_ptr(), 64).slice();
    expect(Array.from(afterTs)).toEqual(Array.from(before));

    runRenderRequest(req, engine); // WASM path: must fill the module's buffer
    const afterWasm = new Uint8Array(engine.memory.buffer, engine.render_ptr(), 64).slice();
    expect(Array.from(afterWasm)).not.toEqual(Array.from(before));
  }, 120000);

  it("a non-landmask Fulgora view still takes the TypeScript path", async () => {
    // The engine renders exactly one view. A request for another must fall
    // through rather than error or return a land mask painted as terrain.
    const engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
    const req: ElevationRenderRequest = {
      id: 2,
      seed0: SEED0,
      width: 8,
      height: 8,
      originX: 0,
      originY: 0,
      tilesPerPixel: 8,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      planet: "fulgora",
      view: "terrain",
    };
    const withEngine = new Uint8ClampedArray(runRenderRequest(req, engine).buffer);
    const without = new Uint8ClampedArray(runRenderRequest(req).buffer);
    expect(Array.from(withEngine)).toEqual(Array.from(without));
  }, 120000);
});
