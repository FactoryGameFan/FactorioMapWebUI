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

use crate::distance_from_nearest_point::Point;
use crate::expressions::elevation_lakes::{ElevationLakes, ElevationLakesParams};
use crate::expressions::elevation_nauvis::{ElevationNauvis, ElevationNauvisParams};
use crate::expressions::nauvis_climate::{
    Aux, AuxParams, Moisture, MoistureParams, Temperature, TemperatureParams,
};
use crate::expressions::nauvis_shared::{NauvisShared, NauvisSharedParams};
use crate::tiles::nauvis_catalog::{NauvisTileCatalog, NauvisTileFields, TILE_ORDER};

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
pub struct NauvisParity<'a> {
    stack: &'a NauvisStack,
    tiles: NauvisTileCatalog,
}

impl<'a> NauvisParity<'a> {
    /// How many named fields [`Self::field`] can select, `0..FIELD_COUNT`.
    ///
    /// The order is the order the chain evaluates in: the sixteen expression
    /// fields [`NauvisStack::field`] selects, then the 21 tile probabilities in
    /// `TILE_ORDER`, then the argmax over them.
    pub const FIELD_COUNT: u32 = NauvisStack::FIELD_COUNT + 21 + 1;

    #[must_use]
    pub fn new(stack: &'a NauvisStack, seed0: u32) -> Self {
        Self {
            stack,
            tiles: NauvisTileCatalog::new(seed0),
        }
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
        let i = (field - NauvisStack::FIELD_COUNT) as usize;
        let probabilities = self.tiles.probabilities(&f);
        if i < probabilities.len() {
            return probabilities[i];
        }
        // Out of range resolves to the argmax, matching the exhaustive `match`
        // this was lifted from.
        let winner = self.tiles.resolve(&f);
        TILE_ORDER
            .iter()
            .position(|t| *t == winner)
            .expect("resolve returns a tile from TILE_ORDER") as f64
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
