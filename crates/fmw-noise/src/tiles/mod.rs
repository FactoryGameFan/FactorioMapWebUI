//! The tile layer: the helpers each tile's probability expression composes, the
//! Fulgora ocean test the land mask is built on, and Fulgora's full tile
//! catalog.
//!
//! Phase 3 landed only what the land mask needs (#223); phase 4 added the eight
//! land formulas and the argmax between them (#224). Phase 5 adds Vulcanus's 19
//! tiles (#225), and phase 6 Nauvis's 21 plus the `expression_in_range` builtin
//! every one of its land tiles composes (#226).

pub mod expression_in_range;
pub mod fulgora_catalog;
pub mod fulgora_ocean;
pub mod helpers;
pub mod nauvis_catalog;
pub mod vulcanus_catalog;
