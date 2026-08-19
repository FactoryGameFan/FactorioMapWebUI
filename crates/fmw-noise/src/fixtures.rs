//! Tier 1 of the port's gate: the oracle fixtures, and the only correctness
//! test in this crate.
//!
//! Every test here reads the SAME file its TypeScript counterpart reads, under
//! `test/fixtures/`, and asserts the same thing. Not a copy of the file and not
//! a checksum of it - the repository's own ground truth, so the two ports
//! cannot be graded against different numbers.
//!
//! **A mismatch is a finding, never a bound to widen.** Widening one has hidden
//! a real defect twice on this port, once worth 131x and once worth 40x (#220).
//! The counts below are `assert_eq!` on an EXACT match count rather than an
//! error bound, because every value in these fixtures is exactly f32: a bound
//! cannot tell "close" from "identical", and a kernel evaluated in f64 with the
//! wrong falloff and the wrong summation order passed a 1e-5 bound for a year
//! while scoring 132 of 512.

use crate::basis_gradient_table::{GRADIENT_X, GRADIENT_Y};
use crate::basis_noise::{basis_noise, tables_from_seed, BasisNoiseTables};
use crate::test_json::{load, Json};

/// Rebuild the tables a fixture supplies directly.
fn tables_from_fixture(fixture: &Json) -> BasisNoiseTables {
    let to_array = |key: &str| -> [u8; 256] {
        let v = fixture.get(key).as_u8_array();
        assert_eq!(v.len(), 256, "{key} must have 256 entries");
        let mut out = [0u8; 256];
        out.copy_from_slice(&v);
        out
    };
    BasisNoiseTables {
        sigma: to_array("sigma"),
        a: to_array("a"),
        b: to_array("b"),
    }
}

/// Score a fixture's points, returning (exact matches, worst absolute error).
///
/// The multiply by `input_scale` happens in f64 before the call, matching the
/// TypeScript exactly - JavaScript numbers are f64, so `p.x * inputScale` is an
/// f64 product there and narrowing it here would evaluate a different point.
fn score(fixture: &Json, tables: &BasisNoiseTables) -> (usize, f64) {
    let input_scale = fixture.get("inputScale").as_f64();
    let mut exact = 0usize;
    let mut worst = 0.0f64;
    for point in fixture.get("points").as_array() {
        let x = point.get("x").as_f64() * input_scale;
        let y = point.get("y").as_f64() * input_scale;
        let expected = point.get("v").as_f64();
        let got = basis_noise(x, y, tables);
        worst = worst.max((f64::from(got) - expected).abs());
        if f64::from(got) == expected {
            exact += 1;
        }
    }
    (exact, worst)
}

#[test]
fn the_gradient_table_is_the_one_recovered_from_the_game() {
    // The committed table is emitted by scripts/gen-gradient-table.ts, which
    // also emits the TypeScript one from the same read of this same file. This
    // test is what makes that a fact rather than a claim in a header: it goes
    // red if the generated Rust is ever hand-edited, or regenerated from a
    // different fixture, or left stale after the fixture is re-captured.
    let fixture = load("test/fixtures/basis-gradient-table.json");
    let gx = fixture.get("gradientX").as_f64_array();
    let gy = fixture.get("gradientY").as_f64_array();

    assert_eq!(gx.len(), 256);
    assert_eq!(gy.len(), 256);
    for h in 0..256 {
        // Compared as f64 after widening, so a slot that merely ROUNDS to the
        // right f32 still fails. The fixture values are all exactly f32
        // already, which the TypeScript generator asserts before emitting.
        assert_eq!(f64::from(GRADIENT_X[h]), gx[h], "gradientX slot {h}");
        assert_eq!(f64::from(GRADIENT_Y[h]), gy[h], "gradientY slot {h}");
    }
}

#[test]
fn reproduces_all_512_points_of_the_basis_noise_fixture_exactly() {
    let fixture = load("test/fixtures/basis-noise.seed123456.json");
    let tables = tables_from_fixture(&fixture);
    let (exact, worst) = score(&fixture, &tables);

    // The counterpart is test/basisNoise.spec.ts, which asserts the same 512.
    // It was 473 until 2026-08-18, when the gradient table stopped being
    // derived from a formula and started being recovered from the game (#234).
    // The 39 that missed were the game's own table, not our arithmetic - which
    // was a correct reading, and also an allowance a genuine arithmetic defect
    // in THIS port could have hidden inside. It is gone.
    assert_eq!(exact, 512, "exact f32 matches");
    assert_eq!(worst, 0.0, "worst absolute error");
}

#[test]
fn reproduces_the_seed_derived_oracle_basis_fixture_exactly() {
    // This one also exercises `tables_from_seed`, so it grades the taus88
    // stream, the seed-word clamp, the salt and the four shuffles as well as
    // the kernel. The fixture above supplies its tables directly and cannot.
    let fixture = load("test/fixtures/oracle-basis.seed123456.json");
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let seed1 = fixture.get("seed1").as_f64() as u32;
    let tables = tables_from_seed(seed0, seed1);
    let (exact, worst) = score(&fixture, &tables);

    // test/oracle/oracle.spec.ts asserts the same 38 and the same 0.
    assert_eq!(exact, 38, "exact f32 matches");
    assert_eq!(worst, 0.0, "worst absolute error");
}

#[test]
fn returns_exactly_zero_on_integer_lattice_points() {
    // The game's documented quirk, and it falls out of the kernel rather than
    // being special-cased: on a lattice point every corner offset is zero, so
    // every dot product is zero. The probe in scripts/probes/basis-gradient/
    // uses this as its own control.
    let tables = tables_from_seed(123_456, 0);
    for iy in -3..=3 {
        for ix in -3..=3 {
            let got = basis_noise(f64::from(ix), f64::from(iy), &tables);
            assert_eq!(got, 0.0, "at ({ix}, {iy})");
        }
    }
}

#[test]
fn the_seed_word_is_clamped_from_below() {
    // Every seed in 0..341 produces the same field, because the all-zero taus88
    // state is a fixed point and the clamp is what avoids it. Worth pinning
    // because it looks like a bug at the call site and is not.
    let a = tables_from_seed(0, 0);
    let b = tables_from_seed(340, 0);
    let c = tables_from_seed(0x155, 0);
    assert_eq!(a, b);
    assert_eq!(a, c);
    // And the clamp must actually stop mattering above the threshold, or the
    // test above would pass on a `tables_from_seed` that ignored its seed.
    assert_ne!(a, tables_from_seed(0x156, 0));
}

#[test]
fn the_scorer_resolves_a_single_wrong_point() {
    // What the `poison` feature cannot establish on its own. That feature bends
    // EVERY non-zero result, so a gate could in principle notice it while still
    // being blind to one bad point among 512 - which is the shape a real
    // regression takes. Here the port is left alone and the EXPECTATION is
    // moved by one ULP, so the assertion under test is the scorer's.
    let fixture = load("test/fixtures/basis-noise.seed123456.json");
    let tables = tables_from_fixture(&fixture);
    let input_scale = fixture.get("inputScale").as_f64();

    let mut exact = 0usize;
    let mut nudged_one = false;
    for point in fixture.get("points").as_array() {
        let x = point.get("x").as_f64() * input_scale;
        let y = point.get("y").as_f64() * input_scale;
        let mut expected = point.get("v").as_f64() as f32;
        // Nudge the first non-zero expectation, once.
        if !nudged_one && expected != 0.0 {
            expected = f32::from_bits(expected.to_bits() + 1);
            nudged_one = true;
        }
        if basis_noise(x, y, &tables) == expected {
            exact += 1;
        }
    }

    assert!(nudged_one, "no non-zero point to nudge");
    // 511, not 512. If this ever reads 512 the exact-match count has stopped
    // discriminating and every other assertion in this file is decoration.
    assert_eq!(
        exact, 511,
        "one ULP on one point must cost exactly one match"
    );
}

// ---------------------------------------------------------------------------
// The multioctave family.
//
// Each test reads the same file its TypeScript counterpart reads and asserts
// the same numbers. All four ops are bit-exact, so every assertion is an exact
// count plus `worst == 0` - no bounds. Three of these four had a bound until
// 2026-08-18, and defects were measured that passed every one of them while
// destroying bit-exactness (see the tables in the TypeScript specs).
// ---------------------------------------------------------------------------

use crate::multioctave_noise::{multioctave_noise, MultioctaveParams};
use crate::quick_multioctave_noise::{
    quick_multioctave_noise, quick_multioctave_noise_persistence, QuickMultioctaveParams,
    QuickPersistenceParams,
};
use crate::variable_persistence_multioctave_noise::{
    variable_persistence_multioctave_noise, VariablePersistenceParams,
};

/// Score one fixture case, returning (exact matches, worst absolute error).
fn score_case(values: &[Json], mut eval: impl FnMut(usize) -> f32) -> (usize, f64) {
    let mut exact = 0usize;
    let mut worst = 0.0f64;
    for (i, expected) in values.iter().enumerate() {
        let want = expected.as_f64();
        let got = f64::from(eval(i));
        worst = worst.max((got - want).abs());
        if got == want {
            exact += 1;
        }
    }
    (exact, worst)
}

/// Every value a fixture grades must be exactly f32, or an exact-match count is
/// unreachable by construction and the temptation is to loosen the score rather
/// than read it. Asserted rather than assumed, per case.
fn assert_all_f32(values: &[Json], label: &str) {
    for (i, v) in values.iter().enumerate() {
        let value = v.as_f64();
        assert_eq!(
            f64::from(value as f32),
            value,
            "{label} value {i} is not exactly f32"
        );
    }
}

#[test]
fn reproduces_the_multioctave_fixture_exactly() {
    let fixture = load("test/fixtures/oracle-multioctave.seed123456.json");
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = fixture.get("positions").as_array();

    let mut total = 0usize;
    let mut exact_total = 0usize;
    for case in fixture.get("cases").as_array() {
        let values = case.get("values").as_array();
        assert_all_f32(values, "multioctave");
        let params = MultioctaveParams {
            seed0,
            seed1: case.get("seed1").as_f64() as u32,
            octaves: case.get("octaves").as_f64(),
            persistence: case.get("persistence").as_f64(),
            input_scale: case.get("inputScale").as_f64(),
            output_scale: case.get("outputScale").as_f64(),
        };
        let (exact, worst) = score_case(values, |i| {
            let p = &positions[i];
            multioctave_noise(p.get("x").as_f64(), p.get("y").as_f64(), &params)
        });
        assert_eq!(worst, 0.0, "worst absolute error");
        total += values.len();
        exact_total += exact;
    }

    // test/multioctaveNoise.spec.ts asserts the same 266 and the same 0.
    assert_eq!(total, 266, "fixture size");
    assert_eq!(exact_total, 266, "exact f32 matches");
}

#[test]
fn reproduces_the_variable_persistence_fixture_exactly() {
    let fixture = load("test/fixtures/oracle-variable-persistence-multioctave.seed123456.json");
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = fixture.get("positions").as_array();
    // The per-tile value of the persistence expression, captured alongside the
    // op and fed back in as the model's `p`.
    let persistence = fixture.get("persistenceField").as_f64_array();

    let mut total = 0usize;
    let mut exact_total = 0usize;
    for case in fixture.get("cases").as_array() {
        let values = case.get("values").as_array();
        assert_all_f32(values, "variablePersistence");
        let params = VariablePersistenceParams {
            seed0,
            seed1: case.get("seed1").as_f64() as u32,
            octaves: case.get("octaves").as_f64() as u32,
            input_scale: case.get("inputScale").as_f64(),
            output_scale: case.get("outputScale").as_f64(),
            offset_x: case.get("offsetX").as_f64(),
        };
        let (exact, worst) = score_case(values, |i| {
            let p = &positions[i];
            variable_persistence_multioctave_noise(
                p.get("x").as_f64(),
                p.get("y").as_f64(),
                persistence[i] as f32,
                &params,
            )
        });
        assert_eq!(worst, 0.0, "worst absolute error");
        total += values.len();
        exact_total += exact;
    }

    // test/variablePersistenceMultioctaveNoise.spec.ts asserts the same.
    assert_eq!(total, 266, "fixture size");
    assert_eq!(exact_total, 266, "exact f32 matches");
}

#[test]
fn reproduces_the_quick_multioctave_fixture_exactly() {
    let fixture = load("test/fixtures/oracle-quick-multioctave.seed123456.json");
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = fixture.get("positions").as_array();

    let mut total = 0usize;
    let mut exact_total = 0usize;
    for case in fixture.get("cases").as_array() {
        let values = case.get("values").as_array();
        assert_all_f32(values, "quickMultioctave");
        let params = QuickMultioctaveParams {
            seed0,
            seed1: case.get("seed1").as_f64() as u32,
            octaves: case.get("octaves").as_f64() as u32,
            input_scale: case.get("inputScale").as_f64(),
            output_scale: case.get("outputScale").as_f64(),
            octave_output_scale_multiplier: case.get("oosm").as_f64(),
            octave_input_scale_multiplier: case.get("oism").as_f64(),
            offset_x: case.get("offsetX").as_f64(),
        };
        let (exact, worst) = score_case(values, |i| {
            let p = &positions[i];
            quick_multioctave_noise(p.get("x").as_f64(), p.get("y").as_f64(), &params)
        });
        assert_eq!(worst, 0.0, "worst absolute error");
        total += values.len();
        exact_total += exact;
    }

    // test/quickMultioctaveNoise.spec.ts asserts the same 190 and the same 0.
    // It was 38 until 2026-08-18, when the TypeScript stopped evaluating this
    // op in f64. This port never had that defect, and the count is what proves
    // it rather than a bound that both shapes would have passed.
    assert_eq!(total, 190, "fixture size");
    assert_eq!(exact_total, 190, "exact f32 matches");
}

#[test]
fn reproduces_the_quick_persistence_wrapper_exactly() {
    let fixture = load("test/fixtures/oracle-multioctave-wrappers.seed123456.json");
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = fixture.get("positions").as_array();

    let mut total = 0usize;
    let mut exact_total = 0usize;
    for case in fixture.get("quick").as_array() {
        let values = case.get("values").as_array();
        assert_all_f32(values, "quickPersistence");
        let params = QuickPersistenceParams {
            seed0,
            seed1: case.get("seed1").as_f64() as u32,
            octaves: case.get("octaves").as_f64() as u32,
            input_scale: case.get("inputScale").as_f64(),
            output_scale: case.get("outputScale").as_f64(),
            octave_input_scale_multiplier: case.get("oism").as_f64(),
            persistence: case.get("persistence").as_f64(),
        };
        let (exact, worst) = score_case(values, |i| {
            let p = &positions[i];
            quick_multioctave_noise_persistence(p.get("x").as_f64(), p.get("y").as_f64(), &params)
        });
        assert_eq!(worst, 0.0, "worst absolute error");
        total += values.len();
        exact_total += exact;
    }

    // test/multioctaveWrappers.spec.ts asserts the same 152 and the same 0.
    // `amplitude_corrected_multioctave_noise`, the other wrapper in that
    // fixture, is deliberately NOT ported yet: it sits at 81/152 in the
    // TypeScript with a bit-exact op underneath and an unexplained residual
    // (#254). Porting it now would mean porting a known-wrong model and
    // enshrining its wrongness in a Rust assertion.
    assert_eq!(total, 152, "fixture size");
    assert_eq!(exact_total, 152, "exact f32 matches");
}

// ---------------------------------------------------------------------------
// random_penalty.
// ---------------------------------------------------------------------------

use crate::random_penalty::{
    random_penalty_batch, random_penalty_word, RandomPenaltyParams, RandomPenaltyPosition,
};

/// Rebuild `source[i]` from a case's `sourceKind`, exactly as
/// `test/randomPenalty.spec.ts` does. The fixture keeps the source values out
/// of the file so that the expression under test is named rather than copied.
fn random_penalty_source(kind: &str, positions: &[RandomPenaltyPosition]) -> Vec<f64> {
    match kind {
        "const1" => positions.iter().map(|_| 1.0).collect(),
        "x" => positions.iter().map(|p| p.x).collect(),
        other => panic!("unknown sourceKind {other:?}"),
    }
}

#[test]
fn reproduces_the_random_penalty_fixture_exactly() {
    let fixture = load("test/fixtures/oracle-random-penalty.seed123456.json");
    let positions: Vec<RandomPenaltyPosition> = fixture
        .get("positions")
        .as_array()
        .iter()
        .map(|p| RandomPenaltyPosition {
            x: p.get("x").as_f64(),
            y: p.get("y").as_f64(),
        })
        .collect();

    let mut total = 0usize;
    let mut exact = 0usize;
    let mut worst = 0.0f64;
    for case in fixture.get("cases").as_array() {
        let values = case.get("values").as_array();
        assert_all_f32(values, "randomPenalty");
        let source = random_penalty_source(case.get("sourceKind").as_str(), &positions);
        let got = random_penalty_batch(
            &positions,
            &source,
            &RandomPenaltyParams {
                seed: case.get("rpSeed").as_f64(),
                amplitude: case.get("amplitude").as_f64(),
            },
        );
        assert_eq!(got.len(), values.len(), "batch length");
        for (i, expected) in values.iter().enumerate() {
            let want = expected.as_f64();
            total += 1;
            worst = worst.max((got[i] - want).abs());
            if got[i] == want {
                exact += 1;
            }
        }
    }

    assert_eq!(total, 40, "fixture size");
    assert_eq!(exact, 40, "exact f32 matches");
    assert_eq!(worst, 0.0, "worst absolute error");
}

#[test]
fn the_random_penalty_seed_word_matches_the_measured_formula() {
    // test/randomPenalty.spec.ts asserts the same three.
    assert_eq!(random_penalty_word(0.0, 0.0, 1.0), 0x3f_be2c + 7907);
    // The seed folds into y BEFORE truncation, and coordinates truncate toward
    // zero rather than flooring.
    assert_eq!(random_penalty_word(0.9, 0.9, 0.0), 0x3f_be2c);
    assert_eq!(
        random_penalty_word(-1.5, 0.0, 0.0),
        (0x3f_be2c_u32).wrapping_add((-1i32 as u32).wrapping_mul(7919))
    );
}

// ---------------------------------------------------------------------------
// distance_from_nearest_point, and the starting lakes that feed it.
// ---------------------------------------------------------------------------

use crate::distance_from_nearest_point::{distance_from_nearest_point, Point};

/// The Rust half of `test/captureGrid.ts`.
///
/// Factorio's `MapPosition` is fixed point - `int32 / 256` - and every
/// coordinate handed to `surface.calculate_tile_properties` is converted on the
/// way in. A capture that RECORDS a coordinate off that grid made the game
/// evaluate a slightly different point than the fixture says (#186). The snap
/// is truncation TOWARD ZERO, which was measured over all 17 affected fixtures
/// rather than assumed: on rows with a negative coordinate, truncating is exact
/// where flooring is not 6 times in `oracle-temperature` alone, and flooring
/// never wins.
///
/// It applies to the SAMPLE POSITION only, never to a fixture's recorded
/// values.
fn snap_coord(v: f64) -> f64 {
    (v * 256.0).trunc() / 256.0
}

/// How many of a fixture's positions were recorded off the 1/256 grid. Asserted
/// so a re-capture cannot silently empty the set the snap exists for.
fn count_off_grid(positions: &[(f64, f64)]) -> usize {
    positions
        .iter()
        .filter(|(x, y)| (x * 256.0).fract() != 0.0 || (y * 256.0).fract() != 0.0)
        .count()
}

/// The 26 capture positions of `oracle-elevation-lakes`, snapped.
fn lakes_fixture_positions(fixture: &Json) -> Vec<(f64, f64)> {
    fixture
        .get("positions")
        .as_array()
        .iter()
        .map(|p| (p.get("x").as_f64(), p.get("y").as_f64()))
        .collect()
}

#[test]
fn reproduces_the_games_distance_from_nearest_point_at_all_26_positions() {
    // `distance` is 26 values of `distance_from_nearest_point{x = x, y = y,
    // points = starting_positions}` captured straight from the game. The
    // EvalCtx default spawn is the origin, which is what `starting_positions`
    // resolved to for this capture (confirmed by `distance[0] == hypot`).
    let fixture = load("test/fixtures/oracle-elevation-lakes.seed123456.json");
    let positions = lakes_fixture_positions(&fixture);
    let expected = fixture.get("distance").as_f64_array();
    let spawn = [Point { x: 0.0, y: 0.0 }];

    assert_eq!(positions.len(), 26, "a regen cannot empty the loop");
    // Anti-vacuity for the snap: 14 of the 26 far-ring positions were captured
    // off the grid. Without it this scores 18/26 at worst 4.639e-3.
    assert_eq!(count_off_grid(&positions), 14, "off-grid positions");
    assert_all_f32(fixture.get("distance").as_array(), "distance");

    let mut exact = 0usize;
    let mut worst = 0.0f64;
    for (i, (x, y)) in positions.iter().enumerate() {
        // No narrowing at the comparison: the op returns f32 because the
        // game's does. Until 2026-08-18 both ports returned raw f64 and their
        // specs narrowed HERE instead, which scored 26/26 while the op itself
        // scored 0/26 - the shape #260 found in `random_penalty` (#220).
        let got = f64::from(distance_from_nearest_point(
            snap_coord(*x),
            snap_coord(*y),
            &spawn,
            f64::INFINITY,
        ));
        worst = worst.max((got - expected[i]).abs());
        if got == expected[i] {
            exact += 1;
        }
    }

    // test/distanceFromNearestPoint.spec.ts asserts the same 26 and the same 0.
    assert_eq!(exact, 26, "exact f32 matches");
    assert_eq!(worst, 0.0, "worst absolute error");
}

use crate::starting_lakes::starting_lake_positions;

#[test]
fn computes_the_games_real_starting_lake_for_seed_123456() {
    // Trilaterated exactly, with zero residual, from the fixture's 9 near-spawn
    // `startingLakeDistance` values - so this is ground truth derived from the
    // game's own numbers rather than from either port.
    //
    // It is also the ONE assertion in this file that reaches
    // `starting_lake_positions` without going through
    // `distance_from_nearest_point`, which is what lets the poison build
    // attribute a failure here to this op alone.
    let spawn = [Point { x: 0.0, y: 0.0 }];
    let lakes = starting_lake_positions(123_456, &spawn);
    assert_eq!(lakes, vec![Point { x: 45.0, y: -59.0 }]);
}

#[test]
fn reproduces_every_starting_lake_distance_in_the_fixture() {
    let fixture = load("test/fixtures/oracle-elevation-lakes.seed123456.json");
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = lakes_fixture_positions(&fixture);
    let expected = fixture.get("startingLakeDistance").as_f64_array();
    assert_all_f32(
        fixture.get("startingLakeDistance").as_array(),
        "startingLakeDistance",
    );

    let lakes = starting_lake_positions(seed0, &[Point { x: 0.0, y: 0.0 }]);

    let mut exact = 0usize;
    let mut saturated = 0usize;
    let mut worst = 0.0f64;
    for (i, (x, y)) in positions.iter().enumerate() {
        if expected[i] == 1024.0 {
            saturated += 1;
        }
        // No narrowing at the comparison - see the sibling test above.
        let got = f64::from(distance_from_nearest_point(
            snap_coord(*x),
            snap_coord(*y),
            &lakes,
            1024.0,
        ));
        worst = worst.max((got - expected[i]).abs());
        if got == expected[i] {
            exact += 1;
        }
    }

    assert_eq!(positions.len(), 26, "a regen cannot empty the loop");
    assert_eq!(exact, 26, "exact f32 matches");
    assert_eq!(worst, 0.0, "worst absolute error");
    // **Only 9 of these 26 discriminate anything.** The other 17 sit at exactly
    // 1024, the `maximum_distance` cap, and would match any lake far enough
    // from them - including a lake this port placed on the wrong side of the
    // map. Asserted so the discriminating subset cannot silently shrink.
    assert_eq!(saturated, 17, "rows pinned at the 1024 cap");
    assert_eq!(positions.len() - saturated, 9, "discriminating rows");
}

#[test]
fn the_capture_grid_snap_is_inert_on_starting_lake_distance_and_that_is_measured() {
    // 14 of the 26 positions ARE off the 1/256 grid, so the snap is applied
    // above for the same reason it is applied to `distance`. It changes nothing
    // here, and that is worth pinning rather than leaving as an unexamined
    // habit: all 14 off-grid rows are far-field rows saturated at the 1024 cap,
    // and a displacement under 1/256 cannot unsaturate one. The 9 rows that DO
    // discriminate are all on-grid already.
    //
    // If a re-capture ever moves an off-grid position into the near field, this
    // test goes red and the snap stops being decoration.
    let fixture = load("test/fixtures/oracle-elevation-lakes.seed123456.json");
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = lakes_fixture_positions(&fixture);
    let expected = fixture.get("startingLakeDistance").as_f64_array();
    let lakes = starting_lake_positions(seed0, &[Point { x: 0.0, y: 0.0 }]);

    for (i, (x, y)) in positions.iter().enumerate() {
        let snapped = distance_from_nearest_point(snap_coord(*x), snap_coord(*y), &lakes, 1024.0);
        let raw = distance_from_nearest_point(*x, *y, &lakes, 1024.0);
        let off_grid = (x * 256.0).fract() != 0.0 || (y * 256.0).fract() != 0.0;
        if off_grid {
            assert_eq!(expected[i], 1024.0, "off-grid row {i} is not saturated");
        }
        assert_eq!(snapped, raw, "the snap moved row {i}");
    }
}

// ---------------------------------------------------------------------------
// spot_noise: the candidate stream.
// ---------------------------------------------------------------------------

use crate::spot_candidates::{spot_candidate_points, spot_seed_word, SpotPoint, SpotRegionKey};

/// A fixture's candidate list, sorted the way the fixtures record them.
/// Generation order is not recoverable from `spot-candidates.game.json` - the
/// apexes were trilaterated out of single-cone fields - so both sides sort.
fn sorted(mut points: Vec<SpotPoint>) -> Vec<SpotPoint> {
    points.sort_by(|a, b| a.x.cmp(&b.x).then(a.y.cmp(&b.y)));
    points
}

#[test]
fn reproduces_the_recovered_candidate_draw_stream_bit_exactly() {
    // The raw 32-bit draws, recovered from the game by CRT across region sizes
    // 2048/2050/2058/2066. Reproducing them checks the full u32 output rather
    // than a mod-region_size shadow of it.
    //
    // **These are compared as integers, never as floats.** The largest draw
    // here is 4,192,399,414, where the spacing between adjacent f32 values is
    // 256 - so narrowing this comparison would score 1 of 40 on values that are
    // 40 of 40 equal.
    let fixture = load("docs/noise/spot-candidate-stream.seed123456.json");
    let key = SpotRegionKey {
        seed0: 123_456,
        seed1: 0,
        region_x: 0,
        region_y: 0,
    };
    assert_eq!(spot_seed_word(&key), 0x3e_5c6c);

    // A region the size of the whole u32 range makes `draw % region_size` the
    // identity, so the world coordinate is the raw draw shifted by half.
    let points = spot_candidate_points(&key, 1 << 32, 20);
    let rows = fixture.get("candidate_index_to_Vx_Vy").as_array();
    assert_eq!(rows.len(), 20, "a regen cannot empty the loop");
    for row in rows {
        let row = row.as_array();
        let i = row[0].as_f64() as usize;
        let vx = row[1].as_f64() as i64;
        let vy = row[2].as_f64() as i64;
        assert_eq!(points[i].x + (1 << 31), vx, "draw {i} x");
        assert_eq!(points[i].y + (1 << 31), vy, "draw {i} y");
    }
}

#[test]
fn reproduces_every_game_captured_candidate_set() {
    let fixture = load("test/fixtures/spot-candidates.game.json");
    let cases = fixture.get("cases").as_array();

    let mut total = 0usize;
    let mut exact = 0usize;
    for case in cases {
        let key = SpotRegionKey {
            seed0: case.get("seed0").as_f64() as u32,
            seed1: case.get("seed1").as_f64() as u32,
            region_x: case.get("regionX").as_f64() as i64,
            region_y: case.get("regionY").as_f64() as i64,
        };
        let region_size = case.get("regionSize").as_f64() as u64;
        let expected = case.get("candidates").as_array();
        let got = sorted(spot_candidate_points(&key, region_size, expected.len()));
        for (i, want) in expected.iter().enumerate() {
            let want = want.as_array();
            total += 2;
            if got[i].x == want[0].as_f64() as i64 {
                exact += 1;
            }
            if got[i].y == want[1].as_f64() as i64 {
                exact += 1;
            }
        }
    }

    // test/spotCandidates.spec.ts asserts the same sets, across seeds up to
    // 4,294,967,295, negative region indices and two region sizes.
    assert_eq!(cases.len(), 11, "fixture cases");
    assert_eq!(total, 132, "fixture size");
    assert_eq!(exact, 132, "exact integer matches");
}

// ---------------------------------------------------------------------------
// spot_noise: selection.
// ---------------------------------------------------------------------------

use crate::spot_selection::{select_spots, SelectedSpot, SpotSelectParams};
use std::f64::consts::PI;

/// The probes fixed `spot_radius_expression = 20` and read the cone peak at the
/// apex, so the fixture's third column is `3q / (pi * (20*coneScale)^2)`.
fn peak_of(s: &SelectedSpot) -> f64 {
    let r = 20.0 * s.cone_scale;
    (3.0 * s.quantity) / (PI * r * r)
}

/// Decode one of the fixture's expression descriptors. The same seven kinds
/// `test/spotSelection.spec.ts` decodes, kept as descriptors rather than as
/// captured values so that the expression under test is named.
fn decode_expression(e: &Json) -> Box<dyn Fn(f64, f64) -> f64> {
    let value = |k: &str| -> f64 {
        match e.get_opt(k) {
            Some(v) => v.as_f64(),
            None => 0.0,
        }
    };
    match e.get("kind").as_str() {
        "const" => {
            let v = value("value");
            Box::new(move |_, _| v)
        }
        "x" => Box::new(|x, _| x),
        "negx" => Box::new(|x, _| -x),
        "xminus" => {
            let offset = value("offset");
            Box::new(move |x, _| x - offset)
        }
        "xplus" => {
            let base = value("base");
            Box::new(move |x, _| base + x)
        }
        "x2" => {
            let scale = if e.get_opt("scale").is_some() {
                value("scale")
            } else {
                1.0
            };
            Box::new(move |x, _| x * x * scale)
        }
        "stepx" => {
            let v = value("value");
            Box::new(move |x, _| if x > 0.0 { v } else { 0.0 })
        }
        other => panic!("unknown expression kind {other:?}"),
    }
}

#[test]
fn reproduces_every_game_captured_spot_selection_probe() {
    let fixture = load("test/fixtures/spot-selection.game.json");
    let cases = fixture.get("cases").as_array();

    let mut rows = 0usize;
    let mut xy_exact = 0usize;
    let mut peaks_that_are_f32 = 0usize;
    let mut worst_peak = 0.0f64;
    let mut worst_label = String::new();
    // The two rows #257 records as contradicting the fixture's own other 404.
    let mut over_half_a_milli = Vec::<String>::new();

    for case in cases {
        let name = case.get("name").as_str();
        let key = SpotRegionKey {
            seed0: case.get("seed0").as_f64() as u32,
            seed1: case.get("seed1").as_f64() as u32,
            region_x: case.get("regionX").as_f64() as i64,
            region_y: case.get("regionY").as_f64() as i64,
        };
        let density = decode_expression(case.get("density"));
        let quantity = decode_expression(case.get("quantity"));
        let favorability = decode_expression(case.get("favorability"));
        let params = SpotSelectParams {
            region_size: case.get("regionSize").as_f64() as u64,
            candidate_spot_count: case.get("count").as_f64() as usize,
            spacing: case.get("spacing").as_f64(),
            skip_span: case.get("skipSpan").as_f64() as usize,
            skip_offset: case.get("skipOffset").as_f64() as usize,
            hard_region_target_quantity: case.get("hard").as_bool(),
            density: density.as_ref(),
            quantity: quantity.as_ref(),
            favorability: favorability.as_ref(),
            quantity_batch: None,
        };

        let mut got = select_spots(&key, &params);
        got.sort_by(|a, b| a.x.cmp(&b.x).then(a.y.cmp(&b.y)));
        let expected = case.get("spots").as_array();
        assert_eq!(got.len(), expected.len(), "spot count for {name:?}");

        for (i, want) in expected.iter().enumerate() {
            let want = want.as_array();
            rows += 1;
            if got[i].x == want[0].as_f64() as i64 {
                xy_exact += 1;
            }
            if got[i].y == want[1].as_f64() as i64 {
                xy_exact += 1;
            }
            let want_peak = want[2].as_f64();
            if f64::from(want_peak as f32) == want_peak {
                peaks_that_are_f32 += 1;
            }
            let err = (peak_of(&got[i]) - want_peak).abs();
            if err > worst_peak {
                worst_peak = err;
                worst_label = format!("{name}[{i}]");
            }
            if err >= 5e-4 {
                over_half_a_milli.push(format!("{name}[{i}] err {err:e}"));
            }
        }
    }

    assert_eq!(cases.len(), 55, "fixture cases");
    assert_eq!(rows, 413, "fixture size");

    // **x and y are exact, and they are the whole selection algorithm.** Which
    // candidates survive the dart throw, which skip set they land in, how the
    // favorability sort orders them and where the target cuts the list all show
    // up here as a changed coordinate list.
    assert_eq!(xy_exact, 826, "exact integer matches on x and y");

    // The peak column CANNOT be scored exactly, and that is a property of the
    // capture rather than of either port: it was read off the rendered field
    // with deliberate 3-decimal rounding, so **0 of 413 values are
    // f32-representable**. Asserted rather than assumed, because if a
    // re-capture ever records full precision the right response is to score
    // this exactly, not to keep the tolerance.
    assert_eq!(peaks_that_are_f32, 0, "f32-representable fixture peaks");

    // 5e-4 is half of the last recorded digit - the largest error a correctly
    // rounded 3-decimal capture can produce - so it is the capture's own
    // resolution rather than a number chosen to fit. 411 of 413 rows sit under
    // it, at worst 4.488e-4.
    //
    // The two that do not are `hard1[0]` and `hard1[2]`, both at 1.2415e-3, and
    // they are a contradiction INSIDE the fixture rather than a port error:
    // both compute 23.8732414637843, which 404 other rows record as `23.873`
    // and these two record as `23.872`. That is #257. Pinned by name and by
    // value so it cannot spread.
    assert_eq!(
        over_half_a_milli,
        vec![
            "hard1[0] err 1.241463784300123e-3".to_string(),
            "hard1[2] err 1.241463784300123e-3".to_string(),
        ],
        "rows outside the capture's own 3-decimal resolution"
    );
    assert!(
        worst_peak < 1.25e-3,
        "worst peak error {worst_peak:e} at {worst_label}"
    );
}
