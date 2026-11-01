//! Aquilo's three wells: crude oil, lithium brine and fluorine vent. The
//! catalogue - names, probabilities and colours - that
//! [`crate::placement::aquilo`] places through the game's own generator.
//!
//! The probabilities are `expressions::aquilo_resources`' three
//! `aquilo_*_probability` fields, graded exact against the game. There is no
//! TypeScript counterpart; Aquilo is ported Rust-first.
//!
//! [`WELL_ORDER`] sorts the prototypes by their autoplace `order` strings:
//! fluorine vent `a[resources]-a[fluorine]`, lithium brine
//! `a[resources]-b[lithium]`, then crude oil `c` (the base prototype's; Aquilo
//! swaps in its probability and richness through the planet's
//! `property_expression_names`, `planet-map-gen.lua:439-440`, and leaves the
//! order alone). Each is its own autoplace group, so the three are never
//! arbitrated against each other: each rolls its own 1,024 draws per chunk.
//!
//! ## The guaranteed vent near spawn
//!
//! `aquilo_starting_flourine_vent_tiny` is a cone of radius 1 at distance 80,
//! and the fluorine probability holds `tiny > 0` as a term, so the probability
//! is exactly 1 at every integer corner strictly inside that unit disk. The
//! corner nearest the cone's centre is at most `sqrt(2) / 2` from it, so at
//! least one tile always has probability 1 and its roll always passes. Two to
//! four corners can share the disk, and the generator queues a vent on each.
//! The preview draws them all; a real surface keeps the first in queue order.
//! The tests are in [`crate::placement::aquilo`] and `fixtures`.
//!
//! ## `tile_allowed`: every tile
//!
//! The census (`test/fixtures/oracle-aquilo-entities.seed123456.json`,
//! derived seed 3111923328, tiles -256..255) has 19 wells. Read on its
//! `tileWithoutEffect` column (the shipped `tile` column shows the wells' own
//! later rewrite of the ocean under them), they stand on:
//!
//! | tile | crude oil | lithium brine | fluorine vent |
//! | --- | ---: | ---: | ---: |
//! | `ice-rough` | 3 | 2 | 0 |
//! | `ice-smooth` | 3 | 1 | 0 |
//! | `snow-crests` | 1 | 0 | 0 |
//! | `ammoniacal-ocean` | 2 | 0 | 2 |
//! | `ammoniacal-ocean-2` | 2 | 1 | 2 |
//!
//! So wells stand on land and on both oceans. None stands on `snow-flat`,
//! `snow-lumpy`, `snow-patchy` or `brash-ice`, but 19 wells cannot show that a
//! tile is barred. The prototypes say none is: a resource's default
//! `collision_mask` is `{layers = {resource = true}}`, and on Aquilo no tile
//! mask carries `resource`. `tile_collision_masks.ammoniacal_ocean()`
//! (`base/prototypes/tile/tile-collision-masks.lua:30-40` at 2.1.23) comments
//! it out (`--resource=true`), and that mask is the one both oceans and
//! `brash-ice` use (`space-age/prototypes/tile/tiles-aquilo.lua:135`, `:147`
//! and `:500`). The snow tiles use `ground()` and the ice tiles
//! `meltable_tile()`, neither of which lists `resource`. None of the three
//! prototypes declares a `tile_restriction`. So the gate is the trait's
//! default, true everywhere.
//!
//! ## Colours
//!
//! Each well's `map_color` times 255, truncated: crude oil `{0.78, 0.2, 0.77}`
//! (`base/prototypes/entity/resources.lua:334`), lithium brine
//! `{0.7, 1.0, 0.6}` and fluorine vent `{0.0, 0.8, 1.0}`
//! (`space-age/prototypes/entity/resources.lua:382` and `:511`). The game's
//! full preview (`test/fixtures/oracle-preview-aquilo-full.seed123456.png`)
//! draws exactly these three triples and no other well colour:
//!
//! | well | from `map_color` | in the PNG | pixels |
//! | --- | --- | --- | ---: |
//! | crude oil | (198, 51, 196) | (198, 51, 196) | 475 |
//! | lithium brine | (178, 255, 153) | (178, 255, 153) | 451 |
//! | fluorine vent | (0, 204, 255) | (0, 204, 255) | 157 |
//!
//! Crude oil's 198 (from 198.9) is what shows the channels are truncated, not
//! rounded.

use crate::expressions::aquilo_resources::AquiloResourceFields;

/// One of Aquilo's three wells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AquiloWell {
    CrudeOil,
    LithiumBrine,
    FluorineVent,
}

/// The three in autoplace `order`. See the module docs.
pub const WELL_ORDER: [AquiloWell; 3] = [
    AquiloWell::FluorineVent,
    AquiloWell::LithiumBrine,
    AquiloWell::CrudeOil,
];

impl AquiloWell {
    /// The prototype's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::CrudeOil => "crude-oil",
            Self::LithiumBrine => "lithium-brine",
            Self::FluorineVent => "fluorine-vent",
        }
    }

    /// The prototype's `map_color`, as the game's preview draws it. See the
    /// module docs for the table.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        match self {
            Self::CrudeOil => [198, 51, 196],
            Self::LithiumBrine => [178, 255, 153],
            Self::FluorineVent => [0, 204, 255],
        }
    }

    /// This well's probability field.
    #[must_use]
    pub fn probability(self, f: &AquiloResourceFields) -> f64 {
        match self {
            Self::CrudeOil => f.crude_oil_probability,
            Self::LithiumBrine => f.lithium_brine_probability,
            Self::FluorineVent => f.fluorine_vent_probability,
        }
    }
}
