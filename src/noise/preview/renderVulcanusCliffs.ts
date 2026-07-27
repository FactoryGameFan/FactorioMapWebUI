/**
 * Composite the Vulcanus cliff footprint onto a terrain ImageData. Mirrors
 * renderCliffs (Nauvis), reusing the same placement geometry and the same
 * `CLIFF_MAP_COLOR` mark - `cliff-vulcanus` declares
 * `map_color = {144, 119, 87}` in `space-age/prototypes/entity/entities.lua`,
 * byte-identical to Nauvis's `cliff`, so no second colour is needed.
 *
 * Two differences from the Nauvis renderer:
 *
 * - **No water exclusion.** Vulcanus has no water tile, so there is no
 *   coastline for the footprint to bleed across. (Lava plays that visual role
 *   but is not a water tile, and the game does not exclude cliffs from it here.)
 * - **No levers.** Vulcanus has no cliff autoplace control, so there is nothing
 *   to disable the pass and nothing to rescale the interval; the bands are the
 *   planet constants from `vulcanusCliffFields.ts`.
 */
import type { EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { makeCliffPlacementFromFields } from "../cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  makeVulcanusCliffFields,
} from "../cliffs/vulcanusCliffFields";
import { paintCliffCells } from "./renderCliffs";

export interface RenderVulcanusCliffsOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params (notably `startingPositions`). */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
  /**
   * World box to enumerate placed cliff cells over. Defaults to the pixel grid's
   * own world box. The tiled renderer widens this so a cell centered just
   * outside a tile still paints the part of its mark that falls inside - see
   * renderCliffs' identical option for the full rationale.
   */
  readonly cellQueryBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

export function renderVulcanusCliffs(base: ImageData, opts: RenderVulcanusCliffsOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ctx = withCtxDefaults({ seed0: opts.seed0, ...opts.ctx });
  const placement = makeCliffPlacementFromFields(makeVulcanusCliffFields(ctx), {
    elevation0: VULCANUS_CLIFF_ELEVATION_0,
    interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  });

  const box = opts.cellQueryBox ?? {
    x0: originX,
    y0: originY,
    x1: originX + width * tpp,
    y1: originY + height * tpp,
  };

  paintCliffCells(base, placement.placedCells(box.x0, box.y0, box.x1, box.y1), {
    originX,
    originY,
    tilesPerPixel: tpp,
  });
}
