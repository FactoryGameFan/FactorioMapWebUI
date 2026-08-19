//! The evaluation context, ported from `src/noise/eval/ctx.ts`.
//!
//! Every field maps to a game noise variable: `seed0 = map_seed`,
//! `water_level = 10*log2(control:water:size)`, `segmentation_multiplier =
//! control:water:frequency`, and the spawn and lake point lists.
//!
//! **`distance` is deliberately absent.** It is derived from
//! `starting_positions` at evaluation time, so there is one source of truth for
//! it rather than a stored copy that can drift from the list it came from. No
//! `control:*` constant is referenced by `elevation_lakes`, so none are plumbed.

use crate::distance_from_nearest_point::Point;
use crate::expressions::vulcanus_seed::{seed_normalized, seed_small};

/// `control:<resource>:frequency|size` for one Vulcanus resource.
///
/// Richness is deliberately absent: the client preview renders placement, not
/// yield, so no Vulcanus richness expression is ported.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResourceLevers {
    pub frequency: f64,
    pub size: f64,
}

impl Default for ResourceLevers {
    /// The neutral slider is `1`, not `0` - the same convention every autoplace
    /// control in this codebase uses.
    fn default() -> Self {
        Self {
            frequency: 1.0,
            size: 1.0,
        }
    }
}

/// The four Vulcanus resource autoplace controls, keyed by their in-code name.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct VulcanusResourceControls {
    pub tungsten_ore: ResourceLevers,
    pub vulcanus_coal: ResourceLevers,
    pub calcite: ResourceLevers,
    pub sulfuric_acid_geyser: ResourceLevers,
}

/// The complete free-variable environment the expression trees read.
#[derive(Debug, Clone, PartialEq)]
pub struct EvalCtx {
    pub x: f64,
    pub y: f64,
    pub seed0: u32,
    pub water_level: f64,
    pub segmentation_multiplier: f64,
    pub starting_positions: Vec<Point>,
    /// Lake points for `starting_lake_distance`.
    ///
    /// `None` means "compute the game's real positions from `(seed0,
    /// starting_positions)`", which `elevation_lakes` is the single owner of.
    /// An explicit value - **including an empty vector** - is honoured as-is.
    /// That distinction is why this is an `Option<Vec<_>>` rather than a `Vec`
    /// that happens to be empty.
    pub starting_lake_positions: Option<Vec<Point>>,

    /// `control:vulcanus_volcanism:frequency`, the wire value of the slider.
    ///
    /// Neutral is `1`, confirmed against the oracle -
    /// `vulcanus_scale_multiplier = slider_rescale(1, 3) = 1` at the default
    /// preset - and NOT `0`.
    pub vulcanus_volcanism_frequency: f64,
    /// `control:vulcanus_volcanism:size`. Neutral is `1`, as above.
    pub vulcanus_volcanism_size: f64,
    /// `control:temperature:bias`. Default `0`, meaning no bias.
    pub temperature_bias: f64,
    /// The four Vulcanus resource controls. Every other planet ignores these.
    pub vulcanus_resource_controls: VulcanusResourceControls,

    /// `map_seed_normalized`, the engine's own free variable.
    ///
    /// Defaulted from `seed0` by [`EvalCtx::new`]. Overriding it is for
    /// cross-checking a fixture that pins the value independent of `seed0`, not
    /// for ordinary use.
    pub map_seed_normalized: f32,
    /// `map_seed_small`, the engine's own free variable. See above.
    pub map_seed_small: u32,
}

impl EvalCtx {
    /// The far-from-spawn defaults, with both seed variables derived from
    /// `seed0`.
    ///
    /// The spawn list defaults to a single point at the origin, and it is a
    /// fresh allocation per call - the TypeScript comment about array defaults
    /// being fresh per call is enforced by the ownership rules here rather than
    /// by remembering.
    #[must_use]
    pub fn new(seed0: u32) -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            seed0,
            water_level: 0.0,
            segmentation_multiplier: 1.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            starting_lake_positions: None,
            vulcanus_volcanism_frequency: 1.0,
            vulcanus_volcanism_size: 1.0,
            temperature_bias: 0.0,
            vulcanus_resource_controls: VulcanusResourceControls::default(),
            map_seed_normalized: seed_normalized(seed0),
            map_seed_small: seed_small(seed0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_derive_both_seed_vars_from_seed0() {
        let ctx = EvalCtx::new(123_456);
        assert_eq!(ctx.map_seed_normalized, seed_normalized(123_456));
        assert_eq!(ctx.map_seed_small, seed_small(123_456));
        assert_eq!(ctx.map_seed_small, 57_920);
    }

    #[test]
    fn the_default_spawn_is_a_single_origin_point() {
        let ctx = EvalCtx::new(1);
        assert_eq!(ctx.starting_positions, vec![Point { x: 0.0, y: 0.0 }]);
        assert!(ctx.starting_lake_positions.is_none());
    }

    /// An explicitly EMPTY lake list is not the same as an absent one: absent
    /// means "derive the real positions", empty means "there are none".
    #[test]
    fn an_empty_lake_list_is_distinguishable_from_an_absent_one() {
        let mut ctx = EvalCtx::new(1);
        ctx.starting_lake_positions = Some(Vec::new());
        assert_eq!(ctx.starting_lake_positions.as_deref(), Some(&[][..]));
        assert!(ctx.starting_lake_positions.is_some());
    }

    #[test]
    fn the_neutral_resource_slider_is_one_not_zero() {
        let c = VulcanusResourceControls::default();
        assert_eq!(c.tungsten_ore.frequency, 1.0);
        assert_eq!(c.tungsten_ore.size, 1.0);
        assert_eq!(c.sulfuric_acid_geyser.size, 1.0);
    }
}
