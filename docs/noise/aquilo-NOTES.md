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
is 0 of 1,048,576. What is left is placement:

- **Individual wells and icebergs land in different places from the game's
  preview (#492).** The fields agree, so the suspect is the roll. See "Wells and
  icebergs" below for the numbers.
- **14 of the 180 census icebergs stand on a different land subtype than our
  resolver gives.** All 14 are land against land (snow or ice), and the shore
  agrees for all 199 census entities. The census is a real surface, which runs
  the game's tile correction, and the preview does not (next section), so tile
  correction on real surfaces is the lead. It was not tested.

## The preview runs no tile correction, and shows no well rewrite

Stage 0 measured that the game's preview PNG shows none of the tile correction
pass. The wells have a `created_effect` that rewrites the nearby ocean when a
real surface is generated. On a real surface every well that stands on ocean
reads `snow-lumpy` under it. The preview PNG shows 0 pixels of that rewrite, so
the port does not model it.

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
because the bearings feed the island peaks through the spot fields.

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

**Where each kind may stand.**

- Wells are allowed on every tile. The census has 19 wells (11 crude oil, 4
  lithium brine, 4 fluorine vent). None stood on brash ice, snow-flat or
  snow-patchy, which is too few to prove an exclusion.
- Icebergs are allowed on the six land tiles only. All 180 census icebergs (159
  big, 21 huge) stand on land. Both iceberg prototypes carry `water_tile` in
  their collision mask, and both oceans and brash ice carry it too
  (`tile-collision-masks.lua`, `ammoniacal_ocean()`). The wells declare no
  collision mask of their own.

**The iceberg box rule.** Huge never wins the argmax: big's probability is higher
wherever either is above 0 (swept in 1/1024 steps). So the argmax rule gives big's
2.0 by 1.5 box everywhere, and places 357 icebergs in the census window (tiles
-256 to 255, derived seed, default levers) against the game's 180. The rule in
the port is the huge iceberg's 3.7 by 2.5 box at every tile, as Vulcanus ships
for the same reason (`rocks::vulcanus_placement`). It places **195** against
**180**. It was chosen by comparing counts, not derived. Other rules, same window:
no collision 718, big box plus 3 by 3 tiles on land 234, huge box plus 3 by 3
tiles on land 132. The overlay claims density, not identity: the huge-or-big
split is known wrong, with 0% huge against the game's about 12%.

**The tiny vent.** `aquilo_starting_flourine_vent_tiny` has radius 1 at distance
80, so its probability is 1 at its centre whenever `fluorine_vent` size is above
0. The port places a vent there on every seed.

- It lands on the first in-disk corner in the chunk's decreasing tile order, not
  on the rounded centre. At the derived seed the rounded centre is (-42, -68),
  the placed vent is (-41, -68), and the game's census also has (-41, -68). Our
  model matches the game where the "rounded to its tile" wording would not.
- When the disk straddles a chunk boundary, two vents are drawn. Of 400 seeds
  spread over the 32-bit range, 20 (5%) do. One is pinned: seed 64424508, centre
  (-73.08, -32.54), vents at (-73, -33) and (-73, -32), either side of y = -32.
  The game's behaviour in that case was not captured.
- The census vent at (-40.5, -67.5) has amount exactly 420,000 and sits 78.7
  tiles out, which fits the tiny vent.

**Sizes near spawn.** In the render tests, well sizes of 0.25, 0.5, 2 and 4 move
no well in the 256 window around spawn, and only size 0 does. Frequency moves
only some wells. This is the game's own behaviour, and the Lua explains it. The
window is within 181 tiles of spawn. Out to 260 tiles `aquilo_starting_mask` is
-1, so each spot term `min(mask, spots) * k` is the constant `-k`. The starting
cones have radii of `aquilo_spot_size * 0.8` or `* 0.6`, which the size slider
does not scale. So inside 260 tiles only the `size > 0` gate reads size.

**#492.** The roll uses salts `0x00682f53` (wells) and `0x0027d9c1` (icebergs),
and has no collision across chunks. Against the game's preview, in
the 1024 window at default levers:

| colour | game pixels | our pixels | game pixels with no match of ours within 3 | ours with no game match |
| --- | ---: | ---: | ---: | ---: |
| crude oil | 475 | 295 | 396 | 202 |
| lithium brine | 451 | 444 | 257 | not recorded as a count |
| fluorine vent | 157 | 189 | 130 | not recorded as a count |
| iceberg | 4,609 | 4,716 | 122 | 777 |

The census window also has 24 wells placed by us against the game's 19 (8, 10
and 6 against 11, 4 and 4). The wells and the fields are not in doubt; individual
positions differ. This is the open follow-up. The spec freezes only our own
pixel counts and the game-unmatched counts in the table. The "ours with no game
match" column (202 of 295 crude, 777 iceberg) was measured once and is not
frozen.

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

