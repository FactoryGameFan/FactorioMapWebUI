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
      const tpRate = truePosOre / truePos;
      const fpRate = falsePosOre / falsePos;
      expect(truePos).toBeGreaterThan(100);
      expect(falsePos).toBeGreaterThan(50);
      // Pinned well inside the measured 0.0%/7.8% and 0.4%/6.7%.
      expect(tpRate).toBeLessThan(0.02);
      expect(fpRate).toBeGreaterThan(0.04);
    }
  }, 120000);
});
