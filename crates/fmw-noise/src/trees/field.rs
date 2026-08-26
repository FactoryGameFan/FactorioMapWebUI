//! The 15 tree species' probability expressions and the per-pixel density,
//! ported from `src/noise/trees/treeField.ts`.
//!
//! ## TWO structs, and that is ownership rather than taste
//!
//! [`TreeShared`] BORROWS a [`NauvisShared`], mirroring the TypeScript's
//! optional second parameter - `treeField` already has a shared layer and the
//! render path already has one, so a third copy would be waste. One struct
//! owning both would then be self-referential, so this splits at the first
//! borrow exactly as `vulcanus_stack` does: [`TreeBase`] owns its data,
//! [`TreeFields`] borrows it.
//!
//! ```no_run
//! # use fmw_noise::trees::field::{TreeBase, TreeFieldParams, TreeFields};
//! let base = TreeBase::new(&TreeFieldParams::defaults(123_456));
//! let fields = TreeFields::new(&base);
//! let density = fields.density(0.5, 0.25);
//! ```
//!
//! ## This layer narrows nothing
//!
//! `src/noise/trees/` contains no `f32` call at all. Every narrowing happens
//! inside the primitives it calls - `multioctave_noise`, `moisture`,
//! `temperature`, `distance_from_nearest_point` and `fast_pow` - and the
//! layer's own arithmetic is f64. Same asymmetry as `resources::resource_math`,
//! and the same rule: preserve it, do not harmonise it.

use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{clamp, min, min2};
use crate::expressions::nauvis_climate::{
    Moisture, MoistureParams, Temperature, TemperatureParams,
};
use crate::expressions::nauvis_shared::{NauvisShared, NauvisSharedParams};
use crate::fast_approx::fast_pow;
use crate::multioctave_noise::{MultioctaveParams, Prepared};

use super::asymmetric_ramps::asymmetric_ramps;
use super::catalog::{TreeSpecies, TREE_SPECIES};
use super::shared::TreeShared;

/// A conservative upper bound on `|basis_noise|`, used to bound each species'
/// noise term so the density max can skip octaves that cannot win.
///
/// **A MEASURED maximum plus a safety margin, not an analytic bound** - the
/// basis range is not a clean +/-sqrt(3), see `docs/noise/basis-noise-NOTES.md`.
/// `the_noise_bound_holds_under_hard_sampling` and
/// `the_early_out_is_bit_identical_to_a_naive_max` are what make a wrong value
/// fail loudly instead of silently clipping forests.
pub const BASIS_ABS_MAX: f64 = 1.8;

/// Every species' own noise term uses these. Shared with [`max_noise_for`] so
/// the early-out bound cannot desync from the noise it bounds.
const TREE_OCTAVES: f64 = 3.0;
const TREE_PERSISTENCE: f64 = 0.65;

/// Everything the tree layer reads.
#[derive(Clone, Debug)]
pub struct TreeFieldParams {
    pub seed0: u32,
    /// `control:trees:frequency`.
    pub trees_frequency: f64,
    /// `control:trees:size`.
    pub trees_size: f64,
    /// `control:water:frequency`.
    pub segmentation_multiplier: f64,
    pub moisture_frequency: f64,
    pub moisture_bias: f64,
    /// `control:temperature:frequency` / `:bias`.
    ///
    /// The app has no UI for these, but `climateReads` parses them out of an
    /// imported exchange string's `property_expression_names`, and **trees are
    /// the only consumer of `temperature`** - so dropping them here silently
    /// renders the wrong forest layout.
    pub temperature_frequency: f64,
    pub temperature_bias: f64,
    pub starting_area_moisture_size: f64,
    pub starting_area_moisture_frequency: f64,
    pub starting_positions: Vec<Point>,
}

impl TreeFieldParams {
    /// The game's default controls at one seed, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            trees_frequency: 1.0,
            trees_size: 1.0,
            segmentation_multiplier: 1.0,
            moisture_frequency: 1.0,
            moisture_bias: 0.0,
            temperature_frequency: 1.0,
            temperature_bias: 0.0,
            starting_area_moisture_size: 1.0,
            starting_area_moisture_frequency: 1.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
        }
    }
}

/// Everything the tree layer owns: the climate stack and the shared sub-tree.
pub struct TreeBase {
    pub shared: NauvisShared,
    pub temperature: Temperature,
    pub moisture: Moisture,
    seed0: u32,
    trees_frequency: f64,
    trees_size: f64,
    starting_positions: Vec<Point>,
}

impl TreeBase {
    #[must_use]
    pub fn new(params: &TreeFieldParams) -> Self {
        Self {
            shared: NauvisShared::new(&NauvisSharedParams {
                seed0: params.seed0,
                segmentation_multiplier: params.segmentation_multiplier,
            }),
            temperature: Temperature::new(&TemperatureParams {
                seed0: params.seed0,
                frequency: params.temperature_frequency,
                bias: params.temperature_bias,
            }),
            moisture: Moisture::new(&MoistureParams {
                seed0: params.seed0,
                segmentation_multiplier: params.segmentation_multiplier,
                moisture_frequency: params.moisture_frequency,
                moisture_bias: params.moisture_bias,
                starting_area_moisture_size: params.starting_area_moisture_size,
                starting_area_moisture_frequency: params.starting_area_moisture_frequency,
                starting_positions: params.starting_positions.clone(),
            }),
            seed0: params.seed0,
            trees_frequency: params.trees_frequency,
            trees_size: params.trees_size,
            starting_positions: params.starting_positions.clone(),
        }
    }
}

/// One species' compiled field.
pub struct SpeciesField {
    pub species: &'static TreeSpecies,
    noise: Prepared,
    /// `-size_offset + 0.2 * control:trees:size`, hoisted per species because
    /// it is constant per render - the TypeScript hoists it in the same place.
    size_term: f64,
    /// The largest magnitude this species' noise term can reach.
    pub max_noise: f64,
}

impl SpeciesField {
    /// The species value minus its own noise term, from the per-pixel terms.
    ///
    /// **The four addends are in a load-bearing ORDER.** Float addition is not
    /// associative and the density path below has to stay bit-identical to
    /// [`Self::eval_at`], so keep `climate + distance + size + small`.
    #[must_use]
    pub fn cheap_from(
        &self,
        temperature: f64,
        moisture: f64,
        distance_term: f64,
        small_term: f64,
    ) -> f64 {
        // Three-argument min, the literal 0 first and temperature before
        // moisture, as the TypeScript writes it.
        let climate = min(&[
            0.0,
            asymmetric_ramps(
                temperature,
                self.species.temp_ramp[0],
                self.species.temp_ramp[1],
                self.species.temp_ramp[2],
                self.species.temp_ramp[3],
            ),
            asymmetric_ramps(
                moisture,
                self.species.moist_ramp[0],
                self.species.moist_ramp[1],
                self.species.moist_ramp[2],
                self.species.moist_ramp[3],
            ),
        ]);
        climate + distance_term + self.size_term + small_term
    }

    /// This species' own noise term.
    #[must_use]
    pub fn noise_at(&self, x: f64, y: f64) -> f64 {
        f64::from(self.noise.eval(x, y))
    }
}

/// `|multioctave_noise|` cannot exceed `output_scale * (sum of octave
/// amplitudes) * BASIS_ABS_MAX`.
///
/// With octaves 3 and persistence 0.65 the amplitudes are `norm * (1, 1/P,
/// 1/P^2)`, where `norm` is the RMS normalisation `multioctave_noise` applies.
///
/// **`fast_pow`, NOT `powi` or `powf`.** `multioctave_noise` normalises with the
/// game's fastapprox pow, so a bound computed with an exact pow is not a bound.
#[must_use]
pub fn max_noise_for(species: &TreeSpecies) -> f64 {
    let p = TREE_PERSISTENCE;
    let inv_p2 = 1.0 / (p * p);
    let norm =
        ((inv_p2 - 1.0) / (f64::from(fast_pow(inv_p2 as f32, TREE_OCTAVES as f32)) - 1.0)).sqrt();
    let mut amps = 0.0;
    let mut amp = norm;
    let mut k = 0.0;
    while k < TREE_OCTAVES {
        amps += amp;
        amp /= p;
        k += 1.0;
    }
    species.output_scale * amps * BASIS_ABS_MAX
}

/// The 15 compiled species plus the shared fields they read.
pub struct TreeFields<'a> {
    base: &'a TreeBase,
    tree_shared: TreeShared<'a>,
    pub species: Vec<SpeciesField>,
}

impl<'a> TreeFields<'a> {
    #[must_use]
    pub fn new(base: &'a TreeBase) -> Self {
        let species = TREE_SPECIES
            .iter()
            .map(|s| SpeciesField {
                species: s,
                noise: Prepared::new(&MultioctaveParams {
                    seed0: base.seed0,
                    seed1: s.seed1,
                    octaves: TREE_OCTAVES,
                    persistence: TREE_PERSISTENCE,
                    input_scale: (1.0 / s.input_scale_div) * base.trees_frequency,
                    output_scale: s.output_scale,
                }),
                size_term: -s.size_offset + 0.2 * base.trees_size,
                max_noise: max_noise_for(s),
            })
            .collect();
        Self {
            base,
            tree_shared: TreeShared::new(base.seed0, &base.shared),
            species,
        }
    }

    /// The shared sub-tree, for a caller grading `tree_small_noise` or
    /// `trees_forest_path_cutout_faded` directly.
    #[must_use]
    pub fn shared(&self) -> &TreeShared<'a> {
        &self.tree_shared
    }

    fn distance_term(&self, x: f64, y: f64) -> f64 {
        // The literal 0 first, as written.
        min2(
            0.0,
            f64::from(distance_from_nearest_point(
                x,
                y,
                &self.base.starting_positions,
                f64::INFINITY,
            )) / 20.0
                - 3.0,
        )
    }

    /// One species' full probability at `(x, y)`.
    #[must_use]
    pub fn eval_at(&self, index: usize, x: f64, y: f64) -> f64 {
        let f = &self.species[index];
        let cheap = f.cheap_from(
            self.base.temperature.eval(x, y),
            self.base.moisture.eval(x, y),
            self.distance_term(x, y),
            self.tree_shared.small_noise(x, y) * 0.1,
        );
        // Three-argument min, cap first - written as one `min` rather than
        // nested `min2`, matching the TypeScript's `Math.min(a, b, c)`.
        min(&[
            f.species.cap,
            self.tree_shared.forest_path_cutout_faded(x, y),
            cheap + f.noise_at(x, y),
        ])
    }

    /// The per-pixel tree density: `clamp(max_i p_i, 0, 1)`.
    ///
    /// **`max` is not an approximation.** The game's
    /// `EntityMapGenerationTask::generateEntities` arbitrates one winning entity
    /// per tile by MAX probability and then rolls once against it, so
    /// `max_i p_i` is exactly the probability the game rolls on a tile where a
    /// tree wins. See `docs/noise/placement-roll-NOTES.md`.
    ///
    /// Three things here are performance decisions with correctness
    /// consequences, and all three are ported rather than simplified:
    ///
    /// 1. **The climate stack is evaluated ONCE per pixel**, not once per
    ///    species. It costs more than the three-octave species noise the
    ///    early-out saves, so computing it per species dominated the whole
    ///    render before this shape.
    /// 2. **`cutout_faded` is inlined and DEFERRED**, so it reuses `small_term`
    ///    rather than re-evaluating `tree_small_noise`, and pixels where every
    ///    species is skipped never pay for the billows.
    /// 3. **The early-out must be bit-identical** to a naive max over
    ///    [`Self::eval_at`], which is why the addend order in
    ///    [`SpeciesField::cheap_from`] is fixed.
    #[must_use]
    pub fn density(&self, x: f64, y: f64) -> f64 {
        let t = self.base.temperature.eval(x, y);
        let m = self.base.moisture.eval(x, y);
        let distance_term = self.distance_term(x, y);
        let small_term = self.tree_shared.small_noise(x, y) * 0.1;

        let mut cutout_faded = 0.0;
        let mut have_cutout = false;
        let mut best = 0.0;

        for f in &self.species {
            // `cap` and the cutout both bound the species from above, as does
            // `cheap + max_noise`. If none can beat `best`, the three-octave
            // noise cannot change the answer. Catalog order - descending cap -
            // raises `best` early, which is what makes this fire often.
            if f.species.cap <= best {
                continue;
            }
            let cheap = f.cheap_from(t, m, distance_term, small_term);
            if cheap + f.max_noise <= best {
                continue;
            }
            if !have_cutout {
                cutout_faded = self.tree_shared.forest_path_cutout(x, y) * 0.3 + small_term;
                have_cutout = true;
            }
            let v = min(&[f.species.cap, cutout_faded, cheap + f.noise_at(x, y)]);
            // NOT `max2`: the strict `>` keeps `best` on a NaN or a tie.
            if v > best {
                best = v;
            }
        }
        clamp(best, 0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn built(params: &TreeFieldParams) -> TreeBase {
        TreeBase::new(params)
    }

    #[test]
    fn the_early_out_is_bit_identical_to_a_naive_max() {
        // The property the whole density path rests on. `treeFieldEarlyOut.spec.ts`
        // asserts the same thing on the TypeScript side; measured there over the
        // same grid, the two agree at 3,600 of 3,600 points.
        let base = built(&TreeFieldParams::defaults(123_456));
        let fields = TreeFields::new(&base);
        let mut non_zero = 0;
        for i in 0..60 {
            for j in 0..60 {
                let x = f64::from(i) * 13.5 - 400.0;
                let y = f64::from(j) * 11.25 - 400.0;
                let mut best = 0.0f64;
                for k in 0..fields.species.len() {
                    let v = fields.eval_at(k, x, y);
                    if v > best {
                        best = v;
                    }
                }
                let naive = clamp(best, 0.0, 1.0);
                let got = fields.density(x, y);
                assert_eq!(got, naive, "at ({x}, {y})");
                if got > 0.0 {
                    non_zero += 1;
                }
            }
        }
        // Anti-vacuity: a grid where every species is skipped everywhere would
        // satisfy the above with 3,600 zeros.
        assert_eq!(non_zero, 1081, "non-zero density points");
    }

    #[test]
    fn the_noise_bound_holds_under_hard_sampling() {
        // `BASIS_ABS_MAX` is measured, not analytic, so the bound it produces
        // has to be checked against the noise it bounds. If it were too small
        // the early-out would clip forests silently.
        let base = built(&TreeFieldParams::defaults(123_456));
        let fields = TreeFields::new(&base);
        let mut worst_ratio = 0.0f64;
        for f in &fields.species {
            for i in 0..300 {
                let x = f64::from(i) * 17.3 - 2000.0;
                let y = f64::from(i) * -9.7 + 1500.0;
                let n = f.noise_at(x, y).abs();
                assert!(
                    n <= f.max_noise,
                    "{} noise {n} over {}",
                    f.species.name,
                    f.max_noise
                );
                worst_ratio = worst_ratio.max(n / f.max_noise);
            }
        }
        // And it is not absurdly loose - a bound of 1e9 would also "hold".
        assert!(
            worst_ratio > 0.3,
            "the bound is vacuous: worst ratio {worst_ratio}"
        );
    }

    #[test]
    fn the_bound_uses_the_fastapprox_pow_and_not_an_exact_one() {
        // `multioctave_noise` normalises with the game's fastapprox pow, so a
        // bound computed with an exact pow is not a bound. Pinned as a
        // disagreement, so swapping in `powf` turns this red.
        let p = TREE_PERSISTENCE;
        let inv_p2 = 1.0 / (p * p);
        let fast = f64::from(fast_pow(inv_p2 as f32, TREE_OCTAVES as f32));
        let exact = inv_p2.powf(TREE_OCTAVES);
        assert_ne!(fast, exact);
        let species = &TREE_SPECIES[0];
        let with_exact = {
            let norm = ((inv_p2 - 1.0) / (exact - 1.0)).sqrt();
            let mut amps = 0.0;
            let mut amp = norm;
            for _ in 0..3 {
                amps += amp;
                amp /= p;
            }
            species.output_scale * amps * BASIS_ABS_MAX
        };
        assert_ne!(max_noise_for(species), with_exact);
    }

    #[test]
    fn the_cheap_addend_order_is_load_bearing() {
        // Float addition is not associative, and the early-out's bit-identity
        // depends on `cheap_from` producing exactly what `eval_at` uses. A
        // reordering that looks equivalent is not.
        let base = built(&TreeFieldParams::defaults(123_456));
        let fields = TreeFields::new(&base);
        let f = &fields.species[0];
        let (t, m, d, s) = (11.5, 0.65, -1.25, 0.037_5);
        let climate = min(&[
            0.0,
            asymmetric_ramps(
                t,
                f.species.temp_ramp[0],
                f.species.temp_ramp[1],
                f.species.temp_ramp[2],
                f.species.temp_ramp[3],
            ),
            asymmetric_ramps(
                m,
                f.species.moist_ramp[0],
                f.species.moist_ramp[1],
                f.species.moist_ramp[2],
                f.species.moist_ramp[3],
            ),
        ]);
        assert_eq!(f.cheap_from(t, m, d, s), climate + d + f.size_term + s);
        // A different association really does differ somewhere - swept, because
        // any single point may agree by luck.
        let differs = (0..500).any(|i| {
            let dd = f64::from(i) * -0.007_3;
            let ss = f64::from(i) * 0.001_1;
            f.cheap_from(t, m, dd, ss) != climate + (dd + (f.size_term + ss))
        });
        assert!(
            differs,
            "no association difference found, so this is vacuous"
        );
    }

    #[test]
    fn every_control_reaches_the_field_it_belongs_to() {
        // Both fixtures run at one control setting each, so a lever dropped
        // between the params and a primitive would be nearly invisible to
        // tier 1. Each is moved on its own.
        // SWEPT, not checked at one point, and that is not caution: a species
        // value is a three-way `min`, so a lever only shows where the term it
        // feeds is the one winning. Checked at (211.5, -88.25) first, where
        // segmentation is genuinely inert because neither the cutout nor the
        // moisture ramp is the minimum there.
        let b0 = built(&TreeFieldParams::defaults(123_456));
        let f0 = TreeFields::new(&b0);

        let moves_something = |f: &dyn Fn(&mut TreeFieldParams)| -> bool {
            let mut p = TreeFieldParams::defaults(123_456);
            f(&mut p);
            let base = TreeBase::new(&p);
            let fields = TreeFields::new(&base);
            // The sweep runs from (-60, 60) out to (416, -416), which passes
            // within 60 tiles of BOTH the origin spawn and the moved one at
            // (400, -400). That is deliberate: `starting_positions` reaches
            // only `min(0, distance/20 - 3)`, which is flat 0 beyond 60 tiles,
            // and the starting-area moisture terms are inert at the degenerate
            // default size of 1. A sweep in the far field cannot see it move.
            (0..120).any(|i| {
                let x = f64::from(i) * 4.0 - 60.0;
                let y = f64::from(i) * -4.0 + 60.0;
                (0..TREE_SPECIES.len()).any(|k| fields.eval_at(k, x, y) != f0.eval_at(k, x, y))
            })
        };
        assert!(
            moves_something(&|p| p.trees_frequency = 3.0),
            "trees frequency"
        );
        assert!(moves_something(&|p| p.trees_size = 2.0), "trees size");
        assert!(
            moves_something(&|p| p.segmentation_multiplier = 2.0),
            "segmentation"
        );
        assert!(
            moves_something(&|p| p.moisture_frequency = 3.0),
            "moisture frequency"
        );
        assert!(moves_something(&|p| p.moisture_bias = 0.2), "moisture bias");
        assert!(
            moves_something(&|p| p.temperature_frequency = 4.0),
            "temperature frequency"
        );
        assert!(
            moves_something(&|p| p.temperature_bias = 7.0),
            "temperature bias"
        );
        assert!(
            moves_something(&|p| p.starting_positions = vec![Point {
                x: 400.0,
                y: -400.0
            }]),
            "starting positions"
        );
        // Anti-vacuity: the sweep must not report a difference for a change
        // that is not one.
        assert!(
            !moves_something(&|_p| {}),
            "the sweep reports a difference with no change"
        );
    }

    #[test]
    fn trees_size_is_a_flat_additive_term_and_moves_every_species_the_same_way() {
        // `-size_offset + 0.2 * control:trees:size`. A lever wired into the
        // noise instead of the constant would still change the field, so
        // "it moved" is not enough - the SHAPE of the move is the check.
        let mut bigger = TreeFieldParams::defaults(123_456);
        bigger.trees_size = 2.0;
        let b0 = built(&TreeFieldParams::defaults(123_456));
        let b1 = built(&bigger);
        let f0 = TreeFields::new(&b0);
        let f1 = TreeFields::new(&b1);
        for (k, species) in TREE_SPECIES.iter().enumerate() {
            assert_eq!(
                f1.species[k].size_term - f0.species[k].size_term,
                0.2,
                "{}",
                species.name
            );
            // The noise term is untouched by the size lever.
            assert_eq!(
                f0.species[k].noise_at(311.5, -177.25),
                f1.species[k].noise_at(311.5, -177.25),
                "{} noise",
                species.name
            );
        }
    }

    #[test]
    fn the_density_is_clamped_into_zero_to_one_and_reaches_both_ends() {
        let base = built(&TreeFieldParams::defaults(123_456));
        let fields = TreeFields::new(&base);
        let mut zeros = 0;
        let mut positive = 0;
        for i in 0..80 {
            for j in 0..80 {
                let d = fields.density(f64::from(i) * 9.5 - 300.0, f64::from(j) * 8.25 - 300.0);
                assert!((0.0..=1.0).contains(&d), "density {d} out of range");
                if d == 0.0 {
                    zeros += 1;
                } else {
                    positive += 1;
                }
            }
        }
        assert!(
            zeros > 0 && positive > 0,
            "zeros {zeros}, positive {positive}"
        );
    }

    #[test]
    fn the_species_cap_really_caps() {
        // Every species is bounded by its own `cap`, which is the leading term
        // of the min. A cap read from the wrong row would be invisible in the
        // density (the max hides it) but not here.
        let base = built(&TreeFieldParams::defaults(123_456));
        let fields = TreeFields::new(&base);
        for k in 0..fields.species.len() {
            for i in 0..100 {
                let x = f64::from(i) * 11.5 - 400.0;
                let v = fields.eval_at(k, x, 63.25);
                assert!(
                    v <= fields.species[k].species.cap,
                    "{} exceeded its cap: {v}",
                    fields.species[k].species.name
                );
            }
        }
    }
}
