#!/usr/bin/env bash
# The one definition of the flags the committed engine.wasm is built with.
#
# Sourced by BOTH `build-wasm.sh` (which produces the module) and
# `verify-rust.sh` (which rebuilds it and compares bytes). Those two must agree
# exactly or the gate reports "stale" against a module that is perfectly
# current, so this lives in one file rather than being written out twice - the
# same anti-drift rule the workflow follows by naming only package.json scripts.
#
# ## What this fixes, and why the gate was only accidentally green (#299)
#
# `verify-rust.sh` compares bytes instead of rebuilding-and-retesting because
# #218 measured byte identity holding across macOS/aarch64 and an ubuntu x86_64
# runner. That property is real and still holds - but it was quietly conditional
# on something nobody had written down: whether the `rust-src` component is
# installed.
#
# Three files of GENERIC std code get monomorphised into `fmw-wasm` -
# `alloc/src/collections/btree/{navigate,node}.rs` and
# `core/src/slice/sort/stable/quicksort.rs`, reached through the
# `RefCell<BTreeMap>` region cache in `vulcanus_biomes` and the stable sort.
# Panic locations for monomorphised generics are resolved at OUR build time, so
# with `rust-src` present they resolve to a LOCAL ABSOLUTE PATH instead of the
# remapped `/rustc/<commit-hash>/` form the prebuilt std uses.
#
# Measured, changing only that component inside one linux/arm64 container:
#
#   rust:1.97.1, no rust-src            84,171 bytes  <- the committed module
#   same container, + rustup component add rust-src    84,283 bytes
#
# 117 of those 120 bytes are three paths that are 39 characters longer each; the
# rest is adjacent length prefixes. Every byte of the delta is in the DATA
# section - `code` is 74,523 either way, and its bytes move only because
# data-segment pointers shift underneath them.
#
# The host was NOT the variable, which is worth stating because the issue was
# first diagnosed that way. linux/aarch64 - the SAME cpu as the mac - reproduces
# the committed bytes exactly, and so does linux/x86_64. Architecture is
# refuted, and #218's cross-machine identity has not expired.
#
# Two consequences that make this worth fixing rather than documenting:
#
#   1. The embedded string contains $HOME, so before this flag TWO DIFFERENT
#      MACS could not agree with each other either. It was never "Linux vs
#      macOS", it was "rust-src or not", and CI merely happens not to install
#      it. `rust-toolchain.toml` pins `profile = "minimal"` with rustfmt and
#      clippy only - rust-src arrives out of band, which rust-analyzer does by
#      default, so any contributor's editor can turn the gate red.
#   2. Nothing anywhere stated that dependency, so the failure surfaces as
#      "engine.wasm is stale" - which reads as "your diff broke the port" and
#      sends you hunting a change you did not make.
#
# Both values are asked of `rustc` rather than hardcoded, so a toolchain bump
# carries this along instead of silently re-breaking it. It is also inert where
# it is not needed: with no `rust-src` installed there is nothing to remap and
# the flag changes no byte, which is why CI's output is unaffected.
#
# Verified on the mac that was failing: with this flag it produces 84,171 bytes
# and sha256 a18f7ace90a4c1c8ec0c0f695405b035ca03d68f3a8b6d9373ff1b3694e6f596,
# byte-identical to the committed module.

WASM_SYSROOT="$(rustc --print sysroot)"
WASM_RUSTC_HASH="$(rustc -vV | awk '/commit-hash/ {print $2}')"

if [ -z "$WASM_RUSTC_HASH" ]; then
  echo "ERROR: could not read rustc's commit-hash; refusing to build with a" >&2
  echo "half-applied remap, which would produce bytes that differ from CI." >&2
  exit 1
fi

# Appended rather than assigned, so a caller that already set RUSTFLAGS for
# its own reasons keeps it. Cargo takes RUSTFLAGS as a space-separated list.
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$WASM_SYSROOT/lib/rustlib/src/rust/=/rustc/$WASM_RUSTC_HASH/"
