# Cliffs (M4) - reverse-engineering notes

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

## Placement rule (disasm-confirmed + validated ~90% tile-for-tile)

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

1. **`fixImpossibleCells` in detail.** It only accounts for 1.8 points of the
   12.5 as ported, but "our sweep differs subtly from the game's" is not excluded
   by that - a different sweep could be both closer AND worth more.
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
never read by the collision test**. Whatever drains the queue consumes it. The
port's `tileCollides` post-filter models the `mode == 2` path, which is the one
map generation takes; the flag remains unmodelled and is measured not to matter
for placement.

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

## Validation result: EXACT since 2026-07-30 (the residual is resolved)

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
  the outer edges of the four CORNER cells only (8 edges) - and
  `crossingsForChunk` passes **`false`** (`mov w1, #0x0` at `0x10160d0c8`), so
  that step never runs in this path at all.
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
