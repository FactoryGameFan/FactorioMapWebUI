import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  RECORDING,
  consultedCount,
  expectFrozen,
  expectRecordedRows,
  flushRecording,
  foldPixels,
  frozenCount,
} from "./tier3Frozen";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng } from "./oracle/decodePng";
import { planTiles, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";
import { compileEngine, instantiateEngine } from "../src/noise/wasm/engine";
import { CLIFF_MAP_COLOR } from "../src/noise/cliffs/cliffCatalog";
import { ROCK_MAP_COLOR } from "../src/noise/rocks/rockCatalog";
import { VULCANUS_RESOURCE_CATALOG } from "../src/noise/resources/vulcanusResourceCatalog";
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

/**
 * The tier-3 freeze section for this spec. See `tier3Frozen.ts`.
 *
 * Every Rust-against-TypeScript render below is ALSO checked against a frozen
 * checksum, so the assertion survives #227 deleting the TypeScript arm. Without
 * it, `runRenderRequest(req)` with the engine left off stops being an
 * independent arm the moment the Vulcanus branch goes, and the comparison would
 * pass while grading nothing.
 */
const SECTION = "vulcanus:render";

/**
 * Rows this spec must record, as a literal - the same guard tier 2 documents:
 * adding a case makes a record run DROP the section until this is updated.
 *
 * 4 terrain windows + 5 routed views + 4 rocks + 5 resources + 4 composite
 * + 4 cliffs.
 *
 * The three `renderTiled` helpers are NOT here: every one of their calls passes
 * the engine, so they compare tiled against whole rather than Rust against
 * TypeScript, and the deletion leaves them intact.
 */
const ROWS = 26;

expectRecordedRows(SECTION, ROWS);
afterAll(flushRecording);

/** Freeze one render, and compare the two arms while both exist. */
function freeze(label: string, name: string, wasm: ArrayLike<number>, ts: ArrayLike<number>): void {
  expectFrozen(SECTION, label, name, foldPixels(wasm), foldPixels(ts));
}

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

/**
 * Rock pixels the overlay paints over terrain, per window, in `WINDOWS` order.
 *
 * Frozen for the same reason the cliff counts are. Unlike the resource overlay
 * below, rocks are dense enough that every one of the four windows carries
 * them, so this list needs no window set of its own.
 */
const ROCK_PIXELS_PER_WINDOW = [510, 54, 106, 96];

/**
 * Overlay pixels the `all` composite paints over terrain, per window.
 *
 * Larger than the rock and cliff counts added together in the windows where an
 * overlay covers another's pixels - which is the point of asserting it
 * separately rather than deriving it.
 */
const ALL_PIXELS_PER_WINDOW = [1041, 620, 1440, 124];

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
      freeze(w.label, "terrain", wasm, ts);
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
   * Every Vulcanus view now goes through the engine, and the ones that do not
   * are the ones the planet cannot have.
   *
   * This test used to assert the opposite - that `rocks`, `resources` and `all`
   * stayed on the TypeScript path - and it is what would have gone red if they
   * had moved without being graded. They have moved, and the three describe
   * blocks below are what grades them.
   *
   * The land mask and the scrap footprint are still refused, and by STATUS
   * rather than by falling back: Vulcanus has no ocean and no scrap, so those
   * views are meaningless here rather than merely unimplemented.
   */
  it("routes every view the planet has through the engine", async () => {
    const e = await engine();
    const w = WINDOWS[0] as Window;
    for (const view of ["terrain", "cliffs", "rocks", "resources", "all"] as const) {
      const composite = { ...request(w), view };
      const withEngine = new Uint8ClampedArray(runRenderRequest(composite, e).buffer);
      const withoutEngine = new Uint8ClampedArray(runRenderRequest(composite).buffer);
      expect(Array.from(withEngine), `${view}: engine vs none`).toEqual(Array.from(withoutEngine));
      // Prefixed: this block sweeps WINDOWS[0] through every view, so a bare
      // window label would collide with the per-view blocks below.
      freeze(`routes ${view}`, view, withEngine, withoutEngine);
    }

    // And `all` really does differ from bare terrain here, so the assertion
    // above is not comparing two copies of the same picture.
    const all = new Uint8ClampedArray(runRenderRequest({ ...request(w), view: "all" }, e).buffer);
    const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
    expect(Array.from(all)).not.toEqual(Array.from(terrain));
  }, 300000);
});

/** How many pixels of `overlay` are not the colour `terrain` has there. */
function paintedOver(overlay: Uint8ClampedArray, terrain: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < overlay.length; i += 4) {
    if (
      overlay[i] !== terrain[i] ||
      overlay[i + 1] !== terrain[i + 1] ||
      overlay[i + 2] !== terrain[i + 2]
    ) {
      n++;
    }
  }
  return n;
}

const isColor = (px: Uint8ClampedArray, i: number, c: readonly number[]): boolean =>
  px[i] === c[0] && px[i + 1] === c[1] && px[i + 2] === c[2];

/**
 * Tier 3 for the ROCK overlay - the first of the two views that carry the
 * placement roll across the boundary.
 *
 * The roll is what makes this different from every earlier view: the module
 * seeds taus88 per 32-tile chunk and resolves a whole chunk at a time, so a
 * mis-ported chunk seed word or draw order gives an overlay that is uniform,
 * deterministic, plausible, and wrong at every tile. Byte-identity against the
 * TypeScript is what says the stream and the greedy collision pass agree.
 */
describe("the WASM engine renders the Vulcanus rock overlay exactly as the TypeScript does", () => {
  const rockRequest = (w: Window): ElevationRenderRequest => ({ ...request(w), view: "rocks" });

  it("is byte-identical across four windows", async () => {
    const e = await engine();
    for (const w of WINDOWS) {
      const req = rockRequest(w);
      const wasm = new Uint8ClampedArray(runRenderRequest(req, e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(req).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
      freeze(w.label, "rocks", wasm, ts);
    }
  }, 300000);

  /**
   * Anti-vacuity, and the assertion that needs making: byte-identity between
   * two renders that painted NO rocks would be satisfied by an engine whose
   * rock pass never ran.
   *
   * Counted per window and frozen, so a pass that starts placing more or fewer
   * is a finding rather than noise. Every rock pixel must also be the rock
   * colour - a pass that painted the right COUNT of the wrong colour would
   * otherwise slip through.
   */
  it("paints rock pixels in every window, and only rock-coloured ones", async () => {
    const e = await engine();
    const counts: number[] = [];
    for (const w of WINDOWS) {
      const wasm = new Uint8ClampedArray(runRenderRequest(rockRequest(w), e).buffer);
      const terrain = new Uint8ClampedArray(runRenderRequest(request(w), e).buffer);
      let painted = 0;
      for (let i = 0; i < wasm.length; i += 4) {
        if (isColor(wasm, i, ROCK_MAP_COLOR) && !isColor(terrain, i, ROCK_MAP_COLOR)) painted++;
      }
      expect(painted, `${w.label}: rock pixels`).toBe(paintedOver(wasm, terrain));
      counts.push(painted);
    }
    expect(counts).toEqual(ROCK_PIXELS_PER_WINDOW);
  }, 300000);

  /**
   * Rendering the window as tiles must reproduce the single whole-image render
   * byte for byte, through the ENGINE.
   *
   * This is what the placement sweep box exists to provide, and it is a
   * SECOND box rather than a reuse of the cliff one because the two halos are
   * different shapes - the cliff block is asymmetric and its directions cross,
   * a placement mark is a symmetric 3x3.
   *
   * The second arm is what stops this being vacuous: dropping `fullImage`
   * removes the halo and the tiles must come back DIFFERENT. Measured at 92
   * pixels on this window, so the halo is load-bearing rather than defensive.
   */
  it("tiles to the same bytes as one whole render, and the halo is what makes it so", async () => {
    const e = await engine();
    const w = WINDOWS[2] as Window; // tall, coarse - 8 tiles per pixel
    const whole = new Uint8ClampedArray(runRenderRequest(rockRequest(w), e).buffer);

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
            ...rockRequest(w),
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

/**
 * Tier 3 for the RESOURCE overlay, which has two passes rather than one: the
 * geyser ROLLS and paints a 3x3 mark, the three solid ores THRESHOLD and paint
 * a single pixel each.
 *
 * **This block has its own windows, and it has to.** Ore patches are far
 * sparser than rocks: three of the four windows the rest of this file uses
 * contain no ore at all, so a per-window count over them would read
 * `[0, 0, 53, 0]` and three quarters of the comparison would be vacuous. These
 * five were found by sweeping the map for ore and then varying width, height,
 * origin and tiles-per-pixel independently across what was left, so a swapped
 * width and height or an origin folded into the wrong axis is still visible.
 *
 * Between them the five cover all FOUR catalog entries. Only the last carries
 * geysers, which is why it is here at all - it is the one window that grades
 * the rolled pass.
 */
describe("the WASM engine renders the Vulcanus resource overlay exactly as the TypeScript does", () => {
  const ORE_WINDOWS: Window[] = [
    {
      label: "square on a coal patch",
      width: 64,
      height: 64,
      originX: -64,
      originY: -128,
      tilesPerPixel: 1,
    },
    { label: "wide, offset", width: 96, height: 24, originX: -96, originY: -110, tilesPerPixel: 1 },
    {
      label: "tall, coarse",
      width: 24,
      height: 96,
      originX: -2048,
      originY: 768,
      tilesPerPixel: 8,
    },
    {
      label: "fine, fractional origin",
      width: 48,
      height: 32,
      originX: 140.5,
      originY: -110.25,
      tilesPerPixel: 0.5,
    },
    {
      label: "coarse, all four entries",
      width: 128,
      height: 128,
      originX: 0,
      originY: 0,
      tilesPerPixel: 8,
    },
  ];

  /**
   * Pixels of each catalog entry's `map_color`, per window, in `ORE_WINDOWS`
   * order and then catalog order (tungsten, calcite, coal, geyser).
   *
   * Frozen exact counts rather than "more than zero", for the reason every
   * count in this port is frozen: a bound wide enough to be safe is wide enough
   * to swallow a whole patch. The zeros are real and are what makes the table
   * worth writing out - each window carries a DIFFERENT ore, so a resolver
   * wired to one region field for all three would show up as the same column
   * everywhere.
   */
  const ORE_PIXELS = [
    [0, 0, 2755, 0],
    [0, 0, 1291, 0],
    [53, 0, 0, 0],
    [0, 23, 0, 0],
    [47, 172, 80, 37],
  ];

  const oreRequest = (w: Window): ElevationRenderRequest => ({
    ...request(w),
    view: "resources",
    width: w.width,
    height: w.height,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: w.tilesPerPixel,
  });

  it("is byte-identical across five windows", async () => {
    const e = await engine();
    for (const w of ORE_WINDOWS) {
      const req = oreRequest(w);
      const wasm = new Uint8ClampedArray(runRenderRequest(req, e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(req).buffer);
      expect(wasm.length, `${w.label}: length`).toBe(w.width * w.height * 4);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
      freeze(w.label, "resources", wasm, ts);
    }
  }, 300000);

  /**
   * Every catalog entry is painted somewhere, in its OWN colour, at a frozen
   * count.
   *
   * Byte-identity above would be satisfied by two renderers that both painted
   * nothing, and by two that both painted the wrong ore - this is the assertion
   * that says which entry landed where.
   */
  it("paints each entry's own map colour, at the counts measured", async () => {
    const e = await engine();
    const table: number[][] = [];
    for (const w of ORE_WINDOWS) {
      const px = new Uint8ClampedArray(runRenderRequest(oreRequest(w), e).buffer);
      table.push(
        VULCANUS_RESOURCE_CATALOG.map((entry) => {
          let n = 0;
          for (let i = 0; i < px.length; i += 4) if (isColor(px, i, entry.mapColor)) n++;
          return n;
        }),
      );
    }
    expect(table).toEqual(ORE_PIXELS);
    // All four entries reach a pixel somewhere in the set, so no entry is
    // graded only by its own zeros.
    const perEntry = VULCANUS_RESOURCE_CATALOG.map((_, i) =>
      table.reduce((a, row) => a + (row[i] as number), 0),
    );
    expect(perEntry.every((n) => n > 0)).toBe(true);
  }, 300000);

  /**
   * The geyser's 3x3 mark straddles worker-tile seams, so the resource view
   * needs the same halo the rock view does - and the same proof that it is
   * doing something.
   *
   * Run on the one window that has geysers. The three thresholded ores paint a
   * single pixel each and ignore the sweep box entirely, so without a geyser in
   * frame the second arm below would pass on a window where the halo changes
   * nothing.
   */
  it("tiles to the same bytes as one whole render, and the halo is what makes it so", async () => {
    const e = await engine();
    const w = ORE_WINDOWS[4] as Window;
    const whole = new Uint8ClampedArray(runRenderRequest(oreRequest(w), e).buffer);
    const full: ImageBox = {
      originX: w.originX,
      originY: w.originY,
      width: w.width,
      height: w.height,
      tilesPerPixel: w.tilesPerPixel,
    };
    const renderTiled = (halo: boolean): Uint8ClampedArray => {
      const tiles = planTiles(full, 32).map((t) => {
        const out = runRenderRequest(
          {
            ...oreRequest(w),
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

/**
 * Tier 3 for the `all` composite - terrain, then resources, then rocks, then
 * cliffs, in one request.
 *
 * Sent as one request rather than four for the reason `cliffs` is: every
 * overlay shares the whole field DAG below the tile argmax, so splitting them
 * would build that chain four times.
 */
describe("the WASM engine renders the Vulcanus composite exactly as the TypeScript does", () => {
  const allRequest = (w: Window): ElevationRenderRequest => ({ ...request(w), view: "all" });

  it("is byte-identical across four windows", async () => {
    const e = await engine();
    const counts: number[] = [];
    for (const w of WINDOWS) {
      const req = allRequest(w);
      const wasm = new Uint8ClampedArray(runRenderRequest(req, e).buffer);
      const ts = new Uint8ClampedArray(runRenderRequest(req).buffer);
      expect(Array.from(wasm), `${w.label}: pixels`).toEqual(Array.from(ts));
      freeze(w.label, "all", wasm, ts);
      counts.push(paintedOver(wasm, new Uint8ClampedArray(runRenderRequest(request(w), e).buffer)));
    }
    expect(counts).toEqual(ALL_PIXELS_PER_WINDOW);
  }, 300000);

  /**
   * The paint ORDER, asserted rather than described.
   *
   * Resources paint first and the two obstruction overlays over the top, so a
   * cliff or a rock crossing an ore patch reads as the thing that is in the
   * way. Reordering the three passes changes only the pixels where two of them
   * land, which is a few hundred out of 16,384 here - invisible to a
   * whole-image bound, and exactly what this counts.
   *
   * The numbers are frozen: 208 ore pixels are covered in this window, 2 by a
   * rock and 206 by a cliff. Painting rocks or cliffs FIRST would take all
   * three to zero.
   */
  it("paints resources first and the obstruction overlays over the top", async () => {
    const e = await engine();
    const w: Window = {
      label: "coarse, all four entries",
      width: 128,
      height: 128,
      originX: 0,
      originY: 0,
      tilesPerPixel: 8,
    };
    const geometry = {
      width: w.width,
      height: w.height,
      originX: w.originX,
      originY: w.originY,
      tilesPerPixel: w.tilesPerPixel,
    };
    const all = new Uint8ClampedArray(
      runRenderRequest({ ...request(w), ...geometry, view: "all" }, e).buffer,
    );
    const resources = new Uint8ClampedArray(
      runRenderRequest({ ...request(w), ...geometry, view: "resources" }, e).buffer,
    );

    const oreColors = VULCANUS_RESOURCE_CATALOG.map((p) => p.mapColor);
    let covered = 0;
    let byRock = 0;
    let byCliff = 0;
    for (let i = 0; i < all.length; i += 4) {
      if (!oreColors.some((c) => isColor(resources, i, c))) continue;
      if (oreColors.some((c) => isColor(all, i, c))) continue;
      covered++;
      if (isColor(all, i, ROCK_MAP_COLOR)) byRock++;
      if (isColor(all, i, CLIFF_MAP_COLOR)) byCliff++;
    }
    expect({ covered, byRock, byCliff }).toEqual({ covered: 208, byRock: 2, byCliff: 206 });
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
      freeze(w.label, "cliffs", wasm, ts);
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

describe("the tier-3 freeze covers this spec rather than merely existing", () => {
  // Declared last on purpose: tests run in declaration order within a file, so
  // this sees every `freeze` call the run made. See the same guard on
  // `wasmNauvisRenderParity.spec.ts`, where deleting one call site left all 37
  // other tests green.
  //
  // `expectRecordedRows` guards only a RECORD run, so without this a deleted
  // `freeze` call site would leave its row in the table un-consulted while
  // every gate stayed green. Both numbers are asserted because they fail on
  // opposite mistakes: the table count catches a re-record that wrote a
  // different surface, the consulted count catches a call site that stopped
  // asking.
  it.skipIf(RECORDING)("consults every frozen row exactly once", () => {
    expect(frozenCount(SECTION), "rows in the committed table").toBe(ROWS);
    expect(consultedCount(SECTION), "distinct rows this run looked up").toBe(ROWS);
  });
});
