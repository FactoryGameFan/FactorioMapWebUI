import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vite-plus/test";

import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import {
  compileEngine,
  instantiateEngine,
  renderThroughWasm,
  type EngineExports,
} from "../src/noise/wasm/engine";

/**
 * The one Fulgora defect no oracle fixture can catch.
 *
 * Every Fulgora fixture in this repo is captured through a harness that sets
 * `mgs.seed` on the created surface EXPLICITLY, so inside those runs
 * `map_seed` simply IS the map seed and the derivation is bypassed. A renderer
 * that passed the raw map seed straight through would agree with every one of
 * them and still draw the wrong planet for a real user.
 *
 * That is not hypothetical - it is exactly the Vulcanus surface-seed bug, which
 * passed every internal check for weeks because the fixture and the code agreed
 * with each other while both disagreed with the game.
 */
function hash(px: Uint8ClampedArray): number {
  let h = 2166136261;
  for (let i = 0; i < px.length; i++) h = Math.imul(h ^ (px[i] as number), 16777619);
  return h >>> 0;
}

/** The engine, compiled once for the file. Fulgora renders through nothing else since #371. */
let engine: EngineExports;
beforeAll(async () => {
  const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
  engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
});

/** A 48x48 terrain window at 8 tiles/px, as a copy rather than a view over module memory. */
function terrain(seed0: number): Uint8ClampedArray {
  return renderThroughWasm(engine, {
    view: "terrain",
    seed0,
    width: 48,
    height: 48,
    originX: 0,
    originY: 0,
    tilesPerPixel: 8,
    islandsFrequency: 1,
    islandsSize: 1,
  }).slice();
}

describe("fulgora surface seed", () => {
  it("renders at mapSeed + crc32('fulgora'), not the raw map seed", () => {
    const mapSeed = 123456;
    const derived = surfaceSeedForPlanet("fulgora", mapSeed);
    expect(derived).not.toBe(mapSeed);
    expect(hash(terrain(derived))).not.toBe(hash(terrain(mapSeed)));
  });

  it("the discriminating window is not a solid colour", () => {
    // A 48x48 window that came back all-ocean would make the test above pass on
    // two identical solid images only by luck of the hash - and would stop
    // discriminating the moment the palette changed. Require real structure.
    const px = terrain(surfaceSeedForPlanet("fulgora", 123456));
    const distinct = new Set<number>();
    for (let i = 0; i < px.length; i += 4) {
      distinct.add(
        ((px[i] as number) << 16) | ((px[i + 1] as number) << 8) | (px[i + 2] as number),
      );
    }
    expect(distinct.size).toBeGreaterThan(1);
  });
});

/**
 * The request dispatch, tested separately from the renderer.
 *
 * This block exists because a planted defect exposed the gap: replacing
 * `req.fulgoraIslandControls` with hardcoded neutral values in
 * `elevationRenderRequest.ts` broke NOTHING - every render test still passed,
 * because they all reached the renderer directly and every default is
 * neutral. A lever that silently does nothing is exactly the failure the
 * request layer can hide.
 */
describe("fulgora render request dispatch", () => {
  const BASE: ElevationRenderRequest = {
    id: 1,
    seed0: surfaceSeedForPlanet("fulgora", 123456),
    width: 24,
    height: 24,
    originX: -96,
    originY: -96,
    tilesPerPixel: 4,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    view: "terrain",
  };

  function render(req: ElevationRenderRequest): number[] {
    return Array.from(new Uint8ClampedArray(runRenderRequest(req, engine).buffer));
  }

  it("planet 'fulgora' + view 'terrain' matches a direct renderThroughWasm call", () => {
    const req: ElevationRenderRequest = { ...BASE, planet: "fulgora" };
    const direct = renderThroughWasm(engine, {
      view: "terrain",
      seed0: req.seed0,
      width: req.width,
      height: req.height,
      originX: req.originX,
      originY: req.originY,
      tilesPerPixel: req.tilesPerPixel,
      islandsFrequency: 1,
      islandsSize: 1,
    }).slice();
    expect(render(req)).toEqual(Array.from(direct));
  });

  it("planet 'fulgora' differs from the Nauvis terrain render at the same point", () => {
    // The claim is only that the two planets draw different pictures at the
    // same point - a dispatcher that ignored `planet` would draw one of them
    // twice.
    expect(render({ ...BASE, planet: "fulgora" })).not.toEqual(
      render({ ...BASE, planet: "nauvis" }),
    );
  });

  it("threads control:fulgora_islands:frequency through to the render", () => {
    // The lever the plant proved was untested. Frequency 1 is the ONE value
    // that cannot show it - the grid is exactly 175 there and its truncation to
    // a u16 is a no-op - so this moves the slider off its default.
    const neutral = render({
      ...BASE,
      planet: "fulgora",
      fulgoraIslandControls: { frequency: 1, size: 1 },
    });
    const moved = render({
      ...BASE,
      planet: "fulgora",
      fulgoraIslandControls: { frequency: 3, size: 1 },
    });
    expect(moved).not.toEqual(neutral);
  });

  it("threads control:fulgora_islands:size through to the render", () => {
    // Likewise: size 1 makes `slider_rescale(size, 2)` exactly 1, so
    // `fulgora_natural`'s whole scaling term vanishes at the default.
    const neutral = render({
      ...BASE,
      planet: "fulgora",
      fulgoraIslandControls: { frequency: 1, size: 1 },
    });
    const moved = render({
      ...BASE,
      planet: "fulgora",
      fulgoraIslandControls: { frequency: 1, size: 3 },
    });
    expect(moved).not.toEqual(neutral);
  });

  it("omitting the islands controls equals passing the neutral pair", () => {
    // So the default really is the game's neutral position, not "unset".
    const omitted = render({ ...BASE, planet: "fulgora" });
    const neutral = render({
      ...BASE,
      planet: "fulgora",
      fulgoraIslandControls: { frequency: 1, size: 1 },
    });
    expect(omitted).toEqual(neutral);
  });

  it("an overlay view Fulgora has no port for still renders Fulgora terrain", () => {
    // Never a Nauvis field composited onto Fulgora colours - the same fallback
    // the Vulcanus branch applies to the overlays it lacks. `servedView`
    // normalises these four onto `"terrain"` BEFORE the engine is asked, since
    // the module refuses them by status. `resources` and `all` are not in this
    // list any more: Fulgora has a scrap overlay as of #363, so they are a
    // different picture from terrain wherever there is scrap.
    const terrain = render({ ...BASE, planet: "fulgora", view: "terrain" });
    for (const view of ["enemies", "cliffs", "trees", "rocks"] as const) {
      expect(render({ ...BASE, planet: "fulgora", view }), `view ${view}`).toEqual(terrain);
    }
  });
});
