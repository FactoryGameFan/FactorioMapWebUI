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
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn checksum_variable_persistence(
    seed0: u32,
    seed1: u32,
    octaves: u32,
    input_scale: f64,
    output_scale: f64,
    offset_x: f64,
    persistence: f32,
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
