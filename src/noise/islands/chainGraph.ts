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
 * Smallest distance in tiles between any land tile of `a` and any of `b`, as a
 * Chebyshev distance - a pole's reach is a square, not a circle.
 */
export function minGapTiles(a: PlacedMask, b: PlacedMask): number {
  const A = landTiles(a);
  const B = landTiles(b);
  let best = Infinity;
  for (const p of A)
    for (const q of B) {
      const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  return best === Infinity ? Infinity : Math.max(0, best - 1);
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

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      // Cheap box test first: a pair whose BOXES are further apart than the
      // reach cannot possibly have land within it, and the per-tile comparison
      // below is quadratic in island area.
      if (boxGap(masks[i] as PlacedMask, masks[j] as PlacedMask) > reachTiles) continue;
      if (minGapTiles(masks[i] as PlacedMask, masks[j] as PlacedMask) <= reachTiles) union(i, j);
    }

  return Array.from({ length: n }, (_, i) => find(i));
}
