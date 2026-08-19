//! Factorio's `spot_noise` spot-selection phase, ported from
//! `src/noise/spotSelection.ts`. See `docs/noise/spot-noise-NOTES.md`,
//! "Spot selection - SOLVED".
//!
//! Sits on top of the candidate RNG in [`crate::spot_candidates`] and turns a
//! region's infinite candidate stream into the finite list of spots the game
//! renders. Verified against Factorio 2.1.11 across 55 probe configurations:
//!
//! 1. **Dart throw.** Walk candidates in generation order. A candidate is
//!    accepted if its squared distance to every previously accepted spot is at
//!    least a threshold that starts at `spacing^2` and is multiplied by 15/16
//!    on every rejection. The walk ends when
//!    `candidate_spot_count * skip_span` spots have been accepted.
//! 2. **Skip.** Accepted spot `j` belongs to set `j mod skip_span`; the
//!    expression renders the set matching its `skip_offset`.
//! 3. **Target.** The regional quantity target is the mean of
//!    `density_expression` over the set's accepted spots, times the region
//!    area.
//! 4. **Trim.** Stable-sort the set by favorability descending, then keep spots
//!    while the accumulated quantity is under target. With
//!    `hard_region_target_quantity` the last kept spot's quantity is cut to hit
//!    the target exactly, and its cone shrinks self-similarly - radius and peak
//!    both scale by `(q'/q)^(1/3)`.
//!
//! ## The one division with an unbounded divisor in this file
//!
//! `fast_cbrt(q2 / q)` in the hard-target branch. `fast_approx`'s header
//! records that its own two divisions were proved safe by enumerating every
//! reachable divisor, and warns that a future primitive with an unbounded
//! divisor range needs that enumeration re-run. This is that primitive - and
//! the fixture reaches this line exactly ONCE, with operands giving exactly
//! 0.5, so it is effectively untested. Treat the hard-target path as read from
//! the disassembly rather than measured.

use crate::fast_approx::fast_cbrt;
use crate::poison;
use crate::spot_candidates::{spot_seed_word, SpotPoint, SpotRegionKey};
use crate::taus88::{seeded_state, taus88_next};

/// Per-rejection decay of the SQUARED spacing threshold.
///
/// Measured exactly: `sqrt(15/16)` on distances beat `61/63` and `e^(-1/31)` on
/// 12 of 12 discriminating seeds. The game works in squared space and knocks
/// 1/16 off per rejection.
const SPACING_SQ_DECAY: f64 = 15.0 / 16.0;

/// Safety valve only. The game showed no cap through ~170 tried candidates, but
/// a degenerate config - huge spacing, tiny region - must not spin forever.
const MAX_TRIED: usize = 100_000;

/// A spot expression: quantity per unit area, spot quantity or favorability,
/// evaluated at a spot position.
pub type SpotExpression<'a> = &'a dyn Fn(f64, f64) -> f64;

/// A batched spot-quantity expression, evaluated over a whole skip set at once.
pub type SpotQuantityBatch<'a> = &'a dyn Fn(&[SpotPoint]) -> Vec<f64>;

/// One selected spot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SelectedSpot {
    pub x: i64,
    pub y: i64,
    pub quantity: f64,
    /// 1 for a full spot; `(q'/q)^(1/3)` for a hard-target-shrunk last spot.
    /// Multiply the spot's radius and peak by this when rendering the cone.
    pub cone_scale: f64,
}

/// The expressions and knobs of one `spot_noise` call.
pub struct SpotSelectParams<'a> {
    pub region_size: u64,
    pub candidate_spot_count: usize,
    /// `suggested_minimum_candidate_point_spacing`.
    pub spacing: f64,
    pub skip_span: usize,
    pub skip_offset: usize,
    pub hard_region_target_quantity: bool,
    /// Quantity per unit area, evaluated at accepted spot positions.
    pub density: SpotExpression<'a>,
    pub quantity: SpotExpression<'a>,
    pub favorability: SpotExpression<'a>,
    /// Optional batched spot quantity, evaluated over ALL skip-set accepted
    /// spots at once in acceptance order, before the sort and trim. Overrides
    /// `quantity` when present.
    ///
    /// Needed for a `spot_quantity_expression` containing a `random_penalty` -
    /// a batch op whose per-spot value depends on the whole spot list and its
    /// order, which the game evaluates at the skip-set spots as one batch. The
    /// returned slice aligns with the input spots.
    pub quantity_batch: Option<SpotQuantityBatch<'a>>,
}

/// The spots of one region, in favorability order - the order the trim ran in.
#[must_use]
pub fn select_spots(key: &SpotRegionKey, p: &SpotSelectParams) -> Vec<SelectedSpot> {
    let span = p.skip_span.max(1);
    let rs = p.region_size as i64;
    let half = (p.region_size / 2) as i64;
    let needed = p.candidate_spot_count * span;

    // The candidate stream, drawn lazily rather than through
    // `spot_candidate_points`, because the walk length is not known in advance.
    let mut st = seeded_state(spot_seed_word(key));

    // Phase 1: dart throw with a decaying squared threshold.
    let mut accepted: Vec<SpotPoint> = Vec::new();
    let mut spacing_sq = p.spacing * p.spacing;
    let mut tried = 0usize;
    while accepted.len() < needed && tried < MAX_TRIED {
        tried += 1;
        let x = key.region_x * rs + (u64::from(taus88_next(&mut st)) % p.region_size) as i64 - half;
        let y = key.region_y * rs + (u64::from(taus88_next(&mut st)) % p.region_size) as i64 - half;
        let mut ok = true;
        for a in &accepted {
            // The distances are integer tile offsets, so this product is exact
            // in f64 for any region a Factorio map can hold.
            let dx = (x - a.x) as f64;
            let dy = (y - a.y) as f64;
            if dx * dx + dy * dy < spacing_sq {
                ok = false;
                break;
            }
        }
        if ok {
            accepted.push(SpotPoint { x, y });
        } else {
            spacing_sq *= SPACING_SQ_DECAY;
        }
    }

    // Phase 2: this expression's skip set.
    let mine: Vec<SpotPoint> = accepted
        .iter()
        .enumerate()
        .filter(|(j, _)| j % span == p.skip_offset)
        .map(|(_, a)| *a)
        .collect();

    // Phase 3: the regional target, from density at the set's own spots.
    let target = if mine.is_empty() {
        0.0
    } else {
        let sum: f64 = mine
            .iter()
            .map(|a| (p.density)(a.x as f64, a.y as f64))
            .sum();
        (sum / mine.len() as f64) * rs as f64 * rs as f64
    };

    let batched = p.quantity_batch.map(|f| f(&mine));

    // Phase 4: stable sort by favorability descending, then accumulate to
    // target.
    let mut ranked: Vec<(usize, SpotPoint, f64)> = mine
        .iter()
        .enumerate()
        .map(|(j, a)| (j, *a, (p.favorability)(a.x as f64, a.y as f64)))
        .collect();
    ranked.sort_by(|a, b| {
        // Written as the TypeScript comparator rather than as a key, because
        // `b.fav - a.fav || a.j - b.j` treats a NaN difference as falsy and
        // falls through to index order. The `else` arm below does the same.
        // No reachable favorability expression produces a NaN; if one ever did,
        // this comparator would stop being a total order and Rust's sort would
        // panic rather than silently misorder, which is the better failure.
        let d = b.2 - a.2;
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            a.0.cmp(&b.0)
        }
    });

    let mut out = Vec::new();
    let mut acc = 0.0f64;
    for (j, spot, _) in ranked {
        if acc >= target {
            break;
        }
        let mut q = match &batched {
            Some(values) => values[j],
            None => (p.quantity)(spot.x as f64, spot.y as f64),
        };
        // The game skips a spot with non-positive quantity or radius - "not
        // emitted, not counted toward the target". Near spawn, regular resource
        // density fades to 0 so its spots get quantity 0; emitting them renders
        // a degenerate flat cone across the whole cull radius. Skipping BEFORE
        // the accumulation is what keeps a zero spot from consuming the budget.
        if q <= 0.0 {
            continue;
        }
        let mut cone_scale = 1.0;
        if p.hard_region_target_quantity && acc + q > target {
            let q2 = target - acc;
            // `q2 / q` is an f64 division; `fast_cbrt` narrows its argument to
            // f32 on the way in, exactly as the TypeScript's `fastLog2` does
            // through its `Float32Array` store.
            cone_scale = f64::from(fast_cbrt((q2 / q) as f32));
            q = q2;
        }
        out.push(SelectedSpot {
            x: poison::i64_result(spot.x),
            y: spot.y,
            quantity: q,
            cone_scale,
        });
        acc += q;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: SpotRegionKey = SpotRegionKey {
        seed0: 123_456,
        seed1: 100,
        region_x: 0,
        region_y: 0,
    };

    fn params<'a>(
        density: SpotExpression<'a>,
        quantity: SpotExpression<'a>,
        favorability: SpotExpression<'a>,
        quantity_batch: Option<SpotQuantityBatch<'a>>,
    ) -> SpotSelectParams<'a> {
        SpotSelectParams {
            region_size: 1024,
            candidate_spot_count: 21,
            spacing: 45.254_833_995_939_045,
            skip_span: 1,
            skip_offset: 0,
            hard_region_target_quantity: false,
            density,
            quantity,
            favorability,
            quantity_batch,
        }
    }

    /// A spot with non-positive quantity is skipped rather than emitted. Near
    /// spawn the regular resource density fades to 0, so this is the ordinary
    /// case rather than an edge one.
    #[test]
    fn emits_no_spot_whose_quantity_is_non_positive() {
        let one = |_: f64, _: f64| 1.0;
        let step = |x: f64, _: f64| if x > 0.0 { 1000.0 } else { 0.0 };
        let out = select_spots(&KEY, &params(&one, &step, &one, None));
        assert!(!out.is_empty(), "the x>0 spots must survive");
        assert!(out.iter().all(|s| s.quantity > 0.0));
    }

    #[test]
    fn emits_nothing_when_every_quantity_is_zero() {
        let one = |_: f64, _: f64| 1.0;
        let zero = |_: f64, _: f64| 0.0;
        assert!(select_spots(&KEY, &params(&one, &zero, &one, None)).is_empty());
    }

    /// The same guard applies to a batched quantity, which is the path a
    /// `random_penalty`-bearing expression takes.
    #[test]
    fn skips_non_positive_quantities_from_a_batch_too() {
        let one = |_: f64, _: f64| 1.0;
        let zero = |_: f64, _: f64| 0.0;
        let batch = |spots: &[SpotPoint]| -> Vec<f64> {
            spots
                .iter()
                .map(|s| if s.x > 0 { 1000.0 } else { 0.0 })
                .collect()
        };
        let out = select_spots(&KEY, &params(&one, &zero, &one, Some(&batch)));
        assert!(!out.is_empty());
        assert!(out.iter().all(|s| s.quantity > 0.0));
    }

    /// The batch is evaluated over the skip set in ACCEPTANCE order, and
    /// indexed by acceptance index rather than by rank. Getting that wrong
    /// would pair each spot with another spot's quantity, which is invisible
    /// when every quantity is equal.
    #[test]
    fn a_batched_quantity_is_indexed_by_acceptance_order() {
        let one = |_: f64, _: f64| 1.0;
        let zero = |_: f64, _: f64| 0.0;
        // Favorability reverses acceptance order, so rank and acceptance index
        // disagree for every spot.
        let fav = |x: f64, _: f64| -x;
        let batch = |spots: &[SpotPoint]| -> Vec<f64> {
            // A distinct, position-derived quantity per spot.
            spots.iter().map(|s| 1000.0 + s.x as f64).collect()
        };
        let out = select_spots(&KEY, &params(&one, &zero, &fav, Some(&batch)));
        assert!(!out.is_empty());
        for s in &out {
            assert_eq!(
                s.quantity,
                1000.0 + s.x as f64,
                "spot {s:?} got another's q"
            );
        }
    }

    /// Rejection decays the threshold, so a spacing far larger than the region
    /// still fills its quota rather than spinning to `MAX_TRIED`.
    #[test]
    fn a_huge_spacing_still_fills_the_quota_because_the_threshold_decays() {
        let one = |_: f64, _: f64| 1.0;
        let q = |_: f64, _: f64| 10_000.0;
        let mut p = params(&one, &q, &one, None);
        p.spacing = 20_000.0;
        p.candidate_spot_count = 6;
        let out = select_spots(&KEY, &p);
        assert!(!out.is_empty(), "the decay must let candidates through");
    }
}
