# Cliffs (M4) - reverse-engineering notes

> ## STATUS, 2026-08-01: both planets validated; issue #18 is CLOSED
>
> | | recall | precision | wrong orientation |
> | --- | --- | --- | --- |
> | **Nauvis** | 1.0000 | 1.0000 | **0 / 334** |
> | **Vulcanus**, as shipped | **0.9720** | **0.9713** | ~2.4% |
> | **Vulcanus**, no lava rejection | 0.9758 | 0.8719 | 37 / 1531 = 2.4% |
>
> The shipped row went 0.9675 -> 0.9758 -> **0.9720** in one day as the collision
> box was corrected twice. The middle value came from a 45-degree oriented-box
> model (#88) that scored best and was **wrong**; disassembly showed the engine
> discards the box's orientation tag entirely. Do not "restore" the better
> number - see `## The collision box, settled by disassembly` in
> `vulcanus-cliffs-NOTES.md`.
>
> **Read the shipping row.** The renderer applies `tryToAddCliff`'s lava-collision
> rejection and the second row does not; leaving it off is what produced the
> "precision 0.872 / 187-cell excess" figure #84 opened with. The rejection drops
> 198 cells, **185 of them false positives and 13 true**, so almost the whole
> excess was a rule the measurement was not applying. Measured 2026-08-01 in
> `test/vulcanusCliffEntities.spec.ts`; the no-rejection row is kept because
> `test/cliffOrientationOracle.spec.ts` deliberately scores the larger set.
>
> What is left on Vulcanus: 38 of the game's 1569 missing and 43 of our 1574
> spurious. **The 13 that used to be a "TILE question" were neither** - not the
> lava mask (a dense 994-position capture found ZERO mismatches) but the
> collision box, which the port had collapsed from `rotbb`'s rotated rectangle to
> its bounding box. Fixed; see `## The lava perimeter was the COLLISION BOX` in
> `vulcanus-cliffs-NOTES.md`. Remainder in **#84**.
>
> **Read `## ROOT CAUSE, 2026-08-01` (further down) before anything else in this
> file.** It is the resolution of issue #18: `multisample`'s offsets are in the
> calling noise program's GRID UNITS, not tiles, so the cliff generator and the
> tile generator read genuinely different elevation fields.
>
> **Everything between here and that section is the investigation record.** Its
> measurements stand and are worth reading for method; its *conclusions* are
> superseded, several of them within hours of being written. Do not act on a
> number from those sections without checking it against this banner - in
> particular the `~90%` in the next heading, the 12.5% / 29.8% / 8.1% / 11.7%
> orientation-error tables, and the 0.806 / 0.938 / 0.853 recalls all describe the
> port BEFORE the fix.

Factorio 2.1.11 (build 86962, mac-arm64). Measured 2026-07-20 against the headless
oracle (`test/oracle/oracle.ts` `sampleExpression` for the noise fields; a
`find_entities_filtered{type="cliff"}` chunk-forced dump for placement) and the
non-stripped shipped binary (disassembly). Companion to `enemy-bases-NOTES.md`,
`placement-roll-NOTES.md`, `basis-noise-NOTES.md`. Source Lua: `~/GitHub/factorio-data`
@ tag `2.1.11`, `core/prototypes/noise-programs.lua` (cliff expressions),
`base/prototypes/entity/entity-util.lua` (`scaled_cliff`, the cliff entity),
`base/prototypes/planet/planet-map-gen.lua` (Nauvis `cliff_settings`).

Key strategic finding: **cliff placement is deterministic** - there is NO per-chunk
RNG roll (unlike the deferred M3.5 resource stipple / M4 per-nest placement). It is a
pure function of two noise fields plus the interval/elevation_0 settings, so a
faithful render does not touch the deferred `EntityMapGenerationTask` placement RNG.

## The two noise fields (verbatim, `noise-programs.lua`)

```
cliff_elevation_nauvis = 10 + 30 * (nauvis_hills - nauvis_hills_cliff_level)

cliffiness_nauvis = (main_cliffiness >= cliff_cutoff) * 10       -- a 0-or-10 gate

main_cliffiness = min( base_cliffiness, forest_path_cliffiness, bridge_path_cliffiness,
                       elevation_cliffiness, starting_area_cliffiness, 4*low_frequency_cliffiness )
  base_cliffiness          = (nauvis_cliff_ringbreak - 0.01) * 60
  forest_path_cliffiness   = (forest_path_billows   - 0.03) * 12
  bridge_path_cliffiness   = (nauvis_bridge_billows  - 0.05) * 15
  elevation_cliffiness     = (elevation_nauvis_no_cliff - 4) / 2
  starting_area_cliffiness = -2 + distance * segmentation_multiplier / 120
  low_frequency_cliffiness = 1.5
     + basis_noise{ seed0=map_seed, seed1=86883, input_scale=nauvis_segmentation_multiplier/500, output_scale=0.51 }
     + min( slider_to_linear(cliff_frequency, -1.7, 1.7), slider_to_linear(cliff_richness, -1, 1) )
  cliff_cutoff    = 2 * cliff_gap_size^1.5
  cliff_gap_size  = 0.5 - 0.5 * slider_to_linear(cliff_richness, -1, 1)
  cliff_frequency = 40 / cliff_elevation_interval     -- effective interval (post getModified*)

slider_to_linear(v, lo, hi) = lo + 0.5*(hi-lo)*(1 + log2(v)/log2(6))

nauvis_cliff_ringbreak = abs(nauvis_hills - nauvis_hills_offset)
nauvis_hills_offset    = abs(multioctave_noise{ x = x + 12*nauvis_hills_offset_normalized_x,
                                                y = y + 12*nauvis_hills_offset_normalized_y,
                                                persistence=0.5, seed0=map_seed, seed1=900, octaves=4,
                                                input_scale=nauvis_segmentation_multiplier/90 })
nauvis_hills_offset_raw_x = basis_noise{ seed1='nauvis_offset_x', input_scale=nauvis_segmentation_multiplier/500 }
nauvis_hills_offset_raw_y = basis_noise{ seed1='nauvis_offset_y', input_scale=nauvis_segmentation_multiplier/500 }
normalize(a, b, bias)     = a / sqrt(bias + a^2 + b^2)          -- bias 0.001
nauvis_hills_offset_normalized_x = normalize(raw_x, raw_y, 0.001)   -- and _y swaps the args
```

### String-seed resolution (`'nauvis_offset_x'` / `'nauvis_offset_y'`) - SOLVED

Factorio hashes a **string** `basis_noise` `seed1` to a u32 with **standard zlib/ANSI
CRC32** (polynomial `0xEDB88320`) - bit-identical to the app's existing
`src/codec/crc32.ts`. Confirmed two ways (2026-07-20 spike):

- Binary: the shipped arm64 slice carries Stephan Brumme's "Fast CRC32" suite
  (`crc32_fast/_1byte/_4bytes/...`) and a `_Crc32Lookup` table at vmaddr
  `0x102f24490` whose first entries (`0, 0x77073096, 0xee0e612c, ...`) are the
  standard zlib table.
- Oracle: `basisNoise(x, y, basisNoiseTablesFromSeed(seed0, crc32(name)))` matches
  the game's `basis_noise{seed1='<name>'}` to ~1e-7 (the fastapprox floor) at 12
  points x 2 seeds; alternative hashes (djb2/fnv1a/sdbm) were fully uncorrelated.

So `seed1(name) = crc32(utf8Bytes(name))`, seed0-independent:

```
crc32("nauvis_offset_x") = 593691028   (0x2360A1D4)
crc32("nauvis_offset_y") = 1415852290  (0x5460AAC2)
```

The port computes these via the existing `crc32` (or hardcodes the two constants
with this note as the source).

**Confirmed (Task 11, 2026-07-20):** `NAUVIS_OFFSET_X_SEED1 = 593691028` /
`NAUVIS_OFFSET_Y_SEED1 = 1415852290` are exactly `crc32("nauvis_offset_x")` /
`crc32("nauvis_offset_y")` as above, and remain oracle-validated end-to-end - the
whole cliff placement pipeline that depends on them (via `nauvis_hills_offset_raw_x/y`
-> `nauvis_hills_offset_normalized_x/y` -> `nauvis_hills_offset` ->
`nauvis_cliff_ringbreak` -> `base_cliffiness`) reproduces the real game's
`find_entities` cliff positions to the frac given below, so no separate standalone
regression on the two constants was needed.

Already ported (reuse `src/noise/expressions/nauvisShared.ts`): `nauvis_hills`,
`nauvis_hills_cliff_level`, `forest_path_billows`, `nauvis_bridge_billows`. New:
`elevation_nauvis_no_cliff` (= `elevation_nauvis_function(0)`, i.e. the elevation
tree with `added_cliff_elevation=0` - needs the `makeElevationNauvis` seam
refactor), the offset/ringbreak chain (string seeds `'nauvis_offset_x/y'`), the seed
86883 `basis_noise`, and `slider_to_linear`. **No `VoronoiNoise`** anywhere in the
Nauvis cliff tree (it appears only on Space-Age planets).

## Placement rule (disasm-confirmed; see the STATUS banner for current accuracy)

Reverse-engineered from the non-stripped binary and validated against a real
`find_entities_filtered{type="cliff"}` dump (chunk-forced generation, default preset).

### `crossesCliff(a, b, cliffinessAvg, elevation_0, interval)` @ `0x101606d08`

```
if a < 0 or b < 0: return 0
boundary = elevation_0 + interval * floor((max(a,b) - elevation_0) / interval)   -- frintm: floor to -inf
if boundary < elevation_0: return 0
dA = a - boundary; dB = b - boundary
if cliffinessAvg > 0.5:                    -- gate is > 0.5 (NOT > 0); the arg is an AVERAGE
   if dA < 0 and dB > 0: return +1
   if dA > 0 and dB < 0: return -1
return 0
```

Corrections vs the initial symbol-only guess: band index is
`floor((elev - elevation_0)/interval)` with `elevation_0` a subtracted phase (no
half-offset); both elevations must be `>= 0`; `max(a,b) >= elevation_0`; the gate
compares the **average** of the two corners' cliffiness to `0.5`. Because
`cliffiness_nauvis in {0,10}`, `avg > 0.5` == "at least one corner cliffy". Return is
signed (+1/-1/0); encode -1 as 3 for the orientation code.

The inlined copy inside `crossingsForChunk` (`0x101606dc0`, `0x101607460`+,
`0x1016075c0`+) forms `s3 = (cliffiness[A] + cliffiness[B]) * 0.5` before the call.

### The lattice (the placement half is exact; the SAMPLE half was wrong until #70)

`grid_size = {4,4}`, `grid_offset = {0, 0.5}` (from `scaled_cliff`). A 32-tile chunk
= `8x8` cells of `4x4` tiles; fields sampled at the `9x9` cell corners; the entity is
placed at the cell **center**:

```
corner(i,j)  world tile = ( chunkX*32 + i*4 + 0,  chunkY*32 + j*4 + 0 )
cliff center world tile = ( chunkX*32 + cx*4 + 2, chunkY*32 + cy*4 + 2.5 )   -> x≡2, y≡2.5 (mod 4)
```

**The corner line above read `j*4 + 0.5` until 2026-07-30, and that was the bug
fixed in #70** - `grid_offset` is a CENTRE offset and `crossingsForChunk` never
reads it. See "Validation result: EXACT since 2026-07-30" below for the evidence
and for why the mod-4 check in the next paragraph stayed green throughout: the
error moves no placed cliff. The heading used to claim "confirmed 100% exact",
which was true of the centres and silent on the sample sites.

Every dumped cliff across both test seeds matched `x mod 4 == 2` and `y mod 4 == 2.5`
exactly. (`generateCliffs` @ `0x10161cda8`, constants `32.0`, `grid_size/2=2.0`,
`grid_offset` from `[proto+0xb70/0xb78]`.)

### Cell -> cliff (orientation code)

For cell `(cx,cy)` the four edges are the crossings on its shared corner pairs:
`L=cross(corner(cx,cy),corner(cx,cy+1))`, `R=cross(corner(cx+1,cy),corner(cx+1,cy+1))`,
`T=cross(corner(cx,cy),corner(cx+1,cy))`, `B=cross(corner(cx,cy+1),corner(cx+1,cy+1))`.
`generateCliffs +292..+308` packs `code = (enc(L)<<6)|(enc(R)<<4)|(enc(T)<<2)|enc(B)`
(2 bits each, -1 encoded as 3). `CellCliffCrossing::toMaybeCliffOrientation`
maps the 256 codes -> a `CliffOrientation` or "none". A cell whose code maps to
non-none gets a cliff.

**Corrected 2026-07-30, twice.** There are **20** orientations, not 16, and the
render needs more than the boolean: the game rejects a cliff whose orientation's
collision box hits the wrong tile (see "The collision rejection" below), and that
box is per-orientation. The full `code -> CliffOrientation` map and the 20
collision boxes now live in `cliffCatalog.ts` as `CLIFF_CODE_TO_ORIENTATION` /
`CLIFF_ORIENTATION_COLLISION_BOX`, pinned by `test/cliffOrientation.spec.ts`.

The id was recoverable all along and was simply not read: the function returns one
64-bit word whose **low** 32 bits are the tri-state (2 = real, 1 = none, 0 = empty
cell) and whose **high** 32 bits are the orientation id. `CLIFF_PLACING_CODES` was
extracted from the low word only.

Also note the address above (`0x1016067a0`) is from the build this file was first
written against; under 2.1.12 the symbol is at `0x10160c3ac`. Re-derive from `nm`.

### The collision rejection - PORTED 2026-07-30 (PR #73), and it is half of issue #18

`EntityMapGenerationTask::tryToAddCliff` (`0x101625038` in 2.1.12) does not just
record the cell. It switches on the `CliffOrientation` (a 20-entry jump table),
loads that orientation's `collision_bounding_box` from `proto + 0x5c0 + id*0x48`,
and calls

```
EntityMapGenerationTask::wouldCollide(BoundingBox const&, CollisionMask const&,
                                      MapPosition, Direction)      // 0x101625468
```

with the prototype's own collision mask at `proto + 0x2b0` and `Direction = 0`. On
a hit it returns false and **the cliff is never added.**

`wouldCollide` converts the box to tile indices with `(box + position) >> 8`
(`MapPosition` is 8-bit fixed point, so an arithmetic floor) and scans the
**inclusive** rectangle `[left..right] x [top..bottom]` over a 96x96 per-tile mask
grid (`this + 0x90`, origin at `[+0x4890]`/`[+0x4894]`, one u16 index into a
0x20-byte `CollisionMask` table at `0x103711118`), ANDing each tile's mask with the
entity's. It reads tiles only - `tryToAddCliff` never writes that grid - so the
rejection is **order-independent**, which is what makes it portable to a
per-cell renderer at all.

Which tiles collide follows from the masks. The cliff mask holds `water_tile`;
`tile_collision_masks.lava()` sets `water_tile = true`, and on Vulcanus `lava` and
`lava-hot` are the only tiles that do. So on Vulcanus this rule reads "no cliff
whose collision box touches lava", and on Nauvis "…touches water" - which is why
it was invisible there: `test/cliffResidual.spec.ts` already found that no Nauvis
cliff touches water at all.

Measured 2026-07-30 against `oracle-vulcanus-cliff-entities.seed123456`, applying
the rule with the real per-orientation boxes and our own tile resolver:

| region | ratio | precision | recall | rejects TP / FP |
| --- | --- | --- | --- | --- |
| `[0,0]` | 1.184 -> 1.120 | 0.681 -> 0.700 | 0.806 -> 0.784 | 6 / 12 |
| `[1500,1500]` | **1.203 -> 1.003** | **0.779 -> 0.930** | 0.938 -> 0.933 | 4 / **173** |
| `[-1200,800]` | 0.935 -> 0.925 | 0.912 -> 0.922 | 0.853 -> 0.853 | 0 / 4 |

**The control arm is what makes that non-vacuous:** sampling the same lava field
10,000 tiles away rejects 111 TP / 40 FP and 361 TP / 82 FP - indiscriminate, ratio
collapsing to 0.65 / 0.70. The real arm rejects almost only false positives.

So it explains region `[1500,1500]`'s over-placement essentially in full and
**does not** explain regions `[0,0]` or `[-1200,800]`, which barely move.

#### The 10 true positives it costs are a one-tile boundary, and the resolver is not the residual

Wiring the rejection in gives the cliff overlay a dependency on the Vulcanus tile
resolver, so the obvious next suspect was that resolver: it is ~98.2% accurate on
the 19-way tile name, and the natural guess (written into this file and into
`vulcanusCliffEntities.spec.ts` when the rule landed) was that it is worse at a
lava boundary. **Measured 2026-07-30. The guess was wrong in its premise and
right in its conclusion, and neither half needed a Factorio run** - both fixtures
are committed.

- **The binary lava classification is EXACT.** `tryToAddCliff` only ever asks
  whether a tile carries `water_tile`, never which tile it is, so the 19-way
  argmax is the wrong thing to have been quoting. On all 381 positions of
  `oracle-vulcanus-tile-names.seed123456` - 49 lava/lava-hot, 332 not - the
  resolver lands on the correct side in **both** directions, zero mismatches.
  All 7 name errors are non-lava/non-lava confusions inside one biome family.
  Nor is it worse near a boundary: the 42 positions at Chebyshev distance 1 from
  a tile of the opposite lava-ness are 42/42 correct on the full name.
  `test/vulcanusTiles.spec.ts` now pins the zero.
- **But every real cliff is a negative-space oracle, and 10 of them contradict
  us.** The game ran this same rejection and kept the cliff, so the game sees no
  lava in that box. Over the 1400 real cliffs we place across the three regions,
  10 boxes hold our lava - **0.71%** - and in all 10 the offending tile sits at
  Chebyshev depth **1** inside our own lava, on its perimeter. Not one is deep.
  Depth 1 is the common case for any lava tile, so that alone does not
  discriminate; the control is region `[1500,1500]`'s 173 correct rejections,
  which spread across the whole range (65 at depth 1, 52 deeper than 6). The
  rule's real work is nowhere near the boundary.

**This rules the resolver out as a cause of the remaining over-placement**, which
is why it was worth measuring before reading any more of `generateCliffs`. A
resolver that UNDER-called lava would leave false positives sitting next to lava.
They do not: of region `[0,0]`'s 95 surviving false positives only 4.2% come
within 2 tiles of any lava, against 7.2% of its 222 matched true positives - the
wrong way round - and in regions `[1500,1500]` and `[-1200,800]` the bulk (42/62
and 20/29) are more than 8 tiles from the nearest lava tile. Whatever remains is
not a lava question, and it is not a tile question.

### The orientation oracle - DONE 2026-07-30, and it localises the residual

Both cliff fixtures now record each entity's `cliff_orientation`
(`LuaEntity.cliff_orientation`, a 20-value string union whose order matches
`CLIFF_ORIENTATION_NAMES` exactly). Re-capturing reproduced every prior position
- Nauvis 282/52 in the same order, Vulcanus 283/885/409 - so only the new column
changed, and Nauvis's fixture moved from a 2.1.11 capture to 2.1.12 in the
process. `placedCells` now returns the crossing `code` alongside the centre, so
`test/cliffOrientationOracle.spec.ts` scores the SHIPPING path rather than a
parallel re-derivation.

**`CLIFF_CODE_TO_ORIENTATION` is confirmed against the game.** All 334 Nauvis
cliffs match exactly. That matters because the table's only previous check was
`cliffOrientation.spec.ts`, which compares it against the same jump table it was
read from - a misread and a mistranscription would have agreed.

**Vulcanus does not match, and this is the sharpest view of #18 yet.** Over the
cells the port and the game both place:

| region | matched | wrong orientation |
| --- | --- | --- |
| `[0,0]` | 228 | 68 = **29.8%** |
| `[1500,1500]` | 830 | 67 = 8.1% |
| `[-1200,800]` | 342 | 40 = 11.7% |
| total | 1400 | 175 = **12.5%** |

Since the table is right, a mismatch is a disagreement about the four CROSSINGS.
The dominant failure is exactly **two edges differing** (125 of 175): one of the
cell's two crossings is on a different side, i.e. a single corner on the wrong
side of a band boundary. Errors spread evenly over L:87 R:80 T:87 B:89, so it is
not a directional off-by-one. A cell can be in the right place for the wrong
reason, and 175 of them are - which the counts could never show.

Three candidate causes were tested **against this metric** and all three fail:

- **The fields, again, and this time on four bits per cell.** Re-running PR #57's
  substitution (the game's own corner elevation and cliffiness at `[1500,1500]`)
  leaves the mismatch at 67/830, identical to the digit, while a +3 elevation
  bias moves it to 122/793. The substitution is live, the metric is sensitive,
  and the fields are right. #57 scored PLACEMENT only - one bit per cell - so it
  could not have seen this either way.
- **`fixImpossibleCells`**: turning it off moves the total 12.5% -> 14.3% and
  `[0,0]` 29.8% -> 30.8%. It helps slightly and explains almost nothing.
- **Chunk borders**: 13.3% wrong on the outer ring vs 11.9% interior. No
  concentration, despite the ring being exactly where `fixImpossibleCells`
  cannot clear an edge.

#### That gap is now CLOSED - the fields are exact at `[0,0]` too

The corner-fields fixture's three regions are `[1500,1500]`, `[1100,2600]` and
`[-1700,1900]` - all calcite regions, chosen for issue #24. So "the fields are
exact" had been measured where the port is already good (8.1%) and never where it
is worst (29.8%). `oracle-vulcanus-cliff-corner-fields-entity-regions` fixes that:
both fields at every corner of all three **cliff-entity** regions, 12,675 corners,
captured 2026-07-30.

`[1500,1500]` is deliberately in **both** fixtures. That overlap is the check on
this capture's corner indexing - an off-by-one there would look exactly like a
field error at `[0,0]` - and the two agree bit-for-bit on all 4225 shared
corners.

**Result: the game's own values reproduce ours to the unit, in every region,
including `[0,0]`.** Same cells placed, same matched, same wrong:

| region | placed | matched | wrong orientation | +3 bias control |
| --- | --- | --- | --- | --- |
| `[0,0]` | 335 | 228 | 68 = 29.8% | 78 = 36.4%, 347 placed |
| `[1500,1500]` | 1065 | 830 | 67 = 8.1% | 122 = 15.4%, 1070 placed |
| `[-1200,800]` | 375 | 342 | 40 = 11.7% | 60 = 18.9%, 358 placed |

The bias arm moves placement AND orientation in all three, so the substitution is
live everywhere it is claimed to be. `test/vulcanusCliffCornerFields.spec.ts`
pins all of it.

**So the entire residual is in the RULE as ported**, and there is no longer any
input left to suspect: `crossingsForChunk`'s sampling geometry, the
`cliff_smoothing` knot model, or `crossesCliff` itself.

### `CliffGenerator::crossingsForChunk` - read whole 2026-07-30, and it MATCHES

`0x10160c9cc`, 2244 bytes, ends where `getModifiedElevationInterval` begins.
Decompiled whole. Every structural element agrees with the port, so this section
is a list of things that are now confirmed rather than assumed:

- **The sample lattice is bare.** The two input registers are filled with
  `x = chunkX*32 + i*gridX`, `y = chunkY*32 + j*gridY` over a 9x9 corner block.
  No `grid_offset` anywhere - #70's finding, seen from the producing side.
- **The smoothing knots are exactly as ported.** Per axis:
  `lo = i & ~3`, `hi = lo + 4` clamped to `w - 1` (the `uVar25 = uVar25 - 1`
  before the loop is where the 7 comes from), `t = (i & 3) / (hi - lo)` with
  `t = 0` when the span is degenerate. Blend is
  `s * bilerp + (1 - s) * raw` with `s = cliff_smoothing` at `settings + 0xd0`.
- **Which register is smoothed**: `settings + 0x1e0` (elevation) is smoothed into
  a fresh array; `settings + 0x1e4` (cliffiness) is read RAW at the same indices.
- **`crossesCliff` is inlined here** and is our rule: both elevations `>= 0`, the
  band from `max(a,b)`, reject when the band lands below `elevation_0`, and the
  crossing gated on `cliffinessAvg > 0.5` with the two sign cases.
- **The two edge arrays.** Horizontal (corner `(x,y)` to `(x+1,y)`) is
  `(h+1) x w` at index `x + w*y`; vertical (`(x,y)` to `(x,y+1)`) is `(w+1) x h`
  at index `x + y*(w+1)`. `generateCliffs` then reads L/R from the vertical array
  and T/B from the horizontal one. Our `vIndex`/`hIndex` and `cellCode` match.
- Tail call is `fixImpossibleCells(this, false)`, confirming the `false`.

#### Three more causes falsified, with denominators

- **`float` vs `double` is NOT it.** The engine does all of this at 32 bits and
  the port at 64, which fits the signature (one corner flipping near a band
  boundary) well enough to be worth testing. Replaying the whole rule with
  `Math.fround` at every step changes **nothing**: 0 of 12,480 raw edges differ
  per region, and placement and orientation are identical.
- **The `(int)` vs `Math.floor` difference is real but inert.** The engine
  truncates toward zero where the port floors. They differ only when
  `max(a,b) < elevation_0`, and there both give "no crossing" - the band lands at
  or below `elevation_0`, and both corners are below it, so neither sign case can
  fire. Included in the 0-of-12,480 above.
- **The smoothing model is right IN KIND, not merely unfalsified.** Running
  Vulcanus with `cliff_smoothing = 0` makes the orientation error much worse -
  29.8% -> 71.3%, 8.1% -> 64.1%, 11.7% -> 54.5% - so the knot blend is doing real
  and correct work. That is the control the disassembly reading needed.
- The float table at `0x102cf9cf0` that a smoothing-weight table would live in is
  just `0.0 .. 31.0`, the SIMD lane-index constant for the vectorised
  register-fill loop. There is no weight table.

#### What that leaves

Fields exact, rule structurally confirmed, precision irrelevant, smoothing
confirmed - and 12.5% of shared cells still carry the wrong crossings. The
candidates that survive:

1. ~~**`fixImpossibleCells` in detail.**~~ **Closed 2026-08-01** - see the next
   section. All 24 clear orders were swept (the ported `L, T, R, B` wins) and,
   decisively, the pass finds only 35 illegal cells and clears 59 edges across
   all three regions. It is too small by a factor of five to be the cause. The
   original wording here - "a different sweep could be both closer AND worth
   more" - was right to keep it open and wrong about the size.
2. ~~**The choice of expression, which no substitution can test.**~~ **Closed
   from the data, 2026-07-30.** The worry was real - the corner-field fixtures
   capture `vulcanus_elevation` and `cliffiness_basic` **by name**, so if a
   different expression fed `settings + 0x1e0` the substitution would agree with
   the port for the same reason the port is wrong, exactly like the corner-fields
   fixture captured at the port's own assumed lattice. But the routing is
   explicit in `space-age/prototypes/planet/planet-map-gen.lua:13-14`, in the
   block carrying Vulcanus's `cliff_elevation_interval = 120` /
   `cliff_elevation_0 = 70`:

   ```lua
   cliffiness      = "cliffiness_basic",
   cliff_elevation = "cliff_elevation_from_elevation",
   ```

   and `cliff_elevation_from_elevation` is literally `expression = "elevation"`
   (`core/prototypes/noise-programs.lua:288`), which Vulcanus routes at
   `vulcanus_elevation`. Worth knowing what the alternative was: the **default**
   `cliff_elevation` is `cliff_elevation_nauvis`
   (`10 + 30 * (nauvis_hills - nauvis_hills_cliff_level)`), a completely
   different field - so this was a live way to be wrong, in the same shape as the
   `cliff_smoothing` default that cost issue #18 two months.

### Nine more causes falsified, 2026-08-01 - and candidate 1 above is now CLOSED

The list above left `fixImpossibleCells` as the surviving candidate. It is not the
cause, and neither is anything else that can be reached by varying the port.

**The harness, because it is reusable and it is what makes these cheap.** The
smoothing is a transform on the elevation field, so a candidate smoothing can be
*pre-applied to the field* and the placement then run with `smoothing: 0`. That
runs the SHIPPING rule over a candidate transform, needs no edit to
`cliffPlacement.ts`, and scores in ~1.5s for all three regions because one field
cache is shared across every candidate. The control arm reproduces
**1400 matched / 175 wrong** to the digit, which is what licenses the rest.

**1. The smoothing knot geometry is right, and it is a sharp optimum in four
dimensions.** Sweeping `(span, clamp, anchor offset, blend s)`:

| variation | wrong / matched | |
| --- | --- | --- |
| **shipping: span 4, clamp 7, offset 0, s=1** | **175 / 1400** | **12.5%** |
| clamp 8 (the "clean" global bilerp) | 378 / 1124 | 33.6% |
| clamp 6 | 485 / 1189 | 40.8% |
| anchor offset 1..7 | 523-578 | 51-72% |
| s = 0.9 / 0.75 / 0.5 / 0 | 238 / 371 / 530 / 705 | 17.6-62.8% |
| span 8 / span 2 | 367 / 572 | 64.8% / 55.1% |

Both axes were also swept independently (`clampX` x `clampY`, `offsetX` x
`offsetY`): the minimum is at (7,7) and (0,0), not on any off-diagonal. **The
odd clamp-to-7 asymmetry that reads like a misread is 2.7x better than the clean
reading** - so the disassembly is now corroborated by something other than
itself, which is exactly what that section needed.

**2. Cliffiness stays raw.** Smoothing it too: 279/1397 = 20.0%.

**3. Linear interpolation, not a curve.** smoothstep 29.3%, smootherstep 37.3%,
nearest 61.8%, sqrt 50.5%, square 53.9% - against linear's 14.3% in the same
(fix-sweep-free) harness.

**4. The band constants are a sharp optimum too.** `cliff_elevation_0` swept
64..76 bottoms exactly at **70** (12.5%, rising to 25.7% at 65 and 23.1% at 76);
`cliff_elevation_interval` bottoms exactly at **120**. The elevation range over
the sampled corners is -62.3 .. 1226.3, so ~10 bands are genuinely in play and
the interval is not inert.

**5. No structural variant of `crossesCliff` helps.** Dropping the negative-
elevation gate 12.9%, gating on raw elevation instead 12.5%, non-strict
comparison 12.5%, dropping the cliffiness gate 22.5%, anchoring the band on
`min(a,b)` places nothing at all. The "different band" formulation scores
**exactly** 175 - it is provably identical to the max-anchored one except when
`max(a,b)` sits exactly on a boundary.

**6. `fixImpossibleCells` cannot be the cause, by size.** All 24 edge-clearing
priorities were swept: the ported **`L, T, R, B` is the best of all 24** (175,
against 181-217). But the decisive number is that across all three regions the
pass finds only **35 illegal cells and clears 59 edges**. Identical fields plus
an identical rule give identical pre-fix codes, so a pass that touches ~35 cells
cannot produce 175 wrong ones. This closes candidate 1.

**7. The fields were compared as VALUES for the first time, not as outcomes.**
Every previous exoneration ran the substitution and asserted the placement did
not move. That is weaker than it sounds. Comparing our field directly against
`oracle-vulcanus-cliff-corner-fields-entity-regions` over all 12,675 corners:

| | median | max |
| --- | --- | --- |
| elevation \|ours - game\| | 2.7e-4 | **4.8e-2** |
| cliffiness \|ours - game\| | 0 | 6.4e-6 |

The corrections the failures need are **~3.6 elevation units** (below), four
orders of magnitude larger. The fields are right, and now that is measured
rather than inferred from a null result.

**8. The packing, the lattice and the table are cleared from the fixture alone.**
See `test/cliffEdgeConsistency.spec.ts`: the game's own adjacent cliffs agree on
**every** shared edge (Nauvis 147 h + 166 v, Vulcanus 805 h + 834 v, zero
mismatches), and all 1569 `cliff-vulcanus` land exactly on `(cx*4+2, cy*4+2.5)`
while exactly the 8 `crater-cliff`s do not.

**9. The failure shape says "diffuse", not "structural".** The cliffiness gate
blocks **zero** of the edges the game crossed; 141 of 156 are `sameSide` (our two
corner elevations do not straddle a band) and 13 are `band<e0`. Not one
disagreement is a sign flip - every differing edge is a crossing appearing or
disappearing, never reversing. The error rate is flat over in-chunk cell position
(8x8, no structure), flat over position in the smoothing lattice (so it is not
concentrated on interpolated corners), spread over 64 distinct orientation
transitions, and mostly isolated (137 wrong cells have a correct neighbour, 66 a
wrong one).

#### What this leaves, stated as the contradiction it is

Fields right to 5e-2. Smoothing at a sharp four-dimensional optimum. Rule,
bands, packing, table and lattice all confirmed. Fix sweep too small by a factor
of five. And yet 175 of 1400 shared cells still carry different crossings.

The sharpest single statement of the residual: over the 5891 edges of the game's
own cliffs where the cliffiness gate is open, **our smoothed elevation predicts
the game's crossing 88.7% of the time and the raw elevation 60.3%**. So the
smoothing is doing real and largely correct work, and the last ~11% is a
difference between the game's smoothed cliff elevation and a linear bilerp of
the raw field on the chunk-anchored 0/4/7 lattice - a difference of a few
elevation units, at corners where the raw field agrees to 0.05.

~~**The next step is the binary, not another behavioural sweep.**~~ **Wrong, and
the game said so within the hour - see the next section.** The conclusion drawn
from all of the above was "the residual is inside the smoothing"; it is not in
the smoothing at all. Every measurement above stands; the inference from them
did not. Read the next section before acting on this one.

**One methodological note, because it cost a wrong reading.** Nauvis's fixture
cases are the same region at **different seeds**. Merging them into one cell map
invents four "inconsistent" adjacent pairs out of nothing, which briefly looked
like a finding about chunk-boundary edges. Tally per case. The committed spec
says so at the function.

### `cliff_smoothing` swept IN THE GAME - and it is NOT the residual (2026-08-01)

The section above searched the smoothing exhaustively *inside the port* and
concluded the residual must live within it. **That conclusion is false.** The
refutation is one setting, and it is the kind only the game can supply.

`cliff_smoothing` is a `map_gen_settings.cliff_settings` field, so it can be
**overridden on the created surface** rather than accepted as the planet ships
it. `sampleCliffEntitiesFull` (oracle.ts) takes a `cliffSmoothing` option and the
probe dumps the `cliff_settings` the surface **reports back**, which is what
makes the sweep non-vacuous: an override that silently failed to apply is
otherwise indistinguishable from a setting that does not matter.

`s = 0` is the decisive member of the family. With smoothing off the cliff
elevation **is** the raw field - measured accurate to a max of 4.8e-2 - fed to a
rule that reproduces Nauvis 334/334. A port whose only defect were the smoothing
would therefore be **exact** at `s = 0`. Region `[0,0]`, captured 2026-08-01:

| `cliff_smoothing` | game | ours | matched | wrong |
| --- | --- | --- | --- | --- |
| **0** | 352 | 432 | 289 | **83 = 28.7%** |
| 0.5 | 315 | 374 | 267 | 73 = 27.3% |
| 1 | 283 | 335 | 228 | 68 = 29.8% |

**The error is flat in `s`.** Turning the suspect off does not move it. So the
smoothing is not the cause, and the four-dimensional in-port sweep was searching
the wrong transform the whole time.

Two things worth keeping from it anyway. The smoothing model is *good* - the
placement counts track the game's across all three values, and the parameter
optima were real - which is precisely why it was so convincing. And the dumped
settings are the only direct evidence outside the `.lua` files that Vulcanus
generates with `cliff_elevation_0 = 70`, `cliff_elevation_interval = 120`,
`cliff_smoothing = 1`. `test/vulcanusCliffSmoothingSweep.spec.ts` pins all of it.

**The general lesson, which this repo keeps re-learning.** A parameter sweep
inside the port can only rank models *within the family the port already
implements*; a sharp optimum says "best in family", never "correct". The whole
family was wrong here, and no amount of internal sweeping could have said so.
When a suspect is reachable as a *game setting*, vary it in the game and see
whether the error moves - that is a one-run experiment which either indicts the
suspect or clears it outright, and it does not depend on being right about the
mechanism. Same shape as the surface-seed bug: self-consistency is not
validation.

### The rule COLLAPSED term by term - #18 is in the FIELD, not the placement (2026-08-01)

`cliff_settings` holds every constant the placement rule uses and all of them are
settable on the surface, so a term does not have to be *modelled* - it can be
switched **off in the game**:

| lever | effect |
| --- | --- |
| `cliff_smoothing = 0` | leaves the RAW elevation |
| `cliff_elevation_interval = 1e6` | a **single contour** at `cliff_elevation_0`; no band arithmetic |
| `richness = 4` | `0.5*log2(4) = 1`, so `cliffiness_basic` saturates at 1.5 and its `> 0.5` gate is always open |

All three together reduce the rule to **"an edge crosses iff elevation crosses
70"**, which makes the game's own cliffs a direct readout of
`sign(elevation - 70)` at the generator's sample points.

| Vulcanus arm | game | ours | matched | wrong |
| --- | --- | --- | --- | --- |
| smoothing off only | 352 | 432 | 289 | 83 = 28.7% |
| + single contour | 271 | 349 | 208 | 79 = 38.0% |
| **+ gate held open** | 335 | **463** | 265 | **99 = 37.4%** |
| bands, gate open | 431 | 559 | 360 | 105 = 29.2% |

**And Nauvis, through the same code and the same lattice, is EXACT - including at
a setting never captured before.** `cliff_elevation_interval = 80` gives
**281/281 in both directions**, so the port tracks the game when a cliff setting
*moves*, not merely at the default. It also agrees on the degenerate arm, where a
single contour at 50 yields zero cliffs from both, because `cliffiness_nauvis`'s
cutoff is derived from the interval while `cliffiness_basic`'s is not.

That control is what gives the Vulcanus numbers their meaning. The rule, the
lattice, the code packing, the repair sweep and the settings plumbing are all now
confirmed **against the game**, under a changed setting. What is left is the
field - and the informative half is not the error rate but the over-placement:
with everything else switched off **we place 463 cliffs where the game places
335**, so our 70-contour is ~38% longer. Our elevation is *rougher at the 4-tile
scale* than the one the generator reads.

#### The open lead: our elevation may be right in the wrong CHANNEL

Our field is not wrong against the channel it was checked in - it reproduces
`oracle-vulcanus-cliff-corner-fields-entity-regions` to a max of 4.8e-2, and that
fixture came from `LuaSurface.calculate_tile_properties`. The question this
raises is whether the map GENERATOR reads the same values that channel reports.

The prime suspect is **`multisample`**, which sits in `vulcanus_elevation`'s
chain through `vulcanus_basalt_lakes_multisample`
(`planet-vulcanus-map-gen.lua:540,547`) and which Nauvis's `cliff_elevation_nauvis`
does not contain at all - the asymmetry the whole residual needs. Its own
documentation describes it as evaluating

> in a separate noise program with a larger grid. Sub-grids are copied to the
> main program.

which is explicitly **grid-dependent**, and the two channels have different
grids: the cliff generator walks a 4-tile corner lattice, `calculate_tile_properties`
does not. `docs/noise/vulcanus-multisample-NOTES.md` established
`multisample(e, dx, dy) == e(x+dx, y+dy)` at 150/150 comparisons - but measured
it **through `calculate_tile_properties`**, the same channel as the fixture. A
`min()` of four samples is an erosion operator, so a coarser effective grid in
the generator would smooth the field exactly the way the over-placement implies.

This is the repo's recurring trap in a new place: not a fixture captured at the
wrong *site* this time, but one captured through the wrong *channel*. Nothing
here refutes the multisample port; what has never been tested is whether it
behaves the same when the calling program's grid is 4 tiles rather than 1.
`test/vulcanusCliffCollapsed.spec.ts` pins all of the above.

## ROOT CAUSE, 2026-08-01: `multisample`'s offsets are in GRID UNITS, not tiles

> **Issue #18 is resolved.** `docs/noise/vulcanus-multisample-NOTES.md` proved
> `multisample(e, dx, dy) == e(x + dx, y + dy)` at 150/150 comparisons, and that
> is correct **for `LuaSurface.calculate_tile_properties`, whose noise program has
> a 1-tile grid**. It was never checked in any other channel. The primitive's own
> docs say it evaluates "in a separate noise program with **a larger grid**" whose
> "sub-grids are copied to the main program", and that phrase is load-bearing.
>
> Asked through the CLIFF GENERATOR - whose grid is the 4-tile corner lattice -
> by routing a probe onto `cliff_elevation` with the rule collapsed, so cliffs
> mark exactly where the routed field crosses 71:
>
> | arm | column | |
> | --- | --- | --- |
> | `x` | 70 | baseline |
> | `multisample(x, 0, 0)` | 70 | identical |
> | `multisample(x, 4, 0)` | **54** | shifted **16 tiles**, not 4 |
> | `multisample(x, 0, 4)` | 70 | null control |
>
> **`dx = 4` moves the field 16 tiles = 4 x the grid step.** So Vulcanus's
> `vulcanus_basalt_lakes_multisample` - a `min` over `{0,1}x{0,1}` - spans **4
> tiles** for cliffs and **1 tile** for every per-tile consumer. `min` is an
> erosion operator, so the cliff channel's elevation is much smoother; the port
> used the 1-tile field for both, making the cliff elevation too rough and
> over-placing by ~40%.
>
> | | before | after |
> | --- | --- | --- |
> | wrong orientation | 175 = 12.5% | **37 = 2.4%** |
> | recall | 0.806 / 0.938 / 0.853 | **1.000 / 0.973 / 0.965** |
> | `[0,0]` (worst region) | 29.8% wrong | **2.5%**, recall 1.000 |
> | level sweep, ratio | 1.20-1.49 below 120 | **1.00-1.09 at every level** |
>
> Both columns are measured **without** the lava-collision rejection, which is the
> right control for isolating this one change but is not the shipping path. On the
> path the renderer runs, "after" is recall 0.9675 / precision 0.9743 / 31 wrong -
> see the banner at the top of this file.
>
> `VulcanusElevation` now exposes `cliffElevation` beside `elevation`; both hang
> off one stack and share every sub-expression below the multisample, so the cost
> is a second memo table. **Do not collapse them back together** - they are
> different fields, not a cache miss.
>
> Nothing here refutes the multisample port or the per-tile consumers:
> `calculate_tile_properties` and the tile renderer both live in the 1-tile
> channel, where `e(x + dx, y + dy)` is exactly right. What was wrong was using
> one channel's field in the other's consumer. `test/multisampleGrid.spec.ts`.
>
> **The lesson, which is the third form of the same trap this repo keeps hitting.**
> It was not a fixture captured at the wrong SITE (#70's `grid_offset`), nor a
> value that was simply wrong - it was a fixture captured through the wrong
> CHANNEL, agreeing with a port that made the same mistake. Ask which code path
> CONSUMES a value, not only which coordinates it is sampled at. And note that no
> amount of sweeping inside the port could have found this: every arm of the
> 4-dimensional smoothing sweep, the band sweep and the rule sweep was searching a
> family that shared the defect.
>
> The sections below are preserved as the record of the investigation. Their
> measurements stand; read their conclusions as historical.

### The level-set inversion - #18 is ONE TERM of `vulcanus_elev` (2026-08-01)

The collapsed rule is also an **instrument**. A cell carries a cliff exactly when
its corner elevations straddle `cliff_elevation_0`, so sweeping that threshold
measures the elevation field **the generator itself reads** - the one thing an
expression sample cannot do, since `calculate_tile_properties` answers for its
own channel and whether the two agree was precisely the open question.

19 levels, `cliff_elevation_0` 20..200 step 10, region `[0,0]`:

| `cliff_elevation_0` | game | ours | ours/game |
| --- | --- | --- | --- |
| 20 | 658 | 979 | 1.49 |
| 40 | 603 | 816 | 1.35 |
| 70 | 335 | 463 | 1.38 |
| 110 | 142 | 200 | 1.41 |
| **120** | 122 | 126 | **1.03** |
| 150 | 117 | 117 | **1.00** |
| 200 | 97 | 97 | **1.00** |

**There is a clean edge at 120**: every level at or above it is 1.00-1.04 (and
the same CELLS, `both/game > 0.9`, not merely the same count), every level below
it is 1.20-1.49. The worst high level is 1.04 and the best low level is 1.20, so
this is a threshold, not a drift.

That edge is not arbitrary. `vulcanus_elev` is

```
vulcanus_elevation_offset
  + lerp(lerp(120 * vulcanus_basalt_lakes_multisample,
              20 + vulcanus_mountains_func * vulcanus_mountains_elevation_multiplier,
              vulcanus_mountains_biome),
         vulcanus_ashlands_func,
         vulcanus_ashlands_biome)
```

and `vulcanus_basalt_lakes` is a `min(1, ...)`, so **the basalt-lakes branch
saturates at exactly 120**. Everything above 120 comes from the mountains and
ashlands branches - which contain no `multisample` - and the port reproduces
those *exactly*. Everything below is governed by
`vulcanus_basalt_lakes_multisample`, which is the only `multisample` in the chain
and the only term with no Nauvis counterpart.

**So the residual is that one term, and the port is exact everywhere else in the
field.** `test/vulcanusElevationLevels.spec.ts` pins the threshold and its
separation.

The mechanism to suspect is the one the primitive's own docs describe: it
evaluates "in a separate noise program with a larger grid" whose "sub-grids are
copied to the main program". The cliff generator's program walks the 4-tile
corner lattice; `calculate_tile_properties` does not - and that is the channel
`vulcanus-multisample-NOTES.md` measured `multisample(e,dx,dy) == e(x+dx,y+dy)`
through, and the channel every elevation fixture was captured through. A `min()`
of four samples is an erosion operator, so a coarser effective grid in the
generator smooths the field exactly the way a 40% over-placement implies.

Note what this does NOT say: the multisample port is not refuted, and neither is
the corner-fields fixture. Both are correct **in their channel**. What has never
been tested is whether the primitive behaves the same when the calling program's
grid is 4 tiles rather than 1 - and the tile renderer, which consumes
`vulcanus_elevation` through the same 1-tile channel the fixtures use, is not
implicated by any of this.

#### Where that leaves #18

The residual survives with smoothing disabled, so it is in something Nauvis and
Vulcanus share, differing only in the inputs - and the inputs are measured right.
Still standing after this session, now with smoothing removed from the list:

- **The cliffiness gate is not it either.** Swept against the `s = 0` fixture:
  `avg > 0.5` (shipping) 28.7%, requiring BOTH corners (`min`) 37.1%, `max` is
  arithmetically identical to `avg` because `cliffiness_basic` is confined to
  `[0.5, 1.5]`. A threshold sweep bottoms exactly at 0.5. And `min` is refuted
  outright by Nauvis, which drops from 334/334 to 295 placed / 32 wrong.
- The one asymmetry left unexplained is that Nauvis's cliffiness is the binary
  `{0, 10}` while Vulcanus's is continuous - so on Nauvis the gate is never
  near-threshold and on Vulcanus it always is. The gate combination is now
  measured, but nothing has yet tested how the engine *rounds or stores* that
  field.

Beware one measurement trap met here: scoring edges over **all** the game's
cells (rather than the cells both place) reports ~57% agreement and ~260 "sign
flips" at every smoothing value. Those are an artifact of the wider denominator,
not a finding - the rate is flat in `s`, which is the control that catches it.

### The FFF on cliffs (#219) - checked, and mostly confirms the binary

https://factorio.com/blog/post/fff-219 is the design writeup. Read 2026-07-30 so
nobody spends the time again. It confirms the shape: an elevation threshold per
cell edge, an **independent** `cliffiness` noise layer applied equally to the
north-south and east-west edges ("Cliffiness only determines small-scale
placement to ensure that there are passages through any sufficiently long cliff
face"), a 4x4-tile cell, chunk-at-a-time generation, and that an earlier
slope-based rule was dropped because it produced cells no cliff graphic could
represent.

Two things to be careful with:

- **It is from 2017 and describes the pre-2.0 algorithm.** Where it and the
  2.1.12 binary disagree, the binary wins.
- **Its description of the repair pass is a simplification, and following it
  would be a bug.** The FFF says the generator "removes edges marked as
  cliff-crossing until no cell has more than 2 'cliff-crossing' edges". That is
  strictly weaker than what the binary does. Of the 20 placing codes, 8 have one
  crossing and 12 have two - but there are `C(4,2) * 2 * 2 = 24` possible
  two-crossing codes, so **12 two-crossing codes are illegal**, the ones whose
  two crossings disagree in direction. A "count <= 2" predicate would leave those
  in place, and `generateCliffs` asserts and aborts on an illegal code, so the
  engine cannot be using it. `fixImpossibleCells`' real predicate, read off the
  jump table, is `isCliffPlaced(code)` plus code 0 - which is what is ported.

The FFF's one operational detail agrees with the port: it notes the pass
prioritises chunk boundaries because neighbouring chunks must independently agree
there, which is the same constraint as "a boundary edge is not clearable".

FFF #390 (Noise expressions 2.0) and #401 (new terrain, new planet) were checked
for cliff-expression naming and have nothing on it.

### `EntityMapGenerationTask::generateCliffs` - full body read 2026-07-30

At `0x1016229b4` in 2.1.12 (1080 bytes, ends where `generateEntities` begins).
Decompiled whole. It confirms three things the port already does and turns up one
it does not model:

- **The code packing is ours.** The vertical edge array has stride `w + 1` and
  the horizontal one stride `w`, and the cell reads
  `L=v[cx,cy], R=v[cx+1,cy], T=h[cx,cy], B=h[cx,cy+1]` packed 2 bits each in that
  order - matching `cellCode`.
- **`toMaybeCliffOrientation` is INLINED here**, and its structure is exactly the
  one `fixImpossibleCells` splits on: a `< 0x51` byte jump table at
  `0x102d001b7`, then explicit compares for `0xC0`, `0xC1`, `0xCC`, `0xF0`
  storing `0xc00000002`, `0x800000002`, `0x400000002`, `2` - i.e.
  `(orientation << 32) | 2`, giving orientations 12, 8, 4, 0 for those four
  codes. That agrees with `CLIFF_CODE_TO_ORIENTATION` entry for entry. Anything
  in `0x51..0xBF` falls into an assert-and-abort.
- **The centre formula, and where `grid_offset` really is applied.**
  `x = grid_offset.x + chunk.x*32 + cx*grid.x + (grid.x >> 1)` and likewise for
  `y`, with the shift on the INTEGER grid size. With `grid = {4,4}` and
  `grid_offset = {0, 0.5}` that is `+2` and `+2.5` - `CLIFF_CELL_CENTER_X/Y`.
  Note it is added to the CENTRE and nowhere else, which is the #70 finding seen
  from the other side.
- **New: `tryToAddCliff` takes a fifth argument, and it is `!onChunkBorder`.**
  `bVar3` is set true when `cx == 0 || cy == 0 || cx == w-1 || cy == h-1`, and
  the call passes `bVar3 ^ 1`. Do not assume it gates the collision test - it
  does not (below). Measured, it does not gate placement either: the game's
  cliffs are spread uniformly across all 64 in-chunk positions.

  **It gates something else, and "the flag remains unmodelled and is measured
  not to matter" was true only of `tryToAddCliff` itself.** `applyCliffs` reads
  it out of the queued record and uses it to decide which cliffs get
  `Cliff::updateConnections()`. See the `applyCliffs` section below - added
  2026-08-03, and the first time anything downstream of the queue was read.

### `tryToAddCliff` has TWO paths, and the earlier note described only one

At `0x101625038` (608 bytes). It branches on a mode byte at `this + 0x10`:

- `mode == 2`: switch on orientation, load that orientation's box from
  `proto + 0x5c0 + id*0x48`, call `wouldCollide(this, box, proto+0x2b0, position,
  Direction=0)` at `+0x430` (= `0x101625468`). On a hit, **return 0 immediately**.
- otherwise, **no collision test at all**.

The two are **sequential, not alternatives**: on a miss (`tbz w0, 0`) the
collision path falls through into the same tail as the other branch, which
appends a 16-byte record `{u16 protoId, u8 orientation, MapPosition position,
bool}` to a vector at `this + 0x30..0x40`. So the shape is "test if this mode
tests, then queue", and the fifth argument is **stored in that record at +0xc and
never read by the collision test**. Whatever drains the queue consumes it.

> **CORRECTION, 2026-08-03 (#84): mode 2 is the map PREVIEW generator, not map
> generation, so on a real map `tryToAddCliff` runs NO collision test.** This
> paragraph used to end "the port's `tileCollides` post-filter models the
> `mode == 2` path, which is the one map generation takes". That is backwards,
> and the constructors say so in one instruction each:
>
> | constructor | mode byte at `this+0x10` |
> | --- | --- |
> | `(Surface&, ChunkPosition const&)` | `0` (`0x101622118`) |
> | `(Surface&, MapGenerator const&, ChunkPosition const&, ...)` - **map generation** | **`1`** (`0x101622238`) |
> | `(MapPreviewGenerator const&, ChunkPosition const&)` | **`2`** (`0x101622348`) |
>
> Every rejection on a real map therefore happens in `applyCliffs`, through
> `Surface::wouldCollide` on a cliff that has already been created and added to
> the surface - which is why it can affect its neighbours, and why #108's
> `rejectAtCrossingStage` measured what it measured. See the next section.

### `EntityMapGenerationTask::applyCliffs` - the queue's consumer, read 2026-08-03

At `0x101623c98` (1008 bytes), and until #84 nothing downstream of the queue had
been read at all. Per queued `CliffAddition`:

```
collided = Surface::wouldCollide(proto, position, orientation)   // 0x10160c088
entity   = proto->createEntity(spec)                             // vtable +0x740
addEntityToSurface(surface, entity)
if (collided)          -> list A     ([x29-0x70])
else if (!record.bool) -> list B     ([x29-0x88]); record.bool is !onChunkBorder
```

then, after the whole chunk's cliffs are on the surface, list A gets
`Entity::forceDestroy()` and list B gets vtable `+0x6b0`, which the `Cliff`
vtable resolves to **`Cliff::updateConnections()`** (`0x1007a90d4`).

Two consequences the port had no model for:

- **A rejected cliff is destroyed, not skipped**, and `Cliff::onDestroy`
  (`0x1007a8770`) calls `destroyEnd(opposite(side))` on each connected
  neighbour. `Cliff::destroyEnd` (`0x1007a8d40`) rewrites the orientation with
  that side replaced by `none`, or `forceDestroy`s when nothing is left - so it
  cascades. `Cliff::destroyWithoutCorrection` exists precisely because the
  ordinary destroy corrects.
- **`updateConnections` runs on the chunk's outer ring only**, and drops any end
  whose neighbour chunk is generated (status `> 0x31`) but holds no cliff that
  `isCliffConnected` accepts.

`Surface::wouldCollide(CliffPrototype const&, MapPosition const&,
CliffOrientation)` itself is: the orientation's box from `proto + 0x5c0 +
id*0x48` offset by the position, an early `return false` if the box is
degenerate, then `constCollideWithTile` and `collideWithEntity`. Same box and
mask as `EntityMapGenerationTask::wouldCollide` - only the stage differs.

The full port, the four extracted tables and the scoring are in
`src/noise/cliffs/cliffConnections.ts` and `test/cliffConnections.spec.ts`; the
result is in `vulcanus-cliffs-NOTES.md`.

### `crater-cliff` is not on the cliff lattice - confirmed, not assumed

**FFF #386 explains why it exists and corroborates both readings**
(https://factorio.com/blog/post/fff-386). Craters were originally going to be
collidable decoratives, and were made cliffs instead because:

> "the collision boxes are always rectangles so hitting invisible corners is
> annoying, and there's a flat part in the middle that looks buildable but isn't.
> We also wanted some partial craters which would mean even more special
> collision rules. The solution we came up with is more like a ring of special
> cliffs where sections of the ring can randomly be removed."

Two things follow, and both match what was read out of the binary. **Cliff
collision boxes really are plain rectangles** - said outright by the developers,
which is the independent confirmation `CLIFF_ORIENTATION_COLLISION_BOX` and the
`rotbb` AABB derivation never had. And a **ring with randomly dropped sections**
is not a lattice structure at all, which is why these positions are fractional
(`-1184.375, 814.98828125`) and why they carry orientations from the same 20-value
enum without ever touching `crossingsForChunk`.

They also cannot be issue #18's residual, which is worth stating with the count
rather than by argument: of the three cliff-entity regions, `[0,0]` has **zero**
crater-cliffs and `[1500,1500]` has **zero**. All 8 are in `[-1200,800]`. The
region with the worst crossing error has none of them.

`space-age/prototypes/decorative/decoratives-vulcanus.lua:2776` defines it
through `scaled_cliff_crater` with `autoplace.probability_expression =
"crater_cliff"`, and `planet-map-gen.lua:122` lists it under Vulcanus's **entity**
autoplace settings beside the rocks and the geyser. So it is placed by the entity
generator with jitter, not by `generateCliffs`, which is why its positions are
fractional. It carries its own `collision_mask` including `water_tile`. Excluding
it from the cliff comparison is correct; it is 8 of region 2's 409 entities.

#### `rotbb` boxes

16 of the 20 orientations use `rotbb(x, y, size, intersect)`
(`base/prototypes/entity/entity-util.lua:9`), which builds a rectangle centred at
`(x + size/2, y + size/2)` and tags it with orientation **1/8** - a 45 degree
rotation. Rotating its half-extents by 45 gives `(hx + hy) * cos(45) = size/2` on
both axes whatever `intersect` was, so **the AABB is exactly the square
`[x, x+size] x [y, y+size]`** and `intersect` only splits the diagonal inside it.
`test/cliffOrientation.spec.ts` re-derives that from the full rotated rectangle
rather than restating it, and asserts the unrotated rectangle differs (so the
check is not trivially true).

### Slider mapping (disasm-confirmed)

- `getModifiedElevationInterval` @ `0x101607684`: `interval / frequency`. Default
  `40 / 1 = 40`.
- `getModifiedRichness` @ `0x10160a2e0`: `richness_field * size_field`. Default
  `1 * 1 = 1` -> `cliff_richness = 1` -> `cliff_gap_size = 0.5` ->
  `cliff_cutoff = 2*0.5^1.5 = 0.7071`.
- `generateCliffs +72..+80` gates the whole pass on the size (Continuity) field
  being non-zero, so **Continuity = 0 disables all cliffs**.
- The app's `nauvis_cliff` terrain control exposes Frequency = the `frequency` slot,
  Continuity = the `size` slot (no richness column); `cliffSettings.richness` /
  `cliffElevationInterval` are the base values `getModified*` scale.

### `cliff_smoothing` - a no-op on Nauvis ONLY, and the trap that cost issue #18

`cliff_smoothing = 0` on Nauvis (`planet-map-gen.lua:18`), so it is a no-op *here*.
This section used to stop at that sentence, and that omission is what hid the
Vulcanus cliff bug for two months: the **prototype default is 1, not 0**
(`CliffPlacementSettings.cliff_smoothing`), Vulcanus's `cliff_settings` does not
override it, and the port applied Nauvis's 0 to both planets. Nauvis kept scoring a
1.000 count ratio the whole time, so nothing pointed at it.

It is not a post-pass. `crossingsForChunk` @ `0x10160cdec` rewrites the cliff
**elevation** register (`[settings+0x1e0]`) *before* any `crossesCliff` call, and
leaves cliffiness (`[+0x1e4]`) alone:

```
smoothed(i,j) = (1 - s) * E(i,j) + s * bilerp(E at the four surrounding knots)
```

Per axis, over each chunk's own `9x9` corner block:

```
lo = i & ~3                      // i = IN-CHUNK corner index, 0..8
hi = min(lo + 4, CHUNK_CORNERS - 1)   // CHUNK_CORNERS = 32/4 = 8
t  = (i & 3) / (hi - lo)
```

Knots therefore land at in-chunk indices **0, 4 and 7** - the second span is three
corners wide, not four, because `hi` clamps to 7 rather than to the block edge at 8.
Index 8 falls out with `t = 0` on itself and is the same world point as the next
chunk's index 0 (also a knot), so the two chunks agree and the whole thing reduces
to a function of the global corner index with no chunk loop. The lattice is
chunk-anchored, so the smoothed field is deliberately discontinuous every 32 tiles -
this is what the prototype docs mean by smoothing making "placement inaccurate".

Ported in `smoothingKnots` / `smoothedElevation` (`cliffPlacement.ts`), pinned by
`test/cliffSmoothing.spec.ts`. `CliffBands.smoothing` defaults to **0**, i.e.
Nauvis's value rather than the prototype's, because Nauvis is the planet that
currently measures 1.000 and must not move.

Settings-struct offsets used above, for anyone re-reading the disasm:
`+0xc8` = `cliff_elevation_0`, `+0xcc` = `cliff_elevation_interval`,
`+0xd0` = `cliff_smoothing`.

**Open, not chased (2026-07-28):** the codec's `cliff.cliffSmoothing` u8 label is
unproven. The game's Lua sets `cliff_smoothing = 1` for the Lakes and Island
presets, but all 9 strings in `builtin-presets.json` decode to `u8 = 0` and
`unknownFloat = 1.0` - nothing in the tail distinguishes them. The Default preset
*is* confirmed 0 by the game's own parse dump, so Nauvis rendering is correct
either way; what is unknown is whether the wire carries smoothing at all. Worth an
issue if the Nauvis render is ever driven by a Lakes/Island preset.

## Validation result: NAUVIS exact since 2026-07-30 (historical - Nauvis only)

> **The ~6% Nauvis residual documented throughout this section is GONE, and the
> cause was none of the six things named for it.** The port sampled the two
> fields at `(i*4, j*4 + 0.5)`, adding the prototype's `grid_offset {0, 0.5}` to
> the SAMPLE position. That offset is a **centre** offset - the game data says so
> at `base/prototypes/entity/entity-util.lua:305` ("cliffs are auto-placed with
> centers at (0, 0.5) offset from the grid") and `CliffGenerator::crossingsForChunk`
> reads `grid_size` (`[proto+0xb60]`/`[0xb68]`) and never `grid_offset`
> (`[0xb70]`/`[0xb78]`), taking its sample origin from `chunkPos << 5`.
>
> Correcting it takes Nauvis from **0.943 / 0.943 to 1.0000 recall, 1.0000
> precision, ratio 1.000 at both seeds** - exact agreement with
> `find_entities_filtered` - and Vulcanus recall from 0.792/0.870/0.803 to
> 0.806/0.938/0.853.
>
> Why it hid for two months, and why five other causes were "confirmed" instead:
> the error moves **no placed cliff**. Cell centres are derived from their own
> constants, so `x mod 4 == 2` / `y mod 4 == 2.5` held, the preview agreement
> held, and PR #57's substitution of the game's own field values changed zero
> cells - because that oracle fixture had itself been captured at the port's
> assumed lattice. A substitution test can falsify a VALUE; it cannot falsify the
> SITE it was sampled at.
>
> Everything below is preserved as the record of the investigation. Read the
> numbers in it as historical.

## Validation result and the deferred residual (historical - see above)

Reimplementing the rule (sample `cliff_elevation_nauvis` + `cliffiness_nauvis` at the
corner lattice via the oracle, apply the crossing rule + lattice) reproduced the real
`find_entities` cliffs. Final numbers, from the committed drift-guard test
(`test/cliffPlacement.spec.ts`, fixture `oracle-cliff-entities.seed123456.json`,
region `[512,1024)^2`):

| seed   | region      | actual | predicted | matched | frac  |
| ------ | ----------- | ------ | --------- | ------- | ----- |
| 123456 | [512,1024)^2| 282    | 282       | 266     | 0.943 |
| 777771 | [512,1024)^2| 52     | 52        | 49      | 0.942 |

(An earlier spike over smaller sub-regions measured ~89-90%; the final full-region
numbers above, re-measured 2026-07-20 for Task 11, are the ones the test asserts
against with a `>= 0.85` drift guard.)

Lattice was 100% exact. The ~6% residual is **not** a phase error or f32 noise.

**It is also NOT `fixImpossibleCells` - that attribution stood from 2026-07-20 to
2026-07-28 and is now falsified by measurement.** The pass was ported (see below)
and Nauvis's numbers do not move by a single cell: 0.9433 recall / 0.9433
precision / 1.000 ratio at seed 123456 and 0.9423 / 0.9423 / 1.000 at 777771,
identical with the pass on and off. It never fires on Nauvis, which makes sense -
`cliffiness_nauvis` is a hard 0-or-10 gate, so the crossing configurations it
produces are already legal.

**The other half of the original sentence is falsified too.** `tryToAddCliff`
(`0x101625038`) drops cliffs whose orientation-specific bounding box
`wouldCollide` (`0x101625468`) - "the water/existing-entity rejection". It cannot
be the residual either:

- **Existing entities are not there yet.** `computeInternal` runs
  `generateCliffs()` *before* `generateEntities()`, so the per-tile mask grid the
  check consults holds only the tiles' masks. There is nothing else to hit.
- **The only tile layer the cliff mask intersects is `water_tile`** - so the whole
  rejection reduces to "no cliffs on water" here.
- **And that can never fire.** Measured over `[512,1024)^2` at both oracle seeds:
  **not one cliff cell touches water** - not ours, not the game's, not the matched
  ones and not the mismatched ones. `cliff_elevation_nauvis` is `10 + 30 * (...)`
  and `crossesCliff` requires both corners non-negative with `max >= elevation_0`,
  so the geometry already excludes everywhere water can be. The regions are 21.1%
  and 71.9% water, so this is a real exclusion and not a dry test window.

### Threshold sensitivity: a real effect, but not a cause

Distance from the nearest band boundary (`10 + 40k`), minimised over each cell's
four corners:

| seed | matched p10/p50/p90 | mismatched p10/p50/p90 |
| --- | --- | --- |
| 123456 | 0.04 / 0.24 / 0.60 (n=266) | 0.02 / **0.07** / 0.25 (n=16) |
| 777771 | 0.06 / 0.26 / 0.53 (n=49) | 0.04 / **0.06** / 0.06 (n=3) |

**The cells we get wrong sit 3-4x closer to a band edge than the ones we get
right.** That is what a small field difference looks like: our cliff elevation and
the game's disagree by enough to flip a corner across a boundary, but only where
the corner was already sitting on one. A structural rule we had failed to port
would not select for boundary proximity like that.

The reading taken from that on 2026-07-28 was **field precision** (f32 vs f64,
the fastapprox floor compounding through the hills chain). **That is falsified
too, later the same day - the third cause named for this residual and the third
to fail.** The table above is real; the inference from it was not. Boundary
proximity is the generic signature of a *marginal decision* - it says the
decision was close, not what tipped it. Every cause that acts through the field
produces it, so it never discriminated between them.

### The residual is NOT field precision (falsified 2026-07-28)

The one number nobody had put next to the 0.07 is how big our field error
actually is. Three measurements, two of which need no Factorio install and are
asserted in `test/cliffResidual.spec.ts`:

1. **Our `cliff_elevation_nauvis` agrees with the game to ~1e-4.** Over the
   committed 1024-point oracle grid: p50 1.03e-4, max **3.55e-4** at seed 123456
   (1.48e-4 / 4.85e-4 at 777771). The game's values come back as exact f32
   (`23.576189041137695`), so this is our port's real numerical distance, not a
   capture artefact. Note `cliffFields.spec.ts` guards this field at a **1%
   relative** tolerance - +-0.4 on a 40-wide band, five times the matched /
   mismatched separation - so that guard could never have settled this either
   way.
2. **A field error that size flips nothing.** Jittering every corner by +-eps and
   counting changed cells: `3.5e-4 -> 0`, `1e-3 -> 0`, `1e-2 -> 0.3`,
   `5e-2 -> 4.3`, `1e-1 -> 9`, `3e-1 -> 39`. Nauvis misses **16**. Reaching 16
   needs eps of order 0.1 - roughly **300x** the error we actually carry. A
   1e-4 difference cannot move a decision sitting 0.07 from a boundary.
3. **Direct capture at the failing corners agrees.** `cliff_elevation_nauvis` and
   `cliffiness_nauvis` sampled at the exact four corners of all 38 failing cells
   across both seeds (302 + 57 positions): elevation error there is 1.3e-4
   median / 3.2e-4 max - **statistically the same as at matched cells**
   (1.0e-4 / 2.9e-4), so there is no local blow-up hiding at the misses - and the
   cliffiness gate is **exact**, 0/102 and 0/19 mismatches.

The clincher: re-running `crossesCliff` + the orientation table on the **game's
own corner values** reproduces our verdict at every one of the 38 failing cells -
**0 differ**, identical codes. Re-running the whole placement pass over a
full 129x129 game-captured corner lattice likewise returns the same 282 cells and
the same 266 matches. Given the game's exact field we still place where it did
not, and skip where it did.

So the fields are not the residual. It is downstream of them.

### What that leaves - the open lead

Feeding the game's own field into the rule, **all 16 false negatives compute to
cell code `0x00`** - zero crossings on all four edges (16/16 at seed 123456, 3/3
at 777771). A cell with no crossings cannot generate a cliff, yet the game has an
entity recorded at that position. Meanwhile our 16 false positives compute to
ordinary placed codes (`0x11`, `0x40`, `0x33`, `0xc0`, ...).

Supporting geometry, captured the same day (`cliff_orientation` + `bounding_box`
for all 282 entities):

- Every entity position is **on** the cell lattice (`x mod 4 == 2`,
  `y mod 4 == 2.5`) - 0 of 282 off it - and no two entities share a position.
- The bounding-box offset from `position` is **constant per orientation** across
  all 19 orientations present, so `position` is a consistent anchor, not
  something that drifts per entity.
- 12 of 16 false positives pair with a false negative one cell away at a
  **uniform `dy = +4`** (`dx` in `{-4, 0, +4}`); never `dy = -4`. One-sided like
  that is not what random re-routing of a contour looks like.

Two candidate readings, not yet separated - **do not record either as the cause
until it is measured**:

- **The cell -> entity position convention is off** for a subset, so the entity we
  score as a miss is really our own cell recorded 4 tiles down. Against this: the
  offset is not constant per orientation (`north-to-west` appears in both the
  matched and the missed sets), and 266 entities land exactly on our cell.
- **An engine step after the crossing rule** adds and removes cliffs using state
  the four corners do not carry. `fixImpossibleCells` only ever *clears* edges,
  so it cannot create a cliff at a `0x00` cell, and it is a measured no-op on
  Nauvis - so if this is it, it is a step not yet identified.

Note what this does to the effort estimate: chasing f32/fastapprox precision
through the hills chain would have been substantial work against a cause now
excluded by 300x.

**The 2026-07-20 decision to defer the pass was still the right call on the
evidence available**, and deferring it cost nothing on Nauvis. What was wrong was
the confident attribution of the residual to it - a guess recorded as a finding.

### `fixImpossibleCells`, ported 2026-07-28

`CellEdgeCliffCrossingArray::fixImpossibleCells` (`0x10160c550`). A **single
forward sweep** over one chunk's `8x8` cells (row-major, `cy` outer), not a
fixpoint: clearing an edge changes the two cells sharing it, and visited cells are
never revisited. Per cell it clears edges until the code is legal, taking the
first **clearable** edge in order `L, T, R, B`, where clearable means not on the
chunk's outer boundary. That boundary rule is what keeps the pass chunk-local, so
the ported version needs no chunk ordering and worker tiling stays byte-identical.

Legality needs no new table. The disasm splits on `code <= 0x50` (a 0x51-byte
jump table at `0x102d00115` / `0x102d00166` - two branches, both encoding the
same accept/reject split) and `code >= 0xC0` (bitmask `0x0001000000001003`, set
bits at offsets 0, 1, 12, 48 -> codes `0xC0`, `0xC1`, `0xCC`, `0xF0`). Extracted
and compared against `CLIFF_PLACED_TABLE`: **the accepted set is exactly
`isCliffPlaced(code)` plus code `0`.** Codes `0x51..0xBF` are all rejected.

Two corrections to the paragraph this replaced:

- It does **not** zero the whole chunk border. The `bool` parameter gates zeroing
  the outer edges of the four CORNER cells only (8 edges).
- ~~`crossingsForChunk` passes **`false`**, so that step never runs in this path
  at all.~~ **WRONG, corrected 2026-07-30 by decompiling the function whole.**
  The caller does pass `false`, but the `bool` is not a caller-supplied mode - it
  is a **retry flag the function sets on itself.** On reaching a cell it cannot
  fix, the tail does

  ```
  uVar10 = param_2 & 1;  param_2 = 1;
  if (uVar10 != 0) { log("Unable to remove excess cliff cell edge crossings"); return; }
  goto <top of function>;
  ```

  so it turns the flag on and **restarts the entire pass**, which now begins by
  zeroing those eight corner edges; a second failure abandons the rest of the
  chunk. Note the restart re-sweeps the arrays **as already mutated** by the
  abandoned pass, not the raw crossings.

  This is the error the earlier note made, in its general form: reading a
  parameter's value at the call site says what the caller wants, not what the
  function does with it. Ported 2026-07-30 with `test/fixImpossibleCellsRetry.spec.ts`.

  **Do not read it as a fix for issue #18.** Measured over the committed
  captures, the retry fires **once in 512 chunks** - one chunk of Vulcanus
  `[1500,1500]`, zero across both Nauvis seeds and the other two Vulcanus regions
  - and changes not one placed cell: `[0,0]` 335, `[1500,1500]` 1065,
  `[-1200,800]` 375 before and after, with recall, precision and the orientation
  count all identical. It is correctness, not progress. Because the integration
  fixtures barely execute the branch, it has a dedicated unit spec that builds a
  stuck corner directly; disabling the retry fails 3 of its 5 tests.
- The binary is a **universal** Mach-O. Raw byte reads of those jump tables need
  the arm64 slice offset (115654656 here) added, or they silently return x86_64
  bytes - which is exactly what happened on the first extraction attempt and
  produced 47 plausible-looking distinct targets instead of 2.

Measured effect (`fixImpossibleCells: false` vs `true`, same fields, same
fixtures):

| | recall | precision | ratio |
| --- | --- | --- | --- |
| Nauvis, both seeds | unchanged | unchanged | unchanged |
| Vulcanus `[0,0]` | 0.788 -> 0.792 | 0.684 -> 0.685 | 1.152 -> 1.155 |
| Vulcanus `[1500,1500]` | 0.855 -> **0.870** | 0.718 -> 0.719 | 1.192 -> 1.210 |
| Vulcanus `[-1200,800]` | 0.801 -> 0.803 | 0.865 -> 0.866 | 0.925 -> 0.928 |

Small and one-sided: recall up everywhere (+1.5 points at its best), precision a
shade up, count a shade **worse**. Costs ~10% on the cliff pass (6.15s -> 6.77s
over `placedCells(0,0,1024,1024)` on Vulcanus, paired runs), because the chunk
path evaluates every edge of every chunk overlapping the query box rather than
only the cells asked for.

Water rejection is still approximated by the existing `WATER_TILE_COLORS`
pixel-exclusion (cliffs are not painted on water pixels).

**Task 11 cross-check (2026-07-20):** a real headless
`factorio --generate-map-preview` render of seed 123456 for the matching world
region emits the exact `CLIFF_MAP_COLOR = [144,119,87]` pixels (3990 raw pixels at
1 meter/pixel) - confirming the color extraction independently of this port. Using
those pixels as ground truth, downsampled 2x to the app's `tilesPerPixel=2` render
resolution, the app's own cliffs overlay agrees with the game's real preview output
at 95.7% (within a +-1 cell tolerance) - a second, independent measurement in the
same ballpark as the `find_entities` frac above, and visually the two masks (cell
positions tracing the same plateau-edge curves) are effectively indistinguishable at
this resolution.

## Binary symbols (cliff placement)

**Every address in this file is build-specific and several have already moved.**
The list below is as first written; the 2.1.12 addresses re-derived on 2026-07-30
are in the right-hand column. Always take them from `nm` for the binary in front of
you rather than from either column.

| symbol | as written | 2.1.12 |
| --- | --- | --- |
| `CellCliffCrossing::toMaybeCliffOrientation` | `0x1016067a0` | `0x10160c3ac` |
| `EntityMapGenerationTask::tryToAddCliff` | `0x10161f42c` | `0x101625038` |
| `EntityMapGenerationTask::wouldCollide` | `0x10161f85c` | `0x101625468` |
| `EntityMapGenerationTask::generateCliffs` | `0x10161cda8` | `0x1016229b4` |
| `CliffGenerator::crossingsForChunk` | `0x101606dc0` | `0x10160c9cc` |
| `CliffGenerator::crossesCliff` | `0x101606d08` | `0x10160c914` |
| `CellEdgeCliffCrossingArray::fixImpossibleCells(bool)` | `0x101606944` | `0x10160c550` |
| `CliffPlacementSettings::getModifiedElevationInterval` | `0x101607684` | `0x10160d290` |
| `CliffPlacementSettings::getModifiedRichness` | `0x10160a2e0` | `0x10160feec` |

Note the class name in the left column was wrong as well as the address: the repair
sweep is `CellEdgeCliffCrossingArray::fixImpossibleCells`, not `CliffGenerator::`.
(Also present but unused by Nauvis cliffs: `NoiseOperations::VoronoiNoise::*`.)

Disassemble with (as in the other notes):

```
BIN="$HOME/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio"
lldb -b -o "disassemble --name '_ZN13CliffGenerator12crossesCliffEfffff'" "$BIN"
nm "$BIN" | c++filt | grep -i cliff        # find mangled names
```

**RE-recipe note:** on some of the symbols above, `lldb "disassemble --name
'<mangled>'"` did NOT resolve the symbol on this binary (silently produced no
output/an empty disassembly) even though `nm | c++filt` clearly listed it. Use
`disassemble --start-address <VA> --end-address <VA>` against the `nm`-reported
virtual address instead - that always worked when the by-name form did not.

**Extract-then-decompile, the recipe used for the collision work (2026-07-30).**
Faster than lldb and gives C rather than asm. Two traps first:

- The Mach-O is **universal**. `llvm-objdump`'s `--start-address` AND
  `--disassemble-symbols` are both **silently ignored** on it - you get a dump of
  the whole 512 MB from the x86_64 slice, which looks like a successful run.
- Ghidra on the whole 225 MB binary is impractical. Import just the function.

```bash
FB="$HOME/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio"
FAT=115654656                      # arm64 slice offset in the fat binary
nm "$FB" | grep -i <symbol> | c++filt
# next symbol address gives the length
dd if="$FB" of=fn.bin bs=1 skip=$(( FAT + <vaddr> - 0x100000000 )) count=<len> status=none
r2 -a arm -b 64 -qc 'e scr.color=0; pd 20 @ 0' fn.bin      # sanity: expect a prologue
/opt/homebrew/Cellar/ghidra/*/libexec/support/analyzeHeadless proj p \
  -import fn.bin -processor AARCH64:LE:64:AppleSilicon \
  -loader BinaryLoader -loader-baseAddr <vaddr> \
  -scriptPath "$PWD/gscripts" -postScript decomp.java -deleteProject
```

`decomp.java` must be a **Java** GhidraScript (Python needs PyGhidra, which the
Homebrew install lacks). It takes `getBlocks()[0].getStart()` as the base
(`getImageBase()` returns null for a raw import), calls `setExecute(true)`, then
`DisassembleCommand` -> `CreateFunctionCmd` -> `DecompInterface`.

**The scriptPath gotcha that cost the most time:** the script must live in its own
directory, and **no copy may exist in the parent directory you also pass around**,
or Ghidra 12.1.2 fails with `Failed to find source bundle containing script` - which
reads like a compile error and is not.

Relative branch targets in the extracted blob are relative to the blob, so an
`adrp` printed by `r2` needs the real page added back:
`realPage = (vaddr_of_insn & ~0xfff) + printed_imm`.

## `applyEntities` and the entity stage - read for the ore mechanism (2026-08-03, #84)

Read while chasing the ore -> cliff mechanism (`vulcanus-cliffs-NOTES.md`,
`## The ore rule's mechanism`). Recorded here because it is engine-side RE and
because one of these symbols was not in these notes at all.

| symbol | address |
| --- | --- |
| `EntityMapGenerationTask::applyEntities(Surface&)` | `0x10162422c` |
| `EntityMapGenerationTask::tryToAddEntity(...)` | `0x101625298` |
| `EntityMapGenerationTask::generateEntities(NoiseCache&)` | `0x101622dec` |
| **`Surface::mapGeneratorWouldCollide(EntityPrototype const&, MapPosition const&, Direction const&)**` | `0x101624a44` |
| `CliffCraterPlacer::tryToPlaceCliffAsCrater(...)` | `0x10160bcac` |

**`Surface::mapGeneratorWouldCollide` is a different function from both
`EntityMapGenerationTask::wouldCollide` (`0x101625468`, tile-index based) and
`Surface::wouldCollide` (`0x10160c088`, the cliff one).** It is the entity
stage's own surface query, and it had not been recorded.

### The order, read off the binary rather than quoted

`EntityMapGenerationTask::computeInternal` (`0x101622860`):

```
+0x2c   generateCliffs()                     <- FIRST, before the NoiseCache exists
+0x40   NoiseProgram::getChunkNoiseCache()
+0x94   generateEntities(NoiseCache&)        <- called three times
+0xa4   generateEntities(NoiseCache&)
+0xbc   generateEntities(NoiseCache&)
+0xd0   generateDecoratives(NoiseCache&)
```

`EntityMapGenerationTask::apply` (`0x101623b48`):

```
+0x6c   Chunk::Chunk(...)
+0x7c   applyCliffs(Surface&)
+0x98   applyDecoratives(Surface&, Chunk&)
+0xa4   applyEntities(Surface&)
+0xe4   Surface::onChunkGenerated(Chunk&)
```

So cliffs are decided and placed before any entity in the same chunk, in both
phases - and `generateCliffs` runs before the chunk noise cache is even built.

### `generateCliffs` has no resource input

Its entire call list is `CliffGenerator::crossingsForChunk`,
`MaybeCliffOrientation::value` and `tryToAddCliff` (plus a destructor and two
`logAndAbortOrThrow` arms). Nothing else reaches the queue.

### `applyEntities` SKIPS a colliding entity; it never destroys a cliff

```
101624458: bl   Surface::mapGeneratorWouldCollide(proto, position, direction)
10162445c: tbnz w0, #0x0, +0x10c        <- collided: skip to the loop tail
           ... construct entity, EntityVariationGenerator::apply, addEntityToSurface
```

`tryToAddEntity` has the same shape one stage earlier, against
`EntityMapGenerationTask::wouldCollide`. So the only entity-versus-cliff test in
map generation runs CLIFF -> ENTITY, which is the direction #99 measured as
inert. Nothing in the entity stage removes a cliff.

The one thing in `applyEntities` that does add cliffs is
`CliffCraterPlacer::tryToPlaceCliffAsCrater` at its head - which is `crater-cliff`,
already documented above as off-lattice and not the residual.
