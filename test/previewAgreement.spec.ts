import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import { decodePng } from "./oracle/decodePng";
import { runRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import type { ElevationRenderRequest } from "../src/noise/preview/elevationRenderRequest";
import { CLIFF_MAP_COLOR } from "../src/noise/cliffs/cliffCatalog";
import { ROCK_MAP_COLOR } from "../src/noise/rocks/rockCatalog";

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
 */

const FIXTURES = join(import.meta.dirname, "fixtures");
const SIZE = 1024;
const SEED = 123456;
/** `surfaceSeedForPlanet("vulcanus", 123456)` - see `src/model/planetSurfaceSeed.ts`. */
const VULCANUS_SURFACE_SEED = 1249936247;

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
  }, 120000);

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
  }, 120000);

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
  }, 120000);
});
