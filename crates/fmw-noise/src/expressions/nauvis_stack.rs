//! The Nauvis expression stack, and the tier-2 field selector over it.
//!
//! One place that builds every Nauvis expression from one set of controls, so
//! a consumer cannot wire the shared layer into `aux` at one segmentation and
//! into `moisture` at another.
//!
//! ## The selector lives HERE, not in the wasm crate
//!
//! Copied from `vulcanus_stack`, and for its reason rather than for symmetry:
//! a selector in the other crate needs every field it reads to be `pub`, and a
//! `pub` method cannot be `#[cfg(test)]`-gated because the wasm crate calls it
//! at build time. That leaks test-only API into the library permanently.
//! Keeping it beside the layers lets them stay private.
//!
//! Vulcanus also learned that a parity fold must go through the SAME helpers
//! the renderer uses, or a mis-wiring is reproduced identically on both sides
//! and stays invisible. [`NauvisStack`] is that shared construction; when the
//! Nauvis render path lands it must build from this and not from its own copy.
//!
//! ## No trig crosses this boundary, and Nauvis is the first planet where that is free
//!
//! Fulgora and Vulcanus both hand their bearings' sine and cosine in as VALUES,
//! because `starting_spot_at_angle` is un-narrowed f64 arithmetic and #270
//! measured the wasm libm disagreeing with V8. Nauvis reaches no
//! transcendental at all - no `starting_spot_at_angle`, no `slider_rescale` -
//! so there is nothing to lift out. `moisture` calls `slider_to_linear`, which
//! is f32 per operation and is graded by its own tier-1 test.
//!
//! **If a future Nauvis field reaches `pow`, `log2`, `sin` or `cos`, that
//! changes and it needs its value passed in.**

use std::cell::OnceCell;

use crate::cliffs::catalog::{CliffControls, CliffSettings};
use crate::cliffs::fields::{CliffFieldParams, NauvisCliffFields};
use crate::distance_from_nearest_point::Point;
use crate::expressions::elevation_lakes::{ElevationLakes, ElevationLakesParams};
use crate::expressions::elevation_nauvis::{ElevationNauvis, ElevationNauvisParams};
use crate::expressions::nauvis_climate::{
    Aux, AuxParams, Moisture, MoistureParams, Temperature, TemperatureParams,
};
use crate::expressions::nauvis_shared::{NauvisShared, NauvisSharedParams};
use crate::resources::nauvis_catalog::{resource_by_name, NAUVIS_RESOURCE_CATALOG};
use crate::resources::resolve_resource::{ResourceResolver, ResourceResolverCtx};
use crate::resources::resource_math::ResourceControlLevers;
use crate::resources::resource_patches::{ResourcePatches, ResourcePatchesCtx};
use crate::rocks::catalog::RockControls;
use crate::rocks::field::{NauvisRockFields, RockFieldParams};
use crate::tiles::nauvis_catalog::{NauvisTileCatalog, NauvisTileFields, TILE_ORDER};
use crate::trees::catalog::TREE_SPECIES;
use crate::trees::field::TreeFields;

/// Every control the Nauvis expression core reads.
#[derive(Clone, Debug)]
pub struct NauvisCtx {
    /// Map seed (= `map_seed` / `seed0`).
    pub seed0: u32,
    /// `10 * log2(control:water:size)`.
    pub water_level: f64,
    /// `control:water:frequency`, RAW - the `1.5 *` happens inside the shared
    /// layer.
    pub segmentation_multiplier: f64,
    /// `control:moisture:frequency`.
    pub moisture_frequency: f64,
    /// `control:moisture:bias`.
    pub moisture_bias: f64,
    /// `control:aux:frequency`.
    pub aux_frequency: f64,
    /// `control:aux:bias`.
    pub aux_bias: f64,
    /// `control:temperature:frequency`.
    pub temperature_frequency: f64,
    /// `control:temperature:bias`.
    pub temperature_bias: f64,
    /// `control:starting_area_moisture:size`.
    pub starting_area_moisture_size: f64,
    /// `control:starting_area_moisture:frequency`.
    pub starting_area_moisture_frequency: f64,
    /// Spawn points.
    pub starting_positions: Vec<Point>,
    /// `control:trees:frequency`.
    pub trees_frequency: f64,
    /// `control:trees:size`.
    pub trees_size: f64,
    /// `control:<resource>:frequency|size|richness`, applied to EVERY resource.
    ///
    /// One set of levers rather than six, and that is a sweep decision rather
    /// than a modelling one: the three levers reach three different formulas
    /// (`size` and `frequency` the field, `richness` only the wrapper), so
    /// moving them uniformly exercises every path. Eighteen separate arguments
    /// across the ABI would buy nothing the resolver's own cargo tests do not
    /// already cover.
    ///
    /// **`size` must stay above 0 in a parity sweep.** At or below it the
    /// resolver drops the resource entirely and every resource field folds
    /// zeros, which is a vacuous comparison rather than a failing one.
    pub resource_controls: ResourceControlLevers,
    /// The `nauvis_cliff` autoplace control.
    pub cliff_controls: CliffControls,
    /// The cliff-related `MapGenSettings` fields.
    ///
    /// `cliff_elevation_0` is carried but read by neither cliff field, so a
    /// sweep moving it grades nothing. It is here because the render path will
    /// need it and because it mirrors the TypeScript's own `CliffSettingsInput`.
    pub cliff_settings: CliffSettings,
    /// The `rocks` autoplace control.
    pub rock_controls: RockControls,
}

impl NauvisCtx {
    /// The game's default controls at one seed, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            water_level: 0.0,
            segmentation_multiplier: 1.0,
            moisture_frequency: 1.0,
            moisture_bias: 0.0,
            aux_frequency: 1.0,
            aux_bias: 0.0,
            temperature_frequency: 1.0,
            temperature_bias: 0.0,
            starting_area_moisture_size: 1.0,
            starting_area_moisture_frequency: 1.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            trees_frequency: 1.0,
            trees_size: 1.0,
            resource_controls: ResourceControlLevers::defaults(),
            cliff_controls: CliffControls::defaults(),
            cliff_settings: CliffSettings::defaults(),
            rock_controls: RockControls::defaults(),
        }
    }
}

/// Every Nauvis expression, built once from one context.
///
/// Two structs are NOT needed here, unlike `vulcanus_stack`: nothing in this
/// chain borrows a layer beneath it, because each expression owns its own
/// [`NauvisShared`]. That is three shared layers rather than one - see
/// [`NauvisStack::new`] for why that is the faithful arrangement and not
/// waste to be optimised away.
pub struct NauvisStack {
    /// The shared sub-tree at the stack's own segmentation, for callers that
    /// want its fields directly.
    pub shared: NauvisShared,
    /// `elevation_nauvis`.
    pub elevation_nauvis: ElevationNauvis,
    /// `elevation_nauvis_no_cliff` - `cliff_elevation_nauvis`'s dependency.
    pub elevation_nauvis_no_cliff: ElevationNauvis,
    /// `elevation_lakes`.
    pub elevation_lakes: ElevationLakes,
    /// `elevation_island`.
    pub elevation_island: ElevationLakes,
    /// `aux_nauvis`.
    pub aux: Aux,
    /// `moisture_nauvis`.
    pub moisture: Moisture,
    /// `temperature_basic`.
    pub temperature: Temperature,
}

impl NauvisStack {
    /// Build every expression from one context.
    ///
    /// Each member derives its own [`NauvisShared`] rather than borrowing one,
    /// which is what the TypeScript does - `makeAux`, `makeMoisture` and
    /// `makeElevationNauvis` each call `makeNauvisShared` - and the results are
    /// bit-identical either way, because the layer is a pure function of
    /// `(seed0, segmentation)`. Sharing one would be a performance change with
    /// a borrow-checker cost and no behavioural difference; it is deliberately
    /// not made here, so that this construction stays a transcription.
    #[must_use]
    pub fn new(ctx: &NauvisCtx) -> Self {
        let seed0 = ctx.seed0;
        let seg = ctx.segmentation_multiplier;

        let elevation_nauvis_params = ElevationNauvisParams {
            seed0,
            water_level: ctx.water_level,
            segmentation_multiplier: seg,
            starting_positions: ctx.starting_positions.clone(),
            starting_lake_positions: None,
            with_cliff_elevation: true,
        };
        let mut no_cliff_params = elevation_nauvis_params.clone();
        no_cliff_params.with_cliff_elevation = false;

        let lakes_params = ElevationLakesParams {
            seed0,
            water_level: ctx.water_level,
            segmentation_multiplier: seg,
            starting_positions: ctx.starting_positions.clone(),
            starting_lake_positions: None,
            bias: 20.0,
        };

        Self {
            shared: NauvisShared::new(&NauvisSharedParams {
                seed0,
                segmentation_multiplier: seg,
            }),
            elevation_nauvis: ElevationNauvis::new(&elevation_nauvis_params),
            elevation_nauvis_no_cliff: ElevationNauvis::new(&no_cliff_params),
            elevation_lakes: ElevationLakes::new(&lakes_params),
            elevation_island: ElevationLakes::new(&lakes_params.clone().to_island()),
            aux: Aux::new(&AuxParams {
                seed0,
                segmentation_multiplier: seg,
                frequency: ctx.aux_frequency,
                bias: ctx.aux_bias,
            }),
            moisture: Moisture::new(&MoistureParams {
                seed0,
                segmentation_multiplier: seg,
                moisture_frequency: ctx.moisture_frequency,
                moisture_bias: ctx.moisture_bias,
                starting_area_moisture_size: ctx.starting_area_moisture_size,
                starting_area_moisture_frequency: ctx.starting_area_moisture_frequency,
                starting_positions: ctx.starting_positions.clone(),
            }),
            temperature: Temperature::new(&TemperatureParams {
                seed0,
                frequency: ctx.temperature_frequency,
                bias: ctx.temperature_bias,
            }),
        }
    }

    /// How many named fields [`Self::field`] can select, `0..FIELD_COUNT`.
    ///
    /// The order is the order the chain evaluates in: the shared layer, then
    /// the four elevation trees, then the three climate expressions.
    ///
    /// The count is a constant on the struct that owns the `match`, so the two
    /// cannot drift apart, and the wasm crate re-exports it rather than
    /// restating it.
    pub const FIELD_COUNT: u32 = 16;

    /// One named field at `(x, y)`.
    ///
    /// Out-of-range indices resolve to `temperature`, matching the exhaustive
    /// `match` this was lifted from.
    #[must_use]
    pub fn field(&self, field: u32, x: f64, y: f64) -> f64 {
        match field {
            0 => self.shared.hills(x, y),
            1 => self.shared.cliff_level(x, y),
            2 => self.shared.plateaus(x, y),
            3 => self.shared.bridge_billows(x, y),
            4 => self.shared.forest_path_billows(x, y),
            5 => self.shared.hills_offset_raw_x(x, y),
            6 => self.shared.hills_offset_raw_y(x, y),
            7 => self.shared.hills_offset(x, y),
            8 => self.shared.cliff_ringbreak(x, y),
            9 => self.elevation_nauvis.eval(x, y),
            10 => self.elevation_nauvis_no_cliff.eval(x, y),
            11 => self.elevation_lakes.eval(x, y),
            12 => self.elevation_island.eval(x, y),
            13 => self.aux.eval(x, y),
            14 => self.moisture.eval(x, y),
            _ => self.temperature.eval(x, y),
        }
    }
}

/// The tier-2 field selector: the whole Nauvis chain plus the tile layer above
/// it.
///
/// It is a separate struct from [`NauvisStack`] rather than more arms on
/// `NauvisStack::field`, for the reason the Vulcanus port records: the tile
/// catalog builds nineteen `Prepared` multioctaves, and nothing on the
/// expression chain needs them. Folding them into the stack would make every
/// tier-1 fixture test pay for a layer it does not read.
///
/// **The selector lives here, beside the stack, and NOT in the wasm crate.**
/// Reaching these fields from another crate would mean `pub` accessors that
/// exist solely for a test, and a `pub` method cannot be `#[cfg(test)]`-gated
/// because the wasm crate calls it at build time. Keeping it here also keeps
/// [`Self::FIELD_COUNT`] on the type that owns the `match`, so the count and
/// the arms it bounds cannot drift apart.
pub struct NauvisParity<'a, 'b> {
    stack: &'a NauvisStack,
    /// The tree layer, when the caller built one.
    ///
    /// **Borrowed rather than owned, and that is ownership rather than taste.**
    /// `TreeFields` borrows a `TreeBase`, so a selector owning both would be
    /// self-referential - the same split `vulcanus_stack` makes. It is an
    /// `Option` so the caller can skip building it: `checksum_nauvis` is one
    /// call per FIELD, and the tree layer builds sixteen `Prepared`
    /// multioctaves plus a climate stack that the other 57 fields never read.
    trees: Option<&'b TreeFields<'b>>,
    tiles: NauvisTileCatalog,
    /// Everything the resource fields need, kept so they can be built once.
    resource_ctx: ResourceResolverCtx,
    /// The resource layer, built on first use.
    ///
    /// Lazy for a measured reason rather than a stylistic one: constructing it
    /// builds four `ElevationNauvis` trees, because the starting favorability
    /// of each solid reads the map's elevation. `checksum_nauvis` is one call
    /// per FIELD, so an eager build would make all 38 expression and tile
    /// fields pay for a layer none of them reads.
    resources: OnceCell<NauvisResourceFields>,
    /// Everything the cliff and rock fields need, kept so they can be built
    /// once.
    cliff_rock_ctx: CliffRockCtx,
    /// The cliff and rock layer, built on first use.
    ///
    /// Lazy for the same measured reason as the resource block above, and the
    /// cost here is the same one: `NauvisCliffFields` builds a whole
    /// `ElevationNauvis` for `elevation_nauvis_no_cliff`, and
    /// `NauvisRockFields` builds a `Moisture` and an `Aux`, each of which
    /// carries its own `NauvisShared`. An eager build would charge all 76
    /// earlier fields for a layer none of them reads.
    ///
    /// It is an owned `OnceCell` rather than the tree layer's borrowed
    /// `Option`, because nothing here borrows anything with a shorter life than
    /// the selector - `NauvisCliffFields` and `NauvisRockFields` each own their
    /// sub-layers outright, so there is no self-reference to work around.
    cliff_rock: OnceCell<NauvisCliffRockFields>,
}

/// What the cliff and rock fields need, carried until first use.
struct CliffRockCtx {
    cliff: CliffFieldParams,
    rock: RockFieldParams,
}

/// The cliff and rock layer as tier 2 sees it.
struct NauvisCliffRockFields {
    cliffs: NauvisCliffFields,
    rocks: NauvisRockFields,
}

/// The resource layer as tier 2 sees it.
///
/// **The five thresholded resources come from the shipped [`ResourceResolver`],
/// not from a private copy of its wiring**, which is the rule Vulcanus's
/// `checksum_vulcanus` records: a copy is reproduced identically on both sides
/// and stays invisible. Here it does more than that. The TypeScript half of the
/// sweep cannot reach inside `makeResourceResolver`, which returns a bare
/// closure and exposes nothing, so that side builds its six fields from the
/// documented skip constants instead. The two sides reach the same numbers by
/// two different routes,
/// and agreement is evidence that the resolver really does partition the
/// streams the way its own documentation says. A shared copy would have proved
/// nothing.
///
/// Crude oil is built separately because the resolver deliberately does not
/// hold it - it is the one `Roll` resource - and it is built with the same skip
/// parameters the resolver would have used, which is what the renderer's own
/// oil pass does.
struct NauvisResourceFields {
    resolver: ResourceResolver,
    oil: ResourcePatches,
}

impl<'a, 'b> NauvisParity<'a, 'b> {
    /// How many named fields [`Self::field`] can select, `0..FIELD_COUNT`.
    ///
    /// The order is the order the chain evaluates in: the sixteen expression
    /// fields [`NauvisStack::field`] selects, then the 21 tile probabilities in
    /// `TILE_ORDER`, then the argmax over them, then the resource layer (six
    /// `field`s, six `probability`s, six `richness`es and the resolver's
    /// winner), then the tree layer (`tree_small_noise`, the two forest-path
    /// cutouts, the 15 species and the density over them), and finally the
    /// cliff and rock block.
    pub const FIELD_COUNT: u32 = Self::CLIFF_ROCK_BASE + 6;

    /// Where the resource block starts.
    const RESOURCE_BASE: u32 = NauvisStack::FIELD_COUNT + 21 + 1;
    /// Where the tree block starts.
    pub const TREE_BASE: u32 = Self::RESOURCE_BASE + 6 * 3 + 1;
    /// Where the cliff and rock block starts: `cliff_elevation`, `cliffiness`,
    /// the three rock probabilities and `rock_density`.
    pub const CLIFF_ROCK_BASE: u32 = Self::TREE_BASE + 3 + 15 + 1;

    #[must_use]
    pub fn new(stack: &'a NauvisStack, ctx: &NauvisCtx) -> Self {
        Self {
            stack,
            trees: None,
            tiles: NauvisTileCatalog::new(ctx.seed0),
            resource_ctx: ResourceResolverCtx {
                seed0: ctx.seed0,
                // Every resource on the same levers - see `NauvisCtx`.
                controls: NAUVIS_RESOURCE_CATALOG
                    .iter()
                    .map(|r| (r.control_name.to_string(), ctx.resource_controls))
                    .collect(),
                starting_positions: ctx.starting_positions.clone(),
                segmentation_multiplier: ctx.segmentation_multiplier,
                water_level: ctx.water_level,
                starting_lake_positions: None,
            },
            resources: OnceCell::new(),
            cliff_rock_ctx: CliffRockCtx {
                cliff: CliffFieldParams {
                    seed0: ctx.seed0,
                    controls: ctx.cliff_controls,
                    settings: ctx.cliff_settings,
                    segmentation_multiplier: ctx.segmentation_multiplier,
                    water_level: ctx.water_level,
                    starting_positions: ctx.starting_positions.clone(),
                    starting_lake_positions: None,
                },
                rock: RockFieldParams {
                    seed0: ctx.seed0,
                    controls: ctx.rock_controls,
                    segmentation_multiplier: ctx.segmentation_multiplier,
                    moisture_frequency: ctx.moisture_frequency,
                    moisture_bias: ctx.moisture_bias,
                    aux_frequency: ctx.aux_frequency,
                    aux_bias: ctx.aux_bias,
                    starting_area_moisture_size: ctx.starting_area_moisture_size,
                    starting_area_moisture_frequency: ctx.starting_area_moisture_frequency,
                    starting_positions: ctx.starting_positions.clone(),
                },
            },
            cliff_rock: OnceCell::new(),
        }
    }

    fn cliff_rock(&self) -> &NauvisCliffRockFields {
        self.cliff_rock.get_or_init(|| NauvisCliffRockFields {
            cliffs: NauvisCliffFields::new(&self.cliff_rock_ctx.cliff),
            rocks: NauvisRockFields::new(&self.cliff_rock_ctx.rock),
        })
    }

    fn resources(&self) -> &NauvisResourceFields {
        self.resources.get_or_init(|| {
            let oil = resource_by_name("crude-oil").expect("crude oil is in the catalog");
            NauvisResourceFields {
                resolver: ResourceResolver::new(&self.resource_ctx),
                oil: ResourcePatches::new(
                    oil,
                    &ResourcePatchesCtx {
                        seed0: self.resource_ctx.seed0,
                        controls: self
                            .resource_ctx
                            .controls
                            .get(oil.control_name)
                            .copied()
                            .unwrap_or_else(ResourceControlLevers::defaults),
                        starting_positions: self.resource_ctx.starting_positions.clone(),
                        segmentation_multiplier: self.resource_ctx.segmentation_multiplier,
                        water_level: self.resource_ctx.water_level,
                        starting_lake_positions: None,
                        regular_skip_span: 6,
                        regular_skip_offset: oil.patch_set_index,
                        starting_skip_span: 4,
                        starting_skip_offset: oil.patch_set_index,
                    },
                ),
            }
        })
    }

    /// Attach a tree layer, so the tree block can be selected.
    ///
    /// A builder rather than a constructor parameter because the caller has to
    /// own the `TreeBase` the `TreeFields` borrows, and only wants to build
    /// either when a tree field is actually being asked for.
    #[must_use]
    pub fn with_trees(mut self, trees: &'b TreeFields<'b>) -> Self {
        self.trees = Some(trees);
        self
    }

    /// One resource's compiled field, by catalog index.
    ///
    /// `None` when the resolver dropped it, which happens only at
    /// `size <= 0` - see [`NauvisCtx::resource_controls`], which says why a
    /// parity sweep must not do that.
    fn resource_patches(&self, index: usize) -> Option<&ResourcePatches> {
        let params = NAUVIS_RESOURCE_CATALOG.get(index)?;
        let held = self.resources();
        if params.name == "crude-oil" {
            return Some(&held.oil);
        }
        held.resolver.patches(params.control_name)
    }

    /// One named field at `(x, y)`.
    ///
    /// The 21 probabilities are folded individually rather than only the
    /// winner, because **an argmax absorbs almost anything** - and that is
    /// measured twice over, not assumed:
    ///
    /// - Numeric poison applied to every field beneath the catalog leaves all
    ///   153 captured tiles resolving correctly (see `fixtures.rs`).
    /// - Planting a one-digit slip in `grass-3`'s climate box - `aux_to` 0.65
    ///   to 0.66 - moves **`tile:grass-3` and nothing else** across a 484-point
    ///   window. `resolvedTileIndex` does not budge.
    ///
    /// So a mis-transcribed climate box really does show here and nowhere else.
    /// Folding only the winner would have graded 21 formulas with one number
    /// that cannot see any of them.
    ///
    /// The argmax itself crosses as its INDEX widened to `f64`, which is exact
    /// for 0..21 and keeps the whole selector one `f64`-valued function.
    #[must_use]
    pub fn field(&self, field: u32, x: f64, y: f64) -> f64 {
        if field < NauvisStack::FIELD_COUNT {
            return self.stack.field(field, x, y);
        }
        let f = NauvisTileFields {
            x,
            y,
            elevation: self.stack.elevation_nauvis.eval(x, y),
            aux: self.stack.aux.eval(x, y),
            moisture: self.stack.moisture.eval(x, y),
        };
        if field >= Self::CLIFF_ROCK_BASE {
            return self.cliff_rock_field(field - Self::CLIFF_ROCK_BASE, x, y);
        }
        if field >= Self::TREE_BASE {
            return self.tree_field(field - Self::TREE_BASE, x, y);
        }
        if field >= Self::RESOURCE_BASE {
            return self.resource_field(field - Self::RESOURCE_BASE, x, y);
        }
        let i = (field - NauvisStack::FIELD_COUNT) as usize;
        let probabilities = self.tiles.probabilities(&f);
        if i < probabilities.len() {
            return probabilities[i];
        }
        // The last index before the resource block is the argmax.
        let winner = self.tiles.resolve(&f);
        TILE_ORDER
            .iter()
            .position(|t| *t == winner)
            .expect("resolve returns a tile from TILE_ORDER") as f64
    }

    /// One field of the resource block, `0..19`.
    ///
    /// All three wrappers are folded for all six resources rather than only the
    /// resolver's winner, for the reason the tile layer measured: **an argmax
    /// absorbs almost anything**. The winner is one integer per position and it
    /// moves only when a probability crosses 0.5, so folding it alone would
    /// grade eighteen formulas with a number that cannot see any of them - and
    /// `richness` in particular never reaches the winner at all.
    ///
    /// Out-of-range resolves to the winner, matching the exhaustive `match`
    /// this was lifted from.
    fn resource_field(&self, index: u32, x: f64, y: f64) -> f64 {
        let i = index as usize;
        if i < 18 {
            let Some(patches) = self.resource_patches(i % 6) else {
                return 0.0;
            };
            return match i / 6 {
                0 => patches.field(x, y),
                1 => patches.probability(x, y),
                _ => patches.richness(x, y),
            };
        }
        // The resolver's winner as its CATALOG index, widened - exact for
        // 0..6, where 6 means no resource is drawn here. Catalog index rather
        // than position in the resolver's own list, so that a resource being
        // dropped by a `size` lever cannot silently renumber the others.
        match self.resources().resolver.resolve(x, y) {
            Some(params) => params.patch_set_index as f64,
            None => NAUVIS_RESOURCE_CATALOG.len() as f64,
        }
    }

    /// One field of the tree block, `0..19`.
    ///
    /// All 15 species are folded individually rather than only the density over
    /// them, for the reason the tile layer measured: a `max` absorbs almost
    /// anything. The density is one number per pixel and it moves only when the
    /// WINNING species changes value, so folding it alone would grade fifteen
    /// climate boxes with a number that cannot see fourteen of them.
    ///
    /// Both forest-path cutouts are folded, not just the faded one the species
    /// read, because the density path reaches the RAW cutout directly - it
    /// inlines `cutout * 0.3 + small_term` to avoid a second `tree_small_noise`
    /// call. A fold of the faded one alone would not cover that call site.
    ///
    /// Returns 0 when no tree layer was attached. `checksum_nauvis` always
    /// attaches one before selecting from this range, and
    /// `the_tree_block_is_zero_without_a_tree_layer` pins the fallback so it
    /// cannot be mistaken for a value.
    fn tree_field(&self, index: u32, x: f64, y: f64) -> f64 {
        let Some(trees) = self.trees else {
            return 0.0;
        };
        match index {
            0 => trees.shared().small_noise(x, y),
            1 => trees.shared().forest_path_cutout(x, y),
            2 => trees.shared().forest_path_cutout_faded(x, y),
            i if (i as usize) < 3 + TREE_SPECIES.len() => trees.eval_at(i as usize - 3, x, y),
            // Out of range resolves to the density, matching the exhaustive
            // `match` this was lifted from.
            _ => trees.density(x, y),
        }
    }

    /// One field of the cliff and rock block, `0..6`.
    ///
    /// The three rock probabilities are folded separately from the density
    /// above them, for the reason the tile and resource blocks both measured:
    /// **a max absorbs almost anything.** Here it is worse than an argmax,
    /// because the density also CLAMPS to `[0, 1]` and Nauvis rocks are sparse:
    /// it is exactly 0 at 96 to 98 percent of a 64x64 window, so a fold of it
    /// alone is mostly a fold of zeros. `huge` and `big` in particular differ
    /// only by a constant factor and a constant offset, so the max picks the
    /// same one of them almost everywhere.
    ///
    /// **`cliffiness` crosses as its 0/10 GATE and nothing finer**, which is a
    /// real limit rather than an oversight. The TypeScript exposes only the
    /// gate - `makeCliffiness` returns it - so recovering `main_cliffiness` on
    /// the JavaScript side would mean rebuilding the six sub-terms there from
    /// the same parts this reads. That is the private-copy trap
    /// `checksum_vulcanus` records: a copy is reproduced identically on both
    /// sides and stays invisible. So the fold compares gate answers, and a
    /// divergence smaller than the nearest margin to the cutoff is invisible to
    /// tier 2 as well as to tier 1. `cliff_elevation` is continuous and shares
    /// four of the six sub-terms' `NauvisShared`, which is what grades that
    /// region at all.
    fn cliff_rock_field(&self, index: u32, x: f64, y: f64) -> f64 {
        let held = self.cliff_rock();
        match index {
            0 => held.cliffs.cliff_elevation(x, y),
            1 => held.cliffs.cliffiness(x, y),
            2 => held.rocks.at(x, y).huge,
            3 => held.rocks.at(x, y).big,
            4 => held.rocks.at(x, y).sand,
            // Out of range resolves to the density, matching the other blocks.
            _ => held.rocks.density(x, y),
        }
    }
}

#[cfg(test)]
mod parity_tests {
    use super::*;

    fn parity_ctx() -> NauvisCtx {
        NauvisCtx::defaults(123_456)
    }

    #[test]
    fn every_resource_field_index_reaches_a_distinct_value() {
        // The same guard the expression block carries: a `match` arm pointing
        // at the wrong accessor produces a valid checksum for the WRONG field,
        // so tier 2 would compare two fields nobody named. Two indices agreeing
        // over a whole sweep is the fingerprint.
        //
        // A 2D GRID, not a line, and that is not caution. `probability` is 0
        // wherever there is no ore, so a diagonal that misses every patch makes
        // all six probability fields the identical all-zero vector and the test
        // reports six collisions that are not collisions. The first sweep tried
        // here did exactly that.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let sweep: Vec<Vec<f64>> = (NauvisParity::RESOURCE_BASE..NauvisParity::TREE_BASE)
            .map(|f| {
                let mut row = Vec::with_capacity(36 * 36);
                for i in 0..36 {
                    for j in 0..36 {
                        row.push(parity.field(
                            f,
                            f64::from(i) * 34.3 + 1600.0,
                            f64::from(j) * 33.1 + 1600.0,
                        ));
                    }
                }
                row
            })
            .collect();
        // Two anti-vacuity conditions, and the grid was moved to satisfy the
        // second after it failed:
        //
        // 1. Some probability must reach 1, or the grid found no ore and the
        //    six probability fields are the identical all-zero vector.
        // 2. The grid must sit OUTSIDE 1600 tiles. `richness_distance_factor`
        //    is `max(expr, 1)` and the expression is below 1 for every distance
        //    under 1600, so nearer in, `richness` is bit-identical to `field`
        //    at the default richness lever - six more false collisions.
        let probabilities_seen = sweep[6..12].iter().flatten().any(|v| *v == 1.0);
        assert!(probabilities_seen, "the grid contains no ore at all");
        assert!(
            crate::resources::regular_patches::richness_distance_factor(1600.0_f64.hypot(1600.0))
                > 1.0,
            "the grid is inside the flat part of the richness distance factor"
        );
        for a in 0..sweep.len() {
            for b in (a + 1)..sweep.len() {
                assert_ne!(
                    sweep[a],
                    sweep[b],
                    "resource fields {} and {} are the same sweep",
                    NauvisParity::RESOURCE_BASE + a as u32,
                    NauvisParity::RESOURCE_BASE + b as u32
                );
            }
        }
    }

    #[test]
    fn the_resource_block_starts_where_the_tile_block_ends_and_the_count_bounds_it() {
        // `FIELD_COUNT` bounds a selector whose last arm is a catch-all, so an
        // index added without moving the count would silently never be swept.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let (x, y) = (611.5, -377.25);

        assert_eq!(NauvisParity::RESOURCE_BASE, NauvisStack::FIELD_COUNT + 22);
        assert_eq!(NauvisParity::TREE_BASE, NauvisParity::RESOURCE_BASE + 19);

        // The index just below the block is still the tile argmax, and the
        // first index of the block is a resource field rather than that argmax.
        let argmax = parity.field(NauvisParity::RESOURCE_BASE - 1, x, y);
        assert!((0.0..21.0).contains(&argmax), "tile argmax {argmax}");
        // The last index of the block is the resolver's winner, which is also
        // the block's own catch-all - but the index PAST it is now the tree
        // block, not the fallback, so the two are asserted separately.
        assert_eq!(
            parity.field(NauvisParity::TREE_BASE - 1, x, y),
            parity.field(NauvisParity::TREE_BASE - 1, x, y)
        );
        assert!(
            parity.field(NauvisParity::TREE_BASE - 1, x, y) <= 6.0,
            "the last resource index is the resolver winner"
        );
    }

    #[test]
    fn the_three_wrappers_land_on_the_indices_the_selector_claims() {
        // 0..5 field, 6..11 probability, 12..17 richness, in catalog order.
        // An off-by-six here would fold `copper`'s probability under
        // `iron`'s name on both sides and stay invisible.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let (x, y) = (740.5, -260.25);
        for (i, params) in NAUVIS_RESOURCE_CATALOG.iter().enumerate() {
            let patches = parity
                .resource_patches(i)
                .unwrap_or_else(|| panic!("{} is held at default levers", params.name));
            let base = NauvisParity::RESOURCE_BASE + i as u32;
            assert_eq!(
                parity.field(base, x, y),
                patches.field(x, y),
                "{}",
                params.name
            );
            assert_eq!(
                parity.field(base + 6, x, y),
                patches.probability(x, y),
                "{} probability",
                params.name
            );
            assert_eq!(
                parity.field(base + 12, x, y),
                patches.richness(x, y),
                "{} richness",
                params.name
            );
        }
    }

    #[test]
    fn the_resolver_field_is_a_catalog_index_and_reaches_more_than_one_value() {
        // Folded as the CATALOG index rather than the resolver's own list
        // position, so a resource dropped by a `size` lever cannot renumber the
        // others. 6 means nothing is drawn.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let last = NauvisParity::TREE_BASE - 1;
        let mut seen = std::collections::BTreeSet::new();
        for i in 0..300 {
            let v = parity.field(
                last,
                f64::from(i) * 11.5 - 700.0,
                f64::from(i) * 5.25 - 300.0,
            );
            assert!((0.0..=6.0).contains(&v), "winner index {v}");
            assert_eq!(v, v.trunc(), "winner index is not integral: {v}");
            seen.insert(v as i64);
        }
        assert!(seen.contains(&6), "no empty tile in the sweep");
        assert!(
            seen.len() > 1,
            "the resolver returned one answer everywhere: {seen:?}"
        );
        // And oil is never the winner - the resolver does not hold it.
        assert!(!seen.contains(&4), "crude oil was resolved: {seen:?}");
    }

    #[test]
    fn crude_oil_is_absent_from_the_resolver_and_still_has_its_own_folded_field() {
        // The one resource whose field tier 2 grades but whose winner it never
        // sees. If oil were dropped from the block entirely, the roll pass the
        // renderer will need would go into #227 ungraded.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let oil_index = 4;
        assert_eq!(NAUVIS_RESOURCE_CATALOG[oil_index].name, "crude-oil");
        assert!(parity.resource_patches(oil_index).is_some());
        assert!(
            parity.resources().resolver.patches("crude-oil").is_none(),
            "the resolver must not hold oil"
        );
        // Its field is live rather than a stub.
        let nonzero = (0..80).any(|i| {
            parity.field(
                NauvisParity::RESOURCE_BASE + oil_index as u32,
                f64::from(i) * 37.5 + 400.0,
                155.25,
            ) != 0.0
        });
        assert!(nonzero, "oil's folded field is all zeros");
    }

    #[test]
    fn the_resource_levers_reach_the_resource_fields() {
        // Every tier-1 case runs the resources at 1/1/1, so a lever dropped
        // between `NauvisCtx` and the resolver would be invisible to the
        // fixtures. Each is moved on its own.
        let base = NauvisCtx::defaults(123_456);
        let base_stack = NauvisStack::new(&base);
        let base_parity = NauvisParity::new(&base_stack, &base);
        let (x, y) = (820.5, -410.25);
        let iron_field = NauvisParity::RESOURCE_BASE;
        let iron_richness = iron_field + 12;

        let moved = |f: &dyn Fn(&mut ResourceControlLevers)| -> f64 {
            let mut ctx = NauvisCtx::defaults(123_456);
            f(&mut ctx.resource_controls);
            let stack = NauvisStack::new(&ctx);
            NauvisParity::new(&stack, &ctx).field(iron_field, x, y)
        };
        assert_ne!(
            moved(&|c| c.frequency = 2.0),
            base_parity.field(iron_field, x, y),
            "resource frequency"
        );
        assert_ne!(
            moved(&|c| c.size = 2.0),
            base_parity.field(iron_field, x, y),
            "resource size"
        );
        // Richness reaches only the wrapper, never the field - which is why it
        // needs its own assertion on both sides of that boundary.
        assert_eq!(
            moved(&|c| c.richness = 3.0),
            base_parity.field(iron_field, x, y),
            "richness must not move the raw field"
        );
        let mut rich = NauvisCtx::defaults(123_456);
        rich.resource_controls.richness = 3.0;
        let rich_stack = NauvisStack::new(&rich);
        assert_ne!(
            NauvisParity::new(&rich_stack, &rich).field(iron_richness, x, y),
            base_parity.field(iron_richness, x, y),
            "resource richness"
        );
    }

    fn tree_fixture(ctx: &NauvisCtx) -> crate::trees::field::TreeBase {
        use crate::trees::field::{TreeBase, TreeFieldParams};
        let mut p = TreeFieldParams::defaults(ctx.seed0);
        p.trees_frequency = ctx.trees_frequency;
        p.trees_size = ctx.trees_size;
        p.segmentation_multiplier = ctx.segmentation_multiplier;
        TreeBase::new(&p)
    }

    #[test]
    fn every_tree_field_index_reaches_a_distinct_value() {
        // Same guard as the expression and resource blocks: a `match` arm
        // pointing at the wrong accessor produces a valid checksum for the
        // WRONG field. Two indices agreeing over a whole sweep is how that
        // shows.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let base = tree_fixture(&ctx);
        let trees = TreeFields::new(&base);
        let parity = NauvisParity::new(&stack, &ctx).with_trees(&trees);
        let sweep: Vec<Vec<f64>> = (NauvisParity::TREE_BASE..NauvisParity::CLIFF_ROCK_BASE)
            .map(|f| {
                let mut row = Vec::with_capacity(30 * 30);
                for i in 0..30 {
                    for j in 0..30 {
                        row.push(parity.field(
                            f,
                            f64::from(i) * 27.3 - 400.0,
                            f64::from(j) * 24.7 - 400.0,
                        ));
                    }
                }
                row
            })
            .collect();
        for a in 0..sweep.len() {
            for b in (a + 1)..sweep.len() {
                assert_ne!(
                    sweep[a],
                    sweep[b],
                    "tree fields {} and {} are the same sweep",
                    NauvisParity::TREE_BASE + a as u32,
                    NauvisParity::TREE_BASE + b as u32
                );
            }
        }
        // Anti-vacuity: the density must be non-zero somewhere, or the grid
        // found no forest and the last field is all zeros.
        assert!(
            sweep[sweep.len() - 1].iter().any(|v| *v > 0.0),
            "the grid contains no trees at all"
        );
    }

    #[test]
    fn the_tree_block_starts_where_the_resource_block_ends_and_the_count_bounds_it() {
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let base = tree_fixture(&ctx);
        let trees = TreeFields::new(&base);
        let parity = NauvisParity::new(&stack, &ctx).with_trees(&trees);
        let (x, y) = (140.5, -95.25);

        assert_eq!(NauvisParity::TREE_BASE, NauvisParity::RESOURCE_BASE + 19);
        assert_eq!(NauvisParity::CLIFF_ROCK_BASE, NauvisParity::TREE_BASE + 19);

        // The three shared fields land where the selector claims.
        assert_eq!(
            parity.field(NauvisParity::TREE_BASE, x, y),
            trees.shared().small_noise(x, y)
        );
        assert_eq!(
            parity.field(NauvisParity::TREE_BASE + 1, x, y),
            trees.shared().forest_path_cutout(x, y)
        );
        assert_eq!(
            parity.field(NauvisParity::TREE_BASE + 2, x, y),
            trees.shared().forest_path_cutout_faded(x, y)
        );
        // Then the 15 species, in catalog order.
        for (k, species) in TREE_SPECIES.iter().enumerate() {
            assert_eq!(
                parity.field(NauvisParity::TREE_BASE + 3 + k as u32, x, y),
                trees.eval_at(k, x, y),
                "{}",
                species.name
            );
        }
        // The last index in the block is the density, its own catch-all. It
        // is bounded by `CLIFF_ROCK_BASE` rather than by `FIELD_COUNT` now that
        // a block follows this one - past `CLIFF_ROCK_BASE` the selector
        // dispatches to the cliff and rock fields, so the old "past the end is
        // the density" assertion would have started grading the wrong block.
        assert_eq!(
            parity.field(NauvisParity::CLIFF_ROCK_BASE - 1, x, y),
            trees.density(x, y)
        );
        assert_ne!(
            parity.field(NauvisParity::CLIFF_ROCK_BASE, x, y),
            trees.density(x, y),
            "the cliff block must start where the tree block ends"
        );
    }

    #[test]
    fn the_tree_block_is_zero_without_a_tree_layer() {
        // The fallback exists so the selector can stay one type whether or not
        // the caller built the tree layer. It must be an obvious sentinel
        // rather than a plausible number - `checksum_nauvis` always attaches
        // one before selecting from this range.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        for f in NauvisParity::TREE_BASE..NauvisParity::CLIFF_ROCK_BASE {
            assert_eq!(parity.field(f, 140.5, -95.25), 0.0, "field {f}");
        }
        // And the blocks below it are unaffected by the missing layer.
        assert_ne!(parity.field(0, 140.5, -95.25), 0.0);
    }

    #[test]
    fn the_tree_levers_reach_the_tree_block() {
        // Both are dead at the default, so tier 1's default-control fixture
        // cannot see either. The controls fixture covers them against the game;
        // this covers them against the wiring.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let base = tree_fixture(&ctx);
        let trees = TreeFields::new(&base);
        let parity = NauvisParity::new(&stack, &ctx).with_trees(&trees);

        let moved = |f: &dyn Fn(&mut NauvisCtx)| -> bool {
            let mut c = NauvisCtx::defaults(123_456);
            f(&mut c);
            let s = NauvisStack::new(&c);
            let b = tree_fixture(&c);
            let t = TreeFields::new(&b);
            let p = NauvisParity::new(&s, &c).with_trees(&t);
            (0..60).any(|i| {
                let x = f64::from(i) * 17.3 - 400.0;
                let y = f64::from(i) * -11.7 + 200.0;
                (NauvisParity::TREE_BASE..NauvisParity::CLIFF_ROCK_BASE)
                    .any(|f| p.field(f, x, y) != parity.field(f, x, y))
            })
        };
        assert!(moved(&|c| c.trees_frequency = 3.0), "trees frequency");
        assert!(moved(&|c| c.trees_size = 2.0), "trees size");
        assert!(
            !moved(&|_c| {}),
            "the sweep reports a difference with no change"
        );
    }

    #[test]
    fn every_cliff_and_rock_field_index_reaches_a_distinct_value() {
        // Same guard as the three blocks before it: a `match` arm pointing at
        // the wrong accessor produces a valid checksum for the WRONG field, so
        // tier 2 would compare two fields nobody named.
        //
        // A 2D grid rather than a line, for the reason the resource block
        // records: `density` clamps to 0 wherever no rock wins, and Nauvis
        // rocks are sparse, so a diagonal that misses every patch would make
        // the density an all-zero vector and report a collision that is not
        // one.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let sweep: Vec<Vec<f64>> = (NauvisParity::CLIFF_ROCK_BASE..NauvisParity::FIELD_COUNT)
            .map(|f| {
                let mut row = Vec::with_capacity(40 * 40);
                for i in 0..40 {
                    for j in 0..40 {
                        row.push(parity.field(
                            f,
                            f64::from(i) * 13.3 - 200.0,
                            f64::from(j) * 11.7 - 200.0,
                        ));
                    }
                }
                row
            })
            .collect();
        assert_eq!(sweep.len(), 6, "the block is six fields wide");
        for a in 0..sweep.len() {
            for b in (a + 1)..sweep.len() {
                assert_ne!(
                    sweep[a],
                    sweep[b],
                    "cliff/rock fields {} and {} are the same sweep",
                    NauvisParity::CLIFF_ROCK_BASE + a as u32,
                    NauvisParity::CLIFF_ROCK_BASE + b as u32
                );
            }
        }

        // Anti-vacuity, one per field that can degenerate:
        //
        // - the gate must answer BOTH ways somewhere, or a constant-0 port
        //   would fold identically;
        // - the clamped density must be non-zero somewhere, or the grid found
        //   no rocks and the last field is all zeros - which is bit-identical
        //   between any two ports and compares nothing.
        let gate = &sweep[1];
        assert!(gate.contains(&10.0), "no position is cliffy");
        assert!(gate.contains(&0.0), "every position is cliffy");
        assert!(
            sweep[5].iter().any(|v| *v > 0.0),
            "the grid contains no rocks at all"
        );
    }

    #[test]
    fn the_cliff_and_rock_block_starts_where_the_tree_block_ends_and_the_count_bounds_it() {
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let (x, y) = (140.5, -95.25);

        assert_eq!(NauvisParity::FIELD_COUNT, NauvisParity::CLIFF_ROCK_BASE + 6);

        let cliffs = NauvisCliffFields::new(&CliffFieldParams::defaults(ctx.seed0));
        let rocks = NauvisRockFields::new(&RockFieldParams::defaults(ctx.seed0));
        let base = NauvisParity::CLIFF_ROCK_BASE;
        assert_eq!(parity.field(base, x, y), cliffs.cliff_elevation(x, y));
        assert_eq!(parity.field(base + 1, x, y), cliffs.cliffiness(x, y));
        assert_eq!(parity.field(base + 2, x, y), rocks.at(x, y).huge);
        assert_eq!(parity.field(base + 3, x, y), rocks.at(x, y).big);
        assert_eq!(parity.field(base + 4, x, y), rocks.at(x, y).sand);
        assert_eq!(parity.field(base + 5, x, y), rocks.density(x, y));
        // Past the end is the density, the block's own catch-all.
        assert_eq!(
            parity.field(NauvisParity::FIELD_COUNT, x, y),
            rocks.density(x, y)
        );
    }

    #[test]
    fn the_cliff_and_rock_layer_is_built_only_when_one_of_its_fields_is_asked_for() {
        // Lazy for the same measured reason as the resource block: building it
        // constructs an `ElevationNauvis` for `elevation_nauvis_no_cliff`, plus
        // a `Moisture` and an `Aux` that each carry their own `NauvisShared`.
        // `checksum_nauvis` is one call per field, so an eager build would
        // charge all 76 earlier fields for a layer none of them reads.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let _ = parity.field(0, 100.5, 100.25);
        let _ = parity.field(NauvisParity::CLIFF_ROCK_BASE - 1, 100.5, 100.25);
        assert!(parity.cliff_rock.get().is_none(), "built too early");
        let _ = parity.field(NauvisParity::CLIFF_ROCK_BASE, 100.5, 100.25);
        assert!(parity.cliff_rock.get().is_some(), "never built");
    }

    #[test]
    fn the_cliff_and_rock_levers_reach_their_block() {
        // Every one of these is dead or nearly dead at the default, so tier 1's
        // default-control fixtures cannot see any of them. `cliff_elevation_0`
        // is deliberately absent: neither field reads it, and this asserts that
        // rather than leaving it to be assumed.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);

        let moved = |f: &dyn Fn(&mut NauvisCtx)| -> bool {
            let mut c = NauvisCtx::defaults(123_456);
            f(&mut c);
            let st = NauvisStack::new(&c);
            let p = NauvisParity::new(&st, &c);
            // A 2D GRID, not a diagonal, and that is not caution. The only
            // observable this block gives `low_freq_cliffiness` is the 0/10
            // GATE, and a gate flips only where its term wins the outer `min`
            // AND lands the other side of the cutoff. A 60-point line found no
            // such position for the frequency lever and reported "this lever
            // reaches nothing", which was a statement about the line.
            (0..40).any(|i| {
                (0..40).any(|j| {
                    let x = f64::from(i) * 13.3 - 200.0;
                    let y = f64::from(j) * 11.7 - 200.0;
                    (NauvisParity::CLIFF_ROCK_BASE..NauvisParity::FIELD_COUNT)
                        .any(|f| p.field(f, x, y) != parity.field(f, x, y))
                })
            })
        };
        // **Cliff frequency reaches this block ONLY at the slider's extreme
        // minimum, and that is measured rather than reasoned.** Swept over
        // 1600 positions x 6 fields at frequencies 1.0, 0.8, 0.6, 0.5, 0.45,
        // 0.42, 0.4, 0.35, 0.3, 0.25 and 1/6, the count of moved field values
        // is **0 at every one of them except 1/6, where it is 21 of 9600**. The
        // elevation interval behaves identically, because it reaches the same
        // place as `40 / interval`: 0 at 60, 80, 100 and 120, and 21 at 240.
        //
        // The mechanism is a `min` inside a `min`. Cliff frequency's only path
        // is `low_freq_lever = min(slider_to_linear(cliff_frequency, -1.7, 1.7),
        // slider_to_linear(cliff_richness, -1, 1))`, whose second argument is
        // exactly 0 at the default richness - so any frequency at or above 1
        // loses that `min` outright. Below 1 the lever does move, but the only
        // thing this block can observe is the 0/10 GATE, and the term it feeds
        // is `4 * (1.5 + basis + lever)` with `basis` bounded by an
        // `output_scale` of 0.51. That sits far above the 0.707 cutoff until
        // the lever drags it down, and it takes the whole slider range to do
        // it. A first pass here estimated the crossing at about 0.42 from those
        // bounds and was wrong by more than a factor of two, which is why the
        // sweep above exists.
        //
        // A sweep that wants to grade this lever therefore has to set it to
        // 1/6. Anything milder grades nothing and looks like it grades
        // something.
        assert!(
            moved(&|c| c.cliff_controls.frequency = 1.0 / 6.0),
            "cliff frequency at the slider minimum"
        );
        assert!(
            !moved(&|c| c.cliff_controls.frequency = 0.25),
            "0.25 must stay masked - if this fails the lever found a second \
             path and the sweep numbers above are stale"
        );
        assert!(
            !moved(&|c| c.cliff_controls.frequency = 3.0),
            "a frequency above 1 must stay masked by the min"
        );
        assert!(
            moved(&|c| c.cliff_controls.continuity = 2.0),
            "cliff continuity"
        );
        assert!(
            moved(&|c| c.cliff_settings.cliff_elevation_interval = 240.0),
            "cliff elevation interval at 40/240 = the slider minimum"
        );
        assert!(
            !moved(&|c| c.cliff_settings.cliff_elevation_interval = 120.0),
            "120 gives frequency 1/3, which the min still masks"
        );
        assert!(
            moved(&|c| c.cliff_settings.richness = 2.0),
            "cliff richness"
        );
        assert!(
            moved(&|c| c.rock_controls.frequency = 2.0),
            "rocks frequency"
        );
        assert!(moved(&|c| c.rock_controls.size = 2.0), "rocks size");

        // `cliff_elevation_0` reaches nothing in this block, which is why the
        // ABI does not carry it. Asserted so that if a later field starts
        // reading it, this line fails instead of the lever silently going
        // ungraded.
        assert!(
            !moved(&|c| c.cliff_settings.cliff_elevation_0 = 25.0),
            "cliff_elevation_0 reached the block - the ABI must now carry it"
        );
        assert!(
            !moved(&|_c| {}),
            "the sweep reports a difference with no change"
        );
    }

    #[test]
    fn the_resource_layer_is_built_only_when_a_resource_field_is_asked_for() {
        // Lazy for a measured reason: building it constructs four
        // `ElevationNauvis` trees. If it became eager, all 38 expression and
        // tile fields would pay for a layer none of them reads, and
        // `checksum_nauvis` is one call per field.
        let ctx = parity_ctx();
        let stack = NauvisStack::new(&ctx);
        let parity = NauvisParity::new(&stack, &ctx);
        let _ = parity.field(0, 100.5, 100.25);
        let _ = parity.field(NauvisParity::RESOURCE_BASE - 1, 100.5, 100.25);
        assert!(parity.resources.get().is_none(), "built too early");
        let _ = parity.field(NauvisParity::RESOURCE_BASE, 100.5, 100.25);
        assert!(parity.resources.get().is_some(), "never built");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_field_index_reaches_a_distinct_expression() {
        // A `match` arm pointing at the wrong accessor is a one-token slip that
        // produces a valid checksum for the WRONG field, so tier 2 would then
        // compare two fields nobody named. Two indices returning the identical
        // value over a whole sweep is the fingerprint of that.
        let stack = NauvisStack::new(&NauvisCtx::defaults(123_456));
        let sweep: Vec<Vec<f64>> = (0..NauvisStack::FIELD_COUNT)
            .map(|f| {
                (0..24)
                    .map(|i| stack.field(f, f64::from(i) * 61.5 - 400.0, f64::from(i) * -37.25))
                    .collect()
            })
            .collect();
        for a in 0..sweep.len() {
            for b in (a + 1)..sweep.len() {
                assert_ne!(sweep[a], sweep[b], "fields {a} and {b} are the same sweep");
            }
        }
    }

    #[test]
    fn the_field_count_matches_the_arms_that_are_not_the_fallback() {
        // `FIELD_COUNT` bounds a `match` whose last arm is a catch-all, so an
        // index added to the `match` without moving the count would silently
        // never be swept. Asserted by checking the first out-of-range index
        // returns the fallback and the last in-range one does too - i.e. the
        // catch-all starts exactly where the count says.
        let stack = NauvisStack::new(&NauvisCtx::defaults(123_456));
        let (x, y) = (137.5, -211.25);
        let last = NauvisStack::FIELD_COUNT - 1;
        assert_eq!(stack.field(last, x, y), stack.temperature.eval(x, y));
        assert_eq!(
            stack.field(NauvisStack::FIELD_COUNT, x, y),
            stack.temperature.eval(x, y)
        );
        assert_ne!(stack.field(last - 1, x, y), stack.temperature.eval(x, y));
    }

    #[test]
    fn the_controls_reach_the_expressions_they_name() {
        // A stack that dropped a control on the floor would still build, and
        // every tier-1 test runs at the defaults where most of them are 1 or 0
        // - so nothing else in the gate would notice. Each control is moved on
        // its own and must change the field it belongs to.
        let base = NauvisStack::new(&NauvisCtx::defaults(123_456));
        let (x, y) = (311.5, -177.25);

        let moved = |f: &dyn Fn(&mut NauvisCtx)| -> NauvisStack {
            let mut ctx = NauvisCtx::defaults(123_456);
            f(&mut ctx);
            NauvisStack::new(&ctx)
        };

        assert_ne!(
            moved(&|c| c.aux_frequency = 2.0).aux.eval(x, y),
            base.aux.eval(x, y),
            "aux frequency"
        );
        assert_ne!(
            moved(&|c| c.aux_bias = 0.2).aux.eval(x, y),
            base.aux.eval(x, y),
            "aux bias"
        );
        assert_ne!(
            moved(&|c| c.moisture_frequency = 2.0).moisture.eval(x, y),
            base.moisture.eval(x, y),
            "moisture frequency"
        );
        assert_ne!(
            moved(&|c| c.moisture_bias = 0.2).moisture.eval(x, y),
            base.moisture.eval(x, y),
            "moisture bias"
        );
        assert_ne!(
            moved(&|c| c.temperature_frequency = 2.0)
                .temperature
                .eval(x, y),
            base.temperature.eval(x, y),
            "temperature frequency"
        );
        assert_ne!(
            moved(&|c| c.temperature_bias = 3.0).temperature.eval(x, y),
            base.temperature.eval(x, y),
            "temperature bias"
        );
        // Far field, and that is not an arbitrary choice: within about 500
        // tiles of spawn `starting_island` wins the outer `max` and the water
        // level is masked entirely. Checked at (311.5, -177.25) first, where
        // the two are bit-identical - which is the expression working, not a
        // dropped control.
        assert_eq!(
            moved(&|c| c.water_level = 5.0).elevation_nauvis.eval(x, y),
            base.elevation_nauvis.eval(x, y),
            "water level is masked inside the starting island"
        );
        assert_ne!(
            moved(&|c| c.water_level = 5.0)
                .elevation_nauvis
                .eval(5000.5, -5000.25),
            base.elevation_nauvis.eval(5000.5, -5000.25),
            "water level"
        );
        assert_ne!(
            moved(&|c| c.segmentation_multiplier = 2.0)
                .shared
                .plateaus(x, y),
            base.shared.plateaus(x, y),
            "segmentation"
        );
        // The two starting-area moisture levers only bite near spawn, and the
        // size one only when it is off its degenerate default. The FREQUENCY
        // one needs a distance in its transition band as well: the region is
        // `clamp(2 - (freq/400) * d, 0, 1)`, which saturates at 1 for
        // `d <= 400/freq`, so at d = 100 both 1 and 4 clamp to 1 and the lever
        // looks dead. 150 is inside 4's ramp and still inside 1's plateau.
        assert_ne!(
            moved(&|c| c.starting_area_moisture_size = 4.0)
                .moisture
                .eval(0.0, 0.0),
            base.moisture.eval(0.0, 0.0),
            "starting area moisture size"
        );
        assert_ne!(
            moved(&|c| {
                c.starting_area_moisture_size = 4.0;
                c.starting_area_moisture_frequency = 4.0;
            })
            .moisture
            .eval(150.0, 0.0),
            moved(&|c| c.starting_area_moisture_size = 4.0)
                .moisture
                .eval(150.0, 0.0),
            "starting area moisture frequency"
        );
        assert_ne!(
            moved(&|c| c.starting_positions = vec![Point {
                x: 512.0,
                y: -512.0
            }])
            .elevation_nauvis
            .eval(x, y),
            base.elevation_nauvis.eval(x, y),
            "starting positions"
        );
    }
}
