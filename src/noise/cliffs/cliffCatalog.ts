/**
 * Cliff catalog: wire/gameplay constants and the pure slider/lever math the
 * game's map-gen GUI uses for the Cliffs autoplace control (frequency ->
 * elevation interval, continuity/richness -> cliff richness).
 *
 * See docs/superpowers/sdd/ for the cliffs design spec and RE notes. Also holds
 * `isCliffPlaced`, the per-cell placement predicate extracted from the game's
 * `CellCliffCrossing::toMaybeCliffOrientation`.
 */

/** Wire name of the Nauvis cliff autoplace control. */
export const CLIFF_CONTROL_NAME = "nauvis_cliff";

/** In-game map_color for cliff tiles. */
export const CLIFF_MAP_COLOR: readonly [number, number, number] = [144, 119, 87];

/** Cliff placement grid cell size, in tiles. */
export const CLIFF_GRID_SIZE = 4;

/**
 * Side, in pixels, of the block painted per placed cliff cell, anchored so it
 * covers the cell's OWN footprint: pixels `px - SIDE/2 .. px + SIDE/2 - 1` from
 * the cell centre, which at 1 tile/px is exactly the `CLIFF_GRID_SIZE` world
 * tiles the cell spans.
 *
 * Cliffs sit on a sparse 4-tile grid, so one pixel per cell reads as a faint
 * stipple that blends into the terrain, and the block exists to make the
 * ridgelines legible while keeping the faithful `CLIFF_MAP_COLOR`.
 *
 * **4 is the size at which cells abut exactly** at the app's 1024px /
 * 1-tile-per-pixel preview: centres are 4px apart, so 4px blocks tile with
 * neither gap nor overlap. This replaced a 5x5 centred block (radius 2), which
 * overlapped its neighbour by a pixel and read a pixel too thick - Eric,
 * 2026-07-27, on the deployed preview. The overlap was not doing any work: it is
 * the *tiling*, not the excess, that joins the stipple into a line.
 *
 * **Do not drop this to 3.** Measured, not assumed: at 3px the blocks fall a
 * pixel short of their neighbour and the ridgelines break into visible dashes.
 * 4 is the floor, not a preference.
 *
 * This is deliberately in PIXEL space rather than world space. A world-space
 * footprint would be more faithful at 1 tile/px and would vanish when zoomed out,
 * where a cell is a fraction of a pixel; the whole point of the block is
 * legibility at preview scale.
 */
export const CLIFF_MARK_SIZE_PX = 4;

/**
 * How far the block extends BELOW/LEFT of the cell centre pixel. The block spans
 * `px - CLIFF_MARK_BACK_PX .. px + CLIFF_MARK_SIZE_PX - CLIFF_MARK_BACK_PX - 1`,
 * and this offset is what aligns it with the cell's footprint rather than
 * hanging off one corner: a cell centred at world `cx*4 + 2` spans `[cx*4,
 * cx*4+4)`, i.e. 2 tiles back and 1 forward from its centre pixel.
 *
 * Also the halo the tiled renderer must widen its cell enumeration by
 * (`cliffCellQueryBox`), since it is the larger of the two directions.
 */
export const CLIFF_MARK_BACK_PX = 2;

/** X coordinate of a cliff cell's center, in cell-local tiles. */
export const CLIFF_CELL_CENTER_X = 2;

/** Y coordinate of a cliff cell's center, in cell-local tiles. */
export const CLIFF_CELL_CENTER_Y = 2.5;

/** Default `cliff_elevation_0` map-gen setting (elevation of the first cliff band). */
export const CLIFF_ELEVATION_0_DEFAULT = 10;

/** Default `cliff_elevation_interval` map-gen setting, before the frequency lever. */
export const CLIFF_ELEVATION_INTERVAL_DEFAULT = 40;

/** seed1 for the low-frequency cliffiness basis noise. */
export const LOW_FREQ_CLIFFINESS_SEED1 = 86883;

/** Y offset applied to a cliff cell corner. */
export const CLIFF_CORNER_OFFSET_Y = 0.5;

/** The `nauvis_cliff` autoplace control's frequency/size sliders (size doubles as continuity). */
export interface CliffControls {
  frequency: number;
  continuity: number;
}

/** The cliff-related MapGenSettings fields that feed the lever math. */
export interface CliffSettingsInput {
  cliffElevation0: number;
  cliffElevationInterval: number;
  richness: number;
}

/**
 * Maps a geometric slider value (1/6..6, with 1 = 100%/midpoint) to a linear
 * value in `[lo, hi]`. Mirrors the game's `slider_to_linear` GUI helper.
 */
export function sliderToLinear(v: number, lo: number, hi: number): number {
  return lo + 0.5 * (hi - lo) * (1 + Math.log2(v) / Math.log2(6));
}

/** Higher frequency -> tighter (smaller) elevation bands between cliff lines. */
export function getModifiedElevationInterval(baseInterval: number, frequency: number): number {
  return baseInterval / frequency;
}

/** Continuity scales cliff richness directly; 0 disables cliffs entirely. */
export function getModifiedRichness(baseRichness: number, continuity: number): number {
  return baseRichness * continuity;
}

/**
 * Cell codes that place a cliff, i.e. codes for which the game's
 * `CellCliffCrossing::toMaybeCliffOrientation` returns a real `CliffOrientation`
 * (not "none"). Ground truth extracted from the Factorio arm64 binary
 * (`CellCliffCrossing::toMaybeCliffOrientation` @ VA `0x1016067a0`).
 *
 * A cell `code` is the 8-bit `(enc(L)<<6)|(enc(R)<<4)|(enc(T)<<2)|enc(B)` where
 * each 2-bit field encodes an edge crossing (0 -> 0, +1 -> 1, -1 -> 3).
 *
 * Extraction (arm64 slice of the universal binary):
 *   - The function loads `code = *this`, then dispatches in three ranges:
 *       * `code <= 0x50`: an indexed jump via a 81-byte `__TEXT.__const` table
 *         @ VA `0x102cf614c` (`byteIndex[code]`; branch target =
 *         `0x1016067d0 + byteIndex*4`).
 *       * `0x51 <= code <= 0xbf`: falls through to the "none" block.
 *       * `0xc0 <= code <= 0xff`: explicit compares; only 0xc0, 0xc1, 0xcc, 0xf0
 *         reach an orientation block.
 *   - Every real-orientation block returns with the low 32-bit word = 2
 *     (`mov w9, #0x2`); the "none" sentinel block @ `0x101606934` returns low
 *     word = 1 (`mov w9, #0x1`), and `code == 0` returns 0 via `0x10160693c`.
 *     So "placing" == "target block sets w9 to 2" == "not a none block".
 *   - Evaluating all 256 codes yields exactly these 20 placing codes (single
 *     edges, straight walls e.g. 5 = T+1/B+1 and 80 = L+1/R+1, and corners).
 * See docs/noise/cliffs-NOTES.md for the mangled-name/disasm recipe.
 */
const CLIFF_PLACING_CODES: readonly number[] = [
  1, 3, 4, 5, 12, 15, 16, 17, 28, 48, 51, 52, 64, 67, 68, 80, 192, 193, 204, 240,
];

/**
 * 256-entry boolean lookup: `CLIFF_PLACED_TABLE[code]` is true iff that cell code
 * places a cliff. Materialized from `CLIFF_PLACING_CODES` (see above for the
 * binary extraction @ `0x1016067a0`).
 */
const CLIFF_PLACED_TABLE: readonly boolean[] = (() => {
  const table: boolean[] = Array.from({ length: 256 }, () => false);
  for (const code of CLIFF_PLACING_CODES) table[code] = true;
  return table;
})();

/**
 * True iff cell `code` places a cliff (its `toMaybeCliffOrientation` maps to a
 * real orientation, not "none"). Codes outside `[0, 255]` guard to `false`.
 */
export function isCliffPlaced(code: number): boolean {
  if (!Number.isInteger(code) || code < 0 || code > 255) return false;
  return CLIFF_PLACED_TABLE[code];
}
