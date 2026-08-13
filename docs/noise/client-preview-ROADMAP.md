# Client-side map preview - roadmap

Forward-looking plan (not a living doc - a point-in-time record, like the specs
under `docs/superpowers/`). Written 2026-07-17, right after `basis_noise` and
`spot_noise` were fully reverse-engineered.

## Goal

Generate Factorio 2.1.11 map previews **in the browser**, from a `Preset`, with no
server round-trip - to optionally replace (or front-run) the headless
`preview-service/` container with instant, offline previews.

Correctness bar: **visually faithful**, with per-expression agreement to ~1e-6
against the game (the fastapprox noise floor - bit-exactness is the wrong goal,
see `basis-noise-NOTES.md`). A preview is downsampled (~1 px per N tiles), so
small numeric drift is invisible anyway.

Non-goal: reproducing the game's threading, chunk streaming, or entity placement.
We evaluate noise per pixel, independently.

## Where we are: the hard part is done

The two primitives the community called "black magic" are solved and verified
against the game's own machine code:

- **`basis_noise`** - `src/noise/basisNoise.ts` (`basisNoise`, and
  `basisNoiseTablesFromSeed` for the full seed -> tables derivation).
  `docs/noise/basis-noise-NOTES.md`.
- **`spot_noise`** - candidate RNG `src/noise/spotCandidates.ts`, selection
  `src/noise/spotSelection.ts`, rendering documented.
  `docs/noise/spot-noise-NOTES.md`.

What remains is **breadth, not depth**: an expression evaluator, a handful of
smaller primitives, and a large body of game *data* (the expression trees + tile
autoplace) to port - all of it validatable against the oracle, none of it
research-hard.

## The stack

```
6. Render        tile/resource -> color, downsample, compose image
5. Tile types    elevation + climate -> winning tile (autoplace "peaks")
4. Settings      control:*:frequency/size/richness/bias, property_expression_names
3. Expressions   base-game trees: elevation, temperature, moisture, aux, resources
2. Evaluator     the 14 NoiseOperations + arithmetic + built-in vars (x,y,distance,seed)
1. Primitives    basis_noise (done), spot_noise (done), + the rest below
```

## Do this first: the validation harness (M0)

Everything below is built test-first against the game, exactly as the primitives
were. Commit the harness so every later layer has ground truth.

- [x] Commit a reusable headless oracle under `test/oracle/` (currently rebuilt
      ad hoc each session): a mod that routes an arbitrary named noise expression
      onto `elevation`, reads `calculate_tile_properties({"elevation"}, positions)`
      in `on_init`, `write_file`s JSON, `error("DUMPED-OK")` to exit (~1.7 s/run).
      Recipe in `basis-noise-NOTES.md` / `noise-oracle-basis-measurements`.
      It needs a local Factorio install, so gate the tests on its presence.
- [x] A `sampleExpression(exprString, positions, {seed, ...}) -> number[]` helper
      that runs the oracle and returns game values, for use as fixtures.
- [x] Decide fixture policy: capture once, commit JSON (like the existing
      `basis-noise*.json`), run the comparison in CI without Factorio.

## Milestone 1 - MVP: elevation land/water/coast

The smallest recognizable preview. Proves the evaluator design before the big
data port.

- [x] **Evaluator core** (`src/noise/eval/`): a per-pixel evaluator. Recommended
      shape - compile each named expression to a JS closure `(ctx) => number`
      where `ctx = { x, y, seed, controls }`; the expression tree maps directly to
      nested calls. (The game compiles to a register program in `NoiseCache`; we
      do **not** need to replicate that - it is an internal batching optimization.)
- [x] **Remaining primitives needed for elevation** (RE against the oracle):
  - `MultioctaveNoise` / `VariablePersistenceMultioctaveNoise` - octave layering
    over `basis_noise`. Already partly measured (basis summed, ~RMS-normalized,
    std ratio 1.077x at octaves=4). Nail persistence/lacunarity/per-octave seed
    and input-scale exactly. `NoiseOperations::MultioctaveNoise::run` at a known
    address (see the disassembler in `scratchpad`), or infer from
    `core/prototypes/noise-programs` Lua.
  - Trivial math ops: `Const`, `Clamp`, `If`, `PowInt`, arithmetic
    (`BinaryExpression` add/sub/mul/div/min/max, `UnaryExpression`). These are
    one-liners; confirm signatures from the binary if in doubt.
  - `DistanceFromNearestPoint` (starting-area / spawn shaping) if the elevation
    tree uses it.
- [x] **The elevation expression**: Nauvis `elevation` (the default) ported
      2026-07-19 as `makeElevationNauvis` (`src/noise/expressions/elevationNauvis.ts`,
      merged f95594f) - a 1:1 hand-port of `elevation_nauvis_function` from
      `core/prototypes/noise-programs.lua`, validated against the oracle to the f32
      floor (worst far-field 4.08e-3, near-spawn 2.87e-6). KEY finding: it needs NO
      new primitive - `ridge`/`terrace` (rated "small" below) are used by NO
      elevation tree (every apparent "ridge" was the `b`ridge`` substring). The
      Island variant (`elevation_island`, a trivial `bias=-1000` lakes variant)
      shipped 2026-07-19 as `makeElevationIsland` (`src/noise/expressions/elevationIsland.ts`)
      - a thin wrapper over `makeElevationLakes` with `bias=-1000` and
      `segmentation_multiplier/4`, validated against the oracle to the f32 floor
      (worst far-field 6.66e-3, near-spawn 5.2e-7). All three base map types
      (Nauvis, Lakes, Island) now render client-side; they dispatch via a `mapType` selector.
- [x] **Render**: `elevation < 0` -> water (deep vs shallow by threshold), else
      land; draw to a `<canvas>` at a chosen scale. Coastline falls out.
- [x] **Validate**: sample the game's `elevation` at a grid for a few seeds; diff
      to ~1e-6; then eyeball the rendered coastline against a real
      `--generate-map-preview`.

Done = a recognizable land/water/coastline image from a `Preset`, matching the
game's elevation to the noise floor.

## Milestone 2 - climate terrain colors - DONE 2026-07-19

Shipped on branch `feat/m2-climate-terrain` (see
`docs/superpowers/specs/2026-07-19-milestone2-climate-terrain-design.md` and
`docs/noise/terrain-render-NOTES.md`). Client renders Nauvis terrain colors that
match the real game's tile placement at 100% (153/153 oracle points, 3 seeds).

- [x] Ported `temperature_basic`, `moisture_nauvis`, `aux_nauvis` (default Nauvis
      climate) as hand-written closures over the solved primitives, reusing the
      extracted `nauvisShared` internals (`nauvis_plateaus`/`hills`/`bridge_billows`
      + new `forest_path_billows`). Oracle-validated to the f32 floor (temperature
      worst 7.07e-5, aux 1.01e-5, moisture 2.76e-5). `temperature` is ported but
      unused by tiles. KEY: `trees_forest_path_cutout` is billow noise, not tree
      placement.
- [x] **Reverse-engineered the native `expression_in_range`** (undocumented C++
      builtin) from the oracle: `min(peak_maximum, peak_multiplier * min_i(min(v_i -
      from_i, to_i - v_i)))` - per-dim triangular peak, min across dims, no lower
      clamp, `peak_maximum` may be Infinity (sand-1). Worst residual 9.5e-7. See
      `docs/noise/expression-in-range-NOTES.md`.
- [x] **Tile-type resolution** (`src/noise/tiles/`): the 21 Nauvis tiles as a
      catalog (`catalog.ts`) built on `expression_in_range_base`/`water_base`/
      `noise_layer_noise`; `resolveTile` picks the argmax `probability_expression`
      (tiles are a pure argmax - `order` has no effect). Tile selection is driven by
      aux + moisture (land) and elevation (water); temperature is unused.
- [x] Palette: each tile's `map_color`, cross-checked byte-for-byte against
      `tiles.lua`.
- [x] **Validated tile assignment against the game** via a new `get_tile` tile-ID
      oracle path (chunk-generate + `surface.get_tile().name`, `test/oracle/oracle.ts`),
      NOT `--generate-map-preview` (which only sanity-checks compositing). The
      widened multi-seed fixture (20/21 tiles) caught a latent `quickMultioctaveNoise`
      octave-seed bug (invisible on even seeds) - fixed to a flat `seed0 + k`.
- [x] Terrain render path (`renderTerrain`, water early-out with an analytically
      proven-safe threshold) + a Terrain/Elevation view toggle (Nauvis only). The
      moisture/aux sliders drive the terrain view (non-default climate is a faithful
      port but not oracle-validated point-by-point; only the default preset is).

Done = colored terrain (grass / sand / dirt / desert variants + water), matching the
game's tile placement at the default preset.

## Milestone 3 - resources

`spot_noise` is fully solved; this is wiring, not research.

**M3a (regular whole-map patches) - DONE** (merged to `main`, pushed, deployed live
2026-07-20).
Spec `docs/superpowers/specs/2026-07-19-milestone3-resources-design.md`, plan
`docs/superpowers/plans/2026-07-19-milestone3a-regular-patches.md`.

- [x] Port the per-resource autoplace expressions (iron/copper/coal/stone/
      uranium + crude-oil) from `prototypes/entity/resources.lua` +
      `resource-autoplace.lua`. `src/noise/resources/` = catalog (6 param sets),
      resourceMath (distance/amplitude local functions), regularPatches
      (`makeRegularPatches`: spot field + blob term). The `control:<resource>:*`
      levers flow in via `readResourceControls`.
- [x] Wire `selectSpots` + the max-of-cones renderer into per-pixel evaluation,
      region-cached. The one unknown (`random_penalty`'s batch composition inside
      spot-quantity selection) resolved: a batch over all skip-set accepted spots
      in acceptance order (`quantityBatch`). Oracle-validated (pure-regular fixture,
      iron+uranium, 2 seeds): abs error < 0.7 units everywhere after fixing the
      cube root to the game's fastapprox `pow` (`fastApprox.ts`, `fastCbrt`).
- [x] Overlay resource patches on the terrain image (resource `map_color`),
      order-priority winner where `probability >= 0.5` (`resolveResource` +
      `renderResources`); worker `view:"resources"`; Resources toggle on the panel.
- [x] Validated against the pure-regular `calculate_tile_properties` oracle and a
      headless full-view render (all 6 ore types as blob patches, spawn cleared).

- [x] **Ore excluded from water** (2026-07-20): resources collide with water, so
      renderResources skips any pixel the terrain drew as deepwater/water. Reuses
      renderTerrain's exact water decision (no re-derivation), so the ore edge lines
      up with the drawn coastline.

**M3b (starting patches, near-spawn guaranteed ore) - DONE** (merged to `main`,
pushed, deployed live 2026-07-20; branch `feat/m3-resources` fast-forwarded in,
tip `0131aa8`). Plan
`docs/superpowers/plans/2026-07-20-milestone3b-starting-patches.md`.

- [x] Ported `starting_patches` (`src/noise/resources/startingPatches.ts`) for the
      four solids (iron/copper/coal/stone): a spot field (region_size 450,
      candidate_spot_count 32, spacing 48, `hard_region_target_quantity`) plus the
      same `blobs0` blob term shape as regular patches, over a deterministic
      favorability (lake-mask x modulation x origin-excluder x 2, minus a distance
      term - no random jitter). `resourcePatches.ts` composes
      `all_patches = max(starting, regular)` for the four solids; oil/uranium
      (no starting placement) delegate to the regular field unchanged.
- [x] **Version-discrepancy finding**: the `~/Downloads/factorio 4/data` dump used
      to draft the M3b plan is Factorio 2.0.77 (stale); the app targets 2.1.11.
      `starting_patches` changed materially between those versions (radius
      120->150, region_size radius*2->radius*3, spacing 32->48, and the
      favorability term dropped its `random_penalty_at(0.5,1)` jitter entirely in
      favor of a deterministic `origin_excluder`). Caught mid-implementation by
      diffing against the oracle and the Steam app's own bundled 2.1.11 Lua - see
      `docs/noise/M3-session-handoff.md` and the
      `factorio-data-version-hazard` memory note for the full finding and the
      authoritative source path.
- [x] The starting favorability's lake mask couples to the map's `elevation`
      PROPERTY, which on the default Nauvis map is `elevation_nauvis` (confirmed
      against the oracle, not the `elevation_lakes` literal an earlier draft
      assumed). `makeStartingPatches` hardcodes `makeElevationNauvis`; generalizing
      to Lakes/Island starting elevation is deferred until the resolver needs a
      non-default map type for resources.
- [x] `selectSpots` gained a `favorabilityBatch` option (mirrors the existing
      `quantityBatch`) for favorability expressions with a `random_penalty` batch
      term - unused by 2.1.11 starting patches (whose favorability turned out
      deterministic) but available for future primitives - plus routed the
      hard-target `coneScale` shrink through `fastCbrt` (was `Math.cbrt`).
- [x] Oracle-validated against a `has_starting_area_placement=1` fixture: near-spawn
      points match to well under 1.0 absolute. `test/resourcePatches.spec.ts` uses a
      combined `abs<1.0 OR rel<1e-2` tolerance to also accommodate the pre-existing
      far-field `basisNoise` f32 floor (~5e-4 relative on ~1e4-magnitude points)
      without masking real near-spawn errors.
- [x] Headless full-view eyeball (Task 7): iron/copper/coal/stone patches cluster
      tightly around spawn, oil renders as a small dot far out (no starting
      placement, as expected), spawn is not bare.

**M3.5 (per-tile placement stipple) - SPIKED then DEFERRED (2026-07-20).** The
placement RNG was reverse-engineered (`EntityMapGenerationTask::generateEntities` /
`generateEntityOnTile`): it is taus88, seeded once per 32x32 chunk from
`ChunkPosition` (`max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY)`, no map-seed), and
the roll is `place if taus88()/2^32 < probability`. But it is a **single per-chunk
stream shared across ALL entity autoplacers** (enemies, rocks, resources), consumed
in a fixed order with 2 data-dependent jitter draws per placed entity - so faithful
resource stipple would require simulating whole-chunk entity generation across
subsystems this app never ported. Multi-session + cross-subsystem; **deferred**
(Eric, 2026-07-20). Full RE + a cheaper cosmetic-dither alternative:
`docs/noise/placement-roll-NOTES.md`. Solid-footprint (opaque where `prob >= 0.5`)
shipped in M3a/b.

**SHIPPED 2026-07-27, as a third option neither the spike nor this entry named.**
Not the whole-chunk simulator, and not the cosmetic dither: a real roll against
the real probability, with the two coupling sources deliberately dropped. Dropping
the 2 jitter draws is the load-bearing move - with no data-dependent consumption a
chunk's 1024 draws are a pure function of `(chunkX, chunkY, salt)`, which restores
per-position purity and keeps the tiled render byte-identical to the untiled one.
Cross-overlay arbitration is then simply absent, so **positions are not the
game's; density is the claim**, and it is validated per overlay against real
`count_entities_filtered` counts. All five overlays converted (Vulcanus rocks,
Nauvis rocks, Nauvis enemy bases, Vulcanus geysers, Nauvis crude oil - the four
issue #9 named, plus Vulcanus rocks). See "WHAT WAS ACTUALLY BUILT" in
`placement-roll-NOTES.md`.

M3a follow-ups (known, deferred by priority - 2026-07-20):

- [~] **Ore excluded from cliffs** - WITHDRAWN 2026-07-30 (issue #24, PR #57).
      **There is no exclusion rule to port.** `generateCliffs()` (`0x1016229b4`)
      calls exactly three functions and touches no tile, entity or resource data,
      so the game does not exclude ore from cliffs at generation time by any
      mechanism this could reuse. The observation that started this - cliffs
      appearing on ore far below the chance rate - also does not survive its own
      null: region `[0,0]`'s 945 ore tiles are **2 blobs**, not 945 independent
      samples, and under a torus-shift null two of three regions were not
      significant at all (P = 0.51, 0.29). The effect is real pooled over nine
      regions (18/12,533 = 0.14%) but it is a consequence of where cliffs land,
      not of a rule that keeps them off ore. Do not re-open this as a port.
- [x] **Oil renders as tiny dots, not patches** - DONE 2026-07-27 (Task 8). Both
      sub-items landed together, which is what the note predicted: (a)
      `renderResources.ts` now applies oil's `random_penalty{source=1,
      amplitude=48}` probability factor, and (b) oil places through the per-tile
      placement roll rather than the `>= 0.5` footprint. It was never really
      "tiny dots" - the threshold drew oil's whole patch EXTENT, 1234 tiles in
      `[0,0]-[512,512]` where the game has **8** wells. Now 7 vs 8 there, and
      0 vs 0 in `[4096,4096]`. The `random_penalty` batch extent, which this was
      expected to require, turned out to be irrelevant to density - see
      `docs/noise/random-penalty-NOTES.md`.
      - **2026-07-20 finding (from `~/GitHub/factorio-data` @ 2.1.11,
        `resource-autoplace.lua:103-105`):** for `random_probability < 1` the game
        appends `* random_penalty{x=x, y=y, source=1, amplitude=1/random_probability}`
        to the probability expression (and `/ random_probability` to richness - the
        richness half is ALREADY done in `regularPatches.ts`). The `random_penalty`
        factor is `1 - (1/rp)*U`, i.e. it is itself a per-tile ~`rp` Bernoulli baked
        into the probability. **Applying (a) alone, with the current `>= 0.5`
        threshold render, makes oil sparser or vanish** (the factor is `>= 0.5` for
        only ~`rp/2` of tiles, and oil's spots are already ~1 tile), so it is NOT a
        standalone visual win - it only pays off combined with M3.5's roll (place if
        roll < probability). So (a) is really M3.5-prep, or wants a per-resource
        render rule (e.g. render oil where probability `> 0`, ~`rp` density, using
        only the already-validated `randomPenalty` primitive - a cheap approximation
        that skips the un-RE'd placement RNG). **Decision (2026-07-20, Eric):
        FOLD INTO M3.5** - apply the probability factor together with the RE'd
        placement roll (place if roll < probability), validated tile-for-tile
        against `find_entities`. Oil stays as-is (tiny dots) until M3.5; no
        standalone change.
      - **DONE 2026-07-27 (Task 8), and the fold was the right call** - the factor
        and the roll landed together exactly as decided. Two corrections to the
        analysis above, both from measurement. The factor costs a **96x** density
        reduction, not `rp` = 48x: `1 - 48U` is positive only for `U < 1/48` and
        averages 1/2 there. And validation is by **density, not tile-for-tile**
        against `find_entities` - this port does not reproduce positions for any
        overlay. The `random_penalty` batch extent that made this look expensive
        turned out to be irrelevant to density (`random-penalty-NOTES.md`), so the
        per-resource render rule was never needed.

Done = ore patches overlaid on land, responding to the frequency/size/richness sliders.

## Milestone 4 - the long tail

- [x] Cliffs (`cliffiness` / cliff elevation bands) - DONE (2026-07-20; merged to
      main + deployed live, main tip `e783901`). Done = a Nauvis-gated
      `view: "cliffs"` footprint overlay painting `CLIFF_MAP_COLOR = [144,119,87]`
      (a 5x5 block per cell for preview legibility), driven by the two oracle-validated
      noise fields (`cliff_elevation_nauvis`, `cliffiness_nauvis`) plus a
      disasm-derived geometric placement rule (`crossesCliff` + the 4-tile grid +
      `toMaybeCliffOrientation` none/not-none predicate), levers wired
      (`nauvis_cliff` frequency/continuity + `cliffSettings`). Validated **100%**
      against real `find_entities_filtered{type="cliff"}` dumps (frac 1.000 at
      both seeds since 2026-07-30; was 0.943/0.942 while the fields were sampled
      half a tile off in y) and cross-checked against a real
      `factorio --generate-map-preview` render of the same seed/region (95.7%
      spatial agreement at render resolution, using the game's own emitted
      `[144,119,87]` pixels as ground truth). Full writeup: `cliffs-NOTES.md`.
      **All three items previously listed here as "still deferred" are now
      retired, and none of them explained the ~6% Nauvis residual - which is
      itself now RESOLVED (2026-07-30): the fields were sampled at `j*4 + 0.5`
      because the port added the prototype's `grid_offset` (a CENTRE offset) to
      the sample position. Corrected, Nauvis is **1.0000 recall / 1.0000
      precision / ratio 1.000** at both seeds, i.e. exact. The five earlier
      causes were falsified on** (2026-07-28,
      the day five stated causes were falsified - see
      `notes-must-say-how-they-were-measured` and `cliffs-NOTES.md`):
      `fixImpossibleCells` was **ported** in PR #32 (`dea73ac`,
      `cliffPlacement.ts:105`, `test/cliffFixImpossibleCells.spec.ts`) and changes
      **zero** predictions on Nauvis; the exact `wouldCollide` rejection is moot
      because **no Nauvis cliff touches water at all**; and the ore-on-cliff
      exclusion was withdrawn outright (see the M3a follow-up above - there is no
      such rule in the game). **The residual is CLOSED as of 2026-08-01 (PR #83).**
      It was a FIELD error after all, not the rule error PR #57 concluded:
      `multisample`'s offsets are in the calling noise program's GRID UNITS, so
      the cliff generator (4-tile lattice) and the tile generator (1 tile) read
      different `vulcanus_elevation`. PR #57's substitution missed it because its
      fixture came through the same 1-tile channel the port used. Vulcanus recall
      on the shipping path is now 0.9675 with precision 0.9743 and 2.0% wrong
      orientations; see the ROOT CAUSE section of `cliffs-NOTES.md` and issue #84
      for the remainder. `VoronoiNoise` (layer-1 primitive table below) is
      confirmed **unneeded for Nauvis** - it appears nowhere in the cliff tree or
      any other Nauvis expression traced so far, only on Space-Age planets - so it
      remains un-ported with no open TODO against it.
- [x] Enemy bases (enemy autoplace - `enemy-autoplace-utils.lua`), starting-area
      clearing. Done = footprint overlay (`view: "enemies"`) from the
      oracle-validated `enemy_base_probability` field, threshold
      `ENEMY_FOOTPRINT_THRESHOLD = 0.05`, spawners only (worms and per-nest
      placement deferred, see `docs/noise/enemy-bases-NOTES.md`).
- [x] Trees (tree autoplace - `base/prototypes/entity/trees.lua`), decoratives
      ruled out. Done = a density-shaded `view: "trees"` overlay, all 15 Nauvis
      species (`tree_01` ... `tree_09_red`), oracle-validated to the ~1e-3 noise
      floor, composited into `view: "all"` between terrain and the resource/
      enemy/cliff overlays, with `control:trees` frequency/size wired. The
      preview's own binary was disassembled first: it places real entities and
      charts them (`chartEntities` -> `Chart::drawEntity` ->
      `ChartingInterface::drawRectangle`), so this port renders the exact
      expected value of what the game's per-tile placement roll would produce
      rather than a guessed shading. The charted footprint (1.0x1.0 tiles,
      kernel `[0.5,1,0.5]`, compounding per-tree alpha) was determined
      empirically against a real game render and validated on two seeds
      (game ink / our ink: 5.70/4.67 = 1.22x @ seed 123456, 7.89/6.89 = 1.14x
      @ seed 777771) - the residual is the expected-value-vs-discrete gap and
      needs the deferred Phase 2 stipple to close, not further tuning.
      **Decoratives are ruled out by binary evidence**: no
      `DecorativeMapGenerationTask` symbol exists anywhere in the shipped
      binary, and the preview worker calls only `chartCliffs` + `chartEntities`
      - the game's own preview shows no decoratives either. Full writeup,
      including the oracle-caught per-species `sizeOffset` bug and its
      methodology lesson, the `BASIS_ABS_MAX` early-out measurement, and the
      measured render cost: `docs/noise/trees-NOTES.md`. Design record:
      `docs/superpowers/specs/2026-07-21-nauvis-trees-design.md`. **Still
      deferred** (do not treat as done): the per-tile placement roll (Phase 2,
      `docs/noise/placement-roll-NOTES.md`), worms/fish autoplacers, and
      cliff exclusion (consistent with the existing ore-on-cliffs gap).
- [~] Non-Nauvis planets (Space Age) - each is another expression set.
      **Vulcanus TERRAIN done 2026-07-23** (V1: spawn geometry, cracks, the radial
      ashlands/mountains/basalts biome system, volcano spots, climate aux/moisture/
      temperature, elevation, the ~24 `*_range` tile-probability expressions + the
      19-tile argmax, and planet-dispatched rendering). Every expression is
      oracle-validated against real Factorio 2.1.12 (Space Age) to the f32 floor.
      Spec/plan: `docs/superpowers/specs/2026-07-23-vulcanus-client-preview-design.md`,
      `docs/superpowers/plans/2026-07-23-vulcanus-client-preview-v1.md`; per-expression
      notes in `docs/noise/vulcanus-*-NOTES.md`.
      - **Perf - FIXED 2026-07-24 (~50x, byte-identical).** Was ~60x heavier per
        pixel than Nauvis (~545 us/px); now **~12 us/px** (~1.4x Nauvis), i.e.
        interactive when tiled across the worker pool (~2s at 1024^2). The prime
        suspect in the earlier note - per-pixel `spot_noise`/region work - was
        **wrong**: a CPU profile put ~81% of the time in raw `basisNoise` eval, and
        a call count showed `basisNoise` running ~12,600x/pixel against a ~200-eval
        floor. Root cause was the **un-memoized field DAG**: unlike the Nauvis
        resolver (which evaluates each field once per pixel into an `env` scalar
        bag), the Vulcanus resolver passed lazy field *closures* into its 19 tile
        `*_range` expressions and re-invoked them per access, so a shared node like
        `mountains_raw_volcano` (feeds all 3 biomes, each read ~5x by the ranges) and
        every noise octave beneath it recomputed ~60-100x/pixel. Fix: `memoXY`
        (`src/noise/eval/memoXY.ts`), a single-slot `(x,y)` cache wrapping each field
        node across the Vulcanus expression files - a render sweeps one pixel at a
        time, so repeat reads collapse to one eval per node per pixel while returning
        the identical float (byte-exact; verified by a stash-diff of a 4-window
        render hash and the full oracle suite still green at 984 passed). Confined to
        the Vulcanus path; the shared noise primitives and Nauvis are untouched.
        **`memoXY` does NOT transfer to Nauvis - Nauvis never had the pathology
        (checked 2026-07-24, don't re-investigate).** Profiled the same way: Nauvis
        terrain is **164 `basisNoise`/px, ~8 us/px** - already at the noise floor
        (Vulcanus's post-fix floor is ~200/px). Two reasons, both verified: (1) at the
        argmax level `tiles/resolve.ts` already evaluates elevation/aux/moisture once
        per pixel into an `env` scalar bag, so the tile catalog reads scalars, not
        closures; (2) inside each field, `elevationNauvis`/`aux`/`moisture` are written
        straight-line - every sub-node is computed once into a local const and then
        combined, nothing re-read. There is no redundant work for a cache to remove, so
        wrapping Nauvis in `memoXY` would only add per-call branch overhead (marginally
        slower). The one remaining Nauvis lever is the hot leaf itself: `basisNoise` is
        ~65% of both planets' time and is now *necessary* work - only SIMD/WASM on the
        kernel would move it, and that would help both planets equally.

      **Vulcanus V2 (resources) DONE 2026-07-24** - the four resource region
      fields (tungsten-ore, coal, calcite, sulfuric-acid geyser), their
      near-spawn starting spots and biome favorabilities, and a resource overlay
      (`view: "resources"`, three solid ores) all ported and oracle-validated.
      Also **restored the three resource-coupling terms** V1 had approximated
      away in the tile catalog (`vulcanus_metal_tile`, `vulcanus_calcite_region`,
      `vulcanus_sulfuric_acid_region_patchy`), raising `get_tile` agreement from
      **96.85% (369/381) to 98.16% (374/381)**. Full writeup, including the
      per-resource parameter table, the two approximations (`random_penalty ->
      1`, no richness) and their measured consequences, the `sulfuricAcidPatches`
      residual anomaly and its resolution, and characterization of the 7
      remaining `get_tile` mismatches (far-field f32 argmax flips, unrelated to
      the coupling restoration): `docs/noise/vulcanus-resources-NOTES.md`.
      - **Perf gate (Task 8, 2026-07-24; corrected in the final-fix pass):
        PASS.** Terrain now evaluates the resource region fields on every
        pixel even with the overlay off, since the tile catalog reads them.
        Measured 11.92 us/px (V1, worktree at `a0ea049`) vs. 13.96 us/px
        (V2, this branch, `view: "terrain"`) at 1024x1024/seed 123456 - a
        1.17x change. **But `"terrain"` is not the view non-dev users get for
        Vulcanus** - Task 7 made `"resources"` the default (`effectiveView` in
        `ElevationPreviewPanel.vue`), and `renderVulcanusResources` builds its
        own independent Vulcanus field stack rather than reusing the terrain
        render's, so the ore DAG runs twice per pixel on that path. Measured
        18.22 us/px for `view: "resources"` - a **1.53x** change against the
        11.92 us/px baseline. Both are well inside the ~2x regression gate,
        so this is a record correction, not a regression - but 1.53x /
        18.22 us/px is the number that reflects what users actually see. See
        `docs/noise/vulcanus-resources-NOTES.md`'s Performance section and
        `.superpowers/sdd/2026-07-24-vulcanus-v2-resources/task-8-report.md`
        for the full before/after table and methodology.

      **Vulcanus V3 (sulfuric-acid geyser) - DONE 2026-07-27.** Shipped
      2026-07-26 as a patch blob (a fourth `VULCANUS_RESOURCE_CATALOG` entry
      painting `sulfuricAcidRegionPatchy > 0` in `map_color` `[199, 199, 26]`),
      which drew the region where the game *rolls* rather than the geysers
      themselves and overstated their area by 4.2x (measured).
      It now rolls: `placement: "roll"` on the catalog entry, the game's
      `vulcanus_sulfuric_acid_geyser_probability` read from source (no
      `random_penalty` - unlike its calcite/coal/tungsten neighbours),
      `makePlacementSet` with the lava tile gate and the 2.8 x 2.8
      `collision_box`, and a 3x3 mark per placement.

      **Validated against the real game.** Oracle region 4 `[-256,-256]` has 56
      geysers and the model places 56; regions 2 and 3 hold no sulfur at all and
      both sides are 0. n = 56 is a weak denominator (Poisson sigma ~7.5) and
      eight alternative salts span 46-63, so read the agreement as unbiased, not
      precise. See `vulcanus-resources-NOTES.md` gap #4 and
      `placement-roll-NOTES.md`. Nauvis crude oil followed in Task 8, which
      closes the last overlay issue #9 tracked.

      **Vulcanus cliffs - DONE 2026-07-26.** `renderVulcanusCliffs` +
      `cliffiness_basic`, oracle-validated to under 5e-6. Far smaller than the
      Nauvis cliff port: the planet overrides `cliffiness` to `cliffiness_basic`
      and `cliff_elevation` to its own `elevation`, so none of the Nauvis
      hills/ringbreak/billows chain is involved, and the placement geometry is
      shared. Vulcanus has **no** cliff autoplace control, so the bands are
      planet constants (elevation_0 70, interval 120) rather than preset fields.
      Not yet validated at entity level against a `find_entities` dump - see
      `docs/noise/vulcanus-cliffs-NOTES.md`.

      **Vulcanus rocks - DONE 2026-07-26.** `renderVulcanusRocks` +
      `vulcanus_decorative_knockout`, oracle-validated. Four rock entities share
      two probability expressions, and everything they read except the knockout
      was already ported for V1's tile catalog. Vulcanus deliberately omits the
      `rocks` autoplace control ("can't add the rocks control otherwise nauvis
      rocks spawn"), so there are no sliders. Rendered as a threshold on the
      probability field, which caps at 0.2 and forms a plateau - so it reads as
      rocky ground rather than as individual rocks, and wants an eyeball. See
      `docs/noise/vulcanus-rocks-NOTES.md`.

      Deferred: demolishers (the only `voronoi_cell_id` user -
      skipping it is why Vulcanus needed no `VoronoiNoise` port). Fulgora/Aquilo
      DO build terrain on Voronoi, so they will force that primitive.

      **Fulgora V1 (terrain) - DONE 2026-08-13** (#27, PRs #164, #186, #189,
      #190, #192, #193). Land / oil-ocean-shallow / oil-ocean-deep, rendered
      through `renderFulgoraTerrain`. Fulgora is the planet that forced the
      `VoronoiNoise` primitive the line above predicted: the map IS a Voronoi
      tiling and every island is one cell, sliced into four classes by cell id.

      **Agreement: 5050/5057 on land-vs-ocean and 2785/2796 on shallow-vs-deep,
      against real `surface.get_tile` names** - the first Fulgora fixture that
      reports what the game placed rather than what an expression evaluated to.
      Every expression in the chain matches the game at its own `basisNoise`
      floor; `fulgora_elevation` is 7.6e-5 absolute, 8e-7 relative.

      **Perf: ~3.91 us/px** at 1024x1024, tpp 1 (min of 3, same harness as the
      rows above). The implementation plan estimated ~12 us/px, so this is **3x
      better than estimated** and the cheapest planet in the table - against
      Nauvis terrain ~8.02, Vulcanus terrain ~14.94 and Vulcanus resources
      ~21.46. No profiling or optimisation was needed. The reason is structural
      rather than lucky: Fulgora resolves a 3-way class from one expression
      chain, where Nauvis and Vulcanus each run a 19-to-21-tile argmax per pixel.

      Two defects worth carrying forward, both recorded in
      `docs/noise/fulgora-elevation-NOTES.md`:

      - **Noise primitives were being fed f64 coordinates** where the game uses
        f32. Fixed inside `sumOctaves` and `makeVoronoi`'s `toGrid`, worth up to
        331x on a single field. A measured no-op for every earlier caller,
        because they all pass raw world coordinates, which are already exactly
        representable; Fulgora is the first caller to pass a derived one.
        Remaining primitives tracked in #191.
      - **A NaN probability must LOSE an autoplace argmax, not poison it.**
        `water_base` returns `-inf` and tiles multiply it by a factor that is
        often 0, so `0 * -inf` NaNs are routine and `Math.max` let one tile veto
        all twelve. Worth 211 of the first 218 mismatches. This is a general
        trap for any planet's tile catalog.

      Deferred for Fulgora: the eight LAND tiles are not resolved against each
      other (the ocean tiles dominate the argmax wherever they are placeable, so
      only the land/ocean split is decided) - which means no road/ruin paving,
      walls, conduit, machinery, `fulgoran-dust` or dunes/sand distinction. Also
      deferred: scrap resources, cliffs, and the island finder. The remaining 18
      tile mismatches are boundary-exclusive and are NOT reachable by any model
      of the four ocean expressions - the game places water where its own
      expressions score it unplaceable - so they need the post-argmax transition
      pass reverse-engineered, not a constant re-fitted.

## Milestone 5 - integration

- [ ] A `previewMap(preset, {width, height, scale}) -> ImageData` entry point.
- [x] Wire into the app UI next to / instead of the `preview-service` call. Keep
      the server path as a fallback and as a cross-check oracle.
- [x] Perf: evaluate off the main thread (Web Worker); tile the viewport. **Done
      2026-07-21** - the 1024x1024 preview is split into 64 128px tiles rendered
      across a pool of `hardwareConcurrency - 1` workers and blitted
      progressively. Browser-measured on a 12-core machine (8 performance + 4
      efficiency), seed 123456, median of 3:

      | view      | single worker | tiled (11 workers) | speedup |
      | --------- | ------------- | ------------------ | ------- |
      | elevation | ~1,700 ms     | 237 ms             | 7.2x    |
      | terrain   | ~9,100 ms     | 1,519 ms           | 6.0x    |
      | all       | ~12,500 ms    | 1,918 ms           | 6.5x    |

      Half the image is on screen about a second before the render finishes, so
      the perceived latency is lower again. Tiling is byte-identical to the
      single render - `test/tiledEquality.spec.ts` asserts it across all six
      views, and the only renderer needing a seam fix was cliffs (marks are
      painted around a cell centre, so each tile queries a 2-tile halo clamped
      to the image).

      Caching per-region spot lists across tiles was measured and **rejected**:
      rebuilding every resolver per tile costs only 1.03-1.07x total CPU, so the
      scene/geometry split it would have required was not worth it. See
      `docs/superpowers/plans/2026-07-21-region-tiling-renderer.md`.

- [ ] Perf: target interactive re-render on slider changes (currently still a
      manual Generate).

## Remaining primitives to reverse-engineer (layer 1)

The binary defines exactly **14** `NoiseOperations::*::run` types. Status:

| op | needed for | difficulty |
| --- | --- | --- |
| `BasisNoise` | everything | DONE |
| `SpotNoise` | resources/enemies | DONE (RNG+select+render) |
| `Const`, `Clamp`, `If`, `PowInt` | all trees | trivial (math) |
| `BinaryExpression`/`UnaryExpression` (arithmetic) | all trees | trivial |
| `MultioctaveNoise` | terrain | DONE (`multioctaveNoise.ts`) |
| `QuickMultioctaveNoise` | climate (temp/moisture/aux) | DONE (`quickMultioctaveNoise.ts`) |
| `VariablePersistenceMultioctaveNoise` | terrain (elevation) | DONE (`variablePersistenceMultioctaveNoise.ts`) |
| `DistanceFromNearestPoint` | spawn/starting area | DONE (`distanceFromNearestPoint.ts`) - `min(maximum_distance, nearest euclidean dist to any point)`; points int/256 fixed-point. Geometry read off disasm; needs runtime point data (see below) so validates via the elevation tree, not standalone. |
| `Terrace` | terrain banding | small - NOT used by any elevation tree (2026-07-19) |
| `Ridge` | terrain | small - NOT used by any elevation tree; every "ridge" in noise-programs.lua is the `b`ridge`` substring (2026-07-19) |
| `RandomPenalty` | jitter | small |
| `Multisampling` | AA/quality | small |
| `VoronoiNoise` | some terrains | **confirmed unneeded for Nauvis** (2026-07-20, M4 cliffs RE) - present in the binary but not referenced by the cliff tree or any other Nauvis expression traced so far; only appears on Space-Age planets. Un-ported, no open TODO. |

Method for each: disassemble `NoiseOperations::<Op>::run` (the capstone
disassembler `scratchpad/re/fdis.py` seeks by symbol address from
`nm | c++filt`), and/or probe it through the oracle, then validate to ~1e-6.
None are "black magic" - the two that were are already done.

### M1 scoping note: the elevation tree depends on runtime spawn data

Traced the Nauvis `elevation` tree (`core/prototypes/noise-programs.lua`). The
default `elevation_nauvis` is large (`elevation_nauvis_function` over `nauvis_main`,
`nauvis_bridges`, `nauvis_detail`, `nauvis_macro`, `nauvis_hills_plateaus`, ...);
the `elevation_lakes` / `elevation_island` variants are smaller
(`finish_elevation{make_0_12like_lakes{...}}`). **All of them reference values that
are not pure noise:**

- `distance` - distance from the spawn point (world origin-ish).
- `starting_lake_positions` / `starting_positions` - runtime-generated spawn/lake
  points, fed to `distance_from_nearest_point`. These come from the game's
  starting-area placement, not a noise expression.
- `water_level`, `segmentation_multiplier` - map-gen settings (scalars the app's
  `Preset` already models, but the noise DSL exposes them as vars).

So an elevation render needs a decision before the evaluator work: either (a) render
**far from spawn**, where the `distance`- and `starting_*`-gated terms fade out, and
supply `water_level`/`segmentation_multiplier` from the preset - the cheapest path to
a recognizable coastline; or (b) additionally RE the spawn / starting-lake placement
to be faithful near the origin. (a) is the right MVP.

There is also an evaluator-shape fork: hand-port each named expression to a TS
closure (roadmap's stated primary strategy) vs. write a parser for the noise DSL
strings. Hand-porting is less upfront work for the MVP; a parser pays off only if
the whole tree corpus gets ported.

## Porting the expression trees (layer 3) - the biggest chunk

Two strategies; use both:

1. **Transpile the Lua** (primary). The base-game expressions live in
   `data/base/prototypes/**` and `data/core/prototypes/**` as the noise DSL (an
   expression-builder API). Re-express each named expression as a JS closure over
   the primitives. Some are generated by helper functions (autoplace utils) - port
   the helper, not each output.
2. **Capture + validate** (safety net). The game can serialize named noise
   expressions; and `calculate_tile_properties` gives exact values. Every ported
   expression is diffed against the game before it is trusted. This is what makes
   the port low-risk despite its size.

This layer is where the real effort and the ongoing maintenance sit: the trees
are large, interdependent, reference the `control:*` constants, and differ across
game versions and base-vs-Space-Age.

## Settings wiring (layer 4)

The app already models the levers in `Preset`
(`autoplaceControls`, `property_expression_names`, seed). The evaluator's `ctx`
needs to expose them as the `control:<name>:frequency|size|richness|bias`
constants and honor `property_expression_names` overrides (which can *replace* a
named expression entirely - e.g. the map-type elevation swap). `seed` = `seed0`
(random -> wire 0); each `basis_noise`/`spot_noise` call carries its own `seed1`.

## Risks and the build-vs-keep decision

- **Maintenance surface.** The expression trees track game versions and base vs
  Space Age. The `preview-service` container gets this for free by running the
  real game; a client port must be re-synced on updates.
- **You already have a working preview.** `preview-service/` (headless Factorio +
  Cloudflare) renders correct previews today. A client-side reimplementation is a
  **UX/infra optimization** (instant, offline, no cold starts), not a correctness
  need. Weigh the ongoing port cost against that benefit before committing past
  the MVP.
- **De-risking:** the MVP (M1) is cheap and proves the evaluator; stop there if
  the value/cost tradeoff does not hold up. The oracle makes every step verifiable,
  so there are no unknown cliffs left after the primitives.

## Suggested module layout

```
src/noise/
  basisNoise.ts          # done
  spotCandidates.ts      # done
  spotSelection.ts       # done
  eval/                  # M1: evaluator + primitive library + arithmetic
  expressions/           # M1+: ported base-game trees (elevation, climate, ...)
  tiles/                 # M2: tile autoplace peak resolution + palette
  preview/               # M1+: per-pixel driver, region spot cache, render to canvas
test/oracle/             # M0: committed headless harness + capture helper
```

## Immediate next action

Start **M0 + M1**: commit the oracle harness, build the evaluator core, RE
`MultioctaveNoise`, port Nauvis `elevation`, render land/water. That converts the
two solved primitives into an actual image and locks the evaluator design before
the large expression port begins.
