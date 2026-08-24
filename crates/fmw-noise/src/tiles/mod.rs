//! The tile layer: the helpers each tile's probability expression composes, the
//! Fulgora ocean test the land mask is built on, and Fulgora's full tile
//! catalog.
//!
//! Phase 3 landed only what the land mask needs (#223); phase 4 added the eight
//! land formulas and the argmax between them (#224). Phase 5 adds Vulcanus's 19
//! tiles (#225).

pub mod fulgora_catalog;
pub mod fulgora_ocean;
pub mod helpers;
pub mod vulcanus_catalog;
