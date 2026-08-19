//! A single-slot `(x, y)` cache, ported from `src/noise/eval/memoXY.ts`.
//!
//! The field graph is a heavily-shared DAG: a node like `mountains_raw_volcano`
//! feeds all three Vulcanus biomes, and each biome is read ~5x by the 19 tile
//! `*_range` expressions, so evaluating it lazily recomputes that node - and
//! every `basis_noise` octave beneath it - dozens of times per pixel. A renderer
//! sweeps one pixel at a time and reads every node at that single `(x, y)`, so a
//! one-entry cache collapses the repeats to one evaluation per node per pixel.
//!
//! **Byte-exact by construction.** It returns the identical value the wrapped
//! function computed - cached, not recomputed-and-rerounded - so a memoized
//! graph renders bit-for-bit the same as an un-memoized one. The key is exact
//! equality on both coordinates, so any change in either recomputes rather than
//! returning a stale value. Correctness never depends on the caller staying on
//! one pixel; only speed does.
//!
//! ## The coordinates are recorded AFTER the function returns
//!
//! That ordering is load-bearing for any function that can fail. Recording them
//! first - which the TypeScript did until 2026-08-05 - leaves the slot claiming
//! a position it never produced a value for, so the NEXT call at that position
//! returns the PREVIOUS position's number instead of failing again. The failure
//! surfaces on the second call, never the first, which is about as quiet as a
//! bug gets.
//!
//! `Voronoi::pyramid_noise` is such a function here: it rejects `minkowski3`,
//! as the game's own expression compiler does. In Rust that is a panic rather
//! than a thrown value, so the hazard is narrower than in JavaScript - but the
//! ordering costs nothing and `a_panicking_function_does_not_claim_its_slot`
//! makes it a measured property rather than a comment. For a function that
//! returns normally the two orderings are value-identical, so nothing else
//! changes.

/// A one-entry memo over `(x, y)`.
///
/// Generic over the value so an `f32`-valued field is not widened through `f64`
/// on the way into the cache and back out.
#[derive(Debug, Clone)]
pub struct MemoXy<V> {
    last_x: f64,
    last_y: f64,
    value: V,
}

impl<V: Copy + Default> Default for MemoXy<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V: Copy + Default> MemoXy<V> {
    /// An empty memo.
    ///
    /// The coordinates start at NaN, which never equals itself, so the first
    /// call always misses. World coordinates are finite, so a real call can
    /// never collide with the sentinel.
    #[must_use]
    pub fn new() -> Self {
        Self {
            last_x: f64::NAN,
            last_y: f64::NAN,
            value: V::default(),
        }
    }

    /// Return the cached value for `(x, y)`, or compute it with `f` and keep it.
    pub fn get<F>(&mut self, x: f64, y: f64, f: F) -> V
    where
        F: FnOnce(f64, f64) -> V,
    {
        if x == self.last_x && y == self.last_y {
            return self.value;
        }
        // `f` FIRST. If it panics, the slot must keep pointing at the last
        // position that actually produced a value. See the module docs.
        let value = f(x, y);
        self.value = value;
        self.last_x = x;
        self.last_y = y;
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    /// A hit returns the identical value and does not call the function again.
    #[test]
    fn a_repeat_call_at_the_same_point_is_one_evaluation() {
        let calls = Cell::new(0);
        let mut memo = MemoXy::<f64>::new();
        let f = |x: f64, y: f64| {
            calls.set(calls.get() + 1);
            x * 1000.0 + y
        };

        assert_eq!(memo.get(3.5, -2.25, f), 3497.75);
        assert_eq!(memo.get(3.5, -2.25, f), 3497.75);
        assert_eq!(calls.get(), 1);

        // Either coordinate changing is a miss.
        assert_eq!(memo.get(3.5, -2.5, f), 3497.5);
        assert_eq!(calls.get(), 2);
        assert_eq!(memo.get(4.5, -2.5, f), 4497.5);
        assert_eq!(calls.get(), 3);
    }

    /// The value is returned unchanged, bit for bit, rather than recomputed.
    #[test]
    fn a_hit_returns_the_identical_bits() {
        let mut memo = MemoXy::<f32>::new();
        let odd = f32::from_bits(0x3f80_0001); // 1.0 + 1 ULP
        let first = memo.get(1.0, 1.0, |_, _| odd);
        let second = memo.get(1.0, 1.0, |_, _| unreachable!("must not re-evaluate"));
        assert_eq!(first.to_bits(), second.to_bits());
    }

    /// **The ordering rule.** A function that panics must not leave the slot
    /// claiming its position, or the next call there returns the PREVIOUS
    /// position's value instead of panicking again.
    ///
    /// Planting the wrong ordering - recording `last_x`/`last_y` before calling
    /// `f` - makes the final assertion fail with `2000.0`, the value from
    /// `(2, 0)`. That was watched failing, not assumed.
    #[test]
    fn a_panicking_function_does_not_claim_its_slot() {
        let mut memo = MemoXy::<f64>::new();
        let good = |x: f64, _y: f64| x * 1000.0;
        let bad = |_x: f64, _y: f64| -> f64 { panic!("this position has no value") };

        assert_eq!(memo.get(2.0, 0.0, good), 2000.0);

        let first = catch_unwind(AssertUnwindSafe(|| memo.get(5.0, 0.0, bad)));
        assert!(first.is_err(), "the first call at (5, 0) must panic");

        // The second call at the SAME position must panic too. With the slot
        // wrongly claimed it would return 2000.0 instead.
        let second = catch_unwind(AssertUnwindSafe(|| memo.get(5.0, 0.0, bad)));
        assert!(
            second.is_err(),
            "the slot claimed (5, 0) despite producing no value, so the second \
             call returned a stale number instead of panicking"
        );
    }
}
