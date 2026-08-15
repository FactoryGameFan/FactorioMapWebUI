import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { decodePng } from "./oracle/decodePng";
import { runRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import type { ElevationRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import { CLIFF_MAP_COLOR } from "../src/noise/cliffs/cliffCatalog";
import { ROCK_MAP_COLOR } from "../src/noise/rocks/rockCatalog";
import { makeFulgoraStack } from "../src/noise/tiles/fulgoraCatalog";
import { makeFulgoraScrap } from "../src/noise/expressions/fulgoraScrap";
import { SCRAP_MAP_COLOR } from "../src/noise/resources/fulgoraResourceCatalog";

/**
 * Compare our render against the game's OWN `--generate-map-preview` output.
 *
 * Every other oracle in this repo validates a *value* - a noise expression, a tile
 * name, an entity count or position - and none of them can see a whole-overlay
 * error: a layer missing entirely, drawn in the wrong colour, at the wrong scale,
 * or composited in the wrong order. Each is checked against the thing it is
 * derived from rather than against the finished image. This is the check that
 * closes that (issue #22 item 6), and it immediately found a real one: Vulcanus
 * rocks were painted at 0.07x the game's coverage.
 *
 * The fixtures are the game's PNGs, captured with every disableable autoplace
 * control forced to `size: 0` so the comparison is layer-by-layer rather than a
 * pile of everything at once
 * (`test/oracle/previewCompare.ts`; which controls are disableable is the game's
 * own answer, in `autoplace-can-be-disabled.dump.json`). Needing no Factorio
 * binary at test time is the whole point of committing them.
 *
 * Alignment: `--map-preview-size 1024` covers 1024 world tiles centred on the
 * origin, i.e. 1 tile per pixel from `(-512, -512)`.
 *
 * ---
 *
 * **Every comparison here carries `}, 300000)`, and it used to be `120000`.**
 * Each one renders a full 1024x1024 image, which makes them the slowest tests
 * in the suite. That number is a RESOURCE budget, not an assertion bound -
 * raising it blesses nothing, and every measured claim below still has to hold.
 *
 * The same unchanged test, "Vulcanus rock and cliff coverage", on four
 * consecutive CI runs:
 *
 * | tree                         | duration | result    |
 * | ---------------------------- | -------- | --------- |
 * | main, before the scrap work  | 69.6s    | pass      |
 * | PR #202                      | 90.1s    | pass      |
 * | main, after #202 merged      | 108.8s   | pass      |
 * | PR #203                      | 150.5s   | TIMED OUT |
 * | PR #203, at this 300s budget | 139.7s   | pass      |
 *
 * That last row is what proves the budget was the problem: given room, the same
 * test finishes in 139.7s. It is over 120s on its own merits rather than just
 * under, so a bigger number is not masking anything here.
 *
 * Its own work never changed across any of those runs - #202's only render-path
 * edit is inside the `planet === "fulgora"` branch, and Vulcanus never enters
 * it. What changed is the runner. #202 added three spec files, which re-buckets
 * vitest's sha1 hash-shard, and shard 1 now co-schedules this file (298s) with
 * `vulcanusCliffRejectionStage.spec.ts` (205s) - 503s of that shard's 653s on
 * 2 of its 4 workers.
 *
 * So a timeout here means slow, exactly as CLAUDE.md says, and the run-to-run
 * spread on identical code is about 40%. 300s gives the worst run yet a 2x
 * margin. If it ever trips again, read the duration the reporter prints before
 * assuming a hang - no assertion in this file has ever failed on CI.
 *
 * Kept as a bare literal rather than a named constant on purpose: any longer
 * token pushes `}, 300000);` past the formatter's line budget, and oxfmt then
 * rewrites all five `it(...)` calls into multi-line argument form and re-indents
 * every test body. That is a 146-line diff to change a timeout.
 */

const FIXTURES = join(import.meta.dirname, "fixtures");
const SIZE = 1024;
const SEED = 123456;
/** `surfaceSeedForPlanet("vulcanus", 123456)` - see `src/model/planetSurfaceSeed.ts`. */
const VULCANUS_SURFACE_SEED = 1249936247;
/**
 * `surfaceSeedForPlanet("fulgora", 123456)` - the preview takes a MAP seed,
 * not a surface seed. Every other Fulgora fixture in this repo comes from a
 * harness that FORCES the surface seed to the raw value, so this constant is
 * the one place in the suite that has to derive it. Using the raw `123456`
 * here scores about 0.5% agreement instead of 99.9% and looks exactly like a
 * broken port rather than a wrong constant - confirmed by hand by swapping in
 * `123456` and watching the scrap footprint test below fail badly, then
 * restoring this value.
 */
const FULGORA_SURFACE_SEED = 2967702466;

function reference(name: string): { width: number; height: number; rgb: Uint8Array } {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
  return decodePng(bytes, (b) => new Uint8Array(inflateSync(b)));
}

function render(req: Partial<ElevationRenderRequest> & { seed0: number }): Uint8ClampedArray {
  const full: ElevationRenderRequest = {
    id: 1,
    width: SIZE,
    height: SIZE,
    originX: -SIZE / 2,
    originY: -SIZE / 2,
    tilesPerPixel: 1,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
    view: "terrain",
    ...req,
  };
  return new Uint8ClampedArray(runRenderRequest(full).buffer);
}

const rgbAt = (rgb: Uint8Array, i: number): [number, number, number] => [
  rgb[i * 3],
  rgb[i * 3 + 1],
  rgb[i * 3 + 2],
];
const oursAt = (b: Uint8ClampedArray, i: number): [number, number, number] => [
  b[i * 4],
  b[i * 4 + 1],
  b[i * 4 + 2],
];
const same = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

describe("preview agreement with the game", () => {
  it("Nauvis terrain is pixel-identical except where the game drew enemy bases", () => {
    const game = reference("oracle-preview-nauvis-terrain.seed123456.png");
    expect([game.width, game.height]).toEqual([SIZE, SIZE]);
    const ours = render({ seed0: SEED });

    // `enemy-base` is the ONE control the game reports as `can_be_disabled: false`
    // (autoplace-can-be-disabled.dump.json), so it is present in the reference
    // while our terrain view does not draw it. Those pixels are excluded rather
    // than tolerated, and counted so the exclusion cannot quietly grow.
    const ENEMY = [255, 25, 25];
    let enemyPx = 0;
    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const g = rgbAt(game.rgb, i);
      if (same(g, ENEMY)) {
        enemyPx++;
        continue;
      }
      if (!same(g, oursAt(ours, i))) differing++;
    }
    const compared = SIZE * SIZE - enemyPx;

    // Measured 2026-07-28: 1189 enemy pixels, and 10 of the remaining 1,047,387
    // disagree - 99.999%. Bounds are drift guards a little above that; the render
    // is deterministic, so any movement here is a real change.
    expect(enemyPx).toBeLessThan(3000);
    expect(differing).toBeLessThan(200);
    expect(differing / compared).toBeLessThan(0.0002);
  }, 300000);

  it("Vulcanus terrain agrees once rocks and cliffs are masked", () => {
    const game = reference("oracle-preview-vulcanus-terrain.seed123456.png");
    const ours = render({ seed0: VULCANUS_SURFACE_SEED, planet: "vulcanus" });

    // Vulcanus has NO `rocks` control and no cliff control, so unlike Nauvis
    // those two cannot be disabled in the capture - they are in the reference
    // whatever we do. Masking them isolates the terrain layer; their coverage is
    // asserted separately below, which is where the real finding was.
    let masked = 0;
    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const g = rgbAt(game.rgb, i);
      if (same(g, ROCK_MAP_COLOR) || same(g, CLIFF_MAP_COLOR)) {
        masked++;
        continue;
      }
      if (!same(g, oursAt(ours, i))) differing++;
    }
    const rel = differing / (SIZE * SIZE - masked);
    // Measured 98.664% over 929,686 compared pixels. Notably worse than Nauvis's
    // 99.999% and NOT yet diagnosed - the bound guards against drift, it does not
    // bless the gap.
    expect(rel).toBeLessThan(0.02);
  }, 300000);

  it("Vulcanus rock and cliff coverage stays in the game's neighbourhood", () => {
    const game = reference("oracle-preview-vulcanus-terrain.seed123456.png");
    const ours = render({ seed0: VULCANUS_SURFACE_SEED, planet: "vulcanus", view: "all" });

    const share = (
      pick: (i: number) => readonly [number, number, number],
      color: readonly number[],
    ): number => {
      let n = 0;
      for (let i = 0; i < SIZE * SIZE; i++) if (same(pick(i), color)) n++;
      return n / (SIZE * SIZE);
    };
    const gameRock = share((i) => rgbAt(game.rgb, i), ROCK_MAP_COLOR);
    const ourRock = share((i) => oursAt(ours, i), ROCK_MAP_COLOR);
    const gameCliff = share((i) => rgbAt(game.rgb, i), CLIFF_MAP_COLOR);
    const ourCliff = share((i) => oursAt(ours, i), CLIFF_MAP_COLOR);

    console.log(
      `preview coverage: rock game=${(gameRock * 100).toFixed(2)}% ours=${(ourRock * 100).toFixed(2)}% ` +
        `(${(ourRock / gameRock).toFixed(2)}x); cliff game=${(gameCliff * 100).toFixed(2)}% ` +
        `ours=${(ourCliff * 100).toFixed(2)}% (${(ourCliff / gameCliff).toFixed(2)}x)`,
    );

    // **This is the assertion that would have caught the bug this file was written
    // for.** Rocks painted 1x1 gave 0.37% against the game's 5.17% - 0.07x - while
    // placement DENSITY was correct to 0.2-7.5% the whole time. No entity oracle
    // could see it; only the rendered image can. Measured now: 0.65x.
    expect(ourRock / gameRock).toBeGreaterThan(0.4);
    expect(ourRock / gameRock).toBeLessThan(1.5);

    // Cliffs are KNOWN BAD at 2.28x (issue #18, corroborating the entity-level
    // 1.1-1.6x over-placement by an independent route). The bound is pinned just
    // above the current value so it cannot get worse unnoticed; tighten it when
    // #18 lands rather than leaving this as a permanent blessing.
    expect(ourCliff / gameCliff).toBeLessThan(2.5);
  }, 300000);

  it("Fulgora terrain is pixel-identical to the game's own preview", () => {
    const game = reference("oracle-preview-fulgora-terrain.seed123456.png");
    expect([game.width, game.height]).toEqual([SIZE, SIZE]);
    const ours = render({ seed0: FULGORA_SURFACE_SEED, planet: "fulgora", view: "terrain" });
    let differing = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (!same(rgbAt(game.rgb, i), oursAt(ours, i))) differing++;
    }
    // Fulgora has no enemy bases, so unlike the Nauvis case there is nothing to
    // exclude. Measured: 34,976 of 1,048,576 pixels differ (3.34%). V1/V2
    // report 99.86% get_tile agreement and 94.5% on the land argmax from
    // sampled points, so a whole-image number in the low single-digit percent
    // is the expected shape, not a regression. The bound is set just above the
    // measured value; do not widen it further without a new measurement.
    //
    // The first measurement here was 38.7% - a real bug, not this bound: the
    // "deep" ocean tile's map colour in renderFulgoraTerrain.ts rounded
    // (49*1.15, 31*1.15, 35*1.15) instead of truncating it as the game does,
    // landing one green value high on every one of the ~35% of pixels that
    // are deep ocean. Fixed there, not here - see the comment on `COLORS.deep`
    // in that file for the evidence. The 3.34% left over after that fix is the
    // land-argmax residual this comment already expected.
    expect(differing / (SIZE * SIZE)).toBeLessThan(0.04);
  }, 300000);

  it("every scrap pixel the game drew is inside our model's footprint", () => {
    const off = reference("oracle-preview-fulgora-terrain.seed123456.png");
    const on = reference("oracle-preview-fulgora-scrap.seed123456.png");
    const stack = makeFulgoraStack({ seed0: FULGORA_SURFACE_SEED });
    const scrap = makeFulgoraScrap(stack);

    // A SUPERSET assertion, and against the FOOTPRINT PREDICATE rather than a
    // rendered overlay - both deliberate.
    //
    // Superset, never equality, because ResourceEntityPrototype::map_grid
    // defaults to true: the game draws solid ore as a 2x2-block checkerboard
    // and shows about 0.5 pixels per entity. Requiring equality would bake
    // that 2x under-placement into the renderer.
    //
    // Footprint, not the rolled overlay this renderer actually paints: a roll
    // only paints where a random draw succeeds, which is about 40% of the
    // positions where the model's probability is nonzero. Diffing the rolled
    // pixels against the game's drawn pixels can't reach a useful agreement
    // rate for that reason alone - it would be measuring the salt, not the
    // model. `probability(x, y) > 0` asks the question this test actually
    // means: could scrap have landed here at all, per the model. The
    // salt used to decide whether it actually does is arbitrary (any salt is
    // as good as any other for that decision), and DENSITY - whether the
    // model rolls at roughly the right rate - is gated separately, by
    // `test/fulgoraScrapDensity.spec.ts`. This test is purely about location.
    let gameScrap = 0;
    let outside = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (same(rgbAt(off.rgb, i), rgbAt(on.rgb, i))) continue;
      gameScrap++;
      // originX = originY = -SIZE/2, tilesPerPixel = 1 (see `render` above),
      // and renderFulgoraTerrain.ts writes row-major (py*width+px) - confirmed
      // by reading that file rather than assumed.
      const x = -SIZE / 2 + (i % SIZE);
      const y = -SIZE / 2 + Math.floor(i / SIZE);
      if (scrap.probability(x, y) <= 0) outside++;
    }
    // Measured: 1825 game scrap pixels; 1 of them (0.0548%) falls outside the
    // model's footprint - 99.95% inside, exactly matching the design spec's
    // section 2.5 measurement of 1824/1825. The bound is set just above that.
    expect(gameScrap).toBeGreaterThan(1500);
    expect(outside / gameScrap).toBeLessThan(0.001);
  }, 300000);

  it("we paint scrap in the game's own map_color", () => {
    const on = reference("oracle-preview-fulgora-scrap.seed123456.png");
    let pure = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (same(rgbAt(on.rgb, i), [229, 229, 229])) pure++;
    }
    // map_color = {0.9, 0.9, 0.9} x 255. The game's own preview is where this
    // triple was confirmed, not the Lua alone.
    expect(pure).toBeGreaterThan(1000);
    expect(SCRAP_MAP_COLOR).toEqual([229, 229, 229]);
  });
});
