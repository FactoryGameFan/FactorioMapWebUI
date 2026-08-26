//! The six Nauvis resources and their `resource_autoplace_settings`, ported
//! from `src/noise/resources/resourceCatalog.ts`.
//!
//! Copied from `base/prototypes/entity/resources.lua` plus the defaults in
//! `core/lualib/resource-autoplace.lua`, in the order `initialize_patch_set`
//! registers them (iron, copper, coal, stone, crude-oil, uranium) - which is
//! also their `regular_patch_set_index`.
//!
//! ## The rq factors stay DIVISIONS
//!
//! They are written `1.1 / 10.0` and `1.5 / 7.0` rather than folded to
//! decimals, because `1.1 / 10.0` is not bitwise `0.11` in f64. Folding them
//! changes the number that reaches `fast_cbrt`, and the TypeScript writes them
//! as divisions for the same reason.

/// Autoplace `order`. `"b"` resources are drawn in preference to `"c"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ResourceOrder {
    /// Autoplace order `"b"` - the four solid ores.
    B,
    /// Autoplace order `"c"` - crude oil and uranium.
    C,
}

/// How a resource decides where it is drawn.
///
/// - [`Threshold`](ResourcePlacement::Threshold) - draw wherever
///   `probability >= 0.5`, i.e. paint the patch as a solid footprint. Right for
///   the five resources whose `random_probability` is 1: their probability is
///   `clamp(all_patches, 0, 1)`, which saturates to 1 inside a patch and is 0
///   outside, so the threshold *is* the patch boundary.
/// - [`Roll`](ResourcePlacement::Roll) - draw where the game's per-tile
///   placement draw beats the probability, subject to the tile and collision
///   gates. Right for crude oil alone, whose probability carries a
///   `random_penalty{source = 1, amplitude = 48}` factor that is positive on
///   only ~1 tile in 48. Thresholding it paints the whole patch extent as solid
///   ore, where the game puts down a handful of individual wells: measured at
///   **1,234 tiles against the game's 8 entities** in `[0,0]-[512,512]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourcePlacement {
    /// Draw wherever `probability >= 0.5`.
    Threshold,
    /// Draw where the per-tile placement roll succeeds.
    Roll,
}

/// One resource's `resource_autoplace_settings`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResourceParams {
    /// Entity/prototype name, e.g. `"iron-ore"`.
    pub name: &'static str,
    /// Autoplace control name (= `name` for base resources).
    pub control_name: &'static str,
    /// Autoplace order: `"b"` resources beat `"c"` in the overlay.
    pub order: ResourceOrder,
    /// `regular_patch_set_index` (init order 0..5); also the `skip_offset`.
    pub patch_set_index: usize,
    pub base_density: f64,
    pub base_spots_per_km2: f64,
    pub candidate_spot_count: usize,
    /// `regular_rq_factor_multiplier / 10`.
    pub regular_rq_factor: f64,
    /// `starting_rq_factor_multiplier / 7`. Needed for `basement_value` even
    /// where there is no starting placement.
    pub starting_rq_factor: f64,
    pub seed1: u32,
    pub random_probability: f64,
    pub random_spot_size_min: f64,
    pub random_spot_size_max: f64,
    pub additional_richness: f64,
    pub minimum_richness: f64,
    pub richness_post_multiplier: f64,
    pub has_starting_area_placement: bool,
    /// `map_color`, scaled to 0..255 and rounded.
    pub map_color: [u8; 3],
    /// How the renderer turns this entry into pixels.
    pub placement: ResourcePlacement,
}

/// `map_color` (0..1) -> 0..255, rounded, matching the game's preview tint.
///
/// `(v * 255.0 + 0.5) as u8` rather than `.round()`, because `f64::round` is
/// not a `const fn` and this has to build a `static`. Truncation of `v + 0.5`
/// IS round-half-up for a non-negative `v`, which every `map_color` component
/// is - and round-half-up is what JavaScript's `Math.round` does, where
/// `f64::round` would be round-half-away-from-zero. The two agree on
/// non-negative inputs; `color255_matches_rust_round` pins that rather than
/// leaving it as a claim.
const fn color255(v: f64) -> u8 {
    (v * 255.0 + 0.5) as u8
}

/// Defaults for a base solid ore: order `"b"`, starting placement, no specials.
const fn solid_ore(
    name: &'static str,
    patch_set_index: usize,
    base_density: f64,
    regular_rq_factor_multiplier: f64,
    starting_rq_factor_multiplier: f64,
    candidate_spot_count: usize,
    map_color: [u8; 3],
) -> ResourceParams {
    ResourceParams {
        name,
        control_name: name,
        order: ResourceOrder::B,
        patch_set_index,
        base_density,
        base_spots_per_km2: 2.5,
        candidate_spot_count,
        regular_rq_factor: regular_rq_factor_multiplier / 10.0,
        starting_rq_factor: starting_rq_factor_multiplier / 7.0,
        seed1: 100,
        random_probability: 1.0,
        random_spot_size_min: 0.25,
        random_spot_size_max: 2.0,
        additional_richness: 0.0,
        minimum_richness: 0.0,
        richness_post_multiplier: 1.0,
        has_starting_area_placement: true,
        map_color,
        placement: ResourcePlacement::Threshold,
    }
}

/// The six Nauvis resources, in `patch_set_index` order.
pub static NAUVIS_RESOURCE_CATALOG: [ResourceParams; 6] = [
    solid_ore(
        "iron-ore",
        0,
        10.0,
        1.1,
        1.5,
        22,
        [color255(0.415), color255(0.525), color255(0.58)],
    ),
    solid_ore(
        "copper-ore",
        1,
        8.0,
        1.1,
        1.2,
        22,
        [color255(0.803), color255(0.388), color255(0.215)],
    ),
    solid_ore(
        "coal",
        2,
        8.0,
        1.0,
        1.1,
        21,
        [color255(0.0), color255(0.0), color255(0.0)],
    ),
    solid_ore(
        "stone",
        3,
        4.0,
        1.0,
        1.1,
        21,
        [color255(0.69), color255(0.611), color255(0.427)],
    ),
    ResourceParams {
        name: "crude-oil",
        control_name: "crude-oil",
        order: ResourceOrder::C,
        patch_set_index: 4,
        base_density: 8.2,
        base_spots_per_km2: 1.8,
        candidate_spot_count: 21,
        regular_rq_factor: 1.0 / 10.0,
        starting_rq_factor: 1.0 / 7.0,
        seed1: 100,
        random_probability: 1.0 / 48.0,
        random_spot_size_min: 1.0,
        random_spot_size_max: 1.0,
        additional_richness: 220_000.0,
        minimum_richness: 0.0,
        richness_post_multiplier: 1.0,
        has_starting_area_placement: false,
        map_color: [color255(0.78), color255(0.2), color255(0.77)],
        // The one roll resource. `random_probability = 1/48` puts a
        // `random_penalty{source = 1, amplitude = 48}` factor on oil's
        // probability and nothing else in this catalog carries one.
        placement: ResourcePlacement::Roll,
    },
    ResourceParams {
        name: "uranium-ore",
        control_name: "uranium-ore",
        order: ResourceOrder::C,
        patch_set_index: 5,
        base_density: 0.9,
        base_spots_per_km2: 1.25,
        candidate_spot_count: 21,
        regular_rq_factor: 1.0 / 10.0,
        starting_rq_factor: 1.0 / 7.0,
        seed1: 100,
        random_probability: 1.0,
        random_spot_size_min: 2.0,
        random_spot_size_max: 4.0,
        additional_richness: 0.0,
        minimum_richness: 0.0,
        richness_post_multiplier: 1.0,
        has_starting_area_placement: false,
        map_color: [color255(0.0), color255(0.7), color255(0.0)],
        // Uranium shares oil's autoplace order "c" but NOT its penalty:
        // `random_probability` is 1 here, so its probability saturates inside a
        // patch like the four solids' and a threshold is the right rule.
        placement: ResourcePlacement::Threshold,
    },
];

/// One catalog entry by prototype name.
#[must_use]
pub fn resource_by_name(name: &str) -> Option<&'static ResourceParams> {
    NAUVIS_RESOURCE_CATALOG.iter().find(|r| r.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color255_matches_rust_round_on_every_reachable_input() {
        // The `const fn` cannot call `f64::round`, so it uses `v + 0.5`
        // truncation instead. That is only equal to rounding for a
        // non-negative input, which is what a `map_color` component is. Swept
        // rather than argued: 100,001 points across the whole legal range, plus
        // every exact half so the tie rule is exercised on purpose.
        for i in 0..=100_000u32 {
            let v = f64::from(i) / 100_000.0;
            assert_eq!(
                color255(v),
                (v * 255.0).round() as u8,
                "color255 disagrees with round at {v}"
            );
        }
        for k in 0..255u32 {
            let v = (f64::from(k) + 0.5) / 255.0;
            assert_eq!(color255(v), (v * 255.0).round() as u8, "tie at {v}");
        }
    }

    #[test]
    fn the_rq_factors_are_divisions_and_not_their_decimal_lookalikes() {
        // `1.1 / 10.0` is 0.11000000000000001 and the literal `0.11` is
        // 0.11000000000000000055 - a different f64. The value feeds a
        // `fast_cbrt` and then a squared divisor, so the difference is not
        // absorbed. This is the guard that a later tidy-up cannot fold them.
        let iron = resource_by_name("iron-ore").expect("iron is in the catalog");
        assert_eq!(iron.regular_rq_factor, 1.1 / 10.0);
        assert_ne!(iron.regular_rq_factor, 0.11);
        assert_eq!(iron.starting_rq_factor, 1.5 / 7.0);
    }

    #[test]
    fn the_catalog_is_in_patch_set_index_order_and_names_are_unique() {
        // `patch_set_index` doubles as the skip offset into a shared candidate
        // stream, so a catalog whose order and indices disagree would partition
        // the stream wrongly while still producing plausible patches.
        for (i, r) in NAUVIS_RESOURCE_CATALOG.iter().enumerate() {
            assert_eq!(r.patch_set_index, i, "{} is out of order", r.name);
            assert_eq!(r.control_name, r.name, "{} control name", r.name);
        }
        for (i, a) in NAUVIS_RESOURCE_CATALOG.iter().enumerate() {
            for b in NAUVIS_RESOURCE_CATALOG.iter().skip(i + 1) {
                assert_ne!(a.name, b.name);
            }
        }
    }

    #[test]
    fn only_crude_oil_rolls_and_only_the_four_solids_have_starting_placement() {
        let rolls: Vec<&str> = NAUVIS_RESOURCE_CATALOG
            .iter()
            .filter(|r| r.placement == ResourcePlacement::Roll)
            .map(|r| r.name)
            .collect();
        assert_eq!(rolls, vec!["crude-oil"]);

        let starting: Vec<&str> = NAUVIS_RESOURCE_CATALOG
            .iter()
            .filter(|r| r.has_starting_area_placement)
            .map(|r| r.name)
            .collect();
        assert_eq!(starting, vec!["iron-ore", "copper-ore", "coal", "stone"]);

        // The four that have starting placement register FIRST, which is why
        // `resolve_resource` can reuse `patch_set_index` as the starting-set
        // skip offset. If a fifth ever gained starting placement out of order,
        // that reuse would silently partition the starting stream wrongly.
        for r in NAUVIS_RESOURCE_CATALOG.iter() {
            assert_eq!(
                r.has_starting_area_placement,
                r.patch_set_index < 4,
                "{} breaks the starting-set index reuse",
                r.name
            );
        }
    }

    #[test]
    fn uranium_shares_oils_order_but_not_its_penalty() {
        let oil = resource_by_name("crude-oil").expect("oil");
        let uranium = resource_by_name("uranium-ore").expect("uranium");
        assert_eq!(oil.order, uranium.order);
        assert_eq!(oil.random_probability, 1.0 / 48.0);
        assert_eq!(uranium.random_probability, 1.0);
        assert_eq!(uranium.placement, ResourcePlacement::Threshold);
    }
}
