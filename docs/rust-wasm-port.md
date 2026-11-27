# The Rust/WASM noise engine - the full working rules

This is the long form of `CLAUDE.md`'s Rust/WASM section, in the same relation
to it as `docs/factorio-reference-and-oracle.md` is to the reference section.
**Read this before touching `crates/`, `src/noise/wasm/`, or any tier-1/2/3
spec.** `CLAUDE.md` keeps the part that bites a session which is NOT working on
the port; everything a session needs while actually editing it is here.

It is a LIVE document - update it when the port moves. That is what separates it
from `docs/rust-wasm-port-history.md`, which is the archaeology: the count
tables, the rejected sweep candidates, the per-phase landing lists, and the
before-and-after of each fix. Read the history when a rule here is too terse to
act on, or when a frozen count moves and you need to know what moved it last
time.

It was split out on 2026-09-05, when `CLAUDE.md` had reached 158,884 characters
against Claude Code's 150k limit and this material was 69,234 of them. #319 had
already taken the archaeology out on 2026-08-25, leaving 38,150; phases 6, 7 and
8 put 31,084 back in eleven days. Every remaining block that is purely a record
totals 7,482 characters, so a second archaeology-only trim would have left
`CLAUDE.md` at 151,402 and still over. What moved this time is rules, and this
is where they live now.

## Where the port stands, and what still takes the TypeScript path

A Cargo workspace at the repository root, landed empty on purpose (#219) so the
gate was proven green on `main` before any port code depended on it. Two crates:
`fmw-noise` is the engine library and `fmw-wasm` is a `cdylib` holding only the
boundary. The design record is
`docs/superpowers/specs/2026-08-16-rust-wasm-noise-engine-design.md`.

**`docs/rust-wasm-port-history.md` holds the long record** - the count tables,
the rejected sweep candidates, the per-phase landing lists, the planted-break
enumerations, and the archaeology behind each fix. This section keeps the
current state and the rules, each stated ONCE rather than at every site where it
bit. Read the history when a rule here is too terse to act on, or when a frozen
count moves and you need to know what moved it last time.

**Do not quote a byte count for `engine.wasm` from this file.** Every ported op
changes it and it has gone stale twice. `verify:rust` compares the committed
module against a fresh build, so the gate always knows the right number even
when this file does not. Get it with `shasum -a 256 src/noise/wasm/engine.wasm`.

### Where the port stands

| phase    | scope                                                                                                 | state |
| -------- | ----------------------------------------------------------------------------------------------------- | ----- |
| 1 (#220) | primitives: `taus88`, `fast_approx`, `basis_noise`, the four multioctave ops, `random_penalty`, the spot ops, `distance_from_nearest_point`, `starting_lakes`, `voronoi_noise` | done |
| 2 (#221) | the `eval` layer - `multisample`, `memo_xy`, `memo_region`, `math`, `ctx`, `primitives` - plus `expressions/vulcanus_seed` | done |
| 3 (#223) | Fulgora elevation and cells, `starting_spot_at_angle`, `tiles/`, the ABI boundary, and the render cutover | done |
| 4 (#224) | the rest of Fulgora: masks, roads, ruins, scrap, the tile catalog and `fulgora_stack`                  | done |
| 5 (#225) | Vulcanus end to end - terrain, cliffs, rocks, resources                                               | done |
| 6 (#226) | Nauvis - every expression, the terrain render, all five overlays, the `all` composite, and (as of #227) the three `elevation` views | done |
| 7 (#227, #371) | delete the ported TypeScript under `src/noise/` - Nauvis and the render fallbacks in #227, then Fulgora and the Vulcanus expressions in #371, which left `src/noise/` holding orchestration, catalogs and the ABI only | done |
| 8 (#363) | Fulgora's `resources` and `all` composites                                                            | done |
| 9 (#454) | Aquilo end to end - terrain, tiles, wells, icebergs; Rust-first, no TypeScript counterpart            | done |
| 10 (#492) | Aquilo's wells and icebergs through the game's own per-chunk entity generator (`placement/generate.rs`), replacing the salted roll there | done |
| 11 (#454) | Gleba slice 1 - the terrain fields and the 41-tile choice at tier 1 (`terrace` op, `gleba_*`); no ABI, render, cliffs or entities yet | tier 1 done |
| 12 (#454) | Gleba slice 2 - the terrain view through the engine, name-order tie-break, and tile correction (`tiles/correction.rs`), graded against a REAL surface; dev mode only in the app | terrain done |
| 13 (#454) | Aquilo's terrain through tile correction at one tile per pixel, graded against a REAL surface; the preview PNGs become a reference | terrain done |
| 14 (#454) | Gleba slice 3 - stone and both stromatolites in `resources` and `all`, placed as a REAL surface places them (the per-chunk generator plus apply), 5,193 of 5,193 | stone and stromatolites done |

**Every planet, every view the panel offers, renders through the engine.** Gleba
offers terrain, resources and all, and only in dev mode. The
per-layer landing narrative is in the history doc; what follows is only what is
still a rule.

**Two cases are REFUSED rather than routed anywhere, both deliberately.** A
caller-supplied `startingLakePositions` throws
`STARTING_LAKE_POSITIONS_UNSUPPORTED` (#365), because the module derives the
lake list from the seed and the spawn - the game's own rule - so an explicit
list is a WRONG answer rather than a slow one, and because the request is a
fixed-size struct with nowhere to put a variable-length array. And a non-Nauvis
`planet` with an elevation view throws `unsupportedPair`, because `mapType`
spans the Nauvis family only. **There is no TypeScript path left for either to
take**: #227 deleted the Nauvis and Vulcanus arms and #371 the Fulgora one.
Neither case is reachable from the app.

**Nauvis's cutover has a third guard: the SPAWN.** The Nauvis block carries no
spawn list, so the module fixes it at the origin, and `runRenderRequest` refuses
the engine when `startingPositions` is anything else. That is a correctness
guard rather than a missing optimisation - `startingPositions` reaches
`elevation_nauvis`'s distance term and `moisture`'s starting-area blend.

**`view: "elevation"` is three `view` codes** - `elevationLakes`,
`elevationNauvis`, `elevationIsland` - rather than one plus a `mapType` field,
because the common prefix has no such field and `view` has been a `u32` since
v1. Adding codes is free; adding a field is a layout change. `render_nauvis`
takes them before it builds a tile catalog, since the view is a sign test on one
tree with no argmax and no overlay.

It was never a dev-mode curiosity, which is why it was worth porting.
`"elevation"` is the request DEFAULT, and `ElevationPreviewPanel`'s
`effectiveView` returns it unconditionally for any Nauvis preset whose map type
is not "nauvis" - **outside** the `devMode` branch - so it is what an ordinary
user sees on every Lakes or Island preset, two of the three map types.

`test/wasmElevationRenderParity.spec.ts` grades those three codes, and **its
windows are MEASURED rather than chosen**: two obvious far-field windows turned
out to be a single flat colour on one or more trees, which a byte-identical
assertion passes without grading anything. It also reaches `renderThroughWasm`
directly on each code, because a gate that quietly declined the engine would
satisfy every `wasm === ts` assertion in the file while proving nothing.

**`waterLevel` is inert on `elevation_island`**, measured: water fraction holds
at 1.7% from -20 to +20 across a 128x128 window at 8 tiles/px, while the same
sweep moves `elevation_lakes` from 2.5% to 42.0%. The -1000 island bias swamps
the water term. That is a property of the tree, not of the port - both renderers
do it, which the byte-identical arms already say.

**The Nauvis paint order is trees, resources, rocks, enemies, cliffs**, and it
was WRONG in the module for four slices with nothing able to tell. A
single-overlay request triggers exactly one pass, so `all` is the first request
that runs more than one and therefore the first thing that grades the order at
all. Reordering changes only the pixels where two passes land - 2 of 9,216 in
the window that grades it - which is invisible to any whole-image bound. The
frozen `{ore, covered, byRock, byEnemy, byCliff}` count is what catches it.

**Oil paints FIRST as a 3x3 mark and the solids paint over the top.** That reads
backwards until you read it as the game's arbitration: a solid ore saturates far
above oil, so it must win a shared pixel. The exception is kept by an `oil_mark`
buffer and a `compare_priority` set computed once per render; uranium alone is
outranked by oil today. Crude oil is also the ONLY rolled resource - the other
five threshold.

**The cliff overlay builds its own `NauvisCliffFields`** rather than sharing
the render's stack. It was once the only Nauvis pass reading the REAL water
level, because that stack pinned it to 0 for #320; both read the request now.
It is also the only
overlay with an even-sided mark (`px - 2 ..= px + 1`, anchored not centred) and
the only one needing a SECOND ABI box.

Three traps the overlay work paid for, all transferable:

- **A field named for the game's expression is not necessarily the one the
  renderer rolls against.** `NauvisRockFields` has both `rock_density` - the
  game's named expression, which `oracle-rock-density` holds - and `density`,
  the CLAMPED max of the three prototype probabilities. The placement rolls
  against the second. Rolling the first placed about 35x too many rocks, because
  it is unclamped and much larger. The frozen tier-3 counts caught it on the
  first run; a bound wide enough to be safe would not have.
- **Reproduce the reference's out-of-range reads, including the ones that are
  quirks.** `renderRocks.ts` swept the halo-widened box and indexed
  `base.data[(py * width + px) * 4]` with a `px` that can be negative - which
  for `py > 0` is a VALID index into the previous row, so its water skip
  consults the wrong pixel. It is not harmless: a rock at `px = -1` still owes
  pixel 0 part of its 3x3 mark. `water_at_wrapping_offset` reproduces it,
  including JavaScript's `undefined` for a genuinely out-of-buffer read, and
  says why.
- **The tile gate cannot read painted pixels.** A chunk straddles the render
  edge, so `tile_allowed` asks about tiles outside the window. That is what
  moved `nauvis_tile_at` and the water early-out out of `fmw-wasm`'s `render.rs`
  into `fmw_noise::tiles::nauvis_resolve` - the terrain sweep is no longer its
  only caller. The pixel-colour skip that remains is an optimisation and a paint
  guard, not the correctness gate.

**Anchor an edit on text only the target has.** Two edits in one slice landed in
the VULCANUS path instead of the Nauvis one, because the two writers end with
identical text: `NauvisParams` and `VulcanusParams` both end
`pub placement_sweep_box: [f64; 4],`, and `renderNauvisThroughWasm` and
`renderVulcanusThroughWasm` both end
`placementSweepBox: placementMarkSweepBox(req),`. The first was caught by the
compiler; the second was not - it type-checked and rendered zero enemies, which
looked exactly like a broken port.

**`cliffConnections.ts` was kept after the port, and is now deleted.** It had
zero consumers of any kind since #360 deleted the 23 investigation specs that
imported it, and was kept only as the human-readable reference
`crates/fmw-noise/src/cliffs/connections.rs` cites as its source. It was deleted
on 2026-11-26; read it at `dc6bccd`. The Rust port's module comment points
there.

### A window must CONTAIN the thing it grades

This is the single most expensive lesson in the port, and it recurred at six
sites, so it gets stated once here rather than at each. **Sweep the map for the
thing first, then choose the window** - and vary width, height, origin and
tiles-per-pixel independently across what is left.

- **Near-spawn windows are not a sample of any far-field lever.** #320's first
  measurement used an 80x80 grid at step 7 over +/-280 tiles and reported 0 of
  6400 tiles differing at every water level. Widening to +/-3000 reverses the
  answer entirely: 47.5% differ at `control:water:size = 2`. The starting-lake
  and starting-island terms dominate inside the starting area and mask the
  water-level term.
- **Enemy bases do not spawn in the starting area at all**, so two of the five
  shared windows carry zero enemy pixels, and on the near-spawn window
  `control:enemy-base:frequency` moves the render by exactly 0 bytes. Both the
  byte-identity block and the lever test would have reported success having
  graded nothing. The enemy block has its own five windows.
- **Crude oil appeared in exactly ONE of ten windows swept**, at 9 pixels - one
  placement. Because it is the only rolled resource, nine candidate windows
  would have graded the threshold path alone while looking complete.
- **Ore is sparse against a 22x22 tier-2 sweep**: four of the six resource
  `probability` fields folded 484 zeros in both original windows - bit-identical
  and comparing nothing. No single window fixes it (the best of six candidates
  reached five of six resources), so there are two wide ones, and `every
  resource is actually drawn somewhere in the sweep` freezes the per-resource
  hit counts.
- **The resource overlay needs its own five windows** because three of the four
  the rest of that file uses contain no ore at all, giving a per-window count of
  `[0, 0, 53, 0]`. Only the fifth carries geysers, and it is the one window that
  grades the ROLLED pass.
- **A lever can be masked so hard that only the slider's extreme grades it.**
  Cliff frequency reaches the tier-2 block through two nested `min`s. Over 1600
  positions the count of moved field values is 0 at 1.0, 0.8, 0.6, 0.5, 0.45,
  0.42, 0.4, 0.35, 0.3 and 0.25, and 21 of 9600 at 1/6. An analytic estimate of
  the crossing from the term's own bounds said "about 0.42" and was wrong by
  more than a factor of two, so SWEEP the lever rather than reasoning about it.

**Also check that a lever moves the picture in the direction you are testing.**
`control:scrap:frequency` above neutral does not move Fulgora at all - measured
on a 64x64 window at (-500, 3000), seed 123456: `(4, 1)` is byte-identical to
`(1, 1)` at 149 scrap pixels, while `(0.25, 1)` gives 104. A parity test that
moves that slider UPWARD grades nothing, and one written that way was measured
passing against a module that ignored the field outright.

### The three tiers, and what each one cannot see

- **Tier 1 grades the port against the GAME**, using the `oracle-*` fixtures.
  Score is an exact f32 match count, frozen, never an error bound (#162) -
  except where that count degenerates, which the Nauvis resource layer is the
  first place it does.
- **Tier 2 grades Rust against TypeScript**, folding many fields at several
  slider settings into one order-sensitive checksum.
- **Tier 3 is byte-identical RGBA** through the real ABI boundary, plus a count
  against the game's own preview PNGs. Since 2026-09-14 those PNGs are
  terrain-only: `test/oracle/previewCompare.ts` captures them with a data-stage
  mod (`TERRAIN_ONLY_DATA_FINAL_FIXES`) that removes what no control can switch
  off - Nauvis enemy bases, every Vulcanus cliff, rock, chimney and lichen tree,
  and Fulgora's ruins, fulgurite and big rocks - so nothing is masked and every
  one of the 1,048,576 pixels is compared. Each spec guards its reference by
  asserting the removed colour is absent, which names a capture made without the
  mod before the differing count reports it as a render regression.

  **The render's levers must match the capture's, and Vulcanus is the proof.**
  The captures force the disableable resource controls to size 0; a request
  that names no `vulcanusResourceControls` renders at size 1. The Vulcanus tile
  stack paints ore-halo tiles from the ore fields, so the mismatch put 10,603
  halo pixels into a "terrain" count of 10,610 - 88% sitting exactly on the
  render's own ore footprint - until 2026-09-16, when Eric read it off the diff
  image. With the levers matched the count was 7. The spec asserts both
  numbers, so the levers stay load-bearing: since the grid path (#451) they
  are 1 with the levers and 10,605 without.
  Nauvis does not have the effect (8 either way at the time, 1 since #451),
  because its tiles do not read
  the ore fields. What the matched pairing cannot grade is the halo tiles
  themselves: the only game image that has them has ore drawn on top.

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
  `cargo test` runs on the host libm, so a `log2`/`pow` difference inside
  `wasm32-unknown-unknown` is invisible to it (#270). Anything new that reaches
  a transcendental needs a tier-2 sweep, not just a fixture.
- **And `cargo test`'s OWN libm differs between your machine and the runner, so
  an exact count with a libm call inside it is not portable.** Measured landing
  the enemy layer (#327): a test froze the number of radii where `r.powf(3.0)`
  differs from `r * r * r` at 3,653 of 14,406. That is 3,651 on the Linux/x86_64
  runner. It passed `pnpm run verify` three times locally and turned the `rust`
  job red on every CI run, looking like a port regression rather than a platform
  difference. Before freezing a count, ask what it is a function of: if `pow`,
  `log2`, `exp`, `cbrt`, `sin` or `cos` sits anywhere inside the predicate being
  counted, freeze a FRACTION and say why. The parts that are ours stay exact -
  that test still asserts `total` at exactly 14,406, because the shape of the
  sweep does not depend on the host.

**Tiers 2 and 3 are FROZEN tables now, not comparisons** (#227). Both got their
TypeScript arm by running the reference beside the port, and #227 deleted the
TypeScript, so both arms would otherwise be the same code - a comparison that
passes while grading nothing. Tier 2's 1,168 folds live in
`test/fixtures/tier2-checksums.json`; tier 3's renders live in
`test/fixtures/tier3-render-checksums.json`, where `nauvis:render` holds 73
rows, `vulcanus:render` 26, `elevation:render` 18 and `fulgora:render` 23 - the
last recorded 2026-09-04 ahead of #371, which deleted the Fulgora TypeScript
arm the way #227 deleted the other two. **Each spec now asserts the WASM arm
against a value captured while both arms still agreed.** While both existed the
table could not be wrong, because each arm was checked against it; with the
reference gone, a row can no longer find a NEW disagreement, but it still
catches the port moving - including underneath it in the toolchain.

**Native against WASM.** `crates/fmw-wasm/src/native_parity.rs` is a
`cargo test` that recomputes Fulgora's 76 tier-2 folds natively, for both
cases of `test/wasmFulgoraParity.spec.ts`, and compares them field by field:
the native fold for field index `i` must equal the frozen row
`"<case> | <FIELD_NAMES[i]>"` in `test/fixtures/tier2-checksums.json`. The names
are scanned from the spec's own `FIELD_NAMES` block at compile time, so the
mapping cannot drift (a sorted-list comparison would pass if two fields
swapped values). The WASM
spec already checks the module against those same rows, so native equals
frozen and WASM equals frozen together mean native equals WASM. This is the
check that sees a libm call differing between the two hosts. It covers the
point path only (`checksum_fulgora`), not `At::Grid`. It is not in the poison
run, which uses `-p fmw-noise` only. The module is the last line of
`lib.rs` so no reachable code moves. Planting a one-ULP nudge in
`slider_rescale` (native builds only) made the "frequency 2, size 3" case
fail while "default sliders" still passed.

**The island finder has a freeze of the same shape** - `test/islandsFrozen.ts`
over `test/fixtures/island-finder-checksums.json`, four rows in two sections,
because the survey and the finder's ranked list were the last two things still
compared against the TypeScript Fulgora chain. A row there is a structure
folded through its JSON, not an image. Record with `FMW_FREEZE_ISLANDS=1`.

**That freeze exists for one specific reason: nothing else runs the port inside
`wasm32-unknown-unknown`.** `cargo test` links the host libm, so the #270 class
is invisible to tier 1, and tier 3 executes wasm only along paths that reach a
rendered pixel - many fields reach none at all. Without the tables, #227 would
have closed that hole permanently while every gate stayed green. Write each
layer's tier 2 as the layer lands - a layer with no fold has nothing to freeze.

**Read a moved number, do not adjust it.** Record with `FMW_FREEZE_TIER2=1`,
`FMW_FREEZE_TIER3=1` or `FMW_FREEZE_ISLANDS=1`, then run the specs normally - a
record run compares nothing and so proves nothing.

**The plumbing is shared and the tables are not.** `test/frozenTable.ts` holds
the machinery, and both `tier2Frozen.ts` and `tier3Frozen.ts` are thin wrappers
over `makeFrozenTable`. Tier 3 keeps its own FILE because a row means a
different thing - one rendered image, not a field folded over a grid - and
because `tier2Coverage.spec.ts` anchors tier 2's rows to the module's own
`checksum_*` exports, which render rows do not have.

**The tier-3 fold runs in JavaScript**, not Rust. Both arms already hand back
RGBA bytes, so folding there keeps them symmetric and adds no export - which
means freezing tier 3 rebuilds no `engine.wasm` and cannot go stale against the
committed binary. The fold takes the byte LENGTH first, so a truncated buffer
cannot collide with a shorter render that shares a prefix.

**Each tier-3 spec asserts its own COVERAGE.** `expectRecordedRows` guards only
a RECORD run, so without a second guard nothing checks that the rows are
consulted on a normal run, and a deleted `freeze` call site would leave its row
un-consulted while every gate stayed green - measured: 37 other tests stay
GREEN, and only the coverage guard fires. `frozenTable.ts` tracks the distinct
rows each run looks up, and the spec asserts BOTH that count and the table's.
The two fail on opposite mistakes: the table count catches a re-record that
wrote a different surface, the consulted count catches a call site that stopped
asking. A literal compared only against the file would move with neither. The
row-count guard has also fired for real - a first record run declared 73 and
recorded 60, and `flushRecording` DROPPED the section rather than committing a
short table.

**One test is deliberately NOT frozen**: `refuses the engine for a spawn list
longer than the ABI cap`. Both its arms are the TypeScript renderer, which is
its whole claim, so a frozen row would capture a picture the engine can never
reproduce.

**Parity sweeps must use NON-binary origins and steps**, or they agree by
construction. `test/wasmNauvisParity.spec.ts` freezes 2,365 of 2,420 positions
off the f32 grid, with two tier-3-shaped windows asserted at 0 as the control.
Planting a coordinate narrowing in `hills_offset_raw_x` leaves tier 1 green and
turns tier 2 red.

**An anti-vacuity assertion is not optional.** "Nothing diverges" is exactly what
a sweep evaluating nothing reports. Every parity spec also asserts that its two
windows differ from each other on every field, and that each places every tile.

**Every guard in this port was proven by PLANTING a break and watching it go
red, never by predicting it would.** The individual break tables are in the
history doc. Three of them are worth knowing because the outcome was surprising,
and each has its own rule below: a unit-norm check passing a bearing swap, a
halo one tile wider passing every value check, and a deleted `freeze` call site
leaving 37 tests green.

### Two noise paths: point and chunk grid (#451)

**The game evaluates noise two ways, and the port now has both.** Every
point fixture (`calculate_tile_properties`) reaches the game's POINT
`basis_noise` kernel. Map generation, and so the game's own preview, evaluates
32x32 chunks through a CHUNK-GRID kernel for every op whose `x` and `y` are
the raw coordinates. The two are different functions of the same algebra; see
`docs/noise/basis-noise-NOTES.md`, "The chunk-grid kernel".

- **`crate::at::At` says which.** `At::Point` is the point path, `At::Grid` the
  grid path: a chunk origin plus a column and row, built with `At::tile(x, y)`.
  The chunk is part of the position because a `multisample` reads one column
  past it from the SAME chunk's 33x33 program (`At::shifted`) - Vulcanus's
  basalt-lakes min filter. Each noise wrapper has an `eval_at` (`Prepared::eval_at`,
  `quick_multioctave_noise::sum_octaves_at`,
  `variable_persistence_multioctave_noise::eval_at`,
  `eval::primitives::basis_noise_expr_at`), and each existing `eval(x, y)` is
  `eval_at(At::point(x, y))`, so every point-path caller and fixture is unchanged.
- **Which kernel applies cannot be read off a coordinate's value**, so an
  expression that warps a coordinate builds an `At::Point` for that call
  whatever it was handed. `nauvis_hills_offset` is the one case in the Nauvis
  tree.
- **All three terrain sweeps pass `At::Grid`**, and only at exactly one tile
  per pixel on whole-tile coordinates (`terrain_at` in
  `crates/fmw-wasm/src/render.rs`). Traced previews showed that case is grid
  for every tile-stage op on the raw coordinates. Every other zoom and every
  overlay is still the point path; the grid at other zooms is unmeasured.
- **Warped coordinates stay points, on every planet.** Nauvis's
  `nauvis_hills_offset`; Fulgora's `fulgora_basis` (at `fulgora_wx`),
  `fulgora_basis_oil` and the road subnoise, which the traced Fulgora preview
  sends to the point kernel as 1,024-point lists. Vulcanus's warped
  coordinates feed only `spot_noise` and `voronoi_cell_id`, which are not
  basis ops.
- **The counts it moved:** Nauvis 8 -> 1, Vulcanus 7 -> 1 and Fulgora 22 -> 20
  differing pixels against the game's preview.
- **Tier 1 grades each op's grid path** against gdb captures of the game's own
  kernel calls: `oracle-basis-grid`, `oracle-multioctave-grid` and
  `oracle-quick-vp-grid`. Tier 2 is untouched, because it runs the point path.

### Reading a frozen count

**Score by exact f32 match count and freeze the number.** If one moves later:
read it, do not adjust it. Up is worth taking; down is a regression. Measure the
expected count on the TypeScript side first, so the number comes from the
reference rather than from the port being written.

Four things flatter or depress a count, and each is a reading rather than a
result:

- **A clamp flatters it**, because a saturated position is exact for free.
  Vulcanus's three clamped biomes score 403, 402 and 408 of 434 against
  unclamped sources at 128, 107 and 127. Read `*_biome_full` as the port's score
  and `*_biome` as what the consumer needs.
- **A discrete output scores high.** `mountain_volcano_spots` is 359 of 434
  because it is dominated by which candidate survives, and a sub-ULP error
  almost never changes that. `voronoi_cell_id` has the same property.
- **Depth looked like the cause and was not.** Nauvis `temperature` was
  bit-exact while `elevation_nauvis` sat at 8 of 26, and this bullet used to
  put that down to depth. #452 refuted it: the noise ops were exact all along,
  and the residual was the f64 arithmetic joining them. Rounded to f32 at every
  step (`eval::math::f32r`), with `offset_x = 10000 / 1.5` rounded before it
  meets a coordinate, `aux`, `moisture`, `elevation_lakes` and
  `elevation_nauvis` all reach 26 of 26. A deep tree scores low when its
  glue is f64, so look there before blaming depth.
- **A small residual is not a high count.** `detailNoise` once had the smallest
  residual of its three sibling fields and the fewest exact matches, 1 of 38.
  That one number is the whole argument for counting matches instead of bounding
  error.

### When the exact-match count degenerates - the resource layer

**On `resources/` the exact f32 match count is 0 and grades nothing.** It is
0 of 16,420 on `oracle-resource-regular` and 0 of 14,980 on
`oracle-resource-starting`, snapped or not, because the fields run to ~12,300
in magnitude and the port sits a systematic ~0.61 from the game - about 600 f32
ULPs. The count is 0 whatever the port does. It is still asserted at 0, so that
fixing #261 turns it into a red test rather than a silent improvement.

**A frozen worst-absolute residual does not cover the gap on its own.** Of nine
breaks planted in the TypeScript, two real ones moved it in 0 of 8 cases -
dropping the `f32()` on `3 * quantity` in the cone, and pre-narrowing `Math.PI`
there. Both change values; the 0.61 offset swamps them. That is the class of
#273 and #309. (Five further candidates that looked like breaks are genuine
no-ops; the full table is in the history doc.)

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

**2.1.14 through 2.1.17 are ONE oracle** for map-gen, because the data Lua is
byte-identical across them - 2.1.17's whole diff against 2.1.16 is four
`info.json` bumps, the changelog and `elevated-rail-pictures.lua`, none of it
map-gen. So `refs:sync --fixtures` overstates staleness by four versions, and a
fixture captured at any of them is comparable with one captured at any other.
`oracle-slider-to-linear.seed123456.json` is the first captured at 2.1.17.

### The findings this port produced, and how they were settled

The port found real defects in shipped TypeScript. **None was fixed inside the
port.** Each got an issue and landed as its own graded change, because a
unilateral fix on the Rust side reads as a port bug in tier 2, which is the
whole point of having tier 2. The precision findings are all landed: #269, #270,
#273, #279, #290, #293, #309.

**#320 and #324 are both LANDED, and nothing is left open.** The Rust reproduced
#320 on purpose while there was a TypeScript arm for it to agree with; #380
deleted that arm, which left the pinned zero agreeing with nothing. Each fix
went in as its own graded change:

- **#320 - `waterLevel` never reached the Nauvis tile argmax. FIXED.**
  `render_nauvis` handed `nauvis_ctx` a hard-coded 0, so the `terrain` view,
  the terrain base of `all`, and the trees, resources, rocks and enemies
  overlays all resolved at `water_level = 0` however the slider was set, while
  `elevation` and `cliffs` honoured it. It reads `p.water_level` now and the
  parameter is gone, so no Nauvis lever sits outside the shared wiring.
  **#326 is the CLOSED duplicate**, `NOT_PLANNED` on 2026-08-26 with its
  measurements moved onto #320.

  Two things about the grading are worth copying. **The fix moved exactly one
  frozen row of 73** - `waterLevel | lever` - because every other tier-3 row
  is captured at the default controls, where `waterLevel` IS 0, so reading 0
  and pinning 0 produce identical bytes. A table can be blind to a defect it
  covers in every other respect. And **the window is the whole difficulty**:
  at +/-280 tiles the lever moves nothing at all, so the two new rows sweep
  +/-3000, where 1,731 of 3,600 pixels move (48.1%, arriving independently at
  the 47.5% of tiles #320 measured). The near-spawn case is asserted rather
  than avoided, so a sweep cannot quietly drift back onto a dead window.
- **#324 - BOTH `slider_to_linear` forms were wrong, not one. FIXED.** The
  issue framed it as a duplicated function where one copy was right.
  `scripts/probes/cliff-slider-to-linear` asked the game over 3 ranges x 13
  sliders and refuted both:

  | candidate | (-1,1) | (-1.7,1.7) | (-50,50) | total |
  | --- | ---: | ---: | ---: | ---: |
  | per-op f32 **+ bounds narrowed** | 13/13 | **13/13** | 13/13 | **39/39** |
  | per-op f32, what `eval/math.ts` shipped | 13/13 | 5/13 | 13/13 | 31/39 |
  | f64 rounded once | 7/13 | 8/13 | 6/13 | 21/39 |
  | plain f64, what `cliffCatalog.ts` shipped | 2/13 | 1/13 | 2/13 | 5/39 |

  The f64 copy **fails a control**: at `s = 6` the ratio is exactly 1, so every
  implementation must return `hi` whatever `log2(6)` is, and it returns `1.7`
  where the game returns `f32(1.7)`. The per-operation form narrowed every
  operation but not the **bounds**. Both duplicate copies are deleted; the
  cliff lever calls `eval::math::slider_to_linear`.

  **Why a year of evidence could not see it.** `(-1.7, 1.7)` is the only range
  in all of `factorio-data` whose bounds are not exactly representable in f32.
  Every other use is `(-1, 1)`, `(-0.5, 0.5)` or `(-50, 50)`, where narrowing
  the bounds is a no-op - and `fulgora_grid`'s `(-50, 50)` is what the original
  5/5 validation used. The measurement was sound and its input class could not
  discriminate the hypothesis. This is #320's lesson in another costume:
  ask which INPUT the evidence holds constant, not just how much evidence there
  is.

  **It moved exactly one frozen row**, `slider linear [-1.7, 1.7] |
  checksum_slider`, which is the correct signature. No cliff fixture moved, and
  that is asserted rather than hoped:
  `the_lever_is_zero_at_the_default_controls_and_live_off_them` pins both the
  default 0 and the lever being live off the default, so the test cannot pass
  by the lever having been wired to a constant.

  Probe design worth copying: pass the slider as `x` so the capture POSITIONS
  are the slider positions, and select the range with `y` as a mask-sum
  (`0 * finite` is exactly 0 and `0 + w` is exactly `w`, so the selection adds
  no rounding). Keep the bounds LITERAL - computing `-1.7` as `-1 - 0.7` rounds
  the bound and contaminates the measurement.

  **Where it is graded now.** The 39-cell game comparison, with the two
  rejected forms as controls, is `reproduces_the_games_slider_to_linear_at_all_39_points`
  and its companion in `crates/fmw-noise/src/fixtures.rs`. The TypeScript copy
  of `slider_to_linear` and its spec (`test/sliderToLinearOracle.spec.ts`) were
  deleted once nothing shipped called them; a test-local copy in
  `test/dslMathOracle.ts` remains only as the TypeScript side of the 600-point
  fold in `test/wasmEvalParity.spec.ts`.

  It also corrected a comment that appeared in both `eval/math.rs` and
  `eval/math.ts`: `slider_to_linear` does NOT "resolve on the prototype side -
  Lua, not the noise VM". It is declared `type = "noise-function"`, so it is
  inlined into its callers and evaluated by the machine. The conclusion that
  comment supported - exact `log2`, not `fast_approx` - survives and is better
  supported now, because the probe passes a position variable that cannot be
  constant-folded.

Five rules came out of the sweep work, and they are the transferable part:

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
  the evidence for months: the narrowed form scores 101/101, the un-narrowed one
  81/101. **A "no fixture can grade this" claim is only about the fixtures you
  looked at.**
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

### Two open threads

**#191's issue text is stale - read the code, not the issue.**
`quickMultioctaveNoise` already narrows both coordinates.
`variablePersistenceMultioctaveNoise` narrowed `x` and not `y` in **both**
ports, which is why tier 2 could not see it, and both now narrow it. The third
op, `basisNoise` itself, was deliberately NOT changed: its disciplined callers
all narrow before calling. No committed fixture discriminates it.

**#279's 12 candidates are still unapplied, and its prediction about them is NOT
confirmed.** It expected `moats`, `vaultSpots` and `spotsPrebanding` to reach
101/101 once the cones moved; measured, they reach 69, 69 and 98. They improved
and did not close, so each still has to be applied and re-scored one at a time.

- **#407 - the Vulcanus cliff collision test was the PREVIEW path's, not the
  placement path's. FIXED (2026-09-08).** `#90` disassembled `tryToAddCliff`,
  which discards `rotbb`'s `1/8` tag and scans the raw rectangle; the path
  that places cliffs, `EntityMapGenerationTask::applyCliffs`, hands
  `Surface::wouldCollide` the box WITH its orientation word, widens it with
  `getAABB`, and runs `BoundingBox::collide` - an oriented separating-axis
  test - per blocking tile. Found by reading the call out of the running game
  with lldb (#406): `test/fixtures/oracle-vulcanus-wouldcollide` holds all
  2157 calls, and `cliffs/collision.rs` reproduces the tile verdict on every
  one. The same calls showed the loader TRUNCATES `rotbb`'s doubles where the
  catalog rounded (15 of 16 corner boxes one unit off), and that the game
  tests the RAW queued orientation where the apply pass read the cascaded one.

  Three lessons. **A disassembly of the wrong path is exact and wrong**: #90's
  three steps were all correct about `tryToAddCliff`, and the model they
  produced scored WORSE than the 45-degree fit #88 had reached and #90
  rejected as "empirical" - the right shape lost to the wrong evidence. **Grade
  the predicate, not its survivors**: every earlier fixture recorded which
  cliffs stood after the test, and a two-sided error set against those read as
  two defects; one boolean per call read as one. And **the first lldb run
  wrote zero events and looked like a quiet map** - a bare-address breakpoint
  set before launch never resolves - so the probe now asserts every hit count.

  The shipping crossing-stage arm moved 1504/21/22/6 -> **1521/10/16/0** on
  the 1531 game cliffs, region `[0,0]` is exact on position AND orientation
  (283 of 283), and every remaining disagreement is a cell the game's own test
  passed and something later destroyed.

- **#414 - the ore -> cliff removal geometry is the CLIFF's oriented box
  against the resource's tile-widened box. LANDED (2026-09-13).** Read off
  `ResourceEntity::postSetup` in #415 and graded on the game's own entities
  (apply stage 85 -> 44 errors), then put into `VulcanusOreRejection`. Three
  things the port change measured that the reading could not, all in
  `docs/noise/vulcanus-cliffs-NOTES.md` (2026-09-13):

  - **The port's ore field is one ring fatter than the game's entities**, and
    it is a roll: `random_penalty_between(0.9, 1, 1)` per tile, taken as 1 by
    the port. At the overlay's threshold the field misses none of the game's
    1,190 calcite tiles and adds 83; at the roll's floor it adds none and
    misses 226. The removal reads the field at the roll's midpoint
    (`ORE_REMOVAL_REGION_THRESHOLD`), the overlay keeps painting at the top,
    and the two consumers of one field now differ on purpose - the catalog's
    comment says why. On the port's own path the geometry alone was worse by
    count (95 -> 97 errors on the two graded regions); with the midpoint it is
    95 -> 89. (Superseded 2026-09-26: the next entry reproduces the roll, and
    the midpoint is gone.)
  - **The live-orientation removal phase is refuted.** The engine runs the
    removal after `applyCliffs`, on the cliff's live box; a harness phase that
    does the same scores worse than reading the queued orientation
    (1633/18/27/5 against 1634/17/22/5), because the four cells it was meant
    to keep are trimmed later still, and it spares five the game removed. The
    game's answer depends on chunk generation order. The phase stays as a
    control.
  - **The port's own geyser roll is refuted as a removal source**:
    1591/35/38/30 at the crossing stage - half the surplus, more than twice
    the missing - because the roll's positions are not the game's.

  Eight fixture tests, two tier-3 render rows and two tier-3 counts moved,
  and each was re-frozen with the reading beside it; the shape of every claim
  held. It is not free: the cliff view renders 3-20% slower and the `all`
  composite 2-3%, and the crate's tests take 15% longer clean and 21% longer
  under poison, all timed against `main` in turn.

- **#84 - the solid-ore roll is REPRODUCED, and the ring is gone
  (2026-09-26).** `random_penalty_between(0.9, 1, 1)`'s batch is the tile's
  chunk, row-major, seeded from the chunk corner at integer coordinates.
  `VulcanusOreRoll` reads it, and both the ore overlay and the cliff removal
  read the one rolled footprint, so `ORE_REMOVAL_REGION_THRESHOLD` is deleted
  and the two consumers agree again. Graded in
  `the_vulcanus_ore_roll_is_the_chunk_batch` against every solid-ore entity in
  four regions (three default at 2.1.12, one at volcanism frequency 0.5 at
  2.1.17): 7,096 of 7,096 placed, 2 extra, both in the band where the
  probability is between 0 and 1. Two traps it measured:

  - **Only the batch's FIRST position matters.** The source is constant, so
    it seeds the stream and nothing else does; a planted x/y swap of the
    batch positions leaves every test green. Row-major lives in the index the
    roll is read at, and swapping that turns the test red with exactly its
    column-major control's numbers.
  - **A half-tile control cannot fail at `x, y >= 0`.** The seed truncates
    toward zero, so the tile-centre batch equals the integer one in both
    non-negative regions and loses only where a coordinate is negative.

  What it is worth: the overlay stops painting 810 tiles the game leaves
  bare. The cliff removal gains little - 89 -> 86 errors on the two graded
  regions at the crossing stage, 221 -> 206 over the sixteen out-of-sample
  ones - because the rest of its ore error is the sulfuric-acid geyser.
  Seeding the geyser's roll as the game seeds `generateEntities` (salt 0),
  with or without the solid ores competing for the tile, places 0 to 1 of
  the game's 44 geysers, so that stream is still unknown.

  **Probable cause, found 2026-10-31 on Aquilo (#492), not tested on
  Vulcanus.** The game runs one stream per chunk shared by every autoplace
  group in `order`, and the geyser (`c`) is the last group. Its draws start
  after every earlier group's - rocks, the three solid ores - and every tile
  an earlier group can stand on spends a draw even at probability 0. A stream
  that starts at the chunk's first draw cannot line up with it. See
  `docs/noise/entity-generation-NOTES.md`.

  It is close to free. Timed against `main` in turn, all 27 view and window
  pairs came in between 0.99x and 1.02x, each within a 3% spread.

### No open findings, and do not "fix" the next one inside the port

`variable_persistence_multioctave_noise` takes its `persistence` operand as
**f64**, matching the TypeScript. `oracle-variable-persistence-multioctave`
cannot grade the width - all 38 of its persistence values are already f32 - but
`oracle-multioctave-wrappers`'s amplitude-corrected cases can, because they pass
the program constant `0.7` straight in: **f64 scores 81/152, f32 scores
89/152**.

**The worse-scoring f64 form is what ships.** 89 is an improvement rather than a
full exact count, so the greedy-accept rule rejects it, and adopting it would
put a divergence into every Nauvis elevation value with nothing to grade it.
Neither form is the game's. Posted to #254 as one term worth 8 points, with 63
still unexplained.

**The rest was found on 2026-10-23, porting Aquilo.** The f32 persistence and
the `output_scale` transform folded in f32, in the Lua's order, together score
**152/152** (the f64 transform with the f32 persistence scores 122). That form
is `AmplitudeCorrectedGame`, graded by
`the_games_amplitude_corrected_form_reproduces_the_wrapper_fixture_exactly`,
and Aquilo's `random_island_peaks` uses it. Nauvis still reads the shipped
form, so its counts did not move; moving it is its own graded change (#254).

Two harness compensations went with that work, and both are worth copying.
`checksum_variable_persistence` crossed the ABI as an f32, so the spec narrowed
its own value with `Math.fround` first - making the two sides agree by
construction on exactly the term that differed. Both are f64 now. And
`p ** octaves` is **`powf`, not `powi`**: `powi` disagrees with V8 by one ULP at
0.7^4, 0.7^6 and 0.7^8, and one ULP there flips the f32 rounding of the octave
gain, which moves every point in the case.

### Gleba (#454), slice 1: terrain fields and tiles at tier 1

`expressions/gleba_terrain.rs`, `gleba_starting.rs`, `gleba_stack.rs` and
`tiles/gleba_catalog.rs` hold the four property fields (`gleba_elevation`,
`gleba_aux`, `gleba_moisture`, `gleba_temperature`) and the 41 tile
probabilities. `eval::math::terrace` is the new op, decoded from
`NoiseOperations::Terrace::run`. Graded against
`oracle-gleba-fields.seed123456.json` (surface seed FORCED to 123456):
every field and every tile column is 1,024 of 1,024, and the winner matches the
game's strict argmax at all 957 positions that have one.

What a reader needs that the code comments do not say:

- **The fixture cannot grade the tile tie-break.** 67 of its 1,024 positions have
  a tied top score, all between variants of one family (`lowland-olive-blubber`
  and its `-2` and `-3`, `wetland-green-slime` and `-light-`, and so on). The
  game keeps the first of its own candidate list at a tie
  (`generateBasicTiles` uses a strict `>` from `-inf`). Slice 2 settled the
  order from data: name byte order (`TIE_ORDER`), see below.
- **`y_distortion` is `gleba_wobble_x * 15` at every starting cone**, not
  `gleba_wobble_y`. It is the game's own typo and it is kept (see
  `expressions/gleba_starting.rs`).
- **Planted breaks the grade sees** (columns that fall below 1,024): `terrace` as
  the identity (elevation 834), `gleba_select`'s constant folded in f64 (aux
  1,014), no distortion on the cones (yumako soil 918), no fertile spot field
  (yumako soil 563), libm `sin` in the spiral bridges (elevation 1,023, four
  columns). The strict `<` in `terrace` at `frac == strength` is not reached by
  the fixture and is pinned by a unit test.
- **Only the point kernel is graded.** Every position is a
  `calculate_tile_properties` read. The raw-coordinate multioctaves follow the
  `At` they are given, so the chunk-grid path is available to a render but
  ungraded.
- **Only default levers are graded.** The water frequency and size and the plants
  frequency are wired through `GlebaControls` and untested away from 1.

### Gleba (#454), slice 2: the terrain view, graded against a real surface

The terrain view renders through the engine, and at one tile per pixel it
matches `get_tile` on a REAL Gleba surface at every one of 65,536 tiles. Eric
chose the real surface over the preview PNG as the target on 2026-11-26: the
preview skips a pass a real map runs, so matching it would mean matching a
picture no player sees.

**The ABI block.** `PLANET_GLEBA = 4`, a 24-byte block (`gleba_water`
frequency and size, `gleba_plants` frequency), so a request was 80 bytes.
Slice 3 appended the `gleba_stone` control's frequency, size and richness, so
the block is 48 bytes and a request 104; the first three did not move.
`writeGlebaParams` is the one place an absent lever becomes 1. **No trig
crosses the boundary**, which is a deliberate exception to "trig crosses as
values": Gleba's spiral bridges take a sine per POSITION, so the module
computes every sine with the game's own polynomial (`vm_sin`, #531). That
polynomial is plain f64 arithmetic with no libm, so it gives the same bits in
V8, in WASM and natively; the starting cones use it too.

**Three steps took the render from 2,470 wrong tiles to 0** (by name, 256 x 256
window around spawn, map seed 123456, derived surface seed 3215206427):

| step | tiles wrong (by name) | pixels wrong (map colour) |
| --- | ---: | ---: |
| raw argmax, listing-order ties (row-by-row capture) | 2,470 | 1,499 |
| ties to the name that sorts first | 1,680 | 698 |
| same, against the radius capture | 1,682 | 697 |
| tile correction ported | **0** | **0** |

- **Ties: name byte order** (`TIE_ORDER` in `tiles/gleba_catalog.rs`). Against
  the game's own terrain preview PNG, which shows the raw argmax, the listing
  order differed at 831 pixels of the 256 window and 20,535 of the full 1024,
  every one a tie; name order differs at 0 of 1,048,576. The comparator in
  `CompiledMapGenSettings::compile` was not decoded, so the rule is inferred.
  The tie-break agent's real-surface reading agrees (94.9% of 7,209 tied cells,
  the rest near correction).
- **Tile correction** (`tiles/correction.rs`, and
  `docs/noise/tile-correction-NOTES.md` for how it was read). The 697 pixels the
  raw argmax still had wrong were exactly the pixels where the preview PNG and
  the real surface disagree, so all of them were this pass.
- **The chunk order matters, and is part of the port.** Correction writes into
  neighbouring chunks, so the order chunks are corrected in changes the map:
  requesting the same chunks one by one in reverse moved 450 tiles. One radius
  request, the way a game start makes its spawn area, corrects in columns order
  (x outer, y inner), and the port does the same. It matches the radius capture
  and a chunk-by-chunk columns capture at every tile; a row-by-row capture is 16
  tiles off, because that request does not correct in plain row order and its
  real order was not decoded. A player who explores in another order can get a
  slightly different map, which no preview can know.
- **The margin.** Each render corrects the chunks its pixels touch plus one
  chunk on each side (`CORRECTION_MARGIN_CHUNKS`), reading raw tiles one chunk
  further. With no margin, 33 tiles of the window are wrong; one and two give
  the same 0. A tiled render (100-pixel tiles, not chunk aligned) stitches to
  the whole render byte for byte, because every tile corrects the same chunks
  in the same global order around itself.
- **Only at one tile per pixel on a whole-tile origin.** Correction is defined
  on tiles. At any other zoom a pixel is the raw argmax at a point, which is
  what the game's preview draws.

**What it costs.** A 256 x 256 Gleba render takes about 380 ms in WASM against
150 ms for the raw argmax (2 tiles per pixel) and 63 ms for an Aquilo terrain
render, measured once on hammond under load from other sessions. The extra is
the raw tiles of the margin and about 1.7 ms of correction per chunk.

**Tier 3** is `test/wasmGlebaRenderParity.spec.ts`: 0 pixels against both
real-surface captures, the preview PNG differing from the render exactly where
it differs from the real surface (697 in the window, 9,736 of the full 1024),
the seed trap, the plants lever (8,544), and the tiling check. Tier 1 grades the
same windows by tile name in `fixtures.rs` (`gleba_raw_tiles_against_the_real_surface`,
`gleba_corrected_tiles_against_the_real_surface`,
`gleba_corrected_tiles_against_a_columns_request`).

**Planted breaks, each turning a frozen count red:** listing-order ties (real
surface 698 to 1,499 before correction; preview 0 to 20,535); counting the
candidate's id in `countFixedNeighborsOfKind` (0 to 840 tiles); writing back
every second-pass change (0 to 2 on each capture); rows order (0 to 44);
skipping correction in the render (5 of 8 tier-3 tests red, 697 pixels).

**In the app** Gleba is `devOnly` in `PLANET_CAPABILITIES`: with dev mode off
the panel still says "Client preview is not available for Gleba yet." Slice 3
below adds stone and the stromatolites to the `resources` and `all` views.

### Gleba (#454), slice 3: stone and the stromatolites, against a real surface

The `resources` and `all` views draw every `stone`, `iron-stromatolite` and
`copper-stromatolite` a REAL Gleba surface places, at one tile per pixel. Over
the 1024 x 1024 window -512..511 at map seed 123456 the engine places all
5,193 of them at the game's own position, to the 1/256 tile, and nothing
else, on its own corrected tiles. That is the real surface, not the game's
preview. The preview skips the apply step (measured on Aquilo, #492), and
without that step the generator's queues for this window hold 8,631.

**Why this slice first.** The research census (`gleba.local/`, 1024 window)
counts about 30,000 plants, 4,330 stromatolites, 863 stone, 2,484 cliffs and
67 nests. Plants are the most visible, but the game's own data put the
stromatolites first: they have the empty autoplace `order`, so they are the
FIRST group each chunk's random stream serves, and nothing another group
draws can move them. Stone is next in value and needs no stream at all (see
below). Plants come after the stromatolites in the stream and need
`tile_restriction`, which the generator does not have yet. So this slice is
exact without porting anything else, and the plants can build on it.

**The fixtures** are `oracle-gleba-real-surface-entities.seed123456.json`
(plants, nests and cliffs off, so nothing else can take a graded entity's
place) and `...-entities-default.seed123456.json` (every control at its
default), from `scripts/probes/gleba-entities`. The graded fixture also holds
every autoplacer's facts and every tile's collision layers as the prototypes
report them at runtime, and eleven fields at 2,560 positions.

**Credit.** FactMapGen (`M45-Science/FactMapGen`, Go, AGPL-3.0, which credits
this repo) draws Gleba's stone and stromatolites to match the game's preview.
Its `factorio_gleba_features.go` and `factorio_gleba_placement.go` were read
alongside the Lua for the two stromatolite expressions, the
`gleba_simple_spot` call with `skip_offset = 1`, and the stromatolites sharing
one group ahead of the plants. Each rule here was then graded against the
game. Its preview rule (no apply step) is what this slice does NOT copy.

**What a real surface does, and the port with it** (`placement/gleba.rs`,
`expressions/gleba_resources.rs`):

- **The fields.** `gleba_select(gleba_<metal>_stromatolite -
  clamp(gleba_decorative_knockout, 0, 1), 1.3, 2, 0.2, 0, 1)` for each
  stromatolite, and `4000 * max(starting, gleba_simple_spot(...) *
  max(gleba_highland, gleba_midland_aux_2)) * richness / size` for stone, f32
  per step. All eleven match `calculate_tile_properties` at 2,560 of 2,560
  positions (`gleba_resource_fields_match_the_game`).
- **`skip_offset = 1`.** `gleba_simple_spot` drops the first accepted spot of
  each region. `select_spots` kept nothing at an offset at or past the span
  (#489); it now keeps `j >= offset && (j - offset) % span == 0`, which is the
  same set below the span, so no other planet's output moves.
- **The groups.** Sorted by (`order`, name): copper and iron stromatolites
  share `""`, then the twelve plants, then `stone` (`b`), then the nests. The
  two stromatolites are ONE group, so each tile goes to the higher
  probability and draws once. `generate_chunk` refused a group of two; it now
  ports the richness tie-break (cpp:394). The facts test
  (`gleba_autoplacer_facts_match_the_game`) checks the sort, every box, flag
  and layer, and all 41 tiles' layers against the prototypes.
- **Stone needs no stream.** Its probability is exactly 0 or 1, and a roll
  places when `p > U` with `U` in `[0, 1)`. So it places on exactly the tiles
  where its probability is 1, wherever its draws land. The port runs it
  straight after the stromatolites and cannot be told apart from the game.
- **Masks.** Stromatolites stand only on wetland (their mask holds
  `ground_tile`, which every land tile has, and `player`, which the deep lake
  has); stone only on land (`resource`, which wetland and the lake carry).
  So the stream reads the corrected tiles, and the raw argmax is not good
  enough: on it the whole window matched 3,546 of 5,193.
- **Apply.** Each chunk's queue in order, chunks row-major, dropping an entity
  whose box meets (touching included) one already placed on a shared layer.
  Stromatolites block stromatolites; stone blocks stone; the two never share
  a layer. Columns order gave the same 5,193, so this capture does not tell
  the two orders apart; rows is what Aquilo measured.
- **The render** (`render_gleba_entities`) generates the window's chunks plus
  one ring, on the corrected tiles of all of them, and paints each entity
  over the tiles `floor(left)` to `ceil(right) - 1` in its map colour:
  (129, 105, 78) for both stromatolites, as in the Lua, so a map cannot tell
  iron from copper, and (175, 155, 108) for stone, as the preview PNG draws
  it. At any other zoom, or a fractional origin, no entity is drawn, because
  the entities depend on the corrected tiles.

**Grades.**

| test | what | frozen |
| --- | --- | --- |
| `gleba_resource_fields_match_the_game` | 11 fields, 2,560 positions, f32 bits | 2,560 each |
| `gleba_entities_replay_the_real_surface` | two dense 128 windows, by position | 209 of 209, 158 of 158 |
| `gleba_entity_replay_controls` | strict overlap / preview / raw tiles | (207, 214) (209, 279) (168, 214); (156, 161) (158, 208) (116, 154) |
| `test/wasmGlebaEntityParity.spec.ts` | the 1024 window through the module, pixel by pixel | 0 of 1,048,576 |
| same | against the default map | 1 pixel |
| same | stone control at size 0 | 863 pixels, no stone left |

The debug-build Rust tests replay two 128-tile windows (one iron and stone,
one copper and stone) because the whole window takes about 9 seconds even in
release. The spec grades the whole window through the release module: it
paints the game's entities onto OUR terrain render by the same footprint rule
and compares every pixel, so a differing pixel is a misplaced, missing or
extra entity. The terrain stays 0 in `wasmGlebaRenderParity.spec.ts`.

**The remainder against the map a player gets: 1 of 5,193.** The default map
lacks one copper stromatolite at (134.5, -479.625). Its box reaches y =
-480.125, past the chunk edge at -480, where a water-cane at (134.375,
-480.125) stands; the water-cane is in the chunk above, which is applied
first. Plants are not ported, so the render shows that stromatolite. Its
footprint is two pixels and a neighbour covers one, so the spec freezes 1.

**Planted breaks, each run:**

| break | what went red |
| --- | --- |
| the old skip filter `j % span == offset` | stone richness 1,577 of 2,560, probability 2,046; the replay loses every stone (71 of 209, 52 of 158) |
| the two stromatolites as two groups | iron window 140 matched of 206 placed (copper sorts first, so its window holds) |
| probabilities read at the tile centre | 128 of 203, 105 of 164 |
| the preview's rule (no apply) in the render | 2,037 pixels |
| raw tiles in the entity pass | 3,552 pixels |
| no chunk ring in the render | 5 pixels, all at the window's edge |

Two swaps changed nothing in the two replay windows, so neither rule is
graded there: the two stromatolites' order inside their group (no tile there
has both at the same positive probability), and the point kernel at the
integer corner instead of the chunk grid (no roll there falls between the
two). The facts test pins the first from the prototypes. Neither was tried
on the whole window.

**What it costs** (the app's default view, 1024 x 1024 at one tile per pixel,
map seed 123456, WASM under Node, the 64 tiles of 128 summed on one thread,
median of 7 interleaved runs on hammond, other sessions running):

| module | `terrain` | `all` | ratio |
| --- | ---: | ---: | ---: |
| first wiring | 6,653 ms | 17,242 ms | 2.6x |
| shipped (kept fields) | 6,906 ms | 13,200 ms | 1.9x |

The shipped module keeps the five terrain values the resource fields read
(`KeptInputs`, about 40 KB a chunk, for up to 100 chunks, enough for a 256-pixel tile and its ring) as tile correction
evaluates them, so the entity pass does not evaluate the terrain a second
time. Its output equals the first wiring's byte for byte over 77 requests
(every view, the 64 app tiles, whole 1024 windows, chunk-aligned and not, 2
tiles per pixel, a fractional origin, moved stone levers). What is left is the
ring: a 128-pixel tile corrects 8 x 8 chunks instead of 6 x 6 and generates 6
x 6 chunks of entities, and every one of those is needed (see
`GLEBA_ENTITY_RING_CHUNKS`). The browser with its worker pool was not
measured.

**What is not drawn yet:** plants, cliffs and pentapod nests. The views that
would show them (`trees`, `cliffs`, `enemies`, `rocks`) fall back to the
terrain. Plants are the next slice: they are the next groups in the stream,
and the yumako tree and jellystem need `tile_restriction`.

### Nauvis: the terrain graded against a real surface (2026-11-26)

Nauvis follows Gleba: at one tile per pixel on a whole-tile origin the render
is the raw argmax plus tile correction, and it matches `get_tile` on a real
surface. At any other zoom it is still the raw argmax at a point, as the game's
preview draws it. The wiring is `tiles/nauvis_correction.rs` and a short branch in
`render_nauvis`; the layers come from the game (`NauvisTile::layer`).

**The fixtures** come from `scripts/probes/gleba-real-surface`, which now takes
`FMW_PLANET`, `FMW_X0`, `FMW_Y0` and `FMW_SIDE`. Nauvis needs a FRESH surface
with the `nauvis` surface's settings and seed 123456: the game's own `nauvis`
surface generates its spawn chunks before `on_init`, so the disabled controls
never reach them. Two 256 x 256 windows, each from one radius request:

| window | raw argmax vs real (by name = by colour) | corrected | corrected, every pair allowed |
| --- | ---: | ---: | ---: |
| spawn, -128..127 | 89 | **0** | 0 |
| coast, x 384..639, y -320..-65 | 326 | **0** | 73 |
| whole preview, -512..511 (scratch capture, not committed) | 2,810 | **0** | 59 |

- **`allowed_neighbors` is part of the port now.** `deepwater` allows only
  `water`, and the game makes the table symmetric, so no land tile may touch it.
  Correction fails a tile beside a forbidden neighbour at once and replaces it
  with the first step of a path between the two, which is `water`
  (`tiles::correction::Neighbours`; the reading is in
  `docs/noise/tile-correction-NOTES.md`). The spawn window never puts deepwater
  beside land in its raw tiles, so the coast window was chosen to have it, 90
  times.
- **No ties.** Gleba's argmax ties go to the name that sorts first. No position
  of the spawn window and its margin has two Nauvis tiles sharing the top score,
  nor any of five wider windows checked by hand (a 1024 and four 512 windows,
  out to 8,000 tiles), so registration order and name order pick the same tile
  and Nauvis cannot say which rule the game uses. `TILE_ORDER` stays.
- **The margin.** One chunk, as Gleba. The spawn window is exact even with none;
  the 1024 window is 8 tiles off with none, 0 with one or two. 128-pixel worker
  tiles stitch to the whole render byte for byte.
- **Not covered by these windows:** the second pass's shared queue (skipping
  the second pass changes no Nauvis tile here; Gleba's tests catch it), and
  overlays: resources, rocks and enemies still test the RAW tile for their
  water gate (`tile_allowed`), and the tree overlay reads the painted pixel,
  which is now the corrected one at one tile per pixel. The rock pass's
  pre-roll water test reads the corrected tile too, at the rock's own
  position (#566, below).

**Tier 1** is `crates/fmw-noise/src/fixtures/nauvis_real_surface.rs` (by tile
name; the raw, spawn and coast tests are in `POISONED_TESTS`). **Tier 3** is the
real-surface block in `test/wasmNauvisRenderParity.spec.ts`. The preview PNG is
now a reference: the 1024 count moved 0 -> 2,810, exactly the tiles where the
scratch real surface differs from the PNG, and in the spawn window the PNG
differs from the render at the same 89 pixels where it differs from the real
surface. No tier-2 fold moved (they grade fields per position, not the render),
and no frozen `nauvis:render` row moved, because none of them is at one tile
per pixel on a whole-tile origin.

**Planted breaks:** correcting chunks in rows order (spawn 0 -> 2); sand-1's
layer 152 -> 176 (spawn 0 -> 21, and the layer test red); replacing with the
offending tile instead of the replacement (coast 0 -> 8,907); dropping the
forbidden-neighbour check (coast 0 -> 73); poison (all three red).

**Through `correct_window`.** The Nauvis render uses Aquilo's lazy
`correct_window` (raw tiles read only when the pass first needs them, and no
walk from a seed inside a 3 x 3 block of one id) with the deepwater rule passed
in. That changes no tile: the eager pass over a fully filled world gives the
same tiles on both committed windows (asserted) and on the 1024 scratch
surface (measured), and `lazy_and_eager_reads_agree` and
`skipping_uniform_seeds_changes_nothing` now also run with a neighbour rule
(id 1 may touch only id 2) active.

**What it costs.** WASM under Node on hammond with other sessions running,
median of 5 interleaved rounds (each round runs every case on all three
modules in turn):

| render | raw argmax (915d3af) | first wiring, eager (7a38504) | now, lazy |
| --- | ---: | ---: | ---: |
| `all` 1024 x 1024, the app's default view, as 64 worker tiles of 128 summed on one thread | 5,974 ms | 14,237 ms (2.38x) | 9,290 ms (1.56x) |
| terrain, the same 64 worker tiles | 2,445 ms | 10,727 ms (4.39x) | 5,825 ms (2.38x) |
| terrain 256 x 256 at 1 tile per pixel | 154 ms | 394 ms | 254 ms |

Other zooms are not corrected, so they cost what they did. What is left is the
raw tiles of the margin chunks, which correction must read in full: a
128-pixel worker tile corrects 6 x 6 chunks to paint 4 x 4, and the worker
tiles redo each other's margins. Nauvis has less to gain from the uniform skip
than Aquilo's open ocean (the land is a patchwork of 19 tiles), and Aquilo's
third change, keeping the fields for the entity pass, does not transfer: the
Nauvis overlays' water gates evaluate tiles on the point kernel
(`nauvis_tile_at`), not the chunk grid, so they cannot reuse the corrected
pass's raw tiles without changing their output. Sharing raw chunks between
worker tiles would be the next lever.

### Nauvis rocks at worker-tile seams (#566)

The rock pass tests a rock's tile for water before it rolls. It sweeps one
pixel past the worker tile, because a rock there still owes the tile part of
its 3 x 3 mark. The test used to read the painted buffer at
`(py * width + px)`, the way `renderRocks.ts` did, and for `px = -1` that is
the last pixel of the previous row: the far edge of the same tile. So a seam
rock depended on the tile width. On the 1024 `rocks` view, 128-pixel tiles
matched the whole render on 12 of 12 seeds and 256-pixel tiles missed a 3-pixel
rock column on 4 (seeds 123456, 7, 8 and 11).

**The fix reads the terrain at the rock's own world position.** The render
keeps its Nauvis tiles in a grid that covers the sweep halo as well as the
window (`NauvisTerrainGrid` in `crates/fmw-wasm/src/render.rs`), and the
pre-roll test reads that grid. At one tile per pixel the halo tiles come out of
the margin chunks the window's own correction has already corrected
(`nauvis_corrected_tiles_reading_out`), so they cost nothing.

Four ways were built and compared on the 1024 app window, 12 seeds, at 128 and
256 pixel tiles:

| fix | tiled = whole | whole render vs before | cost, `all` at 256 px |
| --- | --- | --- | ---: |
| correct a window widened by the halo | 12 of 12 | same | +16% (`rocks` +27%) |
| read the halo from the margin (shipped) | 12 of 12 | same | about 0 |
| a point outside the tile is not water | 12 of 12 | same | 0 |
| drop the pre-roll test (`tile_allowed` alone) | 12 of 12 | 3 px off at water level 20 | 0 |

- **Why not the widened window.** It is the same answer, and it pulls in a
  whole extra ring of chunks, which spends most of what 256-pixel tiles save.
- **Why not "outside is not water".** It is right only while the whole render's
  answer for that tile is "not water" or `tile_allowed` refuses the rock
  anyway. Nothing makes that so; it happened to hold on 12 seeds.
- **Why not drop the test.** The test is live. At water level 20, seed 123456,
  it refuses a rock at (797..799, 51) on a tile that correction made water,
  which `tile_allowed` (the raw point kernel) cannot see. A real surface places
  entities after correction, so the refusal is the faithful one.
- **How exact the margin read is.** Not by proof, any more than the window's
  own tiles are: both rest on the margin being wide enough. Over the 1024 app
  window at 12 seeds and at water levels 0, 20 and -15, every halo tile matched
  the whole window's tile, at both tile sizes. Without a margin the same reads
  were 14 to 44 tiles off per render.
  `halo_tiles_read_from_the_margin_match_a_window_that_holds_them` keeps a
  coast-window case, with a raw-argmax control that misses 5 halo tiles.

`test/tiledEqualityAppGeometry.spec.ts` renders the app's own geometry (1024
square, one tile per pixel, the spawn at the centre, the `rocks` view) at 128
and 256 pixel tiles on seeds 123456 and 7. Before the fix it failed at 256 on
both, at (255, 417..419) and (512, 1015..1017); after, both pass.

The `all` view also changed in one way the gate cannot see at these seeds: the
pre-roll test used to read the painted buffer AFTER crude oil, whose mark may
spill onto water, so an oil pixel over water read as land. It now reads the
terrain. On seeds 123456, 7, 8 and 11 the `all` whole render did not move.

### Fulgora: the terrain view, graded against a real surface

Fulgora's terrain now matches `get_tile` on a REAL surface at every one of
65,536 tiles at one tile per pixel, the way Gleba's does. It used to match the
game's preview PNG exactly, which is the raw argmax: 1,003 pixels from the real
map in the 256 x 256 window around spawn (map seed 123456, derived surface seed
2967702466).

| step | tiles wrong (by name) | pixels wrong (map colour) |
| --- | ---: | ---: |
| raw argmax, the `-2` ocean tiles told apart | 1,703 | 1,003 |
| tile correction, columns order, window plus one chunk | **0** | **0** |

By name the raw count is larger than by colour because correction also moves
tiles between each oil-ocean tile and its `-2` twin.

- **The `-2` twins are real tiles to correction.** `oil-ocean-shallow-2` and
  `oil-ocean-deep-2` share a map colour with their base tile but not a layer
  (147 against 148, 67 against 66), so a boundary between them is a boundary.
  `FulgoraTile` gained `Shallow2` and `Deep2`; `folded()` maps them back for a
  picture, the land mask and the tier-2 checksum, whose folds did not move.
- **Ties.** The twelve scores are visited in tile-name order (`NAME_ORDER`),
  Gleba's measured rule. There is no exact tie at the maximum anywhere the
  render reads around the window, or on a 16,384-point sweep far from spawn
  (`fulgora_ties_at_the_maximum`), so the order changes no tile here; putting
  the old order back turns nothing red.
- **The order near a request's edge.** The probe's default radius-6 request
  puts its edge two chunks from the window, and that surface differs from
  radius 7, 10 and 18 at 5 tiles, all near that edge. The game queues
  correction tasks through `MapGenerationManager::request`'s 3 x 3
  prerequisite walk (`tiles::correction::requested_correction_order`); that
  order reproduces radius 6, radius 10 and a rows-order request at every tile,
  and it reproduces Gleba's rows capture too. Inside a generated area it gives
  the same tiles as columns order, so the renderer uses columns order and is
  graded against the radius-10 capture. The walk order is a test model only,
  because it depends on an edge no preview can know, and it would make a tiled
  render differ from a whole one (36 tiles at 1024 in 128-pixel tiles).
- **The margin.** No margin leaves 61 tiles wrong; one and two chunks give the
  same 0. A 1024 render cut into the app's 128-pixel tiles stitches to the
  whole render at every tile, and its centre matches the real surface.
- **Not reached.** Scrap placement still tests the raw tile for oil ocean. A
  real surface places scrap after correction, so a corrected tile could move a
  scrap entity; the scrap views are not graded against a real surface.

**What it costs.** The render goes through `correct_window`, which reads raw
tiles lazily and skips walks that cannot change anything (Aquilo's cost fix).
Measured on hammond in Node, serial, median of 7 interleaved runs:

| render | raw argmax | eager correction (559b658) | lazy correction |
| --- | ---: | ---: | ---: |
| 256 x 256 terrain | 170 ms | 418 ms (2.5x) | 301 ms (1.8x) |
| app default: 1024 x 1024 `all`, 128-pixel worker tiles | 4.95 s | 13.76 s (2.8x) | 9.29 s (1.9x) |

The app figure is total worker time; the pool splits it. The lazy render is
byte-identical to the eager one on 24 requests and the whole app default.
What is left is raw tiles: the app reads 2.33 raw tiles per pixel shown, and
2.25 of that is the corrected chunks themselves, which every walk reads. A
128-pixel tile corrects 6 x 6 chunks to show 4 x 4, so only a larger worker
tile would cut it further (256 pixels would make it 1.56). The app renders at
one tile per pixel only, so every user sees the corrected map.

**Tier 3** is `test/wasmFulgoraRenderParity.spec.ts`: 0 pixels against the
radius-10 surface, the preview PNG differing from the render exactly where it
differs from the real surface (1,003 in the window, 22,288 of the full 1024),
and the tiling check. Eleven tier-3 rows were re-recorded: every 1-tile-per-pixel
window (origin land mask, terrain, resources, all; both scrap windows'
resources and all; the three scrap-slider cases). Checked against the old
engine, every moved pixel is terrain (no scrap pixel moved), and the origin
window went from 189 pixels off the real surface to 0. The rows at other zooms
did not move. Tier 1 grades by name in `fixtures/fulgora_real_surface.rs`.

**Planted breaks:** swapping the shallow twins' layers (0 to 679 tiles by name
and 83 pixels; 11 of 33 tier-3 tests red); folding `-shallow-2` back into
`-shallow` before correction (raw kinds 12 to 11, corrected 0 to 18,564 by
name and 56 by colour); no correction margin (0 to 61); columns order against
the radius-6 and rows captures (5 and 10, where the walk gives 0). Two plants did NOT go red, and that is a finding:
the old tie order (there are no ties), and visiting the walk's neighbours
y outer instead of x outer (these captures cannot tell the two apart).

### Aquilo (#454)

Aquilo is the fourth planet to render through the engine. It was ported
Rust-first: there is no TypeScript version to agree with, so tier 2 only freezes
the module's own folds, and tier 1 and tier 3 are what grade it against the
game. `docs/noise/aquilo-NOTES.md` holds the findings behind the
numbers here.

**The ABI block.** `PLANET_AQUILO = 3`. The block is 128 bytes (six resource
levers, three bearing pairs of sine and cosine, and one placement sweep box), so
a request is 184 bytes. Since #492 the sweep box is decoded and not read: each
pixel reads only its own chunk's entities, so there is no halo. The slot stays
so the layout does not move. That is smaller than Vulcanus's 368, so
`REQUEST_BYTES` stays Nauvis's 576. The offered views are terrain, resources,
rocks and all. `VIEW_ENTITY_FOOTPRINT = 12` exists for the test that grades
placement, and the panel never offers it. Elevation, enemies, cliffs, trees and
the land mask are not served by the module. The app falls back to terrain for
the last four, and an elevation request throws `unsupportedPair`.

**Tier 1: every field is a full house.** The fixtures capture 30 fields at 3
lever settings (default, all three resource sliders at size 0, and a moved
setting) from two game versions that agree bit for bit. All counts are exact
f32 bit matches, and every one is full:

| group                                                  | default | size 0 | moved |
| ------------------------------------------------------ | ------: | -----: | ----: |
| resource fields (11: 4 cones, mask, 3 spots, 3 odds)   |     632 |    452 |   626 |
| terrain fields (8)                                     |     632 |    452 |   626 |
| tile scores (9) and tile winner                        |     632 |    452 |   626 |
| iceberg odds (2)                                       |     632 |    452 |   626 |

`aquilo_elevation` and `aquilo_aux` are also 1024/1024 on the Stage 0 fixture
(`oracle-aquilo-fields`, default levers only), and the nine tile scores are
1024 of 1024 there. The counts live in `fixtures.rs`; this table is the shape,
not the authority.

- **Size 0 is the basement, never NaN.** At size 0 the spot radius is 0, so the
  cone formula `3q / (pi r^2)` is 0/0. The game reads exactly -1 (the basement
  value) over the whole capture pool, and the port does too
  (`a_zero_size_spot_field_is_the_basement_everywhere`). The size gate in the
  probability is a constant fold: at size 0 it is `+0`, where a literal multiply
  by zero gives `-0`.
- **Every constant is an f32 slot.** The wobble fields scored 144 and 99 of 632
  with `output_scale` as a double, and 632 with it narrowed. Four tile-score
  constants (`0.01`, `0.05`, `0.4`, `0.6`) did the same. `0.75` is exact in
  binary, so narrowing it is a no-op.
- **The grid path is graded only by tier 3.** Every tier-1 position is a point
  capture, so the chunk-grid path of the plain fields, the billows and
  `AmplitudeCorrectedGame` is first graded by the terrain comparison below.

**Two findings that change shipped code, each filed rather than fixed here**
(see "Do not fix the next one inside the port" above):

- `ConeArithmetic::GameBinary` (#491). The game's spot cone, read from the 2.1.23
  binary: `PI` is the double `3.1416` (at `.rodata` `0xffc028`), the peak narrows
  once, the distance is an f32 square root of an f32 sum of f32 squares. The
  ported cone, `ConeArithmetic::PortedF32`, uses the true pi and an f64
  distance, and left Aquilo's spot fields at 568, 568 and 561 of 632. Aquilo
  uses `GameBinary`. Vulcanus keeps `PortedF32` so its frozen counts do not move.
  Measured by switching Vulcanus over without committing it, its five spot
  fields would rise from 1033, 1026, 999, 1020, 1020 to 1058, 1048, 1056, 1052,
  1043 of 1085. Nauvis's spot code probably has the same cone. #491 holds the
  follow-up.
- `AmplitudeCorrectedGame` (#254). The shipped amplitude-corrected form is wrong
  in two ways: the persistence is f32, and the `output_scale` transform is folded
  in f32 in the Lua's order. On the wrapper fixture the game's form scores
  152/152 and the shipped form 81. Aquilo's `random_island_peaks` scored 608, 434
  and 602 of 632, 452 and 626 with the shipped form. Nauvis keeps the shipped form;
  the finding is posted on #254.

**Tier 2: four windows, two lever settings, 224 rows.** `checksum_aquilo` folds
all 28 fields (11 resource, 8 terrain, 9 tile scores) over a 26 by 26 window.
The frozen table `tier2-checksums.json` has an `aquilo` section of 224 rows: 4
windows by 2 lever settings by 28 fields. The first window is the original one,
and three more were added because it held a constant on 8 of 28 fields at
default levers (the window is mostly ocean away from any well). The added
windows hold the spawn cones, a ring across the starting mask ramp (distance
300 to 340), and the guaranteed vent. This is the "a window must contain the
thing it grades" rule again: the plan's window was kept for its original rows,
and the extra windows were added beside it rather than accepting the constants.

- All 28 fields take more than one value in some case (graded in
  `native_parity.rs`), and moving each of the six levers alone changes at least
  one fold (`wasmAquiloParity.spec.ts`). Each lever is compared over every
  window against the default, except the size levers, which are compared against
  the same lever with only its frequency moved. The default layout puts no
  random fluorine spot in any window, so a fluorine size change has nothing to
  resize there; moving the frequency first relocates the spots into the windows.
  The test failed first, which showed it can discriminate.
- A field index past the last real field (28 or more) folds 0 rather than a
  plausible checksum of zeros, and the specs assert index 27 folds non-zero.
  `checksum_vulcanus` has the same shape and was not changed, because it is
  shipped code.
- Tier 2 here compares the module run native with the module run in WASM, so it
  sees the wasm libm, but it cannot see a mistake that both share. The frozen
  rows were written from the WASM run and the native test matched them with no
  copying.

**Tier 3: the terrain matches a real surface at every pixel; the preview PNGs
are now a reference (2026-11-26, see "Aquilo against a real surface" below).**
Before that the terrain gap to the preview was 0 of 1,048,576, and since #492
the composite's was too, inside a 4-pixel border. The spec is
`test/wasmAquiloRenderParity.spec.ts` (27 tests since the real-surface change, 24 since #492, 26 before: the
per-colour fingerprint and the halo-radius check went. About 17 to 20 seconds on
tealc, about 1.5 times Fulgora's). All of it uses the derived surface seed 3111923328
for map seed 123456, and the window is -512 to 511 at one tile per pixel.

| what                                                           | frozen                |
| -------------------------------------------------------------- | --------------------- |
| terrain view against the REAL surface, -128..127 (levers at size 0) | 0 of 65,536      |
| preview PNG against our render in that window, and against the real surface | 531, at the same pixels |
| terrain view against the terrain PNG (levers at size 0), a reference | 718 of 1,048,576 (0 before the correction) |
| same, levers left at neutral (control)                         | 13,707 (13,194 before) |
| raw map seed instead of the derived one, 256 by 256 at spawn   | 7,376 of 8,843 land pixels differ (83%; measured, asserted > 50%) |
| composite (wells and icebergs) against the full PNG, every pixel | 1,067 of 1,048,576: 1,064 tile against tile (0 before), 3 entity pixels at the edge, 0 entity pixels inside a 4-pixel border |
| per-colour pixels in that composite                            | equal to the game's, except iceberg +3 |
| footprint pixels outside, grown by 1 pixel                     | 7                     |
| footprint pixels outside, grown by 2 pixels                    | 0                     |
| footprint share of the window                                  | 3.59% (asserted 1% to 10%) |
| tiled render against whole render, 100-pixel tiles cutting through chunks, no halo | 0 bytes differ |
| entity pixels straddling those seams (control)                 | asserted > 0          |
| `aquilo:render` rows in `tier3-render-checksums.json`          | 14                    |

- **The terrain PNG was captured with all three resource controls at size 0,
  and those controls reshape the islands.** A render that names no levers
  renders at size 1 and differs from the PNG in 13,707 pixels (13,194 before the correction). The matched
  pairing gives 718, the correction's footprint (0 before). The spec freezes both numbers so the levers stay load-bearing.
  This is the Vulcanus lesson again (see tier 3 above).
- **The full-PNG test grades the composite, every pixel, nothing masked
  (#492).** Wells and icebergs come from the game's own per-chunk entity
  generator (`crates/fmw-noise/src/placement/generate.rs`; the
  reverse-engineering is `docs/noise/entity-generation-NOTES.md`): one
  unsalted taus88 stream per chunk, shared by the five autoplace groups in
  `order`, jitter draws included. They are drawn by the preview's rule, which
  was measured against the PNG rather than read: no entity-against-entity
  collision, each entity covering `floor(left)` to `ceil(right) - 1`, clipped
  to its own chunk, the first queued winning an overlap. The 3 differing pixels
  belong to one huge iceberg at (211.375, 511.6875) whose box reaches tile row
  512, past the capture; the game did not draw it. The lead is that the preview
  has no tiles past its own area. It was seen once and not read from code, so
  the engine does not copy it. The per-colour counts are asserted beside the
  total so a failure names the layer that moved.
- **The same generator reproduces a real surface: 209 of 209 entities** at the
  game's positions, to the 1/16 tile
  (`aquilo_real_surface_replay_places_every_entity_the_game_did` in
  `fixtures.rs`). That replay needs the game's own land, because a real
  surface runs tile correction and moves the shore, and the preview does not.
  It also applies entity collision, which the preview skips. Two of its apply
  rules (touching boxes collide; chunks apply row-major) were measured, and
  the touching rule has a control that fails without it.
- **The footprint is 7 outside when grown by 1 pixel, not 0.** All 7 are
  iceberg edge pixels. A huge iceberg is 3.7 by 2.5 tiles and the game draws it
  that wide, so an edge can sit two pixels from the tile it was rolled on.
  Both radii are frozen.
- **Overlaps show whichever entity was queued first.** Groups queue in
  `order`: fluorine vent and lithium brine before the icebergs, crude oil after.
  So the composite shows brine or vent over an iceberg, and an iceberg over
  crude oil. The overlap test finds both kinds in the two windows and asserts
  each occurs, so neither half is vacuous.
- **Before #492, for the record.** The salted roll (salts `0x00682f53` and
  `0x0027d9c1`, now deleted) painted 3x3 marks: crude 295, lithium 444, vent
  189 and iceberg 4,716 pixels against the game's 475, 451, 157 and 4,609, and
  the full-PNG test graded the terrain view with entity pixels masked (0 of
  1,023,862). `docs/noise/aquilo-NOTES.md` keeps that table.
- **The `aquilo:render` digests are a self-snapshot, not a correctness grade.**
  They are the bytes our own module produced when they were frozen, in 14 rows
  (4 views by 2 windows, and 6 slider cases). #492 changed 11 of the 14 (by
  `git diff` of `tier3-render-checksums.json`). The two terrain rows did not
  move, and neither did "slider fluorine vent frequency | all"; why that one
  window shows no entity change was not looked into. They catch a render that
  changed. They cannot say the render was right. The full-PNG test and the
  control counts are what grade it against the game.
- **Each slider crosses the ABI.** Six cases move one lever each to 2 (crude
  frequency and size, lithium frequency and size, fluorine frequency and size),
  each in a window where it matters, and each asserts the picture changed. Most
  windows are dead to most levers. Near spawn, sizes of 0.25 to 4 moved no well,
  and only size 0 did. That is the game's own rule: out to 260 tiles
  `aquilo_starting_mask` is -1, so each spot term is the constant `-k`, and the
  starting cones' radii (`aquilo_spot_size * 0.8` or `* 0.6`) ignore the size
  slider. Only the `size > 0` gate reads size there.
- **A planted swap of two bearings turned 12 of 26 tests red** (terrain gap 0 to
  1,189, full-PNG tiles 0 to 554). It was reverted and the rebuilt module
  matched the committed one again. This was before #492 and was not re-run.

**Two rulings that shaped those numbers.**

- *The footprint is frozen at two radii.* The plan expected 0 at the mark
  radius. Measuring found 7 edge pixels, each checked by flooding its iceberg
  in the game PNG, so both 7 and 0 are frozen, with the reason.
- *The tile grade uses the terrain view.* Superseded by #492: the full-PNG test
  now grades the composite, every pixel.

**Placement rules, now read from the game (#492).** Before #492 these were
choices made by comparing counts. Now each follows from the prototypes and the
generator, and the 209/209 real-surface replay confirms them.

- Wells are candidates on every tile: their `collision_mask` is `{resource}`,
  and no Aquilo tile carries that layer. So each well group spends 1,024 draws
  per chunk. Icebergs are candidates on the six land tiles only: both iceberg
  prototypes carry `water_tile`, which both oceans and brash ice also carry.
- Each iceberg uses its own box (huge 3.7 by 2.5, big 2.0 by 1.5). The old rule,
  huge's box everywhere because huge never wins an argmax, is gone: huge and big
  are separate `order` groups and are never arbitrated against each other.
  That is how the game gets about 12% huge (22 of 190 on the real surface).
- No well tile rewrite. The wells' `created_effect` rewrites nearby ocean during
  map generation, but the game's preview PNG shows none of it (0 pixels), so
  the port does not model it. The preview also runs no tile correction.
- Not ported, each unreachable on Aquilo today: `placement_density`, grid
  snapping, the richness tie-break inside a multi-prototype group
  (`generate_chunk` refuses one; Vulcanus's solid ores share `order` `"b"` and
  will need it), and `tile_restriction`. The richness slider is not passed to
  the engine; the app's minimum is 1/6, so richness is always above 0, but an
  imported string with an Aquilo richness of 0 would draw wells the game does
  not place.

### Aquilo against a real surface (#454, 2026-11-26)

At one tile per pixel on a whole-tile origin, the Aquilo render now runs tile
correction after the argmax, the way Gleba's does (`render_aquilo`,
`AquiloStack::corrected_tiles`), so the terrain is what a real surface holds.
At any other zoom a pixel is still the raw argmax at a point. The wells and
icebergs are still drawn by the preview's rule (#553). The app opens Aquilo at
one tile per pixel in the `all` view, so a user sees the corrected terrain with
the preview's entities on top. `docs/noise/aquilo-NOTES.md` has the findings.

- **Correction alone closes the gap.** Aquilo's nine layers through the
  unchanged `tiles/correction.rs` give 0 wrong tiles by name against the
  committed real surface (551 raw), and against two uncommitted 1024 x 1024
  real surfaces (levers off, and neutral with every entity autoplace removed).
  No Aquilo tile has `allowed_neighbors`, and the argmax has no ties in
  1,327,104 tiles, so neither the neighbour table nor the tie order is
  reached. `correction.rs` did not change, so Gleba stays at 0.
- **The fixture** is `oracle-aquilo-real-surface.seed123456.json`, from the
  Gleba probe with `FMW_PLANET=aquilo` (`scripts/probes/gleba-real-surface`).
  A columns-order request gave the same window at every tile and is not
  committed.
- **The preview tests moved only to the correction's footprint.** The terrain
  PNG went from 0 to 718, and in the 256 window the PNG differs from the render
  exactly where it differs from the real surface (531 pixels, asserted). On
  the full PNG, 1,064 tile pixels moved, and on the 1,042,881 pixels where both
  images show a tile they are exactly where the neutral 1024 real surface
  differs from the PNG (measured). The `aquilo:render` digests: 13 of 14 rows
  moved, and in each one every moved pixel is a tile colour on both sides and
  equals the corrected terrain view (old and new module compared, render by
  render). "slider fluorine vent frequency | all" did not move because the
  correction changes no tile in that window.
- **The margin is load-bearing for the worker pool.** Cut into the app's
  128-pixel tiles with no margin, 45 tiles of the committed window are wrong;
  with one chunk, 0 (`aquilo_corrected_tiles_against_the_real_surface`).
- **Planted breaks:** no correction in the render (real surface 0 to 531,
  terrain PNG 718 to 0, full PNG 1,064 to 0, 15 of 27 tests red); brash ice at
  the oceans' layer 67 (corrected tiles 0 to 160 wrong, and the layer check
  red); `AQUILO_CORRECTION_MARGIN_CHUNKS` at 0 (tiled 0 to 45 wrong).
- **What it costs: about 1.3x, after three changes that alter no output
  byte.** The first wiring cost about 3x, because a 128-pixel tile evaluated
  8 x 8 chunks of raw tiles to draw its 4 x 4, and the entity pass then
  evaluated the window again. Now:
  - `correct_window` (`tiles/correction.rs`) reads raw tiles lazily, so the
    outer ring of chunks, which is read but never corrected, costs only the
    band the walks reach. Gleba uses it too.
  - The scan skips a walk whose seed sits in a 3 x 3 block of one id. Such a
    walk changes and queues nothing (the module docs give the argument), and
    open ocean is mostly such seeds.
  - The Aquilo render keeps the fields correction evaluated for the window's
    chunks (`KeptFields`, up to 64 chunks) and the entity generator reads them
    instead of evaluating each tile a second time.

  Measured on hammond with other sessions running, the app's default view
  (1024 x 1024 `all`, map seed 123456):

  | module | WASM under Node, 64 tiles of 128 summed on one thread | browser, headless Chrome, 15 workers, wall |
  | --- | ---: | ---: |
  | raw argmax, before correction | 2,236 ms | 590 ms |
  | first correction wiring | 6,645 ms | 1,691 ms |
  | now | 2,920 ms | 750 ms |

  Node is the median of 7 interleaved runs; the browser is the median of 9
  `Generate` clicks after one warm-up, read off the dev-mode elapsed readout
  (`pnpm vp dev`, `?dev=1`, seed fixed at 123456). A 256 x 256 terrain render
  went 63 ms, 187 ms, 118 ms. What is left is mostly the raw tiles of the
  margin chunks, which correction must read in full. 256-pixel worker tiles
  instead of 128 measured 727 ms against 738 ms in the browser, inside the
  noise, so the pool's tile size was left alone.

  The output is the same, byte for byte, as the first wiring's: 52 Aquilo and
  Gleba requests (every view, levers off and neutral, chunk-aligned and not,
  1, 2 and 0.5 tiles per pixel) and the whole 1024 `all` view, tiled and
  whole, compared with the previous module. The unit tests
  `lazy_and_eager_reads_agree` and `skipping_uniform_seeds_changes_nothing`
  pin the two correction changes on random grids.
- **The entity overlays are the next step (#553).** The corrected land matches
  the land mask of `oracle-aquilo-surface` at all 409,600 tiles, where the raw
  argmax misses 172 (`aquilo_corrected_land_matches_the_entity_stream_surface`),
  so the entity replay could read our tiles instead of the game's.

### Vulcanus: the terrain graded against a real surface (2026-11-26)

At one tile per pixel on a whole-tile origin, the Vulcanus render now runs tile
correction, as a real surface does and the game's preview does not, so the
terrain under every view is what a player's map shows. The module is
`crates/fmw-noise/src/tiles/vulcanus_correction.rs`; `render_vulcanus` calls
it. The target is `get_tile` on a real surface, the same rule Eric set for
Gleba.

**Against the real surface**, 256 x 256 tiles around spawn, map seed 123456,
derived surface seed 1249936247, the ore controls at size 0 as the preview
capture had them (`oracle-vulcanus-real-surface.seed123456.json`):

| step | tiles wrong (by name) | pixels wrong (map colour) |
| --- | ---: | ---: |
| raw argmax (what the preview PNG shows) | 2,053 | 1,814 |
| tile correction, layers only | 217 | 217 |
| plus the may-touch rule (`allowed_neighbors`) | **1** | **1** |

- **Layers.** `VulcanusTile::layer` is the game's effective layer, read back at
  runtime. Lava (`water-overlay`, 86) and lava-hot (`water`, 69) sit far below
  the ground tiles (`ground-natural`, 184 to 202).
- **Tiles that may not touch.** Lava and lava-hot allow only each other, so
  lava against ground fails the consistency check before any layer test
  (`Neighbours` in `tiles/correction.rs`, the design the Nauvis port read from
  the binary). The game's replacement search finds no path out of that pair,
  in its own tile list or in ours, so lava and ground never replace each other;
  without the rule the layer checks turn ground into lava along one-wide
  strips, the 217 above.
- **The last tile is order, not the pass.** At (-127, 95) we draw lava-hot and
  the capture lava. Corrected in the order the game queues the tasks for that
  request (`MapGenerationManager::request`, decoded by the Fulgora port:
  each requested chunk first asks for its 3 x 3 one stage lower, so one
  request corrects the 5 x 5 around it), both committed captures match at
  every tile, the radius one and the one-at-a-time `-each` one
  (`the_games_request_order_reproduces_both_captures`). An uncommitted capture
  of the whole 1024 x 1024 window (one radius-18 request,
  `realsurface.local/real-vulcanus-1024-radius18.json`) has lava-hot at
  (-127, 95), like the render; the render differs from it at 3 of 1,048,576
  tiles, all at its left edge, and the request order takes that to 0. The
  render keeps columns order: it cannot know what a game requested, and
  columns order agrees with the request order away from a request's edge.
- **No ties.** No two tiles share the winning score anywhere in the 1024 x 1024
  window (closest 2.4e-7), so the listing-order argmax needs no tie order.
- **Margin.** One chunk, as Gleba: none leaves 79 tiles wrong, two changes
  nothing. Tiled renders (128- and 100-pixel tiles) stitch to the whole one byte
  for byte.

**What moved.** The preview PNG is now a reference: the render differs from it
at 39,950 of 1,048,576 pixels, where correction changed a colour, and inside
the fixture window exactly where the real surface differs from it, plus the one
order tile. Eleven tier-3 rows moved, all at one tile per pixel on a whole-tile
origin (the 64 x 64 window at the origin in every view, and two ore windows in
the resource view); in each, every moved pixel is a terrain pixel correction
changed, and no overlay pixel moved. The overlay counts (rocks, cliffs, ore,
composite) did not move. No tier-2 fold moved: correction is a render step.

**What it costs.** The render goes through `correct_window` (lazy raw reads,
no-op walks skipped, from the Aquilo port). Node, one thread, median of three
interleaved runs on hammond with other sessions running; "eager" is the first
version of this port, which read every raw tile of the margin and ring:

| render | raw argmax | eager correction | `correct_window` |
| --- | ---: | ---: | ---: |
| 1024 x 1024 `all`, 64 tiles of 128 px, the four ore controls at size 0 | 25.7 s | 84.3 s (3.3x) | 51.9 s (2.0x) |
| the same, `terrain` | 18.8 s | 76.8 s (4.1x) | 45.0 s (2.4x) |
| one 256 x 256 terrain render | 1.16 s | 2.65 s (2.3x) | 1.88 s (1.6x) |

**The first row is not the app's default view.** It was measured with the
ore controls at size 0, as the real-surface capture had them, so it has no ore
overlay. Re-measured on 2026-11-26 (same method): that setting gives 53.1 s,
and the app's own default, ores on, gives 92.0 s at 128-pixel tiles and 68.6 s
at 256. The ore overlay was the other half of the render (39.0 s at 128 px,
31.1 s at 256), and it now goes through two projections; see "The ore overlay
reads projections" below.

The eager and lazy renders are byte-identical over the whole app view, in both
views. What is left is mostly the raw tiles of each tile's margin: a 128-pixel
tile (4 x 4 chunks) corrects 6 x 6 chunks, so it reads about 2.25 times its own
tiles, at about 18 microseconds per raw Vulcanus tile. Measured with a counter
on the raw reads (2026-11-26): a 128-pixel tile reads 38,200 raw tiles for its
own 16,384, a 256-pixel tile 104,800 for 65,536, and the whole 1024 window as one
piece would read 1,191,000.

**The worker pool does not divide these times by its worker count.** Measured
in Chrome with no DevTools attached, on hammond (6 performance cores with two
threads each, plus 4 efficiency cores): a 256-pixel Vulcanus tile that takes
4.4 s alone takes about 7 s while 14 others run beside it, so 15 or 16 workers
run about 9 times faster than one thread at best, not 15 times. The 256-pixel
grid also gives 16 tiles to 15 workers, so the 16th tile runs alone at the end:
10.3 s against 7.6 s with 16 workers.

**Do not time a render through a browser that has DevTools attached.** Under
chrome-devtools-mcp the same tile took 8.5 s instead of 4.2 s, because V8 runs
WebAssembly in its debug tier while a debugger is attached.

**Not modelled.** Entity placement on a real surface runs after correction, so
the rock lists that name hot and cold ground tiles may see corrected tiles. The
overlays still read the raw argmax; their cliff and lava tests only ask lava or
not, which correction never changes.

**Tier 3** is the real-surface block of `test/wasmVulcanusRenderParity.spec.ts`
(1 pixel, at (-127, 95); the PNG window differs from the render at 1,815 pixels,
exactly its 1,814 against the real surface plus that tile; tiled renders stitch).
Tier 1 grades the same window by name in `vulcanus_correction.rs`.

**Planted breaks, each turning a frozen count red.** Planted in the shipped
render and run through tier 3: no may-touch rule (1 to 217 pixels; the PNG
check 1,815 to 1,808), and no margin (1 to 72 pixels, and the 128-pixel tiled
render no longer stitches). In tier 1: poison on the argmax (1 to 64,368 by
name), and the `-each` capture corrected in columns order instead of its own
row order (0 to non-zero).

### The ore overlay reads projections (2026-11-26)

`paint_vulcanus_resources` used to call the whole resource layer
(`VulcanusStack::resources`) twice over: once per pixel for the three solid
ores, and once per tile of every chunk the geyser roll resolves. The geyser
roll resolves whole chunks, so a 1-pixel halo pulls in a full ring of them: 100
chunks for an interior 256-pixel tile against its own 64, and 36 for a
128-pixel tile against 16. The whole layer also evaluates four favorabilities,
the sulfur cones, the sulfur spots and the patch noise, none of which a solid
ore reads, and the three solid ores' cones and spots, none of which the geyser
reads.

Both passes now read a projection: the solid ores `ore_regions` (the existing
fast path the ore -> cliff rejection uses), the geyser
`sulfuric_acid_region_patchy`. Each projection calls the same helpers the full
layer does, and each has a raw-bits twin test against it in
`expressions/vulcanus_resources.rs`
(`the_ore_region_projection_agrees_with_the_full_eval_bit_for_bit`,
`the_geyser_patchy_projection_agrees_with_the_full_eval_bit_for_bit`).

- **Output: unchanged.** The 1024 x 1024 app view stitches to the same bytes
  as before at 128- and 256-pixel tiles, in the `all` and `resources` views.
  No frozen count moved.
- **Cost:** Node, one thread, sum over the tiles of the app view, medians of
  two interleaved runs: `all` 68.4 s to 46.9 s at 256-pixel tiles (31% less)
  and 92.1 s to 63.9 s at 128 (31%); the `resources` view 62.6 s to 40.7 s
  at 256.
  In Chrome with 15 workers the 256-pixel render went from 10.3 s to 7.0 s,
  and with 4 workers from 19.3 s to 13.2 s.
- **Poison still reaches the geyser.** Under `--features poison` the geyser
  probability over a 64 x 64 window changes at every position, and the
  placements over a 512 x 512 window go from 56 to 29,567: the projection
  reaches the same `basis_noise`, spot and `f64_result` hooks the full layer
  does.

### Current tier-1 counts

**`crates/fmw-noise/src/fixtures.rs` is the authority, and the tables live in
`docs/rust-wasm-port-history.md`.** Do not copy a count back into this file. It
has gone stale twice, and a number written in two places is a number that can
disagree with itself. What stays here is the part that is a RULE rather than a
record.

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
  0 gate mismatches of 1024 at both seeds - the strongest tier-1 result any
  Nauvis field has apart from `temperature`. That means nothing on its own,
  because a constant-0 port also produces no mismatches on the zero side. The
  non-zero count is frozen next to it for that reason.
- **When a fixture is FULLY ON-GRID the snap is the identity, so assert that
  rather than applying a snap that buys nothing.** Pin BOTH arms anyway: "the
  snap is the identity" is a claim about ANSWERS, and an off-grid count of 0
  only counts positions.
- **A hand-maintained count table DRIFTS, and nothing was asserting it.**
  `test/captureGrid.ts` had drifted in four rows at once - two tree rows and two
  `oracle-rock-density` rows - each off by one or two in BOTH arms of its
  fixture and in the same direction, which is the signature of the port having
  moved since the table was taken. All four are frozen on the Rust side now,
  snapped and raw. That is the general remedy: freeze it in a test, or do not
  write it down.
- **The resource layer has no exact count at all** - see "When the exact-match
  count degenerates" above.
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

### The ABI

**The request layout is at v2 and is per-planet.** A 56-byte common prefix
declares `params_bytes`, then a per-planet block follows:

| planet   | block | request |
| -------- | ----- | ------- |
| Aquilo   | 128   | 184     |
| Gleba    | 24    | 80      |
| Fulgora  | 64    | 120     |
| Nauvis   | 520   | 576     |
| Vulcanus | 312   | 368     |

**Nauvis is the largest, so `REQUEST_BYTES` is 576.** Do not quote that table
from here - it has gone stale once already, because a block grows whenever an
overlay lands. The constants are declared in three places that must agree, and
reading all three at once is both the current answer and the check that they
have not drifted:

```bash
grep -n '_BYTES' crates/fmw-wasm/src/abi.rs src/noise/wasm/request.ts \
  test/fixtures/verify-wasm-request.py
```

**A planet block can grow with NO version bump, and that is the split working.**
Vulcanus's has grown twice (248 -> 280 for the cliff view, 280 -> 312 for the
overlays), Fulgora's once (#363, 48 -> 64, for `control:scrap:frequency` and
`:size`), and Nauvis's seven times (64 -> 96 -> 144 -> 160 -> 232 -> 376 -> 512
-> 520, #339 appending the spawn list and then the starting-area radius, the
enemy field's `20 / radius` term).
`BadParamsLength` refuses a writer whose declared length disagrees. **A version
bump is for a change to the COMMON prefix**, which every planet reads.

**Blocks are append-only.** Fulgora's two scrap sliders sit AFTER the trig
rather than beside the two island sliders, because grouping them with the other
controls would have moved the trig block, whose offsets every existing reader
already knows.

**`REQUEST_BYTES` is a `max`, not `COMMON_BYTES + VULCANUS_PARAMS_BYTES`.** Both
sides had it written the second way, which was correct while Vulcanus's block
was the largest, and went silently wrong the moment Nauvis's overtook it in
#335 - the failure being a scratch buffer too small, which surfaces as a
truncated request rather than as a size error. The Rust test asserts the PROPERTY (the
capacity equals the largest request) rather than repeating a literal. A Nauvis
request sat BETWEEN the other two through its first five sizes, which is what
makes "the encoder returns a LENGTH, not the capacity" a real statement rather
than a two-case coincidence.

**Nauvis carries ONE world box; Vulcanus carries TWO; trees need none.** Which
overlays need one is not guessable. The terrain view paints one pixel per pixel.
Trees read a one-cell border of their own FIELD rather than of the image, so a
tiled render matches an untiled one with nothing widened - the only one of the
five like that. Rocks do read the image and their mark is a symmetric 3x3, so
one box covers it exactly. **Two overlays with different-SHAPED marks need TWO
boxes**: Vulcanus sends both `cell_query_box` and `placement_sweep_box`, because
the cliff block spans `px - 2 ..= px + 1` so its halo is asymmetric and its two
directions cross. Both are SENT rather than derived, because each needs the FULL
image's geometry, which the prefix does not carry and only the tiled renderer
knows. Nauvis's cliff overlay needs its own second box for the same reason.

**The module does NOT default the scrap sliders**, and `FulgoraParams`'s
`Default` gives 0 rather than the neutral 1 on purpose, so a writer that forgot
them renders visibly wrong rather than plausibly right. The single place an
absent slider becomes 1 is `writeFulgoraParams` in `src/noise/wasm/request.ts`.
Do not add a second.

**`VIEW_SCRAP_FOOTPRINT` is not the scrap overlay**, and #363's issue body was
written believing it was. The footprint view paints every tile where the
probability is positive; the `all` composite paints the subset a placement ROLL
accepts. Measured over a 128x128 window at seed 123456: 708 footprint tiles
against 177 placed, so substituting one for the other moves 531 pixels. The
footprint is deliberately not a roll, because diffing rolled pixels against the
game's drawn pixels measures the salt rather than the model.

**Errors return a status code and never trap.** A trap would poison the instance
for every later request in that worker; a spec sends a bad magic and then
renders successfully through the same instance.

**Trig crosses as VALUES computed in V8**, never computed in the module (#270).
Nauvis carries none, because it is the one planet free of transcendentals.
Since #531 those values are the GAME's own sin/cos polynomial
(`src/noise/gameTrig.ts`, and `vm_sin`/`vm_cos` in `eval/math.rs` for tier 1),
not `Math.sin`: the game's `sin` is not libm, and a correctly rounded f32 sine
is one ULP away from it on about 5% of inputs. The bearings feeding it are
graded against the game on 606 seeds (`test/bearingChain.spec.ts`).

`test/fixtures/wasm-request.v2.json` pins the encoding for all five planets
(Aquilo, 128 bytes, request 184, and Gleba, 24 bytes, request 80, both added in #454). It is declared under
`notFixtures` because it is our own ABI rather than Factorio
ground truth, and its bytes are checked by
`test/fixtures/verify-wasm-request.py` - **a third implementation, not the
writer under test** - so a future version is re-verified the same way rather
than regenerated from the encoder.

Two lessons from that checker, and both generalise past it:

- **A property check is not a structural check.** The checker cannot reproduce
  the Fulgora and Vulcanus trig values, since those are the game's own sin/cos
  polynomial (`src/noise/gameTrig.ts`, #531) computed in V8, so it checked each
  pair for `sin^2 + cos^2 = 1` instead. That
  property **passed a planted swap of two bearings** - rendering a plausible
  planet with its biomes rotated - because a property is invariant under
  permutation. It now also recovers each angle with `atan2` and checks it
  against the offset the game's Lua gives it. **Ask what your property is
  invariant under, and plant that.** Aquilo is the exception: its arm's trig
  bytes ARE the script's own copy of the game's sin/cos polynomial (`game_poly`;
  they were Python's libm sine and cosine until #531, which sit one ULP from the
  game on about 5% of inputs), and they equal V8's, so the checker also compares
  them to 2e-7.
- **Check that a structural claim's DATA instantiates it.** Nauvis's check is
  "distinct scalars at distinct offsets", which was sound - and the committed
  request carried only two distinct values across its eight fields, five `1.0`
  and three `0.0`, so a swap of `moistureFrequency` and `auxFrequency` read back
  correct and passed every assertion. The fixture uses twelve distinct values
  now, and both checkers ENFORCE distinctness rather than assuming it.

Of eleven breaks planted against Vulcanus's two boxes, ten are caught by the
per-edge value check. The eleventh is not: **a halo one tile wider on the low x
side, with the request edited to agree, passes every value check**, and is
caught only by asserting the placement halo is symmetric about the pixel box.
The structural checks (four distinct edges, not inverted, no edge shared between
the boxes) caught none of the eleven and constrain the FIXTURE.

### The cutover, and why an early render is not a bug

`runRenderRequest(req, engine?)` takes an OPTIONAL engine - a parameter rather
than module state, so nothing has to be registered or reset between tests.
`createRenderWorker` loads and compiles the module once per page and posts it to
each worker; the worker instantiates synchronously with
`new WebAssembly.Instance(module)`, which is allowed for an already-compiled
module on any thread.

**A render dispatched before the engine message arrives is QUEUED, and the
handshake must SETTLE.** This paragraph used to say an early request was "not a
bug" because it took the byte-identical TypeScript path, and that a failed fetch
or compile was therefore safe to swallow. Both halves expired with #227: with no
TypeScript to fall back to, the worker holds a request until the engine message
arrives - and a swallowed load failure then meant the message never arrived and
every tile hung on "Rendering..." (found and fixed in #371's engine-mandatory
change). `createRenderWorker` now posts `{ kind: "engine", error }` on failure,
the worker fails each queued and later request with
`render engine failed to load: ...`, and the host rejects them by id.
`IslandFinderPanel`'s `surveyEngine()` stopped swallowing for the same reason;
its failure lands in the panel as the module's own message.
`test/renderWorkerEngine.spec.ts` grades the queue, the bad-module case and the
no-module case.

**The engine load sits in `createRenderWorker`, not in `createWorkerHost`, and
that is not stylistic.** Every test that exercises the host constructs it with a
fake worker factory, and fetching from the host made those tests print a page of
`ECONNREFUSED` while still passing - under vitest the module URL points at a dev
server that is not running. Loading beside the real `new Worker` means only the
real browser path ever reaches the network.

### Performance

**The engine is ~2.46x faster than the TypeScript IN THE BROWSER**, and the
"22.71x" #275 published is wrong:

| harness             | TypeScript |        WASM |     ratio |
| ------------------- | ---------: | ----------: | --------: |
| Chrome, dev server  | **246 ms** | **99.7 ms** | **2.46x** |
| Node, inside vitest |    1134 ms |     50.7 ms |     22.4x |

The same TypeScript is 246 ms in the browser and ~1130 ms under vitest, and its
warm-up trace is flat from the first pass, so that is not a cold JIT - at the
time it was read as issue **#267**, vitest's per-module transform, and only one
of the two arms paid that tax. **#267 was refuted and closed on 2026-09-05**
(its own A/B now returns 0.99x, because #227 and #371 took `src/noise/` from 99
modules to 25), so the mechanism behind this particular gap is no longer
established - the measurement stands, its explanation does not. The WASM arm differs the other way (50.7 ms in Node against 99.7 ms in
Chrome), so neither engine is uniformly faster.

**The lesson generalises past this number.** Any A/B where the two arms go
through different amounts of the test harness is measuring the harness.
Benchmark in the environment that ships, or at least confirm the harness treats
both arms alike.

**`multioctave_noise(x, y, &params)` REBUILDS its seed tables on every call, and
that cost 20x before it was measured.** `tables_from_seed` runs a PRNG over
three 256-byte permutation tables, and Fulgora's chain makes eight such calls
per pixel. Hoisting them into a `Prepared` built once per render - which is what
the TypeScript's closure has always done - moved a 256x256 landmask render from
975.8ms to 50.7ms. Nothing in tiers 1-3 could see it, because the results are
identical either way; only a benchmark can.

### Rules that keep the port deterministic

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
  computed once outside the per-pixel path and handed in. If a new field ever
  reaches a transcendental, its value gets passed in the same way.
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
- **A frozen raw-bits fold must not contain a NaN.** WASM permits any NaN
  payload, so the fold becomes host-specific. A wholly different value across
  hosts is a NaN; a near miss is libm.

### The poison feature is the gate's anti-vacuity control

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

### `engine.wasm` is a COMMITTED artifact

`scripts/build-wasm.sh` produces it; `verify:rust` rebuilds and compares bytes
rather than regenerating. That is what keeps `vp build` free of any non-JS step
and lets `deploy:app` run on a machine with no Rust at all. **Any change to a
Rust source means rerunning that script and committing the result**, or the gate
fails as "stale".

Byte identity across machines is measured, not hoped for (#218): the same
source, profile and pinned toolchain give the same sha256 on macOS/aarch64 and
on an ubuntu x86_64 runner. That is why the gate can use `cmp` instead of
rebuild-and-retest. **A red `verify-rust.sh` on a fresh machine is usually
neither your diff nor the host** - `rust-src` bakes local absolute paths into
the module, and one RUSTFLAGS remap fixes it (#299).

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

### Structure conventions to copy for the next layer

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
  84; the breakdown is in the history doc and `fixtures.rs` is the authority.

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
  spec builds all six from the documented skip constants. Agreement is then
  evidence that the resolver really does partition its two candidate streams the
  way its own docs say. Building the same private copy on both sides would have
  proved nothing.
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
- **Cross the parameters as a REQUEST once a render path exists.**
  `checksum_vulcanus(request_len, field)` reads the request already in the
  scratch buffer, written by the shipped `encodeRenderRequest`, and builds its
  stack through the same `render::vulcanus_*` helpers the RENDERER uses - so a
  bearing wired to the wrong layer is INSIDE the comparison. A private copy of
  that wiring would be reproduced identically on both sides and stay invisible.
  The sweep is the request's own pixel grid, swept in the renderer's own order,
  so there is one geometry convention rather than two.

  `checksum_nauvis` does the same since #337. It took twenty-nine ARGUMENTS
  while there was no render path for a request to enclose; once there was one,
  that form meant the module built a second `NauvisCtx` beside the renderer's,
  and a lever wired to the wrong layer in both would have folded to the same
  checksum on both sides. `render::nauvis_ctx` is the one definition now, and a
  planted swap of `moisture_frequency` and `aux_frequency` in the RENDERER turns
  tier 2 red - which the argument form could not have done, by construction.

  Two things that conversion needed, both worth copying.
  `NauvisCtx.resource_controls` became SIX triples rather than one applied to
  all six: the renderer was already building its own six-entry map from the
  ABI's eighteen levers, so those levers sat outside tier 2 entirely. And
  `water_level` was a PARAMETER of `nauvis_ctx` rather than a field of it,
  because the renderer pinned it to 0 for #320 while tier 2 had to sweep the
  real value - one field outside the shared wiring, for a reason that was
  itself a tracked defect. #320 is fixed and the parameter is gone. **A
  request carries an off-grid sweep perfectly well**, so nothing about this
  form makes the parity coordinates binary.

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

### Grading things that are not noise expressions

**The placement roll is the first ported thing that is not a noise expression**,
and it is graded differently because of it. There is no per-position fixture:
the game's ground truth is a count per 512x512 region, and scoring one region
costs ~33s in a debug build. So the roll is graded against the game on the
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

**Aquilo is the exception since #492.** It runs the game's own unsalted
stream (`placement/generate.rs`), so its rolled pixels ARE the model, and its
composite is diffed against the game's PNG pixel for pixel. The rule above
still holds for every planet that ships a salted roll.

**The seed trap has its own test.** The preview PNGs come from
`--generate-map-preview --map-gen-seed`, a MAP seed, while every `oracle-*.json`
comes from `sampleExpression`, which forces the SURFACE seed. Rendering with the
map seed makes the Fulgora terrain comparison collapse from 22 differing pixels
(0.002%; it was 3% before the terrain-only re-capture, when the count was mostly
entities) to over 40%, and that is asserted rather than described.

**The composite's paint ORDER is asserted, not described.** Cliffs paint FIRST
and everything else over them, which is the game's own preview order
(`MapPreviewGenerator::Worker::computeEntities` draws the cliff list, then every
other autoplaced entity on top; Factorio 2.1.23). On Vulcanus that is cliffs,
resources, rocks. It was resources, rocks, cliffs until 2026-11-25, the old
TypeScript composite's order, which put a cliff over an ore patch where the game
puts the ore over the cliff. Reordering the passes changes only the pixels where
two of them land, which is invisible to a whole-image bound, and the counts are
frozen exactly.

### Broken rustdoc links are gated, and the PRIVATE view is the one that sees them

`verify:rust` runs `cargo doc` with
`RUSTDOCFLAGS="-D rustdoc::broken_intra_doc_links"` and
`--document-private-items`. It was added in #388, after #387 shipped two broken
links past a fully green gate.

**The reason nothing caught them is that no other tool can.**
`rustdoc::broken_intra_doc_links` is a **rustdoc** lint - not rustc, not clippy
- so `cargo clippy -D warnings` never fires on it, and before #388 the script
ran no rustdoc at all. In #387 a deleted item left the module doc above it
saying the function "now lives here too" and linking to it twice. `verify` was
green locally and all eleven CI checks passed. CodeRabbit surfaced it, and only
indirectly: it asked for a deprecated forwarding wrapper, which is wrong for an
unpublished internal crate whose old behaviour is refuted at 5/39. A wrong
conclusion can still point at the right line.

**`--document-private-items` is load-bearing rather than thorough, and that is
a planted result.** The default view only checks links on PUBLIC items. Of the
11 broken links standing on `main`, 2 were invisible to it - both in
`cliffs/catalog.rs`, on private items. Re-break the link at
`cliffs/catalog.rs:379` and the public view exits **0**, having missed it, while
the gate exits **101**. The crate is `publish = false` with mostly private
internals, so the private view is also the one that matches how it is read.

**It is scoped to that one lint, not `-D warnings`.** Four
`private_intra_doc_links` and four `redundant_explicit_links` warnings stand
deliberately. The first four are public docs in `voronoi_noise.rs` pointing at
private items, which resolve under the flag above; a blanket deny would also let
a future rustdoc release redden untouched code by adding a lint.

**Cost is not a reason to skip it:** 0.67/0.67/0.70s over three cold runs in a
fresh target dir, 0.03s warm. `fmw-noise` has zero dependencies, so `--no-deps`
rustdoc compiles nothing.

Two shapes to know when a link will not resolve. A link to a `#[cfg(test)]` test
function can never resolve in a normal build - 9 of the 11 were this, and the
fix is to drop the brackets and keep the backticks, which leaves the prose
identical. And `Self` means the type of the impl block the doc sits in, not the
type you meant: `trees/field.rs` linked `[Self::eval_at]` from a doc on
`SpeciesField::cheap_from`, while `eval_at` belongs to `TreeFields`.

### `verify:rust`'s cost is a RANGE

Treat it as roughly **6.5 to 8.5 minutes** on CI, not a number - `main`'s four
runs from 2026-09-11 to 2026-09-13 came in at 6m33s, 8m13s, 8m28s and 8m25s,
the same spread the test shards show. A single run measures the runner at least
as much as the job. Do not "correct" this to whichever number you last saw; if a
change really does move it, show it with more than one run.

**This paragraph said 1m45s to 2m50s until 2026-09-13**, which was true when
#219 landed on a nearly empty crate and stayed written down while the frozen
cliff tables and the poison phase grew the job fourfold. It cost a wrong "+8
minutes" verdict on #415's test, whose real CI cost was about two minutes.
`CLAUDE.md`'s Rust section carries the `gh` commands that read the real range
off `main`'s recent runs; use those before judging any PR's cost.

The expensive half is the cliff fixture tests, and each is expensive for the
same reason: under `poison`, `crossing_result` turns every lattice edge into a
crossing, so far more cells place and the `onDestroy` cascade recurses over a
dense set. The connection test measured 33s in the normal arm and 93s poisoned
when this was first written; the removal-geometry test (#415) is 40s and 89s.
They are kept because they are the ONLY grading of `cliffs::connections`, a
module on no render path; without them that port would have unit tests and no
measurement against anything. Anyone adding a fixture test of that shape should
re-measure this job first, and trim it to the regions that carry its errors -
#415 dropped two of four regions that held none, for a third of the cost.

**It runs `bash scripts/verify-rust.sh` directly**, the one place the CI YAML
names a command instead of a package.json script. That does not reopen the drift
rule, because `verify:rust` _is_ that one line. Going through pnpm would add
setup-node and a full install (~28s) to a job that needs no JavaScript. If
`verify:rust` ever grows a second command, the job must become
`pnpm run verify:rust` with the setup steps restored.
