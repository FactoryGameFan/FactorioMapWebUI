/**
 * PROTOTYPE (issue #19 follow-up): a multi-entry `(x, y)` memo, for the one
 * case `memoXY` structurally cannot serve.
 *
 * `memoXY` holds the LAST `(x, y)` only. That is the right shape for collapsing
 * a DAG's fan-out within a single pixel, which is what it was added for, and it
 * is very cheap - two number compares. But it can only ever hit when two
 * consumers ask for the same coordinate back to back.
 *
 * The Vulcanus rock overlay breaks that assumption. Its cost is spent inside
 * `resolveChunk`, which sweeps all 1024 tiles of a chunk in reverse index order
 * to resolve collisions - a chunk-major traversal, while terrain walks pixels
 * row-major. The two visit the same coordinates in different orders, so a
 * single-entry memo never hits across them even when they share field objects,
 * and no amount of loop fusion can align them.
 *
 * This keeps every value it computes, keyed on the integer tile coordinate, so
 * the second traversal hits regardless of order.
 *
 * ## Cost, and why the production geometry makes it cheap
 *
 * Unbounded retention is only acceptable because of how this app renders: the
 * preview is tiled across a 64-worker pool at 128x128 per tile, so a cache
 * covers ~16k entries, not the whole map. The 512x512 and 1024x1024 whole-image
 * renders exist in the benchmark, not in the app.
 *
 * Keys pack two 16-bit tile coordinates into one number, so this is exact for
 * |x|, |y| < 32768 and falls back to computing (never to a WRONG value) outside
 * that. Non-integer coordinates also bypass the cache rather than aliasing onto
 * a neighbour - the cliff lattice samples at y + 0.5, and rounding those onto
 * integer keys would silently return a different point's value.
 */
const LIMIT = 32768;

export function memoRegion(fn: (x: number, y: number) => number): (x: number, y: number) => number {
  const cache = new Map<number, number>();
  return (x: number, y: number): number => {
    // Bypass rather than alias: a non-integer or out-of-range coordinate must
    // not collide with a different point's cached value.
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x <= -LIMIT ||
      x >= LIMIT ||
      y <= -LIMIT ||
      y >= LIMIT
    )
      return fn(x, y);
    const key = ((x + LIMIT) << 16) | (y + LIMIT);
    const hit = cache.get(key);
    // `undefined` rather than a sentinel: NaN and 0 are both legitimate field
    // values here, so neither can stand in for "absent".
    if (hit !== undefined) return hit;
    const value = fn(x, y);
    cache.set(key, value);
    return value;
  };
}
