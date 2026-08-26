//! The Nauvis tree layer, ported from `src/noise/trees/`.
//!
//! **Nauvis only, and there is no other planet's trees to come** - Vulcanus and
//! Fulgora have none. The layer is the 15 species' autoplace probability
//! expressions, the two shared noise fields they read, the `asymmetric_ramps`
//! builtin behind their climate boxes, and the per-pixel density the renderer
//! draws.
//!
//! Read `docs/nauvis-trees-port-survey.md` before changing any of it: it
//! inventories the argument orders, the one per-species term that an early
//! draft got wrong by 5.01e-2, and where the f32 narrowing does and does not
//! go.

pub mod asymmetric_ramps;
pub mod catalog;
pub mod field;
pub mod shared;
