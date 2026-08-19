//! A multi-entry `(x, y)` memo, ported from `src/noise/eval/memoRegion.ts`.
//!
//! [`MemoXy`](super::memo_xy::MemoXy) holds the LAST `(x, y)` only. That is the
//! right shape for collapsing a DAG's fan-out within a single pixel, and it is
//! very cheap - two compares. But it can only hit when two consumers ask for the
//! same coordinate back to back.
//!
//! The Vulcanus rock overlay breaks that assumption. Its cost is spent inside
//! `resolve_chunk`, which sweeps all 1024 tiles of a chunk in reverse index
//! order to resolve collisions - a chunk-major traversal, while terrain walks
//! pixels row-major. The two visit the same coordinates in different orders, so
//! a single-entry memo never hits across them even when they share field
//! objects, and no amount of loop fusion aligns them. This keeps every value it
//! computes, so the second traversal hits regardless of order.
//!
//! ## Cost, and why the production geometry makes it cheap
//!
//! Unbounded retention is only acceptable because of how this app renders: the
//! preview is tiled across a 64-worker pool at 128x128 per tile, so a cache
//! covers ~16k entries rather than the whole map. The 512x512 and 1024x1024
//! whole-image renders exist in the benchmark, not in the app.
//!
//! ## Two deviations from the TypeScript, both deliberate
//!
//! **A `BTreeMap`, not a hash map.** The determinism policy forbids `HashMap`
//! iteration reaching output (spec section 5). Nothing here iterates, so a hash
//! map would in fact be safe - but a `BTreeMap` needs no hasher, has no
//! platform-dependent seeding on `wasm32-unknown-unknown`, and closes the
//! question rather than leaving it resting on "nothing iterates today". At ~16k
//! entries a lookup is about 14 comparisons against re-running a `basis_noise`
//! DAG node, so the trade is not close. Phase 4 may replace it with a
//! direct-mapped array, which is the shape the Voronoi cache already uses.
//!
//! **The key is an `i64` pair rather than a packed `number`.** The TypeScript
//! packs two 16-bit coordinates into one float because a JavaScript `Map` keyed
//! on a tuple would compare by identity. Rust compares tuples structurally, so
//! the packing - and its `|x|, |y| < 32768` limit - is not needed. The
//! range guard stays anyway: see below.
//!
//! ## What bypasses the cache, and why bypassing beats aliasing
//!
//! Non-integer coordinates are computed rather than cached. The cliff lattice
//! samples at `y + 0.5`, and rounding those onto integer keys would silently
//! return a DIFFERENT point's value. Bypassing is slower; aliasing is wrong.

use std::collections::BTreeMap;

/// The coordinate magnitude beyond which lookups bypass the cache.
///
/// Kept from the TypeScript, where it was the packing limit. It is not needed
/// for correctness here - an `i64` key has room for any world coordinate - but
/// it bounds the map's size against a caller that sweeps far from the origin,
/// which is the property that made unbounded retention acceptable in the first
/// place.
const LIMIT: i64 = 32768;

/// A growing memo over integer `(x, y)`.
#[derive(Debug, Clone, Default)]
pub struct MemoRegion<V> {
    cache: BTreeMap<(i64, i64), V>,
}

impl<V: Copy> MemoRegion<V> {
    /// An empty memo.
    #[must_use]
    pub fn new() -> Self {
        Self {
            cache: BTreeMap::new(),
        }
    }

    /// Number of entries held. For tests and for sizing measurements.
    #[must_use]
    pub fn len(&self) -> usize {
        self.cache.len()
    }

    /// Whether the memo holds nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }

    /// Return the cached value for `(x, y)`, or compute it with `f` and keep it.
    ///
    /// A non-integer or out-of-range coordinate bypasses the cache entirely
    /// rather than aliasing onto a neighbour.
    pub fn get<F>(&mut self, x: f64, y: f64, f: F) -> V
    where
        F: FnOnce(f64, f64) -> V,
    {
        let Some(key) = Self::key(x, y) else {
            return f(x, y);
        };
        if let Some(&hit) = self.cache.get(&key) {
            return hit;
        }
        let value = f(x, y);
        self.cache.insert(key, value);
        value
    }

    /// The integer key for `(x, y)`, or `None` when the point must bypass.
    fn key(x: f64, y: f64) -> Option<(i64, i64)> {
        // `fract() != 0` also rejects NaN and both infinities, since their
        // fractional part is NaN and NaN is never equal to zero. The range
        // check below would reject the infinities anyway; NaN it would not,
        // because every comparison against NaN is false.
        if x.fract() != 0.0 || y.fract() != 0.0 {
            return None;
        }
        if !(x > -(LIMIT as f64) && x < LIMIT as f64 && y > -(LIMIT as f64) && y < LIMIT as f64) {
            return None;
        }
        Some((x as i64, y as i64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn hits_out_of_order_which_is_the_whole_reason_it_exists() {
        let calls = Cell::new(0);
        let mut memo = MemoRegion::<f64>::new();
        let f = |x: f64, y: f64| {
            calls.set(calls.get() + 1);
            x * 1000.0 + y
        };

        // A row-major sweep, then the same points visited in reverse.
        for x in 0..8 {
            memo.get(f64::from(x), 4.0, f);
        }
        assert_eq!(calls.get(), 8);
        for x in (0..8).rev() {
            assert_eq!(memo.get(f64::from(x), 4.0, f), f64::from(x) * 1000.0 + 4.0);
        }
        assert_eq!(calls.get(), 8, "the reverse sweep must be all hits");
    }

    /// `MemoXy` cannot do the above, which is what makes this module more than
    /// a duplicate. Stated as a test so the claim is executable.
    ///
    /// It hits exactly ONCE - at the fold, where the reverse sweep starts on
    /// the point the forward sweep just finished - and misses the other seven.
    /// The first draft of this test asserted 16 and the test itself corrected
    /// it, which is the reason to write the number out rather than assert
    /// "more than the other one".
    #[test]
    fn a_single_slot_memo_hits_only_at_the_fold() {
        let calls = Cell::new(0);
        let mut memo = super::super::memo_xy::MemoXy::<f64>::new();
        let f = |x: f64, y: f64| {
            calls.set(calls.get() + 1);
            x * 1000.0 + y
        };
        for x in 0..8 {
            memo.get(f64::from(x), 4.0, f);
        }
        for x in (0..8).rev() {
            memo.get(f64::from(x), 4.0, f);
        }
        assert_eq!(
            calls.get(),
            15,
            "a one-slot memo saves only the evaluation at the fold"
        );
    }

    /// A non-integer coordinate must BYPASS, never alias onto a neighbour.
    ///
    /// The cliff lattice samples at `y + 0.5`; returning `(3, 4)`'s value for
    /// `(3, 4.5)` would be silently wrong.
    #[test]
    fn a_fractional_coordinate_bypasses_rather_than_aliasing() {
        let mut memo = MemoRegion::<f64>::new();
        let f = |x: f64, y: f64| x * 1000.0 + y;

        assert_eq!(memo.get(3.0, 4.0, f), 3004.0);
        assert_eq!(memo.get(3.0, 4.5, f), 3004.5);
        assert_eq!(memo.get(3.5, 4.0, f), 3504.0);
        assert_eq!(memo.len(), 1, "only the integer point may be stored");
    }

    /// Out of range and non-finite coordinates bypass too.
    #[test]
    fn out_of_range_and_non_finite_coordinates_bypass() {
        let mut memo = MemoRegion::<f64>::new();
        let f = |x: f64, _y: f64| x;

        assert_eq!(memo.get(32768.0, 0.0, f), 32768.0);
        assert_eq!(memo.get(-32768.0, 0.0, f), -32768.0);
        assert!(memo.get(f64::NAN, 0.0, f).is_nan());
        assert_eq!(memo.get(f64::INFINITY, 0.0, f), f64::INFINITY);
        assert!(memo.is_empty(), "nothing above may be cached");

        // And the points just inside the limit ARE cached, so the assertions
        // above are testing the boundary rather than a blanket refusal.
        assert_eq!(memo.get(32767.0, 0.0, f), 32767.0);
        assert_eq!(memo.get(-32767.0, 0.0, f), -32767.0);
        assert_eq!(memo.len(), 2);
    }

    /// Zero and NaN are both legitimate field values, so neither can stand in
    /// for "absent" - the presence check must be on the key, not the value.
    #[test]
    fn a_cached_nan_or_zero_is_still_a_hit() {
        let calls = Cell::new(0);
        let mut memo = MemoRegion::<f64>::new();
        // `&calls` rather than `calls`: the returned closure must be `move`
        // (it outlives the call that built it) and a moved `Cell` could only be
        // used once.
        let yielding = |v: f64| {
            let calls = &calls;
            move |_x: f64, _y: f64| {
                calls.set(calls.get() + 1);
                v
            }
        };

        assert_eq!(memo.get(1.0, 1.0, yielding(0.0)), 0.0);
        assert_eq!(
            memo.get(1.0, 1.0, yielding(999.0)),
            0.0,
            "0.0 must be a hit"
        );
        assert!(memo.get(2.0, 2.0, yielding(f64::NAN)).is_nan());
        assert!(
            memo.get(2.0, 2.0, yielding(999.0)).is_nan(),
            "NaN must be a hit, not a miss"
        );
        assert_eq!(calls.get(), 2);
    }
}
