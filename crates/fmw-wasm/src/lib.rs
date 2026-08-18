//! The WASM boundary, and nothing else. No logic lives here.
//!
//! Phase 0c exports only the parity checksum, which is enough to prove the
//! whole loading path works - compile the module, instantiate it, write into
//! linear memory, read a result back - before any noise math depends on it.

use fmw_noise::{basis_noise, checksum};

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
