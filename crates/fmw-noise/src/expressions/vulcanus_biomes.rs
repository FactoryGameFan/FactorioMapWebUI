//! Vulcanus's biome system, ported from
//! `src/noise/expressions/vulcanusBiomes.ts`.
//!
//! The radial biome-noise chain - noise, raw, full, clamped - for all three
//! biomes, plus `mountain_volcano_spots` and the spot-noise pipeline behind it.
//! Transcribed from
//! `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` lines ~229-389.
//!
//! ## The mountains split exists to break a cycle, and it is load-bearing
//!
//! `mountain_volcano_spots` depends on the mountains biome, and the mountains
//! biome folds the volcano field back in. The Lua breaks that with a PRE-volcano
//! stage: `volcano_area` reads `mountains_biome_full_pre_volcano`, and only the
//! POST-volcano raw feeds the three `*_biome_full` fields.
//!
//! Collapsing the two stages into one would be an infinite recursion rather than
//! a wrong number, so it announces itself - but writing `volcano_area` against
//! the post-volcano raw by mistake would not. That is why the pre-volcano stage
//! is a named method here rather than an inline local.
//!
//! ## No memo, except where the TypeScript's memo is not a memo
//!
//! The rest of this port evaluates a layer top to bottom into locals, because
//! every read is at the same `(x, y)`. This layer has one genuine exception:
//! `regionSpots` caches SELECTED SPOTS PER REGION, and `raw_spots` at one point
//! reads spots from up to four neighbouring regions. That is cross-position
//! state, so it is a real cache and it is kept - as a `RefCell<BTreeMap>`, so
//! that `eval` can stay `&self` and the density and favorability closures handed
//! to `select_spots` can borrow it immutably alongside.
//!
//! `BTreeMap` rather than `HashMap` deliberately: nothing here iterates the
//! cache, but a determinism-critical port should not carry a container whose
//! iteration order is unspecified, in case someone later adds a sweep over it.
//!
//! ## Cost
//!
//! `volcano_area` is evaluated at every spot candidate, and it pulls the whole
//! pre-volcano chain - six biome-noise octave stacks and the three spawn cones -
//! at that candidate's position. The TypeScript memoizes each of those; this
//! recomputes them.
//!
//! **This layer joined a render path with the cliff view, and the measurement
//! its own caveat asked for has been taken.** The ore -> cliff rejection reads
//! `vulcanus_resources`, whose `select_spots` pulls this chain. Measured at
//! 256x256, 1 tile/px, the cliff overlay costs **1.10x** the terrain sweep in
//! the WASM arm against **1.28x** in the TypeScript arm - so the un-memoized
//! chain is proportionally cheaper here than the memoized one is there, because
//! the cliff pass walks a 4-tile lattice rather than every pixel. The full table
//! and the reason only WITHIN-arm ratios are readable are in
//! `vulcanus_resources`' own cost section.
//!
//! It is still correct-first by choice for any PER-PIXEL consumer, and
//! `multioctave_noise`'s own docs record what happened last time a per-call
//! rebuild went unmeasured: 20x.

use crate::at::At;
use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::ctx::EvalCtx;
use crate::eval::math::{clamp, f32r, lerp_f32, max2, slider_rescale};
use crate::expressions::starting_spot_at_angle::{starting_spot_at_angle, AngleTrig, StartingSpot};
use crate::expressions::vulcanus_helpers::VulcanusHelpers;
use crate::expressions::vulcanus_spawn::{
    VulcanusSpawn, WobbleSums, VULCANUS_STARTING_AREA_RADIUS_F32,
};
use crate::multioctave_noise::Prepared;
use crate::poison;
use crate::spot_candidates::SpotRegionKey;
use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};

/// `vulcanus_biome_contrast = 2`. Higher means sharper biome transitions.
pub const VULCANUS_BIOME_CONTRAST: f64 = 2.0;

/// `region_size` for `mountain_volcano_spots`.
///
/// **256, not the 1024 the resource spot fields use.** A region size that is
/// wrong by a factor of four still produces spots, just the wrong ones, and
/// nothing about the output announces the cause.
const VOLCANO_REGION_SIZE: u64 = 256;

/// Region index for a coordinate. Regions are centred on multiples of the size,
/// which is why this offsets by half before dividing.
fn region_index(c: f64) -> i64 {
    ((c + VOLCANO_REGION_SIZE as f64 / 2.0) / VOLCANO_REGION_SIZE as f64).floor() as i64
}

/// The pre-volcano stage: everything `volcano_area` needs, and nothing that
/// depends on the volcano field.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PreVolcano {
    pub ashlands_raw: f64,
    pub basalts_raw: f64,
    pub mountains_raw_pre_volcano: f64,
    pub mountains_biome_full_pre_volcano: f64,
    pub starting_area: f64,
}

/// Every named expression the oracle fixture grades, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BiomeFields {
    pub mountain_volcano_spots: f64,
    pub mountains_raw_volcano: f64,
    pub mountains_biome_full: f64,
    pub ashlands_biome_full: f64,
    pub basalts_biome_full: f64,
    pub mountains_biome: f64,
    pub ashlands_biome: f64,
    pub basalts_biome: f64,
}

/// The per-render constants of Vulcanus's biome system.
pub struct VulcanusBiomes<'a> {
    helpers: &'a VulcanusHelpers,
    spawn: &'a VulcanusSpawn,
    seed0: u32,
    starting_positions: Vec<Point>,

    mountains_near: Prepared,
    mountains_far: Prepared,
    ashlands_near: Prepared,
    ashlands_far: Prepared,
    basalts_near: Prepared,
    basalts_far: Prepared,

    /// `0.3 + 0.7 * slider_rescale(size, 3) / slider_rescale(scale_multiplier, 3)`.
    ///
    /// Two nested `slider_rescale`s, because `scale_multiplier` is itself one.
    /// Both are 1 at the default preset, so volcanism is 1 there.
    pub volcanism: f64,
    volcanism_sq: f64,
    /// `f32(200 * volcanism)`, and the cull radius as well as the cone radius:
    /// `maximum_spot_basement_radius` and `spot_radius_expression` are the same
    /// expression in the Lua, so they coincide.
    radius: f64,
    /// `f32(radius * radius)` - the spot QUANTITY, narrowed.
    quantity: f64,
    spacing: f64,

    protector: StartingSpot,
    volcano_spot: StartingSpot,

    region_cache: RefCell<BTreeMap<(i64, i64), Vec<SelectedSpot>>>,
}

impl<'a> VulcanusBiomes<'a> {
    /// Build the layer, taking the two volcano discs' trig from the caller.
    #[must_use]
    pub fn new(
        ctx: &EvalCtx,
        helpers: &'a VulcanusHelpers,
        spawn: &'a VulcanusSpawn,
        volcano_spot_trig: AngleTrig,
        protector_trig: AngleTrig,
    ) -> Self {
        let r = VULCANUS_STARTING_AREA_RADIUS_F32;
        let seed0 = ctx.seed0;

        // The near scale is `seed1` at `scale * 0.5`; the far scale is
        // `seed1 + 1000` at `scale`. Both halves of every pair, written out, so
        // a wrong seed offset is visible rather than hidden in a loop.
        let biome = |seed1: u32, scale: f64| helpers.biome_noise(seed1, scale);

        // `0.3 + 0.7 * a / b` is `0.3 + ((0.7 * a) / b)`, one f32 step each (#521).
        let volcanism = f32r(
            f32r(0.3)
                + f32r(
                    f32r(f32r(0.7) * f64::from(slider_rescale(ctx.vulcanus_volcanism_size, 3.0)))
                        / f64::from(slider_rescale(helpers.scale_multiplier, 3.0)),
                ),
        );
        let radius = f64::from((200.0 * volcanism) as f32);

        Self {
            helpers,
            spawn,
            seed0,
            starting_positions: ctx.starting_positions.clone(),

            mountains_near: biome(342, 60.0 * 0.5),
            mountains_far: biome(342 + 1000, 60.0),
            ashlands_near: biome(12_416, 40.0 * 0.5),
            ashlands_far: biome(12_416 + 1000, 40.0),
            basalts_near: biome(42_416, 80.0 * 0.5),
            basalts_far: biome(42_416 + 1000, 80.0),

            volcanism,
            volcanism_sq: f32r(volcanism * volcanism),
            radius,
            quantity: f64::from((radius * radius) as f32),
            spacing: f32r(1500.0 * volcanism),

            // Both discs round their distance and radius to f32, like the three
            // in `vulcanus_spawn` (#521): `(400 * r) / 2` is two steps.
            protector: StartingSpot {
                trig: protector_trig,
                distance: f32r(f32r(400.0 * r) / 2.0),
                radius: f32r(800.0 * r),
            },
            volcano_spot: StartingSpot {
                trig: volcano_spot_trig,
                distance: f32r(400.0 * r),
                radius: 200.0,
            },

            region_cache: RefCell::new(BTreeMap::new()),
        }
    }

    /// As [`VulcanusBiomes::new`], but computing both bearings with the game's own
    /// sin/cos polynomial (#531).
    ///
    /// The volcano disc sits at the mountains bearing; the protector is mirrored
    /// by `180 * starting_direction`, so the two swap sides with the seed.
    #[must_use]
    pub fn with_host_trig(
        ctx: &EvalCtx,
        helpers: &'a VulcanusHelpers,
        spawn: &'a VulcanusSpawn,
    ) -> Self {
        // The game narrows the sum to f32 (#531): `180 * direction` is exactly
        // +-180, so only the add rounds. Un-narrowed, it matched the game's
        // protector angle on 567 of 606 probed seeds.
        let protector_angle = f32r(spawn.mountains_angle + 180.0 * spawn.starting_direction);
        Self::new(
            ctx,
            helpers,
            spawn,
            AngleTrig::from_degrees(spawn.mountains_angle),
            AngleTrig::from_degrees(protector_angle),
        )
    }

    /// `distance_from_nearest_point{points = starting_positions}`, uncapped.
    fn distance(&self, x: f64, y: f64) -> f64 {
        self.distance_at(At::point(x, y))
    }

    /// [`Self::distance`] at an [`At`] (#451).
    fn distance_at(&self, at: At) -> f64 {
        let (x, y) = (at.x(), at.y());
        f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ))
    }

    /// `biome_multiscale(seed1, scale, bias)` with `bias = 0` at all three call
    /// sites: the near and far noise blended by `clamp(distance / 10000, 0, 1)`.
    fn multiscale_at(&self, near: &Prepared, far: &Prepared, at: At, bias: f64) -> f64 {
        let (x, y) = (at.x(), at.y());
        f32r(
            bias + lerp_f32(
                f64::from(near.eval_at(at)),
                f64::from(far.eval_at(at)),
                clamp(f32r(self.distance(x, y) / 10_000.0), 0.0, 1.0),
            ),
        )
    }

    /// The pre-volcano stage of the biome chain.
    #[must_use]
    pub fn pre_volcano(&self, x: f64, y: f64) -> PreVolcano {
        self.pre_volcano_at(At::point(x, y))
    }

    /// [`Self::pre_volcano`] at an [`At`] (#451).
    #[must_use]
    pub fn pre_volcano_at(&self, at: At) -> PreVolcano {
        let wobble = WobbleSums::at_pos(self.helpers, at);
        let spawn = self.spawn.eval_at(at, wobble);

        let mountains_noise =
            self.multiscale_at(&self.mountains_near, &self.mountains_far, at, 0.0);
        let ashlands_noise = self.multiscale_at(&self.ashlands_near, &self.ashlands_far, at, 0.0);
        let basalts_noise = self.multiscale_at(&self.basalts_near, &self.basalts_far, at, 0.0);

        let blend = clamp(2.0 * spawn.starting_area, 0.0, 1.0);

        // Each biome's starting weight is a SIGN PATTERN over the three start
        // blobs: its own positive, the other two negative. Written out per
        // biome rather than generated, because a sign error here is a plausible
        // map rather than a broken one.
        //
        // Left to right with a rounding after each sign-folded step: `-m + a - b`
        // is `((-m) + a) - b` (#521).
        let ashlands_raw = lerp_f32(
            ashlands_noise,
            f32r(f32r(-spawn.mountains_start + spawn.ashlands_start) - spawn.basalts_start),
            blend,
        );
        let basalts_raw = lerp_f32(
            basalts_noise,
            f32r(f32r(-spawn.mountains_start - spawn.ashlands_start) + spawn.basalts_start),
            blend,
        );
        let mountains_raw_pre_volcano = lerp_f32(
            mountains_noise,
            f32r(f32r(spawn.mountains_start - spawn.ashlands_start) - spawn.basalts_start),
            blend,
        );

        PreVolcano {
            ashlands_raw,
            basalts_raw,
            mountains_raw_pre_volcano,
            mountains_biome_full_pre_volcano: f32r(
                mountains_raw_pre_volcano - max2(ashlands_raw, basalts_raw),
            ),
            starting_area: spawn.starting_area,
        }
    }

    /// `volcano_area = lerp(mountains_biome_full_pre_volcano, 0, starting_area)`.
    ///
    /// Lerping TOWARD zero as the starting area rises is what keeps volcanoes
    /// out of spawn.
    #[must_use]
    pub fn volcano_area(&self, x: f64, y: f64) -> f64 {
        self.volcano_area_at(At::point(x, y))
    }

    /// [`Self::volcano_area`] at an [`At`] (#451).
    #[must_use]
    pub fn volcano_area_at(&self, at: At) -> f64 {
        let pre = self.pre_volcano_at(at);
        lerp_f32(pre.mountains_biome_full_pre_volcano, 0.0, pre.starting_area)
    }

    /// The spot-noise query offset. The SAME offset is used as the
    /// `x_distortion` of both volcano discs below.
    ///
    /// Each division and each sum is its own f32 step (#521).
    fn query_offset_at(&self, at: At) -> (f64, f64) {
        let h = self.helpers;
        let sum =
            |a: f64, b: f64, c: f64| f32r(f32r(f32r(a / 2.0) + f32r(b / 12.0)) + f32r(c / 80.0));
        (
            sum(
                h.wobble_x_at(at),
                h.wobble_large_x_at(at),
                h.wobble_huge_x_at(at),
            ),
            sum(
                h.wobble_y_at(at),
                h.wobble_large_y_at(at),
                h.wobble_huge_y_at(at),
            ),
        )
    }

    /// The spot-noise query POSITION, `x + wobble_x/2 + large_x/12 + huge_x/80`.
    ///
    /// **Not `x + query_offset`.** The Lua adds the three terms to `x` one at a
    /// time, so each partial sum is rounded with `x` in it; the distortion
    /// above sums the three terms first. The two differ in the last place (#521).
    fn query_position_at(&self, at: At) -> (f64, f64) {
        let h = self.helpers;
        let walk = |c: f64, a: f64, b: f64, d: f64| {
            f32r(f32r(f32r(c + f32r(a / 2.0)) + f32r(b / 12.0)) + f32r(d / 80.0))
        };
        (
            walk(
                at.x(),
                h.wobble_x_at(at),
                h.wobble_large_x_at(at),
                h.wobble_huge_x_at(at),
            ),
            walk(
                at.y(),
                h.wobble_y_at(at),
                h.wobble_large_y_at(at),
                h.wobble_huge_y_at(at),
            ),
        )
    }

    /// The selected spots of one region, computed once and cached.
    fn region_spots(&self, region_x: i64, region_y: i64) -> Vec<SelectedSpot> {
        if let Some(hit) = self.region_cache.borrow().get(&(region_x, region_y)) {
            return hit.clone();
        }
        let key = SpotRegionKey {
            seed0: self.seed0,
            seed1: 1,
            region_x,
            region_y,
        };
        let density = |x: f64, y: f64| f32r(self.volcano_area(x, y) / self.volcanism_sq);
        let quantity = |_x: f64, _y: f64| self.quantity;
        let favorability = |x: f64, y: f64| self.volcano_area(x, y);
        let spots = select_spots(
            &key,
            &SpotSelectParams {
                region_size: VOLCANO_REGION_SIZE,
                candidate_spot_count: 1,
                spacing: self.spacing,
                skip_span: 1,
                skip_offset: 0,
                hard_region_target_quantity: false,
                density: &density,
                quantity: &quantity,
                favorability: &favorability,
                quantity_batch: None,
            },
        );
        self.region_cache
            .borrow_mut()
            .insert((region_x, region_y), spots.clone());
        spots
    }

    /// One spot's cone at `(qx, qy)`, or `None` when the spot does not reach.
    ///
    /// The game's own arithmetic, read from the 2.1.23 binary and shared with
    /// Aquilo's spot fields (`spot_field::ConeArithmetic::GameBinary`): the
    /// distance is an f32 `sqrtss` of an f32 sum of f32 squares, the cull is
    /// `max_r < d` on that f32 distance, the peak is computed once in f64 with
    /// the game's pi (the double `3.1416`, not `PI`) and narrowed, and the cone
    /// is `peak - d * slope` in f32. This layer carries its own copy of the
    /// region walk, so it carries its own copy of this too (#521).
    fn cone_at(&self, qx: f64, qy: f64, s: &SelectedSpot) -> Option<f64> {
        const GAME_SPOT_PI: f64 = f64::from_bits(0x4009_21ff_2e48_e8a7);
        let radius = self.radius as f32;
        // `hard_region_target_quantity = 0`, so `cone_scale` is 1; a spot at or
        // below zero is never emitted.
        if radius <= 0.0 || s.quantity <= 0.0 {
            return None;
        }
        let dx = qx as f32 - s.x as f32;
        let dy = qy as f32 - s.y as f32;
        let d = (dx * dx + dy * dy).sqrt();
        if radius < d {
            return None;
        }
        let r = f64::from(radius);
        let peak = ((f64::from(s.quantity as f32) * 3.0) / ((r * GAME_SPOT_PI) * r)) as f32;
        let slope = peak / radius;
        Some(f64::from(peak - d * slope))
    }

    /// `raw_spots` - the spot-noise field, a max of cones over a basement of 0.
    ///
    /// With `quantity = radius^2` the cone peak `3q / (pi r^2)` collapses to the
    /// constant `3 / pi`, so density and favorability only decide WHICH single
    /// candidate per region survives, never how tall it is. The arithmetic is
    /// still written out per operation in f32, because that constant is only
    /// constant in exact arithmetic.
    #[must_use]
    pub fn raw_spots(&self, x: f64, y: f64) -> f64 {
        self.raw_spots_at(At::point(x, y))
    }

    /// [`Self::raw_spots`] at an [`At`] (#451).
    #[must_use]
    pub fn raw_spots_at(&self, at: At) -> f64 {
        let (qx, qy) = self.query_position_at(at);

        let mut best = 0.0; // basement_value = 0
        for region_x in region_index(qx - self.radius)..=region_index(qx + self.radius) {
            for region_y in region_index(qy - self.radius)..=region_index(qy + self.radius) {
                for s in self.region_spots(region_x, region_y) {
                    let cone = self.cone_at(qx, qy, &s);
                    let Some(cone) = cone else { continue };
                    if cone > best {
                        best = cone;
                    }
                }
            }
        }
        best
    }

    /// `mountain_volcano_spots = max(starting_volcano_spot, raw_spots - starting_protector)`.
    #[must_use]
    pub fn mountain_volcano_spots(&self, x: f64, y: f64) -> f64 {
        self.mountain_volcano_spots_at(At::point(x, y))
    }

    /// [`Self::mountain_volcano_spots`] at an [`At`] (#451).
    #[must_use]
    pub fn mountain_volcano_spots_at(&self, at: At) -> f64 {
        let (x, y) = (at.x(), at.y());
        let (off_x, off_y) = self.query_offset_at(at);
        let protector = clamp(
            starting_spot_at_angle(&self.protector, x, y, off_x, off_y),
            0.0,
            1.0,
        );
        let volcano_spot = clamp(
            starting_spot_at_angle(&self.volcano_spot, x, y, off_x, off_y),
            0.0,
            1.0,
        );
        max2(volcano_spot, f32r(self.raw_spots_at(at) - protector))
    }

    /// Evaluate every graded field of this layer at one position.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> BiomeFields {
        self.eval_at(At::point(x, y))
    }

    /// [`Self::eval`] at an [`At`] (#451).
    #[must_use]
    pub fn eval_at(&self, at: At) -> BiomeFields {
        let pre = self.pre_volcano_at(at);
        let spots = self.mountain_volcano_spots_at(at);

        // The volcano field re-enters the mountains raw here, and this is the
        // only place it does. The 0.5 halves the pre-volcano contribution; the
        // max picks between a gentle ramp and a hard step at 0.33.
        let mountains_raw_volcano = f32r(
            f32r(0.5 * pre.mountains_raw_pre_volcano)
                + max2(
                    f32r(2.0 * spots),
                    f32r(10.0 * clamp(f32r(f32r(spots - f32r(0.33)) * 3.0), 0.0, 1.0)),
                ),
        );

        // Each `*_full` subtracts the max of the OTHER two raws, and mountains
        // contributes its POST-volcano raw to its siblings.
        let mountains_biome_full =
            f32r(mountains_raw_volcano - max2(pre.ashlands_raw, pre.basalts_raw));
        let ashlands_biome_full =
            f32r(pre.ashlands_raw - max2(mountains_raw_volcano, pre.basalts_raw));
        let basalts_biome_full =
            f32r(pre.basalts_raw - max2(mountains_raw_volcano, pre.ashlands_raw));

        BiomeFields {
            mountain_volcano_spots: poison::f64_result(spots),
            mountains_raw_volcano,
            mountains_biome_full,
            ashlands_biome_full,
            basalts_biome_full,
            mountains_biome: clamp(mountains_biome_full * VULCANUS_BIOME_CONTRAST, 0.0, 1.0),
            ashlands_biome: clamp(ashlands_biome_full * VULCANUS_BIOME_CONTRAST, 0.0, 1.0),
            basalts_biome: clamp(basalts_biome_full * VULCANUS_BIOME_CONTRAST, 0.0, 1.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> EvalCtx {
        EvalCtx::new(123_456)
    }

    /// The default preset puts both nested `slider_rescale`s at 1, so volcanism
    /// is exactly 1 - which makes the radius exactly 200 and the spacing 1500.
    #[test]
    fn the_default_volcanism_is_exactly_one() {
        let c = ctx();
        let helpers = VulcanusHelpers::new(&c);
        let spawn = VulcanusSpawn::with_host_trig(&c);
        let biomes = VulcanusBiomes::with_host_trig(&c, &helpers, &spawn);
        assert_eq!(biomes.volcanism, 1.0);
        assert_eq!(biomes.radius, 200.0);
        assert_eq!(biomes.spacing, 1500.0);
        assert_eq!(biomes.quantity, 40_000.0);
    }

    /// Regions are centred on multiples of 256, so the boundary sits at +/-128
    /// rather than at 0. An index that floored `c / 256` would put every region
    /// half a region out.
    #[test]
    fn regions_are_centred_on_multiples_of_the_region_size() {
        assert_eq!(region_index(0.0), 0);
        assert_eq!(region_index(127.9), 0);
        assert_eq!(region_index(128.0), 1);
        assert_eq!(region_index(-128.1), -1);
        assert_eq!(region_index(-129.0), -1);
        assert_eq!(region_index(384.0), 2);
    }

    /// The three clamped biomes are in `[0, 1]`, and the `*_full` variants are
    /// the same quantity UNCLAMPED - so at least one position must show a full
    /// value outside the range, or the clamp is doing nothing and the two sets
    /// of fields are redundant.
    #[test]
    fn the_full_variants_are_unclamped_and_the_biomes_are_not() {
        let c = ctx();
        let helpers = VulcanusHelpers::new(&c);
        let spawn = VulcanusSpawn::with_host_trig(&c);
        let biomes = VulcanusBiomes::with_host_trig(&c, &helpers, &spawn);
        let mut outside = 0usize;
        for k in 0..60 {
            let (x, y) = (f64::from(k) * 43.5 - 1200.0, f64::from(k) * -27.25 + 700.0);
            let f = biomes.eval(x, y);
            for v in [f.mountains_biome, f.ashlands_biome, f.basalts_biome] {
                assert!((0.0..=1.0).contains(&v), "clamped biome {v} at {x},{y}");
            }
            for v in [
                f.mountains_biome_full,
                f.ashlands_biome_full,
                f.basalts_biome_full,
            ] {
                if !(0.0..=1.0).contains(&v) {
                    outside += 1;
                }
            }
        }
        assert!(
            outside > 0,
            "no full variant left [0, 1], so the clamp is inert"
        );
    }

    /// At most one biome can win at a point: the `*_full` fields subtract the
    /// max of the other two, so at most one can be positive.
    #[test]
    fn at_most_one_biome_full_is_positive() {
        let c = ctx();
        let helpers = VulcanusHelpers::new(&c);
        let spawn = VulcanusSpawn::with_host_trig(&c);
        let biomes = VulcanusBiomes::with_host_trig(&c, &helpers, &spawn);
        for k in 0..60 {
            let (x, y) = (f64::from(k) * 31.5 - 900.0, f64::from(k) * 19.75 - 600.0);
            let f = biomes.eval(x, y);
            let positive = [
                f.mountains_biome_full,
                f.ashlands_biome_full,
                f.basalts_biome_full,
            ]
            .iter()
            .filter(|v| **v > 0.0)
            .count();
            assert!(positive <= 1, "{positive} biomes positive at {x},{y}");
        }
    }

    /// `volcano_area` reads the PRE-volcano mountains full, which is what breaks
    /// the cycle. If it read the post-volcano one this would not terminate, so
    /// the test is that it returns at all - plus that it really is the
    /// pre-volcano value rather than something merely close to it.
    #[test]
    fn volcano_area_reads_the_pre_volcano_stage() {
        let c = ctx();
        let helpers = VulcanusHelpers::new(&c);
        let spawn = VulcanusSpawn::with_host_trig(&c);
        let biomes = VulcanusBiomes::with_host_trig(&c, &helpers, &spawn);
        let (x, y) = (612.5, -318.25);
        let pre = biomes.pre_volcano(x, y);
        let want = lerp_f32(pre.mountains_biome_full_pre_volcano, 0.0, pre.starting_area);
        assert_eq!(biomes.volcano_area(x, y), want);
        // And the post-volcano value really is different, so the distinction is
        // not academic at this point.
        assert_ne!(
            biomes.eval(x, y).mountains_biome_full,
            pre.mountains_biome_full_pre_volcano
        );
    }

    /// The spot quantity is the radius squared rounded to f32, not the f64
    /// square. Pinned at a slider setting where the two can differ.
    #[test]
    fn the_quantity_is_the_narrowed_square_of_the_radius() {
        let mut c = ctx();
        // A slider setting where 200 * volcanism is not exact in f32, so the
        // two forms can differ at all.
        c.vulcanus_volcanism_size = 3.0;
        let helpers = VulcanusHelpers::new(&c);
        let spawn = VulcanusSpawn::with_host_trig(&c);
        let b = VulcanusBiomes::with_host_trig(&c, &helpers, &spawn);
        assert_eq!(b.quantity, f64::from((b.radius * b.radius) as f32));
    }
}
