//! The outer `resource_autoplace_all_patches` expression, ported from
//! `src/noise/resources/resourcePatches.ts`.
//!
//! ```text
//! all_patches = if(has_starting_area_placement == 1,
//!                  max(starting_patches, regular_patches),
//!                  regular_patches)
//! ```
//!
//! ## An enum, not a trait object
//!
//! Oil and uranium have no starting field, and the TypeScript returns the
//! `RegularPatches` object itself for them - structural subtyping makes that a
//! zero-cost "delegate verbatim". Rust has no structural subtyping, so the
//! choice is an enum or a `Box<dyn>`. The enum is what keeps the
//! delegate-verbatim property visible: [`ResourcePatches::RegularOnly`] calls
//! straight through to the same three methods, so oil's wrapper math -
//! `random_probability`, `additional_richness` - stays in one place rather than
//! being re-derived here. A trait object would hide which of the two is running.

use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{max2, min2};

use super::nauvis_catalog::ResourceParams;
use super::regular_patches::{richness_distance_factor, RegularPatches, RegularPatchesCtx};
use super::resource_math::ResourceControlLevers;
use super::starting_patches::{StartingPatches, StartingPatchesCtx};

/// Everything one `all_patches` field needs.
#[derive(Clone, Debug)]
pub struct ResourcePatchesCtx {
    pub seed0: u32,
    pub controls: ResourceControlLevers,
    pub starting_positions: Vec<Point>,
    /// Elevation inputs for the starting favorability. Read only by the solids.
    pub segmentation_multiplier: f64,
    pub water_level: f64,
    pub starting_lake_positions: Option<Vec<Point>>,
    /// Regular set skip params. 1/0 for the isolated oracle; 6/index in the app.
    pub regular_skip_span: usize,
    pub regular_skip_offset: usize,
    /// Starting set skip params. 1/0 for the isolated oracle; 4/index in the app.
    pub starting_skip_span: usize,
    pub starting_skip_offset: usize,
}

impl ResourcePatchesCtx {
    /// The game's default controls at one seed, spawning at the origin, with
    /// both sets unpartitioned - the isolated-oracle configuration.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            controls: ResourceControlLevers::defaults(),
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            segmentation_multiplier: 1.0,
            water_level: 0.0,
            starting_lake_positions: None,
            regular_skip_span: 1,
            regular_skip_offset: 0,
            starting_skip_span: 1,
            starting_skip_offset: 0,
        }
    }
}

/// The compiled `all_patches` field for one resource at one seed.
pub enum ResourcePatches {
    /// Oil and uranium: no starting placement, so this IS the regular field.
    RegularOnly(RegularPatches),
    /// The four solids: `max(starting_patches, regular_patches)`.
    ///
    /// `starting` is BOXED. A `StartingPatches` owns a whole `ElevationNauvis`
    /// tree, so this variant is several kilobytes against `RegularOnly`'s one,
    /// and every `ResourcePatches` - oil's included - would otherwise be sized
    /// for the larger. It is a representation change and nothing else: the box
    /// is built once per resource, never on a per-pixel path.
    Combined {
        starting: Box<StartingPatches>,
        regular: RegularPatches,
        params: ResourceParams,
        levers: ResourceControlLevers,
        spawn: Vec<Point>,
    },
}

impl ResourcePatches {
    #[must_use]
    pub fn new(params: &ResourceParams, ctx: &ResourcePatchesCtx) -> Self {
        let regular = RegularPatches::new(
            params,
            &RegularPatchesCtx {
                seed0: ctx.seed0,
                controls: ctx.controls,
                starting_positions: ctx.starting_positions.clone(),
                skip_span: ctx.regular_skip_span,
                skip_offset: ctx.regular_skip_offset,
            },
        );

        if !params.has_starting_area_placement {
            return Self::RegularOnly(regular);
        }

        let starting = StartingPatches::new(
            params,
            &StartingPatchesCtx {
                seed0: ctx.seed0,
                controls: ctx.controls,
                starting_positions: ctx.starting_positions.clone(),
                segmentation_multiplier: ctx.segmentation_multiplier,
                water_level: ctx.water_level,
                starting_lake_positions: ctx.starting_lake_positions.clone(),
                skip_span: ctx.starting_skip_span,
                skip_offset: ctx.starting_skip_offset,
            },
        );

        Self::Combined {
            starting: Box::new(starting),
            regular,
            params: *params,
            levers: ctx.controls,
            spawn: ctx.starting_positions.clone(),
        }
    }

    /// The raw `all_patches` field value.
    #[must_use]
    pub fn field(&self, x: f64, y: f64) -> f64 {
        match self {
            Self::RegularOnly(regular) => regular.field(x, y),
            // STARTING FIRST, as the TypeScript writes it. `max2` rather than
            // `f64::max`, for the signed-zero reason recorded on it.
            Self::Combined {
                starting, regular, ..
            } => max2(starting.field(x, y), regular.field(x, y)),
        }
    }

    /// `clamp(field, 0, 1)` - the solid-footprint probability.
    #[must_use]
    pub fn probability(&self, x: f64, y: f64) -> f64 {
        match self {
            Self::RegularOnly(regular) => regular.probability(x, y),
            Self::Combined { levers, .. } => {
                if levers.size > 0.0 {
                    min2(max2(self.field(x, y), 0.0), 1.0)
                } else {
                    0.0
                }
            }
        }
    }

    /// The autoplace richness at `(x, y)`, 0 where `size <= 0`.
    ///
    /// The four solids all have `random_probability = 1`, `additional_richness
    /// = 0` and `minimum_richness = 0`, so the general wrapper
    /// [`RegularPatches::richness`] carries reduces to this. It is written out
    /// rather than shared, matching the TypeScript - and the reduction is
    /// asserted in `the_combined_richness_reduction_holds_for_every_solid`, so
    /// it is a checked property rather than a comment.
    #[must_use]
    pub fn richness(&self, x: f64, y: f64) -> f64 {
        match self {
            Self::RegularOnly(regular) => regular.richness(x, y),
            Self::Combined {
                params,
                levers,
                spawn,
                ..
            } => {
                if levers.size <= 0.0 {
                    return 0.0;
                }
                let distance = f64::from(distance_from_nearest_point(x, y, spawn, f64::INFINITY));
                params.richness_post_multiplier
                    * levers.richness
                    * self.field(x, y)
                    * richness_distance_factor(distance)
            }
        }
    }

    /// The `regular_patches` half, for a caller that needs the branches apart.
    ///
    /// Test-only, along with [`Self::starting`]: the shipped consumers all read
    /// the combined field. Tier 1 needs the branches apart to count the
    /// positions where NEITHER reached a cone.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn regular(&self) -> &RegularPatches {
        match self {
            Self::RegularOnly(regular) | Self::Combined { regular, .. } => regular,
        }
    }

    /// The `starting_patches` half, absent for oil and uranium. Test-only, see
    /// [`Self::regular`].
    #[cfg(test)]
    #[must_use]
    pub(crate) fn starting(&self) -> Option<&StartingPatches> {
        match self {
            Self::RegularOnly(_) => None,
            Self::Combined { starting, .. } => Some(starting),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::nauvis_catalog::{resource_by_name, NAUVIS_RESOURCE_CATALOG};

    #[test]
    fn oil_and_uranium_delegate_verbatim_to_the_regular_field() {
        // Not "produce the same numbers" - the same object. A wrapper re-derived
        // here would drop oil's `random_probability` divide and its 220,000
        // `additional_richness`, and the field would still look right.
        for name in ["crude-oil", "uranium-ore"] {
            let params = resource_by_name(name).expect(name);
            let all = ResourcePatches::new(params, &ResourcePatchesCtx::defaults(123_456));
            assert!(matches!(all, ResourcePatches::RegularOnly(_)), "{name}");
            assert!(all.starting().is_none(), "{name}");
            let regular = RegularPatches::new(params, &RegularPatchesCtx::defaults(123_456));
            for &(x, y) in &[(700.5, -300.25), (1500.5, 0.25), (0.5, 0.25)] {
                assert_eq!(all.field(x, y), regular.field(x, y), "{name} field");
                assert_eq!(
                    all.probability(x, y),
                    regular.probability(x, y),
                    "{name} probability"
                );
                assert_eq!(
                    all.richness(x, y),
                    regular.richness(x, y),
                    "{name} richness"
                );
            }
        }
    }

    #[test]
    fn a_solid_is_the_max_of_its_two_branches_with_starting_first() {
        let params = resource_by_name("iron-ore").expect("iron");
        let all = ResourcePatches::new(params, &ResourcePatchesCtx::defaults(123_456));
        let starting = all.starting().expect("a solid has a starting branch");
        let regular = all.regular();
        for i in 0..40 {
            let x = f64::from(i) * 23.5 - 400.0;
            let y = 71.25;
            assert_eq!(
                all.field(x, y),
                max2(starting.field(x, y), regular.field(x, y)),
                "at ({x}, {y})"
            );
        }
    }

    #[test]
    fn each_branch_wins_the_outer_max_somewhere() {
        // Anti-vacuity for the test above: if the starting branch never won,
        // `max(starting, regular)` would be indistinguishable from `regular`
        // and the whole M3b half of this layer would be untested.
        let params = resource_by_name("iron-ore").expect("iron");
        let all = ResourcePatches::new(params, &ResourcePatchesCtx::defaults(123_456));
        let starting = all.starting().expect("a solid has a starting branch");
        let regular = all.regular();
        let mut starting_wins = 0;
        let mut regular_wins = 0;
        for i in 0..300 {
            let x = f64::from(i) * 9.5 - 700.0;
            let y = f64::from(i) * 4.25 - 200.0;
            let s = starting.field(x, y);
            let r = regular.field(x, y);
            if s > r {
                starting_wins += 1;
            } else if r > s {
                regular_wins += 1;
            }
        }
        assert!(
            starting_wins > 0 && regular_wins > 0,
            "starting won {starting_wins}, regular won {regular_wins}"
        );
    }

    #[test]
    fn the_combined_richness_reduction_holds_for_every_solid() {
        // The four solids all have `random_probability = 1`,
        // `additional_richness = 0` and `minimum_richness = 0`, which is why
        // the combined wrapper is allowed to be three terms instead of six.
        // Checked against the general form rather than asserted in a comment,
        // so a catalog edit that broke the premise turns this red.
        for params in NAUVIS_RESOURCE_CATALOG
            .iter()
            .filter(|p| p.has_starting_area_placement)
        {
            assert_eq!(params.random_probability, 1.0, "{}", params.name);
            assert_eq!(params.additional_richness, 0.0, "{}", params.name);
            assert_eq!(params.minimum_richness, 0.0, "{}", params.name);

            let all = ResourcePatches::new(params, &ResourcePatchesCtx::defaults(123_456));
            let (x, y) = (211.5, -88.25);
            let general = {
                let mut r = all.field(x, y) / params.random_probability;
                r += params.additional_richness;
                params.richness_post_multiplier
                    * 1.0
                    * r
                    * richness_distance_factor(f64::from(distance_from_nearest_point(
                        x,
                        y,
                        &[Point { x: 0.0, y: 0.0 }],
                        f64::INFINITY,
                    )))
            };
            assert_eq!(all.richness(x, y), general, "{}", params.name);
        }
    }

    #[test]
    fn a_disabled_size_control_zeroes_both_wrappers_on_both_variants() {
        let ctx = ResourcePatchesCtx {
            controls: ResourceControlLevers {
                frequency: 1.0,
                size: 0.0,
                richness: 1.0,
            },
            ..ResourcePatchesCtx::defaults(123_456)
        };
        for name in ["iron-ore", "uranium-ore"] {
            let params = resource_by_name(name).expect(name);
            let all = ResourcePatches::new(params, &ctx);
            assert_eq!(all.probability(120.5, 33.25), 0.0, "{name}");
            assert_eq!(all.richness(120.5, 33.25), 0.0, "{name}");
        }
    }

    #[test]
    fn the_probability_saturates_inside_a_patch_and_is_zero_outside() {
        // What makes `placement: Threshold` the right rule for the five
        // non-oil resources: the probability is not a gradient, it is a
        // footprint. If it never reached 1 the threshold would carve patches
        // smaller than the game's.
        let params = resource_by_name("iron-ore").expect("iron");
        let all = ResourcePatches::new(params, &ResourcePatchesCtx::defaults(123_456));
        // A 2D sweep, not a line: ore patches are sparse enough that a single
        // diagonal through 400 points found no ore at all on the first try.
        let mut ones = 0;
        let mut zeros = 0;
        let mut between = 0;
        for i in 0..70 {
            for j in 0..70 {
                let x = f64::from(i) * 16.5 - 600.0;
                let y = f64::from(j) * 16.25 - 600.0;
                let p = all.probability(x, y);
                assert!((0.0..=1.0).contains(&p));
                if p == 1.0 {
                    ones += 1;
                } else if p == 0.0 {
                    zeros += 1;
                } else {
                    between += 1;
                }
            }
        }
        assert!(ones > 0 && zeros > 0, "ones {ones}, zeros {zeros}");
        assert!(
            between * 20 < ones + zeros,
            "the footprint is a gradient, not a footprint: {between} interior points"
        );
    }
}
