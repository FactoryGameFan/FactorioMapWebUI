import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { withDiffArtifacts } from "./diffArtifacts";
import graded from "./fixtures/oracle-gleba-real-surface-entities.seed123456.json";
import defaults from "./fixtures/oracle-gleba-real-surface-entities-default.seed123456.json";
import plants from "./fixtures/oracle-gleba-real-surface-plants.seed123456.json";
import cliffArm from "./fixtures/oracle-gleba-real-surface-cliffs.seed123456.json";
import nestArm from "./fixtures/oracle-gleba-real-surface-nests.seed123456.json";
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
 *
 * **The plants (#454, slice 4)** are graded the same way against
 * `oracle-gleba-real-surface-plants.seed123456.json`, the same surface with
 * the plants on (nests and cliffs still off): 30,451 plants, every one at its
 * exact position but one, and the stone and stromatolites with them.
 *
 * **The cliffs** are graded against
 * `oracle-gleba-real-surface-cliffs.seed123456.json`, the same surface with
 * everything on but the nests: 2,484 cliffs at the game's position and
 * orientation, which block plants and stromatolites.
 *
 * **The pentapod nests (#454, slice 6)** are graded against
 * `oracle-gleba-real-surface-nests.seed123456.json`, the map a player gets,
 * every control at its default: 30 `gleba-spawner` and 37
 * `gleba-spawner-small`, every one at the game's position.
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

/** The graded slice-3 arm had the plants, nests and cliffs off, so this request does too. */
const WINDOW = {
  planet: "gleba",
  view: "resources",
  seed0: SEED0,
  width: SIDE,
  height: SIDE,
  originX: X0,
  originY: X0,
  tilesPerPixel: 1,
  glebaControls: { plantsSize: 0, cliffContinuity: 0, enemySize: 0 },
} as const satisfies GlebaRenderRequest;

/** The plants arm had the nests and cliffs off, and everything else at its default. */
const PLANT_WINDOW = {
  ...WINDOW,
  glebaControls: { cliffContinuity: 0, enemySize: 0 },
} as const satisfies GlebaRenderRequest;

/** The cliffs arm had the nests off, and everything else at its default. */
const CLIFF_WINDOW = {
  ...WINDOW,
  glebaControls: { enemySize: 0 },
} as const satisfies GlebaRenderRequest;

/** Every lever at its default: the nests arm, the default arm, and the map a player gets. */
const DEFAULT_WINDOW = {
  ...WINDOW,
  glebaControls: {},
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
 * How a map draws an entity, mirroring `GlebaEntity::paint` from the game's
 * own facts: a `tree` with no `map_color` blends toward the chart's default
 * tree colour `{0.19, 0.39, 0.19}` at alpha 0.4 (102 / 256, rounded as the
 * Nauvis tree overlay rounds it); a `plant` (yumako-tree, jellystem) is its
 * `map_color`, white. `pass` is the order they paint in.
 */
const TREE_BLEND: readonly number[] = [48, 99, 48];
const WHITE: readonly number[] = [255, 255, 255];
/**
 * A pentapod nest has no `map_color`; the game's own Gleba preview PNG draws
 * every one in (255, 25, 25), its `default_enemy_color` `{1, 0.1, 0.1}`.
 */
const NEST: readonly number[] = [255, 25, 25];
type Autoplacer = { name: string; type: string; collisionBox: number[] };
/**
 * Each entity paints the box it occupies on the surface, its collision box.
 * Only the small nest's differs from its map-gen box (+-1.35 against +-2.35).
 */
function paintRules(autoplacers: Autoplacer[]) {
  const rules = new Map<
    string,
    { box: number[]; color: readonly number[]; blend: boolean; pass: number }
  >();
  for (const a of autoplacers) {
    const box = a.collisionBox.map((v) => Math.round(v * 256));
    if (a.type === "tree") rules.set(a.name, { box, color: TREE_BLEND, blend: true, pass: 0 });
    else if (a.type === "plant") rules.set(a.name, { box, color: WHITE, blend: false, pass: 1 });
    else if (a.type === "unit-spawner")
      rules.set(a.name, { box, color: NEST, blend: false, pass: 3 });
    else if (a.name in COLOR)
      rules.set(a.name, { box, color: COLOR[a.name] as readonly number[], blend: false, pass: 2 });
  }
  return rules;
}
const PLANT_RULES = paintRules(nestArm.autoplacers as Autoplacer[]);

/** `cliff-gleba`'s `map_color`, painted solid. */
const CLIFF: readonly number[] = [144, 119, 87];

/**
 * Each cliff orientation's box AABB relative to the cell centre, in 1/256
 * tile: left, top, right, bottom. Printed from `GlebaCliff::oriented` and
 * `get_aabb` (`print_footprint_offsets` in `placement/gleba_cliffs.rs`); the
 * cell centres all sit at the same tile fraction, so they are constants.
 */
const CLIFF_AABB: Record<string, readonly [number, number, number, number]> = {
  "west-to-east": [-512, -384, 512, 384],
  "north-to-south": [-256, -512, 256, 512],
  "east-to-west": [-512, -128, 512, 128],
  "south-to-north": [-256, -512, 256, 512],
  "west-to-north": [-896, -767, 256, 383],
  "north-to-east": [-255, -767, 895, 383],
  "east-to-south": [-257, -127, 639, 767],
  "south-to-west": [-639, -128, 255, 766],
  "west-to-south": [-895, -383, 255, 767],
  "north-to-west": [-640, -767, 256, 127],
  "east-to-north": [-255, -767, 639, 127],
  "south-to-east": [-257, -383, 895, 767],
  "west-to-none": [-768, -383, 0, 383],
  "none-to-east": [-1, -383, 767, 383],
  "east-to-none": [-1, -127, 639, 511],
  "none-to-west": [-640, -128, 2, 512],
  "north-to-none": [-255, -639, 511, 127],
  "none-to-south": [-256, -127, 510, 639],
  "south-to-none": [-511, -128, 255, 638],
  "none-to-north": [-511, -639, 255, 127],
};

type EntityFixture = {
  names: string[];
  entities: number[][];
  orientations?: string[];
};

/**
 * `terrain` with a fixture's entities painted on it the way the module paints
 * them: the tree blends, then the cliffs (when `withCliffs`), then the white
 * plants, then stone and the stromatolites, then the nests; each over the tiles `floor(low)`
 * to `ceil(high) - 1` of its box (for a cliff, its oriented box's AABB),
 * keeping only the names `keep` allows.
 */
function expectedFrom(
  f: EntityFixture,
  terrain: Uint8ClampedArray,
  keep: (name: string) => boolean,
  withCliffs: boolean,
): Uint8ClampedArray {
  const out = terrain.slice();
  type Mark = {
    x: number;
    y: number;
    box: readonly number[];
    color: readonly number[];
    blend: boolean;
    order: number;
  };
  const marks: Mark[] = [];
  for (const e of f.entities) {
    const [k, x, y, o] = e as [number, number, number, number?];
    const name = f.names[k] as string;
    if (name === "cliff-gleba") {
      if (!withCliffs) continue;
      const orientation = (f.orientations as string[])[o as number] as string;
      marks.push({ x, y, box: CLIFF_AABB[orientation]!, color: CLIFF, blend: false, order: 1 });
      continue;
    }
    if (!keep(name)) continue;
    const rule = PLANT_RULES.get(name)!;
    // Passes 0 (trees), 1 (white plants), 2 (resources), 3 (nests); cliffs go
    // between 0 and 1.
    marks.push({
      x,
      y,
      box: rule.box,
      color: rule.color,
      blend: rule.blend,
      order: rule.pass === 0 ? 0 : rule.pass + 1,
    });
  }
  marks.sort((a, b) => a.order - b.order);
  for (const { x, y, box, color, blend } of marks) {
    const [l, t, r, b] = box as [number, number, number, number];
    const fx0 = Math.floor((x + l) / 256);
    const fx1 = Math.floor((x + r - 1) / 256);
    const fy0 = Math.floor((y + t) / 256);
    const fy1 = Math.floor((y + b - 1) / 256);
    for (let ty = Math.max(fy0, X0); ty <= Math.min(fy1, X0 + SIDE - 1); ty++) {
      for (let tx = Math.max(fx0, X0); tx <= Math.min(fx1, X0 + SIDE - 1); tx++) {
        const p = ((ty - X0) * SIDE + (tx - X0)) * 4;
        for (let c = 0; c < 3; c++) {
          const want = color[c] as number;
          out[p + c] = blend ? ((256 - 102) * (out[p + c] as number) + 102 * want) >> 8 : want;
        }
      }
    }
  }
  return out;
}

/** The plants arm painted, with no cliffs. */
function expectedPlants(
  terrain: Uint8ClampedArray,
  keep: (name: string) => boolean,
): Uint8ClampedArray {
  return expectedFrom(plants as EntityFixture, terrain, keep, false);
}

const isPlant = (name: string) => PLANT_RULES.get(name)!.pass < 2;
const isNest = (name: string) => PLANT_RULES.get(name)!.pass === 3;

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

/** The world tiles (x, y) where two window renders differ, row by row. */
function differingTiles(a: ArrayLike<number>, b: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      const p = i / 4;
      out.push([X0 + (p % SIDE), X0 + Math.floor(p / SIDE)]);
    }
  }
  return out;
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
   * Against the map a player gets: with the plants on, the water-cane at
   * (134.375, -480.125) blocks the copper stromatolite at (134.5, -479.625),
   * as in the game, so the resources view matches the default map exactly.
   * With the plants off (slice 3) this was 1 pixel.
   */
  it("matches the default map's stone and stromatolites with the plants on", async () => {
    const { terrain, resources } = await renders();
    const withPlants = renderThroughWasm(await engine(), { ...DEFAULT_WINDOW, view: "resources" });
    expect(differing(expected(terrain, defaults), withPlants)).toBe(0);
    // The control: without plants, that one stromatolite stays.
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
      glebaControls: { plantsSize: 0, stoneSize: 0, cliffContinuity: 0 },
    });
    const { resources } = await renders();
    expect(countColor(off, STONE)).toBe(0);
    expect(differing(off, resources)).toBe(863);
  }, 300000);
});

describe("the WASM engine against the real Gleba surface's plants", () => {
  it("grades a surface with 30,451 plants and nothing but the graded entities", () => {
    expect(plants.surfaceSeed).toBe(SEED0);
    expect(plants.buildLine).toContain("Version: 2.1.23 ");
    expect(plants.window).toEqual(graded.window);
    const plantCount = Object.entries(plants.counts)
      .filter(([n]) => isPlant(n))
      .reduce((a, [, v]) => a + v, 0);
    expect(plantCount).toBe(30451);
    expect(plants.counts["water-cane"]).toBe(18280);
    expect(plants.counts["copper-stromatolite"]).toBe(1845);
    expect(Object.keys(plants.census).sort()).toEqual([...plants.names].sort());
  });

  /**
   * **The `all` view against the real surface: 4 of 1,048,576 pixels.** They
   * are two footprints, of the two plants the game kept against stone's
   * tree-removal roll (odds 0.04 and 0.19). The engine takes the expected
   * outcome of that roll, which comes from a random generator the whole
   * surface shares (`placement::gleba`); on the cliffs arm, another
   * generation of the same plants, the game removed both and kept two
   * others. The stingfrond's other two tiles hold stone, painted over it
   * either way.
   */
  it("paints every plant, stone and stromatolite of the real surface but one", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...PLANT_WINDOW, view: "terrain" }).slice();
    const all = renderThroughWasm(e, { ...PLANT_WINDOW, view: "all" }).slice();
    const want = expectedPlants(terrain, () => true);
    const n = differingTiles(want, all);
    withDiffArtifacts(
      {
        spec: "wasmGlebaEntityParity",
        case: "gleba-all-vs-real-surface-plants",
        game: { width: SIDE, height: SIDE, rgb: rgbOf(want) },
        ours: { width: SIDE, height: SIDE, rgba: all },
      },
      () => {
        expect(n).toEqual(PLANT_DIFFERING_TILES);
      },
    );
    // Non-vacuity: the blend and the white are both painted, widely.
    expect(countColor(terrain, WHITE)).toBe(0);
    expect(countColor(all, WHITE)).toBeGreaterThan(2000);
    expect(differing(terrain, all)).toBeGreaterThan(90000);
  }, 300000);

  /** The `trees` view is the plants alone, and `resources` the rest. */
  it("splits the entities between the trees and resources views", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...PLANT_WINDOW, view: "terrain" }).slice();
    // Each render is a view into the module's memory: copy it before the next.
    const trees = renderThroughWasm(e, { ...PLANT_WINDOW, view: "trees" }).slice();
    const resources = renderThroughWasm(e, { ...PLANT_WINDOW, view: "resources" }).slice();
    expect(differingTiles(expectedPlants(terrain, isPlant), trees)).toEqual(TREES_DIFFERING_TILES);
    expect(
      differing(
        expectedPlants(terrain, (n) => !isPlant(n)),
        resources,
      ),
    ).toBe(0);
  }, 300000);

  /**
   * The plants control reaches the render: at size 0 no plant is drawn, and
   * the trees view is the terrain.
   */
  it("draws no plant with the plants control at size 0", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...PLANT_WINDOW, view: "terrain" }).slice();
    const off = renderThroughWasm(e, { ...WINDOW, view: "trees" });
    expect(differing(off, terrain)).toBe(0);
  }, 300000);
});

/**
 * Frozen, by position: the two plants the game kept against stone's
 * tree-removal roll on this generation. The sunnycomb at (-44.8125, -27.5)
 * (odds 0.04; its box only touches its stones' tiles) and the stingfrond at
 * (-324.9375, 451.1875) (odds 0.19). See the `all` view test above.
 */
const PLANT_DIFFERING_TILES: [number, number][] = [
  [-46, -28],
  [-45, -28],
  [-326, 450],
  [-326, 451],
];
/**
 * The same two in the `trees` view: the stingfrond's four tiles there,
 * because no stone paints over two of them.
 */
const TREES_DIFFERING_TILES: [number, number][] = [
  [-46, -28],
  [-45, -28],
  [-326, 450],
  [-325, 450],
  [-326, 451],
  [-325, 451],
];

describe("the WASM engine against the real Gleba surface's cliffs", () => {
  it("grades a surface with 2,484 cliffs and nothing but the graded entities", () => {
    expect(cliffArm.surfaceSeed).toBe(SEED0);
    expect(cliffArm.buildLine).toContain("Version: 2.1.23 ");
    expect(cliffArm.window).toEqual(graded.window);
    expect(cliffArm.counts["cliff-gleba"]).toBe(2484);
    expect(cliffArm.cliffSettings).toEqual({
      name: "cliff-gleba",
      elevation0: 40,
      interval: 60,
      richness: Math.fround(0.8),
      smoothing: 0,
      control: "gleba_cliff",
    });
    expect(Object.keys(cliffArm.census).sort()).toEqual([...cliffArm.names].sort());
  });

  /**
   * **The `cliffs` view: every cliff of the real surface at its position and
   * orientation, and no other.** Exact over the whole window.
   */
  it("paints every cliff of the real surface, and nothing else", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...CLIFF_WINDOW, view: "terrain" }).slice();
    const cliffs = renderThroughWasm(e, { ...CLIFF_WINDOW, view: "cliffs" }).slice();
    const want = expectedFrom(cliffArm as EntityFixture, terrain, () => false, true);
    const n = differingTiles(want, cliffs);
    withDiffArtifacts(
      {
        spec: "wasmGlebaEntityParity",
        case: "gleba-cliffs-vs-real-surface",
        game: { width: SIDE, height: SIDE, rgb: rgbOf(want) },
        ours: { width: SIDE, height: SIDE, rgba: cliffs },
      },
      () => {
        expect(n).toEqual([]);
      },
    );
    expect(countColor(terrain, CLIFF)).toBe(0);
    expect(countColor(cliffs, CLIFF)).toBeGreaterThan(10000);
  }, 300000);

  /**
   * **The `all` view against the real surface with cliffs.** The differing
   * tiles are the footprints of the two plants the game kept against stone's
   * tree-removal roll on this generation (`placement::gleba`).
   */
  it("paints the cliffs, plants, stone and stromatolites of the real surface", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...CLIFF_WINDOW, view: "terrain" }).slice();
    const all = renderThroughWasm(e, { ...CLIFF_WINDOW, view: "all" }).slice();
    const want = expectedFrom(cliffArm as EntityFixture, terrain, () => true, true);
    const n = differingTiles(want, all);
    withDiffArtifacts(
      {
        spec: "wasmGlebaEntityParity",
        case: "gleba-all-vs-real-surface-cliffs",
        game: { width: SIDE, height: SIDE, rgb: rgbOf(want) },
        ours: { width: SIDE, height: SIDE, rgba: all },
      },
      () => {
        expect(n).toEqual(CLIFF_ARM_DIFFERING_TILES);
      },
    );
  }, 300000);

  /** The cliff control reaches the render: at continuity 0 no cliff is drawn. */
  it("draws no cliff with the cliff control at size 0", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...CLIFF_WINDOW, view: "terrain" }).slice();
    const off = renderThroughWasm(e, { ...PLANT_WINDOW, view: "cliffs" });
    expect(differing(off, terrain)).toBe(0);
  }, 300000);
});

/**
 * Frozen, by position: the stingfrond at (-326.4375, 441.375), which the
 * game kept against odds of 0.43 on this generation (and removed on the
 * plants arm's). The other plant it kept, the sunnycomb at (-62.75, 0.125),
 * lies wholly under stone paint, so no pixel shows it.
 */
const CLIFF_ARM_DIFFERING_TILES: [number, number][] = [
  [-328, 440],
  [-327, 440],
  [-326, 440],
  [-328, 441],
  [-327, 441],
];

describe("the WASM engine against the real Gleba surface's pentapod nests", () => {
  it("grades the map a player gets, with 67 nests and nothing but the graded entities", () => {
    expect(nestArm.surfaceSeed).toBe(SEED0);
    expect(nestArm.buildLine).toContain("Version: 2.1.23 ");
    expect(nestArm.window).toEqual(graded.window);
    expect(nestArm.counts["gleba-spawner"]).toBe(30);
    expect(nestArm.counts["gleba-spawner-small"]).toBe(37);
    expect(nestArm.counts["cliff-gleba"]).toBe(2484);
    for (const c of Object.values(nestArm.controls)) {
      expect(c).toEqual({ frequency: 1, size: 1, richness: 1 });
    }
    expect(Object.keys(nestArm.census).sort()).toEqual([...nestArm.names].sort());
  });

  /**
   * **The `enemies` view: every nest of the real surface at its position, and
   * no other.** Exact over the whole window.
   */
  it("paints every nest of the real surface, and nothing else", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...DEFAULT_WINDOW, view: "terrain" }).slice();
    const enemies = renderThroughWasm(e, { ...DEFAULT_WINDOW, view: "enemies" }).slice();
    const want = expectedFrom(nestArm as EntityFixture, terrain, isNest, false);
    const n = differingTiles(want, enemies);
    withDiffArtifacts(
      {
        spec: "wasmGlebaEntityParity",
        case: "gleba-enemies-vs-real-surface",
        game: { width: SIDE, height: SIDE, rgb: rgbOf(want) },
        ours: { width: SIDE, height: SIDE, rgba: enemies },
      },
      () => {
        expect(n).toEqual([]);
      },
    );
    // Non-vacuity: the terrain has no pixel of the nest colour, and the nests
    // paint hundreds.
    expect(countColor(terrain, NEST)).toBe(0);
    expect(countColor(enemies, NEST)).toBe(NEST_PX);
  }, 300000);

  /**
   * **The `all` view against the map a player gets.** The differing tiles
   * are the cliffs arm's: the stingfrond the game kept against stone's
   * tree-removal roll on this generation, as there.
   */
  it("paints every entity of the real surface", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...DEFAULT_WINDOW, view: "terrain" }).slice();
    const all = renderThroughWasm(e, { ...DEFAULT_WINDOW, view: "all" }).slice();
    const want = expectedFrom(nestArm as EntityFixture, terrain, () => true, true);
    const n = differingTiles(want, all);
    withDiffArtifacts(
      {
        spec: "wasmGlebaEntityParity",
        case: "gleba-all-vs-real-surface-nests",
        game: { width: SIDE, height: SIDE, rgb: rgbOf(want) },
        ours: { width: SIDE, height: SIDE, rgba: all },
      },
      () => {
        expect(n).toEqual(CLIFF_ARM_DIFFERING_TILES);
      },
    );
  }, 300000);

  /**
   * The views split the entities: `trees` the plants, `resources` stone and
   * the stromatolites, each against the map a player gets, with the nests
   * placed but not drawn.
   */
  it("keeps the nests out of the trees and resources views", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...DEFAULT_WINDOW, view: "terrain" }).slice();
    const trees = renderThroughWasm(e, { ...DEFAULT_WINDOW, view: "trees" }).slice();
    const resources = renderThroughWasm(e, { ...DEFAULT_WINDOW, view: "resources" }).slice();
    const f = nestArm as EntityFixture;
    expect(differingTiles(expectedFrom(f, terrain, isPlant, false), trees)).toEqual(
      NEST_ARM_TREES_DIFFERING_TILES,
    );
    expect(
      differing(
        expectedFrom(f, terrain, (n) => !isPlant(n) && !isNest(n), false),
        resources,
      ),
    ).toBe(0);
    expect(countColor(trees, NEST)).toBe(0);
    expect(countColor(resources, NEST)).toBe(0);
  }, 300000);

  /** The enemy control reaches the render: at size 0 no nest is drawn. */
  it("draws no nest with the enemy control at size 0", async () => {
    const e = await engine();
    const terrain = renderThroughWasm(e, { ...DEFAULT_WINDOW, view: "terrain" }).slice();
    const off = renderThroughWasm(e, { ...CLIFF_WINDOW, view: "enemies" });
    expect(differing(off, terrain)).toBe(0);
  }, 300000);
});

/** The nest colour's pixels in the `enemies` view of the whole window: 67 footprints. */
const NEST_PX = 1456;

/**
 * Frozen, by position: the `trees` view against the nests arm. The two
 * plants the game kept against stone's tree-removal roll on this generation,
 * the sunnycomb at (-62.75, 0.125), whose tiles stone paints over in the
 * `all` view, and the stingfrond at (-326.4375, 441.375).
 */
const NEST_ARM_TREES_DIFFERING_TILES: [number, number][] = [
  [-64, -1],
  [-63, -1],
  [-64, 0],
  [-63, 0],
  [-328, 440],
  [-327, 440],
  [-326, 440],
  [-328, 441],
  [-327, 441],
  [-326, 441],
];

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
    // Plants on, in the `all` view: a stone in a neighbouring chunk can now
    // remove a plant, and a plant can block a stromatolite.
    const req = { ...DEFAULT_WINDOW, view: "all", ...FULL } as const;
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

describe("tiling the whole window at the app's tile size", () => {
  /**
   * The app renders in 256-pixel worker tiles. Each generates its own rings
   * of chunks, cliff cells and corrected tiles, so the whole 1024 window cut
   * into sixteen such tiles must stitch to the single render byte for byte:
   * that is what shows `GLEBA_CLIFF_TILE_RING_CHUNKS` is wide enough at every
   * seam, not only in one region.
   */
  it("stitches sixteen 256-pixel tiles to the whole render, cliffs on", async () => {
    const e = await engine();
    const FULL: ImageBox = {
      originX: X0,
      originY: X0,
      width: SIDE,
      height: SIDE,
      tilesPerPixel: 1,
    };
    const req = { ...DEFAULT_WINDOW, view: "all", ...FULL } as const;
    const whole = renderThroughWasm(e, req).slice();
    const tiles = planTiles(FULL, 256).map((t) => ({
      ...t,
      data: renderThroughWasm(e, {
        ...req,
        originX: t.originX,
        originY: t.originY,
        width: t.width,
        height: t.height,
      }).slice(),
    }));
    expect(tiles).toHaveLength(16);
    expect(differing(stitchTiles(FULL, tiles), whole)).toBe(0);
  }, 600000);
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
