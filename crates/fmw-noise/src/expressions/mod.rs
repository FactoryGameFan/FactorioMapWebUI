//! Named noise expressions, ported from `src/noise/expressions/`.
//!
//! Phase 2 landed the two engine seed variables, because the evaluation context
//! needs them. Phase 3 adds Fulgora's landmask chain - the shared layer, the
//! Voronoi cell classification, and the elevation mix - plus the
//! `starting_spot_at_angle` cone all three read. The rest arrives with its
//! planet: the remainder of Fulgora in #224, Vulcanus in #225, Nauvis in #226.

pub mod fulgora_cells;
pub mod fulgora_elevation;
pub mod fulgora_masks;
pub mod fulgora_roads;
pub mod fulgora_ruins;
pub mod fulgora_scrap;
pub mod fulgora_shared;
pub mod fulgora_stack;
pub mod starting_spot_at_angle;
pub mod vulcanus_helpers;
pub mod vulcanus_seed;
