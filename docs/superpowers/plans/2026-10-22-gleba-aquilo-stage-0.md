# Gleba and Aquilo, Stage 0 (shared setup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repo ready to add Gleba and Aquilo: fix the planet routing so an unported planet can never render as Nauvis or Fulgora, drive the panel from one planet table, add a native-versus-WASM check, extend the spot cache key, and capture every game fact Stages 1 to 3 need.

**Architecture:** Three kinds of work. (1) TypeScript routing: an explicit planet on every WASM request, a `PLANET_CAPABILITIES` table that the panel and `runRenderRequest` both read. (2) Rust: a native test that recomputes Fulgora's tier-2 folds, a widened spot-cache key, and a diagnostic of the last differing pixel. (3) `factorio-oracle` probes under `scripts/probes/` that capture fixtures at 2.1.23 (and 2.0.77 where cheap), plus new preview PNGs. No Gleba or Aquilo rendering ships in this stage.

**Tech Stack:** Vue 3 + TypeScript (Vite+, `pnpm vp test`), Rust workspace `crates/` (`fmw-noise`, `fmw-wasm`), `factorio-oracle` CLI, Factorio 2.1.23 and 2.0.77 headless.

**Spec:** `docs/superpowers/specs/2026-10-22-gleba-and-aquilo-design.md`

## Global Constraints

- Work on branch `gleba-aquilo-stage-0` off `main`. Commit the spec as the branch's first commit. `main` takes changes only by PR.
- Gate before every PR: `pnpm run verify` must exit 0. Any Rust source change needs `bash scripts/build-wasm.sh` and the rebuilt `src/noise/wasm/engine.wasm` committed.
- Frozen counts for Nauvis, Vulcanus and Fulgora must not move. If one moves, stop and report it; never edit a fixture or expected value to pass.
- Probe installs on tealc: 2.1.23 root `/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio` (nested), 2.0.77 root `/home/eric/factorio-headless-2.0.77`. Always pass `--factorio <root>` AND `--version <v>`; assert the report's `provenance.buildLine` contains the version. Oracle binary: `~/.cargo/bin/factorio-oracle`.
- For `test/oracle/previewCompare.ts` on 2.1.23, set `FACTORIO_BIN=/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio/bin/x64/factorio` and `FACTORIO_DATA_DIR=/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio/data` on the command (the shell's `FACTORIO_DATA_DIR` points at the factorio-data clone, which is wrong here).
- Every new file under `test/fixtures/` gets a `test/fixtures/PROVENANCE.json` entry (`factorioVersion`, `evidence` naming the probe, the `buildLine`, the date, and `versionDifferences` when two versions ran). `maxUnknown` stays 0.
- Tier-1 captures FORCE the surface seed (`mgs.seed = 123456`). Anything compared with a preview PNG uses the DERIVED surface seed: Gleba 3215206427, Aquilo 3111923328, Nauvis 123456, Vulcanus 1249936247 (map seed 123456).
- Sample positions are multiples of 1/256.
- New probes copy the shape of `scripts/probes/autoplace-can-be-disabled/` (mod, asserts as controls) and the runner shape of `scripts/probes/vulcanus-cliff-volcanism/capture.ts:307-365` (keep the oracle error as `cause`). Dump with `helpers.write_file("oracle-dump.json", helpers.table_to_json(t))` then `error("DUMPED-OK")`.
- Rust: no `mul_add`, `min2`/`max2` for every min/max, new tests pass `clippy --all-targets --all-features -D warnings` and `cargo doc --document-private-items`. New `#[cfg(test)]` modules in `fmw-wasm` go at the END of `lib.rs` so `core::panic::Location` records do not move.
- Prose in docs and PR bodies: hyphens, never em or en dashes; 12th-grade reading level or below.

## Review Focus

1. A request whose `planet` is a cast string such as `"gleba"` must throw in `encodeRenderRequest`, not encode a valid Fulgora request (today it does). Test in Task 2.
2. Selecting Gleba or Aquilo in the panel after a render must show "Client preview is not available for Gleba yet." and must not call the renderer. Test in Task 4.
3. `runRenderRequest({ planet: "aquilo", view: "all" })` must throw `/no renderer for planet aquilo/`, not paint Nauvis (today it paints Nauvis). Test in Task 3.
4. A probe whose `--factorio` path does not resolve must fail, not silently run Steam 2.0.77. Every runner in Tasks 7 to 12 asserts `buildLine`.
5. A spot cache warmed by one spec must not answer for another spec sharing `seed1` but with a different region size or skip offset. Test in Task 6.

---

### Task 1: The last-pixel diagnostic (our side)

**Files:**
- Modify: `crates/fmw-noise/src/fixtures.rs` (append tests)
- Modify: `docs/noise/tile-correction-NOTES.md` (new section "The last differing pixel on Nauvis and Vulcanus")

**Interfaces:**
- Consumes: `NauvisCtx::defaults(seed)` (`expressions/nauvis_stack.rs:137`), `NauvisStack::new(&ctx)`, `NauvisTileCatalog::new(seed)`, `NauvisTileCatalog::probabilities(&NauvisTileFields) -> [f64; 21]` (`tiles/nauvis_catalog.rs:244`), `TILE_ORDER`; `EvalCtx::new(seed)`, `VulcanusBase::with_host_trig`, `biomes_with_host_trig`, `VulcanusStack::with_host_trig`, `VulcanusStack::tile_probabilities_at(At) -> [f64; 19]` (`vulcanus_stack.rs:383`); `At::tile(x, y)`.
- Produces: two frozen tests and a `top_two_gap_ulps(probs: &[f64]) -> (usize, usize, u64)` test helper (winner index, runner-up index, gap in f32 ULPs at the winner's magnitude).

- [ ] **Step 1: Write `the_last_nauvis_pixel_is_a_known_argmax` and `the_last_vulcanus_pixel_is_a_known_argmax`.** Nauvis: seed 123456, `At::tile(229, -19)`, `NauvisTileFields { x: 229.0, y: -19.0, elevation, aux, moisture, grid: true }` from the stack's `eval_at`. Vulcanus: seed 1249936247 with the four `vulcanus_resource_controls` at `size: 0.0, frequency: 1.0` (layout as `render.rs:401-406`), `At::tile(-361, 11)`. Each asserts the winner's tile name (Nauvis `grass-3`, Vulcanus `volcanic-cracks-warm`, i.e. what we render today), the runner-up's name (expected `grass-1` and `volcanic-cracks`, the game's choice), and the gap in ULPs equal to a frozen constant. Start the constant at `0` so the first run fails and prints the real value.
- [ ] **Step 2: Run** `cargo test --locked -p fmw-noise the_last_ -- --nocapture`. Expected: FAIL showing the measured gap (and the names, if either guess is wrong - if the runner-up is not the game's tile, record that; it is a finding, not a test bug).
- [ ] **Step 3: Freeze** the measured gaps and any corrected names, with a comment stating the result and today's date.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then plant a one-ULP change by running under `--features poison` and confirm both go red; add both full paths to `POISONED_TESTS` in `scripts/verify-rust.sh` with the comment "f64_result hooks on the elevation, aux and moisture fields move the gap".
- [ ] **Step 5: Write the notes section** with both gaps and what they mean: a gap of a few ULPs means a rounding near-tie; a large gap means a step after tile choice. Leave the conclusion open until Task 7 reports.
- [ ] **Step 6: Commit** `git commit --message "Freeze the top-two tile scores at the last Nauvis and Vulcanus pixel"`.

### Task 2: Every WASM request names its planet

**Files:**
- Modify: `src/noise/wasm/request.ts:128` (make `FulgoraRenderRequest.planet` required), `:414-451` (no default; unknown planet throws)
- Modify: `src/noise/preview/elevationRenderRequest.ts:404-419` (`renderFulgoraThroughWasm` passes `planet: "fulgora"`)
- Modify: `test/fixtures/wasm-request.v2.json` (add `"planet": "fulgora"` to the fulgora arm), `test/fixtures/verify-wasm-request.py:89` (require the key)
- Modify: every test call site that omits `planet` for a Fulgora request: `test/fulgoraSurfaceSeed.spec.ts:46,113`, `test/fulgoraLandMaskRender.spec.ts:54,56`, `test/wasmFulgoraRenderParity.spec.ts` (all sites, including `:321-331`)
- Test: `test/wasmFulgoraRenderParity.spec.ts` ("the request encoding is pinned on both sides" block)

**Interfaces:**
- Produces: `encodeRenderRequest(target: Uint8Array, req: WasmRenderRequest): number` throws `Error("unknown planet <name> in render request")` when `req.planet` is not a key of `PLANET`. `PLANET` is unchanged (`fulgora: 0, vulcanus: 1, nauvis: 2`).

- [ ] **Step 1: Write the failing test** `it("refuses a planet the engine has no block for, rather than encoding it as Fulgora")`: `expect(() => encodeRenderRequest(buf, { ...fulgoraReq, planet: "gleba" } as never)).toThrow(/unknown planet gleba/)`.
- [ ] **Step 2: Run** `pnpm vp test test/wasmFulgoraRenderParity.spec.ts -t "refuses a planet"`. Expected: FAIL (no throw).
- [ ] **Step 3: Implement** in the order that keeps bytes identical: add `planet: "fulgora"` to `renderFulgoraThroughWasm`, the JSON fixture's fulgora arm and every test site above; make the field required; replace the `?? "fulgora"` default with a lookup that throws; make the `.py` checker require the key.
- [ ] **Step 4: Run** `pnpm vp test test/wasmFulgoraRenderParity.spec.ts test/fulgoraSurfaceSeed.spec.ts test/fulgoraLandMaskRender.spec.ts` and `python3 test/fixtures/verify-wasm-request.py`. Expected: PASS, with the committed request bytes unchanged (the planet code for Fulgora is 0 either way).
- [ ] **Step 5: Commit** `git commit --message "Require an explicit planet on every WASM render request"`.

### Task 3: A planet capability table, and refuse unported planets

**Files:**
- Create: `src/model/planetCapabilities.ts`
- Modify: `src/noise/preview/elevationRenderRequest.ts` (`servedView` at `:595-610`, `runRenderRequest` at `:627-737`)
- Test: `test/planetCapabilities.spec.ts` (new), `test/elevationRenderRequest.spec.ts`, `test/viewNormalisation.spec.ts`

**Interfaces:**
- Consumes: `Planet`, `PLANETS` from `src/model/planets.ts`.
- Produces:
  ```ts
  export type PreviewView = "elevation" | "terrain" | "resources" | "enemies" | "cliffs" | "trees" | "rocks" | "all";
  export interface PlanetCapability {
    /** false = "Client preview is not available for <label> yet." */
    readonly rendered: boolean;
    /** Views the engine renders for this planet, in toggle order. */
    readonly views: readonly PreviewView[];
    /** Views that render this planet's terrain instead (what servedView does today). */
    readonly fallToTerrain: readonly (PreviewView | "landmask")[];
  }
  export const PLANET_CAPABILITIES: Readonly<Record<Planet, PlanetCapability>>;
  ```
  Values, copied from today's behaviour: nauvis `rendered: true`, views all eight, fallToTerrain `["landmask"]`; vulcanus views `["terrain","resources","cliffs","rocks","all"]`, fallToTerrain `["enemies","trees","landmask"]`; fulgora views `["terrain","all"]`, fallToTerrain `["enemies","cliffs","trees","rocks"]`; gleba and aquilo `rendered: false`, views `[]`, fallToTerrain `[]`.

- [ ] **Step 1: Write failing tests.** In `test/planetCapabilities.spec.ts`: the table has exactly the five `PLANETS` keys; every `fallToTerrain` entry is absent from `views`; `rendered` is false exactly when `views` is empty. In `test/elevationRenderRequest.spec.ts`: `it.each(["gleba","aquilo"])("refuses planet %s rather than painting Nauvis", ...)` expects `runRenderRequest({ ...REQ, planet, view: "all" }, engine)` to throw `/no renderer for planet gleba/` (and aquilo). Add the four Fulgora fall-through pairs to `FALL_THROUGH` in `test/viewNormalisation.spec.ts:58-63`.
- [ ] **Step 2: Run** `pnpm vp test test/planetCapabilities.spec.ts test/elevationRenderRequest.spec.ts test/viewNormalisation.spec.ts`. Expected: FAIL (module missing; gleba renders Nauvis).
- [ ] **Step 3: Implement** the table, make `servedView` read `fallToTerrain`, and make `runRenderRequest` throw `unsupportedPair(planet, view)` first thing when `!PLANET_CAPABILITIES[planet].rendered`. Keep the Nauvis default for an absent `planet` in `runRenderRequest` (Nauvis tests rely on it).
- [ ] **Step 4: Run** the three files, then `pnpm vp test test/wasmNauvisRenderParity.spec.ts test/wasmVulcanusRenderParity.spec.ts test/wasmFulgoraRenderParity.spec.ts`. Expected: PASS, every frozen count unchanged.
- [ ] **Step 5: Commit** `git commit --message "Route preview views through one planet capability table"`.

### Task 4: The panel reads the capability table

**Files:**
- Modify: `src/components/ElevationPreviewPanel.vue` (`supported` `:78-82`, `unsupportedMessage` `:84-93`, `nauvisOverlaysAvailable` `:135-137`, `terrainAvailable` and the other `*Available` `:138-152`, `effectiveView` `:182-198`, the Elevation button `:357-360`)
- Modify: `src/components/IslandFinderPanel.vue:131` only if it reads cleanly from the table; otherwise leave it.
- Test: `test/elevationPreviewPanel.spec.ts`

**Interfaces:**
- Consumes: `PLANET_CAPABILITIES`, `PreviewView` from Task 3.

- [ ] **Step 1: Write failing tests** in a new `describe("planets with no renderer")`: for gleba and aquilo, after mounting with a supported Nauvis preset and switching the `planet` prop from `"nauvis"` (rendered once) to the planet: the `[data-test="unsupported"]` text is `Client preview is not available for Gleba yet.` (and `Aquilo`), the renderer spy is not called again, and `[data-test="generate"]` is disabled. Add to `describe("planet: fulgora ...")`: with dev mode on, `[data-test="view-elevation"]` is disabled (today it is enabled and silently renders "all").
- [ ] **Step 2: Run** `pnpm vp test test/elevationPreviewPanel.spec.ts`. Expected: the Fulgora elevation test FAILS; the gleba/aquilo tests may pass already (they pin behaviour the refactor must keep).
- [ ] **Step 3: Implement.** For non-Nauvis planets, availability of view `v` is `PLANET_CAPABILITIES[planet].views.includes(v)`. Nauvis keeps its map-type rules (`nauvisMapType`, the elevation-only note, the starting-point limit). `supported` is `PLANET_CAPABILITIES[planet].rendered` for non-Nauvis planets. `effectiveView` for non-Nauvis planets returns `view` when dev mode is on and the view is in `views`, else `"all"`. Keep every existing disabled-button `title` text.
- [ ] **Step 4: Run** `pnpm vp test test/elevationPreviewPanel.spec.ts test/app.spec.ts` then `pnpm run check:vue`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** `git commit --message "Drive the preview panel's planet gating from the capability table"`.

### Task 5: Native folds match the WASM folds (the new tier 2)

**Files:**
- Create: `crates/fmw-wasm/src/native_parity.rs`
- Modify: `crates/fmw-wasm/src/lib.rs` (append `#[cfg(test)] mod native_parity;` as the LAST line)
- Modify: `docs/rust-wasm-port.md` (a short "Native against WASM" subsection under the tiers)

**Interfaces:**
- Consumes: `checksum_fulgora(seed0, islands_frequency, islands_size, sin_start, cos_start, sin_vault, cos_vault, field, x0, y0, step, n) -> u64` (`lib.rs:830`), `fulgora_field_count()`; `test/fixtures/tier2-checksums.json` via `include_str!`.
- Produces: `native_fulgora_folds_match_the_frozen_wasm_folds` test.

- [ ] **Step 1: Write the test.** Inputs exactly as `test/wasmFulgoraParity.spec.ts:77-104`: `SEED0 = 2967702466`, `X0 = -613.5`, `Y0 = 428.25`, `STEP = 7.3`, `N = 26`, cases "default sliders" (1, 1) and "frequency 2, size 3" (2, 3). Trig as V8's bits: `sin_start = f64::from_bits(0xbfd803dd1d123eec)`, `cos_start = 0x3feda967ce0fc3d1`, `sin_vault = 0x3fd803dd1d138d52`, `cos_vault = 0xbfeda967ce0f8021`. For each case compare the SORTED list of 76 native folds against the sorted 76 frozen values under `"fulgora"` whose key starts with `"<case label> | "` (parse the hex strings; no JSON crate - a small string scan is enough).
- [ ] **Step 2: Run** `cargo test --locked -p fmw-wasm native_fulgora -- --nocapture`. Expected: PASS. Then prove it discriminates: temporarily add a `#[cfg(not(target_arch = "wasm32"))]` one-ULP nudge to one Fulgora field reached by the "frequency 2, size 3" case (one that goes through `slider_rescale`), run again, expect FAIL, and revert. Record the planted line and the failure in the commit message.
- [ ] **Step 3: Write the docs subsection**: what it compares (point path only, not `At::Grid`), that native equals frozen and WASM equals frozen together imply native equals WASM, and that it is not in the poison run.
- [ ] **Step 4: Run** `bash scripts/verify-rust.sh`. Expected: exit 0, `engine.wasm` not stale.
- [ ] **Step 5: Commit** `git commit --message "Compare native Fulgora folds with the frozen WASM folds"`.

### Task 6: The spot cache key carries the whole spot spec

**Files:**
- Modify: `crates/fmw-noise/src/expressions/vulcanus_resources.rs` (`:239`, `:357`, `:487-532`, module doc `:28-42`)
- Rebuild: `src/noise/wasm/engine.wasm`

**Interfaces:**
- Produces: a `SpotCacheKey { seed1: u32, region_size_bits: u64, skip_span: u32, skip_offset: u32, candidate_spot_count: u32, region_x: i64, region_y: i64 }` (derive `Ord`) replacing `(u32, i64, i64)`. Add any `SpotSpec` field that shapes `select_spots` and is not listed here; `favor` and `size_rescaled` are fields of the spec, so include a stable identity for them too (their `to_bits`).

- [ ] **Step 1: Write the failing test** `two_specs_sharing_seed1_do_not_share_cached_spots` in the module's `tests`: build two `SpotSpec`s with the same `seed1` and different `region_size`, query the first then the second on one instance (warm), and the second alone on a fresh instance (cold); assert warm == cold. Copy the cold-against-warm shape from `resources/starting_patches.rs:485`.
- [ ] **Step 2: Run** `cargo test --locked -p fmw-noise two_specs_sharing_seed1`. Expected: FAIL.
- [ ] **Step 3: Implement** the key. Update the module doc's "one map rather than four" paragraph.
- [ ] **Step 4: Run** `cargo test --locked -p fmw-noise vulcanus` (including `fixtures::reproduces_the_vulcanus_resource_layer_at_every_captured_position` with its 15 frozen counts), `bash scripts/build-wasm.sh`, then `pnpm vp test test/wasmVulcanusParity.spec.ts test/wasmVulcanusRenderParity.spec.ts`. Expected: PASS, no frozen count or row moved (today's four `seed1` values 789, 782349, 749, 759 are distinct, so output must be bit-identical).
- [ ] **Step 5: Commit** `git commit --message "Key the spot cache on the whole spot spec, not seed1 alone"` with the rebuilt `engine.wasm`.

### Task 7: Probe - does the preview PNG run tile correction?

**Files:**
- Create: `scripts/probes/preview-tile-correction/{capture.ts,README.md}`
- Create: `test/fixtures/oracle-preview-tile-correction.json` + PROVENANCE entry
- Modify: `docs/noise/tile-correction-NOTES.md` (answer the open question, or say what the probe showed)

**Interfaces:**
- Consumes: Task 1's two tiles; `test/fixtures/oracle-preview-{nauvis,vulcanus,fulgora}-terrain.seed123456.png` (tile `(x, y)` is pixel `(x + 512, y + 512)`, `decodePng` RGB stride 3).
- Produces: per target tile: `getTileFilled` (3x3 chunks generated around it), `getTileIsolated` (only its own chunk, `request_to_generate_chunks(p, 0)`), each candidate tile's `map_color`, and the PNG pixel colour.

- [ ] **Step 1: Write the probe.** Derived surface seed (drop the `mgs.seed` line). Targets: Nauvis (229, -19), Vulcanus (-361, 11), plus a POSITIVE CONTROL: one Fulgora tile where `test/fixtures/oracle-fulgora-tiles` disagrees with the engine's raw argmax (pick from the 142 known mismatches) and the PNG colour at that tile. Arm A generates a 3x3 chunk block; arm B generates the isolated chunk only, in a separate surface. Assert `buildLine` contains `2.1.23`.
- [ ] **Step 2: Run** against 2.1.23. Expected: the dump exists and the control tile shows arm A differing from the raw argmax (if it does not, the probe cannot see correction; stop and report).
- [ ] **Step 3: Decide and record**: for each target, does the PNG match arm A (corrected) or the raw argmax? Write the fixture and the notes section, including the Task 1 gaps.
- [ ] **Step 4: Run** `pnpm vp test test/fixtureProvenance.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit --message "Measure whether the game's preview runs tile correction"`.

### Task 8: Probe - the native ops Gleba and Aquilo need

**Files:**
- Create: `scripts/probes/native-ops/{capture.ts,README.md}`
- Create: `test/fixtures/oracle-native-ops.json` + PROVENANCE entry (with `versionDifferences`)

**Interfaces:**
- Produces: a fixture of raw f32 bits per expression per position, consumed by Stage 2 (terrace, sin, cos) and Stage 1 (pow).

- [ ] **Step 1: Write the probe**, sampling inline expressions through `calculate_tile_properties` with each registered as its own named noise expression (several properties per call, property names first). Expressions: `sin(x / 64)`, `cos(x / 64)`, `sin(x * 13.37)`, `cos(y * 0.731)` (trig must be the whole value, not a small term); `terrace{value = x / 10, offset = 40, width = 20, strength = 0.2}` plus the same with strengths 0, 0.5, 0.95 and offsets -7.5, 0; `pow(abs(x) + 0.001, 0.5)`, `(abs(x) + 0.001) ^ 0.5`, `sqrt(abs(x) + 0.001)`. Positions: 1,024 points with x in [-4096, 4096] and y in [-512, 512], on the 1/256 grid, including x = 0 and negative values. If the game rejects an expression (for example `sqrt` not defined, or a non-constant terrace argument), record that in the README and drop it. Run against 2.1.23 and 2.0.77; refuse to write the fixture if any value differs.
- [ ] **Step 2: Run.** Expected: both versions bit-identical.
- [ ] **Step 3: Check the pow question** in the README: are all three forms bit-identical? (Expected yes, per `Folding::pow` at `0x1540ca0`.)
- [ ] **Step 4: Run** `pnpm vp test test/fixtureProvenance.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit --message "Capture terrace, VM trig and pow 0.5 from the game"`.

### Task 9: Probe - spot noise with skip span 1, offset 1

**Files:**
- Create: `scripts/probes/spot-skip-offset/{capture.ts,README.md}`
- Create: `test/fixtures/oracle-spot-skip-offset.json` + PROVENANCE entry
- Modify: `docs/noise/spot-noise-NOTES.md:73` and its crash section

- [ ] **Step 1: Write the probe**: on the Gleba surface (forced seed 123456), sample `gleba_simple_spot`'s underlying `spot_noise` with `skip_span = 1, skip_offset = 1` (copy the call from `planet-gleba-map-gen.lua`) and, as a control, the same call with `skip_offset = 0`, each in its OWN run (separate work dirs) so they cannot share a cache key. 512 positions covering several regions. Assert `buildLine`.
- [ ] **Step 2: Run** against 2.1.23. Expected: no crash, and the two fields differ (if they are identical, offset is ignored - a finding).
- [ ] **Step 3: Correct the notes**: offset 1 with span 1 is legal; the recorded crash was the `SpotNoiseCache.cpp:150` candidate-count assertion when expressions sharing one cache key ask for different counts. State what the probe measured.
- [ ] **Step 4: Run** `pnpm vp test test/fixtureProvenance.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit --message "Show skip offset 1 with span 1 is legal spot noise"`.

### Task 10: Probe - planet entity settings, Aquilo cliffs and the well tile rewrite

**Files:**
- Create: `scripts/probes/planet-autoplace/{capture.ts,README.md}`
- Create: `test/fixtures/oracle-planet-autoplace.2.1.23.json` + PROVENANCE entry

- [ ] **Step 1: Write the probe.** For Gleba and Aquilo surfaces at the DERIVED seed: dump `surface.map_gen_settings.autoplace_settings` whole (all categories), `cliff_settings`, and `autoplace_controls`. Generate a 512x512 tile region around the origin on each. Dump `find_entities_filtered` counts by name and type (expect `plant`, `tree`, `unit-spawner`, `simple-entity`, `resource`, `cliff`). For Aquilo: for every resource entity, read the 7x7 tiles around it, and on a SECOND surface with the same settings but the three resource controls at size 0, read the same 7x7 tiles; report how many tiles differ. Assert `buildLine`.
- [ ] **Step 2: Run** against 2.1.23. Expected: Aquilo cliff count 0 (if not, Stage 1 grows cliffs - report it); Gleba plant and spawner counts non-zero (confirms they enter through their controls); the Aquilo diff count answers whether the well rewrite runs during map generation.
- [ ] **Step 3: Write the README findings** for all three questions.
- [ ] **Step 4: Run** `pnpm vp test test/fixtureProvenance.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit --message "Capture Gleba and Aquilo entity settings and the well tile rewrite"`.

### Task 11: Preview PNG captures for Gleba and Aquilo

**Files:**
- Modify: `test/oracle/previewCompare.ts` (`:253-258` per-planet disabled controls; add a `full` arm with no data-final-fixes mod and nothing disabled)
- Create: `test/fixtures/oracle-preview-{gleba,aquilo}-{terrain,full}.seed123456.png` + 4 PROVENANCE entries

- [ ] **Step 1: Add the planet arms.** Gleba disables `gleba_stone` and `gleba_cliff` (the only disableable Gleba controls); Aquilo disables `lithium_brine`, `fluorine_vent`, `aquilo_crude_oil`. The terrain-only mod already drops non-resource entity settings and sets `treat_missing_as_default = false`; treat "it removes plants, spawners, stromatolites and icebergs" as a prediction.
- [ ] **Step 2: Capture** all four PNGs with the env from Global Constraints, map seed 123456, size 1024. Confirm the log shows `Loading mod preview_terrain_only 0.0.1 (data-final-fixes.lua)` for the terrain arms.
- [ ] **Step 3: Prove the prediction**: count pixels that differ between each planet's terrain and full PNG (must be non-zero), and cross-check with Task 10's entity counts that nothing of type `plant`, `tree`, `unit-spawner` or `simple-entity` is drawn in the terrain arm (re-run Task 10's entity count with the terrain-only mod loaded if needed). Re-capture each terrain PNG once more and confirm it is byte-identical.
- [ ] **Step 4: Write PROVENANCE entries** in the style of `oracle-preview-vulcanus-terrain.seed123456.png` (command, `buildLine`, disabled list, pixel delta, byte count, repeat capture). Run `pnpm vp test test/fixtureProvenance.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit --message "Capture Gleba and Aquilo preview PNGs at 2.1.23"`.

### Task 12: Tier-1 field captures, cross-checked against FactorioTools

**Files:**
- Create: `scripts/probes/planet-fields/{capture.ts,README.md}`
- Create: `test/fixtures/oracle-gleba-fields.seed123456.json`, `test/fixtures/oracle-aquilo-fields.seed123456.json` + PROVENANCE entries

**Interfaces:**
- Produces: raw f32 bits of `elevation`, `aux`, `moisture`, `temperature` and every tile probability (`tile:<name>:probability`, or each tile's `probability_expression` registered as its own expression if those names are ignored) at fixed positions, for Stages 1 and 2.

- [ ] **Step 1: Download** `malte9799/FactorioTools` `packages/mapgen/test/fixtures/{gleba,aquilo}-123.json` and `packages/mapgen/scripts/oracle.ts` at a pinned commit into a new empty scratch directory. Record the commit SHA. Read (do not run) `oracle.ts` to learn their seed convention (forced or derived) and position list.
- [ ] **Step 2: Write the probe** to capture the same fields at THEIR positions and seed convention on 2.0.77, plus our own 1,024 positions (forced seed 123456, a spread that contains every tile type at least once - check it in the probe) on 2.1.23 and 2.0.77. Refuse to write if 2.0.77 and 2.1.23 differ.
- [ ] **Step 3: Run**, then score our 2.0.77 capture at their positions against their fixture bit for bit. Expected: identical. If not, stop and report which fields differ - one of the two harnesses is wrong.
- [ ] **Step 4: Commit our captures only** (not their files). PROVENANCE `evidence` names the probe, both `buildLine`s, and "agrees bit for bit with malte9799/FactorioTools <sha> gleba-123.json/aquilo-123.json at their N positions". Run `pnpm vp test test/fixtureProvenance.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit --message "Capture Gleba and Aquilo tier-1 fields, cross-checked against FactorioTools"`.

### Task 13: Gate, PR and CI cost

- [ ] **Step 1: Run** `pnpm run verify`. Expected: exit 0.
- [ ] **Step 2: Open the PR** with a body that lists each finding (Tasks 1, 7, 8, 9, 10, 12) and links issue #454. End it with the attribution lines from the session.
- [ ] **Step 3: Read CI cost** across three runs of the PR (open, amend, push) for the `rust` job and the slowest test shard, against the last three `main` runs (commands in CLAUDE.md "verify:rust's cost is a RANGE"). If either median rose by more than 2 minutes, stop and report before merging.
- [ ] **Step 4: Read CodeRabbit's review body** (count from `Actionable comments posted: N`) and answer every finding.

---

## Later stages (separate plans, written after Stage 0 lands)

- **Stage 1 - Aquilo, complete.** About 35 expressions in `expressions/aquilo_*.rs` (avoid `aux.rs`), a shared "starting spot plus spot noise" helper on Task 6's key, 9-tile catalog, wells as rolled resource marks, icebergs as rocks, the well tile rewrite if Task 10 shows it, an Aquilo ABI block (code 3, append-only) in `abi.rs`, `request.ts` and `verify-wasm-request.py`, a native-against-WASM fold on Task 5's pattern, tier-1 specs on Task 12's fixture, a Fulgora-shaped tier-3 spec against Task 11's PNG, and `PLANET_CAPABILITIES.aquilo.rendered = true`. Ships at under 0.1% of pixels.
- **Stage 2 - Gleba terrain and cliffs.** `terrace` and VM `sin`/`cos` in Rust graded on Task 8's fixture (with attribution to frankh/factorio-mapgen where adapted), the CLAUDE.md and `docs/rust-wasm-port.md` trig wording, about 60 expressions, 41-tile catalog, cliffs through the shared core, ABI code 4. Ships at the bar.
- **Stage 3 - Gleba entities.** Stone (on Task 9's finding), stromatolites, plants as a density tint, spawners via a parameterised enemy layer, the composite view.
