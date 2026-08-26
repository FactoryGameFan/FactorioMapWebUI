# Rust/WASM noise port - the full measurement record

This is the narrative record of the Rust/WASM port (issue #215, phases 0-6),
lifted verbatim out of `CLAUDE.md` at commit `57d3fb3` on 2026-08-25. It moved
because that section had grown to 77,578 characters - 43% of a `CLAUDE.md` that
was 29k over Claude Code's 150k limit - and most of its length is the story of
how a number moved rather than a rule anyone needs at the keyboard.

**`CLAUDE.md` still carries every rule and every trap.** What lives here and not
there is the archaeology: the before-and-after count tables, the candidate
sweeps that were rejected, the per-phase landing lists, and the three or four
retellings of how a wrong belief was refuted. Read this when you want to know
why a number is what it is, or when a frozen count moves and you need to know
what moved it last time.

The snapshot itself has not been edited, so it goes stale the moment the port
moves; `CLAUDE.md` is the current state and this is the paper trail. Records
shed by `CLAUDE.md` since then are APPENDED under "Later additions" at the
bottom rather than merged into the snapshot, each one dated, so the 2026-08-25
text stays readable as the thing it was.

---

### The Rust/WASM noise engine (`crates/`) - phases 1-4 landed, phase 5 in progress

A Cargo workspace at the repository root, landed empty on purpose (#219) so the
gate was proven green on `main` before any port code depended on it. Two crates:
`fmw-noise` is the engine library and `fmw-wasm` is a `cdylib` holding only the
boundary. The design record is
`docs/superpowers/specs/2026-08-16-rust-wasm-noise-engine-design.md`.

**Do not read the byte counts in this section as current.** They have gone stale
twice already, because every ported op changes them: 599 bytes at phase 0, 23,363
after `basis_noise` and the multioctave family, 42,952 after the phase-1
primitives. `verify:rust` compares the committed module against a fresh build, so
the gate always knows the right number even when this file does not. Get it with
`shasum -a 256 src/noise/wasm/engine.wasm`, and do not add a new count here
without deciding it is worth maintaining.

**Phase 1 is complete** (#220): `taus88`, `fast_approx`, `basis_noise` and its
gradient table, the four multioctave ops, `random_penalty`, `spot_candidates`,
`spot_selection`, `distance_from_nearest_point`, `starting_lakes` and
`voronoi_noise`.

**Phase 2 is complete** (#221): the `eval` layer - `multisample`, `memo_xy`,
`memo_region`, `math`, `ctx`, `primitives`, plus `expressions/vulcanus_seed`.
Five oracle fixtures joined tier 1 (`oracle-fastpow`, `oracle-multisample`,
`oracle-multisample-grid`, `oracle-seed-vars`, and the `sliderRescaleProbe` in
`oracle-fulgora-elevation`), which also closed a standing gap: `fast_approx`
shipped in phase 1 with **no tier-1 test and no poison hook** of its own.
`eval/f32.ts` has no Rust counterpart on purpose - the narrowing is the type -
and `eval/mod.rs` carries the two-case rule in its place.

**Phase 3's EXPRESSION half and its BOUNDARY are complete; the cutover is
not** (#223). Landed: `expressions/fulgora_shared`, `fulgora_cells`,
`fulgora_elevation`, `starting_spot_at_angle`, and `tiles/` with `water_base`,
`best_probability` and the ocean test the land mask is built on. Tier 1 grades
all 41 named fields against `oracle-fulgora-{shared,cells,elevation}` plus
`oracle-starting-spot`, and the whole chain end to end against
`oracle-fulgora-tiles` - 5,057 tiles the game actually placed. Tier 2 folds all
42 fields at two slider settings. The CSP change (#222) has landed.

Part 2 added the boundary: `crates/fmw-wasm/src/abi.rs`, `render.rs`, and
`src/noise/wasm/{request,engine}.ts`. **Tier 3 is byte-identical RGBA** against
`renderFulgoraLandMask` across four windows that vary width, height, origin,
tiles-per-pixel and both sliders independently.

**The request layout is at ABI v2 and is now per-planet** (#225). v1 was one
fixed 104-byte struct with Fulgora's two island sliders and four trig values
baked into it; v2 is a 56-byte common prefix followed by a block whose length
the prefix declares. v1's `reserved` word became `params_bytes` - what its own
comment said it was for - and its `ReservedNotZero` status became
`BadParamsLength`. A Fulgora request is still exactly 104 bytes; a Vulcanus one
is **368**, most of that being ten `(sin, cos)` pairs against Fulgora's two plus
two world boxes. It has grown twice since - 304 -> 336 for the cliff view's
`cell_query_box`, 336 -> 368 for the overlays' `placement_sweep_box` - and
neither time needed a version bump, which is the split working. Nauvis gets a
third block in phase 6, also with no bump.

`test/fixtures/wasm-request.v2.json` pins the encoding for both planets. It is
declared under `notFixtures` because it is our own ABI rather than Factorio
ground truth, and its bytes were checked by
`test/fixtures/verify-wasm-request.py` - a third implementation, not the writer
under test - which is committed beside it so a future version is re-verified the
same way rather than regenerated from the encoder.

**That checker was measured MISSING a real defect, which is why it has three
trig checks and not one.** It cannot reproduce the trig VALUES, because those are
V8's `Math.sin` after an f32 narrowing and a second libm is exactly the
disagreement #270 measured. Checking each pair for `sin^2 + cos^2 = 1` catches a
shifted or half-shifted block - and **passed a planted swap of two bearings**,
which is the failure that renders a plausible planet with its biomes rotated. It
now also recovers each angle with `atan2` and checks it against the offset the
game's Lua gives it from the ashlands bearing. Seven planted breaks are caught,
up from four. A property check is not a structural check; this is the cheap way
to find out which one you wrote.

Errors return a **status code and do not trap**, because a trap would poison the
instance for every later request in that worker; a spec sends a bad magic and
then renders successfully through the same instance.

Part 3 is the cutover. `runRenderRequest(req, engine?)` takes an OPTIONAL
engine and dispatches Fulgora's land mask to it when one is supplied - a
parameter rather than module state, so nothing has to be registered or reset
between tests. `createRenderWorker` loads and compiles the module once per page
and posts it to each worker it creates; the worker instantiates synchronously
with `new WebAssembly.Instance(module)`, which is allowed for an
already-compiled module on any thread.

**A render dispatched before the engine message arrives is not a bug**, and that
is what makes the cutover safe rather than merely tested: the two paths are
byte-identical, so an early request takes the TypeScript path and returns the
same pixels. There is no window in which the worker is wrong, only one in which
it is slower - which is also why a failed fetch or compile is swallowed.
`test/renderWorkerEngine.spec.ts` asserts exactly that, comparing the pixels
from before the handshake against the pixels from after it.

**The engine load sits in `createRenderWorker`, not in `createWorkerHost`, and
that is not stylistic.** Every test that exercises the host constructs it with a
fake worker factory, and fetching from the host made those tests print a page of
`ECONNREFUSED` while still passing - under vitest the module URL points at a dev
server that is not running. Loading beside the real `new Worker` means only the
real browser path ever reaches the network.

The in-browser measurement is done - see the speedup table below. #223 is
complete.

**Phase 4 (#224) adds the rest of Fulgora**: `fulgora_masks`, `fulgora_roads`,
`fulgora_ruins`, `fulgora_scrap`, `tiles/fulgora_catalog` with the eight land
formulas and the argmax, and `fulgora_stack` composing the whole graph. Tier 1
grades 26 more named fields plus the scrap probability, and the FULL tile argmax
against the tile the game placed - **4,915 of 5,057**, the same count the
TypeScript reaches. Tier 2 folds 76 fields at two slider settings.

`poison::index_result` is the argmax's own control, and it needed one: under
poison the ocean hook flips every position's answer, so the tile test would have
been red whether or not the argmax had a control at all. `POISONED_TESTS` now
carries FULL test paths rather than bare `fixtures::` names, so a control can
live beside its op.

**Phase 5 (#225) ports Vulcanus, and the planet now RENDERS through the
engine.** Landed: `vulcanus_helpers`, `vulcanus_cracks`, `vulcanus_climate`,
`vulcanus_spawn`, `vulcanus_biomes`, `vulcanus_elevation`, plus
`vulcanus_temperature` on the elevation module; then `vulcanus_resources`,
`tiles/vulcanus_catalog`, `vulcanus_stack`, and the `terrain` render path
behind ABI v2. `vulcanus_shared` needed no port - it is
`starting_spot_at_angle`, done in #279 - and `vulcanus_seed` landed in phase 2.

**Phase 5's second half adds the CLIFF stack, and `cliffs` renders through the
engine too.** `cliffs/{catalog,placement,connections,vulcanus_fields,
vulcanus_ore_rejection}` plus the ore footprint slice of
`resources/vulcanus_catalog`.

**Phase 5's third part finishes Vulcanus: `rocks`, `resources` and `all` render
through the engine, so every view the planet has now does.** New modules:
`placement/roll` (the per-chunk taus88 placement roll and its two gates),
`rocks/{catalog,vulcanus_field,vulcanus_placement}`,
`resources/vulcanus_geyser`, and the rest of `resources/vulcanus_catalog` - map
colours, entry ordering, `sulfuric_acid_geyser_probability`. The routing test in
`test/wasmVulcanusRenderParity.spec.ts` used to assert those three views stayed
on the TypeScript path; it now asserts the opposite, and it is what would have
gone red had they moved ungraded.

**The placement roll is the first ported thing that is not a noise expression**,
and it is graded differently because of it. There is no per-position fixture:
the game's ground truth is `oracle-entity-counts.seed123456.json`, which is a
count per 512x512 region, and scoring one region costs **~33s in a debug
build** - the same order as the cliff connection test that already took
`verify:rust` to 1m50s. So the roll is graded against the game on the
TypeScript side (`test/entityDensity.spec.ts`, three rock regions and three
geyser regions) and the two ports are tied together by tier 3's byte-identity.
Its cargo tests are structural: the reverse-engineered chunk seed word, the
DECREASING tile order (the first draw belongs to tile 1023 - a reversal is
invisible to any density or uniformity check), salt decorrelation, and the
order-dependent collision pass.

**Tier 1 for the rock field is `oracle-vulcanus-rocks.seed123456.json` at 434
positions, and `vulcanus_decorative_knockout` is BIT-EXACT at every one of
them** - worst residual exactly 0, the strongest tier-1 result any Vulcanus
field has. It is a bare two-octave `multioctave_noise` at `output_scale = 1`,
so nothing sits between it and the primitives #290 and #293 fixed. The two
composites above it carry the biome layer's error: `vulcanus_rock_huge` 178 of
434, `vulcanus_rock_big` 205. All three counts were measured on the TypeScript
side too and agree exactly.

Read `density` (412 of 434) with its clamp: **399 of those positions clamp to
exactly 0** and a saturated position is exact for free, so of the 35 nonzero
positions only 13 are exact. Same reading `*_biome_full` versus `*_biome` gets
in the biome layer.

**The TypeScript's own bounds on those three fields are 2e-4 / 5e-4 / 5e-4
against measured worst residuals of 0, 3.7199e-7 and 2.5693e-7** - the first
inert outright, the other two 1,300x wider than the thing they bound. That
side's comment still describes the knockout's residual growing with distance to
1.18e-4, which was true before #290 and #293 narrowed `basis_noise`'s input
scale and is not true now. Recorded rather than fixed there; it belongs to #256
with the other 86.

**ABI v2's Vulcanus block grew again, 280 -> 312, and again with no version
bump.** The new field is a SECOND world box, `placement_sweep_box`, and it is a
second box rather than a reuse of `cell_query_box` because the two halos are
different shapes: the cliff block spans `px - 2 ..= px + 1`, so its halo is
asymmetric and its two directions cross, while a placement mark is a symmetric
3x3 centred on its pixel. `test/fixtures/verify-wasm-request.py` grew six more
planted breaks for it, every one RUN rather than listed - five are caught by
the per-edge value check (the cliff box written into both slots, the two boxes
swapped, a block shifted by one f64, one edge wrong, a stale declared length)
and the sixth is not: a halo one tile wider on the low x side, with the request
edited to agree, passes every value check and is caught only by asserting the
placement halo is symmetric about the pixel box. The no-coinciding-edge check
caught none of the six and is a fixture constraint, which the file now says.

**The measured geyser peak in the TypeScript was wrong, and the two numbers
recorded beside each other did not agree.** `vulcanusResourceCatalog.ts`
recorded the sulfuric-acid geyser's peak probability as **0.0883** at
(2481, -1985) "where `patchy` is 1.217". The expression is
`0.025 * ((patchy > 0) + 2 * patchy)`, which at 1.217 is 0.08585; evaluating the
chain at that exact position at seed 123456 gives `patchy = 1.2172893` and
**0.0858645**. The position and the `patchy` are right and the probability was
not - 0.0883 would need a `patchy` of 1.266. Nothing depends on the difference
(both are two orders of magnitude below calcite's saturated ~1, which is all the
catalog-ordering argument needs), and both sides are corrected.

**Three of the nine TypeScript files in that directory pair were NOT ported, and
each for its own reason.** Read this before "finishing" them:

- `cliffFields.ts` and `rocks/rockField.ts` are NAUVIS. They need
  `nauvis_shared`, `elevation_nauvis`, `aux` and `moisture` - 464 more lines
  that are the core of #226 - and neither reaches a Vulcanus view. They belong
  to phase 6.
- `cliffConnections.ts` WAS ported, and it is the odd one: it has **zero `src/`
  consumers**. `grep -rln` finds it imported by 23 investigation specs and by
  nothing the renderer runs. It models `Cliff::updateConnections` /
  `onDestroy`, which is #84's subject, and it was ported so that investigation
  can be run against the engine rather than only against the TypeScript.

**Tier 3 for Vulcanus** (`test/wasmVulcanusRenderParity.spec.ts`) is
byte-identical against the TypeScript across four windows for `terrain`,
`cliffs`, `rocks` and `all`, and across five more for `resources`, and
**12,423 of 929,686** compared pixels against the game's own 1024x1024 PNG -
98.664%, which is the TypeScript's own number to four decimal places, reached
through a separate path. It is asserted as an EXACT count where
`previewAgreement.spec.ts` uses a 2% bound, because byte-identity means it can
be.

**Tier 2 for Vulcanus landed 2026-08-24 and CLOSED #225's last gate item**
(`test/wasmVulcanusParity.spec.ts` + `checksum_vulcanus`). It folds **74 named
fields** - helpers, spawn, cracks, climate, biomes, elevation, temperature,
resources, the geyser probability, the three tile-support fields,
`cliffiness_basic`, the knockout and the two rock expressions, then the 19 tile
probabilities and the argmax over them - at two slider settings in two windows,
296 comparisons of 676 points each, in **7.0s**.

**The parameters cross as a REQUEST, not as arguments**, and that is worth
copying for Nauvis. Fulgora's `checksum_fulgora` takes its seven parameters in
its signature; Vulcanus needs 31 more `f64` (three sliders, four resource
control pairs, ten bearings), so `checksum_vulcanus(request_len, field)` reads
the request already in the scratch buffer, written by the shipped
`encodeRenderRequest`. The win is not the shorter signature: the module then
builds its stack through the same `render::vulcanus_{ctx,base,biomes,stack}`
helpers the RENDERER uses, so a bearing wired to the wrong layer is INSIDE the
comparison. A private copy of that wiring would be reproduced identically on
both sides and stay invisible. The sweep is the request's own pixel grid, swept
rows-outer exactly as `render_vulcanus` sweeps it, so there is one geometry
convention rather than two.

**The field SELECTOR lives in `fmw-noise`, not in the wasm crate, and copy that
for Nauvis too.** `VulcanusParity` sits beside `VulcanusStack` in
`expressions/vulcanus_stack.rs`; the wasm export builds the stack through the
render helpers and then calls `parity.field(field, x, y)`. The reason is
ownership of test-only API: the selector needs `elevation_fields` and
`temperature`, which NO render path reads, and reaching them from another crate
meant two `pub` methods on a library type that existed solely for a test - and a
`pub` method cannot be `#[cfg(test)]`-gated, because the wasm crate calls it at
build time. Keeping the selector in the same module makes both private again.
The field count moved with it (`VulcanusParity::FIELD_COUNT`), so the count and
the `match` it bounds cannot drift apart.

The move is pure code motion and was checked as such rather than assumed: tier 2
(74 fields) and tier 3 (byte-identical renders) both pass unchanged. It DOES
move `engine.wasm` by 142 bytes, because the selector inlines differently once
it is in the same crate as the layers it reads - which is a reminder that a
wasm diff is not by itself evidence of a behaviour change.

**It found a real divergence on its first run, and the divergence was #309 -
now fixed, see below.**
`basisNoiseExpr` forms its coordinate product in f64 and narrows once
(`primitives.ts:66`); the Rust narrows `x` to f32 first and multiplies two f32s
(`primitives.rs:87`). They agree at every f32-exact coordinate and differ
everywhere else - **32 of the 74 fields** on an off-grid sweep, and one
narrowing takes that to **0 of 74**.

Three blind spots had to line up for that to survive three shipped PRs, and each
is worth more than the bug:

- **No fixture can grade it.** The game snaps every sample to its own 1/256
  MapPosition grid before evaluating (#186), and that grid is a subset of the
  f32-exact grid. At the snapped positions - the points the game actually
  visited - both forms give `hairline_cracks` **61 of 61 exact, worst residual
  exactly 0**.

  **Scoring at the RAW fixture coordinates is a trap that returns a confident
  wrong answer**, and it was walked into while chasing this: it reports 48/61
  for the TypeScript form and 50/61 for the Rust one, which looks like a
  measurement settling the question and is really a comparison at 21 points the
  game never evaluated. `test/captureGrid.ts` exists for exactly this; use
  `snapPosition` before scoring anything against a fixture.

- **Tier 3 cannot see it.** All four of its windows use binary fractions
  (origins `512.5` and `3000.75`, `tilesPerPixel` `0.5`, `1`, `8`), so every
  coordinate is f32-exact and the ports agree by construction.

- **The tile argmax absorbs it.** In the off-grid sweep `resolvedTile` matched at
  all 676 points while 17 of the 19 probabilities behind it diverged. That is the
  same property that made `poison::index_result` necessary, and it is the
  standing answer to "tier 3 is byte-identical, so why build tier 2".

**#309 IS FIXED, and it was settled by measurement rather than by the
internal-consistency argument this file used to record here.** That argument -
both ports' multioctave already narrows (`multioctaveNoise.ts:203`,
`multioctave_noise.rs:137`), the game holds its noise variables at f32 - pointed
the right way but proved nothing, and this section previously said so.

**The measurement came from a fixture already committed, not from a new
capture.** `fulgora_basis` is a multioctave read at Fulgora's DERIVED coordinate
`wx = ox + wobble_x * wobble_mask`, computed in f64 and therefore off the f32
grid at **55 of that fixture's 101 positions**. Scored against the game:

| `sumOctaves` incoming coordinate |       exact | worst residual |
| -------------------------------- | ----------: | -------------- |
| **narrowed** (what shipped)      | **101/101** | exactly 0      |
| un-narrowed (planted)            |      81/101 | 7.0333e-6      |

Twenty positions discriminate, so the game demonstrably narrows the incoming
coordinate, and the Rust form was the right one. `basisNoiseExpr` now narrows
`x` and `y` before the `input_scale` multiply.

**That is also the measurement #191 asked for, in its own words** - "a caller
that passes a derived coordinate" - and Fulgora has satisfied it since it
landed, unnoticed for months. Two lessons, and the second is the transferable
one:

- **Fold the fixtures you already HAVE before capturing more.** The plan here
  was a far-field capture at |x| >= 65536, where the 1/256 grid stops being a
  subset of the f32 grid. It would have worked and it was unnecessary: a
  DERIVED coordinate leaves the f32 grid right next to the origin, so the
  evidence was sitting in `oracle-fulgora-elevation` the whole time.
- **A "no fixture can grade this" claim is about the fixtures you looked at.**
  It was true of every Vulcanus fixture and false of a Fulgora one.

**#191 is two-thirds done and its issue text is stale.** Re-read the code, not
the issue: `quickMultioctaveNoise` ALREADY narrows both coordinates
(`quickMultioctaveNoise.ts:192-193`), so only one of its three ops was
outstanding. `variablePersistenceMultioctaveNoise` narrowed `x` and NOT `y` - in
**both** ports, which is why tier 2 could not see it: the two agreed with each
other while both disagreed with the game. `x` was narrowed only as a side effect
of the `f32(x + offset_x)` add; `y` had no add and so was silently multiplied in
f64. Both ports now narrow it.

The third op, `basisNoise` itself, was deliberately NOT changed. Its disciplined
callers all narrow before calling, so narrowing inside would be a no-op for
them - and its remaining direct callers (`nauvisShared.ts:133-134`,
`startingPatches.ts:185`, `regularPatches.ts:164-165`) are unported NAUVIS
chains where the whole expression is un-narrowed, not just the coordinate.
Planting the internal narrowing leaves all 26 of their specs passing, so no
committed fixture discriminates it. That belongs to #226, scored layer by layer
under the greedy-accept rule, not to a change that cannot grade it.

**The parity windows still sweep ON the f32 grid, and the pin has been
INVERTED.** `the two ports agree off the f32 grid` now asserts **0 of 74**
diverging where the pin froze 32, and reverting `primitives.ts` reproduces
`[ 'hairlineCracks', ...(31) ]` - checked by planting, not assumed. Its
anti-vacuity is not optional and is easy to get wrong: "nothing diverges" is
exactly what a sweep evaluating nothing would report, so the test also asserts
the off-grid window's folds differ from the on-grid window's on all 74 fields.
The windows themselves are kept as they are because they are tuned for FIELD
coverage (the `startingArea` range, all 19 tiles placed), not because the
restriction is still load-bearing.

Two anti-vacuity numbers, both frozen: the two windows differ on **all 74**
fields, and each places **all 19** tiles, so every probability fold is graded
over a window where its tile actually wins somewhere. The second slider setting
moves 50 of the 74; that one stays a floor, because which fields read a slider is
a property of the chain rather than a result.

**Tier 2 has a SHELF LIFE, and #227 is the deadline.** It compares Rust against
TypeScript, and #227 deletes the TypeScript. It can only ever be written while
both exist, so Nauvis's (#226) must be written as each layer lands rather than
at the end.

**The resource overlay has its OWN five windows, and it has to.** Ore patches
are far sparser than rocks: three of the four windows the rest of that file uses
contain no ore at all, so a per-window count over them reads `[0, 0, 53, 0]` and
three quarters of the comparison is vacuous. The five were found by sweeping the
map for ore and then varying width, height, origin and tiles-per-pixel
independently across what was left. Only the fifth carries geysers, which is why
it is there - it is the one window that grades the ROLLED pass, and the one the
resource halo test runs on, since the three thresholded ores paint a single
pixel each and ignore the sweep box entirely.

**The composite's paint ORDER is asserted, not described.** Resources first,
then rocks, then cliffs - so a cliff or a rock crossing an ore patch reads as
the thing that is in the way. Reordering the three passes changes only the
pixels where two of them land, which is 208 of 16,384 in the window that grades
it (2 covered by a rock, 206 by a cliff) - invisible to a whole-image bound, and
frozen exactly.

**The cliff stack's tier 1 is the game's own cliff entities, four columns, both
rejection arms** - and every one of the 24 numbers was measured on the
TypeScript side too and agrees exactly, so they describe the distance BOTH ports
sit from the game:

| arm       | game |     ours | matched | orientation |
| --------- | ---: | -------: | ------: | ----------: |
| lava only | 1569 |     1570 |    1525 |        1492 |
| shipping  | 1569 | **1547** |    1525 |    **1504** |

`orientation` is four bits per cell against `LuaEntity.cliff_orientation` where
position is one, and it is what says the two ports produce the same cell CODES
rather than merely the same positions. The ore rejection removes 23 cells, none
of them a cliff the game kept, and takes wrong orientations **33 -> 21** - which
is exactly the figure `renderVulcanusCliffs.ts` records having measured, reached
through a separate implementation.

**`cliffiness_basic` is exact at all 12,675 captured corners**, with the clamp
saturating at 8,431 of them - read the count with its clamp, the way
`vulcanus_biomes`' three clamped biomes are read.

**The corner fixture's `elevation` column is the TILE channel, and grading
`cliff_elevation` against it is a category error worth 60.6 tiles.** That is
issue #83 - `multisample`'s offsets are in the consuming program's grid units,
so the 4-tile cliff lattice and the 1-tile tile lattice read different values.
Both ports score the same 419 of 12,675 against it, because both read the right
field and the fixture holds the other one. The test now grades the TILE-channel
field (786 of 12,675, worst 4.393e-2, identical on both sides) and asserts the
two grids DISAGREE at 2,519 corners - turning #83 from a comment into a live
assertion. The gap is **sparse and large** rather than a uniform offset, which
is why the wrong channel cost seven points of recall instead of being obvious.

**The cliff pass needed THREE poison hooks, not one.** `crosses_cliff` returns a
tri-state classification a numeric hook cannot reach (`poison::crossing_result`,
which ROTATES rather than negating - negating `0` is `0`, the answer most edges
give, so a sign flip would leave most of the lattice untouched). And
`fixImpossibleCells` has no value to bend at all, only a choice of which edge to
clear, so it gets `poison::sweep_order`. Both have their own test in
`POISONED_TESTS`, because under poison the crossing hook moves every edge in the
lattice and the end-to-end test would be red whether or not the sweep had a
control.

**ABI v2's Vulcanus block has grown twice with NO version bump - 248 -> 280 for
the cliff view, 280 -> 312 for the overlays** - and that is the per-planet split
working rather than a shortcut: the prefix declares its own block length,
`BadParamsLength` refuses a writer that disagrees, and Fulgora's request has not
moved a byte through either. A version bump is for a change to the COMMON
prefix, which every planet reads.

Both new fields are world boxes, and both are **sent rather than derived**,
because each needs the FULL image's geometry - which the prefix does not carry
and only the tiled renderer knows. They are two boxes rather than one because
their halos are different SHAPES: the cliff block spans `px - 2 ..= px + 1`, so
its halo is asymmetric and its two directions CROSS, while a placement mark is a
symmetric 3x3 centred on its pixel.
`test/fixtures/verify-wasm-request.py` grew five planted breaks for the first
box and six for the second, all RUN rather than listed. Every one of the eleven
is caught by the per-edge value check except the last: a halo one tile wider on
the low x side, with the request edited to agree, passes every value check and
is caught only by asserting the placement halo is symmetric about the pixel box.
The structural checks (four distinct edges, not inverted, no edge shared between
the boxes) caught none of them and constrain the FIXTURE, which the file says
rather than claiming credit.

**`vulcanus_stack` is TWO structs, and that is ownership rather than taste.**
`VulcanusBiomes`, `VulcanusElevation` and `VulcanusResources` all borrow the
layers beneath them, so one struct owning the whole graph would be
self-referential. `VulcanusBase` owns everything that owns its data; the biome
layer is a named local because two layers borrow it; `VulcanusStack` holds the
rest. Three lines of construction instead of one, and honest about it.

**Every one of the 20 frozen counts this phase added agrees with the
TypeScript**, measured on both sides against the same fixtures with the same
1/256 capture-grid snap - the same count AND the same worst residual to every
printed digit. The four starting spots are the load-bearing agreement: 1082,
974, 969 and 1049 of 1085 are the only counts `test/vulcanusResources.spec.ts`
freezes rather than bounds, and the port reproduced all four without having seen
them. Tile placement is 374 of 381 at the forced surface seed and 368 at a real
save's, both matching the TypeScript, with the raw map seed scoring 37 as the
control.

Tier 1 grades **24 named fields** across six fixtures. Every count was measured
again on the TypeScript side against the same fixture and all 24 agree, so they
are the distance BOTH ports sit from the game rather than a gap between them.

**Four things this phase measured that are worth more than the counts:**

- **A second, independent fixture pointed at #269, and #269 has since landed.**
  `hairline_cracks` is the shallowest expression in its layer - a bare `plasma`,
  nothing composed on top - so its weakness could not come from the crack file.
  `plasma` subtracts two `basis_noise_expr` results, and that adapter returned
  the un-narrowed f64 product. Fixed in `df3e39e`, and this branch re-scored
  against it:

  | field                | before  | after       | exposed?                      |
  | -------------------- | ------- | ----------- | ----------------------------- |
  | `hairlineCracks`     | 3/61    | **2/61**    | directly, at output scale 0.6 |
  | `floodCracksA`       | 15/61   | 15/61       | no                            |
  | `floodCracksB`       | 40/61   | 40/61       | no                            |
  | `floodPaths`         | 10/61   | 10/61       | no                            |
  | `floodBasaltsFunc`   | 8/61    | **9/61**    | via `hairline_cracks`         |
  | `mountainPlasma`     | 7/38    | **11/38**   | directly, at 125 and 625      |
  | `elev` / `elevation` | 113/434 | **115/434** | directly, at 250 and 150      |

  **Two corrections came out of that, and both are worth more than the counts.**

  First, **exposure is transitive.** `fixtures.rs` predicted the four flood
  fields would not move, on the grounds that eleven of the layer's twelve DIRECT
  `basis_noise_expr` calls sit at power-of-two output scales. Three held.
  `floodBasaltsFunc` did not, because it READS `hairline_cracks` -
  `+ 0.3 * min(0.5, hairline_cracks)`, right there in the layer's own verbatim
  transcription. The three that held are exactly the three that never touch it.
  Count composition, not call sites.

  Second, **`hairlineCracks` went DOWN, 3 to 2.** That is not evidence against
  the fix: the primitive is graded 196/196 against the game at five output
  scales. It is the both-directions movement #273 measured. These chains carry
  other unported narrowings, so correcting one term shifts values slightly and a
  position that happened to land exactly right can stop doing so. A count
  falling by one at 61 positions says the field is still wrong for reasons this
  change does not address.

- **A clamp flatters a count, and here it is measurable.** The three clamped
  biomes score 403, 402 and 408 of 434 against their own unclamped sources at
  128, 107 and 127 - the same quantity, times 2, clamped. Nothing improved
  between them: the clamp saturates at 0 or 1 over most of the map and a
  saturated position is exact for free. Read `*_biome_full` as the port's score
  and `*_biome` as what the consumer needs. Same effect in `starting_area`
  (371 of 410) against the unclamped `ashlands_start` (61) feeding it.
- **The oracle cannot see elevation's `-500` clamp**, and that was checked
  rather than assumed. `vulcanus_elevation` is `max(-500, elev)` and the
  captured `elev` bottoms out at **-58.77**, so the two columns are the same
  field at all 434 positions - 0 of 434 differ - and a port that dropped the
  `max` would score 115 either way. Both are graded anyway; the clamp's real
  test lives in the module, constructing the case the fixture does not.
- **A discrete output scores like one.** `mountain_volcano_spots` at 359 of 434
  is the highest UNCLAMPED count in the Vulcanus port, because it is dominated
  by which single candidate survives per region - a choice a sub-ULP error
  almost never changes. The same property `voronoi_cell_id` has.

**`detailNoise` is the reading to carry out of this phase.** It has the
SMALLEST residual of its three helper fields (7.778e-5) and the FEWEST exact
matches (**1 of 38**), where `mountainPlasma` has 2.815e-3 and 11 of 38. A field
can be uniformly close and almost never right, which is the argument for
counting matches rather than bounding error, stated in one number.

Read elevation's worst residual of 1.332e-1 against its scale before reacting:
the field spans -58 to +1024, so that is ~1.3e-4 relative, the same order as
every layer above it. An absolute bound would need re-tuning per field for
scale alone - a third reason not to use one.

**`vulcanus_biomes` keeps a REAL cache, and it is the only layer that does.**
Every other ported layer evaluates top to bottom into locals, because every read
is at the same `(x, y)`. `raw_spots` is not: it reads selected spots from up to
four neighbouring regions, which is genuine cross-position state. The region
cache is a `RefCell<BTreeMap>` so `eval` can stay `&self` while the density and
favorability closures handed to `select_spots` borrow it. `BTreeMap` rather than
`HashMap` deliberately - nothing iterates it today, but a determinism-critical
port should not carry a container whose iteration order is unspecified.

`volcano_area` is evaluated at every spot candidate and pulls the whole
pre-volcano chain at that candidate; the TypeScript memoizes those and the port
recomputes them. **Nothing on the render path reaches this layer yet**, so it is
correct-first on purpose. If it ever joins a per-pixel render that is the first
measurement to take - `multioctave_noise`'s own docs record what happened last
time a per-call rebuild went unmeasured, which was 20x.

**The mountains pre-volcano split is load-bearing.** `mountain_volcano_spots`
depends on the mountains biome and the mountains biome folds the volcano field
back in; the Lua breaks that with a PRE-volcano stage that `volcano_area` reads.
Collapsing the two is an infinite recursion, which announces itself - reading
`volcano_area` off the POST-volcano raw does not.

**`cliff_elevation` is a separate entry point, not a convenience.**
`multisample`'s offsets are in the CONSUMING program's grid units, so the cliff
generator's 4-tile lattice moves the field 16 tiles for a `dx` of 4 (#83). The
tile and terrain channels pass 1; cliffs pass 4; both go through one code path
with the grid as a parameter.

**Tier 3 now covers both preview PNGs**, which is what #224's gate asks for.
`test/wasmFulgoraRenderParity.spec.ts` renders through the real boundary and
compares against the images Factorio itself produced:

| comparison                                              | result                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| WASM vs TypeScript, landmask AND terrain, four windows  | byte-identical                                                      |
| WASM vs `oracle-preview-fulgora-terrain.png`, 1024x1024 | **34,977** differing pixels (3.34%) - the TypeScript's exact number |
| WASM scrap footprint vs the scrap PNG                   | **1,825** game scrap pixels, **1** outside the footprint            |

The terrain figure is an EXACT count rather than a bound, because the two
renders are byte-identical: it must be that number, not merely under 4%.

The scrap comparison is a SUPERSET on the FOOTPRINT, never equality and never
against a rolled overlay. `map_grid` defaults to true, so the game draws solid
ore as a 2x2 checkerboard at about 0.5 pixels per entity, and a roll paints only
where a draw succeeds - about 40% of the nonzero positions. Diffing rolled
pixels would measure the salt rather than the model.

**And the seed trap has its own test.** The PNGs come from
`--generate-map-preview --map-gen-seed`, a MAP seed, while every `oracle-*.json`
comes from `sampleExpression`, which forces the SURFACE seed. Rendering with the
map seed makes the same comparison collapse from 3% differing to over 40%, and
that is asserted rather than described.

**`multioctave_noise(x, y, &params)` REBUILDS its seed tables on every call, and
that cost 20x before it was measured.** `tables_from_seed` runs a PRNG over
three 256-byte permutation tables, and `octave_terms` re-derives the octave
list; Fulgora's chain makes eight such calls per pixel. Hoisting them into a
`Prepared` built once per render - which is exactly what the TypeScript's
`makeMultioctaveNoise` closure has always done - moved a 256x256 landmask render
from **975.8ms to 50.7ms** in the same harness, a **19.2x** within-arm
improvement. Nothing in tiers 1-3 could see it, because the results are
identical either way; only a benchmark can. The wrapper carries the warning in
its own docs.

**The engine is ~2.46x faster than the TypeScript IN THE BROWSER, and the
"22.71x" #275 published is wrong.** That number came from a benchmark running
inside vitest, where the TYPESCRIPT arm is taxed and the WASM arm is not:

| harness             | TypeScript |        WASM |     ratio |
| ------------------- | ---------: | ----------: | --------: |
| Chrome, dev server  | **246 ms** | **99.7 ms** | **2.46x** |
| Node, inside vitest |    1134 ms |     50.7 ms |     22.4x |

The same TypeScript is **246 ms in the browser and ~1130 ms under vitest**, and
its warm-up trace is flat from the first pass, so that is not a cold JIT - it is
issue **#267**, vitest's per-module transform, which #267 measured at 3.7x on a
different file. **A ratio measured under vitest is not an engine comparison**,
because only one of its two arms pays that tax. Note the WASM arm differs the
other way (50.7 ms in Node against 99.7 ms in Chrome), so neither engine is
uniformly faster - which is the second reason to quote the browser.

Browser method, on the geometry the island finder uses: warmed 12 passes per
arm, interleaved, min of 11, three separate page loads giving **2.46 / 2.47 /
2.46**, plus **2.41x** at 1024x1024 @ 2 tiles/px (3786 ms against 1574 ms).
Byte-identity was re-checked in the browser in the same run.

Read 2.46x beside the spike's 7.5-13.2x rather than instead of it: the spike
measured the leaf kernel and one composition, this is a whole composed render.

**The lesson generalises past this number.** Any A/B where the two arms go
through different amounts of the test harness is measuring the harness. Benchmark
the arms in the environment that ships, or at least confirm the harness treats
them alike.

**No memo in the Rust chain, and that is not a shortcut.** The TypeScript wraps
every field in `memoXY` because it builds a DAG of lazy closures; the Rust
evaluates the chain top to bottom in one pass and keeps intermediates in locals.
That is what the memo achieves, bit-identically (a hit returns the value the
function computed), with no cache and no `&mut` plumbing. It is legitimate only
because every read in that chain is at the SAME `(x, y)` - checked field by
field. A field that read a neighbour would need the cache back.

**`starting_spot_at_angle` takes its trig as an INPUT**, and phase 3 is where
that stopped being optional. It is plain f64 arithmetic with no narrowing, so a
one-ULP `sin` difference lands straight in the result - and #270 measured that
the wasm libm and V8 really do disagree. At **all 13 call sites** the angle and
distance are per-render constants (read, not assumed), so the sine and cosine
are computed once outside the per-pixel path and handed in. Tier 2 passes V8's
values to the module, which makes a libm disagreement impossible rather than
unlikely.

`checksum` holds the tier-2 parity fold; **`fold_f64` folds RAW BITS and must
stay order-sensitive**, because an XOR fold is blind to order and cancels pairs,
so swapping two points or breaking two identically would leave it unchanged.
`the_fold_is_order_sensitive` makes that load-bearing rather than a claim in a
comment, and it was watched failing against a planted XOR fold.

**The wasm libm is NOT the host libm, and only a tier-2 spec can see the
difference** (#270, measured 2026-08-19, **now FIXED**). Sweeping 600 slider
positions, `sliderToLinear` and the per-operation `sliderRescale` agree between
the ports 600/600, and the un-narrowed `eval/sliderRescale.ts` form agreed
**599/600** - one position each at `s = 3.5435` (n=2) and `s = 6.3657` (n=3).
Native Rust agrees with V8 at both points, same 64 bits, so the divergence
belonged to the `log2`/`pow` that `wasm32-unknown-unknown` compiles in. Two
consequences: `cargo test` runs on the host libm and cannot find this class of
bug at all, and the per-operation f32 forms survive **because** they narrow -
one f64 ULP is ~29 bits below what an f32 narrowing keeps. Anything new that
reaches a transcendental needs a tier-2 sweep, not just a fixture.

**It was closed by DELETING the un-narrowed form, not by keeping it out of the
module**, and the reason is that the libm question was the second-worst thing
about it. `slider_rescale` is a **noise-function** in
`core/prototypes/noise-functions.lua:16` - the noise machine evaluates it, per
operation, in f32 - so the oracle already said which form is the game's: the
per-operation one matches all 7 probe points in
`oracle-fulgora-elevation.seed123456.json` and the rounded-once one misses
`s = 0.5` and `s = 5`. It was the form that disagreed with the game, on five
shipped call sites.

`src/noise/eval/sliderRescale.ts` is gone. All five callers -
`vulcanusResources.ts` (x4 at n=2), `vulcanusHelpers.ts` and `vulcanusBiomes.ts`
(x3 at n=3), and **`rocks/rockField.ts`** at n=1.5, which the issue did not list

- read `eval/math.ts` now, and `rockCatalog.ts` re-exports rather than
  re-implements. Three things worth knowing before touching this again:

- **No fixture could see the change, and that is measured rather than lucky.**
  Every fixture and spec feeds these call sites only `size` 0 or 1, and the two
  forms are BIT-IDENTICAL at both. The full gate went 2057 -> 2061 tests passed,
  the +4 being the rewritten `test/sliderRescale.spec.ts` and nothing else.
- **The input space is 12 values, not a range.** `PERCENT_STEPS` is `Math.fround`
  of twelve exact fractions and those are the only settings a user can pick.
  Across them the two forms return a different f64 at **10 of 12** for every `n`,
  and a different f32 at 3 of 12 (n=2), 4 of 12 (n=3), and **0 of 12** (n=1.5).
  So the Nauvis rock change is invisible at f32 granularity at every reachable
  setting; it was taken to remove the second implementation, not to move a pixel.
- **`engine.wasm` is byte-identical across the change** (`cd1a79c1...`, 84,177
  bytes). `slider_rescale_f64` was never exported, so it had already been
  dead-code-eliminated. It survives as `slider_rescale_rounded_once` under
  `#[cfg(test)]`, purely as the control that keeps "the shipped form matches the
  oracle" from being an assertion against nothing.

**THREE TypeScript findings came out of the port and none was fixed IN the
port.** All were behaviour changes to shipped fields that passed their own
fixtures, so each got an issue instead. The port reproduces the TypeScript
exactly in every case - a unilateral "fix" on the Rust side would read as a port
bug in tier 2, which is the whole point of having tier 2. **All three have since
landed as their own changes**, which is the intended path, not an exception:

- **#269 - LANDED.** `basisNoiseExpr` returned an un-narrowed f64 product where
  the game evaluates `f32(f32(output_scale) * basis)`, and none of its five
  callers narrowed either. Settled against the game at 196 positions and five
  output scales (the fixture is #287's): the shipped form scored
  `[196, 28, 6, 96, 1]` and the game's form scores **196 of 196 at every scale**.
  **Narrowing the product is necessary and NOT sufficient** - the `output_scale`
  CONSTANT is held at f32 as well, the same shape as #273, and that is the half
  the issue itself does not say.

  Re-scored on every field that reads it, because a green gate proves nothing
  here (see below): `mountain_plasma` **7 -> 11 of 38**, Vulcanus `elev` and
  `elevation` **114 -> 116 of 434**, and `elevation_lakes` (13/17),
  `elevation_nauvis` (3/17) and both `cliffiness` gates (1024/1024) unmoved.
  Nothing regressed - unlike #273, which moved counts in both directions.

  **A power-of-two `output_scale` is immune** and cannot grade any of this:
  multiplying an f32 by one is a pure exponent shift. Which sites the fix can
  reach is decided by the output scale alone - `cliff_fields` (0.51),
  `nauvis_shared` (0.6), `elevation_lakes` (1.5), `vulcanus_elevation`
  (250, 150) and the `plasma` magnitudes routed into it (125/625, 0.15/0.75)
  are all exposed, while the eleven `plasma` sites the crack layer calls at
  1, 0.5 and 0.25 are blind by construction and did not move.

- **#290 and #293 - BOTH LANDED, together.** The output scale was only a third
  of it. Two more terms were wrong, and neither could be graded without the
  other, so they landed as one change.

  **#290 - the input side.** The game holds `input_scale` at f32 **and**
  narrows the coordinate product:
  `basis_noise(f32(x * f32(input_scale)), ...)`. Graded 196 of 196 at seven
  scales (`test/basisInputScale.spec.ts`) and again at the five real caller
  `(input_scale, output_scale)` pairs (`test/basisCallerScales.spec.ts`), then
  confirmed against the game's OWN leaves at 61 of 61 with **worst residual
  exactly 0**, near field and far.

  **#293 - the scale arguments.** `vulcanus_cracks_scale` is a
  **noise-EXPRESSION, not a Lua number**, so `0.3 * vulcanus_cracks_scale` is an
  f32 multiply inside the noise machine. So is `1 / 50 / scale` inside
  `vulcanus_plasma` and `vulcanus_detail_noise`, and
  `vulcanus_scale_multiplier / scale` inside `vulcanus_biome_noise`. The port
  computed all of them in f64 and narrowed once, which is a different number.

  **Every count improved and not one regressed:**

  | field                | before  | after       |
  | -------------------- | ------- | ----------- |
  | `detailNoise`        | 1/38    | **38/38**   |
  | `mountainPlasma`     | 11/38   | **38/38**   |
  | `hairlineCracks`     | 2/61    | **50/61**   |
  | `floodCracksA`       | 15/61   | **45/61**   |
  | `floodCracksB`       | 40/61   | **43/61**   |
  | `floodPaths`         | 10/61   | **28/61**   |
  | `floodBasaltsFunc`   | 9/61    | **31/61**   |
  | `aux`                | 40/61   | **41/61**   |
  | `moisture`           | 20/61   | **29/61**   |
  | `elev` / `elevation` | 115/434 | **169/434** |
  | `temperature`        | 196/434 | **244/434** |

  **Every number in that "after" column has since been superseded, because all
  of them were scored at UNSNAPPED coordinates.** The table is kept as the
  record of what #290/#293 moved; do not read it as current. See the snap
  section below for the live counts - `hairlineCracks` is 61 of 61.

  `detailNoise` is the one to notice. This file used to hold it up as the
  argument for counting matches rather than bounding error - smallest residual
  of its three helper fields, fewest exact matches, 1 of 38. It is now 38 of 38.
  The bound never moved; the port did.

- **Three tier-1 sweeps scored at coordinates the game never evaluated, and
  fixing it moved 13 frozen counts UP (#295).** `vulcanus_sweep` and the biome
  test read `p.x` raw, where `oracle-vulcanus-cracks` and
  `oracle-vulcanus-climate` record **21 of 61** positions off the 1/256
  `MapPosition` grid and `oracle-vulcanus-biomes` records 22 of 434. The other
  seven tests over off-grid fixtures already snapped - the practice was
  established and these three were simply missed.

  | field                   | raw     | snapped     |
  | ----------------------- | ------- | ----------- |
  | `hairlineCracks`        | 50/61   | **61/61**   |
  | `floodCracksA`          | 45/61   | **55/61**   |
  | `floodCracksB`          | 43/61   | **51/61**   |
  | `floodPaths`            | 28/61   | **34/61**   |
  | `floodBasaltsFunc`      | 31/61   | **37/61**   |
  | `aux`                   | 41/61   | **51/61**   |
  | `moisture`              | 29/61   | **35/61**   |
  | `mountains_raw_volcano` | 163/434 | **174/434** |
  | `mountains_biome_full`  | 128/434 | **135/434** |
  | `ashlands_biome_full`   | 107/434 | **114/434** |
  | `basalts_biome_full`    | 127/434 | **134/434** |
  | `mountains_biome`       | 403/434 | **404/434** |
  | `ashlands_biome`        | 402/434 | **404/434** |

  Two counts did NOT move, and both are readings rather than noise:
  `mountain_volcano_spots` stays 359 because its output is a DISCRETE choice of
  which candidate survives, and a sub-1/256 coordinate shift almost never
  changes that - the same property `voronoi_cell_id` has. `basalts_biome` stays
  408 because it is clamped and saturated over most of the map.

  **This REFUTES what #295 read into `hairlineCracks`.** The issue took it
  scoring 50 against the 2.1.12 capture and 61 against a 2.1.14 one as the game
  changing under the fixture. Measured: the 2.1.12 fixture SNAPPED scores 61
  too, and the two fixtures do not even hold the same positions - the older one
  records 21 of them unsnapped.

  **And the residual version effect is ZERO, not the "at most 2 counts, both
  ways" this paragraph used to claim** (measured 2026-08-25, closing #295). That
  figure came from comparing each capture's score over its OWN 61 positions,
  which is the same mistake one level down: the two captures share only **52**
  of their 61 points, so the comparison was again across two sample sets.

  | field              | 2.1.12 /61 | 2.1.16 /61 | 2.1.12 /52 | 2.1.16 /52 |
  | ------------------ | ---------: | ---------: | ---------: | ---------: |
  | `hairlineCracks`   |         61 |         61 |     **52** |     **52** |
  | `floodCracksA`     |         55 |         54 |     **46** |     **46** |
  | `floodCracksB`     |         51 |         50 |     **45** |     **45** |
  | `floodPaths`       |         34 |         36 |     **28** |     **28** |
  | `floodBasaltsFunc` |         37 |         37 |     **31** |     **31** |

  Restricted to the shared points every field ties, so the whole difference
  lives in the 9 points the captures do not share. Three independent readings,
  any of which could have failed:

  - **Game against game, no port involved.** At all 52 shared points both
    captures record BIT-IDENTICAL values on all five fields, worst delta exactly
    0, with a control (a different field of the same fixture) agreeing 0 of 52.
  - **The data.** Every Lua file behind the chain - `planet-vulcanus-map-gen.lua`,
    `noise-programs.lua`, `noise-functions.lua`,
    `base/prototypes/noise-expressions.lua`, `tiles-vulcanus.lua` - is
    byte-identical 2.1.12 -> 2.1.16.
  - **The mechanism, exactly.** The re-capture's position equals
    `Math.floor(old_raw * 256) / 256` at **61 of 61** and
    `Math.trunc(...)` at **52** - the two disagree on exactly the 9.

  **So a re-capture of an off-grid fixture CANNOT land on the points that
  snapping the old one produces, and that is by design rather than a bug.** A
  capture PRODUCES a grid coordinate with `Math.floor` (`snapToMapPosition` in
  `test/oracle/capture.ts`); `test/captureGrid.ts` RECOVERS one with
  `Math.trunc`, because truncation toward zero is what the game does to a
  coordinate handed to it off the grid. Both are right for their own job, and
  `capture.ts` has said so in a comment the whole time. They differ by one cell
  on a NEGATIVE coordinate, which is why this never showed up near the origin.

  The consequence is the transferable part: **comparing two captures' COUNTS is
  never a version measurement unless you first restrict to the points they
  share.** Compare values at shared positions instead, which needs no port and
  cannot be confounded this way. That comparison is kept as an assertion over
  two committed fixtures, in `test/vulcanusPlasmaDecomposition.spec.ts`.

  **A version difference and a capture-grid difference look identical from
  inside a count, so rule out the grid FIRST** - it is free, where re-capturing
  to test a version hypothesis will confirm that hypothesis whether or not it is
  true. Following #295's own suggested handling here would have produced a
  confident wrong answer.

  And **2.1.14, 2.1.15 and 2.1.16 are ONE oracle** for map-gen: the data Lua is
  byte-identical across them, and a re-capture at 2.1.16 matched 2.1.14 on all
  305 sampled values. So `refs:sync --fixtures` reporting "115 of 118 predate
  the installed binary" overstates staleness by three versions; the real cut is
  95 of 118 older than 2.1.14.

  `the_capture_grid_snap_is_load_bearing_on_the_vulcanus_crack_layer` pins BOTH
  arms, not just the good one - a test asserting only the snapped number would
  pass again if the snap were removed and the counts re-frozen to match, which
  is exactly how this shipped the first time. **There are now THREE of these**;
  `..._on_the_vulcanus_biome_layer` was added 2026-08-25 because the biome half
  of that change landed with neither a dual-arm test nor an off-grid count, so
  its six counts could have been quietly re-frozen downward. It pins all eight
  fields, including the two that DO NOT move - `mountain_volcano_spots` at 359
  and `basalts_biome` at 408 - since pinning those flat is what says the
  discrete-choice and saturated-clamp readings are still true.

  **`test/fixtures/PROVENANCE.json` now carries `maxUnknown: 0`.** The last
  undocumented fixture was `autoplace-can-be-disabled.dump.json`, committed
  2026-07-12 with no version recorded; `scripts/probes/autoplace-can-be-disabled`
  re-captured it at 2.1.16 and it came back **byte-identical**, 1696 bytes.
  Keep that probe rather than treating it as scaffolding - it is the only thing
  that makes the claim repeatable, and `docs/fixture-version-audit.md`'s rule is
  that a clean data diff can never promote an `unknown` entry. Because the count
  must EQUAL the ratchet, 0 is now a floor: a new fixture with no provenance
  fails immediately instead of taking up slack.

- **The technique that solved #293 is worth more than the fix: capture the
  INTERMEDIATES, at the SAME positions.** `basisCallerScales` graded the two
  leaves at 196 positions on a +/-400 grid and got 196 of 196.
  `oracle-vulcanus-cracks` graded the composed field at 61 different positions
  and got 2 of 61. Nothing had measured one position end to end, so "leaves
  right, composition wrong" was an inference across disjoint sample sets.

  Capturing `vulcanus_hairline_cracks` AND both of its leaves together settled
  it in two steps:

  1. **Game against game, with the port removed entirely.**
     `abs(gameLeafA - gameLeafB)` reproduces the game's own `hairline_cracks` at
     only **7 of 61**, worst 5.272e-4. The expression was wrong, and no line of
     our code was involved in showing it.
  2. **Our leaf model against the game's own leaves: 61 of 61, worst exactly 0.**

  Leaves provably exact plus composed field provably wrong localises the fault
  to the ARGUMENTS - which is what sent us to the game's Lua. The oracle harness
  samples named noise expressions by name, so any intermediate the game names
  can be captured this way. `test/vulcanusPlasmaDecomposition.spec.ts` keeps
  both steps as assertions.

  That 5.272e-4 was also the number that breached `vulcanusCracks.spec.ts`'s
  3e-4 bound when #290 was first tried ALONE. Fixing the leaves converged the
  port onto `abs(gameA - gameB)` - the wrong target - which is what made the
  argument error visible at all. A partial fix exposing a deeper one is a
  finding, not a regression.

- **The game's own Lua is on the capture machine**, under
  `<install>/data/space-age/prototypes/planet/`. Read it before inferring a
  formula from residuals. #293 was three hours of numerical archaeology that one
  `grep` of `planet-vulcanus-map-gen.lua` would have shortened, because the
  answer - `vulcanus_cracks_scale` being a noise-expression - is visible in the
  prototype's own `type` field.

- **#270 - FIXED.** The wasm libm question above. Closed by deleting the
  un-narrowed `slider_rescale` and moving all five callers onto the
  per-operation form the oracle says the game uses.
- **#273 - LANDED** (`e723b30`). Fulgora's elevation constants were f64 where
  the game holds them at f32. Typing them took `fulgora_dunes` from **26/101 to
  101/101 with worst error exactly 0** and `fulgora_rock` from 84/101 to
  101/101. The control was `fulgora_scrap_medium`: same op family, no added
  constant, already 101/101 - so the whole gap was the literal.
  `crates/fmw-noise/src/fixtures.rs` carries the planted fix as a live test
  rather than leaving it in the issue, because a measurement nobody runs goes
  stale.

The shape to copy: find it while porting, reproduce it faithfully so tier 2 stays
honest, open an issue, and fix it in a change graded on its own.

**A green `pnpm run verify` cannot see a change of this class - measured, not
assumed (#256).** When #269's fix landed, the full TypeScript suite passed with
**zero failures** even though the model under seven call sites had changed,
because the oracle specs that cover those callers assert combined abs/rel bounds
rather than exact f32 matches. The bounds are wide enough to swallow the whole
difference. The only spec that noticed was `test/basisOutputScale.spec.ts`,
which freezes exact counts on purpose. So when you change an op that shipped
fields read, **re-score those fields exactly before and after** - the gate going
green is not evidence, and #162 is the standing record of a tolerance hiding a
real bug for a year.

**`f64::max` is NOT `Math.max`, and only a raw-bits fold can see the
difference** (found 2026-08-19, #224). They differ two ways: on NaN, where
`f64::max` returns the non-NaN operand and `Math.max` propagates - and on
**signed zero**, where `Math.max(-0, +0)` is `+0` while `f64::max` follows IEEE
754-2019 `maximumNumber`, whose result for two operands that compare equal is
explicitly _either input, non-deterministically_.

That is not theoretical here. Fulgora's `tile_ruin_paving` folded to a different
tier-2 checksum than the TypeScript because both of its `max` arms were zero
with different signs. Phase 3 had shipped 27 such sites and its parity passed
only because those windows never hit the case.

Every `min`/`max` in a ported expression now goes through
`eval::math::{min2, max2}` - and the **argument order is kept as the TypeScript
writes it**, for the same reason. Reach for `f64::min`/`f64::max` in ported
arithmetic and the divergence is invisible to every tolerance and to tier 1; it
takes an order-sensitive fold over raw bits to find.

**The Fulgora tier-1 counts are frozen exact numbers, and 13 of them reached
101/101 when #273 landed.** Each was measured against the TypeScript side by side
and they agree exactly - same count, same worst residual - so they describe the
port's remaining distance from the game, which both implementations share.
Freezing them is what makes a change to any of them a finding. If one moves: read
the number, do not adjust it. Up is worth taking; down is a regression.

**#273 is the worked example of how to move them, and its method is the
transferable part.** Fulgora's chain held f64 literals where the game holds f32,
plus intermediates rounded once at the end rather than per operation. Three
things about how it was settled:

- **Accept only a field that reaches a FULL exact count.** Every candidate was
  applied to the real tree, scored against the oracle fixture, and reverted;
  one was taken only when its own field hit 101/101 at a residual of exactly 0.
  Twelve candidates that merely improved were **rejected and written up**, not
  committed - `fulgoran_dunes_probability` 75 -> 98 and `fulgora_mix_oil`
  48 -> 53 among them. "It got smaller" stays a hypothesis.
- **Measure cumulatively, because the chain is a DAG.** Scored one at a time
  against a fixed baseline, `natural` looks capped at 99/101 and the issue
  predicted exactly that. It reaches **101/101** once `wobble_mask` is fixed,
  because `natural` reads `basis` and `basis` was the second cause. A candidate
  sweep that does not re-baseline after each accept will under-report.
- **The same literal wants opposite fixes in different arities.** Typing the
  three constants in `sprawl_pyramids` REGRESSES it 99 -> 97; narrowing every
  operation takes it to 101/101. A one-term `a OP constant` recovers at the
  comparison's own rounding and a three-term sum does not.

**What #273 did NOT change is the tile argmax** - 4,915 of 5,057 before and
after, same 7 land/ocean and 11 shallow/deep misses, so those really are
boundary-exclusive. **And the whole-image terrain preview went 34,976 -> 34,977
differing pixels of 1,048,576 - one pixel WORSE.** That is the honest number and
it is worth stating plainly: this class of fix buys bit-exactness on named
fields, not visible accuracy, because the image is dominated by the `mix_*`
chain that #273 could not reach. A draft of this paragraph claimed a 25-pixel
improvement, measured on a tree carrying three candidates that were later
dropped for failing the accept rule. Re-measure on the tree you actually ship.

**The whole TypeScript suite stayed GREEN through all of it, and that is the
#162 pathology, not luck.** Every Fulgora assertion on that side is an upper
bound on the worst residual, so improving a residual keeps it under the bound;
89 of 89 Fulgora tests passed before and after. Only the Rust port's frozen
exact counts could see the change, and they named every field that moved.

**`starting_spot_at_angle` was the block, and #279 removed it.** It evaluated in
f64 and is SHARED with Vulcanus, so it could not ride along with a Fulgora-only
change. Narrowing it needs all five of per-operation narrowing, an f32 `pi`, f32
`sin`/`cos`, f32 radius/distance and an f32 angle - **no subset works**, and an
f32 `pi` on its own helps the vault cone and HURTS the main one until the angle
is narrowed too. The last two live at the CALL SITES (`grid / 1.8`,
`seed0 / 360`, `angle + 180`), not in the function.

What it bought, all re-measured on the shipped tree:

- **`starting_spot_at_angle` itself: 88 -> 152 of 152.** The direct oracle test,
  against values the game produced, is now exact at every captured case. That is
  the strongest statement in tier 1 about this expression, and it is what makes
  everything below a consequence rather than a coincidence. The comment on that
  assertion used to explain the 88 away as "the same known port gap the elevation
  chain carries" - it was not a gap in the chain, it was this expression.
- Both Fulgora cones **83/101 and 85/101 -> 101/101 at residual exactly 0**, and
  `fulgora_vault_pyramids` 85 -> 101 and `vault_pyramids_and_start` 77 -> 101
  behind them. **13 frozen counts up, 1 down** (`fulgoran_rock_probability`
  80 -> 79, recorded at the assertion the way #273 recorded its two).
- **The terrain PNG 34,977 -> 34,788 differing pixels of 1,048,576.** #273 moved
  this by one pixel in the wrong direction; this moves it by **189** the right
  way, because the cones feed the `mix_*` chain the image is made of. So "this
  class of fix buys bit-exactness, not a better picture" is not a rule - it
  depends on whether the field is upstream of what the image is made of.
- The scrap footprint's one stray game pixel is gone: `outside` 1 -> **0**.

**On Vulcanus it is a large improvement that a BOUND reported as a regression**,
which is #162 with the sign flipped. Exact f32 matches out of 1085:
`startingTungsten` 614 -> 1082, `startingCoal` 611 -> 974, `startingCalcite`
547 -> 969, `startingSulfur` 618 -> 1049. The only thing that got worse was
calcite's single worst residual, 2.2888e-5 -> 3.0518e-5, tripping a 3e-5 bound.
That outlier sits at `(-2332.9, 2333.7)` where the field's own value is
**-133.94**, so one f32 ULP there is 1.53e-5 and the bound is a TWO-ULP bound at
that magnitude; exactly 2 of 1085 positions exceed it. Those four assertions are
now **frozen exact counts** with the residual kept underneath - a replacement,
not a widening, and proven strictly stronger by planting: un-narrowing the
calcite radius drops the count 969 -> 669 while the residual bound passes
unchanged.

The Vulcanus call-site audit is done (5 resource sites, 3 spawn sites, the three
spawn angles). It took calcite 669 -> 969 and did not move those 2 deep-field
points, which is the far-from-origin f32 coordinate floor the other Vulcanus
specs document rather than anything in the expression.

**#270 did NOT clear this**, and a note here used to imply it might by blaming
the calcite radius on "the un-narrowed `sliderRescale` of #270". The radius is
`(35 / 1.5) * sliderRescale(calcite.size, 2)`, and at the default `size = 1`
**both** forms return exactly 1 - so the value reaching `startingCalcite` in
every fixture never changed. What was un-narrowed there is the `35 / 1.5` and the
multiply, which is #279's own lattice.

**The 12 candidates #279 lists are still unapplied**, and the issue's prediction
about them is NOT confirmed. It expected `moats`, `vaultSpots` and
`spotsPrebanding` to reach 101/101 once the cones moved; measured, they reach
69, 69 and 98. They improved, they did not close. Those candidates are their own
per-operation narrowings and still have to be applied and re-scored one at a
time, under the greedy-accept rule.

**Phase 6 (#226) is IN PROGRESS: the Nauvis EXPRESSION CORE is ported and
gated; the five overlays, the tiles and the render path are not.** Landed:
`nauvis_shared`, `elevation_lakes` (and `elevation_island`, which is that tree
with `bias = -1000` and the segmentation quartered), `elevation_nauvis` (and
`elevation_nauvis_no_cliff`), `nauvis_climate` holding `aux`, `moisture` and
`temperature`, plus `nauvis_stack`. Still unported: `resources/`, `enemies/`,
`trees/`, `rocks/rockField.ts`, `cliffs/cliffFields.ts` and `tiles/` - about
2,750 lines of TypeScript, more than the core was.

Tier 1 grades every captured Nauvis field, snapped onto the 1/256 capture grid
and scored by exact f32 match count. **Every count was measured on the
TypeScript side against the same fixture with the same snap and agrees to every
printed digit**, so they describe the distance BOTH ports sit from the game:

| field                                   | exact    | worst       |
| --------------------------------------- | -------- | ----------- |
| `temperature`                           | 26/26    | **0**       |
| `elevation_lakes`                       | 21/26    | 3.814697e-6 |
| `elevation_island`                      | 19/26    | 1.525879e-5 |
| `moisture`                              | 18/26    | 5.960464e-8 |
| `aux`                                   | 14/26    | 5.960464e-8 |
| `elevation_nauvis`                      | 8/26     | 3.852844e-4 |
| `elevation_nauvis_no_cliff` (two seeds) | 6, 4 /26 | 3.8e-4      |

plus the cliff offset chain at 38 positions and two seeds: `rawX` 30 and 36,
`rawY` 30 and 30, `hillsOffset` 29 and 31, `cliffRingbreak` 29 and 31.

**Read `temperature` beside the rest rather than as an outlier.** It is the
shallowest expression in the port - one `quick_multioctave_noise` and a clamp,
nothing composed beneath it - and it is bit-exact. `aux` and `moisture` are one
`nauvis_plateaus` away from it and land at one f32 ULP. `elevation_nauvis` is
the weakest count in the Nauvis port because it stacks the shared layer, an
amplitude-corrected persistence field and a variable-persistence detail stack,
so it carries every unported narrowing underneath it at once.

**Porting `amplitude_corrected_multioctave_noise` moved a SHIPPED op, and no
fixture in the tree could see the difference.**
`variable_persistence_multioctave_noise` took `persistence` as an **f32**;
the TypeScript multiplies its f32 accumulator by an un-narrowed JavaScript
number. `oracle-variable-persistence-multioctave`'s captured `persistenceField`
is the noise machine's own `0.35 + 0.25 * basis_noise{...}`, so all 38 values
are exactly f32 and both widths score 266/266 with worst 0 - the same shape as
#191 and #309, a narrowing the fixtures agree on because they only ever offer
values already on the grid.

`oracle-multioctave-wrappers`'s amplitude-corrected cases DO discriminate,
because they pass the program constant `0.7` straight in:

| persistence operand                | exact  | worst    |
| ---------------------------------- | ------ | -------- |
| f64 (the TypeScript, and now this) | 81/152 | 1.788e-7 |
| f32 (what shipped here)            | 89/152 | 5.960e-8 |

**The better-scoring form is NOT the one taken.** 89 is an improvement and not
a full exact count, so the greedy-accept rule rejects it as a model change, and
adopting it would put a divergence into every Nauvis elevation value with
nothing to grade it. It is a real finding for #254 - which records the 81/152
as unexplained - naming one term worth 8 points and still 63 short. Neither
form is the game's.

Two harness compensations went with it. `checksum_variable_persistence` crossed
the ABI as an f32, so `test/wasmMultioctaveParity.spec.ts` narrowed its own
value with `Math.fround` first, making the two sides agree by construction on
exactly the term that differed; both are f64 now and two of that spec's cases
(0.62, 0.9) are not f32-exact, so it grades the width instead of hiding it.
And `p ** octaves` is **`powf`, not `powi`** - `powi` disagrees with V8 by one
ULP at 0.7^4, 0.7^6 and 0.7^8, and one ULP there flips the f32 rounding of the
octave gain, which moves every point in the case.

**Tier 2 lands with the layers, not after them** (`test/wasmNauvisParity.spec.ts`

- `checksum_nauvis`, 16 fields x 3 cases). Two departures from the Vulcanus
  shape, both deliberate: the parameters cross as ARGUMENTS rather than as a
  request, because there is no render path yet whose wiring a request would put
  inside the comparison; and no trig crosses at all, because Nauvis reaches no
  transcendental - which is why its signature is narrower than Fulgora's despite
  carrying more controls.

**Its sweep deliberately leaves the f32 grid, and that is load-bearing rather
than decorative.** 1,430 of 1,452 sampled positions have at least one
coordinate off the grid, frozen, with two tier-3-shaped windows asserted at 0
as the control. Planting a pure coordinate narrowing in `hills_offset_raw_x`
leaves tier 1 GREEN and turns tier 2 RED - so it is not a second opinion on
what tier 1 covers, it is the only thing in the gate that can see that class of
change on Nauvis. Every tier-3 window uses a binary origin and step, which is
how #309 survived three shipped PRs.

**`aux.rs` cannot exist**, so the three climate expressions share
`nauvis_climate.rs`. `aux` is a reserved device name on Windows and a file by
that name cannot be checked out there at all. It is the one place the port does
not mirror `src/noise/expressions/` 1:1. `temperature_basic` is not
Nauvis-specific either - Nauvis is just the only planet in this port that
reaches it.

**Adding an UNREACHABLE module moved `engine.wasm` by 54 bytes, and it is not
the panic-location fingerprint.** No section kept its size and the delta was
not a line count; the sufficient explanation is inlining, since a new caller of
`var_pers_eval` and friends changes the cost heuristics for code that DOES
ship. Checked both ways: each source rebuilds to its own hash reproducibly, and
all 55 wasm parity tests including tier 3's byte-identical renders pass. That
is a third fingerprint to hold beside the two below.

**No expression layer in phase 6 carries its own poison hook, and that was
measured rather than skipped.** `nauvis_shared` has one on `cliff_ringbreak`;
deleting it leaves that layer's tier-1 test red anyway at 5 of 30 on `rawX`,
because every field in these chains composes `basis_noise` and inherits its
hook. No test in the crate could give one of them an independent control, so
the later layers do not add hooks just to look symmetrical. All nine phase-6
tier-1 tests are in `POISONED_TESTS` and all nine go red.
`the_cliff_elevation_term_moves_the_tree_...` stays GREEN and should - it is a
relational assertion, so a perturbation applies to both sides and cancels.

- **`src/noise/wasm/engine.wasm` is a COMMITTED artifact.**
  `scripts/build-wasm.sh` produces it; `verify:rust` rebuilds and compares bytes
  rather than regenerating. That is what keeps `vp build` free of any non-JS step
  and lets `deploy:app` run on a machine with no Rust at all. **Any change to a
  Rust source means rerunning that script and committing the result**, or the
  gate fails as "stale".
- **Byte identity across machines is measured, not hoped for** (#218): the same
  source, profile and pinned toolchain give the same bytes and the same sha256 on
  macOS/aarch64 and on an ubuntu x86_64 runner. That is why the gate can use
  `cmp` instead of rebuild-and-retest.
- **A `engine.wasm` diff can be pure LINE NUMBERS, and a DOC COMMENT is enough
  to cause one.** Seen twice while landing #225's cliff half: a 9-line struct
  added to `vulcanus_resources.rs` moved 2 bytes (two `core::panic::Location`
  line numbers for that file's `RefCell` borrow sites, 427 -> 436 and 469 ->
  478), and a **19-line `///` block on its own** in `cliffs/placement.rs` moved
  9 bytes - six Locations in that file, every one shifted by exactly 19. No code
  byte moved either time and every section kept its exact size. So a
  comment-only edit in a reachable file makes `verify-rust.sh` report "stale",
  and that is the gate working rather than a false positive.

  The fingerprint: tiny `cmp -l` count, every changed offset inside the `data`
  section, all section sizes identical, and a `u32` delta equal to the lines you
  inserted. **The trap is alignment** - the record is `{file_ptr, file_len,
line, col}` and it is NOT 4-byte aligned in the data image, so reading a `u32`
  at `offset - (offset % 4)` gave "delta 4864" and looked like a moved string
  table; realigned, the same field is 716 -> 735 and 4864 is just `19 << 8`.
  Locate the record from its file pointer and length, not from alignment. The
  build itself is deterministic - a no-change rebuild reproduces the bytes
  exactly, checked while chasing this - so a diff after an edit is always the
  edit.

- **The `poison` feature is the gate's anti-vacuity control, and it needs ONE
  HOOK PER OP.** It perturbs an op's returned value; `verify:rust` builds with it
  and asserts a **named list** of tier-1 tests goes red. The list is why: while
  every ported op composed `basis_noise`, its single hook reddened everything, so
  a suite-level "did anything fail" check looked sufficient. The five primitives
  added in #220's second batch compose it in none of their paths, and that check
  would have passed with five ports carrying no control at all. Adding an op
  means adding its hook and its test name to `POISONED_TESTS`. That list has
  already earned itself twice: it caught `voronoi_noise`'s `cell_random`
  shipping with no hook on the first run of the gate after the port landed, and
  phase 2 found that `fast_approx` had shipped in phase 1 with no tier-1 test
  and no hook at all. Two of the phase-2 tier-1 tests stay GREEN under poison
  and both should - one reads a fixture and no port code, and the other asserts
  that WRONG models of `^` disagree, which poisoning only strengthens.
  `poison.rs` records why, beside the two earlier ones.

  **A numeric hook does not reach a DISCRETE output**, which phase 3 measured
  rather than assumed: with only the elevation hook live, the end-to-end tile
  test stayed green at 7 and 11 misses out of 5,057, because a one-ULP nudge
  changes which side of a comparison a value falls on essentially never. That is
  the same property that makes `voronoi_cell_id` exact where `pyramid_noise` is
  not. `poison::bool_result` flips the classification instead. Any future op
  whose output is a choice rather than a number needs that hook, not `f64_result`.

- **The determinism rules are what protect that**, and each is written where it
  is enforced: no `mul_add` or fast-math, `clippy::suboptimal_flops` explicitly
  allowed so turning `nursery` on later cannot push the port toward FMA, no
  `target-cpu=native`, `simd128` off (measured at 1.27x on a gather-bound
  kernel - it would change the binary for no gain), and `relaxed_simd` never,
  since its fused multiply-add is non-deterministic across engines by design.
- **A WASM `u64` arrives in JavaScript as a SIGNED BigInt.** `fnv1a64("")` is
  `0xcbf29ce484222325` and JavaScript reads `-0x340d631b7bdddcdb`, its two's
  complement. No error is raised - the number is simply wrong in a way that
  looks like a broken checksum. Every u64 crossing needs
  `BigInt.asUintN(64, x)`; `test/wasmEngine.spec.ts` shows the shape.


---

## Later additions, appended after the snapshot

Everything above this line is the 2026-08-25 snapshot and is left unedited, so
its phase-6 section still describes the expression core as the newest work. What
follows was appended afterwards, each block dated, as `CLAUDE.md` shed a record
it no longer needed at the keyboard.

### 2026-08-26 - the phase-6 tier-1 tables (#226)

Moved out of `CLAUDE.md`'s "Current tier-1 counts" when the cliff and rock
fields (#325), the enemy-base layer (#327) and the terrain render (#328) landed.
`crates/fmw-noise/src/fixtures.rs` remains the authority; these are the numbers
as frozen on that date, kept so a future move can be read against them.
`CLAUDE.md` keeps the readings, which are rules rather than records.

The enemy-base layer, where the exact-match metric **measures magnitude rather
than accuracy**, and the split is the whole reading:

| bucket                   | seed 123456 | seed 777771 | worst   |
| ------------------------ | ----------- | ----------- | ------- |
| basement, `\|v\| >= 100` | 209 / 239   | 126 / 159   | 4.29e-5 |
| mid, `1 <= \|v\| < 100`  | **0 / 602** | **0 / 658** | 9.76e-6 |
| live, `\|v\| < 1`        | **1 / 191** | **1 / 215** | 4.17e-6 |

The basement is -1000, so a position no cone reaches sits near -1007 where one
f32 ULP is about 6e-5 - larger than the whole residual, so it is exact for free.
Nearly the entire headline count of 210 and 127 is that.

The cliff and rock layers:

| fixture                  | metric                  | seed 123456 | seed 777771 |
| ------------------------ | ----------------------- | ----------- | ----------- |
| `oracle-cliff-elevation` | exact of 1024           | 355         | 281         |
| `oracle-cliffiness`      | gate MISMATCHES of 1024 | **0**       | **0**       |
| `oracle-rock-density`    | exact of 26, snapped    | 17          | -           |

`cliffiness_nauvis`'s anti-vacuity control is the non-zero count frozen beside
it, 252 and 255 of 1024.

The resource layer has no exact count - it is 0 of 16,420 and 0 of 14,980 - so
it freezes a worst absolute residual per case instead, plus a fold. All four
cases at two seeds each:

| fixture                    | iron          | copper / uranium |
| -------------------------- | ------------- | ---------------- |
| `oracle-resource-regular`  | 0.6665/0.6811 | 0.4459/0.4725    |
| `oracle-resource-starting` | 0.6211/0.6386 | 0.3752/0.3760    |

Every one of those is the same term: the `fast_cbrt` inside `basement_value`
(#261). Split by whether a cone reached the position, the residual is +0.36 to
+0.61 where the basement is read and **-0.002 to -0.124 where it is not**.

The tile layer is **153 of 153** at all three seeds. The tree layer is **120 of
442** on `oracle-trees` and **9 of 51** on `oracle-trees-controls`, snapped,
with `tree_small_noise` bit-exact at 26/26 and the 15 species between 1 and 11
of 26 - the depth rule again.

### 2026-08-26 - the powf count that was never portable (#327)

`the_spot_quantity_cube_is_powf_and_a_plain_product_would_diverge` first froze
the disagreement between `r.powf(3.0)` and `r * r * r` at **3,653 of 14,406**.
That count is a property of the host math library, not of the arithmetic:

| host                | differ of 14,406 |
| ------------------- | ---------------- |
| macOS / aarch64     | 3,653            |
| Linux / x86_64 (CI) | 3,651            |

`pnpm run verify` was green three times locally before the push, because CI is
the only place the second host is ever exercised. The assertion is on the
fraction now, held between 20% and 30%, with `total` still frozen at exactly
14,406. Planting the break it exists to catch - making both sides
`r.powf(3.0)` - drives it to `0 of 14406 (0.0%)` and fails loudly, so the
widened form is not vacuous. The rule is in `CLAUDE.md` beside the tier-2 libm
bullet.
