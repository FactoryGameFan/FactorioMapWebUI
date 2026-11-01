//! Aquilo's lithium icebergs, `lithium-iceberg-huge` and `lithium-iceberg-big`:
//! the catalogue that [`crate::placement::aquilo`] places.
//!
//! Both are `simple-entity` prototypes in
//! `space-age/prototypes/decorative/decoratives-aquilo.lua` (2.1.23), with
//! probabilities that read only `aquilo_high_frequency_peaks`:
//!
//! | | `lithium-iceberg-huge` | `lithium-iceberg-big` |
//! | --- | --- | --- |
//! | probability | `(aquilo_high_frequency_peaks - 0.8) * 0.1` | `(aquilo_high_frequency_peaks - 0.7) * 0.8` |
//! | `collision_box` | `{{-1.85, -1.25}, {1.85, 1.25}}`: 3.7 x 2.5 | `{{-1.0, -0.75}, {1.0, 0.75}}`: 2.0 x 1.5 |
//! | autoplace `order` | `a[rock]-a[huge]` | `a[rock]-b[big]` |
//! | `collision_mask` | `item`, `object`, `player`, `water_tile` | the same |
//! | `map_color` | `lithium_rock_map_colour` = `{168, 188, 211}` | the same |
//!
//! There is no TypeScript counterpart; Aquilo is ported Rust-first. The
//! `lithium-iceberg-medium` and smaller kin are `optimized-decorative`s, which
//! the map preview does not draw.
//!
//! [`crate::placement::aquilo`] places them through the game's own
//! generator. Each is its own autoplace group, huge first, so huge icebergs
//! claim their places before big ones roll at all. That is how the game gets
//! about 12% huge although big's probability is the larger wherever either is
//! above 0: there is no arbitration between the two.
//!
//! ## The six land tiles
//!
//! The census (`test/fixtures/oracle-aquilo-entities.seed123456.json`,
//! derived seed 3111923328, tiles -256..255) has all 180 icebergs on land
//! (`tileWithoutEffect`, the same as `tile` for icebergs):
//!
//! | tile | big | huge |
//! | --- | ---: | ---: |
//! | `snow-flat` | 31 | 6 |
//! | `snow-crests` | 20 | 3 |
//! | `snow-lumpy` | 33 | 4 |
//! | `snow-patchy` | 13 | 2 |
//! | `ice-rough` | 28 | 2 |
//! | `ice-smooth` | 34 | 4 |
//! | `brash-ice`, both oceans | 0 | 0 |
//!
//! The prototypes say why: both `collision_mask`s carry `water_tile`, and
//! `tile_collision_masks.ammoniacal_ocean()`
//! (`base/prototypes/tile/tile-collision-masks.lua:30-40` at 2.1.23) lists
//! `water_tile = true`. That mask is the one both oceans and `brash-ice` use
//! (`space-age/prototypes/tile/tiles-aquilo.lua:135`, `:147` and `:500`). The
//! snow tiles use `ground()` and the ice tiles `meltable_tile()`, which do not.
//!
//! The game tests the mask first at the iceberg's own tile, to decide whether
//! it is a candidate (and so spends a draw), then at every tile under its box.
//!
//! ## Colour
//!
//! `lithium_rock_map_colour = {168, 188, 211}` (`decoratives-aquilo.lua:9`)
//! is already in 0-255 units. The game's full preview
//! (`test/fixtures/oracle-preview-aquilo-full.seed123456.png`) draws 4,609
//! pixels of exactly (168, 188, 211), the one non-tile colour there besides
//! the three wells' (see `resources::aquilo_wells`).

use crate::poison;
use crate::tiles::aquilo_catalog::AquiloTile;

/// `lithium_rock_map_colour`, shared by both prototypes, as the game's preview
/// draws it.
pub const ICEBERG_COLOR: [u8; 3] = [168, 188, 211];

/// One of the two iceberg prototypes the preview draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AquiloIceberg {
    Huge,
    Big,
}

/// The two in autoplace `order`: huge's group rolls first.
pub const ICEBERG_ORDER: [AquiloIceberg; 2] = [AquiloIceberg::Huge, AquiloIceberg::Big];

impl AquiloIceberg {
    /// The prototype's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::Huge => "lithium-iceberg-huge",
            Self::Big => "lithium-iceberg-big",
        }
    }

    /// The prototype's `map_color`. Both share one.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        ICEBERG_COLOR
    }
}

/// Narrow to f32 and back, the noise machine's per-op rounding.
fn f32r(v: f64) -> f64 {
    f64::from(v as f32)
}

/// The two probabilities in [`ICEBERG_ORDER`], unclamped, each op in f32:
/// `(h - 0.8) * 0.1` and `(h - 0.7) * 0.8`.
#[must_use]
pub fn iceberg_probabilities(high_frequency_peaks: f64) -> [f64; 2] {
    let h = f32r(high_frequency_peaks);
    let huge = f32r(f32r(h - f64::from(0.8f32)) * f64::from(0.1f32));
    let big = f32r(f32r(h - f64::from(0.7f32)) * f64::from(0.8f32));
    [huge, big].map(poison::f64_result)
}

/// Whether an iceberg may stand on this tile: the six land tiles.
#[must_use]
pub fn iceberg_tile_allowed(tile: AquiloTile) -> bool {
    !matches!(
        tile,
        AquiloTile::BrashIce | AquiloTile::AmmoniacalOcean | AquiloTile::AmmoniacalOcean2
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::aquilo_catalog::TILE_ORDER;

    /// Wherever either probability is above 0, big is strictly the larger:
    /// swept in f32 steps of 1/1024 over the field's whole positive range and
    /// past it. So the game's huge icebergs (about 12%) cannot come from an
    /// argmax between the two; they come from huge's group rolling first.
    #[test]
    fn big_is_the_larger_wherever_either_iceberg_can_place() {
        let mut positive = 0;
        for i in 0..4096 {
            let h = f64::from(i) / 1024.0;
            let [huge, big] = iceberg_probabilities(h);
            if huge > 0.0 || big > 0.0 {
                positive += 1;
                assert!(big > huge, "h = {h}: huge {huge} against big {big}");
            }
        }
        // Non-vacuity: the sweep crosses big's zero at h = 0.7.
        assert!(positive > 3000, "{positive}");
    }

    /// The gate is the six land tiles, and only those.
    #[test]
    fn icebergs_stand_on_the_six_land_tiles_only() {
        let allowed: Vec<&str> = TILE_ORDER
            .iter()
            .filter(|t| iceberg_tile_allowed(**t))
            .map(|t| t.game_name())
            .collect();
        assert_eq!(
            allowed,
            vec![
                "snow-flat",
                "snow-crests",
                "snow-lumpy",
                "snow-patchy",
                "ice-rough",
                "ice-smooth"
            ]
        );
    }
}
