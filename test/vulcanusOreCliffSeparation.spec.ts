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
  // **It is uniform across all four resource names.** That is what rules out the
  // "it is just a per-resource biome dependency" reading: a biome effect would
  // vary by resource and be partial, not sit at ~0 for every one of them.
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
    // acts over a much larger distance than collision can.
    //
    // Region 1 behaves differently: calcite comes within 1 tile of a cliff
    // centre and 8 entities land inside footprints. So the mechanism is NOT one
    // uniform distance test, and any fix that models it as a fixed exclusion
    // radius will be wrong on one region or the other.
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
