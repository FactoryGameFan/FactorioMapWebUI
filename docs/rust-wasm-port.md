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

**Every planet, every view the panel offers, renders through the engine.** The
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

**One TypeScript file in a ported directory was kept for a reason that is not
obvious.** `cliffConnections.ts` has zero consumers of any kind since #360
deleted the 23 investigation specs that imported it. It is the human-readable
reference `crates/fmw-noise/src/cliffs/connections.rs` cites as its source, so
that #84's cliff investigation can still be run against the engine. The
type-checker still covers it, because `tsconfig.json` includes `src/**/*` by
glob rather than by reachability.

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
- **Depth beats everything.** Nauvis `temperature` is bit-exact because it is
  one `quick_multioctave_noise` and a clamp with nothing beneath it.
  `elevation_nauvis` is the weakest Nauvis count because it stacks three layers
  and carries every unported narrowing at once. Read the spread by depth, not as
  a ranking.
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

Two harness compensations went with that work, and both are worth copying.
`checksum_variable_persistence` crossed the ABI as an f32, so the spec narrowed
its own value with `Math.fround` first - making the two sides agree by
construction on exactly the term that differed. Both are f64 now. And
`p ** octaves` is **`powf`, not `powi`**: `powi` disagrees with V8 by one ULP at
0.7^4, 0.7^6 and 0.7^8, and one ULP there flips the f32 rounding of the octave
gain, which moves every point in the case.

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
| Fulgora  | 64    | 120     |
| Nauvis   | 512   | 568     |
| Vulcanus | 312   | 368     |

**Nauvis is the largest, so `REQUEST_BYTES` is 568.** Do not quote that table
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
`:size`), and Nauvis's six times (64 -> 96 -> 144 -> 160 -> 232 -> 376 -> 512,
the last of them #339 appending the spawn list).
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

`test/fixtures/wasm-request.v2.json` pins the encoding for all three planets. It
is declared under `notFixtures` because it is our own ABI rather than Factorio
ground truth, and its bytes are checked by
`test/fixtures/verify-wasm-request.py` - **a third implementation, not the
writer under test** - so a future version is re-verified the same way rather
than regenerated from the encoder.

Two lessons from that checker, and both generalise past it:

- **A property check is not a structural check.** The checker cannot reproduce
  the trig values, since those are V8's `Math.sin` after an f32 narrowing, so it
  checked each pair for `sin^2 + cos^2 = 1` instead. That property **passed a
  planted swap of two bearings** - rendering a plausible planet with its biomes
  rotated - because a property is invariant under permutation. It now also
  recovers each angle with `atan2` and checks it against the offset the game's
  Lua gives it. **Ask what your property is invariant under, and plant that.**
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

**The seed trap has its own test.** The preview PNGs come from
`--generate-map-preview --map-gen-seed`, a MAP seed, while every `oracle-*.json`
comes from `sampleExpression`, which forces the SURFACE seed. Rendering with the
map seed makes the Fulgora terrain comparison collapse from 3% differing to over
40%, and that is asserted rather than described.

**The composite's paint ORDER is asserted, not described.** On Vulcanus:
resources, then rocks, then cliffs - so a cliff or a rock crossing an ore patch
reads as the thing that is in the way. Reordering the three passes changes only
208 of 16,384 pixels in the window that grades it, which is invisible to a
whole-image bound, and it is frozen exactly.

### `verify:rust`'s cost is a RANGE

Treat it as roughly **1m45s to 2m50s**, not a number. Three CI runs on code
whose Rust half was equivalent came in at 1m44s, 2m48s and 2m49s, and that is
the same spread the test shards show. A single run measures the runner at least
as much as the job. Do not "correct" this to whichever number you last saw; if a
change really does move it, show it with more than one run.

The expensive half is the cliff connection fixture test - 33s in the normal arm
and 93s under poison, because `crossing_result` turns every lattice edge into a
crossing, so far more cells place and the `onDestroy` cascade recurses over a
dense set. It is kept because it is the ONLY grading of `cliffs::connections`, a
445-line module on no render path; without it that port would have unit tests
and no measurement against anything. Anyone adding a second fixture test of that
shape should re-measure this job first.

**It runs `bash scripts/verify-rust.sh` directly**, the one place the CI YAML
names a command instead of a package.json script. That does not reopen the drift
rule, because `verify:rust` _is_ that one line. Going through pnpm would add
setup-node and a full install (~28s) to a job that needs no JavaScript. If
`verify:rust` ever grows a second command, the job must become
`pnpm run verify:rust` with the setup steps restored.
