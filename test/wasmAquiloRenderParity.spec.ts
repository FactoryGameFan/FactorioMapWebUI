import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import { decodePng, type DecodedImage } from "./oracle/decodePng";
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
import {
  placementMarkSweepBox,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { planTiles, stitchTiles, type ImageBox } from "../src/noise/preview/tiling";
import {
  compileEngine,
  instantiateEngine,
  renderThroughWasm,
  type EngineExports,
} from "../src/noise/wasm/engine";
import type { AquiloRenderRequest, AquiloResourceControls } from "../src/noise/wasm/request";

/**
 * **Tier 3 for Aquilo: the engine's pictures against the game's own preview.**
 *
 * Tier 1 grades each Aquilo field against game captures and tier 2 freezes
 * native-against-WASM folds. Neither looks at a picture. This file does, in
 * three ways:
 *
 * 1. The terrain render against `oracle-preview-aquilo-terrain.seed123456.png`,
 *    every one of the 1,048,576 pixels, frozen as an exact count. This is the
 *    first time the whole Aquilo terrain is graded as an image, so it is the
 *    main result of the port.
 * 2. The entity layers (three wells, one iceberg colour) against
 *    `oracle-preview-aquilo-full.seed123456.png`, as a superset check on the
 *    footprint and a per-colour nearness count on the composite.
 * 3. Byte-identity of the composites on small windows, frozen in
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

/**
 * The radius of the 3x3 mark a well or an iceberg paints. The engine's copy is
 * `PLACEMENT_MARK_RADIUS_PX` in `crates/fmw-noise/src/placement/roll.rs`, and
 * the worker pool's is the private one in `elevationRenderRequest.ts` that
 * `placementMarkSweepBox` widens by. The tiling test below asserts that box is
 * widened by exactly this much, so the three cannot drift apart silently.
 */
const PLACEMENT_MARK_RADIUS_PX = 1;

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

describe("the WASM engine agrees with the game's Aquilo terrain PNG", () => {
  /**
   * **The terrain gap: 0 of 1,048,576 pixels.** Exact, not a bound. The ship
   * bar was below 1,048 (0.1%). Measured 2026-10-23 on the first run; nothing
   * had to be fixed to reach it, which makes the two controls below the part
   * that says it means something.
   *
   * Nothing is masked. The capture removed the icebergs with a data-stage mod
   * and switched the three wells off by control, so the reference is terrain
   * alone, and the assertion that it holds no entity colour is what names a
   * capture made without the mod before the count reports a render regression.
   */
  const DIFFERING_PX = 0;

  /**
   * The same comparison with the three resource controls left at the neutral
   * 1. The islands then take the shape the full PNG has, not the terrain
   * PNG's. If this ever falls to `DIFFERING_PX`, the levers have stopped
   * reaching the render and a matched pairing can no longer be told from a
   * mismatched one.
   */
  const DIFFERING_PX_AT_DEFAULT_LEVERS = 13194;

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

/**
 * One mask, built once, used by both the counter and the diff artifacts.
 * Written out twice, the two copies would drift, and the artifacts would then
 * describe a different comparison from the one that failed.
 *
 * A pixel is graded when the game drew a TILE colour there and no entity
 * colour within `ENTITY_MASK_RADIUS_PX` of it (a square, so Chebyshev
 * distance). The radius keeps the comparison off the ground right beside an
 * entity, where the game's mark edge and the tile under it meet. The count does
 * not hang on the choice: measured 2026-10-23, radii 1 to 5 all give 0
 * differing pixels; the radius only decides how many pixels are compared.
 */
const ENTITY_MASK_RADIUS_PX = 3;
let ignoredMask: Uint8Array | undefined;
function fullPngIgnoreMask(): Uint8Array {
  if (ignoredMask) return ignoredMask;
  const game = fullPng();
  const mask = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const notTile = !TILE_KEYS.has(gameKey(game, i));
      const nearEntity = anyWithin(x, y, ENTITY_MASK_RADIUS_PX, SIZE, SIZE, (j) =>
        ENTITY_BY_KEY.has(gameKey(game, j)),
      );
      if (notTile || nearEntity) mask[i] = 1;
    }
  }
  ignoredMask = mask;
  return mask;
}

describe("the WASM engine agrees with the full PNG on the tiles the game drew", () => {
  /**
   * The only reference with the resource controls at NEUTRAL, so the only one
   * that grades the island shapes the three spot fields give at default
   * sliders. The terrain test above grades them at size 0.
   *
   * **Our TERRAIN view, not our composite.** Our wells and icebergs land where
   * our roll put them, and the roll's salt is ours, so the composite would add
   * every mark of ours the game has no mark beside (1,102 pixels, measured) to
   * a count meant to grade tiles. Where the marks land is graded by the
   * per-colour test further down.
   */
  it("matches the full PNG on the tiles the game drew", async () => {
    const game = fullPng();
    const ours = await pngWindowRender("terrain, levers neutral", { view: "terrain" });
    const mask = fullPngIgnoreMask();
    const ignore = (i: number): boolean => mask[i] === 1;
    let compared = 0;
    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (ignore(i)) continue;
      compared++;
      if (gameKey(game, i) !== oursKey(ours, i)) differing++;
    }
    withDiffArtifacts(
      {
        spec: "wasmAquiloRenderParity",
        case: "aquilo-full-tiles-vs-game",
        game,
        ours: { width: SIZE, height: SIZE, rgba: ours },
        ignore,
      },
      () => {
        // Anti-vacuity: the mask leaves almost the whole image to compare.
        expect(compared).toBe(1023862);
        expect(differing).toBe(0);
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
   * **At the mark radius, 7 game pixels fall outside, all iceberg.** The game
   * draws a huge iceberg at its own size, 3.7 x 2.5 tiles, so its far edge can
   * sit two pixels from its centre tile, one more than the 3x3 mark we paint.
   * Grown by two pixels the footprint holds every one. Both numbers are frozen,
   * so a footprint that shrinks (or a placement that moves out of it) shows at
   * once at either radius.
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
    expect(outsideAt(PLACEMENT_MARK_RADIUS_PX)).toEqual({
      crudeOil: 0,
      lithiumBrine: 0,
      fluorineVent: 0,
      iceberg: 7,
    });
    expect(outsideAt(PLACEMENT_MARK_RADIUS_PX + 1)).toEqual({
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

describe("each entity colour lands near the game's own marks of that colour", () => {
  /**
   * The union footprint above cannot see a well's identity, so it cannot tell
   * crude oil from lithium brine. (Under the planted bearing swap it did go red,
   * but only because the swap also moved the islands: the terrain gap became
   * 1,189.) This counts, per
   * colour, the game's pixels of that colour with no pixel of the SAME colour in
   * our default-lever composite within `2 * PLACEMENT_MARK_RADIUS_PX + 1`
   * pixels (two marks' radii plus one pixel of slack). A swap moves these.
   *
   * The counts are large for the wells because the placement roll's salt is
   * ours, so individual wells land elsewhere; they are frozen as a fingerprint,
   * not as a quality score. Icebergs are dense, so theirs is small. Our own
   * pixel count per colour is frozen beside them, as is the game's.
   */
  const NEAR_PX = 2 * PLACEMENT_MARK_RADIUS_PX + 1;

  it("the per-colour unmatched counts are frozen", async () => {
    const game = fullPng();
    const ours = await pngWindowRender("all, levers neutral", { view: "all" });
    const unmatched = { crudeOil: 0, lithiumBrine: 0, fluorineVent: 0, iceberg: 0 };
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const k = gameKey(game, y * SIZE + x);
        const n = ENTITY_BY_KEY.get(k);
        if (!n) continue;
        if (!anyWithin(x, y, NEAR_PX, SIZE, SIZE, (j) => oursKey(ours, j) === k)) unmatched[n]++;
      }
    }
    expect(entityCounts(ours)).toEqual({
      crudeOil: 295,
      lithiumBrine: 444,
      fluorineVent: 189,
      iceberg: 4716,
    });
    expect(unmatched).toEqual({
      crudeOil: 396,
      lithiumBrine: 257,
      fluorineVent: 130,
      iceberg: 122,
    });
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
 * at least one well mark and one iceberg mark (asserted below, not assumed).
 *
 * - **spawn**: the tiny fluorine vent near spawn at (-41, -68), crude oil and
 *   dense icebergs.
 * - **lithium, north-east**: a lithium brine field with icebergs, at an origin
 *   off the 32-tile chunk grid. It holds 14 pixels where a lithium mark and an
 *   iceberg mark overlap.
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
   * a well mark and an iceberg mark, and its rocks view really paints
   * `ICEBERG_COLOR` - the only render test that shows the icebergs painting.
   */
  it("every window holds a well mark and an iceberg mark, and the rocks view paints icebergs", async () => {
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
      expect(rocks.iceberg, `${w.label}: the composite draws every iceberg pixel`).toBe(
        all.iceberg,
      );
    }
    expect([...seen].sort(), "all three wells across the two windows").toEqual(
      [...WELL_NAMES].sort(),
    );
  });

  /**
   * Icebergs paint after wells, so a pixel both marks cover shows the iceberg.
   * The north-east window has such pixels; this finds them from the two
   * single-layer views and checks the composite at each.
   */
  it("an iceberg mark over a well mark shows the iceberg", async () => {
    const e = await engine();
    const w = WINDOWS[1] as Window;
    const resources = renderThroughWasm(e, windowRequest(w, { view: "resources" })).slice();
    const rocks = renderThroughWasm(e, windowRequest(w, { view: "rocks" })).slice();
    const all = renderThroughWasm(e, windowRequest(w, { view: "all" }));
    const iceberg = colorKey(...ENTITY_COLORS.iceberg);
    let both = 0;
    let icebergWins = 0;
    for (let i = 0; i < WINDOW_SIDE * WINDOW_SIDE; i++) {
      const well = ENTITY_BY_KEY.get(oursKey(resources, i));
      if (!well || well === "iceberg" || oursKey(rocks, i) !== iceberg) continue;
      both++;
      if (oursKey(all, i) === iceberg) icebergWins++;
    }
    expect(both).toBe(14);
    expect(icebergWins).toBe(both);
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
   * 256 x 256 as one request against the same window as four 128 x 128
   * requests, each carrying the halo-widened `placementSweepBox` the worker
   * pool sends. A well or iceberg centred just outside a tile still owes that
   * tile part of its 3x3 mark.
   *
   * The window holds spawn, so it carries all three wells and the tiny vent,
   * and its seams at x = 0 and y = 0 cross marks (the no-halo control below
   * shows they do).
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

  function renderTiled(e: EngineExports, halo: boolean): Uint8ClampedArray {
    const fullImage = {
      originX: FULL.originX,
      originY: FULL.originY,
      width: FULL.width,
      height: FULL.height,
    };
    const tiles = planTiles(FULL, 128).map((t) => {
      const sub: AquiloRenderRequest = {
        ...base,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
      };
      // The box the worker pool computes. Only the geometry fields are read.
      const box = placementMarkSweepBox({ ...sub, fullImage } as unknown as ElevationRenderRequest);
      const req = halo ? { ...sub, placementSweepBox: box } : sub;
      return { ...t, data: renderThroughWasm(e, req).slice() };
    });
    return stitchTiles(FULL, tiles);
  }

  it("tiled equals whole for the all view", async () => {
    const e = await engine();
    const whole = renderThroughWasm(e, base).slice();
    const counts = entityCounts(whole);
    for (const n of ENTITY_NAMES) expect(counts[n], `${n} pixels in the window`).toBeGreaterThan(0);
    expect(renderTiled(e, true)).toEqual(whole);
  });

  it("without the halo the tiles do NOT match, so the test above can fail", async () => {
    const e = await engine();
    const whole = renderThroughWasm(e, base).slice();
    const tiled = renderTiled(e, false);
    let differing = 0;
    for (let i = 0; i < whole.length; i++) if (whole[i] !== tiled[i]) differing++;
    expect(differing).toBe(84);
  });

  it("the worker pool's halo is exactly the mark radius", () => {
    const sub = { originX: 0, originY: 0, width: 128, height: 128, tilesPerPixel: 1 };
    const box = placementMarkSweepBox({
      ...sub,
      fullImage: { originX: -128, originY: -128, width: 256, height: 256 },
    } as unknown as ElevationRenderRequest);
    expect(box).toEqual({
      x0: -PLACEMENT_MARK_RADIUS_PX,
      y0: -PLACEMENT_MARK_RADIUS_PX,
      x1: 128,
      y1: 128,
    });
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
