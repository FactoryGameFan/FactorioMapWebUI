//! The order-priority overlay resolver, ported from
//! `src/noise/resources/resolveResource.ts`.
//!
//! At a world tile, which resource patch (if any) is drawn. The game places
//! resources in autoplace `order` sequence and a later patch overwrites an
//! earlier one where they overlap; the preview mirrors that by letting the
//! FIRST resource in order priority whose `probability >= 0.5` win.
//!
//! Priority is autoplace `order` (`"b"` before `"c"`), then `patch_set_index`
//! within an order. All six resources share one candidate stream partitioned by
//! `skip_span = 6` / `skip_offset = patch_set_index` for the regular set, and
//! the four solids share another partitioned by `skip_span = 4` / the same
//! offset - the solids register first, so their starting-set index equals their
//! regular `patch_set_index`.
//!
//! ## Crude oil is deliberately absent from the result
//!
//! It is the one `placement: Roll` resource, and a roll needs the chunk stream
//! and the collision gate that a per-tile pure resolver cannot express. The
//! renderer paints it in its own pass. **Leaving oil in this loop is what used
//! to paint its whole patch extent as solid ore** - 1,234 tiles against the
//! game's 8 entities in `[0,0]-[512,512]`.
//!
//! [`pick_winner`] still ranks oil correctly; it is a pure priority function
//! over whatever it is handed. [`compare_priority`] is public for the same
//! reason the TypeScript exports it: the renderer needs the same rule for a
//! resource this resolver does not hold, and two copies of the rule is how the
//! oil-versus-uranium inversion of #22 item 3 got in.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::distance_from_nearest_point::Point;

use super::nauvis_catalog::{
    ResourceOrder, ResourceParams, ResourcePlacement, NAUVIS_RESOURCE_CATALOG,
};
use super::resource_math::ResourceControlLevers;
use super::resource_patches::{ResourcePatches, ResourcePatchesCtx};

/// The regular set shares one candidate stream across all six resources.
pub const REGULAR_SKIP_SPAN: usize = 6;
/// The starting set shares one candidate stream across the four solids.
pub const STARTING_SKIP_SPAN: usize = 4;

/// Everything the resolver needs.
#[derive(Clone, Debug)]
pub struct ResourceResolverCtx {
    pub seed0: u32,
    /// Per-resource control levers, keyed by `control_name`. A missing entry is
    /// all-default.
    pub controls: BTreeMap<String, ResourceControlLevers>,
    pub starting_positions: Vec<Point>,
    /// Elevation inputs for the starting favorability coupling (solids only).
    pub segmentation_multiplier: f64,
    pub water_level: f64,
    pub starting_lake_positions: Option<Vec<Point>>,
}

impl ResourceResolverCtx {
    /// Every resource at the game's default controls, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            controls: BTreeMap::new(),
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            segmentation_multiplier: 1.0,
            water_level: 0.0,
            starting_lake_positions: None,
        }
    }
}

fn order_rank(o: ResourceOrder) -> i32 {
    match o {
        ResourceOrder::B => 0,
        ResourceOrder::C => 1,
    }
}

/// Draw priority between two resources: [`Ordering::Less`] when `a` is drawn in
/// preference to `b`.
///
/// The TypeScript is `orderRank(a) - orderRank(b) || a.index - b.index`, and
/// JavaScript's `||` falls through on 0 - so in Rust it is `then`, not a
/// two-key tuple comparison written by hand.
#[must_use]
pub fn compare_priority(a: &ResourceParams, b: &ResourceParams) -> Ordering {
    order_rank(a.order)
        .cmp(&order_rank(b.order))
        .then(a.patch_set_index.cmp(&b.patch_set_index))
}

/// The order-priority winner among the resources present at a tile, or `None`.
///
/// Pure - the field evaluation lives in [`ResourceResolver`]. Ties keep the
/// EARLIER element, because the TypeScript replaces `best` only on a strict
/// `< 0`.
#[must_use]
pub fn pick_winner<'a>(present: &[&'a ResourceParams]) -> Option<&'a ResourceParams> {
    let mut best: Option<&'a ResourceParams> = None;
    for p in present {
        if best.is_none_or(|b| compare_priority(p, b) == Ordering::Less) {
            best = Some(p);
        }
    }
    best
}

/// The compiled resolver over the THRESHOLD catalog resources whose `size`
/// control is above 0.
pub struct ResourceResolver {
    /// Pre-sorted by [`compare_priority`], so the first present resource is the
    /// winner and no per-tile `present` list has to be built.
    fields: Vec<(&'static ResourceParams, ResourcePatches)>,
}

impl ResourceResolver {
    #[must_use]
    pub fn new(ctx: &ResourceResolverCtx) -> Self {
        let mut fields: Vec<(&'static ResourceParams, ResourcePatches)> = Vec::new();
        for params in NAUVIS_RESOURCE_CATALOG.iter() {
            // Roll resources - crude oil alone - are not thresholded and are
            // not resolved here. See the module header.
            if params.placement == ResourcePlacement::Roll {
                continue;
            }
            let levers = ctx
                .controls
                .get(params.control_name)
                .copied()
                .unwrap_or_else(ResourceControlLevers::defaults);
            // A disabled resource never appears.
            if levers.size <= 0.0 {
                continue;
            }
            let patches = ResourcePatches::new(
                params,
                &ResourcePatchesCtx {
                    seed0: ctx.seed0,
                    controls: levers,
                    starting_positions: ctx.starting_positions.clone(),
                    segmentation_multiplier: ctx.segmentation_multiplier,
                    water_level: ctx.water_level,
                    starting_lake_positions: ctx.starting_lake_positions.clone(),
                    regular_skip_span: REGULAR_SKIP_SPAN,
                    regular_skip_offset: params.patch_set_index,
                    starting_skip_span: STARTING_SKIP_SPAN,
                    starting_skip_offset: params.patch_set_index,
                },
            );
            fields.push((params, patches));
        }
        fields.sort_by(|a, b| compare_priority(a.0, b.0));
        Self { fields }
    }

    /// The resource drawn at `(x, y)`, or `None`.
    #[must_use]
    pub fn resolve(&self, x: f64, y: f64) -> Option<&'static ResourceParams> {
        for (params, patches) in &self.fields {
            if patches.probability(x, y) >= 0.5 {
                return Some(params);
            }
        }
        None
    }

    /// The resources this resolver holds, in priority order.
    #[must_use]
    pub fn resources(&self) -> Vec<&'static ResourceParams> {
        self.fields.iter().map(|(p, _)| *p).collect()
    }

    /// One held resource's field, by `control_name`.
    #[must_use]
    pub(crate) fn patches(&self, control_name: &str) -> Option<&ResourcePatches> {
        self.fields
            .iter()
            .find(|(p, _)| p.control_name == control_name)
            .map(|(_, patches)| patches)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::nauvis_catalog::resource_by_name;

    fn p(name: &str) -> &'static ResourceParams {
        resource_by_name(name).expect(name)
    }

    #[test]
    fn order_beats_index_and_index_breaks_a_tie_within_an_order() {
        // Uranium is index 5 and oil is index 4, both order "c"; iron is index
        // 0 and order "b". The inversion #22 item 3 shipped was exactly a
        // comparator that got one of these two keys the wrong way round.
        assert_eq!(
            compare_priority(p("iron-ore"), p("uranium-ore")),
            Ordering::Less
        );
        assert_eq!(
            compare_priority(p("uranium-ore"), p("iron-ore")),
            Ordering::Greater
        );
        assert_eq!(
            compare_priority(p("crude-oil"), p("uranium-ore")),
            Ordering::Less
        );
        assert_eq!(
            compare_priority(p("iron-ore"), p("copper-ore")),
            Ordering::Less
        );
        assert_eq!(compare_priority(p("stone"), p("crude-oil")), Ordering::Less);
        assert_eq!(
            compare_priority(p("iron-ore"), p("iron-ore")),
            Ordering::Equal
        );
    }

    #[test]
    fn pick_winner_keeps_the_earlier_element_on_a_tie_and_ignores_input_order() {
        // The TypeScript replaces `best` only on a strict `< 0`. A `<=` would
        // keep the LAST of a tie instead, which no ordering test would catch
        // because ties are between a resource and itself.
        assert_eq!(pick_winner(&[]), None);
        assert_eq!(
            pick_winner(&[p("uranium-ore"), p("stone"), p("crude-oil")]).map(|r| r.name),
            Some("stone")
        );
        assert_eq!(
            pick_winner(&[p("stone"), p("uranium-ore"), p("crude-oil")]).map(|r| r.name),
            Some("stone")
        );
        // Oil still ranks correctly even though the resolver never holds it.
        assert_eq!(
            pick_winner(&[p("uranium-ore"), p("crude-oil")]).map(|r| r.name),
            Some("crude-oil")
        );
    }

    #[test]
    fn the_resolver_holds_five_resources_in_priority_order_and_never_oil() {
        let r = ResourceResolver::new(&ResourceResolverCtx::defaults(123_456));
        let names: Vec<&str> = r.resources().iter().map(|p| p.name).collect();
        assert_eq!(
            names,
            vec!["iron-ore", "copper-ore", "coal", "stone", "uranium-ore"]
        );
        assert!(
            r.patches("crude-oil").is_none(),
            "oil must not be resolved here"
        );
    }

    #[test]
    fn a_disabled_resource_is_dropped_rather_than_held_at_zero() {
        // Dropped, so it costs nothing to build - which matters because
        // building a solid constructs a whole `elevation_nauvis` tree.
        let mut ctx = ResourceResolverCtx::defaults(123_456);
        ctx.controls.insert(
            "coal".to_string(),
            ResourceControlLevers {
                frequency: 1.0,
                size: 0.0,
                richness: 1.0,
            },
        );
        let r = ResourceResolver::new(&ctx);
        let names: Vec<&str> = r.resources().iter().map(|p| p.name).collect();
        assert_eq!(
            names,
            vec!["iron-ore", "copper-ore", "stone", "uranium-ore"]
        );
    }

    #[test]
    fn a_missing_control_entry_is_all_default_rather_than_zero() {
        // `unwrap_or(defaults())`, not `unwrap_or_default()`. A zeroed lever
        // would silently drop every resource the caller did not name.
        let named = ResourceResolver::new(&ResourceResolverCtx::defaults(123_456));
        let mut ctx = ResourceResolverCtx::defaults(123_456);
        ctx.controls
            .insert("iron-ore".to_string(), ResourceControlLevers::defaults());
        let explicit = ResourceResolver::new(&ctx);
        assert_eq!(named.resources().len(), explicit.resources().len());
        for i in 0..80 {
            let (x, y) = (f64::from(i) * 27.5 - 900.0, 143.25);
            assert_eq!(
                named.resolve(x, y).map(|r| r.name),
                explicit.resolve(x, y).map(|r| r.name)
            );
        }
    }

    #[test]
    fn the_skip_partition_is_applied_and_changes_the_field() {
        // The resolver builds with span 6 / offset = index, unlike the isolated
        // oracle's span 1. If the partition were dropped, every resource would
        // draw from the same unpartitioned stream and their patches would sit
        // on top of each other.
        let r = ResourceResolver::new(&ResourceResolverCtx::defaults(123_456));
        let held = r.patches("iron-ore").expect("iron is held");
        let unpartitioned =
            ResourcePatches::new(p("iron-ore"), &ResourcePatchesCtx::defaults(123_456));
        // A 2D sweep, not a line. Away from a cone both fields are
        // `basement + blob`, and neither term reads the skip params - so a line
        // that misses every patch compares two identical numbers and reports
        // agreement. The first line tried here did exactly that.
        let mut differs = 0;
        let mut total = 0;
        for i in 0..40 {
            for j in 0..40 {
                let x = f64::from(i) * 51.5 - 900.0;
                let y = f64::from(j) * 49.25 - 900.0;
                total += 1;
                if held.field(x, y) != unpartitioned.field(x, y) {
                    differs += 1;
                }
            }
        }
        assert!(
            differs > 0,
            "the skip partition is not reaching the field ({differs}/{total})"
        );
    }

    #[test]
    fn resolve_returns_the_first_present_resource_in_priority_order() {
        // Equivalence between the short-circuit loop and the explicit
        // `pick_winner` over everything present. They are two statements of one
        // rule, and the fast one is the one that ships.
        let r = ResourceResolver::new(&ResourceResolverCtx::defaults(123_456));
        let mut found = 0;
        for i in 0..500 {
            let x = f64::from(i) * 7.5 - 800.0;
            let y = f64::from(i) * 3.25 - 300.0;
            let present: Vec<&ResourceParams> = r
                .fields
                .iter()
                .filter(|(_, patches)| patches.probability(x, y) >= 0.5)
                .map(|(p, _)| *p)
                .collect();
            let expected = pick_winner(&present).map(|p| p.name);
            assert_eq!(r.resolve(x, y).map(|p| p.name), expected, "at ({x}, {y})");
            if expected.is_some() {
                found += 1;
            }
        }
        assert!(
            found > 0,
            "no resource was resolved anywhere, so this is vacuous"
        );
    }
}
