// Constants and pure helpers for the Nauvis rocks overlay, transcribed from
// factorio-data @ 2.1.11 (base/prototypes/decorative/decoratives.lua and
// base/prototypes/noise-expressions.lua). All three charted rock prototypes
// (huge-rock, big-rock, big-sand-rock) share this map_color.
import { sliderRescale } from "../eval/math";

// Re-exported for existing callers/tests (`sliderRescale` used to be defined
// here). The implementation lives in `../eval/math` beside the other DSL
// operations, so non-rocks callers can use it without a `rocks/`-flavored
// import.
//
// It moved here from `../eval/sliderRescale`, which held a SECOND, different
// implementation - the whole chain in f64, rounded once at the end. The oracle
// says that one is not the game's: it misses two of the seven probe positions
// the per-operation form matches (#270). Re-export, never re-implement;
// `test/sliderRescale.spec.ts` asserts this is the same function object.
export { sliderRescale };

export const ROCK_SEED1 = 137;
export const ROCK_MAP_COLOR: readonly [number, number, number] = [129, 105, 78];

/**
 * Radius, in pixels, of the mark painted per placed rock - `(2r+1)^2`, so `0` is
 * a single pixel. **Both planets use 1 (a 3x3 mark).**
 *
 * The placement roll made rocks sparse - 0.080% of Nauvis ground and 0.504% of
 * Vulcanus over `[-512, 512)^2` - and a 1x1 mark on top of that is far too little
 * ink on both. Nauvis was fixed first, on sight: `ROCK_MAP_COLOR` (129, 105, 78)
 * is within a few units of the dirt it usually sits on, so the overlay was simply
 * invisible (Eric, 2026-07-27: "can't see the rocks anymore").
 *
 * **Vulcanus was left at 1x1 in that same pass, and that was wrong.** The
 * argument was that 3x3 would take coverage to ~4.5%, "back within sight of the
 * 7.03% plateau the roll existed to escape". Comparing against the game's OWN
 * `--generate-map-preview` output settles it (2026-07-28, issue #22 item 6):
 *
 * | overlay | game | ours at 1x1 | ours at 3x3 |
 * | --- | --- | --- | --- |
 * | Vulcanus rocks | **5.17%** | 0.37% (0.07x) | 3.33% (0.65x) |
 *
 * The game covers a *twentieth of Vulcanus* in rock colour, because it paints
 * each rock's real footprint (~3 x 2.2 tiles) rather than a dot. A 1x1 mark was
 * **14x too little**; 3x3 is 0.65x and the closest an odd-sided mark gets (5x5
 * would overshoot to ~1.8x).
 *
 * The flaw in the old reasoning is worth keeping: the 7.03% threshold plateau was
 * wrong in its **contiguity**, not its area. It painted rocky *ground*; the game
 * really does put that much rock down, just scattered. Judging a coverage number
 * against a figure whose problem was its shape is how the wrong conclusion got
 * drawn - and no amount of entity-count validation could have caught it, because
 * placement density was already correct to 0.2-7.5%. Only the rendered image
 * shows it.
 */
export const NAUVIS_ROCK_MARK_RADIUS_PX = 1;
/** See {@link NAUVIS_ROCK_MARK_RADIUS_PX} - the planets agree. */
export const VULCANUS_ROCK_MARK_RADIUS_PX = 1;

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
