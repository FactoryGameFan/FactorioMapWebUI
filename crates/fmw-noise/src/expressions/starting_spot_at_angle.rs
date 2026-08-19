//! `starting_spot_at_angle`, ported from `src/noise/expressions/vulcanusShared.ts`.
//!
//! A cone centred on a point placed at a bearing and distance from spawn:
//!
//! ```text
//! delta_x = distance*sin(a) - x_from_start + x_distortion
//! delta_y = -distance*cos(a) - y_from_start + y_distortion
//! result  = 1 - sqrt(delta_x^2 + delta_y^2) / radius
//! ```
//!
//! ## The trig is an INPUT, and that is the whole design of this module
//!
//! The determinism policy (spec section 5) says trig must be committed
//! constants or compiled code, never a runtime `sin`/`cos`, because V8 and libm
//! disagree in the last bit. #270 turned that from a principle into a
//! measurement: the `log2`/`pow` that `wasm32-unknown-unknown` compiles in
//! disagrees with V8 on 1 of 600 slider positions, and **native Rust agrees with
//! V8 at those same points** - so `cargo test` on the host cannot see the class
//! of bug at all.
//!
//! `slider_rescale` survived that because it narrows to f32 at every step, and
//! one f64 ULP is ~29 bits below what an f32 narrowing keeps. **This expression
//! has no narrowing anywhere** - it is plain f64 arithmetic ending in a `sqrt`
//! and a divide - so a one-ULP difference in `sin` propagates straight to the
//! result.
//!
//! The way out is structural rather than numerical. **At every one of the 13
//! call sites in the TypeScript, `angle` and `distance` are per-render
//! constants** - `fulgora_shared` computes `angle = seed0 / 360`, Vulcanus reads
//! its three angles off the seed vars, and the distances are grid or radius
//! multiples. None of them varies with position. Checked by reading all 13, not
//! assumed.
//!
//! So the sine and cosine of the angle are computed **once per render, outside
//! the per-pixel path**, and handed in. The caller that owns them is the one
//! that owns the engine question: in a tier-1 test that is Rust's own libm,
//! graded against the oracle; in tier-2 parity and in the shipped engine it is
//! V8's, passed across the boundary, which makes a libm disagreement impossible
//! rather than unlikely.

/// The sine and cosine of one bearing, in the order the expression uses them.
///
/// Constructed either from an angle in degrees ([`AngleTrig::from_degrees`],
/// which is what a Rust tier-1 test uses) or from values computed elsewhere
/// ([`AngleTrig::new`], which is what the WASM boundary uses).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AngleTrig {
    pub sin: f64,
    pub cos: f64,
}

impl AngleTrig {
    /// From values computed by the caller. Use this at the boundary.
    #[must_use]
    pub fn new(sin: f64, cos: f64) -> Self {
        Self { sin, cos }
    }

    /// From an angle in DEGREES, via Rust's libm.
    ///
    /// `(angle / 180) * PI` in that order and with those parentheses, matching
    /// the TypeScript: `angle / 180 * PI` and `angle * (PI / 180)` are different
    /// numbers, because `PI / 180` is not exact.
    ///
    /// **Not for the shipped engine.** See the module docs: this reaches
    /// whichever libm the target links, and the WASM one is measurably not
    /// V8's. It is here so a tier-1 test can grade the expression against the
    /// oracle without a fixture having to carry pre-computed trig.
    #[must_use]
    pub fn from_degrees(angle: f64) -> Self {
        let radians = (angle / 180.0) * std::f64::consts::PI;
        Self {
            sin: radians.sin(),
            cos: radians.cos(),
        }
    }
}

/// The constants of one cone. Everything here is fixed for a whole render.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StartingSpot {
    pub trig: AngleTrig,
    pub distance: f64,
    pub radius: f64,
}

/// Evaluate the cone at `(x_from_start, y_from_start)` with the given
/// distortion.
///
/// The distortion IS per-position - it is the wobble field - which is why it
/// stays an argument while the angle does not.
#[must_use]
pub fn starting_spot_at_angle(
    spot: &StartingSpot,
    x_from_start: f64,
    y_from_start: f64,
    x_distortion: f64,
    y_distortion: f64,
) -> f64 {
    let delta_x = spot.distance * spot.trig.sin - x_from_start + x_distortion;
    let delta_y = -spot.distance * spot.trig.cos - y_from_start + y_distortion;
    crate::poison::f64_result(1.0 - (delta_x * delta_x + delta_y * delta_y).sqrt() / spot.radius)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cone is 1 at its own centre and 0 on its rim, which pins the sign of
    /// both delta terms and the direction of `radius`.
    #[test]
    fn is_one_at_the_centre_and_zero_on_the_rim() {
        // angle 90 puts the centre at (+distance, 0): sin(90 deg) = 1, cos = 0.
        let spot = StartingSpot {
            trig: AngleTrig::from_degrees(90.0),
            distance: 170.0,
            radius: 350.0,
        };
        let centre = starting_spot_at_angle(&spot, 170.0, 0.0, 0.0, 0.0);
        assert!((centre - 1.0).abs() < 1e-12, "centre was {centre}");
        let rim = starting_spot_at_angle(&spot, 170.0 + 350.0, 0.0, 0.0, 0.0);
        assert!(rim.abs() < 1e-12, "rim was {rim}");
    }

    /// angle 0 puts the centre at `(0, -distance)`, which is what the leading
    /// minus on `delta_y` is for. An inverted sign lands at `(0, +distance)` and
    /// this test is what sees it.
    #[test]
    fn angle_zero_places_the_centre_at_negative_y() {
        let spot = StartingSpot {
            trig: AngleTrig::from_degrees(0.0),
            distance: 250.0,
            radius: 100.0,
        };
        let up = starting_spot_at_angle(&spot, 0.0, -250.0, 0.0, 0.0);
        let down = starting_spot_at_angle(&spot, 0.0, 250.0, 0.0, 0.0);
        assert!(
            (up - 1.0).abs() < 1e-12,
            "expected the centre at -y, got {up}"
        );
        assert!(down < 0.0, "expected +y to be outside the cone, got {down}");
    }

    /// Distortion moves the sample point, not the centre - so it enters with the
    /// same sign as the centre term and the opposite sign to the position.
    #[test]
    fn distortion_offsets_the_sample_not_the_centre() {
        let spot = StartingSpot {
            trig: AngleTrig::from_degrees(90.0),
            distance: 0.0,
            radius: 100.0,
        };
        // Ten tiles of distortion cancels ten tiles of position exactly.
        assert_eq!(
            starting_spot_at_angle(&spot, 10.0, 0.0, 10.0, 0.0),
            starting_spot_at_angle(&spot, 0.0, 0.0, 0.0, 0.0)
        );
    }

    /// `(angle / 180) * PI` is not `angle * (PI / 180)`. Pinned because the
    /// second form is the one a reader is likely to "tidy" it into.
    #[test]
    fn the_radian_conversion_keeps_the_typescripts_association() {
        let mut differing = 0;
        for degrees in 1..=720 {
            let a = f64::from(degrees);
            if ((a / 180.0) * std::f64::consts::PI) != (a * (std::f64::consts::PI / 180.0)) {
                differing += 1;
            }
        }
        assert!(
            differing > 0,
            "the two associations agree everywhere tested, so this guard is \
             vacuous - pick a wider sweep"
        );
    }
}
