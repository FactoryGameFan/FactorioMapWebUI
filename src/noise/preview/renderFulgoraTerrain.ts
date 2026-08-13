import { type FulgoraSurface, makeFulgoraSurfaceResolver } from "../tiles/fulgoraCatalog";
import type { FulgoraCtx } from "../expressions/fulgoraShared";

export interface RenderFulgoraTerrainOptions {
  /** Map seed as the noise program sees it - the FULGORA SURFACE seed. */
  readonly seed0: number;
  /** Output pixel dimensions. */
  readonly width: number;
  readonly height: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params - the two `control:fulgora_islands:*` levers. */
  readonly ctx?: Omit<FulgoraCtx, "seed0">;
}

/**
 * Map colours, taken from `space-age/prototypes/tile/tiles-fulgora.lua` rather
 * than picked by eye.
 *
 * `oil-ocean-shallow` and `-shallow-2` both declare `{74, 42, 43}`, and
 * `oil-ocean-deep` and `-deep-2` both declare `{49*1.15, 31*1.15, 35*1.15}` -
 * which is why the resolver only has to get shallow-versus-deep right and never
 * which variant of each. The scaled triple is written out here in the form the
 * Lua uses so it stays checkable against the source.
 *
 * `land` is `fulgoran-sand`'s own colour. Fulgora's eight land tiles are not
 * resolved against each other yet (see `fulgoraCatalog.ts` - the ocean tiles
 * dominate the argmax wherever they are placeable, so only the land/ocean split
 * is decided). Using a real land tile's colour rather than an invented one means
 * a later pass can introduce the full land argmax without the palette jumping.
 */
const COLORS: Record<FulgoraSurface, readonly [number, number, number]> = {
  land: [118, 68, 56],
  shallow: [74, 42, 43],
  deep: [Math.round(49 * 1.15), Math.round(31 * 1.15), Math.round(35 * 1.15)],
};

/**
 * Sweep a `width x height` pixel grid over world space and return an
 * `ImageData` painted with each pixel's Fulgora surface colour, mirroring
 * `renderVulcanusTerrain`.
 *
 * `seed0` must already be the SURFACE seed - derive it with
 * `surfaceSeedForPlanet("fulgora", mapSeed)`. Nothing here can catch a caller
 * that passes a raw map seed, because every Fulgora oracle fixture is captured
 * with the surface seed forced; `test/fulgoraSurfaceSeed.spec.ts` is what
 * guards it.
 *
 * Like the Vulcanus renderer this has no water early-out. Fulgora is mostly
 * ocean, so an early-out would be tempting, but deciding a pixel is ocean IS
 * the whole computation - the elevation chain has to run either way.
 */
export function renderFulgoraTerrain(opts: RenderFulgoraTerrainOptions): ImageData {
  const { width, height, seed0 } = opts;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const resolve = makeFulgoraSurfaceResolver({ seed0, ...opts.ctx });
  const data = new Uint8ClampedArray(width * height * 4);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      const color = COLORS[resolve(wx, wy)];
      const o = (py * width + px) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;
    }
  }

  return new ImageData(data, width, height);
}
