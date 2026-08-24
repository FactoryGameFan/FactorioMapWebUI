//! The game's per-tile entity PLACEMENT roll, ported from
//! `src/noise/placement/`.
//!
//! Distinct from every other module in this crate: nothing here evaluates a
//! noise expression. This is the layer above them - the taus88 stream
//! `EntityMapGenerationTask::generateEntities` runs per chunk, and the two
//! arbitration gates it applies around the roll.
//!
//! `docs/noise/placement-roll-NOTES.md` carries the disassembly this was
//! recovered from.

pub mod roll;
