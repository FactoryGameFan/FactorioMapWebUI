//! Factorio's `distance_from_nearest_point` primitive
//! (`NoiseOperations::DistanceFromNearestPoint::run`, non-stripped Mach-O:
//! `0x101759568` in 2.1.11, `0x101767b08` in 2.1.14), ported from
//! `src/noise/distanceFromNearestPoint.ts`.
//!
//! Unlike the multioctave family this needed no oracle fit - it is plain
//! geometry - and its `points` argument is a runtime list the noise DSL will
//! not accept as a literal, so it cannot be probed standalone. It validates
//! through `finish_elevation`, whose tree feeds it `starting_lake_positions`.
//!
//! Per tile:
//!
//! ```text
//! distance_from_nearest_point(x, y) =
//!     min( maximum_distance , min over p in points of dist((x, y), p) )
//! ```
//!
//! The disassembly seeds a running best with `maximum_distance^2`, loops the
//! points tracking the smallest squared distance, then returns
//! `bestSq < maximum_distance^2 ? sqrt(bestSq) : maximum_distance`.
//!
//! ## Every step is f32, and both ports had this wrong until 2026-08-18
//!
//! The TypeScript returned a raw f64 and its spec compared `Math.fround(...)`
//! of it, so the comparison site was recovering a value the op never produced.
//! Scored raw against the game's own captured values that reading was **0 of
//! 26** on `distance` and 17 of 26 on `startingLakeDistance` - the same defect
//! #260 found in `random_penalty`, one op later and worse, since there the raw
//! op still scored 4 of 40.
//!
//! Settled by re-reading `run` at `0x101767b08` in the 2.1.14 Mach-O. The
//! register widths decide it: `s` is a float, `d` is a double, and this
//! function contains no `d` at all.
//!
//! ```text
//! +200  mov    w11, #0x3b800000        // f32 1/256
//! +220  ldp    s0, s1, [x9]            // the point, two int32 fixed-point words
//! +224  scvtf  s0, s0                  // int32 -> FLOAT
//! +232  fmul   s0, s0, s2              // * 1/256, in SINGLE
//! +300  ldr    s2, [x12]               // x, from an f32 register slot
//! +304  fsub   s2, s2, s0              // dx, SINGLE
//! +316  fmul   s4, s2, s2              // dx*dx, SINGLE
//! +324  fadd   s4, s4, s5              // d2,    SINGLE
//! +436  ldp    s2, s1, [x19, #0x38]    // maximum_distance and its SQUARE, both
//! +440  fsqrt  s3, s0                  //   f32 constants; SINGLE-precision sqrt
//! +448  fcsel  s0, s3, s2, lt          // bestSq < maxSq ? sqrt(bestSq) : max
//! +452  str    s0, [x9], #0x4          // stored as f32
//! ```
//!
//! Three consequences that the shape alone does not give you:
//!
//! - **`maximum_distance` and its square are f32 constants read together by one
//!   `ldp`**, precomputed at construction. The cap comparison is against
//!   `f32(max)^2` rounded once, not a product recomputed per call in f64.
//! - **The incoming coordinates arrive as f32**, because the register buffer
//!   holds `float`. Feeding a primitive f64 coordinates is a recorded hazard on
//!   this port worth up to 331x (#190), which is why `x` and `y` are narrowed
//!   on entry rather than taken as `f32` - the caller's coordinate arithmetic
//!   happens in f64, exactly as it does in JavaScript.
//! - **The point conversion is `int32 * f32(1/256)` in f32**, not
//!   `round(v * 256) / 256` in f64. Identical for the integer tile positions
//!   every caller passes, and different past +-65,536 tiles, where the int32
//!   exceeds 2^24 and `scvtf` starts rounding.
//!
//! ## What the fixture can and cannot settle here
//!
//! It rejects the old f64 return at 0 of 26. It CANNOT separate this shape from
//! f64-with-one-final-narrowing: measured, the two agree on all 26 fixture
//! points and on all 41,495 points of a wide sweep, worst difference 0. So the
//! shape above is a reading of the binary rather than a fit to the data, which
//! is why it was read rather than guessed.
//!
//! The kernel is `sqrt(dx*dx + dy*dy)`, not `hypot` - a third reading. The two
//! differ on 8 of the 26 fixture points in f64 and on 0 of 26 in f32.

/// A point in world tiles.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// `f32(1/256)`, the exact multiplier at +200 (`0x3b800000`).
const INV_256: f32 = f32::from_bits(0x3b80_0000);

/// JavaScript's `Math.round`: ties go toward positive infinity, not away from
/// zero.
///
/// Rust's `f64::round` rounds half AWAY FROM ZERO, so the two disagree at
/// exactly `-0.5` - `Math.round` gives `-0`, `f64::round` gives `-1`. That
/// reaches `quantise` for a point at `-1/512` and nothing else. Unreachable
/// with the integer and 1/256 point lists the game actually passes, and written
/// out anyway because a silent one-tile shift on negative coordinates is
/// exactly the class of bug this port exists to avoid.
///
/// Phrased as `floor(v) + (v - floor(v) >= 0.5)` rather than `floor(v + 0.5)`,
/// because adding 0.5 first rounds, and at `0.49999999999999994` that carries
/// to 1 where `Math.round` gives 0.
fn js_round(v: f64) -> f64 {
    let floor = v.floor();
    if v - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// A point coordinate as the game holds it: `int32 = round(coord * 256)`,
/// converted back with `scvtf` and a single-precision multiply by 1/256.
fn quantise(v: f64) -> f32 {
    (js_round(v * 256.0) as f32) * INV_256
}

/// Evaluate `distance_from_nearest_point` at world coordinates `(x, y)`: the
/// Euclidean distance to the nearest of `points`, capped at `maximum_distance`.
///
/// With no points, or all of them beyond the cap, it returns
/// `maximum_distance`. Pass `f64::INFINITY` for uncapped - the game's exact
/// default when the DSL omits the argument is unconfirmed, but every base-game
/// caller passes one (the elevation tree's is 1024).
///
/// Returns `f32`, because the op stores one. See the header.
///
/// Cost is O(points) per tile, so callers sweeping a grid should reduce
/// `points` to the region of interest first.
#[must_use]
pub fn distance_from_nearest_point(x: f64, y: f64, points: &[Point], maximum_distance: f64) -> f32 {
    // Both are f32 constants the operation precomputes, read together by the
    // one `ldp s2, s1` at +436.
    let max = maximum_distance as f32;
    let max_sq = max * max;
    // The register buffer these are read from holds `float`. Taking `f64` here
    // and narrowing is deliberate: the CALLER's coordinate arithmetic happens
    // in f64, exactly as it does in JavaScript, so narrowing at the parameter
    // would evaluate a different point (#190).
    let xf = x as f32;
    let yf = y as f32;

    let mut best_sq = max_sq;
    for p in points {
        let dx = xf - quantise(p.x);
        let dy = yf - quantise(p.y);
        // The naive squared distance, not `hypot`. See the header.
        let d2 = dx * dx + dy * dy;
        if d2 < best_sq {
            best_sq = d2;
        }
    }
    crate::poison::f32_result(if best_sq < max_sq {
        best_sq.sqrt()
    } else {
        max
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const POINTS: [Point; 4] = [
        Point { x: 0.0, y: 0.0 },
        Point { x: 40.0, y: 0.0 },
        Point { x: 0.0, y: 40.0 },
        Point { x: -50.0, y: 30.0 },
    ];

    /// Closed-form distances anyone can check on paper. The counterpart is
    /// test/distanceFromNearestPoint.spec.ts.
    #[test]
    fn returns_the_euclidean_distance_to_the_nearest_point() {
        assert_eq!(distance_from_nearest_point(0.0, 0.0, &POINTS, 1024.0), 0.0);
        // Between the origin and (40, 0): the origin is nearer, at 10.
        assert_eq!(
            distance_from_nearest_point(10.0, 0.0, &POINTS, 1024.0),
            10.0
        );
        // (36, 0): (40, 0) is nearer, at 4.
        assert_eq!(distance_from_nearest_point(36.0, 0.0, &POINTS, 1024.0), 4.0);
        // A 3-4-5 triangle from (0, 40).
        assert_eq!(distance_from_nearest_point(3.0, 44.0, &POINTS, 1024.0), 5.0);
    }

    #[test]
    fn caps_the_result_at_maximum_distance() {
        assert_eq!(
            distance_from_nearest_point(100_000.0, 100_000.0, &POINTS, 1024.0),
            1024.0
        );
        // Exactly at the cap stays capped: `bestSq == maxSq` takes the
        // `maximum_distance` branch, not the sqrt.
        let origin = [Point { x: 0.0, y: 0.0 }];
        assert_eq!(
            distance_from_nearest_point(1024.0, 0.0, &origin, 1024.0),
            1024.0
        );
        // Just inside it returns the true distance.
        assert_eq!(
            distance_from_nearest_point(1000.0, 0.0, &origin, 1024.0),
            1000.0
        );
    }

    #[test]
    fn with_no_points_returns_maximum_distance() {
        assert_eq!(distance_from_nearest_point(5.0, 5.0, &[], 1024.0), 1024.0);
        assert_eq!(
            distance_from_nearest_point(5.0, 5.0, &[], f64::INFINITY),
            f32::INFINITY
        );
    }

    #[test]
    fn quantises_points_onto_the_1_over_256_grid() {
        // 0.001 is under half of 1/256, so it snaps to 0 and the distance is 0.
        // Chosen to avoid the exact-half tie, whose rounding the game has not
        // been measured on.
        let near = [Point { x: 0.001, y: 0.0 }];
        assert_eq!(
            distance_from_nearest_point(0.0, 0.0, &near, f64::INFINITY),
            0.0
        );
        // An exact multiple of 1/256 survives untouched.
        let on_grid = [Point {
            x: 1.0 / 256.0,
            y: 0.0,
        }];
        assert_eq!(
            distance_from_nearest_point(0.0, 0.0, &on_grid, f64::INFINITY),
            1.0 / 256.0
        );
        // Past 2^24 the int32 fixed-point word no longer fits an f32 mantissa,
        // so `scvtf` rounds and the game loses sub-tile precision. 65_536.5
        // tiles is 16,777,344 in fixed point, which rounds to 16,777,344 - but
        // 65_536.001 rounds to the same place, so the two are indistinguishable
        // to the op. That is the game's behaviour, not a defect in the port.
        let far = [Point {
            x: 65_536.5,
            y: 0.0,
        }];
        let far_nudged = [Point {
            x: 65_536.501,
            y: 0.0,
        }];
        assert_eq!(
            distance_from_nearest_point(0.0, 0.0, &far, f64::INFINITY),
            distance_from_nearest_point(0.0, 0.0, &far_nudged, f64::INFINITY)
        );
    }

    /// The tie direction, pinned because Rust's own `round` disagrees with
    /// JavaScript's here and the difference is a whole 1/256 on the negative
    /// side.
    #[test]
    fn the_quantisation_tie_rounds_toward_positive_infinity() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(-1.5), -1.0);
        // `f64::round` gives -2.0 here, which is the reading this function
        // exists to avoid.
        assert_ne!(js_round(-1.5), (-1.5f64).round());
        // And the `floor(v + 0.5)` shortcut gives 1.0 here, which is the other.
        assert_eq!(js_round(0.499_999_999_999_999_94), 0.0);
    }
}
