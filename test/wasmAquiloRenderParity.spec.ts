import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng, type DecodedImage } from "./oracle/decodePng";
import realSurface from "./fixtures/oracle-aquilo-real-surface.seed123456.json";
import {
  consultedCount,
  expectFrozen,
  expectRecordedRows,
  flushRecording,
  foldPixels,
  frozenCount,
  RECORDING,
} from "./tier3Frozen";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import { planTiles, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";
import {
  compileEngine,
  instantiateEngine,
  renderThroughWasm,
  type EngineExports,
} from "../src/noise/wasm/engine";
import type { AquiloRenderRequest, AquiloResourceControls } from "../src/noise/wasm/request";

/**
 * **Tier 3 for Aquilo: the engine's pictures against a real surface and the
 * game's own preview.**
 *
 * Tier 1 grades each Aquilo field against game captures and tier 2 freezes
 * native-against-WASM folds. Neither looks at a picture. This file does, in
 * four ways:
 *
 * 1. The terrain render against `oracle-aquilo-real-surface.seed123456.json`,
 *    `get_tile` at every tile of -128..127 on a REAL generated surface (#454):
 *    0 of 65,536 pixels differ. This is the target, since Eric's ruling of
 *    2026-11-26 that the render should show what the map will actually look
 *    like. At one tile per pixel the engine runs tile correction after the
 *    argmax (`crates/fmw-noise/src/tiles/correction.rs`), as a real surface
 *    does and the preview does not.
 * 2. The terrain render against `oracle-preview-aquilo-terrain.seed123456.png`,
 *    every one of the 1,048,576 pixels, now as a REFERENCE: it differs exactly
 *    by the correction's footprint, 718 pixels. Before the correction it was 0.
 * 3. The composite, wells and icebergs included, against
 *    `oracle-preview-aquilo-full.seed123456.png`, every pixel (#492). The
 *    entities still match the preview's (#553 is about the real world's); the
 *    terrain under them differs by the correction's footprint. Plus a superset
 *    check on the entity footprint view.
 * 4. Byte-identity of the composites on small windows, frozen in
 *    `tier3-render-checksums.json` under `aquilo:render`, plus the tiling and
 *    slider checks that keep the worker pool honest.
 *
 * ## The seed and the levers must both match the capture
 *
 * The PNGs come from `--generate-map-preview --map-gen-seed 123456`, a MAP seed,
 * so every render compared with them uses the DERIVED surface seed. And the
 * terrain capture switched the three Aquilo resource controls to size 0. Those
 * controls reshape the islands (`aquilo_island_peaks` takes a max over their
 * spot fields), so a terrain render compared with that PNG sets all three to
 * size 0 as well. Both mismatches are asserted below rather than described,
 * because each one produces a count that looks like a broken port.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

let cachedEngine: EngineExports | undefined;
async function engine(): Promise<EngineExports> {
  cachedEngine ??= await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
  return cachedEngine;
}

/** Aquilo's surface seed at map seed 123456, 3,111,923,328. */
const SEED0 = surfaceSeedForPlanet("aquilo", 123456);

/** The game's own "off" for an autoplace control, as the terrain capture set it. */
const OFF = { frequency: 1, size: 0 } as const;
const LEVERS_OFF: AquiloResourceControls = {
  crudeOil: OFF,
  lithiumBrine: OFF,
  fluorineVent: OFF,
};

/** The PNG window: 1024 x 1024 at one tile per pixel, centred on the origin. */
const SIZE = 1024;
const PNG_WINDOW = {
  planet: "aquilo",
  seed0: SEED0,
  width: SIZE,
  height: SIZE,
  originX: -SIZE / 2,
  originY: -SIZE / 2,
  tilesPerPixel: 1,
} as const satisfies AquiloRenderRequest;

type Rgb = readonly [number, number, number];

/** `map_color` of each Aquilo tile. Ice-rough and ice-smooth share one. */
const TILE_COLORS: readonly Rgb[] = [
  [190, 194, 197], // snow-flat
  [179, 185, 192], // snow-crests
  [166, 174, 185], // snow-lumpy
  [156, 166, 181], // snow-patchy
  [100, 135, 177], // ice-rough, ice-smooth
  [21, 42, 56], // brash-ice
  [15, 13, 25], // ammoniacal-ocean
  [17, 15, 30], // ammoniacal-ocean-2
];

/**
 * The four entity colours, read off the full PNG's histogram (Task 6) and
 * matched there to each prototype's `map_color`. The engine paints the same
 * values: `AquiloWell::color` and `rocks::aquilo_icebergs::ICEBERG_COLOR`.
 */
const ENTITY_COLORS = {
  crudeOil: [198, 51, 196],
  lithiumBrine: [178, 255, 153],
  fluorineVent: [0, 204, 255],
  iceberg: [168, 188, 211],
} as const satisfies Record<string, Rgb>;
type EntityName = keyof typeof ENTITY_COLORS;
const ENTITY_NAMES = Object.keys(ENTITY_COLORS) as EntityName[];
const WELL_NAMES: readonly EntityName[] = ["crudeOil", "lithiumBrine", "fluorineVent"];

const colorKey = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
const TILE_KEYS = new Set(TILE_COLORS.map(([r, g, b]) => colorKey(r, g, b)));
const ENTITY_BY_KEY = new Map<number, EntityName>(
  ENTITY_NAMES.map((n) => {
    const [r, g, b] = ENTITY_COLORS[n];
    return [colorKey(r, g, b), n];
  }),
);

/** The game's colour at pixel `i`, as a key. */
const gameKey = (img: DecodedImage, i: number): number =>
  colorKey(img.rgb[i * 3] as number, img.rgb[i * 3 + 1] as number, img.rgb[i * 3 + 2] as number);
/** Our colour at pixel `i`, as a key. */
const oursKey = (px: ArrayLike<number>, i: number): number =>
  colorKey(px[i * 4] as number, px[i * 4 + 1] as number, px[i * 4 + 2] as number);

const pngCache = new Map<string, DecodedImage>();
function reference(name: string): DecodedImage {
  let img = pngCache.get(name);
  if (!img) {
    img = decodePng(
      new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name))),
      (b) => new Uint8Array(inflateSync(b)),
    );
    pngCache.set(name, img);
  }
  return img;
}
const terrainPng = (): DecodedImage => reference("oracle-preview-aquilo-terrain.seed123456.png");
const fullPng = (): DecodedImage => reference("oracle-preview-aquilo-full.seed123456.png");

/**
 * The 1024 renders, each made once per run. Several tests read the same one,
 * and a 1024 `all` render is the most expensive thing in this file. A copy is
 * kept, because the engine's output buffer is reused by the next render.
 */
const renderCache = new Map<string, Uint8ClampedArray>();
async function pngWindowRender(
  key: string,
  over: Partial<AquiloRenderRequest>,
): Promise<Uint8ClampedArray> {
  let px = renderCache.get(key);
  if (!px) {
    px = renderThroughWasm(await engine(), { ...PNG_WINDOW, ...over }).slice();
    renderCache.set(key, px);
  }
  return px;
}

/** Pixels where the game's RGB and ours differ. */
function countDiffering(game: DecodedImage, ours: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < game.width * game.height; i++) {
    if (gameKey(game, i) !== oursKey(ours, i)) n++;
  }
  return n;
}

/**
 * Whether some pixel within `radius` of (x, y) (a square, so Chebyshev
 * distance) satisfies `hit`. Out-of-image pixels never do.
 */
function anyWithin(
  x: number,
  y: number,
  radius: number,
  width: number,
  height: number,
  hit: (i: number) => boolean,
): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      if (hit(yy * width + xx)) return true;
    }
  }
  return false;
}

/** Per-entity pixel counts in an RGBA image. */
function entityCounts(px: ArrayLike<number>): Record<EntityName, number> {
  const out = { crudeOil: 0, lithiumBrine: 0, fluorineVent: 0, iceberg: 0 };
  for (let i = 0; i < px.length / 4; i++) {
    const n = ENTITY_BY_KEY.get(oursKey(px, i));
    if (n) out[n]++;
  }
  return out;
}

describe("the full PNG holds exactly the four entity colours the engine paints", () => {
  /**
   * Step 1 of the task, as an assertion. Task 6 read these four colours off
   * the histogram; if a re-capture brings a fifth (a new entity, a changed
   * `map_color`), everything below would grade it as terrain or ignore it.
   */
  it("every pixel is a tile colour or one of the four entity colours, at the frozen counts", () => {
    const full = fullPng();
    expect([full.width, full.height]).toEqual([SIZE, SIZE]);
    const other = new Map<number, number>();
    const counts = { crudeOil: 0, lithiumBrine: 0, fluorineVent: 0, iceberg: 0 };
    for (let i = 0; i < SIZE * SIZE; i++) {
      const k = gameKey(full, i);
      const n = ENTITY_BY_KEY.get(k);
      if (n) counts[n]++;
      else if (!TILE_KEYS.has(k)) other.set(k, (other.get(k) ?? 0) + 1);
    }
    expect([...other.entries()], "colours that are neither tile nor entity").toEqual([]);
    // A property of the PNG alone. No change to the port can move these.
    expect(counts).toEqual({ crudeOil: 475, lithiumBrine: 451, fluorineVent: 157, iceberg: 4609 });
  });

  it("the terrain PNG holds tile colours only", () => {
    const terrain = terrainPng();
    expect([terrain.width, terrain.height]).toEqual([SIZE, SIZE]);
    let nonTile = 0;
    for (let i = 0; i < SIZE * SIZE; i++) if (!TILE_KEYS.has(gameKey(terrain, i))) nonTile++;
    expect(nonTile).toBe(0);
  });
});

/** The real surface's window: -128..127 on both axes. */
const REAL_SIDE = realSurface.window.width;
const REAL_WINDOW = {
  ...PNG_WINDOW,
  view: "terrain",
  width: REAL_SIDE,
  height: REAL_SIDE,
  originX: realSurface.window.x0,
  originY: realSurface.window.y0,
  aquiloResourceControls: LEVERS_OFF,
} as const satisfies AquiloRenderRequest;

/** The real-surface fixture drawn in each tile's `map_color`, as the game reported it. */
function realSurfaceImage(): DecodedImage {
  const rgb = new Uint8Array(REAL_SIDE * REAL_SIDE * 3);
  let i = 0;
  for (const row of realSurface.rows) {
    for (const c of row) {
      const name = realSurface.names[
        realSurface.alphabet.indexOf(c)
      ] as keyof typeof realSurface.tiles;
      rgb.set(realSurface.tiles[name].mapColor, i * 3);
      i++;
    }
  }
  expect(i).toBe(REAL_SIDE * REAL_SIDE);
  return { width: REAL_SIDE, height: REAL_SIDE, rgb };
}

/** The real-surface window cut out of the centre of a 1024 PNG. */
function centreOf(png: DecodedImage): DecodedImage {
  const off = (png.width - REAL_SIDE) / 2;
  const rgb = new Uint8Array(REAL_SIDE * REAL_SIDE * 3);
  for (let y = 0; y < REAL_SIDE; y++) {
    const start = ((y + off) * png.width + off) * 3;
    rgb.set(png.rgb.subarray(start, start + REAL_SIDE * 3), y * REAL_SIDE * 3);
  }
  return { width: REAL_SIDE, height: REAL_SIDE, rgb };
}

let cachedRealWindow: Uint8ClampedArray | undefined;
async function realWindowRender(): Promise<Uint8ClampedArray> {
  cachedRealWindow ??= renderThroughWasm(await engine(), REAL_WINDOW).slice();
  return cachedRealWindow;
}

describe("the WASM engine against the real Aquilo surface", () => {
  it("the fixture is the derived seed's surface, terrain-only, levers off, one radius request", () => {
    expect(realSurface.surfaceSeed).toBe(SEED0);
    expect(realSurface.buildLine).toContain("Version: 2.1.23 ");
    expect(realSurface.chunkOrder).toBe("radius");
    expect(realSurface.pregenerated).toEqual([]);
    expect(realSurface.disabledControls).toEqual(
      expect.arrayContaining(["lithium_brine", "fluorine_vent", "aquilo_crude_oil"]),
    );
    expect(Object.keys(realSurface.counts)).toHaveLength(9);
  });

  /**
   * **0 of 65,536 pixels.** Exact, not a bound. Before tile correction was
   * wired into the Aquilo render it was 531, the whole gap between the preview
   * PNG and the real surface here. By tile NAME the Rust tests grade the same
   * window exactly too (`crates/fmw-noise/src/fixtures/aquilo_real_surface.rs`:
   * 551 names differ raw, 0 corrected).
   */
  const DIFFERING_PX_REAL = 0;

  it("matches the real surface at every pixel", async () => {
    const real = realSurfaceImage();
    const ours = await realWindowRender();
    const n = countDiffering(real, ours);
    withDiffArtifacts(
      {
        spec: "wasmAquiloRenderParity",
        case: "aquilo-terrain-vs-real-surface",
        game: real,
        ours: { width: REAL_SIDE, height: REAL_SIDE, rgba: ours },
      },
      () => {
        expect(n).toBe(DIFFERING_PX_REAL);
      },
    );
  }, 300000);

  /**
   * The control that the correction is in the render and that the preview is
   * the raw argmax: in this window the preview PNG differs from our render at
   * exactly the 531 pixels where it differs from the real surface.
   */
  it("differs from the preview PNG exactly where the real surface does", async () => {
    const png = centreOf(terrainPng());
    const real = realSurfaceImage();
    const ours = await realWindowRender();
    let onlyOne = 0;
    for (let i = 0; i < REAL_SIDE * REAL_SIDE; i++) {
      const p = gameKey(png, i);
      if ((p !== oursKey(ours, i)) !== (p !== gameKey(real, i))) onlyOne++;
    }
    expect(countDiffering(png, ours)).toBe(531);
    expect(onlyOne, "pixels where the PNG differs from one of the two only").toBe(0);
  }, 300000);
});

describe("the game's terrain PNG, for reference only", () => {
  /**
   * **718 of 1,048,576 pixels: the tile correction's footprint.** The preview
   * PNG shows the raw argmax and skips the correction a real surface runs, so
   * it is not the target and nothing may be tuned to it. Before the correction
   * was wired in this was 0 (from 2026-10-23 to 2026-11-26): the raw argmax is
   * the game's at every pixel.
   *
   * The 718 are where a real surface differs from the PNG. Against an
   * uncommitted 1024 x 1024 real surface (the same probe with the window
   * widened, 2026-11-26) the corrected tiles match `get_tile` at all
   * 1,048,576, and the raw argmax differs at 751 by name and 718 by colour. The
   * test above checks the 256 window of that against the committed fixture.
   *
   * Nothing is masked. The capture removed the icebergs with a data-stage mod
   * and switched the three wells off by control, so the reference is terrain
   * alone, and the assertion that it holds no entity colour is what names a
   * capture made without the mod before the count reports a render regression.
   */
  const DIFFERING_PX = 718;

  /**
   * The same comparison with the three resource controls left at the neutral
   * 1. The islands then take the shape the full PNG has, not the terrain
   * PNG's. If this ever falls to `DIFFERING_PX`, the levers have stopped
   * reaching the render and a matched pairing can no longer be told from a
   * mismatched one. It was 13,194 before the correction, which rewrites the
   * neutral-lever shores too.
   */
  const DIFFERING_PX_AT_DEFAULT_LEVERS = 13707;

  it("differs from the game's terrain PNG on exactly the frozen pixel count", async () => {
    const game = terrainPng();
    const ours = await pngWindowRender("terrain, levers off", {
      view: "terrain",
      aquiloResourceControls: LEVERS_OFF,
    });
    let entityPx = 0;
    for (let i = 0; i < SIZE * SIZE; i++) if (ENTITY_BY_KEY.has(gameKey(game, i))) entityPx++;
    const differing = countDiffering(game, ours);
    withDiffArtifacts(
      {
        spec: "wasmAquiloRenderParity",
        case: "aquilo-terrain-vs-game",
        game,
        ours: { width: SIZE, height: SIZE, rgba: ours },
      },
      () => {
        expect(entityPx, "entities in the reference - was it captured without the mod?").toBe(0);
        expect(differing).toBe(DIFFERING_PX);
      },
    );
  }, 300000);

  it("reports a large count with the resource levers left at neutral, so the levers are load-bearing", async () => {
    const ours = await pngWindowRender("terrain, levers neutral", { view: "terrain" });
    const differing = countDiffering(terrainPng(), ours);
    expect(differing).toBe(DIFFERING_PX_AT_DEFAULT_LEVERS);
    expect(differing).not.toBe(DIFFERING_PX);
  }, 300000);

  it("scores far worse at the raw map seed, which is what the seed trap looks like", async () => {
    // The 256 x 256 around spawn is enough to show it. The PNG's corners are
    // almost all ocean (10 land pixels in the top-left 256 x 256), so the
    // window has to hold land for the comparison to mean anything.
    const game = terrainPng();
    const SIDE = 256;
    const OFFSET = (SIZE - SIDE) / 2;
    const wrong = renderThroughWasm(await engine(), {
      ...PNG_WINDOW,
      view: "terrain",
      seed0: 123456,
      width: SIDE,
      height: SIDE,
      originX: -SIDE / 2,
      originY: -SIDE / 2,
      aquiloResourceControls: LEVERS_OFF,
    });
    let differing = 0;
    let land = 0;
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        const k = gameKey(game, (y + OFFSET) * SIZE + x + OFFSET);
        // Aquilo is mostly ocean, so the share of all pixels says little. Count
        // where the game drew land or ice and the wrong seed did not agree.
        if (k === colorKey(15, 13, 25) || k === colorKey(17, 15, 30)) continue;
        land++;
        if (k !== oursKey(wrong, y * SIDE + x)) differing++;
      }
    }
    expect(land, `land ${String(land)}, differing ${String(differing)}`).toBeGreaterThan(1000);
    expect(differing / land).toBeGreaterThan(0.5);
  }, 300000);
});

describe("the WASM engine draws the game's full preview, entities included", () => {
  /**
   * **Our composite against the game's full preview, every pixel, nothing
   * masked.** The full PNG is the only reference with the resource controls at
   * NEUTRAL, so it grades the island shapes at default sliders as well as
   * every well and iceberg.
   *
   * The entities come from the game's own per-chunk generator
   * (`crates/fmw-noise/src/placement/generate.rs`, #492): one unsalted taus88
   * stream per chunk shared by the five autoplace groups, jitter included, and
   * drawn by the preview's rule - no entity-against-entity collision, each
   * entity clipped to its own chunk, the first queued winning an overlap. The
   * per-colour counts are asserted beside the total so a failure says which
   * layer moved.
   *
   * **3 entity pixels differ, all at the capture's bottom edge, and they are frozen
   * there.** They belong to one huge iceberg at (211.375, 511.6875) whose box
   * reaches tile row 512, one past the 1024-tile capture. The game did not
   * draw it; we do. The leading explanation is that the preview generates
   * tiles only inside its own area, so the generator's tile check finds no
   * ground past the edge. That was seen once, not read from code. Only 4 of
   * our entities cross the capture edge at all, and the other 3 (big icebergs
   * beside it) are fully covered by neighbours, so they cannot confirm or
   * refute it. The app renders a continuous map, so the engine does not copy
   * an edge that only a fixed-size capture has. Inside a border of
   * `EDGE_PX` pixels - more than any Aquilo box reaches - no entity pixel
   * differs.
   *
   * **The terrain under the entities is the real surface's, not the
   * preview's (#454), so it differs from this PNG at `TERRAIN_PX` pixels**,
   * every one a tile colour on both sides. That is the tile correction's
   * footprint at neutral levers where no entity covers it. Against an
   * uncommitted 1024 x 1024 real surface at neutral levers with every entity
   * autoplace removed (2026-11-26), the corrected terrain matches `get_tile` at
   * all 1,048,576 tiles and the raw argmax differs at 1,358 by colour. On the
   * 1,042,881 pixels where both images show a tile, our render differs from
   * this PNG at exactly the 1,064 where that real surface does. It was 0 before
   * the correction. The entities are still the preview's (#553).
   */
  const TERRAIN_PX = 1064;

  it("matches the full PNG on every entity pixel; the terrain differs by the correction", async () => {
    const game = fullPng();
    const ours = await pngWindowRender("all, levers neutral", { view: "all" });
    const EDGE_PX = 4;
    let differing = 0;
    let entityInside = 0;
    let terrainOnly = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = y * SIZE + x;
        const g = gameKey(game, i);
        const o = oursKey(ours, i);
        if (g === o) continue;
        differing++;
        if (TILE_KEYS.has(g) && TILE_KEYS.has(o)) {
          terrainOnly++;
          continue;
        }
        const inside = x >= EDGE_PX && y >= EDGE_PX && x < SIZE - EDGE_PX && y < SIZE - EDGE_PX;
        if (inside) entityInside++;
      }
    }
    let gameEntities = { crudeOil: 0, lithiumBrine: 0, fluorineVent: 0, iceberg: 0 };
    for (let i = 0; i < SIZE * SIZE; i++) {
      const n = ENTITY_BY_KEY.get(gameKey(game, i));
      if (n) gameEntities = { ...gameEntities, [n]: gameEntities[n] + 1 };
    }
    withDiffArtifacts(
      {
        spec: "wasmAquiloRenderParity",
        case: "aquilo-full-vs-game",
        game,
        ours: { width: SIZE, height: SIZE, rgba: ours },
      },
      () => {
        expect(entityInside).toBe(0);
        expect(terrainOnly).toBe(TERRAIN_PX);
        expect(differing).toBe(TERRAIN_PX + 3);
        expect(entityCounts(ours)).toEqual({ ...gameEntities, iceberg: gameEntities.iceberg + 3 });
      },
    );
  }, 300000);
});

describe("the WASM engine's entity footprint contains every entity the game drew", () => {
  /**
   * A SUPERSET check. The footprint is white where any well, or an iceberg on a
   * land tile, has a probability above 0; no roll and no collision test. Every
   * entity pixel the game drew should sit on or next to a white pixel.
   *
   * **Grown by one pixel, 7 game pixels fall outside, all iceberg.** The game
   * draws a huge iceberg at its own size, 3.7 x 2.5 tiles, so its far edge can
   * sit two pixels from the tile it was rolled on. Grown by two pixels the
   * footprint holds every one. Both numbers are frozen, so a footprint that
   * shrinks shows at once at either radius.
   */
  it("the footprint contains every entity pixel the game drew", async () => {
    const game = fullPng();
    const footprint = await pngWindowRender("footprint", { view: "entityFootprint" });
    const white = (i: number): boolean => footprint[i * 4] !== 0;
    const outsideAt = (radius: number): Record<EntityName, number> => {
      const out = { crudeOil: 0, lithiumBrine: 0, fluorineVent: 0, iceberg: 0 };
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const n = ENTITY_BY_KEY.get(gameKey(game, y * SIZE + x));
          if (!n) continue;
          if (!anyWithin(x, y, radius, SIZE, SIZE, white)) out[n]++;
        }
      }
      return out;
    };
    let gameEntityPx = 0;
    for (let i = 0; i < SIZE * SIZE; i++) if (ENTITY_BY_KEY.has(gameKey(game, i))) gameEntityPx++;
    expect(gameEntityPx).toBe(5692);
    expect(outsideAt(1)).toEqual({
      crudeOil: 0,
      lithiumBrine: 0,
      fluorineVent: 0,
      iceberg: 7,
    });
    expect(outsideAt(2)).toEqual({
      crudeOil: 0,
      lithiumBrine: 0,
      fluorineVent: 0,
      iceberg: 0,
    });
  }, 300000);

  it("the footprint is neither empty nor more than 10% of the window, so the superset is not free", async () => {
    const footprint = await pngWindowRender("footprint", { view: "entityFootprint" });
    let painted = 0;
    for (let i = 0; i < SIZE * SIZE; i++) if (footprint[i * 4] !== 0) painted++;
    const share = painted / (SIZE * SIZE);
    expect(share).toBeGreaterThan(0.01);
    expect(share).toBeLessThan(0.1);
  }, 300000);
});

/**
 * The tier-3 freeze section for this spec. See `tier3Frozen.ts`.
 *
 * Every Aquilo render is graded against values recorded on 2026-10-23, the
 * day the terrain gap above was measured at 0. There is no TypeScript arm and
 * never was, so these rows are the only thing that notices a byte moving.
 */
const SECTION = "aquilo:render";

interface Window {
  readonly label: string;
  readonly originX: number;
  readonly originY: number;
}

/**
 * Two 128 x 128 windows, each chosen from a sweep of the composite to hold
 * at least one well and one iceberg (asserted below, not assumed).
 *
 * - **spawn**: the tiny fluorine vent near spawn at (-41, -68), crude oil and
 *   dense icebergs.
 * - **lithium, north-east**: a lithium brine field with icebergs, at an origin
 *   off the 32-tile chunk grid, where lithium brine and icebergs overlap.
 *
 * Between them the two windows carry all three well colours.
 */
const WINDOWS: readonly Window[] = [
  { label: "spawn", originX: -64, originY: -128 },
  { label: "lithium, north-east", originX: 131, originY: -447 },
];
const WINDOW_SIDE = 128;
const VIEWS = ["terrain", "resources", "rocks", "all"] as const;

/**
 * Rows this spec must record: 4 views x 2 windows, plus one slider case per
 * lever. Kept as a literal so a record run that falls short drops the section
 * rather than writing a short table.
 */
const ROWS = 14;

expectRecordedRows(SECTION, ROWS);
afterAll(flushRecording);

function windowRequest(w: Window, over: Partial<AquiloRenderRequest> = {}): AquiloRenderRequest {
  return {
    planet: "aquilo",
    seed0: SEED0,
    width: WINDOW_SIDE,
    height: WINDOW_SIDE,
    originX: w.originX,
    originY: w.originY,
    tilesPerPixel: 1,
    ...over,
  };
}

describe("the WASM engine renders Aquilo's views to their frozen bytes", () => {
  it.each(VIEWS)("renders %s to its frozen bytes on every window", async (view) => {
    const e = await engine();
    for (const w of WINDOWS) {
      const px = renderThroughWasm(e, windowRequest(w, { view }));
      expect(px.length, `${w.label}: length`).toBe(WINDOW_SIDE * WINDOW_SIDE * 4);
      expectFrozen(SECTION, w.label, view, foldPixels(px));
    }
  });

  /**
   * "A window must contain the thing it grades." Each window's composite holds
   * a well and an iceberg, and its rocks view really paints `ICEBERG_COLOR`.
   * The rocks view can show MORE iceberg pixels than the composite, never
   * fewer: in the composite an earlier-queued well keeps a tile both cover
   * (see the overlap test below).
   */
  it("every window holds a well and an iceberg, and the rocks view paints icebergs", async () => {
    const e = await engine();
    const seen = new Set<EntityName>();
    for (const w of WINDOWS) {
      const all = entityCounts(renderThroughWasm(e, windowRequest(w, { view: "all" })));
      const wells = WELL_NAMES.reduce((s, n) => s + all[n], 0);
      expect(wells, `${w.label}: well pixels`).toBeGreaterThanOrEqual(9);
      expect(all.iceberg, `${w.label}: iceberg pixels`).toBeGreaterThanOrEqual(9);
      for (const n of WELL_NAMES) if (all[n] > 0) seen.add(n);
      const rocks = entityCounts(renderThroughWasm(e, windowRequest(w, { view: "rocks" })));
      expect(rocks.iceberg, `${w.label}: rocks view iceberg pixels`).toBeGreaterThan(0);
      expect(
        rocks.iceberg,
        `${w.label}: the composite hides no iceberg pixel the rocks view lacks`,
      ).toBeGreaterThanOrEqual(all.iceberg);
    }
    expect([...seen].sort(), "all three wells across the two windows").toEqual(
      [...WELL_NAMES].sort(),
    );
  });

  /**
   * Where a well and an iceberg cover the same tile, the one the game queued
   * FIRST is drawn. The groups queue in autoplace `order`: fluorine vent and
   * lithium brine before the icebergs, crude oil after them. So the composite
   * shows brine or vent over an iceberg, and an iceberg over crude oil. Both
   * kinds of overlap are found from the two single-layer views over both
   * windows; each must occur, so neither half of the rule is vacuous.
   */
  it("an overlap shows whichever entity the game queued first", async () => {
    const e = await engine();
    const iceberg = colorKey(...ENTITY_COLORS.iceberg);
    const seen = { earlyWellOverIceberg: 0, icebergOverCrude: 0 };
    for (const w of WINDOWS) {
      const resources = renderThroughWasm(e, windowRequest(w, { view: "resources" })).slice();
      const rocks = renderThroughWasm(e, windowRequest(w, { view: "rocks" })).slice();
      const all = renderThroughWasm(e, windowRequest(w, { view: "all" }));
      for (let i = 0; i < WINDOW_SIDE * WINDOW_SIDE; i++) {
        const well = ENTITY_BY_KEY.get(oursKey(resources, i));
        if (!well || oursKey(rocks, i) !== iceberg) continue;
        if (well === "crudeOil") {
          seen.icebergOverCrude++;
          expect(oursKey(all, i), `${w.label}: iceberg over crude oil`).toBe(iceberg);
        } else {
          seen.earlyWellOverIceberg++;
          expect(oursKey(all, i), `${w.label}: ${well} over an iceberg`).toBe(
            oursKey(resources, i),
          );
        }
      }
    }
    expect(seen.earlyWellOverIceberg).toBeGreaterThan(0);
    expect(seen.icebergOverCrude).toBeGreaterThan(0);
  });

  it("the windows are not the same picture", async () => {
    const e = await engine();
    const digests = WINDOWS.map((w) =>
      foldPixels(renderThroughWasm(e, windowRequest(w, { view: "all" }))),
    );
    expect(new Set(digests).size).toBe(WINDOWS.length);
  });
});

describe("tiled equals whole for the all view", () => {
  /**
   * 256 x 256 as one request against the same window cut into tiles. Since
   * #492 a pixel reads only its own chunk's entities (the preview draws each
   * entity inside its own chunk only), so the tiles need no halo at all, and
   * the worker pool's `placementSweepBox` is not read for Aquilo.
   *
   * The tiles are 100 pixels wide, so their seams at x = -28 and x = 72 cut
   * through chunks rather than along chunk lines. That is the case a
   * chunk-local cache could get wrong, and the control below shows entities
   * really are drawn across those seams.
   */
  const FULL: ImageBox = {
    originX: -128,
    originY: -128,
    width: 256,
    height: 256,
    tilesPerPixel: 1,
  };
  const base: AquiloRenderRequest = {
    planet: "aquilo",
    seed0: SEED0,
    view: "all",
    ...FULL,
  };
  const TILE_PX = 100;

  it("tiled equals whole for the all view, with seams inside chunks", async () => {
    const e = await engine();
    const whole = renderThroughWasm(e, base).slice();
    const counts = entityCounts(whole);
    for (const n of ENTITY_NAMES) expect(counts[n], `${n} pixels in the window`).toBeGreaterThan(0);
    const tiles = planTiles(FULL, TILE_PX).map((t) => {
      const sub: AquiloRenderRequest = {
        ...base,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
      };
      return { ...t, data: renderThroughWasm(e, sub).slice() };
    });
    expect(stitchTiles(FULL, tiles)).toEqual(whole);
  });

  it("entities are drawn across the tile seams, so the test above can fail", async () => {
    const e = await engine();
    const whole = renderThroughWasm(e, base);
    // Entity pixels on both sides of a vertical seam, in the same row.
    let straddling = 0;
    for (const seam of [TILE_PX, 2 * TILE_PX]) {
      for (let y = 0; y < FULL.height; y++) {
        const left = ENTITY_BY_KEY.get(oursKey(whole, y * FULL.width + seam - 1));
        const right = ENTITY_BY_KEY.get(oursKey(whole, y * FULL.width + seam));
        if (left && right) straddling++;
      }
    }
    expect(straddling).toBeGreaterThan(0);
  });
});

describe("each slider crosses the ABI", () => {
  /**
   * Moving any one of the six levers changes the composite. One lever at a
   * time, because moving two together lets a module that ignores one of them
   * pass.
   *
   * **The windows were swept for, because most windows are dead to most
   * levers.** Measured 2026-10-23 on 256 x 256 composites, one lever at a time:
   * the window around spawn does not move for a size of 0.25, 0.5, 2 or 4 on
   * any of the three wells, only for 0, and a
   * window moves only for the wells whose fields reach it. The crude-and-lithium window
   * below moves 2,048 / 1,585 / 1,391 / 2,481 pixels for crude frequency, crude
   * size, lithium frequency and lithium size at 2; the fluorine window moves
   * 2,307 and 3,092 for fluorine frequency and size at 2.
   */
  const CRUDE_LITHIUM: Window = { label: "crude and lithium, west", originX: -512, originY: -192 };
  const FLUORINE: Window = { label: "fluorine, north-west", originX: -192, originY: -448 };
  const SLIDER_SIDE = 256;
  const CASES: readonly {
    label: string;
    window: Window;
    controls: AquiloResourceControls;
  }[] = [
    {
      label: "crude oil frequency",
      window: CRUDE_LITHIUM,
      controls: { crudeOil: { frequency: 2 } },
    },
    { label: "crude oil size", window: CRUDE_LITHIUM, controls: { crudeOil: { size: 2 } } },
    {
      label: "lithium brine frequency",
      window: CRUDE_LITHIUM,
      controls: { lithiumBrine: { frequency: 2 } },
    },
    { label: "lithium brine size", window: CRUDE_LITHIUM, controls: { lithiumBrine: { size: 2 } } },
    {
      label: "fluorine vent frequency",
      window: FLUORINE,
      controls: { fluorineVent: { frequency: 2 } },
    },
    { label: "fluorine vent size", window: FLUORINE, controls: { fluorineVent: { size: 2 } } },
  ];

  const request = (w: Window, controls?: AquiloResourceControls): AquiloRenderRequest =>
    windowRequest(w, {
      view: "all",
      width: SLIDER_SIDE,
      height: SLIDER_SIDE,
      ...(controls ? { aquiloResourceControls: controls } : {}),
    });

  // Two windows, three cases each: render each neutral picture once.
  const neutralByWindow = new Map<string, Uint8ClampedArray>();

  it.each(CASES)("$label changes the picture and renders to its frozen bytes", async (c) => {
    const e = await engine();
    let neutral = neutralByWindow.get(c.window.label);
    if (!neutral) {
      neutral = renderThroughWasm(e, request(c.window)).slice();
      neutralByWindow.set(c.window.label, neutral);
    }
    const moved = renderThroughWasm(e, request(c.window, c.controls));
    expect(Array.from(moved)).not.toEqual(Array.from(neutral));
    expectFrozen(SECTION, `slider ${c.label}`, "all", foldPixels(moved));
  });
});

describe("the tier-3 freeze covers this spec rather than merely existing", () => {
  it.skipIf(RECORDING)("consults every frozen row exactly once", () => {
    expect(frozenCount(SECTION), "rows in the committed table").toBe(ROWS);
    expect(consultedCount(SECTION), "distinct rows this run looked up").toBe(ROWS);
  });
});
