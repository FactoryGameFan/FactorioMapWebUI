//! The Nauvis enemy-base layer, ported from `src/noise/enemies/`.
//!
//! One noise expression, `enemy_base_probability`, and the constants and
//! distance scalars it reads. It drives the deterministic enemy-base spawner,
//! which is what the client-side overlay reproduces.
//!
//! See `docs/nauvis-enemies-port-survey.md` for the dependency inventory and
//! the measurements behind the tests - in particular why the exact f32 match
//! count on this field measures MAGNITUDE rather than accuracy.

pub mod catalog;
pub mod field;
pub mod placement;
