import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import { renderFulgoraTerrain } from "../src/noise/preview/renderFulgoraTerrain";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { compileEngine, instantiateEngine } from "../src/noise/wasm/engine";

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
function hash(img: ImageData): number {
  let h = 2166136261;
  for (let i = 0; i < img.data.length; i++) h = Math.imul(h ^ (img.data[i] as number), 16777619);
  return h >>> 0;
}

describe("fulgora surface seed", () => {
  it("renders at mapSeed + crc32('fulgora'), not the raw map seed", () => {
    const mapSeed = 123456;
    const derived = surfaceSeedForPlanet("fulgora", mapSeed);
    expect(derived).not.toBe(mapSeed);

    const opts = { width: 48, height: 48, tilesPerPixel: 8 };
    const atDerived = renderFulgoraTerrain({ ...opts, seed0: derived });
    const atRaw = renderFulgoraTerrain({ ...opts, seed0: mapSeed });
    expect(hash(atDerived)).not.toBe(hash(atRaw));
  });

  it("the discriminating window is not a solid colour", () => {
    // A 48x48 window that came back all-ocean would make the test above pass on
    // two identical solid images only by luck of the hash - and would stop
    // discriminating the moment the palette changed. Require real structure.
    const img = renderFulgoraTerrain({
      width: 48,
      height: 48,
      tilesPerPixel: 8,
      seed0: surfaceSeedForPlanet("fulgora", 123456),
    });
    const distinct = new Set<number>();
    for (let i = 0; i < img.data.length; i += 4) {
      distinct.add(
        ((img.data[i] as number) << 16) |
          ((img.data[i + 1] as number) << 8) |
          (img.data[i + 2] as number),
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
 * because they all call `renderFulgoraTerrain` directly and every default is
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

  it("planet 'fulgora' + view 'terrain' matches a direct renderFulgoraTerrain call", () => {
    const req: ElevationRenderRequest = { ...BASE, planet: "fulgora" };
    const direct = renderFulgoraTerrain({
      seed0: req.seed0,
      width: req.width,
      height: req.height,
      originX: req.originX,
      originY: req.originY,
      tilesPerPixel: req.tilesPerPixel,
    });
    const got = new Uint8ClampedArray(runRenderRequest(req).buffer);
    expect(Array.from(got)).toEqual(Array.from(direct.data));
  });

  it("planet 'fulgora' differs from the Nauvis terrain render at the same point", async () => {
    // Nauvis needs the engine as of #227 and Fulgora does not, which is #363
    // rather than an asymmetry this test cares about. The claim is only that
    // the two planets draw different pictures at the same point.
    const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
    const e = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
    const nauvis = new Uint8ClampedArray(runRenderRequest({ ...BASE, planet: "nauvis" }, e).buffer);
    const fulgora = new Uint8ClampedArray(runRenderRequest({ ...BASE, planet: "fulgora" }).buffer);
    expect(Array.from(fulgora)).not.toEqual(Array.from(nauvis));
  });

  it("threads control:fulgora_islands:frequency through to the render", () => {
    // The lever the plant proved was untested. Frequency 1 is the ONE value
    // that cannot show it - the grid is exactly 175 there and its truncation to
    // a u16 is a no-op - so this moves the slider off its default.
    const neutral = new Uint8ClampedArray(
      runRenderRequest({
        ...BASE,
        planet: "fulgora",
        fulgoraIslandControls: { frequency: 1, size: 1 },
      }).buffer,
    );
    const moved = new Uint8ClampedArray(
      runRenderRequest({
        ...BASE,
        planet: "fulgora",
        fulgoraIslandControls: { frequency: 3, size: 1 },
      }).buffer,
    );
    expect(Array.from(moved)).not.toEqual(Array.from(neutral));
  });

  it("threads control:fulgora_islands:size through to the render", () => {
    // Likewise: size 1 makes `slider_rescale(size, 2)` exactly 1, so
    // `fulgora_natural`'s whole scaling term vanishes at the default.
    const neutral = new Uint8ClampedArray(
      runRenderRequest({
        ...BASE,
        planet: "fulgora",
        fulgoraIslandControls: { frequency: 1, size: 1 },
      }).buffer,
    );
    const moved = new Uint8ClampedArray(
      runRenderRequest({
        ...BASE,
        planet: "fulgora",
        fulgoraIslandControls: { frequency: 1, size: 3 },
      }).buffer,
    );
    expect(Array.from(moved)).not.toEqual(Array.from(neutral));
  });

  it("omitting the islands controls equals passing the neutral pair", () => {
    // So the default really is the game's neutral position, not "unset".
    const omitted = new Uint8ClampedArray(runRenderRequest({ ...BASE, planet: "fulgora" }).buffer);
    const neutral = new Uint8ClampedArray(
      runRenderRequest({
        ...BASE,
        planet: "fulgora",
        fulgoraIslandControls: { frequency: 1, size: 1 },
      }).buffer,
    );
    expect(Array.from(omitted)).toEqual(Array.from(neutral));
  });

  it("an overlay view Fulgora has no port for still renders Fulgora terrain", () => {
    // Never a Nauvis field composited onto Fulgora colours - the same fallback
    // the Vulcanus branch applies to the overlays it lacks.
    const terrain = new Uint8ClampedArray(
      runRenderRequest({ ...BASE, planet: "fulgora", view: "terrain" }).buffer,
    );
    for (const view of ["resources", "enemies", "cliffs", "trees", "rocks", "all"] as const) {
      const got = new Uint8ClampedArray(
        runRenderRequest({ ...BASE, planet: "fulgora", view }).buffer,
      );
      expect(Array.from(got), `view ${view}`).toEqual(Array.from(terrain));
    }
  });
});
