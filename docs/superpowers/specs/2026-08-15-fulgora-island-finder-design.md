# Fulgora island finder: survey, measure, rank, chain

Design record, 2026-08-15. Point-in-time, not a living document.

Issue: [#27 - Fulgora & large island finder](https://github.com/wormeyman/FactorioMapWebUI/issues/27).

## 1. Scope

The whole text of issue #27 is the island finder:

> Have a tool or an option to find large islands or perhaps large island chains
> that can have regular power poles connect for mega basing, or just easier
> starting out.

Everything shipped for Fulgora so far - V1 terrain, V2 land tiles, V3 scrap - is
the engine that makes this answerable. This spec covers the finder itself.

Four decisions were taken before the design was written:

| decision | choice |
| --- | --- |
| output | a ranked, sortable list; clicking a row re-centers the preview |
| search area | a user-set radius, default 5,000 tiles (a 10k x 10k box) |
| chain rule | big power pole, **30 tiles** of wire reach |
| ranking metric | **largest inscribed rectangle** |
| class filter | none - rank all classes, show class as a column |

### Non-goals

- **Other planets.** The Nauvis "island" map type has islands too, and the
  measure/rank/chain stages would work there unchanged. Stage 1 would not: it
  depends on Fulgora's Voronoi structure. Keep the later stages planet-agnostic
  where it is free to do so, but do not build or test a second planet here.
- **Rotated rectangles.** Factorio builds on an axis-aligned grid, so an
  axis-aligned rectangle is the useful answer, not a weaker approximation of a
  rotated one.
- **Buildable-area accounting.** Scrap patches and ruin tiles sit on the land
  and do consume space. Excluding them was considered and dropped: it needs the
  V2 land-tile argmax and the V3 scrap roll per candidate, and section 2 shows
  the argmax is not where the cost is, so this is a genuine option for a later
  revision rather than something closed off.
- **Sliders for the search.** The radius is the one control. No frequency or
  size levers of its own; the finder reads the preset's existing
  `control:fulgora_islands:*` values, because those change the grid and so
  change the answer.

## 2. What was measured before this spec was written

Every number here came from a throwaway benchmark against the current tree, seed
`2967702466` (Fulgora's surface seed for map seed 123456). None is an estimate.

**The survey pass is effectively free.**

| what | result |
| --- | --- |
| one `cells` evaluation | **2.33 us** |
| 43,400 samples, a 48-tile step over 10k x 10k | **101 ms** |
| share of samples that are ocean (`cells < 0.33`) | 32.4%, matching the field's own threshold |

**Measuring a candidate is where the whole cost sits.** The tile resolver, timed
over 256-tile windows that are 100% land:

| origin | 4 tiles/px | 1 tile/px |
| --- | --- | --- |
| (0, 0) | 22.96 us/px | 20.81 us/px |
| (3000, 3000) | 16.88 us/px | 17.09 us/px |

Every budget below uses **17 us/px**, the cheaper end. The coarse pass samples
at 8 tiles/px, which was not measured directly - but since per-pixel cost does
not improve with a coarser step (the next bullet), carrying 17 forward is the
conservative reading rather than an optimistic one.

Two results from that table killed two design ideas, and both are worth keeping
written down so nobody retries them:

- **Coarse sampling does not reduce per-pixel cost, only pixel count.** At
  tpp=4 the per-pixel cost is the same or slightly *worse* than tpp=1, because
  `memoXY` and `memoRegion` amortize badly when consecutive samples sit 4 tiles
  apart. Coarse sampling is still a large win, but purely through counting
  fewer pixels. Budget it that way.
- **Skipping the eight-way land argmax buys about 10%, not the 2-3x expected.**
  `resolveFrom` decides land against ocean with `bestOcean > 0` and only then
  runs the land argmax to name *which* land tile, so a mask-only resolver looked
  like an easy saving. Measured: 16.02 against 20.22 us/px at the origin, and
  16.56 against 16.93 at (3000, 3000). The cost is the elevation chain, which
  the land tiles merely re-read from cache. **Do not build a separate land-mask
  resolver.** Call the existing resolver and test its result.

Note the roadmap records ~7.9 us/px for a land-filled Fulgora viewport, and this
spec measures 17-23. Both are right. The roadmap figure is a 1024x1024 render;
these are 256-tile candidate windows, which amortize the caches worse. **The
figure that governs this design is the one measured at the geometry that ships**
- see the existing note on benchmark geometry in the repo's memory.

## 3. Architecture

Five stages, each its own module under `src/noise/islands/`.

### Stage 1 - survey (`cellSurvey.ts`)

Raster scan the search box evaluating only `cells`. Group the samples by island.
Drop groups whose id is below 0.33 (ocean).

At the default grid of 175 tiles a 10k x 10k box holds roughly 3,265 cells;
32.4% are ocean, so roughly **2,200 candidates**.

**The step is `grid / 8`, derived, never hardcoded.** The benchmark in section 2
used a 48-tile step, and that is too coarse to ship: Manhattan Voronoi at jitter
0.6 produces cells noticeably smaller than the grid, and at the smallest grid
the Islands frequency slider allows (125) a 48-tile step averages only 2.6
samples across a cell. Small islands would fall between samples and never be
reported - a silent miss, which is the worst failure mode this tool can have.

`grid / 8` is about 22 tiles at the default grid and 15.6 at grid 125. Cost at
22 tiles over 10k x 10k: 206,600 samples x 2.33 us = **481 ms**. Still
negligible against the measure stages, so there is no reason to economize here.

That budget is what makes the safety margin free. If a later change makes the
survey expensive, re-derive the step from a measured miss rate rather than by
picking a number.

**Island identity needs one change to `voronoiNoise.ts`.** `cellId` returns a
float hash in `[0, 1)`. Two distinct cells can collide on that value, and
grouping by it would silently merge two separate islands into one candidate with
a nonsense bounding box. `searchAt` already computes the stable integer
`(cellX, cellY)` before hashing. `Voronoi` gains one accessor returning that
pair. This is the only change to existing noise code, and it is additive.

**An island's world position comes from its own samples, not from
`pointForCell`.** The Voronoi here is sampled through a coordinate warp
(`fulgoraShared`'s wobble fields, amplitude `grid * 0.07`, about 12 tiles), so
`pointForCell` returns a point in *warped* space and there is no analytic
inverse. Stage 1 already holds the world coordinates of every sample that landed
in the cell, so the centroid and bounding box come from those.

### Stage 2 - coarse measure (`islandMask.ts`, `largestRectangle.ts`)

For each candidate, rasterize a land mask over its sample bounding box at
**8 tiles/px**, keeping only pixels belonging to that cell, then compute the
largest inscribed rectangle.

`largestRectangle` is the standard histogram-and-stack method: build a
per-column run-length histogram, then sweep it with a monotonic stack, O(w x h).
Axis-aligned. It is pure, takes a binary mask, and returns
`{x, y, width, height}` in mask coordinates.

Budget: 2,200 candidates x about 1,024 px x 17 us = **38s single-threaded**,
roughly **3.5s** across the existing worker pool.

### Stage 3 - refine (`findIslands.ts`)

Re-measure the top 50 by coarse rectangle area at **1 tile/px**.

50 rather than 10 because the coarse pass can misorder near-ties: an 8-tile
sampling step can misjudge a rectangle edge by up to 8 tiles in each dimension.
50 is a deliberate over-provision, and the right way to revisit it is to measure
how far a refined ranking moves from the coarse one, not to argue about it.

Budget: 50 x 65,536 px x 17 us = **56s single-threaded**, roughly **5s** pooled.

### Stage 4 - chains (`chainGraph.ts`)

Build a graph over the refined islands. Add an edge between two islands whose
land comes within **30 tiles** - a big power pole's wire reach.

Gaps are measured between the rasterized masks, not between centroids or
bounding boxes: two islands can have close bounding boxes and distant land. Only
pairs whose bounding boxes are within 30 tiles are compared at all, so the
quadratic term stays small.

Connected components over that graph give the chains. A chain's total rectangle
area is the sum over its members, which lets the table sort by chain as well as
by island.

### Stage 5 - UI

A results panel with a sortable table:

| column | source |
| --- | --- |
| coordinates | stage 1 centroid |
| rectangle (w x h) | stage 3, or stage 2 for unrefined rows |
| land area | stage 2 or 3 mask |
| class | mesa / sprawl / vault, from the cell id |
| distance from spawn | derived |
| chain | stage 4 component id and its member count |

Clicking a row re-centers the existing client preview on that island. Rows that
were never refined are marked, so a coarse number is never mistaken for a
measured one.

The search radius is a numeric input, defaulting to 5,000. The panel shows a
progress indicator and a cancel control, because a large radius is seconds of
work, not milliseconds.

## 4. Total cost, and the lever

About **9 seconds** for the default 5,000-tile radius: 0.5s survey, 3.5s coarse,
5s refine, with chains and UI negligible beside those.

The radius is the lever, and cost grows with its square. A 2,000-tile radius is
roughly 1.5s; a 10,000-tile radius roughly 35s. The UI should say so rather than
letting a user discover it.

## 5. Accuracy, and what to tell the user

Fulgora's land-versus-ocean split agrees with the game on **99.86%** of
positions. The residual mismatches are boundary-exclusive - they sit exactly
where an island's edge is, which is exactly what a rectangle measurement reads.

So a reported rectangle should be treated as accurate to about a tile, not
exact. The panel says this once, plainly. It is not a defect to fix here: the
cause is the unported post-argmax pass
(`TileCorrectionMapGenerationTask`, see #199), and porting that is a separate
architectural change to the renderer.

## 6. Testing

- **`largestRectangle`** is pure and cheap, so it gets real coverage:
  hand-worked small cases, all-land and all-ocean degenerate masks, single-row
  and single-column masks, and a brute-force O(n^4) reference implementation
  checked against the fast one over many random masks. This is the one module
  where an exhaustive test is affordable, and it is also the one most likely to
  have an off-by-one.
- **`cellSurvey`** is tested against the existing Fulgora fixtures: every island
  it reports must have `cells >= 0.33` at its own sample positions, and a
  deliberately coarsened step must be shown to *miss* islands that the specified
  step finds - otherwise the step derivation is untested.
- **The Voronoi accessor** gets a test that two positions in the same cell
  return the same integer pair and that positions in adjacent cells do not.
- **`chainGraph`** is tested on synthetic masks with known gaps: 29 tiles joins,
  31 tiles does not.
- **Cost** gets a row in `test/render-cost.perf.spec.ts`, so a regression in the
  survey or measure pass is visible.

Per this repo's convention, any claim in a comment about what a planted break
does must actually be planted and observed. Section 2's two dead ends were
established that way and should not be re-litigated from argument.

## 7. Risks

- **The 9-second budget assumes the worker pool.** The finder must run off the
  main thread through the existing pool, or the UI locks up. That pool currently
  serves tiled rendering; feeding it a different job shape is the main
  integration risk in this plan and should be the first thing prototyped.
- **Candidate count scales with the Islands frequency slider.** At the smallest
  grid (125) a 10k x 10k box holds about 6,400 cells rather than 3,265, nearly
  doubling the cost. Budget from the preset's actual grid, not the default.
- **50 refined rows may be too few or too many.** Measure the reordering rather
  than guessing.
