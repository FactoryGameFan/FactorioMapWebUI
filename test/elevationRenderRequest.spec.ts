import { describe, it, expect } from "vite-plus/test";
import {
  cliffCellQueryBox,
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";
import { renderElevation, LAND_RGBA, WATER_RGBA } from "../src/noise/preview/renderElevation";
import { renderTerrain } from "../src/noise/preview/renderTerrain";
import { RESOURCE_CATALOG } from "../src/noise/resources/resourceCatalog";
import { ENEMY_MAP_COLOR } from "../src/noise/enemies/enemyCatalog";
import { CLIFF_MAP_COLOR } from "../src/noise/cliffs/cliffCatalog";
import { ROCK_MAP_COLOR } from "../src/noise/rocks/rockCatalog";
import { makeTreeDensity } from "../src/noise/trees/treeField";

const REQ: ElevationRenderRequest = {
  id: 7,
  seed0: 123456,
  width: 8,
  height: 6,
  originX: -16,
  originY: -16,
  tilesPerPixel: 4,
  waterLevel: 0,
  segmentationMultiplier: 1,
  startingPositions: [{ x: 0, y: 0 }],
};

describe("runRenderRequest", () => {
  it("echoes id/width/height and returns an RGBA buffer of the right size", () => {
    const r = runRenderRequest(REQ);
    expect(r.id).toBe(7);
    expect(r.width).toBe(8);
    expect(r.height).toBe(6);
    expect(r.buffer.byteLength).toBe(8 * 6 * 4);
  });

  it("produces bytes identical to a direct renderElevation call", () => {
    const direct = renderElevation({
      seed0: REQ.seed0,
      width: REQ.width,
      height: REQ.height,
      originX: REQ.originX,
      originY: REQ.originY,
      tilesPerPixel: REQ.tilesPerPixel,
      ctx: {
        waterLevel: REQ.waterLevel,
        segmentationMultiplier: REQ.segmentationMultiplier,
        startingPositions: REQ.startingPositions,
      },
    });
    const got = new Uint8ClampedArray(runRenderRequest(REQ).buffer);
    expect(Array.from(got)).toEqual(Array.from(direct.data));
  });

  it("dispatches mapType 'nauvis' to renderElevation's nauvis factory", () => {
    const nauvisReq: ElevationRenderRequest = { ...REQ, mapType: "nauvis" };
    const direct = renderElevation({
      seed0: REQ.seed0,
      width: REQ.width,
      height: REQ.height,
      originX: REQ.originX,
      originY: REQ.originY,
      tilesPerPixel: REQ.tilesPerPixel,
      mapType: "nauvis",
      ctx: {
        waterLevel: REQ.waterLevel,
        segmentationMultiplier: REQ.segmentationMultiplier,
        startingPositions: REQ.startingPositions,
      },
    });
    const got = new Uint8ClampedArray(runRenderRequest(nauvisReq).buffer);
    expect(Array.from(got)).toEqual(Array.from(direct.data));
  });

  it("forwards mapType through to the render, flipping the pixel at a discriminating point", () => {
    // World point (-1200, -1162), seed 123456: makeElevationNauvis = +2.34 (LAND),
    // makeElevationLakes = -6.81 (WATER). If runRenderRequest dropped/reversed the
    // mapType forwarding, both requests would render the same color here.
    const base: ElevationRenderRequest = {
      id: 1,
      seed0: 123456,
      width: 1,
      height: 1,
      originX: -1200,
      originY: -1162,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
    };

    const nauvisBuf = new Uint8ClampedArray(
      runRenderRequest({ ...base, mapType: "nauvis" }).buffer,
    );
    expect(Array.from(nauvisBuf.slice(0, 4))).toEqual(LAND_RGBA);

    const lakesBuf = new Uint8ClampedArray(runRenderRequest({ ...base, mapType: "lakes" }).buffer);
    expect(Array.from(lakesBuf.slice(0, 4))).toEqual(WATER_RGBA);
  });

  it("view 'terrain' dispatches to renderTerrain, producing terrain-tile colors", () => {
    // World point (2742, 8459), seed 123456: a known deep-water point from
    // renderTerrain.spec.ts (deepwater color [38, 64, 73, 255]) - distinct from
    // renderElevation's flat WATER_RGBA, so this proves the terrain renderer ran.
    const req: ElevationRenderRequest = {
      id: 9,
      seed0: 123456,
      width: 1,
      height: 1,
      originX: 2742,
      originY: 8459,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "terrain",
    };
    const direct = renderTerrain({
      seed0: req.seed0,
      width: req.width,
      height: req.height,
      originX: req.originX,
      originY: req.originY,
      tilesPerPixel: req.tilesPerPixel,
      ctx: { segmentationMultiplier: req.segmentationMultiplier },
    });
    const got = new Uint8ClampedArray(runRenderRequest(req).buffer);
    expect(Array.from(got)).toEqual(Array.from(direct.data));
    expect(Array.from(got)).toEqual([38, 64, 73, 255]);
  });

  it("view 'terrain' forwards climate fields, changing some pixel under a shifted aux bias", () => {
    // A 20x20 land-ward grid (aux/moisture drive most of the catalog's
    // expression_in_range boxes, so a +0.5 aux bias reliably flips some
    // pixel's argmax winner somewhere in a grid this size) - proving
    // runRenderRequest forwards moistureFrequency/moistureBias/auxFrequency/
    // auxBias/startingAreaMoistureSize/startingAreaMoistureFrequency through
    // to renderTerrain's ctx rather than dropping them.
    const req: ElevationRenderRequest = {
      id: 10,
      seed0: 123456,
      width: 20,
      height: 20,
      originX: -2000,
      originY: -2000,
      tilesPerPixel: 200,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "terrain",
      auxBias: 0.5,
    };
    const direct = renderTerrain({
      seed0: req.seed0,
      width: req.width,
      height: req.height,
      originX: req.originX,
      originY: req.originY,
      tilesPerPixel: req.tilesPerPixel,
      ctx: { segmentationMultiplier: req.segmentationMultiplier, auxBias: 0.5 },
    });
    const got = new Uint8ClampedArray(runRenderRequest(req).buffer);
    expect(Array.from(got)).toEqual(Array.from(direct.data));

    const baseline = new Uint8ClampedArray(runRenderRequest({ ...req, auxBias: undefined }).buffer);
    expect(Array.from(got)).not.toEqual(Array.from(baseline));
  });

  it("view 'resources' overlays ore on the terrain (differs from terrain only where ore is)", () => {
    // 32x32 px at 16 tiles/px over world [512, 1024) - a region with patches.
    const terrainReq: ElevationRenderRequest = {
      id: 11,
      seed0: 123456,
      width: 32,
      height: 32,
      originX: 512,
      originY: 512,
      tilesPerPixel: 16,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "terrain",
    };
    const terrain = new Uint8ClampedArray(runRenderRequest(terrainReq).buffer);
    const withOre = new Uint8ClampedArray(
      runRenderRequest({ ...terrainReq, view: "resources" }).buffer,
    );

    const catalogColors = new Set(RESOURCE_CATALOG.map((r) => r.mapColor.join(",")));
    let differing = 0;
    for (let i = 0; i < terrain.length; i += 4) {
      const same =
        terrain[i] === withOre[i] &&
        terrain[i + 1] === withOre[i + 1] &&
        terrain[i + 2] === withOre[i + 2] &&
        terrain[i + 3] === withOre[i + 3];
      if (same) continue;
      differing++;
      // A differing pixel must be an opaque catalog color (the overlay).
      expect(withOre[i + 3]).toBe(255);
      expect(catalogColors.has(`${withOre[i]},${withOre[i + 1]},${withOre[i + 2]}`)).toBe(true);
    }
    expect(differing).toBeGreaterThan(0); // ore appears
    expect(differing).toBeLessThan(32 * 32); // but not everywhere
  });

  it("view 'resources' never paints ore over water (terrain water pixels are preserved)", () => {
    // A large view that includes open water; every pixel the terrain drew as
    // deepwater/water must be byte-identical in the resources render (ore excluded).
    const terrainReq: ElevationRenderRequest = {
      id: 13,
      seed0: 2883961880,
      width: 128,
      height: 128,
      originX: -512,
      originY: -512,
      tilesPerPixel: 8,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "terrain",
    };
    const terrain = new Uint8ClampedArray(runRenderRequest(terrainReq).buffer);
    const withOre = new Uint8ClampedArray(
      runRenderRequest({ ...terrainReq, view: "resources" }).buffer,
    );
    const water = new Set([
      [38, 64, 73].join(","), // deepwater
      [51, 83, 95].join(","), // water
    ]);
    let waterPixels = 0;
    for (let i = 0; i < terrain.length; i += 4) {
      if (!water.has(`${terrain[i]},${terrain[i + 1]},${terrain[i + 2]}`)) continue;
      waterPixels++;
      // unchanged: same bytes as the terrain render
      expect([withOre[i], withOre[i + 1], withOre[i + 2], withOre[i + 3]]).toEqual([
        terrain[i],
        terrain[i + 1],
        terrain[i + 2],
        terrain[i + 3],
      ]);
    }
    expect(waterPixels).toBeGreaterThan(0); // the view really does contain water
  });

  it("view 'resources' forwards resourceControls (iron size 0 removes iron pixels)", () => {
    const base: ElevationRenderRequest = {
      id: 12,
      seed0: 123456,
      width: 32,
      height: 32,
      originX: 512,
      originY: 512,
      tilesPerPixel: 16,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "resources",
    };
    const iron = RESOURCE_CATALOG.find((r) => r.name === "iron-ore")!;
    const ironColor = iron.mapColor.join(",");
    const countIron = (buf: Uint8ClampedArray): number => {
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) {
        if (`${buf[i]},${buf[i + 1]},${buf[i + 2]}` === ironColor && buf[i + 3] === 255) n++;
      }
      return n;
    };
    const withIron = new Uint8ClampedArray(runRenderRequest(base).buffer);
    const noIron = new Uint8ClampedArray(
      runRenderRequest({
        ...base,
        resourceControls: { "iron-ore": { frequency: 1, size: 0, richness: 1 } },
      }).buffer,
    );
    expect(countIron(withIron)).toBeGreaterThan(0);
    expect(countIron(noIron)).toBe(0);
  });

  it("view 'enemies' overlays enemy-base placements on the terrain", () => {
    // 32x32 px at 1 tile/px over world [1000,1032) x [1040,1072) - inside a base
    // spot (5 placements, 45 painted pixels at seed 123456). This used to be a
    // 1x1 image at the same origin, which worked while the overlay thresholded
    // `enemy_base_probability`; a roll places ~1 spawner per few hundred tiles, so
    // a single pixel is no longer a reliable hit. Widened rather than moved, and
    // the assertion is "some pixels changed and every changed pixel is exactly
    // ENEMY_MAP_COLOR" rather than a pixel count.
    const req: ElevationRenderRequest = {
      id: 14,
      seed0: 123456,
      width: 32,
      height: 32,
      originX: 1000,
      originY: 1040,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "enemies",
      enemyControls: { frequency: 1, size: 1 },
    };
    const terrain = new Uint8ClampedArray(runRenderRequest({ ...req, view: "terrain" }).buffer);
    const withEnemies = new Uint8ClampedArray(runRenderRequest(req).buffer);
    expect(Array.from(withEnemies)).not.toEqual(Array.from(terrain));
    let changed = 0;
    for (let i = 0; i < terrain.length; i += 4) {
      if (
        withEnemies[i] === terrain[i] &&
        withEnemies[i + 1] === terrain[i + 1] &&
        withEnemies[i + 2] === terrain[i + 2]
      )
        continue;
      changed++;
      expect([withEnemies[i], withEnemies[i + 1], withEnemies[i + 2], withEnemies[i + 3]]).toEqual([
        ...ENEMY_MAP_COLOR,
        255,
      ]);
    }
    expect(changed).toBeGreaterThan(0);
  });

  it("view 'cliffs' overlays the cliff footprint on the terrain", () => {
    // 64x64 px at 1 tile/px over world [960,1024)x[512,576) - the same dense
    // sub-window renderCliffs.spec.ts uses (~39 cliffs at seed 123456).
    const req: ElevationRenderRequest = {
      id: 15,
      seed0: 123456,
      width: 64,
      height: 64,
      originX: 960,
      originY: 512,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "cliffs",
      cliffControls: { frequency: 1, continuity: 1 },
      cliffSettings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
    };
    const terrain = new Uint8ClampedArray(runRenderRequest({ ...req, view: "terrain" }).buffer);
    const withCliffs = new Uint8ClampedArray(runRenderRequest(req).buffer);
    expect(Array.from(withCliffs)).not.toEqual(Array.from(terrain));

    let painted = 0;
    for (let i = 0; i < withCliffs.length; i += 4) {
      if (
        withCliffs[i] === CLIFF_MAP_COLOR[0] &&
        withCliffs[i + 1] === CLIFF_MAP_COLOR[1] &&
        withCliffs[i + 2] === CLIFF_MAP_COLOR[2] &&
        withCliffs[i + 3] === 255
      ) {
        painted++;
      }
    }
    expect(painted).toBeGreaterThan(0);
  });

  it("view 'cliffs' defaults cliffControls/cliffSettings when omitted", () => {
    const req: ElevationRenderRequest = {
      id: 16,
      seed0: 123456,
      width: 64,
      height: 64,
      originX: 960,
      originY: 512,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "cliffs",
    };
    const withDefaults = new Uint8ClampedArray(runRenderRequest(req).buffer);
    const explicit = new Uint8ClampedArray(
      runRenderRequest({
        ...req,
        cliffControls: { frequency: 1, continuity: 1 },
        cliffSettings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
      }).buffer,
    );
    expect(Array.from(withDefaults)).toEqual(Array.from(explicit));
  });

  it("view 'elevation' (explicit or default/omitted) keeps the water/land mask", () => {
    const explicit = new Uint8ClampedArray(runRenderRequest({ ...REQ, view: "elevation" }).buffer);
    const omitted = new Uint8ClampedArray(runRenderRequest(REQ).buffer);
    expect(Array.from(explicit)).toEqual(Array.from(omitted));
    // Every pixel of the flat elevation mask is exactly LAND_RGBA or WATER_RGBA
    // - neither matches the terrain deepwater color proven above, so this locks
    // in that omitting/explicitly requesting "elevation" never routes through
    // renderTerrain.
    const landOrWater = [LAND_RGBA, WATER_RGBA].map((c) => JSON.stringify(c));
    for (let i = 0; i < explicit.length; i += 4) {
      const px = JSON.stringify(Array.from(explicit.slice(i, i + 4)));
      expect(landOrWater).toContain(px);
    }
  });

  it("view 'all' composites all five overlays onto terrain (exactly the union of the single-overlay diffs)", () => {
    // 128x128 px at 4 tiles/px over world [512, 1024) - a region with resources,
    // enemy bases, cliffs, trees, and rocks all present, which is all this test
    // needs from a window.
    //
    // The rocks-over-resources ordering used to be checked here too, and the
    // 4 tiles/px was chosen (over the 16 this test used before rocks moved above
    // resources) to make a resource pixel ever be a rock pixel at all. That no
    // longer works: when rocks thresholded a probability field they covered
    // ~0.9% of the window, but rolling the game's per-tile placement draw puts
    // them at ~0.07% of tiles, and the intersection with ore in this window is
    // now exactly zero. Re-probing found no window that carries all five
    // overlays AND a workable rocks-and-resources intersection, so that
    // assertion moved to its own test below with its own window, rather than
    // being weakened here. See the comment on that test for the probe.
    //
    // The same factor thinned the plain presence assertion below, twice. Rocks
    // moved to the roll in Task 5, and enemy bases followed in Task 6: this
    // window now holds 5 rock pixels and 5 enemy pixels, against 172 resource,
    // 1539 cliff and 5198 tree (all measured; enemies were 217 while the overlay
    // thresholded `enemy_base_probability`). `rocks.size > 0` and
    // `enemies.size > 0` therefore have far narrower margins than the other
    // three - if a future change moves either placement at all, expect those to
    // be the assertions that go first, and re-probe for a window rather than
    // dropping them.
    const req: ElevationRenderRequest = {
      id: 21,
      seed0: 123456,
      width: 128,
      height: 128,
      originX: 512,
      originY: 512,
      tilesPerPixel: 4,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "terrain",
    };
    const terrain = new Uint8ClampedArray(runRenderRequest(req).buffer);
    const bufFor = (view: ElevationRenderRequest["view"]) =>
      new Uint8ClampedArray(runRenderRequest({ ...req, view }).buffer);
    const diffPixels = (buf: Uint8ClampedArray): Set<number> => {
      const s = new Set<number>();
      for (let i = 0; i < terrain.length; i += 4)
        if (
          buf[i] !== terrain[i] ||
          buf[i + 1] !== terrain[i + 1] ||
          buf[i + 2] !== terrain[i + 2] ||
          buf[i + 3] !== terrain[i + 3]
        )
          s.add(i);
      return s;
    };
    const resourcesBuf = bufFor("resources");
    const allBuf = bufFor("all");
    const resources = diffPixels(resourcesBuf);
    const enemies = diffPixels(bufFor("enemies"));
    const cliffs = diffPixels(bufFor("cliffs"));
    const trees = diffPixels(bufFor("trees"));
    const rocks = diffPixels(bufFor("rocks"));
    const all = diffPixels(allBuf);

    // The chosen region actually exercises all five overlays.
    expect(resources.size).toBeGreaterThan(0);
    expect(enemies.size).toBeGreaterThan(0);
    expect(cliffs.size).toBeGreaterThan(0);
    expect(trees.size).toBeGreaterThan(0);
    expect(rocks.size).toBeGreaterThan(0);

    // "all" is exactly the union of the five: every single-overlay diff is in
    // "all", and "all" paints nothing the five don't (no phantom pixels).
    for (const i of resources) expect(all.has(i)).toBe(true);
    for (const i of enemies) expect(all.has(i)).toBe(true);
    for (const i of cliffs) expect(all.has(i)).toBe(true);
    for (const i of trees) expect(all.has(i)).toBe(true);
    for (const i of rocks) expect(all.has(i)).toBe(true);
    const union = new Set<number>([...resources, ...enemies, ...cliffs, ...trees, ...rocks]);
    expect(all.size).toBe(union.size);

    // The union assertion above is ORDER-INVARIANT - it holds just as well if
    // trees were composited LAST, washing the ore/base/cliff colors green. The
    // overlapping pixels stay in the diff set either way, they are just the
    // wrong color. So pin the order too.
    //
    // Compositing runs terrain -> trees -> resources -> rocks -> enemies ->
    // cliffs, and every overlay paints opaquely, so on any contended pixel the
    // last one to run wins. Checked here: a pixel resources paint that no LATER
    // overlay paints must equal the resources render exactly - trees underneath
    // must not show through. (Rocks-over-resources is the test below.)
    let treesUnder = 0;
    for (const i of resources) {
      // Skip anything a later overlay also paints - rocks included, even though
      // this window has no such pixel today, so the loop stays correct if one
      // ever appears.
      if (enemies.has(i) || cliffs.has(i) || rocks.has(i)) continue;
      if (trees.has(i)) treesUnder++;
      expect(
        [allBuf[i], allBuf[i + 1], allBuf[i + 2], allBuf[i + 3]],
        `pixel ${i}: trees must composite UNDER resources`,
      ).toEqual([resourcesBuf[i], resourcesBuf[i + 1], resourcesBuf[i + 2], resourcesBuf[i + 3]]);
    }
    // ...and that assertion is only meaningful where the two overlays actually
    // contend for the same pixel, so prove this window has such pixels rather
    // than passing because they never meet.
    expect(treesUnder, "window must have pixels both trees and resources paint").toBeGreaterThan(0);
  });

  it("view 'all' composites rocks OVER resources", () => {
    // Split out of the union test above when Nauvis rocks moved from a
    // probability threshold to the game's per-tile placement roll: rocks now
    // cover ~0.07% of tiles instead of ~0.9%, so the two overlays almost never
    // contend, and the union test's window lost its last shared pixel.
    //
    // **Re-chosen in Task 8, when crude oil stopped being a threshold.** The
    // previous window (origin (0, 1024)) rested on 3-4 shared pixels, and it
    // turned out they were OIL pixels: once oil moved to a per-tile roll its
    // 1234-tile blob in that neighbourhood collapsed to a handful of wells, the
    // shared count went to exactly 0, and this test failed. That is the guard
    // working - `progress.md` had flagged the 4-pixel margin as "thin but
    // deterministic" one task earlier - but it also means the old window was
    // never really testing rocks against *ore*.
    //
    // The replacement is picked against the post-oil predicates directly rather
    // than by rendering: every tile in [-1600, 1600)^2 where
    // `makeResourceResolver` (now oil-free) returns non-null AND
    // `makeNauvisRockPlacement` places was collected - 86 of them across the
    // whole 3200x3200 area, which is how scarce this contention now is - then
    // 128x128 windows scored by how many they contain. Origin (71, 1302) holds
    // **11**, the best available, against the old window's 0.
    //
    // Nothing about this window is load-bearing except that the shared count is
    // non-zero, which the final assertion proves rather than assumes.
    const req: ElevationRenderRequest = {
      id: 22,
      seed0: 123456,
      width: 128,
      height: 128,
      originX: 71,
      originY: 1302,
      tilesPerPixel: 1,
      waterLevel: 0,
      segmentationMultiplier: 1,
      startingPositions: [{ x: 0, y: 0 }],
      view: "terrain",
    };
    const terrain = new Uint8ClampedArray(runRenderRequest(req).buffer);
    const bufFor = (view: ElevationRenderRequest["view"]) =>
      new Uint8ClampedArray(runRenderRequest({ ...req, view }).buffer);
    const diffPixels = (buf: Uint8ClampedArray): Set<number> => {
      const s = new Set<number>();
      for (let i = 0; i < terrain.length; i += 4)
        if (
          buf[i] !== terrain[i] ||
          buf[i + 1] !== terrain[i + 1] ||
          buf[i + 2] !== terrain[i + 2] ||
          buf[i + 3] !== terrain[i + 3]
        )
          s.add(i);
      return s;
    };
    const allBuf = bufFor("all");
    const resources = diffPixels(bufFor("resources"));
    const rocks = diffPixels(bufFor("rocks"));
    // The two overlays that composite AFTER rocks; a pixel either of them paints
    // says nothing about rock-vs-resource order. Empty in this window today, but
    // rendered rather than assumed so the exclusion stays honest.
    const enemies = diffPixels(bufFor("enemies"));
    const cliffs = diffPixels(bufFor("cliffs"));

    let rocksOver = 0;
    for (const i of resources) {
      if (enemies.has(i) || cliffs.has(i) || !rocks.has(i)) continue;
      rocksOver++;
      expect(
        [allBuf[i], allBuf[i + 1], allBuf[i + 2]],
        `pixel ${i}: rocks must composite OVER resources`,
      ).toEqual([...ROCK_MAP_COLOR]);
    }
    expect(rocksOver, "window must have pixels both rocks and resources paint").toBeGreaterThan(0);
  });
});

describe("view: trees", () => {
  // World window (420, -280) at 4 tiles/px over a 12x12 image, seed 123456.
  // NOTE: the origin (0, 0) that a naive test would reach for sits inside the
  // game's starting-area clearing (tree density is genuinely 0 within 60 tiles
  // of a spawn point - see treeField.ts's `distance / 20 - 3` term), so a
  // "renders differ" assertion there would pass for the wrong reason (nothing
  // painted at all). This window was chosen because sampling it directly with
  // makeTreeDensity shows real, non-zero cover; the assertion below proves that
  // in-line so the test cannot silently pass while exercising an empty forest.
  const base = {
    id: 1,
    seed0: 123456,
    width: 12,
    height: 12,
    originX: 420,
    originY: -280,
    tilesPerPixel: 4,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    mapType: "nauvis" as const,
  };

  it("samples a window with genuine, non-zero tree density", () => {
    const density = makeTreeDensity({ seed0: base.seed0 });
    let nonZero = 0;
    for (let py = 0; py < base.height; py++) {
      for (let px = 0; px < base.width; px++) {
        const wx = base.originX + px * base.tilesPerPixel;
        const wy = base.originY + py * base.tilesPerPixel;
        if (density(wx, wy) > 0) nonZero++;
      }
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it("renders terrain with the tree overlay composited on top", () => {
    const terrain = runRenderRequest({ ...base, view: "terrain" });
    const trees = runRenderRequest({ ...base, view: "trees" });
    expect(Array.from(new Uint8ClampedArray(trees.buffer))).not.toEqual(
      Array.from(new Uint8ClampedArray(terrain.buffer)),
    );
  });

  // Trees are the only consumer of `temperature`, and there is no UI for
  // control:temperature:* - it reaches the render only from an imported exchange
  // string. So this is the one assertion standing between a dropped field and a
  // silently wrong forest layout. A bias this large pushes temperature out of
  // every species' ramp, so the overlay must vanish back to bare terrain.
  it("forwards temperatureBias through to the tree overlay", () => {
    const terrain = runRenderRequest({ ...base, view: "terrain" });
    const trees = runRenderRequest({ ...base, view: "trees" });
    const frozen = runRenderRequest({ ...base, view: "trees", temperatureBias: -1000 });
    // The overlay is doing something to begin with...
    expect(Array.from(new Uint8ClampedArray(trees.buffer))).not.toEqual(
      Array.from(new Uint8ClampedArray(terrain.buffer)),
    );
    // ...and the lever turns it off, which it cannot do if the field is dropped.
    expect(Array.from(new Uint8ClampedArray(frozen.buffer))).toEqual(
      Array.from(new Uint8ClampedArray(terrain.buffer)),
    );
  });

  it("forwards temperatureFrequency through to the tree overlay", () => {
    const trees = runRenderRequest({ ...base, view: "trees" });
    const warped = runRenderRequest({ ...base, view: "trees", temperatureFrequency: 4 });
    expect(Array.from(new Uint8ClampedArray(warped.buffer))).not.toEqual(
      Array.from(new Uint8ClampedArray(trees.buffer)),
    );
  });

  it("includes trees in the all-composite", () => {
    const withoutTrees = runRenderRequest({ ...base, view: "cliffs" });
    const all = runRenderRequest({ ...base, view: "all" });
    expect(Array.from(new Uint8ClampedArray(all.buffer))).not.toEqual(
      Array.from(new Uint8ClampedArray(withoutTrees.buffer)),
    );
  });

  it("honors treeControls", () => {
    const a = runRenderRequest({ ...base, view: "trees" });
    const b = runRenderRequest({
      ...base,
      view: "trees",
      treeControls: { frequency: 3, size: 2 },
    });
    expect(Array.from(new Uint8ClampedArray(a.buffer))).not.toEqual(
      Array.from(new Uint8ClampedArray(b.buffer)),
    );
  });

  it("defaults treeControls to 1/1 when omitted", () => {
    const implicit = runRenderRequest({ ...base, view: "trees" });
    const explicit = runRenderRequest({
      ...base,
      view: "trees",
      treeControls: { frequency: 1, size: 1 },
    });
    expect(Array.from(new Uint8ClampedArray(implicit.buffer))).toEqual(
      Array.from(new Uint8ClampedArray(explicit.buffer)),
    );
  });
});

describe("cliffCellQueryBox", () => {
  const full = { originX: -64, originY: -64, width: 128, height: 128 };
  const req = (over: Partial<ElevationRenderRequest>): ElevationRenderRequest => ({
    id: 0,
    seed0: 1,
    width: 32,
    height: 32,
    originX: -64,
    originY: -64,
    tilesPerPixel: 1,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    ...over,
  });

  it("is the plain pixel box when the request is the whole image", () => {
    expect(cliffCellQueryBox(req({}))).toEqual({ x0: -64, y0: -64, x1: -32, y1: -32 });
  });

  it("widens an interior tile by the mark radius on every side", () => {
    // Interior tile at pixel offset (32, 32) of the 128x128 image.
    const box = cliffCellQueryBox(req({ originX: -32, originY: -32, fullImage: full }));
    expect(box).toEqual({ x0: -34, y0: -34, x1: 2, y1: 2 });
  });

  it("clamps to the image edge instead of widening past it", () => {
    // Top-left tile: the low sides must NOT be widened past the image origin,
    // because the untiled render drops cells centered outside the image.
    const box = cliffCellQueryBox(req({ fullImage: full }));
    expect(box.x0).toBe(full.originX);
    expect(box.y0).toBe(full.originY);
    expect(box.x1).toBe(-30); // interior side still widened
    expect(box.y1).toBe(-30);
  });

  it("clamps the far edge of the last tile", () => {
    const box = cliffCellQueryBox(req({ originX: 32, originY: 32, fullImage: full }));
    expect(box.x1).toBe(full.originX + full.width); // tpp 1
    expect(box.y1).toBe(full.originY + full.height);
  });

  it("scales the halo by tilesPerPixel", () => {
    const box = cliffCellQueryBox(
      req({ originX: -32, originY: -32, tilesPerPixel: 4, fullImage: full }),
    );
    expect(box.x0).toBe(-32 - 8); // CLIFF_MARK_BACK_PX * 4
  });
});
