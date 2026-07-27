/**
 * Composite the Vulcanus rock overlay onto a terrain ImageData: sweep the same
 * pixel grid as renderVulcanusTerrain and paint `ROCK_MAP_COLOR` where the rock
 * probability field clears the footprint threshold. Mutates `base` in place.
 * Mirrors renderRocks (Nauvis).
 *
 * All four Vulcanus rock entities declare `map_color = {129, 105, 78}`
 * (`space-age/prototypes/decorative/decoratives-vulcanus.lua`), identical to
 * Nauvis's rocks, so `ROCK_MAP_COLOR` is shared rather than duplicated.
 *
 * Two differences from the Nauvis renderer:
 *
 * - **No water exclusion.** Vulcanus has no water tile.
 * - **No levers.** Vulcanus deliberately omits the `rocks` autoplace control
 *   (see `vulcanusRockField.ts`), so there is no frequency or size to thread.
 *
 * Like the Nauvis overlay this is a **threshold on the probability field, not a
 * placement**. Rock probabilities cap at 0.2, so there is no threshold that
 * yields a faithful footprint - the game rolls per tile against that
 * probability and charts each placed rock by its collision box. Reproducing
 * that needs the per-chunk placement roll tracked in issue #9.
 */
import type { EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { ROCK_MAP_COLOR } from "../rocks/rockCatalog";
import {
  VULCANUS_ROCK_FOOTPRINT_THRESHOLD,
  makeVulcanusRockFields,
} from "../rocks/vulcanusRockField";

export interface RenderVulcanusRocksOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params (notably `startingPositions`). */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
}

export function renderVulcanusRocks(base: ImageData, opts: RenderVulcanusRocksOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ctx = withCtxDefaults({ seed0: opts.seed0, ...opts.ctx });
  const { density } = makeVulcanusRockFields(ctx);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      if (density(wx, wy) < VULCANUS_ROCK_FOOTPRINT_THRESHOLD) continue;
      const o = (py * width + px) * 4;
      base.data[o] = ROCK_MAP_COLOR[0];
      base.data[o + 1] = ROCK_MAP_COLOR[1];
      base.data[o + 2] = ROCK_MAP_COLOR[2];
      base.data[o + 3] = 255;
    }
  }
}
