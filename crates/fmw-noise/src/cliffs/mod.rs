//! The cliff layer: the placement grid, the crossing rule, the repair sweep,
//! the apply-time connection pass, and Vulcanus's two cliff fields.
//!
//! Ported from `src/noise/cliffs/` in phase 5's second half (#225). What lives
//! here is `CliffGenerator` / `Cliff` behaviour rather than planet behaviour:
//! the 4-tile corner lattice, `crossesCliff`, `fixImpossibleCells`, the
//! orientation tables and the connection rules are the same on every planet.
//! Only [`fields`], [`vulcanus_fields`] and [`vulcanus_ore_rejection`] know
//! which planet they are on.
//!
//! Nauvis's own cliff fields arrived with #226 and live in [`fields`]. They are
//! named for the planet the way the Vulcanus pair is, so the two sit side by
//! side rather than one of them owning the unqualified name.

pub mod catalog;
pub mod connections;
pub mod fields;
pub mod placement;
pub mod vulcanus_fields;
pub mod vulcanus_ore_rejection;
