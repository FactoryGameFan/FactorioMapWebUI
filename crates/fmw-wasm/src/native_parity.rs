//! Native against WASM, for the point path of Fulgora's tier-2 folds.
//!
//! `test/fixtures/tier2-checksums.json` holds folds recorded from the WASM
//! build, and `test/wasmFulgoraParity.spec.ts` checks the WASM module against
//! them. This test recomputes the same folds natively and checks them against
//! the same table, so native == frozen and WASM == frozen together give
//! native == WASM. That is how a libm call that differs between the two hosts
//! gets caught.
//!
//! The comparison is PER FIELD: native fold for field index `i` must equal
//! the frozen value under `"<case label> | <FIELD_NAMES[i]>"`. The names are
//! scanned out of the spec's own `const FIELD_NAMES = [ ... ];` block with
//! `include_str!`, so the index-to-name mapping cannot drift from the one the
//! WASM spec uses. A sorted-list comparison was tried first and rejected: it
//! passes when two fields swap values. `checksum_fulgora` reads no scratch
//! buffer, so these tests take no `BUFFERS` lock.

use super::{checksum_fulgora, fulgora_field_count};

const TABLE: &str = include_str!("../../../test/fixtures/tier2-checksums.json");
const SPEC: &str = include_str!("../../../test/wasmFulgoraParity.spec.ts");

// Inputs mirror test/wasmFulgoraParity.spec.ts.
const SEED0: u32 = 2_967_702_466;
const X0: f64 = -613.5;
const Y0: f64 = 428.25;
const STEP: f64 = 7.3;
const N: u32 = 26;

/// `[(label, islands_frequency, islands_size)]`, as in the spec's `CASES`.
const CASES: [(&str, f64, f64); 2] = [
    ("default sliders", 1.0, 1.0),
    ("frequency 2, size 3", 2.0, 3.0),
];

/// The names in the spec's `const FIELD_NAMES = [ ... ];`, in order. Strict:
/// every line in the block must be a bare `"name",` or the scan panics.
fn field_names() -> Vec<&'static str> {
    let start = SPEC
        .find("const FIELD_NAMES = [")
        .expect("FIELD_NAMES block");
    let body = &SPEC[start..];
    let body = &body[body.find('\n').expect("line end") + 1..];
    let body = &body[..body.find("\n];").expect("block end")];
    body.lines()
        .map(|line| {
            line.trim()
                .strip_prefix('"')
                .and_then(|l| l.strip_suffix("\","))
                .unwrap_or_else(|| panic!("unexpected FIELD_NAMES line: {line:?}"))
        })
        .collect()
}

/// The frozen value under `"fulgora"` for the key `"<label> | <name>"`.
fn frozen(label: &str, name: &str) -> u64 {
    let start = TABLE.find("\"fulgora\": {").expect("fulgora section") + 1;
    let section = &TABLE[start..];
    let section = &section[..section.find('}').expect("section end")];
    let prefix = format!("\"{label} | {name}\": ");
    let mut found = section.lines().filter_map(|line| {
        let rest = line.trim().strip_prefix(prefix.as_str())?;
        let hex = rest.strip_prefix("\"0x")?.split('"').next()?;
        Some(u64::from_str_radix(hex, 16).expect("hex parses"))
    });
    let value = found
        .next()
        .unwrap_or_else(|| panic!("no frozen row for {label} | {name}"));
    assert!(
        found.next().is_none(),
        "duplicate frozen row {label} | {name}"
    );
    value
}

#[test]
fn native_fulgora_folds_match_the_frozen_wasm_folds() {
    // The trig values V8 hands the module, as bits.
    let sin_start = f64::from_bits(0xbfd8_03dd_1d12_3eec);
    let cos_start = f64::from_bits(0x3fed_a967_ce0f_c3d1);
    let sin_vault = f64::from_bits(0x3fd8_03dd_1d13_8d52);
    let cos_vault = f64::from_bits(0xbfed_a967_ce0f_8021);
    let fields = fulgora_field_count();
    let names = field_names();
    assert_eq!(fields, 76);
    assert_eq!(names.len(), fields as usize, "scanned FIELD_NAMES count");
    for (label, frequency, size) in CASES {
        for (field, name) in (0..fields).zip(&names) {
            let native = checksum_fulgora(
                SEED0, frequency, size, sin_start, cos_start, sin_vault, cos_vault, field, X0, Y0,
                STEP, N,
            );
            assert_eq!(
                native,
                frozen(label, name),
                "{label} | {name} (field {field}): native fold differs from frozen"
            );
        }
    }
}
