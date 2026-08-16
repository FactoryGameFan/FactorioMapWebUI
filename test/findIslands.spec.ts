import { describe, expect, it } from "vite-plus/test";
import {
  findIslands,
  nearestLandPixel,
  compareResults,
  COARSE_TILES_PER_PIXEL,
  REFINE_TILES_PER_PIXEL,
  type IslandResult,
} from "../src/noise/islands/findIslands";
import { floodFillFrom, landMaskFromImage } from "../src/noise/islands/islandMask";
import {
  runRenderRequest,
  type ElevationRenderRequest,
} from "../src/noise/preview/elevationRenderRequest";

const SEED0 = 2967702466;
/** In-process executor - the same seam `createRenderPool` uses in its tests. */
const execute = async (req: ElevationRenderRequest) => runRenderRequest(req);

/**
 * A fixed grid every `landTilesOf` reconstruction snaps to, INDEPENDENT of
 * whichever `tpp` `findIslands` happened to measure a given row at.
 *
 * A first version of this helper rendered each row at its OWN `tpp` (coarse
 * 8, refined 2) from its OWN `windowFor`-derived origin, and it passed
 * against pre-fix code that is known (by direct measurement) to duplicate
 * islands - a false negative. The cause: two rows' pixel grids are offset
 * from each other whenever their window origins are not congruent modulo
 * `tpp`, so exact world-tile-key comparisons between two INDEPENDENTLY
 * positioned coarse grids can miss real, substantial overlap even where the
 * underlying land is identical. Rendering every row through this same fixed
 * `tpp` and an origin snapped to a multiple of it puts every reconstruction
 * on ONE shared coordinate grid, so a real overlap cannot hide between
 * samples.
 */
const OVERLAP_TPP = REFINE_TILES_PER_PIXEL;
/** Generous margin around a row's own sampled bounding box - independent of, and wider than, `findIslands`'s internal `WINDOW_PAD_TILES`. */
const OVERLAP_PAD_TILES = 64;

function snapDown(v: number, step: number): number {
  return Math.floor(v / step) * step;
}

/**
 * Independently re-derives the land tiles a returned `IslandResult` covers,
 * by rendering fresh (not reusing `findIslands`'s own internal masks) at the
 * shared `OVERLAP_TPP` grid above. Returns a set of `"x,y"` world tile keys.
 */
async function landTilesOf(r: IslandResult): Promise<Set<string>> {
  const tpp = OVERLAP_TPP;
  const originX = snapDown(r.minX - OVERLAP_PAD_TILES, tpp);
  const originY = snapDown(r.minY - OVERLAP_PAD_TILES, tpp);
  const width = Math.max(1, Math.ceil((r.maxX + OVERLAP_PAD_TILES - originX) / tpp));
  const height = Math.max(1, Math.ceil((r.maxY + OVERLAP_PAD_TILES - originY) / tpp));
  const res = await execute({
    id: 0,
    seed0: SEED0,
    planet: "fulgora",
    view: "terrain",
    width,
    height,
    originX,
    originY,
    tilesPerPixel: tpp,
  } as unknown as ElevationRenderRequest);
  const rgba = new Uint8ClampedArray(res.buffer);
  const all = landMaskFromImage(rgba, width, height);
  const seedPx = Math.round((r.centroidX - originX) / tpp);
  const seedPy = Math.round((r.centroidY - originY) / tpp);
  const seed = nearestLandPixel(all, width, height, seedPx, seedPy);
  const tiles = new Set<string>();
  if (seed === undefined) return tiles;
  const mine = floodFillFrom(all, width, height, seed.x, seed.y);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      if (mine[py * width + px]) tiles.add(`${originX + px * tpp},${originY + py * tpp}`);
    }
  }
  return tiles;
}

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

  it("never reports the same physical island twice - no two results share a land tile", async () => {
    // `islandMask`'s flood fill deliberately crosses Voronoi cell boundaries
    // (two cells whose land touches ARE one island), but `surveyIslands`
    // enumerates one candidate per CELL - so several adjacent cells can each
    // flood-fill an overlapping slice of the SAME island into their own row
    // unless something deduplicates them. Verified independently here by
    // re-rendering each result's own window and re-flood-filling from its
    // own centroid, rather than trusting `findIslands`'s internal bookkeeping.
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
    });
    expect(found.length).toBeGreaterThan(0);
    const sets = await Promise.all(found.map((r) => landTilesOf(r)));
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i]!;
        const b = sets[j]!;
        let shared = 0;
        for (const t of a) if (b.has(t)) shared++;
        expect(shared, `results ${i} and ${j} share ${shared} land tile(s)`).toBe(0);
      }
    }
  }, 300000);

  it("grows the render window and re-measures when the isolated island mask touches the border", async () => {
    // Cells (-1,-1) and (-1,0) are two Voronoi views of the SAME connected
    // island, and its coastline runs right past the flat pad-32 window edge -
    // so BOTH candidates' pad-32 flood fills are truncated (the isolated mask
    // touches the border). Dedup keeps whichever of the two saw more land at
    // that truncated size; measured directly with growth disabled: (-1,-1) =
    // 20,992 tiles / 10x11 rect, (-1,0) = 32,000 tiles / 25x9 rect, so (-1,0)
    // wins pre-fix and (-1,-1) does not appear in the results at all.
    // Growing the window on border contact lets either candidate's flood fill
    // reach the island's true extent - both converge to the SAME 70,016
    // tiles / 34x9 rectangle once the mask stops touching the border, which
    // happens at pad 256 for this island (confirmed unchanged at pad 400, so
    // the 3-growth cap is not itself the limit here).
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
      refineCount: 0,
    });
    const row = found.find(
      (r) => (r.cellX === -1 && r.cellY === -1) || (r.cellX === -1 && r.cellY === 0),
    );
    expect(row).toBeDefined();
    expect(row!.clipped).toBe(false);
    expect(row!.landTiles).toBeGreaterThan(32000);
    expect(row!.rect.width * row!.rect.height).toBeGreaterThan(25 * 9);
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

  it("reports progress that ends at the total, WITHOUT the end-of-run fallback firing", async () => {
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
    // `total` is computed from candidates.length + a refine count that isn't
    // known until AFTER the zero-land filter and the dedup pass have both run
    // - an overcounted total would leave `done` short at the end, papered
    // over by the fallback call `if (done < total) onProgress(total, total)`.
    // That fallback call reports `done` as `total` WITHOUT it being one more
    // than the previous call's `done` - a real tick always increments `done`
    // by exactly 1, so checking every call's `done` against its own 1-based
    // call index catches a fallback-covered overcount that comparing only
    // the last tuple (above) cannot: an overcounted total's last REAL tick
    // still has `done < total`, so the fallback appends one more call whose
    // `done` jumps straight to `total`, skipping call-index+1.
    expect(seen.map(([d]) => d)).toEqual(seen.map((_unused, i) => i + 1));
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

/** A minimal row for `compareResults` - only the fields the comparator reads matter. */
function stubResult(over: { refined: boolean; area: number }): IslandResult {
  return {
    cellX: 0,
    cellY: 0,
    id: 0.8,
    klass: "mesa",
    sampleCount: 1,
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    centroidX: 0,
    centroidY: 0,
    rect: { x: 0, y: 0, width: over.area, height: 1 },
    rectTiles: { width: over.area, height: 1 },
    landTiles: over.area,
    refined: over.refined,
    clipped: false,
    chainId: 0,
    distanceFromSpawn: 0,
  };
}

describe("compareResults", () => {
  it("sorts refined rows before unrefined rows, even when an unrefined row's area is larger", () => {
    // This is the exact scenario a plain area sort gets wrong: the unrefined
    // row's coarse area (500) is bigger than the refined row's true area
    // (100), but the refined measurement must still rank first because it is
    // the one that can be trusted.
    const bigUnrefined = stubResult({ refined: false, area: 500 });
    const smallRefined = stubResult({ refined: true, area: 100 });
    const sorted = [bigUnrefined, smallRefined].sort(compareResults);
    expect(sorted).toEqual([smallRefined, bigUnrefined]);
  });

  it("sorts by area descending within each refined/unrefined group", () => {
    const refinedSmall = stubResult({ refined: true, area: 10 });
    const refinedBig = stubResult({ refined: true, area: 90 });
    const unrefinedSmall = stubResult({ refined: false, area: 5 });
    const unrefinedBig = stubResult({ refined: false, area: 50 });
    const sorted = [unrefinedSmall, refinedSmall, unrefinedBig, refinedBig].sort(compareResults);
    expect(sorted).toEqual([refinedBig, refinedSmall, unrefinedBig, unrefinedSmall]);
  });
});
