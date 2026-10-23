//! The WASM boundary, and nothing else. No logic lives here.
//!
//! Every export is either a scratch-region accessor or a tier-2 parity
//! checksum. The checksums exist so a TypeScript spec can compare the two ports
//! in process, over a whole grid at once, by strict bit equality rather than a
//! tolerance - see `test/wasmMultioctaveParity.spec.ts` and
//! `test/wasmPrimitiveParity.spec.ts`.
//!
//! Phase 0c started with a single checksum, deliberately, so the whole loading
//! path was proven - compile the module, instantiate it, write into linear
//! memory, read a result back - before any noise math depended on it.

pub mod abi;
pub mod render;

use fmw_noise::{
    basis_noise, checksum, multioctave_noise, quick_multioctave_noise,
    variable_persistence_multioctave_noise,
};

/// A fixed scratch region the caller writes into.
///
/// No allocator, and no `#![no_std]`. Both were tried and both were wrong.
/// `#![no_std]` here while `fmw-noise` links `std` produces
/// `error[E0152]: found duplicate lang item 'panic_impl'`, and the spike that
/// measured 1,518 bytes used plain `std` anyway - so `no_std` was buying
/// nothing and costing a build. An allocator would exist only to hand back
/// memory nothing ever frees, because the module's lifecycle is "instantiate
/// once per worker, fill a buffer per call". Phase 3 replaces this with an
/// explicitly reused render buffer of the same shape.
const SCRATCH_BYTES: usize = 1 << 16;
static mut SCRATCH: [u8; SCRATCH_BYTES] = [0; SCRATCH_BYTES];

/// Offset of the scratch region in linear memory.
#[unsafe(no_mangle)]
pub extern "C" fn scratch_ptr() -> u32 {
    // `addr_of!` rather than a plain reference to the `static mut`, or
    // `static_mut_refs` denies the build under `-D warnings`.
    core::ptr::addr_of!(SCRATCH) as u32
}

/// Capacity of the scratch region, in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn scratch_len() -> u32 {
    SCRATCH_BYTES as u32
}

/// FNV-1a 64 over the first `len` bytes of the scratch region.
///
/// **Returns a `u64`, which JavaScript receives as a SIGNED BigInt.** Measured:
/// `fnv1a64` of an empty slice is `0xcbf29ce484222325`, and JavaScript reads
/// `-0x340d631b7bdddcdb`, its two's complement. No error is raised - the number
/// is simply wrong in a way that looks like a broken checksum. Every caller
/// must apply `BigInt.asUintN(64, x)`.
#[unsafe(no_mangle)]
pub extern "C" fn fnv1a64(len: u32) -> u64 {
    let bytes = unsafe {
        core::slice::from_raw_parts(core::ptr::addr_of!(SCRATCH).cast::<u8>(), len as usize)
    };
    checksum::fnv1a64(bytes)
}

/// Fold one f64 into a running checksum, by raw bits. Same signed-BigInt
/// caveat as [`fnv1a64`].
#[unsafe(no_mangle)]
pub extern "C" fn fold_f64(acc: u64, value: f64) -> u64 {
    checksum::fold_f64(acc, value)
}

/// Tier 2 of the port's gate: fold `n * n` `basis_noise` results into one
/// checksum, so a TypeScript spec can compare the two ports in process.
///
/// The grid is `x0 + i * step` by `y0 + j * step`, rows outer, and the fold is
/// order-sensitive on purpose - see [`fmw_noise::checksum::fold_f64`]. That
/// makes this a strict bit-equality check over the whole grid at once rather
/// than a tolerance over a sample.
///
/// **This detects divergence; it does not establish correctness.** Both ports
/// could agree and both be wrong. Correctness is tier 1, the oracle fixtures,
/// which each port is graded against independently.
///
/// Same signed-BigInt caveat as [`fnv1a64`]: apply `BigInt.asUintN(64, x)`.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_basis_noise(
    seed0: u32,
    seed1: u32,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let tables = basis_noise::tables_from_seed(seed0, seed1);
    let mut acc = 0u64;
    for j in 0..n {
        // f64 throughout, matching the TypeScript: JavaScript numbers are f64,
        // so narrowing the coordinate here would evaluate a different grid.
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            let x = x0 + f64::from(i) * step;
            acc = checksum::fold_f64(acc, f64::from(basis_noise::basis_noise(x, y, &tables)));
        }
    }
    acc
}

/// Tier 2 for `multioctave_noise`: fold `n * n` results into one checksum.
///
/// Same contract as [`checksum_basis_noise`] - rows outer, order-sensitive
/// fold, strict bit equality rather than a tolerance, and the same signed-BigInt
/// caveat. And the same limit: it detects divergence between the two ports, it
/// does not establish correctness. Correctness is tier 1.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn checksum_multioctave_noise(
    seed0: u32,
    seed1: u32,
    octaves: f64,
    persistence: f64,
    input_scale: f64,
    output_scale: f64,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let params = multioctave_noise::MultioctaveParams {
        seed0,
        seed1,
        octaves,
        persistence,
        input_scale,
        output_scale,
    };
    let tables = basis_noise::tables_from_seed(seed0, seed1);
    let terms = multioctave_noise::octave_terms(&params);
    let mut acc = 0u64;
    for j in 0..n {
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            let x = x0 + f64::from(i) * step;
            let v = multioctave_noise::sum_octaves(x, y, &terms, &tables);
            acc = checksum::fold_f64(acc, f64::from(v));
        }
    }
    acc
}

/// Tier 2 for `variable_persistence_multioctave_noise`.
///
/// `persistence` is a single value per call rather than per point. The real op
/// takes a spatially varying persistence, and computing one here would put
/// arithmetic that is NOT the op under test on both sides of the comparison,
/// where a difference would read as an op divergence. The per-tile path is
/// graded by tier 1 instead, which feeds the fixture's captured
/// `persistenceField`; the spec calls this with several values.
///
/// It crosses as an **f64**, and that is load-bearing rather than tidy. It was
/// an f32 until #226, so the spec narrowed its own value with `Math.fround`
/// before comparing - a harness compensation that made the two sides agree by
/// construction on exactly the term that turned out to differ. Two of that
/// spec's cases pass a persistence which is not f32-exact (0.62 and 0.9), so
/// with the compensation gone this comparison now grades the operand width
/// instead of hiding it.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn checksum_variable_persistence(
    seed0: u32,
    seed1: u32,
    octaves: u32,
    input_scale: f64,
    output_scale: f64,
    offset_x: f64,
    persistence: f64,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let params = variable_persistence_multioctave_noise::VariablePersistenceParams {
        seed0,
        seed1,
        octaves,
        input_scale,
        output_scale,
        offset_x,
    };
    let tables = basis_noise::tables_from_seed(seed0, seed1);
    let terms = variable_persistence_multioctave_noise::terms(&params);
    let mut acc = 0u64;
    for j in 0..n {
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            let x = x0 + f64::from(i) * step;
            let v =
                variable_persistence_multioctave_noise::eval(x, y, persistence, &terms, &tables);
            acc = checksum::fold_f64(acc, f64::from(v));
        }
    }
    acc
}

/// Tier 2 for `quick_multioctave_noise`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn checksum_quick_multioctave(
    seed0: u32,
    seed1: u32,
    octaves: u32,
    input_scale: f64,
    output_scale: f64,
    oosm: f64,
    oism: f64,
    offset_x: f64,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let params = quick_multioctave_noise::QuickMultioctaveParams {
        seed0,
        seed1,
        octaves,
        input_scale,
        output_scale,
        octave_output_scale_multiplier: oosm,
        octave_input_scale_multiplier: oism,
        offset_x,
    };
    let terms = quick_multioctave_noise::octave_terms(&params);
    let mut acc = 0u64;
    for j in 0..n {
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            let x = x0 + f64::from(i) * step;
            acc = checksum::fold_f64(
                acc,
                f64::from(quick_multioctave_noise::sum_octaves(x, y, &terms)),
            );
        }
    }
    acc
}

// ---------------------------------------------------------------------------
// Tier 2 for the phase-1 primitives that do NOT compose `basis_noise`:
// random_penalty, the spot_noise pair, starting_lakes and
// distance_from_nearest_point.
//
// Same contract as `checksum_basis_noise` throughout - order-sensitive fold,
// strict bit equality rather than a tolerance, and the same signed-BigInt
// caveat. And the same limit: this detects divergence between the two ports, it
// does not establish correctness. Correctness is tier 1.
// ---------------------------------------------------------------------------

use fmw_noise::{
    distance_from_nearest_point, random_penalty, spot_candidates, spot_selection, starting_lakes,
    voronoi_noise,
};

/// The shared spawn list for the two lake exports.
///
/// Generated from a rule rather than passed in, because the boundary takes
/// scalars and a list would mean writing into the scratch region on the
/// JavaScript side - machinery that would itself need testing. The rule is
/// duplicated in `test/wasmPrimitiveParity.spec.ts`; keep the two in step.
fn spawns(count: u32) -> Vec<distance_from_nearest_point::Point> {
    (0..count)
        .map(|k| distance_from_nearest_point::Point {
            x: f64::from(k) * 1000.0,
            y: f64::from(k) * -700.0,
        })
        .collect()
}

/// Tier 2 for `random_penalty`.
///
/// The batch is the whole `n * n` grid in row-major order - which is the op's
/// evaluation order, and the thing that makes it a batch op rather than a
/// function of position. `source_kind` selects the source expression, mirroring
/// the fixture: 0 is the constant 1, 1 is `x`. Kind 1 goes negative over half
/// the grid, so it exercises the `source <= 0` pass-through and the draw it
/// does not consume.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_random_penalty(
    rp_seed: f64,
    amplitude: f64,
    source_kind: u32,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let mut positions = Vec::with_capacity((n * n) as usize);
    for j in 0..n {
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            positions.push(random_penalty::RandomPenaltyPosition {
                x: x0 + f64::from(i) * step,
                y,
            });
        }
    }
    let source: Vec<f64> = positions
        .iter()
        .map(|p| if source_kind == 0 { 1.0 } else { p.x })
        .collect();
    let out = random_penalty::random_penalty_batch(
        &positions,
        &source,
        &random_penalty::RandomPenaltyParams {
            seed: rp_seed,
            amplitude,
        },
    );

    let mut acc = 0u64;
    for v in out {
        acc = checksum::fold_f64(acc, v);
    }
    acc
}

/// Tier 2 for the `spot_noise` candidate stream.
///
/// Folds the coordinates of `count` candidates across a block of regions, so
/// the seed word's dependence on the region index is part of what is compared.
/// The coordinates are whole tiles and fold as exact f64.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_spot_candidates(
    seed0: u32,
    seed1: u32,
    region_x0: i32,
    region_y0: i32,
    regions: u32,
    region_size: u32,
    count: u32,
) -> u64 {
    let mut acc = 0u64;
    for ry in 0..regions {
        for rx in 0..regions {
            let key = spot_candidates::SpotRegionKey {
                seed0,
                seed1,
                region_x: i64::from(region_x0) + i64::from(rx),
                region_y: i64::from(region_y0) + i64::from(ry),
            };
            for p in
                spot_candidates::spot_candidate_points(&key, u64::from(region_size), count as usize)
            {
                acc = checksum::fold_f64(acc, p.x as f64);
                acc = checksum::fold_f64(acc, p.y as f64);
            }
        }
    }
    acc
}

/// One of the favorability shapes the spot-selection fixture uses. Constant
/// favorability leaves the sort order entirely to the acceptance-index
/// tie-break, so a port could get the comparator wrong and still agree; `x` and
/// `-x` are what make the sort observable.
fn favorability_of(kind: u32) -> fn(f64, f64) -> f64 {
    match kind {
        1 => |x, _| x,
        2 => |x, _| -x,
        _ => |_, _| 1.0,
    }
}

/// Tier 2 for `spot_noise` selection.
///
/// `density` and `quantity` are constants and `favorability` is one of the
/// three shapes above, which is the fixture's own parameter space. Folds every
/// output field, including `cone_scale` - so the hard-target branch's
/// `fast_cbrt` is inside the comparison rather than beside it.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn checksum_spot_selection(
    seed0: u32,
    seed1: u32,
    region_x: i32,
    region_y: i32,
    region_size: u32,
    count: u32,
    spacing: f64,
    skip_span: u32,
    skip_offset: u32,
    hard: u32,
    density: f64,
    quantity: f64,
    favorability_kind: u32,
) -> u64 {
    let density_fn = move |_x: f64, _y: f64| density;
    let quantity_fn = move |_x: f64, _y: f64| quantity;
    let favorability_fn = favorability_of(favorability_kind);
    let key = spot_candidates::SpotRegionKey {
        seed0,
        seed1,
        region_x: i64::from(region_x),
        region_y: i64::from(region_y),
    };
    let params = spot_selection::SpotSelectParams {
        region_size: u64::from(region_size),
        candidate_spot_count: count as usize,
        spacing,
        skip_span: skip_span as usize,
        skip_offset: skip_offset as usize,
        hard_region_target_quantity: hard != 0,
        density: &density_fn,
        quantity: &quantity_fn,
        favorability: &favorability_fn,
        quantity_batch: None,
    };

    let mut acc = 0u64;
    for s in spot_selection::select_spots(&key, &params) {
        acc = checksum::fold_f64(acc, s.x as f64);
        acc = checksum::fold_f64(acc, s.y as f64);
        acc = checksum::fold_f64(acc, s.quantity);
        acc = checksum::fold_f64(acc, s.cone_scale);
    }
    acc
}

/// Tier 2 for `starting_lake_positions`.
///
/// Folds every lake off one continuous stream, so the seeding, the stream order
/// and the polynomial are all inside one number.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_starting_lakes(seed0: u32, spawn_count: u32) -> u64 {
    let mut acc = 0u64;
    for lake in starting_lakes::starting_lake_positions(seed0, &spawns(spawn_count)) {
        acc = checksum::fold_f64(acc, lake.x);
        acc = checksum::fold_f64(acc, lake.y);
    }
    acc
}

/// Tier 2 for `distance_from_nearest_point`.
///
/// The points are the starting lakes of `seed0`, which is how `elevation_lakes`
/// actually composes these two, and folding the grid puts both the cap branch
/// and the sqrt branch in the same number. A divergence here that
/// `checksum_starting_lakes` does not also show is this op's own.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_distance_from_nearest_point(
    seed0: u32,
    spawn_count: u32,
    maximum_distance: f64,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let points = starting_lakes::starting_lake_positions(seed0, &spawns(spawn_count));
    let mut acc = 0u64;
    for j in 0..n {
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            let x = x0 + f64::from(i) * step;
            acc = checksum::fold_f64(
                acc,
                f64::from(distance_from_nearest_point::distance_from_nearest_point(
                    x,
                    y,
                    &points,
                    maximum_distance,
                )),
            );
        }
    }
    acc
}

/// Tier 2 for the four `voronoi_*` ops.
///
/// One export rather than four, selected by `op`, because the four share a
/// field and building it is most of the call. `op` is 0 cell_id, 1 spot,
/// 2 facet, 3 pyramid; `distance_type` is 0 chebyshev, 1 manhattan,
/// 2 euclidean, 3 minkowski3 - the game's own `DistanceType` order, which is
/// what indexes its jump table.
///
/// Same contract as [`checksum_basis_noise`]: rows outer, order-sensitive fold,
/// strict bit equality rather than a tolerance, the signed-BigInt caveat, and
/// the same limit - it detects divergence, it does not establish correctness.
///
/// **The field is rebuilt once and swept, so the caches are inside the
/// comparison.** A cache that returned another cell's point - the shape the Go
/// spike shipped, where a zero-initialised tag array made cell (0, 0) read
/// uninitialised offsets - would move this checksum and nothing else in the
/// gate would notice.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn checksum_voronoi(
    seed0: u32,
    seed1: u32,
    grid_size: f64,
    jitter: f64,
    distance_type: u32,
    op: u32,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let dt = match distance_type {
        0 => voronoi_noise::VoronoiDistanceType::Chebyshev,
        1 => voronoi_noise::VoronoiDistanceType::Manhattan,
        2 => voronoi_noise::VoronoiDistanceType::Euclidean,
        _ => voronoi_noise::VoronoiDistanceType::Minkowski3,
    };
    let mut v = voronoi_noise::Voronoi::new(&voronoi_noise::VoronoiParams {
        seed0,
        seed1,
        grid_size,
        jitter,
        distance_type: dt,
        search_range_override: None,
    });
    let mut acc = 0u64;
    for j in 0..n {
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            let x = x0 + f64::from(i) * step;
            let value = match op {
                0 => v.cell_id(x, y),
                1 => v.spot_noise(x, y),
                2 => v.facet_noise(x, y),
                _ => v.pyramid_noise(x, y),
            };
            acc = checksum::fold_f64(acc, f64::from(value));
        }
    }
    acc
}

/// Tier 2 for `voronoi` cell INDICES - the stable `(cellX, cellY)` identity,
/// which [`checksum_voronoi`]'s `cell_id` hashes away and can collide on.
///
/// Worth its own export because two distinct cells CAN share a `cell_id` - the
/// XOR combine forces exactly two colliding pairs - so a port that returned the
/// wrong cell could still produce the right float.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn checksum_voronoi_cell_index(
    seed0: u32,
    seed1: u32,
    grid_size: f64,
    jitter: f64,
    distance_type: u32,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let dt = match distance_type {
        0 => voronoi_noise::VoronoiDistanceType::Chebyshev,
        1 => voronoi_noise::VoronoiDistanceType::Manhattan,
        2 => voronoi_noise::VoronoiDistanceType::Euclidean,
        _ => voronoi_noise::VoronoiDistanceType::Minkowski3,
    };
    let mut v = voronoi_noise::Voronoi::new(&voronoi_noise::VoronoiParams {
        seed0,
        seed1,
        grid_size,
        jitter,
        distance_type: dt,
        search_range_override: None,
    });
    let mut acc = 0u64;
    for j in 0..n {
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            let x = x0 + f64::from(i) * step;
            let (cx, cy) = v.cell_index(x, y);
            acc = checksum::fold_f64(acc, f64::from(cx));
            acc = checksum::fold_f64(acc, f64::from(cy));
        }
    }
    acc
}

// ---------------------------------------------------------------------------
// Tier 2 for the phase-2 `eval` layer (#221).
//
// Same contract as `checksum_basis_noise` throughout - order-sensitive fold,
// strict bit equality rather than a tolerance, and the same signed-BigInt
// caveat. And the same limit: this detects divergence between the two ports, it
// does not establish correctness. Correctness is tier 1.
// ---------------------------------------------------------------------------

use fmw_noise::eval::{math, memo_region::MemoRegion, memo_xy::MemoXy, multisample, primitives};
use fmw_noise::expressions::vulcanus_seed;
use fmw_noise::fast_approx;

/// Tier 2 for the noise machine's `^`, across all three of its branches.
///
/// `exponent` selects the branch the way the operator itself does: `0.5` takes
/// the exact square root, a whole number takes exponentiation by squaring, and
/// anything else takes fastapprox. `use_cbrt` routes to `fast_cbrt` instead, so
/// the `ONE_THIRD_F32` constant is inside the comparison rather than beside it.
///
/// The bases sweep `x0 + i * step` and must stay positive - `fast_log2` of a
/// non-positive base is not a value either port promises anything about.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_pow(exponent: f32, use_cbrt: u32, x0: f64, step: f64, n: u32) -> u64 {
    let mut acc = 0u64;
    for i in 0..n {
        let x = (x0 + f64::from(i) * step) as f32;
        let v = if use_cbrt == 0 {
            fast_approx::noise_machine_pow(x, exponent)
        } else {
            fast_approx::fast_cbrt(x)
        };
        acc = checksum::fold_f64(acc, f64::from(v));
    }
    acc
}

/// Tier 2 for the two slider functions that the game's own arithmetic matches.
///
/// **This one carries more weight than the others**, because it is the only
/// place in the port where both sides call a libm transcendental (`log2`,
/// `2^x`) rather than arithmetic the ISA specifies exactly. Tier 1 grades
/// `slider_rescale` at seven probe points; this sweeps 600, in WASM, against
/// V8's libm.
///
/// `kind` is 0 `slider_to_linear(s, a, b)` and 1 `slider_rescale(s, a)`. `s`
/// sweeps `s0 + i * ds` and must stay positive.
///
/// ## This sweep already caught one, and that is why it exists (#270, CLOSED)
///
/// A third form used to ship: `src/noise/eval/sliderRescale.ts`, which rounded
/// once at the end instead of per operation. It **did not agree between the two
/// ports**, and that was measured rather than assumed:
///
/// | form | agreement over 600 slider positions, n = 2 and n = 3 |
/// | --- | --- |
/// | `slider_to_linear` (per-op f32) | 600 / 600 |
/// | `slider_rescale` (per-op f32) | 600 / 600 |
/// | the rounded-once form | **599 / 600** |
///
/// The single disagreement is at `s = 3.5435` for `n = 2` and `s = 6.3657` for
/// `n = 3`. **Native Rust agrees with V8 exactly at both points** - checked
/// directly, same bits - so this was the `wasm32-unknown-unknown` libm
/// specifically, not Rust. Which means `cargo test` on the host could not see
/// it, and only this tier-2 spec could.
///
/// Why the other two survive and that one did not: they narrow every
/// intermediate to f32, and a one-ULP f64 difference is about 29 bits below
/// what survives that. The un-narrowed form had nothing to absorb it. This is
/// the determinism policy's transcendental rule (spec section 5) arriving as a
/// measurement.
///
/// **It was deleted rather than routed around**, because the oracle says it was
/// also the form that disagreed with the GAME - it misses two of the seven
/// probe points the per-operation form matches. Every caller (four Vulcanus
/// fields plus Nauvis rock size) now reads `eval::math::slider_rescale`, and
/// `slider_rescale_rounded_once` survives only as a `#[cfg(test)]` control. So
/// there is no un-narrowed form left to keep out of this module - and none
/// should be added. Anything new that reaches a transcendental gets a sweep
/// here, not just a fixture.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_slider(kind: u32, s0: f64, ds: f64, n: u32, a: f64, b: f64) -> u64 {
    let mut acc = 0u64;
    for i in 0..n {
        let s = s0 + f64::from(i) * ds;
        let v = if kind == 0 {
            f64::from(math::slider_to_linear(s, a, b))
        } else {
            f64::from(math::slider_rescale(s, a))
        };
        acc = checksum::fold_f64(acc, v);
    }
    acc
}

/// Tier 2 for the two engine seed variables.
///
/// Folds both per seed, so a port that got one right and the other wrong still
/// moves the number. The stride is a `u32` add that WRAPS, which is deliberate:
/// it lets a short sweep reach the top of the range, where `map_seed_normalized`
/// narrows to exactly 1 and plain f64 division does not.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_seed_vars(seed_start: u32, stride: u32, n: u32) -> u64 {
    let mut acc = 0u64;
    let mut seed = seed_start;
    for _ in 0..n {
        acc = checksum::fold_f64(acc, f64::from(vulcanus_seed::seed_normalized(seed)));
        acc = checksum::fold_f64(acc, f64::from(vulcanus_seed::seed_small(seed)));
        seed = seed.wrapping_add(stride);
    }
    acc
}

/// Tier 2 for the DSL's plain math operators.
///
/// Small, but `min` and `max` are where a JavaScript-versus-Rust SEMANTIC
/// difference lurks rather than a numeric one - `f64::min` discards NaN where
/// `Math.min` propagates it, and the two disagree on signed zero. The sweep
/// includes `-0.0` for that reason. NaN is deliberately NOT folded: it has many
/// bit patterns and folding raw bits would compare the two engines' choice of
/// payload rather than the operator. Both sides assert the NaN rule directly
/// instead.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_eval_math(x0: f64, step: f64, n: u32) -> u64 {
    let mut acc = 0u64;
    for i in 0..n {
        let x = x0 + f64::from(i) * step;
        acc = checksum::fold_f64(acc, math::clamp(x, -1.0, 1.0));
        acc = checksum::fold_f64(acc, math::lerp(-3.0, 7.0, x));
        acc = checksum::fold_f64(acc, math::min(&[x, -x, 0.5, -0.0]));
        acc = checksum::fold_f64(acc, math::max(&[x, -x, 0.5, -0.0]));
    }
    acc
}

/// Tier 2 for the composed `eval` pipeline: `basis_noise_expr` read through
/// `multisample`, through `MemoXy`, through `MemoRegion`.
///
/// **The grid is swept TWICE - forward, then in reverse - and both sweeps are
/// folded.** The reverse pass is all cache hits, so the memos are inside the
/// comparison rather than beside it. A cache that returned a neighbour's value
/// would move this checksum and nothing else in the gate would notice; that is
/// the exact shape of the sentinel bug the Go spike shipped, where a
/// zero-initialised tag array made cell (0, 0) read uninitialised offsets.
///
/// The step is a whole number so the coordinates stay integral and
/// `MemoRegion` caches rather than bypassing. A fractional step would silently
/// turn the second sweep into 2n fresh evaluations and the test would still
/// pass, proving nothing about the cache.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn checksum_eval_pipeline(
    seed0: u32,
    seed1: u32,
    input_scale: f64,
    output_scale: f64,
    offset_x: f64,
    dx: f64,
    dy: f64,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let params = primitives::BasisExprParams {
        seed0,
        seed1,
        input_scale,
        output_scale,
        offset_x,
    };
    let tables = basis_noise::tables_from_seed(seed0, seed1);
    // f64, not f32: `basis_noise_expr` narrows the product to f32 (#269) but
    // returns it widened, exactly as the TypeScript does, and the TypeScript
    // memos hold a `number`. The memo element type tracks the memo, not the
    // arithmetic. See the note on `basis_noise_expr`.
    let mut region = MemoRegion::<f64>::new();
    let mut slot = MemoXy::<f64>::new();

    let mut acc = 0u64;
    for pass in 0..2u32 {
        for j in 0..n {
            for i in 0..n {
                // Reverse the second pass so the one-slot memo cannot serve it
                // and the region memo has to.
                let (ii, jj) = if pass == 0 {
                    (i, j)
                } else {
                    (n - 1 - i, n - 1 - j)
                };
                let x = x0 + f64::from(ii) * step;
                let y = y0 + f64::from(jj) * step;
                let v = region.get(x, y, |px, py| {
                    slot.get(px, py, |qx, qy| {
                        multisample::multisample(
                            |sx, sy| primitives::basis_noise_expr(sx, sy, &params, &tables),
                            qx,
                            qy,
                            dx,
                            dy,
                        )
                    })
                });
                acc = checksum::fold_f64(acc, v);
            }
        }
    }
    acc
}

// ---------------------------------------------------------------------------
// Tier 2 for phase 3 - Fulgora's landmask chain (#223).
// ---------------------------------------------------------------------------

use fmw_noise::expressions::starting_spot_at_angle::AngleTrig;
use fmw_noise::expressions::{fulgora_cells, fulgora_scrap, fulgora_shared, fulgora_stack};
use fmw_noise::tiles::{fulgora_catalog, fulgora_ocean};

/// The named field a [`checksum_fulgora`] call folds.
///
/// A selector rather than one blended number, so a divergence names the field
/// it is in. The order is the order the chain evaluates in, which is also the
/// order the oracle fixtures list.
const FIELD_COUNT: u32 = 76;

/// Tier 2 for Fulgora's whole field graph, one named field at a time.
///
/// **The two bearings' sine and cosine are INPUTS**, which is the whole reason
/// this signature is as wide as it is. `starting_spot_at_angle` is plain f64
/// arithmetic with no narrowing anywhere, so a one-ULP `sin` difference between
/// V8 and whatever libm `wasm32-unknown-unknown` links would land straight in
/// the result - and #270 measured that those two libms really do disagree, on 1
/// of 600 slider positions, where `cargo test` on the host could not see it.
///
/// Every call site's angle is a per-render constant, so lifting the trig out
/// costs nothing and closes the question rather than bounding it.
///
/// `field` selects which named expression to fold, `0..FIELD_COUNT`. Same
/// contract as [`checksum_basis_noise`] otherwise: rows outer, order-sensitive
/// fold, strict bit equality, the signed-BigInt caveat, and the same limit -
/// it detects divergence, it does not establish correctness.
///
/// **The four Voronoi caches are inside the comparison**, because the stack is
/// built once and swept. A cache that returned a neighbouring cell's point
/// would move this and nothing else in the gate would notice.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub extern "C" fn checksum_fulgora(
    seed0: u32,
    islands_frequency: f64,
    islands_size: f64,
    sin_start: f64,
    cos_start: f64,
    sin_vault: f64,
    cos_vault: f64,
    field: u32,
    x0: f64,
    y0: f64,
    step: f64,
    n: u32,
) -> u64 {
    let ctx = fulgora_shared::FulgoraCtx {
        seed0,
        islands_frequency,
        islands_size,
    };
    let mut stack = fulgora_stack::FulgoraStack::new(
        &ctx,
        &fulgora_scrap::ScrapControls::default(),
        AngleTrig::new(sin_start, cos_start),
        AngleTrig::new(sin_vault, cos_vault),
    );

    let mut acc = 0u64;
    for j in 0..n {
        let y = y0 + f64::from(j) * step;
        for i in 0..n {
            let x = x0 + f64::from(i) * step;
            let f = stack.eval(x, y);
            let s = &f.shared;
            let c = &f.cells;
            let e = &f.elevation;
            let m = &f.masks;
            let r = &f.roads;
            let u = &f.ruins;
            let v = match field {
                0 => s.wobble_influence,
                1 => s.wobble_mask,
                2 => s.wobble_x,
                3 => s.wobble_y,
                4 => s.ox,
                5 => s.oy,
                6 => s.wx,
                7 => s.wy,
                8 => s.starting_cone,
                9 => s.starting_vault_cone,
                10 => s.starting_mask,
                11 => s.starting_vault_mask,
                12 => c.cells,
                13 => c.pyramids,
                14 => c.spots,
                15 => c.spots_inv,
                16 => c.blanks,
                17 => c.mesa,
                18 => c.sprawl,
                19 => c.vaults,
                20 => c.vaults_and_starting_vault,
                21 => e.basis,
                22 => e.basis_oil,
                23 => e.rock,
                24 => e.dunes,
                25 => e.scrap_medium,
                26 => e.natural,
                27 => e.sprawl_pyramids,
                28 => e.vault_pyramids,
                29 => e.vault_pyramids_and_start,
                30 => e.moats,
                31 => e.mix_pyramids,
                32 => e.mix_natural,
                33 => e.mix_moats,
                34 => e.vault_spots,
                35 => e.mix_spots,
                36 => e.oil_mask,
                37 => e.mix_oil,
                38 => e.sand_basins,
                39 => e.pre_elevation,
                40 => e.elevation,
                // The landmask's own answer: 0 land, 1 shallow, 2 deep.
                41 => match fulgora_ocean::ocean_tile(e) {
                    None => 0.0,
                    Some(fulgora_ocean::Ocean::Shallow) => 1.0,
                    Some(fulgora_ocean::Ocean::Deep) => 2.0,
                },
                42 => m.natural,
                43 => m.natural_and_mesa,
                44 => m.artificial,
                45 => r.road_cells,
                46 => r.road_pyramids,
                47 => r.pyramids_banding,
                48 => r.spots_prebanding,
                49 => r.spots_banding,
                50 => r.structure_cells,
                51 => r.structure_subnoise,
                52 => r.structure_facets,
                53 => r.road_paving_thin,
                54 => r.road_paving_2,
                55 => r.road_paving_2b,
                56 => r.road_paving_2c,
                57 => r.road_dust,
                58 => u.ruins_walls,
                59 => u.ruins_paving,
                60 => u.tile_ruin_paving,
                61 => u.tile_ruin_walls,
                62 => u.tile_ruin_conduit,
                63 => u.tile_ruin_machinery,
                64 => f.scrap.probability,
                65 => f.scrap.struct_term,
                66 => f.scrap.vault_term,
                // The eight land probabilities, in LAND_ORDER.
                67..=74 => f.land_probabilities()[(field - 67) as usize],
                // The resolved tile, as its index in a fixed list. A number so
                // it rides the same comparator as the fields it derives from.
                _ => tile_code(f.tile()),
            };
            acc = checksum::fold_f64(acc, v);
        }
    }
    acc
}

/// The resolved tile as a number, in the order `FulgoraTile` declares.
fn tile_code(tile: fulgora_catalog::FulgoraTile) -> f64 {
    use fulgora_catalog::FulgoraTile as T;
    match tile {
        T::FulgoranDust => 0.0,
        T::FulgoranDunes => 1.0,
        T::FulgoranSand => 2.0,
        T::FulgoranRock => 3.0,
        T::FulgoranPaving => 4.0,
        T::FulgoranWalls => 5.0,
        T::FulgoranConduit => 6.0,
        T::FulgoranMachinery => 7.0,
        T::Shallow => 8.0,
        T::Deep => 9.0,
    }
}

/// How many fields [`checksum_fulgora`] can select, so the spec cannot silently
/// stop covering one.
///
/// Without this the spec would carry its own copy of the count, and adding a
/// field to the chain would leave the new one untested while every existing
/// assertion still passed.
#[unsafe(no_mangle)]
pub extern "C" fn fulgora_field_count() -> u32 {
    FIELD_COUNT
}

// ---------------------------------------------------------------------------
// Tier 2 for phase 5 - the whole Vulcanus field graph (#225).
// ---------------------------------------------------------------------------

use fmw_noise::expressions::aquilo_stack::AquiloParity;
use fmw_noise::expressions::vulcanus_stack::VulcanusParity;

/// Tier 2 for the Vulcanus field graph, one named field at a time.
///
/// **The parameters arrive as a REQUEST, not as arguments.** Fulgora's
/// counterpart takes its seven as a signature; Vulcanus needs 31 more `f64` -
/// three sliders, four resource control pairs and ten bearings - so this reads
/// the request already sitting in the scratch buffer, written by the shipped
/// `encodeRenderRequest`. That buys more than a shorter signature: the stack is
/// built through the same `render::vulcanus_*` helpers the renderer uses, so a
/// bearing wired to the wrong layer is INSIDE this comparison rather than
/// beside it. A private copy of that wiring here would be reproduced
/// identically on both sides and stay invisible.
///
/// **The sweep is the request's own pixel grid**, swept rows-outer exactly as
/// `render_vulcanus` sweeps it, so there is one geometry convention rather than
/// two. Nothing is written to the render buffer.
///
/// `field` selects which named expression to fold, `0..VulcanusParity::FIELD_COUNT`.
/// Same contract as [`checksum_fulgora`] otherwise: order-sensitive fold over
/// raw bits, strict bit equality, the signed-BigInt caveat, and the same limit -
/// it detects divergence, it does not establish correctness.
///
/// **Returns 0 if the request does not decode as a Vulcanus one**, rather than
/// trapping, for the reason `render_request` does not trap: a trap poisons the
/// instance for every later call in that worker. A rejected request folds 0 for
/// every field, which no real sweep does, so the spec goes red naming the first
/// field rather than passing quietly. `a request the module cannot decode folds
/// 0, rather than trapping` in `test/wasmVulcanusParity.spec.ts` makes that
/// contract load-bearing rather than a promise here: it corrupts the magic word
/// and sends a Fulgora request, and checks a real one folds non-zero first so
/// the arms differ by the corruption alone.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_lines)]
pub extern "C" fn checksum_vulcanus(request_len: u32, field: u32) -> u64 {
    let bytes = unsafe {
        core::slice::from_raw_parts(
            core::ptr::addr_of!(SCRATCH).cast::<u8>(),
            request_len as usize,
        )
    };
    let Ok(req) = abi::decode(bytes) else {
        return 0;
    };
    let abi::Params::Vulcanus(p) = req.params else {
        return 0;
    };

    let ctx = render::vulcanus_ctx(req.seed0, &p);
    let base = render::vulcanus_base(&ctx, &p);
    let biomes = render::vulcanus_biomes(&base, &p);
    let stack = render::vulcanus_stack(&base, &biomes, &p);
    let parity = VulcanusParity::new(&stack, req.seed0);

    let mut acc = 0u64;
    for py in 0..req.height {
        let y = req.origin_y + f64::from(py) * req.tiles_per_pixel;
        for px in 0..req.width {
            let x = req.origin_x + f64::from(px) * req.tiles_per_pixel;
            acc = checksum::fold_f64(acc, parity.field(field, x, y));
        }
    }
    acc
}

/// How many fields [`checksum_vulcanus`] can select, so the spec cannot
/// silently stop covering one.
///
/// Without this the spec would carry its own copy of the count, and adding a
/// field to the chain would leave the new one untested while every existing
/// assertion still passed.
#[unsafe(no_mangle)]
pub extern "C" fn vulcanus_field_count() -> u32 {
    VulcanusParity::FIELD_COUNT
}

/// Tier 2 for the Aquilo field graph, one named field at a time.
///
/// Built through `render::aquilo_stack`, the helper the renderer uses, so the
/// levers and bearings arrive the way a render's do. The window comes from the
/// request, as in [`checksum_vulcanus`]. `field` selects an expression,
/// `0..AquiloParity::FIELD_COUNT`.
///
/// **Returns 0 if the request does not decode as an Aquilo one, or if `field`
/// is not below `aquilo_field_count()`**, rather than trapping, for the reason
/// `checksum_vulcanus` gives.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_aquilo(request_len: u32, field: u32) -> u64 {
    let bytes = unsafe {
        core::slice::from_raw_parts(
            core::ptr::addr_of!(SCRATCH).cast::<u8>(),
            request_len as usize,
        )
    };
    aquilo_fold(bytes, field)
}

/// [`checksum_aquilo`] over request bytes held anywhere, so the native test
/// can fold without touching the shared scratch buffer.
fn aquilo_fold(bytes: &[u8], field: u32) -> u64 {
    // An index past the end is refused like an undecodable request: it would
    // otherwise fold the constant 0.0 and read as a real, constant field.
    if field >= AquiloParity::FIELD_COUNT {
        return 0;
    }
    let Ok(req) = abi::decode(bytes) else {
        return 0;
    };
    let abi::Params::Aquilo(p) = req.params else {
        return 0;
    };

    let mut stack = render::aquilo_stack(req.seed0, &p);
    let mut parity = AquiloParity::new(&mut stack);

    let mut acc = 0u64;
    for py in 0..req.height {
        let y = req.origin_y + f64::from(py) * req.tiles_per_pixel;
        for px in 0..req.width {
            let x = req.origin_x + f64::from(px) * req.tiles_per_pixel;
            acc = checksum::fold_f64(acc, parity.field(field, x, y));
        }
    }
    acc
}

/// How many fields [`checksum_aquilo`] can select, so the spec cannot silently
/// stop covering one.
#[unsafe(no_mangle)]
pub extern "C" fn aquilo_field_count() -> u32 {
    AquiloParity::FIELD_COUNT
}

/// FNV-1a 64 over the sorted names of the tiles that block a Vulcanus cliff.
///
/// The set is written on both sides of the port - here as
/// [`fmw_noise::tiles::vulcanus_catalog::VulcanusTile::is_cliff_blocking`], in
/// TypeScript as `VULCANUS_CLIFF_BLOCKING_TILES` - and before #364 nothing
/// asserted the two agreed. A spec hashes the TypeScript set through this
/// module's own [`fnv1a64`] and compares, so the two sides cannot drift.
///
/// Names rather than a count, because a count cannot tell `lava` from
/// `volcanic-folds`. Sorted, so the sides need not also agree on an order.
///
/// **Returns a `u64`, so the same signed-BigInt caveat as [`fnv1a64`] applies:**
/// the caller must apply `BigInt.asUintN(64, x)`.
#[unsafe(no_mangle)]
pub extern "C" fn vulcanus_cliff_blocking_names_fnv1a64() -> u64 {
    fmw_noise::tiles::vulcanus_catalog::cliff_blocking_names_fnv1a64()
}

// ---------------------------------------------------------------------------
// The render boundary (#223). See `abi.rs` for the request layout and
// `render.rs` for what it does.
// ---------------------------------------------------------------------------

/// The render output buffer.
///
/// 1024x1024 RGBA, which is the largest window the app or the benchmark asks
/// for. Static rather than allocated: the module's lifecycle is "instantiate
/// once per worker, fill a buffer per call", so an allocator would exist only
/// to hand back memory nothing ever frees.
///
/// **It costs nothing in the committed file.** A zero-initialised static lives
/// in WebAssembly's memory section, not its data section, so this is 4 MB of
/// declared linear memory and 0 bytes of `engine.wasm`.
///
/// **It is 8-aligned on purpose.** `surveyThroughWasm.ts` reads it as a
/// `Float64Array`, and that constructor throws `RangeError: start offset of
/// Float64Array should be a multiple of 8` at any other offset. A bare
/// `[u8; N]` only promises 1-byte alignment: rustc 1.98.1 happened to place it
/// on an 8-byte boundary and 1.99.1 did not, which broke the island finder and
/// the cell survey (21 tests) the moment the toolchain moved (#473).
const RENDER_BYTES: usize = 1024 * 1024 * 4;
#[repr(C, align(8))]
struct RenderBuffer([u8; RENDER_BYTES]);
static mut RENDER: RenderBuffer = RenderBuffer([0; RENDER_BYTES]);

/// Offset of the render output buffer in linear memory.
#[unsafe(no_mangle)]
pub extern "C" fn render_ptr() -> u32 {
    core::ptr::addr_of!(RENDER) as u32
}

/// Capacity of the render output buffer, in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn render_len() -> u32 {
    RENDER_BYTES as u32
}

/// Size of the fixed request header, so the TypeScript writer cannot drift from
/// it.
#[unsafe(no_mangle)]
pub extern "C" fn request_bytes() -> u32 {
    abi::REQUEST_BYTES as u32
}

/// The ABI version this module speaks.
#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    abi::ABI_VERSION
}

/// Render the request sitting in the first `len` bytes of the scratch region
/// into the render buffer.
///
/// Returns a status code; **it does not trap**. A trap would poison the
/// instance for every later request in that worker, and the errors here are all
/// things a caller can cause - see spec section 6.5. `panic = "abort"` stays on
/// for genuine bugs.
///
/// 0 is success. The rest are [`abi::Status`]: 1 short buffer, 2 bad magic,
/// 3 bad version, 4 unsupported planet or view, 5 output too large,
/// 6 reserved word not zero.
#[unsafe(no_mangle)]
pub extern "C" fn render_request(len: u32) -> u32 {
    let request = unsafe {
        core::slice::from_raw_parts(core::ptr::addr_of!(SCRATCH).cast::<u8>(), len as usize)
    };
    let out = unsafe {
        core::slice::from_raw_parts_mut(core::ptr::addr_of_mut!(RENDER).cast::<u8>(), RENDER_BYTES)
    };
    render::render(request, out) as u32
}

/// Bytes one surveyed position writes: `[cell_id, cell_x, cell_y]` as `f64`.
///
/// `cell_id` is `f64` because the TypeScript compares it against `0.33` and
/// carries it into `IslandCandidate.id` - narrowing it here would change which
/// cells the finder reports. `cell_x`/`cell_y` are integers in an `i32` on the
/// Rust side and plain numbers in JavaScript; sending them as `f64` keeps one
/// element width across the block rather than saving eight bytes for a mixed
/// layout the reader would have to unpack twice.
const SURVEY_STRIDE_BYTES: usize = 24;

/// Positions one `survey_fulgora_cells` call can write.
///
/// The island finder searches to radius 20,000 at a step of `grid / 8` - about
/// 3.3 million positions, or 80 MB of triples against a 4 MB buffer - so a whole
/// search cannot land in one call and the caller sweeps in bands. This is what
/// bounds a band.
const SURVEY_MAX_POSITIONS: usize = RENDER_BYTES / SURVEY_STRIDE_BYTES;

/// Positions a survey request would write, without evaluating any of them.
///
/// Exported so the caller can size its bands from the module's own limit rather
/// than recomputing it - the same reason `request_bytes` is exported.
#[unsafe(no_mangle)]
pub extern "C" fn survey_max_positions() -> u32 {
    SURVEY_MAX_POSITIONS as u32
}

/// Sweep a strided box and write each position's Voronoi cell id and index.
///
/// **This is not a render**, and it exists because #227 deletes the TypeScript
/// the Fulgora island finder runs on. `cellSurvey.ts` evaluates
/// `stack.cells.cells(x, y)` per position and reads `cellIndex` at the WARPED
/// position - measured at 96.3% of island-finding, against 3.7% for the pure
/// graph and rectangle work that stays in TypeScript.
///
/// The request is an ordinary Fulgora request: `origin_x`/`origin_y` are the
/// band's first position, `tiles_per_pixel` is the survey step, and
/// `width`/`height` are how many positions each way. A strided grid is exactly
/// what the common prefix already describes, so this needs no new block.
///
/// **It evaluates only `shared` and `cells`, not the whole stack.**
/// `FulgoraStack::eval` computes elevation, roads, ruins and scrap in one eager
/// pass - correct for a render, and all wasted here. The two layers this does
/// build are the same types the renderer uses, so there is no private copy of
/// the wiring.
///
/// Returns a status code and does not trap, like [`render_request`].
#[unsafe(no_mangle)]
pub extern "C" fn survey_fulgora_cells(len: u32) -> u32 {
    let request = unsafe {
        core::slice::from_raw_parts(core::ptr::addr_of!(SCRATCH).cast::<u8>(), len as usize)
    };
    let req = match abi::decode(request) {
        Ok(r) => r,
        Err(status) => return status as u32,
    };
    let abi::Params::Fulgora(p) = req.params else {
        return abi::Status::UnsupportedPlanetOrView as u32;
    };
    let positions = (req.width as usize) * (req.height as usize);
    if positions > SURVEY_MAX_POSITIONS {
        return abi::Status::OutputTooLarge as u32;
    }

    let ctx = fulgora_shared::FulgoraCtx {
        seed0: req.seed0,
        islands_frequency: p.islands_frequency,
        islands_size: p.islands_size,
    };
    // One shared layer and one cell layer for the whole band, so the Voronoi
    // point caches stay warm across it - the same reason the renderer shares a
    // stack, and the reason a band is worth more than a position at a time.
    let shared = fulgora_shared::FulgoraShared::new(
        &ctx,
        AngleTrig::new(p.sin_start, p.cos_start),
        AngleTrig::new(p.sin_vault, p.cos_vault),
    );
    let mut cells = fulgora_cells::FulgoraCells::new(&ctx, shared.grid);

    let out = unsafe {
        core::slice::from_raw_parts_mut(core::ptr::addr_of_mut!(RENDER).cast::<u8>(), RENDER_BYTES)
    };
    let mut offset = 0usize;
    for py in 0..req.height {
        let y = req.origin_y + f64::from(py) * req.tiles_per_pixel;
        for px in 0..req.width {
            let x = req.origin_x + f64::from(px) * req.tiles_per_pixel;
            let s = shared.eval(x, y);
            let c = cells.eval(&s);
            // `cell_index` is read at the warped position inside `eval`, which
            // is the subtlety `cellSurvey.ts` carries a comment about: reading
            // it at the raw sample would name the cell owning the raw point
            // rather than the one that produced the id.
            out[offset..offset + 8].copy_from_slice(&c.cells.to_le_bytes());
            out[offset + 8..offset + 16].copy_from_slice(&f64::from(c.cell_index.0).to_le_bytes());
            out[offset + 16..offset + 24].copy_from_slice(&f64::from(c.cell_index.1).to_le_bytes());
            offset += SURVEY_STRIDE_BYTES;
        }
    }
    abi::Status::Ok as u32
}

/// The survey step the module would use for this request's `grid`.
///
/// `surveyStep` in the TypeScript is `grid / 8`, and `grid` comes out of the
/// shared layer rather than being a constant - it moves with
/// `islands_frequency`. A caller that guessed it would sweep a different set of
/// points than the finder was written against.
#[unsafe(no_mangle)]
pub extern "C" fn fulgora_survey_step(
    seed0: u32,
    islands_frequency: f64,
    islands_size: f64,
    sin_start: f64,
    cos_start: f64,
    sin_vault: f64,
    cos_vault: f64,
) -> f64 {
    let ctx = fulgora_shared::FulgoraCtx {
        seed0,
        islands_frequency,
        islands_size,
    };
    let shared = fulgora_shared::FulgoraShared::new(
        &ctx,
        AngleTrig::new(sin_start, cos_start),
        AngleTrig::new(sin_vault, cos_vault),
    );
    shared.grid / 8.0
}

// ---------------------------------------------------------------------------
// Tier 2 for phase 6 - the Nauvis expression core (#226).
// ---------------------------------------------------------------------------

// The ctx construction moved to `render::nauvis_ctx`, which is what took the
// cliff, rock, enemy, resource and spawn imports with it. That is the change
// this signature exists for: one definition of the wiring, shared by the
// renderer and by tier 2.
use fmw_noise::expressions::nauvis_stack::{NauvisParity, NauvisStack};
use fmw_noise::trees::field::{TreeBase, TreeFieldParams, TreeFields};

/// Tier 2 for the Nauvis expression core, one named field at a time.
///
/// **The parameters arrive as a REQUEST**, the way `checksum_vulcanus`'s do,
/// and this signature replaced twenty-nine arguments when the Nauvis render
/// path landed. The old form's own doc said to revisit it then, for the reason
/// Vulcanus records: a private copy of the renderer's wiring is reproduced
/// identically on both sides of the comparison and stays invisible. There were
/// two constructions of `NauvisCtx` - one here, one in `render_nauvis` - and a
/// lever wired to the wrong layer in both would have folded to the same
/// checksum.
///
/// Now there is one, `render::nauvis_ctx`, and a mis-wiring is INSIDE the
/// comparison.
///
/// Three things worth knowing about the conversion:
///
/// - **The resource block is per-resource now.** `NauvisCtx` carried a single
///   triple applied to all six while the renderer built its own six-entry map
///   from the ABI - so the eighteen levers the request carries were outside
///   tier 2 entirely. They are inside it now.
/// - **A request can express an off-grid sweep perfectly well.** The origin and
///   `tiles_per_pixel` are plain `f64`; the spec sends non-binary values for the
///   reason the header gives, and nothing about a request makes them binary.
/// - **`water_level` reaches the stack through the same helper now.** It was a
///   separate parameter until #320, because the renderer pinned it to zero to
///   mirror `renderTerrain.ts` while tier 2 had to sweep the real value. That
///   TypeScript is gone, so both callers read the request and no field sits
///   outside the shared wiring.
///
/// Nauvis crosses no trig at all, so the #270 hazard that forces Fulgora's and
/// Vulcanus's wide signatures does not apply here.
#[unsafe(no_mangle)]
pub extern "C" fn checksum_nauvis(request_len: u32, field: u32) -> u64 {
    let bytes = unsafe {
        core::slice::from_raw_parts(
            core::ptr::addr_of!(SCRATCH).cast::<u8>(),
            request_len as usize,
        )
    };
    let Ok(req) = abi::decode(bytes) else {
        return 0;
    };
    let abi::Params::Nauvis(p) = req.params else {
        return 0;
    };

    // Through the RENDERER's own helper, which is the whole point of this
    // signature - see `render::nauvis_ctx`. Every lever the request carries
    // reaches the stack the same way the render path reaches it.
    let ctx = render::nauvis_ctx(req.seed0, &p);
    let stack = NauvisStack::new(&ctx);

    // The parity selector rather than the stack's own, so the 21 tile
    // probabilities, the argmax over them and the resource and tree layers are
    // inside the comparison too.
    //
    // The tree layer is built HERE rather than inside the selector, and only
    // when a tree field is being asked for. `TreeFields` borrows a `TreeBase`,
    // so a selector owning both would be self-referential; and this is one call
    // per FIELD, so an unconditional build would make every other field pay for
    // sixteen `Prepared` multioctaves it never reads. The two locals have to
    // outlive the borrow, hence the declaration before the `if`.
    let tree_base;
    let tree_fields;
    let parity = if field >= NauvisParity::TREE_BASE {
        let mut tree_params = TreeFieldParams::defaults(req.seed0);
        tree_params.trees_frequency = ctx.trees_frequency;
        tree_params.trees_size = ctx.trees_size;
        tree_params.segmentation_multiplier = ctx.segmentation_multiplier;
        tree_params.moisture_frequency = ctx.moisture_frequency;
        tree_params.moisture_bias = ctx.moisture_bias;
        tree_params.temperature_frequency = ctx.temperature_frequency;
        tree_params.temperature_bias = ctx.temperature_bias;
        tree_params.starting_area_moisture_size = ctx.starting_area_moisture_size;
        tree_params.starting_area_moisture_frequency = ctx.starting_area_moisture_frequency;
        tree_base = TreeBase::new(&tree_params);
        tree_fields = TreeFields::new(&tree_base);
        NauvisParity::new(&stack, &ctx).with_trees(&tree_fields)
    } else {
        NauvisParity::new(&stack, &ctx)
    };

    // The request's own pixel grid, swept in the renderer's own order, so
    // there is one geometry convention rather than two.
    //
    // **A parity sweep still has to be off the f32 grid**, and a request can
    // express that perfectly well - the origin and `tiles_per_pixel` are plain
    // `f64`. The spec sends non-binary values for exactly that reason; nothing
    // about carrying them in a request makes them binary.
    let mut acc = 0u64;
    for py in 0..req.height {
        let y = req.origin_y + f64::from(py) * req.tiles_per_pixel;
        for px in 0..req.width {
            let x = req.origin_x + f64::from(px) * req.tiles_per_pixel;
            acc = checksum::fold_f64(acc, parity.field(field, x, y));
        }
    }
    acc
}

/// How many fields [`checksum_nauvis`] can select, so the spec cannot silently
/// stop covering one.
#[unsafe(no_mangle)]
pub extern "C" fn nauvis_field_count() -> u32 {
    NauvisParity::FIELD_COUNT
}

#[cfg(test)]
mod survey_tests {
    use super::*;
    use fmw_noise::expressions::fulgora_scrap::ScrapControls;
    use std::sync::Mutex;

    /// Serialises access to the module's `SCRATCH` and `RENDER` statics.
    ///
    /// **These tests were racy when they landed in #342 and CI passed them
    /// anyway.** Every one writes a request into the single `SCRATCH` buffer
    /// and reads the single `RENDER` buffer, and cargo runs tests in parallel -
    /// so one test's request overwrites another's mid-call. It surfaced as
    /// `a_nauvis_request_is_not_surveyed` getting `0`: the survey succeeded
    /// because it had been handed a neighbouring test's VALID Fulgora request.
    ///
    /// Measured before the fix: 2-3 failures in every parallel run, 0 in every
    /// single-threaded one. That is the shape to check for whenever a test here
    /// touches the statics - a `--test-threads=1` run passing while the default
    /// fails is the signature, and it is invisible to a single green CI run.
    static BUFFERS: Mutex<()> = Mutex::new(());

    /// The TypeScript side views `RENDER` as a `Float64Array`, so its offset
    /// must be a multiple of 8. Checks the declaration, not where one compiler
    /// happened to put it - that luck is what #473 ran out of.
    #[test]
    fn the_render_buffer_is_aligned_for_a_float64_view() {
        assert!(core::mem::align_of::<RenderBuffer>() >= core::mem::align_of::<f64>());
        assert_eq!(render_ptr() % 8, 0);
    }

    /// A Fulgora request over a strided box, built from the layout table.
    ///
    /// Written here rather than borrowed from `abi`'s test helpers, which are
    /// private to that module - and deliberately so, since a survey request
    /// varies the geometry those helpers hold fixed.
    fn survey_request(seed0: u32, x0: f64, y0: f64, step: f64, nx: u32, ny: u32) -> Vec<u8> {
        let mut b = vec![0u8; abi::COMMON_BYTES + abi::FULGORA_PARAMS_BYTES];
        b[0..4].copy_from_slice(&abi::MAGIC.to_le_bytes());
        b[4..8].copy_from_slice(&abi::ABI_VERSION.to_le_bytes());
        b[8..12].copy_from_slice(&abi::PLANET_FULGORA.to_le_bytes());
        b[16..20].copy_from_slice(&seed0.to_le_bytes());
        b[20..24].copy_from_slice(&nx.to_le_bytes());
        b[24..28].copy_from_slice(&ny.to_le_bytes());
        b[28..32].copy_from_slice(&(abi::FULGORA_PARAMS_BYTES as u32).to_le_bytes());
        b[32..40].copy_from_slice(&x0.to_le_bytes());
        b[40..48].copy_from_slice(&y0.to_le_bytes());
        b[48..56].copy_from_slice(&step.to_le_bytes());
        let p = abi::COMMON_BYTES;
        b[p..p + 8].copy_from_slice(&1.0f64.to_le_bytes());
        b[p + 8..p + 16].copy_from_slice(&1.0f64.to_le_bytes());
        // Trig for the two bearings. Real values rather than zeros: a zeroed
        // pair is not a unit vector and would put the starting spot somewhere
        // the game never places it.
        for (i, v) in [0.6f64, 0.8, -0.28, 0.96].iter().enumerate() {
            b[p + 16 + i * 8..p + 24 + i * 8].copy_from_slice(&v.to_le_bytes());
        }
        b
    }

    fn run_survey(req: &[u8]) -> u32 {
        unsafe {
            let scratch = core::slice::from_raw_parts_mut(
                core::ptr::addr_of_mut!(SCRATCH).cast::<u8>(),
                SCRATCH_BYTES,
            );
            scratch[..req.len()].copy_from_slice(req);
        }
        survey_fulgora_cells(req.len() as u32)
    }

    fn survey_triple(i: usize) -> (f64, f64, f64) {
        let out = unsafe {
            core::slice::from_raw_parts(core::ptr::addr_of!(RENDER).cast::<u8>(), RENDER_BYTES)
        };
        let at = i * SURVEY_STRIDE_BYTES;
        let read = |o: usize| {
            let mut buf = [0u8; 8];
            buf.copy_from_slice(&out[o..o + 8]);
            f64::from_le_bytes(buf)
        };
        (read(at), read(at + 8), read(at + 16))
    }

    /// The cheap two-layer path answers exactly what the full stack does.
    ///
    /// This is the whole correctness claim of the export. `FulgoraStack::eval`
    /// computes elevation, roads, ruins and scrap in one eager pass; the survey
    /// builds only `shared` and `cells`. Those are the same types, but "same
    /// type" is not "same answer" - the stack could in principle feed the cell
    /// layer something the standalone construction does not. So it is compared
    /// rather than argued, at every position of a real band.
    #[test]
    fn the_survey_matches_the_full_stack_at_every_position() {
        // Poison-tolerant: a panicking sibling must not turn every later
        // test into a lock error that hides the original failure.
        let _guard = BUFFERS.lock().unwrap_or_else(|e| e.into_inner());
        let (x0, y0, step, nx, ny) = (-1024.0, 512.0, 21.875, 24u32, 19u32);
        let seed0 = 2_967_702_466u32;
        assert_eq!(run_survey(&survey_request(seed0, x0, y0, step, nx, ny)), 0);

        let ctx = fulgora_shared::FulgoraCtx {
            seed0,
            islands_frequency: 1.0,
            islands_size: 1.0,
        };
        let mut stack = fulgora_stack::FulgoraStack::new(
            &ctx,
            &ScrapControls::default(),
            AngleTrig::new(0.6, 0.8),
            AngleTrig::new(-0.28, 0.96),
        );

        let mut distinct_ids = 0;
        let mut seen: Option<f64> = None;
        for py in 0..ny {
            for px in 0..nx {
                let x = x0 + f64::from(px) * step;
                let y = y0 + f64::from(py) * step;
                let want = stack.eval(x, y);
                let (id, cx, cy) = survey_triple((py * nx + px) as usize);
                assert_eq!(id.to_bits(), want.cells.cells.to_bits(), "id at ({x}, {y})");
                assert_eq!(
                    cx,
                    f64::from(want.cells.cell_index.0),
                    "cellX at ({x}, {y})"
                );
                assert_eq!(
                    cy,
                    f64::from(want.cells.cell_index.1),
                    "cellY at ({x}, {y})"
                );
                if seen != Some(id) {
                    distinct_ids += 1;
                    seen = Some(id);
                }
            }
        }
        // Anti-vacuity: a band that returned one constant would satisfy every
        // assertion above while grading nothing. This counts RUNS rather than
        // unique values, so it also refuses a band that is one cell throughout.
        assert!(
            distinct_ids > 20,
            "the band is nearly constant: {distinct_ids} runs"
        );
    }

    /// A band larger than the buffer is refused rather than overrunning it.
    #[test]
    fn a_band_past_the_buffer_is_refused() {
        // Poison-tolerant: a panicking sibling must not turn every later
        // test into a lock error that hides the original failure.
        let _guard = BUFFERS.lock().unwrap_or_else(|e| e.into_inner());
        let too_many = (SURVEY_MAX_POSITIONS as u32) / 100 + 1;
        let req = survey_request(1, 0.0, 0.0, 8.0, too_many, 101);
        assert_eq!(run_survey(&req), abi::Status::OutputTooLarge as u32);
        // And the largest legal band is accepted, so the bound is the real one
        // rather than something stricter that happens to refuse the case above.
        let exact = survey_request(1, 0.0, 0.0, 8.0, SURVEY_MAX_POSITIONS as u32, 1);
        assert_eq!(run_survey(&exact), 0);
    }

    /// A non-Fulgora request is refused rather than read as one.
    #[test]
    fn a_nauvis_request_is_not_surveyed() {
        // Poison-tolerant: a panicking sibling must not turn every later
        // test into a lock error that hides the original failure.
        let _guard = BUFFERS.lock().unwrap_or_else(|e| e.into_inner());
        let mut b = survey_request(1, 0.0, 0.0, 8.0, 2, 2);
        b[8..12].copy_from_slice(&abi::PLANET_NAUVIS.to_le_bytes());
        // The declared params length still says Fulgora's, so this is refused
        // as a length error before the planet is ever read - which is the
        // check doing its job, and why the planet guard needs its own case.
        assert_ne!(run_survey(&b), 0);
    }

    /// The step the module reports is the one the finder was written against.
    #[test]
    fn the_reported_step_is_grid_over_eight() {
        let step = fulgora_survey_step(2_967_702_466, 1.0, 1.0, 0.6, 0.8, -0.28, 0.96);
        let ctx = fulgora_shared::FulgoraCtx {
            seed0: 2_967_702_466,
            islands_frequency: 1.0,
            islands_size: 1.0,
        };
        let shared = fulgora_shared::FulgoraShared::new(
            &ctx,
            AngleTrig::new(0.6, 0.8),
            AngleTrig::new(-0.28, 0.96),
        );
        assert_eq!(step, shared.grid / 8.0);
        // It MOVES with the frequency lever - a constant would pass the line
        // above and still be wrong for any non-default preset.
        let other = fulgora_survey_step(2_967_702_466, 3.0, 1.0, 0.6, 0.8, -0.28, 0.96);
        assert_ne!(step, other);
    }
}

#[cfg(test)]
mod native_parity;

/// The Aquilo render entry, through the real decoder.
#[cfg(test)]
mod aquilo_render_tests {
    use crate::abi::{self, Status, AQUILO_PARAMS_BYTES, COMMON_BYTES};
    use crate::render::{
        render, PLANET_AQUILO, VIEW_ALL, VIEW_CLIFFS, VIEW_ENTITY_FOOTPRINT, VIEW_LANDMASK,
        VIEW_RESOURCES, VIEW_ROCKS, VIEW_TERRAIN, VIEW_TREES,
    };
    use fmw_noise::expressions::aquilo_resources::AquiloBearings;
    use fmw_noise::tiles::aquilo_catalog::TILE_ORDER;

    /// The derived Aquilo surface seed for map seed 123456.
    const SEED0: u32 = 3_111_923_328;
    const FLUORINE_COLOR: [u8; 3] = [0, 204, 255];

    /// A request with the three bearings from the host libm. The shipped
    /// engine gets V8's values; these are close enough for the tiny vent's
    /// position, which the test reads back from the same values.
    fn request(view: u32, (w, h): (u32, u32), (ox, oy): (f64, f64), fluorine_size: f64) -> Vec<u8> {
        let mut b = vec![0u8; COMMON_BYTES + AQUILO_PARAMS_BYTES];
        let put_u32 = |b: &mut Vec<u8>, at: usize, v: u32| {
            b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        };
        let put_f64 = |b: &mut Vec<u8>, at: usize, v: f64| {
            b[at..at + 8].copy_from_slice(&v.to_le_bytes());
        };
        put_u32(&mut b, 0, abi::MAGIC);
        put_u32(&mut b, 4, abi::ABI_VERSION);
        put_u32(&mut b, 8, PLANET_AQUILO);
        put_u32(&mut b, 12, view);
        put_u32(&mut b, 16, SEED0);
        put_u32(&mut b, 20, w);
        put_u32(&mut b, 24, h);
        put_u32(&mut b, 28, AQUILO_PARAMS_BYTES as u32);
        put_f64(&mut b, 32, ox);
        put_f64(&mut b, 40, oy);
        put_f64(&mut b, 48, 1.0);
        let p = COMMON_BYTES;
        for (i, (f, s)) in [(1.0, 1.0), (1.0, 1.0), (1.0, fluorine_size)]
            .into_iter()
            .enumerate()
        {
            put_f64(&mut b, p + i * 16, f);
            put_f64(&mut b, p + 8 + i * 16, s);
        }
        let bearings = AquiloBearings::from_host(SEED0);
        for (i, t) in [
            bearings.crude_oil,
            bearings.lithium_brine,
            bearings.fluorine_vent,
        ]
        .into_iter()
        .enumerate()
        {
            put_f64(&mut b, p + 48 + i * 16, t.sin);
            put_f64(&mut b, p + 56 + i * 16, t.cos);
        }
        let sweep = [
            ox - 1.0,
            oy - 1.0,
            ox + f64::from(w) + 1.0,
            oy + f64::from(h) + 1.0,
        ];
        for (i, v) in sweep.into_iter().enumerate() {
            put_f64(&mut b, p + 96 + i * 8, v);
        }
        b
    }

    fn run(view: u32, dims: (u32, u32), origin: (f64, f64), fluorine_size: f64) -> Vec<u8> {
        let mut out = vec![0u8; dims.0 as usize * dims.1 as usize * 4];
        let status = render(&request(view, dims, origin, fluorine_size), &mut out);
        assert_eq!(status, Status::Ok);
        out
    }

    /// A 48x48 window centred on the tiny fluorine vent, which the game puts
    /// 80 tiles from the origin on the fluorine bearing.
    fn vent_window() -> ((u32, u32), (f64, f64)) {
        let t = AquiloBearings::from_host(SEED0).fluorine_vent;
        let (cx, cy) = (80.0 * t.sin, -80.0 * t.cos);
        ((48, 48), ((cx - 24.0).floor(), (cy - 24.0).floor()))
    }

    fn count(px: &[u8], color: [u8; 3]) -> usize {
        px.as_chunks::<4>()
            .0
            .iter()
            .filter(|p| p[..3] == color)
            .count()
    }

    #[test]
    fn terrain_paints_only_catalogued_tile_colours_and_more_than_one() {
        let (dims, origin) = vent_window();
        let px = run(VIEW_TERRAIN, dims, origin, 1.0);
        let allowed: Vec<[u8; 3]> = TILE_ORDER.iter().map(|t| t.color()).collect();
        let mut seen = std::collections::BTreeSet::new();
        for p in px.as_chunks::<4>().0.iter() {
            assert!(allowed.contains(&[p[0], p[1], p[2]]), "stray {p:?}");
            assert_eq!(p[3], 255);
            seen.insert([p[0], p[1], p[2]]);
        }
        assert!(seen.len() > 1, "a constant image grades nothing");
    }

    #[test]
    fn the_resource_view_paints_the_guaranteed_vent_and_the_size_lever_removes_it() {
        let (dims, origin) = vent_window();
        let terrain = run(VIEW_TERRAIN, dims, origin, 1.0);
        let wells = run(VIEW_RESOURCES, dims, origin, 1.0);
        assert_eq!(
            count(&terrain, FLUORINE_COLOR),
            0,
            "control: terrain has none"
        );
        assert!(
            count(&wells, FLUORINE_COLOR) > 0,
            "no vent mark near the spawn cone"
        );
        // The fluorine size lever is wired to the fluorine well and nothing
        // else: at size 0 the same window has no vent mark.
        let off = run(VIEW_RESOURCES, dims, origin, 0.0);
        assert_eq!(count(&off, FLUORINE_COLOR), 0);
    }

    #[test]
    fn the_all_view_is_terrain_plus_both_overlays() {
        let (dims, origin) = vent_window();
        let all = run(VIEW_ALL, dims, origin, 1.0);
        let wells = run(VIEW_RESOURCES, dims, origin, 1.0);
        let rocks = run(VIEW_ROCKS, dims, origin, 1.0);
        let terrain = run(VIEW_TERRAIN, dims, origin, 1.0);
        // Every pixel `all` shares with neither overlay is terrain.
        for i in (0..all.len()).step_by(4) {
            if wells[i..i + 4] == terrain[i..i + 4] && rocks[i..i + 4] == terrain[i..i + 4] {
                assert_eq!(all[i..i + 4], terrain[i..i + 4]);
            }
        }
        assert!(count(&all, FLUORINE_COLOR) > 0);
        assert_ne!(all, terrain);
    }

    #[test]
    fn the_footprint_view_is_black_and_white_and_covers_the_vent() {
        let (dims, origin) = vent_window();
        let px = run(VIEW_ENTITY_FOOTPRINT, dims, origin, 1.0);
        let white = count(&px, [255, 255, 255]);
        let black = count(&px, [0, 0, 0]);
        assert_eq!(white + black, px.len() / 4, "only black and white");
        assert!(white > 0 && black > 0, "white {white}, black {black}");
        // The tiny vent's centre tile has probability 1, so it is white.
        let t = AquiloBearings::from_host(SEED0).fluorine_vent;
        let (cx, cy) = (80.0 * t.sin, -80.0 * t.cos);
        let (px_x, px_y) = (
            (cx.round() - origin.0) as usize,
            (cy.round() - origin.1) as usize,
        );
        let o = (px_y * dims.0 as usize + px_x) * 4;
        assert_eq!(px[o..o + 3], [255, 255, 255]);
        // With the fluorine size at 0 that vent no longer counts.
        let off = run(VIEW_ENTITY_FOOTPRINT, dims, origin, 0.0);
        assert_ne!(px, off);
    }

    #[test]
    fn views_aquilo_does_not_serve_are_refused() {
        for view in [VIEW_LANDMASK, 2, VIEW_CLIFFS, VIEW_TREES, 8, 9, 10, 11, 13] {
            let b = request(view, (2, 2), (0.0, 0.0), 1.0);
            let mut out = vec![0u8; 16];
            assert_eq!(
                render(&b, &mut out),
                Status::UnsupportedPlanetOrView,
                "view {view}"
            );
        }
    }
}
