/**
 * Stage 4: group islands into the chains a power pole can wire together.
 *
 * Gaps are measured between LAND, not between centroids or bounding boxes. Two
 * islands can have near-touching bounding boxes and distant land, and a chain
 * built on bounding boxes would promise a connection that is not there.
 */

/** Big electric pole wire reach, in tiles. */
export const BIG_POLE_REACH_TILES = 30;

export interface PlacedMask {
  readonly mask: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** World tile coordinate of the mask's top-left pixel. */
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
}

function landTiles(m: PlacedMask): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let py = 0; py < m.height; py++)
    for (let px = 0; px < m.width; px++)
      if (m.mask[py * m.width + px])
        out.push({ x: m.originX + px * m.tilesPerPixel, y: m.originY + py * m.tilesPerPixel });
  return out;
}

function boundsOf(m: PlacedMask) {
  return {
    x0: m.originX,
    y0: m.originY,
    x1: m.originX + (m.width - 1) * m.tilesPerPixel,
    y1: m.originY + (m.height - 1) * m.tilesPerPixel,
  };
}

/** Chebyshev-style separation between two axis-aligned boxes, in tiles. */
function boxGap(a: PlacedMask, b: PlacedMask): number {
  const A = boundsOf(a);
  const B = boundsOf(b);
  const dx = Math.max(0, Math.max(A.x0 - B.x1, B.x0 - A.x1));
  const dy = Math.max(0, Math.max(A.y0 - B.y1, B.y0 - A.y1));
  return Math.max(dx, dy);
}

/**
 * Chebyshev distance in tiles between the nearest land tiles of two
 * PRE-EXTRACTED land-tile arrays. The shared body behind both the public
 * `minGapTiles` (which extracts on every call, for callers with just one pair
 * to check) and `chainComponents` (which extracts every mask's array ONCE and
 * reuses it across every pair - see the comment there).
 */
function minGapTilesFromArrays(
  A: readonly { x: number; y: number }[],
  B: readonly { x: number; y: number }[],
): number {
  let best = Infinity;
  for (const p of A)
    for (const q of B) {
      const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  return best === Infinity ? Infinity : best;
}

/**
 * Chebyshev distance in tiles between the nearest land tiles of two masks.
 * A big pole sits on a land tile, so reach is measured tile-centre to
 * tile-centre: two poles up to 30 tiles apart connect.
 */
export function minGapTiles(a: PlacedMask, b: PlacedMask): number {
  return minGapTilesFromArrays(landTiles(a), landTiles(b));
}

export function chainComponents(
  masks: readonly PlacedMask[],
  reachTiles: number = BIG_POLE_REACH_TILES,
): number[] {
  const n = masks.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  // Extracted ONCE per mask, not once per PAIR. `minGapTiles` re-walks a
  // mask's whole pixel grid to rebuild its land-tile array every time it is
  // called, and this loop calls it once per pair below - redundant work that
  // scales with how many pairs pass the `boxGap` prefilter, not with `n`.
  // Measured two ways (2026-08-15 review fix): on REAL Fulgora dedup data
  // (radius 5000, 2,313 candidates), `boxGap` already discards 99.8%+ of
  // pairs cheaply, so the whole stage costs ~200ms either way and this hoist
  // saves only a few percent of that. On an adversarial synthetic case shaped
  // to make most box-passing pairs land right next to each other (so far more
  // of them reach this loop), the same hoist saves ~5-10% of a ~1.9s call.
  // Worth doing either way - it removes real, provably redundant work at
  // zero behavior change - but don't expect it to be the dominant cost here;
  // the remaining O(land^2) per-pair comparison is.
  const tiles = masks.map((m) => landTiles(m));

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      // Cheap box test first: a pair whose BOXES are further apart than the
      // reach cannot possibly have land within it, and the per-tile comparison
      // below is quadratic in island area.
      if (boxGap(masks[i] as PlacedMask, masks[j] as PlacedMask) > reachTiles) continue;
      if (
        minGapTilesFromArrays(
          tiles[i] as { x: number; y: number }[],
          tiles[j] as { x: number; y: number }[],
        ) <= reachTiles
      )
        union(i, j);
    }

  return Array.from({ length: n }, (_, i) => find(i));
}
