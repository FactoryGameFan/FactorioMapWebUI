/**
 * Counts the whole Factorio chunks an island covers - 32x32-tile blocks that
 * are land all the way across.
 *
 * This is the area figure a megabase plan is actually made of, and it is
 * deliberately NOT `landTiles / 1024`. A frilly island can carry a large tile
 * count and very few whole chunks, because every chunk its coastline crosses
 * is worth nothing to a blueprint. That disagreement is the point of the
 * number.
 *
 * What counts as land here is whatever `islandMask.ts` produced: ocean is
 * excluded, and cliffs are not modelled at all (the finder renders
 * `view: "terrain"`), so a cliff never subtracts from a chunk. That matches
 * how the terrain plays - cliffs can be removed, ocean cannot.
 *
 * **Chunk boundaries land exactly on pixel boundaries, and that is checked
 * rather than assumed.** A chunk is 32 tiles; the finder samples at 8 tiles/px
 * (coarse) or 2 (refine), and both divide 32. Every window's origin is already
 * snapped to a multiple of its own `tilesPerPixel` (see `windowFor` in
 * `findIslands.ts`), so a world position that is a multiple of 32 is always a
 * whole number of pixels from that origin. `chunkOriginPixel` below relies on
 * exactly that, and `assertDivides` fails loudly if a future caller picks a
 * step that breaks it.
 *
 * **Accuracy depends on which pass measured the mask.** At 8 tiles/px a chunk
 * is 4x4 pixels and each pixel is ONE sample standing for 64 tiles, so a chunk
 * can read full while holding water. At 2 tiles/px it is 16x16 pixels over 4
 * tiles each, which is far more trustworthy. The results table groups refined
 * rows above coarse ones and divides them, so the reader can tell which kind
 * of number they are looking at.
 */

/** A Factorio chunk is 32x32 tiles. */
export const CHUNK_TILES = 32;

function assertDivides(tilesPerPixel: number): number {
  const side = CHUNK_TILES / tilesPerPixel;
  if (!Number.isInteger(side) || side < 1) {
    throw new Error(
      `tilesPerPixel ${tilesPerPixel} does not divide a ${CHUNK_TILES}-tile chunk into whole pixels`,
    );
  }
  return side;
}

/**
 * The pixel offset of the first chunk boundary at or after `origin`.
 *
 * Always >= 0, because `Math.ceil` rounds a world coordinate up to the next
 * multiple of `CHUNK_TILES`, and always a whole number of pixels, because both
 * that multiple and `origin` are multiples of `tilesPerPixel`.
 */
function chunkOriginPixel(origin: number, tilesPerPixel: number): number {
  return (Math.ceil(origin / CHUNK_TILES) * CHUNK_TILES - origin) / tilesPerPixel;
}

/**
 * How many whole chunks of `mask` are land all the way across.
 *
 * `mask` is the ISOLATED island (one flood-filled component), not the raw land
 * mask, so this counts only chunks belonging to this island - a neighbour's
 * land sitting in the same window contributes nothing.
 */
export function countFullChunks(
  mask: Uint8Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
  tilesPerPixel: number,
): number {
  const side = assertDivides(tilesPerPixel);
  const startX = chunkOriginPixel(originX, tilesPerPixel);
  const startY = chunkOriginPixel(originY, tilesPerPixel);

  let count = 0;
  for (let by = startY; by + side <= height; by += side) {
    for (let bx = startX; bx + side <= width; bx += side) {
      let full = true;
      for (let y = by; y < by + side && full; y++) {
        const rowStart = y * width;
        for (let x = bx; x < bx + side; x++) {
          if (!mask[rowStart + x]) {
            full = false;
            break;
          }
        }
      }
      if (full) count++;
    }
  }
  return count;
}
