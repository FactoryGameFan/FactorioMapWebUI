//! The resource OVERLAY layer: how the game's resource probabilities turn into
//! placed entities.
//!
//! Distinct from `expressions::vulcanus_resources`, which is the noise chain.
//! This is the thin layer above it - thresholds, footprints and the per-entry
//! catalog - ported from `src/noise/resources/`.
//!
//! The ore FOOTPRINT arrived first, with the cliff stack, because the ore ->
//! cliff rejection asks exactly this question. The rest of the catalog - map
//! colours, the entry ordering, the geyser's rolled probability - and the
//! geyser's own placement landed with the resource overlay itself.

//! The NAUVIS half arrived with phase 6 and is the whole of
//! `src/noise/resources/`: the six-entry catalog, the distance-dependent
//! scalars, the two spot fields, their outer `max`, and the order-priority
//! resolver above them. Read `docs/nauvis-resources-port-survey.md` before
//! changing any of it - it inventories the argument orders, the narrowing
//! points and the eight constants that moved between 2.0.77 and 2.1.9.

pub mod nauvis_catalog;
pub mod regular_patches;
pub mod resolve_resource;
pub mod resource_math;
pub mod resource_patches;
pub mod starting_patches;
pub mod vulcanus_catalog;
pub mod vulcanus_geyser;
