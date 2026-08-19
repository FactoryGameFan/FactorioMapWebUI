//! Named noise expressions, ported from `src/noise/expressions/`.
//!
//! Phase 2 landed the two engine seed variables, because the evaluation context
//! needs them. Phase 3 adds Fulgora's landmask chain - the shared layer, the
//! Voronoi cell classification, and the elevation mix - plus the
//! `starting_spot_at_angle` cone all three read. The rest arrives with its
//! planet: the remainder of Fulgora in #224, Vulcanus in #225, Nauvis in #226.

pub mod fulgora_cells;
pub mod fulgora_elevation;
pub mod fulgora_shared;
pub mod starting_spot_at_angle;
pub mod vulcanus_seed;
