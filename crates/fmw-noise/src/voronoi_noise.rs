//! Factorio's `voronoi_*` noise primitives - all four ops, for any `jitter` in
//! `[0, 1]`. Ported from `src/noise/voronoiNoise.ts`.
//!
//! **Full RE record: `docs/noise/voronoi-NOTES.md`** - the disassembly
//! addresses, the models that were tried and refuted, and the method behind
//! every number quoted here. This file carries the findings at their sites.
//!
//! Validated bit-exact at f32 against the real 2.1.12 binary:
//! `oracle-voronoi-jitter0.seed123456.json` (15 series x 175 positions at
//! jitter 0), `oracle-voronoi-points.seed123456.json` (45 series x 175, plus an
//! inversion lattice of 6 x 4096 that recovers the point positions themselves),
//! `oracle-voronoi-cellid.multiseed.json` (9 seed series x 256 cells) and
//! `oracle-voronoi-search-range.seed123456.json`.
//!
//! **The jitter-0 rung is DEGENERATE.** At jitter 0 every cell is a congruent
//! unit square, so many different algorithms collapse onto identical numbers -
//! reproducing it is no evidence at all about jitter > 0. Two findings came out
//! of actually testing the jittered rung, and both are recorded at their sites:
//! the sample-to-point delta has to be rebased on the sample's own cell (see
//! [`delta_to`]), and the pyramid's jitter-0 formula was simply wrong once the
//! cells are not squares (0 of 175 at every jitter x distance_type).
//!
//! Three properties of this file are measurements rather than readings, and
//! each would be easy to get plausibly wrong:
//!
//! 1. **Everything is computed in GRID UNITS.** The docs read like "compute the
//!    distance in tiles, then divide by grid_size". The two are algebraically
//!    identical and differ only in f32 rounding, and three of the four distance
//!    types cannot tell them apart. `minkowski3` can: dividing at the end scores
//!    110/175 where dividing the deltas first scores 175/175, because its cube
//!    root runs through fastapprox and amplifies the difference past one ULP.
//! 2. **`minkowski3` uses the game's fastapprox `log2`/`exp2` pair, not a real
//!    cube root.** An exact cube root scores 25/175.
//! 3. **`voronoi_pyramid_noise` differs per distance type, and chebyshev is the
//!    odd one out** - by one hardcoded `0.75` where an isometry wants
//!    `1/sqrt(2)`. See [`CHEBYSHEV_FRAME`].

use crate::fast_approx::{fast_log2, fast_pow2, ONE_THIRD_F32};
use crate::poison;

/// The four `distance_type` functions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoronoiDistanceType {
    Chebyshev,
    Manhattan,
    Euclidean,
    Minkowski3,
}

impl VoronoiDistanceType {
    /// Parse the name the fixtures and the Lua prototypes use.
    ///
    /// # Panics
    ///
    /// On an unknown name, because every call site is a fixture asserting a
    /// known shape.
    #[must_use]
    pub fn from_name(name: &str) -> Self {
        match name {
            "chebyshev" => Self::Chebyshev,
            "manhattan" => Self::Manhattan,
            "euclidean" => Self::Euclidean,
            "minkowski3" => Self::Minkowski3,
            other => panic!("unknown distance_type {other:?}"),
        }
    }
}

/// Thomas Wang's 32-bit integer mix, which is the whole of the voronoi RNG.
///
/// Read straight out of `NoiseOperations::VoronoiPoints::VoronoiPoints` in the
/// 2.1.12 arm64 binary - the six constants appear there verbatim as immediates.
/// This primitive is **not** taus88: none of the seeding shapes that solved
/// `basis_noise` or `spot_noise` produce a consistent word here, and a
/// brute-force inversion over all 2^32 taus88 seed words found no additive
/// `(cellX, cellY)` lattice at all.
///
/// The TypeScript writes `| 0` at each step because the additions must wrap as
/// `uint32`; on `u32` that is what `wrapping_add` means, so there is no `| 0`
/// counterpart here and none is missing.
///
/// **Every constant is grouped on its source hex's byte boundary**, and that is
/// not cosmetic. Transcribing `0x165667b1` as `0x1665_67b1` - one transposition,
/// invisible on the page - is worth 983,040 at step 3 and scored **0 of 2,304**
/// against `oracle-voronoi-cellid.multiseed.json`. Keep the grouping aligned so
/// the next transposition is visible, and never re-group these by eye.
#[must_use]
pub fn wang_hash(mut a: u32) -> u32 {
    a = a.wrapping_add(0x7ed5_5d16).wrapping_add(a << 12);
    a = a ^ 0xc761_c23c ^ (a >> 19);
    a = a.wrapping_add(0x1656_67b1).wrapping_add(a << 5);
    a = a.wrapping_add(0xd3a2_646c) ^ (a << 9);
    a = a.wrapping_add(0xfd70_46c5).wrapping_add(a << 3);
    a ^ 0xb55a_4f09 ^ (a >> 16)
}

/// The per-cell seed word: the field seed mixed with both cell coordinates.
///
/// `seed0 + seed1` is a plain 32-bit sum, confirmed in the constructor rather
/// than inferred from a fit: `VoronoiNoise::VoronoiNoise` does
/// `w8 = asNoiseLayerID(seed1) + (uint)seed0` and stores it at `+0x20`.
///
/// **The Y coordinate is rotated by 16 bits and the X coordinate is not**
/// (`ror w8, w8, #0x10`). That asymmetry is the only thing keeping the field
/// from being degenerate, and the fixture shows exactly what it buys: because
/// the two terms are XORed, cells `(0, 0)` and `(-1, -1)` collide - both reduce
/// to the bare seed, since `ror16(0) == 0` and `ror16(!0) == !0` - as do
/// `(-1, 0)` and `(0, -1)`. Those two pairs are the ONLY duplicate values in
/// each of the 9 captured series. Without the rotation every diagonal `(k, k)`
/// would collide with them.
fn cell_seed(seed0: u32, seed1: u32, cell_x: i32, cell_y: i32) -> u32 {
    let seed = seed0.wrapping_add(seed1);
    seed ^ wang_hash(cell_x as u32) ^ wang_hash((cell_y as u32).rotate_right(16))
}

/// Draw 0: the point's x offset within its cell.
pub const CELL_DRAW_OFFSET_X: u32 = 0;
/// Draw 1: the point's y offset within its cell.
pub const CELL_DRAW_OFFSET_Y: u32 = 1;
/// Draw 2: the value `voronoi_cell_id` reports.
pub const CELL_DRAW_ID: u32 = 2;

/// The per-cell random draw in `[0, 1)` - the value `voronoi_cell_id` returns
/// and the two the jittered point offset is built from.
///
/// The binary draws THREE numbers per cell off the same word, as
/// `wangHash(w)`, `wangHash(w + 1)` and `wangHash(w + 2)`. The first two are
/// the point's x and y offset within the cell and the third is the id. (The
/// compiler folds the `+1`/`+2` into the hash's first addend, which is why
/// `0x7ed56d17` and `0x7ed57d18` appear in the disassembly alongside
/// `0x7ed55d16`.) So the id is `+ 2`, and using `+ 0` would silently hand back
/// the x offset.
///
/// **The conversion is `(double)u32 * 2^-32` narrowed to f32**, exactly as the
/// binary does it (`ucvtf d0, w8` / `fmul` by `0x3df0000000000000` /
/// `fcvt s14, d0`). Doing the multiply in f32 would round twice.
#[must_use]
pub fn cell_random(seed0: u32, seed1: u32, cell_x: i32, cell_y: i32, draw: u32) -> f32 {
    let w = cell_seed(seed0, seed1, cell_x, cell_y);
    // Poisoned at the LEAF rather than only at the four ops, because
    // `reproduces_the_games_per_cell_voronoi_draw_across_all_nine_seed_series`
    // calls this directly and would otherwise stay green under the feature.
    // `scripts/verify-rust.sh` caught exactly that, which is what the named
    // per-op list added in #262 exists for.
    poison::f32_result((f64::from(wang_hash(w.wrapping_add(draw))) / 4_294_967_296.0) as f32)
}

/// The in-cell fraction the constructor stores, in **grid units** - literally
/// the pair of f32s `VoronoiPoints::VoronoiPoints` writes.
///
/// Read out of the 2.1.12 arm64 binary rather than fitted. Draws 0 and 1 come
/// off the cell's word and are turned into an offset by one 2-lane sequence -
/// one lane per axis, so x and y are handled identically:
///
/// ```text
/// fmul.2s  v1, v1, v0[0]   ; * jitter
/// fsub     s0, s11, s0     ; s11 = 1.0
/// fmul     s0, s0, s12     ; s12 = 0.5
/// fadd.2s  v13, v1, v0     ; jitter * r + (1 - jitter) * 0.5
/// ```
///
/// **`jitter` is narrowed to f32 first**, because the prototype field is
/// written by `ldr d0, [x20, #0x88]` / `fcvt s0, d0` / `str s0, [x19, #0x28]`.
/// A Lua `jitter = 0.6` is stored as `f32(0.6)` and every step below is f32.
/// Carrying the double through is wrong in the last ULP - exactly the size of
/// error that gets absorbed into a fudge factor.
///
/// At `jitter == 0` this collapses to exactly `0.5`, independently confirming
/// the cell-centre premise the jitter-0 rung was built on.
///
/// **Point placement does NOT depend on `distance_type`, and that is settled
/// structurally rather than by a fit.** `VoronoiPoints`' constructor is handed
/// the whole `VoronoiNoise` and loads exactly three fields from it across its
/// entire 1508 bytes: `+0x20` (seed), `+0x24` (grid size) and `+0x28` (jitter).
/// `distance_type` is a byte at `+0x26` and is never read by the point
/// generator at all. The fixture agrees: the inverted apexes are identical
/// under manhattan and euclidean at every jitter.
#[must_use]
pub fn point_offset_in_cell(
    seed0: u32,
    seed1: u32,
    jitter: f64,
    cell_x: i32,
    cell_y: i32,
) -> (f32, f32) {
    let j = jitter as f32;
    let base = (1.0f32 - j) * 0.5;
    let offset = |draw: u32| j * cell_random(seed0, seed1, cell_x, cell_y, draw) + base;
    (offset(CELL_DRAW_OFFSET_X), offset(CELL_DRAW_OFFSET_Y))
}

/// Where a cell's point actually sits, in **world tiles**.
///
/// The constructor stores the in-cell FRACTION only and the cell index is added
/// by the consumer, so [`point_offset_in_cell`] is in grid units and this
/// scales it out to tiles.
#[must_use]
pub fn point_for_cell(
    seed0: u32,
    seed1: u32,
    grid_size: f64,
    jitter: f64,
    cell_x: i32,
    cell_y: i32,
) -> (f64, f64) {
    let (ox, oy) = point_offset_in_cell(seed0, seed1, jitter, cell_x, cell_y);
    (
        f64::from(cell_x) * grid_size + grid_size * f64::from(ox),
        f64::from(cell_y) * grid_size + grid_size * f64::from(oy),
    )
}

/// `(a * a) * a` with an f32 rounding at each step, matching the binary's two
/// `fmul`s.
fn cube_f32(a: f32) -> f32 {
    (a * a) * a
}

/// The four `distance_type` functions, computed in f32 throughout because the
/// game does.
///
/// `minkowski3` takes `abs()` on both terms. The docs said otherwise until an
/// official erratum, and the binary settles it directly: `runInternal<3>`
/// clears both lanes' sign bits with `bic.2s v0, #0x80, lsl #24` before cubing.
/// Without that a negative term would cancel a positive one and the "distance"
/// could reach zero away from any point.
///
/// It then goes through the fastapprox pair rather than a real cube root -
/// `Math::log2f`, multiply by `f32(1/3)`, `Math::exp2f` - which is worth ~1e-5
/// relative error and is required for a bit-exact match. An exact cube root
/// scores 25 of 175.
#[must_use]
pub fn distance_of(dt: VoronoiDistanceType, dx: f32, dy: f32) -> f32 {
    let ax = dx.abs();
    let ay = dy.abs();
    match dt {
        VoronoiDistanceType::Chebyshev => ax.max(ay),
        VoronoiDistanceType::Manhattan => ax + ay,
        VoronoiDistanceType::Euclidean => (ax * ax + ay * ay).sqrt(),
        VoronoiDistanceType::Minkowski3 => {
            let sum = cube_f32(ax) + cube_f32(ay);
            // The binary guards the log with `fcmp s1, #0.0` / `b.eq`,
            // returning the zero it preloaded. `log2(0)` is -Infinity, so this
            // is the game's behaviour rather than defensive padding.
            if sum == 0.0 {
                return 0.0;
            }
            fast_pow2(fast_log2(sum) * ONE_THIRD_F32)
        }
    }
}

/// The game's own `VoronoiNoise::getPointsSearchRange()`, which is **per
/// distance type**.
///
/// Read out of `0x101774fd4` in the 2.1.12 arm64 binary: a jump table at
/// `0x102d00a88` holding `[13, 0, 3, 8]` indexed by `DistanceType`, based at
/// `0x101775008`. Entry 0 (chebyshev) branches straight past the compare to the
/// epilogue with `w0` still holding the `mov w0, #1` from before the table, so
/// chebyshev is **pinned at 1**; the other three fall into
/// `fcmp jitter, <threshold>` / `csinc w0, #2, wzr, gt`, i.e.
/// `> threshold ? 2 : 1`.
///
/// **It was inert until 2026-08-05, and finding the positions where it is not
/// was a task of its own.** Forcing it to 2 for all four distance types passed
/// 95/95 voronoi tests, and forcing it to 1 also passed 95/95 - all 2100
/// committed values were indifferent, in both directions. Only
/// `voronoi_pyramid_noise` can see the ring at all: the other three need a
/// ring-2 point to WIN the argmin, while the pyramid only needs one to be
/// nearly EQUIDISTANT. The disagreements are rare - 553 of 16,777,216 for
/// chebyshev at jitter 1 over a 4096x4096-tile window at stride 1 - which is
/// why 175-position grids never hit one.
///
/// **The thresholds themselves are NOT behaviourally pinned.** A disagreement
/// needs high jitter; sweeps at manhattan 0.5 and euclidean `f32(0.66)` found
/// zero. The fixture bounds manhattan's threshold below 0.7 and euclidean's
/// below 0.9, and that is all the game will say. The exact values rest on the
/// disassembly.
///
/// Do not "simplify" this to a constant. Searching two rings unconditionally
/// changes `voronoi_pyramid_noise` for chebyshev, which is Fulgora's
/// `fulgora_road_pyramids`.
#[must_use]
pub fn points_search_range(dt: VoronoiDistanceType, jitter: f64) -> i32 {
    let j = jitter as f32;
    match dt {
        VoronoiDistanceType::Chebyshev => 1,
        VoronoiDistanceType::Manhattan => i32::from(j > 0.5) + 1,
        // `0x3f28f5c3` is `f32(0.66)`, written as bits so it cannot drift
        // through a decimal round-trip.
        VoronoiDistanceType::Euclidean => i32::from(j > f32::from_bits(0x3f28_f5c3)) + 1,
        VoronoiDistanceType::Minkowski3 => i32::from(j > 0.75) + 1,
    }
}

/// A point in the sample's grid-unit frame, as the binary's `Vector2f` pairs.
type Vec2 = (f32, f32);

/// The 45-degree map `runInternal<0>` puts chebyshev through before handing the
/// pair to [`bisector_distance_l1`] - **and the constant is `0.75`, not
/// `1/sqrt(2)`.**
///
/// L-infinity becomes L1 under a 45-degree rotation, so mapping the points this
/// way and then building an L1 bisector is the right construction, and the
/// bisector itself does not care what `k` is - the matrix `[[k, k], [-k, k]]`
/// is `k * sqrt(2)` times a rotation for any `k`. What `k` controls is the
/// Euclidean distance the routine then reports: it comes back multiplied by
/// `k * sqrt(2)`. The isometric choice would be `k = 1/sqrt(2) = 0.70710678`.
///
/// The game uses `fmov s16, #0.75000000` (`0x101772414`, inside
/// `VoronoiNoise::runInternal<DistanceType 0>`), and
/// `0.75 * sqrt(2) = sqrt(9/8)`, so every chebyshev pyramid value is
/// `sqrt(9/8)` times the true distance to the cell boundary - 6.07% too large.
///
/// **That is the whole explanation of chebyshev's `sqrt(9/8)` factor.** It was
/// once measured at jitter 0 and attributed to a clamp biting at a segment
/// endpoint; the number was right and the mechanism was not. It is one
/// hardcoded immediate, it applies at every jitter, and nothing about it is
/// geometry.
const CHEBYSHEV_FRAME: f32 = 0.75;

fn to_chebyshev_frame(x: f32, y: f32) -> Vec2 {
    let kx = x * CHEBYSHEV_FRAME;
    let ky = y * CHEBYSHEV_FRAME;
    (kx + ky, ky - kx)
}

/// The Euclidean distance from `s` to the **L1 bisector** of `a` and `b` - the
/// whole of `NoiseOperations::VoronoiNoise::computePyramidNoiseManhattan`
/// (`0x1017758b8`), transcribed instruction for instruction.
///
/// The name is about which metric's *bisector* is built, not which metric the
/// answer is in: the returned number is a plain `fsqrt` of a squared Euclidean
/// distance. Under L1 the set of points equidistant from `a` and `b` is a
/// polyline - a 45-degree segment flanked by two axis-parallel rays - and the
/// routine builds all three pieces and takes the nearest.
///
/// Reading the layout: the binary picks a MAJOR axis (the one with the larger
/// separation, x winning ties) with `cset w8, eq` / `cset w9, ne` and then
/// addresses every vector through `bfi x, w8/w9, #2, #1`. So this is written as
/// `maj`/`mnr` index math rather than as x/y, which is what makes the two axes
/// provably symmetric.
///
/// Two f32 details a tidier rewrite would lose:
///
/// - the clamps are `fmaxnm`/`fminnm`, which return the non-NaN operand. A
///   degenerate segment gives `0/0 = NaN`, and `fmaxnm(NaN, 0)` is `0` - so the
///   NaN checks here are the binary's behaviour, not defensive padding.
/// - `p1[mnr]` is `a[mnr]` and `p2[mnr]` is `b[mnr]` by construction, but the
///   binary re-loads them from the `p` copies, so the ray parameters are formed
///   against those and not against `a`/`b`.
///
/// One deviation that is deliberate and already checked, so nobody
/// re-discovers it as a defect: the `min`/`max` pairs stand in for the binary's
/// `fcsel mi`/`fcsel gt`, which differ only on NaN operands and on the ordering
/// of `+0` against `-0`. Neither input can be NaN (the points are finite), and
/// a `+0`/`-0` disagreement cancels - the only place the choice is observable
/// is `sep_x`/`sep_y`, which immediately square their result.
fn bisector_distance_l1(a: Vec2, b: Vec2, s: Vec2) -> f32 {
    let av = [a.0, a.1];
    let bv = [b.0, b.1];
    let sv = [s.0, s.1];
    let mid = [(av[0] + bv[0]) * 0.5, (av[1] + bv[1]) * 0.5];
    let hi = [av[0].max(bv[0]), av[1].max(bv[1])];
    let sep_x = av[0].min(bv[0]) - hi[0];
    let sep_y = av[1].min(bv[1]) - hi[1];
    // `fcsel s1, s0, s1, gt` then `cset w8, eq`: x is major on a tie.
    let maj = usize::from(sep_y * sep_y > sep_x * sep_x);
    let mnr = 1 - maj;

    // `fcmp s2, s3` compares b[maj] against a[maj], and its flags drive BOTH
    // the sign chosen for p1 and (still live, 44 bytes later) the one for p2.
    let rising = bv[maj] > av[maj];
    let h1 = (av[mnr] - mid[mnr]).abs();
    let h2 = (bv[mnr] - mid[mnr]).abs();
    let mut p1 = av;
    p1[maj] = mid[maj] + if rising { h1 } else { -h1 };
    let mut p2 = bv;
    p2[maj] = mid[maj] + if rising { -h2 } else { h2 };

    // `fcsel s6, 1.0, -1.0, eq` on `a[mnr] == max(a[mnr], b[mnr])`.
    let sgn: f32 = if av[mnr] == hi[mnr] { 1.0 } else { -1.0 };
    let mut ray = [0.0f32, 0.0f32];
    ray[mnr] = sgn;

    let dx = p2[0] - p1[0];
    let dy = p2[1] - p1[1];
    let dot = dx * (sv[0] - p1[0]) + dy * (sv[1] - p1[1]);
    let len2 = dx * dx + dy * dy;
    let raw = dot / len2;
    // NOT `clamp`. These are `fmaxnm`/`fminnm`, which return the non-NaN
    // operand; `f32::clamp` propagates NaN and panics on an inverted range, so
    // it is a different instruction pair. The NaN cannot reach here - the guard
    // takes it - but the correspondence to the disassembly is the point.
    #[allow(clippy::manual_clamp)]
    let t = if raw.is_nan() {
        0.0
    } else {
        raw.max(0.0).min(1.0)
    };
    let q = (p1[0] + dx * t, p1[1] + dy * t);

    let u_raw = sgn * (sv[mnr] - p1[mnr]);
    let u = if u_raw.is_nan() { 0.0 } else { u_raw.max(0.0) };
    let r = (p1[0] + ray[0] * u, p1[1] + ray[1] * u);

    let v_raw = -(sgn * (sv[mnr] - p2[mnr]));
    let v = if v_raw.is_nan() { 0.0 } else { v_raw.max(0.0) };
    let w = (p2[0] - ray[0] * v, p2[1] - ray[1] * v);

    let sq = |p: Vec2| (p.0 - s.0) * (p.0 - s.0) + (p.1 - s.1) * (p.1 - s.1);
    let qd = sq(q);
    let rd = sq(r);
    let wd = sq(w);
    let rays = if rd < wd { rd } else { wd };
    if qd < rays {
        qd.sqrt()
    } else {
        rays.sqrt()
    }
}

/// Parameters of one voronoi field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VoronoiParams {
    pub seed0: u32,
    pub seed1: u32,
    pub grid_size: f64,
    pub jitter: f64,
    pub distance_type: VoronoiDistanceType,
    /// Force the neighbour search ring for **every** op, overriding
    /// [`points_search_range`]. **Nothing that renders a map may set this.**
    ///
    /// It exists so the search-range fixture can plant the WRONG ring and watch
    /// the committed game values reject it. Without a hook the alternative is a
    /// second copy of the pyramid loop inside the test, which could drift from
    /// this one and would then be testing itself rather than the port.
    pub search_range_override: Option<i32>,
}

/// The result of one neighbour search.
#[derive(Clone, Copy, Debug, PartialEq)]
struct SearchResult {
    d1: f32,
    d2: f32,
    cell_x: i32,
    cell_y: i32,
}

/// The four ops of one voronoi field, each sampled at a world position in tiles.
///
/// Takes `&mut self` rather than `&self` because of the caches below. The
/// TypeScript reaches the same place with closures over a `Map`; there is no
/// interior mutability here, so a render loop holds this mutably for the sweep.
pub struct Voronoi {
    seed0: u32,
    seed1: u32,
    jitter: f64,
    distance_type: VoronoiDistanceType,
    /// **`grid_size` is a 16-bit UNSIGNED INTEGER, so a fractional argument is
    /// TRUNCATED** - measured against the game, not read off the type.
    ///
    /// It went untested for a long time because nothing exercised it: every
    /// committed voronoi fixture uses an integral grid (175, 64), where
    /// truncation is a no-op. Fulgora made it reachable, because `fulgora_grid`
    /// is `175 - slider_to_linear(...)`, a genuine float anywhere except the two
    /// slider endpoints. At a `grid_size` of 155.65736389160156 the fractional
    /// value agrees with the truncated 155 at **101 of 101** probe positions and
    /// with the rounded 156 at 91 - and 155 against 156 is also 91, which is
    /// what makes it a measurement rather than three values that all agree.
    ///
    /// The u16 WRAP is not modelled, only the truncation. Nothing observable
    /// reaches it - no caller passes a grid over 65,535 - and an unobservable
    /// change is indistinguishable from a mistake.
    grid_size: f64,
    search_ring: i32,
    /// The per-cell point cache - the whole of this type's performance story.
    ///
    /// A render sweeps one pixel at a time and every sample reads a
    /// `(2*ring+1)^2` block of cells, with the pyramid walking its own block
    /// twice. At `grid_size = 175` a whole 175x175-tile cell is the same cell
    /// for 30,625 consecutive samples, so the same six Wang mixes would be
    /// redone tens of thousands of times per cell without this.
    ///
    /// **Direct-mapped, with the full cell coordinates stored in the entry.**
    /// The `Option` is not decoration: a zero-initialised tag array makes cell
    /// `(0, 0)` read uninitialised offsets, which is exactly the bug the Go
    /// spike shipped and the checksum caught (spec section 8.4, "zero is a
    /// valid cache tag"). Storing the coordinates rather than a packed key also
    /// makes a collision *recompute* instead of returning another cell's point -
    /// the TypeScript packs its key as `(cellX & 0xffff) * 0x10000 + (cellY &
    /// 0xffff)`, so cells 65,536 apart on an axis collide there and get the
    /// wrong point. Unreachable at any real grid (2^16 * 175 = 11.5M tiles
    /// against Factorio's +-1M), and this port simply does not have it.
    ///
    /// **Byte-exact by construction**: the entry is the value the first call
    /// computed, returned unchanged. A cache that altered any value would be a
    /// bug rather than an optimisation, which is why the fixture tests are the
    /// correctness proof here.
    point_cache: Vec<Option<PointCacheEntry>>,
    /// A one-entry cache over the neighbour search.
    ///
    /// `cell_id`, `spot_noise` and `facet_noise` are three separate expressions
    /// in the Fulgora tree that read the SAME field at the SAME pixel, so
    /// without this the 9- or 25-cell search runs three times per pixel.
    last_search: Option<((f32, f32), SearchResult)>,
}

/// One direct-mapped cache slot: the cell it holds, and that cell's in-cell
/// offset. The coordinates are stored in full rather than as a packed key, so a
/// collision recomputes instead of returning another cell's point.
type PointCacheEntry = ((i32, i32), (f32, f32));

/// Entries in the direct-mapped point cache. A power of two so the index is a
/// mask; 4,096 covers a 64x64 cell neighbourhood, far more than the 25 any one
/// sample touches, so a sweep along a row keeps hitting.
const POINT_CACHE_SLOTS: usize = 4096;

impl Voronoi {
    #[must_use]
    pub fn new(p: &VoronoiParams) -> Self {
        Self {
            seed0: p.seed0,
            seed1: p.seed1,
            jitter: p.jitter,
            distance_type: p.distance_type,
            grid_size: p.grid_size.trunc(),
            search_ring: p
                .search_range_override
                .unwrap_or_else(|| points_search_range(p.distance_type, p.jitter)),
            point_cache: vec![None; POINT_CACHE_SLOTS],
            last_search: None,
        }
    }

    fn offset_at(&mut self, cell_x: i32, cell_y: i32) -> (f32, f32) {
        // A cheap spread over both axes. Only the index is derived from this -
        // the stored coordinates decide a hit - so a poor hash costs a
        // recomputation and can never return a wrong point.
        let slot = ((cell_x as u32).wrapping_mul(0x9e37_79b9)
            ^ (cell_y as u32).wrapping_mul(0x85eb_ca6b)) as usize
            % POINT_CACHE_SLOTS;
        if let Some((key, value)) = self.point_cache[slot] {
            if key == (cell_x, cell_y) {
                return value;
            }
        }
        let value = point_offset_in_cell(self.seed0, self.seed1, self.jitter, cell_x, cell_y);
        self.point_cache[slot] = Some(((cell_x, cell_y), value));
        value
    }

    /// The sample position in grid units, where the cell lattice has unit
    /// spacing.
    ///
    /// **The incoming coordinates are narrowed to f32 first**, for the same
    /// reason `multioctave_noise` does it: the noise machine passes f32 values
    /// between expressions, so whatever computed `(x, y)` handed this call an
    /// f32. It is a no-op for a raw world coordinate, which is why every
    /// voronoi fixture committed before Fulgora is unaffected - Fulgora is the
    /// first caller to pass a DERIVED coordinate, and there it takes both
    /// continuous ops from ~7e-6 to a single f32 ULP.
    /// **The divide is a genuine f32 divide here and an f64 divide narrowed
    /// afterwards in the TypeScript**, and those are not the same operation in
    /// general - a double rounding can differ from a single-precision `fdiv`.
    /// The game issues `fdiv s`, so this side is the faithful one; the two were
    /// then measured against each other rather than assumed equal, and agree on
    /// every one of the 120,000 samples `test/wasmVoronoiParity.spec.ts` folds
    /// (75 op x distance_type x case sweeps of 1,600 points). `fast_approx`'s
    /// header records the same question settled by full enumeration; the
    /// dividend here is unbounded so enumeration is not available, and this
    /// sweep is what stands in for it.
    fn to_grid(&self, x: f64, y: f64) -> (f32, f32) {
        let divisor = self.grid_size as f32;
        ((x as f32) / divisor, (y as f32) / divisor)
    }

    /// The sample-to-point delta in grid units, **rebased on the sample's own
    /// cell** - and that rebasing is load-bearing at f32, not a tidy-up.
    ///
    /// `runInternal<0>` computes the sample's in-cell fraction ONCE, then forms
    /// each neighbour's delta from that fraction and the neighbour's RELATIVE
    /// index:
    ///
    /// ```text
    /// 101772528: scvtf s25, w30      ; (float) the sample's own cell index
    /// 10177252c: fsub  s23, s23, s25 ; sampleFrac = ux - cellIndex
    /// 101772598: scvtf s27, w12      ; (float) the neighbour's RELATIVE index
    /// 1017725a0: ldp   s28, s29, [x21] ; the neighbour's stored in-cell fraction
    /// 1017725a4: fadd  s28, s28, s1  ; frac + relative index
    /// 1017725ac: fabd  s28, s28, s23 ; |that - sampleFrac|
    /// ```
    ///
    /// Forming the same delta from ABSOLUTE coordinates is algebraically
    /// identical and differs in the last ULP, because `cell + frac` at a cell
    /// index of ~11 has an f32 spacing of 2^-20 while the rebased form never
    /// adds a large number to a small one. Measured over 4,200 spot and facet
    /// samples:
    ///
    /// | delta expression | score |
    /// | --- | --- |
    /// | `ux - (cell + frac)`, inner sum in f64 | 3734/4200 |
    /// | `ux - f32(cell + frac)` | 2921/4200 |
    /// | `(frac + relIndex) - (ux - cell)`, what the binary does | **4200/4200** |
    ///
    /// All 466 misses of the first are exactly one ULP - precisely the size of
    /// error that gets mistaken for an accumulation artifact and papered over.
    /// The point itself is unchanged either way, so `cell_id` was already
    /// 175/175 under the absolute form: an argmin test could never have caught
    /// this, only an exact-value one.
    fn delta_to(sample_frac: f32, rel: i32, offset: f32) -> f32 {
        (offset + rel as f32) - sample_frac
    }

    /// The two smallest distances to a cell point, in grid units, ascending,
    /// plus the nearest point's cell.
    ///
    /// `cell_id` reports the cell that OWNS the sample, which at jitter > 0 need
    /// not be the containing cell, so the argmin has to come out of the same
    /// search rather than a second one that could disagree.
    fn search(&mut self, ux: f32, uy: f32) -> SearchResult {
        let cx = ux.floor() as i32;
        let cy = uy.floor() as i32;
        let sfx = ux - cx as f32;
        let sfy = uy - cy as f32;
        let mut out = SearchResult {
            d1: f32::INFINITY,
            d2: f32::INFINITY,
            cell_x: cx,
            cell_y: cy,
        };
        for a in -self.search_ring..=self.search_ring {
            for b in -self.search_ring..=self.search_ring {
                // At jitter 0 every offset is exactly 0.5, so this reduces to
                // the cell centre with no special case - confirmed rather than
                // assumed, since `spot_noise` reads exactly 0 (not merely
                // small) at all 25 of the jitter-0 fixture's cell centres.
                let o = self.offset_at(cx + a, cy + b);
                let d = distance_of(
                    self.distance_type,
                    Self::delta_to(sfx, a, o.0),
                    Self::delta_to(sfy, b, o.1),
                );
                if d < out.d1 {
                    out.d2 = out.d1;
                    out.d1 = d;
                    out.cell_x = cx + a;
                    out.cell_y = cy + b;
                } else if d < out.d2 {
                    out.d2 = d;
                }
            }
        }
        out
    }

    fn search_at(&mut self, ux: f32, uy: f32) -> SearchResult {
        if let Some((key, value)) = self.last_search {
            if key == (ux, uy) {
                return value;
            }
        }
        let value = self.search(ux, uy);
        self.last_search = Some(((ux, uy), value));
        value
    }

    /// The draw of whichever cell OWNS the sample - the cell whose point is
    /// nearest, which at jitter > 0 need not be the containing cell.
    ///
    /// At jitter 0 the two always coincide, which is why this used to read
    /// `floor(ux)` directly with no search. That shortcut is exactly the kind of
    /// degeneracy the jitter-0 rung cannot discriminate.
    pub fn cell_id(&mut self, x: f64, y: f64) -> f32 {
        let (ux, uy) = self.to_grid(x, y);
        let s = self.search_at(ux, uy);
        poison::f32_result(cell_random(
            self.seed0,
            self.seed1,
            s.cell_x,
            s.cell_y,
            CELL_DRAW_ID,
        ))
    }

    /// The winning cell's integer lattice coordinates - the STABLE identity of
    /// a cell, as opposed to [`Voronoi::cell_id`], which hashes this pair into
    /// `[0, 1)` and can therefore collide between two distinct cells. Anything
    /// grouping samples by "which cell am I in" must use this.
    pub fn cell_index(&mut self, x: f64, y: f64) -> (i32, i32) {
        let (ux, uy) = self.to_grid(x, y);
        let s = self.search_at(ux, uy);
        (s.cell_x, s.cell_y)
    }

    pub fn spot_noise(&mut self, x: f64, y: f64) -> f32 {
        let (ux, uy) = self.to_grid(x, y);
        poison::f32_result(self.search_at(ux, uy).d1)
    }

    pub fn facet_noise(&mut self, x: f64, y: f64) -> f32 {
        let (ux, uy) = self.to_grid(x, y);
        let s = self.search_at(ux, uy);
        poison::f32_result(s.d2 - s.d1)
    }

    /// The pyramid value: the distance from the sample to the nearest cell
    /// boundary, as the **minimum over every neighbour except the nearest** of
    /// the distance to that pair's bisector.
    ///
    /// This is a second loop in the binary, after the `d1`/`d2` loop, seeded
    /// with `FLT_MAX` (`mov w8, #0x7f7fffff`) and reduced with `fcsel ... mi`.
    /// Skipping the nearest point is not an optimisation - a zero-separation
    /// pair has a degenerate bisector and would pin the minimum at 0 everywhere.
    ///
    /// - **euclidean** (`runInternal<2>`, `0x101773d64`) has a closed form,
    ///   because a Euclidean bisector is a straight line:
    ///   `dot(midpoint, normalize(b - a))` with both points relative to the
    ///   sample. The zero-length guard on the normalise is the binary's, not
    ///   padding.
    /// - **manhattan and chebyshev** inline [`bisector_distance_l1`], chebyshev
    ///   after [`to_chebyshev_frame`].
    ///
    /// One thing here looks like a mistake and is not: manhattan and chebyshev
    /// pass the points as `sampleFrac - delta`, the point **reflected through
    /// the sample**, with the sample itself as the third argument
    /// (`fsub s24, s24, s22` then `fsub s24, s22, s24`, `0x1017732bc`). A point
    /// reflection about `s` is an isometry fixing `s`, so the distance is
    /// mathematically unchanged - but it is not unchanged at f32, so it is
    /// reproduced literally rather than simplified to the euclidean path's
    /// sample-relative form.
    ///
    /// # Panics
    ///
    /// On `minkowski3`, because the game's own expression compiler refuses that
    /// pair - its `runInternal<3>` has no pyramid path at all.
    pub fn pyramid_noise(&mut self, x: f64, y: f64) -> f32 {
        assert!(
            self.distance_type != VoronoiDistanceType::Minkowski3,
            "voronoi_pyramid_noise does not support minkowski3 - the game's own \
             expression compiler rejects it: \"Voronoi pyramid noise with \
             Minkowski3 distance is not supported\"."
        );
        let (ux, uy) = self.to_grid(x, y);
        let cx = ux.floor() as i32;
        let cy = uy.floor() as i32;
        let sfx = ux - cx as f32;
        let sfy = uy - cy as f32;
        let ring = self.search_ring;

        let delta_at = |me: &mut Self, a: i32, b: i32| -> Vec2 {
            let o = me.offset_at(cx + a, cy + b);
            (Self::delta_to(sfx, a, o.0), Self::delta_to(sfy, b, o.1))
        };

        // The nearest point. Finding it is ring-insensitive - every ring agrees
        // on WHICH point is nearest - but the same range also bounds the
        // neighbour loop below, where it does change the answer.
        let mut d1 = f32::INFINITY;
        let mut na = 0;
        let mut nb = 0;
        for a in -ring..=ring {
            for b in -ring..=ring {
                let (dx, dy) = delta_at(self, a, b);
                let d = distance_of(self.distance_type, dx, dy);
                if d < d1 {
                    d1 = d;
                    na = a;
                    nb = b;
                }
            }
        }
        let near = delta_at(self, na, nb);

        let chebyshev = self.distance_type == VoronoiDistanceType::Chebyshev;
        let reflect = |d: Vec2| (sfx - d.0, sfy - d.1);
        let anchor = if chebyshev {
            let r = reflect(near);
            to_chebyshev_frame(r.0, r.1)
        } else {
            reflect(near)
        };
        let sample = if chebyshev {
            to_chebyshev_frame(sfx, sfy)
        } else {
            (sfx, sfy)
        };

        let mut best = f32::INFINITY;
        for a in -ring..=ring {
            for b in -ring..=ring {
                if a == na && b == nb {
                    continue;
                }
                let far = delta_at(self, a, b);
                let v = if self.distance_type == VoronoiDistanceType::Euclidean {
                    let mut nx = far.0 - near.0;
                    let mut ny = far.1 - near.1;
                    if nx != 0.0 || ny != 0.0 {
                        let len = (nx * nx + ny * ny).sqrt();
                        nx /= len;
                        ny /= len;
                    }
                    let mx = (near.0 + far.0) * 0.5;
                    let my = (near.1 + far.1) * 0.5;
                    my * ny + mx * nx
                } else {
                    let other = if chebyshev {
                        let r = reflect(far);
                        to_chebyshev_frame(r.0, r.1)
                    } else {
                        reflect(far)
                    };
                    bisector_distance_l1(anchor, other, sample)
                };
                if v < best {
                    best = v;
                }
            }
        }
        poison::f32_result(best)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The XOR combine makes exactly two pairs of cells collide, and the
    /// fixture shows exactly two duplicate values per series - so this is the
    /// whole of the degeneracy, not a sample of it.
    #[test]
    fn collides_on_exactly_the_two_cell_pairs_the_xor_combine_forces() {
        let at = |cx: i32, cy: i32| cell_random(123_456, 0, cx, cy, CELL_DRAW_ID);
        assert_eq!(at(0, 0), at(-1, -1));
        assert_eq!(at(-1, 0), at(0, -1));
        // Without the 16-bit rotation on Y, every diagonal (k, k) would collide
        // with (0, 0) too. They must not.
        for k in 1..=8 {
            assert_ne!(at(k, k), at(0, 0), "diagonal ({k}, {k})");
        }
    }

    /// The three draws are distinct, which is what makes the `+ 2` on the id
    /// load-bearing rather than decorative.
    #[test]
    fn the_three_draws_off_one_cell_word_differ() {
        let a = cell_random(123_456, 0, 3, 5, CELL_DRAW_OFFSET_X);
        let b = cell_random(123_456, 0, 3, 5, CELL_DRAW_OFFSET_Y);
        let c = cell_random(123_456, 0, 3, 5, CELL_DRAW_ID);
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
    }

    /// Every draw lands in `[0, 1)`, which the `2^-32` scale is what provides.
    #[test]
    fn every_draw_is_in_the_unit_interval() {
        for cy in -20..20 {
            for cx in -20..20 {
                for draw in [CELL_DRAW_OFFSET_X, CELL_DRAW_OFFSET_Y, CELL_DRAW_ID] {
                    let v = cell_random(123_456, 0, cx, cy, draw);
                    assert!((0.0..1.0).contains(&v), "({cx}, {cy}) draw {draw} = {v}");
                }
            }
        }
    }
}
