//! The rock overlays, ported from `src/noise/rocks/`.
//!
//! **Vulcanus only.** `src/noise/rocks/rockField.ts` is the NAUVIS rock field
//! and is deliberately not here: it needs `nauvis_shared`, `elevation_nauvis`,
//! `aux` and `moisture` from the Nauvis expression tree, none of which is
//! ported, and it reaches no Vulcanus view. It belongs to #226 along with
//! `src/noise/cliffs/cliffFields.ts`, for the same reason.

pub mod catalog;
pub mod vulcanus_field;
pub mod vulcanus_placement;
