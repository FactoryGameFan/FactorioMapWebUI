# Gleba and Aquilo in the map preview - design

Date: 2026-10-22. Status: approved scope, ready for a plan once Eric signs off
on this document. Tracks issue #454.

This is a point-in-time design record, like the other files in this folder. It
is not a living doc. `docs/rust-wasm-port.md` stays the live reference for how
the engine is built and graded.

## Intent

The right-hand preview renders Nauvis, Vulcanus and Fulgora in the browser
through the Rust/WASM engine. Gleba and Aquilo show "not available yet". Eric
wants both added as **full peers** of the other three: every view the panel
offers for that planet, the planet's own sliders wired in, and grading against
the game's own output.

## Decisions Eric made

1. **Both planets, in one project.** They share setup work, so one design
   covers both.
2. **Full peers**, not a terrain-only preview.
3. **Order and rollout:** shared setup first, then Aquilo complete, then Gleba
   in two stages (terrain and cliffs, then entities). **Each stage goes live
   when it merges**, the way Vulcanus V1 to V3 did. Until a planet's first
   stage merges, it keeps its "not available yet" message.
4. **Ship bar - "close, then chase."** A stage ships when its tier-1 game
   fixtures pass with frozen exact-match counts, and its terrain gap against
   the game's terrain-only preview PNG is frozen at under about 0.1% of pixels
   (about 1,000 of 1,048,576). Any gap left over becomes a tracked GitHub issue
   and is chased after it is live. For comparison, the frozen gaps today are
   Nauvis 1, Vulcanus 1 and Fulgora 20 pixels.
5. **If a stage stalls above 0.1% and the excess is shown to be the unported
   tile-correction step, ship anyway.** Freeze the gap and file an issue that
   names tile correction. "Shown" means measured, not assumed (see Stage 0).
6. **Hand-port the formulas**, the same pattern as the other three planets.
   Adapt the hard native ops from the MIT-licensed prior art below, with
   attribution. No formula interpreter in this project.
7. **Entities are drawn and graded like the existing layers**, not placed at
   the game's exact positions. See "Entities" below.

## Goals

- Aquilo renders terrain (9 tiles), its three fluid resources (crude oil,
  lithium brine, fluorine vent) and its icebergs, with its three resource
  sliders wired.
- Gleba renders terrain (41 tiles), cliffs, stone, iron and copper
  stromatolites, the 12 plant types, and the two pentapod spawners, with its
  five controls wired (`gleba_stone`, `gleba_water`, `gleba_plants`,
  `gleba_cliff`, `gleba_enemy_base`).
- The panel offers each new planet the views that make sense for it, the same
  way it does for Vulcanus and Fulgora today.
- Every stage is graded against the game at Factorio 2.1.23, the app's current
  target.

## Non-goals

- **Exact entity positions.** Eric chose the existing-layers approach (decision
  7). Exact placement with the game's collision order is the kind of work
  Vulcanus cliffs took months on and still has about 86 errors.
- **A formula interpreter.** Considered and declined for now (decision 6).
  frankh/factorio-mapgen shows the approach works; it could be its own future
  project, measured against the hand ports.
- **Decoratives.** The preview does not draw them for any planet. Gleba has
  79 and Aquilo 8.
- **Porting tile correction.** Unported for every planet
  (`docs/noise/tile-correction-NOTES.md`), and decision 5 covers what happens if
  it blocks the bar.
- **Map Tools for the new planets.** The island finder stays Fulgora-only.
  (Claude's call; Eric can add it later.)
- **An elevation view for Gleba or Aquilo.** Elevation views stay
  Nauvis-family only, as for Vulcanus and Fulgora.
- **Gleba's unused game expressions.** `gleba_iron_ore_richness` and
  `gleba_copper_ore_richness` exist in the data but nothing references them;
  stromatolites supply iron and copper.

## Anti-goals (would make this a failure even if it "works")

- A render graded only against itself. See "Grading".
- Making CI much slower. The `rust` job already runs 9.5 to 10.7 minutes,
  above the documented 6.5 to 8.5 range, and the Vulcanus render-parity file
  took 279s on one CI run. See "CI cost" for the limit.
- Breaking the existing three planets. Their frozen counts must not move,
  except where a shared change is shown to be a fix and graded as its own
  change (CLAUDE.md, "Do not fix a shipped-code defect inside the port").
- Copying another project's mistakes. Each borrowed piece is checked against
  the game binary or a game fixture before it is trusted; see "Prior art".

## Prior art

Surveyed 2026-10-22 (GitHub, the web, and the two rivals already scored in
#454). Downloads were read, never run.

| project | license | planets | what it is | use it for |
| --- | --- | --- | --- | --- |
| [malte9799/FactorioTools](https://github.com/malte9799/FactorioTools) `packages/mapgen` | MIT (code; game data excluded) | all five | TypeScript evaluator of the game's dumped expressions, f32 via `Math.fround`; last mapgen commit 2026-10-08, pinned to **2.0.77** | Gleba and Aquilo fixtures captured from the game through `calculate_tile_properties` (`test/fixtures/gleba-123.json`, `aquilo-123.json`): elevation, moisture, aux, temperature, all tile probabilities, entity probabilities. Reference code for `terrace` (`evaluator.ts`), VM sin/cos (`fastmath.ts`), the Voronoi variants. Thin: 100 positions and one seed per planet. |
| [frankh/factorio-mapgen](https://github.com/frankh/factorio-mapgen) | MIT | all five | Generic JS compiler of the game's noise Lua, 2.0.77 data, last commit 2026-10-12 | `terrace` (`noise.js:1075-1090`) matches the 2.1.23 disassembly op for op. VM sin/cos (`noise.js:345-351`): all seven f64 constants byte-identical to the binary. `roundEven` is a model for Rust `round_ties_even`. Spot `skip_offset` handling (`noise.js:1030-1046`). **Do not copy** its `gamePow` (misses the `pow(x, 0.5)` -> sqrt fold), its alphabetical strict-`>` tile argmax, or its missing tile correction. |
| factorio.extm.dev | closed source | all five | Hand-written Rust/WASM per planet, with a tile-correction module | A scoring comparison only (0.92% Gleba, 0.07% Aquilo at 2.1.20, #454). Static strings suggest it uses libm `sin` for Gleba, which may be part of its gap. Nothing can be copied. |
| [M45-Science/FactMapGen](https://github.com/M45-Science/FactMapGen) | none stated | all five | Go, server-side; its README calls Gleba and Aquilo "seeded regional approximations" | Nothing. |

Others found and ruled out: ness056/fast-factorio-seed-finder (Nauvis only),
JaguarM/NauvisTerrain (Nauvis only; notes that it reverse-engineered through a
PDB), dnakov/factorio-headless-client (approximate, no terrace or Voronoi),
Callumari08/factorio-rewrite (approximate).

**Licensing.** MIT code can go into this AGPL-3.0-or-later repo if the
copyright and license notice travel with it. Put the notice in the Rust file
that adapts the code, and name the source commit.

## What the recon found

The planet map-gen files are **byte-identical between 2.0.77 and 2.1.23** for
both planets. That makes 2.0.77 a usable second version for probes, and it
makes FactorioTools' 2.0.77 fixtures relevant to 2.1.23.

### Aquilo (small)

Sources: `space-age/prototypes/planet/planet-aquilo-map-gen.lua`,
`planet-map-gen.lua:428-490`, `tiles-aquilo.lua`, `entity/resources.lua`,
`decorative/decoratives-aquilo.lua` (icebergs are entities defined there).

- **No new primitives.** About 35 named expressions, all arithmetic over
  primitives the engine has: `multioctave_noise`, `quick_multioctave_noise`,
  amplitude-corrected multioctave, `voronoi_facet_noise` and `voronoi_cell_id`
  (grid 24 and 10, seed `'aquilo-cracks'`), `spot_noise` with skip span 3,
  `starting_spot_at_angle`.
- **Tiles:** 9, by plain argmax. Land is exactly `elevation > -1`; the land
  tiles carry `100 * (elevation > t)` terms, so every tile boundary is
  sensitive to one f32 step of elevation.
- **Resources:** three fluid wells placed by per-tile roll, like Nauvis oil. All
  three share spot `seed1 = 567` with different region sizes, so the Vulcanus
  spot cache key `(seed1, region_x, region_y)` would collide. The key must
  include region size or skip offset. A guaranteed fluorine vent sits near
  spawn.
- **Icebergs:** two simple entities driven by `aquilo_high_frequency_peaks`,
  collision mask includes `water_tile`. Handle like rocks.
- **No enemies. Probably no cliffs** (no `cliff_settings`, so the default empty
  name applies). Inferred; a capture confirms it.
- **`pow(x, 0.5)`** in `formation_broken`: the game's
  `NoiseExpressions::Folding::pow` (`0x1540ca0`) turns exponent 0.5 into an
  exact `sqrt` node, and the function form appears to share the operator's
  template. So it is very likely exact sqrt, matching #161's measurement of
  `^ 0.5`. Confirm with a fixture.
- **Resources rewrite tiles when created.** The three resources'
  `created_effect` sets snow and ice tiles around a well that lands on
  ammoniacal ocean (`resources.lua:10-34`, explosions at
  `explosions.lua:4912-4975`). No project surveyed handles it. Whether the
  game's preview shows it is unmeasured.

### Gleba (big)

Sources: `planet-gleba-map-gen.lua` (1,272 lines), `planet-map-gen.lua:136-332`,
`tiles-gleba.lua`, `entity/plants.lua`, `entity/enemies.lua`,
`decoratives-gleba.lua` (stromatolites), `autoplace-controls.lua`.

- **About 60 new named expressions.** The elevation alone is about 40 nodes,
  with 2 terraces, 9 starting spots and 2 spiral rotations.
- **Two new primitives, both now decoded:**
  1. **`terrace`** - `NoiseOperations::Terrace::run` at `0x251aa50` in the
     2.1.23 headless binary. All f32: `t = (v - off) / w`, `f = floorf(t)`,
     `frac = t - f`, `up = s < frac ? (frac - s) / (1 - s) : 0`, result
     `(up + f) * w + off`. NaN gives `up = 0`. frankh's code matches.
  2. **VM `sin`/`cos`** - `UnaryOperation<25,sin>::run` at `0x2525620`, cos at
     `0x2527ae0`. No libm: f32 widened to f64, multiply by 1/2π, add -0.25 (for
     cos), round to nearest even with `cvtpd2dq`, `0.25 - |...|`, a polynomial
     `(z2*(z*C+D)+(z*A+B)) + (z2*z2)*E` with constants 6.283185269630412,
     -41.34167506665737, 81.60201529595571, -76.56887678023256,
     39.65735524898863, then narrowed to f32. No FMA. About 8 calls per tile.
- **Tiles:** 41, many split into thin `aux` bands with a 0.005 slope.
- **Cliffs:** yes. `cliff-gleba` is a `scaled_cliff` at scale 1.0 (same family
  as Vulcanus). `cliff_elevation_0 = 40`, `interval = 60`, `richness = 0.80`,
  `smoothing = 0`. Cliffiness reads `gleba_rockpools`. The shared cliff core
  applies.
- **Stone:** the only resource. A hard 0-or-1 probability with a custom
  richness built on `gleba_simple_spot`, which uses `skip_span = 1,
  skip_offset = 1`. `docs/noise/spot-noise-NOTES.md` says that hard-crashes
  the game, but the recorded crash traces to `SpotNoiseCache.cpp:150`, a
  candidate-count assertion when several expressions sharing one cache key ask
  for different counts. So the note is probably wrong, and the rule is the
  `generateSpotList` one: draw `count * span` points and keep indices
  `offset, offset + span, ...`. Confirm with a probe and correct the note.
- **Iron and copper:** `iron-stromatolite` and `copper-stromatolite`, simple
  entities with no control.
- **Plants:** 12 with non-zero probability, controlled by `gleba_plants`. Ten
  are type `tree`; `yumako-tree` and `jellystem` are type `plant` with a soil
  `tile_restriction`. `stingfrond` has two `autoplace` keys in one Lua table
  (`plants.lua:1519` and `:1541`); the second wins.
- **Enemies:** `gleba-spawner` and `gleba-spawner-small`. They reuse
  `enemy_autoplace_base`, but Gleba overrides `enemy_base_frequency` (twice
  Nauvis) and `enemy_base_radius`. `enemies/catalog.rs:143` hard-codes
  Nauvis's values, so it needs parameters.
- **Which entities appear:** Gleba's explicit entity list has only stone and
  the stromatolites. frankh includes any entity whose `autoplace.control` is
  one of the planet's controls; confirm with a dump of the surface's
  `autoplace_settings` before building on it.
- **Several expressions read the property variables** `elevation` and `aux`,
  not the named Gleba expressions. Gleba's overrides must be wired through.

### The repo side

- **Already done for all five planets:** the planet list
  (`src/model/planets.ts`), all eight controls in `controlCatalog.ts`, icons,
  surface seed derivation (with measured Gleba and Aquilo rows), and the
  terrain-only data-stage mod's planet loop.
- **Hard-coded to three planets:** `ElevationPreviewPanel.vue` has
  `vulcanus || fulgora` chains at five places (lines 78-196), the dispatch in
  `src/noise/preview/elevationRenderRequest.ts` has one branch per planet,
  `src/noise/wasm/request.ts:415` defaults an absent planet to **Fulgora**
  while `elevationRenderRequest.ts` defaults to **Nauvis**, and
  `crates/fmw-wasm/src/abi.rs:969` tests for "three planets".
- **ABI blocks are append-only**, so a new planet block needs no version bump.
  `abi.rs`, `request.ts` and `test/fixtures/verify-wasm-request.py` must agree.
- **Shared engine code that applies:** all primitives, the `At` point/grid
  split, `starting_spot_at_angle`, tile helpers, the per-chunk placement roll,
  the cliff core, the rocks catalog, checksum and poison plumbing.
- **Per-planet or missing:** expression stacks, tile and resource catalogs, a
  plant layer (`trees/mod.rs` says Nauvis only), a second enemy layer.

## Entities

Each new entity kind is drawn the way the closest existing layer draws its
kind (decision 7):

| entity | drawn like |
| --- | --- |
| Gleba plants (all 12) | Nauvis trees: a density tint from the probability, not placed entities. The two soil-restricted `plant`-type ones respect their `tile_restriction`. |
| Gleba spawners | Nauvis enemy bases |
| Gleba stone | Vulcanus ore (resource overlay) |
| Gleba stromatolites | rocks (rolled marks) |
| Aquilo wells | Nauvis crude oil (rolled resource marks) |
| Aquilo icebergs | rocks |
| Gleba cliffs | the shared cliff core, as Vulcanus |

**Grading for entities:** the game's own probability and richness values at
tier 1 (frozen exact-match counts), plus the existing footprint check against
the full game PNG - the overlay must be a **superset on the footprint**, never
pixel equality, per `docs/rust-wasm-port.md`. No new placement grader is built.

**Aquilo's tile rewrite (Claude's call):** if Stage 0 shows the game's preview
draws the rewritten tiles, draw the rewrite around the wells the overlay
renders, in views that show wells. Because wells are rolled marks, not exact
positions, this is graded only by the footprint check. The terrain-only grade
is unaffected: that capture turns the wells off, so no rewrite happens there.

## Grading

Vulcanus and Fulgora were built in TypeScript first and checked against the
game, then ported to Rust with the TypeScript as a second, independent arm.
That TypeScript is deleted (#227, #360, #371), and so is
`test/oracle/capture.ts`. The plan:

- **Tier 1 is the correctness grade.** Game fixtures for every field a tile,
  resource or entity decision reads, captured at 2.1.23 with the frozen surface
  seed convention, scored by exact-match count per `docs/rust-wasm-port.md`.
  Include `get_tile` reads after real chunk generation, as Fulgora's fixtures
  do. Choose positions so each window contains what it grades.
- **FactorioTools' fixtures are the independent cross-check** that replaces
  the deleted TypeScript arm. They are game captures from a separate harness
  at 2.0.77, and the planets' map-gen is unchanged since then. Score our engine
  against them in a probe or spec. If they are committed as fixtures, they need
  a `PROVENANCE.json` entry naming their origin and version, and their license
  notice. (How to use them is left to the builder.)
- **Tier 3 against the game's terrain-only preview PNG is the second
  correctness grade**, through the data-stage mod in
  `test/oracle/previewCompare.ts`. Gleba's water, plants and enemy controls
  cannot be disabled, so the mod must remove plants, spawners and
  stromatolites.
- **Native-versus-WASM comparison replaces tier 2's host check** (Claude's
  call). Tier 2 used to catch host differences such as a libm call that
  differs between native and WASM (#270). The same raw-bits fold computed by
  `cargo test` on the host and by the WASM module in a vitest spec must match.
- **Self-snapshot freezes** (tier-3 render checksums) still guard against
  regressions once a stage ships. They are not a correctness grade, and the
  docs for each new planet should say so.
- **Run a probe against two versions when cheap.** On tealc, 2.0.77 headless
  with Space Age is at `/home/eric/factorio-headless-2.0.77` (a flat layout).
  The 2.1.23 install is NESTED: its root is
  `/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio`,
  and the outer folder does not resolve. Neither is discovered automatically:
  pass `--factorio <root>` and `--version`, and check each run's `buildLine`.
  Without `--version`, a path that does not resolve falls back to the Steam
  2.0.77 copy with exit 0.

New probes use the `factorio-oracle` CLI under `scripts/probes/`, per
CLAUDE.md. `sampleExpression()` in `test/oracle/` may still be used where it
is the right tool.

## Stages

Each stage is its own set of PRs. Stages are sequential because every Rust
change rebuilds the committed `engine.wasm`, which conflicts on any parallel
branch. Probes and captures for later stages may run ahead in parallel, as
long as they only add files under `scripts/probes/` and `test/fixtures/`.

### Stage 0 - shared setup

1. **The last-pixel test.** Print the top two tile scores at Nauvis tile
   (229, -19) (game grass-1, ours grass-3) and Vulcanus tile (-361, 11) (game
   volcanic-cracks, ours volcanic-cracks-warm), the only two pixels each planet
   still differs from the game's terrain-only PNG. A gap of a few f32 steps
   means a rounding near-tie; a large gap means a step after tile choice,
   most likely tile correction. Together with a probe of whether the game's
   preview runs tile correction at all, this is the evidence decision 5 needs.
2. **One planet capability table** replaces the `vulcanus || fulgora` chains in
   the panel and the per-planet dispatch: which views a planet offers, its
   lever readers, and its render entry. Fix the Fulgora-vs-Nauvis default
   mismatch as its own graded change. Behaviour must not change for the three
   current planets.
3. **Native-versus-WASM comparison harness**, proven on one existing field
   first so it is known to discriminate (plant a change and watch it go red).
4. **Probes**, each a `scripts/probes/` directory with its trap comments:
   `terrace`, VM `sin`/`cos`, `skip_offset = 1`, `pow(x, 0.5)`, Aquilo's
   resource tile rewrite in both `get_tile` and the preview PNG, the Gleba
   `autoplace_settings` dump, and Aquilo's cliff absence. Each runs against
   2.1.23 and, where cheap, 2.0.77.
5. **Score FactorioTools' Gleba and Aquilo fixtures** against our own capture
   harness at the same positions, so we know they agree before leaning on
   them.
6. **Spot-cache key** extended so two resources sharing a `seed1` with
   different region sizes cannot collide. Vulcanus's frozen counts must not
   move.
7. **Preview PNG captures** for both planets (terrain-only and full), with
   `PROVENANCE.json` entries.
8. **Correct `docs/noise/spot-noise-NOTES.md`** if the `skip_offset` probe
   shows the note is wrong.

### Stage 1 - Aquilo, complete

Expressions, 9-tile catalog, the three wells (with a shared "starting spot plus
spot noise" helper Gleba will reuse), icebergs, the tile rewrite if Stage 0
shows the preview draws it, the WASM block and render entry, panel wiring,
tier-1 fixtures, tier-3 freeze. Ships at the bar.

### Stage 2 - Gleba terrain and cliffs

`terrace` and the VM trig as plain Rust arithmetic, the elevation chain, `aux`,
moisture and temperature, rock pools, the band masks, the 41-tile catalog,
Gleba's tile collision layers, and cliffs through the shared core. Ships at the
bar.

### Stage 3 - Gleba entities

Stone, stromatolites, the 12 plants, a parameterised enemy layer for the two
spawners, and the composite view, all drawn per "Entities". Ships at the bar.

## Constraints

- Everything in CLAUDE.md's "Rules that keep the port deterministic": `min2` /
  `max2` in the game's argument order, no `mul_add` or fast-math, no `simd128`,
  `BigInt.asUintN` on every u64, no NaN inside a frozen fold, and a fraction
  rather than an exact count when a libm call sits inside a counted predicate.
- **Trig is a documented exception (Claude's call).** CLAUDE.md says trig
  crosses the boundary as values computed in V8 (#270), because libm differs
  between hosts. The game's VM `sin`/`cos` is a polynomial, not libm, so a Rust
  copy is deterministic. Port it, prove it bit-exact against a game fixture
  with trig as the **dominant** term (frankh's fixture adds sin to values near
  117, which would hide a 1-ULP error), and update CLAUDE.md and
  `docs/rust-wasm-port.md` to say the V8 rule covers libm trig, not the VM's
  polynomial. Per-render bearings such as `starting_spot_at_angle` keep coming
  from V8.
- Use the chunk-grid path (`At::Grid`) from the start, and keep
  domain-warped coordinates on `At::Point`.
- Avoid Windows-reserved file names such as `aux.rs`.
- Add each new poisoned test's full path to `POISONED_TESTS` in
  `scripts/verify-rust.sh` and watch it go red.
- Never edit a fixture or an expected value to make a test pass.

## CI cost

- Model new render-parity specs on **Fulgora's** shape (about 16s on CI), not
  Vulcanus's overlay tiling and composite tests (131s and 110s single tests on
  tealc).
- **Limit (Claude's call):** before merging each stage, read the `rust` job and
  the slowest test shard across at least three CI runs (a PR's open, amend and
  push give three). If either median rises by more than 2 minutes against the
  last three runs on `main`, that stage includes a CI-cost fix before it
  merges. Do not narrow the poison set to get there; that was measured and
  rejected.

## Left to the builder

- Module layout inside `crates/fmw-noise` for each planet, following the
  existing `expressions/<planet>_*.rs`, `tiles/<planet>_catalog.rs` pattern.
- Fixture sample positions and region choices, within the rules in
  `docs/rust-wasm-port.md`.
- How FactorioTools' fixtures are used: scored in a probe only, or committed
  with provenance and license notice.
- Which views each planet offers, matching the existing planets' pattern, as
  long as no view is offered that the engine cannot render.
- Tile palette colours, taken from the game's map colours.
- PR boundaries within a stage.
- The exact shape of the capability table.
