//! Vulcanus's 19 autoplace tiles and the argmax that picks between them. Ported
//! from `src/noise/tiles/vulcanusCatalog.ts`.
//!
//! Transcribed from `space-age/prototypes/tile/tiles-vulcanus.lua`
//! (`~/GitHub/factorio-data`, tag 2.1.11), with the two map-gen helpers
//! `mountain_lava_spots` and `vulcanus_rock_noise` - which live in
//! `planet-vulcanus-map-gen.lua` - ported alongside, because nothing else reads
//! them.
//!
//! ## The order is data, not decoration
//!
//! Tile selection is a pure argmax over the 19 probabilities, ties keeping the
//! FIRST tile in catalog order. Catalog order is the data file's registration
//! order, so [`TILE_ORDER`] is ground truth and rearranging it changes which
//! tile the game places at a tie. `strict >` never displaces the running winner,
//! which is what makes "first" mean first.
//!
//! ## Every probability is a COMPOSITE, so the argmax alone cannot check them
//!
//! Not one of the 19 is a bare named expression the game reports directly - each
//! is arithmetic over several named fields, written out in the Lua. A
//! mis-transcribed `max` arity, operator precedence or sign can still produce a
//! plausible winner, so [`tile_probabilities`] returns the whole vector rather
//! than only the winner. That is the same argument `fulgora_catalog` makes, and
//! it is why the formulas live here once and are never copied into a test.
//!
//! `tile_lightening = 28`: a game `map_color = {r = tile_lightening + N, ...}`
//! stores the byte `28 + N`, and literal `{r, g, b}` colours are used verbatim.
//! The bytes below are the resolved values, as the TypeScript stores them.

use crate::eval::math::{clamp, max, max2, min2, range_select_base};
use crate::expressions::vulcanus_biomes::BiomeFields;
use crate::expressions::vulcanus_helpers::{threshold, Plasma, VulcanusHelpers};
use crate::multioctave_noise::{MultioctaveParams, Prepared};

/// Every tile Vulcanus can place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VulcanusTile {
    VolcanicJaggedGround,
    Lava,
    LavaHot,
    VolcanicCracksHot,
    VolcanicCracksWarm,
    VolcanicCracks,
    VolcanicFoldsFlat,
    VolcanicAshLight,
    VolcanicAshDark,
    VolcanicAshFlats,
    VolcanicPumiceStones,
    VolcanicSmoothStone,
    VolcanicSmoothStoneWarm,
    VolcanicAshCracks,
    VolcanicFolds,
    VolcanicFoldsWarm,
    VolcanicSoilDark,
    VolcanicSoilLight,
    VolcanicAshSoil,
}

/// The 19 tiles in the data file's REGISTRATION order.
///
/// This is the tie-break, so it is ground truth rather than a listing. Three
/// tiles share the colour `[53, 53, 53]` and would be indistinguishable in a
/// rendered image, which is exactly why a name-level fixture grades this and a
/// PNG cannot.
pub const TILE_ORDER: [VulcanusTile; 19] = [
    VulcanusTile::VolcanicJaggedGround,
    VulcanusTile::Lava,
    VulcanusTile::LavaHot,
    VulcanusTile::VolcanicCracksHot,
    VulcanusTile::VolcanicCracksWarm,
    VulcanusTile::VolcanicCracks,
    VulcanusTile::VolcanicFoldsFlat,
    VulcanusTile::VolcanicAshLight,
    VulcanusTile::VolcanicAshDark,
    VulcanusTile::VolcanicAshFlats,
    VulcanusTile::VolcanicPumiceStones,
    VulcanusTile::VolcanicSmoothStone,
    VulcanusTile::VolcanicSmoothStoneWarm,
    VulcanusTile::VolcanicAshCracks,
    VulcanusTile::VolcanicFolds,
    VulcanusTile::VolcanicFoldsWarm,
    VulcanusTile::VolcanicSoilDark,
    VulcanusTile::VolcanicSoilLight,
    VulcanusTile::VolcanicAshSoil,
];

impl VulcanusTile {
    /// The tile's prototype name, which is what the oracle fixture records.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::VolcanicJaggedGround => "volcanic-jagged-ground",
            Self::Lava => "lava",
            Self::LavaHot => "lava-hot",
            Self::VolcanicCracksHot => "volcanic-cracks-hot",
            Self::VolcanicCracksWarm => "volcanic-cracks-warm",
            Self::VolcanicCracks => "volcanic-cracks",
            Self::VolcanicFoldsFlat => "volcanic-folds-flat",
            Self::VolcanicAshLight => "volcanic-ash-light",
            Self::VolcanicAshDark => "volcanic-ash-dark",
            Self::VolcanicAshFlats => "volcanic-ash-flats",
            Self::VolcanicPumiceStones => "volcanic-pumice-stones",
            Self::VolcanicSmoothStone => "volcanic-smooth-stone",
            Self::VolcanicSmoothStoneWarm => "volcanic-smooth-stone-warm",
            Self::VolcanicAshCracks => "volcanic-ash-cracks",
            Self::VolcanicFolds => "volcanic-folds",
            Self::VolcanicFoldsWarm => "volcanic-folds-warm",
            Self::VolcanicSoilDark => "volcanic-soil-dark",
            Self::VolcanicSoilLight => "volcanic-soil-light",
            Self::VolcanicAshSoil => "volcanic-ash-soil",
        }
    }

    /// The tile's `map_color` as an RGB byte triple.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        match self {
            Self::VolcanicJaggedGround => [58, 58, 48],
            Self::Lava => [150, 49, 30],
            Self::LavaHot => [255, 138, 57],
            Self::VolcanicCracksHot => [58, 33, 23],
            Self::VolcanicCracksWarm => [58, 38, 33],
            Self::VolcanicCracks => [43, 42, 43],
            Self::VolcanicFoldsFlat => [44, 43, 44],
            // These three really are the same colour in the game's data.
            Self::VolcanicAshLight | Self::VolcanicAshDark | Self::VolcanicAshFlats => [53, 53, 53],
            Self::VolcanicPumiceStones => [46, 46, 46],
            Self::VolcanicSmoothStone => [50, 50, 58],
            Self::VolcanicSmoothStoneWarm => [54, 50, 50],
            Self::VolcanicAshCracks => [67, 67, 67],
            Self::VolcanicFolds => [43, 43, 43],
            Self::VolcanicFoldsWarm => [65, 45, 45],
            Self::VolcanicSoilDark => [48, 51, 43],
            Self::VolcanicSoilLight => [58, 48, 43],
            Self::VolcanicAshSoil => [48, 48, 43],
        }
    }

    /// The tile whose prototype name is `name`, if Vulcanus places one.
    ///
    /// The inverse of [`Self::name`], resolved through [`TILE_ORDER`] so the two
    /// cannot disagree. It exists because the oracle fixtures record tile
    /// NAMES, not enum variants, and a caller holding a name used to have no way
    /// to reach the enum except by matching strings of its own (#364).
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        TILE_ORDER.into_iter().find(|tile| tile.name() == name)
    }

    /// Whether a cliff whose collision box touches this tile is refused.
    ///
    /// `tile_collision_masks.lava()` sets `water_tile = true` and the cliff mask
    /// holds `water_tile`; no other Vulcanus tile does. Notably
    /// `volcanic-jagged-ground` - the tile the ore patches paint, which the Lua
    /// itself labels "CLIFF TILE" - is `tile_collision_masks.ground()`, which
    /// the cliff mask does not touch, so ore does NOT exclude cliffs through
    /// this rule. That distinction is why the earlier ore-separation work
    /// correctly found no exclusion here while the removal rule in
    /// [`crate::cliffs::vulcanus_ore_rejection`] exists.
    ///
    /// **Measured rather than deduced.** Switching lava and lava-hot out of the
    /// tile autoplace category and regenerating is what established the set, not
    /// a reading of `tile_collision_masks`. A future tile that blocks cliffs
    /// would be found the same way.
    ///
    /// **This is the only definition on the Rust side, and that is the point of
    /// it (#364).** There were four: here, `cliffs::vulcanus_fields`, and twice
    /// in `fixtures.rs` - one of those two by name and its neighbour by enum, so
    /// the string form and the enum form could drift apart without either file
    /// changing. TypeScript keeps its own single definition,
    /// `VULCANUS_CLIFF_BLOCKING_TILES` in `cliffCatalog.ts`, and
    /// [`cliff_blocking_names_fnv1a64`] is what stops the two sides drifting.
    /// **Two other gates pick the same two tiles and MUST NOT be folded into
    /// this one.** `rocks::vulcanus_placement` and `resources::vulcanus_geyser`
    /// each refuse lava as well, and all three sets are equal today - but they
    /// are reached by three unrelated routes in the game's data, so the equality
    /// is a coincidence rather than a shared rule:
    ///
    /// | gate | what actually decides it |
    /// | --- | --- |
    /// | cliffs, here | the cliff's collision mask holds `water_tile`, and `tile_collision_masks.lava()` sets it |
    /// | rocks | the four rock prototypes' `vulcanus_tiles_cold` / `vulcanus_tiles_hot` autoplace lists, whose union is every tile but these |
    /// | geysers | `type = "resource"`'s default mask is `{resource = true}`, which `tile_collision_masks.lava()` also lists |
    ///
    /// Change the tile data on any one of those three axes and the three sets
    /// come apart. A single shared predicate would then be wrong in two places
    /// at once, and silently, which is worse than the duplication #364 removed.
    /// Each gate keeps its own definition and its own comment saying which
    /// mechanism it reads.
    #[must_use]
    pub fn is_cliff_blocking(self) -> bool {
        matches!(self, Self::Lava | Self::LavaHot)
    }
}

/// FNV-1a 64 over every cliff-blocking tile's name, sorted, joined by `\n`.
///
/// The cross-language half of #364. TypeScript holds the same set as
/// `VULCANUS_CLIFF_BLOCKING_TILES`, and `fmw-wasm` exports this so a spec can
/// hash the TypeScript set through the module's own `fnv1a64` and compare the
/// two in process. A change to one side that misses the other then fails a
/// test instead of sitting there.
///
/// **Sorted, so the two sides do not also have to agree on an order.** Catalog
/// order is ground truth for the argmax's tie-break, but it is not something
/// the TypeScript set carries - it is a `Set` of two strings - so hashing in
/// catalog order would make this assertion depend on a fact it is not trying
/// to check.
///
/// Insertion sort over a fixed buffer rather than `Vec::sort`: the WASM build
/// has no allocator, and at 19 tiles the cost is irrelevant.
#[must_use]
pub fn cliff_blocking_names_fnv1a64() -> u64 {
    let mut names = [""; TILE_ORDER.len()];
    let mut count = 0;
    for tile in TILE_ORDER {
        if tile.is_cliff_blocking() {
            names[count] = tile.name();
            count += 1;
        }
    }
    let names = &mut names[..count];
    for i in 1..names.len() {
        let mut j = i;
        while j > 0 && names[j - 1] > names[j] {
            names.swap(j - 1, j);
            j -= 1;
        }
    }

    // 19 names of at most 26 bytes, plus separators, fits with room to spare.
    let mut buf = [0u8; 1024];
    let mut len = 0;
    for (i, name) in names.iter().enumerate() {
        if i > 0 {
            buf[len] = b'\n';
            len += 1;
        }
        buf[len..len + name.len()].copy_from_slice(name.as_bytes());
        len += name.len();
    }
    crate::checksum::fnv1a64(&buf[..len])
}

/// `vulcanus_rock_noise` (`planet-vulcanus-map-gen.lua` ~line 872).
///
/// A plain `multioctave_noise`. The `control:rocks:frequency` slider term beside
/// it in the source is COMMENTED OUT there, so it is not applied here either -
/// which is worth stating, because applying it would look like a fix.
#[must_use]
pub fn vulcanus_rock_noise(seed0: u32) -> Prepared {
    Prepared::new(&MultioctaveParams {
        seed0,
        seed1: 137,
        octaves: 4.0,
        persistence: 0.65,
        input_scale: 0.1,
        output_scale: 0.4,
    })
}

/// `mountain_lava_spots` (`planet-vulcanus-map-gen.lua` ~line 452), and its own
/// plasma.
///
/// ```text
/// clamp(threshold(mountain_volcano_spots * 1.95 - 0.95,
///                 0.4 * clamp(threshold(mountains_biome, 0.5), 0, 1))
///       * threshold(clamp(plasma(17453, 0.2, 0.4, 10, 20) / 20, 0, 1), 1.8),
///       0, 1)
/// ```
pub struct MountainLavaSpots {
    plasma: Plasma,
}

impl MountainLavaSpots {
    #[must_use]
    pub fn new(helpers: &VulcanusHelpers) -> Self {
        Self {
            plasma: helpers.plasma(17_453, 0.2, 0.4, 10.0, 20.0),
        }
    }

    #[must_use]
    pub fn eval(&self, x: f64, y: f64, biomes: &BiomeFields) -> f64 {
        let inner = threshold(
            biomes.mountain_volcano_spots * 1.95 - 0.95,
            0.4 * clamp(threshold(biomes.mountains_biome, 0.5), 0.0, 1.0),
        );
        let plasma_term = threshold(clamp(self.plasma.eval(x, y) / 20.0, 0.0, 1.0), 1.8);
        clamp(inner * plasma_term, 0.0, 1.0)
    }
}

/// The field values the 19 `*_range` expressions read, at one position.
///
/// `elev` is the RAW `vulcanus_elev`, BEFORE `max(-500, ...)`. The ranges
/// reference it by that name, and wiring the clamped `vulcanus_elevation` here
/// instead would agree everywhere above -500 and diverge only in the deep lakes
/// - a difference no near-spawn fixture would show.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct VulcanusTileFields {
    pub elev: f64,
    pub aux: f64,
    pub moisture: f64,
    pub mountains_biome: f64,
    pub ashlands_biome: f64,
    pub basalts_biome: f64,
    pub mountain_volcano_spots: f64,
    pub mountain_lava_spots: f64,
    pub rock_noise: f64,
    pub distance: f64,
    /// `vulcanus_metal_tile = max(0, vulcanus_tungsten_ore_probability)`.
    pub metal_tile: f64,
    /// `vulcanus_calcite_region`.
    pub calcite_region: f64,
    /// `vulcanus_sulfuric_acid_region_patchy`.
    pub sulfuric_acid_region_patchy: f64,
}

impl VulcanusTileFields {
    /// `lava_spawn_excluder = distance > 10`, as 1 or 0.
    fn lava_spawn_excluder(&self) -> f64 {
        if self.distance > 10.0 {
            1.0
        } else {
            0.0
        }
    }
}

/// The 19 `probability_expression`s, in [`TILE_ORDER`].
///
/// Returned whole rather than reduced to a winner, for the reason the module
/// docs give: every one is a composite, and the argmax cannot tell a
/// mis-transcribed composite from a correct one.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn tile_probabilities(f: &VulcanusTileFields) -> [f64; 19] {
    let excluder = f.lava_spawn_excluder();

    // The three resource-coupling terms are V2 restorations: V1 approximated
    // them away, and they are what puts jagged ground on calcite and cracks on
    // tungsten. `50000 *` and `100 *` are the source's own weights, not tuning.
    let lava_basalts = 100.0
        * min2(
            f.basalts_biome * excluder * range_select_base(f.elev, -5000.0, 0.0, 1.0, -1000.0, 1.0),
            100.0 * (1.0 - f.metal_tile),
        );
    let lava_mountains =
        1100.0 * range_select_base(f.mountain_lava_spots, 0.2, 10.0, 1.0, 0.0, 1.0);

    let lava_hot_basalts = 200.0
        * min2(
            f.basalts_biome
                * excluder
                * range_select_base(
                    f.elev,
                    -5000.0,
                    min2(0.0, 5.0 * (-2.0 + 4.0 * f.rock_noise)),
                    1.0,
                    -1000.0,
                    1.0,
                ),
            100.0 * (1.0 - f.metal_tile),
        );
    let lava_hot_mountains =
        1000.0 * range_select_base(f.mountain_lava_spots, 0.05, 0.3, 1.0, 0.0, 1.0);

    let volcanic_cracks_hot = f.basalts_biome * range_select_base(f.elev, 0.0, 8.0, 1.0, 0.0, 20.0);

    let volcanic_cracks_warm = f.basalts_biome
        * range_select_base(f.elev, 8.0, 22.0, 1.0, 0.0, 5.0)
        + (f.aux - 0.05)
        + 50_000.0 * f.metal_tile;

    let volcanic_cracks_cold = (0.5 - f.ashlands_biome)
        * range_select_base(f.elev, 20.0, 100.0, 1.0, 0.0, 1.0)
        + (f.aux - 0.3);

    let volcanic_smooth_stone_warm =
        f.basalts_biome * range_select_base(f.elev, 8.0, 20.0, 1.0, 0.0, 5.0) - (f.aux - 0.05)
            + 50_000.0 * f.metal_tile;

    let volcanic_smooth_stone = (0.5 - f.ashlands_biome)
        * range_select_base(f.elev, 20.0, 100.0, 1.0, 0.0, 1.0)
        - (f.aux - 0.3);

    let volcanic_folds_flat = 2.0 * (f.mountains_biome - 0.5) - 0.15 * f.mountain_volcano_spots;

    let volcanic_folds =
        2.0 * (f.mountains_biome - 0.5) + (f.aux - 0.5) + 0.5 * (f.mountain_volcano_spots - 0.1);

    let volcanic_folds_warm = 2.0 * (f.mountains_biome - 0.5)
        + 3.0 * (f.mountain_volcano_spots - 0.85)
        - 2.0 * (f.aux - 0.5);

    let volcanic_jagged_ground = 5.0
        * min2(
            10.0,
            max2(
                f.calcite_region + 0.2,
                range_select_base(f.elev, 1010.0, 2000.0, 2.0, -10.0, 1.0) + 3.0 * (f.aux - 0.5),
            ),
        );

    // The two soil ranges are each a `max` over a mountains arm and an ashlands
    // arm, so the same tile is reachable from two biomes. Light has a THIRD arm
    // on the sulfuric-acid region; dark does not.
    let soil_light_mountains = min2(0.8, 4.0 * (f.mountains_biome - 0.25))
        - 0.35 * f.mountain_volcano_spots
        - 3.0 * (f.aux - 0.2);
    let soil_dark_mountains = min2(0.8, 4.0 * (f.mountains_biome - 0.25))
        - 0.35 * f.mountain_volcano_spots
        - 1.0 * (f.aux - 0.5);
    let soil_light_ashlands = 2.0 * (f.ashlands_biome - 0.5) + 1.5 * (f.moisture - 0.8);
    let soil_dark_ashlands =
        2.0 * (f.ashlands_biome - 0.5) - 1.5 * (f.aux - 0.25) + 1.5 * (f.moisture - 0.8);

    let volcanic_soil_light = max(&[
        soil_light_mountains,
        soil_light_ashlands,
        10.0 * (f.sulfuric_acid_region_patchy + 0.2),
    ]);
    let volcanic_soil_dark = max2(soil_dark_mountains, soil_dark_ashlands);

    let volcanic_ash_flats =
        2.0 * (f.ashlands_biome - 0.5) - 1.5 * (f.aux - 0.25) - 1.5 * (f.moisture - 0.6);
    let volcanic_ash_light = 2.0 * (f.ashlands_biome - 0.5) - 1.5 * (f.moisture - 0.6);
    let volcanic_ash_dark = min2(1.0, 4.0 * (f.ashlands_biome - 0.25))
        + max2(
            -1.5 * (f.aux - 0.25),
            0.01 - 1.5 * (f.aux - 0.5).abs() - 1.5 * (f.moisture - 0.66),
        );
    let volcanic_pumice_stones =
        2.0 * (f.ashlands_biome - 0.5) + 1.5 * (f.aux - 0.5) + 1.5 * (f.moisture - 0.66);
    let volcanic_ash_cracks = min2(1.0, 4.0 * (f.ashlands_biome - 0.25)) + 1.5 * (f.aux - 0.5)
        - 1.5 * (f.moisture - 0.66);
    let volcanic_ash_soil = 2.0 * (f.ashlands_biome - 0.5);

    // In `TILE_ORDER`. A reordering here against that constant would be a silent
    // relabelling of every tile, which `the_probability_vector_is_in_tile_order`
    // exists to catch.
    [
        volcanic_jagged_ground,
        max2(lava_basalts, lava_mountains),
        max2(lava_hot_basalts, lava_hot_mountains),
        volcanic_cracks_hot,
        volcanic_cracks_warm,
        volcanic_cracks_cold,
        volcanic_folds_flat,
        volcanic_ash_light,
        volcanic_ash_dark,
        volcanic_ash_flats,
        volcanic_pumice_stones,
        volcanic_smooth_stone,
        volcanic_smooth_stone_warm,
        volcanic_ash_cracks,
        volcanic_folds,
        volcanic_folds_warm,
        volcanic_soil_dark,
        volcanic_soil_light,
        volcanic_ash_soil,
    ]
}

/// The tile the game would place here: the argmax over [`tile_probabilities`],
/// ties keeping the first in [`TILE_ORDER`].
///
/// `>` rather than `>=` is what "first wins" means, and it is not a style
/// choice: three of these tiles share a colour and several share whole terms, so
/// exact ties are reachable rather than hypothetical.
#[must_use]
pub fn resolve_tile(f: &VulcanusTileFields) -> VulcanusTile {
    let p = tile_probabilities(f);
    let mut best_index = 0usize;
    let mut best = p[0];
    for (i, &v) in p.iter().enumerate().skip(1) {
        if v > best {
            best = v;
            best_index = i;
        }
    }
    // A numeric hook cannot reach a DISCRETE output - measured in phase 3, where
    // a one-ULP nudge left the Fulgora tile test green. This is the argmax's own
    // control.
    TILE_ORDER[crate::poison::index_result(best_index, TILE_ORDER.len())]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The probability vector and `TILE_ORDER` must stay aligned, because
    /// nothing in the argmax can notice them drifting apart - it would just
    /// return a confidently wrong name.
    ///
    /// Driven by making exactly one tile win from a field state chosen for it,
    /// so a swapped pair shows up as the wrong NAME rather than as a wrong
    /// number.
    #[test]
    fn the_probability_vector_is_in_tile_order() {
        assert_eq!(tile_probabilities(&VulcanusTileFields::default()).len(), 19);
        assert_eq!(TILE_ORDER.len(), 19);

        // `volcanic_cracks_warm` carries a `50000 * metal_tile` term that no
        // other expression except `smooth_stone_warm` carries, and the two
        // differ by the sign of the `aux` term. A positive `aux` offset picks
        // cracks-warm; a negative one picks smooth-stone-warm. If the vector and
        // the order were rotated, these would come back as neighbours instead.
        let mut f = VulcanusTileFields {
            metal_tile: 1.0,
            aux: 1.0,
            ..VulcanusTileFields::default()
        };
        assert_eq!(resolve_tile(&f), VulcanusTile::VolcanicCracksWarm);
        f.aux = -1.0;
        assert_eq!(resolve_tile(&f), VulcanusTile::VolcanicSmoothStoneWarm);
    }

    /// A tie keeps the EARLIER tile, which is the tie-break the game's argmax
    /// performs and the only reason `TILE_ORDER` has to be registration order.
    ///
    /// The state is chosen so the tie arises from the expressions agreeing
    /// rather than from a hand-written pair of equal numbers. At `moisture =
    /// 0.6` the `-1.5 * (moisture - 0.6)` term vanishes from `ash_light`, and at
    /// `aux = 0.25` the `-1.5 * (aux - 0.25)` term vanishes from `ash_flats`, so
    /// both collapse onto `ash_soil`'s bare `2 * (ashlands - 0.5)`; `ash_dark`
    /// joins them because its own `max` picks the zero arm. Four tiles at 1.0.
    ///
    /// The two negative fields are there to keep the tie the MAXIMUM: without
    /// them `soil_light`'s sulfuric-acid arm sits at `10 * 0.2` and
    /// `jagged_ground`'s calcite arm at `5 * 0.2`, both of which outrank it.
    /// The all-zero state was tried first and has no tie at all - the assertion
    /// at the end of this test is what said so.
    #[test]
    fn an_exact_tie_resolves_to_the_earlier_tile_in_order() {
        let f = VulcanusTileFields {
            ashlands_biome: 1.0,
            moisture: 0.6,
            aux: 0.25,
            sulfuric_acid_region_patchy: -1.0,
            calcite_region: -1.0,
            ..VulcanusTileFields::default()
        };
        let p = tile_probabilities(&f);
        let winner = resolve_tile(&f);
        let best = p.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let first_at_best = p.iter().position(|&v| v == best).unwrap();
        assert_eq!(winner, TILE_ORDER[first_at_best]);
        // And the tie is not vacuous: more than one tile reaches the maximum.
        assert!(
            p.iter().filter(|&&v| v == best).count() > 1,
            "no tie at the all-zero state, so this test proves nothing"
        );
    }

    /// The spawn excluder is a hard boolean at 10 tiles, not a ramp.
    ///
    /// It gates BOTH lava tiles' basalts arms, so getting it backwards floods
    /// spawn with lava - which is visible, but only on a fixture that samples
    /// inside 10 tiles of the origin.
    #[test]
    fn the_lava_spawn_excluder_is_a_hard_boundary_at_ten_tiles() {
        let near = VulcanusTileFields {
            distance: 10.0,
            ..VulcanusTileFields::default()
        };
        let far = VulcanusTileFields {
            distance: 10.001,
            ..VulcanusTileFields::default()
        };
        assert_eq!(near.lava_spawn_excluder(), 0.0, "at exactly 10 it excludes");
        assert_eq!(far.lava_spawn_excluder(), 1.0);
    }

    /// `volcanic_soil_light` has THREE arms and `volcanic_soil_dark` has two.
    ///
    /// The third is the sulfuric-acid region, and dropping it is the kind of
    /// error that leaves the map plausible everywhere except on acid.
    #[test]
    fn only_the_light_soil_reads_the_sulfuric_acid_region() {
        let base = VulcanusTileFields::default();
        let acid = VulcanusTileFields {
            sulfuric_acid_region_patchy: 1.0,
            ..base
        };
        let p_base = tile_probabilities(&base);
        let p_acid = tile_probabilities(&acid);
        let light = 17; // VolcanicSoilLight's index in TILE_ORDER
        let dark = 16; // VolcanicSoilDark's
        assert_eq!(TILE_ORDER[light], VulcanusTile::VolcanicSoilLight);
        assert_eq!(TILE_ORDER[dark], VulcanusTile::VolcanicSoilDark);
        assert!(p_acid[light] > p_base[light], "light soil must respond");
        assert_eq!(p_acid[dark], p_base[dark], "dark soil must not");
    }

    /// Three tiles genuinely share `[53, 53, 53]`, so a rendered image cannot
    /// distinguish them and only the name-level fixture can.
    ///
    /// Pinned so that "the colours are all distinct" never gets assumed by
    /// something downstream that wants to invert colour to tile.
    #[test]
    fn three_tiles_share_one_map_colour() {
        let shared = [
            VulcanusTile::VolcanicAshLight,
            VulcanusTile::VolcanicAshDark,
            VulcanusTile::VolcanicAshFlats,
        ];
        for t in shared {
            assert_eq!(t.color(), [53, 53, 53]);
        }
        assert_eq!(
            TILE_ORDER
                .iter()
                .filter(|t| t.color() == [53, 53, 53])
                .count(),
            3
        );
    }

    /// Every tile has a distinct name, which the fixture comparison relies on.
    #[test]
    fn every_tile_name_is_distinct() {
        let mut names: Vec<&str> = TILE_ORDER.iter().map(|t| t.name()).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before, "duplicate tile name");
    }

    /// `from_name` is the exact inverse of `name` for every tile, and refuses
    /// anything else.
    ///
    /// The refusal half is the one that matters: `fixtures.rs` resolves the
    /// oracle's recorded tile names through this, and a mapping that answered
    /// `Some` for a name Vulcanus does not place would make that grader read a
    /// typo as a real tile.
    #[test]
    fn from_name_inverts_name_and_refuses_anything_else() {
        for tile in TILE_ORDER {
            assert_eq!(VulcanusTile::from_name(tile.name()), Some(tile));
        }
        assert_eq!(VulcanusTile::from_name("lava-warm"), None);
        assert_eq!(VulcanusTile::from_name("water"), None);
        assert_eq!(VulcanusTile::from_name(""), None);
    }

    /// The cliff-blocking set is exactly `lava` and `lava-hot`, frozen.
    ///
    /// Frozen on purpose. The set was established by measurement - switching
    /// the two out of the tile autoplace category and regenerating - so a
    /// future change to it is a new measurement, and this test is what makes
    /// that change deliberate rather than incidental. Update the count and the
    /// names together, and say in the commit what was regenerated.
    #[test]
    fn exactly_two_tiles_block_a_cliff_and_they_are_the_lava_pair() {
        let blocking: Vec<&str> = TILE_ORDER
            .iter()
            .filter(|t| t.is_cliff_blocking())
            .map(|t| t.name())
            .collect();
        assert_eq!(blocking, vec!["lava", "lava-hot"]);
    }

    /// The exported hash is over the SORTED names, so the TypeScript side can
    /// reproduce it without knowing catalog order.
    ///
    /// Computed here the long way rather than restating a magic constant: a
    /// hardcoded digest would still pass if `cliff_blocking_names_fnv1a64`
    /// hashed the wrong thing and someone updated the constant to match.
    #[test]
    fn the_exported_hash_is_fnv1a64_of_the_sorted_names_joined_by_newlines() {
        let mut names: Vec<&str> = TILE_ORDER
            .iter()
            .filter(|t| t.is_cliff_blocking())
            .map(|t| t.name())
            .collect();
        names.sort_unstable();
        let expected = crate::checksum::fnv1a64(names.join("\n").as_bytes());
        assert_eq!(cliff_blocking_names_fnv1a64(), expected);
    }
}
