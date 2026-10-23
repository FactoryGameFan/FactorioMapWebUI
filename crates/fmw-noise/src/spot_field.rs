//! The spot-noise query shared by every planet that uses `spot_noise`.
//!
//! Lifted out of `expressions/vulcanus_resources.rs` so Aquilo's three spot
//! fields can reuse it. Vulcanus is bit-identical across the move, graded by
//! `the_shared_spot_query_is_the_vulcanus_one_bit_for_bit` there, which was
//! frozen against the old code first.
//!
//! ## What is shared, and what is not
//!
//! Shared: the region arithmetic ([`SpotGeometry`]), the region cache
//! ([`SpotRegionCache`]) and the cone walk ([`spot_cone_max`]). Not shared: how
//! a region's spots are SELECTED, and what the radius is. Those depend on the
//! planet's density, favorability and size expressions, so each caller passes
//! them in as closures.
//!
//! ## The region cache is real state
//!
//! A query at `(x, y)` reads selected spots from every region within the
//! basement radius, which is genuine cross-position state. It is a
//! `RefCell<BTreeMap>` keyed by the caller's key plus the region. The key `K`
//! must hold EVERY spec field that shapes the selected spots, not just `seed1`:
//! Aquilo's three wells share `seed1` 567 and, at default sliders, region size
//! 1000, and differ only in count, skip offset and radius. The f64 fields go in
//! as `to_bits`, and `region_size` is kept UNFLOORED so 833.3 and 833.9 stay
//! apart even though the selection floors both.
//!
//! `BTreeMap` rather than `HashMap`: nothing iterates it, but a
//! determinism-critical port should not carry a container whose iteration order
//! is unspecified.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::poison;
use crate::spot_selection::SelectedSpot;

/// The region math of one `spot_noise` call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpotGeometry {
    /// `region_size` BEFORE the floor - `base + base / frequency`, which is
    /// fractional at a non-default frequency slider.
    pub region_size: f64,
    /// `maximum_spot_basement_radius` - the per-query cone cull radius.
    pub max_basement_radius: f64,
    /// `basement_value`, the field's value where no cone reaches.
    pub basement_value: f64,
}

impl SpotGeometry {
    /// `Math.floor(region_size)`.
    ///
    /// `select_spots` uses this as an integer modulus. Only the default
    /// (frequency 1, an exact integer) is oracle-covered.
    #[must_use]
    pub fn floored_region_size(&self) -> i64 {
        self.region_size.floor() as i64
    }

    /// `Math.floor(rs / 2)`, matching `spotSelection`'s own `half` exactly.
    ///
    /// Identical to `rs / 2` at every oracle-covered region size (1000, 900 and
    /// 800 are all even), but it must not silently diverge at an odd `rs` that a
    /// non-default frequency slider can reach - frequency 1.5 gives 833.
    #[must_use]
    pub fn half(&self) -> i64 {
        self.floored_region_size() / 2
    }

    /// The region a coordinate falls in. Regions are centred on multiples of the
    /// size, which is why this offsets by half before dividing.
    #[must_use]
    pub fn region_index(&self, c: f64) -> i64 {
        ((c + self.half() as f64) / self.floored_region_size() as f64).floor() as i64
    }
}

/// Selected spots by `(key, region_x, region_y)`.
pub struct SpotRegionCache<K: Ord + Copy> {
    map: RefCell<BTreeMap<(K, i64, i64), Vec<SelectedSpot>>>,
}

impl<K: Ord + Copy> Default for SpotRegionCache<K> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K: Ord + Copy> SpotRegionCache<K> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            map: RefCell::new(BTreeMap::new()),
        }
    }

    /// The cached spots of one region, selecting them on a miss.
    ///
    /// `select` runs OUTSIDE any borrow of the map, because selection can
    /// re-enter the layer that owns this cache.
    pub fn get_or_select(
        &self,
        key: K,
        region_x: i64,
        region_y: i64,
        select: impl FnOnce() -> Vec<SelectedSpot>,
    ) -> Vec<SelectedSpot> {
        let cache_key = (key, region_x, region_y);
        if let Some(hit) = self.map.borrow().get(&cache_key) {
            return hit.clone();
        }
        let spots = select();
        self.map.borrow_mut().insert(cache_key, spots.clone());
        spots
    }
}

/// The highest cone over every spot within the basement radius of `(sx, sy)`.
///
/// `spots_in(region_x, region_y)` yields one region's selected spots.
/// `radius_at(spot)` is the spot's radius BEFORE the `cone_scale` multiply and
/// the f32 narrowing, both of which happen here. `hard_region_target_quantity =
/// 0` means `cone_scale` is always 1, but it is still applied so the cone math
/// stays faithful if that ever changes.
///
/// The game's effective radius is `min(maximum_spot_basement_radius,
/// radius_expression)`. That cap is deliberately omitted: it is unreachable from
/// every reachable Vulcanus UI state (the radius is at most `2 * 1.2 * 25 = 60`,
/// under 128), and the TypeScript omits it for the same reason.
pub fn spot_cone_max(
    geometry: &SpotGeometry,
    sx: f64,
    sy: f64,
    mut spots_in: impl FnMut(i64, i64) -> Vec<SelectedSpot>,
    radius_at: impl Fn(&SelectedSpot) -> f64,
) -> f64 {
    let max_r = geometry.max_basement_radius;
    let mut best = geometry.basement_value;
    let r_x = geometry.region_index(sx - max_r)..=geometry.region_index(sx + max_r);
    for region_x in r_x {
        let r_y = geometry.region_index(sy - max_r)..=geometry.region_index(sy + max_r);
        for region_y in r_y {
            for s in spots_in(region_x, region_y) {
                let dx = sx - s.x as f64;
                let dy = sy - s.y as f64;
                let d2 = dx * dx + dy * dy;
                if d2 > max_r * max_r {
                    continue;
                }
                let radius = f64::from((radius_at(&s) * s.cone_scale) as f32);
                if radius <= 0.0 {
                    continue;
                }
                // Same f32 cone arithmetic as the Nauvis regular patches:
                // the game renders the cone in the f32 noise machine.
                let numerator = f64::from((3.0 * s.quantity) as f32);
                let area =
                    f64::from((f64::from((std::f64::consts::PI * radius) as f32) * radius) as f32);
                let peak = f64::from((numerator / area) as f32);
                let slope = f64::from((peak / radius) as f32);
                let cone = f64::from(
                    (peak - f64::from((f64::from(d2.sqrt() as f32) * slope) as f32)) as f32,
                );
                if cone > best {
                    best = cone;
                }
            }
        }
    }
    // The cone arithmetic above is the one op that nothing upstream already
    // covers - `select_spots` carries its own hook.
    poison::f64_result(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry(region_size: f64) -> SpotGeometry {
        SpotGeometry {
            region_size,
            max_basement_radius: 128.0,
            basement_value: -1.0,
        }
    }

    /// The default frequency gives an exact integer, so the floor is inert -
    /// which is exactly why it needs a case where it is not.
    #[test]
    fn region_size_floors_only_where_a_fractional_frequency_reaches_it() {
        let default = geometry(500.0 + 500.0 / 1.0);
        assert_eq!(default.floored_region_size(), 1000);
        assert_eq!(default.half(), 500);

        // Frequency 1.5 gives 833.33..., which floors to an ODD region size.
        // `half` must floor too, or this diverges from `spot_selection`.
        let odd = geometry(500.0 + 500.0 / 1.5);
        assert_eq!(odd.floored_region_size(), 833);
        assert_eq!(odd.half(), 416, "half must floor, not round");
    }

    /// Regions are centred on multiples of the size, not cornered at them.
    #[test]
    fn the_region_index_offsets_by_half_before_dividing() {
        let g = geometry(1000.0);
        assert_eq!(g.region_index(0.0), 0);
        assert_eq!(g.region_index(499.0), 0);
        assert_eq!(g.region_index(500.0), 1);
        assert_eq!(g.region_index(-500.0), 0);
        assert_eq!(g.region_index(-501.0), -1);
    }

    #[test]
    fn the_cache_selects_once_per_key_and_region() {
        let cache: SpotRegionCache<u32> = SpotRegionCache::new();
        let spot = SelectedSpot {
            x: 1,
            y: 2,
            quantity: 3.0,
            cone_scale: 1.0,
        };
        let mut calls = 0;
        for _ in 0..3 {
            let got = cache.get_or_select(7, 0, 0, || {
                calls += 1;
                vec![spot]
            });
            assert_eq!(got, vec![spot]);
        }
        assert_eq!(calls, 1);
        let other = cache.get_or_select(8, 0, 0, Vec::new);
        assert!(other.is_empty(), "a different key must not share the entry");
    }

    #[test]
    fn no_spot_in_reach_is_the_basement_value() {
        let g = geometry(1000.0);
        assert_eq!(
            spot_cone_max(&g, 0.0, 0.0, |_, _| Vec::new(), |_| 10.0),
            -1.0
        );
    }
}
