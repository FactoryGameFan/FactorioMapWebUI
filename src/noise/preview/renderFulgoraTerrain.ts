import {
  type FulgoraStack,
  type FulgoraTile,
  makeFulgoraOceanTestFrom,
  makeFulgoraStack,
  makeFulgoraTileResolver,
  makeFulgoraTileResolverFrom,
} from "../tiles/fulgoraCatalog";
import type { FulgoraCtx } from "../expressions/fulgoraShared";

export interface RenderFulgoraTerrainOptions {
  /** Shared field DAG - see `RenderVulcanusTerrainOptions.stack`. */
  readonly stack?: FulgoraStack;
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
 * All eight of Fulgora's land tiles are resolved against each other in the land
 * argmax (see `fulgoraCatalog.ts`), so this palette can paint every position
 * in the fixture with the tile the resolver actually names. The ocean tiles
 * still dominate the argmax wherever they are placeable, so the land argmax
 * only runs once none of them are.
 *
 * **The eight-way land argmax is 94.5% accurate against `get_tile` at
 * positions where the game placed a land tile**, measured over all 2261 such
 * positions in the fixture (2137/2261 - see the "OPEN FINDING" paragraph on
 * `makeFulgoraTileResolver` in `fulgoraCatalog.ts` and
 * `test/fulgoraLandTiles.spec.ts` for the full breakdown; the gap is an open
 * finding, not a rounding error). That denominator excludes the other
 * direction: `fulgoraAgreement.spec.ts` pins exactly 7 positions where the
 * game placed OCEAN and this resolver names a land tile, which is not
 * reachable by any palette fix here - see that spec for why. Unlike the
 * three-way palette this replaces, there is at least no longer a tile the
 * game placed that this palette cannot produce at all.
 */
const COLORS: Record<FulgoraTile, readonly [number, number, number]> = {
  "fulgoran-dust": [112, 65, 50],
  "fulgoran-dunes": [125, 71, 59],
  "fulgoran-sand": [118, 68, 56],
  "fulgoran-rock": [131, 85, 66],
  "fulgoran-paving": [120, 94, 67],
  "fulgoran-walls": [114, 75, 65],
  "fulgoran-conduit": [100, 79, 68],
  "fulgoran-machinery": [89, 79, 68],
  shallow: [74, 42, 43],
  // The Lua defines this as `{49*1.15, 31*1.15, 35*1.15}` = (56.35, 35.65,
  // 40.25). Red and blue floor and round identically, so they cannot tell the
  // two rules apart; GREEN is the only discriminating channel: 35.65 rounds to
  // 36 under every rounding rule, including round-half-even, but the game's
  // own `--generate-map-preview` PNG (test/fixtures/oracle-preview-fulgora-
  // terrain.seed123456.png) shows 35 at every one of the 370,891 deep-ocean
  // pixels sampled. That is truncation, not rounding, and it is not a lone
  // reading: `SCRAP_MAP_COLOR`'s 0.9*255 = 229.5 lands on 229 in that same PNG
  // (`src/noise/resources/fulgoraResourceCatalog.ts`), a second, independent
  // case of a game map colour landing one below the rounded value. Using
  // Math.round here painted 91% of a whole-image Fulgora comparison as
  // "different" (differing/1,048,576 = 0.387) before this was found; Math.floor
  // drops that to 0.0334, in line with the ~5.5% land-tile argmax residual this
  // file already documents. Found and fixed while writing
  // `test/previewAgreement.spec.ts`'s whole-image Fulgora terrain comparison.
  deep: [Math.floor(49 * 1.15), Math.floor(31 * 1.15), Math.floor(35 * 1.15)],
};

/**
 * The colours that mean "not land" in a Fulgora terrain render.
 *
 * Derived from `COLORS` rather than written out again: a second hardcoded copy
 * would drift the first time a tile colour is corrected, and one already was -
 * deep ocean's green channel was wrong from V1 until the scrap work, because
 * the game truncates where this renderer rounded.
 */
export const FULGORA_OCEAN_RGB: readonly (readonly [number, number, number])[] = [
  COLORS.shallow,
  COLORS.deep,
];

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

  const resolve =
    opts.stack === undefined
      ? makeFulgoraTileResolver({ seed0, ...opts.ctx })
      : makeFulgoraTileResolverFrom(opts.stack);
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

/**
 * The colour {@link renderFulgoraLandMask} paints every LAND pixel.
 *
 * Deliberately not one of the eight land-tile colours: this render does not
 * know which land tile a pixel is, and painting `fulgoran-dust` would be a
 * picture that claims to know. All `landMaskFromImage` asks is "is this one of
 * `FULGORA_OCEAN_RGB`", so any non-ocean colour is correct, and one that names
 * itself is honest.
 */
export const FULGORA_LANDMASK_LAND_RGB: readonly [number, number, number] = [255, 0, 255];

/**
 * As {@link renderFulgoraTerrain}, but answering only LAND versus OCEAN.
 *
 * The island finder renders terrain and then collapses it to one bit against
 * `FULGORA_OCEAN_RGB` (`islandMask.ts`), so every land-tile probability it
 * computes is discarded. This skips the eight-way argmax on the pixels that
 * reach it. Ocean pixels keep their true `deep`/`shallow` colour - the ocean
 * branch already distinguishes them for free - and land pixels get
 * {@link FULGORA_LANDMASK_LAND_RGB}.
 *
 * **This is NOT the cheap early-out it might look like.** The elevation chain
 * still runs at every pixel, because deciding "is this ocean" IS that chain -
 * the same point `renderFulgoraTerrain`'s header makes. Measured over 40 real
 * candidate windows at radius 1024: **15.7% faster at 8 tiles/px, 13.8% at 2**
 * (20.94 -> 17.66 us/px, 20.13 -> 17.34). The ceiling is structural, because
 * `chain.elevation` alone is 81% of a tile pixel and both views pay it.
 */
export function renderFulgoraLandMask(opts: RenderFulgoraTerrainOptions): ImageData {
  const { width, height, seed0 } = opts;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ocean = makeFulgoraOceanTestFrom(opts.stack ?? makeFulgoraStack({ seed0, ...opts.ctx }));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      const wet = ocean(wx, wy);
      const color = wet === undefined ? FULGORA_LANDMASK_LAND_RGB : COLORS[wet];
      const o = (py * width + px) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;
    }
  }

  return new ImageData(data, width, height);
}
