import { describe, expect, it } from "vite-plus/test";

import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import cliffFix from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import cornerFix from "./fixtures/oracle-vulcanus-cliff-corner-fields.seed123456.json";
import repFix from "./fixtures/oracle-vulcanus-ore-cliff-replication.seed123456.json";
import resFix from "./fixtures/oracle-vulcanus-resource-entities.seed123456.json";

/**
 * The game's cliff/ore separation on Vulcanus, measured entity-to-entity
 * (issue #24). Both sides are the game's own output, captured over identical
 * regions by `test/oracle/capture.ts vulcanus-cliff-entities` and
 * `vulcanus-resource-entities`, so nothing here depends on our port being right.
 *
 * Why it is worth a committed spec rather than a one-off measurement: the
 * separation is the strongest single constraint we have on a mechanism nobody
 * has identified yet, and #24 has already been re-framed twice by re-measuring.
 * Pinning the game's own numbers means the next re-frame starts from data
 * instead of from the previous summary.
 */
const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

function oreTiles(index: number): Set<string> {
  return new Set(resFix.cases[index].resources.map((p) => key(Math.floor(p.x), Math.floor(p.y))));
}

function gameCliffs(index: number): { x: number; y: number }[] {
  return cliffFix.cases[index].cliffs.filter((c) => c.name === "cliff-vulcanus");
}

/** The 4x4 tile block a cliff cell occupies: x in [cx-2, cx+2), y in [cy-2.5, cy+1.5). */
function footprint(cx: number, cy: number): string[] {
  const tiles: string[] = [];
  const y0 = Math.floor(cy - 2.5);
  for (let tx = cx - 2; tx < cx + 2; tx++) {
    for (let ty = y0; ty < y0 + 4; ty++) tiles.push(key(tx, ty));
  }
  return tiles;
}

describe("Vulcanus: the game separates cliffs from ore", () => {
  // READ THE TWO BLOCKS BELOW THIS ONE BEFORE TRUSTING THE INTERPRETATION HERE.
  // The counts in this block are still exactly what the game produced, but two
  // of its conclusions were overturned on 2026-07-29:
  //
  //  * the "chance baseline" / "ratio" columns use tile independence, which does
  //    not hold for two fields that come in a handful of blobs. Under a
  //    shift null, regions 0 and 2 are NOT significant (P = 0.51 and 0.29); only
  //    the ore-rich regions are. See the replication block.
  //  * "there is no single mechanism" understated it: there is no mechanism at
  //    all on the cliff side. `generateCliffs()` reads no resource field, and
  //    substituting the game's own elevation and cliffiness into our placement
  //    does not move one cell - so the overlap our port paints is #18's RULE
  //    error, not a missing exclusion. See the FIELDS/RULE block.
  //
  // Measured 2026-07-28. Region 1's 8/3933 reproduces the figure issue #24 was
  // opened with, from an independent capture - and it comes out identical under
  // either candidate y-anchoring of the footprint, so the result does not rest
  // on that choice.
  //
  // | region | dominant resource | on cliff | chance baseline | ratio |
  // | --- | --- | --- | --- | --- |
  // | 0 `[0,0]` | tungsten | 0 / 945 | 6.9% | 0.000 |
  // | 1 `[1500,1500]` | calcite + geyser | 8 / 3933 | 21.6% | 0.009 |
  // | 2 `[-1200,800]` | coal | 0 / 1047 | 9.8% | 0.000 |
  //
  // It is uniform across all four resource names, which rules out a *per-resource*
  // biome dependency - but NOT terrain generally. **Do not read the uniformity as
  // ruling out terrain**; a dependence the resources SHARE would look exactly like
  // this, and measurement says one partly does. Sampling Vulcanus elevation at the
  // game's own ore and cliff positions (2026-07-28):
  //
  // | region | ore elevation p5/p50/p95 | ore below 70 | cliff elevation p5/p50/p95 |
  // | --- | --- | --- | --- |
  // | 0 `[0,0]` | -25 / 39 / 86 | **81.3%** | 25 / 94 / 300 |
  // | 1 `[1500,1500]` | 738 / 894 / 1169 | 0.0% | 94 / 653 / 949 |
  // | 2 `[-1200,800]` | 300 / 300 / 300 | 0.0% | 27 / 155 / 263 |
  //
  // `cliff_elevation_0 = 70`, so no cliff can exist below 70 at all. In region 0
  // that alone accounts for most of the separation - 81% of the game's ore is
  // under the threshold. In region 2 the ore sits at a flat 300 while every cliff
  // is below 263, so they are disjoint by elevation there too. **Region 1 is not
  // explained**: the ranges genuinely overlap (ore 738-1169, cliffs 94-949) and
  // the separation is still near-total.
  //
  // Region 2 has a sharper version of the same thing: its ore sits on a
  // perfectly FLAT plateau. Local elevation gradient at the game's own ore
  // positions there is 0.00 at p10, p50 and p90, against 5.46/13.59/22.82 at its
  // cliffs. A cliff needs a band crossing between adjacent corners, and a flat
  // field has none, so no cliff can exist there at all.
  //
  // So there is no single mechanism. **Region 1 remains unexplained**, and four
  // candidates have now been measured and FALSIFIED for it - recorded here so
  // they do not get re-tested:
  //
  // 1. **Elevation range.** Only 56% of region 1's cliffs fall outside the band
  //    holding 98% of its ore ([712, 1204]). The other **387 cliffs share the
  //    ore's own elevation band** and still almost no ore sits on them.
  // 2. **Flatness / local gradient.** Region 1's ore and cliffs have effectively
  //    IDENTICAL gradient distributions (p10/p50/p90 = 3.78/10.94/23.06 for ore
  //    vs 4.22/10.98/23.56 for cliffs). Whatever separates them, it is not that
  //    ore sits on flat ground - unlike region 2, where this is the whole story.
  // 3. **The volcano-spot exclusion.** `vulcanus_mountains_resource_favorability`
  //    is `clamp(main_region - (mountain_volcano_spots > 0.78), 0, 1)`, so ore is
  //    genuinely barred from volcano spots - and the game's ore respects it (0.2%
  //    above the cutoff). But only **4.0%** of region 1's cliffs are on volcano
  //    spots, so it cannot account for a ~100x separation.
  // 4. **Collision, on both paths** - see the map-gen mask grid note below.
  const expected: [number, number, number][] = [
    // index, max on-cliff entities, max ratio-to-chance
    [0, 0, 0.001],
    [1, 8, 0.02],
    [2, 0, 0.001],
  ];

  for (const [index, maxOnCliff, maxRatio] of expected) {
    const r = cliffFix.cases[index].region;
    it(`region ${String(index)} [${String(r.x0)},${String(r.y0)}]: the game's ore is ~never on the game's cliffs`, () => {
      const ore = oreTiles(index);
      const cliffs = gameCliffs(index);
      const covered = new Set<string>();
      for (const c of cliffs) for (const t of footprint(c.x, c.y)) covered.add(t);

      let onCliff = 0;
      for (const t of ore) if (covered.has(t)) onCliff++;

      const span = (r.x1 - r.x0) * (r.y1 - r.y0);
      const chance = covered.size / span;
      const rate = onCliff / ore.size;

      expect(ore.size).toBeGreaterThan(500);
      expect(onCliff).toBeLessThanOrEqual(maxOnCliff);
      expect(rate / chance).toBeLessThan(maxRatio);
    });
  }

  it("the separation at [0,0] is far wider than a collision footprint", () => {
    // No ore anywhere within 6 tiles (chebyshev) of ANY of the 283 cliff cell
    // centres. A footprint-scale rejection - the cliff's own 4x4 box - would
    // leave ore free to sit 3 tiles away, so whatever separates them at [0,0]
    // acts over a much larger distance than collision can. The elevation table
    // above is the likely reason here: most of region 0's ore is below the
    // elevation cliffs need to exist at all, so the gap is terrain, not a test.
    //
    // Region 1 behaves differently: calcite comes within 1 tile of a cliff
    // centre and 8 entities land inside footprints. So the mechanism is NOT one
    // uniform distance test, and any fix that models it as a fixed exclusion
    // radius will be wrong on one region or the other.
    //
    // Collision is ruled out on BOTH paths, which is worth recording because the
    // map-gen path is not the one #24 checked. `EntityMapGenerationTask` keeps
    // its own per-tile collision-mask grid over a 96x96 working area (`this+0x90`,
    // one u16 mask-table index per tile); `tryToAddCliff` writes into it and
    // `tryToAddEntity` tests against it via
    // `EntityMapGenerationTask::wouldCollide` (`0x101625468`). So cliffs really do
    // get a chance to block entities at generation time - but the masks still do
    // not intersect (cliff: item/meltable/object/player/water_tile/is_lower_object/
    // is_object/cliff; resource: resource), so this path cannot be what separates
    // them either.
    //
    // Generation ORDER is settled though, and it only goes one way:
    // `computeInternal` calls `generateCliffs()` then `generateEntities()`, and
    // `apply` calls `applyCliffs()` then `applyEntities()`. Cliffs are committed
    // before ore in both phases, so "ore suppressed by cliffs" is possible and
    // "cliffs suppressed by ore" is not.
    const ore = oreTiles(0);
    let closest = Infinity;
    for (const c of gameCliffs(0)) {
      for (let tx = c.x - 8; tx <= c.x + 8; tx++) {
        for (let ty = Math.floor(c.y) - 8; ty <= Math.floor(c.y) + 8; ty++) {
          if (ore.has(key(tx, ty))) {
            closest = Math.min(closest, Math.max(Math.abs(tx - c.x), Math.abs(ty - c.y)));
          }
        }
      }
    }
    expect(closest).toBeGreaterThan(6);
  });

  it("our own over-placement is enriched on ore the game kept clear", () => {
    // The asymmetry that says our residual error and this separation are
    // related: cells we place that the game also places almost never touch ore,
    // but cells we place that the game does NOT have touch ore an order of
    // magnitude more often.
    //
    // | region | true positives on ore | false positives on ore |
    // | --- | --- | --- |
    // | 0 `[0,0]` | 0 / 223 = 0.0% | 8 / 103 = 7.8% |
    // | 1 `[1500,1500]` | 3 / 757 = 0.4% | 20 / 298 = 6.7% |
    //
    // Note the size: 8 and 20 cells out of 103 and 298 false positives. Modelling
    // the exclusion would remove those and move the over-placement ratio from
    // 1.152 -> ~1.124 and 1.192 -> ~1.169. It is a real part of #18's residual
    // but a small one - do not expect it to close the gap.
    const ctx = withCtxDefaults({ seed0: 123456, startingPositions: [{ x: 0, y: 0 }] });
    const fields = makeVulcanusCliffFields(ctx);

    for (const index of [0, 1]) {
      const r = cliffFix.cases[index].region;
      const ore = oreTiles(index);
      const game = new Set(gameCliffs(index).map((c) => key(c.x, c.y)));
      const ours = makeCliffPlacementFromFields(fields, {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
      }).placedCells(r.x0, r.y0, r.x1, r.y1);

      let truePos = 0;
      let truePosOre = 0;
      let falsePos = 0;
      let falsePosOre = 0;
      for (const c of ours) {
        const touches = footprint(c.x, c.y).some((t) => ore.has(t));
        if (game.has(key(c.x, c.y))) {
          truePos++;
          if (touches) truePosOre++;
        } else {
          falsePos++;
          if (touches) falsePosOre++;
        }
      }
      // **The false-positive population has largely collapsed** since the
      // `multisample` grid fix (test/multisampleGrid.spec.ts) took recall to
      // 1.000 / 0.973 / 0.965. Region 0 is down from 103 false positives to 9,
      // too few to measure an enrichment on, so the comparison now runs only
      // where a population survives - region 1, still ~209.
      expect(truePos).toBeGreaterThan(100);
      // True positives never touch ore, and that half is unaffected and still
      // worth pinning: it is the stronger of the two statements.
      expect(truePosOre / truePos).toBeLessThan(0.02);
      if (falsePos < 50) continue;
      // Where enough over-placement remains, it is still enriched on ore the
      // game kept clear - so the exclusion this file documents is real and is
      // part of what is LEFT of #18, not part of what was fixed.
      expect(falsePosOre / falsePos).toBeGreaterThan(0.04);
    }
  }, 120000);
});

/**
 * Region, ore-tile set and cliff-cover set for any of the 11 captured regions,
 * from whichever of the three entity fixtures holds it.
 */
interface RegionCase {
  region: { x0: number; y0: number; x1: number; y1: number };
  ore: Set<string>;
  cover: Set<string>;
  cliffCells: { x: number; y: number }[];
  label: string;
}

function allRegions(): RegionCase[] {
  const out: RegionCase[] = [];
  const push = (
    region: { x0: number; y0: number; x1: number; y1: number },
    resources: { x: number; y: number }[],
    cliffs: { x: number; y: number; name: string }[],
  ): void => {
    const cliffCells = cliffs.filter((c) => c.name === "cliff-vulcanus");
    const cover = new Set<string>();
    for (const c of cliffCells) for (const t of footprint(c.x, c.y)) cover.add(t);
    out.push({
      region,
      ore: new Set(resources.map((p) => key(Math.floor(p.x), Math.floor(p.y)))),
      cover,
      cliffCells,
      label: `[${String(region.x0)},${String(region.y0)}]`,
    });
  };
  for (let i = 0; i < cliffFix.cases.length; i++)
    push(cliffFix.cases[i].region, resFix.cases[i].resources, cliffFix.cases[i].cliffs);
  for (const c of repFix.cases) push(c.region, c.resources, c.cliffs);
  return out;
}

describe("Vulcanus: the separation replicates, but its published chance baseline does not", () => {
  /**
   * `#24`'s headline - "about 100x below chance" - divides the observed overlap
   * by a **tile-independence** baseline (`ore tiles x cliff coverage / area`).
   * That baseline assumes each ore tile is an independent trial. It is not:
   * measured on the committed fixtures, region `[0,0]`'s 945 ore tiles are
   * **2 connected blobs** and `[-1200,800]`'s 1047 are **2**, so those regions
   * carry about one independent trial each.
   *
   * The right null keeps the blobs intact and moves them: shift the whole ore
   * tile set by a random offset on the region torus and re-measure the overlap.
   * 500 shifts per region, seeded, 2026-07-29:
   *
   * | region | ore tiles | blobs | cliff cover | overlap | tile-indep. expectation | shift-null median | P(shift <= observed) |
   * | --- | --- | --- | --- | --- | --- | --- | --- |
   * | `[0,0]` | 945 | 2 | 6.9% | 0 | 65 | 0 | **0.51** |
   * | `[1500,1500]` | 3933 | 25 | 21.6% | 8 | 850 | 789 | **0.000** |
   * | `[-1200,800]` | 1047 | 2 | 9.8% | 0 | 103 | 49 | **0.29** |
   * | `[700,-1800]` | 404 | 9 | 15.2% | 0 | 61 | 55 | 0.02 |
   * | `[-2400,-600]` | 597 | 3 | 12.9% | 1 | 77 | 58 | 0.19 |
   * | `[1100,2600]` | 3045 | 20 | 21.2% | 9 | 645 | 611 | **0.000** |
   * | `[-900,-2500]` | 904 | 4 | 15.9% | 0 | 144 | 110 | 0.18 |
   * | `[-1700,1900]` | 714 | 2 | 22.7% | 0 | 162 | 156 | 0.10 |
   * | `[300,3400]` | 944 | 8 | 2.0% | 0 | 19 | 0 | 0.73 |
   *
   * Two things follow, and they pull in opposite directions.
   *
   * **The effect is real and it replicates.** Pooled over the 9 regions that
   * hold ore, 18 of 12,533 ore tiles sit under a cliff - 0.14% - and the two
   * ore-rich regions each land outside 500 of 500 shifts.
   *
   * **But regions `[0,0]` and `[-1200,800]` were never evidence of it.** Half of
   * all random placements of `[0,0]`'s ore blob also hit zero cliffs. The
   * previous write-up called their ratio-to-chance "0.000" and read that as the
   * strongest signal in the set; it is the weakest. Any future claim here needs
   * the shift null, not the tile product.
   */
  it("the shift null replicates the separation, and retires two regions as evidence", () => {
    const regions = allRegions().filter((r) => r.ore.size > 0);
    expect(regions).toHaveLength(9);

    let pooledOre = 0;
    let pooledOverlap = 0;
    const pValues = new Map<string, number>();

    for (const r of regions) {
      const w = r.region.x1 - r.region.x0;
      const h = r.region.y1 - r.region.y0;
      // Flat cover grid: a string-keyed Set is far too slow for 500 shifts.
      const grid = new Uint8Array(w * h);
      for (const t of r.cover) {
        const [tx, ty] = t.split(",").map(Number);
        const gx = tx - r.region.x0;
        const gy = ty - r.region.y0;
        if (gx >= 0 && gx < w && gy >= 0 && gy < h) grid[gy * w + gx] = 1;
      }
      const oreX: number[] = [];
      const oreY: number[] = [];
      for (const t of r.ore) {
        const [tx, ty] = t.split(",").map(Number);
        oreX.push(tx - r.region.x0);
        oreY.push(ty - r.region.y0);
      }
      const overlap = (dx: number, dy: number): number => {
        let n = 0;
        for (let i = 0; i < oreX.length; i++) {
          const gx = (((oreX[i] + dx) % w) + w) % w;
          const gy = (((oreY[i] + dy) % h) + h) % h;
          n += grid[gy * w + gx];
        }
        return n;
      };
      const observed = overlap(0, 0);
      pooledOre += r.ore.size;
      pooledOverlap += observed;

      // Deterministic LCG so the p-values above are reproducible.
      let seed = 777;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const shifts = 500;
      let atOrBelow = 0;
      for (let s = 0; s < shifts; s++) {
        if (overlap(Math.floor(rnd() * w), Math.floor(rnd() * h)) <= observed) atOrBelow++;
      }
      pValues.set(r.label, atOrBelow / shifts);
    }

    // Replication: pooled 18 / 12533 = 0.14%.
    expect(pooledOre).toBe(12533);
    expect(pooledOverlap).toBe(18);

    // The two ore-rich regions are the only ones that carry real signal.
    expect(pValues.get("[1500,1500]")).toBeLessThan(0.005);
    expect(pValues.get("[1100,2600]")).toBeLessThan(0.005);
    // And the two the previous write-up leaned on carry none. This asserts
    // something about the NULL, not about our port - it uses only game data.
    expect(pValues.get("[0,0]")).toBeGreaterThan(0.2);
    expect(pValues.get("[-1200,800]")).toBeGreaterThan(0.15);
  }, 60000);
});

/** The corner-field fixture, keyed for lookup by corner index. */
function gameCornerFields(): { elevation: Map<string, number>; cliffiness: Map<string, number> } {
  const elevation = new Map<string, number>();
  const cliffiness = new Map<string, number>();
  cornerFix.corners.forEach((k, i) => {
    elevation.set(k, cornerFix.elevation[i]);
    cliffiness.set(k, cornerFix.cliffiness[i]);
  });
  return { elevation, cliffiness };
}

/** World position -> corner index, inverting how `cliffPlacement` samples. */
const cornerIndex = (x: number, y: number): string =>
  key(x / cornerFix.grid, Math.round((y - cornerFix.cornerOffsetY) / cornerFix.grid));

describe("Vulcanus cliffs: the port's FIELDS are exact; the residual is in the RULE", () => {
  /**
   * The measurement `#18` never had, and the one that resolves `#24`.
   *
   * `EntityMapGenerationTask::generateCliffs()` (`0x1016229b4`, 2.1.12 arm64)
   * calls exactly three things - `CliffGenerator::crossingsForChunk`,
   * `CellCliffCrossing::toMaybeCliffOrientation` (inlined) and `tryToAddCliff` -
   * and nothing else: no tile lookup, no entity lookup, no resource field.
   * `tryToAddCliff`'s only rejection is `wouldCollide`, and that is gated behind
   * `mode == 2` (`ldrb w8,[x0,#0x10]; cmp w8,#0x2; b.ne`). `computeInternal`
   * calls `generateCliffs()` then `generateEntities()` (three times), and `apply`
   * calls `applyCliffs()`, `applyDecoratives()`, `applyEntities()` - re-read
   * directly here rather than taken from the previous write-up. So **cliff
   * placement is a pure function of `cliff_elevation` and `cliffiness`**, and
   * there is no ore/cliff exclusion in the engine to port.
   *
   * That makes the disagreement locatable. Substituting the GAME's own values
   * for both fields at all 12,675 captured corners, over three
   * calcite-dominated regions, and running our own
   * `makeCliffPlacementFromFields` on them:
   *
   * | region | cells | TP | FP | FN | precision | recall |
   * | --- | --- | --- | --- | --- | --- | --- |
   * | `[1500,1500]` | 3844 | 706 | 290 | 90 | 0.709 | 0.887 |
   * | `[1100,2600]` | 3844 | 720 | 199 | 86 | 0.783 | 0.893 |
   * | `[-1700,1900]` | 3844 | 744 | 156 | 123 | 0.827 | 0.858 |
   *
   * and the placed cell set is **identical, cell for cell, to the one our own
   * fields produce** - not one cell flips. That is what an accurate field
   * predicts: a cell can only flip if a corner sits within the field error of a
   * band boundary, and at ~5e-6 relative error against 120-wide bands the
   * expected number of flips over ~14k corner reads is ~2e-4.
   *
   * **So #18's residual is not a field-accuracy problem.** 17-29% of the cliff
   * cells the port places are wrong, and 11-14% of the game's are missed, with
   * the game's own inputs. The error is in the rule as ported -
   * `crossingsForChunk`'s sampling geometry, the `cliff_smoothing` knot model,
   * `toMaybeCliffOrientation`, or `fixImpossibleCells`.
   */
  const REGIONS = cornerFix.regions;

  function placementForRegion(index: number, source: "game" | "ours" | "game+3"): Set<string> {
    const r = REGIONS[index];
    const ctx = withCtxDefaults({ seed0: cornerFix.seed, startingPositions: [{ x: 0, y: 0 }] });
    const ours = makeVulcanusCliffFields(ctx);
    const { elevation, cliffiness } = gameCornerFields();
    // Out-of-lattice corners fall back to our own field. The chunk-structured
    // placement path rounds the query box out to whole 32-tile chunks, so it
    // reads a fringe of corners outside the captured region; substituting a
    // sentinel there would inject a fake result instead of measuring one.
    const bias = source === "game+3" ? 3 : 0;
    const fields =
      source === "ours"
        ? ours
        : {
            cliffElevation: (x: number, y: number): number => {
              const v = elevation.get(cornerIndex(x, y));
              return v === undefined ? ours.cliffElevation(x, y) : v + bias;
            },
            cliffiness: (x: number, y: number): number =>
              cliffiness.get(cornerIndex(x, y)) ?? ours.cliffiness(x, y),
          };
    const cells = makeCliffPlacementFromFields(fields, {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing: VULCANUS_CLIFF_SMOOTHING,
    }).placedCells(r.x0, r.y0, r.x1, r.y1);
    return new Set(cells.map((c) => key(c.x, c.y)));
  }

  it("substituting the game's TILE-CHANNEL fields now MOVES cells", () => {
    // **Inverted 2026-08-01.** These fixtures sample `vulcanus_elevation` through
    // `calculate_tile_properties`, whose noise program has a 1-tile grid, while
    // the CLIFF generator's has a 4-tile one - and `multisample`'s offsets are in
    // GRID UNITS, so `vulcanus_basalt_lakes_multisample`'s min-filter spans 4
    // tiles for cliffs and 1 tile here (test/multisampleGrid.spec.ts). The port
    // now reads the cliff-channel field, so these values are the right numbers
    // for the wrong consumer and must NOT reproduce our placement.
    //
    // This test agreeing for months is how the wrong channel stayed invisible:
    // the fixture and the port were making the same mistake, so they agreed with
    // each other rather than with the game.
    for (let i = 0; i < REGIONS.length; i++) {
      const game = placementForRegion(i, "game");
      const ours = placementForRegion(i, "ours");
      expect(game.size).toBeGreaterThan(500);
      expect([...game].sort()).not.toEqual([...ours].sort());
    }
  }, 180000);

  it("and the substitution really is live - a +3 elevation bias does move cells", () => {
    // Guards the assertion above against passing vacuously (e.g. if every
    // lookup silently fell through to our own field). 2026-07-29: the bias
    // moves tens of cells per region.
    for (let i = 0; i < REGIONS.length; i++) {
      const game = placementForRegion(i, "game");
      const biased = placementForRegion(i, "game+3");
      const moved = [...game].filter((k) => !biased.has(k)).length;
      expect(moved).toBeGreaterThan(5);
    }
  }, 180000);

  it("the game's own fields put cliffs inside ore patches where the game has none", () => {
    /**
     * The residual, localised. Cells whose whole 4x4 footprint is ore
     * ("full-ore cells"), across the three calcite regions:
     *
     * | region | full-ore cells | our rule on the GAME's fields places | game actually placed |
     * | --- | --- | --- | --- |
     * | `[1500,1500]` | 172 | 8 | **0** |
     * | `[1100,2600]` | 130 | 38 | **0** |
     * | `[-1700,1900]` | 29 | 1 | **0** |
     *
     * A matched control rules out "the rule is just worse on volcano terrain":
     * pairing each full-ore cell with up to three no-ore cells of the same mean
     * elevation (+/-25) and mean cliffiness (+/-0.1) in the same region, the
     * rule's precision on the controls is 0.79 / 1.02 / 2.00 (n = 443 / 387 / 69
     * controls). So the 47 predictions inside ore should have yielded ~47 real
     * cliffs; they yielded 0. Poisson P(0 | 47) ~ 4e-21.
     *
     * Four candidate explanations for THAT, each measured and falsified
     * 2026-07-29 - recorded so they are not re-tested:
     *
     * 1. **Elevation.** With the cliffiness gate forced open, the game's own
     *    corner elevations produce a band crossing in 40.5% / 34.3% / 50.0% of
     *    full-ore cells against 42.7% / 37.3% / 34.0% of random cells in the
     *    same regions. Ore sits on band-crossing terrain at the background rate.
     *    (For coal and tungsten it is 0.000 in four of five regions - ashlands
     *    elevation is `300 + 0.001 * ...`, effectively flat, and basalts tops
     *    out near 120 against `cliff_elevation_0 = 70`. Those resources
     *    genuinely cannot host cliffs; calcite is the hard case, and the earlier
     *    "ore below 70" reading only ever explained them.)
     * 2. **Cliffiness.** The gate (`cliffinessAvg > 0.5`, and `cliffiness_basic`
     *    floors at exactly 0.5) is open at 14.9% of `[1500,1500]`'s full-ore
     *    cells against 60.0% of random - but at **85.8%** of `[1100,2600]`'s
     *    against 64.0%, and 10.0% at `[-1700,1900]`. It does not replicate, in
     *    either direction, which is what a coincidence looks like:
     *    `cliffiness_basic` is a `quick_multioctave_noise` at `seed1 = 123` with
     *    no dependence on any resource, biome or elevation field, so there is no
     *    path by which ore could correlate with it.
     * 3. **`fixImpossibleCells`.** Running the placement with it on and off
     *    changes the full-ore predictions by 0 (measured on the interior-inset
     *    window: 8/35/1 both ways).
     * 4. **Steep or aliased terrain.** Full-ore cells' max corner-to-corner
     *    elevation delta is p10/p50/p90 = 17/37/63 against 13/35/66 for no-ore
     *    cells - the same distribution - and the rule's precision is 0.58-0.84
     *    across every delta bin, with no bin where it collapses.
     *
     * Collision is ruled out on both paths and both masks were re-read here
     * rather than quoted: cliff = `{item, meltable, object, player, water_tile,
     * is_lower_object, is_object, cliff}`, resource = `{resource}`. Nor can a
     * TILE separate them: of the ~20 Vulcanus tiles only `lava` and `lava-hot`
     * carry a layer the cliff mask holds (`water_tile`), and
     * `tile_collision_masks.lava()` also carries `resource`, so lava excludes
     * both. `volcanic-jagged-ground` - the tile the ore patches are painted,
     * whose autoplace literally reads `vulcanus_calcite_region + 0.2` and which
     * the Lua labels "CLIFF TILE" - is `tile_collision_masks.ground()`, which
     * the cliff mask does not touch.
     *
     * So this is not an exclusion rule and there is nothing here to bolt on. It
     * is #18's rule error, and this is the sharpest localisation of it anyone
     * has: a 4x4 cell fully inside a calcite patch is where our rule is wrong
     * ~100% of the time while being right ~78% of the time everywhere else.
     * Whoever attacks #18 next should start from these cells.
     */
    const oreByRegion = new Map<string, Set<string>>();
    const cliffsByRegion = new Map<string, Set<string>>();
    for (const r of allRegions()) {
      oreByRegion.set(r.label, r.ore);
      cliffsByRegion.set(r.label, new Set(r.cliffCells.map((c) => key(c.x, c.y))));
    }

    const perRegion: Record<string, number[]> = {};
    let predicted = 0;
    let actual = 0;
    let fullOreCells = 0;
    for (let i = 0; i < REGIONS.length; i++) {
      const r = REGIONS[i];
      const label = `[${String(r.x0)},${String(r.y0)}]`;
      const ore = oreByRegion.get(label);
      const gameCliffCells = cliffsByRegion.get(label);
      expect(ore).toBeDefined();
      expect(gameCliffCells).toBeDefined();
      if (ore === undefined || gameCliffCells === undefined) continue;
      const placed = placementForRegion(i, "game");

      const g = cornerFix.grid;
      for (let cy = r.y0 / g; cy < r.y1 / g; cy++) {
        for (let cx = r.x0 / g; cx < r.x1 / g; cx++) {
          let n = 0;
          for (let tx = cx * g; tx < cx * g + g; tx++)
            for (let ty = cy * g; ty < cy * g + g; ty++) if (ore.has(key(tx, ty))) n++;
          if (n < g * g) continue;
          fullOreCells++;
          const centre = key(cx * g + 2, cy * g + 2.5);
          if (placed.has(centre)) predicted++;
          if (gameCliffCells.has(centre)) actual++;
          perRegion[label] = perRegion[label] ?? [0, 0, 0];
          perRegion[label][0]++;
          if (placed.has(centre)) perRegion[label][1]++;
          if (gameCliffCells.has(centre)) perRegion[label][2]++;
        }
      }
    }
    // Re-measured 2026-07-30 after the sample-lattice fix (fields are read at
    // the bare (i*4, j*4); the prototype's grid_offset is a CENTRE offset). The
    // per-region split shifted: [1500,1500] 8 -> 9, [1100,2600] 38 -> 37 and
    // [-1700,1900] 1 -> 0, so the total we wrongly place inside all-calcite
    // footprints goes 47 -> 46. The game still places ZERO in all of them, so
    // the finding this test exists for is untouched: it is a rule error, and
    // the sample-lattice fix does not touch it.
    expect(perRegion).toEqual({
      "[1500,1500]": [172, 9, 0],
      "[1100,2600]": [130, 37, 0],
      "[-1700,1900]": [29, 0, 0],
    });
    expect(fullOreCells).toBe(331);
    expect(predicted).toBe(46);
    expect(actual).toBe(0);
  }, 180000);
});
