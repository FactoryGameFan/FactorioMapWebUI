/**
 * Composite the Vulcanus rock overlay onto a terrain ImageData: sweep the same
 * pixel grid as renderVulcanusTerrain, roll the game's per-tile placement draw
 * against the rock probability field, and paint a `PLACEMENT_MARK_RADIUS_PX`
 * mark in `ROCK_MAP_COLOR` wherever it wins. Mutates `base` in place. Mirrors
 * renderRocks (Nauvis).
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
 * Rolling paints a `PLACEMENT_MARK_RADIUS_PX` mark instead of a single pixel,
 * so - exactly like cliffs (`renderCliffs.ts`) - a roll that wins just outside
 * this render's own pixel box can still owe it mark pixels across a tile seam.
 * `sweepBox` is the same halo-widen-and-clamp world box `cliffCellQueryBox`
 * computes for cliffs, generalized to any mark radius
 * (`elevationRenderRequest.ts`'s `rockSweepBox`); omitting it (the untiled/
 * single-render path) sweeps exactly the pixel box, matching the pre-halo
 * behavior.
 */
import type { EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import {
  PLACEMENT_MARK_RADIUS_PX,
  PLACEMENT_SALT,
  makePlacementRoll,
} from "../placement/placementRoll";
import { ROCK_MAP_COLOR } from "../rocks/rockCatalog";
import { makeVulcanusRockFields } from "../rocks/vulcanusRockField";
import { paintMark } from "./renderCliffs";

export interface RenderVulcanusRocksOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params (notably `startingPositions`). */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
  /**
   * World box to sweep for roll hits. Defaults to this render's own pixel box
   * (`[originX, originX + width * tpp) x [originY, originY + height * tpp)`).
   * The tiled renderer widens this by `PLACEMENT_MARK_RADIUS_PX` tiles
   * (clamped to the full image) so a hit centered just outside this tile
   * still paints the part of its mark that falls inside - without it, marks
   * are clipped at tile seams. `paintMark` already clips to the pixel grid,
   * so a wider sweep cannot paint outside this tile's own bounds.
   */
  readonly sweepBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

export function renderVulcanusRocks(base: ImageData, opts: RenderVulcanusRocksOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ctx = withCtxDefaults({ seed0: opts.seed0, ...opts.ctx });
  const { density } = makeVulcanusRockFields(ctx);
  const roll = makePlacementRoll(PLACEMENT_SALT.vulcanusRocks);

  const box = opts.sweepBox;
  // Local pixel range to sweep - the box's own bounds by default, widened by
  // the halo when `box` is given. The round-trip world->local division is
  // exact: `box` is always originX/originY + an integer multiple of tpp (see
  // rockSweepBox), the same guarantee cliffCellQueryBox relies on.
  const pxStart = box ? Math.round((box.x0 - originX) / tpp) : 0;
  const pxEnd = box ? Math.round((box.x1 - originX) / tpp) : width;
  const pyStart = box ? Math.round((box.y0 - originY) / tpp) : 0;
  const pyEnd = box ? Math.round((box.y1 - originY) / tpp) : height;

  for (let py = pyStart; py < pyEnd; py++) {
    const wy = originY + py * tpp;
    for (let px = pxStart; px < pxEnd; px++) {
      const wx = originX + px * tpp;
      if (roll(wx, wy) >= density(wx, wy)) continue;
      paintMark(base, px, py, ROCK_MAP_COLOR, PLACEMENT_MARK_RADIUS_PX);
    }
  }
}
