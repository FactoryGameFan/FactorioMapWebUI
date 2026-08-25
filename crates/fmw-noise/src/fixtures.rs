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
use crate::eval::math::max2;
use crate::test_json::{load, Json};
use std::collections::BTreeMap;

/// Load a fixture and pin the game version its ground truth was captured from.
///
/// The frozen exact counts in this file all describe "this port against game
/// version X", and until #295 not one of them said which X. Pinning it is still
/// worth doing - a re-capture at a new version should force a re-score rather
/// than sliding under a stale number.
///
/// **The example this comment used to give was wrong, and the correction is
/// worth more than the helper.** It read: `vulcanus_hairline_cracks` scores 50
/// of 61 against the 2.1.12 capture and 61 of 61 against a 2.1.14 one, "at the
/// SAME 61 positions with the SAME model", so 11 apparent port errors were the
/// game changing under the fixture. Measured, both halves are false:
///
/// - **The positions are not the same.** The 2.1.12 fixture records 21 of its
///   61 coordinates OFF the 1/256 `MapPosition` grid; the 2.1.14 one was
///   captured after `snapToMapPosition` landed and has none.
/// - **The gap is that snap, not the version.** The 2.1.12 fixture SNAPPED
///   scores 61 of 61 too. What was missing was the snap in `vulcanus_sweep` -
///   the counts were being scored at 21 points the game never evaluated.
///
/// **And the residual version effect is ZERO.** This comment used to say it was
/// "at most 2 counts and goes BOTH ways", citing `floodPaths` 34 -> 36 and
/// `floodCracksA` 55 -> 54. That was the same mistake one level down: those
/// counts compare each capture's score over its OWN 61 positions, and the two
/// captures share only **52** of their 61 points. Restricted to the points they
/// share, every field ties - 52, 46, 45, 28 and 31, identical on both captures -
/// so the whole apparent difference sits in the 9 they do not share (measured
/// 2026-08-25).
///
/// The mechanism is exact, and it is a property of the HARNESS rather than of
/// either version. A capture PRODUCES a grid coordinate with `Math.floor`
/// (`snapToMapPosition` in `test/oracle/capture.ts`); `test/captureGrid.ts`
/// RECOVERS one with `Math.trunc`, because truncation toward zero is what the
/// game does to a coordinate handed to it off the grid. Both are right for
/// their own job, and they differ by one cell on a NEGATIVE coordinate. The
/// re-capture's position equals `floor(old_raw)` at 61 of 61 and
/// `trunc(old_raw)` at 52.
///
/// So **a re-capture of an off-grid fixture cannot land on the points that
/// snapping the old one produces**, and comparing two captures' COUNTS is not a
/// version measurement at all. Compare VALUES at the points they share instead:
/// that uses no port code, so port error cannot confound it.
///
/// It was run twice. Against a fresh 2.1.16 capture all FIVE crack fields came
/// back bit-identical at every shared point, worst delta exactly 0; that
/// capture is not committed, because adopting it would move frozen counts for a
/// difference measured to be zero. What IS committed is the same comparison
/// between the two fixtures already in the tree - `the two captures agree
/// wherever they sample the same point` in
/// `test/vulcanusPlasmaDecomposition.spec.ts`. That one asserts
/// `hairline_cracks` alone, since it is the only field the 2.1.12 and 2.1.14
/// captures have in common, with a control field that agrees 0 of 52.
///
/// Three things generalise from that. **A version difference and a capture-grid
/// difference look identical from inside a count**, so rule out the grid first -
/// it is free, and re-capturing to "check" a version hypothesis will confirm it
/// whether or not it is true. **A count is a comparison between two sample
/// sets** whenever the two sides were captured separately, so check the sets
/// coincide before reading the difference. And 2.1.14, 2.1.15 and 2.1.16 are ONE
/// oracle for map-gen: the data Lua is byte-identical across them - as is every
/// file behind the Vulcanus crack chain back to 2.1.12 - and a re-capture at
/// 2.1.16 matched 2.1.14 on all 305 sampled values, so "predates the installed
/// binary" overstates staleness by three versions.
///
/// Writing the version in a comment would go stale the first time somebody
/// re-captures. This reads `PROVENANCE.json`, so the claim is CHECKED:
/// re-capture a fixture at a new version and every test that freezes a count
/// against it goes red, naming both versions. That red is the signal to
/// re-score the count - which is precisely the moment a comment would have gone
/// quietly wrong instead.
///
/// It deliberately does not accept "whatever PROVENANCE says". The version is
/// written at the call site so the two can disagree; a helper that just read
/// the file would assert nothing.
fn load_captured_at(relative: &str, captured_at: &str) -> Json {
    let name = relative
        .rsplit('/')
        .next()
        .unwrap_or_else(|| panic!("fixture path has no file name: {relative}"));
    let provenance = load("test/fixtures/PROVENANCE.json");
    let entry = provenance
        .get("fixtures")
        .get_opt(name)
        .unwrap_or_else(|| panic!("{name} has no PROVENANCE.json entry (#295)"));
    let recorded = entry.get("factorioVersion").as_str();
    assert_eq!(
        recorded, captured_at,
        "{name} is recorded as a {recorded} capture, but the counts graded \
         against it here were measured at {captured_at}. If it was re-captured, \
         re-score every frozen count that reads it rather than editing this \
         string (#295)."
    );
    load(relative)
}

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
    let fixture = load_captured_at("test/fixtures/basis-gradient-table.json", "2.1.14");
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
    let fixture = load_captured_at("test/fixtures/basis-noise.seed123456.json", "2.1.12");
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
    let fixture = load_captured_at("test/fixtures/oracle-basis.seed123456.json", "2.1.12");
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
    let fixture = load_captured_at("test/fixtures/basis-noise.seed123456.json", "2.1.12");
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
    amplitude_corrected_multioctave_noise, AmplitudeCorrectedParams,
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
    let fixture = load_captured_at("test/fixtures/oracle-multioctave.seed123456.json", "2.1.12");
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-variable-persistence-multioctave.seed123456.json",
        "2.1.12",
    );
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
                // Passed as the f64 the fixture records, not narrowed. Every
                // value in this array is exactly f32 - it is the noise
                // machine's own `0.35 + 0.25 * basis_noise{...}` - so this
                // fixture scores 266/266 under EITHER width and cannot grade
                // the op's persistence operand at all. What can is
                // `oracle-multioctave-wrappers`, whose amplitude-corrected
                // cases pass the raw `0.7`; see the note on `eval`.
                persistence[i],
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-quick-multioctave.seed123456.json",
        "2.1.12",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-multioctave-wrappers.seed123456.json",
        "2.1.12",
    );
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
    assert_eq!(total, 152, "fixture size");
    assert_eq!(exact_total, 152, "exact f32 matches");
}

#[test]
fn reproduces_the_amplitude_corrected_wrapper_at_the_typescripts_own_count() {
    // The other wrapper in the same fixture, and the one this file used to say
    // was "deliberately NOT ported yet: porting it now would mean porting a
    // known-wrong model and enshrining its wrongness in a Rust assertion".
    //
    // Phase 6 needs it - `elevation_lakes` and `elevation_nauvis` both read it
    // for their variable-persistence field - so it is ported now, faithfully,
    // residual and all. That is the port's standing rule rather than an
    // exception to it: reproduce the TypeScript exactly so tier 2 stays
    // honest, and fix the model in a change graded on its own. A unilateral
    // "fix" on the Rust side would read as a port bug here.
    //
    // **The count is FROZEN rather than bounded, which is strictly stronger
    // than what the TypeScript asserts.** That side has `worst < 2.5e-7` and
    // no count at all, so a change to the model that moved 30 positions while
    // staying inside the bound would pass there and fail here. That is #162's
    // whole lesson, and #254 is exactly the kind of open question a bound
    // would let drift.
    //
    // 81 of 152 with the op underneath bit-exact (152/152 above) is #254, and
    // it is not explained. Two models have been tried and rejected on the
    // TypeScript side, both recorded at `test/multioctaveWrappers.spec.ts`:
    // running the wrapper's transform in the noise machine's f32 - which is
    // what took its SIBLING from 38/152 to 152/152 - scores 84/152 here, no
    // better than the f64 form that ships. Do not "fix" this by guessing.
    let fixture = load_captured_at(
        "test/fixtures/oracle-multioctave-wrappers.seed123456.json",
        "2.1.12",
    );
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = fixture.get("positions").as_array();

    let mut total = 0usize;
    let mut exact_total = 0usize;
    let mut worst_total = 0.0f64;
    for case in fixture.get("amplitudeCorrected").as_array() {
        let values = case.get("values").as_array();
        assert_all_f32(values, "amplitudeCorrected");
        let params = AmplitudeCorrectedParams {
            seed0,
            seed1: case.get("seed1").as_f64() as u32,
            octaves: case.get("octaves").as_f64() as u32,
            input_scale: case.get("inputScale").as_f64(),
            offset_x: case.get("offsetX").as_f64(),
            persistence: case.get("persistence").as_f64(),
            amplitude: case.get("amplitude").as_f64(),
        };
        let (exact, worst) = score_case(values, |i| {
            let p = &positions[i];
            amplitude_corrected_multioctave_noise(p.get("x").as_f64(), p.get("y").as_f64(), &params)
        });
        total += values.len();
        exact_total += exact;
        worst_total = worst_total.max(worst);
    }

    assert_eq!(total, 152, "fixture size");
    // Measured on the TypeScript side against this same fixture: 81 and
    // 1.788139e-7, to every printed digit.
    assert_eq!(exact_total, 81, "exact f32 matches, worst {worst_total:e}");
    assert!(
        worst_total < 2.5e-7,
        "worst absolute error {worst_total:e} exceeds the TypeScript's own bound"
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-random-penalty.seed123456.json",
        "2.1.11",
    );
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

#[test]
fn reproduces_the_games_distance_from_nearest_point_at_all_26_positions() {
    // `distance` is 26 values of `distance_from_nearest_point{x = x, y = y,
    // points = starting_positions}` captured straight from the game. The
    // EvalCtx default spawn is the origin, which is what `starting_positions`
    // resolved to for this capture (confirmed by `distance[0] == hypot`).
    let fixture = load_captured_at(
        "test/fixtures/oracle-elevation-lakes.seed123456.json",
        "2.1.11",
    );
    let positions = fixture_positions(&fixture, "positions");
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-elevation-lakes.seed123456.json",
        "2.1.11",
    );
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = fixture_positions(&fixture, "positions");
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-elevation-lakes.seed123456.json",
        "2.1.11",
    );
    let seed0 = fixture.get("seed0").as_f64() as u32;
    let positions = fixture_positions(&fixture, "positions");
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
    let fixture = load_captured_at("test/fixtures/spot-candidates.game.json", "2.1.11");
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
    let fixture = load_captured_at("test/fixtures/spot-selection.game.json", "2.1.11");
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-voronoi-cellid.multiseed.json",
        "2.1.12",
    );
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

/// A fixture's recorded capture positions, as `(x, y)` pairs.
///
/// It READS them and nothing more. Snapping onto the game's 1/256 grid is the
/// caller's job, because not every caller wants it - the anti-vacuity tests for
/// that snap deliberately score both ways (#186, #294).
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-voronoi-jitter0.seed123456.json",
        "2.1.12",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-voronoi-points.seed123456.json",
        "2.1.12",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-voronoi-points.seed123456.json",
        "2.1.12",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-voronoi-search-range.seed123456.json",
        "2.1.12",
    );
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

use crate::eval::math::{slider_rescale, slider_rescale_rounded_once};
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
    let fixture = load_captured_at("test/fixtures/oracle-fastpow.seed123456.json", "2.1.12");
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
    let fixture = load_captured_at("test/fixtures/oracle-fastpow.seed123456.json", "2.1.12");
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
    let fixture = load_captured_at("test/fixtures/oracle-multisample.seed123456.json", "2.1.12");
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-multisample-grid.seed123456.json",
        "2.1.12",
    );
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
    let fixture = load_captured_at("test/fixtures/oracle-seed-vars.multi.json", "2.1.12");
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
    let fixture = load_captured_at("test/fixtures/oracle-seed-vars.multi.json", "2.1.12");
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-elevation.seed123456.json",
        "2.1.14",
    );
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
            f64::from(slider_rescale_rounded_once(s, 2.0) as f32) != probe.get(key).as_f64()
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-shared.seed123456.json",
        "2.1.14",
    );
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
        ("fulgora_starting_cone", 101, &|f| f.starting_cone),
        ("fulgora_starting_vault_cone", 101, &|f| {
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
    let shared_fx = load_captured_at(
        "test/fixtures/oracle-fulgora-shared.seed123456.json",
        "2.1.14",
    );
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-cells.seed123456.json",
        "2.1.14",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-elevation.seed123456.json",
        "2.1.14",
    );
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
        ("fulgora_vault_pyramids", 101, &|f| f.vault_pyramids),
        ("fulgora_vault_pyramids_and_start", 101, &|f| {
            f.vault_pyramids_and_start
        }),
        ("fulgora_moats", 101, &|f| f.moats),
        ("fulgora_mix_pyramids", 100, &|f| f.mix_pyramids),
        ("fulgora_mix_natural", 100, &|f| f.mix_natural),
        ("fulgora_mix_moats", 98, &|f| f.mix_moats),
        ("fulgora_vault_spots", 101, &|f| f.vault_spots),
        ("fulgora_mix_spots", 99, &|f| f.mix_spots),
        ("fulgora_oil_mask", 101, &|f| f.oil_mask),
        ("fulgora_mix_oil", 99, &|f| f.mix_oil),
        ("fulgora_sand_basins", 99, &|f| f.sand_basins),
        ("fulgora_pre_elevation", 100, &|f| f.pre_elevation),
        ("fulgora_elevation", 100, &|f| f.elevation),
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-elevation.seed123456.json",
        "2.1.14",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-starting-spot.seed123456.json",
        "2.1.12",
    );
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
    // **152 of 152 - every captured case, bit-exact** (#279). This was 88 while
    // the expression evaluated in f64, which the comment here used to explain
    // away as "the same known port gap the elevation chain carries". It was not
    // a gap in the chain; it was this expression. Narrowing per operation, with
    // an f32 `pi` and f32 `sin`/`cos`, closes it completely.
    //
    // That makes this the strongest single statement in tier 1 about
    // `starting_spot_at_angle`: not "close to the game" but identical to it, at
    // every one of 152 captured points, against values the game itself produced.
    // **Do not let this fall below 152.** Anything less means the narrowing has
    // been disturbed.
    //
    // The four captured angles are 0, 45, 90 and 180, so this test still says
    // nothing about a libm disagreement at an arbitrary bearing. Nothing here
    // has to: the trig is an INPUT to this function, and tier 2 hands both ports
    // the identical values. See `starting_spot_at_angle`'s module docs and #270.
    assert_eq!(exact, 152, "exact f32 matches out of 152");
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-tiles.seed123456.json",
        "2.1.14",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-ruins.seed123456.json",
        "2.1.14",
    );
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
        ("fulgora_spots_prebanding", 98, &|f: &S| {
            f.roads.spots_prebanding
        }),
        ("fulgora_spots_banding", 50, &|f: &S| f.roads.spots_banding),
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
        // **The one count that keeps going DOWN: 80 -> 79 with #279, then
        // 79 -> 78 with the elevation-chain narrowings.** Recorded rather than
        // smoothed, the same way #273 recorded `fulgora_pre_elevation` 44 -> 43
        // and `fulgora_tile_ruin_machinery` 95 -> 94.
        //
        // Two rounds in the same direction is worth naming, but it is still not
        // evidence against either change, and the company it keeps is the
        // argument: in the same two commits, `starting_spot_at_angle` went
        // 88 -> 152 of 152 against the game's own captured values, both starting
        // cones and `fulgora_moats` and `fulgora_vault_spots` reached 101/101 at
        // a residual of exactly 0, and `fulgora_elevation` went 47 -> 100.
        // Against that, one position on one still-inexact composite crossed a
        // rounding boundary the unlucky way, twice.
        //
        // What WOULD make it a signal: this field reaching a full 101 elsewhere
        // in the chain and then dropping, or the drop appearing on a field that
        // is already exact. Neither has happened. If it goes down a third time,
        // score this field on its own the way #273 scored its candidates rather
        // than reading it out of a cumulative sweep.
        ("fulgoran_rock_probability", 78, &|f: &S| {
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-ruins.seed123456.json",
        "2.1.14",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-scrap.seed123456.json",
        "2.1.14",
    );
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
    let fixture = load_captured_at(
        "test/fixtures/oracle-fulgora-tiles.seed123456.json",
        "2.1.14",
    );
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

// ---------------------------------------------------------------------------
// Phase 5 (#225) - Vulcanus. The helper layer lands first, because climate,
// biomes, elevation and the resource stack all read it.
//
// The counts below are FROZEN EXACT NUMBERS, measured against the oracle and
// recorded rather than chosen. If one moves: read the number, do not adjust it.
// Up is a finding worth taking; down is a regression.
// ---------------------------------------------------------------------------

use crate::expressions::vulcanus_helpers::VulcanusHelpers;

/// Score one named field against its fixture column, at f32.
///
/// The same comparator `score_fulgora` uses, and for the same reason: the game
/// reports f32 values and the chain models f32 arithmetic, so an f64 comparison
/// would measure the host's extra precision rather than the port.
fn score_vulcanus(got: &[f64], want: &[Json], label: &str) -> usize {
    assert_eq!(got.len(), want.len(), "{label}: length mismatch");
    let mut exact = 0usize;
    for (i, w) in want.iter().enumerate() {
        if (got[i] as f32) == (w.as_f64() as f32) {
            exact += 1;
        }
    }
    exact
}

/// Vulcanus's helper layer: the three leaf closures the oracle captured, plus
/// the `vulcanus_scale_multiplier` program constant.
///
/// The three graded fields are deliberately one of each KIND rather than three
/// of the cheapest: `vulcanus_wobble_x` is a two-octave `detail_noise` at a
/// small magnitude, `mountain_plasma` is the `abs(A - B)` of two `basis_noise`
/// calls at magnitudes up to 625, and `detail_noise(837, 1/40, 4, 1.25)` is a
/// four-octave call at a fine input scale. A transcription error in the seed
/// offset, the input scale or the plasma's asymmetric seeds shows in a
/// different one of them.
///
/// **The TypeScript spec for these same three fields asserts BOUNDS**
/// (`4e-4`, `4e-3`, `1e-4`), which is the #162 pathology and is what #256
/// exists to remove. This side counts exact f32 matches instead, so a change
/// that moves a residual without moving a match is visible here and invisible
/// there.
///
/// **And one of those bounds is already stale by six orders of magnitude.**
/// `test/vulcanusHelpers.spec.ts` bounds `vulcanus_wobble_x` at `4e-4` and its
/// comment records "measured worst 2.32e-4 (deep-field point)". Re-measured on
/// this tree the worst residual is **exactly 0** at all 38 positions - the
/// field is bit-exact and the bound would not notice it losing four digits.
/// Recorded here rather than fixed there: the bound is not wrong, it is inert,
/// and rewriting it belongs to #256 with the other 86.
#[test]
fn reproduces_the_vulcanus_helper_layer_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-helpers.seed123456.json",
        "2.1.12",
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 38, "fixture size");
    let seed0 = fixture.get("seed0").as_f64() as u32;

    let ctx = crate::eval::ctx::EvalCtx::new(seed0);
    let helpers = VulcanusHelpers::new(&ctx);
    let mountain_plasma = helpers.plasma(102, 2.5, 10.0, 125.0, 625.0);
    let detail = helpers.detail_noise(837, 1.0 / 40.0, 4.0, 1.25);

    let mut wobble_x = Vec::with_capacity(positions.len());
    let mut plasma = Vec::with_capacity(positions.len());
    let mut detail_out = Vec::with_capacity(positions.len());
    for p in positions {
        let (x, y) = (p.get("x").as_f64(), p.get("y").as_f64());
        wobble_x.push(helpers.wobble_x(x, y));
        plasma.push(mountain_plasma.eval(x, y));
        detail_out.push(f64::from(detail.eval(x, y)));
    }

    // Frozen exact counts, matched field for field against the TypeScript on
    // the same fixture - 38, 11 and 1. They describe the distance BOTH ports
    // still sit from the game, not a gap between them.
    //
    // `mountainPlasma` was 7 before #269 narrowed `basis_noise`'s output scale;
    // it reads two basis calls at magnitudes 125 and 625, neither a power of
    // two, so it is directly exposed. The other two are unaffected: `wobbleX`
    // and `detailNoise` are `detail_noise` calls and never touch that term.
    for (key, want_exact, got) in [
        // Bit-exact at all 38, worst residual exactly 0, deep-field point
        // included. Two octaves at magnitude 4 is the shallowest call the
        // fixture grades and nothing accumulates.
        ("wobbleX", 38usize, &wobble_x),
        // `abs(A - B)` of two basis calls at magnitudes 125 and 625; worst
        // residual 2.815e-3 (2.807e-3 before #269). The output scales amplify
        // the coordinate floor,
        // which is why this is the loosest of the three in absolute terms while
        // still beating `detailNoise` on exact matches.
        ("mountainPlasma", 38, &plasma),
        // Four octaves at input scale 0.8; worst residual 7.778e-5. The
        // SMALLEST residual of the three and the FEWEST exact matches, which is
        // the whole argument for counting matches rather than bounding error:
        // a field can be uniformly close and almost never right.
        ("detailNoise", 38, &detail_out),
    ] {
        assert_eq!(
            score_vulcanus(got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 38"
        );
    }

    // `vulcanus_scale_multiplier` is a program constant and the fixture repeats
    // it at every position, so the check is that it is ONE value and that it is
    // ours. It is 1 at the game's default preset, which is what pins the
    // neutral slider at 1 rather than 0.
    let multipliers = fixture.get("scaleMultiplier").as_f64_array();
    assert!(
        multipliers.iter().all(|m| *m == multipliers[0]),
        "scale multiplier is not constant"
    );
    assert_eq!(multipliers[0], 1.0);
    assert_eq!(helpers.scale_multiplier, 1.0);
}

use crate::expressions::vulcanus_climate::{ClimateFields, VulcanusClimate};
use crate::expressions::vulcanus_cracks::{CrackFields, VulcanusCracks};

/// Evaluate the Vulcanus helper, crack and climate layers once at every
/// fixture position, in dependency order.
///
/// One sweep rather than one per fixture, because climate reads the crack
/// fields at the SAME point and recomputing them would be both slower and a
/// second place for the wiring to be wrong.
fn vulcanus_sweep(seed0: u32, positions: &[Json]) -> (Vec<CrackFields>, Vec<ClimateFields>) {
    let ctx = crate::eval::ctx::EvalCtx::new(seed0);
    let helpers = VulcanusHelpers::new(&ctx);
    let cracks = VulcanusCracks::new(&helpers);
    let climate = VulcanusClimate::new(seed0);

    let mut c_out = Vec::with_capacity(positions.len());
    let mut k_out = Vec::with_capacity(positions.len());
    for p in positions {
        // Snapped, like every other sweep in this file. Without it this scored
        // the crack and climate layers at 21 of 61 coordinates the game never
        // evaluated - see the note on `snap_coord`.
        let (x, y) = (
            snap_coord(p.get("x").as_f64()),
            snap_coord(p.get("y").as_f64()),
        );
        let c = cracks.eval(x, y);
        k_out.push(climate.eval(x, y, &c));
        c_out.push(c);
    }
    (c_out, k_out)
}

/// The crack and flood layer, all five named expressions.
///
/// `flood_basalts_func` is the composite the elevation chain samples and the
/// other four are its inputs, so all five are graded rather than just the
/// composite: a transcription error in one input localises here instead of
/// arriving blended into the field elevation reads.
#[test]
fn reproduces_the_vulcanus_crack_layer_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-cracks.seed123456.json",
        "2.1.12",
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 61, "fixture size");
    let (cracks, _) = vulcanus_sweep(fixture.get("seed0").as_f64() as u32, positions);

    // Frozen exact counts, measured with the positions SNAPPED - 61, 55, 51, 34
    // and 37. They are the distance BOTH ports sit from the game, not a gap
    // between them: the same five numbers come out of a TypeScript harness
    // running this side's own comparison.
    //
    // **All five moved when the snap landed, and `hairlineCracks` closed.**
    // This sweep used to read `p.x` raw, and 21 of these 61 positions are
    // recorded OFF the 1/256 `MapPosition` grid, so a third of the scoring was
    // done at points the game never evaluated:
    //
    //   hairlineCracks    50 -> 61   and 61 of 61 is EXACT
    //   floodCracksA      45 -> 55
    //   floodCracksB      43 -> 51
    //   floodPaths        28 -> 34
    //   floodBasaltsFunc  31 -> 37
    //
    // That also refutes what #295 read into these numbers. The issue took
    // `hairline_cracks` scoring 50 here and 61 against a 2.1.14 capture as the
    // game changing under the fixture. It was the missing snap: this fixture
    // SNAPPED scores 61 too. See `load_captured_at` for the full correction and
    // for why a version hypothesis is the one you must rule out last.
    //
    // ## History: #269, and the exposure rule it established
    //
    // The numbers in this section are the pre-snap ones and are kept because
    // the RULE they establish is still load-bearing. At the time
    // `hairlineCracks` stood at 2 of 61.
    //
    // Worst residuals as measured 2026-08-19, BEFORE #269, in the same order:
    // 1.853e-3, 4.440e-4, 1.122e-4, 5.460e-4, 6.387e-4.
    //
    // `hairlineCracks` at 2 of 61 was the weakest and it is the SHALLOWEST
    // expression in the layer - a bare `plasma` with nothing composed on top -
    // so the weakness could not come from anything this file builds. It pointed
    // at the plasma adapter, and specifically at #269: `basis_noise_expr` returns
    // an un-narrowed f64 product where the game narrows to f32, and `plasma` is
    // two of those subtracted.
    //
    // **Which call sites #269 can reach is decided by the OUTPUT scale alone,
    // and it is a clean rule.** `basis_noise` returns an f32, so multiplying by
    // a POWER OF TWO is a pure exponent shift and can never leave the f32 grid:
    // narrowing that product is the identity. Any other output scale can.
    // Measured over 90,000 samples at a fixed input scale, output scale
    // 1 / 0.5 / 0.25 / 2 / 4 / 64 each change **0.00%** of products, while 0.6
    // changes 79.88%, 0.75 and 3 change 56.32%, 150 changes 97.46% and 125
    // changes 98.38%. Holding the output scale at 1 and sweeping the INPUT
    // scale over 0.125, 0.205, 0.51, 0.6, 1.5 and 0.002 changes 0.00% every
    // time - the input scale decides which noise value you get, never whether
    // the product is representable.
    //
    // So of the twelve DIRECT `basis_noise_expr` calls this layer makes,
    // exactly ONE is exposed: `hairline_cracks`'s first term, at output scale
    // 0.6, where 80.10% of products differ. The other eleven sit at 1, 0.5 or
    // 0.25 and are blind by construction.
    //
    // It also explains why `oracle-basis` cannot grade this: that fixture was
    // captured at output scale 1.
    //
    // ## What happened when #269 landed, and where the paragraph above was wrong
    //
    // This comment used to end "do not expect the other four to move when it
    // is". Three of the four held. `floodBasaltsFunc` did not, and the reason
    // is a real correction rather than noise: **exposure is transitive through
    // composition, and counting DIRECT call sites misses that.** This layer's
    // own verbatim transcription says so at the top of
    // `src/noise/expressions/vulcanusCracks.ts`:
    //
    //   flood_basalts_func = min(max(flood_cracks_a - 0.125, flood_paths),
    //                            flood_cracks_b)
    //                        + 0.3 * min(0.5, hairline_cracks)
    //
    // `flood_basalts_func` READS `hairline_cracks`, so the one exposed term
    // reaches it. `flood_cracks_a`, `flood_cracks_b` and `flood_paths` do not
    // read it, and those are exactly the three that did not move. The rule is
    // therefore: a field is exposed if it reads an exposed site DIRECTLY OR
    // THROUGH ANY FIELD IT COMPOSES.
    //
    // Measured across the #269 fix:
    //
    //   hairlineCracks     3 -> 2    directly exposed  (0.6)
    //   floodCracksA      15 -> 15   not exposed
    //   floodCracksB      40 -> 40   not exposed
    //   floodPaths        10 -> 10   not exposed
    //   floodBasaltsFunc   8 -> 9    exposed VIA hairline_cracks
    //
    // **`hairlineCracks` went DOWN, from 3 to 2.** That is not evidence the fix
    // is wrong - the primitive is graded 196/196 against the game at five
    // output scales in `test/basisOutputScale.spec.ts`, which is as settled as
    // this project gets. It is the both-directions movement #273 measured:
    // these are deep composed chains whose remaining error comes from other
    // unported narrowings, so correcting one term shifts values slightly and a
    // position that happened to land exactly right can stop doing so. A count
    // dropping by one at 61 positions says the field is still wrong for
    // reasons this change does not address, not that the change hurt it.
    //
    // Do not "fix" `hairlineCracks` by reverting anything here. The next term
    // to look at is the `input_scale` question recorded on #269.
    //
    // An earlier draft of this comment blamed the layer's INPUT scales
    // (0.3 * 0.325 and 0.6 * 0.325, neither exact in f32). That was wrong, and
    // it is recorded rather than quietly deleted because it is the plausible
    // guess: the input scale is the number that looks inexact.
    type C = CrackFields;
    for (key, want_exact, select) in [
        (
            "hairlineCracks",
            61usize,
            &(|f: &C| f.hairline_cracks) as &dyn Fn(&C) -> f64,
        ),
        ("floodCracksA", 55, &|f| f.flood_cracks_a),
        ("floodCracksB", 51, &|f| f.flood_cracks_b),
        ("floodPaths", 34, &|f| f.flood_paths),
        ("floodBasaltsFunc", 37, &|f| f.flood_basalts_func),
    ] {
        let got: Vec<f64> = cracks.iter().map(select).collect();
        assert_eq!(
            score_vulcanus(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 61"
        );
    }
}

/// The climate layer: `vulcanus_aux` and `vulcanus_moisture`.
///
/// `vulcanus_temperature` is not here because it is not ported - it reads
/// `vulcanus_elev`, which arrives with the elevation chain.
#[test]
fn reproduces_the_vulcanus_climate_layer_at_every_captured_position() {
    let cracks_fx = load_captured_at(
        "test/fixtures/oracle-vulcanus-cracks.seed123456.json",
        "2.1.12",
    );
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-climate.seed123456.json",
        "2.1.12",
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 61, "fixture size");

    // Climate is graded against crack values evaluated at these positions, so
    // if the two fixtures' position lists ever drift apart the comparison
    // silently stops meaning anything.
    let crack_positions = cracks_fx.get("positions").as_array();
    assert_eq!(positions.len(), crack_positions.len());
    for (a, b) in positions.iter().zip(crack_positions) {
        assert_eq!(a.get("x").as_f64(), b.get("x").as_f64());
        assert_eq!(a.get("y").as_f64(), b.get("y").as_f64());
    }

    let (_, climate) = vulcanus_sweep(fixture.get("seed0").as_f64() as u32, positions);

    // Frozen exact counts, measured as above and matched by the TypeScript at
    // 40 and 20. Worst residuals 4.584e-4 and 1.117e-4.
    //
    // Both are CLAMPED to [0, 1], which flatters them: every position the clamp
    // saturates is exact for free, because both ports and the game all return
    // the bound itself. Read 40 of 61 as an upper bound on what the arithmetic
    // achieves rather than as a measure of it.
    type K = ClimateFields;
    for (key, want_exact, select) in [
        ("aux", 51usize, &(|f: &K| f.aux) as &dyn Fn(&K) -> f64),
        ("moisture", 35, &|f| f.moisture),
    ] {
        let got: Vec<f64> = climate.iter().map(select).collect();
        assert_eq!(
            score_vulcanus(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 61"
        );
    }
}

/// The snap is load-bearing on the crack and climate layers, and by how much.
///
/// The companion to `the_capture_grid_snap_is_load_bearing_on_the_vulcanus_
/// elevation_surface`. It exists because `vulcanus_sweep` shipped WITHOUT the
/// snap: 21 of these 61 positions are recorded off the 1/256 `MapPosition`
/// grid, so a third of the scoring happened at points the game never evaluated,
/// and the frozen counts understated the port by 6 to 11 each.
///
/// Both arms are pinned rather than just the snapped one. A test that only
/// asserted the good number would pass again if the snap were removed and the
/// counts re-frozen to match - which is exactly how this got shipped the first
/// time. The gap between the two columns is the thing being guarded.
///
/// `hairlineCracks` is the row to read: 61 of 61 snapped, EXACT, against 50
/// raw. #295 read that same 11-count gap as the game changing between 2.1.12
/// and 2.1.14 - see `load_captured_at` for why it is not.
#[test]
fn the_capture_grid_snap_is_load_bearing_on_the_vulcanus_crack_layer() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-cracks.seed123456.json",
        "2.1.12",
    );
    let climate_fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-climate.seed123456.json",
        "2.1.12",
    );
    let positions = fixture_positions(&fixture, "positions");

    // Non-vacuity: if a re-capture ever lands these on the grid, the snap
    // becomes the identity and every assertion below stops discriminating.
    let off_grid = positions
        .iter()
        .filter(|(x, y)| (x * 256.0).fract() != 0.0 || (y * 256.0).fract() != 0.0)
        .count();
    assert_eq!(off_grid, 21, "positions recorded off the 1/256 grid");

    let ctx = crate::eval::ctx::EvalCtx::new(fixture.get("seed0").as_f64() as u32);
    let helpers = VulcanusHelpers::new(&ctx);
    let cracks = VulcanusCracks::new(&helpers);
    let climate = VulcanusClimate::new(ctx.seed0);
    let maybe_snap = |v: f64, snap: bool| if snap { snap_coord(v) } else { v };

    let scored = |snap: bool| {
        let fields: Vec<(CrackFields, ClimateFields)> = positions
            .iter()
            .map(|(x, y)| {
                let (px, py) = (maybe_snap(*x, snap), maybe_snap(*y, snap));
                let c = cracks.eval(px, py);
                let k = climate.eval(px, py, &c);
                (c, k)
            })
            .collect();
        let hairline: Vec<f64> = fields.iter().map(|(c, _)| c.hairline_cracks).collect();
        let aux: Vec<f64> = fields.iter().map(|(_, k)| k.aux).collect();
        (
            score_vulcanus(
                &hairline,
                fixture.get("hairlineCracks").as_array(),
                "hairline",
            ),
            score_vulcanus(&aux, climate_fixture.get("aux").as_array(), "aux"),
        )
    };

    assert_eq!(
        scored(false),
        (50, 41),
        "unsnapped - points the game never saw"
    );
    assert_eq!(scored(true), (61, 51), "snapped - where the game evaluated");
}

use crate::expressions::vulcanus_spawn::{SpawnFields, VulcanusSpawn, WobbleSums};

/// Evaluate the spawn layer at every fixture position.
fn vulcanus_spawn_sweep(seed0: u32, positions: &[Json]) -> Vec<SpawnFields> {
    let ctx = crate::eval::ctx::EvalCtx::new(seed0);
    let helpers = VulcanusHelpers::new(&ctx);
    let spawn = VulcanusSpawn::with_host_trig(&ctx);
    positions
        .iter()
        .map(|p| {
            let (x, y) = (p.get("x").as_f64(), p.get("y").as_f64());
            spawn.eval(x, y, WobbleSums::at(&helpers, x, y))
        })
        .collect()
}

/// The seed-derived radial spawn geometry.
///
/// The fixture captures three of the five fields. `ashlands_start` is the one
/// that grades the `starting_spot_at_angle` call directly - the other two are
/// composites - so it is the field that would move if #279's narrowing were
/// ever undone.
#[test]
fn reproduces_the_vulcanus_spawn_layer_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-spawn.seed123456.json",
        "2.1.11",
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 410, "fixture size");
    let fields = vulcanus_spawn_sweep(fixture.get("seed0").as_f64() as u32, positions);

    // Frozen exact counts, measured 2026-08-19 and matched by the TypeScript at
    // 371, 247 and 61 with the same worst residuals: 7.153e-7, 7.019e-7 and
    // 3.815e-6.
    //
    // Those residuals are two to three orders of magnitude SMALLER than the
    // crack layer's and the exact counts are still far from full - 61 of 410 on
    // `ashlandsStart`. It is the same reading `detailNoise` gives in the helper
    // layer, from a completely different expression: closeness and exactness are
    // not the same measurement, and only one of them is a port score.
    //
    // `startingArea` scores highest of the three and that is expected rather
    // than good: it is CLAMPED to [0, 1] and most of the map sits at 0, where
    // both ports and the game agree for free. Compare `ashlandsStart`, which is
    // the same geometry unclamped and unmultiplied, for what the arithmetic
    // actually reaches.
    type S = SpawnFields;
    for (key, want_exact, select) in [
        (
            "startingArea",
            371usize,
            &(|f: &S| f.starting_area) as &dyn Fn(&S) -> f64,
        ),
        ("startingCircle", 247, &|f| f.starting_circle),
        ("ashlandsStart", 61, &|f| f.ashlands_start),
    ] {
        let got: Vec<f64> = fields.iter().map(select).collect();
        assert_eq!(
            score_vulcanus(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 410"
        );
    }
}

use crate::expressions::vulcanus_biomes::{BiomeFields, VulcanusBiomes};

/// The biome system: the three-way radial chain and the volcano spot field.
///
/// All eight captured fields are graded, including the two `*_raw_volcano` and
/// `*_biome_full` internals nothing outside the layer reads, so a transcription
/// error localises instead of arriving blended into `elevation`.
///
/// The fixture nests its columns under `values`, unlike the other Vulcanus
/// fixtures which put them at the top level.
#[test]
fn reproduces_the_vulcanus_biome_layer_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-biomes.seed123456.json",
        "2.1.12",
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 434, "fixture size");
    // Anti-vacuity for the snap below: 22 of these 434 were recorded off the
    // 1/256 grid. If a re-capture ever lands them all on it, the snap becomes
    // the identity and should be deleted rather than left looking load-bearing.
    assert_eq!(
        count_off_grid(&fixture_positions(&fixture, "positions")),
        22,
        "off-grid positions"
    );
    let values = fixture.get("values");

    let ctx = crate::eval::ctx::EvalCtx::new(fixture.get("seed0").as_f64() as u32);
    let helpers = VulcanusHelpers::new(&ctx);
    let spawn = VulcanusSpawn::with_host_trig(&ctx);
    let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);

    let fields: Vec<BiomeFields> = positions
        .iter()
        .map(|p| {
            // Snapped: 22 of these 434 positions were recorded off the 1/256
            // grid, so the raw coordinate is not where the game evaluated.
            biomes.eval(
                snap_coord(p.get("x").as_f64()),
                snap_coord(p.get("y").as_f64()),
            )
        })
        .collect();

    // Frozen exact counts, measured 2026-08-19 and matched by the TypeScript on
    // all eight with the same worst residuals: 3.821e-5, 1.122e-4, 1.546e-4,
    // 1.546e-4, 1.655e-4, 8.955e-5, 3.092e-4, 4.069e-5.
    //
    // **The three clamped biomes score roughly three times their own unclamped
    // sources** - 404, 404 and 408 against 135, 114 and 134 - and they are the
    // same quantity times 2, clamped. Nothing improved between them: the clamp
    // saturates at 0 or 1 across most of the map, and a saturated position is
    // exact for free because both ports and the game return the bound. Read the
    // `*_biome_full` row as the port's real score and the `*_biome` row as what
    // the consumer happens to need. If a future change moves `*_biome` without
    // moving `*_biome_full`, it moved the clamp, not the arithmetic.
    //
    // `mountain_volcano_spots` at 359 is the highest UNCLAMPED count in the
    // Vulcanus port so far, and that fits the pattern `CLAUDE.md` records for
    // `voronoi_cell_id`: the spot pipeline's output is dominated by a DISCRETE
    // choice - which candidate survives per region - and a sub-ULP error almost
    // never changes which one that is. The residual it does carry comes from the
    // cone arithmetic afterwards.
    type B = BiomeFields;
    for (key, want_exact, select) in [
        (
            "mountain_volcano_spots",
            359usize,
            &(|f: &B| f.mountain_volcano_spots) as &dyn Fn(&B) -> f64,
        ),
        ("vulcanus_mountains_raw_volcano", 174, &|f| {
            f.mountains_raw_volcano
        }),
        ("vulcanus_mountains_biome_full", 135, &|f| {
            f.mountains_biome_full
        }),
        ("vulcanus_ashlands_biome_full", 114, &|f| {
            f.ashlands_biome_full
        }),
        ("vulcanus_basalts_biome_full", 134, &|f| {
            f.basalts_biome_full
        }),
        ("vulcanus_mountains_biome", 404, &|f| f.mountains_biome),
        ("vulcanus_ashlands_biome", 404, &|f| f.ashlands_biome),
        ("vulcanus_basalts_biome", 408, &|f| f.basalts_biome),
    ] {
        let got: Vec<f64> = fields.iter().map(select).collect();
        assert_eq!(
            score_vulcanus(&got, values.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 434"
        );
    }
}

/// The snap is load-bearing on the biome layer, and by how much.
///
/// The third of these, after the crack and elevation ones. It exists for the
/// same reason and guards the same failure: the biome sweep shipped scoring at
/// raw `p.x`, and 22 of these 434 positions are recorded off the 1/256
/// `MapPosition` grid, so those rows were graded at points the game never
/// evaluated.
///
/// Both arms are pinned rather than only the snapped one. A test asserting just
/// the good number would pass again if the snap were dropped and the counts
/// re-frozen to match, which is exactly how this shipped the first time. The
/// GAP between the two columns is the thing being guarded, not either column.
///
/// Measured 2026-08-25. Six of the eight move up and none moves down:
///
/// | field | unsnapped | snapped |
/// | --- | ---: | ---: |
/// | `mountain_volcano_spots` | 359 | 359 |
/// | `mountains_raw_volcano` | 163 | **174** |
/// | `mountains_biome_full` | 128 | **135** |
/// | `ashlands_biome_full` | 107 | **114** |
/// | `basalts_biome_full` | 127 | **134** |
/// | `mountains_biome` | 403 | **404** |
/// | `ashlands_biome` | 402 | **404** |
/// | `basalts_biome` | 408 | 408 |
///
/// The two that DO NOT move are readings rather than noise, and pinning them
/// flat is the point of including them. `mountain_volcano_spots` is dominated
/// by a DISCRETE choice - which spot candidate survives a region - and a shift
/// under 1/256 almost never changes which one that is, the same property
/// `voronoi_cell_id` has. `basalts_biome` is clamped and saturated across most
/// of the map, so most of its 408 are exact for free either way.
#[test]
fn the_capture_grid_snap_is_load_bearing_on_the_vulcanus_biome_layer() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-biomes.seed123456.json",
        "2.1.12",
    );
    let positions = fixture_positions(&fixture, "positions");
    let values = fixture.get("values");

    // Non-vacuity: if a re-capture ever lands these on the grid, the snap
    // becomes the identity and every assertion below stops discriminating.
    assert_eq!(
        count_off_grid(&positions),
        22,
        "positions recorded off the 1/256 grid"
    );

    let ctx = crate::eval::ctx::EvalCtx::new(fixture.get("seed0").as_f64() as u32);
    let helpers = VulcanusHelpers::new(&ctx);
    let spawn = VulcanusSpawn::with_host_trig(&ctx);
    let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
    let maybe_snap = |v: f64, snap: bool| if snap { snap_coord(v) } else { v };

    let scored = |snap: bool| {
        let fields: Vec<BiomeFields> = positions
            .iter()
            .map(|(x, y)| biomes.eval(maybe_snap(*x, snap), maybe_snap(*y, snap)))
            .collect();
        let score = |key: &str, select: &dyn Fn(&BiomeFields) -> f64| {
            let got: Vec<f64> = fields.iter().map(select).collect();
            score_vulcanus(&got, values.get(key).as_array(), key)
        };
        (
            score("mountain_volcano_spots", &|f| f.mountain_volcano_spots),
            score("vulcanus_mountains_raw_volcano", &|f| {
                f.mountains_raw_volcano
            }),
            score("vulcanus_mountains_biome_full", &|f| f.mountains_biome_full),
            score("vulcanus_ashlands_biome_full", &|f| f.ashlands_biome_full),
            score("vulcanus_basalts_biome_full", &|f| f.basalts_biome_full),
            score("vulcanus_mountains_biome", &|f| f.mountains_biome),
            score("vulcanus_ashlands_biome", &|f| f.ashlands_biome),
            score("vulcanus_basalts_biome", &|f| f.basalts_biome),
        )
    };

    assert_eq!(
        scored(false),
        (359, 163, 128, 107, 127, 403, 402, 408),
        "unsnapped - points the game never saw"
    );
    assert_eq!(
        scored(true),
        (359, 174, 135, 114, 134, 404, 404, 408),
        "snapped - where the game evaluated"
    );
}

use crate::expressions::vulcanus_elevation::{ElevationFields, VulcanusElevation};

/// The elevation surface: `vulcanus_elev` and `vulcanus_elevation`.
///
/// This is the deepest composite in the Vulcanus port - it reads the helper,
/// crack, climate, spawn and biome layers, all of which are graded separately
/// above. That is the point of grading them separately: a number that moves here
/// can be traced to the layer that moved rather than investigated from scratch.
#[test]
fn reproduces_the_vulcanus_elevation_surface_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-elevation.seed123456.json",
        "2.1.12",
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 434, "fixture size");
    // The snap below is applied for these 22 and no others. Asserted so a
    // re-capture that lands everything on-grid cannot leave it looking
    // load-bearing; `test/vulcanusElevation.spec.ts` pins the same 22.
    assert_eq!(
        count_off_grid(&fixture_positions(&fixture, "positions")),
        22,
        "off-grid positions"
    );

    let ctx = crate::eval::ctx::EvalCtx::new(fixture.get("seed0").as_f64() as u32);
    let helpers = VulcanusHelpers::new(&ctx);
    let cracks = VulcanusCracks::new(&helpers);
    let spawn = VulcanusSpawn::with_host_trig(&ctx);
    let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
    let climate = VulcanusClimate::new(ctx.seed0);
    let elevation = VulcanusElevation::new(&ctx, &helpers, &cracks, &biomes, &climate);

    let fields: Vec<ElevationFields> = positions
        .iter()
        .map(|p| {
            elevation.eval(
                snap_coord(p.get("x").as_f64()),
                snap_coord(p.get("y").as_f64()),
            )
        })
        .collect();

    // Frozen exact counts, graded at coordinates SNAPPED onto the game's 1/256
    // MapPosition grid. 22 of these 434 positions were captured off that grid,
    // so for those the game evaluated a different point than the fixture
    // records (#186). Scoring them raw is what #294 was filed over: it reads as
    // a port gap and is a harness gap. Unsnapped these score 169 and 169, and
    // `the_capture_grid_snap_is_load_bearing_on_the_vulcanus_elevation_surface`
    // pins both pairs so the snap cannot quietly become decoration.
    //
    // **There is no committed TypeScript count for these to match.** A note
    // here used to claim "matched by the TypeScript at 115 and 115"; the
    // counterpart, `test/vulcanusElevation.spec.ts`, applies the same snap
    // through `snapPosition` but grades this field with measured residual
    // BOUNDS - 2e-3 near spawn, 6e-3 far - not with exact counts. Those 115s
    // came from an ad-hoc harness rather than from anything in the repo, and
    // they predate #290/#293 besides. #294's framing that the two ports "freeze
    // different counts" inherits the same mistake: only one of them freezes a
    // count at all.
    //
    // Graded against a **2.1.12** capture while the binary is 2.1.16 (#295).
    // That used to leave "the game changed" as an open candidate for a count
    // short of a full house. It is now a narrow one: every Lua file behind the
    // Vulcanus chain is byte-identical 2.1.12 -> 2.1.16, so a version effect
    // here would have to be an ENGINE change rather than an expression change.
    // On the crack layer it was also ruled out empirically, game against game -
    // see `load_captured_at`.
    //
    // **The two columns are the same field in this fixture, and that is a gap
    // in the fixture rather than a result.** `vulcanus_elevation` is
    // `max(-500, elev)`, and the captured `elev` never goes below -500: its
    // minimum over all 434 positions is -58.77. So `elev` equals `elevation` at
    // every position, the clamp is never exercised, and a port that dropped the
    // `max` entirely would score 171 here too. Checked rather than assumed -
    // 0 of 434 positions differ between the two columns.
    //
    // Grading both anyway, because the cost is nothing and the day a capture
    // reaches a deep enough lake the two counts separate on their own. The
    // clamp itself is held up by `the_clamped_elevation_is_not_the_raw_elev` in
    // the elevation module, which constructs the case the oracle does not.
    //
    // On the residual: 1.332e-1 was the pre-snap worst and looked alarming next
    // to the other layers until you read the scale - elevation spans -58 to
    // +1024 here, so that is about 1.3e-4 relative. The TypeScript's post-snap
    // worsts are 1.869e-3 near spawn and 5.234e-3 far, a 25x improvement that
    // is itself the evidence the off-grid capture, not precision, was the
    // far-field story. An absolute bound would have to be re-tuned per field
    // for scale alone, which is the third argument for counting matches.
    type E = ElevationFields;
    for (key, want_exact, select) in [
        ("elev", 171usize, &(|f: &E| f.elev) as &dyn Fn(&E) -> f64),
        ("elevation", 171, &|f| f.elevation),
    ] {
        let got: Vec<f64> = fields.iter().map(select).collect();
        assert_eq!(
            score_vulcanus(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 434"
        );
    }
}

/// Anti-vacuity for the 1/256 capture-grid snap the two elevation tests apply.
///
/// The lakes pair has a control of the opposite shape - there the snap is
/// INERT, and `the_capture_grid_snap_is_inert_on_starting_lake_distance_and_that_is_measured`
/// pins that inertness. Here it moves real counts, so the control has to score
/// BOTH ways and assert the snapped run is strictly better. If a re-capture
/// ever lands every position on the grid the two runs converge, this goes red,
/// and the snap should be deleted rather than left looking load-bearing.
///
/// Measured 2026-08-21, on the tree that carries #290 and #293:
///
/// | field | unsnapped | snapped |
/// | --- | ---: | ---: |
/// | `elev` (and `elevation`, which equals it here) | 169 | **171** |
/// | `temperature` | 244 | **252** |
///
/// Both move UP, which is the direction that says the snap is recovering the
/// point the game evaluated rather than perturbing a good answer. It is a small
/// move because only 22 of 434 positions are off-grid at all, so 412 of these
/// rows are the same computation either way and the snap can reach at most 22.
#[test]
fn the_capture_grid_snap_is_load_bearing_on_the_vulcanus_elevation_surface() {
    let elev_fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-elevation.seed123456.json",
        "2.1.12",
    );
    let temp_fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-temperature.seed123456.json",
        "2.1.12",
    );

    let ctx = crate::eval::ctx::EvalCtx::new(elev_fixture.get("seed0").as_f64() as u32);
    let helpers = VulcanusHelpers::new(&ctx);
    let cracks = VulcanusCracks::new(&helpers);
    let spawn = VulcanusSpawn::with_host_trig(&ctx);
    let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
    let climate = VulcanusClimate::new(ctx.seed0);
    let elevation = VulcanusElevation::new(&ctx, &helpers, &cracks, &biomes, &climate);

    let maybe_snap = |v: f64, snap: bool| if snap { snap_coord(v) } else { v };

    let score_elev = |snap: bool| {
        let got: Vec<f64> = fixture_positions(&elev_fixture, "positions")
            .iter()
            .map(|(x, y)| {
                elevation
                    .eval(maybe_snap(*x, snap), maybe_snap(*y, snap))
                    .elev
            })
            .collect();
        score_vulcanus(&got, elev_fixture.get("elev").as_array(), "elev")
    };

    let score_temp = |snap: bool| {
        let got: Vec<f64> = fixture_positions(&temp_fixture, "positions")
            .iter()
            .map(|(x, y)| {
                elevation.temperature(
                    maybe_snap(*x, snap),
                    maybe_snap(*y, snap),
                    ctx.temperature_bias,
                )
            })
            .collect();
        score_vulcanus(
            &got,
            temp_fixture.get("temperature").as_array(),
            "temperature",
        )
    };

    assert_eq!(score_elev(false), 169, "elev unsnapped");
    assert_eq!(score_elev(true), 171, "elev snapped");
    assert_eq!(score_temp(false), 244, "temperature unsnapped");
    assert_eq!(score_temp(true), 252, "temperature snapped");
}

/// `vulcanus_temperature`, which the climate layer deferred until `elev` existed.
///
/// It reads the RAW `elev`, so a port that wired it to the clamped
/// `vulcanus_elevation` would agree everywhere above -500 and diverge only in
/// the deep lakes. The fixture spans those.
#[test]
fn reproduces_the_vulcanus_temperature_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-temperature.seed123456.json",
        "2.1.12",
    );
    let positions = fixture.get("positions").as_array();
    // Its own fixture, its own off-grid count - which happens to also be 22.
    assert_eq!(
        count_off_grid(&fixture_positions(&fixture, "positions")),
        22,
        "off-grid positions"
    );

    let ctx = crate::eval::ctx::EvalCtx::new(fixture.get("seed0").as_f64() as u32);
    let helpers = VulcanusHelpers::new(&ctx);
    let cracks = VulcanusCracks::new(&helpers);
    let spawn = VulcanusSpawn::with_host_trig(&ctx);
    let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
    let climate = VulcanusClimate::new(ctx.seed0);
    let elevation = VulcanusElevation::new(&ctx, &helpers, &cracks, &biomes, &climate);

    let got: Vec<f64> = positions
        .iter()
        .map(|p| {
            elevation.temperature(
                snap_coord(p.get("x").as_f64()),
                snap_coord(p.get("y").as_f64()),
                ctx.temperature_bias,
            )
        })
        .collect();

    // Frozen exact count, at snapped coordinates for the same reason as the
    // elevation surface above - this fixture carries its own 22 off-grid
    // positions (#186, #294). Unsnapped it scores 244; the sibling anti-vacuity
    // test pins both numbers.
    //
    // Higher than `elev`'s 171 despite reading it, because temperature scales
    // it by 1/100 above zero - `min(e, e / 100)` - so most of `elev`'s residual
    // is divided away before it lands here.
    //
    // As with the elevation surface, the TypeScript counterpart grades this
    // with residual bounds rather than a count, so the "matched by the
    // TypeScript at 196" this comment used to carry described no committed
    // assertion. Captured at 2.1.12 against a 2.1.16 binary; the map-gen
    // Lua is byte-identical across that range (#295).
    assert_eq!(
        score_vulcanus(&got, fixture.get("temperature").as_array(), "temperature"),
        252,
        "temperature exact f32 matches out of {}",
        positions.len()
    );
}

use crate::expressions::vulcanus_resources::{ResourceFields, VulcanusResources};

/// Vulcanus's resource layer: four favorabilities, four starting spots, the four
/// regions, the sulfuric-acid patchy chain and `vulcanus_metal_tile`.
///
/// The fixture is two populations and both are load-bearing. The first 61
/// positions are a scattered near+far grid that covers the favorabilities, the
/// starting spots and the far-field f32 floor. The remaining 1,024 are a dense
/// 32x32 scan at a 137-tile stride, added in a fix round because the original 61
/// never landed inside a real ore or acid region - `region > 0` nowhere - so the
/// fixture could not tell a working spot-selection port from a stub that
/// returned the basement everywhere.
#[test]
fn reproduces_the_vulcanus_resource_layer_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-resources.seed123456.json",
        "2.1.12",
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 1085, "fixture size");
    // Asserted so a re-capture that lands everything on the 1/256 grid cannot
    // leave the snap below looking load-bearing. `test/vulcanusResources.spec.ts`
    // pins the same number.
    assert_eq!(
        count_off_grid(&fixture_positions(&fixture, "positions")),
        21,
        "off-grid positions"
    );

    let ctx = crate::eval::ctx::EvalCtx::new(fixture.get("seed0").as_f64() as u32);
    let helpers = VulcanusHelpers::new(&ctx);
    let spawn = VulcanusSpawn::with_host_trig(&ctx);
    let biomes = VulcanusBiomes::with_host_trig(&ctx, &helpers, &spawn);
    let cracks = VulcanusCracks::new(&helpers);
    let resources = VulcanusResources::with_host_trig(&ctx, &helpers, &spawn, &biomes, &cracks);

    let fields: Vec<ResourceFields> = positions
        .iter()
        .map(|p| {
            resources.eval(
                snap_coord(p.get("x").as_f64()),
                snap_coord(p.get("y").as_f64()),
            )
        })
        .collect();

    // Frozen exact counts, measured 2026-08-24 at snapped coordinates. **Every
    // one of the fifteen was measured on the TypeScript side against the same
    // fixture with the same snap and the same rule, and all fifteen agree - the
    // same count AND the same worst residual to every printed digit.** So these
    // describe the distance BOTH ports sit from the game, not a gap between
    // them. If one moves, read it: up is worth taking, down is a regression, and
    // neither is a number to edit.
    //
    // The four starting spots are the load-bearing agreement, because they are
    // the only four numbers `test/vulcanusResources.spec.ts` freezes as counts
    // rather than as bounds - 1082, 974, 969 and 1049, landed with #279. This
    // port reproduces all four without having seen them, which is a much
    // stronger statement than the eleven that agree with an implementation
    // graded only by bounds.
    //
    // Three readings worth keeping:
    //
    // - **The regions prove the spot pipeline runs.** The fixture's second
    //   population exists precisely because the original 61 points had
    //   `region > 0` nowhere, so a stub returning the basement everywhere would
    //   have scored full marks. At 1033/1026/999/1020 these are scoring real
    //   cone arithmetic over selected spots.
    // - **`metalTile`'s worst residual is 1.329e2 and that is not an outlier.**
    //   It is `1000 * tungsten_region`, so it carries that field's residual
    //   times a thousand. Read against its own scale it is the tightest field
    //   here, which is the third time this file has had to say an absolute bound
    //   needs re-tuning per field for scale alone.
    // - **`sulfuricAcidPatches` has the SMALLEST residual (7.153e-8) and the
    //   FEWEST matches (867).** That is `detailNoise`'s property again: a field
    //   can be uniformly close and rarely exactly right. It is the argument for
    //   counting matches rather than bounding error, stated in one number, and
    //   it is why this test freezes counts.
    //
    // Graded against a **2.1.12** capture while the binary is 2.1.16 (#295).
    // That used to leave "the game changed" as an open candidate for a count
    // short of a full house. It is now a narrow one: every Lua file behind the
    // Vulcanus chain is byte-identical 2.1.12 -> 2.1.16, so a version effect
    // here would have to be an ENGINE change rather than an expression change.
    // On the crack layer it was also ruled out empirically, game against game -
    // see `load_captured_at`.
    type R = ResourceFields;
    for (key, want_exact, select) in [
        (
            "basaltsFavorability",
            994usize,
            &(|f: &R| f.basalts_favorability) as &dyn Fn(&R) -> f64,
        ),
        ("mountainsFavorability", 1004, &|f| f.mountains_favorability),
        ("mountainsSulfurFavorability", 989, &|f| {
            f.mountains_sulfur_favorability
        }),
        ("ashlandsFavorability", 997, &|f| f.ashlands_favorability),
        ("startingTungsten", 1082, &|f| f.starting_tungsten),
        ("startingCoal", 974, &|f| f.starting_coal),
        ("startingCalcite", 969, &|f| f.starting_calcite),
        ("startingSulfur", 1049, &|f| f.starting_sulfur),
        ("tungstenRegion", 1033, &|f| f.tungsten_region),
        ("coalRegion", 1026, &|f| f.coal_region),
        ("calciteRegion", 999, &|f| f.calcite_region),
        ("sulfuricAcidRegion", 1020, &|f| f.sulfuric_acid_region),
        ("sulfuricAcidPatches", 867, &|f| f.sulfuric_acid_patches),
        ("sulfuricAcidRegionPatchy", 1020, &|f| {
            f.sulfuric_acid_region_patchy
        }),
        ("metalTile", 1077, &|f| f.metal_tile),
    ] {
        let got: Vec<f64> = fields.iter().map(select).collect();
        assert_eq!(
            score_vulcanus(&got, fixture.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 1085"
        );
    }
}

use crate::expressions::vulcanus_stack::{VulcanusBase, VulcanusStack};
use crate::tiles::vulcanus_catalog::VulcanusTile;

/// Count how many of a tile-name fixture's positions the port names correctly.
fn score_vulcanus_tiles(fixture: &Json, seed0: u32) -> usize {
    let ctx = crate::eval::ctx::EvalCtx::new(seed0);
    let base = VulcanusBase::with_host_trig(&ctx);
    let biomes = base.biomes_with_host_trig();
    let stack = VulcanusStack::with_host_trig(&base, &biomes);

    let positions = fixture.get("positions").as_array();
    let want = fixture.get("tileNames").as_array();
    assert_eq!(positions.len(), want.len(), "fixture columns disagree");
    positions
        .iter()
        .zip(want.iter())
        .filter(|(p, w)| stack.tile(p.get("x").as_f64(), p.get("y").as_f64()).name() == w.as_str())
        .count()
}

/// The 19-way Vulcanus tile argmax against `surface.get_tile(x, y).name` on a
/// real Vulcanus surface.
///
/// **This is the phase-5 counterpart of `puts_every_fulgora_tile_where_the_game
/// _puts_it`, and like it the count is FROZEN rather than bounded.** The
/// TypeScript asserts `agreement > 0.978`; a bound that wide cannot see a change
/// worth six tiles, which is exactly the #162 pathology this port exists to stop
/// inheriting.
#[test]
fn puts_every_vulcanus_tile_where_the_game_puts_it() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-tile-names.seed123456.json",
        "2.1.12",
    );
    assert_eq!(
        fixture.get("positions").as_array().len(),
        381,
        "fixture size"
    );
    let seed0 = fixture.get("seed0").as_f64() as u32;

    // Frozen exact count, measured 2026-08-24. The TypeScript scores the same
    // 374 of 381 (98.16%) against this fixture, so this is the distance BOTH
    // ports sit from the game.
    //
    // **100% is not the target here and that is a documented conclusion, not an
    // excuse.** Two causes are established, and both are properties of the model
    // rather than of the transcription:
    //
    // 1. `random_penalty_between(0.9, 1, 1)` inside `vulcanus_metal_tile` is
    //    approximated as 1. `random_penalty` is a whole-batch operation a
    //    per-pixel renderer cannot reproduce, and at an ore-patch edge where the
    //    game rolled a low penalty it can flip placement outright.
    // 2. The far-field f32 coordinate floor tipping a near-tie argmax across a
    //    range boundary.
    //
    // The 7 misses are ADJACENT-tile flips inside one biome family - folds-flat
    // against folds, smooth-stone against cracks-warm, ash-soil against pumice,
    // ash-flats against ash-light, cracks-hot against cracks-warm - spread over
    // radii 192 to 2079. No single range expression is systematically wrong,
    // which would cluster many cells of one tile instead.
    //
    // Captured at 2.1.12 against a 2.1.16 binary; the map-gen
    // Lua is byte-identical across that range (#295).
    assert_eq!(score_vulcanus_tiles(&fixture, seed0), 374, "of 381");
}

/// The BINARY lava classification, which is exact where the 19-way argmax is
/// not.
///
/// Graded separately because it is the only thing the cliff collision rejection
/// reads: `tryToAddCliff` asks whether a tile carries `water_tile`, never which
/// tile it is, so the argmax can confuse `volcanic-folds` for
/// `volcanic-folds-flat` all day without moving a cliff.
///
/// Asserted in BOTH directions - the count of lava the game placed, the count
/// the port places, and zero disagreements - so a port that called everything
/// lava would fail on the second and a port that called nothing lava would fail
/// on the first.
#[test]
fn classifies_every_vulcanus_lava_tile_correctly() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-tile-names.seed123456.json",
        "2.1.12",
    );
    let ctx = crate::eval::ctx::EvalCtx::new(fixture.get("seed0").as_f64() as u32);
    let base = VulcanusBase::with_host_trig(&ctx);
    let biomes = base.biomes_with_host_trig();
    let stack = VulcanusStack::with_host_trig(&base, &biomes);

    let is_lava = |t: VulcanusTile| matches!(t, VulcanusTile::Lava | VulcanusTile::LavaHot);
    let want_lava = |name: &str| name == "lava" || name == "lava-hot";

    let positions = fixture.get("positions").as_array();
    let want = fixture.get("tileNames").as_array();
    let mut game_lava = 0usize;
    let mut our_lava = 0usize;
    let mut mismatch = 0usize;
    for (p, w) in positions.iter().zip(want.iter()) {
        let ours = is_lava(stack.tile(p.get("x").as_f64(), p.get("y").as_f64()));
        let theirs = want_lava(w.as_str());
        if ours {
            our_lava += 1;
        }
        if theirs {
            game_lava += 1;
        }
        if ours != theirs {
            mismatch += 1;
        }
    }
    assert_eq!(game_lava, 49, "lava positions the game placed");
    assert_eq!(our_lava, 49, "lava positions the port places");
    assert_eq!(mismatch, 0, "lava classification disagreements");
}

/// The same argmax against the Vulcanus a real save at map seed 123456 produces.
///
/// The other fixture FORCES the surface seed to the map seed, which validates
/// the expressions and is blind to the seed plumbing. This one is captured from
/// a save with the surface seed left alone, so it records the planet a player
/// actually lands on.
///
/// The Rust side has no port of `surfaceSeedForPlanet` and does not need one -
/// nothing here derives a surface seed, it is handed one across the ABI. So this
/// reads the seed the fixture records and grades the expressions at it. The
/// derivation itself is guarded on the TypeScript side by
/// `test/vulcanusNaturalSeed.spec.ts`, which is where it lives.
#[test]
fn puts_every_vulcanus_tile_where_the_game_puts_it_at_a_real_saves_surface_seed() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-tile-names.natural-mapseed123456.json",
        "2.1.12",
    );
    let map_seed = fixture.get("mapSeed").as_f64() as u32;
    let surface_seed = fixture.get("seed0").as_f64() as u32;
    assert_eq!(map_seed, 123_456);
    assert_eq!(surface_seed, 1_249_936_247, "mapSeed + crc32(\"vulcanus\")");

    // Frozen exact count, measured 2026-08-24, and the TypeScript scores the
    // same 368 of 381 (96.59%) here. A different 381 points simply catch a few
    // more of the same boundary flips the forced-seed fixture documents.
    assert_eq!(score_vulcanus_tiles(&fixture, surface_seed), 368, "of 381");

    // **The contrast is the point of this test, not the 368.** Graded at the RAW
    // map seed the score collapses, because a wrong surface seed is not a subtle
    // regression - it is a different planet. Without this arm, 368 of 381 would
    // look like a strong result for a port that ignored the seed derivation
    // entirely.
    let wrong = score_vulcanus_tiles(&fixture, map_seed);
    assert_eq!(wrong, 37, "of 381 at the raw map seed");
    assert!(
        wrong * 5 < 381,
        "the wrong-seed arm must be near chance, or it is not a control"
    );
}

// ---------------------------------------------------------------------------
// Phase 5, second half (#225): the cliff stack.
// ---------------------------------------------------------------------------

use crate::cliffs::catalog::{
    cliff_code_for_orientation, cliff_collision_tile_box, cliff_orientation_for_code,
    CLIFF_ORIENTATION_NAMES,
};
use crate::cliffs::connections::{apply_cliff_connections, ApplyCollision, CliffConnectionOptions};
use crate::cliffs::placement::{
    CellRejection, CliffBands, CliffFields, CliffPlacement, PlacedCliffCell, TileCollision,
};
use crate::cliffs::vulcanus_fields::{
    VulcanusCliffFields, VulcanusLavaTiles, VULCANUS_CLIFF_ELEVATION_0,
    VULCANUS_CLIFF_ELEVATION_INTERVAL, VULCANUS_CLIFF_SMOOTHING,
};
use crate::cliffs::vulcanus_ore_rejection::VulcanusOreRejection;

/// Which rejections a cliff scoring arm runs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CliffArm {
    /// `tileCollides` only, which is what `test/vulcanusCliffEntities.spec.ts`
    /// scores. Kept so this port's numbers can be read against the figures that
    /// spec's own header table publishes.
    LavaOnly,
    /// What `renderVulcanusCliffs.ts` ships: the lava rejection, the ore -> cliff
    /// rejection, and both acting on the CROSSING rather than as a post-filter.
    Shipping,
}

/// Score one region of a cliff-entity fixture against the port.
///
/// Returns `(game, ours, matched)` over `cliff-vulcanus` entities only.
/// `crater-cliff` is excluded rather than absorbed into the rates: it is placed
/// by the ENTITY generator, jitter draws and all, so its positions are
/// fractional and comparing them against a 4-tile lattice would be a category
/// error.
fn score_vulcanus_cliffs(region: &Json, cliffs: &[Json], seed0: u32, arm: CliffArm) -> CliffScore {
    let ctx = crate::eval::ctx::EvalCtx::new(seed0);
    let base = VulcanusBase::with_host_trig(&ctx);
    let biomes = base.biomes_with_host_trig();
    let stack = VulcanusStack::with_host_trig(&base, &biomes);

    let fields = VulcanusCliffFields::new(&stack, seed0);
    let lava = VulcanusLavaTiles::new(&stack);
    let ore = VulcanusOreRejection::new(&stack, &ctx.vulcanus_resource_controls);
    let bands = CliffBands {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
        reject_at_crossing_stage: arm == CliffArm::Shipping,
        ..CliffBands::default()
    };
    let placement = CliffPlacement::new(&fields, bands).with_tile_collision(&lava);
    let placement = match arm {
        CliffArm::LavaOnly => placement,
        CliffArm::Shipping => placement.with_cell_rejection(&ore),
    };

    let placed = placement.placed_cells(
        region.get("x0").as_f64(),
        region.get("y0").as_f64(),
        region.get("x1").as_f64(),
        region.get("y1").as_f64(),
    );
    let ours: BTreeMap<(u64, u64), u8> = placed.iter().map(|c| (cell_key(c), c.code)).collect();
    let game: BTreeMap<(u64, u64), &str> = cliffs
        .iter()
        .filter(|c| c.get("name").as_str() == "cliff-vulcanus")
        .map(|c| {
            (
                (c.get("x").as_f64().to_bits(), c.get("y").as_f64().to_bits()),
                c.get("orientation").as_str(),
            )
        })
        .collect();

    let mut matched = 0usize;
    let mut orientation_agrees = 0usize;
    for (k, want) in &game {
        let Some(&code) = ours.get(k) else { continue };
        matched += 1;
        let id = cliff_orientation_for_code(code).expect("a placed cell has an orientation");
        if CLIFF_ORIENTATION_NAMES[id as usize] == *want {
            orientation_agrees += 1;
        }
    }
    CliffScore {
        game: game.len(),
        ours: ours.len(),
        matched,
        orientation_agrees,
    }
}

/// What one region's arm scored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CliffScore {
    /// `cliff-vulcanus` entities the game placed.
    game: usize,
    /// Cells the port places.
    ours: usize,
    /// Cells both agree on the POSITION of.
    matched: usize,
    /// Of those, how many the port also gives the game's own
    /// `LuaEntity.cliff_orientation`.
    orientation_agrees: usize,
}

/// A position key that cannot round two distinct cells together: the raw bits
/// of the two coordinates, which are exact on the 4-tile lattice.
fn cell_key(c: &PlacedCliffCell) -> (u64, u64) {
    (c.x.to_bits(), c.y.to_bits())
}

/// The Vulcanus cliff placement against `find_entities_filtered{type="cliff"}`
/// on a real Vulcanus surface - the end-to-end oracle for the whole stack.
///
/// **Four columns per region, all frozen, which is stronger than what the
/// TypeScript spec asserts.** `test/vulcanusCliffEntities.spec.ts` bounds recall
/// and precision with guards "pinned just outside the measured values", wide
/// enough to swallow a change worth several cells - the #162 pathology this port
/// exists to stop inheriting. Freezing `ours` apart from `matched` is what makes
/// over-placement visible: a model that placed a cliff on every lattice cell
/// would score 100% recall. And `orientation` is four bits per cell against the
/// game's own `LuaEntity.cliff_orientation`, where position is one - a cell can
/// land in the right place off the wrong crossings, and 33 of them do.
///
/// | arm | game | ours | matched | orientation | recall | precision |
/// | --- | ---: | ---: | ---: | ---: | ---: | ---: |
/// | lava only | 1569 | 1570 | 1525 | 1492 | 0.9720 | 0.9713 |
/// | shipping  | 1569 | **1547** | 1525 | **1504** | 0.9720 | **0.9858** |
///
/// **Both arms are graded because the difference between them IS the ore rule.**
/// It removes 23 cells and **not one of them is a cliff the game kept** -
/// `matched` is identical between the arms, so the whole 23 comes out of the
/// surplus - while turning 12 wrong orientations right. Wrong orientations go
/// **33 -> 21**, which is exactly what `renderVulcanusCliffs.ts` records having
/// measured for `rejectAtCrossingStage`, reached here through a separate
/// implementation and a different code path.
///
/// All 23 are in region 1 `[1500,1500]`; regions 0 and 2 are untouched, which is
/// why the per-region rows are worth freezing and not just the totals.
///
/// **Every one of these numbers was measured on the TypeScript side too, with
/// the same two arms against the same fixture, and all 24 agree exactly.** So
/// they describe the distance BOTH ports sit from the game, not a gap between
/// them - and because `orientation` agrees as well, the two ports produce the
/// same cell CODES and not merely the same positions. The lava-only rows also
/// reproduce the figures `vulcanusCliffEntities.spec.ts` publishes in its own
/// header table (283/283 at 0.9929, 885/900 at 0.9695/0.9533, 401/387 at
/// 0.9626/0.9974), which is a third, independently written statement of them.
///
/// If one of these moves: read it, do not adjust it. Up is worth taking; down is
/// a regression.
#[test]
fn places_every_vulcanus_cliff_where_the_game_places_it() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-cliff-entities.seed123456.json",
        "2.1.12",
    );
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let seed0 = fixture.get("seed").as_f64() as u32;
    let cases = fixture.get("cases").as_array();
    assert_eq!(cases.len(), 3, "the fixture's three regions");

    let score = |arm| {
        let mut rows = Vec::new();
        let mut totals = CliffScore {
            game: 0,
            ours: 0,
            matched: 0,
            orientation_agrees: 0,
        };
        for case in cases {
            let got = score_vulcanus_cliffs(
                case.get("region"),
                case.get("cliffs").as_array(),
                seed0,
                arm,
            );
            totals.game += got.game;
            totals.ours += got.ours;
            totals.matched += got.matched;
            totals.orientation_agrees += got.orientation_agrees;
            rows.push(got);
        }
        (rows, totals)
    };
    let row = |game, ours, matched, orientation_agrees| CliffScore {
        game,
        ours,
        matched,
        orientation_agrees,
    };

    let (lava_rows, lava) = score(CliffArm::LavaOnly);
    assert_eq!(
        lava_rows,
        vec![
            row(283, 283, 281, 276),
            row(885, 900, 858, 833),
            row(401, 387, 386, 383)
        ],
        "lava-only, per region"
    );
    assert_eq!(lava, row(1569, 1570, 1525, 1492), "lava-only totals");

    let (ship_rows, ship) = score(CliffArm::Shipping);
    assert_eq!(
        ship_rows,
        vec![
            row(283, 283, 281, 277),
            row(885, 877, 858, 842),
            row(401, 387, 386, 385)
        ],
        "shipping, per region"
    );
    assert_eq!(ship, row(1569, 1547, 1525, 1504), "shipping totals");

    // The ore rule's own claim, stated as assertions rather than left to be read
    // off the two rows.
    assert_eq!(
        lava.matched, ship.matched,
        "the ore rejection cost a true positive"
    );
    assert_eq!(lava.ours - ship.ours, 23, "cells the ore rejection removed");
    assert_eq!(
        (
            lava.matched - lava.orientation_agrees,
            ship.matched - ship.orientation_agrees
        ),
        (33, 21),
        "wrong orientations, which renderVulcanusCliffs.ts records as 33 -> 21"
    );
}

/// The Vulcanus cliff fields against the game's own samples at the game's own
/// lattice - 12,675 corners across three regions.
///
/// This is the layer under [`places_every_vulcanus_cliff_where_the_game_places_it`],
/// and it needs its own grading for the reason the whole port is graded field by
/// field: an end-to-end count can be right for compensating reasons, and a
/// discrete output absorbs a sub-ULP error in its inputs essentially always.
///
/// ## The fixture's `elevation` column is the TILE channel, and that is the
/// whole of issue #83
///
/// The capture samples through `LuaSurface.calculate_tile_properties`, whose
/// noise program has a **1-tile grid**. The cliff generator walks the **4-tile**
/// corner lattice, and `multisample`'s offsets are in GRID UNITS, so
/// `vulcanus_basalt_lakes_multisample` returns different values in the two
/// channels. Grading `cliff_elevation` against this column is therefore a
/// category error - it scores 419 of 12,675 with a worst residual of **60.6
/// tiles**, and the TypeScript scores exactly the same 419 and the same 6.0623e1,
/// because both ports read the right field and the fixture holds the other one.
///
/// So this test grades the TILE-channel field against the column that holds it,
/// and asserts the two channels DISAGREE - turning #83 from a comment into a
/// live assertion. A port that collapsed the two grids would go red here rather
/// than quietly losing seven points of cliff recall, which is how the bug hid
/// the first time: the fixture and the port shared the mistake, so every check
/// agreed.
///
/// The gap is **sparse and large**, not a uniform offset: the grids disagree at
/// 2,519 of the 12,675 corners and agree at the other 10,156, because the 2x2
/// min-filter only bites where a neighbour is lower. Where it bites it is worth
/// up to 60.6 tiles. That shape is why the wrong channel cost seven points of
/// recall rather than being obvious.
///
/// **The tile-channel elevation itself is 786 of 12,675**, worst residual
/// 4.393e-2 - about 1.3e-4 relative on a field spanning roughly -58 to +1024,
/// the same order every layer above it carries. That is the standing Vulcanus
/// elevation gap (#293 took it from 115 to 169 of 434 on its own fixture), not
/// anything the cliff stack introduced, and the TypeScript scores the identical
/// 786 and the identical 4.3931e-2.
///
/// **`cliffiness` is exact at every corner - 12,675 of 12,675.** It has no
/// `multisample` in it, so it is channel-independent and this fixture grades it
/// directly. Read the count with its clamp: `cliffiness_basic` ends in
/// `min(1, max(0, ...)) + 0.5` and saturates at 8,431 of the 12,675 corners,
/// where a position is exact for free. The other 4,244 are not, which is what
/// makes the full house worth something.
#[test]
fn reproduces_the_vulcanus_cliff_fields_at_every_captured_corner() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-cliff-corner-fields.seed123456.json",
        "2.1.12",
    );
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let seed0 = fixture.get("seed").as_f64() as u32;
    let grid = fixture.get("grid").as_f64();
    assert_eq!(grid, 4.0, "the cliff lattice is 4 tiles");
    assert_eq!(
        fixture.get("cornerOffsetY").as_f64(),
        0.0,
        "the game samples the BARE lattice - a 0.5 here is the superseded capture"
    );

    let ctx = crate::eval::ctx::EvalCtx::new(seed0);
    let base = VulcanusBase::with_host_trig(&ctx);
    let biomes = base.biomes_with_host_trig();
    let stack = VulcanusStack::with_host_trig(&base, &biomes);
    let fields = VulcanusCliffFields::new(&stack, seed0);

    let corners = fixture.get("corners").as_array();
    let want_elev = fixture.get("elevation").as_f64_array();
    let want_cliff = fixture.get("cliffiness").as_f64_array();
    assert_eq!(corners.len(), 12_675, "captured corners");
    assert_eq!(want_elev.len(), corners.len());
    assert_eq!(want_cliff.len(), corners.len());

    let mut tile_exact = 0usize;
    let mut cliff_exact = 0usize;
    let mut saturated = 0usize;
    let mut channels_differ = 0usize;
    let mut worst_tile: f64 = 0.0;
    let mut worst_channel_gap: f64 = 0.0;
    for (k, corner) in corners.iter().enumerate() {
        let key = corner.as_str();
        let (i, j) = key.split_once(',').expect("corner keys are \"i,j\"");
        let x = i.parse::<f64>().expect("corner i") * grid;
        let y = j.parse::<f64>().expect("corner j") * grid;

        let tile_channel = stack.elevation(x, y);
        if tile_channel as f32 == want_elev[k] as f32 {
            tile_exact += 1;
        }
        worst_tile = max2(worst_tile, (tile_channel - want_elev[k]).abs());

        let cliff_channel = fields.cliff_elevation(x, y);
        let gap = (cliff_channel - tile_channel).abs();
        if gap > 0.0 {
            channels_differ += 1;
        }
        worst_channel_gap = max2(worst_channel_gap, gap);

        let got_cliff = fields.cliffiness(x, y);
        if got_cliff as f32 == want_cliff[k] as f32 {
            cliff_exact += 1;
        }
        if want_cliff[k] == 0.5 || want_cliff[k] == 1.5 {
            saturated += 1;
        }
    }

    assert_eq!(
        cliff_exact, 12_675,
        "cliffiness exact f32 matches out of 12,675"
    );
    assert_eq!(
        saturated, 8_431,
        "corners where the cliffiness clamp saturates"
    );
    assert_eq!(
        tile_exact, 786,
        "tile-channel elevation exact f32 matches out of 12,675"
    );
    assert!(
        worst_tile < 4.4e-2,
        "tile-channel elevation worst residual {worst_tile:e}"
    );

    // #83 as an assertion. The two channels are the same expression read
    // through different grids, and they must not agree.
    assert_eq!(
        channels_differ, 2_519,
        "corners where the two grids disagree"
    );

    // #83 as an assertion. The two channels are the same expression read
    // through different grids, and they must not agree.

    assert!(
        worst_channel_gap > 50.0,
        "the channel gap collapsed to {worst_channel_gap} - has multisample lost its grid?"
    );
}

/// `Surface::wouldCollide` for a Vulcanus cliff at the APPLY stage: the
/// orientation's box against the lava tiles, plus the ore removal.
///
/// The same geometry `tile_collides` drives through the placement pass - only
/// the STAGE it runs at is different, which is the whole subject of
/// [`the_apply_stage_beats_the_crossing_stage_on_three_counts_and_loses_on_none`].
struct LavaAndOre<'a, 'b> {
    lava: VulcanusLavaTiles<'a, 'b>,
    ore: VulcanusOreRejection<'a, 'b>,
}

impl ApplyCollision for LavaAndOre<'_, '_> {
    fn collides(&self, orientation: u8, x: f64, y: f64) -> bool {
        let Some(code) = cliff_code_for_orientation(orientation) else {
            return false;
        };
        if let Some(b) = cliff_collision_tile_box(code, x, y) {
            for tx in b.left..=b.right {
                for ty in b.top..=b.bottom {
                    if self.lava.collides(tx, ty) {
                        return true;
                    }
                }
            }
        }
        self.ore.rejects(code, x, y)
    }
}

/// How a set of oriented cells scores against the game's own.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct OrientationScore {
    /// Right place, right orientation.
    matched: usize,
    /// Right place, wrong orientation.
    wrong: usize,
    /// A cell the game does not have.
    surplus: usize,
    /// A cell the game has and this does not.
    missing: usize,
}

/// `applyCliffs` against `rejectAtCrossingStage` - the two stages a rejection
/// could act at, scored on ORIENTATION against the game's own cliffs.
///
/// `rejectAtCrossingStage` zeroes a rejected cell's four edges. The real stage
/// destroys the entity and lets `Cliff::onDestroy` take the facing end of each
/// CONNECTED neighbour - one or two sides, not four, and by rewriting the
/// orientation rather than by clearing a crossing.
///
/// **This is what grades [`crate::cliffs::connections`] at all.** That module
/// is on no render path - it is the model #84's investigation is scored with -
/// so without this it would be a port with unit tests and no measurement
/// against anything. Here it runs the same three arms the TypeScript's
/// `cliffConnections.spec.ts` runs, over the same fixture, and must reach the
/// same numbers:
///
/// | model | matched | wrong | surplus | missing |
/// | --- | ---: | ---: | ---: | ---: |
/// | `reject_at_crossing_stage` (ships) | 1504 | 21 | 22 | 6 |
/// | `applyCliffs`, lava + ore | **1508** | **18** | 22 | **5** |
/// | `applyCliffs`, no cascade | 1500 | 25 | 22 | 6 |
///
/// The apply stage is better on three counts and worse on none, and the
/// no-cascade row is what says the CASCADE rather than the re-staging is doing
/// it - without that arm "the apply stage is better" would not distinguish the
/// two explanations.
///
/// **It is deliberately not what the renderer runs.** On POSITION alone the two
/// models are a wash - 1526 against 1525 of 1531 - and the renderer paints
/// positions and ignores orientation. Adopting it there means running the pass
/// over a padded query and filtering afterwards, which changes the geometry the
/// tiled-equals-whole tests pin. That is worth doing on its own evidence, not
/// smuggled in for one cell.
///
/// The 64-tile pad is a HALO, not a margin: a cell on the query's outer chunk
/// ring reads its neighbour across the boundary, and the `onDestroy` cascade can
/// reach further still.
#[test]
fn the_apply_stage_beats_the_crossing_stage_on_three_counts_and_loses_on_none() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-cliff-entities.seed123456.json",
        "2.1.12",
    );
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let seed0 = fixture.get("seed").as_f64() as u32;

    let ctx = crate::eval::ctx::EvalCtx::new(seed0);
    let base = VulcanusBase::with_host_trig(&ctx);
    let biomes = base.biomes_with_host_trig();
    let stack = VulcanusStack::with_host_trig(&base, &biomes);
    let fields = VulcanusCliffFields::new(&stack, seed0);
    let lava = VulcanusLavaTiles::new(&stack);
    let ore = VulcanusOreRejection::new(&stack, &ctx.vulcanus_resource_controls);
    let apply = LavaAndOre {
        lava: VulcanusLavaTiles::new(&stack),
        ore: VulcanusOreRejection::new(&stack, &ctx.vulcanus_resource_controls),
    };
    let bands = CliffBands {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
        ..CliffBands::default()
    };

    let mut totals = [OrientationScore::default(); 3];
    for case in fixture.get("cases").as_array() {
        let r = case.get("region");
        let (x0, y0) = (r.get("x0").as_f64(), r.get("y0").as_f64());
        let (x1, y1) = (r.get("x1").as_f64(), r.get("y1").as_f64());

        // The game's own cliffs in this region, by position, carrying the
        // orientation it gave each one.
        let mut game: BTreeMap<(u64, u64), u8> = BTreeMap::new();
        for e in case.get("cliffs").as_array() {
            if e.get("name").as_str() != "cliff-vulcanus" {
                continue;
            }
            let (x, y) = (e.get("x").as_f64(), e.get("y").as_f64());
            if x < x0 || x >= x1 || y < y0 || y >= y1 {
                continue;
            }
            let want = e.get("orientation").as_str();
            if let Some(id) = CLIFF_ORIENTATION_NAMES.iter().position(|n| *n == want) {
                game.insert((x.to_bits(), y.to_bits()), id as u8);
            }
        }

        // Arm 0: the shipping model, rejecting at the crossing stage.
        let shipped: BTreeMap<(u64, u64), u8> = CliffPlacement::new(
            &fields,
            CliffBands {
                reject_at_crossing_stage: true,
                ..bands
            },
        )
        .with_tile_collision(&lava)
        .with_cell_rejection(&ore)
        .placed_cells(x0, y0, x1, y1)
        .iter()
        .filter_map(|c| cliff_orientation_for_code(c.code).map(|id| (cell_key(c), id)))
        .collect();

        // Arms 1 and 2: the crossing field and the repair alone, over a 64-tile
        // halo, with the rejection moved to the apply stage.
        let raw = CliffPlacement::new(&fields, bands).placed_cells(
            x0 - 64.0,
            y0 - 64.0,
            x1 + 64.0,
            y1 + 64.0,
        );
        let staged = |no_cascade: bool| -> BTreeMap<(u64, u64), u8> {
            apply_cliff_connections(
                &raw,
                &CliffConnectionOptions {
                    collides: Some(&apply),
                    no_cascade,
                    ..Default::default()
                },
            )
            .iter()
            .filter(|c| c.x >= x0 && c.x < x1 && c.y >= y0 && c.y < y1)
            .map(|c| ((c.x.to_bits(), c.y.to_bits()), c.orientation))
            .collect()
        };

        for (i, port) in [shipped, staged(false), staged(true)].iter().enumerate() {
            for (k, id) in port {
                match game.get(k) {
                    None => totals[i].surplus += 1,
                    Some(want) if want == id => totals[i].matched += 1,
                    Some(_) => totals[i].wrong += 1,
                }
            }
            totals[i].missing += game.keys().filter(|k| !port.contains_key(*k)).count();
        }
    }

    let row = |matched, wrong, surplus, missing| OrientationScore {
        matched,
        wrong,
        surplus,
        missing,
    };
    assert_eq!(
        totals[0],
        row(1504, 21, 22, 6),
        "rejectAtCrossingStage (ships)"
    );
    assert_eq!(totals[1], row(1508, 18, 22, 5), "applyCliffs, lava + ore");
    assert_eq!(totals[2], row(1500, 25, 22, 6), "applyCliffs, no cascade");

    // Stated as relations too, so the claim survives a re-measure that moves
    // every row: better on three counts, worse on none.
    assert!(totals[1].matched > totals[0].matched);
    assert!(totals[1].wrong < totals[0].wrong);
    assert!(totals[1].missing < totals[0].missing);
    assert_eq!(totals[1].surplus, totals[0].surplus);
    // And on POSITION alone it is one cell, which is why the renderer is left
    // alone. The whole gain is in orientation.
    assert_eq!(totals[1].matched + totals[1].wrong, 1526);
    assert_eq!(totals[0].matched + totals[0].wrong, 1525);
}

// ---------------------------------------------------------------------------
// Phase 5, part 3 (#225) - the Vulcanus ROCK and RESOURCE overlays.
//
// The two probability expressions and the one new noise field they read. The
// placement roll that turns them into entities has no game fixture of its own -
// see the note on the test below.
// ---------------------------------------------------------------------------

use crate::rocks::vulcanus_field::{vulcanus_decorative_knockout, VulcanusRockFields};

/// The Vulcanus rock probability field: `vulcanus_decorative_knockout` and the
/// two expressions its four rock entities share.
///
/// **`vulcanus_decorative_knockout` is BIT-EXACT at all 434 positions**, worst
/// residual exactly 0 - the strongest tier-1 result any Vulcanus field has. It
/// is a bare two-octave `multioctave_noise` at `output_scale = 1`, so nothing
/// sits between it and the primitives #290 and #293 fixed; the two composites
/// above it carry the biome layer's remaining error and score far lower.
///
/// **The TypeScript spec for these same three fields asserts BOUNDS** (2e-4,
/// 5e-4, 5e-4), which is the #162 pathology and what #256 exists to remove.
/// Measured on that side at the same 434 positions, the worst residuals are
/// **0**, 3.7199e-7 and 2.5693e-7 - so the knockout's bound is inert outright
/// and the other two are 1,300x wider than the thing they bound. That side's
/// comment still describes the knockout's residual growing with distance to
/// 1.18e-4, which was true before #290 and #293 narrowed `basis_noise`'s input
/// scale and is not true now.
///
/// All three counts were measured on the TypeScript side too and agree exactly,
/// so they describe the distance BOTH ports sit from the game rather than a gap
/// between them.
#[test]
fn reproduces_the_vulcanus_rock_fields_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-vulcanus-rocks.seed123456.json",
        "2.1.12",
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 434, "fixture size");
    let seed0 = fixture.get("seed0").as_f64() as u32;

    let ctx = crate::eval::ctx::EvalCtx::new(seed0);
    let base = VulcanusBase::with_host_trig(&ctx);
    let biomes = base.biomes_with_host_trig();
    let stack = VulcanusStack::with_host_trig(&base, &biomes);
    let fields = VulcanusRockFields::new(&stack, seed0);
    let knockout = vulcanus_decorative_knockout(seed0);

    let mut knockout_out = Vec::with_capacity(positions.len());
    let mut huge = Vec::with_capacity(positions.len());
    let mut big = Vec::with_capacity(positions.len());
    for p in positions {
        let (x, y) = (p.get("x").as_f64(), p.get("y").as_f64());
        knockout_out.push(f64::from(knockout.eval(x, y)));
        let f = fields.eval(x, y);
        huge.push(f.rock_huge);
        big.push(f.rock_big);
    }

    let values = fixture.get("values");
    for (key, want_exact, got) in [
        ("vulcanus_decorative_knockout", 434usize, &knockout_out),
        ("vulcanus_rock_huge", 178, &huge),
        ("vulcanus_rock_big", 205, &big),
    ] {
        assert_eq!(
            score_vulcanus(got, values.get(key).as_array(), key),
            want_exact,
            "{key} exact f32 matches out of 434"
        );
    }

    // The density is `clamp(max(huge, big), 0, 1)` of the GAME's own two
    // columns, which is a statement about the arbitration rather than about the
    // port: per-tile arbitration among competing autoplacers is by maximum
    // probability, so taking the max is exact rather than an approximation.
    // Scored against the game's values so it cannot pass by agreeing with our
    // own two fields.
    //
    // **412 of 434 is the CLAMP, not the arithmetic.** 399 of these positions
    // clamp to exactly 0 - both rock expressions are negative over most of the
    // map - and a saturated position is exact for free, because both ports and
    // the game all return the bound itself. Of the 35 positions where the
    // density is nonzero, 13 are exact. Read `vulcanus_rock_big` (205 of 434)
    // as the port's score and this as what the consumer needs, the same way
    // `*_biome_full` and `*_biome` are read in the biome layer. The TypeScript
    // measures 412 and 399 here too.
    let want_huge = values.get("vulcanus_rock_huge").as_array();
    let want_big = values.get("vulcanus_rock_big").as_array();
    let mut density_exact = 0usize;
    let mut clamped_to_zero = 0usize;
    for (i, p) in positions.iter().enumerate() {
        let (x, y) = (p.get("x").as_f64(), p.get("y").as_f64());
        let want = crate::eval::math::clamp(
            crate::eval::math::max2(want_huge[i].as_f64(), want_big[i].as_f64()),
            0.0,
            1.0,
        );
        if want == 0.0 {
            clamped_to_zero += 1;
        }
        if (fields.eval(x, y).density as f32) == (want as f32) {
            density_exact += 1;
        }
    }
    assert_eq!(density_exact, 412, "density exact f32 matches out of 434");
    assert_eq!(clamped_to_zero, 399, "positions the clamp saturates at 0");

    // Both expressions cap at `0.2 * (1 - k * ashlands_biome)`, so the overlay
    // cannot use the ores' `>= 0.5` rule - it rolls per tile instead. The game
    // evaluates the cap in f32, so the captured peak is f32(0.2) rounded up
    // rather than 0.2 exactly; compared with a tick of slack rather than
    // pretending the constant comes back exact.
    let peak = want_huge
        .iter()
        .chain(want_big)
        .map(super::test_json::Json::as_f64)
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(peak <= 0.2 + 1e-6, "captured peak {peak} exceeds the cap");
    assert!(peak > 0.05, "the field is empty over this sample");
}

// ---------------------------------------------------------------------------
// Phase 6 (#226), Nauvis. The shared sub-tree first: `nauvis_hills`,
// `nauvis_hills_cliff_level`, `nauvis_plateaus`, `nauvis_bridge_billows`,
// `forest_path_billows`, and the domain-warped `nauvis_hills_offset` /
// `nauvis_cliff_ringbreak` pair the cliff field reads.
// ---------------------------------------------------------------------------

use crate::expressions::nauvis_shared::{
    NauvisShared, NauvisSharedParams, NAUVIS_OFFSET_X_SEED1, NAUVIS_OFFSET_Y_SEED1,
};

/// Score one named field over a fixture's positions, snapped onto the capture
/// grid, returning (exact f32 matches, worst absolute residual).
///
/// The snap is `snap_coord`, for the reason `load_captured_at` records at
/// length: a fixture's raw coordinate is often not where the game looked.
fn score_nauvis(
    positions: &[(f64, f64)],
    expected: &[Json],
    mut f: impl FnMut(f64, f64) -> f64,
) -> (usize, f64) {
    let mut exact = 0usize;
    let mut worst = 0.0f64;
    for (i, (x, y)) in positions.iter().enumerate() {
        let want = expected[i].as_f64();
        let got = f64::from(f(snap_coord(*x), snap_coord(*y)) as f32);
        worst = worst.max((got - want).abs());
        if got == want {
            exact += 1;
        }
    }
    (exact, worst)
}

#[test]
fn the_nauvis_offset_seeds_are_the_crc32_of_their_expression_names() {
    // The game passes `basis_noise` the STRING 'nauvis_offset_x' / '_y' as
    // seed1 and hashes it with standard CRC32. These two constants are the only
    // place in the port where a seed comes from a name rather than a number, so
    // they are pinned directly rather than left to be graded through the field
    // they seed - a wrong constant produces a perfectly plausible warp field.
    //
    // `src/noise/expressions/nauvisShared.ts` pins the same two values, and
    // `test/nauvisShared.spec.ts` asserts them.
    assert_eq!(NAUVIS_OFFSET_X_SEED1, 593_691_028);
    assert_eq!(NAUVIS_OFFSET_Y_SEED1, 1_415_852_290);
}

#[test]
fn reproduces_the_nauvis_cliff_offset_chain_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-cliff-offset-raw.seed123456.json",
        "2.1.11",
    );
    let positions = fixture_positions(&fixture, "positions");
    assert_eq!(positions.len(), 38, "a regen cannot empty the loop");

    // This fixture was captured entirely ON the 1/256 grid, so `snap_coord` is
    // the identity here and the counts below are the same snapped or not. It is
    // still applied, and the count still asserted, so that a re-capture which
    // introduced off-grid positions would be graded correctly rather than
    // scoring at points the game never evaluated.
    assert_eq!(count_off_grid(&positions), 0, "off-grid positions");

    // Two seeds, so a constant that happened to suit 123456 cannot pass.
    // Every count below was measured on the TypeScript side against this same
    // fixture with the same snap, and all eight agree exactly - so they are the
    // distance BOTH ports sit from the game rather than a gap between them.
    let expected: [(u32, usize, usize, usize, usize); 2] = [
        // (seed, rawX, rawY, hillsOffset, cliffRingbreak) exact f32 matches / 38
        (123_456, 30, 30, 29, 29),
        (777_771, 36, 30, 31, 31),
    ];

    for (case, &(seed, want_raw_x, want_raw_y, want_offset, want_ringbreak)) in
        fixture.get("cases").as_array().iter().zip(expected.iter())
    {
        assert_eq!(case.get("seed").as_f64() as u32, seed, "case order");
        let shared = NauvisShared::new(&NauvisSharedParams {
            seed0: seed,
            segmentation_multiplier: 1.0,
        });

        // `raw_x`/`raw_y` are bare `basis_noise` at `nauvis_seg / 500`, read
        // through the layer so a wrong input scale or a swapped table is caught
        // here rather than only through the fields above them.
        let (raw_x, worst_raw_x) = score_nauvis(&positions, case.get("rawX").as_array(), |x, y| {
            shared.hills_offset_raw_x(x, y)
        });
        let (raw_y, worst_raw_y) = score_nauvis(&positions, case.get("rawY").as_array(), |x, y| {
            shared.hills_offset_raw_y(x, y)
        });
        let (offset, worst_offset) =
            score_nauvis(&positions, case.get("hillsOffset").as_array(), |x, y| {
                shared.hills_offset(x, y)
            });
        let (ringbreak, worst_ringbreak) =
            score_nauvis(&positions, case.get("ringbreak").as_array(), |x, y| {
                shared.cliff_ringbreak(x, y)
            });

        assert_eq!(
            raw_x, want_raw_x,
            "seed {seed} rawX exact, worst {worst_raw_x:e}"
        );
        assert_eq!(
            raw_y, want_raw_y,
            "seed {seed} rawY exact, worst {worst_raw_y:e}"
        );
        assert_eq!(
            offset, want_offset,
            "seed {seed} hillsOffset exact, worst {worst_offset:e}"
        );
        assert_eq!(
            ringbreak, want_ringbreak,
            "seed {seed} cliffRingbreak exact, worst {worst_ringbreak:e}"
        );
    }
}

// ---------------------------------------------------------------------------
// `elevation_lakes` and `elevation_island` - `make_0_12like_lakes` plus
// `finish_elevation`, the two halves of the pre-Nauvis elevation tree.
// ---------------------------------------------------------------------------

use crate::expressions::elevation_lakes::{ElevationLakes, ElevationLakesParams};

/// The three elevation fixtures share a shape: 26 positions, an `elevation`
/// array, and a `startingLakeDistance` array whose saturation at 1024 splits
/// the far field from the near-spawn band.
fn score_elevation(fixture: &Json, tree: &ElevationLakes) -> (usize, f64) {
    let positions = fixture_positions(fixture, "positions");
    let expected = fixture.get("elevation").as_array();
    score_nauvis(&positions, expected, |x, y| tree.eval(x, y))
}

#[test]
fn reproduces_the_games_elevation_lakes_tree_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-elevation-lakes.seed123456.json",
        "2.1.11",
    );
    let positions = fixture_positions(&fixture, "positions");
    assert_eq!(positions.len(), 26, "a regen cannot empty the loop");
    // 14 of the 26 far-ring positions were captured off the 1/256 grid, so the
    // snap is doing real work here - unlike the offset-raw fixture above.
    assert_eq!(count_off_grid(&positions), 14, "off-grid positions");

    let lakes = ElevationLakes::new(&ElevationLakesParams::defaults(123_456));
    let (exact, worst) = score_elevation(&fixture, &lakes);

    // Measured on the TypeScript side against the same fixture with the same
    // snap: 21 and 3.814697e-6, to every printed digit.
    //
    // `test/elevationLakes.spec.ts` asserts a BOUND (`worst < 4e-6`) and splits
    // the fixture into a far field and a near-spawn band. This grades all 26 at
    // once and freezes the count instead, for the reason the header records: a
    // bound cannot tell "close" from "identical", and the 4 far-field misses
    // are #255, still open. If this number moves, read it - up is worth taking,
    // down is a regression.
    assert_eq!(exact, 21, "exact f32 matches, worst {worst:e}");
    assert!(worst < 4e-6, "worst absolute error {worst:e}");
}

#[test]
fn reproduces_the_games_elevation_island_tree_at_every_captured_position() {
    // `elevation_island` IS `elevation_lakes` with `bias = -1000` and the
    // segmentation divided by 4, so this grades the same code down a different
    // branch. The bias is what collapses branch 1 of `make_0_12like_lakes` and
    // leaves branch 2's own literal 20 standing - the two coincide at
    // `elevation_lakes`, which is exactly why a single fixture could not tell
    // a port that confused them from one that did not.
    let fixture = load_captured_at(
        "test/fixtures/oracle-elevation-island.seed123456.json",
        "2.1.11",
    );
    let positions = fixture_positions(&fixture, "positions");
    assert_eq!(positions.len(), 26, "a regen cannot empty the loop");
    assert_eq!(count_off_grid(&positions), 14, "off-grid positions");

    let island = ElevationLakes::new(&ElevationLakesParams::island(123_456));
    let (exact, worst) = score_elevation(&fixture, &island);

    // Measured on the TypeScript side: 19 and 1.525879e-5.
    assert_eq!(exact, 19, "exact f32 matches, worst {worst:e}");
    assert!(worst < 1.6e-5, "worst absolute error {worst:e}");
}

#[test]
fn the_island_branch_differs_from_the_lakes_branch_where_the_bias_bites() {
    // Anti-vacuity for the two tests above: they read different fixtures, but
    // both call the same struct, so a port that ignored `bias` entirely would
    // score 21 on one and something on the other without either test saying
    // the branch was reached. The two trees must actually disagree.
    let lakes = ElevationLakes::new(&ElevationLakesParams::defaults(123_456));
    let island = ElevationLakes::new(&ElevationLakesParams::island(123_456));
    let mut differ = 0usize;
    for i in -8i32..8 {
        for j in -8i32..8 {
            let (x, y) = (f64::from(i) * 137.5, f64::from(j) * 141.25);
            if lakes.eval(x, y) != island.eval(x, y) {
                differ += 1;
            }
        }
    }
    // 232 of 256, not all - `finish_elevation` takes a `min` of four terms and
    // only one of them reads the lakes branch, so where a starting-lake term is
    // already the smallest the bias cannot show. Both halves are frozen:
    // "everything differs" is false, and "something differs" would pass for a
    // port that dropped `bias` and got its difference from the quartered
    // segmentation alone.
    assert_eq!(differ, 232, "positions where the two trees disagree");
    assert_eq!(
        256 - differ,
        24,
        "positions where the outer min masks the bias"
    );
}

// ---------------------------------------------------------------------------
// `elevation_nauvis` - the planet's own elevation tree, and the
// `added_cliff_elevation = 0` variant the cliffiness field depends on.
// ---------------------------------------------------------------------------

use crate::expressions::elevation_nauvis::{ElevationNauvis, ElevationNauvisParams};

#[test]
fn reproduces_the_games_elevation_nauvis_tree_at_every_captured_position() {
    let fixture = load_captured_at(
        "test/fixtures/oracle-elevation-nauvis.seed123456.json",
        "2.1.11",
    );
    let positions = fixture_positions(&fixture, "positions");
    assert_eq!(positions.len(), 26, "a regen cannot empty the loop");
    assert_eq!(count_off_grid(&positions), 14, "off-grid positions");

    let nauvis = ElevationNauvis::new(&ElevationNauvisParams::defaults(123_456));
    let (exact, worst) = score_nauvis(&positions, fixture.get("elevation").as_array(), |x, y| {
        nauvis.eval(x, y)
    });

    // Measured on the TypeScript side against the same fixture with the same
    // snap: 8 and 3.852844e-4, to every printed digit.
    //
    // **8 of 26 is the WEAKEST tier-1 count in the Nauvis port so far, and that
    // is inherited rather than new.** This tree stacks the shared layer, an
    // amplitude-corrected persistence field and a variable-persistence detail
    // stack on top of each other, so it carries every unported narrowing
    // underneath it at once - including the 81/152 of #254, which sits directly
    // in its persistence term. `test/elevationNauvis.spec.ts` bounds the same
    // quantity at 4e-4 and reports no count at all.
    assert_eq!(exact, 8, "exact f32 matches, worst {worst:e}");
    assert!(worst < 4e-4, "worst absolute error {worst:e}");
}

#[test]
fn reproduces_the_games_elevation_nauvis_no_cliff_variant_at_both_seeds() {
    // `elevation_nauvis_no_cliff` is `elevation_nauvis_function(0)` - the same
    // tree with `added_cliff_elevation` forced to zero. It is what
    // `cliff_elevation_nauvis` depends on, so it is a real expression rather
    // than a debugging switch, and it is graded at TWO seeds.
    let fixture = load_captured_at(
        "test/fixtures/oracle-elevation-nauvis-no-cliff.seed123456.json",
        "2.1.11",
    );
    let positions = fixture_positions(&fixture, "positions");
    assert_eq!(positions.len(), 26, "a regen cannot empty the loop");
    assert_eq!(count_off_grid(&positions), 14, "off-grid positions");

    // Measured on the TypeScript side: (seed, exact) pairs, worst 3.833771e-4
    // and 3.089905e-4 respectively.
    for (case, &(seed, want)) in fixture
        .get("cases")
        .as_array()
        .iter()
        .zip([(123_456u32, 6usize), (777_771, 4)].iter())
    {
        assert_eq!(case.get("seed").as_f64() as u32, seed, "case order");
        let mut params = ElevationNauvisParams::defaults(seed);
        params.with_cliff_elevation = false;
        let tree = ElevationNauvis::new(&params);
        let (exact, worst) = score_nauvis(&positions, case.get("elevation").as_array(), |x, y| {
            tree.eval(x, y)
        });
        assert_eq!(
            exact, want,
            "seed {seed} exact f32 matches, worst {worst:e}"
        );
        assert!(worst < 4e-4, "seed {seed} worst absolute error {worst:e}");
    }
}

#[test]
fn the_cliff_elevation_term_moves_the_tree_where_the_outer_min_does_not_mask_it() {
    // Anti-vacuity for the pair above: both call the same struct, so a port
    // that ignored `with_cliff_elevation` would score 8 and 6 against two
    // fixtures that genuinely differ, and neither test would say the flag was
    // read. The two fixtures share their positions exactly, which is what makes
    // a position-by-position comparison legitimate here.
    let with_fixture = load_captured_at(
        "test/fixtures/oracle-elevation-nauvis.seed123456.json",
        "2.1.11",
    );
    let without_fixture = load_captured_at(
        "test/fixtures/oracle-elevation-nauvis-no-cliff.seed123456.json",
        "2.1.11",
    );
    let positions = fixture_positions(&with_fixture, "positions");
    assert_eq!(
        positions,
        fixture_positions(&without_fixture, "positions"),
        "the two fixtures no longer sample the same points"
    );

    let with_cliff = ElevationNauvis::new(&ElevationNauvisParams::defaults(123_456));
    let mut off = ElevationNauvisParams::defaults(123_456);
    off.with_cliff_elevation = false;
    let without_cliff = ElevationNauvis::new(&off);

    // The GAME's own two columns, so this measures the expression rather than
    // the port: the flag must move some positions and be masked at others.
    let game_with = with_fixture.get("elevation").as_array();
    let game_without = without_fixture.get("cases").as_array()[0]
        .get("elevation")
        .as_array();
    let mut game_differ = 0usize;
    let mut ours_differ = 0usize;
    for (i, (x, y)) in positions.iter().enumerate() {
        if game_with[i].as_f64() != game_without[i].as_f64() {
            game_differ += 1;
        }
        let (sx, sy) = (snap_coord(*x), snap_coord(*y));
        if with_cliff.eval(sx, sy) != without_cliff.eval(sx, sy) {
            ours_differ += 1;
        }
    }
    // Frozen both ways. "All 26 differ" is false - the outer `min` against
    // `starting_lake` masks the term near spawn - and "some differ" would pass
    // for a port that read the flag and got the term wrong.
    assert_eq!(
        game_differ, 17,
        "positions where the GAME's two columns differ"
    );
    assert_eq!(ours_differ, 17, "positions where our two trees differ");
}
