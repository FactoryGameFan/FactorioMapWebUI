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

/**
 * Cliff cell centre, in cell-local tiles: `grid_size/2 + grid_offset`.
 *
 * **`grid_offset` belongs HERE, on the centre, and nowhere else.** The
 * prototype's `grid_offset` is `{0, 0.5}` for `scale == 1` (both `cliff` and
 * `cliff-vulcanus`), and `base/prototypes/entity/entity-util.lua:305` says what
 * it is for in as many words: "cliffs are auto-placed with centers at (0, 0.5)
 * offset from the grid". So `x = 4/2 + 0 = 2` and `y = 4/2 + 0.5 = 2.5`, which
 * is why every dumped cliff satisfies `x mod 4 == 2`, `y mod 4 == 2.5`.
 *
 * The FIELDS are sampled at the bare lattice `(i*4, j*4)` - no offset. This was
 * wrong here until 2026-07-30: a `CLIFF_CORNER_OFFSET_Y = 0.5` added the centre
 * offset to the sample position too, displacing every field read half a tile in
 * y. It was invisible because it does not move a single placed cliff - the
 * centre constants below are independent - so the mod-4 checks, the preview
 * agreement and the PR #57 field substitution all passed. Confirmed against the
 * binary (`CliffGenerator::crossingsForChunk` reads `grid_size` at
 * `[proto+0xb60]`/`[0xb68]` and never `grid_offset` at `[0xb70]`/`[0xb78]`;
 * sample origin is `chunkPos << 5` converted to float) and by re-capturing the
 * oracle at the correct lattice: Vulcanus recall 0.8701 -> 0.9379, FP 301 ->
 * 235 at `[1500,1500]`.
 */
export const CLIFF_CELL_CENTER_X = 2;

/** @see CLIFF_CELL_CENTER_X - carries the prototype's `grid_offset.y` of 0.5. */
export const CLIFF_CELL_CENTER_Y = 2.5;

/** Default `cliff_elevation_0` map-gen setting (elevation of the first cliff band). */
export const CLIFF_ELEVATION_0_DEFAULT = 10;

/** Default `cliff_elevation_interval` map-gen setting, before the frequency lever. */
export const CLIFF_ELEVATION_INTERVAL_DEFAULT = 40;

/** seed1 for the low-frequency cliffiness basis noise. */
export const LOW_FREQ_CLIFFINESS_SEED1 = 86883;

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

// `sliderToLinear` USED TO LIVE HERE, computed entirely in f64. #324 deleted
// it rather than fixing it: `src/noise/eval/math.ts` exports the one graded
// implementation, and this copy had no production consumer left after #227
// removed `cliffFields.ts`. `scripts/probes/cliff-slider-to-linear` scored the
// f64 form at 5 of 39 against the game, failing a control at `s = 6`.

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
 * (`CellCliffCrossing::toMaybeCliffOrientation`).
 *
 * **The VA moved.** This block cited `0x1016067a0` from the build it was
 * extracted against; under 2.1.12 the symbol is at `0x10160c3ac`, which is where
 * `CLIFF_CODE_TO_ORIENTATION` below was read. Re-derive the address from `nm`
 * rather than trusting either number - the dispatch structure described here is
 * unchanged, only its address moved.
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

/**
 * The 20 `CliffOrientation` enum values, in enum order - so the index into this
 * array **is** the id the engine uses.
 *
 * Read out of the arm64 slice: `CliffOrientationName::buildMapping`
 * (`0x1007aaec0`) registers name/value pairs in ascending value order, and its
 * name string table is contiguous at `0x102f615f4`. The per-entry string lengths
 * the function loads (12, 14, 12, 14, 13, ...) match these names, which is the
 * check that the table was read in the right order rather than assumed.
 */
export const CLIFF_ORIENTATION_NAMES: readonly string[] = [
  "west-to-east",
  "north-to-south",
  "east-to-west",
  "south-to-north",
  "west-to-north",
  "north-to-east",
  "east-to-south",
  "south-to-west",
  "west-to-south",
  "north-to-west",
  "east-to-north",
  "south-to-east",
  "west-to-none",
  "none-to-east",
  "east-to-none",
  "none-to-west",
  "north-to-none",
  "none-to-south",
  "south-to-none",
  "none-to-north",
];

/**
 * Cell code -> `CliffOrientation` id, the FULL result of
 * `CellCliffCrossing::toMaybeCliffOrientation` rather than the boolean
 * `isCliffPlaced` keeps.
 *
 * The function returns one 64-bit word: the **low** 32 bits are a tri-state
 * (2 = a real orientation, 1 = "none", 0 = the empty cell), and the **high** 32
 * bits are the orientation id. `CLIFF_PLACING_CODES` was extracted from the low
 * word alone, which is why the id was never recorded until 2026-07-30.
 *
 * Extraction, 2.1.12 arm64 slice, body at `0x10160c3ac`:
 *   - `code <= 0x50` dispatches through an 81-byte index table at `0x102d000c4`
 *     (branch target = `0x10160c3dc + index*4`); each landing block is
 *     `mov x8, <id << 32>` / `mov w9, #2` / `orr x0, x9, x8` / `ret`.
 *   - `0x51..0xbf` all fall into the "none" block.
 *   - `0xc0`, `0xc1`, `0xcc`, `0xf0` are explicit compares.
 *
 * The result is a **bijection**: the 20 placing codes map onto the 20
 * orientations one-for-one, with no id used twice and none unused.
 * `test/cliffOrientation.spec.ts` asserts that rather than trusting it.
 *
 * Not yet consumed by the placement pass - see
 * `CLIFF_ORIENTATION_COLLISION_BOX` for what it is for.
 */
export const CLIFF_CODE_TO_ORIENTATION: Readonly<Record<number, number>> = {
  1: 17,
  3: 18,
  4: 16,
  5: 1,
  12: 19,
  15: 3,
  16: 14,
  17: 6,
  28: 10,
  48: 13,
  51: 11,
  52: 5,
  64: 15,
  67: 7,
  68: 9,
  80: 2,
  192: 12,
  193: 8,
  204: 4,
  240: 0,
};

/** An axis-aligned box in cell-centre-relative tiles: `[left, top, right, bottom]`. */
export type CliffCollisionBox = readonly [number, number, number, number];

/**
 * `rotbb(x, y, size, intersect)` as the ENGINE reads it back
 * (`base/prototypes/entity/entity-util.lua:9`).
 *
 * `rotbb` builds a rectangle centred at `(x + size/2, y + size/2)` with
 * half-extents `((1 - intersect/size) * d, (intersect/size) * d)` where
 * `d = size/2 * sqrt(2)`, and tags it with an orientation of **1/8**.
 *
 * **The 1/8 tag is DISCARDED for collision, so this returns the raw rectangle.**
 * Established by disassembly 2026-08-02, three steps deep:
 *
 * 1. `EntityMapGenerationTask::tryToAddCliff` (`0x101625038`) loads the
 *    orientation's box from `proto + 0x5c0 + id*0x48`, copies 20 bytes (four
 *    `int32` edges at `+4` plus the orientation word at `+0x14`), and calls
 *    `wouldCollide` with **`Direction = 0`** (`mov x4, #0x0`).
 * 2. `EntityMapGenerationTask::wouldCollide` (`0x101625468`) forwards that box
 *    and direction to `BoundingBox::BoundingBox(BoundingBox const&, Direction)`
 *    (`0x101c04380`).
 * 3. That constructor zeroes the destination, writes the sentinel `0x80010000`
 *    into the destination's orientation word, and dispatches on the direction
 *    through a jump table whose **entry 0 is 0** - the identity arm, which
 *    copies `left_top`/`right_bottom` verbatim and returns. The source box's own
 *    orientation is never read; the rotation arm below it is reached only for a
 *    non-zero `Direction`.
 *
 * So the collision rectangle is the stored rectangle, axis-aligned, and the
 * tile scan floors it with `(box + position) >> 8` over an inclusive rect.
 *
 * **Two shapes were shipped here before this and both were wrong.** The AABB
 * `[x, x+size] x [y, y+size]` (until #88) is too big at the corners; a 45-degree
 * separating-axis test (#88) is too SMALL, and scored better than the truth
 * because it also absorbed the unrelated orientation residual. See
 * `test/cliffCollisionBox.spec.ts`.
 *
 * Edges are quantised to 1/256 because `MapPosition` is 8-bit fixed point, so
 * `x_dist`'s `sqrt(2)` cannot survive into the engine at full precision.
 */
function rotbbBox(x: number, y: number, size: number, intersect: number): CliffCollisionBox {
  const dist = (size / 2) * SQRT2;
  const yRatio = intersect / size;
  const xDist = (1 - yRatio) * dist;
  const yDist = yRatio * dist;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const q = (v: number): number => Math.round(v * 256) / 256;
  return [q(cx - xDist), q(cy - yDist), q(cx + xDist), q(cy + yDist)];
}

/** The four straight orientations, written as plain boxes in the Lua. */
const CLIFF_STRAIGHT_COLLISION_BOX: readonly CliffCollisionBox[] = [
  [-2.0, -1.5, 2.0, 1.5], //  0 west-to-east
  [-1.0, -2.0, 1.0, 2.0], //  1 north-to-south
  [-2.0, -0.5, 2.0, 0.5], //  2 east-to-west
  [-1.0, -2.0, 1.0, 2.0], //  3 south-to-north
];

/**
 * `rotbb(x, y, size, intersect)`'s four arguments per orientation id, verbatim
 * from `create_cliff_data_specification` (`entity-util.lua:85`), or `null` for
 * the four straight orientations. Verified identical to the Lua, in order.
 */
export const CLIFF_ORIENTATION_ROTBB: readonly (
  | readonly [number, number, number, number]
  | null
)[] = [
  null, //  0 west-to-east
  null, //  1 north-to-south
  null, //  2 east-to-west
  null, //  3 south-to-north
  [-3.5, -3, 4.5, 3], //  4 west-to-north
  [-1, -3, 4.5, 1.5], //  5 north-to-east
  [-1, -0.5, 3.5, 2.5], //  6 east-to-south
  [-2.5, -0.5, 3.5, 1], //  7 south-to-west
  [-3.5, -1.5, 4.5, 1.5], //  8 west-to-south
  [-2.5, -3, 3.5, 2.5], //  9 north-to-west
  [-1, -3, 3.5, 1], // 10 east-to-north
  [-1, -1.5, 4.5, 3], // 11 south-to-east
  [-3, -1.5, 3, 2], // 12 west-to-none
  [0, -1.5, 3, 1], // 13 none-to-east
  [0, -0.5, 2.5, 2], // 14 east-to-none
  [-2.5, -0.5, 2.51, 0.5], // 15 none-to-west
  [-1, -2.5, 3, 1], // 16 north-to-none
  [-1, -0.5, 3, 2.5], // 17 none-to-south
  [-2, -0.5, 3, 0.5], // 18 south-to-none
  [-2, -2.5, 3, 2], // 19 none-to-north
];

const SQRT2 = 1.4142135623730951;

/**
 * `CliffOrientation` id -> the orientation's `collision_bounding_box`, at
 * `scale = 1.0` (both `cliff` and `cliff-vulcanus`), relative to the cliff's
 * centre. Transcribed from `create_cliff_data_specification`
 * (`base/prototypes/entity/entity-util.lua:85`), which is the table the engine
 * loads into `proto + 0x5c0 + id * 0x48`.
 *
 * **What this is for.** `EntityMapGenerationTask::tryToAddCliff`
 * (`0x101625038`) switches on the orientation, reads that entry's box, and
 * calls `EntityMapGenerationTask::wouldCollide(BoundingBox const&,
 * CollisionMask const&, MapPosition, Direction)` (`0x101625468`) with the
 * prototype's collision mask (`proto + 0x2b0`). On a hit it returns false and
 * **the cliff is never recorded** - a rejection this port does not yet run.
 *
 * `wouldCollide` turns the box into tiles with `(box + position) >> 8`
 * (`MapPosition` is 8-bit fixed point, so an arithmetic floor) and scans the
 * INCLUSIVE tile rectangle `[left..right] x [top..bottom]` against a 96x96
 * per-tile mask grid, ANDing each tile's `CollisionMask` with the entity's. It
 * reads tiles only - `tryToAddCliff` never writes that grid - so the rejection
 * has no placement-order dependence.
 *
 * On Vulcanus the only tiles carrying a layer the cliff mask holds
 * (`water_tile`) are `lava` and `lava-hot`. Measured 2026-07-30 against
 * `oracle-vulcanus-cliff-entities.seed123456` with these boxes, region
 * `[1500,1500]` goes from 1065 predicted / 885 real (ratio 1.203, precision
 * 0.779) to 888 predicted (ratio **1.003**, precision **0.930**), rejecting 173
 * false positives and only 4 true ones. See issue #18.
 */
export const CLIFF_ORIENTATION_COLLISION_BOX: readonly CliffCollisionBox[] =
  CLIFF_ORIENTATION_ROTBB.map((spec, id) =>
    spec === null ? CLIFF_STRAIGHT_COLLISION_BOX[id] : rotbbBox(...spec),
  );

/**
 * The `CliffOrientation` id a cell code places, or `undefined` when the code
 * places nothing. Agrees with {@link isCliffPlaced} by construction.
 */
export function cliffOrientationForCode(code: number): number | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 255) return undefined;
  return CLIFF_CODE_TO_ORIENTATION[code];
}

/** An inclusive tile-index rectangle: every tile in it is tested for collision. */
export interface CliffTileBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The tile rectangle `EntityMapGenerationTask::wouldCollide` scans for a cliff
 * of cell `code` centred at `(centerX, centerY)`.
 *
 * Both ends are **inclusive** and both come from a **floor**, because the engine
 * works in `MapPosition`'s 8-bit fixed point and takes `(box + position) >> 8` -
 * an arithmetic shift, so a box edge landing exactly on a tile boundary still
 * pulls that tile in. Reproducing the off-by-one exactly matters: the straight
 * orientations' boxes are 4 tiles wide and land on integers, so an exclusive
 * right edge would test a 4-wide span where the game tests 5.
 */
export function cliffCollisionTileBox(
  code: number,
  centerX: number,
  centerY: number,
): CliffTileBox | undefined {
  const orientation = cliffOrientationForCode(code);
  if (orientation === undefined) return undefined;
  const [l, t, r, b] = CLIFF_ORIENTATION_COLLISION_BOX[orientation];
  return {
    left: Math.floor(centerX + l),
    top: Math.floor(centerY + t),
    right: Math.floor(centerX + r),
    bottom: Math.floor(centerY + b),
  };
}

/**
 * The Vulcanus tiles whose `CollisionMask` shares a layer with the cliff's, so a
 * cliff whose collision box touches one is never placed.
 *
 * `tile_collision_masks.lava()` sets `water_tile = true` and the cliff mask
 * holds `water_tile`; no other Vulcanus tile does. Notably
 * `volcanic-jagged-ground` - the tile the ore patches paint, which the Lua
 * itself labels "CLIFF TILE" - is `tile_collision_masks.ground()`, which the
 * cliff mask does not touch, so ore does NOT exclude cliffs. That distinction is
 * the whole reason the earlier ore-separation work correctly found no exclusion
 * rule while this one exists.
 *
 * Lives here rather than beside the Vulcanus renderer because that renderer is
 * deleted by #227 and this rule is not.
 *
 * **This is the only definition on the TypeScript side, and the Rust side's only
 * definition is `VulcanusTile::is_cliff_blocking` in
 * `crates/fmw-noise/src/tiles/vulcanus_catalog.rs`.** The two are held together
 * by `test/wasmVulcanusParity.spec.ts`, which hashes this set and compares it
 * against the module's `vulcanus_cliff_blocking_names_fnv1a64()`. Before #364
 * the set was written out four times with nothing checking the four agreed.
 */
export const VULCANUS_CLIFF_BLOCKING_TILES: ReadonlySet<string> = new Set(["lava", "lava-hot"]);
