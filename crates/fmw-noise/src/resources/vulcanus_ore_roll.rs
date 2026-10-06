//! The per-tile roll inside every Vulcanus solid-ore probability:
//! `random_penalty_between(0.9, 1, 1)`, reproduced tile for tile (#84).
//!
//! The game's calcite, coal and tungsten probabilities are all
//! `1000 * ((1 + region) * rp - 1)` with `rp = random_penalty_between(0.9, 1, 1)`
//! (`space-age/prototypes/planet/planet-vulcanus-map-gen.lua`), and
//! `random_penalty_between(from, to, seed)` is
//! `random_penalty{source = to, amplitude = to - from}`
//! (`core/prototypes/noise-functions.lua`). The port used to take `rp` as 1,
//! because `random_penalty` is a BATCH op (see [`crate::random_penalty`]) and
//! nobody knew the batch.
//!
//! ## The batch is one chunk, row-major, at integer tile coordinates
//!
//! The source is the constant 1, so every tile consumes exactly one draw and
//! the value at a tile depends only on where its batch starts and where in the
//! batch it sits. Taking the batch as the tile's own 32 x 32 chunk, positions
//! `(32*cx + i % 32, 32*cy + i / 32)` for `i` in `0..1024`, reproduces the
//! game's solid-ore entities over every tile of four whole regions:
//!
//! | region | game ore tiles | this roll: missed / extra | `rp` = 0.95: missed / extra | `rp` = 1: extra |
//! | --- | ---: | ---: | ---: | ---: |
//! | `[0,0]` default, 2.1.12 | 945 | 0 / 0 | 17 / 24 | 81 |
//! | `[1500,1500]` default, 2.1.12 | 3,914 | 0 / 1 | 99 / 100 | 398 |
//! | `[-1200,800]` default, 2.1.12 | 1,047 | 0 / 1 | 33 / 24 | 119 |
//! | `[-2200,-1500]` volcanism f0.5, 2.1.17 | 1,190 | 0 / 0 | 43 / 58 | 212 |
//!
//! The same batch walked column-major misses 69 of the 1,190 at f0.5, and
//! seeded at tile CENTRES misses 62 - though only where a coordinate is
//! negative, since the seed word truncates the first position toward zero and
//! half a tile changes nothing at `x, y >= 0`. So the grading tells the
//! layouts apart. The two
//! extra tiles sit in the band where the probability is between 0 and 1 - 13
//! tiles across all four regions - where the game rolls a second time and a
//! threshold is the best a pure function can do. The frozen test is
//! `the_vulcanus_ore_roll_is_the_chunk_batch` in `fixtures.rs`.
//!
//! ## What it is worth
//!
//! The ore OVERLAY stops painting the ring of tiles the game leaves bare (810
//! across those regions). The ore -> cliff rule gains less than that suggests:
//! most of its remaining error is the sulfuric-acid geyser, whose placement
//! roll is a different stream this module does not reproduce.

use crate::poison;
use crate::random_penalty::{random_penalty_batch, RandomPenaltyParams, RandomPenaltyPosition};
use core::cell::RefCell;
use std::collections::BTreeMap;

const CHUNK: i64 = 32;
const TILES_PER_CHUNK: usize = 1024;

/// `random_penalty_between(0.9, 1, 1)` as the op sees it: `source = to = 1`,
/// `amplitude = to - from`, `seed = 1`.
///
/// `to - from` is taken in f64, as `regular_patches` takes its own
/// `random_penalty_between`. The op reads the amplitude as an f32, and whether
/// the game folds `1 - 0.9` in f32 first was not measured: the two differ by
/// about 2e-8 in `rp`, and no tile in the four graded regions sits that close
/// to the threshold.
const ORE_PENALTY_SOURCE: f64 = 1.0;
const ORE_PENALTY: RandomPenaltyParams = RandomPenaltyParams {
    seed: 1.0,
    amplitude: 1.0 - 0.9,
};

/// One chunk's `rp`, indexed by tile index `dy * 32 + dx`.
type RollCache = RefCell<BTreeMap<(i64, i64), Box<[f64; TILES_PER_CHUNK]>>>;

/// `rp` per tile, one chunk batch at a time.
///
/// Shared by the solid ores: all three expressions call
/// `random_penalty_between` with the same seed, so they draw the same `rp` at
/// a tile. A real cache, like `vulcanus_biomes`', because a chunk's batch is
/// 1,024 draws and a render reads it per pixel.
#[derive(Default)]
pub struct VulcanusOreRoll {
    cache: RollCache,
}

impl VulcanusOreRoll {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `rp` for the tile containing world position `(x, y)`.
    #[must_use]
    pub fn penalty_at(&self, x: f64, y: f64) -> f64 {
        #[allow(clippy::cast_possible_truncation)]
        self.penalty(x.floor() as i64, y.floor() as i64)
    }

    /// `rp` for tile `(tx, ty)`.
    #[must_use]
    pub fn penalty(&self, tx: i64, ty: i64) -> f64 {
        let chunk = (tx.div_euclid(CHUNK), ty.div_euclid(CHUNK));
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let index = (ty.rem_euclid(CHUNK) * CHUNK + tx.rem_euclid(CHUNK)) as usize;
        // A one-ULP nudge to `rp` almost never moves a thresholded tile, so
        // the gate's hook reads the NEIGHBOURING tile's draw instead: still
        // uniform, still deterministic, and wrong at every tile.
        let index = poison::index_result(index, TILES_PER_CHUNK);
        let mut cache = self.cache.borrow_mut();
        let rolls = cache.entry(chunk).or_insert_with(|| chunk_penalties(chunk));
        rolls[index]
    }
}

/// The chunk's batch, in the game's row-major order.
///
/// **Only the first position reaches the result.** It seeds the stream, and
/// with a constant source every later position draws once whatever its
/// coordinates are. So the positions after the first could be anything, and
/// a planted x/y swap here leaves every test green - measured. What makes the
/// batch row-major is the index [`VulcanusOreRoll::penalty`] reads it at;
/// swapping THAT turns `the_vulcanus_ore_roll_is_the_chunk_batch` red with
/// exactly its column-major control's numbers.
fn chunk_penalties((cx, cy): (i64, i64)) -> Box<[f64; TILES_PER_CHUNK]> {
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_wrap)]
    let positions: Vec<RandomPenaltyPosition> = (0..TILES_PER_CHUNK as i64)
        .map(|i| RandomPenaltyPosition {
            x: (cx * CHUNK + i % CHUNK) as f64,
            y: (cy * CHUNK + i / CHUNK) as f64,
        })
        .collect();
    let penalties = random_penalty_batch(
        &positions,
        &[ORE_PENALTY_SOURCE; TILES_PER_CHUNK],
        &ORE_PENALTY,
    );
    let mut out = Box::new([0.0f64; TILES_PER_CHUNK]);
    out.copy_from_slice(&penalties);
    out
}

/// A solid ore's probability, `1000 * ((1 + region) * rp - 1)`, narrowed to
/// f32 after every operation.
#[must_use]
pub fn ore_probability(region: f64, penalty: f64) -> f64 {
    let a = f64::from((1.0 + region) as f32);
    let b = f64::from((a * penalty) as f32);
    let c = f64::from((b - 1.0) as f32);
    f64::from((1000.0 * c) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tile_of_a_chunk_reads_its_own_draw_of_the_chunk_batch() {
        let roll = VulcanusOreRoll::new();
        #[allow(clippy::cast_precision_loss)]
        let positions: Vec<RandomPenaltyPosition> = (0..1024_i64)
            .map(|i| RandomPenaltyPosition {
                x: (-64 + i % 32) as f64,
                y: (32 + i / 32) as f64,
            })
            .collect();
        let batch = random_penalty_batch(&positions, &[1.0; 1024], &ORE_PENALTY);
        for (i, want) in (0_i64..).zip(&batch) {
            assert_eq!(
                roll.penalty(-64 + i % 32, 32 + i / 32).to_bits(),
                want.to_bits()
            );
        }
        // Inside `[0.9, 1]`, and not constant.
        assert!(batch.iter().all(|&rp| (0.9..=1.0).contains(&rp)));
        assert!(batch.iter().any(|&rp| (rp - batch[0]).abs() > 0.01));
    }

    #[test]
    fn at_rp_one_the_probability_is_one_thousand_times_the_region() {
        assert_eq!(ore_probability(0.25, 1.0), 250.0);
        assert_eq!(ore_probability(0.0, 1.0), 0.0);
        // `rp` below 1 takes it below zero at a small region.
        assert!(ore_probability(0.01, 0.95) < 0.0);
    }
}
