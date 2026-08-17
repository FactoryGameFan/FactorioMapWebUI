# Rust port, phase 0: the probe and the empty gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer whether the `wasm32` build is byte-reproducible across machines
(#218), then land the whole Rust workspace and its CI gate with almost nothing in
it, proven green on `main` before any real port code depends on it (#219).

**Architecture:** Two crates in a Cargo workspace at the repository root.
`fmw-noise` is the engine library and `fmw-wasm` is a `cdylib` holding only the
boundary. The built `.wasm` is committed at `src/noise/wasm/engine.wasm` and a
CI step rebuilds it and compares bytes, so `vp build` gains no non-JS step. A new
`rust` CI job is asserted by the existing `verify` aggregator job, so no
repository ruleset change is needed.

**Tech Stack:** Rust 1.97.1 (pinned), `wasm32-unknown-unknown`, `cargo-deny`
0.20.2, GitHub Actions, pnpm scripts, vite-plus test.

**Spec:** `docs/superpowers/specs/2026-08-16-rust-wasm-noise-engine-design.md`,
sections 4, 5, 8.2, 8.3, 9 and 11.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied
verbatim from the spec.

- **Toolchain pinned to `1.97.1`** in `rust-toolchain.toml`, with target
  `wasm32-unknown-unknown` and components `rustfmt`, `clippy`. The local machine
  runs `rustc 1.97.1 (8bab26f4f 2026-07-14)` and the `ubuntu-24.04` runner image
  ships `Cargo 1.97.1` and `Rustup 1.29.0`, so the versions match.

  **That does not mean nothing is downloaded, and an earlier draft of this plan
  said it did.** Measured: rustup treats `1.97.1-<host>` and `stable-<host>` as
  two separate toolchain installs even when they are the same compiler version,
  so the first cargo command after this file lands prints `syncing channel
  updates for 1.97.1-aarch64-apple-darwin` and `downloading 6 components`. That
  is a one-time cost per machine and per runner, it is the price of the pin, and
  it is worth paying - but expect it rather than reading it as a broken config.
- **`Cargo.lock` is committed. Every cargo build and test passes `--locked`.**

  **`--locked` FAILS when no lockfile exists yet**, with `cannot create the lock
  file ... because --locked was passed`. So the very first command in a new
  workspace is `cargo generate-lockfile`, and `--locked` applies from then on.
  This bit the first draft of Task 2.
- **No `mul_add`, no fast-math, no float contraction.** Rust does not contract
  `x * y + z` by default; this rule is about keeping it that way.
- **`clippy::suboptimal_flops` is explicitly allowed with a comment.** That lint
  recommends `a.mul_add(b, c)`, which is the contraction that would break
  bit-exactness. It sits in `nursery`, so it is off today; the `allow` exists so
  that turning `nursery` on later cannot silently push the port toward FMA.
- **No `-C target-cpu=native`.** It makes codegen machine-specific.
- **`simd128` off, `relaxed_simd` off.** SIMD measured at 1.27x on a
  gather-bound kernel, and enabling it changes the binary and therefore the
  byte-identity gate.
- **Zero dependencies in `fmw-noise` and `fmw-wasm`.** Asserted in CI.
  Dev-dependencies are allowed and none are added in this plan.
- **No `HashMap` iteration order reaching output.**
- **Branch before committing. Never push to `main`.** `main` is protected by
  ruleset `EJ` with no bypass actors.
- **Run JavaScript commands through pnpm** (`pnpm vp test`, `pnpm run verify`).
  `npx vp` fails with `EBADDEVENGINES`.
- **Prose style:** hyphens, never em or en dashes. 12th grade reading level or
  below. A comment says how a thing was measured, not only what it does.

---

### Task 1: Measure wasm32 byte-reproducibility across machines (#218)

A spike. Its output is an answer written into #218, and everything it builds is
thrown away. It must finish before Task 6, because the answer decides what the
CI wasm step asserts.

**Files:**
- Create (throwaway, never merged): `crates-probe/Cargo.toml`,
  `crates-probe/src/lib.rs`, `.github/workflows/wasm-repro.yml`
- Branch: `probe/wasm-reproducibility`, deleted at the end

**Interfaces:**
- Consumes: nothing.
- Produces: a yes/no answer recorded as a comment on #218. Task 6 reads it.

- [ ] **Step 1: Branch**

```bash
cd /Users/ericjohnson/GitHub/FactorioMapWebUI
git checkout main && git pull --ff-only
git checkout -b probe/wasm-reproducibility
```

- [ ] **Step 2: Create the probe crate**

The profile settings are the ones the real `fmw-wasm` will use, because a
reproducibility answer for different settings would not transfer.

Create `crates-probe/Cargo.toml`:

```toml
[package]
name = "wasm-repro-probe"
version = "0.0.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

Create `crates-probe/src/lib.rs`:

```rust
//! Throwaway probe for issue #218. Exists only so two machines compile the
//! same non-trivial code with the same profile and we can compare the bytes.
//! Deliberately not the real kernel: the question is about the toolchain, not
//! about noise.

#[unsafe(no_mangle)]
pub extern "C" fn fold(seed: u64, n: u32) -> u64 {
    let mut h = seed;
    for i in 0..n {
        h ^= u64::from(i);
        h = h.wrapping_mul(0x0100_0000_01b3);
        h ^= h >> 33;
    }
    h
}
```

- [ ] **Step 3: Prove the build is reproducible on THIS machine first**

A cross-machine comparison is meaningless if a single machine cannot reproduce
its own output. Check that before anything else.

```bash
cd crates-probe
cargo generate-lockfile        # --locked fails with no lockfile; see Global Constraints
cargo build --locked --release --target wasm32-unknown-unknown
shasum -a 256 target/wasm32-unknown-unknown/release/wasm_repro_probe.wasm
rm -rf target
cargo build --locked --release --target wasm32-unknown-unknown
shasum -a 256 target/wasm32-unknown-unknown/release/wasm_repro_probe.wasm
cd ..
```

Commit `crates-probe/Cargo.lock` along with the rest in Step 5, so the runner
builds from the same lockfile rather than resolving its own.

Expected: the two hashes are identical. If they are NOT, stop and record that in
#218 - the whole byte-identity gate is off the table and Task 6 uses the
fallback, and no cross-machine run is needed.

Write both hashes down. You will need the first one in Step 6.

- [ ] **Step 4: Add the throwaway workflow**

Create `.github/workflows/wasm-repro.yml`:

```yaml
# THROWAWAY. Issue #218 only. This file must never reach `main`.
#
# The question: does the pinned toolchain produce a byte-identical
# wasm32-unknown-unknown module on an ubuntu runner and on a macOS dev machine?
# The answer decides whether the `rust` job can assert byte identity for the
# committed engine.wasm, or has to fall back to rebuild-and-run-the-tests.
name: wasm-repro

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  hash:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Toolchain
        run: |
          rustup toolchain install 1.97.1 --profile minimal
          rustup target add wasm32-unknown-unknown --toolchain 1.97.1
          rustup run 1.97.1 rustc --version --verbose
      - name: Build and hash
        working-directory: crates-probe
        run: |
          rustup run 1.97.1 cargo build --locked --release \
            --target wasm32-unknown-unknown
          F=target/wasm32-unknown-unknown/release/wasm_repro_probe.wasm
          echo "bytes: $(wc -c < "$F")"
          shasum -a 256 "$F"
```

- [ ] **Step 5: Push and run it**

```bash
git add crates-probe .github/workflows/wasm-repro.yml
git commit -m "probe: wasm32 byte-reproducibility across machines (#218)"
git push -u origin probe/wasm-reproducibility
gh workflow run wasm-repro.yml --ref probe/wasm-reproducibility
sleep 45
gh run list --workflow=wasm-repro.yml --limit 1
```

- [ ] **Step 6: Read the runner's hash and compare**

```bash
gh run view --log --job="$(gh run list --workflow=wasm-repro.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')" | grep -E "bytes:|[0-9a-f]{64}"
```

Compare against the hash from Step 3.

- [ ] **Step 7: Record the answer on #218 and close it**

Write the comment with both hashes, both byte counts, and the `rustc --version
--verbose` output from the runner, so a future reader can tell whether a later
disagreement is a toolchain change or a real regression.

```bash
gh issue comment 218 --repo wormeyman/FactorioMapWebUI --body "..."
gh issue close 218 --repo wormeyman/FactorioMapWebUI --reason completed
```

State the consequence explicitly in the comment, in one of these two forms:

- **Identical:** "Task 6 asserts byte identity with `cmp`."
- **Different:** "Task 6 falls back to rebuilding and running the fixture tests
  against the freshly built module. Byte identity is off the table, and the
  reason is <the observed difference>."

- [ ] **Step 8: Delete the probe entirely**

```bash
git checkout main
git push origin --delete probe/wasm-reproducibility
git branch -D probe/wasm-reproducibility
```

Nothing from this task is merged. Confirm with `git log --oneline -1`, which
must still be the spec commit `d134166` or later, and `ls crates-probe`, which
must fail.

---

### Task 2: Workspace, `fmw-noise`, and its first real test

The spec calls phase 0c "empty". This lands one genuinely useful function rather
than a placeholder: `fnv1a64`, the tier-2 parity primitive every later phase
needs. It is about ten lines, it has published test vectors so the test is not
self-referential, and it means the gate is exercising real code from the start.

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `crates/fmw-noise/Cargo.toml`,
  `crates/fmw-noise/src/lib.rs`, `crates/fmw-noise/src/checksum.rs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `fmw_noise::checksum::fnv1a64(bytes: &[u8]) -> u64` and
  `fmw_noise::checksum::fold_f64(acc: u64, value: f64) -> u64`. Task 3 exports
  both across the WASM boundary; Task 5 and Task 7 assert on them.

- [ ] **Step 1: Branch**

```bash
cd /Users/ericjohnson/GitHub/FactorioMapWebUI
git checkout main && git pull --ff-only
git checkout -b feat/rust-workspace-and-gate
```

- [ ] **Step 2: Write the failing test**

Create `crates/fmw-noise/src/checksum.rs` containing ONLY the test module for
now, so the first run fails to compile for the right reason:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Published FNV-1a 64-bit vectors. Ground truth from the reference
    /// implementation, not from this port - a test that checks a function
    /// against itself proves nothing. Re-derived independently in Python
    /// before being written down here.
    #[test]
    fn matches_the_published_fnv1a64_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    /// The whole reason FNV-1a replaces the spike's XOR fold: XOR is blind to
    /// order, so swapping two values leaves it unchanged. This test is what
    /// makes that property load-bearing rather than a claim in a comment.
    #[test]
    fn the_fold_is_order_sensitive() {
        let a = fold_f64(fold_f64(0, 1.5), 2.5);
        let b = fold_f64(fold_f64(0, 2.5), 1.5);
        assert_ne!(a, b, "fold must depend on order; an XOR fold would not");
    }

    /// A fold that ignored the value entirely would pass the test above.
    #[test]
    fn the_fold_depends_on_the_value() {
        assert_ne!(fold_f64(0, 1.5), fold_f64(0, 1.5000000000000002));
    }
}
```

- [ ] **Step 3: Create the workspace and crate manifests**

Create `rust-toolchain.toml`:

```toml
# The counterpart to .node-version. A compiler change is a codegen change, and
# codegen determines the bytes of the committed engine.wasm, so this pin is a
# correctness control rather than a convenience.
#
# 1.97.1 is what this machine runs and what the ubuntu-24.04 runner image ships
# (Cargo 1.97.1, Rustup 1.29.0), so neither side downloads a toolchain today.
[toolchain]
channel = "1.97.1"
components = ["rustfmt", "clippy"]
targets = ["wasm32-unknown-unknown"]
profile = "minimal"
```

Create `Cargo.toml` at the repository root:

```toml
[workspace]
resolver = "2"
members = ["crates/fmw-noise", "crates/fmw-wasm"]

# Shared by both crates. `panic = "abort"` is not a size trick alone: an
# unwind across the WASM boundary has no defined meaning, and expected errors
# are returned as status codes rather than raised (see spec section 6.5).
[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

Create `crates/fmw-noise/Cargo.toml`:

```toml
[package]
name = "fmw-noise"
version = "0.0.0"
edition = "2021"
publish = false

# NO dependencies, and CI asserts it (scripts/verify-rust.sh). A noise kernel
# needs none, and keeping it that way sidesteps the cargo supply-chain question
# for everything that ships rather than managing it.
[dependencies]
```

Create `crates/fmw-noise/src/lib.rs`:

```rust
//! The reverse-engineered Factorio map generator, ported from `src/noise/`.
//!
//! Correctness here means agreement with the game at f32, graded against the
//! oracle fixtures under `test/fixtures/`. See
//! `docs/superpowers/specs/2026-08-16-rust-wasm-noise-engine-design.md`.

// clippy::suboptimal_flops recommends `a.mul_add(b, c)` for `a * b + c`. That
// is a FUSED multiply-add, which rounds once instead of twice and so changes
// results - the exact hazard that made Rust the choice over Go, whose spec
// permits the same fusion. The lint lives in `nursery`, so it is off today.
// This allow exists so that turning `nursery` on later cannot silently push
// the port toward FMA.
#![allow(clippy::suboptimal_flops)]

pub mod checksum;
```

- [ ] **Step 4: Run the test and watch it fail for the right reason**

```bash
cargo generate-lockfile        # first, or --locked errors before it compiles anything
cargo test --locked -p fmw-noise
```

Expected: FAILS to compile, with `cannot find function 'fnv1a64' in this scope`
and the same for `fold_f64`. If it fails with anything else - a manifest error,
a missing target, or `cannot create the lock file` - fix that first. A test that
fails for the wrong reason has not been shown to discriminate.

The first cargo command here also triggers the one-time
`downloading 6 components` for the pinned toolchain. That is expected.

- [ ] **Step 5: Write the minimal implementation**

Prepend to `crates/fmw-noise/src/checksum.rs`, above the `mod tests` block:

```rust
//! FNV-1a 64, the parity checksum for the port's tier-2 cross-check.
//!
//! Why not the XOR fold the 2026-08-16 spikes used: that fold proved four
//! implementations across three languages agreed on 1,000,000 points, and it
//! caught a real sentinel bug in the Go arm. But XOR is blind to order and
//! cancels pairs - swap two points, or break two points identically, and the
//! value does not move. FNV-1a is order-sensitive, which is what
//! `the_fold_is_order_sensitive` pins.

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64 over a byte slice.
#[must_use]
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Fold one `f64` result into a running checksum, by its RAW BITS.
///
/// Raw bits rather than the value: two results that differ in the last bit are
/// the thing this exists to catch, and any comparison that goes through a
/// tolerance cannot see them. Start an accumulator at 0 and fold in evaluation
/// order.
#[must_use]
pub fn fold_f64(acc: u64, value: f64) -> u64 {
    let mut hash = if acc == 0 { FNV_OFFSET_BASIS } else { acc };
    for &byte in &value.to_bits().to_le_bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
cargo test --locked -p fmw-noise
```

Expected: `test result: ok. 3 passed; 0 failed`.

- [ ] **Step 7: Ignore build output**

Add to `.gitignore`, after the `dist/` lines:

```
# Rust build output. The one artifact that IS committed is
# src/noise/wasm/engine.wasm, written by scripts/build-wasm.sh.
target/
```

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock rust-toolchain.toml crates/fmw-noise .gitignore
git commit -m "feat(rust): workspace, fmw-noise, and the FNV-1a parity checksum (#219)"
```

---

### Task 3: The `fmw-wasm` boundary crate and the committed module

**Files:**
- Create: `crates/fmw-wasm/Cargo.toml`, `crates/fmw-wasm/src/lib.rs`,
  `scripts/build-wasm.sh`, `src/noise/wasm/engine.wasm`

**Interfaces:**
- Consumes: `fmw_noise::checksum::{fnv1a64, fold_f64}` from Task 2.
- Produces: a `.wasm` exporting `memory`, `scratch_ptr() -> u32`,
  `scratch_len() -> u32`, `fnv1a64(len: u32) -> u64` and
  `fold_f64(acc: u64, value: f64) -> u64`. Task 5's TypeScript spec calls all
  five.

**A boundary fact that will cost an afternoon if it is not written down.**
Measured against the real module in Node: **a WASM `u64` return arrives in
JavaScript as a SIGNED BigInt.** `fnv1a64("")` should be
`0xcbf29ce484222325n`, and JavaScript receives `-0x340d631b7bdddcdbn`, its
two's complement. Every `u64` crossing this boundary needs
`BigInt.asUintN(64, x)` on the JavaScript side. It is not a bug on either side
and no error is raised; the number is simply wrong in a way that looks like a
broken checksum. This applies to every later phase's checksum export too, so it
belongs in the spec's section 6 as a follow-up commit.

- [ ] **Step 1: Create the crate**

Create `crates/fmw-wasm/Cargo.toml`:

```toml
[package]
name = "fmw-wasm"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib"]

# One path dependency and no others, and deliberately no wasm-bindgen. The
# 2026-08-16 spike hit 1,518 bytes without it, and the boundary is one call per
# render sweep, so there is no glue worth generating. CI asserts that
# `cargo tree --edges normal` over the workspace lists ONLY these two crates.
[dependencies]
fmw-noise = { path = "../fmw-noise" }
```

Create `crates/fmw-wasm/src/lib.rs`. **This code was compiled and run before
being written here** - `cargo fmt --check`, `cargo clippy -D warnings` and
`cargo test` all pass, the module builds to **599 bytes**, and its exports were
called from Node against the FNV-1a vectors.

```rust
//! The WASM boundary, and nothing else. No logic lives here.
//!
//! Phase 0c exports only the parity checksum, which is enough to prove the
//! whole loading path works - compile the module, instantiate it, write into
//! linear memory, read a result back - before any noise math depends on it.

use fmw_noise::checksum;

/// A fixed scratch region the caller writes into.
///
/// No allocator, and no `#![no_std]`. An earlier draft used both, and both were
/// wrong. `#![no_std]` in this crate while `fmw-noise` links `std` produces
/// `error[E0152]: found duplicate lang item 'panic_impl'`, and the spike that
/// measured 1,518 bytes used plain `std` anyway - so `no_std` was buying
/// nothing and costing a build. An allocator would exist only to hand back
/// memory nothing ever frees, because the module's lifecycle is "instantiate
/// once per worker, fill a buffer per call". Phase 3 replaces this with an
/// explicitly reused render buffer of the same shape.
const SCRATCH_BYTES: usize = 1 << 16;
static mut SCRATCH: [u8; SCRATCH_BYTES] = [0; SCRATCH_BYTES];

/// Offset of the scratch region in linear memory.
#[unsafe(no_mangle)]
pub extern "C" fn scratch_ptr() -> u32 {
    core::ptr::addr_of!(SCRATCH) as u32
}

/// Capacity of the scratch region, in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn scratch_len() -> u32 {
    SCRATCH_BYTES as u32
}

/// FNV-1a 64 over the first `len` bytes of the scratch region.
///
/// Returns a `u64`, which JavaScript receives as a SIGNED BigInt. Callers must
/// apply `BigInt.asUintN(64, x)`. See the Interfaces note above.
#[unsafe(no_mangle)]
pub extern "C" fn fnv1a64(len: u32) -> u64 {
    let bytes = unsafe {
        core::slice::from_raw_parts(core::ptr::addr_of!(SCRATCH).cast::<u8>(), len as usize)
    };
    checksum::fnv1a64(bytes)
}

/// Fold one f64 into a running checksum, by raw bits.
#[unsafe(no_mangle)]
pub extern "C" fn fold_f64(acc: u64, value: f64) -> u64 {
    checksum::fold_f64(acc, value)
}
```

`core::ptr::addr_of!` rather than a plain reference to the `static mut` is what
keeps the `static_mut_refs` lint quiet under `-D warnings`. Verified, not
assumed.

- [ ] **Step 2: Write the build script**

Create `scripts/build-wasm.sh`:

```bash
#!/usr/bin/env bash
# Rebuild the committed WASM module.
#
# Deliberately NOT part of `vp build` or `pnpm run verify`. The module is a
# committed artifact and this script is the thing that produces it; the gate
# (scripts/verify-rust.sh) checks the output rather than regenerating it. That
# is what keeps `vp build` free of any non-JS step and lets `deploy:app` run on
# a machine with no Rust toolchain installed.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --locked --release --target wasm32-unknown-unknown -p fmw-wasm

mkdir -p src/noise/wasm
cp target/wasm32-unknown-unknown/release/fmw_wasm.wasm src/noise/wasm/engine.wasm

echo "bytes: $(wc -c < src/noise/wasm/engine.wasm)"
shasum -a 256 src/noise/wasm/engine.wasm
```

- [ ] **Step 3: Build it and record the size**

```bash
chmod +x scripts/build-wasm.sh
./scripts/build-wasm.sh
```

Expected: **599 bytes**, measured on 2026-08-16 with this exact source and
profile. A number well above that means something unintended got linked in.

Write the byte count and hash into the commit message. The size trend across
phases is what answers open question 2 in the spec ("how large is the full
module?"), and it can only be tracked if every phase records its own figure.

- [ ] **Step 4: Commit**

```bash
git add crates/fmw-wasm scripts/build-wasm.sh src/noise/wasm/engine.wasm
git commit -m "feat(rust): fmw-wasm boundary crate and the committed module (#219)"
```

---

### Task 4: Determinism and supply-chain configuration

**Files:**
- Create: `.cargo/config.toml`, `deny.toml`

**Interfaces:**
- Consumes: the workspace from Task 2.
- Produces: config only. Task 5 runs `cargo deny check` against `deny.toml`.

- [ ] **Step 1: Pin the build flags**

Create `.cargo/config.toml`:

```toml
# Deliberately minimal. Everything absent here is absent on purpose.
#
# NO `-C target-cpu=native`: it makes codegen machine-specific, which defeats
# the byte-identity check on the committed engine.wasm and could change
# vectorisation between two machines running the same source.
#
# NO `-C target-feature=+simd128`: measured at 1.27x on the basis kernel, which
# is gather-bound - three table lookups per corner, and WASM SIMD has no gather.
# It would not change results, because LLVM will not reassociate floats without
# fast-math, but it does change the binary and therefore the gate, for no
# measured gain.
#
# NO `+relaxed-simd` under any circumstances: its fused multiply-add is
# explicitly non-deterministic across engines, which is the one thing this port
# cannot tolerate.
[build]
# left empty on purpose; see above

[target.wasm32-unknown-unknown]
rustflags = []
```

- [ ] **Step 2: Configure cargo-deny**

Create `deny.toml`:

```toml
# cargo-deny, the stand-in for pnpm's `minimumReleaseAge: 1440`.
#
# Cargo has no stable equivalent: `-Zmin-publish-age` (rust-lang/cargo#15973)
# is unstable. So the policy is split. Nothing that SHIPS has a dependency at
# all, which scripts/verify-rust.sh asserts with `cargo tree --edges normal`,
# and that removes the question for every byte a user downloads. This file
# governs whatever dev-dependencies arrive later.

[advisories]
version = 2
yanked = "deny"

[bans]
multiple-versions = "warn"
wildcards = "deny"

[licenses]
version = 2
# The app is AGPL-3.0-or-later. These are the permissive licences that can be
# combined with it without further thought; anything else needs a decision
# recorded here rather than an entry added quietly.
allow = ["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unicode-3.0", "Zlib"]

[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
```

- [ ] **Step 3: Verify the config parses**

`cargo-deny` is not installed locally. Install it the same pinned way CI will,
so both sides run the same binary:

```bash
cargo install cargo-deny --locked --version 0.20.2
cargo deny check
```

Expected: `advisories ok`, `bans ok`, `licenses ok`, `sources ok`, with nothing
to check, because the workspace has no external dependencies.

- [ ] **Step 4: Commit**

```bash
git add .cargo/config.toml deny.toml
git commit -m "chore(rust): pin build flags and the cargo-deny policy (#219)"
```

---

### Task 5: The local gate - `verify:rust` and the WASM loading spec

**Files:**
- Create: `scripts/verify-rust.sh`, `test/wasmEngine.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the `.wasm` exports from Task 3, `deny.toml` from Task 4.
- Produces: a `verify:rust` pnpm script. Task 6's CI job runs the same phases.

- [ ] **Step 1: Write the failing TypeScript spec**

This is the miniature of the tier-2 harness: an ordinary spec that loads the
module and compares it against known values. Create `test/wasmEngine.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = join(import.meta.dirname, "..");
const wasmPath = join(repoRoot, "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  scratch_ptr: () => number;
  scratch_len: () => number;
  fnv1a64: (len: number) => bigint;
  fold_f64: (acc: bigint, value: number) => bigint;
}

async function instantiate(): Promise<EngineExports> {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as EngineExports;
}

/**
 * A WASM `u64` arrives in JavaScript as a SIGNED BigInt: 0xcbf29ce484222325
 * comes back as -0x340d631b7bdddcdb, its two's complement. Measured against
 * this exact module in Node. No error is raised - the number is just wrong in a
 * way that looks like a broken checksum, so every u64 crossing goes through
 * here.
 */
const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);

describe("the committed WASM engine", () => {
  it("agrees with the published FNV-1a 64 vectors", async () => {
    const engine = await instantiate();
    const ptr = engine.scratch_ptr();
    const hash = (s: string): bigint => {
      const bytes = new TextEncoder().encode(s);
      expect(bytes.length).toBeLessThanOrEqual(engine.scratch_len());
      new Uint8Array(engine.memory.buffer, ptr, bytes.length).set(bytes);
      return u64(engine.fnv1a64(bytes.length));
    };
    expect(hash("")).toBe(0xcbf29ce484222325n);
    expect(hash("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(hash("foobar")).toBe(0x85944171f73967e8n);
  });

  it("folds f64 results in an order-sensitive way", async () => {
    const engine = await instantiate();
    const a = u64(engine.fold_f64(u64(engine.fold_f64(0n, 1.5)), 2.5));
    const b = u64(engine.fold_f64(u64(engine.fold_f64(0n, 2.5)), 1.5));
    expect(a).not.toBe(b);
  });

  it("is small enough that the size trend stays worth watching", () => {
    // NOT a budget. A hard assertion at the measured size would be a number to
    // widen every phase, which is the habit this repo has been burned by. It is
    // a tripwire: phase 0c's module measures 599 bytes, so anything past 64 KB
    // before the noise math lands means something unintended got linked in.
    const bytes = readFileSync(wasmPath).byteLength;
    expect(bytes).toBeLessThan(64 * 1024);
  });
});
```

- [ ] **Step 2: Run it and watch it pass**

```bash
pnpm vp test test/wasmEngine.spec.ts
```

Expected: 3 passed. Task 3 already built the module, so this passes immediately.
That is fine - the discrimination check for this spec is Task 7, which breaks
the module on purpose and watches this file go red.

- [ ] **Step 3: Write the gate script**

Create `scripts/verify-rust.sh`:

```bash
#!/usr/bin/env bash
# The Rust half of `pnpm run verify`, and the same phases CI's `rust` job runs.
#
# Runs LAST in `verify`, after `vp test`: `verify` is already ~3m30s cold and a
# cold cargo build should not sit in front of the phases that fail fastest.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> cargo fmt --check"
cargo fmt --all --check

echo "==> cargo clippy"
cargo clippy --locked --all-targets --all-features -- -D warnings

echo "==> cargo test"
cargo test --locked --workspace

echo "==> zero dependencies in anything that ships"
# `--edges normal` excludes dev- and build-dependencies, so this is a statement
# about the artifact rather than about the toolchain. See spec section 4.2.
EXTERNAL=$(cargo tree --locked --workspace --edges normal --prefix none \
  | awk 'NF {print $1}' | sort -u | grep -vxE 'fmw-noise|fmw-wasm' || true)
if [ -n "$EXTERNAL" ]; then
  echo "ERROR: shipped crates gained dependencies:" >&2
  echo "$EXTERNAL" >&2
  exit 1
fi

echo "==> committed engine.wasm matches its source"
cargo build --locked --release --target wasm32-unknown-unknown -p fmw-wasm
if ! cmp -s target/wasm32-unknown-unknown/release/fmw_wasm.wasm \
             src/noise/wasm/engine.wasm; then
  echo "ERROR: src/noise/wasm/engine.wasm is stale." >&2
  echo "Rebuild it with ./scripts/build-wasm.sh and commit the result." >&2
  exit 1
fi

echo "==> cargo deny"
if command -v cargo-deny >/dev/null 2>&1; then
  cargo deny check
else
  echo "SKIP: cargo-deny not installed locally."
  echo "      Install with: cargo install cargo-deny --locked --version 0.20.2"
  echo "      CI always runs it, so this cannot be skipped on the way to main."
fi
```

Note on the wasm step: if Task 1 answered "not byte-reproducible", replace the
`cmp` block with a rebuild plus `pnpm vp test test/wasmEngine.spec.ts` against
the freshly built module, and say in the comment that byte identity was measured
and rejected, with the observed difference.

- [ ] **Step 4: Wire it into package.json**

In `package.json`, add the script and extend `verify`:

```json
    "verify:rust": "bash scripts/verify-rust.sh",
    "verify": "pnpm run verify:lint && vp run --cache test && pnpm run preview:test && pnpm run verify:rust",
```

- [ ] **Step 5: Run the whole gate**

```bash
chmod +x scripts/verify-rust.sh
pnpm run verify:rust
pnpm run verify
```

Expected: `verify:rust` prints all six phase headers and exits 0. The full
`verify` exits 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-rust.sh test/wasmEngine.spec.ts package.json
git commit -m "feat(rust): verify:rust gate and the WASM loading spec (#219)"
```

---

### Task 6: The `rust` CI job, asserted by the `verify` aggregator

**Files:**
- Modify: `.github/workflows/verify.yml`

**Interfaces:**
- Consumes: `verify:rust` from Task 5, the #218 answer from Task 1.
- Produces: a `rust` job whose failure turns the required `verify` check red.

- [ ] **Step 1: Add the job**

Insert after the `tests` job in `.github/workflows/verify.yml`:

```yaml
  # The Rust half of the gate. It is NOT a required status check of its own, and
  # that is the point: ruleset EJ matches required checks by NAME, so every name
  # added is a name that blocks every PR forever if it is ever renamed. The
  # `verify` job below already exists to aggregate, and asserting one more
  # `needs.*.result` there gets the same blocking behaviour with no ruleset PUT
  # and no two-step. See CLAUDE.md on the two-step for when a NEW name is
  # genuinely warranted.
  #
  # No toolchain action, pinned or otherwise. The ubuntu-24.04 image ships
  # Cargo 1.97.1 and Rustup 1.29.0, and rust-toolchain.toml pins 1.97.1, so
  # rustup resolves to the preinstalled toolchain and downloads nothing. If a
  # future pin moves off what the image ships, this step starts downloading and
  # gets slower - that is visible in the log, not silent.
  rust:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Show the resolved toolchain
        run: |
          rustup show
          cargo --version
          rustc --version --verbose

      # A pinned release binary rather than `cargo install`, which builds from
      # source and would dominate a job that is otherwise seconds. The checksum
      # is the release's own published .sha256 for this asset, so this is pinned
      # by content the same way the actions above are pinned by commit SHA.
      - name: Install cargo-deny 0.20.2
        run: |
          V=0.20.2
          F=cargo-deny-$V-x86_64-unknown-linux-musl.tar.gz
          curl -fsSLO "https://github.com/EmbarkStudios/cargo-deny/releases/download/$V/$F"
          echo "9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f  $F" \
            | sha256sum -c -
          tar -xzf "$F"
          sudo mv "cargo-deny-$V-x86_64-unknown-linux-musl/cargo-deny" /usr/local/bin/
          cargo deny --version

      # Names the package.json script, never the underlying commands, so there
      # stays exactly one definition of this phase and CI cannot drift from a
      # local run. Same rule as `verify:static` and `verify:shard` above.
      - run: bash scripts/verify-rust.sh
```

- [ ] **Step 2: Wire it into the aggregator**

Change the `verify` job in the same file:

```yaml
  verify:
    needs: [static, tests, rust]
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Assert every phase passed
        env:
          STATIC: ${{ needs.static.result }}
          TESTS: ${{ needs.tests.result }}
          RUST: ${{ needs.rust.result }}
        run: |
          echo "static=$STATIC tests=$TESTS rust=$RUST"
          # `tests` is the matrix aggregate: 'success' only if every shard was.
          [ "$STATIC" = "success" ] || { echo "::error::static phase: $STATIC"; exit 1; }
          [ "$TESTS" = "success" ] || { echo "::error::test shards: $TESTS"; exit 1; }
          [ "$RUST" = "success" ] || { echo "::error::rust phase: $RUST"; exit 1; }
```

The explicit `result` assertions are load-bearing and must not be simplified
away: a job whose dependency FAILED is *skipped*, and a skipped required check
does not block a merge.

- [ ] **Step 3: Update the file's header comment**

The comment block at the top of `verify.yml` lists the jobs. Add `rust` to it,
and state why it is not a required check by name - otherwise the next reader
sees an unlisted job and assumes the ruleset needs updating.

- [ ] **Step 4: Commit and push**

```bash
git add .github/workflows/verify.yml
git commit -m "ci: add the rust job, asserted by the verify aggregator (#219)"
git push -u origin feat/rust-workspace-and-gate
```

- [ ] **Step 5: Open the PR and watch all eight checks**

```bash
gh pr create --repo wormeyman/FactorioMapWebUI --base main \
  --title "feat(rust): land the Rust workspace and the rust CI gate (#219)" \
  --body "Closes #219. Part of #215."
gh pr checks --watch
```

Expected: `static`, `tests (1..4, 4)`, `rust`, `verify` and `build` all pass.
Record the `rust` job's wall time in the PR - it is the number that says whether
the gate is cheap, and nobody can compare against it later if it is not written
down.

---

### Task 7: Prove the gate discriminates

The spec's gate for phase 0c is not "the job is green". It is "a planted failure
in each of its steps turns the required `verify` check red". A gate nobody has
watched fail is indistinguishable from a gate that does nothing, and this
repository has caught vacuous guards exactly this way before.

**Files:** none permanently. Every change here is reverted.

**Interfaces:**
- Consumes: the running gate from Task 6.
- Produces: evidence, posted to #219.

- [ ] **Step 1: Plant each failure locally, one at a time**

For each row, apply the break, run `pnpm run verify:rust`, confirm the expected
failure, then `git checkout .` before the next one.

| # | plant | expected failure |
| --- | --- | --- |
| 1 | add a stray blank line inside a function in `crates/fmw-noise/src/checksum.rs` | `cargo fmt --check` reports a diff |
| 2 | add `let _unused = 1;` to `fnv1a64` | clippy `unused_variables` denied as an error |
| 3 | change the `b"a"` expected value to `0xaf63dc4c8601ec8dn` | `cargo test` fails on `matches_the_published_fnv1a64_vectors` |
| 4 | make `fold_f64` XOR raw bits instead of FNV | `the_fold_is_order_sensitive` fails, which is the whole reason it exists |
| 5 | add `serde = "1"` to `crates/fmw-noise/Cargo.toml` | the zero-dependency step names `serde` and exits 1 |
| 6 | flip one byte of `src/noise/wasm/engine.wasm` with `printf '\\x00' \| dd of=src/noise/wasm/engine.wasm bs=1 seek=8 conv=notrunc` | the wasm comparison reports it stale |
| 7 | same flipped byte, then `pnpm vp test test/wasmEngine.spec.ts` | the TypeScript spec fails to instantiate or returns wrong vectors |

Break 4 is the important one. Breaks 1 through 3 test the tooling; break 4 tests
whether the ORDER-SENSITIVITY claim in the code comment is actually enforced. If
break 4 passes, the comment is decoration and the test needs rewriting.

- [ ] **Step 2: Prove one of them reddens CI end to end**

Local failure shows the script works. It does not show the aggregator wiring
works, which is the part with the subtle failure mode.

```bash
git checkout -b tmp/prove-rust-gate
# plant break 3 - a wrong expected value, the least ambiguous break
git commit -am "TEMPORARY: plant a failure to prove the rust gate reddens verify"
git push -u origin tmp/prove-rust-gate
gh pr create --repo wormeyman/FactorioMapWebUI --base main \
  --title "TEMPORARY: prove the rust gate reddens verify" --body "Do not merge."
gh pr checks --watch
```

Expected: `rust` FAILS, and `verify` FAILS with `::error::rust phase: failure`.
`static`, `tests` and `build` still pass, which is what shows the failure is
attributed correctly rather than taking everything down.

Confirm the PR reports itself as blocked:

```bash
gh pr view --json mergeable,mergeStateStatus --jq '{mergeable, mergeStateStatus}'
```

- [ ] **Step 3: Tear the proof down**

```bash
gh pr close --delete-branch
git checkout feat/rust-workspace-and-gate
git branch -D tmp/prove-rust-gate
```

- [ ] **Step 4: Post the evidence to #219 and merge**

Comment on #219 with the seven local results and the CI run URL showing
`verify` red on `::error::rust phase: failure`. Then merge the Task 6 PR:

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 5: Confirm it is green on `main`**

The spec's phase 0c gate says green on `main`, not green on a PR. Those are
different claims once `strict: true` is in play.

```bash
git checkout main && git pull --ff-only
gh run list --branch main --limit 1
```

Expected: the merge commit's run passes every job including `rust`.

---

## Self-review

**Every Rust and JavaScript block in Tasks 2, 3 and 5 was built and run before
being written down.** That is not ceremony - it found six defects in the first
draft, and five of them would have cost the implementer real time because each
fails in a way that looks like a mistake they just made:

1. **`--locked` fails when no `Cargo.lock` exists.** The draft's first command
   was `cargo test --locked`, which errors before compiling anything.
2. **Pinning `1.97.1` downloads a toolchain** even though `stable` is already
   that version, because rustup treats them as separate installs. The draft
   claimed nothing would be downloaded.
3. **`#![no_std]` in `fmw-wasm` while `fmw-noise` links `std`** gives
   `error[E0152]: found duplicate lang item 'panic_impl'`.
4. **The `no_std` design was unnecessary anyway.** The spike that measured
   1,518 bytes used plain `std`, and the simplified crate here builds to
   **599 bytes**. The bump allocator and panic handler were complexity bought
   for nothing.
5. **A WASM `u64` arrives in JavaScript as a SIGNED BigInt.** `fnv1a64("")`
   returned `-0x340d631b7bdddcdb` instead of `0xcbf29ce484222325`. No error is
   raised. Every u64 crossing needs `BigInt.asUintN(64, x)`.
6. **`core::ptr::addr_of!` is required** rather than a plain reference to the
   `static mut`, or `static_mut_refs` denies the build under `-D warnings`.

Measured state of the verified crates: `cargo fmt --check` clean,
`cargo clippy --all-targets --all-features -- -D warnings` clean, 3 tests pass,
`cargo tree --edges normal` lists only `fmw-noise` and `fmw-wasm`, and the three
FNV-1a vectors match when called from Node through the built module.

**Spec coverage.** Section 4.1 layout: Tasks 2 and 3. Section 4.2 dependency
line: Tasks 2, 3 and 5. Section 5 determinism: Tasks 2 and 4, with the
`suboptimal_flops` allow in Task 2 Step 3 and the flag policy in Task 4 Step 1.
Section 8.2: Task 1. Section 8.3: Tasks 2 through 7. Section 9.1 build: Task 3's
`build-wasm.sh`, kept out of `vp build`. Section 9.2 local gate: Task 5.
Section 9.3 CI: Task 6. Section 11 supply chain: Task 4's `deny.toml` and
Task 6's pinned `cargo-deny`.

**Not covered here, by design.** The Renovate `cargo` rule with
`minimumReleaseAge: "3 days"` (spec section 11, item 3) is deferred to phase 1,
when the first dev-dependency arrives. Adding a Renovate rule for a manager with
nothing to update is a config edit that cannot be verified, and a Renovate config
that fails to parse makes the app do nothing at all, silently.

**Known deviation from #219's wording.** The sub-issue says "one trivial crate
and one trivial test". This plan lands `fnv1a64` and `fold_f64` instead of a
placeholder, because they are the tier-2 parity primitive every later phase
needs, they are about ten lines, and their test vectors are published rather than
self-referential. The alternative is a stub that proves the gate runs without
proving it catches anything.

**Type consistency.** `fnv1a64(&[u8]) -> u64` and `fold_f64(u64, f64) -> u64`
are used with those exact signatures in Task 2 (definition), Task 3 (WASM
export), Task 5 (TypeScript spec, as `bigint` across the boundary) and Task 7
(the planted breaks). The WASM exports are `alloc`, `fnv1a64`, `fold_f64` and
`memory` in all three places they appear.
