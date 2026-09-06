//! Cliff catalog: the engine-level tables the placement pass keys on, ported
//! from `src/noise/cliffs/cliffCatalog.ts`.
//!
//! Most of it is `CliffGenerator` / `CellCliffCrossing` behaviour rather than
//! planet behaviour, so it is shared by every planet that places cliffs.
//! Vulcanus has no cliff autoplace control at all.
//!
//! Part of the Nauvis lever math that shares the TypeScript file arrived with
//! #226 and lives here too: [`modified_elevation_interval`] and
//! [`modified_richness`]. The slider narrowing does NOT, and the round trip is
//! worth reading twice. This module doc once said that block was deliberately
//! absent because "`slider_to_linear` already lives in [`crate::eval::math`]";
//! #226 judged that reasoning wrong and added a local f64 copy beside these
//! two. #324 then asked the game, and the ORIGINAL reasoning was right - the
//! copy scored 5 of 39 and is deleted. See the comment where it used to sit.
//!
//! ## What was read out of the binary, and where
//!
//! The TypeScript file carries the full disassembly recipe and the addresses;
//! this repeats only what a reader needs to judge the tables:
//!
//! - [`CLIFF_PLACING_CODES`] and [`CLIFF_CODE_TO_ORIENTATION`] are the low and
//!   high halves of the one 64-bit word `CellCliffCrossing::toMaybeCliffOrienta
//!   tion` returns. The mapping is a BIJECTION - 20 codes onto 20 orientations,
//!   none used twice and none unused - and [`tests::the_code_to_orientation_map
//!   _is_a_bijection`] asserts that rather than trusting it.
//! - [`CLIFF_ORIENTATION_NAMES`] came from `CliffOrientationName::buildMapping`,
//!   which registers name/value pairs in ascending value order, so the index
//!   into that array IS the id the engine uses. The connection tables in
//!   [`super::connections`] are derived from these names, which is what makes a
//!   transcription slip fail rather than shift the model.
//! - [`CLIFF_ORIENTATION_COLLISION_BOX`] is the table the engine loads into
//!   `proto + 0x5c0 + id * 0x48`, and `tryToAddCliff` hands it to `wouldCollide`
//!   with `Direction = 0` - the identity arm, which copies the rectangle
//!   verbatim and discards `rotbb`'s `1/8` orientation tag. So the collision
//!   shape is the RAW stored rectangle, not a rotated one.
//!
//! ## The boxes are literals here and computed in the TypeScript
//!
//! The TypeScript builds this table at module load by calling `rotbbBox`. This
//! port ships the 20 rectangles as constants and keeps [`rotbb_box`] live
//! beside them, with [`tests::the_rotbb_derivation_reproduces_every_shipped_box`]
//! asserting the two agree bit-for-bit.
//!
//! That is strictly stronger than either half alone, and it is not a style
//! choice: every edge is an exact multiple of `1/256`, because `MapPosition` is
//! 8-bit fixed point and `rotbb`'s `sqrt(2)` cannot survive into the engine at
//! full precision. Shipping the quantised values means the render path does no
//! floating-point rounding for the boxes at all, while the derivation stays
//! checkable against the Lua it came from.

/// Default `cliff_elevation_0` map-gen setting.
pub const CLIFF_ELEVATION_0_DEFAULT: f64 = 10.0;

/// Default `cliff_elevation_interval` map-gen setting, before the frequency
/// lever.
pub const CLIFF_ELEVATION_INTERVAL_DEFAULT: f64 = 40.0;

/// `basis_noise` `seed1` for `low_frequency_cliffiness`.
pub const LOW_FREQ_CLIFFINESS_SEED1: u32 = 86_883;

/// The `nauvis_cliff` autoplace control's two sliders.
///
/// `size` doubles as continuity in the game's own naming, which is why the
/// field is called `continuity` here and in the TypeScript.
#[derive(Clone, Copy, Debug)]
pub struct CliffControls {
    /// `control:nauvis_cliff:frequency`; 1 at the default.
    pub frequency: f64,
    /// `control:nauvis_cliff:size`; 1 at the default. 0 disables cliffs.
    pub continuity: f64,
}

impl CliffControls {
    /// Both sliders at 1.
    #[must_use]
    pub const fn defaults() -> Self {
        Self {
            frequency: 1.0,
            continuity: 1.0,
        }
    }
}

/// The cliff-related `MapGenSettings` fields that feed the lever math.
#[derive(Clone, Copy, Debug)]
pub struct CliffSettings {
    /// `cliff_elevation_0`.
    pub cliff_elevation_0: f64,
    /// `cliff_elevation_interval`, before the frequency lever.
    pub cliff_elevation_interval: f64,
    /// `richness`, before the continuity lever.
    pub richness: f64,
}

impl CliffSettings {
    /// The game's defaults: elevation 0 at 10, interval 40, richness 1.
    #[must_use]
    pub const fn defaults() -> Self {
        Self {
            cliff_elevation_0: CLIFF_ELEVATION_0_DEFAULT,
            cliff_elevation_interval: CLIFF_ELEVATION_INTERVAL_DEFAULT,
            richness: 1.0,
        }
    }
}

// `cliff_slider_to_linear` USED TO LIVE HERE, and #324 deleted it rather than
// fixing it in place.
//
// It was a second implementation of `slider_to_linear` computed entirely in f64
// and never rounded, mirroring `src/noise/cliffs/cliffCatalog.ts`. The port
// reproduced it deliberately, on the rule that a finding lands as its own graded
// change rather than as a unilateral fix on the Rust side.
//
// `scripts/probes/cliff-slider-to-linear` then asked the game directly, over
// three ranges and 13 sliders. The f64 form scored 5 of 39 and FAILED a control
// - at `s = 6` the ratio is exactly 1, so every implementation must return
// exactly `hi`, and it returned 1.7 where the game returns f32(1.7). The whole
// cliff lever now calls `crate::eval::math::slider_to_linear`, which scores
// 39 of 39. Do not reintroduce a local copy.

/// Higher frequency gives tighter (smaller) elevation bands between cliff
/// lines: `base_interval / frequency`.
#[must_use]
pub fn modified_elevation_interval(base_interval: f64, frequency: f64) -> f64 {
    base_interval / frequency
}

/// Continuity scales cliff richness directly; 0 disables cliffs entirely.
#[must_use]
pub fn modified_richness(base_richness: f64, continuity: f64) -> f64 {
    base_richness * continuity
}

/// Cliff placement grid cell size, in tiles.
pub const CLIFF_GRID_SIZE: f64 = 4.0;

/// Cliff cell centre x, in cell-local tiles: `grid_size/2 + grid_offset.x`.
///
/// **`grid_offset` belongs on the CENTRE and nowhere else.** The prototype's
/// `grid_offset` is `{0, 0.5}` for both `cliff` and `cliff-vulcanus`, and
/// `entity-util.lua:305` says what it is for in as many words: "cliffs are
/// auto-placed with centers at (0, 0.5) offset from the grid". The FIELDS are
/// sampled at the bare lattice `(i*4, j*4)` - `crossingsForChunk` reads
/// `grid_size` and never `grid_offset`. Adding it to the sample position too
/// was a real bug in the TypeScript until 2026-07-30, and it was invisible
/// because it moves no placed cliff.
pub const CLIFF_CELL_CENTER_X: f64 = 2.0;

/// Cliff cell centre y - carries the prototype's `grid_offset.y` of 0.5.
///
/// See [`CLIFF_CELL_CENTER_X`]. Every dumped cliff satisfies `x mod 4 == 2` and
/// `y mod 4 == 2.5`, which the oracle spec checks on the fixture itself.
pub const CLIFF_CELL_CENTER_Y: f64 = 2.5;

/// In-game `map_color` for cliff tiles.
///
/// `cliff-vulcanus` declares the same `{144, 119, 87}` Nauvis's `cliff` does, so
/// no second colour is needed.
pub const CLIFF_MAP_COLOR: [u8; 3] = [144, 119, 87];

/// Side, in pixels, of the block painted per placed cliff cell.
///
/// **4 is the size at which cells abut exactly** at the app's 1024px /
/// 1-tile-per-pixel preview: centres are 4px apart, so 4px blocks tile with
/// neither gap nor overlap. It replaced a 5x5 centred block, which overlapped
/// its neighbour by a pixel and read a pixel too thick - and the overlap was
/// doing no work, because it is the TILING, not the excess, that joins the
/// stipple into a line.
///
/// **Do not drop this to 3.** Measured: at 3px the blocks fall a pixel short of
/// their neighbour and the ridgelines break into visible dashes. 4 is the floor,
/// not a preference.
///
/// Deliberately in PIXEL space rather than world space. A world-space footprint
/// would be more faithful at 1 tile/px and would vanish when zoomed out, where a
/// cell is a fraction of a pixel; the whole point of the block is legibility at
/// preview scale.
pub const CLIFF_MARK_SIZE_PX: i64 = 4;

/// How far the block extends BELOW/LEFT of the cell centre pixel.
///
/// The block spans `px - CLIFF_MARK_BACK_PX ..= px + CLIFF_MARK_SIZE_PX -
/// CLIFF_MARK_BACK_PX - 1`, which aligns it with the cell's own footprint rather
/// than hanging it off one corner: a cell centred at world `cx*4 + 2` spans
/// `[cx*4, cx*4+4)`, i.e. 2 tiles back and 1 forward from its centre pixel.
///
/// Also the halo a tiled renderer must widen its cell enumeration by, since it
/// is the larger of the two directions - and the two directions CROSS, which is
/// why the caller sends the query box rather than the engine deriving it.
pub const CLIFF_MARK_BACK_PX: i64 = 2;

/// Cells (and corners) per chunk axis: a 32-tile chunk over the 4-tile grid.
pub const CHUNK_CELLS: usize = 8;

/// The 20 cell codes for which `toMaybeCliffOrientation` returns a real
/// orientation rather than "none".
///
/// A `code` is `(enc(L) << 6) | (enc(R) << 4) | (enc(T) << 2) | enc(B)`, where
/// each 2-bit field encodes one edge crossing: `0 -> 0`, `+1 -> 1`, `-1 -> 3`.
pub const CLIFF_PLACING_CODES: [u8; 20] = [
    1, 3, 4, 5, 12, 15, 16, 17, 28, 48, 51, 52, 64, 67, 68, 80, 192, 193, 204, 240,
];

/// True iff cell `code` places a cliff.
///
/// A `match` rather than a materialised 256-entry table: the codes are a
/// compile-time constant set, so this compiles to a jump table with no static
/// to keep in step with [`CLIFF_PLACING_CODES`].
#[inline]
#[must_use]
pub fn is_cliff_placed(code: u8) -> bool {
    cliff_orientation_for_code(code).is_some()
}

/// The 20 `CliffOrientation` enum values in enum order, so the index IS the id.
pub const CLIFF_ORIENTATION_NAMES: [&str; 20] = [
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

/// `(cell code, orientation id)` - the full result of
/// `toMaybeCliffOrientation`, whose high 32 bits carry the id the low word's
/// tri-state only says exists.
pub const CLIFF_CODE_TO_ORIENTATION: [(u8, u8); 20] = [
    (1, 17),
    (3, 18),
    (4, 16),
    (5, 1),
    (12, 19),
    (15, 3),
    (16, 14),
    (17, 6),
    (28, 10),
    (48, 13),
    (51, 11),
    (52, 5),
    (64, 15),
    (67, 7),
    (68, 9),
    (80, 2),
    (192, 12),
    (193, 8),
    (204, 4),
    (240, 0),
];

/// The `CliffOrientation` id cell `code` places, or `None` when it places
/// nothing. Agrees with [`is_cliff_placed`] by construction - that function is
/// defined in terms of this one.
#[inline]
#[must_use]
pub fn cliff_orientation_for_code(code: u8) -> Option<u8> {
    let mut i = 0;
    while i < CLIFF_CODE_TO_ORIENTATION.len() {
        let (c, id) = CLIFF_CODE_TO_ORIENTATION[i];
        if c == code {
            return Some(id);
        }
        i += 1;
    }
    None
}

/// A cell code that produces `orientation`. The mapping is a bijection, so this
/// is the exact inverse of [`cliff_orientation_for_code`].
#[must_use]
pub fn cliff_code_for_orientation(orientation: u8) -> Option<u8> {
    let mut i = 0;
    while i < CLIFF_CODE_TO_ORIENTATION.len() {
        let (c, id) = CLIFF_CODE_TO_ORIENTATION[i];
        if id == orientation {
            return Some(c);
        }
        i += 1;
    }
    None
}

/// An axis-aligned box in cell-centre-relative tiles: `[left, top, right, bottom]`.
pub type CliffCollisionBox = [f64; 4];

/// `CliffOrientation` id -> the orientation's `collision_bounding_box` at
/// `scale = 1.0`, relative to the cliff's centre.
///
/// Transcribed from `create_cliff_data_specification`
/// (`base/prototypes/entity/entity-util.lua:85`) by way of [`rotbb_box`], and
/// pinned bit-for-bit against the TypeScript's own computation. Every edge is a
/// multiple of `1/256` - see the module docs for why that is the format rather
/// than a coincidence.
pub const CLIFF_ORIENTATION_COLLISION_BOX: [CliffCollisionBox; 20] = [
    [-2.0, -1.5, 2.0, 1.5],                              //  0 west-to-east
    [-1.0, -2.0, 1.0, 2.0],                              //  1 north-to-south
    [-2.0, -0.5, 2.0, 0.5],                              //  2 east-to-west
    [-1.0, -2.0, 1.0, 2.0],                              //  3 south-to-north
    [-2.3125, -2.87109375, -0.1875, 1.37109375],         //  4 west-to-north
    [-0.87109375, -1.8125, 3.37109375, 0.3125],          //  5 north-to-east
    [0.04296875, -0.51953125, 1.45703125, 3.01953125],   //  6 east-to-south
    [-2.51953125, 0.54296875, 1.01953125, 1.95703125],   //  7 south-to-west
    [-3.37109375, -0.3125, 0.87109375, 1.8125],          //  8 west-to-south
    [-1.45703125, -3.01953125, -0.04296875, 0.51953125], //  9 north-to-west
    [-1.01953125, -1.95703125, 2.51953125, -0.54296875], // 10 east-to-north
    [0.1875, -1.37109375, 2.3125, 2.87109375],           // 11 south-to-east
    [-2.20703125, -1.4140625, -0.79296875, 1.4140625],   // 12 west-to-none
    [0.0859375, -0.70703125, 2.9140625, 0.70703125],     // 13 none-to-east
    [0.89453125, -0.6640625, 1.60546875, 2.1640625],     // 14 east-to-none
    [-2.66796875, 0.40234375, 0.17578125, 1.109375],     // 15 none-to-west
    [-0.9140625, -1.70703125, 1.9140625, -0.29296875],   // 16 north-to-none
    [0.14453125, -0.76953125, 0.85546875, 2.76953125],   // 17 none-to-south
    [-2.26953125, 0.64453125, 1.26953125, 1.35546875],   // 18 south-to-none
    [-1.20703125, -2.4140625, 0.20703125, 0.4140625],    // 19 none-to-north
];

/// The four straight orientations, written as plain boxes in the Lua rather
/// than through `rotbb`.
///
/// Public because it is half the derivation record, not an implementation
/// detail: [`CLIFF_ORIENTATION_COLLISION_BOX`]'s first four entries come from
/// here and its other sixteen from [`rotbb_box`], and a reader checking the
/// table against `create_cliff_data_specification` needs both halves.
pub const CLIFF_STRAIGHT_COLLISION_BOX: [CliffCollisionBox; 4] = [
    [-2.0, -1.5, 2.0, 1.5], // 0 west-to-east
    [-1.0, -2.0, 1.0, 2.0], // 1 north-to-south
    [-2.0, -0.5, 2.0, 0.5], // 2 east-to-west
    [-1.0, -2.0, 1.0, 2.0], // 3 south-to-north
];

/// `rotbb(x, y, size, intersect)`'s four arguments per orientation id, verbatim
/// from `create_cliff_data_specification`, or `None` for the four straight
/// orientations.
pub const CLIFF_ORIENTATION_ROTBB: [Option<[f64; 4]>; 20] = [
    None,                          //  0 west-to-east
    None,                          //  1 north-to-south
    None,                          //  2 east-to-west
    None,                          //  3 south-to-north
    Some([-3.5, -3.0, 4.5, 3.0]),  //  4 west-to-north
    Some([-1.0, -3.0, 4.5, 1.5]),  //  5 north-to-east
    Some([-1.0, -0.5, 3.5, 2.5]),  //  6 east-to-south
    Some([-2.5, -0.5, 3.5, 1.0]),  //  7 south-to-west
    Some([-3.5, -1.5, 4.5, 1.5]),  //  8 west-to-south
    Some([-2.5, -3.0, 3.5, 2.5]),  //  9 north-to-west
    Some([-1.0, -3.0, 3.5, 1.0]),  // 10 east-to-north
    Some([-1.0, -1.5, 4.5, 3.0]),  // 11 south-to-east
    Some([-3.0, -1.5, 3.0, 2.0]),  // 12 west-to-none
    Some([0.0, -1.5, 3.0, 1.0]),   // 13 none-to-east
    Some([0.0, -0.5, 2.5, 2.0]),   // 14 east-to-none
    Some([-2.5, -0.5, 2.51, 0.5]), // 15 none-to-west
    Some([-1.0, -2.5, 3.0, 1.0]),  // 16 north-to-none
    Some([-1.0, -0.5, 3.0, 2.5]),  // 17 none-to-south
    Some([-2.0, -0.5, 3.0, 0.5]),  // 18 south-to-none
    Some([-2.0, -2.5, 3.0, 2.0]),  // 19 none-to-north
];

/// `Math.sqrt(2)`, which `std::f64::consts::SQRT_2` is bit-for-bit.
///
/// Aliased rather than used inline so the identity has somewhere to be asserted:
/// [`rotbb_box`] must evaluate the same arithmetic the TypeScript does, and the
/// TypeScript writes the literal `1.4142135623730951`. Both are the correctly
/// rounded binary64 value, and
/// [`tests::the_square_root_constant_is_the_one_the_typescript_writes`] pins it.
const SQRT2: f64 = std::f64::consts::SQRT_2;

/// `Math.round`, which is NOT `f64::round`.
///
/// JavaScript rounds a half UP (toward `+inf`), so `Math.round(-0.5)` is `-0`;
/// Rust rounds a half AWAY FROM ZERO, so `(-0.5f64).round()` is `-1`.
///
/// Every edge below is far from a half in practice - `rotbb`'s `sqrt(2)` sees
/// to that - but "in practice" is not a reason to write the other function, and
/// [`tests::the_rounding_is_javascripts_and_not_rusts`] plants the case that
/// separates them.
#[inline]
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// `rotbb(x, y, size, intersect)` as the ENGINE reads it back
/// (`entity-util.lua:9`), returning the RAW rectangle.
///
/// `rotbb` builds a rectangle centred at `(x + size/2, y + size/2)` with
/// half-extents `((1 - intersect/size) * d, (intersect/size) * d)` where
/// `d = size/2 * sqrt(2)`, and tags it with an orientation of `1/8`. **The tag
/// is discarded for collision** - three steps of disassembly establish it, and
/// the module docs name them - so this returns the rectangle unrotated.
///
/// Two wrong shapes shipped in the TypeScript before this one, and the more
/// accurate-looking of them was the wrong one: a 45-degree separating-axis test
/// scored better on every metric because it also absorbed an unrelated
/// orientation defect. See `test/cliffCollisionBox.spec.ts`.
///
/// Edges are quantised to `1/256` because `MapPosition` is 8-bit fixed point.
#[must_use]
pub fn rotbb_box(x: f64, y: f64, size: f64, intersect: f64) -> CliffCollisionBox {
    let dist = (size / 2.0) * SQRT2;
    let y_ratio = intersect / size;
    let x_dist = (1.0 - y_ratio) * dist;
    let y_dist = y_ratio * dist;
    let cx = x + size / 2.0;
    let cy = y + size / 2.0;
    let q = |v: f64| js_round(v * 256.0) / 256.0;
    [
        q(cx - x_dist),
        q(cy - y_dist),
        q(cx + x_dist),
        q(cy + y_dist),
    ]
}

/// An inclusive tile-index rectangle: every tile in it is tested for collision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CliffTileBox {
    pub left: i64,
    pub top: i64,
    pub right: i64,
    pub bottom: i64,
}

/// The tile rectangle `EntityMapGenerationTask::wouldCollide` scans for a cliff
/// of cell `code` centred at `(center_x, center_y)`.
///
/// Both ends are **inclusive** and both come from a **floor**, because the
/// engine works in `MapPosition`'s 8-bit fixed point and takes
/// `(box + position) >> 8` - an arithmetic shift, so a box edge landing exactly
/// on a tile boundary still pulls that tile in. The straight orientations' boxes
/// are 4 tiles wide and land on integers, so an exclusive right edge would test
/// a 4-wide span where the game tests 5.
#[must_use]
pub fn cliff_collision_tile_box(code: u8, center_x: f64, center_y: f64) -> Option<CliffTileBox> {
    let orientation = cliff_orientation_for_code(code)?;
    let [l, t, r, b] = CLIFF_ORIENTATION_COLLISION_BOX[orientation as usize];
    Some(CliffTileBox {
        left: (center_x + l).floor() as i64,
        top: (center_y + t).floor() as i64,
        right: (center_x + r).floor() as i64,
        bottom: (center_y + b).floor() as i64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_placing_codes_and_the_orientation_map_describe_the_same_set() {
        for code in 0..=255u8 {
            assert_eq!(
                CLIFF_PLACING_CODES.contains(&code),
                is_cliff_placed(code),
                "code {code} disagrees between the two tables"
            );
        }
    }

    /// The 20 placing codes map onto the 20 orientations one-for-one, with no id
    /// used twice and none unused. Asserted rather than trusted - it is what
    /// lets [`cliff_code_for_orientation`] exist at all.
    #[test]
    fn the_code_to_orientation_map_is_a_bijection() {
        let mut seen = [false; 20];
        for (code, id) in CLIFF_CODE_TO_ORIENTATION {
            assert!(
                is_cliff_placed(code),
                "code {code} maps to an id but places nothing"
            );
            assert!(!seen[id as usize], "orientation {id} is used twice");
            seen[id as usize] = true;
            assert_eq!(cliff_code_for_orientation(id), Some(code));
        }
        assert!(
            seen.iter().all(|s| *s),
            "an orientation id is never produced"
        );
    }

    /// The shipped literal table against the `rotbb` derivation it came from.
    /// A transcription slip in either fails here rather than moving a cliff.
    #[test]
    fn the_rotbb_derivation_reproduces_every_shipped_box() {
        for (id, want) in CLIFF_ORIENTATION_COLLISION_BOX.iter().enumerate() {
            let got = match CLIFF_ORIENTATION_ROTBB[id] {
                None => CLIFF_STRAIGHT_COLLISION_BOX[id],
                Some([x, y, size, intersect]) => rotbb_box(x, y, size, intersect),
            };
            assert_eq!(
                got.map(f64::to_bits),
                want.map(f64::to_bits),
                "orientation {id} ({}) box",
                CLIFF_ORIENTATION_NAMES[id]
            );
        }
    }

    /// Every edge is an exact multiple of `1/256`, which is what makes the
    /// literal table above bit-exact rather than approximately right.
    #[test]
    fn every_box_edge_lands_on_the_eight_bit_fixed_point_grid() {
        for (id, box_) in CLIFF_ORIENTATION_COLLISION_BOX.iter().enumerate() {
            for edge in box_ {
                let scaled = edge * 256.0;
                assert_eq!(
                    scaled,
                    scaled.trunc(),
                    "orientation {id} edge {edge} is not a 1/256 multiple"
                );
            }
        }
    }

    /// `Math.round` and `f64::round` disagree on a negative half, and this port
    /// needs JavaScript's. Planted, because no real box edge lands on one.
    /// The TypeScript writes `1.4142135623730951`; Rust's constant must be the
    /// same bits, or `rotbb_box` evaluates different arithmetic.
    ///
    /// `approx_constant` is allowed here precisely because the spelled-out
    /// literal IS the assertion - the lint's advice, "use the constant
    /// directly", would turn this into `SQRT_2 == SQRT_2` and check nothing.
    #[test]
    #[allow(clippy::approx_constant)]
    fn the_square_root_constant_is_the_one_the_typescript_writes() {
        assert_eq!(SQRT2.to_bits(), 1.414_213_562_373_095_1_f64.to_bits());
    }

    #[test]
    fn the_rounding_is_javascripts_and_not_rusts() {
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!((-0.5f64).round(), -1.0);
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(-1.5), -1.0);
    }

    /// The floor is inclusive at both ends, so a straight orientation's 4-tile
    /// box scans FIVE tiles across. Getting this exclusive would silently
    /// shrink every collision test.
    #[test]
    fn a_straight_orientations_box_scans_five_tiles_across() {
        // Code 240 is `west-to-east`, whose box is [-2, -1.5, 2, 1.5].
        let b = cliff_collision_tile_box(240, 2.0, 2.5).expect("240 places a cliff");
        assert_eq!(b.left, 0);
        assert_eq!(b.right, 4);
        assert_eq!(b.right - b.left + 1, 5);
        assert_eq!(b.top, 1);
        assert_eq!(b.bottom, 4);
    }

    #[test]
    fn a_code_that_places_nothing_has_no_tile_box() {
        assert_eq!(cliff_collision_tile_box(0, 2.0, 2.5), None);
        assert_eq!(cliff_collision_tile_box(0x51, 2.0, 2.5), None);
    }
}
