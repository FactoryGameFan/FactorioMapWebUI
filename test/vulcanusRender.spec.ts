import { describe, expect, it } from "vite-plus/test";
import { CLIFF_MAP_COLOR } from "../src/noise/cliffs/cliffCatalog";
import { ROCK_MAP_COLOR } from "../src/noise/rocks/rockCatalog";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { renderTerrain } from "../src/noise/preview/renderTerrain";
import { renderVulcanusTerrain } from "../src/noise/preview/renderVulcanusTerrain";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";

const SEED = 123456;

describe("renderVulcanusTerrain", () => {
  it("produces an ImageData of the requested size", () => {
    const img = renderVulcanusTerrain({ seed0: SEED, width: 8, height: 6 });
    expect(img.width).toBe(8);
    expect(img.height).toBe(6);
    expect(img.data.length).toBe(8 * 6 * 4);
  });

  it("fully populates a 32x32 near-spawn region (no transparent/zero pixels)", () => {
    // Origin-centered, 16 tiles/px so 32px covers a 512x512 world window -
    // large enough to cross several biome/tile boundaries. Each pixel runs
    // the full 19-tile Vulcanus argmax (no water fast-path applies here), so
    // 32x32 (1024 points) is chosen over 128x128 to keep this test fast; an
    // explicit timeout gives headroom under a loaded full-suite run.
    const width = 32;
    const height = 32;
    const img = renderVulcanusTerrain({
      seed0: SEED,
      width,
      height,
      originX: -256,
      originY: -256,
      tilesPerPixel: 16,
    });
    let zeroAlpha = 0;
    let blackTransparent = 0;
    const seen = new Set<string>();
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const a = img.data[i + 3];
      if (a === 0) zeroAlpha++;
      if (r === 0 && g === 0 && b === 0 && a === 0) blackTransparent++;
      seen.add(`${r},${g},${b}`);
    }
    // Vulcanus has no water/transparency, so every pixel must be fully
    // opaque - a zero-alpha pixel means the buffer was never written (a
    // real bug), not a legitimate "no tile here" result the way Nauvis
    // water sometimes reads.
    expect(zeroAlpha).toBe(0);
    expect(blackTransparent).toBe(0);
    // Sanity: the window actually spans more than one tile color
    // (otherwise a renderer that always paints a single hardcoded color
    // would pass the opacity checks above for the wrong reason).
    expect(seen.size).toBeGreaterThan(1);
  }, 15000);

  it("a near-spawn pixel matches the full Vulcanus tile resolver's color at the same world point", () => {
    // World point (-320, -320), seed 123456 - a near-spawn point also sampled by
    // the oracle fixture in vulcanusTiles.spec.ts (tile "volcanic-cracks" there).
    const x = -320;
    const y = -320;
    const resolve = makeVulcanusTileResolver({ seed0: SEED });
    const expected = resolve(x, y).color;

    const img = renderVulcanusTerrain({ seed0: SEED, width: 1, height: 1, originX: x, originY: y });
    expect([img.data[0], img.data[1], img.data[2], img.data[3]]).toEqual([...expected, 255]);
  });
});

describe("runRenderRequest planet dispatch", () => {
  const BASE: ElevationRenderRequest = {
    id: 1,
    seed0: SEED,
    width: 16,
    height: 16,
    originX: -320,
    originY: -320,
    tilesPerPixel: 4,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    view: "terrain",
  };

  it("planet 'vulcanus' + view 'terrain' matches a direct renderVulcanusTerrain call", () => {
    const req: ElevationRenderRequest = { ...BASE, planet: "vulcanus" };
    const direct = renderVulcanusTerrain({
      seed0: req.seed0,
      width: req.width,
      height: req.height,
      originX: req.originX,
      originY: req.originY,
      tilesPerPixel: req.tilesPerPixel,
      ctx: { startingPositions: req.startingPositions },
    });
    const got = new Uint8ClampedArray(runRenderRequest(req).buffer);
    expect(Array.from(got)).toEqual(Array.from(direct.data));
  });

  it("planet 'vulcanus' differs from the Nauvis terrain render at the same point", () => {
    const nauvis = new Uint8ClampedArray(runRenderRequest({ ...BASE, planet: "nauvis" }).buffer);
    const vulcanus = new Uint8ClampedArray(
      runRenderRequest({ ...BASE, planet: "vulcanus" }).buffer,
    );
    expect(Array.from(vulcanus)).not.toEqual(Array.from(nauvis));
  });

  it("omitting planet keeps the Nauvis render byte-identical to an explicit planet: 'nauvis'", () => {
    const omitted = new Uint8ClampedArray(runRenderRequest(BASE).buffer);
    const explicit = new Uint8ClampedArray(runRenderRequest({ ...BASE, planet: "nauvis" }).buffer);
    expect(Array.from(omitted)).toEqual(Array.from(explicit));
  });

  it("omitting planet reproduces a direct renderTerrain call unchanged (Nauvis path untouched)", () => {
    const direct = renderTerrain({
      seed0: BASE.seed0,
      width: BASE.width,
      height: BASE.height,
      originX: BASE.originX,
      originY: BASE.originY,
      tilesPerPixel: BASE.tilesPerPixel,
      ctx: {
        segmentationMultiplier: BASE.segmentationMultiplier,
        startingPositions: BASE.startingPositions,
      },
    });
    const got = new Uint8ClampedArray(runRenderRequest(BASE).buffer);
    expect(Array.from(got)).toEqual(Array.from(direct.data));
  });

  it("renders the Vulcanus resource overlay for view: resources", () => {
    const common = {
      id: 1,
      seed0: 123456,
      planet: "vulcanus" as const,
      width: 48,
      height: 48,
      originX: -1600,
      originY: -1600,
      tilesPerPixel: 8,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
    };
    const terrain = runRenderRequest({ ...common, view: "terrain" });
    const withOre = runRenderRequest({ ...common, id: 2, view: "resources" });
    expect(Array.from(new Uint8ClampedArray(withOre.buffer))).not.toEqual(
      Array.from(new Uint8ClampedArray(terrain.buffer)),
    );
  });

  it("leaves Vulcanus terrain alone for the Nauvis-only overlays", () => {
    const common = {
      id: 3,
      seed0: 123456,
      planet: "vulcanus" as const,
      width: 32,
      height: 32,
      originX: -1600,
      originY: -1600,
      tilesPerPixel: 8,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
    };
    const terrain = runRenderRequest({ ...common, view: "terrain" });
    // "cliffs" and "rocks" are deliberately absent: V3 gave both a Vulcanus
    // port, so neither is a no-op here. The two below still are.
    for (const view of ["enemies", "trees"] as const) {
      const other = runRenderRequest({ ...common, id: 4, view });
      expect(Array.from(new Uint8ClampedArray(other.buffer))).toEqual(
        Array.from(new Uint8ClampedArray(terrain.buffer)),
      );
    }
  });

  it("paints Vulcanus rocks for view:'rocks', in the shared ROCK_MAP_COLOR", () => {
    const common = {
      id: 7,
      seed0: 123456,
      planet: "vulcanus" as const,
      width: 96,
      height: 96,
      originX: -128,
      originY: -128,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
    };
    const terrain = runRenderRequest({ ...common, view: "terrain" });
    const rocks = runRenderRequest({ ...common, id: 8, view: "rocks" });

    // All four Vulcanus rock entities declare map_color {129, 105, 78}, the
    // same as Nauvis's rocks, so ROCK_MAP_COLOR is shared not duplicated.
    const before = new Uint8ClampedArray(terrain.buffer);
    const after = new Uint8ClampedArray(rocks.buffer);
    let changed = 0;
    for (let o = 0; o < after.length; o += 4) {
      if (
        after[o] === before[o] &&
        after[o + 1] === before[o + 1] &&
        after[o + 2] === before[o + 2]
      )
        continue;
      changed++;
      expect([after[o], after[o + 1], after[o + 2]]).toEqual([...ROCK_MAP_COLOR]);
    }
    expect(changed).toBeGreaterThan(0);
  });

  it("paints Vulcanus cliffs for view:'cliffs', in the shared CLIFF_MAP_COLOR", () => {
    const common = {
      id: 5,
      seed0: 123456,
      planet: "vulcanus" as const,
      width: 128,
      height: 128,
      originX: -256,
      originY: -256,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
    };
    const terrain = runRenderRequest({ ...common, view: "terrain" });
    const cliffs = runRenderRequest({ ...common, id: 6, view: "cliffs" });
    expect(Array.from(new Uint8ClampedArray(cliffs.buffer))).not.toEqual(
      Array.from(new Uint8ClampedArray(terrain.buffer)),
    );

    // Every changed pixel must be the cliff colour - `cliff-vulcanus` declares
    // the same map_color {144, 119, 87} as Nauvis's `cliff`, so CLIFF_MAP_COLOR
    // is shared rather than duplicated.
    const before = new Uint8ClampedArray(terrain.buffer);
    const after = new Uint8ClampedArray(cliffs.buffer);
    let changed = 0;
    for (let o = 0; o < after.length; o += 4) {
      if (
        after[o] === before[o] &&
        after[o + 1] === before[o + 1] &&
        after[o + 2] === before[o + 2]
      )
        continue;
      changed++;
      expect([after[o], after[o + 1], after[o + 2]]).toEqual([...CLIFF_MAP_COLOR]);
    }
    expect(changed).toBeGreaterThan(0);
  });
});
