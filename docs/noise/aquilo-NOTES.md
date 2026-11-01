# Aquilo - measured findings

Working notes for the Aquilo port (#454, Stage 1). **Every claim here states how
it was measured.** Where a number comes from a frozen test, the test is named.
The summary of what is frozen is in `docs/rust-wasm-port.md`, under "Aquilo
(#454)"; this file keeps the reasons.

Source Lua: `space-age/prototypes/planet/planet-aquilo-map-gen.lua` and
`space-age/prototypes/decorative/decoratives-aquilo.lua`, read at **2.1.23**. The
fixtures were captured at 2.1.23 and 2.0.77, and every value is bit-identical
between them. Seeds: tier-1 captures FORCE the surface seed to 123456. Anything
compared with a preview PNG uses the DERIVED Aquilo surface seed 3111923328 (map
seed 123456).

Aquilo was ported Rust-first. There is no TypeScript version, so tier 1 (against
the game) and tier 3 (against the preview PNGs) carry the grading.

## Where the counts are not full, and what is left

Every tier-1 field is a full house in all three lever cases, and the terrain gap
is 0 of 1,048,576. Since #492 (2026-10-31) placement is full too:

- **Wells and icebergs come from the game's own per-chunk entity generator.**
  Our composite matches the game's full preview PNG on every pixel inside a
  4-pixel border, and 3 pixels differ at the bottom edge. Replayed on the
  game's real-surface land, the same generator places 209 of 209 entities of a
  real surface at the game's positions. See "Wells and icebergs" below, and
  `entity-generation-NOTES.md` for the generator itself.
- **What is left:** the 3 edge pixels (one huge iceberg whose box reaches past
  the capture; the explanation is a lead, not read from code), and the gaps
  listed under "Not ported" below.

**The 14 census icebergs on a different land subtype.** Before #492, 14 of the
180 census icebergs stood on a different land subtype than our resolver gives
(snow against ice, all land against land; the shore agreed for all 199 census
entities). The census is a real surface, which runs the game's tile correction,
and the preview does not (next section). Tile correction is still the leading
explanation for the subtypes. It was not checked directly: the new real-surface
fixture records land against water only. What #492 did show is that tile
correction matters for placement through the SHORE, not the subtype. Every land
tile spends an iceberg draw, so a moved shore shifts the stream, while snow
against ice changes nothing.

## The preview runs no tile correction, and shows no well rewrite

Stage 0 measured that the game's preview PNG shows none of the tile correction
pass. The wells have a `created_effect` that rewrites the nearby ocean when a
real surface is generated. On a real surface every well that stands on ocean
reads `snow-lumpy` under it. The preview PNG shows 0 pixels of that rewrite, so
the port does not model it.

The preview also runs no entity-against-entity collision (measured in #492,
see "Wells and icebergs"). So the preview and a real surface differ in two
ways that touch placement: the tiles (tile correction) and the collision step.

That is why the census needed a second arm. It strips the wells' `created_effect`
in the data stage and records `tileWithoutEffect`, the tile before the rewrite.
Of 19 census wells, 9 stand on ammoniacal ocean before the rewrite. Read
`tileWithoutEffect`, never `tile`.

## The size-0 levers reshape the islands

The terrain PNG was captured with all three resource controls (`crude_oil`,
`lithium_brine`, `fluorine_vent`) at size 0. Those controls are not only about
the wells: the island peaks read the spot fields, so the levers change the
shapes of the islands.

- Rendered at neutral levers, the terrain view differs from the terrain PNG in
  **13,194** pixels. At size 0, matching the capture, it differs in **0**.
- With lithium brine at size 0 in the app, several islands shrink or vanish
  (seen in a headless browser, not measured by pixel count).
- A preset with no Aquilo controls at all (any imported string from before
  Aquilo) renders at neutral levers, 1 and 1, not size 0.
- Comparing with the full PNG (the one with wells and icebergs drawn) uses
  default levers, all 1.
Frozen in `test/wasmAquiloRenderParity.spec.ts`: 0, and the 13,194 control.

## The bearings

Aquilo's starting cones and well spots sit on three bearings:

- The base is `f32(seed_normalized * 3600)` degrees, where `seed_normalized` is
  the surface seed divided by 2^32. At forced seed 123456 that is
  123456 / 2^32 = 2.87e-5, and the capture reads the resulting `aquilo_angle` as
  0.10347962 degrees.
- The second and third are the base plus 120 and plus 240, each step narrowed to
  f32.
- The sine and cosine of each cross the ABI as values computed in V8
  (`aquiloBearingTrig`), never in the module (#270). The Python checker
  reproduces them for these three angles (see `verify-wasm-request.py`).

A planted swap of two of the three bearings in the renderer turned 12 of the 26
render tests red: the terrain gap went 0 to 1,189 and the full-PNG tiles 0 to 554,
because the bearings feed the island peaks through the spot fields. (Measured
before #492, when the full-PNG test graded the terrain view with entity pixels
masked. Not re-run since.)

## The game's cone arithmetic

The spot fields were short of full (568, 568 and 561 of 632 at default) until
the cone arithmetic was read from the 2.1.23 Linux binary with `objdump`. The
differences are the double `3.1416` for pi (at `.rodata` `0xffc028`), a single
narrowing of the peak, and an f32 distance. The details, the plants, and the
Vulcanus consequence (#491) are in `spot-noise-NOTES.md`, under "The shared Rust
module".

## `AmplitudeCorrectedGame`

`random_island_peaks` uses `amplitude_corrected_multioctave_noise`. With the
shipped form, the elevation scored 608, 434 and 602 of 632, 452 and 626 (and
911 of 1024 on the Stage 0 fixture). The game's form has an f32 persistence
(`f32(0.8)` in the Horner step) and folds the `output_scale` transform in f32 in
the Lua's order, `((1 - p) / 2^n) / (1 - p^n) * amplitude`, where `p^n` is the
f64 `powf` of the f32 `p`, narrowed. On the 152-point wrapper fixture the game's
form scores 152/152 and the shipped one 81. Using the noise machine's
square-and-multiply `pow` instead of `powf` gave 901 of 1024 on Aquilo. This is
the new type `AmplitudeCorrectedGame`. Nauvis keeps the shipped form, and the
finding is posted on #254.

## The `aquilo-cracks` seed

The `tri_crack` Voronoi field uses the string seed `'aquilo-cracks'`. A string
seed is the CRC-32 of its UTF-8 bytes: `crc32("aquilo-cracks")` is
1,475,573,916, or `0x57F3789C`. It is written as a constant with the name and
the hex beside it, as `fulgora_elevation.rs` does. The large and small Voronoi
fields are domain-warped, so they are evaluated at a point; the plain fields
are evaluated on the chunk grid.

## Every constant is an f32 slot

Constants in a noise expression narrow to f32 one operation at a time. Two
places paid for it:

- The wobble fields scored 144 and 99 of 632 with `output_scale` `0.35` as a
  double, and 632 with `f32(0.35)`.
- Four tile-score constants (`0.01`, `0.05`, `0.4`, `0.6`) did the same:
  snow-patchy 1018, brash ice 835 and both oceans 756 of 1024 as doubles, then
  full. (`0.75` is exact in binary, so narrowing it changes nothing.)

## The nine tiles

The tiles, in tie order: `snow-flat`, `snow-crests`, `snow-lumpy`,
`snow-patchy`, `ice-rough`, `ice-smooth`, `brash-ice`, `ammoniacal-ocean`,
`ammoniacal-ocean-2`. The six land tiles are the four snow tiles and the two ice
tiles. `ice-rough` and `ice-smooth` share one colour in the PNG.

- Nine scores, one winner. The first maximum wins and a NaN loses, copied from
  Fulgora's rule. The game's own tie rule is NOT established: the fixtures hold
  0 ties. The two oceans do tie exactly where `aux` is 0.5, but no capture has
  that point.
- Scores: 1024 of 1024 on the Stage 0 fixture, and 632, 452 and 626 in the
  three cases, for the scores and for the winner. All nine tiles win somewhere
  (asserted).
- The colours are the game's `map_color` values, truncated to whole numbers, not
  rounded. `snow-crests` reads (179, 185, 192) from 179.8, 185.6 and 192.2, and
  `snow-lumpy` (166, 174, 185) from 166.2, 174.4 and 185.8. Crude oil's 198 from
  198.9 shows the same.

## Wells and icebergs

**How they are placed (#492, 2026-10-31).** By the game's own per-chunk entity
generator, `EntityMapGenerationTask::generateEntities`, read from the 2.1.23
Linux headless build (DWARF) and written up in `entity-generation-NOTES.md`. The
code is `crates/fmw-noise/src/placement/generate.rs` (the model) and
`placement/aquilo.rs` (Aquilo's five autoplacers). In short: one taus88 stream
per chunk, seeded from the chunk position only (no map seed, no salt), shared
by five autoplace groups in `order`: fluorine vent, lithium brine, huge
iceberg, big iceberg, crude oil. Each group arbitrates its tiles from -inf, so a
tile with probability 0 still draws. Icebergs take two jitter draws per
success, before the box tile check. The old salted roll and its salts
(`0x00682f53` wells, `0x0027d9c1` icebergs) are deleted.

**Where each kind may stand.** Both rules below are now read from the
prototypes and confirmed by the 209/209 replay, not only counted.

- Wells are candidates on every tile. Their `collision_mask` is `{resource}`,
  and no Aquilo tile carries that layer: `ammoniacal_ocean()` comments it out
  (`tile-collision-masks.lua`). So each well group spends 1,024 draws per
  chunk. The census has 19 wells (11 crude oil, 4 lithium brine, 4 fluorine
  vent); 9 stand on ocean before the wells' tile rewrite.
- Icebergs are candidates on the six land tiles only. Both iceberg prototypes
  carry `water_tile` in their collision mask, and both oceans and brash ice
  carry it too. All 180 census icebergs (159 big, 21 huge) stand on land. The
  whole box must cover land as well.

**The real surface: 209 of 209.**
`aquilo_real_surface_replay_places_every_entity_the_game_did` (`fixtures.rs`)
replays the generator over the 289 chunks of a real surface
(`test/fixtures/oracle-aquilo-surface.seed123456.json`, from
`scripts/probes/aquilo-entity-stream`). It uses our probability fields and the
game's own land and water, then applies each chunk's queue with entity
collision. Every one of the game's 209 entities is placed at its position, to
the 1/16 tile, and nothing else. Two apply rules were measured there: boxes
that only touch collide (the strict-overlap control fails), and chunks apply
row-major. A spiral order gave 206 and the reverse order 191 in a scratch
simulator.

The game's own land is needed because a real surface runs tile correction and
our resolver does not. It moves the shore: about 136 land/water flips against
our tiles in the 640 by 640 window. On our tiles, only 60 of the census's 159
big icebergs matched in the scratch simulator, which is how tile correction
was found to matter.

**The preview: every pixel.** The preview runs no tile correction, so on our
tiles (the preview's tiles) the generator reproduces the game's full preview
PNG. The preview draws by its own rule, measured against the PNG and not read
from code: no entity-against-entity collision, each entity drawn as the tiles
`floor(left)` to `ceil(right) - 1` (the high edge is exclusive), clipped to its
own chunk, and the first queued wins an overlap. "matches the full PNG on
every pixel" (`test/wasmAquiloRenderParity.spec.ts`) freezes **0 differing
pixels inside a 4-pixel border and 3 at the edge**, out of 1,048,576:

| colour | game pixels | our pixels |
| --- | ---: | ---: |
| crude oil | 475 | 475 |
| lithium brine | 451 | 451 |
| fluorine vent | 157 | 157 |
| iceberg | 4,609 | 4,612 |

The 3 extra iceberg pixels are one huge iceberg at (211.375, 511.6875), whose
box reaches tile row 512, one past the capture. The game did not draw it. The
leading explanation is that the preview has no tiles past its own area, so the
generator's tile check finds no ground there. That was seen once and not read
from code. The other 3 of our entities that cross the capture edge are hidden
under neighbours, so they cannot test it.

Because each entity is drawn only inside its own chunk, a pixel depends on one
chunk's queue. So a tiled render needs no halo, and the ABI's Aquilo
`placement_sweep_box` is no longer read (the slot stays so the layout does not
move). The tiling test cuts tiles through the middle of chunks and still
matches the whole render byte for byte.

**Huge against big icebergs (superseded rule kept for the record).** Huge never
wins an argmax: big's probability is higher wherever either is above 0 (swept
in 1/1024 steps). Before #492 this forced a box rule chosen by count: the huge
iceberg's 3.7 by 2.5 box at every tile placed 195 against the game's 180 in the
census window, with 0% huge against the game's about 12%. Other rules in that
window were: big box 357, no collision 718, big box plus 3 by 3 tiles on land
234, huge box plus 3 by 3 tiles on land 132. **The game never arbitrates huge
against big.** They are separate `order` groups, huge first, and big fills the
gaps at apply time. That gives the game's mix: 22 huge of 190 icebergs on the
real surface, all placed by the replay. The same mechanism should explain
issue #22 item 1 (Vulcanus and Nauvis place 20-30% huge rocks that never win
an argmax), but it has not been re-run on those planets.

**The tiny vent.** `aquilo_starting_flourine_vent_tiny` has radius 1 at
distance 80, so its probability is exactly 1 on every integer tile corner
inside its unit disk whenever `fluorine_vent` size is above 0. At least one
corner is always inside, and probability 1 always passes its roll.

- The generator queues a vent on every in-disk corner its chunk reaches. A
  real surface keeps only the first in queue order; the others' 2.8-tile boxes
  overlap it and are dropped at apply. The preview has no collision step, so
  it draws them all.
- At the derived seed the cone centre is (-41.94, -68.13). The rounded centre
  would be (-42, -68), but (-41, -68) comes first in the chunk's decreasing
  tile order. The game's census has its vent at (-40.5, -67.5), the centre of
  (-41, -68), and no other vent within 50 tiles of spawn. Pinned by
  `the_tiny_vent_lands_where_the_game_puts_it` (`fixtures.rs`).
- `the_tiny_vent_is_queued_on_every_seed` (`placement/aquilo.rs`) checks five
  seeds, and `a_zero_fluorine_size_removes_the_tiny_vent` is its control.
- Superseded: before #492 the port drew one vent per chunk the disk touched,
  and 20 of 400 seeds (5%) drew two, for example seed 64424508 at (-73, -33)
  and (-73, -32). Under the generator those are still two queued vents in two
  chunks, and the preview draws both. A real surface keeps whichever its chunk
  order applies first. The game's preview for such a seed was not captured.
- The census vent at (-40.5, -67.5) has amount exactly 420,000 and sits 78.7
  tiles out, which fits the tiny vent.

**Not ported, each unreachable today** (details in `entity-generation-NOTES.md`):

- The richness slider is not passed to the engine. A well places only where
  its richness is above 0. The app's smallest step is 1/6, so richness is
  always above 0. **An imported string with an Aquilo richness of 0 would draw
  wells the game does not place.**
- `placement_density` (no entity sets it), grid snapping (`buildPosition`; no
  Aquilo entity needs it), the richness tie-break inside a group of more than
  one prototype (every Aquilo group has one; `generate_chunk` refuses a
  bigger group), and `tile_restriction` (no Aquilo entity declares one).
- No Aquilo slider can drop a group, read from the 2.1.23 data. The game
  drops a group only through the autoplace spec's own `control`, and none of
  the five has one: the wells' is commented out in `resource-autoplace.lua`
  (`:137`) and the icebergs' tables hold only `order` and the probability. So
  size 0 sets the probability to 0 and the group still draws, as the port
  does. `entity-generation-NOTES.md` has the line references.

**Sizes near spawn.** In the render tests, well sizes of 0.25, 0.5, 2 and 4 move
no well in the 256 window around spawn, and only size 0 does. Frequency moves
only some wells. This is the game's own behaviour, and the Lua explains it. The
window is within 181 tiles of spawn. Out to 260 tiles `aquilo_starting_mask` is
-1, so each spot term `min(mask, spots) * k` is the constant `-k`. The starting
cones have radii of `aquilo_spot_size * 0.8` or `* 0.6`, which the size slider
does not scale. So inside 260 tiles only the `size > 0` gate reads size.
(Measured before #492 with the salted roll. The generator reads the same
fields, so the claim carries over, but it was not re-measured.)

**Before #492, for contrast.** The old roll used salts `0x00682f53` (wells) and
`0x0027d9c1` (icebergs), one stream each, with no jitter, no shared stream and
no collision across chunks, and painted 3x3 marks. Against the game's preview,
in the 1024 window at default levers:

| colour | game pixels | our pixels | game pixels with no match of ours within 3 | ours with no game match |
| --- | ---: | ---: | ---: | ---: |
| crude oil | 475 | 295 | 396 | 202 |
| lithium brine | 451 | 444 | 257 | not recorded as a count |
| fluorine vent | 157 | 189 | 130 | not recorded as a count |
| iceberg | 4,609 | 4,716 | 122 | 777 |

The census window had 24 wells placed by us against the game's 19 (8, 10 and 6
against 11, 4 and 4). The fields were right and the stream was not. The spec
that froze this table as a fingerprint was replaced in #492 by the
every-pixel test above.

## Other measured facts

- The thin spots in tier 1: where a spot field is above 0 beyond the starting
  mask, only 5 to 18 positions per field per case are graded, and the starting
  mask is off its clamps at only 21, 13 and 22 positions in the three cases.
  Those are quotas the capture set, not something the port chose.
- Fluorine size 1/6 reads back as 0.1666666716337204 (f32 of 1/6). The port uses
  the read-back values from the capture.
- The window that grades a field must hold the thing it grades. At tier 2, the
  first window folded a constant on 8 of 28 fields at default levers; the extra
  windows fixed that.

