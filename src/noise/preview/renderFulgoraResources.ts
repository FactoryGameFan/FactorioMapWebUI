/**
 * Composite the Fulgora scrap overlay onto a terrain `ImageData`: sweep the same
 * pixel grid as `renderFulgoraTerrain` and paint `SCRAP_MAP_COLOR` where the
 * roll hits. Mutates `base` in place. Mirrors `renderVulcanusResources`.
 *
 * **1x1 marks, not the shared 3x3 `PLACEMENT_MARK_RADIUS_PX`.** Scrap reaches
 * the 0.5 probability cap over contiguous pockets - about one entity per 36 to
 * 83 land tiles - so a 3x3 mark would merge those into a blob. This is the same
 * reasoning Vulcanus rocks use. The geyser gets 3x3 because it is roughly one
 * entity per 3000 tiles and a single pixel disappears.
 *
 * Painting 1x1 also means this pass needs no `sweepBox` halo: a mark cannot
 * cross a worker-tile seam, so the tiled render is byte-identical without one.
 */
import { SCRAP_MAP_COLOR, makeFulgoraScrapPlacement } from "../resources/fulgoraResourceCatalog";
import type { FulgoraScrapControls } from "../expressions/fulgoraScrap";
import { makeFulgoraStack } from "../tiles/fulgoraCatalog";
import type { FulgoraStack } from "../tiles/fulgoraCatalog";
import type { FulgoraCtx } from "../expressions/fulgoraShared";

export interface RenderFulgoraResourcesOptions {
  /** Shared field DAG - see `RenderFulgoraTerrainOptions.stack`. */
  readonly stack?: FulgoraStack;
  /** Map seed as the noise program sees it - the FULGORA SURFACE seed. */
  readonly seed0: number;
  readonly originX?: number;
  readonly originY?: number;
  readonly tilesPerPixel?: number;
  readonly ctx?: Omit<FulgoraCtx, "seed0">;
  readonly scrapControls?: FulgoraScrapControls;
}

export function renderFulgoraResources(base: ImageData, opts: RenderFulgoraResourcesOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const stack = opts.stack ?? makeFulgoraStack({ seed0: opts.seed0, ...opts.ctx });
  const placed = makeFulgoraScrapPlacement(stack, opts.scrapControls);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      if (!placed(wx, wy)) continue;
      const o = (py * width + px) * 4;
      base.data[o] = SCRAP_MAP_COLOR[0];
      base.data[o + 1] = SCRAP_MAP_COLOR[1];
      base.data[o + 2] = SCRAP_MAP_COLOR[2];
      base.data[o + 3] = 255;
    }
  }
}
