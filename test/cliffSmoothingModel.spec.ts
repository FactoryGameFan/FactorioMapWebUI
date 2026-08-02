import { describe, expect, it } from "vite-plus/test";

import stencil from "./fixtures/oracle-cliff-smoothing-stencil.seed123456.json";
import offRegions from "./fixtures/oracle-vulcanus-cliff-smoothing-off-regions.seed123456.json";
import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { CLIFF_ORIENTATION_NAMES, cliffOrientationForCode } from "../src/noise/cliffs/cliffCatalog";
import { makeCliffPlacementFromFields, smoothingKnots } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_RICHNESS,
  VULCANUS_CLIFF_SMOOTHING,
  makeCliffinessBasic,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const seed = offRegions.seed;
const ctx = withCtxDefaults({ seed0: seed, startingPositions: [{ x: 0, y: 0 }] });
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver({ seed0: seed, startingPositions: [{ x: 0, y: 0 }] });
const lava = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);
const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/**
 * The game's dump is chunk-aligned and so reaches slightly outside the requested
 * box, while `placedCells` filters to it exactly. Comparing without this clips
 * a row of "the game placed one we didn't" that is purely a framing artefact.
 */
const inBox = (p: { x: number; y: number }, r: Box): boolean =>
  p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;

const gameCliffs = (
  cliffs: { x: number; y: number; name: string; orientation: string }[],
  r: Box,
): Map<string, string> => {
  const m = new Map<string, string>();
  for (const p of cliffs)
    if (p.name === "cliff-vulcanus" && inBox(p, r)) m.set(key(p.x, p.y), p.orientation);
  return m;
};

interface Score {
  game: number;
  ours: number;
  matched: number;
  missed: number;
  oursOnly: number;
  oriWrong: number;
}
const score = (
  game: Map<string, string>,
  placed: { x: number; y: number; code: number }[],
): Score => {
  let matched = 0;
  let oriWrong = 0;
  const ours = new Set<string>();
  for (const p of placed) {
    const k = key(p.x, p.y);
    ours.add(k);
    const want = game.get(k);
    if (want === undefined) continue;
    matched++;
    const id = cliffOrientationForCode(p.code);
    if (CLIFF_ORIENTATION_NAMES[id as number] !== want) oriWrong++;
  }
  let missed = 0;
  for (const k of game.keys()) if (!ours.has(k)) missed++;
  return {
    game: game.size,
    ours: ours.size,
    matched,
    missed,
    oursOnly: ours.size - matched,
    oriWrong,
  };
};

/**
 * **`cliff_smoothing = 1` on Vulcanus, and it is now MEASURED** (#84).
 *
 * `VULCANUS_CLIFF_SMOOTHING` was inferred from the `CliffPlacementSettings`
 * prototype's default list (issue #28) because the planet's `cliff_settings`
 * block does not mention it. That inference was right, but an inference of
 * exactly this shape is what #28 itself was a bug in, and the value turns out to
 * be the difference between a port that is exact and one that is not (below). So
 * the fixture's first case overrides nothing and reads the whole block back off
 * the planet's own surface.
 */
describe("Vulcanus cliff_settings, read back from the game", () => {
  const defaults = offRegions.cases[0].effective;

  it("reports the four constants the port hard-codes", () => {
    expect(defaults?.cliff_smoothing).toBe(VULCANUS_CLIFF_SMOOTHING);
    expect(defaults?.cliff_elevation_0).toBe(VULCANUS_CLIFF_ELEVATION_0);
    expect(defaults?.cliff_elevation_interval).toBe(VULCANUS_CLIFF_ELEVATION_INTERVAL);
    expect(defaults?.richness).toBe(VULCANUS_CLIFF_RICHNESS);
    // Non-vacuity: the readback is a real dump, not an echo of what we asked for -
    // this case sent no cliffSettings at all.
    expect(offRegions.cases[0].cliffs.length).toBeGreaterThan(500);
  });
});

/**
 * **The `cliff_smoothing` stencil, measured against the game** (#84).
 *
 * `smoothingKnots` interpolates each corner between knots at in-chunk indices
 * **0, 4 and 7** - `hi = min(lo + 4, CHUNK_CORNERS - 1)`, so the second span is
 * three corners wide, not four. That came off a disassembly of
 * `crossingsForChunk` (re-derived 2026-08-02 at `0x10160c9cc`; the VA in
 * cliffs-NOTES.md had moved), and this file is the measurement that the reading
 * is right.
 *
 * The probe is a delta on one corner column or row, so the smoothed field is
 * `1 + 1000 * w(i)` for exactly the stencil weight `w`. See the fixture's
 * `_comment` for the construction.
 *
 * **The in-chunk-3 arms are the ones with teeth.** 3 is not a knot, so the model
 * predicts the game places nothing at all, and that is what the game does. An
 * arm whose predicted output is EMPTY cannot be satisfied by a stencil that is
 * merely close, which is the failure mode every weight-matching test here has.
 */
describe("the cliff_smoothing stencil", () => {
  const cliffinessOpen = makeCliffinessBasic(seed, 4);
  const extras: string[] = [];
  const wrongTotal: number[] = [];
  const oursOnlyKeys = (game: Map<string, string>, placed: { x: number; y: number }[]): string[] =>
    placed.map((p) => key(p.x, p.y)).filter((k) => !game.has(k));

  for (const arm of stencil.cases) {
    const r = arm.region;
    const game = gameCliffs(arm.cliffs, r);
    // The probe: 1 everywhere, 1001 on the one corner line.
    const rawProbe = (x: number, y: number): number =>
      (arm.axis === "x" ? x : y) / 4 === arm.index ? 1001 : 1;
    const smoothed = (x: number, y: number): number => {
      const kx = smoothingKnots(x / 4);
      const ky = smoothingKnots(y / 4);
      return (
        (1 - kx.t) * (1 - ky.t) * rawProbe(kx.lo * 4, ky.lo * 4) +
        kx.t * (1 - ky.t) * rawProbe(kx.hi * 4, ky.lo * 4) +
        (1 - kx.t) * ky.t * rawProbe(kx.lo * 4, ky.hi * 4) +
        kx.t * ky.t * rawProbe(kx.hi * 4, ky.hi * 4)
      );
    };
    const placed = makeCliffPlacementFromFields(
      { cliffElevation: smoothed, cliffiness: cliffinessOpen },
      {
        elevation0: stencil.cliffElevation0,
        interval: arm.effective?.cliff_elevation_interval ?? 1000000,
        // `smoothed` has already applied it; the placement must not apply it twice.
        smoothing: 0,
        tileCollides: lava,
      },
    ).placedCells(r.x0, r.y0, r.x1, r.y1);
    const s = score(game, placed);

    it(`reproduces the game's stencil: ${arm.label}`, () => {
      expect(arm.effective?.cliff_smoothing).toBe(1);
      // The stencil itself is exact in the direction that matters: the model
      // never fails to place a cliff the game places, in any arm. Weight,
      // knot position and interpolation family are therefore all right - a
      // stencil that were wrong anywhere would lose recall somewhere.
      expect(s.missed).toBe(0);
      expect(s.matched).toBeGreaterThan(arm.index % 8 === 3 ? -1 : 25);
      console.log(
        `  ${arm.label.padEnd(38)} game=${String(s.game).padStart(3)} ours=${String(s.ours).padStart(3)} oriWrong=${String(s.oriWrong)} oursOnly=${String(s.oursOnly)}`,
      );
      extras.push(...oursOnlyKeys(game, placed).map((k) => `${arm.label}: ${k}`));
      wrongTotal.push(s.oriWrong);
    });
  }

  /**
   * **The one thing the stencil does NOT explain, kept visible.** Two column arms
   * place 4 cells each that the game does not, and they are the same four both
   * times - cell column 437, rows 381-384, i.e. a short vertical run that appears
   * whenever the stencil's contour passes through it, whatever the delta column.
   *
   * It is not the collision rejection: the game's tiles over
   * `x 1742..1760, y 1518..1546` are `volcanic-soil-dark` / `-folds` /
   * `-jagged-ground` / `-folds-flat` / `-soil-light` and contain **no lava at
   * all**, and only `lava` and `lava-hot` carry the `water_tile` layer the cliff
   * mask collides with. It is not the stencil either, or the row arms and the
   * in-chunk-3 arms would not be exact.
   *
   * It looks like the same unexplained blanket suppression as the `[0,0]` blob -
   * a contiguous patch where the game places no cliff under ANY cliff_elevation
   * routed onto it. Asserted as an exact count rather than an upper bound,
   * because the SHAPE is the lead: if it moves, the cause has changed.
   */
  it("leaves a small, LOCALISED residual - pinned by shape, not bounded away", () => {
    // Six of the eight arms are exact. The two that are not are exact everywhere
    // except ONE place, and it is the same place in both: a four-cell vertical
    // run at x = 1750 (cell column 437, in-chunk 5), rows 1526.5 - 1538.5.
    const cells = [...new Set(extras.map((e) => e.split(": ")[1]))].sort();
    expect(cells).toEqual(["1750,1526.5", "1750,1530.5", "1750,1534.5", "1750,1538.5"]);
    expect(extras.length).toBe(8);
    // ...and exactly one wrong orientation in each of those same two arms.
    expect(wrongTotal).toEqual([0, 0, 1, 1, 0, 0, 0, 0]);
  });

  it("the non-knot arms place NOTHING, and the knot arms are not empty", () => {
    for (const arm of stencil.cases) {
      const n = gameCliffs(arm.cliffs, arm.region).size;
      // in-chunk index 3 on either axis: not a knot, so the delta reaches no corner.
      if (arm.index % 8 === 3) expect(n).toBe(0);
      // Everything else must carry real signal, or the arms above compare nothing.
      else expect(n).toBeGreaterThan(25);
    }
  });
});

/**
 * **The orientation residual is TWO defects, not one** (#84).
 *
 * Run the real rule with `cliff_smoothing` forced to 0 and every other term
 * left alone, and the port's grid-4 cliff elevation is scored directly - no
 * interpolation stands between the field and the crossing test.
 *
 * | region | smoothing = 0 | smoothing = 1 (ships) |
 * | --- | --- | --- |
 * | `[0,0]` | 0 wrong (oracle-vulcanus-cliff-collapsed, arm 0) | 7 wrong |
 * | `[-1200,800]` | **0 wrong**, precision 1.0000 | 4 wrong |
 * | `[1500,1500]` | **21 wrong** | 26 wrong |
 *
 * So `[0,0]` and `[-1200,800]` carry a defect that exists ONLY under smoothing,
 * while `[1500,1500]` carries one that survives smoothing being switched off
 * entirely. Everything upstream of the smoothing has been separately verified
 * against the game - the grid-1 elevation at all 12,675 captured corners
 * (worst 4.8e-2), the grid-4 `multisample` min-filter through the cliff
 * generator itself, `cliffiness_basic` over its 4,266 UNCLAMPED corners
 * (worst 6.4e-6), `crossesCliff` by disassembly, and the stencil above - which
 * is what makes the split meaningful rather than just two numbers.
 *
 * **This is why one region was not enough.** Scoring only `[0,0]` says "smoothing
 * off is exact, therefore the residual is the smoothing", which is false for 21
 * of the 37 wrong orientations. Two of the three regions agreeing is exactly the
 * evidence that produces a confident wrong conclusion.
 */
describe("the residual splits: smoothing=0 is exact in two regions and not in the third", () => {
  const armFor = (x0: number): (typeof offRegions.cases)[number] => {
    const c = offRegions.cases.find(
      (a) => a.effective?.cliff_smoothing === 0 && a.region.x0 === x0,
    );
    expect(c).toBeDefined();
    return c as (typeof offRegions.cases)[number];
  };
  const scoreAt = (arm: (typeof offRegions.cases)[number], smoothing: number): Score => {
    const r = arm.region;
    const placed = makeCliffPlacementFromFields(fields, {
      elevation0: arm.effective?.cliff_elevation_0 ?? VULCANUS_CLIFF_ELEVATION_0,
      interval: arm.effective?.cliff_elevation_interval ?? VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing,
      tileCollides: lava,
    }).placedCells(r.x0, r.y0, r.x1, r.y1);
    return score(gameCliffs(arm.cliffs, r), placed);
  };

  it("every override applied, and both arms compare a substantial set", () => {
    for (const arm of offRegions.cases.filter((a) => a.effective?.cliff_smoothing === 0)) {
      expect(arm.effective?.cliff_smoothing).toBe(0);
      expect(arm.effective?.cliff_elevation_0).toBe(VULCANUS_CLIFF_ELEVATION_0);
      expect(arm.effective?.cliff_elevation_interval).toBe(VULCANUS_CLIFF_ELEVATION_INTERVAL);
      expect(gameCliffs(arm.cliffs, arm.region).size).toBeGreaterThan(400);
    }
  }, 120000);

  it("[-1200,800] with smoothing OFF is orientation-exact", () => {
    const s = scoreAt(armFor(-1200), 0);
    expect(s.oriWrong).toBe(0);
    // Measured 479/479: not one cell placed that the game does not also place.
    expect(s.oursOnly).toBe(0);
    expect(s.matched).toBeGreaterThan(400);
  }, 120000);

  it("[1500,1500] with smoothing OFF is NOT - the residual there is upstream", () => {
    const s = scoreAt(armFor(1500), 0);
    // Measured 21 of 1191 matched cells, every one an OVER-detection, all at the
    // high bands (670 / 790 / 1030) with margins 0.69 - 46.6 elevation units, so
    // this is not float32 noise. Upper bound: the port may improve without
    // editing it, but it must not silently pass by matching nothing.
    expect(s.oriWrong).toBeGreaterThan(0);
    expect(s.oriWrong).toBeLessThanOrEqual(21);
    expect(s.matched).toBeGreaterThan(1100);
  }, 120000);

  /**
   * The control that makes the two tests above mean something: with smoothing at
   * its real value of 1, `[-1200,800]` is NOT exact. If it were, "smoothing off
   * is exact there" would be saying nothing about the smoothing.
   */
  it("and smoothing=1 is what introduces [-1200,800]'s errors", () => {
    const ec = entities.cases.find((c) => c.region.x0 === -1200);
    expect(ec).toBeDefined();
    const r = (ec as NonNullable<typeof ec>).region;
    const placed = makeCliffPlacementFromFields(fields, {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing: VULCANUS_CLIFF_SMOOTHING,
      tileCollides: lava,
    }).placedCells(r.x0, r.y0, r.x1, r.y1);
    const s = score(gameCliffs((ec as NonNullable<typeof ec>).cliffs, r), placed);
    expect(s.oriWrong).toBeGreaterThan(0);
    expect(s.matched).toBeGreaterThan(300);
  }, 120000);
});
