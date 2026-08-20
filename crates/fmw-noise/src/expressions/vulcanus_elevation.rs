//! Vulcanus's elevation surface, ported from
//! `src/noise/expressions/vulcanusElevation.ts`.
//!
//! `mountain_basis_noise`, `mountain_elevation`, `volcano_inverted_peak`,
//! `vulcanus_mountains_func`, `vulcanus_ashlands_func`,
//! `vulcanus_basalt_lakes`, the biome-weighted `vulcanus_elev` lerp of lerps,
//! and `vulcanus_elevation = max(-500, vulcanus_elev)`. Transcribed from
//! `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` lines ~428-562.
//!
//! This also closes the `vulcanus_temperature` the climate layer deferred: it
//! reads `vulcanus_elev`, so it could not be ported until this existed.
//!
//! ## Both elevations are exposed, and the difference is not cosmetic
//!
//! `vulcanus_temperature` reads the RAW `vulcanus_elev`, not the
//! `max(-500, ...)`-clamped `vulcanus_elevation`. Wiring temperature to the
//! clamped field would be invisible above -500, which is nearly everywhere, and
//! wrong in exactly the deep basalt lakes where temperature matters.
//!
//! ## `min(a, a)` is transcribed as written
//!
//! `vulcanus_ashlands_func` takes the min of two `basis_noise` calls that are
//! byte-identical in the Lua - same seed, same scales, same output scale. The
//! min of a value with itself is that value, so this could be one call. It is
//! written as two because the source writes two, and collapsing it is the kind
//! of tidy-up that is only safe until someone changes one of them upstream.
//!
//! ## The cliff channel: `multisample` offsets are in GRID UNITS (#83)
//!
//! `vulcanus_basalt_lakes_multisample` is a 2x2 min filter over integer
//! neighbours. Its footprint is one GRID STEP wide, and the grid belongs to the
//! CONSUMING noise program, not to the field being sampled. The tile and terrain
//! channels run a 1-tile grid; the cliff generator walks the 4-tile corner
//! lattice and needs 4.
//!
//! That was measured rather than assumed - routing `multisample(x, 4, 0)` onto
//! `cliff_elevation` moves the contour by **16 tiles, not 4**, which is 4 times
//! the 4-tile step. So [`VulcanusElevation::cliff_elevation`] exists as a
//! separate entry point taking the wider grid, and both go through the same
//! code with `g` as a parameter.

use crate::basis_noise::{tables_from_seed, BasisNoiseTables};
use crate::eval::ctx::EvalCtx;
use crate::eval::math::{clamp, lerp, max2, min, min2};
use crate::eval::multisample::multisample;
use crate::eval::primitives::{basis_noise_expr, BasisExprParams};
use crate::expressions::vulcanus_biomes::VulcanusBiomes;
use crate::expressions::vulcanus_climate::VulcanusClimate;
use crate::expressions::vulcanus_cracks::VulcanusCracks;
use crate::expressions::vulcanus_helpers::{contrast, Plasma, VulcanusHelpers};
use crate::multioctave_noise::Prepared;
use crate::poison;

/// `vulcanus_elevation_offset = 0`.
///
/// Kept as a named constant rather than dropped, because it is a named program
/// constant in the Lua and a future map-gen preset could move it.
pub const VULCANUS_ELEVATION_OFFSET: f64 = 0.0;
/// `vulcanus_mountains_elevation_multiplier = 1.5`.
pub const VULCANUS_MOUNTAINS_ELEVATION_MULTIPLIER: f64 = 1.5;
/// `vulcanus_ashlands_func`'s `local_expressions.scale = 3`.
const ASHLANDS_SCALE: f64 = 3.0;
/// The grid step the tile and terrain channels use.
pub const TILE_MULTISAMPLE_GRID: f64 = 1.0;
/// The grid step the cliff generator uses. See the module docs and #83.
pub const CLIFF_MULTISAMPLE_GRID: f64 = 4.0;

/// `volcano_inverted_peak(spot, inversion_point)`.
///
/// A tent function peaking at 1 when `spot` equals the inversion point and
/// falling away linearly on both sides. Free rather than a method: it reads no
/// per-render state.
#[must_use]
pub fn volcano_inverted_peak(spot: f64, inversion_point: f64) -> f64 {
    (inversion_point - (spot - inversion_point).abs()) / inversion_point
}

/// A `basis_noise{...}` leaf with its tables derived once.
struct BasisLeaf {
    params: BasisExprParams,
    tables: BasisNoiseTables,
}

impl BasisLeaf {
    fn new(seed0: u32, seed1: u32, input_scale: f64, output_scale: f64) -> Self {
        Self {
            params: BasisExprParams {
                seed0,
                seed1,
                input_scale,
                output_scale,
                offset_x: 0.0,
            },
            tables: tables_from_seed(seed0, seed1),
        }
    }

    fn eval(&self, x: f64, y: f64) -> f64 {
        basis_noise_expr(x, y, &self.params, &self.tables)
    }
}

/// The two elevations at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ElevationFields {
    /// `vulcanus_elev`, raw and unclamped. This is what temperature reads.
    pub elev: f64,
    /// `vulcanus_elevation = max(-500, vulcanus_elev)`.
    pub elevation: f64,
}

/// The per-render constants of Vulcanus's elevation surface.
pub struct VulcanusElevation<'a> {
    cracks: &'a VulcanusCracks,
    biomes: &'a VulcanusBiomes<'a>,
    climate: &'a VulcanusClimate,

    mountain_basis: BasisLeaf,
    ashlands_basis: BasisLeaf,
    mountain_plasma: Plasma,
    /// The plasma behind the `(1 - clamp(...))` factor that flattens mountains.
    mountain_elev_plasma: Plasma,
    lakes_837: Prepared,
    lakes_234: Prepared,
    lakes_643: Prepared,
}

impl<'a> VulcanusElevation<'a> {
    /// Build the layer from the four it stacks on.
    #[must_use]
    pub fn new(
        ctx: &EvalCtx,
        helpers: &'a VulcanusHelpers,
        cracks: &'a VulcanusCracks,
        biomes: &'a VulcanusBiomes<'a>,
        climate: &'a VulcanusClimate,
    ) -> Self {
        let seed0 = ctx.seed0;
        Self {
            cracks,
            biomes,
            climate,
            mountain_basis: BasisLeaf::new(seed0, 13_423, 1.0 / 500.0, 250.0),
            // The input scale MULTIPLIES by the volcanism scale multiplier and
            // divides by 50 and by the ashlands LOCAL scale of 3 - not by the
            // crack scale, and the multiplier is not a divisor.
            //
            // Spelled out because no test here can tell the two apart:
            // `scale_multiplier` is exactly 1 at the default preset, which is
            // what every fixture and the poison gate run at, so
            // `m / 50 / 3` and `1 / 50 / 3 / m` are bit-identical throughout.
            // The forms only diverge at a non-default volcanism FREQUENCY
            // slider, and they would diverge with the whole gate green.
            ashlands_basis: BasisLeaf::new(
                seed0,
                12_643,
                helpers.scale_multiplier / 50.0 / ASHLANDS_SCALE,
                150.0,
            ),
            mountain_plasma: helpers.plasma(102, 2.5, 10.0, 125.0, 625.0),
            mountain_elev_plasma: helpers.plasma(13, 2.5, 10.0, 0.15, 0.75),
            lakes_837: helpers.detail_noise(837, 1.0 / 40.0, 4.0, 1.25),
            lakes_234: helpers.detail_noise(234, 1.0 / 50.0, 4.0, 1.0),
            lakes_643: helpers.detail_noise(643, 1.0 / 70.0, 4.0, 0.7),
        }
    }

    /// `mountain_elevation`.
    #[must_use]
    pub fn mountain_elevation(&self, x: f64, y: f64) -> f64 {
        let mp = self.mountain_plasma.eval(x, y);
        let mbn = self.mountain_basis.eval(x, y);
        // The clamp's upper bound of 10000 is far above anything the plasma
        // reaches; it is the Lua's, kept as written.
        let base = lerp(
            max2(clamp(mp, -100.0, 10_000.0), mbn),
            mp,
            clamp(0.7 * mbn, 0.0, 1.0),
        );
        base * (1.0 - clamp(self.mountain_elev_plasma.eval(x, y), 0.0, 1.0))
    }

    /// `vulcanus_mountains_func`.
    #[must_use]
    pub fn mountains_func(&self, x: f64, y: f64, volcano_spots: f64, aux: f64) -> f64 {
        lerp(
            self.mountain_elevation(x, y),
            700.0 * volcano_inverted_peak(volcano_spots, 0.65),
            clamp(volcano_spots * 3.0, 0.0, 1.0),
        ) + 200.0 * (aux - 0.5) * (volcano_spots + 0.5)
    }

    /// `vulcanus_ashlands_func`. See the module docs on `min(a, a)`.
    #[must_use]
    pub fn ashlands_func(&self, x: f64, y: f64) -> f64 {
        300.0
            + 0.001
                * min2(
                    self.ashlands_basis.eval(x, y),
                    self.ashlands_basis.eval(x, y),
                )
    }

    /// `vulcanus_basalt_lakes`.
    ///
    /// Two `contrast`ed detail fields multiplied by a third, clamped to `[0, 3]`
    /// and subtracted. The `contrast` knee of 0.95 makes both factors zero over
    /// most of the map, so the whole term only bites where all three line up.
    #[must_use]
    pub fn basalt_lakes(&self, x: f64, y: f64) -> f64 {
        let carve = contrast(f64::from(self.lakes_837.eval(x, y)), 0.95)
            * contrast(f64::from(self.lakes_234.eval(x, y)), 0.95)
            * f64::from(self.lakes_643.eval(x, y));
        min2(
            1.0,
            -0.2 + self.cracks.eval(x, y).flood_basalts_func - 0.35 * clamp(carve, 0.0, 3.0),
        )
    }

    /// `vulcanus_basalt_lakes_multisample` - a 2x2 min filter one grid step wide.
    #[must_use]
    pub fn basalt_lakes_multisample(&self, x: f64, y: f64, grid: f64) -> f64 {
        let at = |dx: f64, dy: f64| multisample(|sx, sy| self.basalt_lakes(sx, sy), x, y, dx, dy);
        min(&[at(0.0, 0.0), at(grid, 0.0), at(0.0, grid), at(grid, grid)])
    }

    /// `vulcanus_elev` and `vulcanus_elevation` at one position, on a given grid.
    ///
    /// `grid` is [`TILE_MULTISAMPLE_GRID`] for every tile and terrain consumer
    /// and [`CLIFF_MULTISAMPLE_GRID`] for the cliff generator. It reaches only
    /// the basalt-lakes min filter; everything else is grid-independent.
    #[must_use]
    pub fn eval_at_grid(&self, x: f64, y: f64, grid: f64) -> ElevationFields {
        let biome = self.biomes.eval(x, y);
        let climate = self.climate.eval(x, y, &self.cracks.eval(x, y));

        let mountains_blend = lerp(
            120.0 * self.basalt_lakes_multisample(x, y, grid),
            20.0 + self.mountains_func(x, y, biome.mountain_volcano_spots, climate.aux)
                * VULCANUS_MOUNTAINS_ELEVATION_MULTIPLIER,
            biome.mountains_biome,
        );
        let elev = VULCANUS_ELEVATION_OFFSET
            + lerp(
                mountains_blend,
                self.ashlands_func(x, y),
                biome.ashlands_biome,
            );

        ElevationFields {
            elev: poison::f64_result(elev),
            elevation: max2(-500.0, elev),
        }
    }

    /// The tile and terrain channel.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> ElevationFields {
        self.eval_at_grid(x, y, TILE_MULTISAMPLE_GRID)
    }

    /// The cliff generator's channel, whose multisample grid is 4 tiles.
    #[must_use]
    pub fn cliff_elevation(&self, x: f64, y: f64) -> f64 {
        self.eval_at_grid(x, y, CLIFF_MULTISAMPLE_GRID).elevation
    }

    /// `vulcanus_temperature`, deferred out of the climate layer until
    /// `vulcanus_elev` existed.
    ///
    /// **Reads the RAW elev**, not the clamped elevation. `min(e, e / 100)`
    /// picks the raw value below zero and the hundredth above it, which is what
    /// makes high ground cool slowly and deep lakes cool fast.
    #[must_use]
    pub fn temperature(&self, x: f64, y: f64, temperature_bias: f64) -> f64 {
        let e = self.eval(x, y).elev;
        let biome = self.biomes.eval(x, y);
        let climate = self.climate.eval(x, y, &self.cracks.eval(x, y));
        100.0 + 100.0 * temperature_bias
            - min2(e, e / 100.0)
            - 2.0 * climate.moisture
            - 1.0 * climate.aux
            - 20.0 * biome.ashlands_biome
            + 200.0 * max2(0.0, biome.mountain_volcano_spots - 0.6)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::vulcanus_spawn::VulcanusSpawn;

    /// The tent peaks at exactly 1 on the inversion point and reaches 0 at both
    /// 0 and twice the inversion point. A sign error inverts the volcano.
    #[test]
    fn the_inverted_peak_is_a_tent_centred_on_its_inversion_point() {
        assert_eq!(volcano_inverted_peak(0.65, 0.65), 1.0);
        assert_eq!(volcano_inverted_peak(0.0, 0.65), 0.0);
        assert!((volcano_inverted_peak(1.3, 0.65) - 0.0).abs() < 1e-12);
        // Symmetric about the peak.
        assert!(
            (volcano_inverted_peak(0.45, 0.65) - volcano_inverted_peak(0.85, 0.65)).abs() < 1e-12
        );
        // And it goes NEGATIVE outside, which the caller's clamp relies on.
        assert!(volcano_inverted_peak(2.0, 0.65) < 0.0);
    }

    /// The multisample grid reaches the basalt-lakes filter and nothing else, so
    /// the two channels differ only where the filter's four samples disagree -
    /// and they must differ somewhere, or the cliff channel is not a channel.
    #[test]
    fn the_cliff_grid_changes_the_answer_but_only_through_the_lakes_filter() {
        let ctx = EvalCtx::new(123_456);
        let helpers = VulcanusHelpers::new(&ctx);
        let cracks = VulcanusCracks::new(&helpers);
        let spawn = VulcanusSpawn::with_host_trig(&ctx);
        let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
        let climate = VulcanusClimate::new(ctx.seed0);
        let elevation = VulcanusElevation::new(&ctx, &helpers, &cracks, &biomes, &climate);

        let mut differ = 0usize;
        for k in 0..40 {
            let (x, y) = (f64::from(k) * 23.5 - 400.0, f64::from(k) * -17.25 + 300.0);
            let tile = elevation.eval(x, y).elevation;
            let cliff = elevation.cliff_elevation(x, y);
            if tile != cliff {
                differ += 1;
            }
        }
        assert!(
            differ > 0,
            "the 4-tile grid never changed the answer, so the cliff channel is untested"
        );
    }

    /// `elevation` clamps at -500 and `elev` does not. Temperature reads the
    /// raw one, so the two must stay distinguishable.
    #[test]
    fn the_clamped_elevation_is_not_the_raw_elev() {
        let ctx = EvalCtx::new(123_456);
        let helpers = VulcanusHelpers::new(&ctx);
        let cracks = VulcanusCracks::new(&helpers);
        let spawn = VulcanusSpawn::with_host_trig(&ctx);
        let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
        let climate = VulcanusClimate::new(ctx.seed0);
        let elevation = VulcanusElevation::new(&ctx, &helpers, &cracks, &biomes, &climate);

        for k in 0..40 {
            let (x, y) = (f64::from(k) * 37.5 - 700.0, f64::from(k) * 29.25 - 500.0);
            let f = elevation.eval(x, y);
            assert!(f.elevation >= -500.0);
            assert_eq!(f.elevation, f.elev.max(-500.0));
        }
    }

    /// `min(a, a)` is the identity, so the ashlands surface is the single basis
    /// call plus 300. Asserted so that collapsing the duplicate later is a
    /// deliberate act rather than an accident.
    #[test]
    fn the_ashlands_min_of_identical_calls_is_the_call_itself() {
        let ctx = EvalCtx::new(123_456);
        let helpers = VulcanusHelpers::new(&ctx);
        let cracks = VulcanusCracks::new(&helpers);
        let spawn = VulcanusSpawn::with_host_trig(&ctx);
        let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
        let climate = VulcanusClimate::new(ctx.seed0);
        let elevation = VulcanusElevation::new(&ctx, &helpers, &cracks, &biomes, &climate);

        for k in 0..20 {
            let (x, y) = (f64::from(k) * 51.5, f64::from(k) * -33.25);
            let single = elevation.ashlands_basis.eval(x, y);
            assert_eq!(elevation.ashlands_func(x, y), 300.0 + 0.001 * single);
        }
    }
}
