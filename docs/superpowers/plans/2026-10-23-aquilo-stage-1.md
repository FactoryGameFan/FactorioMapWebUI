# Aquilo, Stage 1 (complete) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aquilo renders in the browser preview as a full peer of the other three planets: terrain (9 tiles), its three wells, and its icebergs, with its three resource sliders wired. It is graded against the game at 2.1.23 and goes live when the PR merges.

**Architecture:** The same shape as Fulgora and Vulcanus. Hand-ported expressions in `crates/fmw-noise/src/expressions/aquilo_*.rs`, a 9-tile catalog, and two rolled overlays (wells, icebergs) on the existing `PlacementSet`. One new ABI block (planet code 3) feeds `render_aquilo`. The spot-noise query that Vulcanus has privately moves into a shared module first, because Aquilo's elevation reads three spot fields and Gleba will read more. The TypeScript side gains one request type, one lever reader and one dispatch branch. `PLANET_CAPABILITIES.aquilo.rendered` flips last.

**Tech Stack:** Rust workspace `crates/` (`fmw-noise`, `fmw-wasm`), Vue 3 + TypeScript (Vite+, `pnpm vp test`), `factorio-oracle` CLI, Factorio 2.1.23 and 2.0.77 headless.

**Spec:** `docs/superpowers/specs/2026-10-22-gleba-and-aquilo-design.md` (Stage 1, "Entities", "Grading", "CI cost"). Stage 0's findings are in `docs/superpowers/plans/2026-10-22-gleba-aquilo-stage-0.md`, `scripts/probes/planet-autoplace/README.md` and the `test/fixtures/PROVENANCE.json` entries for the Aquilo fixtures.

## Global Constraints

- Branch `aquilo-stage-1` off `main` (at or after `a04ebe8`). Commit this plan as the branch's first commit. One PR for the stage.
- Gate before the PR: `pnpm run verify` exits 0. Every Rust source change needs `bash scripts/build-wasm.sh` and the rebuilt `src/noise/wasm/engine.wasm` committed in the same commit.
- Frozen counts for Nauvis, Vulcanus and Fulgora must not move, nor any `tier2-checksums.json` or `tier3-render-checksums.json` value outside a new `aquilo` section. If one moves, stop and report it. Never edit a fixture or an expected value to make a test pass.
- Ship bar: every tier-1 field reaches a frozen exact-match count, and the terrain gap against `test/fixtures/oracle-preview-aquilo-terrain.seed123456.png` is frozen below 1,048 pixels (0.1% of 1024x1024). Any leftover gap becomes a GitHub issue linked from the PR. A preview miss is never tile correction (Stage 0 measured that the preview runs none), so the design's tile-correction exception does not apply.
- Seeds: tier-1 captures FORCE the surface seed (`mgs.seed = 123456`). Anything compared with a preview PNG uses the DERIVED Aquilo surface seed 3111923328 (map seed 123456).
- **No well tile rewrite.** The wells' `created_effect` rewrites nearby ocean during map generation, but Stage 0 measured that the preview PNG shows none of it (0 pixels). Stage 1 does not model it.
- **Lever match:** the terrain PNG was captured with all three Aquilo resource controls at size 0, and those controls reshape the islands. A render compared with that PNG sets `crude_oil`, `lithium_brine` and `fluorine_vent` to `size 0, frequency 1`. A render compared with the full PNG uses defaults (all 1).
- Probe installs on tealc: 2.1.23 root `/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio` (nested), 2.0.77 root `/home/eric/factorio-headless-2.0.77`. Always pass `--factorio <root>` AND `--version <v>` and assert the report's `buildLine` contains the version. Oracle binary `~/.cargo/bin/factorio-oracle`. Positions on the 1/256 grid.
- Every new file under `test/fixtures/` gets a `PROVENANCE.json` entry (`factorioVersion`, `evidence` naming the probe, both `buildLine`s, the date, `versionDifferences`). `maxUnknown` stays 0.
- Port rules from CLAUDE.md "Rules that keep the port deterministic": `min2`/`max2` in the Lua's argument order, no `mul_add`, per-op f32 narrowing where the noise machine narrows, no NaN in a frozen fold, `BigInt.asUintN(64, x)` on every u64. Bearing trig crosses the ABI as V8 values (this stage has no VM trig). Use `At::Grid` for plain-coordinate noise and `At::Point` for anything domain-warped (Aquilo's Voronoi fields and `aquilo_aux` are warped).
- `seed1` string seeds are `crc32(utf8(name))`, written as a constant with the name and hex in a trailing comment, as `fulgora_elevation.rs:39` does. Aquilo has one: `'aquilo-cracks'`.
- No file named `aux.rs`. New `#[cfg(test)]` code in `fmw-wasm` goes at the END of `lib.rs` (extend `native_parity.rs` rather than adding a module above it).
- Each new tier-1 test that a one-ULP perturbation must turn red goes into `POISONED_TESTS` in `scripts/verify-rust.sh`; confirm it goes red under `--features poison`.
- Prose in docs, comments and the PR body: hyphens, never em or en dashes; 12th-grade reading level or below.

## Review Focus

1. **A resource slider at size 0** (the terrain PNG's own setting) makes the spot radius 0, so `3q / (pi r^2)` is 0/0. The spot field must come back as the basement value -1, never NaN, and the elevation must match the game's size-0 case. Test in Task 3 (`a_zero_size_spot_field_is_the_basement_everywhere`) and graded by the size-0 case in Task 1's fixture.
2. **A frequency slider that makes `region_size` fractional** (frequency 1.5 gives 600 + 400/1.5 = 866.67). The region index must floor it as Vulcanus does, and the cache key must keep it unfloored. Graded by the moved-sliders case in Task 1's fixture (Task 3's tests).
3. **The guaranteed fluorine vent near spawn.** `aquilo_starting_flourine_vent_tiny` (radius 1, distance 80) gives probability 1 at its centre whenever `fluorine_vent` size > 0. A person expects a vent there on every seed. Test in Task 6 (`the_tiny_vent_is_placed_on_every_seed`).
4. **A preset with no Aquilo controls** (any imported Nauvis-era string) must render Aquilo at neutral levers (1/1), not size 0. Test in Task 10.
5. **A well or iceberg mark centred just outside a 64-pixel worker tile** must still be painted in that tile, so the tiled render equals the whole render. Test in Task 9 (`tiled equals whole for the all view`).

---

### Task 1: Capture Aquilo's entity-side fields and an entity census

The existing `test/fixtures/oracle-aquilo-fields.seed123456.json` grades elevation, aux and the 9 tile scores at default levers, but 991 of its 1,024 positions are ocean and none was chosen near a spot. This task captures the fields the wells, icebergs and island peaks read, at positions that contain them, at three lever settings.

**Files:**
- Create: `scripts/probes/aquilo-fields/{capture.ts,README.md}`
- Create: `test/fixtures/oracle-aquilo-entity-fields.seed123456.json`, `test/fixtures/oracle-aquilo-entities.seed123456.json`, plus 2 `PROVENANCE.json` entries

**Interfaces:**
- Produces, for Tasks 3 to 6: per lever case, f32 bits at each position for `aquilo_starting_crude_oil`, `aquilo_starting_lithium_brine`, `aquilo_starting_flourine_vent`, `aquilo_starting_flourine_vent_tiny`, `aquilo_starting_mask`, `aquilo_crude_oil_spots`, `aquilo_lithium_brine_spots`, `aquilo_flourine_vent_spots`, `aquilo_crude_oil_probability`, `aquilo_lithium_brine_probability`, `aquilo_flourine_vent_probability`, `aquilo_island_peaks`, `aquilo_wobble_x`, `aquilo_wobble_y`, `aquilo_aux`, `aquilo_elevation`, `aquilo_high_frequency_peaks`, `aquilo_snow_ice`, `aquilo_tile_variant`, `entity:lithium-iceberg-huge:probability`, `entity:lithium-iceberg-big:probability`, and the 9 `tile:<name>:probability` scores. JSON shape: `{ cases: { <label>: { controls, positions: [[x,y],...], fields: { <name>: [hex bits] } } } }`, the hex form `oracle-aquilo-fields` uses.
- Produces, for Tasks 6 and 9: a census at the DERIVED seed over chunks -8..8: every `resource` and `simple-entity` with name, position, and the tile name under its position.

- [ ] **Step 1: Write the probe.** Copy the runner shape of `scripts/probes/planet-fields/capture.ts` (its surface creation, batch read and `buildLine` asserts). Three lever cases, each setting all three controls (`aquilo_crude_oil`, `lithium_brine`, `fluorine_vent`) and reading them back: `default` (all 1/1), `size0` (all size 0, frequency 1), `moved` (crude oil frequency 1.5 size 0.5, lithium brine frequency 0.5 size 2, fluorine vent frequency 2 size 1/6). Positions per case: scout a 16,384-position pool on the 1/256 grid within 1,200 tiles of the origin, then keep, in pool order, 64 positions where each of the three `*_spots` fields is above -1, 64 where each `aquilo_starting_*` cone is above 0, 64 where each iceberg probability is above 0, and 128 more from the rest of the pool. A field whose quota cannot be met is a finding: write it in the README rather than shrinking the quota silently. Register any name that `calculate_tile_properties` refuses as a data-stage `noise-expression` wrapping it, as `planet-fields` did for tile scores.
- [ ] **Step 2: Add the census** on a second surface at the derived seed 3111923328 with default levers: `find_entities_filtered{type = {"resource", "simple-entity"}}` over chunks -8..8 after `request_to_generate_chunks` and `force_generate_chunk_requests`. Record name, position and `surface.get_tile(position).name`.
- [ ] **Step 3: Run** against 2.1.23 and 2.0.77. The script refuses to write if the field captures differ between versions, and asserts each `buildLine`. Expected: identical (the planet's map-gen files are byte-identical between the two). Re-run once and confirm byte-identical output.
- [ ] **Step 4: Write the README findings:** quota counts per field and case; the census totals by name (expect 11 crude-oil, 4 lithium-brine, 4 fluorine-vent, 159 lithium-iceberg-big, 21 lithium-iceberg-huge, matching `oracle-planet-autoplace.2.1.23.json`); and the tiles each entity kind stands on. That last list decides Task 6's `tile_allowed` for each overlay.
- [ ] **Step 5: Write both PROVENANCE entries** and run `pnpm vp test test/fixtureProvenance.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `git commit --message "Capture Aquilo's spot, well and iceberg fields at three lever settings"`.

### Task 2: Lift the spot-noise query out of the Vulcanus module

**Files:**
- Create: `crates/fmw-noise/src/spot_field.rs` (declared in `crates/fmw-noise/src/lib.rs`)
- Modify: `crates/fmw-noise/src/expressions/vulcanus_resources.rs` (`SpotSpec` region math, `region_spots`, `spot_noise_at` move onto the new module; the three key tests at `:1011-1097` move with the cache)

**Interfaces:**
- Produces:
  - `pub struct SpotGeometry { pub region_size: f64, pub max_basement_radius: f64, pub basement_value: f64 }` with `floored_region_size(&self) -> i64`, `half(&self) -> i64`, `region_index(&self, c: f64) -> i64` (bodies moved from `SpotSpec`, unchanged). `region_size` is UNFLOORED.
  - `pub struct SpotRegionCache<K: Ord + Copy>` (a `RefCell<BTreeMap<(K, i64, i64), Vec<SelectedSpot>>>`) with `new()` and `get_or_select(&self, key: K, region_x: i64, region_y: i64, select: impl FnOnce() -> Vec<SelectedSpot>) -> Vec<SelectedSpot>`. The select callback runs OUTSIDE any borrow.
  - `pub fn spot_cone_max(geometry: &SpotGeometry, sx: f64, sy: f64, mut spots_in: impl FnMut(i64, i64) -> Vec<SelectedSpot>, radius_at: impl Fn(&SelectedSpot) -> f64) -> f64` - the region walk, the `d2 > max_basement_radius^2` cull, the `radius <= 0` skip, the f32 cone arithmetic, and the `poison::f64_result(best)` hook, all moved verbatim from `spot_noise_at`.
- Vulcanus keeps its own `SpotCacheKey` (now without `region_x`/`region_y`, which the cache tuple carries) as the `K`.

- [ ] **Step 1: Pin the old behaviour first.** Before moving anything, add `the_shared_spot_query_is_the_vulcanus_one_bit_for_bit` to `vulcanus_resources.rs`'s tests: seed 1249936247, 26x26 positions at step 37.3 from (-480, -480), an order-sensitive `checksum::fold_f64` over the four `*_region` fields of `VulcanusResources::eval_at`, against a frozen constant. Run it on the unmoved code, freeze the printed value, and commit it alone (`git commit --message "Freeze a fold of the Vulcanus spot regions before moving the spot query"`).
- [ ] **Step 2: Move the code**, then run `cargo test --locked -p fmw-noise vulcanus spot_field`. Expected: PASS, the new fold unchanged, the moved key tests green.
- [ ] **Step 3: Rebuild** `bash scripts/build-wasm.sh`, then run `pnpm vp test test/wasmVulcanusParity.spec.ts test/wasmVulcanusRenderParity.spec.ts`. Expected: PASS with every frozen value unchanged. A changed `engine.wasm` is expected (code motion); a changed fold or pixel count is not.
- [ ] **Step 4: Run** `cargo test --locked -p fmw-noise --features poison` on the Vulcanus resource tests listed in `POISONED_TESTS`. Expected: still red (the hook moved, it did not vanish).
- [ ] **Step 5: Commit** `git commit --message "Move the spot-noise query into a shared module, Vulcanus bit-identical"`.

### Task 3: Aquilo's resource fields

**Files:**
- Create: `crates/fmw-noise/src/expressions/aquilo_resources.rs` (declared in `expressions/mod.rs`)
- Modify: `crates/fmw-noise/src/fixtures.rs` (append tier-1 tests)

**Interfaces:**
- Consumes: `spot_field::{SpotGeometry, SpotRegionCache, spot_cone_max}` (Task 2), `spot_selection::{select_spots, SpotSelectParams}`, `starting_spot_at_angle::{starting_spot_at_angle, StartingSpot, AngleTrig}`, `eval::math::{clamp, max2, min2}`.
- Produces:
  - `pub struct AquiloLevers { pub frequency: f64, pub size: f64 }` (`Default` = 1/1) and `pub struct AquiloResourceControls { pub crude_oil: AquiloLevers, pub lithium_brine: AquiloLevers, pub fluorine_vent: AquiloLevers }`.
  - `pub struct AquiloBearings { pub crude_oil: AngleTrig, pub lithium_brine: AngleTrig, pub fluorine_vent: AngleTrig }` with `pub fn from_host(seed0: u32) -> Self` for tests: base `f32(seed_normalized(seed0) * 3600)`, lithium `f32(base + 120)`, vent `f32(base + 240)`, each through `AngleTrig::from_degrees`.
  - `pub struct AquiloResources` with `new(seed0: u32, controls: &AquiloResourceControls, bearings: AquiloBearings) -> Self` and `eval_at(&self, at: At) -> AquiloResourceFields`.
  - `pub struct AquiloResourceFields` with one `f64` per Task 1 resource field: `starting_crude_oil`, `starting_lithium_brine`, `starting_fluorine_vent`, `starting_fluorine_vent_tiny`, `starting_mask`, `crude_oil_spots`, `lithium_brine_spots`, `fluorine_vent_spots`, `crude_oil_probability`, `lithium_brine_probability`, `fluorine_vent_probability`.

Values from `planet-aquilo-map-gen.lua` at 2.1.23: spot size 30; starting spots at distances 40 / 80 / 160 with radii `30*0.8`, `30*0.6`, `30*0.6`, and the tiny vent at distance 80, radius 1, all with zero distortion; `aquilo_spot_noise` with `seed1 = 567`, counts 4 / 3 / 2, skip offsets 0 / 1 / 2, `skip_span = 3`, spacing 128, `region_size = 600 + 400 / frequency`, density 1, favorability 1, radius `30 * sqrt(size)` scaled by 1, 1.2 and 1.5, quantity `radius^2`, basement -1, `maximum_spot_basement_radius = radius * 2`, `hard_region_target_quantity = 0`; the starting mask `clamp((distance - 300) / 40, -1, 1)`; and the three probability expressions exactly as written, `max` and `min` arguments in Lua order. Richness is not ported (the preview renders placement, not yield). The Aquilo cache key is a private `AquiloSpotKey` holding every spec field the way Vulcanus's does.

- [ ] **Step 1: Write the tier-1 tests** `aquilo_resource_fields_match_the_game_<case>` for `default`, `size0` and `moved`: build the stack at seed 123456 with that case's controls and `AquiloBearings::from_host`, evaluate at each fixture position with `At::point`, and assert per field the count of positions whose f32 bits equal the fixture's, against a frozen constant starting at 0. Also write `a_zero_size_spot_field_is_the_basement_everywhere` (all three spot fields exactly -1.0 and finite at 64 positions with size 0) and `the_three_wells_share_seed1_and_do_not_share_cached_spots` (warm the cache with crude oil, then lithium brine must equal a fresh stack's value).
- [ ] **Step 2: Run** `cargo test --locked -p fmw-noise aquilo_resource -- --nocapture`. Expected: FAIL, printing the measured counts.
- [ ] **Step 3: Implement** `aquilo_resources.rs`. Where a field is below its full count, find the cause before freezing (narrowing points first: the radius `30 * 1.2 * sqrt(size)` is `(30 * 1.2) * sqrt(size)` left to right, each op in f32). Freeze each count with a comment giving today's date and, if short of full, what was tried.
- [ ] **Step 4: Run** the tests. Expected: PASS. Add each `aquilo_resource_fields_match_the_game_*` path to `POISONED_TESTS` and confirm red under `--features poison`.
- [ ] **Step 5: Commit** `git commit --message "Port Aquilo's starting spots, spot fields and well probabilities"`.

### Task 4: Aquilo's terrain fields

**Files:**
- Create: `crates/fmw-noise/src/expressions/aquilo_terrain.rs`, `crates/fmw-noise/src/expressions/aquilo_stack.rs`
- Modify: `crates/fmw-noise/src/fixtures.rs`

**Interfaces:**
- Consumes: `AquiloResources` (Task 3), `multioctave_noise::Prepared`, `quick_multioctave_noise`, `variable_persistence_multioctave_noise::amplitude_corrected_multioctave_noise`, `voronoi_noise::Voronoi` (facet noise and `cell_id`), `eval::math::{lerp_f32, max2, min2}`.
- Produces:
  - `pub struct AquiloTerrainFields { pub wobble_x, pub wobble_y, pub aux, pub island_peaks, pub elevation, pub high_frequency_peaks, pub snow_ice, pub tile_variant: f64 }`.
  - `pub struct AquiloCtx { pub seed0: u32, pub controls: AquiloResourceControls }`.
  - `pub struct AquiloStack` with `new(ctx: &AquiloCtx, bearings: AquiloBearings) -> Self`, `with_host_trig(ctx: &AquiloCtx) -> Self`, and `eval_at(&mut self, at: At) -> AquiloFields`, where `pub struct AquiloFields { pub resources: AquiloResourceFields, pub terrain: AquiloTerrainFields }`.

The stack holds the per-render state (the `Prepared` tables, the three Voronoi fields and their caches, the spot caches), built once per render, as `FulgoraStack` does. Values are the Lua's: `aquilo_segmentation_multiplier = 1`, `segmentation_mult = 1/25`, `aquilo_aux_scale = 1.5`; wobble seeds 12243 and 13243; aux seed 14243 with warp `wobble * 300 / aquilo_aux_scale`; billows seeds 2000 / 3000 / 4000 with `offset_x = 10000`; random island peaks seed 1000, `offset_x = -10000`, 6 octaves, persistence 0.8; Voronoi grids 24 and 10 at `x + wobble_x * 2`; `pow(..., 0.5)` is exact `sqrt` (Stage 0's `oracle-native-ops.json`); `aquilo_high_frequency_peaks` seed 1, 3 octaves, persistence 0.85, input scale 1/6; `aquilo_snow_ice` seed 1, input scale 1/12; `aquilo_tile_variant` seed 100, input scale 1/6. Temperature and moisture are not ported: no Aquilo tile, well or iceberg reads them.

- [ ] **Step 1: Write the tier-1 tests** `aquilo_terrain_fields_match_the_game_<case>` over Task 1's three cases (every `AquiloTerrainFields` field), and `aquilo_elevation_and_aux_match_the_game_at_default_levers` over `oracle-aquilo-fields.seed123456.json`'s 1,024 positions. Frozen counts start at 0.
- [ ] **Step 2: Run** `cargo test --locked -p fmw-noise aquilo_terrain aquilo_elevation -- --nocapture`. Expected: FAIL, printing counts.
- [ ] **Step 3: Implement**, layer by layer in dependency order: wobble, aux, high-frequency peaks, snow and tile variant, island peaks, then elevation. Grade each layer before starting the next, so a miss lands on the layer that caused it. Evaluate the Voronoi fields and `aux` at `At::Point` of the warped coordinate, and the plain multioctave fields at the `At` they were given.
- [ ] **Step 4: Freeze, then run.** Expected: PASS. Add the new paths to `POISONED_TESTS` and confirm red under poison.
- [ ] **Step 5: Commit** `git commit --message "Port Aquilo's elevation, aux and the two tile-variety fields"`.

### Task 5: The 9-tile catalog

**Files:**
- Create: `crates/fmw-noise/src/tiles/aquilo_catalog.rs` (declared in `tiles/mod.rs`)
- Modify: `crates/fmw-noise/src/fixtures.rs`

**Interfaces:**
- Consumes: `AquiloTerrainFields` (Task 4), the argmax helper in `tiles/helpers.rs` that Fulgora and Vulcanus use.
- Produces: `pub enum AquiloTile` with nine variants in this `TILE_ORDER`: `snow-flat`, `snow-crests`, `snow-lumpy`, `snow-patchy`, `ice-rough`, `ice-smooth`, `brash-ice`, `ammoniacal-ocean`, `ammoniacal-ocean-2` (the planet's `autoplace_settings.tile` order); `AquiloTile::game_name(self) -> &'static str`; `AquiloTile::color(self) -> [u8; 3]`; `pub fn probabilities(f: &AquiloTerrainFields) -> [f64; 9]`; `pub fn resolve_tile(f: &AquiloTerrainFields) -> AquiloTile`. `AquiloFields::tile(&self) -> AquiloTile` in `aquilo_stack.rs`.

The nine expressions are the Lua's tile expressions (`snow_flat` to `ice_smooth`, `brash_ice`, `ammoniacal_ocean`, `ammoniacal_ocean_2`), with `aquilo_min_elevation(t) = -1 + 2 * (elevation > t)`. `dust-lumpy` has an autoplace but is not in Aquilo's tile settings, so it is excluded. Colours are each tile's `map_color` in `tiles-aquilo.lua`: ammoniacal ocean (15, 13, 25), ammoniacal ocean 2 (17, 15, 30), brash ice (21, 42, 56), ice rough and ice smooth both (100, 135, 177), snow-flat (190, 194, 197), snow-patchy (156, 166, 181), and snow-crests and snow-lumpy from `lerp_color_no_alpha(high, low, 0.3)` and `(high, low, 0.7)`. Copy that function's rounding from the data Lua rather than guessing it. Task 9's PNG comparison is the check on every colour.

- [ ] **Step 1: Write the tests** `aquilo_tile_scores_match_the_game` (all 9 scores at `oracle-aquilo-fields`' 1,024 positions plus Task 1's three cases, an exact count per tile), and `aquilo_tile_winner_matches_the_game` (the argmax of the fixture's own scores against our `resolve_tile`, frozen count; the fixture reports 0 ties).
- [ ] **Step 2: Run, implement, freeze, run** as in Task 3. Expected: PASS. Add both to `POISONED_TESTS`.
- [ ] **Step 3: Commit** `git commit --message "Add Aquilo's 9-tile catalog"`.

### Task 6: The well and iceberg overlays

**Files:**
- Create: `crates/fmw-noise/src/resources/aquilo_wells.rs`, `crates/fmw-noise/src/rocks/aquilo_icebergs.rs` (declared in their `mod.rs`)
- Modify: `crates/fmw-noise/src/placement/roll.rs` (two salts)

**Interfaces:**
- Consumes: `AquiloStack` and `AquiloFields` (Tasks 3 to 5), `placement::roll::{PlacementSource, PlacementSet, PlacementCollisionBox}`.
- Produces:
  - `salt::AQUILO_WELLS` and `salt::AQUILO_ICEBERGS`: new arbitrary values distinct from the nine existing salts, with a one-line doc each.
  - `pub enum AquiloWell { CrudeOil, LithiumBrine, FluorineVent }` with `color(self) -> [u8; 3]`; `pub struct AquiloWellPlacement<'a>` with `new(stack: &'a RefCell<AquiloStack>) -> Self`, `winner(&self, x, y) -> Option<AquiloWell>`, `placement_set(&self) -> PlacementSet<'_>`.
  - `pub struct AquiloIcebergPlacement<'a>` with the same shape, for `lithium-iceberg-huge` (probability `(high_frequency_peaks - 0.8) * 0.1`, box 3.7 x 2.5) and `lithium-iceberg-big` (`(high_frequency_peaks - 0.7) * 0.8`, box 2.0 x 1.5).

Each overlay's `probability` is the larger of its prototypes' probabilities, clamped to [0, 1], and the winner is the prototype that gives it, as `rocks/nauvis_placement.rs` does for its three rocks. The three wells' boxes are 2.8 x 2.8 (`collision_box` +-1.4 in `resources.lua`). `tile_allowed` follows Task 1's census: an entity kind that the census shows on a tile class is allowed there, and one it never shows on a class is gated off it. Write the census numbers in the module doc. Colours: each well's `map_color` from `space-age/prototypes/entity/resources.lua` (and `base` for crude oil); the iceberg colour is read off the game's full PNG in Task 9 Step 1, not guessed. Until then use a placeholder and leave a failing test that names it.

- [ ] **Step 1: Write the tests:** `the_tiny_vent_is_placed_on_every_seed` (for seeds 123456, 1, 4000000000 at default levers, `placed` is true at the tiny vent's centre `(80 * sin, -80 * cos)` of the vent bearing, rounded to its tile); `wells_and_icebergs_place_on_a_real_window` (a 512x512 window at the derived seed places at least one of each overlay); `the_well_overlay_is_a_pure_function_of_position` (two `PlacementSet`s asked in different orders agree on 4,096 tiles).
- [ ] **Step 2: Run, implement, run.** Expected: PASS.
- [ ] **Step 3: Commit** `git commit --message "Add Aquilo's well and iceberg overlays"`.

### Task 7: The Aquilo ABI block and render entry

**Files:**
- Modify: `crates/fmw-wasm/src/abi.rs` (layout doc table, `PLANET_AQUILO`, `AQUILO_PARAMS_BYTES`, `AquiloParams`, `Params::Aquilo`, decode, the "three planets" test at `:969`)
- Modify: `crates/fmw-wasm/src/render.rs` (`PLANET_AQUILO = 3`, `VIEW_ENTITY_FOOTPRINT = 12`, the `supported` match, `render_aquilo`, `pub(crate) fn aquilo_stack(seed0: u32, p: &AquiloParams) -> AquiloStack`)
- Modify: `src/noise/wasm/request.ts` (`PLANET.aquilo = 3`, `VIEW.entityFootprint = 12`, `AquiloRenderRequest`, `aquiloBearingTrig(seed0)`, `writeAquiloParams`, the dispatch arms)
- Modify: `test/fixtures/verify-wasm-request.py` (`decode_aquilo`), `test/fixtures/wasm-request.v2.json` (an `aquilo` arm), `test/wasmFulgoraRenderParity.spec.ts:278-327` (the per-planet byte and length assertions gain Aquilo)

**Interfaces:**
- Produces the block layout (128 bytes, so an Aquilo request is 184):

```text
aquilo block (128 bytes)
 +0  f64  crude_oil_frequency
 +8  f64  crude_oil_size
+16  f64  lithium_brine_frequency
+24  f64  lithium_brine_size
+32  f64  fluorine_vent_frequency
+40  f64  fluorine_vent_size
+48  f64 x 6   trig: (sin, cos) for the crude oil, lithium brine and fluorine vent bearings
+96  f64 x 4   placement_sweep_box: x0, y0, x1, y1 (same meaning as Vulcanus's)
```

- `aquiloBearingTrig(seed0)` returns three `{ sin, cos }` through `trigOf`, with angles `base = f32(seedNormalized(seed0) * 3600)`, `f32(base + 120)` and `f32(base + 240)`.
- `request.ts` exports `interface AquiloResourceControls { readonly crudeOil?: AquiloLevers; readonly lithiumBrine?: AquiloLevers; readonly fluorineVent?: AquiloLevers }` with `interface AquiloLevers { readonly frequency?: number; readonly size?: number }`. `AquiloRenderRequest` carries `aquiloResourceControls?: AquiloResourceControls`, and the writer substitutes the neutral 1 for anything absent (as `writeFulgoraParams` does for scrap).
- `render_aquilo` serves `VIEW_TERRAIN`, `VIEW_RESOURCES` (terrain, then wells), `VIEW_ROCKS` (terrain, then icebergs), `VIEW_ALL` (terrain, wells, then icebergs), and `VIEW_ENTITY_FOOTPRINT` (white where any well or iceberg probability is above 0, black elsewhere; for Task 9's superset check, never offered by the panel). Every other view returns the unsupported status.

- [ ] **Step 1: Write the failing checks:** the Aquilo arm in `wasm-request.v2.json` (planet aquilo, seed 3111923328, a 8x4 window, moved sliders) with bytes decoded by `verify-wasm-request.py` from the layout table above, not produced by the writer; the abi test that decodes it; `refuses a planet that has a PLANET code but no params arm` still red for a made-up code 4.
- [ ] **Step 2: Implement** both sides. Rebuild with `bash scripts/build-wasm.sh`.
- [ ] **Step 3: Run** `python3 test/fixtures/verify-wasm-request.py`, `cargo test --locked -p fmw-wasm abi`, `pnpm vp test test/wasmFulgoraRenderParity.spec.ts`. Expected: PASS. `REQUEST_BYTES` stays Nauvis's 568.
- [ ] **Step 4: Commit** `git commit --message "Add the Aquilo ABI block and render entry"`.

### Task 8: Tier 2 for Aquilo, native and WASM

**Files:**
- Modify: `crates/fmw-noise/src/expressions/aquilo_stack.rs` (`AquiloParity` with `FIELD_COUNT` and `field(i, x, y) -> f64`)
- Modify: `crates/fmw-wasm/src/lib.rs` (`checksum_aquilo(request_len: u32, field: u32) -> u64` and `aquilo_field_count() -> u32`, beside `checksum_vulcanus`, built through `render::aquilo_stack`)
- Modify: `crates/fmw-wasm/src/native_parity.rs` (an Aquilo section)
- Create: `test/wasmAquiloParity.spec.ts`; Modify: `test/fixtures/tier2-checksums.json` (an `aquilo` section)

**Interfaces:**
- `AquiloParity` fields, in this order, are every `AquiloResourceFields` and `AquiloTerrainFields` field plus the nine tile scores. The spec's `const FIELD_NAMES = [ ... ];` block lists them one per line, which is what `native_parity.rs` scans.
- Two cases, each a 26x26 window at 7.3 tiles/px from (-613.5, 428.25), seed 3111923328: `default sliders` and `moved sliders` (Task 1's `moved` values). The native test takes the `aquilo` arm's committed bytes from `wasm-request.v2.json`, sets the window and the slider f64s at the offsets in Task 7's table, and folds; the spec encodes the same requests with `encodeRenderRequest`.

- [ ] **Step 1: Write** `test/wasmAquiloParity.spec.ts` on `test/wasmVulcanusParity.spec.ts`'s pattern (field count from the module, a rejected request folds 0, no NaN in any fold), with frozen values written on the first run. Write the native test to compare each native fold with the frozen value by field name.
- [ ] **Step 2: Run** `pnpm vp test test/wasmAquiloParity.spec.ts` and `cargo test --locked -p fmw-wasm native_parity`. Expected: PASS. Plant a break (drop one f32 narrowing in `aquilo_resources.rs`), confirm the native test goes red, and revert.
- [ ] **Step 3: Commit** `git commit --message "Freeze Aquilo's tier-2 folds and check native against them"`.

### Task 9: Tier 3 against the game's preview PNGs

**Files:**
- Create: `test/wasmAquiloRenderParity.spec.ts`
- Modify: `test/fixtures/tier3-render-checksums.json` (an `aquilo:render` section)

Model the file on `test/wasmFulgoraRenderParity.spec.ts` (about 16s on CI), not on the Vulcanus overlay spec.

- [ ] **Step 1: Measure the game's entity pixels first.** List the RGB values in `oracle-preview-aquilo-full.seed123456.png` that are not one of the nine tile colours, with counts. Expected: the three well colours and one iceberg colour. Put the iceberg colour into `AquiloIcebergPlacement` (Task 6's placeholder test now passes). If some other colour appears, stop and report it.
- [ ] **Step 2: Write the specs:**
  - `differs from the game's terrain PNG on exactly the frozen pixel count`: 1024x1024 at 1 tile/px, the same window and origin the Fulgora PNG spec uses, seed 3111923328, all three controls at size 0, view terrain. Assert the reference has no entity-coloured pixels, then freeze the differing count. It must be below 1,048.
  - `matches the full PNG on the tiles the game drew`: the same window at default levers, compared only on pixels whose game colour is a tile colour and that are not within 3 pixels of an entity-coloured pixel. Define that mask once and pass the same mask to the counter and to `withDiffArtifacts`'s `ignore`. Freeze the count.
  - `the footprint contains every entity pixel the game drew`: our `entityFootprint` view at default levers, dilated by `PLACEMENT_MARK_RADIUS_PX`, covers every entity-coloured game pixel. Freeze the game's entity pixel count and assert 0 outside. Also assert the footprint is neither empty nor more than 10% of the window.
  - `renders to its frozen bytes` for terrain, resources, rocks and all on two 128x128 windows chosen so each holds at least one well mark and one iceberg mark (assert that, then compare digests with `aquilo:render`).
  - `tiled equals whole for the all view`: a 256x256 render as one request against the same window as four 128x128 requests with the halo-widened `placement_sweep_box` the worker pool sends.
  - `each slider crosses the ABI`: moving any one of the six levers changes the all-view picture.
- [ ] **Step 3: Run** `pnpm vp test test/wasmAquiloRenderParity.spec.ts`. Read the terrain gap. If it is 1,048 or more, find the cause (the first suspect is a lever or seed mismatch between capture and render; see the `a-frozen-count-can-be-a-lever-mismatch` lesson in `docs/rust-wasm-port.md`) before freezing. Freeze, re-run, expect PASS. Record the spec's wall time.
- [ ] **Step 4: Commit** `git commit --message "Grade Aquilo against the game's preview PNGs"`.

### Task 10: Wire Aquilo into the app, then turn it on

**Files:**
- Modify: `src/model/resourceReads.ts` (`readAquiloResourceControls`), `src/model/elevationPreviewCtx.ts` (an `aquiloResourceControls` field), `src/components/ElevationPreviewPanel.vue` (pass it), `src/noise/preview/elevationRenderRequest.ts` (`aquiloResourceControls?` on the request, `renderAquiloThroughWasm`, the dispatch branch), `src/model/planetCapabilities.ts`
- Test: `test/planetCapabilities.spec.ts`, `test/elevationRenderRequest.spec.ts`, the panel spec that covers the "not available" message

**Interfaces:**
- `readAquiloResourceControls(preset: { autoplaceControls: Record<string, AutoplaceSetting> }): AquiloResourceControls` (Task 7's type) reads `aquilo_crude_oil`, `lithium_brine` and `fluorine_vent`, defaulting each to `{ frequency: 1, size: 1 }`.
- The final table row: `aquilo: { rendered: true, views: ["terrain", "resources", "rocks", "all"], fallToTerrain: ["enemies", "cliffs", "trees", "landmask"] }`.

- [ ] **Step 1: Write the tests:** a preset with none of the three controls reads as neutral 1/1 (Review Focus 4), and one with `lithium_brine` size 0 reads size 0; `runRenderRequest({ planet: "aquilo", view: "all" })` with a stub engine sends planet code 3 and the preset's levers; `view: "cliffs"` is served as terrain; the elevation views throw `unsupportedPair`; the panel shows Aquilo's four toggles and no "not available" message; Gleba still shows "Client preview is not available for Gleba yet."
- [ ] **Step 2: Implement** the reader, the ctx field, the dispatch branch, and the panel wiring. Flip the capability row LAST, after the dispatch branch exists.
- [ ] **Step 3: Run** `pnpm vp test test/planetCapabilities.spec.ts test/elevationRenderRequest.spec.ts` and `pnpm run check:vue`. Expected: PASS.
- [ ] **Step 4: Look at it.** Run `pnpm vp dev --port 5199 --strictPort`, pick Aquilo, and confirm each of the four views draws and the three sliders move the islands. Note what you saw in the task report.
- [ ] **Step 5: Commit** `git commit --message "Render Aquilo in the preview"`.

### Task 11: Docs, gate, PR and CI cost

**Files:**
- Modify: `docs/rust-wasm-port.md` (the ABI table, an Aquilo section with every frozen count and what each tier grades; say plainly that `aquilo:render` digests are a self-snapshot, not a correctness grade)
- Modify: `docs/noise/spot-noise-NOTES.md` (the shared module, and Aquilo's `maximum_spot_basement_radius = radius * 2`)
- Create: `docs/noise/aquilo-NOTES.md` (the findings from Tasks 1, 3, 4 and 9: lever effects, anything below a full count and why)

- [ ] **Step 1: Write the docs.** If the terrain gap is above 0, or any tier-1 count is short of full, file one issue per cause with the numbers and link it from the notes.
- [ ] **Step 2: Run** `pnpm run verify`. Expected: exit 0.
- [ ] **Step 3: Open the PR** linking #454, listing each frozen count and each filed issue. End it with the session's attribution lines.
- [ ] **Step 4: Read CI cost** across three runs of the PR (open, amend, push): the `rust` job and the slowest test shard, against the last three `main` runs (commands in CLAUDE.md "verify:rust's cost is a RANGE"). If either median rises by more than 2 minutes, stop and report before merging.
- [ ] **Step 5: Read CodeRabbit's review body** (count from `Actionable comments posted: N`) and answer every finding.
