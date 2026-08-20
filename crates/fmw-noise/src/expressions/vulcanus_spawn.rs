//! Vulcanus's seed-derived radial spawn geometry, ported from
//! `src/noise/expressions/vulcanusSpawn.ts`.
//!
//! Three biome "starts" - ashlands, basalts and mountains - placed at fixed
//! distances and radii around spawn, 120 degrees apart, rotated and mirrored by
//! the map seed. `starting_area` is their max clamped to `[0, 1]` and blends the
//! biomes near spawn; `starting_circle` is a related but separate UNCLAMPED
//! falloff that pushes random ore placement away from spawn. Transcribed from
//! `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` lines ~162-225.
//!
//! ## Three numbers here are easy to get wrong and none of them is checkable by eye
//!
//! - **`basalts_start`'s distance is a bare `250`**, not `250 * r`, where both
//!   its siblings scale by `r`. Transcribed as written.
//! - **Ashlands and basalts share a distortion coefficient of `0.1 * r`;
//!   mountains uses half of it, `0.05 * r`.**
//! - **The three results carry different multipliers**: ashlands `4`, basalts
//!   and mountains `2`.
//!
//! Each produces a plausible map when wrong, so each has its own test rather
//! than relying on the fixture to notice.
//!
//! ## The trig is an INPUT, for the reason #279 records
//!
//! All three bearings are per-render constants derived from the seed, so their
//! sines and cosines are computed once outside the per-pixel path and handed in.
//! A runtime `sin` in the shipped module is the one thing the determinism policy
//! forbids, and #270 measured that the wasm libm and V8 really do disagree by a
//! ULP. [`VulcanusSpawn::with_host_trig`] computes them with Rust's own libm,
//! for tests.

use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::ctx::EvalCtx;
use crate::eval::math::{clamp, max};
use crate::expressions::starting_spot_at_angle::{starting_spot_at_angle, AngleTrig, StartingSpot};
use crate::expressions::vulcanus_helpers::VulcanusHelpers;
use crate::poison;

/// `vulcanus_starting_area_radius = 0.7 * 0.75`.
pub const VULCANUS_STARTING_AREA_RADIUS: f64 = 0.7 * 0.75;

/// The summed wobble distortion every `*_start` reads, at one position.
///
/// All three starts read the SAME two sums, which is why they are computed once
/// here and passed in rather than recomputed per start. The TypeScript memoizes
/// them for exactly that reason.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WobbleSums {
    pub x: f64,
    pub y: f64,
}

impl WobbleSums {
    /// Sum the three x wobbles and the three y wobbles at one position.
    #[must_use]
    pub fn at(helpers: &VulcanusHelpers, x: f64, y: f64) -> Self {
        Self {
            x: helpers.wobble_x(x, y) + helpers.wobble_large_x(x, y) + helpers.wobble_huge_x(x, y),
            y: helpers.wobble_y(x, y) + helpers.wobble_large_y(x, y) + helpers.wobble_huge_y(x, y),
        }
    }
}

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SpawnFields {
    pub ashlands_start: f64,
    pub basalts_start: f64,
    pub mountains_start: f64,
    pub starting_area: f64,
    pub starting_circle: f64,
}

/// The per-render constants of Vulcanus's spawn geometry.
pub struct VulcanusSpawn {
    /// `-1 + 2 * (map_seed_small & 1)`, so either -1 or +1. It mirrors the
    /// whole arrangement, which is why it multiplies the angle OFFSETS rather
    /// than the base angle.
    pub starting_direction: f64,
    /// `map_seed_normalized * 3600` degrees.
    pub ashlands_angle: f64,
    /// `ashlands_angle + 120 * starting_direction` degrees.
    pub mountains_angle: f64,
    /// `ashlands_angle + 240 * starting_direction` degrees.
    pub basalts_angle: f64,
    ashlands: StartingSpot,
    basalts: StartingSpot,
    mountains: StartingSpot,
    starting_positions: Vec<Point>,
}

impl VulcanusSpawn {
    /// Build the layer, taking the three bearings' trig from the caller.
    #[must_use]
    pub fn new(
        ctx: &EvalCtx,
        ashlands_trig: AngleTrig,
        mountains_trig: AngleTrig,
        basalts_trig: AngleTrig,
    ) -> Self {
        let r = VULCANUS_STARTING_AREA_RADIUS;
        let (ashlands_angle, mountains_angle, basalts_angle) = Self::angles(ctx);
        Self {
            starting_direction: Self::starting_direction(ctx),
            ashlands_angle,
            mountains_angle,
            basalts_angle,
            ashlands: StartingSpot {
                trig: ashlands_trig,
                distance: f64::from((170.0 * r) as f32),
                radius: f64::from((350.0 * r) as f32),
            },
            basalts: StartingSpot {
                trig: basalts_trig,
                // A bare 250, NOT 250 * r. See the module docs.
                distance: 250.0,
                radius: f64::from((550.0 * r) as f32),
            },
            mountains: StartingSpot {
                trig: mountains_trig,
                distance: f64::from((250.0 * r) as f32),
                radius: f64::from((500.0 * r) as f32),
            },
            starting_positions: ctx.starting_positions.clone(),
        }
    }

    /// As [`VulcanusSpawn::new`], but computing all three bearings with Rust's
    /// libm. For tier-1 tests and anything that is not the shipped engine.
    #[must_use]
    pub fn with_host_trig(ctx: &EvalCtx) -> Self {
        let (a, m, b) = Self::angles(ctx);
        Self::new(
            ctx,
            AngleTrig::from_degrees(a),
            AngleTrig::from_degrees(m),
            AngleTrig::from_degrees(b),
        )
    }

    /// `-1 + 2 * (map_seed_small & 1)`.
    fn starting_direction(ctx: &EvalCtx) -> f64 {
        -1.0 + 2.0 * f64::from(ctx.map_seed_small & 1)
    }

    /// The three bearings in degrees, each narrowed the way the TypeScript
    /// narrows them.
    ///
    /// `f32(120 * direction)` is narrowed SEPARATELY before being added, and
    /// then the sum is narrowed again. Both roundings are in the TypeScript and
    /// both are kept - see the two-case rule in `src/noise/eval/f32.ts`.
    fn angles(ctx: &EvalCtx) -> (f64, f64, f64) {
        let direction = Self::starting_direction(ctx);
        let ashlands = f64::from((f64::from(ctx.map_seed_normalized) * 3600.0) as f32);
        let mountains = f64::from((ashlands + f64::from((120.0 * direction) as f32)) as f32);
        let basalts = f64::from((ashlands + f64::from((240.0 * direction) as f32)) as f32);
        (ashlands, mountains, basalts)
    }

    /// Evaluate every field of this layer at one position.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64, wobble: WobbleSums) -> SpawnFields {
        let r = VULCANUS_STARTING_AREA_RADIUS;

        // Ashlands and basalts share 0.1 * r; mountains uses half of it.
        let wide_x = 0.1 * r * wobble.x;
        let wide_y = 0.1 * r * wobble.y;
        let tight_x = 0.05 * r * wobble.x;
        let tight_y = 0.05 * r * wobble.y;

        let ashlands_start = 4.0 * starting_spot_at_angle(&self.ashlands, x, y, wide_x, wide_y);
        let basalts_start = 2.0 * starting_spot_at_angle(&self.basalts, x, y, wide_x, wide_y);
        let mountains_start = 2.0 * starting_spot_at_angle(&self.mountains, x, y, tight_x, tight_y);

        // The argument order is the TypeScript's - basalts, mountains,
        // ashlands - and it is kept rather than sorted, per the signed-zero
        // note in `CLAUDE.md`.
        let starting_area = clamp(
            max(&[basalts_start, mountains_start, ashlands_start]),
            0.0,
            1.0,
        );

        // NOT clamped, and that is the point of it being a separate field from
        // `starting_area`: it goes on rising past 1 toward spawn and negative
        // far from it, which is what makes it usable as an ore suppressor.
        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        let starting_circle = 1.0 + (r * (300.0 - distance)) / 50.0;

        SpawnFields {
            ashlands_start,
            basalts_start,
            mountains_start,
            starting_area: poison::f64_result(starting_area),
            starting_circle,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer() -> (VulcanusHelpers, VulcanusSpawn) {
        let ctx = EvalCtx::new(123_456);
        (
            VulcanusHelpers::new(&ctx),
            VulcanusSpawn::with_host_trig(&ctx),
        )
    }

    /// `0.7 * 0.75` is written as the product rather than as `0.525`, because
    /// the product is what the Lua writes and the two are not the same f64.
    #[test]
    fn the_starting_area_radius_is_the_product_the_lua_writes() {
        assert_eq!(VULCANUS_STARTING_AREA_RADIUS, 0.7 * 0.75);
    }

    /// The direction is exactly -1 or +1, never 0 or 2. It comes from one bit,
    /// so an off-by-one in the formula shows immediately.
    #[test]
    fn the_starting_direction_is_a_sign() {
        for seed in [0u32, 1, 2, 3, 123_456, 999_999, u32::MAX] {
            let d = VulcanusSpawn::with_host_trig(&EvalCtx::new(seed)).starting_direction;
            assert!(d == -1.0 || d == 1.0, "seed {seed} gave {d}");
        }
        // The bit really does drive it: consecutive seeds differ in bit 0, and
        // `map_seed_small` keeps the low 16 bits, so they flip the sign.
        let even = VulcanusSpawn::with_host_trig(&EvalCtx::new(2)).starting_direction;
        let odd = VulcanusSpawn::with_host_trig(&EvalCtx::new(3)).starting_direction;
        assert_eq!(even, -1.0);
        assert_eq!(odd, 1.0);
    }

    /// The three bearings sit 120 degrees apart, in the order the direction
    /// picks. Checked modulo 360 because the base angle is unbounded.
    ///
    /// **Not an exact comparison, and the reason is the expression rather than
    /// the test.** Every angle is narrowed to f32, and `ashlands_angle` is
    /// `map_seed_normalized * 3600`, so it sits near 3600 where one f32 ULP is
    /// about 2.4e-4; the measured separation at seed 123456 is 239.999998. The
    /// tolerance is on the SEPARATION of two f32 angles, a geometric property
    /// of this layer. It is not a residual bound standing in for an exact
    /// count - nothing here measures the port against the game.
    #[test]
    fn the_three_bearings_are_120_degrees_apart() {
        let (_, spawn) = layer();
        let sep = |a: f64, b: f64| (a - b).rem_euclid(360.0);
        let d = spawn.starting_direction;
        let (near, far) = if d > 0.0 {
            (120.0, 240.0)
        } else {
            (240.0, 120.0)
        };
        let m = sep(spawn.mountains_angle, spawn.ashlands_angle);
        let b = sep(spawn.basalts_angle, spawn.ashlands_angle);
        assert!((m - near).abs() < 1e-3, "mountains separation {m}");
        assert!((b - far).abs() < 1e-3, "basalts separation {b}");
    }

    /// **`basalts_start`'s distance is a bare 250.** Its siblings scale by `r`,
    /// so the natural transcription error is `250 * r` - which is 131.25, a
    /// different place entirely, and still produces a plausible map.
    #[test]
    fn the_basalts_distance_is_not_scaled_by_the_radius() {
        let (_, spawn) = layer();
        assert_eq!(spawn.basalts.distance, 250.0);
        assert_ne!(
            spawn.basalts.distance,
            f64::from((250.0 * VULCANUS_STARTING_AREA_RADIUS) as f32)
        );
        // Its siblings DO scale, which is what makes the exception an exception.
        assert_eq!(
            spawn.mountains.distance,
            f64::from((250.0 * VULCANUS_STARTING_AREA_RADIUS) as f32)
        );
        assert_eq!(
            spawn.ashlands.distance,
            f64::from((170.0 * VULCANUS_STARTING_AREA_RADIUS) as f32)
        );
    }

    /// Mountains is distorted by half what the other two get. Feeding all three
    /// the same coefficient still produces three blobs in the right places.
    #[test]
    fn mountains_takes_half_the_distortion_of_the_other_two() {
        let (helpers, spawn) = layer();
        let (x, y) = (120.5, -80.25);
        let wobble = WobbleSums::at(&helpers, x, y);
        assert_ne!(
            wobble.x, 0.0,
            "need a nonzero wobble for this to say anything"
        );

        let r = VULCANUS_STARTING_AREA_RADIUS;
        let got = spawn.eval(x, y, wobble);
        // Rebuild mountains with the WIDE coefficient and confirm it differs.
        let wrong = 2.0
            * starting_spot_at_angle(
                &spawn.mountains,
                x,
                y,
                0.1 * r * wobble.x,
                0.1 * r * wobble.y,
            );
        assert_ne!(got.mountains_start, wrong);
    }

    /// `starting_area` is clamped and `starting_circle` is not. Clamping the
    /// second would break its use as an ore suppressor far from spawn, where it
    /// must be allowed to go negative.
    #[test]
    fn starting_area_is_clamped_and_starting_circle_is_not() {
        let (helpers, spawn) = layer();
        let mut saw_above_one = 0usize;
        let mut saw_negative = 0usize;
        for k in 0..120 {
            let (x, y) = (f64::from(k) * 37.5 - 2000.0, f64::from(k) * -21.25 + 900.0);
            let f = spawn.eval(x, y, WobbleSums::at(&helpers, x, y));
            assert!((0.0..=1.0).contains(&f.starting_area));
            if f.starting_circle > 1.0 {
                saw_above_one += 1;
            }
            if f.starting_circle < 0.0 {
                saw_negative += 1;
            }
        }
        assert!(saw_above_one > 0 && saw_negative > 0,
            "starting_circle stayed inside [0, 1] over the whole sweep ({saw_above_one} above, {saw_negative} below), so this proves nothing");
    }
}
