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

### 2026-09-05 - the five orphaned basis fixtures, graded in Rust ahead of #371's deletion

#371 deletes the last of the TypeScript math, and five game captures had no
reader but a TypeScript spec: `oracle-basis-input-scale`,
`oracle-basis-output-scale`, `oracle-basis-caller-scales`,
`basis-noise-seeding.game` and `oracle-vulcanus-plasma-decomposition`. Their
grades moved to `crates/fmw-noise/src/fixtures.rs` first, as #359 did for the
stage localisation before #227. The counts, every one matching the row the
TypeScript spec had frozen:

| fixture | model | exact |
| --- | --- | --- |
| input scale, 7 cases | #290 narrowing | 196/196 each; un-narrowed control `[196, 196, 3, 4, 3, 20, 79]` |
| output scale, 5 cases | #290 narrowing | 196/196 each; product-only control `[196, 110, 151, 196, 196]` |
| caller scales, 5 cases | #290 narrowing | 196/196 each; output-only control `[3, 4, 27, 74, 77]` |
| seeding, 9 pairs x 48 | `tables_from_seed` + `basis_noise` | **432/432, worst 0** - the spec had only a 1e-5 bound |
| plasma decomposition | leaves and `hairline_cracks` | 61/61 each; the game's own `abs(A - B)` agrees at 7/61 |

Two fixtures from that first-pass list were NOT ported and stay as recorded
losses when their specs go: `oracle-vulcanus-tile-lever` (4.4 MB, the tile
argmax under per-resource overrides) and `oracle-fulgora-scrap-entities` (the
scrap roll against the game's per-region entity counts, which costs tens of
seconds a region in a debug build). Both fixtures stay committed with their
provenance; a future test can pick either up.

### 2026-09-05 - the phase 6-8 section, lifted whole (#226, #227, #363, #371)

The second trim. `CLAUDE.md` had reached 160,830 characters against Claude
Code's 150k limit and this section was 70,808 of them - 44%. #319 left it at
38,150 on 2026-08-25; phases 6, 7 and 8 put 32,658 back in eleven days.

**What is different this time is that the archaeology was already gone.** #319
took it. Every remaining block that is purely a record - the phase-6 landing
narrative, the planted-break enumerations, the #326 measurement detail, the
84-field list - totals about 7,500 characters, which would have left `CLAUDE.md`
at roughly 153,000 and still over. So this trim moved rules as well as records,
into a new LIVE document, `docs/rust-wasm-port.md`, which is the long form of
the section and is required reading before touching the port. `CLAUDE.md` keeps
only what bites a session that is not working on it.

The text below is lifted verbatim from `CLAUDE.md` at `bf601a1`, immediately
before the trim, so nothing in it can have been lost in the condensation. Read
it when a rule in the live doc is too terse to act on.

### The Rust/WASM noise engine (`crates/`) - phases 1-5 done, phase 6 all but the overlays

A Cargo workspace at the repository root, landed empty on purpose (#219) so the
gate was proven green on `main` before any port code depended on it. Two crates:
`fmw-noise` is the engine library and `fmw-wasm` is a `cdylib` holding only the
boundary. The design record is
`docs/superpowers/specs/2026-08-16-rust-wasm-noise-engine-design.md`.

**The long measurement record moved to `docs/rust-wasm-port-history.md`** - the
before-and-after count tables, the rejected sweep candidates, the per-phase
landing lists, and the archaeology behind each fix. This section keeps the
current state and the rules. Read the history when a frozen count moves and you
need to know what moved it last time.

**Do not quote a byte count for `engine.wasm` from this file.** Every ported op
changes it and it has gone stale twice. `verify:rust` compares the committed
module against a fresh build, so the gate always knows the right number even
when this file does not. Get it with `shasum -a 256 src/noise/wasm/engine.wasm`.

#### Where the port stands

| phase    | scope                                                                                                                                                                                                                  | state |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1 (#220) | primitives: `taus88`, `fast_approx`, `basis_noise`, the four multioctave ops, `random_penalty`, the spot ops, `distance_from_nearest_point`, `starting_lakes`, `voronoi_noise`                                         | done  |
| 2 (#221) | the `eval` layer - `multisample`, `memo_xy`, `memo_region`, `math`, `ctx`, `primitives` - plus `expressions/vulcanus_seed`                                                                                             | done  |
| 3 (#223) | Fulgora elevation and cells, `starting_spot_at_angle`, `tiles/`, the ABI boundary, and the render cutover                                                                                                              | done  |
| 4 (#224) | the rest of Fulgora: masks, roads, ruins, scrap, the tile catalog and `fulgora_stack`                                                                                                                                  | done  |
| 5 (#225) | Vulcanus end to end - terrain, cliffs, rocks, resources. **Every Vulcanus view the panel offers renders through the engine** (not `elevation` - see below).                                                            | done  |
| 6 (#226) | Nauvis - every expression, the TERRAIN render, all FIVE overlays and the `all` composite. The `elevation` view is ported too, as of #227                                                                               | done  |
| 7 (#227) | delete the ported TypeScript under `src/noise/` - Nauvis and the render fallbacks in #227, then Fulgora and the Vulcanus expressions in #371, which left `src/noise/` holding orchestration, catalogs and the ABI only | done  |
| 8 (#363) | Fulgora's `resources` and `all` composites, so **every planet's DEFAULT view renders through the engine**                                                                                                              | done  |

Phase 6 has ported every Nauvis _expression_: `nauvis_shared`,
`elevation_lakes` (which also yields `elevation_island` - the same tree at
`bias = -1000` with the segmentation quartered), `elevation_nauvis` and
`elevation_nauvis_no_cliff`, `nauvis_climate` (holding `aux`, `moisture` and
`temperature`), and `nauvis_stack`. It also ported
`amplitude_corrected_multioctave_noise`, which phase 1 had deferred. Then the
21-tile catalog and argmax, and then the whole of `resources/` - the six-entry
catalog, the distance-dependent scalars, both spot fields, their outer `max`
and the order-priority resolver.

Then `trees/` - `asymmetric_ramps`, the 15-species catalog, the two shared
forest-path fields, and the species/density layer with its early-out.

Then the two remaining Nauvis _field_ layers, which needed no new module:
`cliffs/fields.rs` (`cliff_elevation_nauvis` and the `cliffiness_nauvis` gate)
and `rocks/field.rs` (the three prototype probabilities and the density over
them). Both are pure compositions of parts already ported, so the only new
primitives were seven constants and three lever helpers across the two existing
`catalog.rs` files.

Then `enemies/` - the constants, the four distance scalars and
`enemy_base_probability` with its spot-region cache. That is **every Nauvis
expression ported**.

Then the ABI's third planet block and the **terrain render**, with the water
early-out and tier 3. `view: "terrain"` on Nauvis now renders through the
engine, byte-identical to the TypeScript across four windows and 8 pixels from
the game's own 1024x1024 preview.

Then the TREE overlay, the first of the five and the only one that needs no
halo box: it reads its density FIELD at a one-cell world-coordinate border
rather than reading neighbouring image pixels, so a tiled render matches an
untiled one with nothing widened.

Then the ROCK overlay - the first Nauvis placement roll, reusing
`placement/roll.rs` whole and adding only a salt, three collision boxes and the
argmax over them.

Then the ENEMY overlay, which reuses the rock overlay's roll, water gate,
sweep box and skip-aware painter whole and adds only two levers, three salts, a
constant collision box and the penalty composition.

Then the CLIFF overlay, the most structural of the five: it needed
`impl CliffFields for NauvisCliffFields`, which did not exist - `vulcanus_fields`
was the only implementor, so the whole placement engine including
`connections.rs` had been ported with no Nauvis caller. It is also the only one
with an even-sided mark (`px - 2 ..= px + 1`, anchored not centred), the only one
that needs a SECOND ABI box, and the only Nauvis pass that reads the REAL water
level - it builds its own `NauvisCliffFields` rather than sharing the render's
stack, whose `water_level` is pinned to 0 for #326. One request carries a water
level the terrain pass ignores and the cliff pass honours.

Then the RESOURCE overlay, the largest: eighteen per-resource levers, and the
only Nauvis layer that mixes a threshold pass with a roll. Crude oil is the one
rolled entry; the other five threshold. Oil paints FIRST as a 3x3 mark and the
solids paint over the top, which reads backwards until you read it as the
game's arbitration - a solid ore saturates far above oil, so it must win a
shared pixel. The exception is kept by an `oil_mark` buffer and a
`compare_priority` set computed once per render: uranium alone is outranked by
oil today.

Then the `all` COMPOSITE. **Every Nauvis view the gate LISTS renders through the
engine.**

**`view: "elevation"` was the eighth and the last, and it is ported as of
#227.** It is three `view` codes - `elevationLakes`, `elevationNauvis`,
`elevationIsland` - rather than one plus a `mapType` field, because the common
prefix has no such field and `view` has been a `u32` since v1. Adding codes is
free; adding a field is a layout change. `render_nauvis` takes them before it
builds a tile catalog, since the view is a sign test on one tree with no argmax
and no overlay.

It was never a dev-mode curiosity, which is why it was worth porting.
`"elevation"` is the request DEFAULT, and `ElevationPreviewPanel`'s
`effectiveView` returns it unconditionally for any Nauvis preset whose map type
is not "nauvis" - **outside** the `devMode` branch - so it is what an ordinary
user sees on every Lakes or Island preset, two of the three map types.

**Two cases are REFUSED rather than routed anywhere, both deliberately.** A
caller-supplied `startingLakePositions` throws
`STARTING_LAKE_POSITIONS_UNSUPPORTED` (#365), because the module derives the
lake list from the seed and the spawn - the game's own rule - so an explicit
list is a WRONG answer rather than a slow one, and because the request is a
fixed-size struct with nowhere to put a variable-length array. And a
non-Nauvis `planet` with an elevation view throws `unsupportedPair`, because
`mapType` spans the Nauvis family only. There is no TypeScript path left for
either to take: #227 deleted the Nauvis and Vulcanus arms and #371 the
Fulgora one. Neither case is reachable from the app.

`test/wasmElevationRenderParity.spec.ts` grades it, and its windows are
MEASURED rather than chosen: two obvious far-field windows turned out to be a
single flat colour on one or more trees, which a byte-identical assertion passes
without grading anything. It also reaches `renderThroughWasm` directly on each
of the three codes, because a gate that quietly declined the engine would
satisfy every `wasm === ts` assertion in the file.

**One measured oddity worth knowing: `waterLevel` is inert on
`elevation_island`.** Water fraction holds at 1.7% from -20 to +20 across a
128x128 window at 8 tiles/px, while the same sweep moves `elevation_lakes` from
2.5% to 42.0%. The -1000 island bias swamps the water term. That is a property
of the tree, not of the port - both renderers do it, which the byte-identical
arms already say.

**The paint order was WRONG in the module for four slices and nothing could
tell.** The five `if`s ran trees, rocks, enemies, resources, cliffs; the
TypeScript runs trees, resources, rocks, enemies, cliffs. A single-overlay
request triggers exactly one of them, so `all` is the first request that runs
more than one and therefore the first thing that grades the order at all.
Reordering changes only the pixels where two passes land - 2 of 9,216 in the
window that grades it - which is invisible to any whole-image bound. The
frozen `{ore, covered, byRock, byEnemy, byCliff}` count is what catches it, and
**the window matters**: only one of the four has all three obstruction types
covering ore, so on the other three two thirds of that assertion would be
zeroes.

**Crude oil appeared in exactly ONE of ten windows swept**, at 9 pixels - and
that one pixel-cluster is one placement. Measured on the Rust side, its
penalised probability is positive at 1 point in 9,216. Because it is the only
rolled resource, nine of the ten candidate windows would have graded the
threshold path alone while looking complete. This is the ore-window lesson at
its sharpest: for a sparse layer, sweep for the thing before choosing a window.

**The default window set is unusable for a SPARSE overlay, and the enemy layer
is where that bit hardest.** Enemy bases do not spawn inside the starting area,
so two of the five windows the tree and rock blocks share carry zero enemy
pixels - and on the near-spawn window `control:enemy-base:frequency` moves the
render by exactly **0 bytes**. Both the byte-identity block and the lever test
would have reported success having graded nothing. The enemy block has its own
five windows, swept from the far field and then varied in width, height, origin
and tiles-per-pixel independently. Same lesson as Vulcanus's ore windows; expect
to need it again for resources, which are sparser still.

**Two edits in one slice landed in the VULCANUS path instead of the Nauvis one**,
because the two writers end with identical text: `NauvisParams` and
`VulcanusParams` both end `pub placement_sweep_box: [f64; 4],`, and
`renderNauvisThroughWasm` and `renderVulcanusThroughWasm` both end
`placementSweepBox: placementMarkSweepBox(req),`. The first was caught by the
compiler; the second was not - it type-checked and rendered zero enemies, which
looked exactly like a broken port. Anchor an edit on text only the target has.

Three traps that slice paid for, all transferable:

- **A field named for the game's expression is not necessarily the one the
  renderer rolls against.** `NauvisRockFields` has both `rock_density` - the
  game's named expression, which `oracle-rock-density` holds - and `density`,
  the CLAMPED max of the three prototype probabilities. The placement rolls
  against the second. Rolling the first placed about 35x too many rocks, because
  it is unclamped and much larger. The frozen tier-3 counts caught it on the
  first run; a bound wide enough to be safe would not have.
- **Reproduce the reference's out-of-range reads, including the ones that are
  quirks.** `renderRocks.ts` sweeps the halo-widened box and indexes
  `base.data[(py * width + px) * 4]` with a `px` that can be negative - which for
  `py > 0` is a VALID index into the previous row, so its water skip consults the
  wrong pixel. It is not harmless: a rock at `px = -1` still owes pixel 0 part of
  its 3x3 mark. `water_at_wrapping_offset` reproduces it, including JavaScript's
  `undefined` for a genuinely out-of-buffer read, and says why.
- **The tile gate cannot read painted pixels.** A chunk straddles the render
  edge, so `tile_allowed` asks about tiles outside the window. That is what moved
  `nauvis_tile_at` and the water early-out out of `fmw-wasm`'s `render.rs` into
  `fmw_noise::tiles::nauvis_resolve` - the terrain sweep is no longer its only
  caller. The pixel-colour skip that remains is an optimisation and a paint
  guard, not the correctness gate.

**One TypeScript file in a ported directory was ported for a reason that is not
obvious.** `cliffConnections.ts` has **zero consumers of any kind** since #360 deleted the
23 investigation specs that imported it. It is kept as the human-readable
reference `crates/fmw-noise/src/cliffs/connections.rs` cites as its source, so
that #84's cliff investigation can still be run against the engine. The
type-checker still covers it, because `tsconfig.json` includes `src/**/*` by
glob rather than by reachability.

#### The three tiers, and what each one cannot see

- **Tier 1 grades the port against the GAME**, using the `oracle-*` fixtures.
  Score is an **exact f32 match count**, frozen, never an error bound (#162) -
  **except where that count degenerates**, which the Nauvis resource layer is
  the first place it does. See "When the exact-match count degenerates" below.
- **Tier 2 grades Rust against TypeScript**, folding many fields at several
  slider settings into one order-sensitive checksum.
- **Tier 3 is byte-identical RGBA** through the real ABI boundary, plus a count
  against the game's own preview PNGs.

Each tier is blind to something the others catch, and every gap below was
measured rather than assumed:

- **A fixture cannot grade a narrowing the game already snapped away.** The game
  snaps every sample to its 1/256 `MapPosition` grid before evaluating, and that
  grid is a subset of the f32-exact grid, so a narrowed and an un-narrowed form
  score the same. #309 lived through three shipped PRs this way.
- **Tier 3 cannot see one either**, because every one of its windows uses a
  binary origin and step. That is deliberate for byte-identity, and it means
  tier 3 proves nothing about off-grid behaviour.
- **A tile argmax absorbs almost anything.** In one off-grid sweep
  `resolvedTile` matched at all 676 points while 17 of the 19 probabilities
  behind it diverged. That is the standing answer to "tier 3 is byte-identical,
  so why build tier 2".
- **Only tier 2 sees the wasm libm**, and after #227 only its FROZEN table does.
  `cargo test` runs on the host libm, so a
  `log2`/`pow` difference inside `wasm32-unknown-unknown` is invisible to it
  (#270). Anything new that reaches a transcendental needs a tier-2 sweep, not
  just a fixture.
- **And `cargo test`'s OWN libm differs between your machine and the runner, so
  an exact count with a libm call inside it is not portable.** Measured
  2026-08-26 landing the enemy layer (#327): a test froze the number of radii
  where `r.powf(3.0)` differs from `r * r * r` at 3,653 of 14,406. That is
  **3,651** on the Linux/x86_64 runner. It passed `pnpm run verify` three times
  locally and turned the `rust` job red on every CI run, looking like a port
  regression rather than a platform difference. Before freezing a count, ask
  what it is a function of: if `pow`, `log2`, `exp`, `cbrt`, `sin` or `cos` sits
  anywhere inside the predicate being counted, freeze a FRACTION and say why.
  The parts that are ours stay exact - that test still asserts `total` at
  exactly 14,406, because the shape of the sweep does not depend on the host.

**Tier 2's shelf life is now a FREEZE rather than a deadline.** It compared Rust
against TypeScript, and #227 deletes the TypeScript, so all 1,168 folds are
committed to `test/fixtures/tier2-checksums.json` and each spec asserts BOTH
arms against the frozen value instead of against each other. When the TypeScript
arm goes, the wasm arm keeps running against a number captured while the two
demonstrably agreed. Write each layer's tier 2 as the layer lands anyway - a
layer with no fold has nothing to freeze.

**That freeze exists for one specific reason: nothing else runs the port inside
`wasm32-unknown-unknown`.** `cargo test` links the host libm, so the #270 class
is invisible to tier 1, and tier 3 executes wasm only along paths that reach a
rendered pixel - many fields reach none at all. Without the table, #227 would
have closed that hole permanently while every gate stayed green.

Four planted breaks were RUN rather than predicted: a flipped bit in one frozen
value reddens the **wasm** arm by name; a deleted row fails `toBeDefined` rather
than passing quietly; a dropped case fails the per-planet count guard; and
perturbing a Rust constant (`SEA_LEVEL_TEMPERATURE`, 15.0 -> 15.000000001) and
rebuilding reddens the wasm arm alone, which is exactly the post-#227 behaviour
the table is for. **Read a moved number, do not adjust it.**

Record with `FMW_FREEZE_TIER2=1`, then run the specs normally - a record run
compares nothing and so proves nothing.

**Tier 3 now carries the same freeze, for the same reason (#227).** The render
parity specs got their TypeScript arm by calling `runRenderRequest` with the
engine argument left off, so after the deletion both arms would be the SAME
code - a comparison that passes while grading nothing. `test/tier3Frozen.ts`
freezes each render to a checksum in
`test/fixtures/tier3-render-checksums.json`; `nauvis:render` holds 73 rows,
`vulcanus:render` 26, `elevation:render` 18 and `fulgora:render` 23 - the last
recorded 2026-09-04 ahead of #371, which deletes the Fulgora TypeScript arm
the way #227 deleted the other two.
Record with `FMW_FREEZE_TIER3=1`.

**The island finder has a freeze of the same shape** - `test/islandsFrozen.ts`
over `test/fixtures/island-finder-checksums.json`, four rows in two sections,
because the survey and the finder's ranked list were the last two things still
compared against the TypeScript Fulgora chain. A row there is a structure
folded through its JSON, not an image. Record with `FMW_FREEZE_ISLANDS=1`.

**The plumbing is shared and the tables are not.** `test/frozenTable.ts` holds
the machinery, and both `tier2Frozen.ts` and `tier3Frozen.ts` are thin wrappers
over `makeFrozenTable`, so the guards live in one place rather than two. Tier 3
keeps its own FILE because a row means a different thing - one rendered image,
not a field folded over a grid - and because `tier2Coverage.spec.ts` anchors
tier 2's rows to the module's own `checksum_*` exports, which render rows do
not have.

**The tier-3 fold runs in JavaScript**, not Rust. Both arms already hand back
RGBA bytes, so folding there keeps them symmetric and adds no export - which
means freezing tier 3 rebuilds no `engine.wasm` and cannot go stale against the
committed binary. The fold takes the byte LENGTH first, so a truncated buffer
cannot collide with a shorter render that shares a prefix.

**Each tier-3 spec asserts its own COVERAGE**, the way the three tier-2 planet
specs do. `expectRecordedRows` guards only a RECORD run - it feeds
`flushRecording`, which returns immediately unless the environment variable is
set - so without a second guard nothing checks that the rows are consulted on a
normal run, and a deleted `freeze` call site would leave its row in the table
un-consulted while every gate stayed green. `frozenTable.ts` tracks the distinct
rows each run looks up, and the spec asserts BOTH that count and the table's.
The two fail on opposite mistakes: the table count catches a re-record that
wrote a different surface, the consulted count catches a call site that stopped
asking. A literal compared only against the file would move with neither.

Three planted breaks were RUN rather than predicted:

- a corrupted row reddens the wasm arm by name
  (`wasm 11549297961623709281 != frozen 16045690984833335023`)
- a deleted row fails "no frozen checksum" rather than skipping quietly
- **a deleted `freeze` call site leaves all 37 other tests GREEN**, and is
  caught only by the coverage guard, at "expected 72 to be 73"

The row-count guard also fired for real - a first record run declared 73 and
recorded 60, and `flushRecording` DROPPED the section rather than committing a
short table. The 13 missing rows were the four overlay lever loops, which share
an identical body.

**One test is deliberately NOT frozen**: `refuses the engine for a spawn list
longer than the ABI cap`. Both its arms are the TypeScript renderer, which is
its whole claim, so a frozen row would capture a picture the engine can never
reproduce. It belongs to the `> 8` spawn carve-out, and the #227 deletion
removes both together. The spawn census on #227 is why that is safe: the most
starting points any exchange string in the repo carries is two, against a cap
of eight.

**Parity sweeps must use NON-binary origins and steps**, or they agree by
construction. `test/wasmNauvisParity.spec.ts` freezes 2,365 of 2,420 positions
off the f32 grid, with two tier-3-shaped windows asserted at 0 as the control.
Planting a coordinate narrowing in `hills_offset_raw_x` leaves tier 1 green and
turns tier 2 red.

**An anti-vacuity assertion is not optional.** "Nothing diverges" is exactly what
a sweep evaluating nothing reports. Every parity spec also asserts that its two
windows differ from each other on every field, and that each places every tile.

#### Reading a frozen count

**Score by exact f32 match count and freeze the number.** If one moves later:
read it, do not adjust it. Up is worth taking; down is a regression. Measure the
expected count on the TypeScript side first, so the number comes from the
reference rather than from the port being written. Every count in the port was
measured on both sides and agrees to every printed digit, so they describe the
distance BOTH ports sit from the game, not a gap between them.

Four things flatter or depress a count, and each is a reading rather than a
result:

- **A clamp flatters it**, because a saturated position is exact for free.
  Vulcanus's three clamped biomes score 403, 402 and 408 of 434 against
  unclamped sources at 128, 107 and 127. Read `*_biome_full` as the port's
  score and `*_biome` as what the consumer needs.
- **A discrete output scores high.** `mountain_volcano_spots` is 359 of 434
  because it is dominated by which candidate survives, and a sub-ULP error
  almost never changes that. `voronoi_cell_id` has the same property.
- **Depth beats everything.** Nauvis `temperature` is bit-exact because it is
  one `quick_multioctave_noise` and a clamp with nothing beneath it.
  `elevation_nauvis` is the weakest Nauvis count because it stacks three layers
  and carries every unported narrowing at once. Read the spread by depth, not as
  a ranking.
- **A small residual is not a high count.** `detailNoise` once had the smallest
  residual of its three sibling fields and the fewest exact matches, 1 of 38.
  That one number is the whole argument for counting matches instead of bounding
  error.

#### When the exact-match count degenerates - the resource layer

**On `resources/` the exact f32 match count is 0 and grades nothing.** It is
0 of 16,420 on `oracle-resource-regular` and 0 of 14,980 on
`oracle-resource-starting`, snapped or not, because the fields run to ~12,300
in magnitude and the port sits a systematic ~0.61 from the game - about 600 f32
ULPs. The count is 0 whatever the port does. It is still asserted at 0, so that
fixing #261 turns it into a red test rather than a silent improvement.

**A frozen worst-absolute residual does not cover the gap on its own**, and that
was measured rather than assumed. Nine breaks were planted in the TypeScript,
each checked against an order-sensitive fold of all 31,400 field values so a
real change could be told from a no-op:

- Two real breaks moved the residual loudly - the starting cone radius reading
  `s.quantity` (delta 7,887), and the starting stream losing its `seed1 + 1`
  (delta 13,230).
- **Two real breaks moved it in 0 of 8 cases**: dropping the `f32()` on
  `3 * quantity` in the cone, and pre-narrowing `Math.PI` there. Both change
  values. The 0.61 offset swamps them. That is the class of #273 and #309.
- Five looked like breaks and are genuine no-ops: the regular cull radius
  128 -> 120, the cone's `>` -> `>=`, `min(atMax, atD)` argument order,
  `REGULAR_SPACING`'s last digit, and `1/3` written as a decimal.

So `fixtures.rs` freezes four numbers per case instead of one: the exact count,
the exact worst residual, the count of positions no cone reached, and **an
FNV-1a fold of the port's own values, measured on the TypeScript side first**.
The fold is what catches a narrowing slip, and it is what lets `cargo test`
catch one alone rather than waiting for the JavaScript parity spec.

**Do not take a cone-versus-basement split off a subtraction.** `field -
blobTerm == basement` looks like the spot field and is not: `(a + b) - b` is not
`a`, and the proxy undercounts the at-basement group by up to 692 of 4,105
positions. Both ports agree on the proxy at 8 of 8 cases, so it is a faithful
measurement of the wrong thing. Take it from the spot field.

**`snapPosition` before scoring anything against a fixture**
(`test/captureGrid.ts`). Scoring at raw fixture coordinates returns a confident
wrong answer, because it grades at points the game never visited. Three tier-1
sweeps shipped doing this, and fixing it moved 13 frozen counts up (#295).

**Rule out the capture grid before blaming the game version.** A version
difference and a grid difference look identical from inside a count, and
re-capturing to test a version hypothesis will confirm that hypothesis whether
or not it is true. Two more consequences, both measured (#295):

- **Comparing two captures' COUNTS is never a version measurement** unless you
  first restrict to the positions they share. Two Vulcanus captures shared only
  52 of their 61 points; restricted to those, all five fields tied exactly.
  Compare values at shared positions instead - that needs no port at all.
- **A re-capture cannot land on the points that snapping an old fixture
  produces.** A capture PRODUCES a grid coordinate with `Math.floor`
  (`snapToMapPosition` in `test/oracle/capture.ts`); `test/captureGrid.ts`
  RECOVERS one with `Math.trunc`, because truncation toward zero is what the
  game does to an off-grid coordinate. They differ by one cell on a NEGATIVE
  coordinate, which is why this never showed up near the origin.

Where a snap is load-bearing, the test pins **both** arms - the snapped count
and the raw one. A test asserting only the good number would pass again if the
snap were removed and the counts re-frozen to match, which is exactly how this
shipped the first time. There are three such tests.

**2.1.14, 2.1.15 and 2.1.16 are ONE oracle** for map-gen, because the data Lua
is byte-identical across them. So `refs:sync --fixtures` overstates staleness by
three versions.

#### The findings this port produced, and how they were settled

The port found real defects in shipped TypeScript. **None was fixed inside the
port.** Each got an issue and landed as its own graded change, because a
unilateral fix on the Rust side reads as a port bug in tier 2, which is the
whole point of having tier 2. All are now landed: #269, #270, #273, #279, #290,
#293, #309.

**The render path added a second one, and it is a user-visible bug rather than a
precision question: #326.** `renderTerrain.ts` - the Nauvis tile argmax, so the
`terrain` view and the terrain base of `all` - never threads `waterLevel` into
the elevation it reads. `TileResolverParams` has no such field, so every tile
resolves at `water_level = 0` however the slider is set, while the `elevation`,
`resources` and `cliffs` views in the same panel all honour it. Measured over a
162x162 grid spanning +/-3000 tiles: `control:water:size = 2` moves **12,471 of
26,244 tiles (47.5%)**, and size 8 moves 74.4%.

**A near-spawn window hides it completely, and that is the transferable half.**
The first measurement used an 80x80 grid at step 7 over +/-280 tiles and
reported **0 of 6400 differ at every water level**, with an `elevation_nauvis`
mean that did not move at all above 0. That window sits inside the starting
area, where the tree's starting-lake and starting-island terms dominate and the
water-level term is masked. Widening to +/-3000 reverses the answer entirely. A
near-spawn window is not a sample of this lever - and the same trap set the
tier-3 spec's windows, where a 64x64 window at 1 tile/px came back with TWO
distinct colours and `auxFrequency` moved nothing.

The Rust render reproduces the omission, so tier 3 stays byte-identical and the
fix lands as its own graded change with its pixel impact measured.

**The cliff layer added one more, and it is a DUPLICATED FUNCTION rather than a
narrowing.** `src/noise/cliffs/cliffCatalog.ts` carries its own plain-f64
`sliderToLinear`, and `cliffFields.ts` is its only consumer. The form in
`src/noise/eval/math.ts` rounds every operation to f32 and is the one measured
against the game - `fulgora_grid` sampled at five slider positions, where an f64
chain rounded once at the end misses `s = 3` by one ULP. The two disagree at
**11 of 22** slider positions across the two ranges the cliff gate reads, worst
1.4e-7. The Rust reproduces the f64 form, because that is what the TypeScript
does; the finding is issue #324.

No committed fixture can grade it. All three cliff fixtures were captured at
default settings, and at `s = 1` the two forms agree exactly on `(-1, 1)`. They
do NOT agree on `(-1.7, 1.7)`, where the f32 form gives 4.768372e-8 rather than
0 - but the gate reads that range only inside a `min` whose other argument is
the `(-1, 1)` zero, so the one place they differ at the default is masked by an
argument the `min` never picks. `test/cliffCatalog.spec.ts` asserts the anchor to
12 decimal places, which the game-validated form would fail.

**A lever can be masked so hard that only the slider's extreme grades it**, and
that is the transferable half. Cliff frequency reaches the tier-2 block by one
path, through two nested `min`s. Measured over 1600 positions, the count of
moved field values is **0 at 1.0, 0.8, 0.6, 0.5, 0.45, 0.42, 0.4, 0.35, 0.3 and
0.25, and 21 of 9600 at 1/6**. A sweep at any milder setting grades nothing
while looking like it grades something. An analytic estimate of the crossing
from the term's own bounds said "about 0.42" and was wrong by more than a factor
of two, so sweep the lever rather than reasoning about it.

Five rules came out of that work, and they are the transferable part:

- **Accept a sweep candidate only when its OWN field reaches a full exact
  count**, and re-baseline after each accept, because the chain is a DAG.
  Against a frozen baseline `fulgora_natural` looks capped at 99/101 and
  actually reaches 101/101 once its input is fixed. Twelve candidates that
  merely improved were rejected and written up. "It got smaller" stays a
  hypothesis.
- **Mirror the reference's narrowing points, never earlier or later.** The game
  holds constants at f32, narrows per operation, and narrows the coordinate
  going into a primitive. Getting one of those right and not the others can make
  a count WORSE, and the same literal wants opposite fixes in different arities:
  typing three constants in a three-term sum regresses it, while narrowing every
  operation fixes it.
- **Fold the fixtures you already HAVE before capturing more.** #309 looked
  ungradeable, and the plan was a far-field capture at `|x| >= 65536`. It was
  unnecessary. Fulgora reads a multioctave at a DERIVED coordinate, which leaves
  the f32 grid right next to the origin, so `oracle-fulgora-elevation` had held
  the evidence for months: the narrowed form scores **101/101**, the un-narrowed
  one 81/101. **A "no fixture can grade this" claim is only about the fixtures
  you looked at.**
- **Capture the INTERMEDIATES, at the SAME positions.** #293 was settled by
  comparing the game's own composed field against the game's own leaves, with
  our code removed from the comparison entirely: `abs(gameLeafA - gameLeafB)`
  reproduced the game's `hairline_cracks` at only 7 of 61, so the expression was
  wrong and no line of ours was involved in showing it. The oracle harness
  samples any expression the game names, so this is available for any layer.
- **A green `pnpm run verify` cannot see a change of this class** (#256). When
  #269 landed, the whole TypeScript suite passed with zero failures even though
  the model under seven call sites had changed, because those specs assert
  tolerance bounds wide enough to swallow it. Re-score exact counts before and
  after.

**Read the game's Lua before inferring a formula from residuals.** It is on the
capture machine at `<install>/data/space-age/prototypes/planet/`. #293 was three
hours of numerical archaeology that one grep of `planet-vulcanus-map-gen.lua`
would have shortened - the answer, `vulcanus_cracks_scale` being a
noise-expression rather than a Lua number, is visible in the prototype's own
`type` field.

**Do not publish a headline number measured on an intermediate tree.** A
25-pixel improvement was published from a tree carrying three candidates that
were later dropped; the shipped number was one pixel worse.

#### Two open threads

**#191's issue text is stale - read the code, not the issue.**
`quickMultioctaveNoise` already narrows both coordinates.
`variablePersistenceMultioctaveNoise` narrowed `x` and not `y` in **both**
ports, which is why tier 2 could not see it, and both now narrow it. The third
op, `basisNoise` itself, was deliberately NOT changed: its disciplined callers
all narrow before calling, and its remaining direct callers
(`nauvisShared.ts:133`, `startingPatches.ts:185`, `regularPatches.ts:164`) are
unported NAUVIS chains where the whole expression is un-narrowed. No committed
fixture discriminates it, so **that belongs to #226**, scored layer by layer
under the greedy-accept rule.

**#279's 12 candidates are still unapplied, and its prediction about them is NOT
confirmed.** It expected `moats`, `vaultSpots` and `spotsPrebanding` to reach
101/101 once the cones moved; measured, they reach 69, 69 and 98. They improved
and did not close, so each still has to be applied and re-scored one at a time.

#### One open finding, and do not "fix" it

`variable_persistence_multioctave_noise` takes its `persistence` operand as
**f64**, matching the TypeScript. `oracle-variable-persistence-multioctave`
cannot grade the width - all 38 of its persistence values are already f32 - but
`oracle-multioctave-wrappers`'s amplitude-corrected cases can, because they pass
the program constant `0.7` straight in: **f64 scores 81/152, f32 scores 89/152**.

**The worse-scoring f64 form is what ships.** 89 is an improvement rather than a
full exact count, so the greedy-accept rule rejects it, and adopting it would
put a divergence into every Nauvis elevation value with nothing to grade it.
Neither form is the game's. Posted to #254 as one term worth 8 points, with 63
still unexplained.

Two harness compensations went with that work, and both are worth copying.
`checksum_variable_persistence` crossed the ABI as an f32, so the spec narrowed
its own value with `Math.fround` first - making the two sides agree by
construction on exactly the term that differed. Both are f64 now. And
`p ** octaves` is **`powf`, not `powi`**: `powi` disagrees with V8 by one ULP at
0.7^4, 0.7^6 and 0.7^8, and one ULP there flips the f32 rounding of the octave
gain, which moves every point in the case.

#### Current tier-1 counts

**`crates/fmw-noise/src/fixtures.rs` is the authority, and the tables live in
`docs/rust-wasm-port-history.md`.** Do not copy a count back into this file. It
has gone stale twice, and a number written in two places is a number that can
disagree with itself - which is exactly the failure `test/captureGrid.ts` hit
below. What stays here is the part that is a RULE rather than a record.

- **Freeze the three BUCKETS, not the headline, wherever a basement or a clamp
  dominates.** The enemy-base field is the worked case: it bottoms out at -1000,
  so a position no cone reaches sits near -1007, where one f32 ULP is about
  6e-5 - larger than the whole residual, and therefore exact for free. Nearly
  the entire headline count is that. Where the field is actually doing something
  the port matches 2 of 406. A single frozen headline goes green on badly wrong
  cone arithmetic, and moves when a recapture shifts the basement/live split.
  This is the "a clamp flatters it" rule with a basement instead of a clamp.
- **A gate result needs an anti-vacuity control frozen beside it.**
  `cliffiness_nauvis` is `(main_cliffiness >= cliff_cutoff) * 10` and scores
  **0 gate mismatches of 1024** at both seeds - the strongest tier-1 result any
  Nauvis field has apart from `temperature`. That means nothing on its own,
  because a constant-0 port also produces no mismatches on the zero side. The
  non-zero count is frozen next to it for that reason.
- **When a fixture is FULLY ON-GRID the snap is the identity, so assert that
  rather than applying a snap that buys nothing** - `captureGrid.ts`'s own rule
  for a snap that has reached zero. Pin BOTH arms anyway: "the snap is the
  identity" is a claim about ANSWERS, and an off-grid count of 0 only counts
  positions. The two cliff fixtures are the first phase-6 layer where it holds.
- **A hand-maintained count table DRIFTS, and nothing was asserting it.**
  `test/captureGrid.ts` had drifted in four rows at once - two tree rows and two
  `oracle-rock-density` rows - each off by one or two in BOTH arms of its
  fixture and in the same direction, which is the signature of the port having
  moved since the table was taken rather than of a methodology difference. All
  four are frozen on the Rust side now, snapped and raw, so a future drift fails
  a test instead of quietly ageing a comment. That is the general remedy: freeze
  it in a test, or do not write it down.
- **The resource layer has no exact count at all** - see "When the exact-match
  count degenerates" above. It freezes a worst absolute residual per case plus a
  fold, and every one of those residuals is the same term: the `fast_cbrt`
  inside `basement_value` (#261).
- **Assert an EXACT count rather than a bound wherever byte-identity makes one
  possible.** Vulcanus's whole-image comparison against the game's own 1024x1024
  PNG is frozen exactly for that reason, not bounded.
- **A bound reported #279's Vulcanus work as a REGRESSION, which is #162 with
  the sign flipped.** Four resource fields went from about 600 to about 1000
  exact of 1085 while one worst residual tripled and tripped a 3e-5 bound - a
  bound that was two ULPs at the outlier's own magnitude. Those four assertions
  are frozen exact counts now with the residual kept underneath, and the
  replacement was proven strictly stronger by planting: un-narrowing the calcite
  radius drops the count 969 -> 669 while the residual bound passes unchanged.

#### The ABI

**The request layout is at v2 and is per-planet.** A 56-byte common prefix
declares `params_bytes`, then a per-planet block follows. Fulgora's request is
120 bytes; Vulcanus's is 368; Nauvis's is 568 and is the largest, so
`REQUEST_BYTES` is Nauvis's.

**A planet block can grow with NO version bump, and that is the split working.**
The Vulcanus block has grown three times (248 -> 280 -> 312 -> 368), and
Fulgora's grew for the first time in #363 (48 -> 64, so the request went 104 -> 120) when the scrap overlay needed `control:scrap:frequency` and `:size` to
cross. `BadParamsLength` refuses a writer whose declared length disagrees. **A
version bump is for a change to the COMMON prefix**, which every planet reads.

**The Fulgora block is append-only, and the two scrap sliders sit AFTER the
trig rather than beside the two island sliders.** Grouping them with the other
controls would have moved the trig block, which every existing reader already
knows the offsets of. `test/fixtures/verify-wasm-request.py` - the third
implementation, neither the writer nor the Rust reader - checks both new
offsets, and a planted swap of the two is one of the breaks confirmed caught.

**The module does NOT default the scrap sliders**, and `FulgoraParams`'s
`Default` gives 0 rather than the neutral 1 on purpose, so a writer that forgot
them renders visibly wrong rather than plausibly right. The single place an
absent slider becomes 1 is `writeFulgoraParams` in `src/noise/wasm/request.ts`.
Do not add a second.

**`VIEW_SCRAP_FOOTPRINT` is not the scrap overlay, and #363's issue body was
written believing it was.** The footprint view paints every tile where the
probability is positive; the `all` composite paints the subset a placement ROLL
accepts. Measured over a 128x128 window at seed 123456: 708 footprint tiles
against 177 placed, so substituting one for the other moves 531 pixels. The
footprint is deliberately not a roll, because diffing rolled pixels against the
game's drawn pixels measures the salt rather than the model -
`crates/fmw-wasm/src/render.rs` says so at the constant.

**`control:scrap:frequency` above neutral does not move the picture**, measured
2026-08-31 on a 64x64 window at (-500, 3000), seed 123456: `(4, 1)` is
byte-identical to `(1, 1)` at 149 scrap pixels, while `(0.25, 1)` gives 104.
`size` moves both ways - 194 at 3, 118 at 0.25. This is not a curiosity: a
parity test that moves `frequency` UPWARD grades nothing, and one written that
way was measured passing against a module that ignored the field outright.
`test/wasmFulgoraRenderParity.spec.ts` moves one slider at a time and pins the
dead zone.

**Nauvis's block landed at 64 bytes with no bump and has since grown five
times** - 96 for the tree overlay's four levers, 144 for the rock overlay's two
and its sweep box, 160 for the enemy overlay's two, 232 for the cliff overlay's
five and its own query box, 376 for the resource overlay's eighteen - so a
Nauvis request is 432.

**`REQUEST_BYTES` MOVED for the first time since the v2 split, and it is
Nauvis's now.** Both sides had it written as `COMMON_BYTES +
VULCANUS_PARAMS_BYTES`, which was correct for three planets and silently wrong
the moment a fourth block overtook it - the failure being a scratch buffer too
small, which surfaces as a truncated request rather than as a size error. It is
a `max` on both sides now, and the Rust test asserts the PROPERTY (the capacity
equals the largest request) rather than repeating a literal. A Nauvis request
was between the other two, which is what makes "the encoder returns a LENGTH,
not the capacity" a real statement rather than a two-case coincidence. It carries no trig, because Nauvis is the
one planet free of transcendentals.

It carries ONE world box, not two, and which overlays need one is not
guessable. The terrain view paints one pixel per pixel. Trees need none either,
because they read a one-cell border of their own FIELD rather than of the image

- so a tiled render matches an untiled one with nothing widened, and trees are
  the only one of the five like that. Rocks do read the image, and their mark is a
  symmetric 3x3, so one box covers it exactly. Cliffs will need a SECOND box,
  because that block is asymmetric and its two directions cross.

`test/fixtures/wasm-request.v2.json` pins all three, and
`verify-wasm-request.py` decodes all three. Nauvis's structural check is just
"distinct scalars at distinct offsets" - there is no unit-norm property to lean
on, and none is needed, because scalars cannot be swapped without one reading
wrong.

**That argument was sound and the FIXTURE did not instantiate it**, which is the
bearing-swap lesson one level up rather than the opposite of it. The committed
Nauvis request carried only two distinct values across its eight fields - five
`1.0` and three `0.0` - so a swap of `moistureFrequency` and `auxFrequency` read
back correct and passed every assertion. The fixture now uses twelve distinct
values, and both checkers ENFORCE distinctness rather than assuming it:
`verify-wasm-request.py` fails on a repeat, and `no_two_nauvis_fields_share_an_offset`
is the Rust side. **Check that a structural claim's data instantiates it**; a
property nothing exercises reports success either way.

**Errors return a status code and never trap.** A trap would poison the instance
for every later request in that worker; a spec sends a bad magic and then
renders successfully through the same instance.

`test/fixtures/wasm-request.v2.json` pins the encoding for both planets. It is
declared under `notFixtures` because it is our own ABI rather than Factorio
ground truth, and its bytes were checked by
`test/fixtures/verify-wasm-request.py` - **a third implementation, not the
writer under test** - committed beside it so a future version is re-verified the
same way rather than regenerated from the encoder.

**That checker was measured MISSING a real defect, and the lesson is bigger than
the checker.** It cannot reproduce the trig VALUES, since those are V8's
`Math.sin` after an f32 narrowing, so it checks each pair for
`sin^2 + cos^2 = 1` instead. That property **passed a planted swap of two
bearings** - the failure that renders a plausible planet with its biomes rotated

- because a property is invariant under permutation. It now also recovers each
  angle with `atan2` and checks it against the offset the game's Lua gives it, and
  catches seven planted breaks instead of four. **A property check is not a
  structural check.** Ask what your property is invariant under, and plant that.

**Two overlays with different-SHAPED marks need TWO boxes.** Vulcanus sends both
`cell_query_box` and `placement_sweep_box` rather than reusing one: the cliff
block spans `px - 2 ..= px + 1`, so its halo is asymmetric and its two
directions cross, while a placement mark is a symmetric 3x3 centred on its
pixel. Both are SENT rather than derived, because each needs the FULL image's
geometry, which the prefix does not carry and only the tiled renderer knows.

Eleven planted breaks were RUN against those two boxes, not listed. Ten are
caught by the per-edge value check. The eleventh is not: **a halo one tile wider
on the low x side, with the request edited to agree, passes every value check**
and is caught only by asserting the placement halo is symmetric about the pixel
box. The structural checks (four distinct edges, not inverted, no edge shared
between the boxes) caught none of the eleven and constrain the FIXTURE, which
the file says rather than claiming credit.

#### The cutover, and why an early render is not a bug

`runRenderRequest(req, engine?)` takes an OPTIONAL engine - a parameter rather
than module state, so nothing has to be registered or reset between tests.
`createRenderWorker` loads and compiles the module once per page and posts it to
each worker; the worker instantiates synchronously with
`new WebAssembly.Instance(module)`, which is allowed for an already-compiled
module on any thread.

**Nauvis's cutover has one extra guard: the SPAWN.** The Nauvis block carries no
spawn list, so the module fixes it at the origin, and `runRenderRequest` refuses
the engine when `startingPositions` is anything else. That is a correctness
guard rather than a missing optimisation - `startingPositions` reaches
`elevation_nauvis`'s distance term and `moisture`'s starting-area blend, so
taking the engine there would be a wrong answer rather than a slow one.

**A render dispatched before the engine message arrives is QUEUED, and the
handshake must SETTLE.** This paragraph used to say an early request was "not
a bug" because it took the byte-identical TypeScript path, and that a failed
fetch or compile was therefore swallowed. Both halves expired with #227: with
no TypeScript to fall back to, the worker holds a request until the engine
message arrives - and a swallowed load failure then meant the message never
arrived and every tile hung on "Rendering..." (found and fixed in #371's
engine-mandatory change). `createRenderWorker` now posts
`{ kind: "engine", error }` on failure, the worker fails each queued and later
request with `render engine failed to load: ...`, and the host rejects them by
id. `IslandFinderPanel`'s `surveyEngine()` stopped swallowing for the same
reason; its failure lands in the panel as the module's own message.
`test/renderWorkerEngine.spec.ts` grades the queue, the bad-module case and the
no-module case.

**The engine load sits in `createRenderWorker`, not in `createWorkerHost`, and
that is not stylistic.** Every test that exercises the host constructs it with a
fake worker factory, and fetching from the host made those tests print a page of
`ECONNREFUSED` while still passing - under vitest the module URL points at a dev
server that is not running. Loading beside the real `new Worker` means only the
real browser path ever reaches the network.

#### Performance

**The engine is ~2.46x faster than the TypeScript IN THE BROWSER**, and the
"22.71x" #275 published is wrong:

| harness             | TypeScript |        WASM |     ratio |
| ------------------- | ---------: | ----------: | --------: |
| Chrome, dev server  | **246 ms** | **99.7 ms** | **2.46x** |
| Node, inside vitest |    1134 ms |     50.7 ms |     22.4x |

The same TypeScript is 246 ms in the browser and ~1130 ms under vitest, and its
warm-up trace is flat from the first pass, so that is not a cold JIT - it is
issue **#267**, vitest's per-module transform. Only one of the two arms pays
that tax. The WASM arm differs the other way (50.7 ms in Node against 99.7 ms in
Chrome), so neither engine is uniformly faster. Method: warmed 12 passes per
arm, interleaved, min of 11, three page loads giving 2.46 / 2.47 / 2.46, plus
2.41x at 1024x1024.

**The lesson generalises past this number.** Any A/B where the two arms go
through different amounts of the test harness is measuring the harness.
Benchmark in the environment that ships, or at least confirm the harness treats
both arms alike.

**`multioctave_noise(x, y, &params)` REBUILDS its seed tables on every call, and
that cost 20x before it was measured.** `tables_from_seed` runs a PRNG over three
256-byte permutation tables, and Fulgora's chain makes eight such calls per
pixel. Hoisting them into a `Prepared` built once per render - which is what the
TypeScript's closure has always done - moved a 256x256 landmask render from
**975.8ms to 50.7ms**. Nothing in tiers 1-3 could see it, because the results are
identical either way; only a benchmark can.

#### Rules that keep the port deterministic

- **`f64::max` is NOT `Math.max`.** They differ on NaN, and on **signed zero**,
  where `Math.max(-0, +0)` is `+0` while `f64::max` follows IEEE 754-2019
  `maximumNumber`, whose result for two operands that compare equal is
  explicitly either input. Fulgora's `tile_ruin_paving` really did fold to a
  different checksum for this reason, and phase 3 had shipped 27 such sites.
  Every `min`/`max` in a ported expression goes through
  `eval::math::{min2, max2}`, and **the argument order is kept as the TypeScript
  writes it**. Only an order-sensitive raw-bits fold can see this - it is
  invisible to every tolerance and to tier 1.
- **`fold_f64` folds RAW BITS and must stay order-sensitive.** An XOR fold is
  blind to order and cancels pairs, so swapping two points or breaking two
  identically would leave it unchanged. `the_fold_is_order_sensitive` makes that
  load-bearing, and it was watched failing against a planted XOR fold.
- **Trig crosses the boundary as VALUES computed in V8**, never computed in the
  module (#270). `starting_spot_at_angle` is plain f64 with no narrowing, so a
  one-ULP `sin` difference lands straight in the result. At all 13 call sites
  the angle and distance are per-render constants, so the sine and cosine are
  computed once outside the per-pixel path and handed in. Nauvis reaches no
  transcendental today; if a new field does, its value gets passed in.
- **No `mul_add` and no fast-math.** `clippy::suboptimal_flops` is explicitly
  allowed so turning `nursery` on later cannot push the port toward FMA. No
  `target-cpu=native`. `simd128` is off (measured at 1.27x on a gather-bound
  kernel, so it would change the binary for no gain), and `relaxed_simd` never,
  since its fused multiply-add is non-deterministic across engines by design.
- **A WASM `u64` arrives in JavaScript as a SIGNED BigInt.** `fnv1a64("")` is
  `0xcbf29ce484222325` and JavaScript reads `-0x340d631b7bdddcdb`, its two's
  complement. No error is raised - the number is simply wrong in a way that
  looks like a broken checksum. Every u64 crossing needs
  `BigInt.asUintN(64, x)`; `test/wasmEngine.spec.ts` shows the shape.

#### The poison feature is the gate's anti-vacuity control

`verify:rust` builds with the `poison` feature, which perturbs an op's returned
value, and asserts a **named list** of tier-1 tests goes red. The list is why:
while every ported op composed `basis_noise`, its single hook reddened
everything, so a suite-level "did anything fail" check looked sufficient. It is
not. That list has already earned itself twice - it caught `voronoi_noise`'s
`cell_random` shipping with no hook, and found that `fast_approx` had shipped a
whole phase earlier with no tier-1 test and no hook at all.

**Adding an op means adding its hook and its FULL test path to
`POISONED_TESTS`, then watching it actually go red.**

- **A numeric hook does not reach a DISCRETE output.** With only the elevation
  hook live, the Fulgora tile test stayed green at 7 and 11 misses of 5,057,
  because a one-ULP nudge changes which side of a comparison a value falls on
  essentially never. Discrete outputs need their own hook: `poison::bool_result`,
  `index_result` for an argmax, `crossing_result` for a tri-state classification
  (which ROTATES rather than negating, since negating `0` is `0`, the answer
  most edges give), and `sweep_order` for `fixImpossibleCells`, which has no
  value to bend at all, only a choice of which edge to clear.
- **A hook whose op moves everything needs its consumer tested separately.**
  Under poison the Fulgora ocean hook flips every position's answer, so the
  argmax test would be red whether or not the argmax had a control of its own.
  Same for the cliff sweep under `crossing_result`.
- **Some tests stay GREEN under poison and should.** One reads a fixture and no
  port code; another asserts that WRONG models of `^` disagree, which poisoning
  only strengthens; and a relational assertion cancels, because a perturbation
  applies to both sides. `poison.rs` records each.
- **Do not add a hook no test could give an independent control.** No phase-6
  expression layer carries one, and that was measured: deleting `nauvis_shared`'s
  leaves its tier-1 test red anyway at 5 of 30, because everything in these
  chains composes `basis_noise`.

#### `engine.wasm` is a COMMITTED artifact

`scripts/build-wasm.sh` produces it; `verify:rust` rebuilds and compares bytes
rather than regenerating. That is what keeps `vp build` free of any non-JS step
and lets `deploy:app` run on a machine with no Rust at all. **Any change to a
Rust source means rerunning that script and committing the result**, or the gate
fails as "stale".

Byte identity across machines is measured, not hoped for (#218): the same
source, profile and pinned toolchain give the same sha256 on macOS/aarch64 and
on an ubuntu x86_64 runner. That is why the gate can use `cmp` instead of
rebuild-and-retest.

**Three fingerprints for a diff that is NOT a behaviour change**, all seen for
real:

- **Pure line numbers.** A tiny `cmp -l` count, every changed offset inside the
  `data` section, all section sizes identical, and a `u32` delta equal to the
  number of lines you inserted. Those are `core::panic::Location` records.
- **A comment-only edit counts.** A 19-line `///` block on its own moved 9
  bytes, shifting six Locations by exactly 19. So a comment-only edit in a
  reachable file makes the gate report "stale", and that is the gate working
  rather than a false positive.
- **A new UNREACHABLE module counts too**, measured at 54 bytes in #318. No
  section kept its size and the delta was not a line count; the sufficient
  explanation is inlining, since a new caller of an existing helper changes the
  cost heuristics for code that DOES ship.

**The trap when reading a Location record is alignment.** It is
`{file_ptr, file_len, line, col}` and it is NOT 4-byte aligned in the data
image. Reading a `u32` at `offset - (offset % 4)` gave "delta 4864" and looked
like a moved string table; realigned, the same field is 716 -> 735, and 4864 is
just `19 << 8`. Locate the record from its file pointer and length, not from
alignment.

The build is deterministic - a no-change rebuild reproduces the bytes exactly -
so a diff after an edit is always the edit. **Prove no behaviour changed by
running the wasm parity specs**, especially tier 3's byte-identical renders.

#### Structure conventions to copy for the next layer

- **`aux.rs` cannot exist.** `aux` is a reserved device name on Windows and a
  file by that name cannot be checked out there at all, so the three Nauvis
  climate expressions share `nauvis_climate.rs`. It is the one place the port
  does not mirror `src/noise/expressions/` 1:1. Watch for the same trap with any
  new module name.
- **The tier-2 field SELECTOR lives in `fmw-noise`, beside its stack**, not in
  the wasm crate. The selector needs fields no render path reads, and reaching
  them from another crate meant two `pub` methods existing solely for a test -
  and a `pub` method cannot be `#[cfg(test)]`-gated, because the wasm crate calls
  it at build time. Keeping the selector in the same module makes both private
  again, and moves the field count with it, so the count and the `match` it
  bounds cannot drift apart. That move was pure code motion and still shifted
  `engine.wasm` by 142 bytes, which is a reminder that a wasm diff is not by
  itself evidence of a behaviour change.
- **Export a `<planet>_field_count()`** and assert the spec's name list against
  it, so a field added to the chain cannot silently go untested. Nauvis is at
  **84**: 16 expression fields, 21 tile probabilities, the tile argmax, 18
  resource wrappers, the resource resolver, then `tree_small_noise`, the two
  forest-path cutouts, 15 tree species and the tree density, then
  `cliff_elevation`, `cliffiness`, the three rock probabilities and
  `rock_density`, and finally `enemy_base_field` and `enemy_probability`.

  **Index a block from its own BASE, never from the end of the list.** This has
  now bitten twice in the same file. Two tree assertions were written as
  `FIELD_NAMES.length - 1` and broke when the cliff block landed behind them;
  the cliff block's own name test was then written as an open-ended
  `slice(base)`, which asserted "these six are the last six" and broke when the
  enemy block landed. Use a bounded slice and assert the NEXT block's first name.

  **Do not fold an operand just because a `max` sits above it.** The tile argmax
  and the rock max both hide their operands, so those blocks fold each one. The
  enemy `max` does not: its spot field runs from -1000 to about +1 while the
  terms added to it are roughly +/-0.15, so the composed field is dominated by
  the spot field rather than masking it. Check the magnitudes before deciding -
  and folding it would have cost a reimplementation of the region scan in the
  parity spec, which the TypeScript does not expose.

- **Let the two sides reach the same numbers by DIFFERENT routes where you can.**
  Nauvis's resource block is the worked case: the Rust selector reads its five
  thresholded resources off the shipped `ResourceResolver`, while the TypeScript
  spec builds all six from the documented skip constants, because
  `makeResourceResolver` returns a bare closure and exposes nothing. Agreement
  is then evidence that the resolver really does partition its two candidate
  streams the way its own docs say. Building the same private copy on both sides
  would have proved nothing - that is the `checksum_vulcanus` trap one level up.
- **Build an expensive tier-2 layer LAZILY.** `checksum_nauvis` is one call per
  FIELD, and constructing the resource block builds four `ElevationNauvis`
  trees, so an eager build would make all 38 expression and tile fields pay for
  a layer none of them reads. A `OnceCell` on the selector fixes it, and
  `the_resource_layer_is_built_only_when_a_resource_field_is_asked_for` keeps it
  fixed. **The tree block needs a different shape for the same goal**, because
  `TreeFields` borrows a `TreeBase` and a selector owning both would be
  self-referential: it is an `Option<&TreeFields>` on the selector, built at the
  CALL SITE inside an `if field >= TREE_BASE`, with the two locals declared
  before the `if` so they outlive the borrow. Its fallback returns 0 and
  `the_tree_block_is_zero_without_a_tree_layer` pins that, so a missing layer
  cannot be mistaken for a value.
- **A parity window must CONTAIN the thing it grades.** Four of the six resource
  `probability` fields folded 484 zeros in both original windows, because ore is
  sparse against a 22x22 sweep and no patch intersected them - a fold that is
  perfectly bit-identical and compares nothing. No single window fixes it (the
  best of six candidates reached five of six resources), so there are two wide
  ones, and `every resource is actually drawn somewhere in the sweep` freezes
  the per-resource hit counts so a window drifting off its patches fails rather
  than silently losing coverage. Same lesson as the resource overlay's five
  windows on Vulcanus.
- **Cross the parameters as a REQUEST once a render path exists.**
  `checksum_vulcanus(request_len, field)` reads the request already in the
  scratch buffer, written by the shipped `encodeRenderRequest`, and builds its
  stack through the same `render::vulcanus_*` helpers the RENDERER uses - so a
  bearing wired to the wrong layer is INSIDE the comparison. A private copy of
  that wiring would be reproduced identically on both sides and stay invisible.
  The sweep is the request's own pixel grid, swept in the renderer's own order,
  so there is one geometry convention rather than two. **`checksum_nauvis` does
  the same since #337.** It took twenty-nine ARGUMENTS while there was no render
  path for a request to enclose; once there was one, that form meant the module
  built a second `NauvisCtx` beside the renderer's, and a lever wired to the
  wrong layer in both would have folded to the same checksum on both sides and
  stayed invisible. `render::nauvis_ctx` is the one definition now, and a
  planted swap of `moisture_frequency` and `aux_frequency` in the RENDERER turns
  tier 2 red - which the argument form could not have done, by construction.

  Two things that conversion needed, both worth copying. `NauvisCtx.resource_controls`
  became SIX triples rather than one applied to all six: the renderer was
  already building its own six-entry map from the ABI's eighteen levers, so
  those levers sat outside tier 2 entirely. And `water_level` is a PARAMETER of
  `nauvis_ctx` rather than a field of it, because the renderer pins it to 0 for
  #326 while tier 2 must sweep the real value - exactly one field outside the
  shared wiring, for a reason that is itself a tracked defect. **A request
  carries an off-grid sweep perfectly well**, so nothing about this form makes
  the parity coordinates binary.

- **No memo in the Rust chain, and that is not a shortcut.** The TypeScript
  wraps every field in `memoXY` because it builds a DAG of lazy closures; the
  Rust evaluates top to bottom in one pass and keeps intermediates in locals.
  That achieves what the memo achieves, bit-identically, with no cache and no
  `&mut` plumbing. It is legitimate only because every read in that chain is at
  the SAME `(x, y)` - checked field by field. A field that read a neighbour
  would need the cache back.
- **`vulcanus_biomes` is the one layer that keeps a real cache**, because
  `raw_spots` reads selected spots from up to four neighbouring regions. It is a
  `RefCell<BTreeMap>` so `eval` can stay `&self` while the closures handed to
  `select_spots` borrow it, and `BTreeMap` rather than `HashMap` because a
  determinism-critical port should not carry a container whose iteration order
  is unspecified. Nothing on the render path reaches that layer yet, so it is
  correct-first on purpose; if it ever joins a per-pixel render, measure it
  first.
- **The mountains pre-volcano split is load-bearing.** `mountain_volcano_spots`
  depends on the mountains biome and the mountains biome folds the volcano field
  back in; the Lua breaks that with a PRE-volcano stage that `volcano_area`
  reads. Collapsing the two is an infinite recursion, which announces itself -
  reading `volcano_area` off the POST-volcano raw does not.
- **`vulcanus_stack` is TWO structs, and that is ownership rather than taste.**
  Three layers borrow the layers beneath them, so one struct owning the whole
  graph would be self-referential. Nauvis needs only one.
- **`cliff_elevation` is a separate entry point, not a convenience.**
  `multisample`'s offsets are in the CONSUMING program's grid units, so the
  cliff generator's 4-tile lattice moves the field 16 tiles for a `dx` of 4
  (#83). Both channels go through one code path with the grid as a parameter.
  **Check which channel a fixture was captured in before grading against it** -
  the corner fixture holds the TILE channel, grading `cliff_elevation` against
  it is a category error worth 60.6 tiles, and the test now asserts the two
  grids DISAGREE at 2,519 of 12,675 corners. The gap is sparse and large rather
  than a uniform offset, which is why the wrong channel cost seven points of
  recall instead of being obvious.

#### Grading things that are not noise expressions

**The placement roll is the first ported thing that is not a noise expression**,
and it is graded differently because of it. There is no per-position fixture:
the game's ground truth is a count per 512x512 region, and scoring one region
costs **~33s in a debug build**. So the roll is graded against the game on the
TypeScript side (`test/entityDensity.spec.ts`, three rock regions and three
geyser regions) and the two ports are tied together by tier 3's byte-identity.
Its cargo tests are structural instead: the reverse-engineered chunk seed word,
the **DECREASING** tile order (the first draw belongs to tile 1023, and a
reversal is invisible to any density or uniformity check), salt decorrelation,
and the order-dependent collision pass.

**A comparison against a game PNG must be a SUPERSET on the FOOTPRINT**, never
equality and never against a rolled overlay. `map_grid` defaults to true, so the
game draws solid ore as a 2x2 checkerboard at about 0.5 pixels per entity, and a
roll paints only where a draw succeeds - about 40% of the nonzero positions.
Diffing rolled pixels measures the salt rather than the model.

**The seed trap has its own test.** The preview PNGs come from
`--generate-map-preview --map-gen-seed`, a MAP seed, while every `oracle-*.json`
comes from `sampleExpression`, which forces the SURFACE seed. Rendering with the
map seed makes the Fulgora terrain comparison collapse from 3% differing to over
40%, and that is asserted rather than described.

**An overlay needs windows where its thing actually appears.** The resource
overlay has its own five windows because ore is far sparser than rocks - three
of the four windows the rest of that file uses contain no ore at all, so a
per-window count reads `[0, 0, 53, 0]` and three quarters of the comparison is
vacuous. The five were found by sweeping the map for ore and then varying width,
height, origin and tiles-per-pixel independently across what was left. Only the
fifth carries geysers, and it is the one window that grades the ROLLED pass.

**The composite's paint ORDER is asserted, not described.** Resources, then
rocks, then cliffs - so a cliff or a rock crossing an ore patch reads as the
thing that is in the way. Reordering the three passes changes only 208 of 16,384
pixels in the window that grades it, which is invisible to a whole-image bound,
and it is frozen exactly.

#### `verify:rust`'s cost is a RANGE

Treat it as roughly **1m45s to 2m50s**, not a number. Three CI runs on code
whose Rust half was equivalent came in at 1m44s, 2m48s and 2m49s, and that is
the same spread the test shards show. A single run measures the runner at least
as much as the job. Do not "correct" this to whichever number you last saw; if a
change really does move it, show it with more than one run.

The expensive half is the cliff connection fixture test - 33s in the normal arm
and 93s under poison, because `crossing_result` turns every lattice edge into a
crossing, so far more cells place and the `onDestroy` cascade recurses over a
dense set. It is kept because it is the ONLY grading of `cliffs::connections`, a
445-line module on no render path; without it that port would have unit tests and
no measurement against anything. Anyone adding a second fixture test of that
shape should re-measure this job first.

**It runs `bash scripts/verify-rust.sh` directly**, the one place the CI YAML
names a command instead of a package.json script. That does not reopen the drift
rule, because `verify:rust` _is_ that one line. Going through pnpm would add
setup-node and a full install (~28s) to a job that needs no JavaScript. If
`verify:rust` ever grows a second command, the job must become
`pnpm run verify:rust` with the setup steps restored.

