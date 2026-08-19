//! The reverse-engineered Factorio map generator, ported from `src/noise/`.
//!
//! Correctness here means agreement with the game at f32, graded against the
//! oracle fixtures under `test/fixtures/`. See
//! `docs/superpowers/specs/2026-08-16-rust-wasm-noise-engine-design.md`.

// clippy::suboptimal_flops recommends `a.mul_add(b, c)` for `a * b + c`. That
// is a FUSED multiply-add, which rounds once instead of twice and so changes
// results - the exact hazard that made Rust the choice over Go, whose spec
// permits the same fusion. The lint lives in `nursery`, so it is off today.
// This allow exists so that turning `nursery` on later cannot silently push
// the port toward FMA.
#![allow(clippy::suboptimal_flops)]

pub mod basis_gradient_table;
pub mod basis_noise;
pub mod checksum;
pub mod fast_approx;
pub mod multioctave_noise;
pub mod quick_multioctave_noise;
pub mod taus88;
pub mod variable_persistence_multioctave_noise;

#[cfg(test)]
mod test_json;

#[cfg(test)]
mod fixtures;
