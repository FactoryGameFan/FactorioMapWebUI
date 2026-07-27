/**
 * Composite the Vulcanus rock overlay onto a terrain ImageData: sweep the same
 * pixel grid as renderVulcanusTerrain, roll the game's per-tile placement draw
 * against the rock probability field, and paint a single `ROCK_MAP_COLOR`
 * pixel wherever it wins. Mutates `base` in place. Mirrors renderRocks
 * (Nauvis), including its choice of a 1x1 mark: "rocks are point-like, and a
 * block would merge scattered rocks into a blob" (renderRocks.ts) - unlike
 * enemy bases/geysers/oil (Tasks 6-8), which keep the 3x3
 * `PLACEMENT_MARK_RADIUS_PX` mark for legibility.
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
 * This rolls rather than thresholds: it draws `makePlacementRoll`'s per-tile
 * `U` and places where `U < density(x, y)`. Positions are not tile-exact -
 * there is no cross-overlay arbitration against other autoplacers and no
 * jitter draws within the tile (see `placementRoll.ts`) - but density is the
 * property under test, and this is a faithful roll against it rather than a
 * threshold on it.
 *
 * A 1x1 mark cannot straddle a tile seam, so - unlike cliffs
 * (`renderCliffs.ts`) - this needs no halo-widened sweep box: sweeping exactly
 * this render's own pixel box already reproduces the untiled render tile for
 * tile (see `tiledEquality.spec.ts`'s Vulcanus rocks/all cases).
 */
import type { EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { PLACEMENT_SALT, makePlacementRoll } from "../placement/placementRoll";
import { ROCK_MAP_COLOR } from "../rocks/rockCatalog";
import { makeVulcanusRockFields } from "../rocks/vulcanusRockField";

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
  const roll = makePlacementRoll(PLACEMENT_SALT.vulcanusRocks);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      if (roll(wx, wy) >= density(wx, wy)) continue;
      const o = (py * width + px) * 4;
      base.data[o] = ROCK_MAP_COLOR[0];
      base.data[o + 1] = ROCK_MAP_COLOR[1];
      base.data[o + 2] = ROCK_MAP_COLOR[2];
      base.data[o + 3] = 255;
    }
  }
}
