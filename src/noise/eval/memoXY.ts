/**
 * Wrap a pure `(x, y) => number` field in a single-slot cache keyed on the last
 * `(x, y)` it was called with.
 *
 * The Vulcanus field graph is a heavily-shared DAG: a single node like
 * `mountains_raw_volcano` feeds all three biomes, and each biome is read ~5x by
 * the 19 tile `*_range` expressions, so a naive lazy-closure evaluation
 * recomputes each node - and every `basis_noise` octave beneath it - dozens of
 * times per pixel. A renderer sweeps one pixel at a time and reads every node at
 * that single `(x, y)`, so a one-entry cache collapses those repeat reads to one
 * evaluation per node per pixel.
 *
 * Byte-exact by construction: it returns the *identical* float the wrapped
 * function computed (cached, not recomputed-and-rounded), so a memoized field
 * graph produces bit-for-bit the same render as the un-memoized one. The cache is
 * keyed on exact `===` equality of both coordinates, so any change in either
 * coordinate (including the off-pixel spot coordinates a region selection probes)
 * recomputes rather than returning a stale value - correctness never depends on
 * the caller staying on one pixel, only efficiency does.
 *
 * **The coordinates are recorded AFTER `fn` returns, and that ordering is
 * load-bearing for any `fn` that can throw.** Recording them first - which is
 * what this did until 2026-08-05 - leaves the slot claiming a position it never
 * produced a value for, so the NEXT call at that same position returns the
 * PREVIOUS position's number instead of throwing again. The failure surfaces on
 * the second call, never the first, which is about as quiet as a bug gets.
 * `src/noise/voronoiNoise.ts` has such an `fn` (`voronoi_pyramid_noise` rejects
 * `minkowski3`, as the game's own expression compiler does), and the hazard was
 * first dodged there by hoisting the throw out of the memo. Fixing it here
 * instead retires the whole class: for a function that returns normally the two
 * orderings are value-identical, so nothing else changes.
 */
export function memoXY(fn: (x: number, y: number) => number): (x: number, y: number) => number {
  // NaN sentinels: NaN !== NaN, so the very first call always misses. World
  // coordinates are finite, so a real call never collides with the sentinel.
  let lastX = NaN;
  let lastY = NaN;
  let value = 0;
  return (x: number, y: number): number => {
    if (x === lastX && y === lastY) return value;
    // `fn` first: if it throws, the slot must keep pointing at the last
    // position that actually produced a value. See the docblock.
    value = fn(x, y);
    lastX = x;
    lastY = y;
    return value;
  };
}
