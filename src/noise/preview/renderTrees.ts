/**
 * Composite the tree overlay onto a terrain ImageData: sweep the same pixel grid
 * as renderTerrain and blend the game's tree chart color over each pixel with an
 * alpha proportional to the pixel's tree-footprint coverage. Mutates `base` in
 * place.
 *
 * Why a footprint kernel and not a flat per-pixel blend: the game's own map
 * preview places real tree entities and charts each one via
 * `ChartingInterface::drawRectangle`, which rasterizes an entity's box
 * floor-to-ceil and blends every pixel it touches at full alpha (see
 * `0x1001b1fdc` in the disassembly). A tree's charted box is 1.0x1.0 tiles, so
 * with a uniformly distributed sub-tile placement it paints its own tile's
 * pixel with probability 1, each of the 4 edge-adjacent pixels with probability
 * 0.5, and each diagonal with probability 0.25 - the separable kernel
 * `[0.5, 1.0, 0.5]`. We cannot place individual trees without the per-chunk
 * placement roll (deferred - see docs/noise/placement-roll-NOTES.md), so we
 * draw the EXPECTED coverage instead: the density is exactly the probability
 * the game rolls against, because arbitration picks the max-probability entity
 * per tile and rolls once. Treating neighbouring tiles' placements as
 * independent events, the probability at least one paints a given pixel is one
 * minus the product of all their misses - which also self-limits at 1 with no
 * artificial clamp needed. Modelling one pixel per tree left the overlay 4.2x
 * under-inked against a real game render; this closes that gap. See the design
 * spec for the full RE and the coverage-prediction validation against seed
 * 123456 (9.80% / 11.46% / 13.13% predicted for box sizes 0.8 / 1.0 / 1.2
 * against a measured 11.49%).
 *
 * Trees do not place on water, so water pixels are skipped, reusing renderTerrain's
 * exact water decision via WATER_TILE_COLORS the same way renderResources does.
 * Cliff exclusion is not wired, matching the existing deferred ore-on-cliffs item.
 *
 * The blend itself compounds per drawn tree, not per coverage probability:
 * `drawRectangle` blends the tree color into the chart once for every tree
 * that touches a pixel, so two overlapping trees reach
 * `1 - (1 - TREE_MAX_ALPHA)^2`, not a single capped blend at `TREE_MAX_ALPHA`.
 * Blending once against a coverage probability structurally capped alpha at
 * `TREE_MAX_ALPHA` (0.398) and left the overlay under-inked (3.85 vs. the
 * game's 5.70 total ink units at seed 123456, whose implied alpha reaches a
 * measured max of 0.952). Moving the per-tree alpha inside the product lets
 * independent blends compound instead.
 */
import { WATER_TILE_COLORS } from "./renderResources";
import { makeTreeDensity, type TreeFieldParams } from "../trees/treeField";
import { TREE_MAP_COLOR } from "./palette";

/** The alpha component of the same constant: fully-forested tiles blend at 40%. */
export const TREE_MAX_ALPHA = 0.4;

/** Separable 1-D footprint kernel for a 1.0-tile box with a uniform sub-tile offset. */
const KERNEL_WEIGHT: readonly [number, number, number] = [0.5, 1.0, 0.5];

export interface RenderTreesOptions extends TreeFieldParams {
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
}

export function renderTrees(base: ImageData, opts: RenderTreesOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const density = makeTreeDensity(opts);

  const isWater = (r: number, g: number, b: number): boolean => {
    for (const [wr, wg, wb] of WATER_TILE_COLORS) {
      if (r === wr && g === wg && b === wb) return true;
    }
    return false;
  };

  // Precompute a (width + 2) x (height + 2) density buffer spanning the pixel
  // grid plus a one-cell border, sampled at the exact world coordinates the
  // pixel loop below uses. This reads the density FIELD (a pure function of
  // world coordinates), never the image buffer, so no halo is needed for
  // tiled rendering to stay byte-identical - and it keeps the cost at one
  // density evaluation per pixel (plus the thin border), not nine.
  const bufW = width + 2;
  const bufH = height + 2;
  const densityBuf = new Float64Array(bufW * bufH);
  for (let by = 0; by < bufH; by++) {
    const wy = originY + (by - 1) * tpp;
    for (let bx = 0; bx < bufW; bx++) {
      const wx = originX + (bx - 1) * tpp;
      densityBuf[by * bufW + bx] = density(wx, wy);
    }
  }

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const o = (py * width + px) * 4;
      if (isWater(base.data[o], base.data[o + 1], base.data[o + 2])) continue;

      // The game blends once PER DRAWN TREE, not once against a coverage
      // probability - so overlapping trees compound rather than cap out at a
      // single tree's TREE_MAX_ALPHA. Each neighbouring tile independently
      // draws at alpha `TREE_MAX_ALPHA * p * w` (w = the separable
      // [0.5, 1, 0.5] kernel weight), and the combined alpha of independent
      // blends is 1 minus the product of their misses - which self-limits
      // toward 1, not TREE_MAX_ALPHA. Measured against a real
      // --generate-map-preview render at seed 123456, the game's implied
      // alpha has median 0.381, p90 0.65, max 0.952 - all well above the old
      // formula's structural ceiling of TREE_MAX_ALPHA (0.398).
      let miss = 1;
      for (let dy = -1; dy <= 1; dy++) {
        const wy = KERNEL_WEIGHT[dy + 1];
        const by = py + 1 + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const wx = KERNEL_WEIGHT[dx + 1];
          const bx = px + 1 + dx;
          const p = densityBuf[by * bufW + bx] * wx * wy;
          miss *= 1 - TREE_MAX_ALPHA * p;
        }
      }
      const alpha = 1 - miss;
      if (alpha <= 0) continue;

      // Match the game's integer blend arithmetic exactly rather than
      // float-rounding: alpha is an 8-bit byte, then fixed up 255 -> 256.
      const A = Math.round(alpha * 255);
      const a = A + (A >> 7);
      base.data[o] = ((256 - a) * base.data[o] + a * TREE_MAP_COLOR[0]) >> 8;
      base.data[o + 1] = ((256 - a) * base.data[o + 1] + a * TREE_MAP_COLOR[1]) >> 8;
      base.data[o + 2] = ((256 - a) * base.data[o + 2] + a * TREE_MAP_COLOR[2]) >> 8;
      base.data[o + 3] = 255;
    }
  }
}
