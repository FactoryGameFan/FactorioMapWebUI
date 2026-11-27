/**
 * Pure tile geometry for the region-tiled renderer: split a pixel image into a
 * grid of sub-boxes, each carrying both its pixel offset within the full image
 * (`dx`/`dy`, for blitting) and its own world origin (for rendering). No Worker,
 * no renderer, no DOM - see the region-tiling design doc.
 */

/** A pixel rectangle plus the world coordinates it maps onto. */
export interface ImageBox {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly tilesPerPixel: number;
}

/** An `ImageBox` that is part of a larger image, at pixel offset `dx`/`dy`. */
export interface TileBox extends ImageBox {
  readonly dx: number;
  readonly dy: number;
}

/**
 * Split `full` into a row-major grid of at most `tileSize`-square tiles. The
 * trailing row and column are narrower when the size is not divisible, so the
 * tiles cover the image exactly once with no overlap.
 *
 * Byte-identity precondition: a tile computes world coordinates as
 * `(originX + dx * tilesPerPixel) + px * tilesPerPixel`, while the untiled
 * render computes `originX + (dx + px) * tilesPerPixel`. Those agree exactly
 * only when the intermediate products are exactly representable in f64 - true
 * for integer origins and integer `tilesPerPixel`, which is all the app uses
 * (the preview is fixed at 1). A fractional `tilesPerPixel` (a zoom feature,
 * say) could make the two disagree in the last bit and silently break the
 * tiled-equals-untiled invariant. Do not generalize this without extending the
 * equality gate to the new scale.
 */
export function planTiles(full: ImageBox, tileSize: number): TileBox[] {
  if (!(tileSize > 0)) throw new Error("planTiles: tileSize must be positive");
  const tiles: TileBox[] = [];
  for (let dy = 0; dy < full.height; dy += tileSize) {
    const height = Math.min(tileSize, full.height - dy);
    for (let dx = 0; dx < full.width; dx += tileSize) {
      const width = Math.min(tileSize, full.width - dx);
      tiles.push({
        dx,
        dy,
        width,
        height,
        originX: full.originX + dx * full.tilesPerPixel,
        originY: full.originY + dy * full.tilesPerPixel,
        tilesPerPixel: full.tilesPerPixel,
      });
    }
  }
  return tiles;
}

/** A map chunk's edge, in world tiles. */
const CHUNK_TILES = 32;

/**
 * Cut positions along one axis of `length` pixels, each near its `ideal` and
 * moved to the nearest pixel that starts a world chunk when there is one.
 *
 * Chunk alignment is a cost decision, not a correctness one. At one tile per
 * pixel every planet but Nauvis corrects its terrain over each worker tile's
 * own chunks plus a one-chunk margin, so a tile that ends a few pixels into a
 * chunk pays for that whole chunk, and its neighbour pays for it again. Any
 * cut stitches byte for byte; `test/tiledEqualityAppGeometry.spec.ts` renders
 * the app's own plans.
 *
 * A pixel starts a chunk when `origin + px * tilesPerPixel` is a multiple of
 * 32. With no such pixel (a chunk narrower than a pixel, or an origin off the
 * pixel grid) a cut stays at its ideal. A snapped cut that would collide with
 * its neighbour stays near its ideal too, so every run keeps at least one
 * pixel.
 */
function snapCuts(
  origin: number,
  length: number,
  tilesPerPixel: number,
  ideals: readonly number[],
): number[] {
  const cuts: number[] = [];
  let prev = 0;
  ideals.forEach((raw, k) => {
    const ideal = Math.round(raw);
    const remaining = ideals.length - k;
    const lo = prev + 1;
    const hi = length - remaining;
    const snapped = nearestChunkStart(origin, tilesPerPixel, ideal);
    const cut =
      snapped !== null && snapped >= lo && snapped <= hi
        ? snapped
        : Math.min(Math.max(ideal, lo), hi);
    cuts.push(cut);
    prev = cut;
  });
  return cuts;
}

/**
 * The pixel nearest `px` whose world coordinate starts a chunk, or null when
 * the chunk pitch or the origin is not a whole number of pixels.
 */
function nearestChunkStart(origin: number, tilesPerPixel: number, px: number): number | null {
  const pitch = CHUNK_TILES / tilesPerPixel;
  const originPx = origin / tilesPerPixel;
  if (!Number.isInteger(pitch) || !Number.isInteger(originPx)) return null;
  // The pixel offset of the first chunk start at or after pixel 0.
  const phase = ((-originPx % pitch) + pitch) % pitch;
  return phase + Math.round((px - phase) / pitch) * pitch;
}

/**
 * The fewest tiles a plan holds, so that even a one- or two-worker pool paints
 * the preview in pieces rather than all at the end.
 */
const MIN_TILES = 4;

/**
 * The extra pixels a tile pays for along each axis, for choosing between
 * layouts: one 32-tile chunk of correction margin on each side at one tile per
 * pixel. Only the ranking of layouts reads it.
 */
const MARGIN_PX = 64;

/** How many tiles each of `rows` rows holds: as even as possible, the larger rows spread out. */
function rowCounts(count: number, rows: number): number[] {
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, i) =>
    Math.floor(((i + 1) * extra) / rows) > Math.floor((i * extra) / rows) ? base + 1 : base,
  );
}

/**
 * The row count whose largest tile, margin included, is smallest. Each row is
 * as tall as its share of the tiles, so every tile has about the same area;
 * what the row count changes is how square they are, and a long thin tile pays
 * the most margin for its area.
 */
function bestRowCount(width: number, height: number, count: number): number {
  let best = 1;
  let bestCost = Infinity;
  for (let rows = 1; rows <= Math.min(count, height); rows++) {
    let worst = 0;
    for (const c of rowCounts(count, rows)) {
      const w = width / c;
      const h = (height * c) / count;
      worst = Math.max(worst, (w + MARGIN_PX) * (h + MARGIN_PX));
    }
    if (worst < bestCost) {
      bestCost = worst;
      best = rows;
    }
  }
  return best;
}

/**
 * The tile plan for a pool of `workers`: a whole number of tiles per worker
 * (one, unless that leaves fewer than `MIN_TILES`), all of about the same
 * area, laid out in rows and cut on chunk boundaries where the geometry
 * allows. Row-major, so tiles still paint top to bottom.
 *
 * **One tile per worker, because the tiles cost the same.** Every planet's
 * tiles take within about 10% of each other at the app's geometry (measured on
 * Vulcanus: 4.10 to 4.50 s for the 16 tiles of a 256-pixel grid), so a plan
 * with a tile count that is not a multiple of the pool leaves a last tile
 * running alone while the rest of the pool idles. That is what the old
 * 256-pixel grid did on a 16-thread machine: 16 tiles on 15 workers, and the
 * 16th ran alone for 4.4 s.
 *
 * Fewer, larger tiles also repeat less work: each tile corrects its own chunks
 * plus a one-chunk margin, so the margin is a smaller share of a larger tile.
 * See `docs/rust-wasm-port.md`, "The tile plan follows the pool".
 */
export function planForPool(full: ImageBox, workers: number): TileBox[] {
  const n = Math.max(1, Math.floor(workers));
  return planRows(full, n * Math.ceil(MIN_TILES / n));
}

/**
 * `count` tiles of about the same area, in rows (see `bestRowCount`), cut on
 * chunk boundaries where the geometry allows. `planForPool` picks `count`.
 */
export function planRows(full: ImageBox, count: number): TileBox[] {
  if (!(Number.isInteger(count) && count > 0)) {
    throw new Error("planRows: count must be a positive integer");
  }
  const rows = rowCounts(count, bestRowCount(full.width, full.height, count)).map((c) =>
    Math.min(c, full.width),
  );
  const total = rows.reduce((a, b) => a + b, 0);
  const rowIdeals: number[] = [];
  let acc = 0;
  for (const c of rows.slice(0, -1)) {
    acc += c;
    rowIdeals.push((full.height * acc) / total);
  }
  const ys = [
    0,
    ...snapCuts(full.originY, full.height, full.tilesPerPixel, rowIdeals),
    full.height,
  ];
  const tiles: TileBox[] = [];
  rows.forEach((c, j) => {
    const colIdeals = Array.from({ length: c - 1 }, (_, i) => (full.width * (i + 1)) / c);
    const xs = [
      0,
      ...snapCuts(full.originX, full.width, full.tilesPerPixel, colIdeals),
      full.width,
    ];
    const dy = ys[j]!;
    const height = ys[j + 1]! - dy;
    for (let i = 0; i < c; i++) {
      const dx = xs[i]!;
      tiles.push({
        dx,
        dy,
        width: xs[i + 1]! - dx,
        height,
        originX: full.originX + dx * full.tilesPerPixel,
        originY: full.originY + dy * full.tilesPerPixel,
        tilesPerPixel: full.tilesPerPixel,
      });
    }
  });
  return tiles;
}

/** A rendered tile's pixels, positioned within the full image. */
export interface StitchTile {
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Assemble rendered tiles into one full-image RGBA buffer. The app blits tiles
 * straight to the canvas instead (so they appear progressively); this exists for
 * consumers that need a flat buffer, notably the tiled-equals-untiled gate.
 */
export function stitchTiles(
  full: { readonly width: number; readonly height: number },
  tiles: readonly StitchTile[],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(full.width * full.height * 4);
  for (const t of tiles) {
    const rowBytes = t.width * 4;
    for (let y = 0; y < t.height; y++) {
      const src = y * rowBytes;
      out.set(t.data.subarray(src, src + rowBytes), ((t.dy + y) * full.width + t.dx) * 4);
    }
  }
  return out;
}
