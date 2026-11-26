import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng, type DecodedImage } from "./oracle/decodePng";
import realSurface from "./fixtures/oracle-gleba-real-surface.seed123456.json";
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
 * terrain-only (`scripts/probes/gleba-real-surface`). Each tile is drawn in the
 * `map_color` the game reported for it, which is what the engine paints. Eric
 * chose the real surface over the game's preview PNG on 2026-11-26: the target
 * is what the map will actually look like.
 *
 * ## What the frozen count is
 *
 * The engine paints the raw tile argmax. A real surface runs one more pass
 * after it, `TileCorrectionMapGenerationTask`
 * (`docs/noise/tile-correction-NOTES.md`), which rewrites tiles at boundaries
 * and is not ported. The game's own preview PNG skips that pass, and the engine
 * matches the preview PNG at every pixel of this window (the reference test
 * below). The preview PNG differs from the real surface at exactly the frozen
 * count here. So every differing pixel is tile correction, as far as this
 * window can show.
 *
 * Several tiles share a map colour, so a picture sees only part of the
 * correction: by tile NAME the gap is 1,680 tiles, frozen in
 * `gleba_raw_tiles_against_the_real_surface` (`crates/fmw-noise/src/fixtures.rs`).
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

type TileName = keyof typeof realSurface.tiles;

/** The real surface's tile names, row-major. */
const realNames: readonly TileName[] = realSurface.rows.flatMap((row) =>
  row.split("").map((c) => realSurface.names[realSurface.alphabet.indexOf(c)] as TileName),
);

/** The real surface drawn in each tile's map colour, as the diff writer takes it. */
const realImage: DecodedImage = (() => {
  const rgb = new Uint8Array(SIDE * SIDE * 3);
  realNames.forEach((n, i) => {
    rgb.set(realSurface.tiles[n].mapColor, i * 3);
  });
  return { width: SIDE, height: SIDE, rgb };
})();
const realKey = (i: number): number =>
  colorKey(
    realImage.rgb[i * 3] as number,
    realImage.rgb[i * 3 + 1] as number,
    realImage.rgb[i * 3 + 2] as number,
  );

/** Pixels where the real surface's colour and ours differ. */
function differingFromReal(ours: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < SIDE * SIDE; i++) if (realKey(i) !== oursKey(ours, i)) out.push(i);
  return out;
}

/** Whether a real tile touches a different real tile on one of its four sides. */
function onRealBoundary(i: number): boolean {
  const x = i % SIDE;
  const y = Math.floor(i / SIDE);
  const here = realNames[i];
  return (
    (x > 0 && realNames[i - 1] !== here) ||
    (x < SIDE - 1 && realNames[i + 1] !== here) ||
    (y > 0 && realNames[i - SIDE] !== here) ||
    (y < SIDE - 1 && realNames[i + SIDE] !== here)
  );
}

let cachedRender: Uint8ClampedArray | undefined;
async function windowRender(): Promise<Uint8ClampedArray> {
  cachedRender ??= renderThroughWasm(await engine(), WINDOW).slice();
  return cachedRender;
}

describe("the real-surface fixture", () => {
  it("is the derived seed's surface, terrain-only, with 36 tile kinds in the window", () => {
    expect(realSurface.surfaceSeed).toBe(SEED0);
    expect(realSurface.buildLine).toContain("Version: 2.1.23 ");
    expect(realNames).toHaveLength(SIDE * SIDE);
    expect(Object.keys(realSurface.counts)).toHaveLength(36);
  });
});

describe("the WASM engine against the real Gleba surface", () => {
  /**
   * **698 of 65,536 pixels (1.07%) differ, and all of them are the tile
   * correction pass** (see the file header). Exact, not a bound.
   *
   * It was 1,499 before ties went to the name that sorts first
   * (`TIE_ORDER` in `crates/fmw-noise/src/tiles/gleba_catalog.rs`).
   */
  const DIFFERING_PX = 698;

  /**
   * How many of those sit on a boundary of the REAL surface (a tile whose
   * four-neighbour differs). Correction only rewrites boundaries, so nearly all
   * should; over the whole window only about a third of tiles touch a
   * different tile.
   */
  const DIFFERING_ON_REAL_BOUNDARY = 646;

  it("differs from the real surface on exactly the frozen pixel count", async () => {
    const ours = await windowRender();
    const differing = differingFromReal(ours);
    const onBoundary = differing.filter(onRealBoundary).length;
    let boundaryTiles = 0;
    for (let i = 0; i < SIDE * SIDE; i++) if (onRealBoundary(i)) boundaryTiles++;
    withDiffArtifacts(
      {
        spec: "wasmGlebaRenderParity",
        case: "gleba-terrain-vs-real-surface",
        game: realImage,
        ours: { width: SIDE, height: SIDE, rgba: ours },
      },
      () => {
        expect(differing.length).toBe(DIFFERING_PX);
        expect(onBoundary).toBe(DIFFERING_ON_REAL_BOUNDARY);
        // The share on a boundary is far above the window's own share, which
        // is what makes "correction rewrites boundaries" a measurement.
        expect(onBoundary / differing.length).toBeGreaterThan((2 * boundaryTiles) / (SIDE * SIDE));
      },
    );
  }, 300000);

  it("scores far worse at the raw map seed, which is what the seed trap looks like", async () => {
    const wrong = renderThroughWasm(await engine(), { ...WINDOW, seed0: 123456 });
    const differing = differingFromReal(wrong).length;
    expect(differing / (SIDE * SIDE)).toBeGreaterThan(0.5);
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
    expect(differingFromReal(moved).length).toBe(8025);
  }, 300000);
});

describe("the game's preview PNG, for reference only", () => {
  /**
   * The terrain-only preview PNG shows the raw argmax with no tile correction.
   * It is NOT the target, and nothing here may be tuned to it. It is here
   * because agreeing with it is what separates "our scores are wrong" from
   * "correction moved the tile".
   */
  const png = (): DecodedImage =>
    decodePng(
      new Uint8Array(
        readFileSync(
          join(import.meta.dirname, "fixtures", "oracle-preview-gleba-terrain.seed123456.png"),
        ),
      ),
      (b) => new Uint8Array(inflateSync(b)),
    );

  /**
   * 0 of 1,048,576: the raw argmax, with name-order ties, is the game's at
   * every pixel of the PNG, which contains the real-surface window. It was
   * measured, not expected; under the listing-order tie-break the 256 window
   * alone differed at 831 pixels, every one a tie.
   */
  it("matches the whole 1024 x 1024 preview PNG at every pixel", async () => {
    const game = png();
    const ours = renderThroughWasm(await engine(), {
      ...WINDOW,
      width: game.width,
      height: game.height,
      originX: -game.width / 2,
      originY: -game.height / 2,
    });
    let differing = 0;
    for (let i = 0; i < game.width * game.height; i++) {
      const k = colorKey(
        game.rgb[i * 3] as number,
        game.rgb[i * 3 + 1] as number,
        game.rgb[i * 3 + 2] as number,
      );
      if (k !== oursKey(ours, i)) differing++;
    }
    expect(differing).toBe(0);
  }, 300000);
});

describe("tiling", () => {
  /**
   * The terrain view paints one pixel per tile with no halo, so a render cut
   * into worker tiles must stitch back to the whole render byte for byte.
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
