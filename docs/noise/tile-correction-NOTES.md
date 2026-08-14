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
- **How much of the Fulgora residual this pass actually explains.** Nothing here
  measures that. The mechanism matching the residual's direction and shape is
  suggestive, not a measurement. `canStartTask` gating on neighbour chunks
  suggests an experiment - generate an isolated chunk, which may never be
  corrected, and compare `get_tile` against the same coordinates inside a filled
  region - but that lever is untested and the task may well run on save, on
  load, or on first access.
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
