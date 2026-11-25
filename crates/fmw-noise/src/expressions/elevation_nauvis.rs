//! `elevation_nauvis`, ported from `src/noise/expressions/elevationNauvis.ts`.
//!
//! `elevation_nauvis_function(nauvis_hills_plateaus)` from
//! `core/prototypes/noise-programs.lua`: a bridge/macro/detail mix lifted by
//! the shared layer's plateaus, then cut by the starting-lake term.
//!
//! ## `nauvis_seg` and `seg` are BOTH live, and only one node uses the plain one
//!
//! Every noise sub-node scales by `nauvis_segmentation_multiplier`
//! (`1.5 * control:water:frequency`), which is what
//! [`crate::expressions::nauvis_shared`] holds. The single exception is
//! `starting_island`'s distance falloff, which uses the RAW segmentation. The
//! two differ by a factor of 1.5 at every setting including the default, so
//! routing the wrong one into that term is not a no-op anywhere - and it is a
//! change no fixture-free reading of the code would flag, because both names
//! are in scope at the call site.
//!
//! ## `offset_x` belongs to two nodes, not to the shared layer
//!
//! `10000 / nauvis_seg` is carried by the `detail` stack and the `persistance`
//! field only. The shared layer takes none, which its own module says at
//! length.
//!
//! ## Every step is f32, and `offset_x` is rounded BEFORE it meets `x`
//!
//! The game evaluates the tree one f32 operation at a time, literals
//! included, and each step here goes through [`f32r`] in the order the Lua
//! writes it (#452). One constant needs saying on its own: `offset_x =
//! 10000 / nauvis_seg` is 6666.67 at the default, which is not an f32. The
//! game holds it as an f32 constant, so `x + offset_x` adds the ROUNDED
//! value; adding the f64 value and rounding the sum lands on a different
//! point. Measured on the 26-point fixture: the offset alone takes the tree
//! from 8 to 10, the f32 steps alone to 19, and the two together to 26.
//! `elevation_lakes` uses `10000 / 1`, which is exact, which is why only
//! Nauvis showed it.
//!
//! ## `nauvis_persistance` uses the game's amplitude-corrected form (#521)
//!
//! The persistence field is `amplitude_corrected_multioctave_noise`, and its
//! shipped f64 transform is 81 of 152 against the game (#254). Nauvis reads
//! [`AmplitudeCorrectedGame`], the f32 form that is 152 of 152. At the one point
//! `elevation_nauvis_no_cliff` used to miss, the shipped form's noise was two
//! f32 steps off (0.090559684 against the game's 0.0905597). That reached the
//! detail stack and moved the result by about a third of an f32 step, enough to
//! flip a rounding where the answer is small (4.35) and invisible where it is
//! large (the full tree gives 22.1 there). It was not the `lerp`: fed the
//! game's own `t` and `nauvis_detail`, our `lerp` and `nauvis_main` match the
//! game bit for bit.
//!
//! ## `elevation_nauvis_no_cliff` is a real expression
//!
//! `elevation_nauvis_function(0)`, i.e. `added_cliff_elevation` forced to zero.
//! `cliff_elevation_nauvis` depends on it, so it is not a debugging switch, and
//! it is graded against its own two-seed fixture.

use crate::at::At;
use crate::basis_noise::{tables_from_seed, BasisNoiseTables};
use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};
use crate::eval::math::{clamp, f32r, lerp_f32, max2, min2};
use crate::expressions::nauvis_shared::{NauvisShared, NauvisSharedParams};
use crate::multioctave_noise::{MultioctaveParams, Prepared};
use crate::quick_multioctave_noise::{
    quick_persistence_terms, sum_octaves_at as quick_sum_octaves_at, QuickOctaves,
    QuickPersistenceParams,
};
use crate::starting_lakes::starting_lake_positions;
use crate::variable_persistence_multioctave_noise::{
    eval_at as var_pers_eval_at, terms as var_pers_terms,
    AmplitudeCorrectedGame, AmplitudeCorrectedParams, VariablePersistenceParams,
    VariablePersistenceTerms,
};

/// `elevation_magnitude` in the Lua.
const ELEVATION_MAGNITUDE: f64 = 20.0;
/// `starting_lake_distance`'s cap.
const STARTING_LAKE_DISTANCE_CAP: f64 = 1024.0;

/// Free variables of the tree.
#[derive(Clone, Debug)]
pub struct ElevationNauvisParams {
    /// Map seed (= `map_seed` / `seed0`).
    pub seed0: u32,
    /// `10 * log2(control:water:size)`; 0 at the default.
    pub water_level: f64,
    /// `control:water:frequency`; 1 at the default. The RAW control - the
    /// `1.5 *` happens inside.
    pub segmentation_multiplier: f64,
    /// Spawn points for `distance` (uncapped).
    pub starting_positions: Vec<Point>,
    /// Lake points for `starting_lake_distance`, capped at 1024. `None` derives
    /// the game's real positions.
    pub starting_lake_positions: Option<Vec<Point>>,
    /// Whether `nauvis_hills_plateaus` feeds `added_cliff_elevation`. `false`
    /// is `elevation_nauvis_no_cliff`.
    pub with_cliff_elevation: bool,
}

impl ElevationNauvisParams {
    /// The game's default controls, spawning at the origin.
    #[must_use]
    pub fn defaults(seed0: u32) -> Self {
        Self {
            seed0,
            water_level: 0.0,
            segmentation_multiplier: 1.0,
            starting_positions: vec![Point { x: 0.0, y: 0.0 }],
            starting_lake_positions: None,
            with_cliff_elevation: true,
        }
    }
}

/// The compiled tree, with every table and octave stack derived once.
pub struct ElevationNauvis {
    water_level: f64,
    /// The RAW `control:water:frequency`. Read by `starting_island` and nothing
    /// else - see the module note.
    seg: f64,
    nauvis_seg: f64,
    with_cliff_elevation: bool,
    starting_positions: Vec<Point>,
    starting_lake_positions: Vec<Point>,
    shared: NauvisShared,
    detail: VariablePersistenceTerms,
    detail_tables: BasisNoiseTables,
    persistance: AmplitudeCorrectedGame,
    /// The persistence field's `input_scale`, kept for the test that pins it.
    persistance_input_scale: f64,
    macro_a: Prepared,
    macro_b: Prepared,
    starting_lake_noise: QuickOctaves,
}

impl ElevationNauvis {
    #[must_use]
    pub fn new(params: &ElevationNauvisParams) -> Self {
        let seed0 = params.seed0;
        let seg = params.segmentation_multiplier;
        let shared = NauvisShared::new(&NauvisSharedParams {
            seed0,
            segmentation_multiplier: seg,
        });
        let nauvis_seg = shared.nauvis_seg;
        // Rounded to f32 here, before any coordinate is added to it. See the
        // module note.
        let offset_x = f32r(10_000.0 / nauvis_seg);

        let starting_positions = params.starting_positions.clone();
        let starting_lake_positions = params
            .starting_lake_positions
            .clone()
            .unwrap_or_else(|| starting_lake_positions(seed0, &starting_positions));

        let detail = VariablePersistenceParams {
            seed0,
            seed1: 600,
            octaves: 5,
            input_scale: nauvis_seg / 14.0,
            output_scale: 0.03,
            offset_x,
        };

        Self {
            water_level: f32r(params.water_level),
            seg: f32r(seg),
            nauvis_seg,
            with_cliff_elevation: params.with_cliff_elevation,
            starting_positions,
            starting_lake_positions,
            shared,
            detail: var_pers_terms(&detail),
            detail_tables: tables_from_seed(seed0, 600),
            // The game's form of `amplitude_corrected_multioctave_noise`, not
            // the shipped f64 one (see the module note).
            persistance: AmplitudeCorrectedGame::new(&AmplitudeCorrectedParams {
                seed0,
                seed1: 500,
                octaves: 5,
                // `nauvis_seg / 2`, NOT the detail stack's `nauvis_seg / 14`.
                // The persistence field is far coarser than the field it
                // drives, which is in the Lua and easy to lose by reusing the
                // neighbouring constant.
                input_scale: nauvis_seg / 2.0,
                offset_x,
                persistence: 0.7,
                amplitude: 0.5,
            }),
            persistance_input_scale: nauvis_seg / 2.0,
            macro_a: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 1000,
                octaves: 2.0,
                persistence: 0.6,
                input_scale: nauvis_seg / 1600.0,
                output_scale: 1.0,
            }),
            macro_b: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: 1100,
                octaves: 1.0,
                persistence: 0.6,
                input_scale: nauvis_seg / 1600.0,
                output_scale: 1.0,
            }),
            starting_lake_noise: quick_persistence_terms(&QuickPersistenceParams {
                seed0,
                seed1: 14,
                octaves: 4,
                input_scale: 1.0 / 8.0,
                output_scale: 0.8,
                octave_input_scale_multiplier: 0.5,
                persistence: 0.68,
            }),
        }
    }

    /// `nauvis_persistance`: `clamp(amplitude_corrected + 0.55, 0.5, 0.65)`.
    fn persistence(&self, at: At) -> f64 {
        clamp(
            f32r(
                f64::from(self.persistance.eval_at(at)) + f32r(0.55),
            ),
            f32r(0.5),
            f32r(0.65),
        )
    }

    /// Evaluate the tree at one point.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> f64 {
        self.eval_at(At::point(x, y))
    }

    /// Evaluate the tree at an [`At`]. Every noise op in it reads the raw
    /// `x`/`y` in `noise-programs.lua`, so on a tile each takes the grid path
    /// (#451); the distances and the arithmetic around them are unchanged.
    #[must_use]
    pub fn eval_at(&self, at: At) -> f64 {
        let (x, y) = (at.x(), at.y());
        let persistence = self.persistence(at);
        let nauvis_detail = f64::from(var_pers_eval_at(
            at,
            persistence,
            &self.detail,
            &self.detail_tables,
        ));

        // `nauvis_bridges`: a gentle fall, then a much steeper one past 0.1.
        let bb = self.shared.bridge_billows_at(at);
        let nauvis_bridges = f32r(
            f32r(1.0 - f32r(f32r(0.1) * bb)) - f32r(f32r(0.9) * max2(0.0, f32r(f32r(-0.1) + bb))),
        );

        // `nauvis_macro`. The second factor is half-wave rectified, so the
        // macro term is zero over roughly half the map rather than symmetric.
        let nauvis_macro = f32r(
            f64::from(self.macro_a.eval_at(at)) * max2(0.0, f64::from(self.macro_b.eval_at(at))),
        );

        let added_cliff_elevation = if self.with_cliff_elevation {
            f32r(
                f32r(f32r(0.1) * self.shared.hills_at(at))
                    + f32r(f32r(0.8) * self.shared.plateaus_at(at)),
            )
        } else {
            0.0
        };

        let distance = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_positions,
            f64::INFINITY,
        ));
        let starting_macro_multiplier =
            clamp(f32r(f32r(distance * self.nauvis_seg) / 2000.0), 0.0, 1.0);

        let ridge = lerp_f32(
            f32r(f32r(0.5 * added_cliff_elevation) - f32r(0.6)),
            f32r(f32r(f32r(1.9) * added_cliff_elevation) + f32r(1.6)),
            f32r(f32r(0.1) + f32r(0.5 * nauvis_bridges)),
        );
        let nauvis_main = f32r(
            ELEVATION_MAGNITUDE
                * f32r(
                    f32r(ridge + f32r(0.25 * nauvis_detail))
                        + f32r(f32r(3.0 * nauvis_macro) * starting_macro_multiplier),
                ),
        );

        // The one node that reads the RAW segmentation. See the module note.
        let starting_island = f32r(
            nauvis_main
                + f32r(ELEVATION_MAGNITUDE * f32r(2.5 - f32r(f32r(distance * self.seg) / 200.0))),
        );
        // `wlc_amplitude = 2`; `water_level * 2` is a folded constant.
        let wlc_elevation = max2(
            f32r(nauvis_main - f32r(self.water_level * 2.0)),
            starting_island,
        );

        let sld = f64::from(distance_from_nearest_point(
            x,
            y,
            &self.starting_lake_positions,
            STARTING_LAKE_DISTANCE_CAP,
        ));
        let sln = f64::from(quick_sum_octaves_at(at, &self.starting_lake_noise));
        let starting_lake =
            f32r(f32r(ELEVATION_MAGNITUDE * f32r(-3.0 + f32r(f32r(sld + sln) / 8.0))) / 8.0);

        min2(wlc_elevation, starting_lake)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_starting_island_term_reads_the_raw_segmentation_not_the_nauvis_one() {
        // The two differ by 1.5 at every setting, so this is reachable at the
        // DEFAULT controls rather than only under an unusual slider. Written as
        // a comparison against a tree built with `seg` pre-multiplied by 1.5:
        // if `starting_island` used `nauvis_seg`, that tree would agree with
        // this one wherever `starting_island` decides the outer `max`.
        let real = ElevationNauvis::new(&ElevationNauvisParams::defaults(123_456));
        assert_eq!(real.seg, 1.0);
        assert_eq!(real.nauvis_seg, 1.5);
        assert_ne!(real.seg, real.nauvis_seg, "the two must not collapse");

        // Somewhere the island term has to be the one that wins, or the field
        // it feeds is unreachable and the distinction is untestable.
        let mut island_wins = 0usize;
        for i in 0i32..200 {
            let d = f64::from(i) * 5.0;
            // `starting_island` beats `nauvis_main - 0` while `2.5 - d/200 > 0`,
            // i.e. within 500 tiles of spawn at the default segmentation.
            if 2.5 - (d * real.seg) / 200.0 > 0.0 {
                island_wins += 1;
            }
        }
        assert_eq!(island_wins, 100, "the island term's reach at seg = 1");
    }

    #[test]
    fn the_persistence_field_is_coarser_than_the_detail_stack_it_drives() {
        // `nauvis_seg / 2` against `nauvis_seg / 14`. Reusing one for the other
        // is a plausible-looking slip that no range check would catch.
        let tree = ElevationNauvis::new(&ElevationNauvisParams::defaults(123_456));
        assert_eq!(tree.persistance_input_scale, 1.5 / 2.0);
        assert!(
            tree.persistance_input_scale > 1.5 / 14.0,
            "the persistence field must be the coarser of the two"
        );
    }

    #[test]
    fn the_persistence_field_stays_inside_its_clamp() {
        let tree = ElevationNauvis::new(&ElevationNauvisParams::defaults(123_456));
        // The bounds are the f32 literals the game holds (#452).
        let (lo_bound, hi_bound) = (f32r(0.5), f32r(0.65));
        let (mut lo, mut hi) = (0usize, 0usize);
        for i in -30i32..30 {
            for j in -30i32..30 {
                let p = tree.persistence(At::point(f64::from(i) * 23.5, f64::from(j) * 29.25));
                assert!(
                    (lo_bound..=hi_bound).contains(&p),
                    "persistence {p} out of range"
                );
                if p == lo_bound {
                    lo += 1;
                }
                if p == hi_bound {
                    hi += 1;
                }
            }
        }
        // Unlike `elevation_lakes`, BOTH bounds bite here: the window is 0.15
        // wide against that tree's 0.8, so the same +/-0.25 field saturates on
        // each side. Frozen, so a widened clamp would show.
        assert_eq!(lo, 1452, "positions clamped to 0.5");
        assert_eq!(hi, 1020, "positions clamped to 0.65");
    }

    #[test]
    fn the_macro_term_is_half_wave_rectified_and_therefore_zero_over_much_of_the_map() {
        // `macro_a * max(0, macro_b)`, not `macro_a * macro_b`. Dropping the
        // `max` doubles the term's support and changes its sign distribution,
        // which reads as a plausible macro field rather than a broken one.
        let tree = ElevationNauvis::new(&ElevationNauvisParams::defaults(123_456));
        let mut zero = 0usize;
        for i in -40i32..40 {
            for j in -40i32..40 {
                let (x, y) = (f64::from(i) * 311.0, f64::from(j) * 293.0);
                if max2(0.0, f64::from(tree.macro_b.eval(x, y))) == 0.0 {
                    zero += 1;
                }
            }
        }
        assert_eq!(
            zero, 3192,
            "positions where the rectifier zeroes the macro term"
        );
    }
}
