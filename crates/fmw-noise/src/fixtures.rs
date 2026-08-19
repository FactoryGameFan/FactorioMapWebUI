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

// ---------------------------------------------------------------------------
// voronoi_*: the per-cell RNG.
// ---------------------------------------------------------------------------

use crate::voronoi_noise::{cell_random, CELL_DRAW_ID};

#[test]
fn reproduces_the_games_per_cell_voronoi_draw_across_all_nine_seed_series() {
    let fixture = load("test/fixtures/oracle-voronoi-cellid.multiseed.json");
    let cells: Vec<(i32, i32)> = fixture
        .get("cells")
        .as_array()
        .iter()
        .map(|c| (c.get("cx").as_f64() as i32, c.get("cy").as_f64() as i32))
        .collect();
    let series = fixture.get("series").as_array();

    // Negative cell indices are half the point of the capture: a hash that
    // mishandled two's complement would be invisible on a 0..15 block.
    assert_eq!(cells.len(), 256, "cells");
    assert_eq!(series.len(), 9, "seed series");
    assert_eq!(
        cells.iter().filter(|(x, y)| *x < 0 || *y < 0).count(),
        192,
        "cells with a negative index"
    );

    let mut total = 0usize;
    let mut exact = 0usize;
    for s in series {
        let seed0 = s.get("seed0").as_f64() as u32;
        let seed1 = s.get("seed1").as_f64() as u32;
        let values = s.get("values").as_array();
        assert_all_f32(values, "cellRandom");
        for (i, (cx, cy)) in cells.iter().enumerate() {
            total += 1;
            if f64::from(cell_random(seed0, seed1, *cx, *cy, CELL_DRAW_ID)) == values[i].as_f64() {
                exact += 1;
            }
        }
    }

    // test/voronoiNoise.spec.ts asserts the same 9 x 256.
    assert_eq!(total, 2304, "fixture size");
    assert_eq!(exact, 2304, "exact f32 matches");
}

#[test]
fn the_voronoi_seeds_combine_as_a_single_32_bit_sum() {
    // Read out of `VoronoiNoise::VoronoiNoise` rather than guessed:
    // `w8 = asNoiseLayerID(seed1) + (uint)seed0`. So (123456, 1) and (123457, 0)
    // are the SAME field, and the sum wraps. Pinned so a later "fix" that
    // separated the two seeds fails loudly.
    for cy in -3..=3 {
        for cx in -3..=3 {
            assert_eq!(
                cell_random(123_456, 1, cx, cy, CELL_DRAW_ID),
                cell_random(123_457, 0, cx, cy, CELL_DRAW_ID)
            );
            assert_eq!(
                cell_random(0xffff_ffff, 1, cx, cy, CELL_DRAW_ID),
                cell_random(0, 0, cx, cy, CELL_DRAW_ID)
            );
        }
    }
}

use crate::voronoi_noise::{points_search_range, Voronoi, VoronoiDistanceType, VoronoiParams};

/// Build a field for one fixture series.
fn voronoi(
    seed0: u32,
    seed1: u32,
    grid_size: f64,
    jitter: f64,
    dt: &str,
    override_ring: Option<i32>,
) -> Voronoi {
    Voronoi::new(&VoronoiParams {
        seed0,
        seed1,
        grid_size,
        jitter,
        distance_type: VoronoiDistanceType::from_name(dt),
        search_range_override: override_ring,
    })
}

/// Score one `op:distance_type[:jitter]` series against its positions.
fn score_voronoi_series(
    key: &str,
    values: &[Json],
    positions: &[(f64, f64)],
    mut eval: impl FnMut(f64, f64) -> f32,
) -> (usize, usize) {
    assert_all_f32(values, key);
    assert_eq!(values.len(), positions.len(), "{key} length");
    let mut exact = 0usize;
    for (i, (x, y)) in positions.iter().enumerate() {
        if f64::from(eval(*x, *y)) == values[i].as_f64() {
            exact += 1;
        }
    }
    (values.len(), exact)
}

fn fixture_positions(fixture: &Json, key: &str) -> Vec<(f64, f64)> {
    fixture
        .get(key)
        .as_array()
        .iter()
        .map(|p| (p.get("x").as_f64(), p.get("y").as_f64()))
        .collect()
}

/// Dispatch one of the four ops by the fixture's key prefix.
fn eval_voronoi_op(v: &mut Voronoi, op: &str, x: f64, y: f64) -> f32 {
    match op {
        "voronoi_cell_id" => v.cell_id(x, y),
        "voronoi_spot_noise" => v.spot_noise(x, y),
        "voronoi_facet_noise" => v.facet_noise(x, y),
        "voronoi_pyramid_noise" => v.pyramid_noise(x, y),
        other => panic!("unknown voronoi op {other:?}"),
    }
}

#[test]
fn reproduces_the_jitter_zero_voronoi_fixture_exactly() {
    // **This rung is DEGENERATE and proves less than its size suggests.** At
    // jitter 0 every cell is a congruent unit square, so many different
    // algorithms collapse onto identical numbers. It is the jittered fixture
    // below that discriminates. Kept because it is free and because a
    // regression would show here first.
    let fixture = load("test/fixtures/oracle-voronoi-jitter0.seed123456.json");
    let seed0 = fixture.get("seed").as_f64() as u32;
    let seed1 = fixture.get("seed1").as_f64() as u32;
    let grid_size = fixture.get("gridSize").as_f64();
    let jitter = fixture.get("jitter").as_f64();
    let positions = fixture_positions(&fixture, "positions");
    let values = fixture.get("values");

    let Json::Obj(entries) = values else {
        panic!("values is not an object")
    };
    let mut total = 0usize;
    let mut exact_total = 0usize;
    for (key, series) in entries {
        let (op, dt) = key.split_once(':').expect("op:distance_type");
        let mut v = voronoi(seed0, seed1, grid_size, jitter, dt, None);
        let (n, exact) = score_voronoi_series(key, series.as_array(), &positions, |x, y| {
            eval_voronoi_op(&mut v, op, x, y)
        });
        total += n;
        exact_total += exact;
    }

    // 15 series, not 16: `voronoi_pyramid_noise:minkowski3` does not exist,
    // because the game's own expression compiler refuses that pair.
    assert_eq!(entries.len(), 15, "series");
    assert_eq!(total, 2625, "fixture size");
    assert_eq!(exact_total, 2625, "exact f32 matches");
}

#[test]
fn reproduces_the_jittered_voronoi_fixture_exactly() {
    // The rung that actually discriminates: 45 series at jitter 0.6, 0.8 and
    // 1.0. The pyramid's old jitter-0 formula scored 0 of 175 at every one of
    // these, which is what the degenerate rung above could never have shown.
    let fixture = load("test/fixtures/oracle-voronoi-points.seed123456.json");
    let seed0 = fixture.get("seed").as_f64() as u32;
    let seed1 = fixture.get("seed1").as_f64() as u32;
    let grid_size = fixture.get("gridSize").as_f64();
    let positions = fixture_positions(&fixture, "opPositions");
    let ops = fixture.get("ops");

    let Json::Obj(entries) = ops else {
        panic!("ops is not an object")
    };
    let mut total = 0usize;
    let mut exact_total = 0usize;
    for (key, series) in entries {
        let mut parts = key.split(':');
        let op = parts.next().expect("op");
        let dt = parts.next().expect("distance_type");
        let jitter: f64 = parts
            .next()
            .expect("jitter")
            .parse()
            .expect("jitter number");
        let mut v = voronoi(seed0, seed1, grid_size, jitter, dt, None);
        let (n, exact) = score_voronoi_series(key, series.as_array(), &positions, |x, y| {
            eval_voronoi_op(&mut v, op, x, y)
        });
        total += n;
        exact_total += exact;
    }

    assert_eq!(entries.len(), 45, "series");
    assert_eq!(total, 7875, "fixture size");
    assert_eq!(exact_total, 7875, "exact f32 matches");
}

#[test]
fn reproduces_the_voronoi_point_inversion_lattice_exactly() {
    // The lattice recovers the POINT POSITIONS themselves rather than an op's
    // output: 6 series x 4,096 samples of `spot_noise` and `cell_id` around one
    // cell, at three jitters and two distance types. This is what pins
    // `point_offset_in_cell` directly instead of through an argmin.
    let fixture = load("test/fixtures/oracle-voronoi-points.seed123456.json");
    let seed0 = fixture.get("seed").as_f64() as u32;
    let seed1 = fixture.get("seed1").as_f64() as u32;
    let grid_size = fixture.get("gridSize").as_f64();

    let mut total = 0usize;
    let mut exact_values = 0usize;
    let mut exact_ids = 0usize;
    for s in fixture.get("series").as_array() {
        let jitter = s.get("jitter").as_f64();
        let dt = s.get("distanceType").as_str();
        let lattice = s.get("lattice").as_array();
        let values = s.get("values").as_array();
        let cell_ids = s.get("cellIds").as_array();
        assert_all_f32(values, "lattice values");
        assert_all_f32(cell_ids, "lattice cellIds");
        let mut v = voronoi(seed0, seed1, grid_size, jitter, dt, None);
        for (i, p) in lattice.iter().enumerate() {
            let x = p.get("x").as_f64();
            let y = p.get("y").as_f64();
            total += 1;
            if f64::from(v.spot_noise(x, y)) == values[i].as_f64() {
                exact_values += 1;
            }
            if f64::from(v.cell_id(x, y)) == cell_ids[i].as_f64() {
                exact_ids += 1;
            }
        }
    }

    assert_eq!(total, 24576, "fixture size");
    assert_eq!(exact_values, 24576, "exact spot_noise matches");
    assert_eq!(exact_ids, 24576, "exact cell_id matches");
}

#[test]
fn reproduces_the_voronoi_search_range_fixture_and_rejects_the_wrong_ring() {
    // `points_search_range` was INERT until 2026-08-05: forcing it to 2 for all
    // four distance types passed 95/95 voronoi tests, and forcing it to 1 also
    // passed 95/95. This fixture is what ended that, and it is the only place
    // the ring is observable at all - so the anti-vacuity half (the planted
    // wrong ring must FAIL) is the point of the test, not a garnish.
    let fixture = load("test/fixtures/oracle-voronoi-search-range.seed123456.json");
    let seed0 = fixture.get("seed").as_f64() as u32;
    let seed1 = fixture.get("seed1").as_f64() as u32;
    let grid_size = fixture.get("gridSize").as_f64();

    let mut total = 0usize;
    let mut exact = 0usize;
    let mut wrong_ring_matches = 0usize;
    for s in fixture.get("series").as_array() {
        let dt = s.get("distanceType").as_str();
        let jitter = s.get("jitter").as_f64();
        let expected_range = s.get("expectedRange").as_f64() as i32;
        let positions = fixture_positions(s, "positions");
        let values = s.get("values").as_array();
        assert_all_f32(values, "searchRange values");

        // The range this port computes must be the one the fixture names.
        assert_eq!(
            points_search_range(VoronoiDistanceType::from_name(dt), jitter),
            expected_range,
            "{dt} at jitter {jitter}"
        );

        let mut right = voronoi(seed0, seed1, grid_size, jitter, dt, None);
        let wrong = if expected_range == 1 { 2 } else { 1 };
        let mut planted = voronoi(seed0, seed1, grid_size, jitter, dt, Some(wrong));
        for (i, (x, y)) in positions.iter().enumerate() {
            total += 1;
            if f64::from(right.pyramid_noise(*x, *y)) == values[i].as_f64() {
                exact += 1;
            }
            if f64::from(planted.pyramid_noise(*x, *y)) == values[i].as_f64() {
                wrong_ring_matches += 1;
            }
        }
    }

    // 37, over 5 series: chebyshev at jitter 1 (8), manhattan at 1 (11) and at
    // 0.7 (6), euclidean at 1 (11) and at 0.9 (1). Small because the ring is
    // only observable at ~3.3e-5 of positions - 553 of 16,777,216 for chebyshev
    // at jitter 1 - which is why the other two fixtures never hit one.
    assert_eq!(fixture.get("series").as_array().len(), 5, "series");
    assert_eq!(total, 37, "fixture size");
    assert_eq!(exact, 37, "exact f32 matches at the game's own ring");
    // Every one of these positions was CHOSEN because the two rings disagree
    // there, so the planted ring must miss all 40. If this ever reads above 0
    // the fixture has stopped discriminating and the range is inert again.
    assert_eq!(wrong_ring_matches, 0, "matches under a planted wrong ring");
}

// ---------------------------------------------------------------------------
// Phase 2 - the `eval` layer (#221).
//
// Same rule as everything above: read the file the TypeScript spec reads, and
// assert an exact count rather than a bound.
// ---------------------------------------------------------------------------

use crate::eval::math::{slider_rescale, slider_rescale_f64};
use crate::eval::multisample::multisample;
use crate::expressions::vulcanus_seed::{seed_normalized, seed_small};
use crate::fast_approx::{fast_cbrt, fast_pow, noise_machine_pow};

/// Look up one exponent series in the `^` fixture.
fn pow_series<'a>(fixture: &'a Json, exponent: &str) -> &'a [Json] {
    for s in fixture.get("series").as_array() {
        if s.get("exponent").as_str() == exponent {
            return s.get("values").as_array();
        }
    }
    panic!("fixture has no series for exponent {exponent}");
}

/// **The noise machine's `^` is THREE functions**, and this grades all three
/// against the operator itself rather than through a downstream chain.
///
/// | exponent | model | matches |
/// | --- | --- | --- |
/// | `1/3`, `2.5` | fastapprox via `Math::powSafe` | 123/123 |
/// | `0.5` | exact `sqrt` | 123/123 |
/// | integral | exact exponentiation by squaring | 123/123 |
///
/// `test/fastApprox.spec.ts` asserts the same four series at the same 123
/// positions. It exists because the rest of the suite could not answer two
/// open questions about a shipped file (#161, #163): every other fixture that
/// touches `fast_approx` compares with a tolerance of ~5e-5 or 1.0, and the
/// effects in question are ~1e-5.
///
/// The `1/3` series is graded through [`fast_cbrt`] rather than
/// `noise_machine_pow(x, 1.0/3.0)`, so the exponent constant `ONE_THIRD_F32` is
/// inside the comparison. In Rust the double-versus-f32 exponent question the
/// TypeScript has to guard against cannot arise - `fast_pow` takes an `f32`, so
/// the type system rules it out - which is why the guards below are the other
/// three rather than a copy of that one.
#[test]
fn reproduces_the_games_pow_operator_at_every_position() {
    let fixture = load("test/fixtures/oracle-fastpow.seed123456.json");
    let positions = fixture.get("positions").as_array();
    let xs: Vec<f32> = positions
        .iter()
        .map(|p| p.get("x").as_f64() as f32)
        .collect();
    assert_eq!(xs.len(), 123, "fixture size");
    // Every position must be exactly f32, or grading `noise_machine_pow` at
    // `x as f32` would be evaluating a different point than the game did.
    for (i, p) in positions.iter().enumerate() {
        let x = p.get("x").as_f64();
        assert_eq!(f64::from(x as f32), x, "position {i} is not exactly f32");
    }

    for (exponent, eval) in [
        (
            "2.5",
            &(|x: f32| noise_machine_pow(x, 2.5)) as &dyn Fn(f32) -> f32,
        ),
        ("0.5", &|x: f32| noise_machine_pow(x, 0.5)),
        ("1/3", &fast_cbrt),
        ("2", &|x: f32| noise_machine_pow(x, 2.0)),
    ] {
        let values = pow_series(&fixture, exponent);
        assert_all_f32(values, exponent);
        let (exact, worst) = score_case(values, |i| eval(xs[i]));
        assert_eq!(worst, 0.0, "worst absolute error for exponent {exponent}");
        assert_eq!(exact, 123, "exact f32 matches for exponent {exponent}");
    }
}

/// **The guards that stop the test above being self-satisfied.**
///
/// Each asserts that the WRONG model disagrees at many positions. Without them
/// the fixture could drift onto positions where every candidate agrees, and the
/// test above would endorse nothing.
///
/// `> 10` rather than `> 0`, so a single coincidental position cannot satisfy
/// them.
#[test]
fn the_pow_fixture_still_discriminates_between_the_three_branches() {
    let fixture = load("test/fixtures/oracle-fastpow.seed123456.json");
    let xs: Vec<f32> = fixture
        .get("positions")
        .as_array()
        .iter()
        .map(|p| p.get("x").as_f64() as f32)
        .collect();

    // An exponent of 0.5 is an EXACT square root, not fastapprox. This was not
    // predicted - the TypeScript spec first asserted fastapprox here and the
    // game refuted it at the first position.
    let half = pow_series(&fixture, "0.5");
    let wrong = xs
        .iter()
        .enumerate()
        .filter(|(i, &x)| f64::from(fast_pow(x, 0.5)) != half[*i].as_f64())
        .count();
    assert!(
        wrong > 10,
        "fastapprox now matches x^0.5 at all but {wrong} positions, so the sqrt \
         special case has been misread or the fixture no longer discriminates"
    );

    // An INTEGRAL exponent takes powSafe's exact squaring path. That matters
    // because `fast_pow`'s other call sites pass an integer `octaves`, which
    // makes "so those are wrong too" a very natural inference - and it is
    // FALSE: swapping the multioctave norm to squaring makes its oracle error
    // 20x worse.
    let two = pow_series(&fixture, "2");
    let squaring_wrong = xs
        .iter()
        .enumerate()
        .filter(|(i, &x)| f64::from(x * x) != two[*i].as_f64())
        .count();
    assert_eq!(squaring_wrong, 0, "x^2 must be exact squaring");
    let fastapprox_wrong = xs
        .iter()
        .enumerate()
        .filter(|(i, &x)| f64::from(fast_pow(x, 2.0)) != two[*i].as_f64())
        .count();
    assert!(
        fastapprox_wrong > 10,
        "fastapprox now matches x^2 at all but {fastapprox_wrong} positions, so \
         the integral fast path has been misread"
    );

    // The pre-`9b49ebb` single-rounding fastapprox must FAIL, which is what
    // turns this fixture from a confirmation of the current code into an
    // adjudication between the two. Reproduced here rather than imported,
    // because it no longer exists in `src/`.
    fn old_log2(x: f32) -> f32 {
        let bits = x.to_bits();
        let y = (f64::from(bits) * 1.192_092_895_507_812_5e-7) as f32;
        let mx = f32::from_bits((bits & 0x007f_ffff) | 0x3f00_0000);
        (f64::from(y)
            - 124.225_514_99
            - 1.498_030_302 * f64::from(mx)
            - 1.725_879_99 / (0.352_088_706_8 + f64::from(mx))) as f32
    }
    fn old_pow2(p: f32) -> f32 {
        let clipp = if p < -126.0 { -126.0 } else { f64::from(p) };
        let z = (clipp - clipp.trunc() + if clipp < 0.0 { 1.0 } else { 0.0 }) as f32;
        let v = (8_388_608.0
            * (clipp + 121.274_057_5 + 27.728_023_3 / (4.842_525_68 - f64::from(z))
                - 1.490_129_07 * f64::from(z))) as f32;
        f32::from_bits(v as i32 as u32)
    }
    let two_point_five = pow_series(&fixture, "2.5");
    let old_wrong = xs
        .iter()
        .enumerate()
        .filter(|(i, &x)| f64::from(old_pow2(2.5 * old_log2(x))) != two_point_five[*i].as_f64())
        .count();
    assert!(
        old_wrong > 10,
        "the old single-rounding fastapprox now agrees at all but {old_wrong} \
         positions, so per-operation rounding has been undone or the fixture \
         drifted onto non-discriminating points"
    );
}

/// `multisample(e, dx, dy)` at `(x, y)` equals `e` evaluated at
/// `(x + dx, y + dy)` - a plain integer coordinate shift, not a supersample.
///
/// The fixture routes the bare `x` and bare `y` variables through the builtin,
/// so the returned number IS the world coordinate it sampled and no inversion
/// is needed. 15 offsets x 5 points x 2 axes = 150 comparisons, and the game's
/// values are exact, so this asserts equality rather than a bound.
/// `test/multisample.spec.ts` asserts the same.
#[test]
fn reproduces_the_native_multisample_shift_at_all_150_comparisons() {
    let fixture = load("test/fixtures/oracle-multisample.seed123456.json");
    let positions = fixture.get("positions").as_array();
    let cases = fixture.get("cases").as_array();

    let mut compared = 0usize;
    for case in cases {
        let dx = case.get("dx").as_f64();
        let dy = case.get("dy").as_f64();
        let sampled_x = case.get("sampledX").as_f64_array();
        let sampled_y = case.get("sampledY").as_f64_array();
        for (i, p) in positions.iter().enumerate() {
            let (x, y) = (p.get("x").as_f64(), p.get("y").as_f64());
            assert_eq!(
                multisample(|xx, _yy| xx, x, y, dx, dy),
                sampled_x[i],
                "x at ({x},{y}) dx={dx} dy={dy}"
            );
            assert_eq!(
                multisample(|_xx, yy| yy, x, y, dx, dy),
                sampled_y[i],
                "y at ({x},{y}) dx={dx} dy={dy}"
            );
            compared += 2;
        }
    }
    assert_eq!(compared, 150, "fixture size");
}

/// **The port implements the ONE-TILE channel only, and that limit is measured
/// rather than asserted in a comment** (#83, open).
///
/// `oracle-multisample-grid` reads the same builtin through the CLIFF
/// generator, whose grid is the 4-tile corner lattice, and a `dx` of 4 moves
/// the field by **16** tiles there - 4 x the grid step - against the 4 this port
/// applies. The two agree in the 1-tile channel that
/// `calculate_tile_properties` and the tile renderer use, which is where the
/// fixture above was captured.
///
/// So this test pins three things at once: that the fixture still shows the 4x
/// scaling, that the port does NOT reproduce it, and that the null control
/// holds. If a future change makes the port grid-aware, this test is the one
/// that should be rewritten - not deleted.
#[test]
fn the_multisample_port_implements_the_one_tile_channel_only() {
    let fixture = load("test/fixtures/oracle-multisample-grid.seed123456.json");
    let cases = fixture.get("cases").as_array();
    assert_eq!(cases.len(), 4, "four arms");

    /// The cell column a set of cliffs sits in, ignoring off-lattice
    /// crater-cliffs.
    fn columns(case: &Json) -> Vec<i64> {
        let mut out: Vec<i64> = case
            .get("cliffs")
            .as_array()
            .iter()
            .filter(|c| c.get("name").as_str() == "cliff-vulcanus")
            .map(|c| c.get("x").as_f64())
            .filter(|x| x.fract() == 0.0)
            .map(|x| x as i64)
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    for case in cases {
        let e = case.get("effective");
        assert_eq!(e.get("cliff_elevation_0").as_f64(), 71.0);
        assert_eq!(e.get("cliff_elevation_interval").as_f64(), 1_000_000.0);
        assert_eq!(e.get("cliff_smoothing").as_f64(), 0.0);
        assert_eq!(e.get("richness").as_f64(), 4.0);
        // Non-vacuity: every arm actually placed cliffs, so comparing columns
        // is comparing something.
        assert!(!columns(case).is_empty(), "an arm placed no cliffs");
    }

    let baseline = columns(&cases[0]);
    assert_eq!(
        baseline,
        vec![70],
        "a single column makes a shift unambiguous"
    );
    assert_eq!(columns(&cases[1]), baseline, "multisample(x, 0, 0) == x");
    assert_eq!(
        columns(&cases[3]),
        baseline,
        "dy cannot move a vertical contour"
    );

    // The measurement. 4 tiles would have left the column at 70 or moved it to
    // 66; the game moved it to 54, which is 16 tiles.
    let shifted = columns(&cases[2]);
    assert_eq!(shifted, vec![54]);
    assert_eq!(baseline[0] - shifted[0], 16, "the game shifted 16 tiles");

    // And this port shifts by 4, not 16. Stated as an assertion so "the port
    // implements the 1-tile channel" cannot quietly stop being true.
    assert_eq!(multisample(|x, _y| x, 70.0, 0.0, 4.0, 0.0), 74.0);
    assert_ne!(multisample(|x, _y| x, 70.0, 0.0, 4.0, 0.0), 86.0);
}

/// `map_seed_normalized` and `map_seed_small` across 12 seeds spanning the
/// 32-bit range, plus the `x_from_start`/`y_from_start` identity.
///
/// `test/vulcanusSeed.spec.ts` asserts the same rows. The discriminating one is
/// `seed0 = 0xFFFFFFFF`: plain f64 division gives 0.9999999997671694, and only
/// the f32 narrowing reaches the oracle's exact 1.
#[test]
fn reproduces_every_game_captured_seed_variable() {
    let fixture = load("test/fixtures/oracle-seed-vars.multi.json");
    let rows = fixture.get("seeds").as_array();
    assert_eq!(rows.len(), 12, "fixture size");

    let mut saw_the_top_of_the_range = false;
    for row in rows {
        let seed0 = row.get("seed0").as_f64() as u32;
        let want_normalized = row.get("mapSeedNormalized").as_f64();
        assert_eq!(
            f64::from(seed_normalized(seed0)),
            want_normalized,
            "map_seed_normalized for seed0={seed0}"
        );
        assert_eq!(
            f64::from(seed_small(seed0)),
            row.get("mapSeedSmall").as_f64(),
            "map_seed_small for seed0={seed0}"
        );
        if seed0 == u32::MAX {
            saw_the_top_of_the_range = true;
            assert_eq!(want_normalized, 1.0, "the oracle's own value at 0xFFFFFFFF");
        }
    }
    assert!(
        saw_the_top_of_the_range,
        "the fixture no longer carries the one row that discriminates f32 \
         narrowing from plain division"
    );
}

/// `x_from_start` and `y_from_start` are the other two seed vars in that
/// fixture, and they need no port: at the default spawn they ARE `x` and `y`.
///
/// Pinned rather than left as a note, because a non-default spawn would change
/// it and this fixture is where that would show up.
#[test]
fn the_from_start_vars_are_the_identity_at_the_default_spawn() {
    let fixture = load("test/fixtures/oracle-seed-vars.multi.json");
    let point = fixture.get("point");
    let (x, y) = (point.get("x").as_f64(), point.get("y").as_f64());
    for row in fixture.get("seeds").as_array() {
        assert_eq!(row.get("xFromStart").as_f64(), x);
        assert_eq!(row.get("yFromStart").as_f64(), y);
    }
}

/// `slider_rescale(s, 2)` at the seven literal slider positions the game was
/// probed at.
///
/// **The default slider cannot see any of this.** At `s = 1` the exponent is
/// exactly 0 and the whole call is a multiply by one, so all 101 captured
/// positions in that fixture accept any implementation. The probe exists for
/// exactly that reason.
///
/// The guard below is the other half: the f64-rounded-once form must MISS at
/// `s = 0.5` and `s = 5`, and fastapprox must miss almost everywhere. Without
/// them, "per-operation f32" would be endorsed by a test that any of the three
/// candidates passes.
#[test]
fn reproduces_the_games_slider_rescale_at_all_seven_probe_points() {
    let fixture = load("test/fixtures/oracle-fulgora-elevation.seed123456.json");
    let probe = fixture.get("sliderRescaleProbe");

    let points = ["0.5", "1", "2", "3", "4", "5", "6"];
    let mut exact = 0usize;
    for key in points {
        let s: f64 = key.parse().expect("probe key is a number");
        let want = probe.get(key).as_f64();
        assert_eq!(
            f64::from(want as f32),
            want,
            "probe value at s={key} is not exactly f32"
        );
        assert_eq!(
            f64::from(slider_rescale(s, 2.0)),
            want,
            "slider_rescale({key}, 2)"
        );
        exact += 1;
    }
    assert_eq!(exact, 7, "probe size");

    // The f64-rounded-once form misses exactly two of the seven, and they are
    // the two the fixture's own provenance names. An implementation that
    // agreed everywhere would mean the probe had stopped discriminating.
    let f64_misses = points
        .iter()
        .filter(|key| {
            let s: f64 = key.parse().unwrap();
            f64::from(slider_rescale_f64(s, 2.0) as f32) != probe.get(key).as_f64()
        })
        .count();
    assert_eq!(
        f64_misses, 2,
        "the f64 form should miss s=0.5 and s=5 and nothing else"
    );

    // And the noise machine's fastapprox `^` misses almost all of them, which
    // is why this resolves on the prototype side rather than through powSafe.
    let fastapprox_misses = points
        .iter()
        .filter(|key| {
            let s: f64 = key.parse().unwrap();
            let ratio = ((f64::from(s.log2() as f32)) / f64::from(6.0f64.log2() as f32)) as f32;
            let got = noise_machine_pow(2.0, ratio * (2.0f64.log2() as f32));
            f64::from(got) != probe.get(key).as_f64()
        })
        .count();
    assert!(
        fastapprox_misses >= 5,
        "fastapprox now matches {} of 7 probe points, so the exact-math reading \
         has been misread or the probe drifted",
        7 - fastapprox_misses
    );
}

// ---------------------------------------------------------------------------
// Phase 3 - Fulgora's landmask chain (#223).
//
// ## Why these assert exact counts that are NOT 101 of 101
//
// Every other tier-1 test in this file asserts a full exact-match count,
// because its op is bit-exact against the game. Fulgora's elevation chain is
// not, and the counts below are the measured truth rather than a target.
//
// **Each one was measured against the TypeScript side by side, and all 21
// agree exactly** - same exact-match count, same worst residual. So these
// numbers describe the PORT's known distance from the game, which both
// implementations share, and not anything this Rust port introduced. That
// symmetry is the reason it is honest to freeze them here: a change to any of
// them is a change to the port, and the test names the field.
//
// **#273 has landed, and these counts are its result.** The chain's literals
// were f64 where the game holds them at f32, and a further set of intermediates
// were rounded once at the end rather than per operation. Eight fixes were
// taken, each one accepted ONLY because its own field reached a full 101/101 at
// a residual of exactly 0 - never because a count merely improved. Thirteen
// fields went from inexact to bit-exact: `wobble_mask`, `wx`, `wy`, `basis`,
// `basis_oil`, `rock`, `dunes`, `natural`, `sprawl_pyramids`, `pyramids`,
// `pyramids_banding`, `ruins_walls` and `tile_ruin_walls`.
//
// **Two counts went DOWN by one and that is recorded rather than hidden**:
// `fulgora_pre_elevation` 44 -> 43 and `fulgora_tile_ruin_machinery` 95 -> 94.
// Both are deep composites that are still inexact, so their inputs moving
// closer to the game reshuffles which individual positions happen to round the
// same way. That is expected churn in an unconverged chain, not a regression in
// any op - every field feeding them improved or held.
//
// **What did NOT move is the tile argmax**: 4,915 of 5,057 before and after,
// with the same 7 land/ocean and 11 shallow/deep misses. Those are
// boundary-exclusive and this was never their cause. The whole-image terrain
// preview went 34,976 -> 34,977 differing pixels of 1,048,576 - one pixel
// WORSE. This class of fix buys bit-exactness on named fields, not a better
// picture; the image is dominated by the `mix_*` chain #273 could not reach.
//
// The remaining inexact fields are the `mix_*` chain and everything downstream
// of the two starting cones. Their blocker is `starting_spot_at_angle`, which
// evaluates in f64 and is shared with Vulcanus - narrowing it takes both cones
// to 101/101 but regresses `vulcanus_starting_calcite`, so it is #279 and
// belongs with #270 and #225.
//
// If you are here because one of these counts moved: read the number, do not
// adjust it. Up is a finding worth taking; down is a regression.
// ---------------------------------------------------------------------------

use crate::expressions::fulgora_cells::FulgoraCells;
use crate::expressions::fulgora_elevation::FulgoraElevation;
use crate::expressions::fulgora_shared::{FulgoraCtx, FulgoraShared};
use crate::expressions::starting_spot_at_angle::{starting_spot_at_angle, AngleTrig, StartingSpot};
use crate::tiles::fulgora_ocean::{ocean_tile, Ocean};

/// Score one named field against its fixture column, at f32.
///
/// Both sides narrow to f32 first, exactly as the TypeScript's own comparator
/// does: the game reports f32 values and the chain models f32 arithmetic, so an
/// f64 comparison would measure the host's extra precision rather than the port.
fn score_fulgora(got: &[f64], want: &[Json], label: &str) -> usize {
    assert_eq!(got.len(), want.len(), "{label}: length mismatch");
    let mut exact = 0usize;
    for (i, w) in want.iter().enumerate() {
        if (got[i] as f32) == (w.as_f64() as f32) {
            exact += 1;
        }
    }
    exact
}

/// Evaluate the whole chain once at every fixture position.
fn fulgora_sweep(
    seed0: u32,
    positions: &[Json],
) -> (
    Vec<crate::expressions::fulgora_shared::SharedFields>,
    Vec<crate::expressions::fulgora_cells::CellFields>,
    Vec<crate::expressions::fulgora_elevation::ElevationFields>,
) {
    let ctx = FulgoraCtx::new(seed0);
    let shared = FulgoraShared::with_host_trig(&ctx);
    let mut cells = FulgoraCells::new(&ctx, shared.grid);
    let elevation = FulgoraElevation::new(&ctx, shared.grid);

    let mut s_out = Vec::with_capacity(positions.len());
    let mut c_out = Vec::with_capacity(positions.len());
    let mut e_out = Vec::with_capacity(positions.len());
    for p in positions {
        let (x, y) = (p.get("x").as_f64(), p.get("y").as_f64());
        let s = shared.eval(x, y);
        let c = cells.eval(&s);
        let e = elevation.eval(x, y, &s, &c);
        s_out.push(s);
        c_out.push(c);
        e_out.push(e);
    }
    (s_out, c_out, e_out)
}

/// The shared layer: the wobble fields, the offset and distorted coordinates,
/// and the two starting cones.
#[test]
fn reproduces_the_fulgora_shared_layer_at_every_captured_position() {
    let fixture = load("test/fixtures/oracle-fulgora-shared.seed123456.json");
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 101, "fixture size");
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let (shared_fields, _, _) = fulgora_sweep(seed0, positions);

    // `fulgora_grid` is a program constant, and the fixture repeats it at every
    // position - so the check is that it is ONE value and that it is ours.
    let grids = fixture.get("fulgora_grid").as_f64_array();
    assert!(grids.iter().all(|g| *g == grids[0]), "grid is not constant");
    assert_eq!(grids[0], 175.0);
    assert_eq!(
        FulgoraShared::with_host_trig(&FulgoraCtx::new(seed0)).grid,
        175.0
    );

    type S = crate::expressions::fulgora_shared::SharedFields;
    for (key, want_exact, select) in [
        (
            "fulgora_wobble_influence",
            101,
            &(|f: &S| f.wobble_influence) as &dyn Fn(&S) -> f64,
        ),
        ("fulgora_wobble_mask", 101, &|f| f.wobble_mask),
        ("fulgora_wobble_x", 101, &|f| f.wobble_x),
        ("fulgora_wobble_y", 101, &|f| f.wobble_y),
        ("fulgora_ox", 101, &|f| f.ox),
        ("fulgora_oy", 101, &|f| f.oy),
        ("fulgora_wx", 101, &|f| f.wx),
        ("fulgora_wy", 101, &|f| f.wy),
        ("fulgora_starting_cone", 83, &|f| f.starting_cone),
        ("fulgora_starting_vault_cone", 85, &|f| {
            f.starting_vault_cone
        }),
        ("fulgora_starting_mask", 101, &|f| f.starting_mask),
        ("fulgora_starting_vault_mask", 101, &|f| {
            f.starting_vault_mask
        }),
    ] {
        let got: Vec<f64> = shared_fields.iter().map(select).collect();
        assert_eq!(
            score_fulgora(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 101"
        );
    }
}

/// The Voronoi layer and the island classification.
///
/// `fulgora_cells` is exact at 101/101 and that is not luck: `cell_id` is a
/// DISCRETE lookup, so a sub-ULP coordinate error almost never changes which
/// cell won. `pyramids` and `spots` read the same coordinates and are
/// continuous, so the same input error passes straight through - which is why
/// `pyramids` is one short.
#[test]
fn reproduces_the_fulgora_cell_classification_at_every_captured_position() {
    let shared_fx = load("test/fixtures/oracle-fulgora-shared.seed123456.json");
    let fixture = load("test/fixtures/oracle-fulgora-cells.seed123456.json");
    let positions = fixture.get("positions").as_array();

    // The two fixtures are compared field against field, so if their position
    // lists ever drift apart every such comparison silently stops meaning
    // anything.
    let shared_positions = shared_fx.get("positions").as_array();
    assert_eq!(positions.len(), shared_positions.len());
    for (a, b) in positions.iter().zip(shared_positions) {
        assert_eq!(a.get("x").as_f64(), b.get("x").as_f64());
        assert_eq!(a.get("y").as_f64(), b.get("y").as_f64());
    }

    let (_, cell_fields, _) = fulgora_sweep(fixture.get("seed0").as_f64() as u32, positions);

    type C = crate::expressions::fulgora_cells::CellFields;
    for (key, want_exact, select) in [
        (
            "fulgora_cells",
            101,
            &(|f: &C| f.cells) as &dyn Fn(&C) -> f64,
        ),
        ("fulgora_pyramids", 101, &|f| f.pyramids),
        ("fulgora_spots", 101, &|f| f.spots),
        ("fulgora_spots_inv", 101, &|f| f.spots_inv),
        ("fulgora_blanks", 101, &|f| f.blanks),
        ("fulgora_mesa", 101, &|f| f.mesa),
        ("fulgora_sprawl", 101, &|f| f.sprawl),
        ("fulgora_vaults", 101, &|f| f.vaults),
        ("fulgora_vaults_and_starting_vault", 101, &|f| {
            f.vaults_and_starting_vault
        }),
    ] {
        let got: Vec<f64> = cell_fields.iter().map(select).collect();
        assert_eq!(
            score_fulgora(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 101"
        );
    }

    // The four classes partition every captured position, which is what makes
    // defining `vaults` as the remainder safe.
    for f in &cell_fields {
        assert_eq!(f.blanks + f.sprawl + f.mesa + f.vaults, 1.0);
    }
}

/// The elevation mix chain, all 20 named expressions.
///
/// The two INTERNAL nodes - `fulgora_vault_pyramids_and_start` and
/// `fulgora_pre_elevation` - are captured and graded here even though nothing
/// outside the chain reads them, so a transcription error in either localises
/// instead of arriving blended into `elevation`.
#[test]
fn reproduces_the_fulgora_elevation_chain_at_every_captured_position() {
    let fixture = load("test/fixtures/oracle-fulgora-elevation.seed123456.json");
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 101, "fixture size");
    let (_, _, e) = fulgora_sweep(fixture.get("seed0").as_f64() as u32, positions);

    type E = crate::expressions::fulgora_elevation::ElevationFields;
    for (key, want_exact, select) in [
        (
            "fulgora_basis",
            101,
            &(|f: &E| f.basis) as &dyn Fn(&E) -> f64,
        ),
        ("fulgora_basis_oil", 101, &|f| f.basis_oil),
        ("fulgora_rock", 101, &|f| f.rock),
        ("fulgora_dunes", 101, &|f| f.dunes),
        ("fulgora_scrap_medium", 101, &|f| f.scrap_medium),
        ("fulgora_natural", 101, &|f| f.natural),
        ("fulgora_sprawl_pyramids", 101, &|f| f.sprawl_pyramids),
        ("fulgora_vault_pyramids", 85, &|f| f.vault_pyramids),
        ("fulgora_vault_pyramids_and_start", 77, &|f| {
            f.vault_pyramids_and_start
        }),
        ("fulgora_moats", 68, &|f| f.moats),
        ("fulgora_mix_pyramids", 93, &|f| f.mix_pyramids),
        ("fulgora_mix_natural", 94, &|f| f.mix_natural),
        ("fulgora_mix_moats", 59, &|f| f.mix_moats),
        ("fulgora_vault_spots", 67, &|f| f.vault_spots),
        ("fulgora_mix_spots", 62, &|f| f.mix_spots),
        ("fulgora_oil_mask", 101, &|f| f.oil_mask),
        ("fulgora_mix_oil", 53, &|f| f.mix_oil),
        ("fulgora_sand_basins", 50, &|f| f.sand_basins),
        ("fulgora_pre_elevation", 43, &|f| f.pre_elevation),
        ("fulgora_elevation", 41, &|f| f.elevation),
    ] {
        let got: Vec<f64> = e.iter().map(select).collect();
        assert_eq!(
            score_fulgora(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 101"
        );
    }
}

/// **The regression guard for #273's `fulgora_dunes` fix, which has landed.**
///
/// `fulgora_scrap_medium` is the same op family as `dunes` - same octaves, same
/// persistence, different input scale - with NO added constant, and it scored
/// 101/101 throughout. So the multioctave underneath `dunes` was always exact
/// and the entire gap was the `0.66`.
///
/// This test holds BOTH forms side by side and asserts the typed one reaches
/// **exactly 0**, the standard `src/noise/eval/f32.ts` sets for confirming a
/// mechanism. It was written as a planted fix while #273 was open; now that the
/// fix ships it is what stops anyone "simplifying" the literal back, and the
/// 26 below is the cost of doing so rather than a description of the port.
#[test]
fn typing_the_dunes_constant_f32_reaches_exactly_zero_residual() {
    use crate::multioctave_noise::{multioctave_noise, MultioctaveParams};
    let fixture = load("test/fixtures/oracle-fulgora-elevation.seed123456.json");
    let positions = fixture.get("positions").as_array();
    let want = fixture.get("fulgora_dunes").as_array();
    let params = MultioctaveParams {
        seed0: fixture.get("seed0").as_f64() as u32,
        seed1: 1_783_911_317,
        octaves: 3.0,
        persistence: 0.7,
        input_scale: 1.0 / 6.0,
        output_scale: 1.0,
    };

    let mut exact_f32_constant = 0usize;
    let mut exact_f64_constant = 0usize;
    let mut worst_f32_constant = 0.0f64;
    for (i, w) in want.iter().enumerate() {
        let p = &positions[i];
        let v = multioctave_noise(p.get("x").as_f64(), p.get("y").as_f64(), &params);
        let b = w.as_f64() as f32;

        // Case 2 of the two-case rule: the CONSTANT is typed f32, so the
        // subtraction happens at f32 against the value the engine holds.
        let with_f32 = 0.66f32 - v.abs();
        worst_f32_constant = worst_f32_constant.max(f64::from((with_f32 - b).abs()));
        if with_f32 == b {
            exact_f32_constant += 1;
        }

        // What ships today: f64 throughout, narrowed once at the comparison.
        if ((0.66 - f64::from(v.abs())) as f32) == b {
            exact_f64_constant += 1;
        }
    }

    assert_eq!(
        exact_f32_constant, 101,
        "typing 0.66 as f32 should be exact - this is the form that ships"
    );
    assert_eq!(worst_f32_constant, 0.0, "and reach a residual of exactly 0");
    assert_eq!(
        exact_f64_constant, 26,
        "an f64 `0.66` scores 26 - this is what reverting the #273 fix would \
         cost, not what the port does"
    );
}

/// `starting_spot_at_angle` against the game, at all four captured cases.
///
/// The fixture is a Vulcanus capture, which is fine and deliberate: the
/// expression is planet-independent and Vulcanus is where it was first
/// recovered. Fulgora reads the same one.
#[test]
fn reproduces_the_games_starting_spot_at_angle_at_every_case() {
    let fixture = load("test/fixtures/oracle-starting-spot.seed123456.json");
    let positions = fixture.get("positions").as_array();
    let cases = fixture.get("cases").as_array();
    assert_eq!(positions.len(), 38, "fixture size");
    assert_eq!(cases.len(), 4, "case count");

    let mut compared = 0usize;
    let mut exact = 0usize;
    for case in cases {
        let spot = StartingSpot {
            trig: AngleTrig::from_degrees(case.get("angle").as_f64()),
            distance: case.get("distance").as_f64(),
            radius: case.get("radius").as_f64(),
        };
        let (dx, dy) = (
            case.get("xDistortion").as_f64(),
            case.get("yDistortion").as_f64(),
        );
        let values = case.get("values").as_array();
        for (i, w) in values.iter().enumerate() {
            let p = &positions[i];
            let got =
                starting_spot_at_angle(&spot, p.get("x").as_f64(), p.get("y").as_f64(), dx, dy);
            if (got as f32) == (w.as_f64() as f32) {
                exact += 1;
            }
            compared += 1;
        }
    }
    assert_eq!(compared, 152, "4 cases x 38 positions");
    // 88, measured against the TypeScript side by side rather than assumed -
    // it scores 88 too, with the same 2.384e-7 worst residual. It is not 152
    // because the expression is f64 throughout while the game evaluates in f32,
    // the same known port gap the elevation chain carries.
    //
    // The four captured angles are 0, 45, 90 and 180, so this test says nothing
    // about a libm disagreement at an arbitrary bearing. Nothing here has to:
    // the trig is an INPUT to this function, and tier 2 hands both ports the
    // identical values. See `starting_spot_at_angle`'s module docs and #270.
    assert_eq!(exact, 88, "exact f32 matches out of 152");
}

/// **The end-to-end gate: does the port put land and ocean where the GAME puts
/// them?**
///
/// Every other test here compares an expression against the same expression
/// evaluated by the game. This one compares against `surface.get_tile(x, y).name`
/// after real chunk generation - the tile the game actually placed. That is a
/// different and stronger question: the elevation chain can agree to 1e-7
/// everywhere and still put the coastline in the wrong place.
///
/// The two counts are the same ones `test/fulgoraAgreement.spec.ts` asserts,
/// and its header explains at length why they are not zero: the seven
/// land-versus-ocean misses are positions where the GAME's own expressions
/// score every ocean tile unplaceable, so no transcription of them can
/// reproduce it. All 18 sit at Chebyshev distance exactly 1 from a tile this
/// port already classes the game's way, which points at a post-argmax
/// correction pass rather than at the expressions.
#[test]
fn puts_fulgora_land_and_ocean_where_the_game_puts_them() {
    let fixture = load("test/fixtures/oracle-fulgora-tiles.seed123456.json");
    let positions = fixture.get("positions").as_array();
    let names = fixture.get("tileNames").as_array();
    assert_eq!(positions.len(), 5057, "fixture size");

    let (_, _, elevation_fields) = fulgora_sweep(fixture.get("seed0").as_f64() as u32, positions);

    let mut binary_misses = 0usize;
    let mut shallow_deep_misses = 0usize;
    let mut ocean_tiles = 0usize;
    for (i, name) in names.iter().enumerate() {
        let game = name.as_str();
        let game_is_ocean = game.starts_with("oil-ocean");
        let game_is_deep = game.starts_with("oil-ocean-deep");
        if game_is_ocean {
            ocean_tiles += 1;
        }

        let ours = ocean_tile(&elevation_fields[i]);
        if ours.is_some() != game_is_ocean {
            binary_misses += 1;
        } else if let Some(kind) = ours {
            // Only meaningful where both agree it is ocean.
            if (kind == Ocean::Deep) != game_is_deep {
                shallow_deep_misses += 1;
            }
        }
    }

    assert_eq!(ocean_tiles, 2796, "ocean tiles in the fixture");
    assert_eq!(binary_misses, 7, "land/ocean disagreements out of 5057");
    assert_eq!(
        shallow_deep_misses, 11,
        "shallow/deep disagreements among tiles both sides call ocean"
    );
}

// ---------------------------------------------------------------------------
// Phase 4 - the rest of Fulgora (#224).
//
// Same rule as phase 3's block above: the counts are the measured truth, each
// one checked against the TypeScript side by side, and a change to any of them
// is a finding rather than a number to adjust.
// ---------------------------------------------------------------------------

use crate::expressions::fulgora_scrap::ScrapControls;
use crate::expressions::fulgora_stack::{FulgoraStack, StackFields};

/// Sweep the whole Fulgora graph once at every fixture position.
fn fulgora_stack_sweep(seed0: u32, positions: &[Json]) -> Vec<StackFields> {
    let ctx = FulgoraCtx::new(seed0);
    let mut stack = FulgoraStack::with_host_trig(&ctx, &ScrapControls::default());
    positions
        .iter()
        .map(|p| stack.eval(p.get("x").as_f64(), p.get("y").as_f64()))
        .collect()
}

/// The masks, the road and structure layer, the ruins layer, and the four land
/// probabilities the fixture reports directly.
///
/// **Six fields here are exact at 101/101 and that is worth reading**, because
/// they are the ones the two-case f32 rule was applied to: `structure_cells`,
/// `structure_subnoise` and `structure_facets` all reach exactly 0 residual.
/// `structure_facets` needs the CONSTANT narrowed (`y * 0.8f32`) and
/// `structure_subnoise` needs the PRODUCT narrowed
/// (`x + f32(10000 * structure_cells)`) - opposite fixes, worth 7.629e-6 and
/// 131x respectively. If either regresses, this is where it shows.
#[test]
fn reproduces_the_fulgora_ruins_layer_at_every_captured_position() {
    let fixture = load("test/fixtures/oracle-fulgora-ruins.seed123456.json");
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 101, "fixture size");
    let f = fulgora_stack_sweep(fixture.get("seed0").as_f64() as u32, positions);

    type S = StackFields;
    for (key, want_exact, select) in [
        (
            "fulgora_natural_mask",
            101,
            &(|f: &S| f.masks.natural) as &dyn Fn(&S) -> f64,
        ),
        ("fulgora_natural_and_mesa_mask", 101, &|f: &S| {
            f.masks.natural_and_mesa
        }),
        ("fulgora_artificial_mask", 101, &|f: &S| f.masks.artificial),
        ("fulgora_road_cells", 101, &|f: &S| f.roads.road_cells),
        ("fulgora_road_pyramids", 101, &|f: &S| f.roads.road_pyramids),
        ("fulgora_pyramids_banding", 101, &|f: &S| {
            f.roads.pyramids_banding
        }),
        ("fulgora_spots_prebanding", 91, &|f: &S| {
            f.roads.spots_prebanding
        }),
        ("fulgora_spots_banding", 46, &|f: &S| f.roads.spots_banding),
        ("fulgora_structure_cells", 101, &|f: &S| {
            f.roads.structure_cells
        }),
        ("fulgora_structure_subnoise", 101, &|f: &S| {
            f.roads.structure_subnoise
        }),
        ("fulgora_structure_facets", 101, &|f: &S| {
            f.roads.structure_facets
        }),
        ("fulgora_road_paving_thin", 101, &|f: &S| {
            f.roads.road_paving_thin
        }),
        ("fulgora_road_paving_2", 101, &|f: &S| f.roads.road_paving_2),
        ("fulgora_road_paving_2b", 101, &|f: &S| {
            f.roads.road_paving_2b
        }),
        ("fulgora_road_paving_2c", 101, &|f: &S| {
            f.roads.road_paving_2c
        }),
        ("fulgora_road_dust", 101, &|f: &S| f.roads.road_dust),
        ("fulgora_ruins_walls", 101, &|f: &S| f.ruins.ruins_walls),
        ("fulgora_ruins_paving", 101, &|f: &S| f.ruins.ruins_paving),
        ("fulgora_tile_ruin_paving", 97, &|f: &S| {
            f.ruins.tile_ruin_paving
        }),
        ("fulgora_tile_ruin_walls", 101, &|f: &S| {
            f.ruins.tile_ruin_walls
        }),
        ("fulgora_tile_ruin_conduit", 96, &|f: &S| {
            f.ruins.tile_ruin_conduit
        }),
        ("fulgora_tile_ruin_machinery", 94, &|f: &S| {
            f.ruins.tile_ruin_machinery
        }),
        ("fulgoran_dust_probability", 45, &|f: &S| {
            f.land_probabilities()[0]
        }),
        ("fulgoran_dunes_probability", 98, &|f: &S| {
            f.land_probabilities()[1]
        }),
        ("fulgoran_sand_probability", 96, &|f: &S| {
            f.land_probabilities()[2]
        }),
        ("fulgoran_rock_probability", 80, &|f: &S| {
            f.land_probabilities()[3]
        }),
    ] {
        let got: Vec<f64> = f.iter().map(select).collect();
        assert_eq!(
            score_fulgora(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 101"
        );
    }
}

/// `fulgora_ruins_walls` is the SAME `0.66 - abs(v)` shape as `fulgora_dunes`,
/// and it scored 19/101 for the same reason before #273 typed the literal.
///
/// Recorded as its own test rather than folded into the table above, because
/// the point is not the count: it is that a second field carrying the identical
/// shape failed in the identical way. That is what turned #273 from three edits
/// into a sweep of the whole chain.
#[test]
fn the_ruins_walls_constant_is_the_same_f32_case_as_dunes() {
    use crate::multioctave_noise::{multioctave_noise, MultioctaveParams};
    let fixture = load("test/fixtures/oracle-fulgora-ruins.seed123456.json");
    let positions = fixture.get("positions").as_array();
    let want = fixture.get("fulgora_ruins_walls").as_array();
    let params = MultioctaveParams {
        seed0: fixture.get("seed0").as_f64() as u32,
        seed1: 2_307_136_174,
        octaves: 3.0,
        persistence: 0.7,
        input_scale: 1.0 / 6.0,
        output_scale: 1.0,
    };

    let mut with_f32 = 0usize;
    let mut with_f64 = 0usize;
    let mut worst_f32 = 0.0f64;
    for (i, w) in want.iter().enumerate() {
        let p = &positions[i];
        let v = multioctave_noise(p.get("x").as_f64(), p.get("y").as_f64(), &params);
        let b = w.as_f64() as f32;
        let typed = 0.66f32 - v.abs();
        worst_f32 = worst_f32.max(f64::from((typed - b).abs()));
        if typed == b {
            with_f32 += 1;
        }
        if ((0.66 - f64::from(v.abs())) as f32) == b {
            with_f64 += 1;
        }
    }
    assert_eq!(
        with_f32, 101,
        "typing 0.66 as f32 should be exact here too - this is the form that ships"
    );
    assert_eq!(worst_f32, 0.0, "and reach a residual of exactly 0");
    assert_eq!(
        with_f64, 19,
        "an f64 `0.66` scores 19 - this is what reverting the #273 fix would \
         cost, not what the port does"
    );
}

/// Fulgora's scrap probability and the two additive terms the game's own
/// diagnostic dump names.
///
/// All three are **101/101 exact**, which is the payoff for transcribing the
/// TypeScript's f32 narrowings operation for operation rather than tidying
/// them. The fixture is captured at the default sliders, so it cannot grade the
/// two slider cuts - `fulgora_scrap`'s module docs carry the reasoning and its
/// own unit test carries the numbers.
#[test]
fn reproduces_the_fulgora_scrap_probability_at_every_captured_position() {
    let fixture = load("test/fixtures/oracle-fulgora-scrap.seed123456.json");
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 101, "fixture size");

    // The capture is at neutral sliders, and the port must be told so rather
    // than assuming it - the fixture states it per position.
    for k in ["scrap_control_frequency", "scrap_control_size"] {
        for v in fixture.get(k).as_f64_array() {
            assert_eq!(v, 1.0, "{k} is not neutral in this fixture");
        }
    }

    let f = fulgora_stack_sweep(fixture.get("seed0").as_f64() as u32, positions);
    type S = StackFields;
    for (key, select) in [
        (
            "fulgora_scrap_probability",
            &(|f: &S| f.scrap.probability) as &dyn Fn(&S) -> f64,
        ),
        ("fulgora_scrap_struct_term", &|f: &S| f.scrap.struct_term),
        ("fulgora_scrap_vault_term", &|f: &S| f.scrap.vault_term),
    ] {
        let got: Vec<f64> = f.iter().map(select).collect();
        assert_eq!(
            score_fulgora(&got, fixture.get(key).as_array(), key),
            101,
            "{key} exact f32 matches out of 101"
        );
    }
}

/// **The full eight-way tile argmax against the tile the GAME actually
/// placed**, which is the strongest question this phase can ask.
///
/// Phase 3 graded only land-versus-ocean. This grades the winner among all ten
/// tiles at 5,057 positions, and 4,915 of them agree - the same count
/// `test/fulgoraLandTiles.spec.ts` reaches from the other side (it scopes to
/// 2,261 land positions and asserts 124 wrong, and 5057 - 2261 + 2137 = 4933
/// is not this number because the ocean half contributes its own 18 misses
/// too; the two are counting different populations, which is why this asserts
/// its own).
///
/// The `-2` variants collapse: the game distinguishes `oil-ocean-shallow-2` and
/// `oil-ocean-deep-2`, and this port models neither, so both fold onto their
/// base tile before comparing.
#[test]
fn puts_every_fulgora_tile_where_the_game_puts_it() {
    let fixture = load("test/fixtures/oracle-fulgora-tiles.seed123456.json");
    let positions = fixture.get("positions").as_array();
    let names = fixture.get("tileNames").as_array();
    assert_eq!(positions.len(), 5057, "fixture size");

    let f = fulgora_stack_sweep(fixture.get("seed0").as_f64() as u32, positions);
    let mut exact = 0usize;
    let mut seen_land_kinds = std::collections::BTreeSet::new();
    for (i, name) in names.iter().enumerate() {
        let game = name.as_str();
        let game_base = game.strip_suffix("-2").unwrap_or(game);
        let ours = f[i].tile().game_name();
        if ours == game_base {
            exact += 1;
        }
        if !game.starts_with("oil-ocean") {
            seen_land_kinds.insert(game_base);
        }
    }
    // Non-vacuity: the fixture really does contain all eight land tiles, so
    // this is grading an eight-way argmax rather than a two-way one.
    assert_eq!(
        seen_land_kinds.len(),
        8,
        "land tiles present: {seen_land_kinds:?}"
    );
    assert_eq!(exact, 4915, "tiles matching the game out of 5057");
}
