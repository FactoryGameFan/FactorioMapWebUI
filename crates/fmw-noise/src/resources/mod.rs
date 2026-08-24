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

pub mod vulcanus_catalog;
pub mod vulcanus_geyser;
