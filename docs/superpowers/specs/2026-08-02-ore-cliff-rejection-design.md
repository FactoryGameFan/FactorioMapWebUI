# Porting the ORE -> CLIFF rejection (issue #84, item 1)

**Date:** 2026-08-02
**Status:** implemented, measured, shipped on `feat/cliff-ore-rejection`

> Point-in-time design record, per `docs/superpowers/specs/` convention. Not a
> living document - the current state of the rule lives in
> `docs/noise/vulcanus-cliffs-NOTES.md` and `src/noise/cliffs/vulcanusOreRejection.ts`.

## Problem

PR #99 settled that Vulcanus resources suppress cliffs (`ORE -> CLIFF`, not the
reverse) and characterised the rule as one-way, additive, local, and shaped like
a box overlap against the resource entity's rectangle. It scored 21 of 31
suppressed cells with zero false alarms in 885.

It deliberately stopped short of porting it, flagging one open sub-question:

> whether driving it from `renderVulcanusResources` (rather than the game's
> entities, which is what the 31/0 score uses) is accurate enough

That is this work.

## Decisions, and what settled each

Four forks. Each was settled by a measurement taken during implementation, not
by preference - the numbers are in `test/cliffOreRejection.spec.ts`.

| decision | chosen | what settled it |
| --- | --- | --- |
| geyser included? | **no**, behind `includeGeyser` | strictly harmful: +1 false rejection, +0 correct |
| cliff rectangle | **prototype base box** | per-orientation catches +1 true cell and costs 2 kept cliffs |
| the unexplained 10 | **not tuned away** | pinned as a gap; #88/#90's lesson |
| where the predicate hangs | **`CliffBands.cellRejects`** | keeps the scored model and the shipped model identical |

### Why recall is the gate

The rule can only ever remove cells. Every cell it fires on at `[1500,1500]` is
surplus, so it is pure precision gain - unless it removes a cliff the game kept,
which is a false rejection and costs recall. Recall is the expensive half of this
port (1.000/0.973/0.965), so "zero false rejections" is a hard gate, not a
report. Both rejected variants fail exactly that gate.

## Architecture

```
CliffBands.cellRejects?: (code, x, y) => boolean     // cliffPlacement.ts, beside tileCollides
    ^ supplied by
makeVulcanusOreRejection(resources, controls, opts)  // cliffs/vulcanusOreRejection.ts
    ^ wired by
renderVulcanusCliffs                                 // reads VulcanusStack.resources
```

`cellRejects` is applied in both paths of `placedCells` (chunked and unchunked),
after the bounds test and after `tileCollides`. It is deliberately an opaque
predicate: the cliff core is planet-agnostic engine behaviour, and this rule is
neither planet-agnostic nor engine-confirmed.

**It hangs there rather than filtering `placedCells`' output** because every spec
drives `makeCliffPlacementFromFields` directly. A filter applied further out
would mean the specs score an unfiltered model while the renderer ships a
filtered one - the same class of silent divergence as the
`worker-configuration.d.ts` drift.

Like `tileCollides` it is a pure per-cell post-filter with no effect on
neighbours, so worker tiling stays byte-identical for free.

### The predicate

- **Cliff box**: `+/-0.98828125 x +/-0.48828125`, the prototype `collision_box`
  the fixture carries - *not* the per-orientation rotbb the lava rejection uses.
- **Ore footprint**: `makeVulcanusOreFootprint`, sharing
  `RESOURCE_PROBABILITY_THRESHOLD` with the ore overlay so the two cannot drift
  onto different footprints. A control at `size = 0` occupies nothing, which is
  the same lever the game was driven with.
- **No entity enumeration.** The tiles whose centres can overlap follow in closed
  form from the two rectangles: exactly 2 tiles for an ore, 4x3 for a geyser,
  against the lava rejection's ~30. The derivation is guarded by a brute-force
  scan a tile wider on every side, not trusted.
- Reuses the composite's `VulcanusStack.resources`; `memoXY` is single-entry, so
  a private DAG would share nothing and pay for the whole tree again.

## Results

| region | game | placed | fires | false rejections | surplus |
| --- | --- | --- | --- | --- | --- |
| `[0,0]` | 283 | 283 | 0 | 0 | 2 -> 2 |
| `[1500,1500]` | 885 | 900 | 20 | **0** | 42 -> **22** |
| `[-1200,800]` | 401 | 387 | 0 | 0 | 1 -> 1 |

Precision at `[1500,1500]`: 0.953 -> **0.975**, true positives untouched. Driving
from the port's own ore model instead of the game's entities costs exactly one
cell (20 against 21).

## What is deliberately not claimed

- **The mechanism is open.** The disassembly still says cliffs are computed and
  placed before any resource entity exists, so this is a characterised empirical
  rule, not a port of a known engine path. Both the module comment and the notes
  say so.
- **11 of 31 are unexplained** (10 run remainders + 1 our ore model misses) and
  the box is not widened until they fall out.
- **The two cliff rectangles now disagree** - base box for ore, per-orientation
  for lava. Defensible only while the ore mechanism is open; revisit first if it
  is ever found.

## Testing

`test/cliffOreRejection.spec.ts`, 8 tests. Scores the shipped predicate across
all three oracle regions; scores both rejected variants so the choice is a
record rather than an assumption; pins the remainder at 11; guards the derived
tile window; asserts the disable path fires zero times; and cross-checks that the
rejection's footprint equals the ore overlay's painted pixels.

Two non-vacuity guards earned their keep: the footprint cross-check was
initially vacuous on a 64x64 window containing no ore, and `painted > 0` caught
it.
