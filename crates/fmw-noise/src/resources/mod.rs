//! The resource OVERLAY layer: how the game's resource probabilities turn into
//! placed entities.
//!
//! Distinct from `expressions::vulcanus_resources`, which is the noise chain.
//! This is the thin layer above it - thresholds, footprints and the per-entry
//! catalog - ported from `src/noise/resources/`.
//!
//! Only the ore FOOTPRINT is here so far. It arrived with the cliff stack,
//! because the ore -> cliff rejection asks exactly this question, and the rest
//! of the catalog (map colours, the geyser's rolled probability) lands with the
//! resource overlay itself.

pub mod vulcanus_catalog;
