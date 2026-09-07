import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vite-plus/test";

import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { compileEngine, instantiateEngine, type EngineExports } from "../src/noise/wasm/engine";
import { foldPixels, frozen } from "./tier3Frozen";

/**
 * The request dispatch for the Vulcanus volcanism control, tested separately
 * from the engine.
 *
 * The engine has read `volcanismFrequency` and `volcanismSize` since phase 5,
 * and `test/wasmVulcanusParity.spec.ts` sweeps both moved. What nothing graded
 * was the line in between: `renderVulcanusThroughWasm` wrote a literal `1` for
 * each, so the Terrain tab's slider was inert on the preview while every
 * render spec stayed green - the same gap the Fulgora islands block in
 * `fulgoraSurfaceSeed.spec.ts` was written for. A lever that silently does
 * nothing is exactly the failure the request layer can hide, and 1 is the one
 * value that hides it: `slider_rescale(1, 3)` is exactly 1, so at the default
 * both terms vanish.
 *
 * **The window must contain the thing it grades.** The first draft of this
 * spec used the `square at origin` window - 64 tiles across at 1 tile per
 * pixel - and stayed red AFTER the slider was wired, because that whole square
 * is inside the starting area, where the volcano spots are excluded and the
 * mountain noise is flattened. Measured 2026-09-07 on the wired code, pixels
 * moved out of the window when a lever is taken off 1:
 *
 * | window (parity spec's)     | frequency 2 | size 3      |
 * | -------------------------- | ----------: | ----------: |
 * | square at origin, 1 px/tile |      0/4096 |      0/4096 |
 * | wide, offset, 1 px/tile    |   1828/2304 |   1813/2304 |
 * | tall, coarse, 8 tiles/px   |   1583/2304 |    698/2304 |
 * | fine, far field, 0.5 t/px  |   1214/1536 |   1300/1536 |
 *
 * So a spec on the origin window passes a hardcoded 1, which is the defect it
 * exists to catch. `WIDE_OFFSET` below is the parity spec's second window,
 * field for field, so the neutral arm can be held to that spec's frozen row.
 */
let engine: EngineExports;
beforeAll(async () => {
  const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");
  engine = await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
});

const SEED0 = surfaceSeedForPlanet("vulcanus", 123456);

const COMMON = {
  id: 1,
  planet: "vulcanus",
  view: "terrain",
  seed0: SEED0,
  waterLevel: 0,
  segmentationMultiplier: 1,
  startingPositions: [{ x: 0, y: 0 }],
} as const satisfies Partial<ElevationRenderRequest>;

/** `wasmVulcanusRenderParity.spec.ts`'s `wide, offset` window, field for field. */
const WIDE_OFFSET: ElevationRenderRequest = {
  ...COMMON,
  width: 96,
  height: 24,
  originX: 512.5,
  originY: -1024.25,
  tilesPerPixel: 1,
};

/** That spec's `square at origin` window - the one the slider cannot reach. */
const SQUARE_AT_ORIGIN: ElevationRenderRequest = {
  ...COMMON,
  width: 64,
  height: 64,
  originX: -32,
  originY: -32,
  tilesPerPixel: 1,
};

const NEUTRAL = { frequency: 1, size: 1 } as const;

function render(req: ElevationRenderRequest): Uint8ClampedArray {
  return new Uint8ClampedArray(runRenderRequest(req, engine).buffer);
}

/** Pixels whose RGB differ between two renders of the same window. */
function pixelsMoved(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  expect(b.length).toBe(a.length);
  let moved = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) moved++;
  }
  return moved;
}

describe("vulcanus volcanism dispatch", () => {
  it("threads control:vulcanus_volcanism:frequency through to the render", () => {
    const neutral = render({ ...WIDE_OFFSET, vulcanusVolcanismControls: NEUTRAL });
    const moved = render({ ...WIDE_OFFSET, vulcanusVolcanismControls: { frequency: 2, size: 1 } });
    // Most of the window, not a sliver: 1828 of 2304 measured. The bound is
    // loose on purpose - the claim is that the lever reaches the render, not
    // any particular count.
    expect(pixelsMoved(neutral, moved)).toBeGreaterThan(1000);
  });

  it("threads control:vulcanus_volcanism:size through to the render", () => {
    const neutral = render({ ...WIDE_OFFSET, vulcanusVolcanismControls: NEUTRAL });
    const moved = render({ ...WIDE_OFFSET, vulcanusVolcanismControls: { frequency: 1, size: 3 } });
    // 1813 of 2304 measured.
    expect(pixelsMoved(neutral, moved)).toBeGreaterThan(1000);
  });

  it("omitting the control equals passing the neutral pair", () => {
    // So the default really is the game's neutral position, not "unset".
    const omitted = render(WIDE_OFFSET);
    const neutral = render({ ...WIDE_OFFSET, vulcanusVolcanismControls: NEUTRAL });
    expect(pixelsMoved(omitted, neutral)).toBe(0);
  });

  it("the neutral pair renders the bytes frozen before the control was wired", () => {
    // The tier-3 row was recorded while the request layer wrote a literal 1
    // for both levers. Wiring the slider must not move a default render; if
    // this row moves, the default is no longer the game's neutral position.
    const want = frozen("vulcanus:render", "wide, offset", "terrain");
    expect(want).toBeDefined();
    const neutral = render({ ...WIDE_OFFSET, vulcanusVolcanismControls: NEUTRAL });
    expect(foldPixels(neutral)).toBe(want);
  });

  it("the cliffs view moves with the slider too", () => {
    // Volcanism moves the elevation contours the cliff bands sit on - the
    // lever #84 wants for separating an elevation-side residual from a
    // placement-side one - so the cliffs view has to see it as well as terrain.
    const neutral = render({ ...WIDE_OFFSET, view: "cliffs" });
    const moved = render({
      ...WIDE_OFFSET,
      view: "cliffs",
      vulcanusVolcanismControls: { frequency: 2, size: 3 },
    });
    expect(pixelsMoved(neutral, moved)).toBeGreaterThan(1000);
  });

  it("the square at the origin cannot see the slider - the control for the window choice", () => {
    // Deliberately frozen at ZERO. This is the window the first draft graded
    // on, and the reason the wired code still read as unwired. If it ever
    // moves, volcanism has started reaching the starting area, which is a
    // finding about the engine rather than about this spec.
    const neutral = render(SQUARE_AT_ORIGIN);
    for (const c of [
      { frequency: 2, size: 1 },
      { frequency: 1, size: 3 },
    ]) {
      const moved = render({ ...SQUARE_AT_ORIGIN, vulcanusVolcanismControls: c });
      expect(pixelsMoved(neutral, moved), JSON.stringify(c)).toBe(0);
    }
  });
});
