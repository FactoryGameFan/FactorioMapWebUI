# Tile correction - the map-gen pass that rewrites tile boundaries

**Status: reverse-engineered, NOT ported.** This file records what the pass is,
what it reads, and how it is scoped. It does not claim a complete algorithm -
the section at the end lists exactly what is still unknown.

Every claim below is graded. "Decoded" means read out of the disassembly
instruction by instruction. "Structural" means the shape is clear from the call
graph, loop bounds or argument setup, but the fine detail was not traced.
"Open" means two readings disagree and neither was settled.

## Why this file exists

Three separate residuals in the Fulgora port pointed the same way:

| residual | count | game places the LOWER-`layer` tile |
| --- | --- | --- |
| land argmax | 124 | 120 |
| land vs ocean | 7 | 7 |
| shallow vs deep | 11 | 8 |

135 of 142. `docs/noise/fulgora-elevation-NOTES.md` recorded that as a **lead**,
not a finding, because nothing showed `layer` was the mechanism rather than a
proxy for the natural-versus-artificial grouping it tracks. Two other facts sat
beside it: the mismatches are boundary-exclusive (121 of 124 are next to a
position the port already gets right), and the game's own evaluation of its own
expressions disagrees with what the game places - so the defect is not in the
formulas at all.

That lead is now a named mechanism.

## What it is

**`TileCorrectionMapGenerationTask`**, a distinct map-generation task. Its
source path survives in the binary's string table:

```
src/Map/TileCorrectionMapGenerationTask.cpp
```

**How this was established.** The Steam build is not stripped, so its symbol
table names map-gen internals directly (see `docs/noise/basis-noise-NOTES.md`
for the general recipe). Searching the symbols for a pass that runs after tile
placement turns this up. It is a separate stage from tile autoplace, which is
why no amount of work on the `probability_expression`s could ever have reached
it.

There is a second, older-looking copy of the same idea on `MapGenerator`
itself - `MapGenerator::correctAndSelectTileTransitions`,
`MapGenerator::correctFromTile`, `MapGenerator::trySecondPass`, and a
`MapGenerator::TileCorrectionBuffers`. `correctAndSelectTileTransitionsAfterManualEditing`
also exists, which is the map-editor path. This file is about the map-generation
task, not those.

### The symbol set, with sizes from the arm64 slice

| function | size |
| --- | --- |
| `apply(Surface&)` | 2872 B |
| `computeInternal()` | 2020 B |
| `isTileConsistentWithFixedTiles(...)` | 1880 B |
| `correctFromTile(AreaPosition, TileCorrectionBuffers&, vector<AreaPosition>&)` | 1612 B |
| `checkForStrongDiagonalSupport(...)` | 712 B |
| `checkForWeakDiagonalSupport(...)` | 664 B |
| `countFixedNeighborsOfKind(AreaPosition, ID<TilePrototype,u16>)` | 360 B |
| `canStartTask(Surface const&, ChunkPosition const&)` | 292 B |
| `trySecondPass(TileCorrectionBuffers&, vector<AreaPosition>&)` | 228 B |
| `isStrongHighLayerSupport(...)` | 116 B |
| `isWeakHighLayerSupport(...)` | 116 B |
| `isTileFixed(...)` | 40 B |
| `setTileFixed(...)` | 24 B |
| `TileCorrectionDebugPreview::save() const` | 3120 B |

About 7.7 KB of code in the eight functions that matter.

## Object layout - DECODED

Read out of the address arithmetic, which is consistent across every function
that touches it:

| what | where |
| --- | --- |
| chunk position | `this+0x10` (int32), `this+0x14` (int32) |
| the tile grid | `this+0x20`, a 96 x 96 array of `u16` prototype ids |
| grid indexing | `this + 0x20 + a*192 + b*2`, so `a` is the row and `b` the column |
| the "fixed" map | `array<array<bool,96>,96>`, passed by pointer, indexed `[a*96 + b]` |
| effective layer | `TilePrototype + 0x1b8`, a `u16` |
| `AreaPosition` | `{ int32 a; int32 b }` - field 0 is the row, field 4 the column |

96 x 96 x 2 bytes = `0x4800`, so the grid runs `0x20` to `0x481F`. Fields at
`0x4838`, `0x4850` and `0x4858` are read by `computeInternal` and were not
identified.

## Scope: a 3x3 chunk neighbourhood - DECODED

96 is 3 x 32, and `computeInternal` confirms it rather than leaving it to
inference. It loads the chunk position from `this+0x10` / `this+0x14` and runs a
double loop from `chunk - 1` with an exit test against `chunk + 2` - so offsets
-1, 0 and +1 on both axes. It then shifts the chunk index left by 5 to get tile
coordinates.

`canStartTask(Surface const&, ChunkPosition const&)` walks the same
neighbourhood, and for each neighbouring chunk checks that the chunk exists and
that a byte at offset `0x1424` has passed a threshold (the code compares against
`0x13` and `0x14`, i.e. 19 and 20). That byte is a generation-stage marker.

**So tile correction cannot run until the surrounding chunks have been
generated.** That is the direct explanation for why the Fulgora mismatches are
boundary-concentrated: this pass only ever looks at boundaries, and it only runs
where a full neighbourhood exists.

## The layer comparison - DECODED

`isWeakHighLayerSupport` and `isStrongHighLayerSupport` are 116 bytes each and
**byte-identical to each other** in the 2.1.14 build. Decoded:

```
isHighLayerSupport(pos, candidate, fixedMap):
    if (pos.a < 0)                  return true    # off the area
    if (pos.b > 95 || pos.a > 95)   return true    # off the area
    if (fixedMap && !fixedMap[pos.a*96 + pos.b])
                                    return true    # neighbour not fixed yet
    id = grid[pos.a*96 + pos.b]
    return prototypes[id]->layer > candidate->layer
```

So "high layer support" means **a neighbour whose effective layer is strictly
higher than the candidate's**, with off-the-area and not-yet-fixed both treated
permissively as support.

This is the `layer` lead confirmed by name and by instruction rather than by
correlation. It does not by itself say which tile wins - that is
`isTileConsistentWithFixedTiles`, below, which is not fully decoded.

## `countFixedNeighborsOfKind` - DECODED

A fully unrolled scan of the 8 surrounding cells, counting those whose grid id
equals the id passed in. Cells outside the 96 x 96 area are skipped and do not
count. Despite the name it takes no `fixedMap` argument - the signature is
`(AreaPosition const&, ID<TilePrototype, u16>)` - so "fixed" refers to the state
of the grid at the time it is called, not to a separate test.

## The diagonal support checks - STRUCTURAL

Both take `(AreaPosition const& pos, bool which, TilePrototype const& candidate,
array<array<bool,96>,96> const* fixedMap)`. Both inline the layer test above at
four positions, and both combine them as:

```
(support(A) && support(B)) || (support(C) && support(D))
```

The `bool` picks which diagonal the four orthogonal neighbours flank:

| `which` | first pair (A, B) | second pair (C, D) |
| --- | --- | --- |
| true | `(a-1, b)`, `(a, b-1)` | `(a+1, b)`, `(a, b+1)` |
| false | `(a-1, b)`, `(a, b+1)` | `(a+1, b)`, `(a, b-1)` |

So each pair is the two orthogonal neighbours that flank one end of a diagonal,
and the test asks whether either end is fully supported. Both call sites in
`isTileConsistentWithFixedTiles` compute that bool the same way, as
`(v != 1)` for some value `v` that was not identified.

## OPEN: what actually differs between weak and strong

This was chased and **not settled**, so it is recorded as open rather than
guessed at. Both readings are written down because the next person will
otherwise repeat the same two dead ends.

- **Reading 1: they differ in how an unfixed neighbour is treated.** Tracing the
  branch targets by hand, the inlined test in `checkForStrongDiagonalSupport`
  appears to send "neighbour not yet fixed" to the same continuation as "no
  support", while `checkForWeakDiagonalSupport` sends it to the same
  continuation as "has support". That would be a clean and meaningful
  distinction: weak gives an ungenerated neighbour the benefit of the doubt and
  strong does not.
- **Reading 2: they are the same algorithm.** The two functions' instruction
  streams line up almost one for one. The differences are register allocation
  (`w11` against `w12`) and three prototype-table reloads that the weak version
  common-subexpressions away, which accounts for the 48-byte size gap. The
  standalone `isWeakHighLayerSupport` and `isStrongHighLayerSupport` are
  byte-identical, which is what you would expect if the source-level
  distinction currently collapses.

The one piece of evidence that separates them: the opcode histograms differ by
exactly one flipped comparison - weak has 20 `b.hi` and 2 `b.ls`, strong has 19
`b.hi` and 3 `b.ls`. That is consistent with reading 1, but it is **not proof**,
because a compiler can express identical logic with an inverted branch and
swapped targets.

**What would settle it:** a full trace of both functions' control flow with the
branch targets resolved, or an experiment against the game that puts an unfixed
neighbour next to a candidate and observes whether the two paths diverge. Do not
record either reading as a finding until one of those is done.

## The decision function and the driver - STRUCTURAL

The call graph, extracted from the branch targets:

| caller | calls |
| --- | --- |
| `computeInternal` | `correctFromTile` (34 call sites), `isTileConsistentWithFixedTiles` (1) |
| `correctFromTile` | `isTileConsistentWithFixedTiles` (2), vector push-back (3) |
| `isTileConsistentWithFixedTiles` | `countFixedNeighborsOfKind` (2), `checkForWeakDiagonalSupport` (2), `checkForStrongDiagonalSupport` (1) |
| `trySecondPass` | `correctFromTile` (1), `isTileConsistentWithFixedTiles` (1) |

Three things worth knowing from that alone:

- **`isTileConsistentWithFixedTiles` is the rewrite.** Its signature ends
  `..., bool&, ID<TilePrototype, unsigned short>&` - two non-const output
  references. It does not just answer yes or no; it hands back a replacement
  tile.
- **Weak is called twice and strong once.** The asymmetry is real and is
  probably the two diagonal orientations for one test and a single orientation
  for another, but which is which was not traced.
- **It is a work queue, not a raster scan.** `correctFromTile` takes a
  `vector<AreaPosition>&` and pushes onto it, and `computeInternal` passes the
  same stack slot to all 34 call sites (`sub x2, x29, #0x90` appears exactly 34
  times). So corrections spread from a seed position to their neighbours, which
  is how one replacement can cascade. `trySecondPass` then re-runs the whole
  thing, so a single pass is not the final state.

The 34 call sites are compiler tail-duplication of one logical call, not 34
distinct scan positions.

## `layer` is an OFFSET from `layer_group`, and the Fulgora notes ignored that

From the prototype docs: `TilePrototype::layer` is a `uint8` and "represents the
positive offset from this tile's `layer_group`. Internally, the final layer is
computed as `layer_group + layer` (a uint16)". The `u16` at `TilePrototype+0x1b8`
that the code above reads is that combined value.

`fulgora-elevation-NOTES.md` compared **raw** `layer` values across all twelve
Fulgora tiles. Checking the prototypes:

| tiles | `layer_group` | raw `layer` |
| --- | --- | --- |
| all eight land tiles | `ground-natural` (the default) | 5 to 12 |
| `oil-ocean-shallow`, `oil-ocean-shallow-2` | `ground-natural` | 4, 3 |
| `oil-ocean-deep`, `oil-ocean-deep-2` | **`water`** | 2, 3 |

- The **land** result (120 of 124) is entirely within `ground-natural`, so it
  stands exactly as written.
- The **land versus ocean** result (7 of 7) compares `oil-ocean-shallow-2`
  against land tiles, also all within `ground-natural`. It stands too.
- The **shallow versus deep** result (8 of 11) compares the `water` group
  against `ground-natural`. That comparison was **not valid as stated**. Its
  conclusion survives, because the docs place `ground-natural` above `water`
  ("used for natural tile sprites above water"), so deep really does have the
  lower effective layer - by a wider margin than the raw numbers suggested. The
  reasoning in that entry needs correcting even though the direction does not.

Anyone extending this to another planet must compare `layer_group + layer`, not
`layer`. Two tiles in different groups can have raw layers that order one way
and effective layers that order the other.

## What this means for the client-side preview

This is the part that decides whether it is worth porting.

The renderer resolves each **pixel** independently, which is what makes it
cheap - about 4.8 microseconds per pixel on Fulgora. Tile correction is defined
on **tiles**, over a 3x3 chunk neighbourhood, with a fixed-tile bitmap, a work
queue and a second pass. To reproduce it the preview would have to:

- resolve a **tile grid** with at least a one-chunk margin around the view,
- run the correction over that grid, and
- sample pixels out of the corrected grid.

And at `tilesPerPixel > 1`, which is every zoomed-out view, it cannot be applied
faithfully at all: one pixel covers many tiles and the correction is per tile.

So this is not a patch to the argmax. It is a change to how a planet renders.

**And the game's own preview does not run it.** Measured on 2026-10-22 (see
"Does the preview PNG run it?" below): the `--generate-map-preview` PNG shows
the raw argmax, never the corrected tile. So a client preview that matches the
game's preview must NOT port this pass. It matters only to anyone who wants to
match `get_tile` in a real save.

## What is NOT established

- The body of `isTileConsistentWithFixedTiles` - the actual rule that decides a
  tile is inconsistent, and how the replacement is chosen. This is the heart of
  the pass and it is not decoded.
- The thresholds the two `countFixedNeighborsOfKind` results are compared
  against.
- The weak versus strong distinction (see the OPEN section).
- The scan order in `computeInternal`, and what the fields at `0x4838`,
  `0x4850` and `0x4858` hold.
- What `apply(Surface&)` writes back, and whether it can change tiles outside
  the centre chunk.
- **How much of the Fulgora residual this pass actually explains.** Not
  measured at the forced seed. At the derived seed, in two boundary-heavy
  blocks, `get_tile` differs from the game's own raw argmax at 1,445 of 18,432
  tiles (see below), which is the size of effect the forced-seed residual
  suggested. `canStartTask` suggested an experiment - generate an isolated
  chunk, which may never be corrected. **That lever was tried and does not
  work** (2026-10-22): a chunk generated alone is corrected exactly as one with
  all its neighbours generated. See below.
- There is **no user-facing debug toggle**. `TileCorrectionDebugPreview::save()`
  exists but no settings string references it, so it is presumably dev-build
  only.

## Reproducing the symbol work

```bash
BIN="$HOME/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio"
lipo -thin arm64 "$BIN" -output /tmp/factorio.arm64      # the Mach-O is universal
nm -U /tmp/factorio.arm64 | c++filt | grep TileCorrection
objdump -d --start-address=0x1016827e4 --stop-address=0x1016828cc /tmp/factorio.arm64
```

Addresses are from the 2.1.14 build (Steam, `pnpm refs:sync --check` in sync at
capture time, 2026-08-14) and **will move on any update**. Re-derive them from
the symbol table rather than reusing the numbers above.

## The last differing pixel on Nauvis and Vulcanus

Each planet still differs from the game's own preview PNG at exactly one
pixel. This section records how close the tile scores are at those two tiles,
measured on our side only. `the_last_nauvis_pixel_is_a_known_argmax` and
`the_last_vulcanus_pixel_is_a_known_argmax` in `crates/fmw-noise/src/fixtures.rs`
freeze the numbers, and both are in `POISONED_TESTS`.

Measured 2026-10-22, through the chunk-grid path (`At::tile`), with the
preview comparison's setup:

| planet   | PNG pixel | tile       | game draws       | we draw                | runner-up (ours)  | winner score | runner-up score | gap in f32 ULPs |
| -------- | --------- | ---------- | ---------------- | ---------------------- | ----------------- | -----------: | --------------: | --------------: |
| Nauvis   | 741,493   | 229,-19    | grass-1          | grass-3                | grass-1           |    1.3117754 |       1.3117691 |              53 |
| Vulcanus | 151,523   | -361,11    | volcanic-cracks  | volcanic-cracks-warm   | volcanic-cracks   |    0.3568011 |       0.3562259 |          19,301 |

In both cases the runner-up is the tile the game draws. So the game's choice
is our second-best, not some tile we score far away.

What the gap means:

- A gap of a few ULPs would point to a rounding near-tie. The game keeps these
  scores in f32, so a one-ULP difference in an input could flip the winner.
- A large gap pointed to a step that runs after tile choice, which we do not
  port. That was the hypothesis Task 7 tested, and the next section refutes
  it: the preview PNG runs no such step.

Nauvis sits at 53 ULPs (about 6.3e-6). That is small but not one or two ULPs.
Vulcanus sits at 19,301 ULPs (about 5.8e-4), which is far too wide for
rounding. The Vulcanus numbers use host libm trig; the shipped engine takes V8
trig narrowed to f32, but a gap this wide is not something a few-ULP trig
difference can close.

The probe in the next section settled it: neither pixel is tile correction.
The game's own raw argmax already picks the tile it draws, and our scores
differ from the game's.

## Does the preview PNG run it? No - measured 2026-10-22

`scripts/probes/preview-tile-correction/` asks the game three things about the
same tiles, at map seed 123456 with the derived surface seeds, the terrain-only
mod and the PNGs' disabled controls:

- **raw** - the winner among the game's own tile scores. `calculate_tile_properties`
  accepts the property name `tile:<name>:probability` in 2.1.23 and returns the
  tile's `probability_expression`. A data-stage copy of each expression returns
  the same value at every position. Both run on the POINT noise kernel, not the
  chunk-grid kernel that map generation uses, so a near tie could differ.
- **filled** - `get_tile` after the block and all its neighbours are generated.
- **the PNG** - the committed terrain-only preview, matched through `map_color`.

The fixture is `test/fixtures/oracle-preview-tile-correction.json`.

| 96 x 96 block | agree | PNG matches there | differ | PNG shows raw | PNG shows filled | same colour |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Nauvis, around (229, -19) | 9,177 | 9,177 | 39 | 39 | 0 | 0 |
| Vulcanus, around (-361, 11) | 8,760 | 8,760 | 456 | 454 | 0 | 2 |
| Fulgora, chunks (-4..-2, 10..12) | 8,494 | 8,494 | 722 | 722 | 0 | 0 |
| Fulgora, chunks (-12..-10, -1..1) | 8,493 | 8,493 | 723 | 717 | 0 | 6 |

**The PNG never shows a corrected tile.** Of 1,940 tiles where `get_tile` and
the raw winner differ, the PNG shows the raw tile at 1,932 and the corrected
tile at none. The other 8 fall where both tiles share a map colour. On Fulgora,
1,436 of the differing tiles lose the raw score by at least 0.001, far more
than the two kernels can move a score. Those are tiles the game rewrote after
the argmax, so the probe could see correction, and the PNG could have shown it.
Where the two readings agree, the PNG matches all 34,924 tiles, so the pixel
grid and colour table are right.

The binary agrees, as far as direct calls go. In 2.1.23 the preview worker
calls `BasicTilesMapGenerationTask::generateBasicTiles` and makes no direct call
to `TileCorrectionMapGenerationTask` or `correctAndSelectTileTransitions`.

### The two pixels are a score difference, not correction

| tile | the game's raw scores | ours, same point kernel | ours, grid (Task 1) | `get_tile` | PNG |
| --- | --- | --- | --- | --- | --- |
| Nauvis (229, -19) | grass-1 1.3117774, grass-3 1.3117646 | grass-1 1.3117714, grass-3 1.3117754 | grass-1 1.3117691, grass-3 1.3117754 | grass-1 | grass-1 |
| Vulcanus (-361, 11) | volcanic-cracks 0.3580069, volcanic-cracks-warm 0.3568015 | volcanic-cracks 0.3562072, volcanic-cracks-warm 0.3568015 | volcanic-cracks 0.3562259, volcanic-cracks-warm 0.3568011 | volcanic-cracks-warm | volcanic-cracks |

- **Nauvis.** The game's own scores put grass-1 first by 107 f32 ULPs. Ours put
  grass-3 first, on the point kernel and the grid kernel alike. Through the
  same point kernel, our grass-1 is 50 ULPs (6.0e-6) low and our grass-3 is 90
  ULPs (1.08e-5) high. Switching our own engine from the point kernel to the
  grid kernel moves those two scores by only 19 and 0 ULPs here. So the gap is
  most likely in our expressions or their inputs, and it is not a later pass.
  That rests on our point kernel matching the game's. The point-kernel
  fixtures show this for the noise primitives, but nobody checked the
  elevation, aux and moisture inputs at this tile. Which term moves was not
  measured. The likely home is issue #452 (Nauvis fields), which already
  records our elevation, moisture and aux missing exact matches that an
  independent engine gets.
- **Vulcanus.** The game's own scores put volcanic-cracks first by 40,448 ULPs.
  Our volcanic-cracks-warm matches the game's to the ULP, but our
  volcanic-cracks is 60,387 ULPs (1.8e-3) low. Our own grid-vs-point shift is
  627 ULPs, about 1% of that. That is a defect in our volcanic-cracks score
  at this tile, far too large for trig or rounding. It is tracked in #488
  and not fixed here.
  `get_tile` reads volcanic-cracks-warm here because correction rewrote the
  raw tile. That is the tile we draw, but only by coincidence, and the PNG does
  not show it.

The "ours, same point kernel" column and the ULP counts are frozen in
`the_last_nauvis_pixel_on_the_point_kernel_against_the_game` and
`the_last_vulcanus_pixel_on_the_point_kernel_against_the_game` in
`crates/fmw-noise/src/fixtures.rs`. They read the game's scores from the
fixture and state their setup: `At::point` at the integer tile corner the
probe sampled, Nauvis's `grid` flag off, Vulcanus with host libm trig and its
four resource controls at size 0. Both are in `POISONED_TESTS`. The grid
column is Task 1's frozen numbers.

### An isolated chunk is still corrected

The probe's second arm generates one chunk alone, in a separate run, with
`request_to_generate_chunks(p, 0)`. `is_chunk_generated` then reports only that
chunk, before and after reading its neighbours. Its tiles still equal the
filled arm's at all 1,024 positions, on Nauvis, Vulcanus and Fulgora alike. In
the Fulgora chunk, (-4, 10), all 112 tiles the game rewrote come back
rewritten. The centre chunk is read before any neighbour, so reading cannot
have caused this. The game builds the neighbourhood it needs without marking
those chunks generated, and `get_tile` on them also returns tiles that mostly
match the filled arm. So "generate an isolated chunk" cannot switch correction
off.

### What this means for the pixel bar

A pixel where the engine differs from the game's preview cannot be explained as
tile correction, because the preview does not run it. Every such pixel is a
difference in the raw scores.
