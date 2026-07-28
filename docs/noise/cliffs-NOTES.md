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

### The lattice (confirmed 100% exact)

`grid_size = {4,4}`, `grid_offset = {0, 0.5}` (from `scaled_cliff`). A 32-tile chunk
= `8x8` cells of `4x4` tiles; fields sampled at the `9x9` cell corners; the entity is
placed at the cell **center**:

```
corner(i,j)  world tile = ( chunkX*32 + i*4 + 0,  chunkY*32 + j*4 + 0.5 )
cliff center world tile = ( chunkX*32 + cx*4 + 2, chunkY*32 + cy*4 + 2.5 )   -> x≡2, y≡2.5 (mod 4)
```

Every dumped cliff across both test seeds matched `x mod 4 == 2` and `y mod 4 == 2.5`
exactly. (`generateCliffs` @ `0x10161cda8`, constants `32.0`, `grid_size/2=2.0`,
`grid_offset` from `[proto+0xb70/0xb78]`.)

### Cell -> cliff (orientation code)

For cell `(cx,cy)` the four edges are the crossings on its shared corner pairs:
`L=cross(corner(cx,cy),corner(cx,cy+1))`, `R=cross(corner(cx+1,cy),corner(cx+1,cy+1))`,
`T=cross(corner(cx,cy),corner(cx+1,cy))`, `B=cross(corner(cx,cy+1),corner(cx+1,cy+1))`.
`generateCliffs +292..+308` packs `code = (enc(L)<<6)|(enc(R)<<4)|(enc(T)<<2)|enc(B)`
(2 bits each, -1 encoded as 3). `CellCliffCrossing::toMaybeCliffOrientation`
(`0x1016067a0`) maps the 256 codes -> a `CliffOrientation` (16 of them: N-S, W-E,
inner/outer/entrance corners) or "none". A cell whose code maps to non-none gets a
cliff. **For the preview render we need only the boolean not-none** (which cells get a
cliff), not the sprite orientation; extract the `code -> none/not-none` predicate from
the table.

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

## Validation result and the deferred residual

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

### So what IS the residual? Threshold sensitivity in the field

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

So the follow-up is **field precision** (f32 vs f64, the fastapprox floor
compounding through the hills chain), not a missing pass - a materially different
piece of work from the two that were assumed for eight days. Asserted in
`test/cliffResidual.spec.ts`, including a non-vacuity check on the water test,
because "no cliff touches water" would pass just as happily against a tile
resolver that never returned water at all.

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

`CliffGenerator::crossesCliff(float,float,float,float,float)` @ `0x101606d08`;
`::crossingsForChunk(CompiledMapGenSettings const&, ChunkPosition const&)` @
`0x101606dc0`; `EntityMapGenerationTask::generateCliffs()` @ `0x10161cda8`,
`::tryToAddCliff(...)` @ `0x10161f42c`, `::wouldCollide` @ `0x10161f85c`;
`CellCliffCrossing::toMaybeCliffOrientation` @ `0x1016067a0`;
`CliffGenerator::fixImpossibleCells` @ `0x101606944`;
`MapGenSettingsHelpers::CliffPlacementSettings::getModifiedElevationInterval` @
`0x101607684`, `::getModifiedRichness` @ `0x10160a2e0`. (Also present but unused by
Nauvis cliffs: `NoiseOperations::VoronoiNoise::*`.)

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
