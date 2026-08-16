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
 * The refine count for every test here that asserts nothing about the SIZE of
 * the refine set. The exact value 3 is measured, not arbitrary - see below.
 *
 * WHY NOT THE DEFAULT: radius 600 at `SEED0` returns 35 deduped rows, so
 * `DEFAULT_REFINE_COUNT` (50) refines every one of them - and refinement is the
 * expensive half, because `measure`'s grow-and-re-render loop pays 16x the
 * pixels for the same pad at 2 tiles/px that it pays at 8. Measured per test on
 * a dev machine: 41-58s at the default against 15-31s here, and the whole file
 * 240s against 135s. CI shards by file, the binding shard was 389s, and runner
 * spread is about 40% against a 300s per-test budget - so the default adds most
 * of a second binding shard to the gate for coverage it does not buy.
 *
 * WHY 3 AND NOT 2: only at 3 do the grouped and flat orderings actually
 * disagree on this data, which is what lets the sort test below discriminate.
 * Measured across the whole ladder (smallest refined area vs largest unrefined
 * area, in tiles):
 *
 *   count 1: 19,684 vs 17,920 - no crossing
 *   count 2: 17,440 vs 17,280 - no crossing
 *   count 3: 14,256 vs 16,640 - CROSSING
 *   count 5: 13,800 vs 11,648 - no crossing
 *
 * At 3, cell (-2,-3) refines from a coarse 17,280 down to a true 14,256 and so
 * falls below two rows still carrying coarse numbers, (-1,2) at 16,640 and
 * (2,1) at 14,976. The window is narrow because the refine set is chosen BY
 * coarse area, so the refined group starts out holding the largest rows and
 * only a row that shrinks a lot on measurement can cross under one left behind.
 *
 * Two tests deliberately do NOT use this:
 *
 * - "grows the render window ..." passes 0, because it is about the coarse
 *   pass and wants no refinement at all.
 * - "reports progress ..." keeps the default, and cannot be cheapened this way.
 *   The overcount it guards against was `candidates.length +
 *   Math.min(refineCount, candidates.length)`, which differs from the correct
 *   `candidates.length + toRefine.length` only when `refineCount` exceeds the
 *   DEDUPED count (35 here, against 41 candidates). At 3 both arithmetics give
 *   44 and the bug is invisible; at 36 or more the refine set is the whole
 *   deduped list again, so there is nothing left to save.
 */
const CHEAP_REFINE_COUNT = 3;

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
    await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute: spy,
      concurrency: 4,
      refineCount: CHEAP_REFINE_COUNT,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(["terrain"]);
  }, 300000);

  it("returns islands with a rectangle no larger than their land area", async () => {
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
      refineCount: CHEAP_REFINE_COUNT,
    });
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) {
      expect(r.rect.width * r.rect.height).toBeLessThanOrEqual(r.landTiles);
      expect(r.landTiles).toBeGreaterThan(0);
    }
  }, 300000);

  it("sorts refined rows as a group above unrefined ones, each group by area descending", async () => {
    // NOT a flat area sort, and that is deliberate. An unrefined row's
    // rectangle was measured at `COARSE_TILES_PER_PIXEL` (8), so its area is
    // quantized to 64-tile blocks and biased upward - a coarse pixel counts as
    // land if its one sample does. Such a row can carry a bigger number than a
    // refined row that is genuinely larger, so `compareResults` ranks the whole
    // refined group first. See its header in `findIslands.ts`.
    //
    // `CHEAP_REFINE_COUNT` is what makes that observable, and it took a
    // measurement to find - at the default 50 every one of the 35 deduped rows
    // at this radius gets refined, so the unrefined group is EMPTY, the two
    // orderings trivially coincide, and a flat-area assertion (which is what
    // this test used to make) passes while testing nothing. Lowering the count
    // is necessary but not sufficient: at 1, 2 and 5 the orderings still agree.
    // See `CHEAP_REFINE_COUNT` for the ladder.
    //
    // Confirmed to discriminate by planting the break: dropping the
    // `a.refined !== b.refined` line from `compareResults` - i.e. restoring the
    // flat sort this test used to assert - fails the group-boundary assertion
    // below with "expected false to be true", because refined row (-2,-3)
    // moves down past two unrefined rows.
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
      refineCount: CHEAP_REFINE_COUNT,
    });
    const area = (r: IslandResult) => r.rectTiles.width * r.rectTiles.height;
    // -1 (no unrefined row) and 0 (no refined prefix) both fail here, so this
    // one assertion pins the group boundary AND that neither group is empty.
    const firstUnrefined = found.findIndex((r) => !r.refined);
    expect(firstUnrefined).toBeGreaterThan(0);
    expect(found.slice(firstUnrefined).every((r) => !r.refined)).toBe(true);
    for (const group of [found.slice(0, firstUnrefined), found.slice(firstUnrefined)]) {
      const areas = group.map(area);
      expect([...areas].sort((a, b) => b - a)).toEqual(areas);
    }
    // ...and the two orderings must actually DISAGREE on this data, or every
    // assertion above would hold for a plain area sort too. A red line here
    // does not mean the sort broke - it means this test went vacuous, the way
    // the flat-sort version it replaced was. Fix it by re-establishing a real
    // coarse/refined area crossing, never by deleting the check.
    const key = (r: IslandResult) => `${r.cellX},${r.cellY}`;
    const flat = [...found].sort((a, b) => area(b) - area(a));
    expect(flat.map(key)).not.toEqual(found.map(key));
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
      refineCount: CHEAP_REFINE_COUNT,
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
    // The one heavy test that keeps the default refine count on purpose - see
    // `CHEAP_REFINE_COUNT`. A small count makes the wrong and right totals
    // equal, so this would pass on the very bug it exists to catch.
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
