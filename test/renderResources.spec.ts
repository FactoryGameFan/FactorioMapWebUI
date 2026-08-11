import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderResources, WATER_TILE_COLORS } from "../src/noise/preview/renderResources";
import { RESOURCE_CATALOG } from "../src/noise/resources/resourceCatalog";
import { makeTileCatalog } from "../src/noise/tiles/catalog";

/** A base filled with a sentinel color no resource uses, alpha 255. */
function sentinelBase(w: number, h: number): ImageData {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = 7;
    d[i * 4 + 1] = 8;
    d[i * 4 + 2] = 9;
    d[i * 4 + 3] = 255;
  }
  return new ImageData(d, w, h);
}

const catalogColors = new Set(RESOURCE_CATALOG.map((r) => r.mapColor.join(",")));

describe("renderResources", () => {
  it("paints resource patches and leaves terrain (sentinel) elsewhere", () => {
    // 64x64 px at 16 tiles/px over world [512, 1536) - a region with patches.
    const base = sentinelBase(64, 64);
    renderResources(base, {
      seed0: 123456,
      originX: 512,
      originY: 512,
      tilesPerPixel: 16,
      controls: {},
    });

    let painted = 0;
    let sentinel = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const [r, g, b, a] = [
        base.data[i * 4],
        base.data[i * 4 + 1],
        base.data[i * 4 + 2],
        base.data[i * 4 + 3],
      ];
      if (r === 7 && g === 8 && b === 9) {
        sentinel++;
      } else {
        painted++;
        expect(a).toBe(255);
        expect(catalogColors.has(`${r},${g},${b}`)).toBe(true);
      }
    }
    expect(painted).toBeGreaterThan(0); // some ore appears
    expect(sentinel).toBeGreaterThan(0); // but not everywhere
  });

  it("never paints ore over water: a fully water-colored base is unchanged", () => {
    // Fill the base with deepwater color over a region full of patches; since every
    // pixel is a water tile, resources collide with all of them -> nothing painted.
    const W = 64;
    const [dr, dg, db] = WATER_TILE_COLORS[0];
    const base = new ImageData(new Uint8ClampedArray(W * W * 4), W, W);
    for (let i = 0; i < W * W; i++) {
      base.data[i * 4] = dr;
      base.data[i * 4 + 1] = dg;
      base.data[i * 4 + 2] = db;
      base.data[i * 4 + 3] = 255;
    }
    const before = Uint8ClampedArray.from(base.data);
    renderResources(base, {
      seed0: 123456,
      originX: 512,
      originY: 512,
      tilesPerPixel: 16,
      controls: {},
    });
    expect(Array.from(base.data)).toEqual(Array.from(before));
  });

  it("WATER_TILE_COLORS matches the tile catalog's water/deepwater map_colors", () => {
    const cat = makeTileCatalog(0);
    const water = (name: string) => cat.find((t) => t.name === name)!.color;
    expect(WATER_TILE_COLORS).toContainEqual([
      water("deepwater")[0],
      water("deepwater")[1],
      water("deepwater")[2],
    ]);
    expect(WATER_TILE_COLORS).toContainEqual([
      water("water")[0],
      water("water")[1],
      water("water")[2],
    ]);
    expect(WATER_TILE_COLORS.length).toBe(2);
  });

  it("leaves the spawn pixel untouched (no patches inside the fade-in radius)", () => {
    const base = sentinelBase(1, 1);
    renderResources(base, {
      seed0: 123456,
      originX: 0,
      originY: 0,
      tilesPerPixel: 1,
      controls: {},
    });
    expect([base.data[0], base.data[1], base.data[2]]).toEqual([7, 8, 9]);
  });

  describe("elevation-coupling ctx forwarding", () => {
    afterEach(() => {
      // The static imports above (already resolved at file load) keep using the
      // real module regardless; this only un-mocks for any later dynamic import.
      vi.doUnmock("../src/noise/resources/resolveResource");
      vi.resetModules();
    });

    it("forwards segmentationMultiplier/waterLevel/startingLakePositions into makeResourceResolver", async () => {
      const resolverFactory = vi.fn(() => () => null);
      // A PARTIAL mock: `renderResources` also imports `comparePriority` from this
      // module (it shares the resolver's own priority rule to protect crude oil's
      // marks - see renderResourcesPaintOrder.spec.ts), so replacing the whole
      // module leaves that import undefined and the render throws.
      vi.doMock("../src/noise/resources/resolveResource", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../src/noise/resources/resolveResource")>()),
        makeResourceResolver: resolverFactory,
      }));
      vi.resetModules();
      const { renderResources: mockedRenderResources } =
        await import("../src/noise/preview/renderResources");

      const startingLakePositions = [{ x: 3, y: 4 }];
      const base = sentinelBase(4, 4);
      mockedRenderResources(base, {
        seed0: 123456,
        controls: {},
        segmentationMultiplier: 1.7,
        waterLevel: 3,
        startingLakePositions,
      });

      expect(resolverFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          segmentationMultiplier: 1.7,
          waterLevel: 3,
          startingLakePositions,
        }),
      );
    });
  });
});
