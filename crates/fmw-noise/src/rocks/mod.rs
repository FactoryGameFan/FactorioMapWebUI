//! The rock overlays, ported from `src/noise/rocks/`.
//!
//! Both planets. [`field`] is Nauvis and [`vulcanus_field`] is Vulcanus; they
//! share [`catalog`] and nothing else, because the two planets' rock
//! probabilities are unrelated expressions that happen to draw in the same
//! colour.
//!
//! This module doc used to say "**Vulcanus only**", because `rockField.ts`
//! needs `aux`, `moisture` and the shared Nauvis layer and none of them was
//! ported. All three arrived earlier in #226, and the field followed.

pub mod catalog;
pub mod field;
pub mod nauvis_placement;
pub mod vulcanus_field;
pub mod vulcanus_placement;
