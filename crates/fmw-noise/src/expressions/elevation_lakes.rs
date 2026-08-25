//! `elevation_lakes` and `elevation_island`, ported from
//! `src/noise/expressions/elevationLakes.ts` and `elevationIsland.ts`.
//!
//! Two halves, both from `core/prototypes/noise-programs.lua`:
//! `make_0_12like_lakes` builds a variable-persistence elevation, and
//! `finish_elevation` cuts it down with the starting-lake terms. They are the
//! non-Nauvis map types - "lakes" is the 0.12-era generator and "island" is the
//! same tree with one constant changed.
//!
//! ## `elevation_island` is this tree with two parameters moved
//!
//! `bias = -1000` and `segmentation_multiplier / 4`. It gets no module of its
//! own because it is not a different expression, and giving it one would invite
//! the two to drift. [`ElevationLakesParams::to_island`] applies both.
//!
//! ## The two `20`s are NOT the same constant, and at `elevation_lakes` they coincide
//!
//! Branch 1 of `make_0_12like_lakes` is `bias + varPers1`, and branch 2 is
//! `20 + water_level - ... + varPers2`. That `20` is a program literal, not the
//! `bias` parameter. At `elevation_lakes` the bias is also 20, so a port that
//! confused them would agree with the game at every position this fixture
//! offers.
//!
//! `elevation_island` is what separates them - it sets `bias = -1000` while
//! branch 2 keeps its own 20 - and that is why the island fixture is graded
//! here rather than treated as a duplicate of the lakes one.
//!
//! ## No poison hook, and that is measured rather than an oversight
//!
//! Every field in this tree composes `basis_noise` and inherits its hook. The
//! same question was settled at `expressions::nauvis_shared::NauvisShared::cliff_ringbreak`
//! by planting: deleting that layer's own `poison::f64_result` left its tier-1
//! test red anyway. There is no path to any value here that avoids
//! `basis_noise`, so a hook on this layer could not be given an independent
//! control by any test in the crate, and one is not added just to look
//! symmetrical.

use crate::basis_noise::{tables_from_seed, BasisNoiseTables};
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{clamp, max2, min};
use crate::eval::primitives::{basis_noise_expr, BasisExprParams};
use crate::quick_multioctave_noise::{
    quick_persistence_terms, sum_octaves as quick_sum_octaves, QuickOctaves, QuickPersistenceParams,
};
use crate::starting_lakes::starting_lake_positions;
use crate::variable_persistence_multioctave_noise::{
    amplitude_corrected_multioctave_noise, eval as var_pers_eval, terms as var_pers_terms,
    AmplitudeCorrectedParams, VariablePersistenceParams, VariablePersistenceTerms,
};

/// `make_0_12like_lakes`'s `terrain_octaves`.
const TERRAIN_OCTAVES: u32 = 8;
/// Branch 2's own additive literal. See the module note - this is NOT `bias`.
const BRANCH_2_LITERAL: f64 = 20.0;
/// `elevation_island`'s bias, which collapses branch 1.
const ISLAND_BIAS: f64 = -1000.0;
/// `elevation_island` divides the user's segmentation by this.
const ISLAND_SEGMENTATION_DIVISOR: f64 = 4.0;
/// `starting_lake_distance` is capped; beyond this the near-spawn terms are inert.
const STARTING_LAKE_DISTANCE_CAP: f64 = 1024.0;

/// Free variables of the tree.
#[derive(Clone, Debug)]
pub struct ElevationLakesParams {
    /// Map seed (= `map_seed` / `seed0`).
    pub seed0: u32,
    /// `10 * log2(control:water:size)`; 0 at the default.
    pub water_level: f64,
    /// `control:water:frequency`; 1 at the default.
    pub segmentation_multiplier: f64,
    /// Spawn points for `distance` (uncapped).
    pub starting_positions: Vec<Point>,
    /// Lake points for `starting_lake_distance`, capped at 1024. `None` derives
    /// the game's real positions from `(seed0, starting_positions)`; an empty
    /// vector is the far-field-only behaviour, which is a different thing.
    pub starting_lake_positions: Option<Vec<Point>>,
    /// `make_0_12like_lakes`'s branch-1 additive term. 20 at `elevation_lakes`.
    pub bias: f64,
}

impl ElevationLakesParams {
    /// `elevation_lakes` at the game's default controls, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            water_level: 0.0,
            segmentation_multiplier: 1.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            starting_lake_positions: None,
            bias: BRANCH_2_LITERAL,
        }
    }

    /// Turn these into `elevation_island`'s: bias `-1000`, segmentation
    /// quartered.
    ///
    /// Callers pass the RAW user segmentation and the divide happens here, the
    /// way `makeElevationIsland` does it - so a caller cannot accidentally
    /// apply it twice by reading the island parameters back out.
    #[must_use]
    pub fn to_island(mut self) -> Self {
        self.bias = ISLAND_BIAS;
        self.segmentation_multiplier /= ISLAND_SEGMENTATION_DIVISOR;
        self
    }

    /// `elevation_island` at the default controls.
    #[must_use]
    pub fn island(seed0: u32) -> Self {
        Self::defaults(seed0).to_island()
    }
}

/// The compiled tree, with every table and octave stack derived once.
pub struct ElevationLakes {
    water_level: f64,
    seg: f64,
    bias: f64,
    starting_positions: Vec<Point>,
    starting_lake_positions: Vec<Point>,
    /// The 8-octave branch-1 stack.
    var_pers_1: VariablePersistenceTerms,
    var_pers_1_tables: BasisNoiseTables,
    /// The 6-octave branch-2 stack.
    var_pers_2: VariablePersistenceTerms,
    var_pers_2_tables: BasisNoiseTables,
    /// The persistence FIELD's parameters. It derives its own tables per call,
    /// which is what the TypeScript does; see [`ElevationLakes::persistence`].
    persistence: AmplitudeCorrectedParams,
    basis_123: BasisExprParams,
    basis_123_tables: BasisNoiseTables,
    lake_noise: QuickOctaves,
}

impl ElevationLakes {
    #[must_use]
    pub fn new(params: &ElevationLakesParams) -> Self {
        let seed0 = params.seed0;
        let seg = params.segmentation_multiplier;
        let input_scale = seg / 2.0;
        let offset_x = 10_000.0 / seg;

        let starting_positions = params.starting_positions.clone();
        let starting_lake_positions = params
            .starting_lake_positions
            .clone()
            .unwrap_or_else(|| starting_lake_positions(seed0, &starting_positions));

        let branch_1 = VariablePersistenceParams {
            seed0,
            seed1: 1,
            octaves: TERRAIN_OCTAVES,
            input_scale,
            output_scale: 0.125,
            offset_x,
        };
        let branch_2 = VariablePersistenceParams {
            seed0,
            seed1: 2,
            octaves: 6,
            input_scale,
            output_scale: 0.125,
            offset_x,
        };

        Self {
            water_level: params.water_level,
            seg,
            bias: params.bias,
            starting_positions,
            starting_lake_positions,
            var_pers_1: var_pers_terms(&branch_1),
            var_pers_1_tables: tables_from_seed(seed0, 1),
            var_pers_2: var_pers_terms(&branch_2),
            var_pers_2_tables: tables_from_seed(seed0, 2),
            persistence: AmplitudeCorrectedParams {
                seed0,
                seed1: 1,
                // `terrain_octaves - 2`. The persistence FIELD runs two octaves
                // shallower than the stack it drives, which is in the Lua and
                // is easy to lose by reusing `TERRAIN_OCTAVES` here.
                octaves: TERRAIN_OCTAVES - 2,
                input_scale,
                offset_x,
                persistence: 0.7,
                amplitude: 0.5,
            },
            basis_123: BasisExprParams {
                seed0,
                seed1: 123,
                input_scale: 1.0 / 8.0,
                output_scale: 1.5,
                offset_x: 0.0,
            },
            basis_123_tables: tables_from_seed(seed0, 123),
            lake_noise: quick_persistence_terms(&QuickPersistenceParams {
                seed0,
                seed1: 14,
                octaves: 5,
                input_scale: 1.0 / 8.0,
                output_scale: 1.0,
                octave_input_scale_multiplier: 0.5,
                persistence: 0.75,
            }),
        }
    }

    /// The variable-persistence field both branches run at:
    /// `clamp(amplitude_corrected + 0.3, 0.1, 0.9)`.
    ///
    /// Note the result is generally NOT f32-exact, because the `+ 0.3` leaves
    /// the grid, and that is what makes the operand width of the multiply
    /// underneath observable at all. See
    /// [`crate::variable_persistence_multioctave_noise::eval`].
    fn persistence(&self, x: f64, y: f64) -> f64 {
        clamp(
            f64::from(amplitude_corrected_multioctave_noise(
                x,
                y,
                &self.persistence,
            )) + 0.3,
            0.1,
            0.9,
        )
    }

    /// `make_0_12like_lakes`.
    fn lakes(&self, x: f64, y: f64) -> f64 {
        let p = self.persistence(x, y);
        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        let branch_1 = self.bias
            + f64::from(var_pers_eval(
                x,
                y,
                p,
                &self.var_pers_1,
                &self.var_pers_1_tables,
            ));
        let branch_2 = BRANCH_2_LITERAL + self.water_level - 0.1 * self.seg * distance
            + f64::from(var_pers_eval(
                x,
                y,
                p,
                &self.var_pers_2,
                &self.var_pers_2_tables,
            ));
        max2(branch_1, branch_2)
    }

    /// `finish_elevation`: four terms, the smallest wins.
    fn finish(&self, elevation: f64, x: f64, y: f64) -> f64 {
        let sld = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_lake_positions,
            STARTING_LAKE_DISTANCE_CAP,
        ));
        let sln = f64::from(quick_sum_octaves(x, y, &self.lake_noise));
        let term_1 = (elevation - self.water_level) / self.seg;
        let term_2 =
            basis_noise_expr(x, y, &self.basis_123, &self.basis_123_tables) + sld / 4.0 - 4.0;
        let term_3 = -1.0 + (sld + sln) / 16.0;
        let term_4 = max2(2.0, 2.0 + sld / 16.0 + sln / 2.0);
        // Argument order kept as the TypeScript writes it: `min` folds left and
        // signed zero is reachable, so reordering is not a no-op (#224).
        min(&[term_1, term_2, term_3, term_4])
    }

    /// Evaluate the tree at one point.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f64 {
        self.finish(self.lakes(x, y), x, y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_island_bias_collapses_branch_one_without_touching_branch_twos_literal() {
        // The two constants coincide at `elevation_lakes`, so this is the only
        // place the port can say it kept them apart. With `bias = -1000` branch
        // 1 is ~1020 below branch 2 and can never win the `max`, so the tree
        // must equal what it would be with branch 1 removed entirely - while
        // `elevation_lakes` at the same points must NOT.
        let island = ElevationLakes::new(&ElevationLakesParams::island(123_456));
        let lakes = ElevationLakes::new(&ElevationLakesParams::defaults(123_456));
        let mut branch_2_wins = 0usize;
        let mut differ_from_lakes = 0usize;
        for i in 0i32..64 {
            let (x, y) = (f64::from(i) * 97.5, f64::from(i) * -53.25);
            let p = island.persistence(x, y);
            let b1 = island.bias
                + f64::from(var_pers_eval(
                    x,
                    y,
                    p,
                    &island.var_pers_1,
                    &island.var_pers_1_tables,
                ));
            let b2 = island.lakes(x, y);
            if b2 > b1 {
                branch_2_wins += 1;
            }
            if island.eval(x, y) != lakes.eval(x, y) {
                differ_from_lakes += 1;
            }
        }
        assert_eq!(
            branch_2_wins, 64,
            "branch 1 won somewhere under the island bias"
        );

        // 62 of the 64, not all of them. `finish_elevation` is a `min` of four
        // terms and only ONE of them reads the lakes branch, so wherever the
        // starting-lake terms are already the smallest the two trees return the
        // same number no matter what the bias was. Frozen at the measured
        // split rather than asserted as "all differ", which is false, or as
        // "some differ", which a port ignoring `bias` entirely could also pass.
        assert_eq!(differ_from_lakes, 62, "island and lakes differ");
    }

    #[test]
    fn the_persistence_field_runs_two_octaves_shallower_than_the_stack_it_drives() {
        // `terrain_octaves - 2`. Reusing `TERRAIN_OCTAVES` here is a one-token
        // slip that produces a plausible field, so it is pinned.
        let lakes = ElevationLakes::new(&ElevationLakesParams::defaults(123_456));
        assert_eq!(lakes.persistence.octaves, TERRAIN_OCTAVES - 2);
        assert_eq!(lakes.persistence.octaves, 6);
    }

    #[test]
    fn the_persistence_field_saturates_its_lower_clamp_and_never_its_upper() {
        // A clamp nothing saturates is a clamp no test is grading.
        let lakes = ElevationLakes::new(&ElevationLakesParams::defaults(123_456));
        let (mut lo, mut hi) = (0usize, 0usize);
        for i in -30i32..30 {
            for j in -30i32..30 {
                let p = lakes.persistence(f64::from(i) * 23.5, f64::from(j) * 29.25);
                assert!((0.1..=0.9).contains(&p), "persistence {p} out of range");
                if p == 0.1 {
                    lo += 1;
                }
                if p == 0.9 {
                    hi += 1;
                }
            }
        }
        // Only the LOWER bound is reachable, and that is a property of the
        // expression rather than of this grid: `amplitude` is 0.5, so the
        // corrected field spans roughly +/-0.25 and `+ 0.3` puts it near
        // [0.05, 0.55] - a long way under 0.9. Frozen both ways, because a test
        // that only asserted "it saturates somewhere" would pass with the upper
        // bound written as any number above 0.55.
        assert_eq!(lo, 430, "positions clamped to the lower bound");
        assert_eq!(hi, 0, "the upper bound is unreachable at amplitude 0.5");
    }

    #[test]
    fn the_computed_starting_lakes_are_used_when_none_are_supplied() {
        // `None` means "derive the game's real lake", and an empty vector means
        // "no lake at all". Those are different trees near spawn, and the
        // difference is the whole near-spawn band of the fixture.
        let derived = ElevationLakes::new(&ElevationLakesParams::defaults(123_456));
        assert_eq!(
            derived.starting_lake_positions,
            vec![Point { x: 45.0, y: -59.0 }]
        );

        let mut empty = ElevationLakesParams::defaults(123_456);
        empty.starting_lake_positions = Some(Vec::new());
        let none = ElevationLakes::new(&empty);
        assert_ne!(derived.eval(11.5, 0.25), none.eval(11.5, 0.25));
    }
}
