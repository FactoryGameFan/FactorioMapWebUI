//! Aquilo's tile catalog: the nine tiles in the planet's `autoplace_settings`
//! order, their probability expressions and the argmax between them.
//!
//! Transcribed from `space-age/prototypes/planet/planet-aquilo-map-gen.lua` at
//! 2.1.23 (the fixtures read bit-identical on 2.0.77). `dust-lumpy` and its
//! kin have an autoplace but are not in Aquilo's tile settings, so they are
//! left out.
//!
//! ## Per-op f32
//!
//! The noise machine holds every constant in f32 (so `0.01` is `f32r(0.01)`, a
//! one-ULP difference that cost the oceans 268 of 1,024) and rounds each op to f32, so
//! every step here goes through [`f32r`]. The `100 * aquilo_min_elevation(t)`
//! term is exactly `-100` or `+100`, and it dominates: land versus water is
//! decided there, and the rest of each formula orders the tiles within a
//! side.
//!
//! ## The tie-break is ours, not the game's
//!
//! The argmax keeps the FIRST maximum in [`TILE_ORDER`] and lets a NaN lose,
//! as Fulgora's does. The game's own rule for an exact tie is not established.
//! `oracle-aquilo-fields` reports 0 ties in its 1,024 positions, so the
//! fixture cannot tell. (The two oceans tie exactly where `aux` is 0.5.)

use crate::expressions::aquilo_terrain::AquiloTerrainFields;
use crate::poison;

/// Every tile Aquilo places.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AquiloTile {
    SnowFlat,
    SnowCrests,
    SnowLumpy,
    SnowPatchy,
    IceRough,
    IceSmooth,
    BrashIce,
    AmmoniacalOcean,
    AmmoniacalOcean2,
}

/// The planet's `autoplace_settings.tile` order. The argmax keeps the first
/// maximum, so this is also the tie-break.
pub const TILE_ORDER: [AquiloTile; 9] = [
    AquiloTile::SnowFlat,
    AquiloTile::SnowCrests,
    AquiloTile::SnowLumpy,
    AquiloTile::SnowPatchy,
    AquiloTile::IceRough,
    AquiloTile::IceSmooth,
    AquiloTile::BrashIce,
    AquiloTile::AmmoniacalOcean,
    AquiloTile::AmmoniacalOcean2,
];

/// Narrow to f32 and back, the noise machine's per-op rounding.
fn f32r(v: f64) -> f64 {
    f64::from(v as f32)
}

/// `aquilo_min_elevation(t) = -1 + 2 * (elevation > t)`, in f32 per op.
fn min_elevation(elevation: f64, t: f64) -> f64 {
    let flag = if elevation > t { 1.0 } else { 0.0 };
    f32r(-1.0 + f32r(2.0 * flag))
}

/// The nine probabilities in [`TILE_ORDER`], each rounded to f32 per op in the
/// order the Lua writes them (left to right).
///
/// Keep this the only place the formulas are written.
#[must_use]
pub fn probabilities(f: &AquiloTerrainFields) -> [f64; 9] {
    let elevation = f32r(f.elevation);
    let aux = f32r(f.aux);
    let ice = f32r(f.snow_ice);
    let variant = f32r(f.tile_variant);
    let abs = f64::abs;
    let slope = |d: f64| f32r(elevation / d);
    // `100 * min_elevation(t) - A - B + elevation / d + c`, left to right.
    let snow = |t: f64, a: f64, b: f64, d: f64, c: f64| {
        let v = f32r(100.0 * min_elevation(elevation, t));
        let v = f32r(v - a);
        let v = f32r(v - b);
        let v = f32r(v + slope(d));
        f32r(v + c)
    };
    // `... + snow_ice - abs(tile_variant ...) - elevation / d + c`.
    let ice_tile = |variant_term: f64, d: f64, c: f64| {
        let v = f32r(100.0 * min_elevation(elevation, -1.0));
        let v = f32r(v + ice);
        let v = f32r(v - variant_term);
        let v = f32r(v - slope(d));
        f32r(v + c)
    };
    let snow_flat = snow(
        1.5,
        f32r(ice + 0.5),
        f32r(abs(f32r(variant - 0.5))),
        25.0,
        1.0,
    );
    let snow_crests = snow(
        1.0,
        f32r(abs(f32r(ice - f32r(0.2)))),
        f32r(abs(f32r(variant - f32r(0.2)))),
        25.0,
        f32r(1.2),
    );
    let snow_lumpy = snow(
        0.5,
        f32r(abs(f32r(ice + f32r(0.1)))),
        f32r(abs(f32r(variant + f32r(0.3)))),
        25.0,
        f32r(1.2),
    );
    let snow_patchy = snow(
        0.0,
        f32r(abs(f32r(ice + f32r(0.4)))),
        f32r(abs(f32r(variant + f32r(0.6)))),
        25.0,
        1.0,
    );
    let ice_rough = ice_tile(f32r(abs(variant)), 10.0, 0.5);
    let ice_smooth = ice_tile(f32r(abs(f32r(variant + 1.0))), 25.0, 1.0);
    // `0.05 * (elevation / 5 - aux / 3 + 0.75)`.
    let brash_ice =
        f32r(f32r(0.05) * f32r(f32r(f32r(elevation / 5.0) - f32r(aux / 3.0)) + f32r(0.75)));
    // `0.01 * (aux - 0.5)` and its negation.
    let ocean = f32r(f32r(0.01) * f32r(aux - 0.5));
    let ocean_2 = f32r(f32r(-0.01) * f32r(aux - 0.5));
    [
        snow_flat,
        snow_crests,
        snow_lumpy,
        snow_patchy,
        ice_rough,
        ice_smooth,
        brash_ice,
        ocean,
        ocean_2,
    ]
    .map(poison::f64_result)
}

/// The argmax over nine probabilities.
///
/// **A NaN loses rather than poisoning the argmax**: `v > best` is false for a
/// NaN. The loop is hand-written because it needs the winning INDEX.
#[must_use]
pub fn argmax(p: &[f64; 9]) -> AquiloTile {
    let mut best_index = 0usize;
    let mut best_value = f64::NEG_INFINITY;
    for (i, v) in p.iter().enumerate() {
        if *v > best_value {
            best_value = *v;
            best_index = i;
        }
    }
    TILE_ORDER[poison::index_result(best_index, TILE_ORDER.len())]
}

/// Resolve a position to its tile.
#[must_use]
pub fn resolve_tile(f: &AquiloTerrainFields) -> AquiloTile {
    argmax(&probabilities(f))
}

/// `lerp_color_no_alpha(a, b, amount)` from `tiles-aquilo.lua`, as the preview
/// draws it: each channel `a + amount * (b - a)` as a double, then truncated.
///
/// The data Lua leaves the channels as doubles; the rounding is not in it.
/// Truncation is read off `oracle-preview-aquilo-terrain`: snow-crests'
/// 179.8, 185.6, 192.2 draws as (179, 185, 192), where rounding would give
/// (180, 186, 192), and snow-lumpy's 166.2, 174.4, 185.8 as (166, 174, 185),
/// where rounding would give 186.
fn lerp_color(a: [u8; 3], b: [u8; 3], amount: f64) -> [u8; 3] {
    let ch = |i: usize| {
        let (a, b) = (f64::from(a[i]), f64::from(b[i]));
        (a + amount * (b - a)) as u8
    };
    [ch(0), ch(1), ch(2)]
}

const SNOW_HIGH: [u8; 3] = [190, 194, 197];
const SNOW_LOW: [u8; 3] = [156, 166, 181];

impl AquiloTile {
    /// The tile's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::SnowFlat => "snow-flat",
            Self::SnowCrests => "snow-crests",
            Self::SnowLumpy => "snow-lumpy",
            Self::SnowPatchy => "snow-patchy",
            Self::IceRough => "ice-rough",
            Self::IceSmooth => "ice-smooth",
            Self::BrashIce => "brash-ice",
            Self::AmmoniacalOcean => "ammoniacal-ocean",
            Self::AmmoniacalOcean2 => "ammoniacal-ocean-2",
        }
    }

    /// The tile's `map_color` in `tiles-aquilo.lua`.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        match self {
            Self::SnowFlat => SNOW_HIGH,
            Self::SnowCrests => lerp_color(SNOW_HIGH, SNOW_LOW, 0.3),
            Self::SnowLumpy => lerp_color(SNOW_HIGH, SNOW_LOW, 0.7),
            Self::SnowPatchy => SNOW_LOW,
            Self::IceRough | Self::IceSmooth => [100, 135, 177],
            Self::BrashIce => [21, 42, 56],
            Self::AmmoniacalOcean => [15, 13, 25],
            Self::AmmoniacalOcean2 => [17, 15, 30],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The colours the game's own preview PNG draws (read off its histogram).
    #[test]
    fn colours_match_the_preview_png_palette() {
        assert_eq!(AquiloTile::SnowCrests.color(), [179, 185, 192]);
        assert_eq!(AquiloTile::SnowLumpy.color(), [166, 174, 185]);
        assert_eq!(AquiloTile::SnowFlat.color(), [190, 194, 197]);
        assert_eq!(AquiloTile::SnowPatchy.color(), [156, 166, 181]);
    }

    /// First maximum wins; NaN loses. The tie is ours, not the game's.
    #[test]
    fn argmax_keeps_the_first_maximum_and_a_nan_loses() {
        let mut p = [0.0; 9];
        p[2] = 1.0;
        p[5] = 1.0;
        assert_eq!(argmax(&p), AquiloTile::SnowLumpy);
        p[2] = f64::NAN;
        assert_eq!(argmax(&p), AquiloTile::IceSmooth);
    }
}
