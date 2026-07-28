// Constants and pure helpers for the Nauvis rocks overlay, transcribed from
// factorio-data @ 2.1.11 (base/prototypes/decorative/decoratives.lua and
// base/prototypes/noise-expressions.lua). All three charted rock prototypes
// (huge-rock, big-rock, big-sand-rock) share this map_color.
import { sliderRescale } from "../eval/sliderRescale";

// Re-exported for existing callers/tests (`sliderRescale` used to be defined
// here); the implementation now lives in `../eval/sliderRescale` so
// non-rocks callers (e.g. Vulcanus's `starting_spot_at_angle` siblings) can
// use it without a `rocks/`-flavored import.
export { sliderRescale };

export const ROCK_SEED1 = 137;
export const ROCK_MAP_COLOR: readonly [number, number, number] = [129, 105, 78];

/**
 * Radius, in pixels, of the mark painted per placed rock - `(2r+1)^2`, so `0` is
 * a single pixel. **The two planets differ, and the reason is measured.**
 *
 * The placement roll made rocks genuinely sparse: 0.080% of Nauvis ground and
 * 0.504% of Vulcanus over `[-512, 512)^2`, against the old thresholded ~1.6% and
 * 7.03%. Sparse alone is not the problem - contrast is:
 *
 * - **Nauvis (`1`, a 3x3 mark).** `ROCK_MAP_COLOR` (129, 105, 78) is within a few
 *   units of the dirt tiles it usually sits on, so at 1x1 and 0.080% the overlay
 *   is invisible in practice (Eric, 2026-07-27, on the deployed preview: "can't
 *   see the rocks anymore"). Thickening to 3x3 takes it to ~0.72% and it reads as
 *   scattered specks.
 * - **Vulcanus (`0`, a single pixel).** Tan on dark basalt is high contrast and
 *   the overlay is already 6x denser, so 1x1 reads as a fine stipple - checked by
 *   eye on the rocks view before changing anything. Thickening it would push
 *   coverage to ~4.5%, back within sight of the 7.03% plateau the roll existed to
 *   escape, and Task 3 moved this overlay to 1x1 for exactly that reason ("a
 *   block would merge scattered rocks into a blob").
 *
 * So the asymmetry is not an oversight: the same 1x1 mark is invisible on one
 * palette and correct on the other.
 */
export const NAUVIS_ROCK_MARK_RADIUS_PX = 1;
/** See {@link NAUVIS_ROCK_MARK_RADIUS_PX} - Vulcanus keeps the single pixel. */
export const VULCANUS_ROCK_MARK_RADIUS_PX = 0;

/**
 * The tile stride at which the rock probability field is evaluated. **Every tile
 * still rolls** - only the field lookup is snapped, so this degrades *where*
 * rocks land, never *how many*, and the Task 4 density oracle stays valid.
 *
 * `1` means "evaluate per tile", i.e. no approximation at all, and that is what
 * ships. See {@link latticeSnapped} for why, and
 * `docs/noise/placement-roll-NOTES.md` for the measurement: a lattice buys back
 * far too little of the render cost to be worth degrading placement for, because
 * rocks are only about a quarter of the overlay budget on Vulcanus and the field
 * is already memoised along the render's own sweep.
 */
export const ROCK_FIELD_LATTICE = 1;

/**
 * Wrap a field so it is only ever evaluated on a `stride`-tile lattice, with each
 * tile reading its lattice cell's value. `stride <= 1` returns the field
 * untouched, so the no-approximation case costs nothing - not even a closure.
 *
 * `Math.floor` (not truncation) so the lattice is uniform across the origin;
 * `-1 / 4` must land in the cell at `-4`, not the one at `0`, or the cell
 * straddling the axis would be half-width and the density would not be
 * translation-invariant.
 */
export function latticeSnapped(
  field: (x: number, y: number) => number,
  stride: number,
): (x: number, y: number) => number {
  if (stride <= 1) return field;
  return (x, y) => field(Math.floor(x / stride) * stride, Math.floor(y / stride) * stride);
}

export type RockControls = {
  frequency: number;
  size: number;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * `range_select_base` (core/prototypes/noise-functions.lua): selects a from-to
 * range, 0 or above inside it, descending outside when `min` < 0.
 *   clamp(min(input - from, to - input) / slope, min, max)
 */
export function rangeSelectBase(
  input: number,
  from: number,
  to: number,
  slope: number,
  min: number,
  max: number,
): number {
  return clamp(Math.min(input - from, to - input) / slope, min, max);
}
