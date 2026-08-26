import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng } from "./oracle/decodePng";
import { compileEngine, instantiateEngine } from "../src/noise/wasm/engine";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";

/**
 * Tier 3 for Nauvis (#226): the Rust engine's terrain render against the
 * TypeScript one, and both against the game's own preview PNG.
 *
 * Same two arms as the Fulgora and Vulcanus specs, answering different
 * questions:
 *
 * - **WASM against TypeScript** must be BYTE-IDENTICAL. That is what makes the
 *   engine a speed choice rather than a behaviour switch, and it is why
 *   `runRenderRequest` can dispatch to whichever path is available with no
 *   window in which the answer is wrong.
 * - **WASM against the game's PNG** says how far both ports sit from the game.
 *   Because the first arm holds, that count is asserted EXACTLY rather than
 *   under a bound.
 *
 * **Nauvis's `seed0` IS the map seed**, unlike Fulgora's and Vulcanus's. Those
 * two derive a surface seed as `mapSeed + crc32(name)` and getting it wrong is
 * the failure that looks like a broken port; here there is nothing to derive,
 * which is one hazard this planet does not have.
 */
const FIXTURES = join(import.meta.dirname, "fixtures");
const SIZE = 1024;
const SEED = 123456;

/**
 * The game draws enemy bases in its capture and our terrain view does not.
 *
 * `enemy-base` is the ONE control the game reports as `can_be_disabled: false`
 * (`autoplace-can-be-disabled.dump.json`), so those pixels are in the reference
 * whatever we ask for. They are excluded rather than tolerated, and counted, so
 * the exclusion cannot quietly grow.
 */
const ENEMY_RGB = [255, 25, 25] as const;

/**
 * Measured on the TypeScript path: 1,189 enemy pixels, and 8 of the remaining
 * 1,047,387 differ - 99.9992%.
 *
 * **`previewAgreement.spec.ts` says 10 in a comment, and that has drifted.** It
 * asserts `toBeLessThan(200)`, so the number in its prose was never checked by
 * anything and the port has moved since it was written - the same way four rows
 * of `test/captureGrid.ts`'s table had. This spec freezes it exactly instead.
 *
 * **These are the TypeScript renderer's own numbers and they have to be**,
 * because the first describe block asserts the two renders are byte-identical.
 * `previewAgreement.spec.ts` reaches the same figures through a separate run.
 * Asserted EXACTLY here for the reason #162 records: a bound reported a real
 * improvement as a regression once, and an exact count cannot.
 */
const ENEMY_PX = 1189;
const DIFFERING_PX = 8;

interface Window {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
}

/**
 * Four windows, deliberately unlike each other.
 *
 * The near-spawn one is not optional: Nauvis's elevation tree has starting-lake
 * and starting-island terms that only fire inside the starting area, and issue
 * #326 was nearly dismissed on a window that sat entirely inside it. A far-field
 * window alone would leave those branches unrendered by both ports.
 */
const WINDOWS: Window[] = [
  // COARSE at spawn rather than fine. A 64x64 window at 1 tile/px covers only
  // +/-32 tiles and came back with TWO distinct colours - identical between two
  // renderers that both painted a near-flat field, which is what the colour
  // count below exists to refuse. At 4 tiles/px it spans +/-128 and is varied.
  {
    label: "coarse at spawn",
    width: 64,
    height: 64,
    originX: -128,
    originY: -128,
    tilesPerPixel: 4,
  },
  {
    label: "wide, offset",
    width: 96,
    height: 24,
    originX: 512.5,
    originY: -1024.25,
    tilesPerPixel: 1,
  },
  { label: "tall, coarse", width: 24, height: 96, originX: -2048, originY: 768, tilesPerPixel: 8 },
  // Far field, and COARSE for the same reason the spawn window is: at
  // 0.5 tiles/px this spanned 24 tiles and came back a single flat colour.
  {
    label: "coarse, far field",
    width: 48,
    height: 48,
    originX: 4000.25,
    originY: -3000.75,
    tilesPerPixel: 16,
  },
];

function request(w: Window): ElevationRenderRequest {
  return {
    id: 1,
    view: "terrain",
    seed0: SEED,
    width: w.width,
    height: w.height,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: w.tilesPerPixel,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
  };
}

let compiled: WebAssembly.Module | undefined;
async function engine() {
  compiled ??= await compileEngine(
    readFileSync(join(import.meta.dirname, "../src/noise/wasm/engine.wasm")),
  );
  return instantiateEngine(compiled);
}

describe("the WASM engine renders Nauvis terrain exactly as the TypeScript does", () => {
  it("is byte-identical across four windows", async () => {
    const e = await engine();
    for (const w of WINDOWS) {
      const req = request(w);
      const wasm = new Uint8ClampedArray(runRenderRequest(req, e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(req).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  it("each of those windows carries several distinct colours", async () => {
    // Anti-vacuity for the comparison above: "identical" is satisfied by two
    // renderers that both painted a flat field. Checked PER window, because one
    // rich window would otherwise cover for three flat ones.
    const e = await engine();
    for (const w of WINDOWS) {
      const px = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      const seen = new Set<string>();
      for (let i = 0; i < px.length; i += 4) {
        seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      }
      expect(seen.size, `${w.label}: distinct colours`).toBeGreaterThan(2);
    }
  }, 300000);

  it("moving the climate levers moves the render on both paths together", async () => {
    // The eight-lever block is defaulted on the TypeScript side inside
    // `makeMoisture` / `makeAux` and read raw by the module, so a wrong default
    // in `renderNauvisThroughWasm` would be a silent divergence. Moving each
    // lever and requiring BOTH paths to move together is what catches one.
    const e = await engine();
    // A WIDE window. `auxFrequency` moved nothing at all across a 64x64 window
    // at 1 tile/px: aux decides between dirt and desert families, and a small
    // patch can sit entirely inside one. The lever is not dead - the window was.
    // A window that is both VARIED and inside the starting area. Two earlier
    // attempts each failed for the opposite reason: 64x64 at 1 tile/px spans
    // +/-32 tiles and `auxFrequency` moved nothing, while 96x96 at 32 tiles/px
    // spans +/-1536 and put the starting-area moisture terms - which only fire
    // within ~150 tiles of spawn - inside a handful of pixels, so
    // `startingAreaMoistureFrequency` moved nothing either. At 4 tiles/px over
    // +/-256 both are live.
    const base: ElevationRenderRequest = {
      ...request(WINDOWS[0]),
      width: 128,
      height: 128,
      originX: -256,
      originY: -256,
      tilesPerPixel: 4,
    };
    const flat = (r: ElevationRenderRequest, eng?: typeof e) =>
      Array.from(new Uint8ClampedArray(runRenderRequest(r, eng).buffer));
    const baseWasm = flat(base, e);
    expect(flat(base)).toEqual(baseWasm);

    const moved: Partial<ElevationRenderRequest>[] = [
      { segmentationMultiplier: 2 },
      { moistureFrequency: 3 },
      { moistureBias: 0.2 },
      { auxFrequency: 0.5 },
      { auxBias: -0.15 },
      { startingAreaMoistureSize: 4 },
      // The frequency has to move WITH the size. See the assertion below.
      { startingAreaMoistureSize: 4, startingAreaMoistureFrequency: 3 },
    ];
    for (const patch of moved) {
      const req = { ...base, ...patch } as ElevationRenderRequest;
      const w = flat(req, e);
      const t = flat(req);
      const name = Object.keys(patch)[0];
      expect(w, `${name}: wasm vs ts`).toEqual(t);
      expect(w, `${name}: must actually move the render`).not.toEqual(baseWasm);
    }

    // **`startingAreaMoistureFrequency` alone is INERT, and that is a property
    // of the expression rather than a gap in the sweep.** `starting_bias_change`
    // is `slider_to_linear(size, -0.5, 0.5)`, which is exactly 0 at the default
    // size - so the whole starting-area blend collapses to `base_bias` and the
    // frequency multiplies a zero difference. `nauvis_climate`'s module note
    // records the same thing about the oracle fixture.
    //
    // Asserted rather than worked around, so that a change making the frequency
    // live on its own fails here instead of silently widening what the sweep
    // covers.
    const freqOnly = { ...base, startingAreaMoistureFrequency: 3 } as ElevationRenderRequest;
    expect(flat(freqOnly, e), "frequency alone must stay inert at the default size").toEqual(
      baseWasm,
    );
    expect(flat(freqOnly)).toEqual(baseWasm);
  }, 300000);

  it("a moved spawn stays on the TypeScript path rather than rendering wrong", async () => {
    // The Nauvis ABI block carries no spawn list, so the module fixes it at the
    // origin. `runRenderRequest` therefore has to REFUSE the engine for a
    // request that moved it - `startingPositions` reaches `elevation_nauvis`'s
    // distance term, so taking the engine anyway would be a wrong answer rather
    // than a slow one.
    const e = await engine();
    const req = {
      ...request(WINDOWS[0]),
      startingPositions: [{ x: 512, y: -256 }],
    };
    const withEngine = Array.from(new Uint8ClampedArray(runRenderRequest(req, e).buffer));
    const withoutEngine = Array.from(new Uint8ClampedArray(runRenderRequest(req).buffer));
    expect(withEngine).toEqual(withoutEngine);
    // And the moved spawn must actually change the render, or this proves
    // nothing about which path ran.
    const atOrigin = Array.from(
      new Uint8ClampedArray(runRenderRequest(request(WINDOWS[0]), e).buffer),
    );
    expect(withEngine).not.toEqual(atOrigin);
  }, 300000);
});

describe("the WASM engine's Nauvis terrain against the game's own preview", () => {
  it("differs from the game at exactly the pixels the TypeScript does", async () => {
    const e = await engine();
    const png = decodePng(
      new Uint8Array(readFileSync(join(FIXTURES, "oracle-preview-nauvis-terrain.seed123456.png"))),
      (b) => new Uint8Array(inflateSync(b)),
    );
    expect([png.width, png.height]).toEqual([SIZE, SIZE]);

    const ours = new Uint8ClampedArray(
      runRenderRequest(
        {
          id: 1,
          view: "terrain",
          seed0: SEED,
          width: SIZE,
          height: SIZE,
          originX: -SIZE / 2,
          originY: -SIZE / 2,
          tilesPerPixel: 1,
          waterLevel: 0,
          segmentationMultiplier: 1,
          startingPositions: [{ x: 0, y: 0 }],
        },
        e,
      ).buffer,
    );

    // ONE definition of the mask, handed to both the counting loop and the
    // artifact writer - written twice the copies drift, and then the artifacts
    // describe a different comparison than the assertion that failed.
    // `decodePng` returns RGB at stride 3, NOT RGBA. Reading it at stride 4
    // silently compares the wrong pixels - it reported 283 enemy pixels against
    // the real 1,189, which looks like a render difference rather than an
    // indexing one.
    const gameAt = (i: number) => [png.rgb[i * 3], png.rgb[i * 3 + 1], png.rgb[i * 3 + 2]];
    const oursAt = (i: number) => [ours[i * 4], ours[i * 4 + 1], ours[i * 4 + 2]];
    const ignore = (i: number): boolean => {
      const g = gameAt(i);
      return g[0] === ENEMY_RGB[0] && g[1] === ENEMY_RGB[1] && g[2] === ENEMY_RGB[2];
    };

    let enemyPx = 0;
    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (ignore(i)) {
        enemyPx++;
        continue;
      }
      const g = gameAt(i);
      const o = oursAt(i);
      if (g[0] !== o[0] || g[1] !== o[1] || g[2] !== o[2]) differing++;
    }

    withDiffArtifacts(
      {
        spec: "wasmNauvisRenderParity",
        case: "nauvis-terrain",
        game: png,
        ours: { width: SIZE, height: SIZE, rgba: ours },
        ignore,
      },
      () => {
        expect(enemyPx).toBe(ENEMY_PX);
        expect(differing).toBe(DIFFERING_PX);
        expect(SIZE * SIZE - enemyPx).toBe(1047387);
      },
    );
  }, 300000);
});
