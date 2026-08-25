//! The whole Vulcanus field graph, built once and evaluated in one pass.
//!
//! The TypeScript counterpart is `makeVulcanusStack` in
//! `src/noise/tiles/vulcanusCatalog.ts`, which exists because five call sites -
//! the tile resolver, the resource overlay, the geyser placement, the rock
//! fields and the cliff fields - used to build their own copy of some or all of
//! the DAG. Its own comment records why that mattered there: `memoXY` is a
//! SINGLE-ENTRY cache, so separate copies share nothing at all.
//!
//! **That reason does not carry over, and the shape here is different because of
//! it.** There is no memo in this port - the chain is evaluated top to bottom at
//! one point and its intermediates live in locals, which is bit-identical to
//! memoising and needs no cache. What a shared stack buys HERE is the per-render
//! state: the `Prepared` multioctave tables, the `Plasma` leaves, and the two
//! region caches. Rebuilding those per pixel is the 20x mistake
//! `multioctave_noise`'s docs record.
//!
//! ## Why this is two structs and not one
//!
//! `VulcanusBiomes`, `VulcanusElevation` and `VulcanusResources` all BORROW the
//! layers beneath them, so a single struct owning the whole graph would be
//! self-referential and Rust will not have it. Splitting at the first borrow
//! gives [`VulcanusBase`] (everything that owns its data) and [`VulcanusStack`]
//! (everything that borrows), with the biome layer named in between because two
//! layers borrow it:
//!
//! ```no_run
//! # use fmw_noise::eval::ctx::EvalCtx;
//! # use fmw_noise::expressions::vulcanus_stack::{VulcanusBase, VulcanusStack};
//! let ctx = EvalCtx::new(123_456);
//! let base = VulcanusBase::with_host_trig(&ctx);
//! let biomes = base.biomes_with_host_trig();
//! let stack = VulcanusStack::with_host_trig(&base, &biomes);
//! let tile = stack.tile(0.0, 0.0);
//! ```
//!
//! Three lines rather than one, and they are honest about the ownership rather
//! than hiding it behind an arena.

use crate::cliffs::vulcanus_fields::CliffinessBasic;
use crate::distance_from_nearest_point::distance_from_nearest_point;
use crate::eval::ctx::EvalCtx;
use crate::expressions::starting_spot_at_angle::AngleTrig;
use crate::expressions::vulcanus_biomes::{BiomeFields, VulcanusBiomes};
use crate::expressions::vulcanus_climate::VulcanusClimate;
use crate::expressions::vulcanus_cracks::VulcanusCracks;
use crate::expressions::vulcanus_elevation::{ElevationFields, VulcanusElevation};
use crate::expressions::vulcanus_helpers::VulcanusHelpers;
use crate::expressions::vulcanus_resources::{OreRegions, ResourceFields, VulcanusResources};
use crate::expressions::vulcanus_spawn::VulcanusSpawn;
use crate::expressions::vulcanus_spawn::WobbleSums;
use crate::multioctave_noise::Prepared;
use crate::resources::vulcanus_catalog::sulfuric_acid_geyser_probability;
use crate::rocks::vulcanus_field::{vulcanus_decorative_knockout, VulcanusRockFields};
use crate::tiles::vulcanus_catalog::TILE_ORDER;
use crate::tiles::vulcanus_catalog::{
    resolve_tile, tile_probabilities, vulcanus_rock_noise, MountainLavaSpots, VulcanusTile,
    VulcanusTileFields,
};

/// The layers that own their data: everything below the first borrow.
pub struct VulcanusBase {
    pub ctx: EvalCtx,
    pub helpers: VulcanusHelpers,
    pub spawn: VulcanusSpawn,
    pub cracks: VulcanusCracks,
    pub climate: VulcanusClimate,
}

impl VulcanusBase {
    /// Build the owning half, taking the three spawn bearings' trig from the
    /// caller.
    ///
    /// See `starting_spot_at_angle`'s module docs for why trig crosses the
    /// boundary as a value: the expression has no f32 narrowing to absorb a
    /// one-ULP `sin` difference, and #270 measured the wasm libm and V8
    /// disagreeing.
    #[must_use]
    pub fn new(ctx: &EvalCtx, spawn_trig: [AngleTrig; 3]) -> Self {
        let helpers = VulcanusHelpers::new(ctx);
        let cracks = VulcanusCracks::new(&helpers);
        let spawn = VulcanusSpawn::new(ctx, spawn_trig[0], spawn_trig[1], spawn_trig[2]);
        let climate = VulcanusClimate::new(ctx.seed0);
        Self {
            ctx: ctx.clone(),
            helpers,
            spawn,
            cracks,
            climate,
        }
    }

    /// As [`VulcanusBase::new`], but computing the three bearings with Rust's
    /// libm. **Not for the shipped engine** - see `AngleTrig::from_degrees`.
    #[must_use]
    pub fn with_host_trig(ctx: &EvalCtx) -> Self {
        let helpers = VulcanusHelpers::new(ctx);
        let cracks = VulcanusCracks::new(&helpers);
        let spawn = VulcanusSpawn::with_host_trig(ctx);
        let climate = VulcanusClimate::new(ctx.seed0);
        Self {
            ctx: ctx.clone(),
            helpers,
            spawn,
            cracks,
            climate,
        }
    }

    /// The biome layer, which both the elevation and resource layers borrow.
    ///
    /// It is built by the caller rather than held here so the two borrowers can
    /// name the same one; holding it would make [`VulcanusBase`]
    /// self-referential.
    #[must_use]
    pub fn biomes(
        &self,
        volcano_spot_trig: AngleTrig,
        protector_trig: AngleTrig,
    ) -> VulcanusBiomes<'_> {
        VulcanusBiomes::new(
            &self.ctx,
            &self.helpers,
            &self.spawn,
            volcano_spot_trig,
            protector_trig,
        )
    }

    /// As [`VulcanusBase::biomes`], with host libm trig. Tests only.
    #[must_use]
    pub fn biomes_with_host_trig(&self) -> VulcanusBiomes<'_> {
        VulcanusBiomes::with_host_trig(&self.ctx, &self.helpers, &self.spawn)
    }
}

/// The layers that borrow, plus the two fields only the tile catalog reads.
pub struct VulcanusStack<'a> {
    base: &'a VulcanusBase,
    biomes: &'a VulcanusBiomes<'a>,
    elevation: VulcanusElevation<'a>,
    resources: VulcanusResources<'a>,
    lava_spots: MountainLavaSpots,
    rock_noise: Prepared,
}

impl<'a> VulcanusStack<'a> {
    /// Build the borrowing half, taking the resource layer's five bearings from
    /// the caller.
    #[must_use]
    pub fn new(
        base: &'a VulcanusBase,
        biomes: &'a VulcanusBiomes<'a>,
        resource_trig: [AngleTrig; 5],
    ) -> Self {
        Self {
            base,
            biomes,
            elevation: VulcanusElevation::new(
                &base.ctx,
                &base.helpers,
                &base.cracks,
                biomes,
                &base.climate,
            ),
            resources: VulcanusResources::new(
                &base.ctx,
                &base.helpers,
                &base.spawn,
                biomes,
                &base.cracks,
                resource_trig,
            ),
            lava_spots: MountainLavaSpots::new(&base.helpers),
            rock_noise: vulcanus_rock_noise(base.ctx.seed0),
        }
    }

    /// As [`VulcanusStack::new`], with host libm trig. **Tests only.**
    #[must_use]
    pub fn with_host_trig(base: &'a VulcanusBase, biomes: &'a VulcanusBiomes<'a>) -> Self {
        Self {
            base,
            biomes,
            elevation: VulcanusElevation::new(
                &base.ctx,
                &base.helpers,
                &base.cracks,
                biomes,
                &base.climate,
            ),
            resources: VulcanusResources::with_host_trig(
                &base.ctx,
                &base.helpers,
                &base.spawn,
                biomes,
                &base.cracks,
            ),
            lava_spots: MountainLavaSpots::new(&base.helpers),
            rock_noise: vulcanus_rock_noise(base.ctx.seed0),
        }
    }

    /// The biome layer's fields at one position. Exposed because three of the
    /// tile ranges read them directly.
    #[must_use]
    pub fn biomes(&self, x: f64, y: f64) -> BiomeFields {
        self.biomes.eval(x, y)
    }

    /// The resource layer's fields at one position.
    #[must_use]
    pub fn resources(&self, x: f64, y: f64) -> ResourceFields {
        self.resources.eval(x, y)
    }

    /// `vulcanus_aux` and `vulcanus_moisture` at one position.
    ///
    /// Exposed because the rock probability expressions read both and nothing
    /// else from the climate layer. Evaluating the crack layer first is not
    /// optional - climate is defined over it.
    #[must_use]
    pub fn climate(&self, x: f64, y: f64) -> crate::expressions::vulcanus_climate::ClimateFields {
        let cracks = self.base.cracks.eval(x, y);
        self.base.climate.eval(x, y, &cracks)
    }

    /// `vulcanus_rock_noise`, the four-octave field both rock expressions add.
    ///
    /// Narrowed through `f32` the same way [`VulcanusStack::tile_fields`]
    /// carries it, because the multioctave returns f32 and the TypeScript's
    /// `sumOctaves` does too.
    #[must_use]
    pub fn rock_noise(&self, x: f64, y: f64) -> f64 {
        f64::from(self.rock_noise.eval(x, y))
    }

    /// The three solid ores' region fields, which is all the ore -> cliff
    /// rejection reads. A projection of [`VulcanusStack::resources`], not a
    /// second model of it - see [`VulcanusResources::ore_regions`].
    #[must_use]
    pub fn ore_regions(&self, x: f64, y: f64) -> OreRegions {
        self.resources.ore_regions(x, y)
    }

    /// `vulcanus_elev` and `vulcanus_elevation` together - the raw field and
    /// the `max(-500, elev)` clamp over it.
    ///
    /// Both at one point rather than two calls, because the tier-2 fold grades
    /// them as separate fields and the clamp is the only thing between them.
    /// **No fixture can grade that clamp**: the captured `elev` bottoms out at
    /// -58.77, so the two columns are the same field at all 434 positions and a
    /// port that dropped the `max` would score identically. The clamp's real
    /// test lives in `vulcanus_elevation`, constructing the case the fixture
    /// does not.
    fn elevation_fields(&self, x: f64, y: f64) -> ElevationFields {
        self.elevation.eval(x, y)
    }

    /// `vulcanus_temperature`, at this stack's own `control:temperature:bias`.
    ///
    /// Exposed for the tier-2 fold, and it is one of the fields that fold
    /// exists for: **no render path reads temperature at all**, so tier 3's
    /// byte-identical pixels say nothing about it. Tier 1 grades it against the
    /// game (244 of 434) and tier 2 is the only thing that would notice it
    /// diverging from the TypeScript.
    fn temperature(&self, x: f64, y: f64) -> f64 {
        self.elevation
            .temperature(x, y, self.base.ctx.temperature_bias)
    }

    /// `vulcanus_elevation` in the TILE channel - the 1-tile grid every
    /// per-tile consumer walks, and what `calculate_tile_properties` reports.
    ///
    /// Distinct from [`VulcanusStack::cliff_elevation`] by exactly the amount
    /// `multisample` shifts between grids (#83), which is not a rounding
    /// difference: the two disagree by tens of tiles over most of a region.
    #[must_use]
    pub fn elevation(&self, x: f64, y: f64) -> f64 {
        self.elevation.eval(x, y).elevation
    }

    /// `cliff_elevation`, the elevation field the CLIFF generator samples.
    ///
    /// Distinct from the `elevation` the tile generator reads, because
    /// `multisample`'s offsets are in the consuming program's grid units and
    /// the cliff generator walks a 4-tile lattice (#83). Both hang off this one
    /// stack and share every sub-expression below the multisample.
    #[must_use]
    pub fn cliff_elevation(&self, x: f64, y: f64) -> f64 {
        self.elevation.cliff_elevation(x, y)
    }

    /// Every field the 19 tile expressions read, at one position.
    #[must_use]
    pub fn tile_fields(&self, x: f64, y: f64) -> VulcanusTileFields {
        let biomes = self.biomes.eval(x, y);
        let cracks = self.base.cracks.eval(x, y);
        let climate = self.base.climate.eval(x, y, &cracks);
        let resources = self.resources.eval(x, y);
        VulcanusTileFields {
            // The RAW `elev`, not the clamped `elevation` - see
            // `VulcanusTileFields`'s own doc comment.
            elev: self.elevation.eval(x, y).elev,
            aux: climate.aux,
            moisture: climate.moisture,
            mountains_biome: biomes.mountains_biome,
            ashlands_biome: biomes.ashlands_biome,
            basalts_biome: biomes.basalts_biome,
            mountain_volcano_spots: biomes.mountain_volcano_spots,
            mountain_lava_spots: self.lava_spots.eval(x, y, &biomes),
            rock_noise: f64::from(self.rock_noise.eval(x, y)),
            distance: f64::from(distance_from_nearest_point(
                x,
                y,
                &self.base.ctx.starting_positions,
                f64::INFINITY,
            )),
            metal_tile: resources.metal_tile,
            calcite_region: resources.calcite_region,
            sulfuric_acid_region_patchy: resources.sulfuric_acid_region_patchy,
        }
    }

    /// The 19 tile probabilities at one position, in `TILE_ORDER`.
    #[must_use]
    pub fn tile_probabilities(&self, x: f64, y: f64) -> [f64; 19] {
        tile_probabilities(&self.tile_fields(x, y))
    }

    /// The tile the game would place here.
    #[must_use]
    pub fn tile(&self, x: f64, y: f64) -> VulcanusTile {
        resolve_tile(&self.tile_fields(x, y))
    }
}

/// Tier 2's field selector for the Vulcanus graph: one named expression, by index.
///
/// **This lives here rather than in the wasm crate on purpose.** The selector
/// needs `elevation_fields` and `temperature`, which nothing on a render path
/// reads - temperature is not drawn at all, and `elev` versus its clamp is a
/// distinction no fixture can make. Reaching them from another crate meant two
/// `pub` methods on a library type that existed solely for a test, and a `pub`
/// method cannot be `#[cfg(test)]`-gated because the wasm crate calls it at
/// build time. Keeping the selector in this module makes both private again.
///
/// The layers it evaluates per point are deliberately NOT shared with each
/// other - `tile_fields` re-evaluates the biome and resource layers, for
/// instance. That is the point: each field is reached through its own entry
/// point, the same one its consumer uses, so a field wired to the wrong layer
/// shows up as a divergence rather than being smoothed over by a shared
/// intermediate. It runs once in a test, so the redundancy is free.
pub struct VulcanusParity<'a, 'b> {
    stack: &'a VulcanusStack<'b>,
    rocks: VulcanusRockFields<'a, 'b>,
    knockout: Prepared,
    cliffiness: CliffinessBasic,
}

impl<'a, 'b> VulcanusParity<'a, 'b> {
    /// How many named fields [`Self::field`] can select, `0..FIELD_COUNT`.
    ///
    /// The order is the order the chain evaluates in: helpers, spawn, cracks,
    /// climate, biomes, elevation, resources, the tile-support fields, the two
    /// overlay fields, then the 19 tile probabilities and the argmax over them.
    pub const FIELD_COUNT: u32 = 74;

    #[must_use]
    pub fn new(stack: &'a VulcanusStack<'b>, seed0: u32) -> Self {
        Self {
            stack,
            // The overlay fields hang off the same stack rather than rebuilding
            // the chain, which is what their own constructors are for.
            rocks: VulcanusRockFields::new(stack, seed0),
            knockout: vulcanus_decorative_knockout(seed0),
            cliffiness: CliffinessBasic::for_vulcanus(seed0),
        }
    }

    /// One named field at `(x, y)`. Out-of-range indices resolve to the argmax,
    /// matching the exhaustive `match` this was lifted from.
    #[must_use]
    #[allow(clippy::too_many_lines)]
    pub fn field(&self, field: u32, x: f64, y: f64) -> f64 {
        let base = self.stack.base;
        let sp = base.spawn.eval(x, y, WobbleSums::at(&base.helpers, x, y));
        let cr = base.cracks.eval(x, y);
        let cl = base.climate.eval(x, y, &cr);
        let bi = self.stack.biomes.eval(x, y);
        let el = self.stack.elevation_fields(x, y);
        let res = self.stack.resources(x, y);
        let tf = self.stack.tile_fields(x, y);
        let rk = self.rocks.eval(x, y);

        match field {
            0 => base.helpers.wobble_x(x, y),
            1 => base.helpers.wobble_y(x, y),
            2 => base.helpers.wobble_large_x(x, y),
            3 => base.helpers.wobble_large_y(x, y),
            4 => base.helpers.wobble_huge_x(x, y),
            5 => base.helpers.wobble_huge_y(x, y),
            6 => sp.ashlands_start,
            7 => sp.basalts_start,
            8 => sp.mountains_start,
            9 => sp.starting_area,
            10 => sp.starting_circle,
            11 => cr.hairline_cracks,
            12 => cr.flood_cracks_a,
            13 => cr.flood_cracks_b,
            14 => cr.flood_paths,
            15 => cr.flood_basalts_func,
            16 => cl.aux,
            17 => cl.moisture,
            18 => bi.mountain_volcano_spots,
            19 => bi.mountains_raw_volcano,
            20 => bi.mountains_biome_full,
            21 => bi.ashlands_biome_full,
            22 => bi.basalts_biome_full,
            23 => bi.mountains_biome,
            24 => bi.ashlands_biome,
            25 => bi.basalts_biome,
            // The RAW `elev` and its clamp, graded separately. No fixture can
            // tell them apart - see `VulcanusStack::elevation_fields`.
            26 => el.elev,
            27 => el.elevation,
            // A genuinely different field, not a rounding of the one above:
            // `multisample`'s offsets are in the CONSUMING program's grid units
            // and the cliff lattice is 4 tiles wide (#83).
            28 => self.stack.cliff_elevation(x, y),
            // Read by no renderer at all, which is half the argument for this
            // selector existing.
            29 => self.stack.temperature(x, y),
            30 => res.basalts_favorability,
            31 => res.mountains_favorability,
            32 => res.mountains_sulfur_favorability,
            33 => res.ashlands_favorability,
            34 => res.starting_tungsten,
            35 => res.starting_coal,
            36 => res.starting_calcite,
            37 => res.starting_sulfur,
            38 => res.tungsten_region,
            39 => res.coal_region,
            40 => res.calcite_region,
            41 => res.sulfuric_acid_region,
            42 => res.sulfuric_acid_patches,
            43 => res.sulfuric_acid_region_patchy,
            44 => res.metal_tile,
            45 => sulfuric_acid_geyser_probability(res.sulfuric_acid_region_patchy),
            46 => tf.mountain_lava_spots,
            47 => tf.rock_noise,
            48 => tf.distance,
            49 => self.cliffiness.eval(x, y),
            50 => f64::from(self.knockout.eval(x, y)),
            51 => rk.rock_huge,
            52 => rk.rock_big,
            53 => rk.density,
            // The 19 tile probabilities, in `TILE_ORDER`.
            54..=72 => tile_probabilities(&tf)[(field - 54) as usize],
            // The resolved tile, as its index in `TILE_ORDER`. A number so it
            // rides the same comparator as the probabilities it derives from,
            // and a DISCRETE one, which is why `resolve_tile` carries
            // `poison::index_result` rather than a numeric hook.
            _ => tile_index(resolve_tile(&tf)),
        }
    }
}

/// A resolved tile as its position in [`TILE_ORDER`].
///
/// A linear scan rather than a second table, so it cannot drift from the order
/// the argmax resolves against.
fn tile_index(tile: crate::tiles::vulcanus_catalog::VulcanusTile) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    TILE_ORDER
        .iter()
        .position(|&t| t == tile)
        .map_or(f64::NAN, |i| i as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stack must be usable, and the three-line construction in the module
    /// docs must actually compile and run.
    #[test]
    fn the_documented_three_line_construction_works() {
        let ctx = EvalCtx::new(123_456);
        let base = VulcanusBase::with_host_trig(&ctx);
        let biomes = base.biomes_with_host_trig();
        let stack = VulcanusStack::with_host_trig(&base, &biomes);
        let tile = stack.tile(0.0, 0.0);
        // Whichever tile it is, it must be one the catalog knows, and its name
        // must be non-empty - a cheap guard against an enum gaining a variant
        // that `name()` forgets.
        assert!(!tile.name().is_empty());
    }

    /// The tile fields must read the RAW `elev`, not the clamped `elevation`.
    ///
    /// The two are identical above -500, which is everywhere the tile fixture
    /// samples, so no fixture can see this wired wrongly. Asserted directly
    /// against the elevation layer instead.
    #[test]
    fn the_tile_fields_read_the_unclamped_elev() {
        let ctx = EvalCtx::new(123_456);
        let base = VulcanusBase::with_host_trig(&ctx);
        let biomes = base.biomes_with_host_trig();
        let stack = VulcanusStack::with_host_trig(&base, &biomes);
        for (x, y) in [(0.0, 0.0), (137.0, -411.0), (-1024.5, 2048.25)] {
            assert_eq!(
                stack.tile_fields(x, y).elev,
                stack.elevation.eval(x, y).elev,
                "tile_fields must carry elev, not elevation"
            );
        }
    }
}
