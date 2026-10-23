//! Vulcanus's resource region fields, ported from
//! `src/noise/expressions/vulcanusResources.ts`.
//!
//! Transcribed from `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`
//! lines ~560-862. Two consumers read this layer, which is why it lives in
//! `expressions/` rather than beside a renderer: the tile argmax reads
//! `vulcanus_metal_tile`, `vulcanus_calcite_region` and
//! `vulcanus_sulfuric_acid_region_patchy` inside four `*_range` expressions, and
//! the resource overlay reads the four regions directly.
//!
//! ## Two approximations carried over verbatim from the TypeScript
//!
//! 1. `random_penalty_between(0.9, 1, 1)` is taken as `1` HERE. It appears in
//!    every `*_probability` expression, and at `rp = 1` the probability
//!    collapses to `1000 * region`, which is what this layer hands up. The roll
//!    itself is applied above it, by
//!    [`VulcanusOreRoll`](crate::resources::vulcanus_ore_roll::VulcanusOreRoll):
//!    its batch turned out to be the tile's chunk, so a per-pixel renderer CAN
//!    reproduce it, and the solid-ore footprint and overlay both read it (#84).
//!    Keeping the fields at `rp = 1` keeps tier 2's folds a statement about the
//!    region chain alone.
//! 2. Richness is not ported at all - the preview renders placement, not yield.
//!
//! Both are reproduced rather than fixed, so tier 2 stays a statement about the
//! port and not about a unilateral improvement. That is the same rule #269,
//! #273 and #279 were found under.
//!
//! ## The region cache is real state, like the biome layer's and unlike the rest
//!
//! Every other read in this layer is at the same `(x, y)`, so the TypeScript's
//! `memoXY` wrappers need no counterpart - the chain evaluates top to bottom
//! into locals and that is what a same-position memo achieves, bit-identically.
//!
//! The four spot fields are the exception. A query at `(x, y)` reads selected
//! spots from every region within `MAX_SPOT_BASEMENT_RADIUS`, which is genuine
//! cross-position state. The cache and the cone walk live in
//! [`crate::spot_field`], shared with Aquilo; this module supplies the key
//! (`SpotCacheKey`: the whole spot spec) and the selection. One cache rather
//! than four, because the key itself separates the streams and a second
//! container could only drift from it.
//!
//! `seed1` alone is NOT the separator. It is distinct across Vulcanus's four
//! streams (789, 782349, 749, 759), but Aquilo's three wells share `seed1` 567
//! and, at default sliders, region size 1000; they differ in count (4, 3, 2),
//! skip offset (0, 1, 2) and radius, so `(seed1, region)` would mix them up.
//! Every `SpotSpec` field that shapes `select_spots` or the spot values is keyed.
//!
//! ## Cost
//!
//! `select_spots` evaluates density and favorability at accepted candidates,
//! and both pull a whole biome-full chain at that candidate. The TypeScript
//! memoizes those; this recomputes them.
//!
//! **This layer IS on a render path now, and the recomputation was measured
//! rather than left as a caveat.** The ore -> cliff rejection reaches it through
//! [`VulcanusResources::ore_regions`], so the `cliffs` view evaluates this
//! chain a couple of tiles per placed cell. This comment used to say "nothing
//! on the render path reaches this layer yet, so it is correct-first by choice",
//! and its own next sentence said what to do when that stopped being true.
//!
//! Measured at 256x256, 1 tile/px, seed 123456, min of 5 after a warm pass,
//! three separate runs agreeing to the second decimal - as the cost of the
//! cliff OVERLAY relative to the terrain sweep in the SAME arm:
//!
//! | arm | terrain | cliffs | overlay |
//! | --- | ---: | ---: | ---: |
//! | TypeScript | 33.10 us/px | 42.41 us/px | 1.28x |
//! | WASM | 8.64 us/px | 9.52 us/px | **1.10x** |
//!
//! So the un-memoized chain costs proportionally LESS here than the memoized
//! one does in the TypeScript. The reason is that the cliff pass is not
//! per-pixel: it walks a 4-tile lattice and touches two tiles per placed cell,
//! so this layer is evaluated a few thousand times against the terrain sweep's
//! 65,536. A memo would be optimising something that is already 10% of the
//! render.
//!
//! **Read the RATIOS, not the microseconds.** Those absolutes are from a run
//! inside vitest, where the TypeScript arm pays #267's per-module transform and
//! the WASM arm does not - `docs/noise/vulcanus-cliffs-NOTES.md` measures the
//! same TypeScript terrain view at 12.68 us/px outside it. A ratio between the
//! two arms would be measuring the harness; a ratio WITHIN one arm cancels it,
//! which is the only reading this table supports.
//!
//! `multioctave_noise`'s docs record what happened the last time a per-call
//! rebuild went unmeasured, which was 20x - that is why this was measured, and
//! the answer this time is that it does not matter.

use crate::at::At;
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::ctx::EvalCtx;
use crate::eval::math::{clamp, max2, min2, slider_rescale};
use crate::expressions::starting_spot_at_angle::{starting_spot_at_angle, AngleTrig, StartingSpot};
use crate::expressions::vulcanus_biomes::VulcanusBiomes;
use crate::expressions::vulcanus_cracks::VulcanusCracks;
use crate::expressions::vulcanus_helpers::VulcanusHelpers;
use crate::expressions::vulcanus_spawn::{
    VulcanusSpawn, WobbleSums, VULCANUS_STARTING_AREA_RADIUS,
};
use crate::multioctave_noise::{MultioctaveParams, Prepared};
use crate::spot_candidates::SpotRegionKey;
use crate::spot_field::{spot_cone_max, ConeArithmetic, SpotGeometry, SpotRegionCache};
use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};

/// `vulcanus_ore_spacing` (`suggested_minimum_candidate_point_spacing`).
pub const VULCANUS_ORE_SPACING: f64 = 128.0;

/// `basement_value` for every Vulcanus resource `spot_noise` call.
const BASEMENT_VALUE: f64 = -1.0;

/// `maximum_spot_basement_radius` - the per-query cone cull radius.
const MAX_SPOT_BASEMENT_RADIUS: f64 = 128.0;

/// `skip_span` for every `vulcanus_place_*_spots` call.
///
/// NOT a shared-stream partition. Each resource has its own `seed1` and
/// therefore its own candidate stream; `skip_span = 3` just thins that stream to
/// a third. The four `skip_offset`s (tungsten 2, coal 1, calcite 1, sulfur 0)
/// are not distinct either - coal and calcite share offset 1, which is harmless
/// precisely because their streams differ.
const SKIP_SPAN: usize = 3;

/// `vulcanus_biome_contrast` as this layer uses it: the favorability contrast,
/// 2 at all four call sites.
const CONTRAST: f64 = 2.0;

/// Which biome favorability a spot field reads.
///
/// A plain-data selector rather than a boxed closure, so the density and
/// favorability expressions handed to `select_spots` can borrow `&self`
/// immutably alongside the region cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Favor {
    Basalts,
    Ashlands,
    /// Calcite's - buffer 0.4, minus the volcano-peak indicator.
    MountainsCalcite,
    /// Sulfur's - buffer 0.3, NO volcano-peak term.
    MountainsSulfur,
}

/// How the `spot_noise` half of a `vulcanus_place_*_spots` call is parameterised.
#[derive(Debug, Clone, Copy)]
struct SpotSpec {
    seed1: u32,
    candidate_spot_count: usize,
    skip_offset: usize,
    /// `region_size` BEFORE the floor - `base + base / frequency`, which is
    /// fractional at a non-default frequency slider.
    region_size: f64,
    /// `slider_rescale(control:<x>:size, 2)`, the multiplier in the shared
    /// `size` expression.
    size_rescaled: f64,
    favor: Favor,
}

/// The cache key of one spot stream: the WHOLE spec, not `seed1`. The region
/// rides beside it in [`SpotRegionCache`]'s own tuple key.
///
/// Every [`SpotSpec`] field is here. The f64 fields go in as `to_bits`, which
/// is exact where a rounded or floored form could merge two specs: `region_size`
/// is kept UNFLOORED, so 833.3 and 833.9 stay apart even though
/// `select_spots` floors both. [`Favor`] is a plain C-like enum, so deriving
/// `Ord` on it gives a stable identity with no discriminant cast. `skip_span` is
/// the module constant today; it is in the key so a future spec that varies it
/// cannot collide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct SpotCacheKey {
    seed1: u32,
    region_size_bits: u64,
    skip_span: u32,
    skip_offset: u32,
    candidate_spot_count: u32,
    size_rescaled_bits: u64,
    favor: Favor,
}

impl SpotSpec {
    /// The cache key of this spec's regions.
    fn cache_key(self) -> SpotCacheKey {
        SpotCacheKey {
            seed1: self.seed1,
            region_size_bits: self.region_size.to_bits(),
            skip_span: SKIP_SPAN as u32,
            skip_offset: self.skip_offset as u32,
            candidate_spot_count: self.candidate_spot_count as u32,
            size_rescaled_bits: self.size_rescaled.to_bits(),
            favor: self.favor,
        }
    }

    /// The region math and cone constants of this spec.
    fn geometry(self) -> SpotGeometry {
        SpotGeometry {
            region_size: self.region_size,
            max_basement_radius: MAX_SPOT_BASEMENT_RADIUS,
            basement_value: BASEMENT_VALUE,
            // Vulcanus's frozen counts were measured with the ported
            // arithmetic, so it stays here; see `spot_field`'s module docs.
            cone: ConeArithmetic::PortedF32,
        }
    }
}

/// The three solid ores' region fields - the projection of [`ResourceFields`]
/// that the ore -> cliff rejection reads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OreRegions {
    pub tungsten: f64,
    pub coal: f64,
    pub calcite: f64,
}

/// Every named expression this layer's oracle fixture grades, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ResourceFields {
    pub basalts_favorability: f64,
    pub mountains_favorability: f64,
    pub mountains_sulfur_favorability: f64,
    pub ashlands_favorability: f64,
    pub starting_tungsten: f64,
    pub starting_coal: f64,
    pub starting_calcite: f64,
    pub starting_sulfur: f64,
    pub tungsten_region: f64,
    pub coal_region: f64,
    pub calcite_region: f64,
    pub sulfuric_acid_region: f64,
    pub sulfuric_acid_patches: f64,
    pub sulfuric_acid_region_patchy: f64,
    pub metal_tile: f64,
}

/// The per-render constants of Vulcanus's resource system.
pub struct VulcanusResources<'a> {
    helpers: &'a VulcanusHelpers,
    spawn: &'a VulcanusSpawn,
    biomes: &'a VulcanusBiomes<'a>,
    cracks: &'a VulcanusCracks,

    seed0: u32,
    starting_positions: Vec<Point>,

    /// `control:tungsten_ore:size > 0`, the gate on `vulcanus_metal_tile`.
    tungsten_size_positive: bool,

    /// The four starting-spot discs, plus sulfur's second.
    spot_tungsten: StartingSpot,
    spot_coal: StartingSpot,
    spot_calcite: StartingSpot,
    spot_sulfur_far: StartingSpot,
    spot_sulfur_near: StartingSpot,

    /// The four `vulcanus_place_*_spots` calls, in tungsten/coal/calcite/sulfur
    /// order.
    tungsten_spots: SpotSpec,
    coal_spots: SpotSpec,
    calcite_spots: SpotSpec,
    sulfur_spots: SpotSpec,

    /// `vulcanus_sulfuric_acid_patches`' own two-octave noise.
    patch_noise: Prepared,

    region_cache: SpotRegionCache<SpotCacheKey>,
}

impl<'a> VulcanusResources<'a> {
    /// Build the layer, taking the five starting-spot bearings from the caller.
    ///
    /// The trig is an INPUT for the reason `starting_spot_at_angle`'s own docs
    /// give: it is plain arithmetic with no narrowing below the trig, so a
    /// one-ULP `sin` difference lands straight in the result, and #270 measured
    /// that the `wasm32-unknown-unknown` libm and V8 really do disagree. All
    /// five angles are per-render constants, so the sines and cosines are
    /// computed once outside the per-pixel path.
    ///
    /// The order is tungsten, coal, calcite, then sulfur's FAR and NEAR discs.
    #[must_use]
    pub fn new(
        ctx: &EvalCtx,
        helpers: &'a VulcanusHelpers,
        spawn: &'a VulcanusSpawn,
        biomes: &'a VulcanusBiomes<'a>,
        cracks: &'a VulcanusCracks,
        trig: [AngleTrig; 5],
    ) -> Self {
        let r = VULCANUS_STARTING_AREA_RADIUS;
        let levers = ctx.vulcanus_resource_controls;

        // `slider_rescale(control:<x>:size, 2)`. `tungsten_size` is deliberately
        // NOT read by `starting_tungsten` - the Lua's own comment says "don't
        // use the slider for radius because it can make tungsten in the safe
        // area" - but it IS read by the tungsten region's size expression.
        let tungsten_size = f64::from(slider_rescale(levers.tungsten_ore.size, 2.0));
        let coal_size = f64::from(slider_rescale(levers.vulcanus_coal.size, 2.0));
        let calcite_size = f64::from(slider_rescale(levers.calcite.size, 2.0));
        let sulfur_size = f64::from(slider_rescale(levers.sulfuric_acid_geyser.size, 2.0));

        Self {
            helpers,
            spawn,
            biomes,
            cracks,
            seed0: ctx.seed0,
            starting_positions: ctx.starting_positions.clone(),
            tungsten_size_positive: levers.tungsten_ore.size > 0.0,

            spot_tungsten: StartingSpot {
                trig: trig[0],
                distance: f64::from((450.0 * r) as f32),
                // Not slider-scaled, per the Lua comment above.
                radius: f64::from((30.0 / 1.5) as f32),
            },
            spot_coal: StartingSpot {
                trig: trig[1],
                distance: f64::from((180.0 * r) as f32),
                radius: f64::from((30.0 * coal_size) as f32),
            },
            spot_calcite: StartingSpot {
                trig: trig[2],
                distance: f64::from((350.0 * r) as f32),
                radius: f64::from((f64::from((35.0 / 1.5) as f32) * calcite_size) as f32),
            },
            spot_sulfur_far: StartingSpot {
                trig: trig[3],
                distance: f64::from((590.0 * r) as f32),
                // A bare literal in the Lua, and exact in f32, so it carries no
                // narrowing in the TypeScript either.
                radius: 30.0,
            },
            spot_sulfur_near: StartingSpot {
                trig: trig[4],
                distance: f64::from((200.0 * r) as f32),
                radius: f64::from((25.0 * sulfur_size) as f32),
            },

            // `region_size` bases differ per placer: metal 500, sulfur 450,
            // non-metal 400. `frequency` is the RAW wire value - the source
            // passes it through without a `slider_rescale`.
            tungsten_spots: SpotSpec {
                seed1: 789,
                candidate_spot_count: 15,
                skip_offset: 2,
                region_size: 500.0 + 500.0 / levers.tungsten_ore.frequency,
                size_rescaled: tungsten_size,
                favor: Favor::Basalts,
            },
            coal_spots: SpotSpec {
                seed1: 782_349,
                candidate_spot_count: 12,
                skip_offset: 1,
                region_size: 400.0 + 400.0 / levers.vulcanus_coal.frequency,
                size_rescaled: coal_size,
                favor: Favor::Ashlands,
            },
            calcite_spots: SpotSpec {
                seed1: 749,
                candidate_spot_count: 12,
                skip_offset: 1,
                region_size: 400.0 + 400.0 / levers.calcite.frequency,
                size_rescaled: calcite_size,
                favor: Favor::MountainsCalcite,
            },
            sulfur_spots: SpotSpec {
                seed1: 759,
                candidate_spot_count: 9,
                skip_offset: 0,
                region_size: 450.0 + 450.0 / levers.sulfuric_acid_geyser.frequency,
                size_rescaled: sulfur_size,
                favor: Favor::MountainsSulfur,
            },

            patch_noise: Prepared::new(&MultioctaveParams {
                seed0: ctx.seed0,
                seed1: 21_000,
                octaves: 2.0,
                persistence: 0.7,
                input_scale: 1.0 / 3.0,
                output_scale: 1.0,
            }),

            region_cache: SpotRegionCache::new(),
        }
    }

    /// As [`VulcanusResources::new`], but computing all five bearings with
    /// Rust's libm.
    ///
    /// **Not for the shipped engine** - see `AngleTrig::from_degrees`. It is
    /// here so a tier-1 test can grade the layer against the oracle without the
    /// fixture carrying pre-computed trig.
    ///
    /// Each angle is narrowed to f32 at the call site, and the per-resource
    /// offset is narrowed before the subtraction. Those are two of the five
    /// narrowings #279 found, and neither lives inside the function.
    #[must_use]
    pub fn with_host_trig(
        ctx: &EvalCtx,
        helpers: &'a VulcanusHelpers,
        spawn: &'a VulcanusSpawn,
        biomes: &'a VulcanusBiomes<'a>,
        cracks: &'a VulcanusCracks,
    ) -> Self {
        let dir = spawn.starting_direction;
        let angle = |base: f64, offset: f64| {
            AngleTrig::from_degrees(f64::from((base + f64::from((offset * dir) as f32)) as f32))
        };
        Self::new(
            ctx,
            helpers,
            spawn,
            biomes,
            cracks,
            [
                angle(spawn.basalts_angle, -10.0),
                angle(spawn.ashlands_angle, 15.0),
                angle(spawn.mountains_angle, -20.0),
                angle(spawn.mountains_angle, 10.0),
                angle(spawn.mountains_angle, 30.0),
            ],
        )
    }

    /// `vulcanus_resource_wobble_x` and `_y`.
    ///
    /// A DIFFERENT combination from `vulcanus_spawn`'s three-wobble sum:
    /// resources use two wobbles, the larger one quarter-weighted.
    fn resource_wobble_at(&self, at: At) -> (f64, f64) {
        (
            self.helpers.wobble_x_at(at) + 0.25 * self.helpers.wobble_large_x_at(at),
            self.helpers.wobble_y_at(at) + 0.25 * self.helpers.wobble_large_y_at(at),
        )
    }

    /// The shared favorability shape:
    /// `clamp((biome_full * (starting_area < 0.01) - buffer) * contrast, 0, 1)`.
    ///
    /// `contrast` is 2 at all four sites; only `buffer` and the calcite volcano
    /// term differ.
    fn favorability(biome_full: f64, starting_area: f64, buffer: f64) -> f64 {
        let outside_start = if starting_area < 0.01 { 1.0 } else { 0.0 };
        clamp((biome_full * outside_start - buffer) * CONTRAST, 0.0, 1.0)
    }

    /// One of the four favorabilities.
    ///
    /// Calcite's is the odd one out twice over - buffer 0.4 rather than 0.3, AND
    /// it subtracts the volcano-peak indicator. Do not collapse it with
    /// sulfur's, which reads the same biome at the common buffer.
    fn favor(&self, kind: Favor, x: f64, y: f64) -> f64 {
        self.favor_at(kind, At::point(x, y))
    }

    /// [`Self::favor`] at an [`At`] (#451).
    fn favor_at(&self, kind: Favor, at: At) -> f64 {
        let b = self.biomes.eval_at(at);
        // `starting_area` comes from the spawn layer rather than from
        // `pre_volcano`'s copy of it, so this reads one field from one owner
        // rather than the same number from two.
        let starting_area = self
            .spawn
            .eval_at(at, WobbleSums::at_pos(self.helpers, at))
            .starting_area;
        match kind {
            Favor::Basalts => Self::favorability(b.basalts_biome_full, starting_area, 0.3),
            Favor::Ashlands => Self::favorability(b.ashlands_biome_full, starting_area, 0.3),
            Favor::MountainsSulfur => {
                Self::favorability(b.mountains_biome_full, starting_area, 0.3)
            }
            Favor::MountainsCalcite => {
                let main = Self::favorability(b.mountains_biome_full, starting_area, 0.4);
                let peak = if b.mountain_volcano_spots > 0.78 {
                    1.0
                } else {
                    0.0
                };
                clamp(main - peak, 0.0, 1.0)
            }
        }
    }

    /// `vulcanus_ore_dist = max(1, distance / 4000)`.
    fn ore_dist(&self, x: f64, y: f64) -> f64 {
        self.ore_dist_at(At::point(x, y))
    }

    /// [`Self::ore_dist`] at an [`At`] (#451).
    fn ore_dist_at(&self, at: At) -> f64 {
        let (x, y) = (at.x(), at.y());
        let d = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        max2(1.0, d / 4000.0)
    }

    /// The shared `size` expression:
    /// `slider_rescale(size, 2) * min(1.2, ore_dist) * 25`.
    fn size_expr(&self, spec: SpotSpec, x: f64, y: f64) -> f64 {
        self.size_expr_at(spec, At::point(x, y))
    }

    /// [`Self::size_expr`] at an [`At`] (#451).
    fn size_expr_at(&self, spec: SpotSpec, at: At) -> f64 {
        let (x, y) = (at.x(), at.y());
        spec.size_rescaled * min2(1.2, self.ore_dist(x, y)) * 25.0
    }

    /// The selected spots of one region of one stream, computed once and cached.
    fn region_spots(&self, spec: SpotSpec, region_x: i64, region_y: i64) -> Vec<SelectedSpot> {
        self.region_cache
            .get_or_select(spec.cache_key(), region_x, region_y, || {
                self.select_region_spots(spec, region_x, region_y)
            })
    }

    /// Select one region's spots (the cache miss path of [`Self::region_spots`]).
    fn select_region_spots(
        &self,
        spec: SpotSpec,
        region_x: i64,
        region_y: i64,
    ) -> Vec<SelectedSpot> {
        let key = SpotRegionKey {
            seed0: self.seed0,
            seed1: spec.seed1,
            region_x,
            region_y,
        };
        let density = |x: f64, y: f64| self.favor(spec.favor, x, y) * 4.0;
        let quantity = |x: f64, y: f64| {
            let s = self.size_expr(spec, x, y);
            s * s
        };
        // No `spot_radius_expression` here on purpose. `select_spots` only needs
        // one when `hard_region_target_quantity` is set, and it is not at any of
        // these four call sites; the radius is evaluated at the surviving spot
        // in `spot_noise` instead. The TypeScript omits it from the same call
        // for the same reason.
        let favorability = |x: f64, y: f64| {
            if self.favor(spec.favor, x, y) > 0.9 {
                1.0
            } else {
                0.0
            }
        };
        select_spots(
            &key,
            &SpotSelectParams {
                region_size: spec.geometry().floored_region_size() as u64,
                candidate_spot_count: spec.candidate_spot_count,
                spacing: VULCANUS_ORE_SPACING,
                skip_span: SKIP_SPAN,
                skip_offset: spec.skip_offset,
                hard_region_target_quantity: false,
                density: &density,
                quantity: &quantity,
                favorability: &favorability,
                quantity_batch: None,
            },
        )
    }

    /// `vulcanus_spot_noise{...}` - the shared noise-function wrapper.
    ///
    /// The wrapper samples at `(x + resource_wobble_x, y + resource_wobble_y)`,
    /// so the WOBBLED coordinate is what selects the region and what the cone
    /// distance is measured from. Using the raw coordinate for the region lookup
    /// produces a plausible-looking but wrong field.
    ///
    /// The region walk, cull and cone arithmetic are [`spot_cone_max`]; this
    /// supplies the wobble, the cached spots and the radius
    /// (`size_expr` at the spot).
    fn spot_noise_at(&self, spec: SpotSpec, at: At) -> f64 {
        let (x, y) = (at.x(), at.y());
        let (wx, wy) = self.resource_wobble_at(at);
        spot_cone_max(
            &spec.geometry(),
            x + wx,
            y + wy,
            |region_x, region_y| self.region_spots(spec, region_x, region_y),
            |s| self.size_expr(spec, s.x as f64, s.y as f64),
        )
    }

    /// `vulcanus_place_metal_spots` - the tungsten placer.
    ///
    /// The only one with the crack term, and the only one whose ceiling is
    /// `clamp(-1 + 4 * favor, -1, 1)` rather than `2 * favor - 1`.
    fn place_metal_spots_at(&self, at: At) -> f64 {
        let spec = self.tungsten_spots;
        let favor = self.favor_at(spec.favor, at);
        min2(
            clamp(-1.0 + 4.0 * favor, -1.0, 1.0),
            self.spot_noise_at(spec, at) - self.cracks.eval_at(at).hairline_cracks / 30_000.0,
        )
    }

    /// `vulcanus_place_sulfur_spots` and `vulcanus_place_non_metal_spots`.
    ///
    /// The two differ only in their `region_size` base, which lives on the spec.
    fn place_capped_spots_at(&self, spec: SpotSpec, at: At) -> f64 {
        min2(
            2.0 * self.favor_at(spec.favor, at) - 1.0,
            self.spot_noise_at(spec, at),
        )
    }

    /// `max(starting_<ore>, min(1 - starting_circle, place_*(...)))`.
    fn region(starting: f64, starting_circle: f64, placed: f64) -> f64 {
        max2(starting, min2(1.0 - starting_circle, placed))
    }

    /// The three SOLID ores' region fields, and nothing else.
    ///
    /// The ore -> cliff rejection asks only "does a solid-ore entity stand on
    /// this tile", which needs `tungsten_region`, `coal_region` and
    /// `calcite_region`. Going through [`VulcanusResources::eval`] for that
    /// would also evaluate the two sulfur cones, the sulfur spot selection and
    /// the patch noise, none of which any consumer of this projection reads -
    /// and the rejection runs on every placed cell of every chunk a render
    /// touches, so it is the one call site where that matters.
    ///
    /// **A projection, not a second model.** Each line here is the same
    /// expression `eval` uses, and
    /// `tests::the_ore_region_projection_agrees_with_the_full_eval_bit_for_bit`
    /// asserts the two agree on raw bits rather than approximately. Two
    /// implementations that could drift apart would be worse than the work
    /// saved, which is the standing objection to a fast path.
    #[must_use]
    pub fn ore_regions(&self, x: f64, y: f64) -> OreRegions {
        self.ore_regions_at(At::point(x, y))
    }

    /// [`Self::ore_regions`] at an [`At`] (#451).
    #[must_use]
    pub fn ore_regions_at(&self, at: At) -> OreRegions {
        let (x, y) = (at.x(), at.y());
        let wobble = WobbleSums::at_pos(self.helpers, at);
        let starting_circle = self.spawn.eval_at(at, wobble).starting_circle;
        let (wx, wy) = self.resource_wobble_at(at);
        let cone = |spot: &StartingSpot| starting_spot_at_angle(spot, x, y, 0.5 * wx, 0.5 * wy);
        OreRegions {
            tungsten: Self::region(
                cone(&self.spot_tungsten),
                starting_circle,
                self.place_metal_spots_at(at),
            ),
            coal: Self::region(
                cone(&self.spot_coal),
                starting_circle,
                self.place_capped_spots_at(self.coal_spots, at),
            ),
            calcite: Self::region(
                cone(&self.spot_calcite),
                starting_circle,
                self.place_capped_spots_at(self.calcite_spots, at),
            ),
        }
    }

    /// Evaluate every graded field of this layer at one position.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> ResourceFields {
        self.eval_at(At::point(x, y))
    }

    /// [`Self::eval`] at an [`At`] (#451).
    #[must_use]
    pub fn eval_at(&self, at: At) -> ResourceFields {
        let (x, y) = (at.x(), at.y());
        let wobble = WobbleSums::at_pos(self.helpers, at);
        let spawn = self.spawn.eval_at(at, wobble);
        let (wx, wy) = self.resource_wobble_at(at);

        // The four starting spots take HALF the resource wobble, except sulfur's
        // pair which take three quarters. Written out per spot rather than
        // looped, because a swapped distortion weight is a plausible map.
        let cone = |spot: &StartingSpot, weight: f64| {
            starting_spot_at_angle(spot, x, y, weight * wx, weight * wy)
        };
        let starting_tungsten = cone(&self.spot_tungsten, 0.5);
        let starting_coal = cone(&self.spot_coal, 0.5);
        let starting_calcite = cone(&self.spot_calcite, 0.5);
        let starting_sulfur = max2(
            cone(&self.spot_sulfur_far, 0.75),
            cone(&self.spot_sulfur_near, 0.75),
        );

        let tungsten_region = Self::region(
            starting_tungsten,
            spawn.starting_circle,
            self.place_metal_spots_at(at),
        );
        let coal_region = Self::region(
            starting_coal,
            spawn.starting_circle,
            self.place_capped_spots_at(self.coal_spots, at),
        );
        let calcite_region = Self::region(
            starting_calcite,
            spawn.starting_circle,
            self.place_capped_spots_at(self.calcite_spots, at),
        );
        let sulfuric_acid_region = Self::region(
            starting_sulfur,
            spawn.starting_circle,
            self.place_capped_spots_at(self.sulfur_spots, at),
        );

        let sulfuric_acid_patches = 0.8 * f64::from(self.patch_noise.eval_at(at)).abs();
        let sulfuric_acid_region_patchy =
            (1.0 + sulfuric_acid_region) * (0.5 + 0.5 * sulfuric_acid_patches) - 1.0;

        // `vulcanus_metal_tile = max(0, vulcanus_tungsten_ore_probability)`,
        // where the probability is
        // `(control:tungsten_ore:size > 0) * 1000 * ((1 + region) * rp - 1)`
        // and `rp -> 1` by approximation 1, so it collapses to `1000 * region`.
        let metal_tile = if self.tungsten_size_positive {
            max2(0.0, 1000.0 * tungsten_region)
        } else {
            0.0
        };

        ResourceFields {
            basalts_favorability: self.favor_at(Favor::Basalts, at),
            mountains_favorability: self.favor_at(Favor::MountainsCalcite, at),
            mountains_sulfur_favorability: self.favor_at(Favor::MountainsSulfur, at),
            ashlands_favorability: self.favor_at(Favor::Ashlands, at),
            starting_tungsten,
            starting_coal,
            starting_calcite,
            starting_sulfur,
            tungsten_region,
            coal_region,
            calcite_region,
            sulfuric_acid_region,
            sulfuric_acid_patches,
            sulfuric_acid_region_patchy,
            metal_tile,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The [`VulcanusResources::ore_regions`] fast path against the full
    /// [`VulcanusResources::eval`] it projects, on RAW BITS rather than a
    /// tolerance.
    ///
    /// Two implementations of the same three expressions is exactly the shape
    /// that drifts silently - the ore -> cliff rejection would then reject
    /// against a footprint the resource overlay does not draw, and neither
    /// render would show it. This is what makes the projection a projection.
    #[test]
    fn the_ore_region_projection_agrees_with_the_full_eval_bit_for_bit() {
        let ctx = EvalCtx::new(123_456);
        let base = crate::expressions::vulcanus_stack::VulcanusBase::with_host_trig(&ctx);
        let biomes = base.biomes_with_host_trig();
        let stack =
            crate::expressions::vulcanus_stack::VulcanusStack::with_host_trig(&base, &biomes);

        // Spread across the three regions the cliff fixture covers, plus the
        // starting area, where the four cones dominate rather than the spots.
        let mut nonzero = 0usize;
        for (x0, y0) in [(0.0, 0.0), (1500.0, 1500.0), (-1200.0, 800.0)] {
            for i in 0..12 {
                for j in 0..12 {
                    let (x, y) = (x0 + f64::from(i) * 19.0, y0 + f64::from(j) * 23.0);
                    let full = stack.resources(x, y);
                    let proj = stack.ore_regions(x, y);
                    assert_eq!(
                        proj.tungsten.to_bits(),
                        full.tungsten_region.to_bits(),
                        "tungsten at ({x}, {y})"
                    );
                    assert_eq!(
                        proj.coal.to_bits(),
                        full.coal_region.to_bits(),
                        "coal at ({x}, {y})"
                    );
                    assert_eq!(
                        proj.calcite.to_bits(),
                        full.calcite_region.to_bits(),
                        "calcite at ({x}, {y})"
                    );
                    if proj.tungsten != 0.0 || proj.coal != 0.0 || proj.calcite != 0.0 {
                        nonzero += 1;
                    }
                }
            }
        }
        // Without this the comparison could pass on three fields that are zero
        // everywhere sampled.
        assert!(
            nonzero > 100,
            "only {nonzero} of 432 positions had any ore signal"
        );
    }

    const FROZEN_FOLD: u64 = 0x41c3_2b2d_06e8_89ed;

    fn layer_at(seed0: u32) -> (EvalCtx, VulcanusHelpers) {
        let ctx = EvalCtx::new(seed0);
        let helpers = VulcanusHelpers::new(&ctx);
        (ctx, helpers)
    }

    /// A fold of the four spot-driven region fields over a grid, frozen BEFORE
    /// the spot query moved into `spot_field` and unchanged by the move.
    ///
    /// Raw bits through an order-sensitive fold, so a one-ULP slip anywhere in
    /// the region walk, the cull, the cone arithmetic or the cache shows.
    #[test]
    fn the_shared_spot_query_is_the_vulcanus_one_bit_for_bit() {
        let (ctx, helpers) = layer_at(1_249_936_247);
        let spawn = VulcanusSpawn::with_host_trig(&ctx);
        let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
        let cracks = VulcanusCracks::new(&helpers);
        let layer = VulcanusResources::with_host_trig(&ctx, &helpers, &spawn, &biomes, &cracks);

        let mut acc = 0u64;
        let mut nonzero = 0usize;
        for i in 0..26 {
            for j in 0..26 {
                let x = -480.0 + f64::from(i) * 37.3;
                let y = -480.0 + f64::from(j) * 37.3;
                let f = layer.eval(x, y);
                for v in [
                    f.tungsten_region,
                    f.coal_region,
                    f.calcite_region,
                    f.sulfuric_acid_region,
                ] {
                    assert!(!v.is_nan());
                    if v != 0.0 {
                        nonzero += 1;
                    }
                    acc = crate::checksum::fold_f64(acc, v);
                }
            }
        }
        assert!(nonzero > 100, "only {nonzero} nonzero region values");
        assert_eq!(acc, FROZEN_FOLD, "fold {acc:#018x}");
    }

    /// The favorability shape, including the gate that zeroes it inside spawn.
    ///
    /// `starting_area >= 0.01` collapses the biome term entirely, so the whole
    /// expression becomes `clamp(-buffer * 2, 0, 1)`, which is 0. A port that
    /// dropped the gate would leave ore inside the safe area.
    #[test]
    fn the_starting_area_gate_zeroes_favorability_rather_than_scaling_it() {
        assert_eq!(
            VulcanusResources::favorability(1.0, 0.5, 0.3),
            0.0,
            "inside the starting area"
        );
        // Outside it, `(1.0 - 0.3) * 2 = 1.4`, clamped to 1.
        assert_eq!(VulcanusResources::favorability(1.0, 0.0, 0.3), 1.0);
        // And the buffer really does subtract. `(0.4 - 0.3) * 2` is not exactly
        // 0.2 in binary, so this compares within an epsilon - the shape is what
        // is under test here, and the exact bits are what the oracle fixture
        // grades.
        assert!((VulcanusResources::favorability(0.4, 0.0, 0.3) - 0.2).abs() < 1e-12);
        // A biome fully under the buffer clamps to zero rather than going
        // negative, which is what keeps a spot density non-negative.
        assert_eq!(VulcanusResources::favorability(0.1, 0.0, 0.3), 0.0);
    }

    /// `region` is `max(starting, min(1 - circle, placed))`, and the starting
    /// spot is OUTSIDE the circle mask.
    ///
    /// The nesting is what puts a starting patch inside spawn at all: the circle
    /// mask suppresses the placed field there, and the `max` re-admits the
    /// hand-placed spot afterwards. Swapping the two would erase every starting
    /// patch, which looks like a spot-selection bug rather than a nesting one.
    #[test]
    fn the_starting_spot_survives_the_circle_mask_that_suppresses_placement() {
        // Deep inside spawn: circle 1 kills the placed field completely.
        assert_eq!(VulcanusResources::region(0.9, 1.0, 0.8), 0.9);
        // Far outside it: the placed field wins.
        assert_eq!(VulcanusResources::region(-1.0, 0.0, 0.8), 0.8);
    }

    /// `metal_tile` is gated on the SIZE slider, not the frequency one.
    #[test]
    fn a_zero_tungsten_size_removes_metal_tile_entirely() {
        let (mut ctx, _) = layer_at(123_456);
        ctx.vulcanus_resource_controls.tungsten_ore.size = 0.0;
        let helpers = VulcanusHelpers::new(&ctx);
        let spawn = VulcanusSpawn::with_host_trig(&ctx);
        let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
        let cracks = VulcanusCracks::new(&helpers);
        let resources = VulcanusResources::with_host_trig(&ctx, &helpers, &spawn, &biomes, &cracks);
        assert_eq!(resources.eval(0.0, 0.0).metal_tile, 0.0);
    }

    /// Calcite and sulfur read the SAME biome and must not be collapsed.
    ///
    /// They differ by the buffer (0.4 against 0.3) and by calcite's volcano-peak
    /// subtraction. Asserted at a position where the two actually differ, so the
    /// case is not vacuous.
    #[test]
    fn the_two_mountains_favorabilities_are_not_the_same_expression() {
        let (ctx, helpers) = layer_at(123_456);
        let spawn = VulcanusSpawn::with_host_trig(&ctx);
        let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
        let cracks = VulcanusCracks::new(&helpers);
        let resources = VulcanusResources::with_host_trig(&ctx, &helpers, &spawn, &biomes, &cracks);

        let mut differed = 0;
        for i in 0..40 {
            let p = 137.0 * f64::from(i) - 2000.0;
            let f = resources.eval(p, p);
            if f.mountains_favorability != f.mountains_sulfur_favorability {
                differed += 1;
            }
        }
        assert!(
            differed > 0,
            "the two mountains favorabilities agreed at all 40 probe positions, \
             so this test cannot see them being collapsed"
        );
    }

    /// Two specs that share a `seed1` must not share cached spots.
    ///
    /// Aquilo's three fluid wells (2.1.23 `planet-aquilo-map-gen.lua`) all call
    /// `aquilo_spot_noise` with seed 567, skip span 3 and spacing 128, and at
    /// default sliders all three region sizes are `600 + 400 / 1 = 1000`. What
    /// differs is the count (4, 3, 2), the skip offset (0, 1, 2) and the radius.
    /// So a key of `(seed1, region)` would hand the second well the first one's
    /// spots. One test per key field that can tell such specs apart: region
    /// size (a moved frequency slider), skip offset and count.
    ///
    /// Each is cold-against-warm, so a collision shows as a difference rather
    /// than as two equal wrong answers. Each also asserts that the two specs
    /// really select different spots, or the test could not see a collision.
    /// Each was planted: with its field dropped from `SpotCacheKey`, its own
    /// test fails.
    ///
    /// `SpotCacheKey` stays here because it embeds the Vulcanus-only `Favor`
    /// enum and `SKIP_SPAN`; the cache it keys is `spot_field`'s.
    fn assert_specs_do_not_share_cached_spots(first: SpotSpec, second: SpotSpec) {
        let (ctx, helpers) = layer_at(123_456);
        let spawn = VulcanusSpawn::with_host_trig(&ctx);
        let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
        let cracks = VulcanusCracks::new(&helpers);
        let build = || VulcanusResources::with_host_trig(&ctx, &helpers, &spawn, &biomes, &cracks);

        let regions: Vec<(i64, i64)> = (-3..=3)
            .flat_map(|x| (-3..=3).map(move |y| (x, y)))
            .collect();

        let cold = build();
        let expected: Vec<_> = regions
            .iter()
            .map(|&(x, y)| cold.region_spots(second, x, y))
            .collect();
        assert!(
            expected.iter().any(|spots| !spots.is_empty()),
            "no region produced a spot, so this test cannot see a collision"
        );
        let cold_first = build();
        assert!(
            regions
                .iter()
                .zip(&expected)
                .any(|(&(x, y), want)| &cold_first.region_spots(first, x, y) != want),
            "the two specs select the same spots everywhere, so this test cannot see a collision"
        );

        let warm = build();
        for &(x, y) in &regions {
            let _ = warm.region_spots(first, x, y);
        }
        for (&(x, y), want) in regions.iter().zip(&expected) {
            assert_eq!(
                &warm.region_spots(second, x, y),
                want,
                "region ({x}, {y}) took the first spec's cached spots"
            );
        }
    }

    const SHARED_SEED1_SPEC: SpotSpec = SpotSpec {
        seed1: 789,
        candidate_spot_count: 15,
        skip_offset: 2,
        region_size: 1000.0,
        size_rescaled: 1.0,
        favor: Favor::Basalts,
    };

    #[test]
    fn two_specs_sharing_seed1_do_not_share_cached_spots() {
        let first = SHARED_SEED1_SPEC;
        let second = SpotSpec {
            region_size: 800.0,
            ..first
        };
        assert_specs_do_not_share_cached_spots(first, second);
    }

    #[test]
    fn two_specs_sharing_seed1_and_differing_only_in_skip_offset_do_not_share_cached_spots() {
        let first = SHARED_SEED1_SPEC;
        let second = SpotSpec {
            skip_offset: 0,
            ..first
        };
        assert_specs_do_not_share_cached_spots(first, second);
    }

    #[test]
    fn two_specs_sharing_seed1_and_differing_only_in_count_do_not_share_cached_spots() {
        let first = SHARED_SEED1_SPEC;
        let second = SpotSpec {
            candidate_spot_count: 8,
            ..first
        };
        assert_specs_do_not_share_cached_spots(first, second);
    }
}
