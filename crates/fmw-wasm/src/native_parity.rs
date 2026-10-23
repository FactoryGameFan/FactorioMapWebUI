//! Native against WASM, for the point path of Fulgora's tier-2 folds.
//!
//! `test/fixtures/tier2-checksums.json` holds folds recorded from the WASM
//! build, and `test/wasmFulgoraParity.spec.ts` checks the WASM module against
//! them. This test recomputes the same folds natively and checks them against
//! the same table, so native == frozen and WASM == frozen together give
//! native == WASM. That is how a libm call that differs between the two hosts
//! gets caught.
//!
//! The comparison is on SORTED lists: the table is keyed by field name, and
//! this crate knows fields only by index, so a sorted list per case avoids a
//! second copy of the name list. `checksum_fulgora` reads no scratch buffer,
//! so these tests take no `BUFFERS` lock.

use super::{checksum_fulgora, fulgora_field_count};

const TABLE: &str = include_str!("../../../test/fixtures/tier2-checksums.json");

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

/// Every frozen value under `"fulgora"` whose key starts with `"<label> | "`.
fn frozen(label: &str) -> Vec<u64> {
    let start = TABLE.find("\"fulgora\": {").expect("fulgora section") + 1;
    let section = &TABLE[start..];
    let section = &section[..section.find('}').expect("section end")];
    let prefix = format!("\"{label} | ");
    let mut out = Vec::new();
    for line in section.lines() {
        let line = line.trim();
        if !line.starts_with(&prefix) {
            continue;
        }
        let hex = line
            .split("\"0x")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("hex value");
        out.push(u64::from_str_radix(hex, 16).expect("hex parses"));
    }
    out.sort_unstable();
    out
}

#[test]
fn native_fulgora_folds_match_the_frozen_wasm_folds() {
    // The trig values V8 hands the module, as bits.
    let sin_start = f64::from_bits(0xbfd8_03dd_1d12_3eec);
    let cos_start = f64::from_bits(0x3fed_a967_ce0f_c3d1);
    let sin_vault = f64::from_bits(0x3fd8_03dd_1d13_8d52);
    let cos_vault = f64::from_bits(0xbfed_a967_ce0f_8021);
    let fields = fulgora_field_count();
    assert_eq!(fields, 76);
    for (label, frequency, size) in CASES {
        let mut native: Vec<u64> = (0..fields)
            .map(|field| {
                checksum_fulgora(
                    SEED0, frequency, size, sin_start, cos_start, sin_vault, cos_vault, field, X0,
                    Y0, STEP, N,
                )
            })
            .collect();
        native.sort_unstable();
        let frozen = frozen(label);
        assert_eq!(frozen.len(), 76, "{label}: frozen rows");
        assert_eq!(native, frozen, "{label}: native folds differ from frozen");
    }
}
