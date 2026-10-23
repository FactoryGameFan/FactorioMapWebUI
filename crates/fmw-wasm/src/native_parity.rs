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

// ---------------------------------------------------------------------------
// Aquilo
// ---------------------------------------------------------------------------

use super::{aquilo_field_count, aquilo_fold};

const AQUILO_SPEC: &str = include_str!("../../../test/wasmAquiloParity.spec.ts");
const AQUILO_FIXTURE: &str = include_str!("../../../test/fixtures/wasm-request.v2.json");

// Inputs mirror test/wasmAquiloParity.spec.ts: the derived Aquilo surface seed
// for map seed 123456, and the same window as Fulgora's.
const AQUILO_SEED0: u32 = 3_111_923_328;

/// `[(label, [crude f, crude s, lithium f, lithium s, fluorine f, fluorine s])]`.
/// The moved levers are the read-back `moved` controls of
/// `test/fixtures/oracle-aquilo-entity-fields.seed123456.json`.
const AQUILO_DEFAULT: [f64; 6] = [1.0; 6];
const AQUILO_MOVED: [f64; 6] = [1.5, 0.5, 0.5, 2.0, 2.0, 0.166_666_671_633_720_4];

/// `(label, levers, window)` with the window as `(x0, y0, step)`, all 26x26.
/// The first two are the original window; the others are named in the spec.
type AquiloCase = (&'static str, [f64; 6], (f64, f64, f64));
const AQUILO_CASES: [AquiloCase; 8] = [
    ("default sliders", AQUILO_DEFAULT, (X0, Y0, STEP)),
    ("moved sliders", AQUILO_MOVED, (X0, Y0, STEP)),
    (
        "default sliders, spawn window",
        AQUILO_DEFAULT,
        SPAWN_WINDOW,
    ),
    ("moved sliders, spawn window", AQUILO_MOVED, SPAWN_WINDOW),
    ("default sliders, ring window", AQUILO_DEFAULT, RING_WINDOW),
    ("moved sliders, ring window", AQUILO_MOVED, RING_WINDOW),
    ("default sliders, vent window", AQUILO_DEFAULT, VENT_WINDOW),
    ("moved sliders, vent window", AQUILO_MOVED, VENT_WINDOW),
];
const SPAWN_WINDOW: (f64, f64, f64) = (-156.0, -156.0, 12.0);
const VENT_WINDOW: (f64, f64, f64) = (-110.0, -150.0, 3.0);
const RING_WINDOW: (f64, f64, f64) = (100.0, 100.0, 16.0);

/// The request bytes for one case: the fixture's header and bearing trig (they
/// belong to this seed), with the window, levers and sweep box written the way
/// `encodeRenderRequest` writes them. The box defaults to the window itself.
fn aquilo_case_bytes(levers: [f64; 6], (x0, y0, step): (f64, f64, f64)) -> Vec<u8> {
    let mut bytes = aquilo_fixture_bytes();
    assert_eq!(&bytes[16..20], &AQUILO_SEED0.to_le_bytes());
    let put = |bytes: &mut [u8], at: usize, v: f64| {
        bytes[at..at + 8].copy_from_slice(&v.to_le_bytes());
    };
    bytes[20..24].copy_from_slice(&N.to_le_bytes());
    bytes[24..28].copy_from_slice(&N.to_le_bytes());
    put(&mut bytes, 32, x0);
    put(&mut bytes, 40, y0);
    put(&mut bytes, 48, step);
    for (i, v) in levers.into_iter().enumerate() {
        put(&mut bytes, 56 + i * 8, v);
    }
    let extent = f64::from(N) * step;
    for (i, v) in [x0, y0, x0 + extent, y0 + extent].into_iter().enumerate() {
        put(&mut bytes, 56 + 96 + i * 8, v);
    }
    bytes
}

/// The names in the Aquilo spec's `const FIELD_NAMES = [ ... ];`, in order.
fn aquilo_field_names() -> Vec<&'static str> {
    let start = AQUILO_SPEC
        .find("const FIELD_NAMES = [")
        .expect("FIELD_NAMES block");
    let body = &AQUILO_SPEC[start..];
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

/// The frozen value under `"aquilo"` for the key `"<label> | <name>"`.
fn aquilo_frozen(label: &str, name: &str) -> u64 {
    let start = TABLE.find("\"aquilo\": {").expect("aquilo section") + 1;
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

/// The committed `aquilo` arm's request bytes: header, levers, the bearing
/// trig V8 computed for this seed, and the sweep box.
fn aquilo_fixture_bytes() -> Vec<u8> {
    let list = AQUILO_FIXTURE
        .split("\"aquilo\": {")
        .nth(1)
        .and_then(|a| a.split("\"bytes\": [").nth(1))
        .and_then(|t| t.split(']').next())
        .expect("the fixture has an aquilo arm with bytes");
    list.split(',')
        .map(|t| t.trim().parse().expect("a byte"))
        .collect()
}

#[test]
fn native_aquilo_folds_match_the_frozen_wasm_folds() {
    let fields = aquilo_field_count();
    let names = aquilo_field_names();
    assert_eq!(fields, 28);
    assert_eq!(names.len(), fields as usize, "scanned FIELD_NAMES count");

    for (label, levers, window) in AQUILO_CASES {
        let bytes = aquilo_case_bytes(levers, window);
        for (field, name) in (0..fields).zip(&names) {
            assert_eq!(
                aquilo_fold(&bytes, field),
                aquilo_frozen(label, name),
                "{label} | {name} (field {field}): native fold differs from frozen"
            );
        }
    }
}

/// An index past the end folds 0, like a request the module rejects; the last
/// real index on the same request folds non-zero (the control).
#[test]
fn an_aquilo_field_index_past_the_end_folds_zero() {
    let (_, levers, window) = AQUILO_CASES[0];
    let bytes = aquilo_case_bytes(levers, window);
    let count = aquilo_field_count();
    assert_ne!(aquilo_fold(&bytes, count - 1), 0);
    assert_eq!(aquilo_fold(&bytes, count), 0);
    assert_eq!(aquilo_fold(&bytes, u32::MAX), 0);
}

/// No NaN in any sample (WASM permits any NaN payload). Also prints how many
/// distinct values each field takes, and asserts that across all cases every
/// field takes more than one in at least one.
#[test]
fn no_aquilo_tier_two_field_is_nan_and_none_is_constant_everywhere() {
    use fmw_noise::expressions::aquilo_stack::AquiloParity;
    let names = aquilo_field_names();
    let mut varies = vec![false; names.len()];
    for (label, levers, (x0, y0, step)) in AQUILO_CASES {
        let bytes = aquilo_case_bytes(levers, (x0, y0, step));
        let req = super::abi::decode(&bytes).expect("decodes");
        let super::abi::Params::Aquilo(p) = req.params else {
            panic!("aquilo block")
        };
        let mut stack = super::render::aquilo_stack(req.seed0, &p);
        let mut parity = AquiloParity::new(&mut stack);
        for (field, name) in (0..AquiloParity::FIELD_COUNT).zip(&names) {
            let mut distinct = std::collections::BTreeSet::new();
            for py in 0..N {
                for px in 0..N {
                    let x = x0 + f64::from(px) * step;
                    let y = y0 + f64::from(py) * step;
                    let v = parity.field(field, x, y);
                    assert!(!v.is_nan(), "{label} | {name} is NaN at ({x}, {y})");
                    distinct.insert(v.to_bits());
                }
            }
            eprintln!("DISTINCT {label} | {name}: {}", distinct.len());
            varies[field as usize] |= distinct.len() > 1;
        }
    }
    for (name, v) in names.iter().zip(varies) {
        assert!(v, "{name} folds a constant in every case");
    }
}
