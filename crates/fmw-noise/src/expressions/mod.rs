//! Named noise expressions, ported from `src/noise/expressions/`.
//!
//! Phase 2 lands only the two engine seed variables, because the evaluation
//! context needs them. The rest arrives with its planet - Fulgora in #223/#224,
//! Vulcanus in #225, Nauvis in #226.

pub mod vulcanus_seed;
