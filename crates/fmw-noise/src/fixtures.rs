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
