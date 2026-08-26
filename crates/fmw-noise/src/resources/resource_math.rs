//! The `distance`-dependent local functions and scalar local_expressions of
//! `resource_autoplace_all_patches` (`core/prototypes/noise-functions.lua`),
//! ported from `src/noise/resources/resourceMath.ts`.
//!
//! Pure math, no RNG - the spot RNG lives in [`super::regular_patches`].
//!
//! `controls` are the `frequency_multiplier` / `size_multiplier`
//! (= `control:<x>:frequency` / `control:<x>:size`). `sign` mirrors the Lua
//! `has_starting_area_placement` ternary argument: -1 (no special starting
//! area), 0 (false), 1 (true). None of the six base resources pass nil, so
//! `sign` is 1 (iron/copper/coal/stone) or 0 (oil/uranium) - the `sign == -1`
//! branches never fire for them, but are kept for fidelity.
//!
//! ## This module narrows NOTHING, and that asymmetry is deliberate
//!
//! `resourceMath.ts` contains no `f32` call at all. Its arithmetic is f64 and
//! the only narrowing anywhere in it happens inside `fast_cbrt`, which takes an
//! `f32` argument. Every other file in this layer is dense in per-operation
//! narrowing. Do not harmonise the two: the cone in `regular_patches` is
//! rendered by the game's f32 noise machine per tile, and these scalars are
//! local_expressions the machine folds once.

use crate::eval::math::{max2, min2, PI};
use crate::fast_approx::fast_cbrt;

use super::nauvis_catalog::ResourceParams;

/// `double_density_distance`.
pub const DOUBLE_DENSITY_DISTANCE: f64 = 1300.0;
/// `regular_patch_fade_in_distance`.
pub const REGULAR_PATCH_FADE_IN_DISTANCE: f64 = 300.0;
/// `starting_resource_placement_radius`.
///
/// **150, and that is a 2.1.9 value.** It was 120 through 2.0.77. See
/// `docs/nauvis-resources-port-survey.md` for the other seven constants that
/// moved in the same window.
pub const STARTING_RESOURCE_PLACEMENT_RADIUS: f64 = 150.0;

/// `(params.regular_blob_amplitude_multiplier or 1) / 8`.
const REGULAR_BLOB_AMPLITUDE_MULTIPLIER: f64 = 1.0 / 8.0;
/// `(params.starting_blob_amplitude_multiplier or 1) / 8`.
const STARTING_BLOB_AMPLITUDE_MULTIPLIER: f64 = 1.0 / 8.0;
/// `starting_patches_split`.
const STARTING_PATCHES_SPLIT: f64 = 0.5;

/// `control:<x>:frequency` and `control:<x>:size`, as the noise-function
/// multipliers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResourceControls {
    pub frequency: f64,
    pub size: f64,
}

/// All three `control:<res>:frequency|size|richness` levers for one resource.
///
/// The TypeScript declares this in `resolveResource.ts` and passes a
/// structural `{ frequency, size, richness }` literal to the three patch
/// builders. Rust has no structural typing, so the three would each need their
/// own named type; one type beside [`ResourceControls`] is the same thing said
/// once. [`ResourceControls`] stays separate because the patch builders
/// deliberately hand the math layer only two of the three - richness never
/// reaches a field value, only the wrapper that scales it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResourceControlLevers {
    pub frequency: f64,
    pub size: f64,
    pub richness: f64,
}

impl ResourceControlLevers {
    /// All three levers at the game's default of 1.
    #[must_use]
    pub const fn defaults() -> Self {
        Self {
            frequency: 1.0,
            size: 1.0,
            richness: 1.0,
        }
    }

    /// The two levers the math layer reads.
    #[must_use]
    pub const fn controls(&self) -> ResourceControls {
        ResourceControls {
            frequency: self.frequency,
            size: self.size,
        }
    }
}

/// `Math.min(Math.max(v, lo), hi)`, written as the TypeScript writes it.
///
/// NOT [`crate::eval::math::clamp`], which is the comparison form
/// `v < lo ? lo : v > hi ? hi : v`. The two differ on a negative zero: with
/// `lo = 0`, `Math.max(-0, 0)` is `+0` while the comparison form returns `-0`
/// unchanged. No reachable input here produces a `-0` numerator, so this is
/// fidelity rather than a fix - but the argument order is inventoried in the
/// port survey for a reason, and picking the other helper would quietly change
/// which one this is.
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    min2(max2(v, lo), hi)
}

/// -1 (no starting area), 0 (false), 1 (true). Base resources are only 1 or 0.
fn starting_sign(params: &ResourceParams) -> i8 {
    i8::from(params.has_starting_area_placement)
}

/// `size_effective_distance_at(distance)`.
#[must_use]
pub fn size_effective_distance_at(distance: f64, params: &ResourceParams) -> f64 {
    if starting_sign(params) == -1 {
        distance
    } else {
        distance - REGULAR_PATCH_FADE_IN_DISTANCE
    }
}

/// `regular_density_at(distance)`: base density scaled by the controls, the
/// spawn fade-in, and the double-density ramp.
#[must_use]
pub fn regular_density_at(
    distance: f64,
    params: &ResourceParams,
    controls: &ResourceControls,
) -> f64 {
    let fade_in = if starting_sign(params) == -1 {
        1.0
    } else {
        clamp(
            (distance - STARTING_RESOURCE_PLACEMENT_RADIUS) / REGULAR_PATCH_FADE_IN_DISTANCE,
            0.0,
            1.0,
        )
    };
    let double_up = 1.0
        + clamp(
            size_effective_distance_at(distance, params) / DOUBLE_DENSITY_DISTANCE,
            0.0,
            1.0,
        );
    // Left to right, exactly as the TypeScript writes the product.
    params.base_density * controls.frequency * controls.size * fade_in * double_up
}

/// `regular_spot_quantity_base_at(distance)`: stuff per spot before the
/// `random_penalty` jitter.
///
/// **Two sequential divides, not `1e6 / (spots * frequency)`.** Every fixture
/// case has `frequency = 1`, so the second divide is by one and the fixtures
/// cannot tell the two forms apart - measured, by folding the field values with
/// the divides collapsed and getting the identical checksum. Off the default
/// control they differ, so the form is kept.
#[must_use]
pub fn regular_spot_quantity_base_at(
    distance: f64,
    params: &ResourceParams,
    controls: &ResourceControls,
) -> f64 {
    (1_000_000.0 / params.base_spots_per_km2 / controls.frequency)
        * regular_density_at(distance, params, controls)
}

/// `regular_spot_height_typical_at(distance)`: the typical cone peak there.
///
/// The game's noise machine evaluates this cube root through its fastapprox
/// `pow`, so [`fast_cbrt`] is required and not an approximation of convenience:
/// an exact `cbrt` leaves a ~7e-5 relative error that dominates the blob term.
/// See `docs/noise/random-penalty-NOTES.md`.
#[must_use]
pub fn regular_spot_height_typical_at(
    distance: f64,
    params: &ResourceParams,
    controls: &ResourceControls,
) -> f64 {
    let mean_size = (params.random_spot_size_min + params.random_spot_size_max) / 2.0;
    let q = mean_size * regular_spot_quantity_base_at(distance, params, controls);
    f64::from(fast_cbrt(q as f32))
        / ((PI / 3.0) * params.regular_rq_factor * params.regular_rq_factor)
}

/// `regular_blob_amplitude_maximum_distance`.
#[must_use]
pub fn regular_blob_amplitude_maximum_distance(params: &ResourceParams) -> f64 {
    if starting_sign(params) == -1 {
        DOUBLE_DENSITY_DISTANCE
    } else {
        DOUBLE_DENSITY_DISTANCE + REGULAR_PATCH_FADE_IN_DISTANCE
    }
}

/// `regular_blob_amplitude_at(distance)`.
#[must_use]
pub fn regular_blob_amplitude_at(
    distance: f64,
    params: &ResourceParams,
    controls: &ResourceControls,
) -> f64 {
    let at_max = regular_spot_height_typical_at(
        regular_blob_amplitude_maximum_distance(params),
        params,
        controls,
    );
    let at_d = regular_spot_height_typical_at(distance, params, controls);
    // Max-distance value first, as the TypeScript writes it.
    REGULAR_BLOB_AMPLITUDE_MULTIPLIER * min2(at_max, at_d)
}

/// `starting_amount`: total resource "stuff" allotted to the starting area,
/// before the split.
#[must_use]
pub fn starting_amount(params: &ResourceParams, controls: &ResourceControls) -> f64 {
    20000.0 * params.base_density * (controls.frequency + 1.0) * controls.size
}

/// `starting_area_spot_quantity`: `starting_amount` spread across the
/// starting-area spots. Two sequential divides, as written.
#[must_use]
pub fn starting_area_spot_quantity(params: &ResourceParams, controls: &ResourceControls) -> f64 {
    starting_amount(params, controls) / STARTING_PATCHES_SPLIT / controls.frequency
}

/// `starting_modulation(distance)`: 1 inside the starting-area placement
/// radius, 0 outside (the boundary itself is outside).
#[must_use]
pub fn starting_modulation(distance: f64) -> f64 {
    if distance < STARTING_RESOURCE_PLACEMENT_RADIUS {
        1.0
    } else {
        0.0
    }
}

/// `starting_density_at(distance)`: `starting_amount` spread over the
/// starting-area disc, gated by `starting_modulation`.
#[must_use]
pub fn starting_density_at(
    distance: f64,
    params: &ResourceParams,
    controls: &ResourceControls,
) -> f64 {
    (starting_amount(params, controls)
        / (PI * STARTING_RESOURCE_PLACEMENT_RADIUS * STARTING_RESOURCE_PLACEMENT_RADIUS))
        * starting_modulation(distance)
}

/// `starting_spot_radius`: the typical starting-area spot radius.
///
/// Exported and read by NOTHING in this layer - `starting_patches` recomputes
/// the same product inline and narrowed to f32, because the cone it feeds is
/// rendered in the f32 noise machine. It is kept because the TypeScript exports
/// it and `test/resourceMath.spec.ts` grades it.
#[must_use]
pub fn starting_spot_radius(params: &ResourceParams, controls: &ResourceControls) -> f64 {
    params.starting_rq_factor
        * f64::from(fast_cbrt(
            starting_area_spot_quantity(params, controls) as f32
        ))
}

/// `starting_favorability_base_at(distance, elevation)`.
///
/// ```text
/// starting_resources_lake_mask * starting_modulation * origin_excluder * 2
///   - min(1, distance / starting_resource_placement_radius)
/// ```
///
/// where `starting_resources_lake_mask = clamp((elevation - 1)/10, 0, 1)`,
/// `origin_excluder = distance > 40` (avoid the crash site) and
/// `starting_modulation = starting_resource_placement_radius > distance`.
///
/// **In 2.1.9+ this is DETERMINISTIC** - the `random_penalty_at(0.5, 1)` term
/// the 2.0.77 expression carried is gone, and so is the separate lake field.
/// `params` and `controls` are unused today and kept for a stable signature
/// across the starting-patch local functions, matching the TypeScript.
#[must_use]
pub fn starting_favorability_base_at(
    distance: f64,
    elevation: f64,
    _params: &ResourceParams,
    _controls: &ResourceControls,
) -> f64 {
    let origin_excluder = if distance > 40.0 { 1.0 } else { 0.0 };
    clamp((elevation - 1.0) / 10.0, 0.0, 1.0) * starting_modulation(distance) * origin_excluder
        * 2.0
        // Literal first, as the TypeScript writes it.
        - min2(1.0, distance / STARTING_RESOURCE_PLACEMENT_RADIUS)
}

/// `starting_blob_amplitude` - a scalar, referenced by `basement_value` even
/// for a regular-only resource.
#[must_use]
pub fn starting_blob_amplitude(params: &ResourceParams, controls: &ResourceControls) -> f64 {
    (STARTING_BLOB_AMPLITUDE_MULTIPLIER
        / ((PI / 3.0) * params.starting_rq_factor * params.starting_rq_factor))
        * f64::from(fast_cbrt(
            starting_area_spot_quantity(params, controls) as f32
        ))
}

/// `basement_value = -6 * max(regular_blob_amplitude_at(max_distance), starting_blob_amplitude)`.
///
/// The constant floor the spot field is initialised to and clamped at. Both
/// `spot_noise` calls in the expression share it, which is why it references
/// the starting term even for oil and uranium.
///
/// **This scalar is where the port's whole measured distance from the game
/// lives** (#261). Substituting an exact cube root for [`fast_cbrt`] in the two
/// amplitudes above moves it by -0.6118 / -0.4069 / -0.3599 for iron / uranium
/// / copper, against measured offsets of +0.6143 / +0.4081 / +0.3616 - three
/// resources within half a percent each. It is NOT changed here: a finding in
/// the shipped TypeScript gets its own graded change, or a unilateral fix on
/// this side reads as a port bug in tier 2.
#[must_use]
pub fn basement_value(params: &ResourceParams, controls: &ResourceControls) -> f64 {
    let regular = regular_blob_amplitude_at(
        regular_blob_amplitude_maximum_distance(params),
        params,
        controls,
    );
    // Regular first, as the TypeScript writes it.
    -6.0 * max2(regular, starting_blob_amplitude(params, controls))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::nauvis_catalog::resource_by_name;

    const DEFAULTS: ResourceControls = ResourceControls {
        frequency: 1.0,
        size: 1.0,
    };

    fn iron() -> &'static ResourceParams {
        resource_by_name("iron-ore").expect("iron is in the catalog")
    }

    #[test]
    fn the_fade_in_and_double_density_ramps_have_the_shape_the_lua_gives_them() {
        let p = iron();
        // Inside the starting radius the regular density is zero, which is what
        // makes regular spots near spawn get quantity 0 and be skipped.
        assert_eq!(regular_density_at(0.0, p, &DEFAULTS), 0.0);
        assert_eq!(regular_density_at(150.0, p, &DEFAULTS), 0.0);
        // Fully faded in at 150 + 300, still before the double-density ramp.
        assert_eq!(
            regular_density_at(450.0, p, &DEFAULTS),
            10.0 * 1.0 * (1.0 + 150.0 / 1300.0)
        );
        // The ramp saturates at fade-in + double-density distance.
        assert_eq!(regular_density_at(1600.0, p, &DEFAULTS), 20.0);
        assert_eq!(regular_density_at(99999.0, p, &DEFAULTS), 20.0);
    }

    #[test]
    fn size_effective_distance_subtracts_the_fade_in_for_every_base_resource() {
        // The `sign == -1` branch is unreachable for all six, so this pins that
        // the OTHER branch is the one every resource takes - a port that had
        // the ternary inverted would still produce a plausible ramp.
        for p in crate::resources::nauvis_catalog::NAUVIS_RESOURCE_CATALOG.iter() {
            assert_eq!(size_effective_distance_at(1000.0, p), 700.0, "{}", p.name);
            assert_eq!(
                regular_blob_amplitude_maximum_distance(p),
                1600.0,
                "{}",
                p.name
            );
        }
    }

    #[test]
    fn starting_modulation_excludes_its_own_boundary() {
        // `starting_resource_placement_radius > distance`, so 150 itself is
        // OUTSIDE. A `>=` would extend every starting patch by a ring.
        assert_eq!(starting_modulation(149.999), 1.0);
        assert_eq!(starting_modulation(150.0), 0.0);
        assert_eq!(starting_modulation(150.001), 0.0);
    }

    #[test]
    fn the_origin_excluder_keeps_starting_spots_off_the_crash_site() {
        // New in 2.1.9: `origin_excluder = "distance > 40"`. Without it the
        // favorability peaks at spawn and the game buries the crash site.
        let p = iron();
        let high_elevation = 20.0;
        let at_30 = starting_favorability_base_at(30.0, high_elevation, p, &DEFAULTS);
        let at_50 = starting_favorability_base_at(50.0, high_elevation, p, &DEFAULTS);
        assert!(at_30 < 0.0, "inside 40 the mask is zeroed: {at_30}");
        assert!(
            at_50 > 1.0,
            "outside 40 it is the lake mask times two: {at_50}"
        );
        assert_eq!(
            starting_favorability_base_at(40.0, high_elevation, p, &DEFAULTS),
            -40.0 / 150.0
        );
    }

    #[test]
    fn the_lake_mask_clamps_and_the_distance_term_clamps() {
        let p = iron();
        // Below water the mask is 0, so favorability is just the distance term.
        assert_eq!(
            starting_favorability_base_at(100.0, 0.5, p, &DEFAULTS),
            -100.0 / 150.0
        );
        // The distance term is `min(1, d / 150)`, clamped - a 2.1.9 change.
        // Beyond the radius the modulation zeroes the mask too, so it is -1 flat.
        assert_eq!(
            starting_favorability_base_at(300.0, 99.0, p, &DEFAULTS),
            -1.0
        );
        assert_eq!(
            starting_favorability_base_at(9999.0, 99.0, p, &DEFAULTS),
            -1.0
        );
    }

    #[test]
    fn the_basement_is_the_larger_of_the_two_blob_amplitudes_times_minus_six() {
        // Iron's regular amplitude wins its max, and that is worth pinning: a
        // port that took the starting term would be 8.5x too shallow and every
        // patch edge would sit in the wrong place.
        let p = iron();
        let regular = regular_blob_amplitude_at(1600.0, p, &DEFAULTS);
        let starting = starting_blob_amplitude(p, &DEFAULTS);
        assert!(regular > starting, "{regular} vs {starting}");
        assert_eq!(basement_value(p, &DEFAULTS), -6.0 * regular);
    }

    #[test]
    fn a_regular_only_resource_still_reads_the_starting_blob_amplitude() {
        // Oil and uranium have no starting placement, and the basement STILL
        // references the starting term because both `spot_noise` calls in the
        // expression share one basement. Dropping it would be invisible for
        // iron (whose regular term wins anyway) and wrong for anything whose
        // starting term is the larger.
        for name in ["crude-oil", "uranium-ore"] {
            let p = resource_by_name(name).expect(name);
            assert!(!p.has_starting_area_placement);
            assert!(starting_blob_amplitude(p, &DEFAULTS) > 0.0, "{name}");
        }
    }

    #[test]
    fn starting_spot_radius_is_the_unnarrowed_twin_of_the_cone_radius_base() {
        // `starting_patches` recomputes this product in f32. The two are the
        // same number widened differently, and this pins that they agree to
        // f32 - if they ever stop, one of the two moved.
        let p = iron();
        let here = starting_spot_radius(p, &DEFAULTS);
        let narrowed = f64::from(
            (p.starting_rq_factor
                * f64::from(fast_cbrt(starting_area_spot_quantity(p, &DEFAULTS) as f32)))
                as f32,
        );
        assert_eq!(here as f32, narrowed as f32);
    }

    #[test]
    fn the_controls_reach_the_scalars_they_belong_to() {
        // Every fixture case runs at frequency = size = 1, so a control dropped
        // on the floor would be invisible to tier 1 entirely.
        let p = iron();
        let base = starting_area_spot_quantity(p, &DEFAULTS);
        let freq = ResourceControls {
            frequency: 2.0,
            size: 1.0,
        };
        let size = ResourceControls {
            frequency: 1.0,
            size: 2.0,
        };
        assert_ne!(starting_area_spot_quantity(p, &freq), base, "frequency");
        assert_ne!(starting_area_spot_quantity(p, &size), base, "size");
        assert_ne!(
            regular_density_at(1000.0, p, &freq),
            regular_density_at(1000.0, p, &DEFAULTS),
            "frequency reaches the regular density"
        );
        assert_ne!(
            regular_density_at(1000.0, p, &size),
            regular_density_at(1000.0, p, &DEFAULTS),
            "size reaches the regular density"
        );
    }

    #[test]
    fn frequency_cancels_out_of_the_regular_quantity_base_but_only_algebraically() {
        // `(1e6 / spots / f) * (baseDensity * f * size * ...)`: the `f`
        // divides out. So MORE frequency means more spots of the SAME size,
        // which is the knob's whole meaning - and it also means this scalar is
        // a poor place to look for a dropped frequency lever.
        //
        // It cancels EXACTLY at 2, and does not at 0.3. That is the two
        // sequential divides showing: the algebra is exact, the arithmetic is
        // not, and which one you get depends on the value. Worth knowing before
        // reading an unchanged number here as a dropped control.
        let p = iron();
        let base = regular_spot_quantity_base_at(1000.0, p, &DEFAULTS);
        for f in [0.5, 2.0, 3.0] {
            let c = ResourceControls {
                frequency: f,
                size: 1.0,
            };
            assert_eq!(
                regular_spot_quantity_base_at(1000.0, p, &c),
                base,
                "at f = {f}"
            );
        }
        let awkward = ResourceControls {
            frequency: 0.3,
            size: 1.0,
        };
        assert_ne!(regular_spot_quantity_base_at(1000.0, p, &awkward), base);
    }

    #[test]
    fn the_two_sequential_divides_are_not_one_divide_by_a_product() {
        // Off the default control the two forms differ in the last bits, and
        // no fixture can see it because every case has frequency = 1. Pinned
        // here so the collapse cannot be made silently.
        let p = iron();
        let c = ResourceControls {
            frequency: 0.3,
            size: 1.0,
        };
        let two = 1_000_000.0 / p.base_spots_per_km2 / c.frequency;
        let one = 1_000_000.0 / (p.base_spots_per_km2 * c.frequency);
        assert_ne!(two, one);
        assert_eq!(
            regular_spot_quantity_base_at(1000.0, p, &c),
            two * regular_density_at(1000.0, p, &c)
        );
    }

    #[test]
    fn the_cube_roots_go_through_fastapprox_and_not_through_an_exact_cbrt() {
        // The single most consequential line in the layer: an exact cbrt here
        // moves `basement_value` by ~0.61 on iron (#261). Pinned as a
        // DISAGREEMENT so that swapping in `f64::cbrt` turns this red rather
        // than quietly re-baselining every frozen residual.
        let p = iron();
        let q = starting_area_spot_quantity(p, &DEFAULTS);
        assert_ne!(f64::from(fast_cbrt(q as f32)), q.cbrt());
        let amp = starting_blob_amplitude(p, &DEFAULTS);
        let exact = (STARTING_BLOB_AMPLITUDE_MULTIPLIER
            / ((PI / 3.0) * p.starting_rq_factor * p.starting_rq_factor))
            * q.cbrt();
        assert_ne!(amp, exact);
        assert!(
            (amp - exact).abs() / exact < 1e-4,
            "and it is a small gap, not a wrong formula"
        );
    }
}
