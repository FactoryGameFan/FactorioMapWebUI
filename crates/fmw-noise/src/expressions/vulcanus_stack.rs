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

use crate::distance_from_nearest_point::distance_from_nearest_point;
use crate::eval::ctx::EvalCtx;
use crate::expressions::starting_spot_at_angle::AngleTrig;
use crate::expressions::vulcanus_biomes::{BiomeFields, VulcanusBiomes};
use crate::expressions::vulcanus_climate::VulcanusClimate;
use crate::expressions::vulcanus_cracks::VulcanusCracks;
use crate::expressions::vulcanus_elevation::VulcanusElevation;
use crate::expressions::vulcanus_helpers::VulcanusHelpers;
use crate::expressions::vulcanus_resources::{OreRegions, ResourceFields, VulcanusResources};
use crate::expressions::vulcanus_spawn::VulcanusSpawn;
use crate::multioctave_noise::Prepared;
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

    /// The three solid ores' region fields, which is all the ore -> cliff
    /// rejection reads. A projection of [`VulcanusStack::resources`], not a
    /// second model of it - see [`VulcanusResources::ore_regions`].
    #[must_use]
    pub fn ore_regions(&self, x: f64, y: f64) -> OreRegions {
        self.resources.ore_regions(x, y)
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
