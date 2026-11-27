import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import graded from "./fixtures/oracle-gleba-real-surface-entities.seed123456.json";
import defaults from "./fixtures/oracle-gleba-real-surface-entities-default.seed123456.json";
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
 * **Tier 3 for Gleba's stone and stromatolites (#454, slice 3), against a REAL
 * surface.**
 *
 * The reference is `oracle-gleba-real-surface-entities.seed123456.json`: every
 * `stone`, `iron-stromatolite` and `copper-stromatolite` on a generated Gleba
 * surface at map seed 123456 over -512..511, at its exact position, with
 * plants, pentapod nests and cliffs switched off so that nothing else can
 * take their place (`scripts/probes/gleba-entities`). The engine places them
 * with the game's per-chunk generator and the apply step's collision, which
 * the game's map preview skips: without that step the same window would show
 * 8,631 entities instead of 5,193 (`fixtures/gleba_entities.rs`).
 *
 * The render paints each entity over its footprint in its map colour, so the
 * expected picture here is OUR terrain render with the GAME's entities
 * painted on it by the same rule. A pixel that differs is an entity in the
 * wrong place, a missing one or an extra one. The terrain itself is graded in
 * `wasmGlebaRenderParity.spec.ts`.
 *
 * By position, the Rust tests replay the same window exactly:
 * `gleba_entities_replay_the_real_surface` in
 * `crates/fmw-noise/src/fixtures/gleba_entities.rs`.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

let cachedEngine: EngineExports | undefined;
async function engine(): Promise<EngineExports> {
  cachedEngine ??= await instantiateEngine(await compileEngine(readFileSync(wasmPath)));
  return cachedEngine;
}

const SEED0 = surfaceSeedForPlanet("gleba", 123456);
const SIDE = graded.window.width;
const X0 = graded.window.x0;

const WINDOW = {
  planet: "gleba",
  view: "resources",
  seed0: SEED0,
  width: SIDE,
  height: SIDE,
  originX: X0,
  originY: X0,
  tilesPerPixel: 1,
} as const satisfies GlebaRenderRequest;

/** Map colours, as the engine paints them (`GlebaEntity::color`). */
const STROMATOLITE: readonly number[] = [129, 105, 78];
const STONE: readonly number[] = [175, 155, 108];

/** Half the map-gen box of each fixture name, in 1/256 tile. */
const HALF: Record<string, number> = {
  "copper-stromatolite": 128,
  "iron-stromatolite": 128,
  stone: 25,
};
const COLOR: Record<string, readonly number[]> = {
  "copper-stromatolite": STROMATOLITE,
  "iron-stromatolite": STROMATOLITE,
  stone: STONE,
};

type Fixture = { names: string[]; entities: number[][] };

/**
 * `terrain` with the fixture's entities painted on it: each covers the tiles
 * `floor(left)` to `ceil(right) - 1` on each axis.
 */
function expected(terrain: Uint8ClampedArray, f: Fixture): Uint8ClampedArray {
  const out = terrain.slice();
  for (const [k, x, y] of f.entities) {
    const name = f.names[k as number] as string;
    const half = HALF[name] as number;
    const color = COLOR[name] as readonly number[];
    const fx0 = Math.floor(((x as number) - half) / 256);
    const fx1 = Math.floor(((x as number) + half - 1) / 256);
    const fy0 = Math.floor(((y as number) - half) / 256);
    const fy1 = Math.floor(((y as number) + half - 1) / 256);
    for (let ty = Math.max(fy0, X0); ty <= Math.min(fy1, X0 + SIDE - 1); ty++) {
      for (let tx = Math.max(fx0, X0); tx <= Math.min(fx1, X0 + SIDE - 1); tx++) {
        out.set(color, ((ty - X0) * SIDE + (tx - X0)) * 4);
      }
    }
  }
  return out;
}

function differing(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

function countColor(px: ArrayLike<number>, c: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] === c[0] && px[i + 1] === c[1] && px[i + 2] === c[2]) n++;
  }
  return n;
}

let cached: { terrain: Uint8ClampedArray; resources: Uint8ClampedArray } | undefined;
async function renders(): Promise<{ terrain: Uint8ClampedArray; resources: Uint8ClampedArray }> {
  if (cached === undefined) {
    const e = await engine();
    cached = {
      terrain: renderThroughWasm(e, { ...WINDOW, view: "terrain" }).slice(),
      resources: renderThroughWasm(e, WINDOW).slice(),
    };
  }
  return cached;
}

describe("the real-surface entity fixtures", () => {
  it("are the derived seed's surface, at 2.1.23, holding only the graded entities", () => {
    for (const f of [graded, defaults]) {
      expect(f.surfaceSeed).toBe(SEED0);
      expect(f.buildLine).toContain("Version: 2.1.23 ");
      expect(f.window).toEqual({ x0: -512, y0: -512, width: 1024, height: 1024 });
    }
    expect(graded.counts).toEqual({
      "copper-stromatolite": 1846,
      "iron-stromatolite": 2484,
      stone: 863,
    });
    // The list holds a one-tile ring as well, for boxes that reach in.
    expect(graded.entities).toHaveLength(5193 + 8);
    expect(Object.keys(graded.census).sort()).toEqual([...graded.names].sort());
    // The default arm is the map a player gets: plants, nests and cliffs too.
    expect(defaults.census["water-cane"]).toBeGreaterThan(10000);
  });

  /**
   * Plants, nests and cliffs take away exactly one: a copper stromatolite at
   * (134.5, -479.625), whose box crosses the chunk edge at y = -480 by 1/8
   * tile, where a water-cane from the chunk above (applied first) stands.
   */
  it("differ from the default map by one stromatolite", () => {
    const key = (e: number[]) => e.join(",");
    const d = new Set(defaults.entities.map(key));
    const g = new Set(graded.entities.map(key));
    const onlyGraded = graded.entities.filter((e) => !d.has(key(e)));
    expect(onlyGraded).toEqual([[0, 134.5 * 256, -479.625 * 256]]);
    expect(defaults.entities.filter((e) => !g.has(key(e)))).toEqual([]);
  });
});

describe("the WASM engine against the real Gleba surface's entities", () => {
  /** **0 of 1,048,576 pixels.** Exact, not a bound. */
  const DIFFERING_PX = 0;

  it("paints every stone and stromatolite where the real surface has one, and nothing else", async () => {
    const { terrain, resources } = await renders();
    const want = expected(terrain, graded);
    const n = differing(want, resources);
    withDiffArtifacts(
      {
        spec: "wasmGlebaEntityParity",
        case: "gleba-resources-vs-real-surface",
        game: { width: SIDE, height: SIDE, rgb: rgbOf(want) },
        ours: { width: SIDE, height: SIDE, rgba: resources },
      },
      () => {
        expect(n).toBe(DIFFERING_PX);
      },
    );
    // Non-vacuity: the view paints both colours, over thousands of pixels,
    // and not by recolouring tiles the terrain already had in that colour.
    expect(countColor(terrain, STROMATOLITE)).toBe(0);
    expect(countColor(terrain, STONE)).toBe(0);
    expect(countColor(resources, STROMATOLITE)).toBeGreaterThan(4330);
    expect(countColor(resources, STONE)).toBe(863);
  }, 300000);

  /**
   * Against the map a player gets, the render shows the one stromatolite a
   * water-cane takes away (plants are not ported). Its footprint is two
   * pixels, (134, -481) and (134, -480), and the upper one is also covered by
   * the stromatolite at (135.125, -480.8125), so ONE pixel differs.
   */
  it("differs from the default map only at the stromatolite a plant removes", async () => {
    const { terrain, resources } = await renders();
    expect(differing(expected(terrain, defaults), resources)).toBe(1);
  }, 300000);

  it("is the same picture in the `all` view", async () => {
    const all = renderThroughWasm(await engine(), { ...WINDOW, view: "all" });
    expect(differing(all, (await renders()).resources)).toBe(0);
  }, 300000);

  /**
   * The stone control reaches the overlay: at size 0 no stone is placed,
   * and the stromatolites, which no control reaches, do not move.
   */
  it("draws no stone with the stone control at size 0", async () => {
    const off = renderThroughWasm(await engine(), {
      ...WINDOW,
      glebaControls: { stoneSize: 0 },
    });
    const { resources } = await renders();
    expect(countColor(off, STONE)).toBe(0);
    expect(differing(off, resources)).toBe(863);
  }, 300000);
});

describe("tiling", () => {
  /**
   * A worker tile generates its own ring of chunks, so cut into 100-pixel
   * tiles (not chunk aligned) the render must still stitch back to the whole
   * render byte for byte. The window is the densest stromatolite field of the
   * fixture's south-west quarter, and holds stone too.
   */
  it("a tiled render stitches to the whole render", async () => {
    const e = await engine();
    const FULL: ImageBox = {
      originX: -400,
      originY: -144,
      width: 300,
      height: 300,
      tilesPerPixel: 1,
    };
    const req = { ...WINDOW, ...FULL };
    const whole = renderThroughWasm(e, req).slice();
    expect(countColor(whole, STROMATOLITE)).toBeGreaterThan(100);
    const tiles = planTiles(FULL, 100).map((t) => ({
      ...t,
      data: renderThroughWasm(e, {
        ...req,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
      }).slice(),
    }));
    expect(stitchTiles(FULL, tiles)).toEqual(whole);
  }, 300000);
});

function rgbOf(rgba: Uint8ClampedArray): Uint8Array {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i] as number;
    rgb[j + 1] = rgba[i + 1] as number;
    rgb[j + 2] = rgba[i + 2] as number;
  }
  return rgb;
}
