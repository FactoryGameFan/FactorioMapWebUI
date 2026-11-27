//! Gleba's tile catalog: the 41 tiles, their probability expressions and the
//! argmax between them.
//!
//! Transcribed from `space-age/prototypes/tile/tiles-gleba.lua` at 2.1.23 (the
//! tier-1 fixture reads bit-identical on 2.0.77). The catalog holds the tiles
//! in the planet's `autoplace_settings.tile` listing order. Tiles with no
//! autoplace (the artificial and overgrowth soils) are not candidates.
//!
//! ## Per-op f32
//!
//! Every constant is an f32 slot and every op rounds to f32, left to right as
//! the Lua writes it, so every step goes through [`f32r`]. The band selectors
//! (`gleba_lowland`, `gleba_midland`, ...) are `gleba_select` calls on the
//! elevation, and each tile mixes them with an aux or temperature band.
//!
//! ## The tie-break: the name that sorts first wins
//!
//! The game runs ONE argmax over every candidate tile, strict `>` from a start
//! of `-inf`, so the first candidate in its own list wins an exact tie
//! (`BasicTilesMapGenerationTask::generateBasicTiles`). Ties are common here:
//! the scores clamp at 1.0 and 1.1, and 2,108 of the 65,536 tiles around spawn
//! at map seed 123456 have a tied top score.
//!
//! The list is sorted before map generation (`CompiledMapGenSettings::compile`,
//! through `prepareAutoplacers<TilePrototype>`). Its comparator was NOT decoded;
//! the rule here, **tile NAME in byte order**, is inferred from data, and
//! [`TIE_ORDER`] holds it:
//!
//! - Against the game's own terrain-only preview PNG (which shows the raw
//!   argmax), the 256 x 256 window around spawn goes from 831 differing pixels
//!   under the listing order to 0 under name order. Every one of the 831 was a
//!   tie whose PNG colour was another member of our tie set.
//! - On a real surface (seed forced to 123456), name order explains 94.9% of
//!   7,209 tied cells, against 68.3% for the listing order. Most of the rest sit
//!   near tile-correction changes (gleba.local/tiebreak-FINDINGS.md).
//!
//! [`TILE_ORDER`] stays the planet's `autoplace_settings` listing order: it is
//! the index order of [`probabilities`], and nothing else reads it as a
//! tie-break. A NaN loses, as in the game.

use crate::eval::math::{f32r, max2, min2};
use crate::expressions::gleba_terrain::{select, GlebaTerrainFields};
use crate::poison;

/// How many tiles Gleba places.
pub const TILE_COUNT: usize = 41;

/// Every tile Gleba places.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlebaTile {
    NaturalYumakoSoil,
    NaturalJellynutSoil,
    WetlandYumako,
    WetlandJellynut,
    WetlandBlueSlime,
    WetlandLightGreenSlime,
    WetlandGreenSlime,
    WetlandLightDeadSkin,
    WetlandDeadSkin,
    WetlandPinkTentacle,
    WetlandRedTentacle,
    GlebaDeepLake,
    LowlandBrownBlubber,
    LowlandOliveBlubber,
    LowlandOliveBlubber2,
    LowlandOliveBlubber3,
    LowlandPaleGreen,
    LowlandCreamCauliflower,
    LowlandCreamCauliflower2,
    LowlandDeadSkin,
    LowlandDeadSkin2,
    LowlandCreamRed,
    LowlandRedVein,
    LowlandRedVein2,
    LowlandRedVein3,
    LowlandRedVein4,
    LowlandRedVeinDead,
    LowlandRedInfection,
    MidlandTurquoiseBark,
    MidlandTurquoiseBark2,
    MidlandCrackedLichen,
    MidlandCrackedLichenDull,
    MidlandCrackedLichenDark,
    MidlandYellowCrust,
    MidlandYellowCrust2,
    MidlandYellowCrust3,
    MidlandYellowCrust4,
    HighlandDarkRock,
    HighlandDarkRock2,
    HighlandYellowRock,
    PitRock,
}

/// The planet's `autoplace_settings.tile` listing order. The argmax keeps the
/// first maximum, so this is also the tie-break (see the module docs).
pub const TILE_ORDER: [GlebaTile; TILE_COUNT] = [
    GlebaTile::NaturalYumakoSoil,
    GlebaTile::NaturalJellynutSoil,
    GlebaTile::WetlandYumako,
    GlebaTile::WetlandJellynut,
    GlebaTile::WetlandBlueSlime,
    GlebaTile::WetlandLightGreenSlime,
    GlebaTile::WetlandGreenSlime,
    GlebaTile::WetlandLightDeadSkin,
    GlebaTile::WetlandDeadSkin,
    GlebaTile::WetlandPinkTentacle,
    GlebaTile::WetlandRedTentacle,
    GlebaTile::GlebaDeepLake,
    GlebaTile::LowlandBrownBlubber,
    GlebaTile::LowlandOliveBlubber,
    GlebaTile::LowlandOliveBlubber2,
    GlebaTile::LowlandOliveBlubber3,
    GlebaTile::LowlandPaleGreen,
    GlebaTile::LowlandCreamCauliflower,
    GlebaTile::LowlandCreamCauliflower2,
    GlebaTile::LowlandDeadSkin,
    GlebaTile::LowlandDeadSkin2,
    GlebaTile::LowlandCreamRed,
    GlebaTile::LowlandRedVein,
    GlebaTile::LowlandRedVein2,
    GlebaTile::LowlandRedVein3,
    GlebaTile::LowlandRedVein4,
    GlebaTile::LowlandRedVeinDead,
    GlebaTile::LowlandRedInfection,
    GlebaTile::MidlandTurquoiseBark,
    GlebaTile::MidlandTurquoiseBark2,
    GlebaTile::MidlandCrackedLichen,
    GlebaTile::MidlandCrackedLichenDull,
    GlebaTile::MidlandCrackedLichenDark,
    GlebaTile::MidlandYellowCrust,
    GlebaTile::MidlandYellowCrust2,
    GlebaTile::MidlandYellowCrust3,
    GlebaTile::MidlandYellowCrust4,
    GlebaTile::HighlandDarkRock,
    GlebaTile::HighlandDarkRock2,
    GlebaTile::HighlandYellowRock,
    GlebaTile::PitRock,
];

/// The order the argmax visits the tiles: indices into [`TILE_ORDER`] (and so
/// into [`probabilities`]), sorted by tile name in byte order. The first tile
/// visited wins a tie (see the module docs). `the_tie_order_is_name_order`
/// checks it against the names.
pub const TIE_ORDER: [usize; TILE_COUNT] = [
    11, 37, 38, 39, 12, 17, 18, 21, 19, 20, 13, 14, 15, 16, 27, 22, 23, 24, 25, 26, 30, 32, 31, 28,
    29, 33, 34, 35, 36, 1, 0, 40, 4, 8, 6, 3, 7, 5, 9, 10, 2,
];

fn mul(a: f64, b: f64) -> f64 {
    f32r(a * b)
}
fn add(a: f64, b: f64) -> f64 {
    f32r(a + b)
}
fn sub(a: f64, b: f64) -> f64 {
    f32r(a - b)
}
fn flag(b: bool) -> f64 {
    if b {
        1.0
    } else {
        0.0
    }
}

/// The 41 probabilities in [`TILE_ORDER`], each rounded to f32 per op in the
/// order the Lua writes them.
///
/// Keep this the only place the formulas are written.
#[must_use]
pub fn probabilities(f: &GlebaTerrainFields) -> [f64; TILE_COUNT] {
    let e = f.elevation;
    let aux = f.aux;
    let tn = f.temperature_normalised;
    let pn = f.plants_noise;
    let pnb = f.plants_noise_b;
    let rock = f.rockpools;

    // The `aux` bands every tile shares: `gleba_select(gleba_aux, a, b, slope, 0, 1)`.
    let aux_band = |a: f64, b: f64, slope: f64| select(aux, a, b, slope, 0.0, 1.0);
    let tn_band = |a: f64, b: f64, slope: f64| select(tn, a, b, slope, 0.0, 1.0);

    // The elevation bands.
    let lowland = select(e, 1.0, 20.0, 0.5, 0.0, 1.0);
    let midland = select(e, 20.0, 120.0, 0.5, 0.0, 1.0);
    let highland = select(e, 120.0, 1000.0, 0.5, 0.0, 1.0);
    let shallows_edge = select(e, -2.0, 2.0, 0.5, 0.0, 1.0);
    let shallows = select(e, -5.0, -2.0, 0.5, 0.0, 1.0);

    // `gleba_shallows[_edge]_aux_1..3`.
    let shallows_aux = [
        mul(shallows, aux_band(0.0, 0.3, 0.005)),
        mul(shallows, aux_band(0.3, 0.7, 0.005)),
        mul(shallows, aux_band(0.7, 1.0, 0.005)),
    ];
    let shallows_edge_aux = [
        mul(shallows_edge, aux_band(0.0, 0.3, 0.005)),
        mul(shallows_edge, aux_band(0.3, 0.7, 0.005)),
        mul(shallows_edge, aux_band(0.7, 1.0, 0.005)),
    ];

    // The rockpool bands.
    let rockpools_deepwater = select(rock, 1.1, 2.0, 0.1, 0.0, 1.0);
    let rockpools_bluewater = select(rock, 0.8, 1.1, 0.1, 0.0, 1.0);
    let rockpools_shallow = select(rock, 0.6, 0.8, 0.1, 0.0, 1.0);

    let mask_green = flag(aux > f32r(0.375));
    let mask_red = flag(aux < f32r(0.625));
    let above_deep_water = flag(e > -10.0);

    // `<shallows> + 2 * min(gleba_select(gleba_aux, a, b, 0.005, 0, 1), gleba_rockpools_shallow)`.
    let wetland = |base: f64, a: f64, b: f64| {
        add(
            base,
            mul(2.0, min2(aux_band(a, b, 0.005), rockpools_shallow)),
        )
    };

    // `gleba_lowland * gleba_select(gleba_aux, a, b, s, 0, 1)
    //   + 0.1 * gleba_select(gleba_temperature_normalised, c, d, 0.005, 0, 1)`.
    let lowland_aux_plus_temperature = |a: f64, b: f64, s: f64, c: f64, d: f64| {
        add(
            mul(lowland, aux_band(a, b, s)),
            mul(f32r(0.1), tn_band(c, d, 0.005)),
        )
    };
    // `gleba_lowland * gleba_select(aux) * gleba_select(temperature)`.
    let lowland_aux_times_temperature = |a: f64, b: f64, c: f64, d: f64| {
        mul(mul(lowland, aux_band(a, b, 0.005)), tn_band(c, d, 0.005))
    };

    let p = [
        // natural-yumako-soil, natural-jellynut-soil
        sub(
            sub(mul(f.fertile_solid, 50_000.0), 40_000.0),
            mul(mask_green, 1_000_000.0),
        ),
        sub(
            sub(mul(f.fertile_solid, 50_000.0), 40_000.0),
            mul(mask_red, 1_000_000.0),
        ),
        // wetland-yumako, wetland-jellynut
        mul(
            mul(mul(f.fertile_spots_coastal, 5000.0), sub(1.0, mask_green)),
            above_deep_water,
        ),
        mul(
            mul(mul(f.fertile_spots_coastal, 5000.0), sub(1.0, mask_red)),
            above_deep_water,
        ),
        // wetland-blue-slime
        add(
            mul(6.0, select(e, -10.0, -4.0, 0.5, 0.0, 1.0)),
            mul(5.0, rockpools_bluewater),
        ),
        // wetland-light-green-slime, wetland-green-slime
        wetland(shallows_edge_aux[0], 0.0, 0.3),
        wetland(shallows_aux[0], 0.0, 0.3),
        // wetland-light-dead-skin, wetland-dead-skin
        wetland(shallows_edge_aux[1], 0.3, 0.7),
        wetland(shallows_aux[1], 0.3, 0.7),
        // wetland-pink-tentacle
        shallows_edge_aux[2],
        // wetland-red-tentacle
        wetland(shallows_aux[2], 0.7, 2.0),
        // gleba-deep-lake
        add(
            mul(10.0, select(e, -500.0, -10.0, 0.5, 0.0, 1.0)),
            mul(10.0, rockpools_deepwater),
        ),
        // lowland-brown-blubber
        add(
            mul(lowland, aux_band(0.0, 0.4, 0.005)),
            mul(f32r(0.1), sub(pnb, f32r(0.8))),
        ),
        // lowland-olive-blubber, -2, -3
        lowland_aux_plus_temperature(0.0, 0.4, 0.005, 0.3, 0.8),
        lowland_aux_plus_temperature(0.0, 0.2, 0.005, 0.0, 0.4),
        lowland_aux_plus_temperature(0.0, 0.4, 0.005, 0.8, 1.0),
        // lowland-pale-green
        lowland_aux_plus_temperature(0.2, 0.4, 0.005, 0.0, 0.3),
        // lowland-cream-cauliflower, -2
        lowland_aux_plus_temperature(0.45, 0.65, 0.005, -0.2, 1.0),
        lowland_aux_plus_temperature(0.3, 0.45, 0.005, -0.2, 1.0),
        // lowland-dead-skin, -2
        lowland_aux_plus_temperature(0.45, 0.65, 0.005, -1.0, -0.2),
        lowland_aux_plus_temperature(0.3, 0.45, 0.005, -1.0, -0.2),
        // lowland-cream-red
        lowland_aux_times_temperature(0.62, 0.77, 0.25, 1.0),
        // lowland-red-vein, -2, -3, -4
        lowland_aux_times_temperature(0.7, 1.0, 0.45, 0.75),
        add(
            mul(lowland, aux_band(0.75, 1.0, 0.005)),
            mul(f32r(0.1), sub(pnb, 1.0)),
        ),
        lowland_aux_times_temperature(0.7, 1.0, 0.25, 0.45),
        lowland_aux_times_temperature(0.7, 1.0, 0.75, 1.0),
        // lowland-red-vein-dead
        lowland_aux_times_temperature(0.6, 1.0, 0.0, 0.25),
        // lowland-red-infection
        add(
            mul(lowland, aux_band(0.7, 1.0, 0.05)),
            mul(f32r(0.1), sub(pn, 1.0)),
        ),
        // midland-turquoise-bark, -2
        add(mul(midland, aux_band(0.0, 0.35, 0.2)), mul(f32r(0.2), tn)),
        sub(mul(midland, aux_band(0.05, 0.4, 0.2)), mul(f32r(0.2), tn)),
        // midland-cracked-lichen, -dull, -dark
        sub(mul(midland, aux_band(0.55, 0.65, 0.15)), mul(f32r(0.2), tn)),
        add(mul(midland, aux_band(0.45, 0.55, 0.15)), mul(f32r(0.2), tn)),
        add(
            max2(
                mul(mul(f32r(1.08), midland), aux_band(0.0, 0.55, 0.1)),
                mul(f32r(1.15), highland),
            ),
            mul(f32r(0.3), sub(pnb, f32r(0.7))),
        ),
        // midland-yellow-crust, -2, -3, -4
        mul(
            mul(midland, aux_band(0.7, 1.0, 0.1)),
            add(
                add(1.0, mul(f32r(0.1), sub(aux, f32r(0.75)))),
                mul(f32r(0.05), pnb),
            ),
        ),
        mul(
            mul(midland, aux_band(0.8, 1.0, 0.15)),
            sub(
                add(
                    f32r(0.93),
                    mul(f32r(0.1), select(f.moisture, 0.5, 0.5, 0.25, 0.0, 1.0)),
                ),
                mul(f32r(0.1), tn),
            ),
        ),
        mul(midland, aux_band(0.65, 1.0, 0.1)),
        mul(
            mul(midland, aux_band(0.8, 1.0, 0.15)),
            add(
                add(
                    f32r(0.9),
                    mul(f32r(0.1), select(f.moisture, 0.25, 0.25, 0.25, 0.0, 1.0)),
                ),
                mul(f32r(0.1), tn),
            ),
        ),
        // highland-dark-rock, -2, highland-yellow-rock
        mul(
            highland,
            max2(
                0.0,
                add(
                    add(f32r(1.05), mul(f32r(0.1), sub(1.0, aux))),
                    mul(f32r(0.2), tn),
                ),
            ),
        ),
        mul(
            highland,
            max2(
                0.0,
                add(
                    f32r(1.13),
                    mul(f32r(0.1), min2(add(aux, f32r(0.1)), sub(1.0, aux))),
                ),
            ),
        ),
        mul(
            highland,
            max2(0.0, sub(add(1.0, mul(f32r(0.1), aux)), mul(f32r(0.2), tn))),
        ),
        // pit-rock
        mul(2.0, f.rockpools_pitrock),
    ];
    p.map(poison::f64_result)
}

/// The argmax over the 41 probabilities, visiting them in [`TIE_ORDER`] with a
/// strict `>`, so the tile whose name sorts first wins a tie.
///
/// **A NaN loses rather than poisoning the argmax**: `v > best` is false for a
/// NaN. The best starts at `-inf`, as the game's does, so an all-NaN input
/// falls back to the first tile visited.
#[must_use]
pub fn argmax(p: &[f64; TILE_COUNT]) -> GlebaTile {
    let mut best_index = TIE_ORDER[0];
    let mut best_value = f64::NEG_INFINITY;
    for i in TIE_ORDER {
        if p[i] > best_value {
            best_value = p[i];
            best_index = i;
        }
    }
    TILE_ORDER[poison::index_result(best_index, TILE_COUNT)]
}

/// Resolve a position to its tile.
#[must_use]
pub fn resolve_tile(f: &GlebaTerrainFields) -> GlebaTile {
    argmax(&probabilities(f))
}

impl GlebaTile {
    /// The tile's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::NaturalYumakoSoil => "natural-yumako-soil",
            Self::NaturalJellynutSoil => "natural-jellynut-soil",
            Self::WetlandYumako => "wetland-yumako",
            Self::WetlandJellynut => "wetland-jellynut",
            Self::WetlandBlueSlime => "wetland-blue-slime",
            Self::WetlandLightGreenSlime => "wetland-light-green-slime",
            Self::WetlandGreenSlime => "wetland-green-slime",
            Self::WetlandLightDeadSkin => "wetland-light-dead-skin",
            Self::WetlandDeadSkin => "wetland-dead-skin",
            Self::WetlandPinkTentacle => "wetland-pink-tentacle",
            Self::WetlandRedTentacle => "wetland-red-tentacle",
            Self::GlebaDeepLake => "gleba-deep-lake",
            Self::LowlandBrownBlubber => "lowland-brown-blubber",
            Self::LowlandOliveBlubber => "lowland-olive-blubber",
            Self::LowlandOliveBlubber2 => "lowland-olive-blubber-2",
            Self::LowlandOliveBlubber3 => "lowland-olive-blubber-3",
            Self::LowlandPaleGreen => "lowland-pale-green",
            Self::LowlandCreamCauliflower => "lowland-cream-cauliflower",
            Self::LowlandCreamCauliflower2 => "lowland-cream-cauliflower-2",
            Self::LowlandDeadSkin => "lowland-dead-skin",
            Self::LowlandDeadSkin2 => "lowland-dead-skin-2",
            Self::LowlandCreamRed => "lowland-cream-red",
            Self::LowlandRedVein => "lowland-red-vein",
            Self::LowlandRedVein2 => "lowland-red-vein-2",
            Self::LowlandRedVein3 => "lowland-red-vein-3",
            Self::LowlandRedVein4 => "lowland-red-vein-4",
            Self::LowlandRedVeinDead => "lowland-red-vein-dead",
            Self::LowlandRedInfection => "lowland-red-infection",
            Self::MidlandTurquoiseBark => "midland-turquoise-bark",
            Self::MidlandTurquoiseBark2 => "midland-turquoise-bark-2",
            Self::MidlandCrackedLichen => "midland-cracked-lichen",
            Self::MidlandCrackedLichenDull => "midland-cracked-lichen-dull",
            Self::MidlandCrackedLichenDark => "midland-cracked-lichen-dark",
            Self::MidlandYellowCrust => "midland-yellow-crust",
            Self::MidlandYellowCrust2 => "midland-yellow-crust-2",
            Self::MidlandYellowCrust3 => "midland-yellow-crust-3",
            Self::MidlandYellowCrust4 => "midland-yellow-crust-4",
            Self::HighlandDarkRock => "highland-dark-rock",
            Self::HighlandDarkRock2 => "highland-dark-rock-2",
            Self::HighlandYellowRock => "highland-yellow-rock",
            Self::PitRock => "pit-rock",
        }
    }

    /// The tile's effective layer (layer group plus offset), as the game
    /// reports it at runtime (`prototypes.tile[name].layer`), stored in
    /// `oracle-gleba-real-surface.seed123456.json`. Tile correction compares
    /// it; `gleba_layers_match_the_game` checks all 41.
    #[must_use]
    pub fn layer(self) -> u16 {
        match self {
            Self::NaturalYumakoSoil => 229,
            Self::NaturalJellynutSoil => 230,
            Self::WetlandYumako => 83,
            Self::WetlandJellynut => 67,
            Self::WetlandBlueSlime => 81,
            Self::WetlandLightGreenSlime => 86,
            Self::WetlandGreenSlime => 86,
            Self::WetlandLightDeadSkin => 87,
            Self::WetlandDeadSkin => 87,
            Self::WetlandPinkTentacle => 85,
            Self::WetlandRedTentacle => 85,
            Self::GlebaDeepLake => 81,
            Self::LowlandBrownBlubber => 113,
            Self::LowlandOliveBlubber => 116,
            Self::LowlandOliveBlubber2 => 115,
            Self::LowlandOliveBlubber3 => 120,
            Self::LowlandPaleGreen => 114,
            Self::LowlandCreamCauliflower => 120,
            Self::LowlandCreamCauliflower2 => 119,
            Self::LowlandDeadSkin => 117,
            Self::LowlandDeadSkin2 => 118,
            Self::LowlandCreamRed => 123,
            Self::LowlandRedVein => 125,
            Self::LowlandRedVein2 => 124,
            Self::LowlandRedVein3 => 126,
            Self::LowlandRedVein4 => 127,
            Self::LowlandRedVeinDead => 119,
            Self::LowlandRedInfection => 128,
            Self::MidlandTurquoiseBark => 220,
            Self::MidlandTurquoiseBark2 => 219,
            Self::MidlandCrackedLichen => 217,
            Self::MidlandCrackedLichenDull => 218,
            Self::MidlandCrackedLichenDark => 209,
            Self::MidlandYellowCrust => 223,
            Self::MidlandYellowCrust2 => 222,
            Self::MidlandYellowCrust3 => 221,
            Self::MidlandYellowCrust4 => 224,
            Self::HighlandDarkRock => 225,
            Self::HighlandDarkRock2 => 226,
            Self::HighlandYellowRock => 227,
            Self::PitRock => 208,
        }
    }

    /// The tile's `map_color`, as the game reports it at runtime
    /// (`prototypes.tile[name].map_color`, read by
    /// `scripts/probes/gleba-real-surface/capture.ts` and stored in
    /// `oracle-gleba-real-surface.seed123456.json`). Several tiles share a
    /// colour, so a picture cannot tell those apart; the fixture test
    /// `gleba_map_colours_match_the_game` compares all 41.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        match self {
            Self::NaturalYumakoSoil => [185, 166, 5],
            Self::NaturalJellynutSoil => [185, 5, 166],
            Self::WetlandYumako => [132, 119, 7],
            Self::WetlandJellynut => [132, 7, 119],
            Self::WetlandBlueSlime => [25, 49, 58],
            Self::WetlandLightGreenSlime => [35, 63, 35],
            Self::WetlandGreenSlime => [25, 53, 25],
            Self::WetlandLightDeadSkin => [51, 50, 56],
            Self::WetlandDeadSkin => [46, 45, 51],
            Self::WetlandPinkTentacle => [64, 19, 34],
            Self::WetlandRedTentacle => [54, 15, 24],
            Self::GlebaDeepLake => [18, 37, 51],
            Self::LowlandBrownBlubber => [66, 82, 11],
            Self::LowlandOliveBlubber => [66, 82, 11],
            Self::LowlandOliveBlubber2 => [66, 82, 11],
            Self::LowlandOliveBlubber3 => [66, 82, 11],
            Self::LowlandPaleGreen => [66, 82, 11],
            Self::LowlandCreamCauliflower => [95, 93, 88],
            Self::LowlandCreamCauliflower2 => [95, 93, 88],
            Self::LowlandDeadSkin => [95, 93, 88],
            Self::LowlandDeadSkin2 => [95, 93, 88],
            Self::LowlandCreamRed => [95, 83, 78],
            Self::LowlandRedVein => [115, 53, 66],
            Self::LowlandRedVein2 => [115, 53, 66],
            Self::LowlandRedVein3 => [115, 53, 66],
            Self::LowlandRedVein4 => [115, 53, 66],
            Self::LowlandRedVeinDead => [115, 53, 66],
            Self::LowlandRedInfection => [115, 53, 66],
            Self::MidlandTurquoiseBark => [46, 68, 48],
            Self::MidlandTurquoiseBark2 => [46, 68, 48],
            Self::MidlandCrackedLichen => [81, 77, 44],
            Self::MidlandCrackedLichenDull => [71, 67, 40],
            Self::MidlandCrackedLichenDark => [61, 57, 30],
            Self::MidlandYellowCrust => [114, 86, 40],
            Self::MidlandYellowCrust2 => [114, 86, 40],
            Self::MidlandYellowCrust3 => [114, 86, 40],
            Self::MidlandYellowCrust4 => [114, 86, 40],
            Self::HighlandDarkRock => [52, 55, 48],
            Self::HighlandDarkRock2 => [52, 55, 48],
            Self::HighlandYellowRock => [52, 55, 48],
            Self::PitRock => [50, 50, 58],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tie goes to the name that sorts first, not to the listing order; a
    /// NaN loses.
    ///
    /// The pair is chosen so the two orders disagree: `natural-yumako-soil`
    /// is listed first (index 0), `gleba-deep-lake` sorts first by name.
    #[test]
    fn a_tie_goes_to_the_first_name_and_a_nan_loses() {
        let mut p = [0.0; TILE_COUNT];
        p[0] = 1.0;
        p[11] = 1.0;
        assert_eq!(TILE_ORDER[0], GlebaTile::NaturalYumakoSoil);
        assert_eq!(argmax(&p), GlebaTile::GlebaDeepLake);
        p[11] = f64::NAN;
        assert_eq!(argmax(&p), GlebaTile::NaturalYumakoSoil);
    }

    /// [`TIE_ORDER`] is a permutation of the 41 indices, in name byte order.
    #[test]
    fn the_tie_order_is_name_order() {
        let mut seen = TIE_ORDER.to_vec();
        seen.sort_unstable();
        assert_eq!(seen, (0..TILE_COUNT).collect::<Vec<_>>());
        for pair in TIE_ORDER.windows(2) {
            let (a, b) = (
                TILE_ORDER[pair[0]].game_name(),
                TILE_ORDER[pair[1]].game_name(),
            );
            assert!(a.as_bytes() < b.as_bytes(), "{a} before {b}");
        }
    }

    /// The names are the 41 distinct tile names, and no two variants share one.
    #[test]
    fn the_catalog_has_41_distinct_names() {
        let mut names: Vec<&str> = TILE_ORDER.iter().map(|t| t.game_name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), TILE_COUNT);
    }
}
