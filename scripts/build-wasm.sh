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

# One definition, shared with verify-rust.sh - see that file for why the flags
# exist at all (#299). The two builds must agree exactly or the gate reports
# "stale" against a module that is current.
# shellcheck source=scripts/wasm-rustflags.sh
. "$(dirname "$0")/wasm-rustflags.sh"

cargo build --locked --release --target wasm32-unknown-unknown -p fmw-wasm

mkdir -p src/noise/wasm
cp target/wasm32-unknown-unknown/release/fmw_wasm.wasm src/noise/wasm/engine.wasm

echo "bytes: $(wc -c < src/noise/wasm/engine.wasm)"
shasum -a 256 src/noise/wasm/engine.wasm
