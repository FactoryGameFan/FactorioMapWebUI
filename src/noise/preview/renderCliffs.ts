/**
 * Composite the cliff footprint overlay onto a terrain ImageData: enumerate
 * placed cliff cells over the pixel grid's world box (via `makeCliffPlacement`,
 * T7), map each cell center to a pixel, and paint a small `CLIFF_MAP_COLOR`
 * block (`CLIFF_MARK_RADIUS_PX`) so the sparse 4-tile-grid footprint reads at
 * preview scale; leave the terrain pixel untouched elsewhere. Mutates `base` in
 * place. See M4 cliffs plan T9.
 *
 * Unlike renderResources/renderEnemies (which sweep every pixel and query a
 * field), cliffs are placed on a sparse 4-tile grid - `placedCells` already
 * enumerates just the placed cells over the box, so we map cell centers to
 * pixels instead of sweeping.
 *
 * Cliffs never sit on water, so we skip any pixel the terrain drew as
 * water/deepwater - the same `WATER_TILE_COLORS` water-skip renderResources
 * and renderEnemies use, reused (not re-derived) so the cliff footprint edge
 * lines up with the coastline the terrain already drew.
 */
import type { Point } from "../distanceFromNearestPoint";
import { makeCliffPlacement } from "../cliffs/cliffPlacement";
import {
  CLIFF_MAP_COLOR,
  CLIFF_MARK_RADIUS_PX,
  type CliffControls,
  type CliffSettingsInput,
} from "../cliffs/cliffCatalog";
import { WATER_TILE_COLORS } from "./renderResources";

export interface RenderCliffsOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  readonly controls: CliffControls;
  readonly settings: CliffSettingsInput;
  readonly segmentationMultiplier?: number;
  readonly waterLevel?: number;
  readonly startingPositions?: readonly Point[];
  readonly startingLakePositions?: readonly Point[];
  /**
   * World box to enumerate placed cliff cells over. Defaults to the pixel grid's
   * own world box. The tiled renderer widens this by CLIFF_MARK_RADIUS_PX tiles
   * (clamped to the full image) so a cell centered just outside this tile still
   * paints the part of its mark that falls inside - without it, cliff marks are
   * clipped at tile seams. The paint loop already clips to the pixel grid, so a
   * wider query cannot paint outside the tile.
   */
  readonly cellQueryBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

/**
 * Paint one `CLIFF_MAP_COLOR` mark per placed cell center. Shared with the
 * Vulcanus renderer, which passes no `skipPixel` because Vulcanus has no water
 * tile to keep the footprint off.
 */
export function paintCliffCells(
  base: ImageData,
  cells: readonly { x: number; y: number }[],
  opts: {
    readonly originX: number;
    readonly originY: number;
    readonly tilesPerPixel: number;
    readonly skipPixel?: (r: number, g: number, b: number) => boolean;
  },
): void {
  const { width, height } = base;
  const { originX, originY, tilesPerPixel: tpp, skipPixel } = opts;
  const r = CLIFF_MARK_RADIUS_PX;
  for (const { x: wx, y: wy } of cells) {
    const cx = Math.floor((wx - originX) / tpp);
    const cy = Math.floor((wy - originY) / tpp);
    // Paint a (2r+1)x(2r+1) block centered on the cell's pixel, re-checking
    // each painted pixel so the thickened footprint still respects skipPixel.
    for (let dy = -r; dy <= r; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const px = cx + dx;
        if (px < 0 || px >= width) continue;
        const o = (py * width + px) * 4;
        if (skipPixel?.(base.data[o], base.data[o + 1], base.data[o + 2]) === true) continue;
        base.data[o] = CLIFF_MAP_COLOR[0];
        base.data[o + 1] = CLIFF_MAP_COLOR[1];
        base.data[o + 2] = CLIFF_MAP_COLOR[2];
        base.data[o + 3] = 255;
      }
    }
  }
}

export function renderCliffs(base: ImageData, opts: RenderCliffsOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const isWater = (r: number, g: number, b: number): boolean => {
    for (const [wr, wg, wb] of WATER_TILE_COLORS) {
      if (r === wr && g === wg && b === wb) return true;
    }
    return false;
  };

  const placement = makeCliffPlacement({
    seed0: opts.seed0,
    controls: opts.controls,
    settings: opts.settings,
    segmentationMultiplier: opts.segmentationMultiplier,
    waterLevel: opts.waterLevel,
    startingPositions: opts.startingPositions,
    startingLakePositions: opts.startingLakePositions,
  });

  const box = opts.cellQueryBox ?? {
    x0: originX,
    y0: originY,
    x1: originX + width * tpp,
    y1: originY + height * tpp,
  };
  const cells = placement.placedCells(box.x0, box.y0, box.x1, box.y1);

  paintCliffCells(base, cells, {
    originX,
    originY,
    tilesPerPixel: tpp,
    skipPixel: isWater,
  });
}
