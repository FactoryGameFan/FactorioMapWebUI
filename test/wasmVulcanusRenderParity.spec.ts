import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng } from "./oracle/decodePng";
import { planTiles, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";
import { compileEngine, instantiateEngine } from "../src/noise/wasm/engine";
import { CLIFF_MAP_COLOR } from "../src/noise/cliffs/cliffCatalog";
import { ROCK_MAP_COLOR } from "../src/noise/rocks/rockCatalog";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";

/**
 * Tier 3 for Vulcanus (#225): the Rust engine's terrain render against the
 * TypeScript one, and both against the game's own preview PNG.
 *
 * The Fulgora counterpart is `wasmFulgoraRenderParity.spec.ts`, and this follows
 * its shape deliberately - the two arms of tier 3 answer different questions and
 * neither substitutes for the other:
 *
 * - **WASM against TypeScript** must be BYTE-IDENTICAL. It says the port did not
 *   change behaviour, which is what makes the engine a speed choice rather than
 *   a behaviour switch, and it is what lets `runRenderRequest` dispatch to
 *   whichever path is available without a window in which the answer is wrong.
 * - **WASM against the game's PNG** says how far both ports sit from the game.
 *   Because the first arm holds, that count must be EXACTLY the TypeScript's
 *   number rather than merely under a bound.
 *
 * The seed here is a SURFACE seed, and getting that wrong is the failure that
 * looks like a broken port. `oracle-preview-vulcanus-terrain.seed123456.png`
 * comes from `--generate-map-preview --map-gen-seed 123456`, and the game
 * derives Vulcanus's surface seed as `mapSeed + crc32("vulcanus")`.
 */
const FIXTURES = join(import.meta.dirname, "fixtures");
const SIZE = 1024;

/** `surfaceSeedForPlanet("vulcanus", 123456)`. */
const VULCANUS_SURFACE_SEED = 1249936247;

/**
 * Rock and cliff pixels in the game's capture, which Vulcanus has no control to
 * disable. Measured 2026-08-24 - 11.34% of the image.
 */
const MASKED_PX = 118890;

/**
 * Of the 929,686 pixels actually compared, the ones that differ: 1.3363%, so
 * 98.664% agreement.
 *
 * **This is the TypeScript renderer's own number**, and it has to be, because
 * the first describe block asserts the two renders are byte-identical.
 * `previewAgreement.spec.ts` records the same 98.664% over the same 929,686
 * compared pixels, from a completely separate run through the TypeScript path.
 *
 * The gap is not diagnosed and this does not bless it - #225's remaining work
 * (the cliff, rock and resource stacks) sits behind part of it. Freezing the
 * count is what makes a change to it a finding.
 */
const DIFFERING_PX = 12423;

/**
 * Cliff pixels the overlay paints over terrain, per window, in `WINDOWS` order.
 *
 * Frozen rather than bounded, for the reason every count in this port is: a
 * bound wide enough to be safe is wide enough to swallow a change worth several
 * cells. Both renderers produce these, because the comparison above is
 * byte-identity.
 */
const CLIFF_PIXELS_PER_WINDOW = [640, 572, 1379, 48];

let compiled: WebAssembly.Module | undefined;
async function engine() {
  compiled ??= await compileEngine(
    readFileSync(join(import.meta.dirname, "../src/noise/wasm/engine.wasm")),
  );
  return instantiateEngine(compiled);
}

function reference(name: string): { width: number; height: number; rgb: Uint8Array } {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
  return decodePng(bytes, (b) => new Uint8Array(inflateSync(b)));
}

interface Window {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
}

/**
 * Four windows that vary every geometry field INDEPENDENTLY.
 *
 * Varying them together would leave a swapped width and height, or an origin
 * folded into the wrong axis, indistinguishable from a correct render - which is
 * the same reason the Fulgora spec uses a non-square window and a fractional
 * origin rather than four scaled squares.
 */
const WINDOWS: Window[] = [
  {
    label: "square at origin",
    width: 64,
    height: 64,
    originX: -32,
    originY: -32,
    tilesPerPixel: 1,
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
  {
    label: "fine, far field",
    width: 48,
    height: 32,
    originX: 3000.75,
    originY: -2999.5,
    tilesPerPixel: 0.5,
  },
];

function request(w: Window): ElevationRenderRequest {
  return {
    id: 1,
    planet: "vulcanus",
    view: "terrain",
    seed0: VULCANUS_SURFACE_SEED,
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

describe("the WASM engine renders Vulcanus terrain exactly as the TypeScript does", () => {
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

  /**
   * Anti-vacuity for the comparison above: the four windows must actually
   * contain more than one tile colour, or "identical" would be satisfied by two
   * renderers that both painted a flat field.
   *
   * Checked per window rather than over the union, because one rich window would
   * otherwise cover for three flat ones.
   */
  it("each of those windows carries several distinct colours", async () => {
    const e = await engine();
    for (const w of WINDOWS) {
      const px = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      const distinct = new Set<number>();
      for (let i = 0; i < px.length; i += 4) {
        distinct.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
      }
      expect(distinct.size, `${w.label}: distinct colours`).toBeGreaterThan(2);
    }
  }, 300000);

  /**
   * The engine is not consulted for a view it cannot serve.
   *
   * Vulcanus's rock and resource overlays are still TypeScript, so `rocks`,
   * `resources` and `all` must take the TypeScript path and come back with the
   * overlays painted. If the dispatch ever routed one of them to the module,
   * this would come back missing them - which looks like a rendering regression
   * rather than a routing one.
   *
   * **`cliffs` is deliberately absent from this list**, because it moved. The
   * block below is what grades it, and this test would be the thing that went
   * red if it had moved without being graded.
   */
  it("leaves the un-ported composite views on the TypeScript path", async () => {
    const e = await engine();
    const w = WINDOWS[0] as Window;
    for (const view of ["all", "rocks", "resources"] as const) {
      const composite = { ...request(w), view };
      const withEngine = new Uint8ClampedArray(runRenderRequest(composite, e).buffer);
      const withoutEngine = new Uint8ClampedArray(runRenderRequest(composite).buffer);
      expect(Array.from(withEngine), `${view}: engine vs none`).toEqual(Array.from(withoutEngine));
    }

    // And `all` really does differ from bare terrain here, so the assertion
    // above is not comparing two copies of the same picture.
    const all = new Uint8ClampedArray(runRenderRequest({ ...request(w), view: "all" }, e).buffer);
    const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
    expect(Array.from(all)).not.toEqual(Array.from(terrain));
  }, 300000);
});

/**
 * Tier 3 for the CLIFF view, which the module renders as a composite: terrain,
 * then the cliff footprint over it.
 *
 * Sent as one request rather than two on purpose - the cliff overlay has nothing
 * to draw on its own, and the two passes share the whole field DAG below the
 * tile argmax, which splitting would build twice.
 */
describe("the WASM engine renders Vulcanus cliffs exactly as the TypeScript does", () => {
  const cliffRequest = (w: Window): ElevationRenderRequest => ({
    ...request(w),
    view: "cliffs",
  });

  it("is byte-identical across four windows", async () => {
    const e = await engine();
    for (const w of WINDOWS) {
      const req = cliffRequest(w);
      const wasm = new Uint8ClampedArray(runRenderRequest(req, e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(req).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
    }
  }, 300000);

  /**
   * Anti-vacuity, and the assertion that actually needs making: byte-identity
   * between two renders that painted NO cliffs would be satisfied by an engine
   * whose cliff pass never ran.
   *
   * Counted per window rather than over the union, because one cliff-rich window
   * would otherwise cover for three empty ones - and the count is frozen, so a
   * pass that starts placing more or fewer is a finding rather than noise.
   */
  it("paints cliff pixels in every window, and the same ones the TypeScript does", async () => {
    const e = await engine();
    const isCliff = (px: Uint8ClampedArray, i: number): boolean =>
      px[i] === CLIFF_MAP_COLOR[0] &&
      px[i + 1] === CLIFF_MAP_COLOR[1] &&
      px[i + 2] === CLIFF_MAP_COLOR[2];

    const counts: number[] = [];
    for (const w of WINDOWS) {
      const wasm = new Uint8ClampedArray(runRenderRequest(cliffRequest(w), e).buffer);
      const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      let painted = 0;
      let overTerrain = 0;
      for (let i = 0; i < wasm.length; i += 4) {
        if (!isCliff(wasm, i)) continue;
        painted++;
        // A cliff pixel that was ALREADY that colour in the terrain render
        // proves nothing, so count the ones the overlay actually changed.
        if (!isCliff(terrain, i)) overTerrain++;
      }
      expect(painted, `${w.label}: cliff pixels`).toBeGreaterThan(0);
      expect(overTerrain, `${w.label}: pixels the overlay changed`).toBeGreaterThan(0);
      counts.push(overTerrain);
    }
    expect(counts).toEqual(CLIFF_PIXELS_PER_WINDOW);
  }, 300000);

  /**
   * Rendering the window as tiles must reproduce the single whole-image render
   * byte for byte, through the ENGINE.
   *
   * This is the guarantee the cell query box exists to provide, and it is the
   * reason that box is sent across the ABI rather than derived inside the
   * module: a cliff cell centred just outside a tile still owes it pixels,
   * because the 4px block spans `px - 2 ..= px + 1`.
   *
   * The second arm is what stops this being vacuous. Dropping `fullImage`
   * removes the halo - `cliffCellQueryBox` then returns the bare pixel box - and
   * the tiles must come back DIFFERENT. Without that arm the test would pass on
   * a window where no cliff happens to straddle a seam, which is most of them:
   * at 1 tile per pixel the 4px block sits on a 4px lattice and a 32px seam is a
   * multiple of 4, so blocks never straddle. `tilesPerPixel: 8` is chosen for
   * exactly that reason, not for coverage.
   */
  it("tiles to the same bytes as one whole render, and the halo is what makes it so", async () => {
    const e = await engine();
    const w = WINDOWS[2] as Window; // tall, coarse - 8 tiles per pixel
    const whole = new Uint8ClampedArray(runRenderRequest(cliffRequest(w), e).buffer);

    const full: ImageBox = {
      originX: w.originX,
      originY: w.originY,
      width: w.width,
      height: w.height,
      tilesPerPixel: w.tilesPerPixel,
    };
    const renderTiled = (halo: boolean): Uint8ClampedArray => {
      const tiles = planTiles(full, 8).map((t) => {
        const out = runRenderRequest(
          {
            ...cliffRequest(w),
            originX: t.originX,
            originY: t.originY,
            width: t.width,
            height: t.height,
            ...(halo ? { fullImage: full } : {}),
          },
          e,
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
    };

    expect(Array.from(renderTiled(true))).toEqual(Array.from(whole));
    expect(Array.from(renderTiled(false))).not.toEqual(Array.from(whole));
  }, 300000);
});

describe("the WASM engine agrees with the game's own Vulcanus preview PNG", () => {
  /**
   * The same 1024x1024 comparison `previewAgreement.spec.ts` makes of the
   * TypeScript renderer, run through the real boundary.
   *
   * **The count is EXACT, not a bound**, and that is available only because the
   * first describe block holds: the two renders are byte-identical, so this must
   * be the TypeScript's own number rather than merely under 2%. A bound here
   * would pass for any change worth thousands of pixels.
   *
   * Rocks and cliffs are masked because Vulcanus has no control that can disable
   * them, so they are in the reference capture whatever the request says. Their
   * coverage is a separate finding with its own assertions in
   * `previewAgreement.spec.ts`; this is the terrain layer alone.
   */
  it("differs on exactly the same pixels the TypeScript renderer does", async () => {
    const e = await engine();
    const game = reference("oracle-preview-vulcanus-terrain.seed123456.png");
    expect([game.width, game.height]).toEqual([SIZE, SIZE]);

    const full: ElevationRenderRequest = {
      ...request(WINDOWS[0] as Window),
      width: SIZE,
      height: SIZE,
      originX: -SIZE / 2,
      originY: -SIZE / 2,
      tilesPerPixel: 1,
    };
    const ours = new Uint8ClampedArray(runRenderRequest(full, e).buffer);

    const rgbAt = (rgb: Uint8Array, i: number): [number, number, number] => [
      rgb[i * 3],
      rgb[i * 3 + 1],
      rgb[i * 3 + 2],
    ];
    const oursAt = (b: Uint8ClampedArray, i: number): [number, number, number] => [
      b[i * 4],
      b[i * 4 + 1],
      b[i * 4 + 2],
    ];
    const same = (a: readonly number[], b: readonly number[]): boolean =>
      a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

    // ONE definition, handed to both the counting loop and the artifact writer -
    // written out twice the copies drift, and then the artifacts describe a
    // different comparison than the assertion that failed.
    const ignore = (i: number): boolean => {
      const g = rgbAt(game.rgb, i);
      return same(g, ROCK_MAP_COLOR) || same(g, CLIFF_MAP_COLOR);
    };

    let masked = 0;
    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (ignore(i)) {
        masked++;
        continue;
      }
      if (!same(rgbAt(game.rgb, i), oursAt(ours, i))) differing++;
    }

    withDiffArtifacts(
      {
        spec: "wasmVulcanusRenderParity",
        case: "terrain-1024",
        game,
        ours: { width: SIZE, height: SIZE, rgba: ours },
        ignore,
      },
      () => {
        // Frozen exact counts, measured 2026-08-24. `previewAgreement.spec.ts`
        // asserts a 2% BOUND on the same comparison; this side freezes the
        // number, because the byte-identity above means it CAN be exact and
        // #162 is the standing record of a tolerance hiding a real defect.
        expect(masked).toBe(MASKED_PX);
        expect(differing).toBe(DIFFERING_PX);
      },
    );
  }, 300000);

  /**
   * The seed trap, asserted rather than described.
   *
   * Every `oracle-*.json` in this repo comes from a harness that FORCES the
   * surface seed; the PNGs come from `--generate-map-preview --map-gen-seed`,
   * which is a MAP seed. Rendering with the map seed produces a different planet
   * entirely, and the contrast is what makes the count above evidence of a
   * correct port rather than of a lucky constant.
   */
  it("scores far worse at the raw map seed, which is what the bug looked like", async () => {
    const e = await engine();
    const game = reference("oracle-preview-vulcanus-terrain.seed123456.png");
    const wrong: ElevationRenderRequest = {
      ...request(WINDOWS[0] as Window),
      seed0: 123456,
      width: SIZE,
      height: SIZE,
      originX: -SIZE / 2,
      originY: -SIZE / 2,
      tilesPerPixel: 1,
    };
    const ours = new Uint8ClampedArray(runRenderRequest(wrong, e).buffer);
    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const g: [number, number, number] = [
        game.rgb[i * 3],
        game.rgb[i * 3 + 1],
        game.rgb[i * 3 + 2],
      ];
      if (g[0] !== ours[i * 4] || g[1] !== ours[i * 4 + 1] || g[2] !== ours[i * 4 + 2]) {
        differing++;
      }
    }
    // An order of magnitude worse than the masked count above, so the surface
    // seed derivation is load-bearing rather than incidental.
    expect(differing).toBeGreaterThan(DIFFERING_PX * 10);
  }, 300000);
});
