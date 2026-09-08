//! The tile half of `Surface::wouldCollide(CliffPrototype const&, MapPosition
//! const&, CliffOrientation)` - the apply-stage collision test every queued
//! cliff passes through - transcribed from the 2.0.77 arm64 disassembly and
//! graded against the game's own calls (#407, #84).
//!
//! `test/fixtures/oracle-vulcanus-wouldcollide.seed123456.json` holds all 2157
//! calls the generator made while re-creating the three cliff fixture regions,
//! recorded by an lldb breakpoint script. Each function here reproduces the
//! corresponding engine routine on every one of them: [`get_aabb`] on all 2157
//! AABBs, [`tile_collides`] on all 2157 tile verdicts with the port's own lava.
//! The rules those calls settled, none of them readable from the preview path
//! `#90` disassembled:
//!
//! - **The loader keeps `rotbb`'s `1/8` tag.** Every corner box carries an
//!   orientation word `[sin, -cos]` in 1.15 fixed point ([`ROTBB_TAG`]); the
//!   straight boxes carry the identity ([`NO_ROTATION`]).
//! - **`BoundingBox::getAABB` widens a rotated box to its axis-aligned
//!   square**, and `Surface::checkTileCollisions` scans the SQUARE's tiles -
//!   `edge >> 8` at both ends, inclusive.
//! - **A blocking tile counts only if the ORIENTED box reaches it**:
//!   `BoundingBox::collide`, a four-axis separating-axis test, is called per
//!   blocking tile against that tile's own square when the `sin` word is set.
//!   With no `sin` word every tile of the (unchanged) box counts, which is the
//!   rule `#90` shipped for every orientation.
//!
//! Every arithmetic detail below - the truncated centre, `fcvtzs #8`, the
//! f32-narrowed trig, doubled extents, `<=` at every edge - is what the binary
//! does, kept because a tile boundary is exactly where a rounding choice flips
//! a verdict.

use super::catalog::{cliff_orientation_for_code, CLIFF_ORIENTATION_COLLISION_BOX};
use super::placement::TileCollision;

/// A box in `MapPosition`'s 1/256 units: `[left, top, right, bottom]`.
pub type FixedBox = [i32; 4];

/// A box's orientation word as the engine stores it: `[sin, -cos]` in 1.15
/// fixed point, each read back as an `i16`.
pub type RotationWord = [i32; 2];

/// The orientation word every `cliff-vulcanus` corner box carries: 45 degrees.
pub const ROTBB_TAG: RotationWord = [0x5a82, 0xa57e];

/// The identity orientation word the four straight boxes carry.
pub const NO_ROTATION: RotationWord = [0, 0x8001];

/// The engine's per-halfword scale, `0x38000100` as an f32: `2^-15 * (1 + 2^-15)`,
/// so that 32767 maps to (just over) 1.
const HALFWORD_SCALE: f32 = f32::from_bits(0x3800_0100);

/// The orientation word a `cliff-vulcanus` box of `orientation` carries.
#[must_use]
pub const fn rotation_word(orientation: u8) -> RotationWord {
    if orientation >= 4 {
        ROTBB_TAG
    } else {
        NO_ROTATION
    }
}

/// The orientation's `collision_bounding_box` with the cell centre added, in
/// 1/256 units - what the engine copies onto its stack before the test.
#[must_use]
pub fn placed_box(orientation: u8, x: f64, y: f64) -> FixedBox {
    let [l, t, r, b] = CLIFF_ORIENTATION_COLLISION_BOX[orientation as usize];
    // Every edge is a 1/256 multiple and every centre a half-tile, so these
    // products are exact integers.
    #[allow(clippy::cast_possible_truncation)]
    [
        ((x + l) * 256.0) as i32,
        ((y + t) * 256.0) as i32,
        ((x + r) * 256.0) as i32,
        ((y + b) * 256.0) as i32,
    ]
}

/// `sin` and `cos` from an orientation word, narrowed the way the binary
/// narrows them: `scvtf` from the int16 halfword, `fmul` by the f32 scale,
/// `fcvt` to f64.
fn trig(rot: RotationWord) -> (f64, f64) {
    #[allow(clippy::cast_possible_truncation)]
    let sin = f64::from(f32::from(rot[0] as i16) * HALFWORD_SCALE);
    #[allow(clippy::cast_possible_truncation)]
    let cos = f64::from((-i32::from(rot[1] as i16)) as f32 * HALFWORD_SCALE);
    (sin, cos)
}

/// `BoundingBox::getAABB` (BoundingBox.cpp:366), three branches. A box with no
/// `sin` word is its own AABB. One with no `cos` word is a quarter turn, and
/// the half-extents swap about the TRUNCATED integer centre with no
/// trigonometry at all - the crater ring's straight segments take this branch,
/// and the general branch is one unit off on them. Otherwise
/// `getRotatedVertices` (BoundingBox.cpp:331): each of the two upper corners is
/// rotated about that centre in f64 tile units and converted back with
/// `fcvtzs #8` - truncation toward zero at 1/256 - the two lower corners are
/// their reflections through the centre, and the AABB is the min/max of the
/// four.
#[must_use]
pub fn get_aabb(b: &FixedBox, rot: RotationWord) -> FixedBox {
    if rot[0] & 0xffff == 0 {
        return *b;
    }
    #[allow(clippy::cast_possible_truncation)]
    let cx = (f64::from(b[0] + b[2]) * 0.5) as i32;
    #[allow(clippy::cast_possible_truncation)]
    let cy = (f64::from(b[1] + b[3]) * 0.5) as i32;
    if rot[1] & 0xffff == 0 {
        return [
            cx - (b[3] - cy),
            cy - (cx - b[0]),
            cx + (cy - b[1]),
            cy + (b[2] - cx),
        ];
    }
    let (sin, cos) = trig(rot);
    let rotate = |px: i32, py: i32| -> (i32, i32) {
        let dx = f64::from(px - cx) * (1.0 / 256.0);
        let dy = f64::from(py - cy) * (1.0 / 256.0);
        let rx = dx * cos - dy * sin;
        let ry = dx * sin + dy * cos;
        #[allow(clippy::cast_possible_truncation)]
        ((rx * 256.0) as i32, (ry * 256.0) as i32)
    };
    let (r1x, r1y) = rotate(b[0], b[1]);
    let (r2x, r2y) = rotate(b[2], b[1]);
    let xs = [cx + r1x, cx + r2x, cx - r2x, cx - r1x];
    let ys = [cy + r1y, cy + r2y, cy - r2y, cy - r1y];
    [
        xs.iter().copied().min().unwrap_or(cx),
        ys.iter().copied().min().unwrap_or(cy),
        xs.iter().copied().max().unwrap_or(cx),
        ys.iter().copied().max().unwrap_or(cy),
    ]
}

/// `BoundingBox::collide` (BoundingBox.cpp:539-671): a closed-interval overlap
/// when neither box carries a `sin` word, else a four-axis separating-axis
/// test in f64 over DOUBLED extents. Every comparison is `<=`, so an edge
/// exactly on a tile edge collides.
#[must_use]
pub fn box_collide(a: &FixedBox, a_rot: RotationWord, b: &FixedBox, b_rot: RotationWord) -> bool {
    if (a_rot[0] | b_rot[0]) & 0xffff == 0 {
        return a[0] <= b[2] && a[1] <= b[3] && a[2] >= b[0] && a[3] >= b[1];
    }
    let (sa, ca) = trig(a_rot);
    let (sb, cb) = trig(b_rot);
    let (wa, ha) = (f64::from(a[2] - a[0]), f64::from(a[3] - a[1]));
    let (wb, hb) = (f64::from(b[2] - b[0]), f64::from(b[3] - b[1]));
    let dx2 = f64::from(b[0] + b[2]) - f64::from(a[0] + a[2]);
    let dy2 = f64::from(b[1] + b[3]) - f64::from(a[1] + a[3]);
    let cos_rel = (sa * sb + ca * cb).abs();
    let sin_rel = (ca * sb - sa * cb).abs();
    if (dx2 * ca + dy2 * sa).abs() - wa > wb * cos_rel + hb * sin_rel {
        return false;
    }
    if (dx2 * sa - dy2 * ca).abs() - ha > wb * sin_rel + hb * cos_rel {
        return false;
    }
    if (dx2 * cb + dy2 * sb).abs() - wb > wa * cos_rel + ha * sin_rel {
        return false;
    }
    (dx2 * sb - dy2 * cb).abs() - hb <= wa * sin_rel + ha * cos_rel
}

/// `Surface::checkTileCollisions` (Surface.cpp:2187) for one box: scan the
/// AABB's tiles, and count a blocking tile outright when the box has no `sin`
/// word, else only when [`box_collide`] says the oriented box reaches the
/// tile's square (`BoundingBox::tileBox` with a zero margin, identity
/// orientation).
#[must_use]
pub fn box_tile_collides(
    boxed: &FixedBox,
    rot: RotationWord,
    aabb: &FixedBox,
    lava: &dyn TileCollision,
) -> bool {
    let rotated = rot[0] & 0xffff != 0;
    for ty in (aabb[1] >> 8)..=(aabb[3] >> 8) {
        for tx in (aabb[0] >> 8)..=(aabb[2] >> 8) {
            if !lava.collides(i64::from(tx), i64::from(ty)) {
                continue;
            }
            if !rotated {
                return true;
            }
            let tile = [tx * 256, ty * 256, (tx + 1) * 256, (ty + 1) * 256];
            if box_collide(boxed, rot, &tile, NO_ROTATION) {
                return true;
            }
        }
    }
    false
}

/// The whole tile half for a `cliff-vulcanus` cell of `orientation` centred at
/// `(x, y)`: the placed box, its AABB, and the scan. Exact against the game
/// on 2157 of 2157 recorded calls (`fixtures.rs`).
#[must_use]
pub fn tile_collides(orientation: u8, x: f64, y: f64, lava: &dyn TileCollision) -> bool {
    let boxed = placed_box(orientation, x, y);
    let rot = rotation_word(orientation);
    let aabb = get_aabb(&boxed, rot);
    box_tile_collides(&boxed, rot, &aabb, lava)
}

/// [`tile_collides`] by cell code, for the placement pass.
#[must_use]
pub fn code_tile_collides(code: u8, x: f64, y: f64, lava: &dyn TileCollision) -> bool {
    cliff_orientation_for_code(code).is_some_and(|o| tile_collides(o, x, y, lava))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lava(Vec<(i64, i64)>);
    impl TileCollision for Lava {
        fn collides(&self, x: i64, y: i64) -> bool {
            self.0.contains(&(x, y))
        }
    }

    /// A rotated corner box's AABB is the SQUARE `rotbb` inscribed it in,
    /// and an unrotated box is its own. The raw rectangle is not contained
    /// in that square - `hx + hy` is fixed at `size/2 * sqrt2`, so it sticks
    /// out on one axis while collapsing on the other (#90) - which is why the
    /// two models disagree in BOTH directions.
    #[test]
    fn a_corner_box_widens_to_its_square_and_a_straight_box_does_not() {
        let straight = placed_box(0, 2.0, 2.5);
        assert_eq!(get_aabb(&straight, rotation_word(0)), straight);
        let corner = placed_box(7, 2.0, 2.5);
        let aabb = get_aabb(&corner, rotation_word(7));
        assert_ne!(aabb, corner);
        assert_eq!(aabb[2] - aabb[0], aabb[3] - aabb[1], "square");
        assert!(
            aabb[2] - aabb[0] > corner[3] - corner[1],
            "taller than the rectangle"
        );
        assert!(
            aabb[2] - aabb[0] < corner[2] - corner[0],
            "narrower than the rectangle"
        );
    }

    /// The oriented test can REJECT a tile the raw rectangle scans: the raw
    /// `south-to-west` rectangle at the origin cell reaches tile (0, 3), the
    /// 45-degree rectangle does not. This is the whole difference `#407`
    /// ships, planted on one tile.
    #[test]
    fn the_oriented_test_spares_a_tile_the_raw_rectangle_scans() {
        let orientation = 7; // south-to-west
        let (x, y) = (2.0, 2.5);
        let boxed = placed_box(orientation, x, y);
        // Every tile of the raw rectangle's floor, as #90 scanned it.
        let raw: Vec<(i64, i64)> = ((boxed[1] >> 8)..=(boxed[3] >> 8))
            .flat_map(|ty| {
                ((boxed[0] >> 8)..=(boxed[2] >> 8)).map(move |tx| (i64::from(tx), i64::from(ty)))
            })
            .collect();
        let spared: Vec<(i64, i64)> = raw
            .iter()
            .copied()
            .filter(|&(tx, ty)| !tile_collides(orientation, x, y, &Lava(vec![(tx, ty)])))
            .collect();
        assert!(!spared.is_empty(), "no raw-rectangle tile is spared");
        // And a tile the rectangle's centre sits on always collides.
        let centre = ((boxed[0] + boxed[2]) / 512, (boxed[1] + boxed[3]) / 512);
        assert!(tile_collides(
            orientation,
            x,
            y,
            &Lava(vec![(i64::from(centre.0), i64::from(centre.1))])
        ));
    }

    /// Touching counts: a tile whose edge lies exactly on a straight box's edge
    /// collides, both in the closed-interval branch and the oriented one.
    #[test]
    fn an_edge_exactly_on_a_tile_edge_collides() {
        let a = [0, 0, 512, 256];
        assert!(box_collide(
            &a,
            NO_ROTATION,
            &[512, 0, 768, 256],
            NO_ROTATION
        ));
        assert!(!box_collide(
            &a,
            NO_ROTATION,
            &[513, 0, 768, 256],
            NO_ROTATION
        ));
        // The same box carrying a zero-angle word through the SAT path.
        let zero_angle: RotationWord = [1, 0x8001];
        assert!(box_collide(
            &a,
            zero_angle,
            &[512, 0, 768, 256],
            NO_ROTATION
        ));
    }
}
