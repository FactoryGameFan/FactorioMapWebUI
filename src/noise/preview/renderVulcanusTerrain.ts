import type { EvalCtxInput } from "../eval/ctx";
import {
  type VulcanusStack,
  makeVulcanusTileResolver,
  makeVulcanusTileResolverFrom,
} from "../tiles/vulcanusCatalog";

export interface RenderVulcanusTerrainOptions {
  /**
   * Vulcanus field stack to render through. The composite path builds ONE
   * cached stack and hands the same instance to every overlay, so each pass
   * reuses the field values the others already computed.
   */
  stack?: VulcanusStack;
  /** Map seed (= map_seed / seed0). Callers resolve a null "random" seed first. */
  readonly seed0: number;
  /** Output pixel dimensions. */
  readonly width: number;
  readonly height: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /**
   * Non-seed resolver params (see `EvalCtx`'s Vulcanus fields,
   * `withCtxDefaults`). `startingPositions` (which affects the
   * `lava_spawn_excluder` distance term) is threaded through, and since V2
   * restored the resource-coupling terms into the tile catalog
   * (`docs/noise/vulcanus-resources-NOTES.md`), `vulcanusResourceControls` is
   * now threaded on every terrain-family call too - the tile catalog reads
   * `metalTile`/`calciteRegion`/`sulfuricAcidRegionPatchy`, all of which depend
   * on the resource control levers (size/frequency), not just the seed.
   */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
}

/**
 * Sweep a `width x height` pixel grid over world space and return an
 * `ImageData` painted with each pixel's winning Vulcanus tile's `map_color`
 * (Task 11 - mirrors `renderTerrain`, but resolves through
 * `makeVulcanusTileResolver` (Task 10) instead of the Nauvis catalog).
 *
 * Deliberately has NO water/deepwater early-out: Vulcanus has no water tile at
 * all (lava plays that visual role but is resolved by the same argmax as every
 * other tile), so the Nauvis fast-path's premise does not apply here. Every
 * pixel runs the full 19-tile argmax.
 */
export function renderVulcanusTerrain(opts: RenderVulcanusTerrainOptions): ImageData {
  const { width, height, seed0 } = opts;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const resolve =
    opts.stack === undefined
      ? makeVulcanusTileResolver({ seed0, ...opts.ctx })
      : makeVulcanusTileResolverFrom(opts.stack);

  const data = new Uint8ClampedArray(width * height * 4);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;

      const color = resolve(wx, wy).color;

      const o = (py * width + px) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;
    }
  }

  return new ImageData(data, width, height);
}
