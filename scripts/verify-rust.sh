#!/usr/bin/env bash
# The Rust half of `pnpm run verify`, and the same phases CI's `rust` job runs.
#
# Runs LAST in `verify`, after `vp test`, per issue #219 - on the reasoning that
# a cold cargo build should not sit in front of the phases that fail fastest.
# That premise was re-measured on 2026-09-05 and the numbers below replace an
# earlier header claiming "1.62s cold, 0.84s warm" - wrong by more than a
# hundredfold, and impossible for a script that runs the crate's tests twice.
# Warm, each phase timed on its own: `cargo test --locked -p fmw-noise
# --features poison` 82.4s, `cargo test --locked --workspace` 26.0s, the
# wasm32 release build 2.8s, `cargo deny check` 0.6s, fmt + clippy 0.3s.
# That is 112.0s, which is 54% of `pnpm run verify` and its LARGEST phase.
#
# The poison phase's cost is the poison, not the test count: filtering to
# `fixtures::` runs 108 tests instead of 452 and still costs 81.3s, and those
# same 108 tests cost 20.8s clean against 81.2s poisoned. Perturbing every op
# drives the code into much slower paths. Narrowing this phase was measured
# and buys nothing; whether the 3.9x itself is inherent is NOT measured.
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
  fixtures::reproduces_the_vulcanus_resource_layer_at_every_captured_position

  # The tile argmax is a DISCRETE output, so `poison::f64_result` cannot reach
  # it - a one-ULP nudge essentially never changes which side of a comparison a
  # value falls on. Its control is `poison::index_result` in
  # `tiles::vulcanus_catalog::resolve_tile`, the same hook Fulgora's argmax uses.
  fixtures::puts_every_vulcanus_tile_where_the_game_puts_it
  fixtures::classifies_every_vulcanus_lava_tile_correctly
  fixtures::puts_every_vulcanus_tile_where_the_game_puts_it_at_a_real_saves_surface_seed
  tiles::vulcanus_catalog::tests::an_exact_tie_resolves_to_the_earlier_tile_in_order

  tiles::fulgora_catalog::tests::an_exact_tie_resolves_to_the_earlier_tile_in_land_order

  # Phase 6 (#226), the Nauvis tile argmax. Same shape as Vulcanus's: the
  # 21-way winner is a DISCRETE output, so `poison::f64_result` cannot reach it
  # and its control is `poison::index_result` in
  # `tiles::nauvis_catalog::NauvisTileCatalog::resolve`.
  #
  # Both tests here are red ONLY because of that hook, and that was measured
  # rather than assumed. Deleting the `index_result` call and re-running under
  # poison leaves BOTH GREEN - so numeric poison applied to every field beneath
  # the catalog moves not one of the 153 tiles.
  #
  # That is a stronger result than Vulcanus's comment above, which this block
  # first copied: there the end-to-end test is red whether or not the argmax has
  # a control, because its ocean/biome hooks move classifications. Here nothing
  # but `index_result` can redden either test, which is the tile argmax's
  # absorbing property stated as a measurement.
  fixtures::puts_every_nauvis_tile_where_the_game_puts_it_at_all_three_seeds
  tiles::nauvis_catalog::tests::an_exact_tie_resolves_to_the_earlier_tile_in_order

  # Phase 6 (#226), the Nauvis resource layer. NO hook of its own, for the same
  # reason no phase-6 expression layer has one: everything under it composes
  # `basis_noise`, `fast_cbrt`, `random_penalty`, `distance_from_nearest_point`
  # and `spot_selection`, all of which already carry theirs. Adding a seventh
  # would give these two tests no control they do not already have.
  #
  # They are listed anyway, and that is the point of a NAMED list rather than a
  # suite-level "did anything fail": these are the only tests that grade
  # `resources::regular_patches` and `resources::starting_patches` against the
  # game, and a future change that made them unreachable from every hook would
  # be a port with no measurement behind it.
  fixtures::reproduces_the_games_regular_resource_patches_at_every_captured_position
  fixtures::reproduces_the_games_combined_resource_patches_at_every_captured_position

  # Phase 6 (#226), the Nauvis tree layer. No hook of its own either: every
  # species composes `basis_noise` through `multioctave_noise`, and the climate
  # boxes read `moisture` and `temperature`, all of which already carry theirs.
  #
  # The third test here is the one worth naming. It scores both fixtures WITHOUT
  # the capture-grid snap, so it is the control on the snap rather than on the
  # port - and it is still listed, because a perturbation has to move it too. A
  # test that stayed green under poison while its snapped twin went red would
  # mean the two were not measuring the same thing.
  fixtures::reproduces_the_games_tree_layer_at_every_captured_position
  fixtures::reproduces_the_games_tree_layer_at_moved_control_levers
  fixtures::the_capture_grid_snap_is_worth_a_third_of_the_tree_agreement

  # Phase 6 (#226), the Nauvis cliff and rock fields. One hook between them,
  # `poison::bool_result` on `cliffs::fields::NauvisCliffFields::cliffiness`,
  # and it was added because a measurement demanded it rather than because the
  # discrete-output rule predicted it.
  #
  # Built with no hook on that line, the gate test stayed GREEN at 0 mismatches
  # while `..._cliff_elevation_at_both_seeds` - which shares the same
  # `NauvisShared` and therefore the same perturbed chain - fell from 355 exact
  # to 227. So numeric poison really does move everything underneath the gate,
  # and not one of its 2,048 answers changes with it: the closest any position
  # sits to the cutoff is 2.344133e-4, against about 6e-8 for one f32 ULP there.
  # With the hook live the same test reports 1024 of 1024 mismatches.
  #
  # The two continuous fields need no hook of their own - `cliff_elevation` and
  # `rock_density` both compose `basis_noise`, which carries its own.
  fixtures::reproduces_the_games_nauvis_cliff_elevation_at_both_seeds
  fixtures::reproduces_the_games_nauvis_cliffiness_gate_exactly_at_both_seeds
  fixtures::reproduces_the_games_nauvis_rock_density_at_every_captured_position

  # Phase 6 (#226), the Nauvis enemy-base layer. No hook of its own: the field
  # composes `basis_noise`, `distance_from_nearest_point` and `spot_selection`,
  # all of which carry theirs, and the last of those already covers the discrete
  # half - which spots survive the trim.
  #
  # Both listed tests were watched going red rather than assumed to. The second
  # is worth naming because its control is THIN: it counts positions where the
  # clamped probability is positive, and `probability` is 0 at 990 of 1032
  # positions, so a perturbation has to push one across zero to be seen. It
  # does - 42 becomes 43 at seed 123456 - but that is one position, so do not
  # read it as a strong gate. The field test above it is the real one.
  fixtures::reproduces_the_games_enemy_base_field_at_both_seeds
  fixtures::the_enemy_fixture_is_mostly_basement_so_the_probability_would_grade_nothing

  # Phase 5's second half (#225), the cliff stack. Three hooks, because three
  # ops here can be wrong independently and one red test would otherwise stand
  # in for all of them:
  #
  #   - `poison::f64_result` on `cliffiness_basic`, the only numeric field;
  #   - `poison::crossing_result` on `crosses_cliff`, whose output is a
  #     TRI-STATE classification a numeric hook cannot reach;
  #   - `poison::sweep_order` on `fixImpossibleCells`, which has no value to
  #     bend at all - only a choice of which edge to clear;
  #   - `poison::bool_result` on `isCliffConnected` and the ore rejection.
  #
  # The two `cliffs::placement` tests are here rather than only the fixtures:
  # under poison the crossing hook moves every edge in the lattice, so the
  # end-to-end test is red whether or not the sweep has a control.
  fixtures::places_every_vulcanus_cliff_where_the_game_places_it
  fixtures::reproduces_the_vulcanus_cliff_fields_at_every_captured_corner
  cliffs::placement::tests::a_crossing_needs_a_band_a_sign_and_the_cliffiness_gate
  cliffs::placement::tests::the_sweep_clears_the_first_clearable_edge_in_l_t_r_b_order
  cliffs::connections::tests::connection_is_a_parity_test_and_not_a_do_they_touch_test

  # Phase 5, part 3 (#225) - the rock and resource overlays.
  #
  # The rock probability FIELD inherits `basis_noise`'s hook, the way the two
  # Vulcanus multioctave fields do: `vulcanus_decorative_knockout` is a bare
  # two-octave call and both rock expressions compose it.
  fixtures::reproduces_the_vulcanus_rock_fields_at_every_captured_position

  # The placement ROLL's accept is a CLASSIFICATION, so its hook is
  # `poison::bool_result` rather than a numeric one - a one-ULP nudge to a
  # probability changes which side of `U < probability` a draw falls on
  # essentially never. It is hooked inside `resolve_chunk` rather than on
  # `placed()`'s return so the perturbation also cascades through the
  # order-dependent collision pass, which is what the second test here sees.
  #
  # Neither test reads a game fixture, and that is deliberate rather than a
  # gap: the game's own entity counts are per 512x512 region, and scoring one
  # region costs ~33s in a debug build - the same order as the cliff connection
  # test that already took this script to 1m50s. The roll is graded against
  # those counts on the TypeScript side (`test/entityDensity.spec.ts`), and the
  # two ports are byte-identical through `test/wasmVulcanusRenderParity.spec.ts`.
  placement::roll::tests::with_no_gates_the_set_is_the_bare_roll
  placement::roll::tests::collision_keeps_the_first_tile_in_the_games_processing_order

  # The geyser's probability is its own small expression over a field the
  # resource layer already grades, so it gets `poison::f64_result` and the one
  # test that pins its value.
  resources::vulcanus_catalog::tests::the_measured_peak_is_far_below_a_solid_ores

  # Fulgora scrap's placement roll (#363). No hook of its own: it composes
  # `resolve_chunk`'s `poison::bool_result`, the same one the two
  # `placement::roll` entries above read, and its probability comes from
  # `expressions::fulgora_scrap`, which `fixtures::reproduces_the_fulgora_scrap_
  # probability_at_every_captured_position` already grades.
  #
  # Watched going red rather than assumed to: the perturbation inverts every
  # accept, so the window's placements go from 177 to 16,207 of 16,384 and the
  # test's upper bound trips.
  #
  # Its sibling `the_collision_box_cannot_reject_anything` is deliberately
  # ABSENT. That one compares a poisoned arm against a poisoned arm, so the
  # perturbation cancels and it stays green - the relational shape `poison.rs`
  # records for the capture-grid snap test. Adding it here would fail the gate
  # for being correct.
  resources::fulgora_catalog::tests::places_a_strict_nonempty_subset_of_the_footprint

  # The only grading of `cliffs::connections` against anything - that module is
  # on no render path, so without this it would be a 445-line port with unit
  # tests and no measurement.
  #
  # It is also the most expensive test in the crate by a wide margin, and that
  # is worth knowing before anyone adds a second like it. Measured: 33s in the
  # normal arm and 93s under poison, which took this whole script from a few
  # seconds to **1m50s** wall. Poisoning is the expensive half because
  # `crossing_result` turns every lattice edge into a crossing, so far more
  # cells place and the onDestroy cascade recurses over a dense set.
  #
  # `verify:rust` is therefore NO LONGER the cheapest job in the workflow. It is
  # still far under the test shards (300s+), so it does not move the gate wall -
  # but the line in CLAUDE.md calling it 19s and the cheapest job expired here.
  fixtures::the_apply_stage_beats_the_crossing_stage_on_three_counts_and_loses_on_none

  # Phase 6 (#226), Nauvis. The shared sub-tree's own hook is
  # `poison::f64_result` on `cliff_ringbreak` - the layer's own arithmetic on
  # top of the warp, rather than one of the octave fields, which inherit
  # `basis_noise`'s hook already.
  #
  # `the_nauvis_offset_seeds_are_the_crc32_of_their_expression_names` is
  # deliberately NOT here. It compares two `u32` constants against numbers
  # worked out by hashing a string, so there is no ULP to bend and a wrong
  # constant fails it with or without the feature - the same class as
  # `the_random_penalty_seed_word_matches_the_measured_formula`. See
  # `crates/fmw-noise/src/poison.rs`.
  fixtures::reproduces_the_nauvis_cliff_offset_chain_at_every_captured_position

  # `amplitude_corrected_multioctave_noise`, ported in phase 6 because
  # `elevation_lakes` and `elevation_nauvis` both read it. Like the layer above,
  # it adds no hook of its own: it is a transform on top of
  # `variable_persistence_multioctave_noise`, so there is no path to it that
  # avoids `basis_noise` and nothing could give its own arithmetic an
  # independent control.
  fixtures::reproduces_the_amplitude_corrected_wrapper_at_the_typescripts_own_count

  # `elevation_lakes` / `elevation_island`. Same reasoning again: every value in
  # that tree composes `basis_noise`, so the layer adds no hook of its own.
  fixtures::reproduces_the_games_elevation_lakes_tree_at_every_captured_position
  fixtures::reproduces_the_games_elevation_island_tree_at_every_captured_position

  # `elevation_nauvis`, and the `added_cliff_elevation = 0` variant that
  # `cliff_elevation_nauvis` depends on. `the_cliff_elevation_term_moves_...`
  # is NOT here: it compares the GAME's own two columns against each other and
  # our two trees against each other, so a perturbation applies to both sides
  # and cancels - the relational shape `poison.rs` records for the capture-grid
  # snap test.
  fixtures::reproduces_the_games_elevation_nauvis_tree_at_every_captured_position
  fixtures::reproduces_the_games_elevation_nauvis_no_cliff_variant_at_both_seeds

  # The three climate expressions. `temperature_basic` composes nothing but
  # `quick_multioctave_noise`, so it is the shallowest thing in the Nauvis port
  # - and the only one that reaches the game bit-exactly.
  fixtures::reproduces_the_games_aux_at_every_captured_position
  fixtures::reproduces_the_games_moisture_at_every_captured_position
  fixtures::reproduces_the_games_temperature_bit_for_bit_at_every_captured_position
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
