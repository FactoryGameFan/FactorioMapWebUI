import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng, type DecodedImage } from "./oracle/decodePng";
import realSurface from "./fixtures/oracle-gleba-real-surface.seed123456.json";
import columnsSurface from "./fixtures/oracle-gleba-real-surface-columns.seed123456.json";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import { planTiles, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";
import {
  compileEngine,
  instantiateEngine,
  renderThroughWasm,
  type EngineExports,
} from "../src/noise/wasm/engine";
import type { GlebaRenderRequest } from "../src/noise/wasm/request";

/**
 * **Tier 3 for Gleba (#454, slice 2): the terrain render against a REAL
 * surface.**
 *
 * The reference is `oracle-gleba-real-surface.seed123456.json`: `get_tile` at
 * every tile of -128..127 on a generated Gleba surface at map seed 123456,
 * terrain-only, its chunks made by one radius request the way a game start
 * makes its spawn area (`scripts/probes/gleba-real-surface`). Each tile is drawn
 * in the `map_color` the game reported for it, which is what the engine
 * paints. Eric chose the real surface over the game's preview PNG on
 * 2026-11-26: the target is what the map will actually look like.
 *
 * ## The render is the raw argmax plus tile correction
 *
 * A real surface runs `TileCorrectionMapGenerationTask` after the tile argmax;
 * the preview PNG does not. At one tile per pixel the engine runs a port of it
 * (`crates/fmw-noise/src/tiles/correction.rs`) over the window's chunks plus a
 * one-chunk margin, and the render matches the real surface at every pixel.
 * Before the port it differed at 697, which is exactly how far the preview PNG
 * is from the real surface in this window; the raw argmax matched the PNG at
 * all 1,048,576 of its pixels.
 *
 * By tile NAME the Rust tests grade the same windows exactly as well
 * (`gleba_corrected_tiles_against_the_real_surface` and
 * `gleba_corrected_tiles_against_a_columns_request` in
 * `crates/fmw-noise/src/fixtures.rs`).
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

let cachedEngine: EngineExports | undefined;
async function engine(): Promise<EngineExports> {
  cachedEngine ??= await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
  return cachedEngine;
}

/** Gleba's surface seed at map seed 123456, 3,215,206,427. */
const SEED0 = surfaceSeedForPlanet("gleba", 123456);

const SIDE = realSurface.window.width;
const WINDOW = {
  planet: "gleba",
  view: "terrain",
  seed0: SEED0,
  width: SIDE,
  height: SIDE,
  originX: realSurface.window.x0,
  originY: realSurface.window.y0,
  tilesPerPixel: 1,
} as const satisfies GlebaRenderRequest;

const colorKey = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
const oursKey = (px: ArrayLike<number>, i: number): number =>
  colorKey(px[i * 4] as number, px[i * 4 + 1] as number, px[i * 4 + 2] as number);
const imageKey = (img: DecodedImage, i: number): number =>
  colorKey(img.rgb[i * 3] as number, img.rgb[i * 3 + 1] as number, img.rgb[i * 3 + 2] as number);

type Surface = typeof realSurface;

/** A real-surface fixture drawn in each tile's map colour. */
function surfaceImage(s: Surface): DecodedImage {
  const rgb = new Uint8Array(SIDE * SIDE * 3);
  let i = 0;
  for (const row of s.rows) {
    for (const c of row.split("")) {
      const name = s.names[s.alphabet.indexOf(c)] as keyof Surface["tiles"];
      rgb.set(s.tiles[name].mapColor, i * 3);
      i++;
    }
  }
  expect(i).toBe(SIDE * SIDE);
  return { width: SIDE, height: SIDE, rgb };
}
const realImage = surfaceImage(realSurface);

/** Pixels where `img` and `ours` differ. */
function differing(img: DecodedImage, ours: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) if (imageKey(img, i) !== oursKey(ours, i)) n++;
  return n;
}

let cachedRender: Uint8ClampedArray | undefined;
async function windowRender(): Promise<Uint8ClampedArray> {
  cachedRender ??= renderThroughWasm(await engine(), WINDOW).slice();
  return cachedRender;
}

/** The game's terrain-only preview PNG, 1024 x 1024 around the origin. */
const previewPng = (): DecodedImage =>
  decodePng(
    new Uint8Array(
      readFileSync(
        join(import.meta.dirname, "fixtures", "oracle-preview-gleba-terrain.seed123456.png"),
      ),
    ),
    (b) => new Uint8Array(inflateSync(b)),
  );

/** The 256 x 256 real-surface window cut out of the 1024 preview PNG. */
function previewWindow(png: DecodedImage): DecodedImage {
  const off = (png.width - SIDE) / 2;
  const rgb = new Uint8Array(SIDE * SIDE * 3);
  for (let y = 0; y < SIDE; y++) {
    rgb.set(
      png.rgb.subarray(((y + off) * png.width + off) * 3, ((y + off) * png.width + off + SIDE) * 3),
      y * SIDE * 3,
    );
  }
  return { width: SIDE, height: SIDE, rgb };
}

describe("the real-surface fixtures", () => {
  it("are the derived seed's surface, terrain-only, with 36 tile kinds in the window", () => {
    for (const s of [realSurface, columnsSurface]) {
      expect(s.surfaceSeed).toBe(SEED0);
      expect(s.buildLine).toContain("Version: 2.1.23 ");
      expect(Object.keys(s.counts)).toHaveLength(36);
    }
    expect([realSurface.chunkOrder, columnsSurface.chunkOrder]).toEqual(["radius", "columns"]);
  });
});

describe("the WASM engine against the real Gleba surface", () => {
  /**
   * **0 of 65,536 pixels.** Exact, not a bound. It was 1,499 under the
   * listing-order tie-break against the first (row-by-row) capture, and 697
   * against this one with name-order ties and no tile correction.
   */
  const DIFFERING_PX = 0;

  it("matches the real surface at every pixel", async () => {
    const ours = await windowRender();
    const n = differing(realImage, ours);
    withDiffArtifacts(
      {
        spec: "wasmGlebaRenderParity",
        case: "gleba-terrain-vs-real-surface",
        game: realImage,
        ours: { width: SIDE, height: SIDE, rgba: ours },
      },
      () => {
        expect(n).toBe(DIFFERING_PX);
      },
    );
  }, 300000);

  it("matches a second real surface whose chunks were requested one by one in columns", async () => {
    expect(differing(surfaceImage(columnsSurface), await windowRender())).toBe(0);
  }, 300000);

  /**
   * The control that the correction is in the render: the preview PNG, which
   * shows the raw argmax, differs from our render in this window at exactly
   * the 697 pixels by which it differs from the real surface.
   */
  it("differs from the preview PNG exactly where the real surface does", async () => {
    const png = previewWindow(previewPng());
    const ours = await windowRender();
    let onlyOne = 0;
    for (let i = 0; i < SIDE * SIDE; i++) {
      const p = imageKey(png, i);
      if ((p !== oursKey(ours, i)) !== (p !== imageKey(realImage, i))) onlyOne++;
    }
    expect(differing(png, ours)).toBe(697);
    expect(onlyOne, "pixels where the PNG differs from one of the two only").toBe(0);
  }, 300000);

  it("scores far worse at the raw map seed, which is what the seed trap looks like", async () => {
    const wrong = renderThroughWasm(await engine(), { ...WINDOW, seed0: 123456 });
    expect(differing(realImage, wrong) / (SIDE * SIDE)).toBeGreaterThan(0.5);
  }, 300000);

  it("moves away from the real surface when the plants frequency moves", async () => {
    // The real surface was generated at the neutral levers, so a moved lever
    // that reaches the render makes the count worse. Only the plants frequency
    // reaches this window: the two water levers moved no pixel of it at 0.5 or
    // 2 (measured), because the starting-area cones decide the land around
    // spawn. `each_lever_changes_the_render` in crates/fmw-wasm grades all
    // three 600 tiles out.
    const moved = renderThroughWasm(await engine(), {
      ...WINDOW,
      glebaControls: { plantsFrequency: 2 },
    });
    expect(differing(realImage, moved)).toBe(8544);
  }, 300000);
});

describe("the game's preview PNG, for reference only", () => {
  /**
   * The preview PNG shows the raw argmax with no tile correction, so it is NOT
   * the target and nothing may be tuned to it. Over its whole 1024 x 1024 the
   * render differs at 9,736 pixels (0.93%), the correction's footprint there
   * by map colour. Before the correction port this was 0: the raw argmax, with
   * name-order ties, is the game's at every pixel of the PNG.
   */
  it("differs from the whole 1024 x 1024 preview PNG by the correction's footprint", async () => {
    const game = previewPng();
    const ours = renderThroughWasm(await engine(), {
      ...WINDOW,
      width: game.width,
      height: game.height,
      originX: -game.width / 2,
      originY: -game.height / 2,
    });
    expect(differing(game, ours)).toBe(9736);
  }, 300000);
});

describe("tiling", () => {
  /**
   * Correction reads neighbouring chunks, so a worker tile corrects its own
   * one-chunk margin. Cut into 100-pixel tiles (not chunk aligned), the render
   * must still stitch back to the whole render byte for byte.
   */
  it("a tiled render stitches to the whole render", async () => {
    const e = await engine();
    const FULL: ImageBox = {
      originX: WINDOW.originX,
      originY: WINDOW.originY,
      width: SIDE,
      height: SIDE,
      tilesPerPixel: 1,
    };
    const whole = (await windowRender()).slice();
    const tiles = planTiles(FULL, 100).map((t) => ({
      ...t,
      data: renderThroughWasm(e, {
        ...WINDOW,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
      }).slice(),
    }));
    expect(stitchTiles(FULL, tiles)).toEqual(whole);
  }, 300000);
});
