//! Vulcanus's climate fields, ported from
//! `src/noise/expressions/vulcanusClimate.ts`.
//!
//! `vulcanus_aux` and `vulcanus_moisture`, transcribed from
//! `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` lines ~117-159.
//!
//! **`vulcanus_temperature` is deliberately absent**, on the same reasoning the
//! TypeScript records: it reads `vulcanus_elev`, which does not exist until the
//! elevation chain lands, and wiring it half-finished would mean a field graded
//! against nothing. It joins this module when elevation does.
//!
//! Both fields are bare `multioctave_noise` calls with no world-space offset -
//! unlike Nauvis, whose `moisture` and `aux` are built on
//! `quick_multioctave_noise` - so they go straight to [`Prepared`] rather than
//! through a helper wrapper.
//!
//! The two crack fields they read (`vulcanus_flood_paths` for `aux`,
//! `vulcanus_flood_cracks_a` for `moisture`) arrive as an already-evaluated
//! [`CrackFields`] rather than being recomputed, which is what keeps the whole
//! Vulcanus chain a single pass per point.

use crate::eval::math::{clamp, min2};
use crate::expressions::vulcanus_cracks::CrackFields;
use crate::multioctave_noise::{MultioctaveParams, Prepared};
use crate::poison;

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ClimateFields {
    pub aux: f64,
    pub moisture: f64,
}

/// The per-render constants of Vulcanus's climate layer.
pub struct VulcanusClimate {
    aux: Prepared,
    moisture_a: Prepared,
    moisture_b: Prepared,
}

impl VulcanusClimate {
    /// Build the layer for one seed.
    #[must_use]
    pub fn new(seed0: u32) -> Self {
        Self {
            aux: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 2,
                octaves: 5.0,
                persistence: 0.6,
                input_scale: 0.2,
                output_scale: 0.6,
            }),
            moisture_a: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 4,
                octaves: 2.0,
                persistence: 0.6,
                input_scale: 0.025,
                output_scale: 0.25,
            }),
            // The odd input scale is a literal in the Lua, not a rounded
            // version of anything. Transcribed digit for digit.
            moisture_b: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 400,
                octaves: 3.0,
                persistence: 0.62,
                input_scale: 0.051_144_353,
                output_scale: 0.25,
            }),
        }
    }

    /// Evaluate both fields at one position, given this point's crack fields.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64, cracks: &CrackFields) -> ClimateFields {
        // `min` before `clamp`, and in this argument order - see the note in
        // `vulcanus_cracks` on why `min2` rather than `f64::min`.
        let aux = clamp(
            min2(
                f64::from(self.aux.eval(x, y)).abs(),
                0.3 - 0.6 * cracks.flood_paths,
            ),
            0.0,
            1.0,
        );

        // Three subtractions from 1, left to right, then clamped. Each `abs`
        // applies to its own noise term rather than to the running total.
        let moisture = clamp(
            1.0 - f64::from(self.moisture_a.eval(x, y)).abs()
                - f64::from(self.moisture_b.eval(x, y)).abs()
                - 0.2 * cracks.flood_cracks_a,
            0.0,
            1.0,
        );

        ClimateFields {
            aux: poison::f64_result(aux),
            moisture,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::ctx::EvalCtx;
    use crate::expressions::vulcanus_cracks::VulcanusCracks;
    use crate::expressions::vulcanus_helpers::VulcanusHelpers;

    fn layers() -> (VulcanusCracks, VulcanusClimate) {
        let helpers = VulcanusHelpers::new(&EvalCtx::new(123_456));
        let cracks = VulcanusCracks::new(&helpers);
        (cracks, VulcanusClimate::new(123_456))
    }

    /// Both fields are clamped to `[0, 1]`, which every downstream biome
    /// comparison assumes.
    #[test]
    fn both_fields_stay_inside_the_unit_interval() {
        let (cracks, climate) = layers();
        for k in 0..200 {
            let (x, y) = (f64::from(k) * 9.5 - 700.0, f64::from(k) * -4.75 + 250.0);
            let f = climate.eval(x, y, &cracks.eval(x, y));
            assert!((0.0..=1.0).contains(&f.aux), "aux {} at {x},{y}", f.aux);
            assert!(
                (0.0..=1.0).contains(&f.moisture),
                "moisture {} at {x},{y}",
                f.moisture
            );
        }
    }

    /// `aux` reads `flood_paths` and `moisture` reads `flood_cracks_a`. Wiring
    /// them the other way round would still produce plausible climate, so each
    /// dependency is checked by moving one crack field and watching only the
    /// field that reads it change.
    ///
    /// **The `flood_paths` nudge has to go UP**, and that is a property of the
    /// expression rather than a detail of this test. `aux` is
    /// `min(abs(noise), 0.3 - 0.6 * flood_paths)`, so lowering `flood_paths`
    /// raises the second arm and the `min` simply keeps choosing the first -
    /// the dependency is real but invisible in that direction. Written down
    /// because the first draft moved it down, watched `aux` not move, and the
    /// failure looks exactly like a missing wire.
    #[test]
    fn each_climate_field_reads_its_own_crack_field() {
        let (cracks, climate) = layers();
        let (x, y) = (137.5, -244.25);
        let base_cracks = cracks.eval(x, y);
        let base = climate.eval(x, y, &base_cracks);

        let mut moved_paths = base_cracks;
        moved_paths.flood_paths += 2.0;
        let a = climate.eval(x, y, &moved_paths);
        assert_ne!(a.aux, base.aux, "aux ignored flood_paths");
        assert_eq!(a.moisture, base.moisture, "moisture read flood_paths");

        let mut moved_cracks_a = base_cracks;
        moved_cracks_a.flood_cracks_a += 1.0;
        let m = climate.eval(x, y, &moved_cracks_a);
        assert_eq!(m.aux, base.aux, "aux read flood_cracks_a");
        assert_ne!(m.moisture, base.moisture, "moisture ignored flood_cracks_a");
    }

    /// The two moisture terms are different fields, not one read twice. Their
    /// seeds are 4 and 400, which is an easy digit to drop.
    #[test]
    fn the_two_moisture_terms_are_different_fields() {
        let climate = VulcanusClimate::new(123_456);
        let mut differ = 0usize;
        for k in 1..64 {
            let (x, y) = (f64::from(k) * 7.5, f64::from(k) * -3.25);
            if climate.moisture_a.eval(x, y) != climate.moisture_b.eval(x, y) {
                differ += 1;
            }
        }
        assert!(differ > 60, "only {differ} of 63 readings differ");
    }
}
