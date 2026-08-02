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

// Three tests here used to carry an explicit `}, 15000)`. They were the only
// annotations in the suite BELOW `vite.config.ts`'s 30s `testTimeout`, so they
// silently opted out of the margin that default exists to provide, and the
// slowest of them ("composites ... in view:'all'", 3.0s locally) timed out on a
// 4-core CI runner as soon as the suite grew. Removing them is the fix: the
// default is ~10x the measured cost and still fails a genuine hang well inside
// the job's cap. Do not re-add a per-test timeout under 30s here.

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
  });

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

  it("rolls Vulcanus rocks rather than thresholding - coverage drops well below the 7% plateau", () => {
    const common = {
      id: 21,
      seed0: 123456,
      planet: "vulcanus" as const,
      width: 256,
      height: 256,
      originX: -128,
      originY: -128,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
    };
    const terrain = new Uint8ClampedArray(runRenderRequest({ ...common, view: "terrain" }).buffer);
    const rocks = new Uint8ClampedArray(
      runRenderRequest({ ...common, id: 22, view: "rocks" }).buffer,
    );
    let changed = 0;
    for (let o = 0; o < rocks.length; o += 4) {
      if (
        rocks[o] !== terrain[o] ||
        rocks[o + 1] !== terrain[o + 1] ||
        rocks[o + 2] !== terrain[o + 2]
      )
        changed++;
    }
    const coverage = changed / (common.width * common.height);
    // Directly measured for this exact window/seed under the old
    // VULCANUS_ROCK_FOOTPRINT_THRESHOLD = 0.02 sweep: 7.56%, close to the 7.03%
    // `docs/noise/vulcanus-rocks-NOTES.md` reports for `[-512, 512)^2`.
    //
    // **The bound used to be `< 0.01`, and that was wrong** - it was pinned just
    // above the 0.78% a 1x1 mark produced, on the assumption that "well below the
    // 7% plateau" was the goal. Comparing against the game's own
    // `--generate-map-preview` output shows the game covers **5.17%** of an
    // origin-centred 1024-tile window in rock colour, so 0.78% was 14x too
    // little, not comfortably conservative (issue #22 item 6). Rocks now paint a
    // 3x3 mark on both planets and this window measures ~4.5%.
    //
    // What this test can still honestly assert is that the render is a scattered
    // roll and not the old plateau, so the bound sits between the two: above the
    // game's own coverage with margin, and clearly under the 7.56% threshold
    // sweep. It is NOT a fidelity check - `docs/noise/vulcanus-rocks-NOTES.md`
    // holds the coverage-vs-game comparison, which is the thing that actually
    // measures accuracy here.
    expect(coverage).toBeLessThan(0.065);
    expect(coverage).toBeGreaterThan(0.02);
    expect(coverage).toBeGreaterThan(0); // and it must still paint SOMETHING
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

  // Vulcanus composites terrain -> resources -> rocks -> cliffs, so both
  // obstruction overlays read on top of an ore patch rather than being buried
  // by it. All three overlays paint opaquely, so the order is fully decided by
  // who paints last on a contended pixel - which is what this pins.
  //
  // Window choice is not arbitrary: resources have to contend with BOTH other
  // overlays for the two assertions to mean anything, and most windows give
  // only one. This one (a 256x256-tile world window at 2 tiles/px) was probed
  // to have 342 resource pixels cliffs also paint, and 67 rocks also paint
  // under the old threshold render. T3 switched rocks to a per-tile placement
  // roll (src/noise/placement/placementRoll.ts) painting a single pixel
  // (matching Nauvis's renderRocks.ts, not the 3x3 mark other roll overlays
  // use), which lowers the rock count sharply - re-measured at 4 here. The
  // window still clears the ">0" bar below, so it was kept rather than
  // re-probed; only this comment's count changed.
  // Both counts are asserted below, so if placement ever shifts the test fails
  // loudly rather than passing vacuously. It runs five full Vulcanus renders,
  // hence the explicit timeout.
  it("composites Vulcanus rocks and cliffs ON TOP of resource patches in view:'all'", () => {
    const common = {
      id: 9,
      seed0: 123456,
      planet: "vulcanus" as const,
      width: 128,
      height: 128,
      originX: -192,
      originY: -192,
      tilesPerPixel: 2,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
    };
    const terrain = new Uint8ClampedArray(runRenderRequest({ ...common, view: "terrain" }).buffer);
    const allBuf = new Uint8ClampedArray(runRenderRequest({ ...common, view: "all" }).buffer);
    const paintedBy = (view: "resources" | "rocks" | "cliffs"): Set<number> => {
      const buf = new Uint8ClampedArray(runRenderRequest({ ...common, view }).buffer);
      const s = new Set<number>();
      for (let o = 0; o < buf.length; o += 4) {
        if (buf[o] !== terrain[o] || buf[o + 1] !== terrain[o + 1] || buf[o + 2] !== terrain[o + 2])
          s.add(o);
      }
      return s;
    };
    const resources = paintedBy("resources");
    const rocks = paintedBy("rocks");
    const cliffs = paintedBy("cliffs");

    let overCliffs = 0;
    let overRocks = 0;
    for (const o of resources) {
      if (cliffs.has(o)) {
        overCliffs++;
        expect(
          [allBuf[o], allBuf[o + 1], allBuf[o + 2]],
          `pixel ${o}: cliffs must composite OVER resources`,
        ).toEqual([...CLIFF_MAP_COLOR]);
      } else if (rocks.has(o)) {
        overRocks++;
        expect(
          [allBuf[o], allBuf[o + 1], allBuf[o + 2]],
          `pixel ${o}: rocks must composite OVER resources`,
        ).toEqual([...ROCK_MAP_COLOR]);
      }
    }
    expect(overCliffs, "window must have pixels both cliffs and resources paint").toBeGreaterThan(
      0,
    );
    expect(overRocks, "window must have pixels both rocks and resources paint").toBeGreaterThan(0);
  });
});
