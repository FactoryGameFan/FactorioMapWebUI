//! Gleba's starting-area cones: the lakes, lowlands, fertile spots, highlands,
//! midlands and the two enemy cones, all `starting_spot_at_angle` calls.
//!
//! Transcribed from `space-age/prototypes/planet/planet-gleba-map-gen.lua` at
//! 2.1.23 (the tier-1 fixture reads bit-identical on 2.0.77). Ported Rust-first:
//! there is no TypeScript counterpart.
//!
//! Every cone's angle is `gleba_starting_angle + K * gleba_starting_direction`,
//! and its distance and radius are whole numbers times
//! `gleba_starting_area_multiplier` (0.7). All three are fixed for a render, so
//! the cones are built once and only the distortion varies per position.
//!
//! **`y_distortion` is `gleba_wobble_x * 15` in every one of these, not
//! `gleba_wobble_y`.** The Lua writes `y_distortion = gleba_wobble_x * 15` (and
//! `* 20` for the enemy cones) at all sixteen call sites. It looks like a typo
//! and it is the game's behaviour, so it is kept.

use crate::eval::math::{f32r, max};
use crate::expressions::starting_spot_at_angle::{starting_spot_at_angle, AngleTrig, StartingSpot};
use crate::expressions::vulcanus_seed::{seed_normalized, seed_small};

/// `gleba_starting_area_multiplier`, the constant 0.7 as the machine holds it.
#[must_use]
pub fn area_multiplier() -> f64 {
    f32r(0.7)
}

/// `gleba_starting_direction` and `gleba_starting_angle`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlebaSeedVars {
    /// `-1 + 2 * (map_seed_small & 1)`, so exactly -1 or 1.
    pub direction: f64,
    /// `map_seed_normalized * 3600`, in f32.
    pub angle: f64,
}

impl GlebaSeedVars {
    #[must_use]
    pub fn new(seed0: u32) -> Self {
        Self {
            direction: -1.0 + 2.0 * f64::from(seed_small(seed0) & 1),
            angle: f32r(f64::from(seed_normalized(seed0)) * 3600.0),
        }
    }
}

/// The cone groups Gleba's expressions read, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StartingFields {
    /// `gleba_starting_lakes`: stone lake, opposite lake, opposite small lake.
    pub lakes: f64,
    /// `gleba_starting_lowlands`: yumako and jellynut lowlands.
    pub lowlands: f64,
    /// `gleba_starting_fertile`: the two small fertile cones.
    pub fertile: f64,
    /// `gleba_starting_highlands`: main and small.
    pub highlands: f64,
    /// `gleba_starting_midlands`: landing, iron and copper.
    pub midlands: f64,
    /// `gleba_starting_enemies_safe`.
    pub enemies_safe: f64,
    /// `gleba_starting_enemies`.
    pub enemies: f64,
}

/// One cone's constants: the angle offset and the distance and radius in units
/// of `gleba_starting_area_multiplier`.
struct ConeSpec {
    angle_offset: f64,
    distance: f64,
    radius: f64,
}

const fn spec(angle_offset: f64, distance: f64, radius: f64) -> ConeSpec {
    ConeSpec {
        angle_offset,
        distance,
        radius,
    }
}

const HIGHLAND_MAIN: ConeSpec = spec(95.0, 100.0, 130.0);
const HIGHLAND_SMALL: ConeSpec = spec(40.0, 130.0, 65.0);
const MIDLAND_LANDING: ConeSpec = spec(265.0, 10.0, 80.0);
const MIDLAND_IRON: ConeSpec = spec(180.0, 120.0, 130.0);
const MIDLAND_COPPER: ConeSpec = spec(340.0, 100.0, 80.0);
const STONE_LAKE: ConeSpec = spec(90.0, 500.0, 350.0);
const OPPOSITE_LAKE: ConeSpec = spec(270.0, 500.0, 450.0);
const OPPOSITE_SMALL_LAKE: ConeSpec = spec(265.0, 50.0, 50.0);
const LOWLAND_YUMAKO: ConeSpec = spec(235.0, 300.0, 140.0);
const LOWLAND_JELLYNUT: ConeSpec = spec(65.0, 290.0, 100.0);
const FERTILE_YUMAKO: ConeSpec = spec(235.0, 310.0, 40.0);
const FERTILE_JELLYNUT: ConeSpec = spec(65.0, 310.0, 40.0);
const ENEMIES_SAFE: ConeSpec = spec(40.0, 210.0, 30.0);
const ENEMIES_YUMAKO: ConeSpec = spec(210.0, 410.0, 30.0);
const ENEMIES_JELLYNUT: ConeSpec = spec(30.0, 410.0, 30.0);

/// Every starting cone of the planet, built once per render.
pub struct GlebaStarting {
    highland_main: StartingSpot,
    highland_small: StartingSpot,
    midland_landing: StartingSpot,
    midland_iron: StartingSpot,
    midland_copper: StartingSpot,
    stone_lake: StartingSpot,
    opposite_lake: StartingSpot,
    opposite_small_lake: StartingSpot,
    lowland_yumako: StartingSpot,
    lowland_jellynut: StartingSpot,
    fertile_yumako: StartingSpot,
    fertile_jellynut: StartingSpot,
    enemies_safe: StartingSpot,
    enemies_yumako: StartingSpot,
    enemies_jellynut: StartingSpot,
}

impl GlebaStarting {
    #[must_use]
    pub fn new(vars: &GlebaSeedVars) -> Self {
        let mult = area_multiplier();
        let cone = |s: ConeSpec| {
            // `gleba_starting_angle + K * gleba_starting_direction`, then the
            // cone's own `angle / 180 * pi` inside `AngleTrig::from_degrees`.
            let angle = f32r(vars.angle + f32r(s.angle_offset * vars.direction));
            StartingSpot {
                trig: AngleTrig::from_degrees(angle),
                distance: f32r(s.distance * mult),
                radius: f32r(s.radius * mult),
            }
        };
        Self {
            highland_main: cone(HIGHLAND_MAIN),
            highland_small: cone(HIGHLAND_SMALL),
            midland_landing: cone(MIDLAND_LANDING),
            midland_iron: cone(MIDLAND_IRON),
            midland_copper: cone(MIDLAND_COPPER),
            stone_lake: cone(STONE_LAKE),
            opposite_lake: cone(OPPOSITE_LAKE),
            opposite_small_lake: cone(OPPOSITE_SMALL_LAKE),
            lowland_yumako: cone(LOWLAND_YUMAKO),
            lowland_jellynut: cone(LOWLAND_JELLYNUT),
            fertile_yumako: cone(FERTILE_YUMAKO),
            fertile_jellynut: cone(FERTILE_JELLYNUT),
            enemies_safe: cone(ENEMIES_SAFE),
            enemies_yumako: cone(ENEMIES_YUMAKO),
            enemies_jellynut: cone(ENEMIES_JELLYNUT),
        }
    }

    /// Every cone group at `(x_from_start, y_from_start)`, with the distortions
    /// the Lua gives them: `gleba_wobble_x * 15` for the terrain cones and
    /// `* 20` for the enemy ones, on both axes.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64, wobble_x: f64) -> StartingFields {
        let d15 = f32r(wobble_x * 15.0);
        let d20 = f32r(wobble_x * 20.0);
        let at15 = |s: &StartingSpot| starting_spot_at_angle(s, x, y, d15, d15);
        let at20 = |s: &StartingSpot| starting_spot_at_angle(s, x, y, d20, d20);
        StartingFields {
            lakes: max(&[
                at15(&self.stone_lake),
                at15(&self.opposite_lake),
                at15(&self.opposite_small_lake),
            ]),
            lowlands: max(&[at15(&self.lowland_yumako), at15(&self.lowland_jellynut)]),
            fertile: max(&[at15(&self.fertile_yumako), at15(&self.fertile_jellynut)]),
            highlands: max(&[at15(&self.highland_main), at15(&self.highland_small)]),
            midlands: max(&[
                at15(&self.midland_landing),
                at15(&self.midland_iron),
                at15(&self.midland_copper),
            ]),
            enemies_safe: at20(&self.enemies_safe),
            enemies: max(&[at20(&self.enemies_yumako), at20(&self.enemies_jellynut)]),
        }
    }

    /// Only the two enemy groups, `(gleba_starting_enemies,
    /// gleba_starting_enemies_safe)`, which the pentapod nests read: the same
    /// values [`GlebaStarting::eval`] gives, without the other cones.
    #[must_use]
    pub fn enemies(&self, x: f64, y: f64, wobble_x: f64) -> (f64, f64) {
        let d20 = f32r(wobble_x * 20.0);
        let at20 = |s: &StartingSpot| starting_spot_at_angle(s, x, y, d20, d20);
        (
            max(&[at20(&self.enemies_yumako), at20(&self.enemies_jellynut)]),
            at20(&self.enemies_safe),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The direction is exactly -1 or 1 and follows the seed's parity.
    #[test]
    fn the_direction_follows_the_seed_parity() {
        assert_eq!(GlebaSeedVars::new(123_456).direction, -1.0);
        assert_eq!(GlebaSeedVars::new(123_457).direction, 1.0);
    }

    /// At 0.7 the multiplier is the f32 nearest 0.7, not the f64 literal.
    #[test]
    fn the_area_multiplier_is_the_f32_constant() {
        assert_eq!(area_multiplier(), f64::from(0.7f32));
        assert_ne!(area_multiplier(), 0.7);
    }
}
