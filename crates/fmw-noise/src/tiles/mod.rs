//! The tile layer: the helpers each tile's probability expression composes, and
//! the Fulgora ocean test the land mask is built on.
//!
//! Phase 3 lands only what the Fulgora LAND MASK needs (#223). The eight land
//! tile formulas and the argmax between them arrive with phase 4 (#224).

pub mod fulgora_ocean;
pub mod helpers;
