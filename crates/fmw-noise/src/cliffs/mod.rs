//! The cliff layer: the placement grid, the crossing rule, the repair sweep,
//! the apply-time connection pass, and Vulcanus's two cliff fields.
//!
//! Ported from `src/noise/cliffs/` in phase 5's second half (#225). What lives
//! here is `CliffGenerator` / `Cliff` behaviour rather than planet behaviour:
//! the 4-tile corner lattice, `crossesCliff`, `fixImpossibleCells`, the
//! orientation tables and the connection rules are the same on every planet.
//! Only [`vulcanus_fields`] and [`vulcanus_ore_rejection`] know which planet
//! they are on.
//!
//! Nauvis's own cliff fields (`cliffFields.ts`) are NOT here. They need
//! `nauvis_shared` and `elevation_nauvis`, which arrive with #226.

pub mod catalog;
pub mod connections;
pub mod placement;
pub mod vulcanus_fields;
pub mod vulcanus_ore_rejection;
