#!/usr/bin/env bash
# The Rust half of `pnpm run verify`, and the same phases CI's `rust` job runs.
#
# Runs LAST in `verify`, after `vp test`, per issue #219 - on the reasoning that
# a cold cargo build should not sit in front of the phases that fail fastest.
# That premise turned out to be much smaller than assumed, and the numbers are
# here rather than the assumption: three runs after `cargo clean` measure
# 1.62 / 1.64 / 1.62s, and three warm runs measure 0.84 / 0.85 / 0.87s. Both
# are under `vp check`'s 2.0s, so the ordering is nearly free either way and is
# left where #219 put it rather than churned. On the CI runner the whole job is
# 19s, of which this script is 2s and the pinned-toolchain sync is 10s.
#
# The cost that IS real is the FIRST run on a machine with no Rust: rustup
# installs the pinned toolchain and its components before anything here runs.
# `pnpm run verify` now needs a cargo, which it did not before.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> cargo fmt --check"
cargo fmt --all --check

echo "==> cargo clippy"
cargo clippy --locked --all-targets --all-features -- -D warnings

echo "==> cargo test"
cargo test --locked --workspace

echo "==> anti-vacuity: the gate must FAIL against a deliberately broken port"
# A parity test that passes against a broken port is worth nothing, so the gate
# proves it can fail rather than asserting it can (#220). `--features poison`
# perturbs every op's returned value; each op's tier-1 fixture test must go red.
#
# `set -e` is why the run is written with a trailing `|| true`: a non-zero exit
# is the PASS here, and an unguarded call would abort the script on success.
POISON_OUT=$(cargo test --locked -p fmw-noise --features poison 2>&1 || true)

if ! grep -q "^test result: FAILED" <<<"$POISON_OUT"; then
  echo "ERROR: the port's tests PASSED with --features poison." >&2
  echo "       The gate cannot see a one-ULP error, so it is not a gate." >&2
  echo "       See crates/fmw-noise/src/poison.rs - an earlier version of this" >&2
  echo "       control perturbed a gradient-table slot instead, and the" >&2
  echo "       fixtures could not resolve it." >&2
  exit 1
fi

# And it must be red for the RIGHT reason, per op.
#
# "the suite went red" is too weak a check, which is measured rather than
# assumed: until #220's second batch, `basis_noise` carried the only poison
# hook, and because every ported op composed it, one hook reddened everything.
# The five primitives added in that batch compose it in NONE of their paths, so
# a suite-level check would have passed while five ports had no anti-vacuity
# control at all.
#
# Adding an op therefore means adding its tier-1 test here. A list rather than a
# pattern, for the same reason `SUPPORTED_VERSIONS` is a list rather than a
# range: a pattern silently accepts something nobody checked.
#
# Entries are FULL test paths, not bare names. That changed with #224, and the
# reason is worth keeping: Fulgora's land argmax needed a control that the ocean
# test's control could not stand in for, and the only test that can see it is a
# unit test living beside the op in `tiles::fulgora_catalog`. Requiring every
# entry to sit in `fixtures::` would have meant either moving that test away
# from its op or leaving the argmax with no control of its own.
POISONED_TESTS=(
  fixtures::reproduces_all_512_points_of_the_basis_noise_fixture_exactly
  fixtures::reproduces_the_multioctave_fixture_exactly
  fixtures::reproduces_the_variable_persistence_fixture_exactly
  fixtures::reproduces_the_quick_multioctave_fixture_exactly
  fixtures::reproduces_the_quick_persistence_wrapper_exactly
  fixtures::reproduces_the_random_penalty_fixture_exactly
  fixtures::reproduces_the_games_distance_from_nearest_point_at_all_26_positions
  fixtures::computes_the_games_real_starting_lake_for_seed_123456
  fixtures::reproduces_every_starting_lake_distance_in_the_fixture
  fixtures::reproduces_the_recovered_candidate_draw_stream_bit_exactly
  fixtures::reproduces_every_game_captured_candidate_set
  fixtures::reproduces_every_game_captured_spot_selection_probe
  fixtures::reproduces_the_games_per_cell_voronoi_draw_across_all_nine_seed_series
  fixtures::reproduces_the_jitter_zero_voronoi_fixture_exactly
  fixtures::reproduces_the_jittered_voronoi_fixture_exactly
  fixtures::reproduces_the_voronoi_point_inversion_lattice_exactly
  fixtures::reproduces_the_voronoi_search_range_fixture_and_rejects_the_wrong_ring
  fixtures::reproduces_the_games_pow_operator_at_every_position
  fixtures::reproduces_the_native_multisample_shift_at_all_150_comparisons
  fixtures::the_multisample_port_implements_the_one_tile_channel_only
  fixtures::reproduces_every_game_captured_seed_variable
  fixtures::reproduces_the_games_slider_rescale_at_all_seven_probe_points
  fixtures::reproduces_the_fulgora_shared_layer_at_every_captured_position
  fixtures::reproduces_the_fulgora_cell_classification_at_every_captured_position
  fixtures::reproduces_the_fulgora_elevation_chain_at_every_captured_position
  fixtures::reproduces_the_games_starting_spot_at_angle_at_every_case
  fixtures::typing_the_dunes_constant_f32_reaches_exactly_zero_residual
  fixtures::puts_fulgora_land_and_ocean_where_the_game_puts_them
  fixtures::reproduces_the_fulgora_ruins_layer_at_every_captured_position
  fixtures::the_ruins_walls_constant_is_the_same_f32_case_as_dunes
  fixtures::reproduces_the_fulgora_scrap_probability_at_every_captured_position
  fixtures::puts_every_fulgora_tile_where_the_game_puts_it

  # Phase 5 (#225), Vulcanus. Its hook is `poison::f64_result` on the plasma
  # output; the two multioctave fields inherit `basis_noise`'s own hook.
  fixtures::reproduces_the_vulcanus_helper_layer_at_every_captured_position
  fixtures::reproduces_the_vulcanus_crack_layer_at_every_captured_position
  fixtures::reproduces_the_vulcanus_climate_layer_at_every_captured_position
  fixtures::reproduces_the_vulcanus_spawn_layer_at_every_captured_position
  fixtures::reproduces_the_vulcanus_biome_layer_at_every_captured_position
  fixtures::reproduces_the_vulcanus_elevation_surface_at_every_captured_position
  fixtures::reproduces_the_vulcanus_temperature_at_every_captured_position

  tiles::fulgora_catalog::tests::an_exact_tie_resolves_to_the_earlier_tile_in_land_order
)
for t in "${POISONED_TESTS[@]}"; do
  if ! grep -q "^test ${t} \.\.\. FAILED" <<<"$POISON_OUT"; then
    echo "ERROR: ${t} stayed GREEN under --features poison." >&2
    echo "       Its op has no live poison hook, so nothing proves that test" >&2
    echo "       can fail. Add one - see crates/fmw-noise/src/poison.rs." >&2
    exit 1
  fi
done

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
# Byte identity rather than a rebuild-and-retest fallback, because #218
# measured it holding: the same source and profile built on macOS/aarch64 and
# on an ubuntu x86_64 runner produce the same 599 bytes and the same sha256.
#
# That property was conditional on something #218 could not have known, because
# the module had no generic std code in it yet: whether `rust-src` is installed.
# `wasm-rustflags.sh` carries the measurement and the fix, and is sourced by
# `build-wasm.sh` too - the producer and the checker must pass identical flags
# or this comparison fails against a module that is perfectly current (#299).
# shellcheck source=scripts/wasm-rustflags.sh
. "$(dirname "$0")/wasm-rustflags.sh"

cargo build --locked --release --target wasm32-unknown-unknown -p fmw-wasm
if ! cmp -s target/wasm32-unknown-unknown/release/fmw_wasm.wasm \
             src/noise/wasm/engine.wasm; then
  echo "ERROR: src/noise/wasm/engine.wasm is stale." >&2
  echo "Rebuild it with ./scripts/build-wasm.sh and commit the result." >&2
  exit 1
fi

echo "==> cargo deny"
# Probe by ASKING CARGO, not with `command -v cargo-deny`. Measured: after
# `cargo install cargo-deny`, the binary lands in $CARGO_HOME/bin, which is not
# necessarily on PATH - cargo finds its own subcommands there regardless. So
# `command -v` reported it missing and this step skipped itself while
# `cargo deny check` ran fine by hand, which is the worst shape a guard can
# take: green, and not checking anything.
if cargo deny --version >/dev/null 2>&1; then
  cargo deny check
else
  echo "SKIP: cargo-deny not installed locally."
  echo "      Install with: cargo install cargo-deny --locked --version 0.20.2"
  echo "      CI always runs it, so this cannot be skipped on the way to main."
fi
