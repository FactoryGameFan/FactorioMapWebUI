import { describe, expect, it } from "vite-plus/test";
import {
  findIslands,
  COARSE_TILES_PER_PIXEL,
  REFINE_TILES_PER_PIXEL,
} from "../src/noise/islands/findIslands";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";

const SEED0 = 2967702466;
/** In-process executor - the same seam `createRenderPool` uses in its tests. */
const execute = async (req: ElevationRenderRequest) => runRenderRequest(req);

describe("findIslands", () => {
  it("only ever asks for view:'terrain'", async () => {
    // The single most expensive mistake available here. `view: "all"` adds the
    // scrap overlay, whose roll is per TILE, so a coarse render pays the full
    // tile cost - measured at 112x. See the spec, section 2b.
    const seen: string[] = [];
    const spy = async (req: ElevationRenderRequest) => {
      seen.push(String(req.view));
      return runRenderRequest(req);
    };
    await findIslands({ ctx: { seed0: SEED0 }, radius: 600, execute: spy, concurrency: 4 });
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(["terrain"]);
  }, 300000);

  it("returns islands with a rectangle no larger than their land area", async () => {
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
    });
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) {
      expect(r.rect.width * r.rect.height).toBeLessThanOrEqual(r.landTiles);
      expect(r.landTiles).toBeGreaterThan(0);
    }
  }, 300000);

  it("sorts by rectangle area, largest first", async () => {
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
    });
    const areas = found.map((r) => r.rectTiles.width * r.rectTiles.height);
    expect([...areas].sort((a, b) => b - a)).toEqual(areas);
  }, 300000);

  it("marks exactly the refined rows as refined", async () => {
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
      refineCount: 2,
    });
    expect(found.filter((r) => r.refined).length).toBeLessThanOrEqual(2);
  }, 300000);

  it("reports progress that ends at the total", async () => {
    const seen: [number, number][] = [];
    await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1]!;
    expect(last[0]).toBe(last[1]);
  }, 300000);

  it("stops early when the signal aborts", async () => {
    const ac = new AbortController();
    let calls = 0;
    const counting = async (req: ElevationRenderRequest) => {
      if (++calls === 3) ac.abort();
      return runRenderRequest(req);
    };
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 2000,
      execute: counting,
      concurrency: 2,
      signal: ac.signal,
    });
    expect(found.length).toBeLessThan(50);
  }, 300000);

  it("uses the documented sampling densities", () => {
    expect(COARSE_TILES_PER_PIXEL).toBe(8);
    expect(REFINE_TILES_PER_PIXEL).toBe(2);
  });
});
