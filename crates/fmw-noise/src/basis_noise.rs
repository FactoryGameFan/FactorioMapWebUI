//! Factorio's `basis_noise` primitive.
//!
//! A port of `src/noise/basisNoise.ts`, which was reverse-engineered against
//! Factorio 2.1.11. Read `docs/noise/basis-noise-NOTES.md` for the derivation
//! and the evidence; this file carries only what a reader of the Rust needs.
//!
//! **The arithmetic is f32 in the game's operation order, and that is the whole
//! difficulty.** An f64 chain narrowed once on return is a different function.
//! Scored by exact f32 match count against the 512-point fixture, because every
//! value in it is exactly f32 and so a tolerance cannot tell "close" from
//! "identical":
//!
//! | shape | exact | worst abs |
//! | --- | --- | --- |
//! | f64, `(1-d)**3`, left to right | 132/512 | 3.110e-7 |
//! | f32, `t*(t*t)`, row-pairwise fold, FORMULA table | 473/512 | 1.192e-7 |
//! | this: the same kernel, MEASURED table (#234) | 512/512 | 0 |
//!
//! In Rust every operand below is already `f32`, so each `*` and `+` rounds to
//! f32 on its own and the TypeScript's explicit `Math.fround` calls have no
//! counterpart here. That equivalence holds only because Rust does not contract
//! `a * b + c` into a fused multiply-add by default. Go's spec permits that
//! fusion and arm64 performs it, which is the single reason this port is in
//! Rust (#215). `clippy::suboptimal_flops` is allowed at the crate root so a
//! later `nursery` cannot push it back toward `mul_add`.

use crate::basis_gradient_table::{GRADIENT_X, GRADIENT_Y};
use crate::taus88::{seeded_state, taus88_next};

/// Number of gradient directions, and the period of the hash on each axis.
const TABLE_SIZE: usize = 256;

/// Index mask for `TABLE_SIZE`.
const MASK: i64 = (TABLE_SIZE - 1) as i64;

/// The per-seed tables.
///
/// `a` and `b` are the per-axis permutation tables of Kensler's "Better
/// Gradient Noise" hash (`h = a[i] ^ b[j]`); `sigma` maps that hash to a
/// gradient direction index. Build them with [`tables_from_seed`], or supply a
/// gauge-equivalent set - the three are only determined up to a gauge, so they
/// need not be the game's literal internals to reproduce its output exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BasisNoiseTables {
    /// Hash value -> gradient direction index. A permutation of 0..=255.
    pub sigma: [u8; TABLE_SIZE],
    /// X-axis permutation table.
    pub a: [u8; TABLE_SIZE],
    /// Y-axis permutation table.
    pub b: [u8; TABLE_SIZE],
}

/// The anti-vacuity control for the whole gate.
///
/// A parity test that passes against a deliberately broken port is worth
/// nothing, so `scripts/verify-rust.sh` builds once with `--features poison`
/// and asserts the tier-1 tests go RED. Without the feature this is the
/// identity and the optimiser removes it.
///
/// **It perturbs the RESULT, and the first attempt perturbed a gradient-table
/// slot instead, which the gate did not notice.** That is measured, not
/// assumed (2026-08-18): bending `GRADIENT_X[0]` by one ULP left
/// `basis-noise.seed123456.json` at 512 of 512 exact. Direction 0 is not
/// unreachable and the slot is not merely unread: it is selected at 4 of the
/// 2,048 corners those 512 points evaluate, and 3 of those 4 pass the `d < 1`
/// test and go on to multiply by it. The value simply survives nothing - one
/// ULP of a 4.2 is about 4.8e-7, and it rounds away in `dx * g`, then again in
/// `dot * falloff`, before it ever reaches the pairwise sum.
///
/// Two things follow, and the second is the one worth carrying forward:
///
/// 1. The control has to act where nothing can round it away, which is the
///    returned value itself.
/// 2. **These fixtures cannot resolve a one-ULP error in a single gradient
///    slot.** So "the table is right because the fixtures are green" is a
///    weaker statement than it looks, and the table has its own direct test
///    against `basis-gradient-table.json` for exactly that reason.
#[inline]
fn poison(value: f32) -> f32 {
    #[cfg(feature = "poison")]
    if value != 0.0 {
        return f32::from_bits(value.to_bits() + 1);
    }
    value
}

/// Evaluate `basis_noise` at a point in *noise space*.
///
/// Callers apply `input_scale` themselves (noise coords = world coords *
/// input_scale), exactly as the game's `basis_noise{input_scale = ...}` does.
///
/// Returns 0 at integer lattice points, which is the game's documented quirk
/// and falls out of the kernel rather than being special-cased.
///
/// `x` and `y` are `f64` rather than `f32` on purpose. The floor and the
/// fractional subtraction happen in f64 in the TypeScript, because JavaScript
/// numbers are f64, and only the RESULT of `x - ix` is narrowed. Taking `f32`
/// here would narrow the coordinate first and quietly evaluate a different
/// point - the defect that cost up to 331x once already (#190).
#[must_use]
pub fn basis_noise(x: f64, y: f64, tables: &BasisNoiseTables) -> f32 {
    let ix = x.floor();
    let iy = y.floor();
    let fx = (x - ix) as f32;
    let fy = (y - iy) as f32;

    // `floor` already removed the fraction, so this cast loses nothing.
    //
    // One deliberate difference from the TypeScript, recorded rather than
    // hidden: JavaScript's `&` coerces through ToInt32, so its index arithmetic
    // wraps at 2^31, while `i64 & 255` here does not. The two agree for every
    // `|ix| < 2^31`. Factorio's map limit is 2,000,000 tiles, so the reachable
    // range is smaller than that by three orders of magnitude and the
    // difference is unobservable - but it IS a difference, and a later port of
    // a primitive that legitimately runs coordinates that large should not
    // assume this line matches JavaScript by construction.
    //
    // NaN and infinity need no special case: an infinite coordinate makes `fx`
    // NaN, so `d` is NaN, so every corner takes the `!(d < 1)` branch and
    // returns 0 whatever the index came out as.
    let ix = ix as i64;
    let iy = iy as i64;

    // Summation over the 4 cell corners, simplex-style, rather than Perlin's
    // separable interpolation: the (1-d)^3 falloff reaches exactly 0 at d = 1,
    // so corners further than one unit contribute nothing.
    let corner = |corner_x: i64, corner_y: i64| -> f32 {
        let dx = fx - corner_x as f32;
        let dy = fy - corner_y as f32;
        let d = dx * dx + dy * dy;
        // The game is branchless here - two corners share a NEON register, so a
        // far corner is SELECTED to zero rather than skipped. Written as an
        // early return because the result is what matters, not the lane trick:
        // past d = 1 the falloff would go negative and SUBTRACT a contribution.
        // Phrased as `!(d < 1)` rather than `d >= 1` so a NaN takes this branch,
        // matching `!(d < 1)` in the TypeScript character for character.
        //
        // clippy::neg_cmp_op_on_partial_ord asks for `partial_cmp` on the
        // grounds that the negation hides an incomparable case. Here the
        // incomparable case is the POINT: `d >= 1.0` is false for NaN and would
        // let a NaN through to the falloff, where `1 - NaN` propagates into the
        // sum and poisons the whole point instead of contributing zero. The
        // lint is right about the general shape and wrong about this line.
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(d < 1.0) {
            return 0.0;
        }

        let t = 1.0 - d;
        // `t * (t * t)`, not `t.powi(3)`. Not the same function: #214 folded 4M
        // results and got `01efaddf3f789c57` for `x*x*x` against
        // `01efaddf3fdbc55d` for `powf(3.0)`, and the game's two `fmul`s say
        // which one it is.
        let falloff = t * (t * t);

        let hash = tables.a[((ix + corner_x) & MASK) as usize]
            ^ tables.b[((iy + corner_y) & MASK) as usize];
        let g = tables.sigma[hash as usize] as usize;
        // The magnitude is folded into the table, which the fixture
        // discriminates: see scripts/gen-gradient-table.ts.
        let dot = dx * GRADIENT_X[g] + dy * GRADIENT_Y[g];
        dot * falloff
    };

    // Pairwise, not left to right: the game adds two corners at a time and
    // folds the pair last. Which two is measured rather than read off the
    // disassembly - pairing the corners that share a `corner_y` scores 473/512
    // exact against 353 for the other pairing, 345 diagonally and 406
    // left-to-right, all against the formula table of the day.
    let row_y0 = corner(0, 0) + corner(1, 0);
    let row_y1 = corner(0, 1) + corner(1, 1);
    poison(row_y0 + row_y1)
}

// ---------------------------------------------------------------------------
// Seed -> tables. Straight from the disassembly of Factorio 2.1.11's
// `Noise::setSeed(uint, uchar)`.
// ---------------------------------------------------------------------------

/// All-zero state is a taus88 fixed point, so the seed word is clamped from
/// below to 0x155 (the same clamp `spot_noise` uses). This is why every seed in
/// `0..341` produces the same field, and why `seed0`'s bit 0 is dead.
const MIN_SEED_WORD: u32 = 0x155;

/// A backward (Durstenfeld) Fisher-Yates shuffle of `identity[0..=255]`,
/// drawing 255 values from the stream: for `pos` from 255 down to 1, swap slot
/// `pos` with `next() % (pos + 1)`. Exactly the shuffle the game applies to
/// each of its four tables, all off one continuous stream.
fn shuffle_identity(next: &mut impl FnMut() -> u32) -> [u8; TABLE_SIZE] {
    let mut t = [0u8; TABLE_SIZE];
    for (i, slot) in t.iter_mut().enumerate() {
        *slot = i as u8;
    }
    for pos in (1..TABLE_SIZE).rev() {
        let j = (next() % (pos as u32 + 1)) as usize;
        t.swap(pos, j);
    }
    t
}

/// Build the `basis_noise` tables directly from `(seed0, seed1)`.
///
/// `seed0` is the map seed; `seed1` distinguishes the many `basis_noise` calls
/// a map-gen program makes.
///
/// The wiring (from `Noise::setSeed`): the effective taus88 seed word is
/// `max(seed0 + 7*(seed1>>8), 0x155)` - `seed1`'s low byte is *not* in the
/// word - and all three state words are set to it. One continuous stream then
/// drives four identity shuffles in order: a scratch table (from which the byte
/// `scratch[seed1 & 0xff]` is taken as a salt), the Y-axis table, the X-axis
/// table, and the gradient permutation. Evaluation hashes as
/// `gradPerm[xTable[i] ^ yTable[j] ^ salt]`; folding the salt into `sigma` lets
/// the plain `a[i] ^ b[j]` evaluator above reproduce it unchanged.
///
/// The addition wraps, matching JavaScript's `>>> 0` on the sum.
#[must_use]
pub fn tables_from_seed(seed0: u32, seed1: u32) -> BasisNoiseTables {
    let word = seed0
        .wrapping_add(7u32.wrapping_mul(seed1 >> 8))
        .max(MIN_SEED_WORD);
    let salt_index = (seed1 & MASK as u32) as usize;

    let mut st = seeded_state(word);
    let mut next = || taus88_next(&mut st);

    let scratch = shuffle_identity(&mut next);
    let salt = scratch[salt_index];
    let y_table = shuffle_identity(&mut next);
    let x_table = shuffle_identity(&mut next);
    let grad_perm = shuffle_identity(&mut next);

    let mut sigma = [0u8; TABLE_SIZE];
    for (h, slot) in sigma.iter_mut().enumerate() {
        *slot = grad_perm[(h as u8 ^ salt) as usize];
    }

    BasisNoiseTables {
        sigma,
        a: x_table,
        b: y_table,
    }
}
