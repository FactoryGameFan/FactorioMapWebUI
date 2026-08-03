# Vulcanus cliffs - port notes

> ## STATUS, 2026-08-01: issue #18 is CLOSED; remainder tracked in #84
>
> **As shipped**: recall **0.9720**, precision **0.9713**, ratio 1.001. Before
> #18's fix: recall 0.806 / 0.938 / 0.853 and 12.5% wrong orientations.
>
> Two rules do that work and both were found late: `tryToAddCliff`'s
> lava-collision rejection (185 false positives across the three oracle regions)
> and the shape of its box, which is the **raw stored rectangle** - the engine
> discards the `1/8` orientation tag. See the last three sections, and note the
> LAST one corrects the one before it.
>
> **Root cause: `multisample`'s offsets are in the calling noise program's GRID
> UNITS, not tiles**, so `vulcanus_basalt_lakes_multisample`'s `min` is a 4-tile
> min-filter for the cliff generator and a 1-tile one for every per-tile consumer.
> The port used the 1-tile field for both, making cliff elevation too rough. Full
> write-up at `## ROOT CAUSE, 2026-08-01` in `cliffs-NOTES.md`; the measurement is
> `test/multisampleGrid.spec.ts`.
>
> **Every accuracy table below this banner is the PRE-FIX state**, kept because the
> reasoning is the useful part. Do not quote one as current. The exceptions are
> the last two sections, which are post-fix and are where this banner's numbers
> come from. Each of the last three corrects the one before it - read all three,
> in order, or you will act on a superseded number.
>
> ## UPDATE 2, 2026-08-02: the BLOB is ORE - #84 item 2 is #24
>
> The "blob" - the contiguous patch in `[0,0]` where the game places no cliff
> whatever `cliff_elevation` is routed onto it - **is a tungsten-ore field**. The
> game does not put cliffs on ore (3 of its 1,569 cliffs across the three oracle
> regions do) and the port does. Read the LAST section,
> **`## The blob is ore`**; it supersedes the "field-independent suppression of
> unknown cause" framing below. Its "mechanism is still open / settle the
> direction first" close is itself superseded by the LAST section,
> **`## The direction is ORE -> CLIFF`**: the resources suppress the cliffs, the
> rule is a box overlap against the resource ENTITY's rectangle, and it is worth
> 31 of the 42 surplus cells at `[1500,1500]`. Two corrections ride with it:
>
> - **`37 / 1531 = 2.4%` is the NO-lava-rejection arm**, not what ships. With the
>   rejection `renderVulcanusCliffs` actually applies it is **33 wrong of 1,525
>   matched**, plus 45 over-placed and 6 missed cells. Both arms are now pinned in
>   `test/cliffOreExclusion.spec.ts` so they cannot be confused again.
> - **The cliffiness gate is exact** - 0 flips over all 24,960 captured edges of
>   the three regions, measured as the boolean `crossesCliff` reads rather than as
>   a value. That closes the clamp-vacuity worry properly.
>
> ## UPDATE 4, 2026-08-02: RECALL IS 0.9961 - every recall figure below is wrong
>
> **Read `## The recall gap was a QUERY-WINDOW ARTIFACT` (last section) before
> quoting any accuracy number in this file.** The port was scored against game
> entity lists that include cliffs centred OUTSIDE the captured box, because
> `find_entities_filtered` selects by bounding box and `placedCells` emits by
> centre. That is 38 cells, the whole apparent recall gap, and the port places
> **38 of 38** once asked about their centres.
>
> Corrected: **recall 0.9961, precision 0.9839**, 1525 matched of 1531. The match
> count was never wrong - only the denominator. All 6 remaining missing cells are
> ones our own lava rejection removed, so **precision (25 surplus) is the only
> real defect left**. Item 3 (rocks/craters) is then CLOSED on the mechanism's own
> geometry: it can only act across chunk borders, and the surplus sits at borders
> at 44.0% against the matched cells' 44.1% - the base rate exactly.
>
> ## UPDATE 3, 2026-08-02: the ore rule is PORTED and SHIPS
>
> The last section, **`## The rule is PORTED, and driving it from our own ore
> model costs one cell`**, supersedes the previous one's closing warning not to
> port this against our own resource positions without measuring that arm. The
> arm is measured: **zero false rejections across all three oracle regions**, and
> `[1500,1500]`'s surplus falls 42 -> 22 (precision 0.953 -> 0.975) with recall
> untouched. It ships as `CliffBands.cellRejects`, ores only, base collision box.
> The geyser arm and the per-orientation box were both scored and both LOSE - see
> the table there before re-proposing either. 11 of the 31 remain unexplained and
> the box is deliberately not widened to cover them.
>
> ## UPDATE, 2026-08-02: the FIELD is exonerated; the residual is two defects
>
> The last section, **`## The residual is TWO defects, and the field is not
> either of them`**, supersedes the "the defect is in the grid-4 cliff-elevation
> field" lead that #91 handed over. That field is now measured correct, along
> with `cliffiness_basic` (over its unclamped corners), the smoothing stencil on
> both axes, and `cliff_smoothing = 1` read back from the game. Read that section
> before touching anything: **with `cliff_smoothing = 0` the port is exact at
> `[0,0]` and `[-1200,800]` and still 21-wrong at `[1500,1500]`**, so there is no
> single cause left to look for.

Factorio 2.1.12 (build 87038, mac-arm64). Ported 2026-07-26. Companion to
`cliffs-NOTES.md`, which holds the reverse-engineering of the placement rule
itself - none of that had to be redone, because the placement geometry is engine
behaviour and is shared between the two planets.

Source Lua: `~/GitHub/factorio-data` @ tag `2.1.12`.

## Why this port is small

Nauvis's cliff port was the M4 milestone: the hills/ringbreak/billows chain,
two string-seeded `basis_noise` leaves, `elevation_nauvis_no_cliff`, and a
six-term `min` for `main_cliffiness`. **None of it applies to Vulcanus.**
`space-age/prototypes/planet/planet-map-gen.lua:13-14` overrides both cliff
properties:

```lua
cliffiness      = "cliffiness_basic",
cliff_elevation = "cliff_elevation_from_elevation",   -- expression is `elevation`
cliff_settings  = { name = "cliff-vulcanus",
                    cliff_elevation_interval = 120,
                    cliff_elevation_0 = 70 }
```

So:

| | Nauvis | Vulcanus |
| --- | --- | --- |
| `cliff_elevation` | `10 + 30 * (nauvis_hills - nauvis_hills_cliff_level)` | the planet's own `elevation`, already ported |
| `cliffiness` | `(main_cliffiness >= cliff_cutoff) * 10`, a 0-or-10 gate | `cliffiness_basic`, continuous in `[0.5, 1.5]` |
| `cliff_elevation_0` | 10 (from the preset) | 70 (planet constant) |
| `cliff_elevation_interval` | 40 (from the preset) | 120 (planet constant) |
| sliders | `nauvis_cliff` frequency + continuity | **none** |

The only new expression is `cliffiness_basic`
(`core/prototypes/noise-programs.lua:310`):

```
clamp(0.5 * log2(cliff_richness) +
      quick_multioctave_noise{x = x, y = y, seed0 = map_seed, seed1 = 123,
                              input_scale = 1/32, output_scale = 1, octaves = 2,
                              octave_output_scale_multiplier = 1,
                              octave_input_scale_multiplier = 1/3},
      0, 1) + 0.5
```

and `quick_multioctave_noise` was already solved
(`quick-multioctave-noise-NOTES.md`).

## Vulcanus has no cliff sliders - measured, not assumed

`space-age/prototypes/autoplace-controls.lua` defines `gleba_cliff` and
`fulgora_cliff` but **no Vulcanus cliff control**, and
`planet_map_gen.vulcanus()`'s `autoplace_controls` list contains no cliff entry.
So `getModifiedRichness(richness, size)` has no lever to move and
`getModifiedElevationInterval(interval, frequency)` no divisor.

This is confirmed against the game rather than read off the Lua: the oracle
fixture captures `cliff_richness` itself, and it is exactly `1` at all 434
probe positions (`test/vulcanusCliffs.spec.ts`). If a future version gives
Vulcanus a cliff control, that assertion fails.

Consequence for the app: the cliff band constants are **planet constants**, not
preset fields. Nauvis reads all four off `preset.cliffSettings` and the
`nauvis_cliff` control; Vulcanus cannot, because the preset is a map-exchange
string describing a Nauvis surface and carries no Vulcanus `cliff_settings`.

## The gate reads differently on the two planets

`crossesCliff` compares the **average** of two corners' cliffiness against
`0.5`. On Nauvis `cliffiness_nauvis` is 0 or 10, so that means "at least one
corner is cliffy". On Vulcanus the field is continuous in `[0.5, 1.5]`, so an
edge is cliffy whenever the clamp term is above zero at either corner. Same
comparison, different shape of input - worth knowing before reusing the number
`0.5` anywhere else.

`test/vulcanusCliffs.spec.ts` pins the `[0.5, 1.5]` range from the fixture, and
asserts the sample actually reaches both ends so the bound is not vacuous.

## Accuracy

`cliffiness_basic` against the game at 434 positions: **worst residual under
5e-6**, i.e. the `quick_multioctave_noise` fastapprox floor with nothing
compounding it. `cliff_elevation` is not separately validated because it *is*
`vulcanus_elevation`, covered by `oracle-vulcanus-elevation.seed123456.json`.

Sampling it directly would in fact be circular: the oracle harness routes the
probe **at** the `elevation` property, so probing `cliff_elevation_from_elevation`
would resolve to the probe itself.

### A knife-edge that cost a detour - snap ring probe positions

The first capture reused the biome capture's probe grid, which pushes raw
`r * cos(a) + 0.5` ring coordinates. That produced a worst residual of **4.98e-4**,
200x the grid points', and it initially looked distance-dependent: r < 300 gave
6.9e-7, r >= 900 gave ~5e-4.

It is not distance. Sampling exactly-representable coordinates out to **4096**
gives 3.6e-6 - the floor. The real cause is a single probe position: at k=9,
r=3000, `cos(3pi/2)` is -1.8e-16 rather than 0, so `x = 0.4999999999994489`
instead of `0.5`. That sits within 5.5e-13 of a noise lattice boundary, and the
game's f32 and our f64 land on opposite sides of the `floor()`. Measured
directly:

| probe x | residual |
| --- | --- |
| `0.5` | 2.75e-7 |
| `0.4999999999994489` | 3.74e-4 |

Same y, same everything else. **The capture now snaps ring coordinates to
1/256**, which is what `MapPosition` stores anyway, and the residual is uniform.

Two things worth carrying forward: a distance-shaped residual is not proof of a
distance-shaped cause (only 24 of 434 points were rings, and they were all the
far ones), and the existing Vulcanus captures still push unsnapped ring
positions - which is part of why `sulfuricAcidPatches` carries a 2.9e-3 bound.

## Rendering

`renderVulcanusCliffs` mirrors `renderCliffs`, sharing both the placement
geometry (`makeCliffPlacementFromFields`, factored out of `makeCliffPlacement`
for this) and the paint loop (`paintCliffCells`). Two differences:

- **No water exclusion, but there IS a lava exclusion.** Vulcanus has no water
  tile, so `renderCliffs`' water check has nothing to test. This section used to
  read "the game does not exclude cliffs from lava" and **that was wrong** - it
  was inferred from the absence of a *water* tile rather than measured.
  `tryToAddCliff` tests the orientation's collision box against the tile mask
  grid, and `tile_collision_masks.lava()` sets the same `water_tile` bit the
  cliff mask excludes, so lava rejects cliffs by exactly the same mechanism water
  does. Ported in #71/#73; it is worth 185 false positives across the three
  oracle regions (precision 0.8719 -> 0.9743) and is passed as `tileCollides`
  from `VULCANUS_CLIFF_BLOCKING_TILES`.
- **No disable path.** With no continuity slider there is nothing to zero.

`cliff-vulcanus` declares `map_color = {144, 119, 87}`
(`space-age/prototypes/entity/entities.lua:2352`), byte-identical to Nauvis's
`cliff`, so `CLIFF_MAP_COLOR` is shared rather than duplicated.

Tiling: `test/tiledEquality.spec.ts` now covers Vulcanus across a seam for all
four ported views. Cliffs are the only Vulcanus overlay that can seam, because
`paintCliffCells` paints a 5x5 mark around a cell center, so a cell just outside
a tile still owes that tile pixels - supplied by the same `cliffCellQueryBox`
halo Nauvis uses.

## Performance, and a known duplication

Measured at 256x256, 1 tile/px, seed 123456, origin-centred, after both V3
overlays landed:

| view | us/px |
| --- | --- |
| terrain | 12.68 |
| resources | 16.09 |
| rocks | 16.37 |
| cliffs | 19.24 |
| **all** (the default for Vulcanus) | **27.01** |

**`all` is 2.13x the terrain baseline, which is past the ~2x gate the Vulcanus
work has used throughout.** Recorded rather than waved through. Two things make
it less alarming than the ratio suggests, but neither makes it zero:

- The gate was a guard against *accidental* regression. This is not accidental -
  `all` went from compositing two layers to four, and the Vulcanus default view
  changed from `resources` to `all` at the same time.
- In wall-clock terms a 1024x1024 preview tiled across ~11 workers lands around
  2.5s, comparable to Nauvis's `all` at 1.9s. The user-visible cost is fine.

If it does need to come down, note that the obvious fix does **not** work.
Sharing one Vulcanus field stack across the renderers sounds right, and is what
the duplication below suggests, but the stacks are built once per render, not
per pixel - the cost is per-sample evaluation. Each overlay sweeps the whole
image in its own loop, so by the time the rocks pass reaches pixel `p` the
single-slot `memoXY` caches hold the terrain pass's last pixel. Sharing the
objects would buy nothing.

The change that would actually pay is **fusing the passes**: one sweep that
evaluates the shared fields at a pixel and lets every overlay consult them
before moving on. That is a real architectural change to four renderers, and it
was not attempted here.

### The cell block is 4x4, and Vulcanus gains more from that than Nauvis does

The shared painter (`paintCliffCells`) went from a 5x5 block centred on the cell
to a 4x4 block anchored on the cell's own footprint (2026-07-27, on Eric's review
of the deployed preview: "the cliffs are maybe 1px too thick"). Cell centres are
`CLIFF_GRID_SIZE` = 4 world tiles apart, so at 1 tile/px 4px blocks tile with
neither gap nor overlap; the old 5x5 overlapped each neighbour by a pixel.

**Vulcanus uses the same placement module, grid and colour**
(`makeCliffPlacementFromFields`, `CLIFF_MAP_COLOR` = 144,119,87, which
`cliff-vulcanus` declares identically to Nauvis's `cliff`), so it inherited the
change automatically - and it benefits more, because its cliffs are far denser
than Nauvis's ridgelines. Cliff pixels in a 256x256 window at 1 tile/px, isolated
by diffing the cliffs view against terrain:

| window | 5x5 (old) | 4x4 (shipped) | change |
| --- | --- | --- | --- |
| `[0,0]` | 8365 (12.8%) | 6752 (10.3%) | -19.3% |
| `[1500,1500]` | 26464 (40.4%) | 22384 (34.2%) | -15.4% |
| `[-1200,800]` | 8887 (13.6%) | 7280 (11.1%) | -18.1% |

The reduction is smaller than the naive 25 -> 16 pixels per cell (-36%) precisely
because Vulcanus cells overlap so heavily: where blocks already merge, removing
the overlap costs less than the per-cell arithmetic suggests. Continuity is
unaffected - checked by eye on both a 34%-coverage window and a sparse near-spawn
one, where the lines stay joined and isolated cells read as single blocks.

Worth noting for anyone reading the 34% row as a bug: that window is genuinely
cliff-dense, and dense cliff fields are a real Vulcanus feature rather than a
painting artefact. It is the same order as the ~16.8% of a headless Vulcanus
preview that cliffs and rocks together account for.

### Re-measured after the placement roll (2026-07-27, Task 9)

The four overlays now roll per tile rather than threshold, so the table above is
superseded. Min-of-7 interleaved renders at 512x512, seed 123456, origin (0,0):

| view | min ms | marginal over terrain | share of overlay budget |
| --- | --- | --- | --- |
| terrain | 3394 | - | - |
| resources | 5406 | 2013 | 40% |
| rocks | 4756 | 1362 | 27% |
| cliffs | 5526 | 2133 | 42% |
| **all** | **8458** | 5064 | - |

The shares sum to 109%, not 100%: the marginals are measured one overlay at a
time, and on the `all` path they share a warmed field cache, so the whole is
slightly cheaper than the sum of its parts. Read them as proportions, not as an
additive decomposition.

`all` is now **2.492x** terrain, further past the gate than V3's 2.13x - and this
is the section that has to say so rather than the one that gets to round it down.
Part of that is real added work (collision gating resolves a whole chunk at a
time), and part is that these are minima at a different window and size than the
V3 row, so the two ratios are not strictly comparable.

**Two things were costed and dropped, and cliffs is why both fail:**

- **The rock field lattice** (Task 9) cuts the rock overlay 38% at stride 4, but
  cannot reach the gate: subtract the rock overlay *entirely* and `all` still sits
  at **2.091x** (7096 against a 3394 terrain baseline). It ships disabled. Details
  in `placement-roll-NOTES.md`.
- **Fusing the passes** - the change suggested above as the one that would pay -
  **cannot help cliffs at all**, which is the single largest line in the table.
  Fusion shares per-pixel field evaluations between passes, but the cliff pass
  does not sample per pixel: its corners sit on a 4-tile lattice, so at 1 tile/px
  it takes one elevation sample per 16 pixels and its cost is in the cell
  enumeration and footprint painting, not in shared field lookups. Fusing would
  redistribute the resources and rocks passes' sampling and leave 41% of the
  overlay budget untouched.

So the honest position is that the remaining cost is concentrated in the one
overlay the two obvious optimisations do not reach, and no cheap fix is
outstanding.

### The 2x gate, and the geometry the gate was always measured on

**Read this before quoting any ratio below.** Every `all/terrain` figure in this
file - including the historical 2.13x and 2.49x - is a **whole-image** render.
The app does not render whole images: the preview is tiled across a 64-worker
pool at 128x128 (`render-tiling-shipped`). Measured 2026-07-28, same total area,
same seed, min-of-5 interleaved:

| | whole 512x512 | tiled 16 x 128x128 |
| --- | --- | --- |
| terrain | 3684 ms | 3553 ms |
| all, shipped | 8584 ms | **10042 ms** |
| all, fused + cache | 6906 ms | 8380 ms |
| **ratio, shipped** | 2.330 | **2.827** |
| **ratio, fused + cache** | **1.875** | **2.359** |

So the prototypes clear 2x **on the basis the gate has always been quoted on**,
and do **not** clear it at the geometry the app actually runs. Both statements
are true and neither alone is honest.

Note where the tiling penalty falls: tiled *terrain* is slightly **cheaper**
(3553 vs 3684 - smaller working set), while tiled `all` is dearer. It lands
entirely on the overlays.

**The 17% in the table above is itself understated, and the reason is worth
more than the number.** Every tiled figure recorded before 2026-07-28 was taken
**without `fullImage`**, and `haloQueryBox` returns the bare tile box when that
field is absent - so the benchmark's tiled arm silently skipped every seam halo
and measured a tiling the app never performs. `renderPool.ts` always sets it.
Re-measured with it, the same pre-fix penalty on `all` is **43%**, not 17%. The
benchmark's tiled arms now pass `fullImage`.

**The stated CAUSE was also wrong, and the correction has a correction.** This
paragraph used to assert the penalty was chunk re-resolution - "each 128px tile
re-resolves every 32x32 chunk it overlaps" - written with no measurement behind
it. Instrumenting `resolveChunk` with a call counter says:

| view | whole 512x512 | tiled, no `fullImage` | tiled, `fullImage` (the app) |
| --- | --- | --- | --- |
| rocks | 256 | 256 (**1.00x**) | 484 (**1.89x**) |
| resources | 256 | 256 (**1.00x**) | 484 (**1.89x**) |
| all | 512 | 512 (**1.00x**) | 968 (**1.89x**) |

Read the two tiled columns together, because the first one on its own is how
this was briefly "falsified" outright. Without the halo, 128 is a multiple of 32,
tiles are chunk-**aligned**, and each chunk belongs to exactly one tile - exactly
1.00x. Add the one-pixel mark halo the app actually uses and the box crosses a
chunk boundary at both ends, so an interior tile resolves **6 chunks per axis
instead of 4** and every seam chunk is resolved by both neighbours.

So chunk re-resolution is real at the geometry the app renders, and it is **not
a bug** - the Vulcanus rock overlay paints a 3x3 mark, so a rock centred one
pixel outside the tile genuinely owes it pixels, and knowing whether that rock
exists requires resolving its chunk. It is the structural cost of combining
independent worker tiles with chunk-granular collision resolution, and it is
what remains after the two fixes below. It is concentrated in the rock overlay,
whose marginal goes from 200 ms whole to 1441 ms tiled (**7.2x**) - super-linear
because the extra chunks fall outside the tile, where terrain has not already
warmed the shared field cache.

**The lesson, since this file has now recorded it twice: a measurement on the
wrong geometry falsifies nothing.** The 1.00x column is a true statement about a
configuration that does not exist in production.

### ROOT CAUSE of the tiling penalty: TWO conservative cliff bounds (fixed 2026-07-28)

Both are the same shape - a bound that is correct but one tile too wide, sitting
in front of something that quantizes to chunks, so the surplus tile costs a whole
chunk. Neither changed a single pixel; `test/tiledEquality.spec.ts` passed before
and after both.

Measured at the app's real geometry (512x512 vs 16 x 128x128, `fullImage` set,
min-of-5 interleaved, two runs one after the other):

| | pre-fix | post-fix |
| --- | --- | --- |
| tiling penalty on `all` | **43.0%** | **24.5%** |
| cliffs marginal, tiled | 3413 ms | **1645 ms** (-52%) |
| cliffs marginal, whole | 1853 ms | **1472 ms** (-21%) |
| ratio all/terrain, tiled | 3.00 | **2.48** |

The cliff pass's own tiled penalty goes from **26.7% to 0.3%**. What is left of
the 24.5% is the chunk re-resolution above, which is structural, and it now sits
in the rock and resource overlays rather than in cliffs.

**This does NOT clear the 2x gate at the geometry the app renders** (2.48x). It
does clear it on the whole-image basis the gate has historically been quoted on
(7444 / 3893 = 1.91x), which is exactly the ambiguity the geometry section above
exists to prevent - so the honest headline is 2.48x, not 1.91x.

#### 1. The cell-index bounds overshot by a cell

**An off-by-one.** `placedCells` derived its
cell-index range with `floor` at the low end and `ceil` at the high end:

```ts
const cxMin = Math.floor((x0 - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE);
const cxMax = Math.ceil((x1 - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE);
```

Cell centres sit at `cx * 4 + 2`, so both ends overshoot by one cell whose centre
is outside the box. The **output** was always right - the emit filter
(`x >= x0 && x < x1`) discarded them. But the chunk loop underneath rounds that
range out to whole 8-cell chunks, and one stray cell is enough to pull in an
entire extra chunk on each side. That is a **fixed +2 chunks per axis per call**,
and a fixed per-call cost is exactly what tiling multiplies by 16.

Counted rather than timed, so these are exact (`test/cliffCellBounds.spec.ts`):

| | chunks/axis | cliffiness evals, whole 512 | tiled 16 x 128 | ratio |
| --- | --- | --- | --- | --- |
| old `floor`/`ceil` | needs 16, does 18 | 21,025 (145²) | 38,416 (49² x 16) | **1.83x** |
| tightened | 16 | **16,641** (129²) | **17,424** (33² x 16) | **1.047x** |

The tightened bounds are the exact inclusive range - `ceil((x0 - CX) / G)` and
`ceil((x1 - CX) / G) - 1` - and the residual 1.047x is the genuine seam cost of
16 independent tiles sharing corner lattices, which is irreducible without
cross-tile state.

Note the whole-image render gets **21% cheaper** too (145² -> 129²); the fix is
not tiling-specific, tiling just made a constant expensive.

#### 2. The seam halo was symmetric while the mark is not

`cliffCellQueryBox` widened by `CLIFF_MARK_BACK_PX` (2) on **both** sides. The
cliff block spans `px - 2 .. px + 1` - 2 back, 1 forward, which is what anchors
it on the cell's 4-tile footprint - so the two sides need different halos, and
**the directions cross**: a cell reaches in from the LOW side only within its
FORWARD extent (1), and from the HIGH side within its BACKWARD extent (2).

The old comment called 2 "the larger of the block's two directions", which was a
faithful description of the 5x5 centred mark it was written for and was never
revisited when the mark became 4x4 anchored (2026-07-27). Correct, and one tile
too wide on the low side - which again rounds out to a whole chunk:

| tiled halo (low/high) | cliffiness evals, 16 x 128 | vs whole |
| --- | --- | --- |
| symmetric 2/2 (old) | 24,336 | 1.462x |
| exact 1/2 (now) | **17,424** | **1.047x** |

The exact halo costs **precisely what no halo at all costs** - the seam
correctness is free once the bound stops crossing a chunk boundary.

This one is a knife-edge, and that is the proof it is exact: narrowing the low
side by one further pixel makes `test/tiledEquality.spec.ts` fail (checked by
planting it). `haloQueryBox` now takes `(backPx, fwdPx)`; the placement-mark
sweep passes the same value twice, because a 3x3 mark genuinely is symmetric.

#### Four things worth carrying forward

- **A conservative bound with a correct filter is invisible to every
  correctness test.** `tiledEquality` passed throughout, before and after both
  fixes, because the pixels never changed. Only a *cost* measurement sees it.
- **Look for a quantizer behind the bound.** Neither surplus tile would have
  mattered on its own. Both were expensive because something downstream rounds
  to 32-tile chunks, which turns "one tile too wide" into "one chunk too many".
  That pattern is worth grepping for wherever a query box meets a chunk loop.
- **The suspect list was wrong in an instructive way.** The three going in were
  stack construction, memo locality, and the seam halo. Construction is 26.5 ms
  per 16 tiles against a ~7300 ms render - **0.4%**, falsified outright. Memo
  locality was never tested because it stopped being plausible once the counts
  were exact. The halo *was* a cause, but not for the reason it was suspected:
  it does not cost extra cells, it costs an extra chunk.
- **Count, don't time, when the mechanism is arithmetic.** The counts matched a
  hand-derived prediction (145², 49² x 16) to the unit. Timing at ~4% run-to-run
  drift could not have established that, and a timing run on the wrong geometry
  actively misled - see the `fullImage` note above.

### SHIPPED: one shared cached stack (2026-07-28)

The Vulcanus composite now builds **one** `makeVulcanusStack(..., { cacheShared:
true })` and hands the same instance to terrain, resources and rocks. Fusion was
prototyped, measured and **dropped**; only the cache ships.

Two runs each, min-of-5 interleaved, same area and seed:

| | whole 512x512 | tiled 16 x 128x128 |
| --- | --- | --- |
| ratio, per-renderer stacks | 2.160 / 2.227 | 2.702 / 2.805 |
| ratio, shared cached stack | **2.028 / 2.049** | **2.525 / 2.564** |
| speedup | 6.1% / 8.0% | 6.6% / 8.6% |

Byte-identical to per-renderer stacks (`test/vulcanusStackCache.spec.ts`, which
renders both ways via `unsharedStacks`).

**What dropping fusion cost, stated plainly.** Before shipping, I predicted the
cache would subsume most of fusion's benefit, because a cross-traversal cache
also serves the resource pass's separate loop. **That was wrong and the numbers
say so.** The two are roughly ADDITIVE, tiled: fusion alone 6.2%, cache alone
6.6-8.6%, both together 16.6%. So shipping the cache without fusion takes a
little over half of what was available. Fusion's cost was a second render path,
a deferred-paint step to preserve the 3x3 geyser mark ordering, and a
`skipThreshold` flag; whether ~7 points is worth that is a live question, not a
settled one.

**Neither reaches the 2x gate at the geometry the app renders** (2.53 tiled -
and that figure is itself optimistic, being one of the pre-2026-07-28 tiled
measurements taken without `fullImage`; the comparable number with the halo is
3.00, and 2.48 after the two cliff-bounds fixes).
See the geometry section above before quoting any of these.

### What the two mechanisms buy - measured 2026-07-28 (fusion since dropped)

The paragraph above ("no cheap fix is outstanding") is **superseded**. Two
prototypes, both byte-identical to the shipped path
(`test/vulcanusFusedEquality.spec.ts`), min-of-7 interleaved @ 512x512 origin
(0,0), two independent runs:

| path | `all` | ratio all/terrain |
| --- | --- | --- |
| sequential (shipped) | 8304 / 8119 ms | 2.421 / 2.367 |
| + fused terrain+ore | 7441 / 7266 ms | 2.170 / 2.118 |
| + cross-traversal cache | **6749 / 6728 ms** | **1.968 / 1.961** |

**Fusion alone does not reach the gate; fusion + the cache does** - on whole-image
geometry, in both runs. Tiled, neither does (2.651 and 2.359); see above.

The two mechanisms also trade places when tiled: fusion's contribution falls
(13.6% -> 6.2%) while the cache's **rises** (6.9% -> 11.0%). Fusion's win comes
from within-pixel adjacency, which a smaller tile does not help; the cache's
comes from cross-traversal reuse, which a smaller working set makes denser. If
only one ships, the tiled numbers argue for the cache, not fusion - the opposite
of what the whole-image numbers suggest.
Note the ratio drifts ~4% run to run (see `render-cost.perf.spec.ts`), which is
why this is quoted from two runs and not one - but 1.96 twice is not a
borderline call.

Why two mechanisms and not one: `memoXY` is a **single-entry** cache, so sharing
field objects between passes saves nothing on its own - measured, terrain + the
three overlay marginals summed to EXACTLY the `all` cost, 96,310,857 basisNoise
calls either way. Fusing terrain with the ore pass makes them ask for the same
`(x, y)` back to back, which cuts the resources marginal by ~52% (1803 -> 886,
1828 -> 853). But the rock overlay's cost sits inside `resolveChunk`, which
sweeps a chunk's 1024 tiles in reverse index order - chunk-major, so **no pixel
loop can line up with it**. That half needs a cache that survives across
traversals, which is what `memoRegion` is.

Both are prototypes behind `fusedPrototype` / `cacheSharedPrototype`, default
off and not wired to any UI. Not shipped: `memoRegion` retains every value it
computes, which is cheap at the app's real geometry (128x128 worker tiles,
~16k entries) but unbounded at the benchmark's 512x512 and 1024x1024.

**The benchmark that could not settle this is now fixed** (issue #19, 2026-07-28).
`pnpm perf` reports minima over 7 interleaved iterations with the spread printed,
and has a Vulcanus block at exactly this geometry - so the hand-run loop these
figures came from is no longer needed. `FMW_PERF_BLOCK=vulcanus pnpm perf` runs
just this block in ~3.7 min.

Two things to know before comparing against the table above. First, **the
marginals are the figure to compare, not the absolutes and not the ratio**:
measured over two back-to-back runs the terrain baseline moved 4.8% and the
`all/terrain` ratio 3.8%, while the marginals held to ~2.5% (rocks was identical
to the millisecond). Second, **the table above is now stale**, and the current
tool says so cleanly: terrain still reproduces (3394 -> 3402/3566, inside the
baseline's own drift), but every overlay marginal has dropped well outside that
drift - resources 2013 -> ~1730, rocks 1362 -> 1079, cliffs 2133 -> ~1875. Three
PRs landed on those paths after this was measured (#25 rocks rendering, #28
`cliff_smoothing` -> 1 which the notes measure as ~10% *cheaper* on the cliff
pass, #32 `fixImpossibleCells` at ~10% dearer). The gate conclusion is unchanged:
`all` measures 2.31-2.40x terrain, still past 2x.

The cliff pass is more expensive than its sample count suggests. Corners sit on
a 4-tile lattice, so at 1 tile/px it evaluates one elevation sample per 16
pixels, yet it adds ~6.5 us/px. Each Vulcanus renderer builds its **own** field
stack (helpers, spawn, cracks, biomes, climate, elevation) rather than reusing
the terrain render's - the same duplication V2 documented for resources - so on
the `all` path the Vulcanus DAG is evaluated four times per pixel region.

## Entity-level validation - DONE 2026-07-28, and the result is not good

> **Read to the end of this section before quoting a number.** The three
> sub-sections below are a diagnosis in order: the failure, what it cleared, and
> the root cause. The tables in the first two are the **pre-fix** state, kept
> because the reasoning that got from one to the other is the useful part. The
> current figures are in "ROOT CAUSE: `cliff_smoothing`".
>
> ~~**And read "The residual is in the RULE, not the fields"...**~~ **FALSIFIED
> 2026-08-01.** The residual WAS in the field. The substitution test that
> "does not move a single placed cell" was comparing against a fixture sampled
> through `calculate_tile_properties` - a 1-tile-grid noise program - while the
> cliff generator reads the same expression on a 4-tile grid, where `multisample`
> returns different values. The fixture and the port shared the same mistake and
> so agreed with each other. That substitution now correctly MOVES cells; see
> `test/vulcanusCliffCornerFields.spec.ts`.

**Superseded the "Not validated" section below.** `test/vulcanusCliffEntities.spec.ts`
now compares the port against every real `cliff-vulcanus` the game places, captured
over three regions by `test/oracle/capture.ts vulcanus-cliff-entities`
(`oracle-vulcanus-cliff-entities.seed123456.json`, 2.1.12, seed 123456).

| region | game | ours | matched | recall | precision | over-placement |
| --- | --- | --- | --- | --- | --- | --- |
| `[0,0]` | 283 | 422 | 161 | 0.569 | 0.382 | 1.49x |
| `[1500,1500]` | 885 | 1399 | 614 | 0.694 | 0.439 | 1.58x |
| `[-1200,800]` | 401 | 455 | 259 | 0.646 | 0.569 | 1.14x |

**Vulcanus reproduces 57-69% of real cliffs, against Nauvis's ~94%, and places
1.1-1.6x too many.** The "same placement geometry as Nauvis, so it should be
comparable" reasoning that stood in for validation here was wrong - the shared
code is shared, but the fields feeding it are not, and the composition does not
carry Nauvis's accuracy across. Tracked as issue #18.

### The shared machinery is CLEARED - this is Vulcanus's own fault

Measuring Nauvis the same way (2026-07-28) answers the obvious next question,
which is whether the cliff port is broadly bad and Nauvis's number was just
flattering it:

| | game | ours | recall | precision | over-placement |
| --- | --- | --- | --- | --- | --- |
| Nauvis seed 123456 | 282 | 282 | 0.943 | 0.943 | **1.000** |
| Nauvis seed 777771 | 52 | 52 | 0.942 | 0.942 | **1.000** |
| Vulcanus `[0,0]` | 283 | 422 | 0.569 | 0.382 | 1.49x |
| Vulcanus `[1500,1500]` | 885 | 1399 | 0.694 | 0.439 | 1.58x |
| Vulcanus `[-1200,800]` | 401 | 455 | 0.646 | 0.569 | 1.14x |

**Nauvis places exactly the game's count at both seeds.** So `crossesCliff`, the
4-tile lattice, the orientation table and the cell enumeration - everything the two
planets share - demonstrably produce the right number of cliffs. The fault is in
what Vulcanus feeds them:

- `makeVulcanusCliffFields` (`cliffElevation` or `cliffiness`), or
- the band constants `VULCANUS_CLIFF_ELEVATION_0 = 70` and
  `VULCANUS_CLIFF_ELEVATION_INTERVAL = 120`.

The *shape* of the error points the same way. Over-placing while also missing a
third of the real cliffs means cells are landing in the wrong places, not merely
too freely - a uniformly over-permissive gate would keep recall high and only
depress precision. A wrong elevation interval or offset does exactly this: it
shifts which elevation crossings exist, adding cells the game has not got and
removing ones it has.

Note also that Nauvis's own figure was **stale in the other direction**: the spec
comment claimed "~89-90%" from the original spike and it now measures 94.3%. The
port improved and nobody re-measured.

`test/cliffPlacement.spec.ts` now asserts precision and an over-placement ratio
alongside recall, so this class of failure cannot hide behind a recall number on
either planet again.

Two things this immediately settles:

- **The 34% coverage window is partly our own over-placement.** The mark-size work
  measured 34.2% cliff-pixel coverage at `[1500,1500]` and recorded it as
  "believed to be a genuinely cliff-dense region". It is dense - but we place 1399
  cells where the game places 885, so roughly a third of that ink is ours, not the
  game's.
- **Precision was the metric that was missing.** The Nauvis spec guarded >= 85%
  *recall* only, which a model that placed a cliff on every lattice cell would
  pass at 100%. It is precision (0.38-0.57) that exposes the real problem on
  Vulcanus - and measuring Nauvis's, which had never been done, is what cleared
  the shared code. Both specs now assert it.

### ROOT CAUSE: `cliff_smoothing` (found + fixed 2026-07-28)

**Neither remaining suspect above was right.** The band constants are correct
(`70` / `120`, straight out of `planet-map-gen.lua:27-28`) and the fields were
fine. The missing piece was a third thing the diagnosis had not listed at all:
**`cliff_smoothing`, which is `1` on Vulcanus and `0` on Nauvis.**

Vulcanus's `cliff_settings` sets only `name`, `cliff_elevation_interval` and
`cliff_elevation_0`, so smoothing takes the **prototype default of 1**. Nauvis,
Fulgora and Gleba all set `cliff_smoothing = 0` explicitly - Fulgora with the
comment "This is critical for correct cliff placement." Vulcanus is the one planet
that doesn't, and it was the one planet that was wrong. The port had no smoothing
support at all, so both planets ran at 0.

The engine applies it to the cliff **elevation** samples before any crossing test.
Full rule, offsets and the disasm reading are in `cliffs-NOTES.md`
("`cliff_smoothing` - a no-op on Nauvis ONLY"); ported as `smoothingKnots` /
`smoothedElevation` in `cliffPlacement.ts`.

Re-measured against the same three regions and the same fixture:

| region | game | ours | recall | precision | ratio | was |
| --- | --- | --- | --- | --- | --- | --- |
| `[0,0]` | 283 | 326 | **0.788** | **0.684** | **1.152** | 0.569 / 0.382 / 1.49x |
| `[1500,1500]` | 885 | 1055 | **0.855** | **0.718** | **1.192** | 0.694 / 0.439 / 1.58x |
| `[-1200,800]` | 401 | 371 | **0.801** | **0.865** | **0.925** | 0.646 / 0.569 / 1.14x |

Recall +15 to +22 points, precision +28 to +30 points, and the count error drops
from 1.1-1.6x over to within 8-19% either way. A sweep at `s = 0 / 0.5 / 1` is
monotone with `s = 1` best on all three regions in all three metrics - so the value
is corroborated by measurement as well as being the documented default. It was not
fitted: there is no other value it could have been.

Two things worth carrying forward from how this was found and missed:

- **The error's shape pointed at the right kind of cause and the wrong instance.**
  "Over-placing while also missing a third of real cliffs means cells land in the
  wrong places" was correct reasoning, and it named the interval as the suspect
  because the interval was the only wrong-places mechanism on the list. Smoothing
  is another one, and it was invisible because `cliffs-NOTES.md` had recorded it as
  "a no-op in this path" - true of Nauvis, silently generalised to the engine.
- **A defaulted field is more dangerous than a wrong one.** Nothing in the Vulcanus
  Lua mentions smoothing; it had to be found by reading what the prototype does
  when the field is *absent*. When porting a settings block, enumerate the
  prototype's full property list and its defaults, not just the keys the planet
  bothers to set.

Residual after the fix is no longer one-directional - region 2 now slightly
under-places - which argues against a remaining uniform bias.

**`fixImpossibleCells` was ported on 2026-07-28 and is NOT the answer either.**
It moves recall +0.25 to +1.5 points (0.788/0.855/0.801 -> 0.792/0.870/0.803),
precision a shade up, and the count a shade worse (1.152/1.192/0.925 ->
1.155/1.210/0.928). Real, faithful, and small. See `cliffs-NOTES.md` for the
ported rule; the same port leaves Nauvis bit-for-bit unchanged, which falsified
the older claim that Nauvis's ~6% residual was this pass.

`tryToAddCliff`'s `wouldCollide` rejection is falsified as well - see
`cliffs-NOTES.md`. It reduces to "no cliffs on water", cliffs are generated before
any entity exists, and on Nauvis not one cliff cell of either side touches water.
Vulcanus has no water tile at all, so it cannot apply here even in principle.

Both named candidates are therefore gone on both planets, and on Nauvis the
residual measures as **threshold sensitivity in the field** rather than a missing
rule.

**That conclusion does NOT carry to Vulcanus** - measured, not assumed. Running
the same boundary-proximity test here (against the smoothed field the gate
actually sees, normalised by each planet's own interval so 40-vs-120 does not do
the talking):

| | matched, median / interval | mismatched | separation |
| --- | --- | --- | --- |
| Nauvis 123456 | 0.60% | **0.18%** | 3.4x |
| Vulcanus `[0,0]` | 3.7% | **1.5%** | 2.4x |
| Vulcanus `[1500,1500]` | 5.4% | **3.9%** | 1.4x |
| Vulcanus `[-1200,800]` | 5.3% | **2.2%** | 2.4x |

The effect is present here - our wrong cells are consistently nearer a boundary
than our right ones - but it is far weaker, and they are **not knife-edge**:
1.5-3.9% of an interval against Nauvis's 0.18%, an order of magnitude out. A
field-precision fix would not close Vulcanus's residual. Whatever is left is
structural and still unidentified.

Pinned in `test/cliffResidual.spec.ts`, deliberately, because generalising a
Nauvis result to both planets is the exact mistake that made `cliff_smoothing`
cost two months.

### `find_entities_filtered{type = "cliff"}` is not a clean proxy on Vulcanus

The dump also catches **`crater-cliff`**, which the planet definition lists under
its *entity* autoplace settings
(`space-age/prototypes/planet/planet-map-gen.lua:122`, beside the rocks and the
geyser) rather than on the cliff grid. It goes through the entity generator, jitter
draws and all, so its positions are fractional: 8 of region 2's 409 sit at
coordinates like `(-1184.375, 814.988)`, which fail the 4-tile lattice check
outright. They are filtered out by name rather than absorbed into the rates, and
the cliff probe now dumps entity names so this is visible rather than latent.

## Not validated (superseded above for cliffs; still true of the wider claim)

**There is no entity-level check.** Nauvis's cliff port was validated against a
real `find_entities_filtered{type="cliff"}` dump at ~94% tile-for-tile
(`cliffs-NOTES.md`). Vulcanus has no equivalent capture yet, so what is proven
here is: the one new noise field matches the game to 5e-6, the band constants
and the absence of sliders are read from the game, and the placement geometry is
the same code that scores 94% on Nauvis. What is **not** proven is that the
composition of those parts reproduces the game's actual Vulcanus cliff
positions.

That capture is the obvious next step and is the same shape as
`captureCliffEntities` in `test/oracle/capture.ts`, pointed at a Vulcanus
surface.

## ~~The residual is in the RULE, not the fields~~ - FALSIFIED 2026-08-01

> **This section's conclusion is wrong, and the way it was wrong is the most
> useful thing in this file.** The residual WAS in the field. The substitution
> below is sound as an experiment and its numbers are real - but the fixture it
> substitutes was captured through `LuaSurface.calculate_tile_properties`, whose
> noise program has a **1-tile grid**, while the cliff generator reads the same
> expression on a **4-tile** grid. `multisample`'s offsets are in grid units, so
> the two channels return different values for `vulcanus_elevation`. The fixture
> and the port were making the same mistake, so substituting one into the other
> could never move a cell. See `## ROOT CAUSE, 2026-08-01` in `cliffs-NOTES.md`.
>
> Read on for the method, not the verdict.

Everything above, and all of #18, treats the Vulcanus cliff gap as a **field
accuracy** problem: the noise field matches to 5e-6, the constants are read from
the game, so the ~1.15-1.19x over-placement must be residual field error
somewhere. **That was believed to be wrong; it was in fact right.**

`test/oracle/capture.ts vulcanus-cliff-corner-fields` dumps the game's own
`vulcanus_elevation` and `cliffiness_basic` at every corner of the placement
lattice (`(i*4, j*4 + 0.5)`) over three calcite-dominated 256x256 regions -
12,675 corners. Feeding those values straight into our own
`makeCliffPlacementFromFields` instead of our fields:

| region | interior cells | TP | FP | FN | precision | recall |
| --- | --- | --- | --- | --- | --- | --- |
| `[1500,1500]` | 3844 | 706 | 290 | 90 | 0.709 | 0.887 |
| `[1100,2600]` | 3844 | 720 | 199 | 86 | 0.783 | 0.893 |
| `[-1700,1900]` | 3844 | 744 | 156 | 123 | 0.827 | 0.858 |

and the placed cell set is **identical, cell for cell, to the one our own fields
produce**. Not one cell flips in any of the three regions.

That is exactly what an accurate field predicts, and it is worth doing the
arithmetic so the result does not read as suspicious: a cell can only flip if a
corner's elevation sits within the field error of a band boundary. At ~5e-6
relative error against 120-wide bands, over ~14k corner reads, the expected
number of flips is ~2e-4. Zero is the expected answer.

So the port's Vulcanus cliff **fields are exact for placement purposes**, and
17-29% of the cliff cells it places are wrong anyway, with 11-14% of the game's
missed. **The residual lives in the rule** - `crossingsForChunk`'s sampling
geometry, the `cliff_smoothing` knot model, `toMaybeCliffOrientation`, or
`fixImpossibleCells` - and #18 should be re-pointed there.

`test/vulcanusOreCliffSeparation.spec.ts` pins this, including a `+3` elevation
bias control so the "identical" assertion cannot pass by the substitution
silently not happening (the bias moves tens of cells per region).

### There is no ore/cliff exclusion in the engine - read out of the binary

The other half of #24. Disassembled from the 2.1.12 arm64 slice (see
`cliffs-NOTES.md` for the lldb recipe):

- `EntityMapGenerationTask::generateCliffs()` (`0x1016229b4`) calls exactly
  three things: `CliffGenerator::crossingsForChunk`,
  `CellCliffCrossing::toMaybeCliffOrientation` (inlined) and `tryToAddCliff`.
  **No tile lookup, no entity lookup, no resource field.**
- `tryToAddCliff` (`0x101625038`) has one rejection path, `wouldCollide`, and it
  is gated behind `mode == 2` (`ldrb w8, [x0, #0x10]; cmp w8, #0x2; b.ne`).
- `computeInternal` (`0x101622860`): `generateCliffs()`, then
  `generateEntities()` three times, then `generateDecoratives()`.
- `apply` (`0x101623b48`): `applyCliffs()`, `applyDecoratives()`,
  `applyEntities()`. `applyCliffs` does call `Surface::wouldCollide` and
  `Entity::forceDestroy`, so a cliff can still be dropped at apply time - but
  against tiles and already-generated neighbours, not against ore that does not
  exist yet.

There is no separate resource generation task: `nm | c++filt` lists
`BasicTilesMapGenerationTask`, `EntityMapGenerationTask` and
`TileCorrectionMapGenerationTask` and nothing else of the kind, so resources are
entities and they are generated after cliffs.

**Cliff placement is therefore a pure function of `cliff_elevation` and
`cliffiness`.** There is no exclusion to port, and any "ore excluded from cliffs"
item (the M3a follow-up in `client-preview-ROADMAP.md`, #24's own second cause)
should be closed rather than implemented.

Collision was already ruled out; both masks were re-read here rather than quoted
from the issue - cliff `{item, meltable, object, player, water_tile,
is_lower_object, is_object, cliff}`, resource `{resource}`. **Tiles cannot
separate them either**, which is worth recording because the ore patches really
do paint their own tile: `volcanic-jagged-ground`'s autoplace is
`5 * min(10, max(vulcanus_calcite_region + 0.2, ...))`, and
`tiles-vulcanus.lua` labels it "CLIFF TILE". Its mask is
`tile_collision_masks.ground()` = `{ground_tile}`, which the cliff mask does not
touch. Of the ~20 Vulcanus tiles only `lava` and `lava-hot` carry `water_tile`,
and `tile_collision_masks.lava()` also carries `resource`, so lava excludes both.

### #24's "100x below chance" baseline does not hold

The issue divides the observed overlap by a **tile-independence** baseline
(`ore tiles x cliff coverage / area`), which assumes each ore tile is an
independent trial. It is not: region `[0,0]`'s 945 ore tiles are **2 connected
blobs**, and `[-1200,800]`'s 1047 are **2**.

The right null keeps the blobs and moves them - shift the whole ore tile set on
the region torus and re-measure. 500 shifts per region, over the three committed
regions plus six new ones (`test/oracle/capture.ts
vulcanus-ore-cliff-replication`, region list fixed before any was measured, and
the two that turned out to hold no ore are kept in the fixture rather than
dropped):

| region | ore tiles | blobs | cliff cover | overlap | tile-indep. | shift median | P(shift <= obs) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `[0,0]` | 945 | 2 | 6.9% | 0 | 65 | 0 | **0.51** |
| `[1500,1500]` | 3933 | 25 | 21.6% | 8 | 850 | 789 | **0.000** |
| `[-1200,800]` | 1047 | 2 | 9.8% | 0 | 103 | 49 | **0.29** |
| `[700,-1800]` | 404 | 9 | 15.2% | 0 | 61 | 55 | 0.02 |
| `[-2400,-600]` | 597 | 3 | 12.9% | 1 | 77 | 58 | 0.19 |
| `[1100,2600]` | 3045 | 20 | 21.2% | 9 | 645 | 611 | **0.000** |
| `[-900,-2500]` | 904 | 4 | 15.9% | 0 | 144 | 110 | 0.18 |
| `[-1700,1900]` | 714 | 2 | 22.7% | 0 | 162 | 156 | 0.10 |
| `[300,3400]` | 944 | 8 | 2.0% | 0 | 19 | 0 | 0.73 |

**The separation replicates** - 18 of 12,533 ore tiles pooled, 0.14%, with both
ore-rich regions outside 500 of 500 shifts. **But `[0,0]` and `[-1200,800]` were
never evidence for it**: half of all random placements of `[0,0]`'s blob also hit
zero cliffs. The previous write-up read their "ratio to chance 0.000" as the
strongest signal in the set; it is the weakest, and the "no cliff can exist below
70, so region 0 is explained by elevation" reading was explaining a
non-observation.

### What is left open, stated as a contradiction rather than a cause

Put the two halves together and they do not fit:

- the binary says cliff placement cannot see ore; and
- the game's own `elevation` + `cliffiness`, through our rule, place **47** cliff
  cells inside cells whose full 4x4 footprint is ore (172/130/29 such cells per
  region, 8/38/1 placed) where the game placed **0**.

A covariate-matched control says that is not the rule simply being worse on
volcano terrain: pairing each full-ore cell with up to three no-ore cells at the
same mean elevation (+/-25) and mean cliffiness (+/-0.1) in the same region, the
rule's precision on the controls is 0.79 / 1.02 / 2.00 (n = 443/387/69). So the
47 should have been ~47 real cliffs. Poisson P(0 | 47) ~ 4e-21.

Since the binary reading is direct, the modelling of `crossingsForChunk` is the
suspect, and **a 4x4 cell fully inside a calcite patch is the sharpest test case
anyone has for #18**: our rule is wrong there ~100% of the time while being right
~78% of the time everywhere else. Four explanations for the localisation were
measured and **falsified** on 2026-07-29 - do not re-test them:

1. **Elevation.** With the cliffiness gate forced open, the game's own corner
   elevations give a band crossing in 40.5% / 34.3% / 50.0% of full-ore cells
   against 42.7% / 37.3% / 34.0% of random cells in the same regions. Calcite
   sits on band-crossing terrain at the background rate. (For coal and tungsten
   the figure is 0.000 in four of five regions, and that is a real structural
   result rather than a coincidence: `vulcanus_ashlands_func` is
   `300 + 0.001 * min(basis, basis)`, i.e. flat 300, and the basalts branch tops
   out near 120 against `cliff_elevation_0 = 70`. Coal and tungsten live on
   terrain that cannot host a cliff at all. Calcite and the geysers live in the
   mountains, with the cliffs, and are the only hard case.)
2. **Cliffiness.** The gate is `cliffinessAvg > 0.5` and `cliffiness_basic`
   floors at exactly 0.5, so it is a hard binary gate over roughly half the map,
   not a soft one. It is open at 14.9% of `[1500,1500]`'s full-ore cells against
   60.0% of random - but at **85.8%** of `[1100,2600]`'s against 64.0%, and 10.0%
   at `[-1700,1900]`. It does not replicate in either direction, which is what a
   coincidence looks like: `cliffiness_basic` is a `quick_multioctave_noise` at
   `seed1 = 123`, `input_scale = 1/32`, with no dependence on any resource,
   biome or elevation field, so there is no path by which ore could correlate
   with it. **This one is worth naming as a near-miss** - in region 1 alone it
   looked like a 3.8x mechanism, and one region would have been enough to write
   it down as the answer.
3. **`fixImpossibleCells`.** On and off changes the full-ore predictions by 0
   (8/35/1 both ways on the interior-inset window).
4. **Steep or aliased terrain.** Full-ore cells' max corner-to-corner elevation
   delta is p10/p50/p90 = 17/37/63 against 13/35/66 for no-ore cells - the same
   distribution - and the rule's precision is 0.58-0.84 across every delta bin,
   with no bin where it collapses. (This was the best remaining guess: the
   mountains branch carries `200 * (aux - 0.5) * (mountain_volcano_spots + 0.5)`
   and `vulcanus_aux` is a 5-tile-wavelength noise, so elevation there swings
   ~150 between adjacent 4-tile corners. It swings the same amount off the ore.)

One measured fact that is not a cause but is where a fifth hypothesis should
start: the false positives our rule produces **off** ore sit one cell from a real
cliff 78% of the time (93 of 120 at `[1100,2600]`) - they are edge-of-line
offsets along a real cliff face. The ones **inside** ore sit 2-5 cells away (4 of
37 at distance 1). They are not misaligned cliff lines; they are cliff faces the
game does not have at all.

## The lava rejection accounted for the "excess", 2026-08-01 (#84 items 1-2)

Issue #84 opened with two symptoms, and they turned out to be one measurement
error. Both arms compared **our placement, which did not run the lava-collision
rejection, against the game's, which always does.** `tryToAddCliff` drops any
cliff whose collision box touches a lava tile, and on Vulcanus the lava is the
basalt lakes - so the comparison was missing a deletion rule whose effect is
concentrated in exactly the low-elevation range where the residual sat.

**Item 1, the 187-cell excess.** Turning the rejection on removes 198 cells
across the three regions: **185 false positives against 13 true**.

| | game | ours | matched | recall | precision | wrong orientation |
| --- | --- | --- | --- | --- | --- | --- |
| no rejection | 1569 | 1756 | 1531 | 0.9758 | 0.8719 | 37 = 2.42% |
| **with rejection** | 1569 | **1558** | 1518 | 0.9675 | **0.9743** | 31 = 2.04% |

Per region, with it on: `[0,0]` 283/277, precision **exactly 1.000**;
`[1500,1500]` 885/895, precision 0.9564; `[-1200,800]` 401/386, precision 0.9974.
The port goes from over-placing 12% to under-placing 0.7%.

**Item 2, the surviving regime split.** `test/vulcanusElevationLevels.spec.ts`
had the low-elevation over-placement ratio at 1.085 against 1.018 high, a gap of
0.067 that read as a second-order error in the same `multisample` term. Run both
sides with the rejection and it collapses:

| `cliff_elevation_0` | ours/game, no rejection | with rejection |
| --- | --- | --- |
| 20 | 1.085 | 0.988 |
| 40 | 1.048 | 1.022 |
| 60 | 1.044 | **1.027** |
| 90 - 130 | 1.008 - 1.018 | 0.991 - 1.000 |
| 140 - 200 | 1.000 - 1.009 | 1.000 - 1.009 |

Gap 0.067 -> **0.018**, and the low regime now straddles 1.0 instead of sitting
above it. There is no second `multisample` defect to find.

### What is actually left is a TILE boundary, not a cliff field

The rejection costs recall, and it costs it in the same regime: 0.951 at level
20 rising to 1.000 at 140 and above. Each real cliff is a negative-space oracle -
the game ran this rejection and kept it, so the game saw no lava in that box -
and every contradiction sits at Chebyshev depth 1 in our lava, our own perimeter,
**never deeper**: 32/32 at level 20, 52/52 across the sweep, 13/13 at default
settings.

**Depth discriminates in one of the two places it was checked, and not the
other.** At default settings it does: `[1500,1500]`'s 170 *correct* rejections
span depth 1 to 9, 45 of them bottomed out deep in lava, against wrong rejections
that are 100% perimeter. At level 20 it does not - there the correct rejections
are 32/32 perimeter too, because the contour has walked down onto the lake edges
and every candidate is near a boundary. So the supported claim is that these
errors are boundary-**sited** in both directions and that at level 20 we call
about half of them right; not that depth alone proves the perimeter is one tile
fat. Narrowing that is a `vulcanusCatalog` question, not a cliff one.

Note what the tile resolver is already known to get right, so this is not a
retread: its binary lava/not classification is **exact on all 381 oracle
positions**, including 42 sitting directly on a lava boundary
(`vulcanusTiles.spec.ts`). Whatever is off is finer than the sample that pinned
it.

### Method note

This is the same trap as #83 wearing different clothes. There, a fixture was
right at the right site but captured through the wrong **channel**. Here, two
sides of a comparison ran different **rule sets** - and in both cases the
mismatch had a plausible mechanism ready to absorb it, so the wrong explanation
was the comfortable one. Before attributing a residual to a mechanism, check
that both sides of the comparison are running the same rules.

## Channel audit: cliffs really are the only coarse-grid consumer (#84 item 4)

#83 left an assumption behind: cliffs are the only consumer reading a
`multisample`-bearing field on a grid other than 1 tile. That was never
measured - which is precisely the status the cliff case itself had before #83 -
so it is measured now. `test/multisampleChannelAudit.spec.ts`.

**The surface is much smaller than "audit every consumer", and that is the first
finding.** `multisample` appears in `~/GitHub/factorio-data` @ 2.1.12 in exactly
**one** place, `vulcanus_basalt_lakes_multisample`
(`planet-vulcanus-map-gen.lua:547`), used only by `vulcanus_elev`. No other
planet uses the primitive at all. So the audit reduces to "who consumes Vulcanus
`elevation`":

| consumer | reads `elevation`? | grid | how established |
| --- | --- | --- | --- |
| cliff generator | yes, via `cliff_elevation_from_elevation` | **4** | measured, #83 |
| tile generator (19 `*_range` expressions) | yes, via `vulcanus_elev` | **1** | measured, below |
| `vulcanus_temperature` | yes, `min(elev, elev/100)` | 1 | same program as tiles |
| resources: tungsten, coal, calcite, sulfuric acid | **no** | n/a | read below |
| rocks, geyser | **no** | n/a | read below |

**The resource row is the one that had to be checked rather than assumed**,
because the generic path *does* couple to elevation:
`starting_resources_lake_mask = clamp((elevation - 1) / 10, 0, 1)` feeds
`starting_patches`' `spot_favorability_expression`
(`core/prototypes/noise-programs.lua:270`), and CLAUDE.md flags that this
coupling is exactly what changed at 2.1.9. Vulcanus does not take that path -
each of its four resources is placed by its own `vulcanus_*_region` expression,
and those four definitions contain **0** references to `elevation`. So the lake
mask is a Nauvis-only coupling and no Vulcanus resource can see the multisample.

### The tile generator reads grid 1, measured against the game

Substituting the cliff generator's 4-tile elevation into the tile resolver and
comparing against the game's own `get_tile` output over the 381 oracle
positions:

| | grid 1 (ships) | grid 4 |
| --- | --- | --- |
| tile-name agreement | **0.9816** | 0.8609 |
| lava misclassifications | **0 / 381** | 27 / 381 |

46 tiles would be named wrongly, and the binary lava call - the only thing the
cliff collision rejection reads - goes from exact to 27 wrong. The 1-tile field
is not merely adequate here; it is the one that matches, and the metric is
demonstrably sensitive to the swap. That sensitivity is the part worth insisting
on: PR #57's substitution failed precisely because "nothing changed" was
indistinguishable from "the substitution never ran".

**A side result.** This also clears the lava perimeter that costs 13 real cliffs
their placement: reading the other elevation channel makes the lava
classification dramatically worse, not better, so the perimeter error is not a
channel mistake. It is somewhere else in `vulcanusCatalog`.

## The lava perimeter was the COLLISION BOX, not the mask (2026-08-01)

The section above concluded that a "sub-tile disagreement about where lava
stops" cost 13 real cliffs their placement, and `vulcanusCliffEntities.spec.ts`
carried the same claim: the tile resolver is "off by about one tile SOMEWHERE".
**That was wrong.** The mask is exact; the collision box was the wrong shape.

### The mask was exonerated by a capture designed to convict it

`oracle-vulcanus-lava-boundary.seed123456.json` samples Chebyshev radius-4
neighbourhoods around the 35 tiles our mask calls lava inside a real cliff's box
- deliberately the hardest positions on the map rather than a representative
sample. Result over 994 positions: **0 lava mismatches in either direction**, and
at the 35 accusing tiles themselves **35/35 agreement**. The game has lava
exactly where we say it does.

That capture was worth making because the existing 381-position survey
structurally could not answer the question: its sensitivity was measured by
planting scale factors on `lava`'s probability, and `1.02` and `1.2` both still
pass. A sparse survey cannot see a sub-tile boundary shift.

### `rotbb` boxes are ROTATED, and the port used their bounding box

`rotbb(x, y, size, intersect)` (`entity-util.lua:9`) returns
`{{cx - x_dist, cy - y_dist}, {cx + x_dist, cy + y_dist}, 1/8}` - a rectangle
**plus an orientation of 1/8**, i.e. 45 degrees. Sixteen of the twenty cliff
orientations are built with it; only the four straight ones are plain
axis-aligned rectangles.

`CLIFF_ORIENTATION_COLLISION_BOX` holds the axis-aligned bounding box. That is
the correct BROAD phase - `wouldCollide` derives its tile rectangle from a
fixed-point floor and scans an inclusive rect, which `cliffCollisionTileBox`
reproduces - but the collision itself is against the rotated rectangle, and the
AABB overruns it at all four corners. `cliffBoxCoversTile` now runs a
separating-axis narrow phase; `test/cliffOrientedBox.spec.ts` pins the geometry.

A note on `rotbbBox` used to say `intersect` could be dropped because it does not
move the AABB. True of the AABB, false of the collision: `intersect` sets how the
diagonal splits, hence which corners are empty.

| | AABB (before) | oriented (after) |
| --- | --- | --- |
| recall | 0.9675 | **0.9758** |
| precision | 0.9743 | 0.9727 |
| `[0,0]` recall | 0.9788 | **1.0000** |
| level-sweep recall | 0.951 at level 20 | **~1.000 at every level** |

It clears **13 of 13** false rejections while keeping 182 of the 185 rejections
that remove genuine false positives - so it is the correct shape, not a
loosening that trades precision for recall.

### Two corrections this forces

- **PR #86's "gap 0.067 -> 0.018" is wrong; it is 0.024.** That figure was
  measured with the over-aggressive AABB rejection, which deleted cells the game
  keeps and so flattered exactly the ratio it was reporting. **A too-strong
  correction hides the thing it is correcting.** The remaining over-placement
  below elevation 120 is real and still open - and it is now pure over-placement,
  with no recall cost.
- **"All 13 sit at Chebyshev depth 1 in our lava" was a true measurement that
  pointed at the wrong suspect.** The box's four corners ARE its perimeter, so a
  corner-shaped box error produces exactly the signature a one-tile-fat mask
  would. Two mechanisms, one fingerprint. A statistic can only rule a suspect
  out if it would come out DIFFERENTLY for each candidate, and a depth histogram
  comes out the same for both.

### What was checked and cleared on the way

- **The inclusive-floor fringe is real engine behaviour, not our bug.**
  `wouldCollide` uses `(box + position) >> 8` and an inclusive rect, so a box
  edge landing exactly on a tile boundary does pull that tile in. Already
  established by disassembly; re-confirmed as not the cause.
- **Chunk ordering is not it.** If the generator read a partly-generated tile
  grid, the offending tiles would sit disproportionately in neighbouring chunks.
  They do not: 2 of 13 cross a chunk boundary against 50 of 185 in the control -
  *less* than baseline.
- **6 of the 13 also carry a wrong orientation** (against a 2.0% base rate, ~23x
  enrichment), and in every case the game's is a smaller `-to-none` variant of
  ours. A wrong orientation means the wrong box, so the two defects compound.
  Those 6 belong to the standing orientation residual, which is unchanged.

## The collision box, settled by disassembly (2026-08-02)

The section above is **wrong about the mechanism** and its numbers are
superseded. It concluded the engine collides against `rotbb`'s rectangle rotated
45 degrees. It does not. The engine uses the **raw stored rectangle**, and
discards the orientation tag.

### What the binary does

Three steps, all in the 2.1.12 arm64 slice:

1. `EntityMapGenerationTask::tryToAddCliff` (`0x101625038`) switches on the
   orientation, loads that entry's box from `proto + 0x5c0 + id*0x48` (20 bytes:
   four `int32` edges at `+4`, the orientation word at `+0x14`), and calls
   `wouldCollide` with **`Direction = 0`** - literally `mov x4, #0x0`.
2. `EntityMapGenerationTask::wouldCollide` (`0x101625468`) forwards box and
   direction to `BoundingBox::BoundingBox(BoundingBox const&, Direction)`
   (`0x101c04380`), then floors the result with `(box + position) >> 8` and scans
   the inclusive tile rectangle against a 96x96 mask grid.
3. That constructor zeroes the destination, writes the sentinel `0x80010000` into
   the destination's orientation word, and dispatches on the direction through a
   jump table whose **entry 0 is 0** (read at `0x102d01400`) - the identity arm,
   which copies `left_top`/`right_bottom` verbatim and returns. The source box's
   own orientation is never read. The rotation arm below it, which calls
   `Vector2<double, Vector>::rotate(Direction)`, is reachable only for a non-zero
   `Direction`.

Corroborated by the API mirror rather than by disassembly alone: `BoundingBox` is
documented as `{MapPosition, MapPosition}` **or** `{MapPosition, MapPosition,
RealOrientation}` with `orientation` optional, and
`OrientedCliffPrototype::collision_bounding_box` is a plain `BoundingBox`.
Nothing in the docs says collision honours the orientation, and the binary says
it does not.

### Three shapes, and the best-scoring one is wrong

| box | false rejections | recall | precision | evidence |
| --- | --- | --- | --- | --- |
| AABB `[x, x+size] x [y, y+size]` | 13 | 0.9675 | 0.9743 | none - an assumption |
| 45-degree oriented rect (#88) | **0** | **0.9758** | 0.9727 | empirical fit only |
| **raw stored rect (current)** | 6 | 0.9720 | 0.9713 | **disassembly + API docs** |

**#88 scored best on every metric and was wrong.** It shrank the box past what
the engine uses, and the excess shrinkage also absorbed a *different* defect: 4
of the 6 cliffs the correct box still rejects are cells where our orientation
disagrees with the game's, so we load the wrong box entirely. Those 4 belong to
the standing orientation residual and should stay visible.

Note the raw rectangle is not simply "smaller". `hx + hy` is fixed at
`size/2*sqrt2`, so its area is at most half the AABB's - but with a small
`intersect` it sticks out PAST the AABB in x while collapsing in y. A first
attempt to assert containment on every axis failed for that reason.

Edges are quantised to 1/256 because `MapPosition` is 8-bit fixed point, so
`x_dist`'s `sqrt(2)` cannot reach the engine at full precision.

### The lesson, which is the same one twice in two days

**A correction that scores better than the truth is still wrong, and it is
dangerous precisely because it scores better.** #86 over-reported a collapsing
gap because the AABB box was over-rejecting; #88 then hit 13/13 by over-shrinking
and hid four orientation bugs. Both times the flattering number came from a
too-strong correction. When a fix lands on a metric perfectly, treat that as a
prompt to find the independent evidence, not as the evidence.

The route that worked here was: stop tuning shapes against the metric, and go
read what the engine does. The binary is unstripped and the whole chain took
three `lldb` calls.

## The residual is TWO defects, and the field is not either of them (2026-08-02)

The handoff into this session (#91) named one lead: "the defect is in the
**grid-4 cliff-elevation field** - the one input in the chain with no direct
per-corner oracle", with the next step being to capture `cliff_elevation` at the
4-tile corner lattice. **That lead is refuted.** The grid-4 field is correct, and
so is everything else upstream of the crossing test. What is left splits into two
defects that live in different regions and have different causes, which is why a
single number ("37 wrong orientations") could never be chased to a single cause.

### What was eliminated, and how

Each of these is a measurement, not a reading. Do not re-derive them.

| input | verdict | how |
| --- | --- | --- |
| grid-1 `vulcanus_elevation` | exact, worst **4.8e-2** | all **12,675** corners of `oracle-vulcanus-cliff-corner-fields-entity-regions` |
| grid-4 `multisample` min-filter | exact | through the CLIFF GENERATOR at `[0,0]` **and** `[1500,1500]`; grid 1 / 2 / 8 / centred all score far worse |
| `multisample(e, 0, 0)` | the identity in this channel | arm A ≡ arm B, cell for cell, both regions |
| `cliffiness_basic` | exact, worst **6.4e-6** | over the **4,266 UNCLAMPED** corners (see the vacuity note below) |
| `cliff_smoothing = 1` | **measured**, not inferred | read back off the planet's own surface with nothing overridden |
| the smoothing stencil | exact | delta probe, both axes, `test/cliffSmoothingModel.spec.ts` |
| `crossesCliff` | exact | disassembly, `0x10160c914` |
| `crossingsForChunk`'s smoothing | matches `smoothingKnots` | disassembly, `0x10160c9cc` (**the VA in cliffs-NOTES.md had moved**) |
| `fixImpossibleCells` give-up branch | never fires | **0** chunks in these regions need even one retry |

Two of those deserve their own note.

**The `cliffiness_basic` exoneration was two-thirds vacuous and is now not.**
`cliffiness_basic` is `clamp(qmn, 0, 1) + 0.5`, and **8,409 of the 12,675
captured corners sit ON a clamp** (6,330 at the floor, 2,079 at the ceiling).
Agreeing there says nothing whatever about `qmn`; it says both sides clamped. The
comparison that carries information is the 4,266-corner interior, and it agrees
to 6.4e-6. Any future "field X is exact" claim about a clamped expression has to
report the interior separately or it is measuring the clamp.

**The smoothing stencil was measured, not just disassembled.** The probe is a
DELTA on one corner column: `1 + 1000 * if(1 - abs(x - X0), 1, 0)` routed onto
`cliff_elevation` with smoothing left at 1. Every corner but one carries the
constant 1, so the smoothed field is exactly `1 + 1000 * w(i)` for the stencil
weight `w`, and the game's cliffs trace `w = 0.5` directly. The design's teeth
are the **in-chunk-index-3 arms**: 3 is not a knot, so the model predicts the game
places *nothing at all*, and the game places nothing at all. An arm whose
predicted output is EMPTY cannot be satisfied by a stencil that is merely close -
which is the failure mode of every weight-matching check.

### The split

Force `cliff_smoothing = 0` and leave every other term real, and the port's
grid-4 field is scored with no interpolation in the way:

| region | smoothing = 0 | smoothing = 1 (ships) |
| --- | --- | --- |
| `[0,0]` | **0** wrong | 7 wrong |
| `[-1200,800]` | **0** wrong, precision 1.0000 | 4 wrong |
| `[1500,1500]` | **21** wrong | 26 wrong |

So `[0,0]` and `[-1200,800]` carry a defect that exists ONLY under smoothing,
while `[1500,1500]` carries one that survives smoothing being switched off
entirely. `[1500,1500]`'s 21 are all **over-detections**, all at the HIGH bands
(670 / 790 / 1030), with margins of **0.69 - 46.6 elevation units** - far too
large for float32, and the cliffiness there sits up to 1.0 clear of its gate.

**This is why one region was never enough.** `[0,0]` alone says "smoothing off is
exact, therefore the residual is the smoothing", and that is false for 21 of the
37. Two of three regions agreeing is exactly the evidence that produces a
confident wrong conclusion - the same shape as #88.

Note also what this does to `docs/noise/...` note "cliff_smoothing is NOT the
residual (#79, #80)". That was measured **before #83 fixed the multisample grid**,
when the field was wrong everywhere and so nothing downstream could be scored. It
has expired: with the field right, smoothing off is exact in two regions of three.

### The smoothing-side defect is NOT in the stencil

The stencil arms are exact in six of eight; the two that are not are exact
everywhere except one four-cell vertical run at `x = 1750`, rows 1526.5-1538.5,
which appears in both arms regardless of which delta column is used. It is not
the collision rejection - the game's tiles over `x 1742..1760, y 1518..1546` are
all `volcanic-*` ground tiles with **no lava at all**, and only `lava`/`lava-hot`
carry the `water_tile` layer the cliff mask collides with.

That is the same signature as the `[0,0]` **blob** below, and they are probably
one thing.

### The blob: a place the game puts no cliff, whatever field it is given

`#84` item 2 ("over-placement below elevation 120") is not spread over the low
band at all. In region `[0,0]` **every** excess cell, at every level of the
19-level sweep and in both probe arms, sits in one contiguous patch: cells
`cx 43-48, cy 34-40` (world `x 172-196, y 136-164`). The game places **zero**
cliffs there under real settings, under all four collapsed arms, at all 19 sweep
levels, and with a completely synthetic `cliff_elevation` routed onto it.

A field-independent hole is not a field error. The obvious suspect, lava, is
mostly ruled out: most of those cells have no lava within 10 tiles by our
resolver, and our resolver is right about lava there to 4 tiles in 483 (those 4
being lava the game HAS and we miss - note the 994-position capture that
"exonerated the mask" sampled neighbourhoods of tiles OUR mask calls lava and
therefore structurally could not find that class of error).

**This is the sharpest open lead**, and a much better one than "we over-place at
low elevation": it is a bounded, contiguous, field-independent suppression, so
whatever causes it is a rule the port does not implement at all.

## The blob is ore (2026-08-02, #84 item 2 -> #24)

The section above called the blob "the sharpest open lead", on the reasoning that
a bounded, contiguous, field-independent hole cannot be a field error and must be
a rule the port does not implement at all. That reasoning was right and the rule
is **ore exclusion**. The patch is a tungsten-ore field.

Measured in `test/cliffOreExclusion.spec.ts`, over the three oracle regions:

| | game | port |
| --- | --- | --- |
| cliffs whose 4x4 cell contains an ore tile | **3** of 1,569 | 29 |
| of the port's 45 surplus cells | - | **26** on ore, all at `[1500,1500]` |
| the collapsed arms' 10-cell blob | 0 | **10 of 10 on ore** |

The blob's ten cells are `x 178/182/186`, `y 138.5-150.5`, and they are the
**same ten in all four collapsed arms** - gate open and gate real, single contour
and real bands. A set that is invariant to both the band structure and the gate
cannot be a field or a cliffiness effect.

The handoff quoted a looser envelope (`cx 43-48, cy 34-40`, world
`x 172-196, y 136-164`). That is the union over the 19-level `cliff_elevation_0`
sweep; the arm-invariant core is the ten.

**Note what this does to the scope.** At real settings the port places nothing in
the blob at all - `[0,0]` scores 283/283 with 2 surplus and 2 missed, neither in
the blob. The blob is only reachable when a sweep forces a contour through the
ore field. The ore rule costs real accuracy only at `[1500,1500]`, where it is
26 of that region's 42 surplus cells.

### What it is NOT, each measured rather than read

- **Not lava.** 2,597 `surface.get_tile` samples from the game over
  `x 160..208, y 124..176`, 0 lookup misses: the blob's interior is
  `volcanic-cracks-warm` / `-hot` / `volcanic-smooth-stone`, with no lava
  anywhere in it. The standing "not lava" claim had been made with OUR resolver,
  which is exactly the component it needed to exonerate - and which is known to
  miss lava the game has (4 tiles in 483 in this same neighbourhood).
- **Not the cliffiness gate.** 0 flips over 24,960 edges; see below.
- **Not any other tile.** Read off a running game rather than deduced:
  `cliff-vulcanus`'s collision mask is
  `cliff, is_lower_object, is_object, item, meltable, object, player, water_tile`,
  and of the 18 Vulcanus tile prototypes only `lava` and `lava-hot` share a layer
  with it (`item`, `player`, `water_tile`). Every other tile, including
  `volcanic-jagged-ground` - the tile ore patches paint, which the Lua labels
  "CLIFF TILE" - is `ground_tile` only. **`VULCANUS_CLIFF_BLOCKING_TILES` is now
  measured, not inferred from `tile_collision_masks.lava()`.**
- **Not entity collision**, and this one is worth its own note because a real
  unported rule was found while ruling it out. `applyCliffs` (`0x101623c98`)
  re-tests every accepted cliff through **`Surface::wouldCollide`**
  (`0x10160c088`), which calls `constCollideWithTile` **and**
  `collideWithEntity`. The port implements neither - only the task-level
  `EntityMapGenerationTask::wouldCollide` (`0x101625468`), which is **tile-only**
  (it indexes `Tile::collisionMasks` over a 96x96 working-area grid and treats
  anything outside that grid as a collision). So there IS a second, entity-aware
  rejection that is not ported. It cannot be what excludes ore, though:
  `tungsten-ore`, `calcite`, `coal` and `sulfuric-acid-geyser` all carry the bare
  `resource` layer, which the cliff mask does not hold.

  What DOES collide with a cliff and is not ported: `big-volcanic-rock`,
  `huge-volcanic-rock` (both `is_lower_object, is_object, item, meltable, object,
  player, water_tile`) and **`crater-cliff`** - a Vulcanus cliff-type entity
  placed by autoplace (`probability_expression = "crater_cliff"`,
  `crater_radius = 7`, `crater_edge_thickness = 5`). Craters are already in the
  fixtures and filtered out by name: 8 in `[-1200,800]`, 3 near `(0, 164)` in the
  collapsed arms. Only two rocks touch the blob, so rocks explain at most 1 of
  its 10 cells - but this is a genuine open item for the wider residual.

So the exclusion is real and its **mechanism is still open**. It is not a
collision, so it is either an ordering effect inside `EntityMapGenerationTask`
(`generateCliffs` runs before `generateEntities`, so the direction may be that
ore avoids cliffs rather than cliffs avoiding ore) or something in
`resource_autoplace` that the cliff pass reads. The next step is to settle the
direction, not to add a rejection.

### The cliffiness gate, measured as the BINARY its consumer reads

`cliffiness_basic` is `clamp(qmn, 0, 1) + 0.5` and two thirds of its captured
corners sit ON a clamp, which is why the value comparison was two-thirds
vacuous. But what the consumer reads is `crossesCliff`'s gate, and that is a
**threshold**:

```
crossesCliff(a, b, cliffiness, e0, interval)   // 0x10160c914
  if (a < 0 || b < 0) return 0
  level = e0 + interval * floor((max(a,b) - e0) / interval)
  if (level < e0) return 0
  if (cliffiness > 0.5) { if (a-level < 0 && b-level > 0) return +1
                          if (a-level > 0 && b-level < 0) return -1 }
  return 0
```

and `crossingsForChunk` feeds it the **average of the two corners**
(`0x10160d1cc`, and again at `0x10160d06c` for the vertical edges). A clamped
corner is therefore not vacuous for the gate at all - it is precisely where an
arbitrarily small error flips the answer. Scored as a boolean over every captured
edge of all three regions the port agrees with the game on **all 24,960**, with
13,661 open and 11,299 shut, so a constant predicate could not pass.

Also re-derived while reading `crossingsForChunk` end to end, and matching the
port: the corner lattice is the bare `chunkOrigin + (i, j) * grid_size`, the
elevation register is smoothed with knots at in-chunk indices `{0, 4, 7}`
(`hi = min(lo + 4, 7)`) and **cliffiness is read unsmoothed**, and
`getModifiedElevationInterval` is `cliff_elevation_interval / frequency`.

## The direction is ORE -> CLIFF (2026-08-02, #84 item 1)

The section above ends "the next step is to settle the direction, not to add a
rejection." It is settled, and the answer is **the resources suppress the
cliffs**. It was settled by a lever rather than by an argument:
`map_gen_settings.autoplace_controls` is settable on the surface exactly like
`cliff_settings`, so the resources can be switched OFF (`size = 0`) and the same
regions regenerated. That is #82's collapse trick pointed one subsystem over.
Captured as `oracle-vulcanus-cliff-ore-direction.seed123456.json`, pinned in
`test/cliffOreDirection.spec.ts`.

| arm | cliff-vulcanus | resources |
| --- | --- | --- |
| `[1500,1500]`, resources ON | 885 | 3,933 |
| `[1500,1500]`, calcite OFF | 912 | 19 |
| `[1500,1500]`, geyser OFF | 889 | 3,914 |
| `[1500,1500]`, ALL OFF | 916 | 0 |
| `[0,0]` collapsed, resources ON | 335 | 945 |
| `[0,0]` collapsed, ALL OFF | **345** | 0 |

**Both arms of the question, not just one.** Turning the ore off puts a cliff in
**all ten** blob cells, `0/10 -> 10/10`. And the converse arm is what makes it a
direction rather than a correlation: the collapsed settings force 335 cliffs
through that region against the default's 283, straight through the tungsten
field, and the ore does not move - the same 945 entities. Cliffs do not push ore
around; ore removes cliffs.

Three properties fall out, and each constrains the mechanism:

- **One-way.** Removing a resource only ever ADDS cliffs. Nothing the game placed
  with the resources on disappears when they are removed, in any of the four
  paired arms. A perturbed field would move cells both ways; a rejection cannot.
- **Additive.** calcite alone accounts for 27 cells, the geyser alone for 4, and
  all resources together for exactly those same 31, with no overlap. So each
  resource acts independently and locally.
- **Local, with a geometry that is a BOX OVERLAP.** Not "is a resource tile
  inside the 4x4 cell" - the test is the cliff's own collision rectangle against
  the **resource entity's** rectangle. That distinction is measurable only
  because `sulfuric-acid-geyser`'s collision half-extent is **1.398** against the
  ores' **0.098**: a test treating every resource as a point at its tile centre
  explains the calcite cells and cannot explain the geyser ones, which is exactly
  the residual that made every candidate geometry score 20-27 of 31.

Scored as a box overlap it explains **21 of the 31** suppressed cells and raises
**zero** false alarms across the 885 the game kept. The other 10 are not
scattered: the suppressed set has six 4-connected components and **every one of
them contains at least one directly-overlapped cell**, so they are the remainder
of runs whose interior was rejected. Adjacency is not a free pass - only 8 of the
885 kept cliffs touch a suppressed cell at all.

### What it is worth, and what is still open

Every one of the 31 is a cell the port currently places, and none is a cliff the
game kept. So the rule is **pure precision**: it can only remove surplus, and it
removes 31 of the 42 cells the port over-places at `[1500,1500]`.

**The mechanism is still not a collision, and now that is doubly established.**
The mask argument stands - the fixture now carries the layers rather than a claim
about them, and `resource` is disjoint from the cliff mask. The disassembly says
the same thing from the other end, and more strongly:
`EntityMapGenerationTask::computeInternal` (`0x101622860`) calls `generateCliffs`
at `+44` and `generateEntities` at `+148`; `apply` (`0x101623b48`) calls
`applyCliffs` at `+124`, `applyDecoratives` at `+152` and `applyEntities` at
`+164`. **The cliffs are both computed and placed before any resource exists**,
so no collision test in the cliff path can see one, and the "ordering effect -
maybe ore avoids cliffs" half of the previous section's guess is refuted by the
converse arm above.

That leaves a rejection that reads the resource *placement* without the resource
*entity*: something the cliff pass evaluates that knows where the patches will
be. `Surface::wouldCollide` (`0x10160c088`) is `constCollideWithTile` +
`collideWithEntity` and nothing else, so it is not there either - and
`collideWithEntity` (`0x100a5b108`) was read rather than assumed this time: it
walks the entities in the box and tests them through the inlined
`CollisionMask::collides` (`CollisionMask.hpp:36`, at `+676`/`+680`), so it is
purely a layer test with no special case for resources. Note also that
`crater-cliff` is suppressed by calcite the same way (0 with calcite on, 8 with
it off), and craters are placed on a completely different path
(`CliffCraterPlacer::tryToPlaceCliffAsCrater`, `0x10160bcac`, called from
`applyEntities`) - so whatever this is, it is common to both cliff kinds rather
than specific to the cliff generator.

**Do not port this as a collision test against our own resource positions
without checking that arm separately.** The 31/0 score above uses the GAME's
resource entities as the input, which isolates the rule from the accuracy of the
resource port; driving it from `renderVulcanusResources` is a second question and
has not been measured.

## The rule is PORTED, and driving it from our own ore model costs one cell (#84 item 1, 2026-08-02)

The section above closes with "driving it from `renderVulcanusResources` is a
second question and has not been measured." It is measured now, and the answer
is that it is safe: `test/cliffOreRejection.spec.ts` scores the shipped
predicate - `makeVulcanusOreRejection`, driven off `buildResources`, the same
field stack the ore overlay paints from - across all three oracle regions.

| region | game | port placed | fires | **false rejections** | surplus |
| --- | --- | --- | --- | --- | --- |
| `[0,0]` | 283 | 283 | 0 | 0 | 2 -> 2 |
| `[1500,1500]` | 885 | 900 | 20 | **0** | 42 -> **22** |
| `[-1200,800]` | 401 | 387 | 0 | 0 | 1 -> 1 |

Precision at `[1500,1500]` goes 0.953 -> **0.975** with the 858 true positives
untouched. **Recall is not touched anywhere**, which was the gate: this rule may
only ever cost precision, and a cell removed that the game kept would be the one
outcome worth refusing.

Driving it from our own ore model rather than the game's entities costs exactly
**one** cell - the fixture-driven geometry explains 21 of the 31, the port-driven
one 20. That is the whole price of the substitution the section above flagged.

### Three variants were scored, and the two that lose are in the spec

Not dismissed in a comment, because #88/#90 already paid for that lesson here -
the best-scoring collision model was the wrong one.

| variant | fires | correct of 31 | false rejections |
| --- | --- | --- | --- |
| **base box, ores only (SHIPPED)** | 20 | 20 | **0** |
| base box + geyser | 21 | 20 | 1 |
| per-orientation box | 23 | 21 | 2 |
| per-orientation + geyser | 24 | 21 | 3 |

- **The geyser arm is strictly harmful**, not merely risky: one more false
  rejection and *not one* additional correct suppression. Its placements are
  salt-dependent (46-63 over eight salts against the game's 56) and its box is
  14x the ores', so a geyser in the wrong place sweeps a wide area. It is
  implemented behind `includeGeyser`, defaulting off, so the arm stays scored
  rather than deleted.
- **The per-orientation rotbb box catches one MORE true cell and pays two kept
  cliffs for it.** Higher `correct` is exactly the trap: recall is the half that
  must not be traded. Note this means the ore rule and the lava rejection use
  *different* cliff rectangles - the base `collision_box` and the per-orientation
  one respectively - which is only defensible because the ore mechanism is open
  and the base box is the shape it was measured with. If the mechanism is ever
  found, revisit this first.

### What is NOT claimed

**11 of the 31 are still unexplained** and the box is deliberately not widened
until they fall out: 10 are #99's run remainders and 1 is the cell our ore model
misses. `test/cliffOreRejection.spec.ts` pins that 11 so the gap stays tracked.

The **mechanism is still open**. This ships a characterised empirical rule -
one-way, additive, local, box-shaped - and the disassembly still says cliffs are
computed and placed before any resource entity exists, so whatever the engine is
really doing, it is not the collision test this models.

### Where it lives

`CliffBands.cellRejects`, a second optional per-cell predicate beside
`tileCollides` in `cliffPlacement.ts`, applied at the same site. It is
deliberately opaque - the shared cliff core stays planet-agnostic, and a
planet-specific, mechanism-open rule does not leak into it. It hangs there rather
than filtering `placedCells`' output so that **the model the specs score is the
model the renderer ships**; every spec drives `makeCliffPlacementFromFields`
directly, so a filter further out would score a different thing than it renders.

Two cheapnesses worth knowing: the predicate never enumerates entities (it solves
the two rectangles for the tiles whose centres can overlap - exactly 2 tiles for
an ore, 4x3 for a geyser, against the lava rejection's ~30), and it reuses the
composite's `VulcanusStack.resources` rather than building a second DAG. The
derived window is guarded by a brute-force scan a tile wider on every side, not
trusted.

## The recall gap was a QUERY-WINDOW ARTIFACT - recall is 0.9961, not 0.972 (#84, 2026-08-02)

**The port has been scored against a game set it was never asked to reproduce.**
`find_entities_filtered` returns every entity whose BOUNDING BOX touches the
query area; `placedCells` emits every cell whose CENTRE lies inside it. Those are
different inclusion rules, so the fixtures carry cliffs centred just outside the
box, and every one has been counted as a miss.

| region | game rows | centred inside | centred OUTSIDE |
| --- | --- | --- | --- |
| `[0,0]` | 283 | 283 | **0** |
| `[1500,1500]` | 885 | 861 | **24** |
| `[-1200,800]` | 401 | 387 | **14** |

That is 38 cells - the entire apparent recall gap - and **the port places 38 of
38 of them** once the query box is widened to include their centres. Every one is
an agreement that was being scored as a failure. `test/cliffErrorBudget.spec.ts`
pins both arms; the widening arm is the load-bearing one, since "we never looked
there" alone is equally consistent with the port being wrong.

### The corrected budget, both sides scored alike

| region | game | port | matched | surplus | missing |
| --- | --- | --- | --- | --- | --- |
| `[0,0]` | 283 | 283 | 281 | 2 | 2 |
| `[1500,1500]` | 861 | 880 | 858 | 22 | 3 |
| `[-1200,800]` | 387 | 387 | 386 | 1 | 1 |
| **total** | **1531** | **1550** | **1525** | **25** | **6** |

**Recall 0.9961, precision 0.9839.** The 0.972 recall quoted in this file's
banner and throughout #84 divided the same 1525 matches by 1569 instead of 1531.
**Correct every recall figure you find here before acting on it** - the match
count was never wrong, only the denominator.

**All 6 missing cells are ones our own lava rejection removed.** There is no cell
left that the port simply fails to generate, in any region. So precision is the
remaining defect, 25 against 6.

### Consequence: item 3 stays OPEN, and the crater arm is worth zero

An earlier draft of this section closed item 3 (the entity half of
`Surface::wouldCollide`) by size, arguing a rejection can only remove cells and
so could not help a 44-cell recall gap. **That argument died with the gap.** With
recall at 0.9961 the dominant defect is the 25 surplus cells, which is exactly
what a rejection removes - so the entity half is the leading candidate, not a
closed one.

The crater arm is still settled exactly, and is worth **nothing**: all 8 craters
sit in `[-1200,800]` and not one touches a cell the port over-places.

### And then the rock arm failed too - on the mechanism's own geometry

**No rock capture is needed to kill it.** `computeInternal` runs
`generateCliffs` before `generateEntities`, and `apply` runs `applyCliffs`
(`+124`) before `applyEntities` (`+164`), so within a chunk no rock exists when
the cliff is applied. A rock can only ever block a cliff from an
ALREADY-GENERATED NEIGHBOUR - which confines the entire mechanism to cells near a
32-tile chunk border.

| | n | near chunk border |
| --- | --- | --- |
| surplus | 25 | 11 = **44.0%** |
| matched | 1525 | 673 = **44.1%** |

**The base rate to three significant figures.** The surplus has no chunk-border
character at all, so the one geometry this mechanism is confined to is not where
the errors are. The direct overlap test agrees and is the weaker arm (3 of 25
against a 6.6% base rate, ~1.7 expected - nothing, and our rock placement is a
salt-dependent roll whose individual positions are unreliable exactly as the
geyser's were in #100).

**So item 3 explains approximately none of the 25 surplus cells, and is closed -
this time on the mechanism's geometry rather than on the ceiling argument that
died with the recall gap.** What remains unexplained: 25 surplus, 6 missing (all
lava-rejection over-rejections), and the 33 wrong orientations.

## The orientation residual is NOT a boundary tie - and the cliff channel still has no oracle (#84, 2026-08-02)

`cliffOrientationResidual.spec.ts` pins the shape: every wrong cell differs in
exactly ONE edge, always an OVER-detection (game finds no crossing, port finds
one). That shape has an obvious cheap explanation, and it is worth writing down
that it is **wrong**, because it eliminates a whole class of cause.

`crossesCliff` decides on the SIGN of `elevation - boundary`. If an endpoint sat
within float noise of a band boundary, the ~1e-6 our fields agree to would flip
the crossing, the residual would be an irreducible precision limit, and there
would be nothing to fix.

**Measured: every crossing edge in a wrong cell sits at least 0.205 from its
boundary**, median ~9.9 - four to seven orders of magnitude clear of float
noise. For the game to disagree, its elevation there must differ from ours by
more than 0.2. That is a real field or rule difference.

Non-vacuity: the overall minimum across all 2,920 crossing edges is 6.4e-3,
thirty times tighter, so "far from the boundary" is a property of the wrong
cells rather than of the sample. `test/cliffOrientationMargin.spec.ts`.

### The one input never checked corner-by-corner

`oracle-vulcanus-cliff-corner-fields-entity-regions` holds the **tile** channel.
That is stated in prose at the top of `vulcanusCliffCornerFields.spec.ts`, and
is now asserted as a number: against our per-tile elevation the worst corner
differs by **4.8e-2**; against the grid-4 cliff channel the cliff generator
actually reads, by **96.09**.

So **the grid-4 cliff-elevation channel has no per-corner oracle at all.** It is
the only input to the placement rule never checked against the game corner by
corner, and after the margin result it is also the only remaining candidate that
could move an endpoint the required 0.2.

**Capturing it is the next concrete step**, and it is not a plain
`calculate_tile_properties` dump - that is the 1-tile program and is exactly what
produced the wrong-channel fixture. It needs the cliff-channel value routed out
of the 4-grid program, e.g. a mod that publishes
`vulcanus_basalt_lakes_multisample` at grid 4 into a readable tile property.
Until that exists, "the fields are exonerated" cannot be said of the channel that
matters - and #93's exoneration rested on a substitution in the tile channel.

## The residual and the OVER-PLACEMENT are one defect (2026-08-03, #84)

Everything above treats two numbers as separate problems: the wrong orientations
(33 on the shipping path) and the surplus cells (25). They are the same defect,
and the reason is structural rather than statistical.

`placedCells` builds **one edge register per chunk**. `v[cy][cx]` is cell `cx`'s
left edge and cell `cx-1`'s right edge - not two equal values, the same array
slot. So a spurious crossing can never sit inside one cell. It corrupts the
orientation of the real cell on one side and manufactures a cliff the game never
placed on the other.

Measured over all three oracle regions, rejections off so the geometry is not
masked:

| | |
| --- | --- |
| matched cells | 1531 |
| wrong orientations | 37 |
| of those whose disputed-edge neighbour the GAME places | **0** |
| distinct phantom neighbours | 34 |
| of those the PORT places, i.e. that are surplus cells | **34 of 34** |

Not one of the 37 has a neighbour the game agrees about, and not one phantom
fails to be surplus. On the shipping path:

| region | matched | wrong | surplus | surplus that ARE phantoms |
| --- | --- | --- | --- | --- |
| `[0,0]` | 281 | 5 | 2 | **2 of 2** |
| `[1500,1500]` | 858 | 25 | 22 | 10 of 22 |
| `[-1200,800]` | 386 | 3 | 1 | 0 of 1 |

**At `[0,0]` the spurious crossings are the whole of the over-placement.** And
the reason 33 wrong cells do not imply 33 surplus is that the lava and ore
rejections already remove 19 of the phantoms - the rejection hides the phantom
while leaving the neighbouring cell's orientation wrong, which is exactly how the
two counts drifted apart and came to be read as unrelated mechanisms.

What this changes is the **value** of the blocked oracle capture above, not its
design. It was being weighed against "33 wrong orientations, ~1.6% of cells",
which reads like a rounding-error chase; it is also worth 12 of the 25 surplus
cells, and all of `[0,0]`'s. `test/cliffPhantomNeighbour.spec.ts`.

### Ruled out on the way, each with a discriminating control

- **No gate in `crossesCliff` is marginal on the disputed edges.** Measured
  against every crossing edge of every matched cell as control: cliffiness gap
  above the `> 0.5` threshold (disputed min 6.8e-3 vs control 1.0e-3), the
  `a < 0 || b < 0` early-out (disputed min elevation 15.6, nowhere near zero) and
  `boundary < e0` (disputed min 2.73 above `e0`). The disputed edges are not
  sitting on any cliff edge of the rule. This corroborates the band-margin result
  above by a different route.
- **The asymmetric smoothing knot lattice is not a misreading.** The port puts
  in-chunk knots at corner indices **0, 4 and 7** because `hi` is clamped to
  `CHUNK_CORNERS - 1`, which is odd enough to look like an off-by-one. Scoring
  the natural alternative - knots every 4 corners globally, i.e. 0, 4, 8 - it is
  **8x worse**: 312 wrong orientations against 37, matched collapsing 1531 -> 1173
  and missing 38 -> 396. Raw (`s = 0`) is worse still at 677. The disassembly
  reading now has a measurement behind it, not just a careful read.
- **`cliffiness_basic` stays exonerated, and the exoneration is sound.** It
  contains no `multisample` (the channel audit, #87, found `multisample` in
  exactly one expression in all of factorio-data), so unlike elevation it has no
  grid-4 variant to be captured in the wrong channel. Its gate test scores the
  binary the consumer reads over 24,960 edges with hit counts and both outcomes
  asserted - 0 flips.

## The grid-4 channel HAS a per-corner oracle now, and it moves the defect (2026-08-03, #84)

The blocker named above - "the grid-4 cliff-elevation channel has no per-corner
oracle at all" - is cleared. It needed no new mod: the cliff generator is itself
the readout, driven entirely through `cliff_settings`.

With `cliff_smoothing = 0` and `cliff_elevation_interval = 1e6`, `crossesCliff`'s
band arithmetic (`boundary = e0 + interval * floor((max(a,b) - e0) / interval)`)
collapses to a single threshold, and the rule becomes exactly

    a cliff sits on an edge  <=>  min(a, b) < cliff_elevation_0 <= max(a, b)

so one run is a **1-bit comparator on all 4,225 corners of a region at once**,
and the entity's `cliff_orientation` says which side is the high one.

**The levels are the real bands (`70 + 120k`), not a uniform sweep**, and that is
the design rather than a shortcut. `crossesCliff` only ever compares the field
against those, so the game's bits at the bands are the *entire*
placement-relevant content of the channel: if they match, the placement is right
whatever the field's exact values are. `oracle-vulcanus-cliff-bands` holds all
three regions at every band their field crosses (3 / 10 / 2 levels), 30 cases
over two gate arms. `test/vulcanusCliffBands.spec.ts`.

### `richness = 4` was never opening the gate, and that matters retroactively

Every collapsed arm since 2026-08-01 held the cliffiness gate open with
`richness = 4`, on the reasoning that `0.5*log2(4) = 1` saturates
`cliffiness_basic` at 1.5. It does not. The expression is
`clamp(0.5*log2(richness) + qmn, 0, 1) + 0.5`, so at richness 4 the clamp is
`clamp(1 + qmn, 0, 1)` - **still 0, and the gate still shut, wherever
`qmn <= -1`.** Routing the `cliffiness` property at the literal `1` places
strictly more cliffs at 13 of the 15 levels, by up to 135 at one.

The second-order problem is worse than the first. Shifting the richness term by
+1 moves the clamp by exactly one, so the corners that *decide* the gate under
that arm are the ones the DEFAULT field clamps flat at 0.5 - the
**8,409-of-12,675** population that the corner-fields fixture cannot speak to
(the vacuity note above). A richness-4 arm therefore cannot separate "the field
is wrong" from "`qmn` below the clamp is wrong". Both arms are captured for
exactly that reason; prefer the constant route when the gate is meant to be gone.

### What the oracle says

| region | bands | verdict |
| --- | --- | --- |
| `[0,0]` | 70, 190, 310 | **EXACT**, both arms - same cells, same orientations, nothing spare |
| `[-1200,800]` | 70, 190 | **EXACT**, both arms (317/317 and 407/407) |
| `[1500,1500]` | 70 .. 1150 | exact at 310 / 430 / 550; wrong at the HIGH bands |

`[1500,1500]`, constant-1 arm, as wrong/surplus: L70 1/3, L190 2/2, L310 0/0,
L430 0/0, L550 0/0, L670 8/5, L790 36/42, L910 22/41, L1030 2/2, L1150 2/2.

**So two of the three regions reproduce the game's cliffs exactly with nothing
between the field and the placement.** That is a much stronger statement than
any cell-count score, and it is the first time the channel has been checked
rather than argued about.

### Every cheap explanation for `[1500,1500]` is eliminated, each with a control

- **Not the smoothing** - it is 0 here.
- **Not the cliffiness gate** - the constant-1 arm removes it by construction,
  and the disagreement is *larger* there than under richness 4, not smaller.
- **Not `fixImpossibleCells`** - **0 of the 73** disputed cells have a code our
  repair changed, so all 73 are raw crossing-test disagreements. (The repair is
  also doing real work in the right direction: turning it off makes agreement
  worse, 44 wrong against 33 at L790.)
- **Not the rejections** - a rejection is a post-filter that cannot alter a
  neighbouring cell's orientation, and the disputed cells are ones BOTH sides
  place.
- **Not the query window** - the game's cells are centre-filtered, so the
  bbox-vs-centre artefact of #101 is out; `missing` is 0-2 per case.
- **Not a boundary tie** - the disputed edges sit a median 18.8 and a maximum
  **69.0** elevation units from the level.

### The paradox that replaces it, and the handoff

At **72 of the 73** disputed edges the game's OWN TILE CHANNEL straddles the
level, and agrees with our cliff-channel value at those corners (worst 18.9,
almost all 0). So the game's cliff generator is reading a field that differs from
the game's own `calculate_tile_properties` elevation at those corners, while the
port has the two equal.

**`multisample` cannot be that difference.** At these corners our grid-4 and
grid-1 variants return the same value - the basalt-lakes term is lerped away at
high elevation, and the bake-off scores the tile channel *identically* to the
shipping field at L790 and L910. The two natural widenings of the min-filter
(over the whole elevation, and over the cliff channel) are catastrophic: 791 and
735 wrong against 73.

So what separates the game's two channels at `[1500,1500]` is something the port
does not model at all, it lives in the MOUNTAINS branch of `vulcanus_elev` (the
only branch that reaches 670+), and it is region-local - `[0,0]` and
`[-1200,800]` never rise past 402 and are exact. That is the next thing to find.

The obvious next measurement is a **fine level sweep** (e.g. 700..900 step 5 at
`[1500,1500]`), which brackets the game's cliff-channel value per corner to the
step and turns "differs by at least 69" into the actual field. It is ~40 runs of
the same capture, no new machinery.

## CORRECTION: the field is RIGHT - the fine sweep refutes the section above (2026-08-03, #84)

The section immediately above concluded, from `oracle-vulcanus-cliff-bands`,
that the port's grid-4 cliff-elevation field is wrong at `[1500,1500]`'s high
bands, and handed over "it lives in the mountains branch of `vulcanus_elev`". The
fine sweep was run to quantify that. **It refutes it instead.**

`oracle-vulcanus-cliff-fine-sweep` sweeps `cliff_elevation_0` across
`[700, 900]` step 5 with the same collapsed rule. Each placed cell's orientation
asserts one-sided constraints on its corners - a crossing at level `L` says "this
corner > L, that one < L" - so 41 levels bracket a corner to the step. Only
POSITIVE observations are used, which is what makes it sound: an absent cliff is
ambiguous (the lava/ore rejections drop whole cells) but a present crossing is
not, because `fixImpossibleCellsSweep` only ever writes `0` and the rejections
never touch the edge registers.

| | |
| --- | --- |
| corners with a two-sided bracket | **998** |
| mean bracket width | **5.72** |
| where the port's value is INSIDE the game's bracket | **996** |
| worst miss of the other two | **6.7e-4** (the port sits ON a swept level, where the strict test yields no observation - the open endpoint, not an error) |
| disputed-edge corner slots with a bracket | 26 of 72 |
| of those, containing the port's value | **26 of 26** |

So the field is exonerated **by direct measurement** rather than by scoring, and
this also independently re-confirms the `(i*4, j*4)` corner lattice: a wrong
sampling site could not put 996 of 998 values inside 5-unit brackets.

### Where the earlier reasoning went wrong

The bands fixture established what the residual is NOT (not smoothing, not the
gate, not the repair, not the rejections, not a boundary tie) and then treated
the field as the last man standing. But it never measured the field - it measured
that the port's value sits a median 18.8 from the level at the disputed edges,
which is a statement about OUR field, not the game's. "Everything else is
excluded, so it must be X" is only as good as the list, and the list was not
closed. **The lower bound was real; the attribution was not.** Same shape as #88,
where the best-scoring model was the wrong one.

### What is actually left

Across all 41 levels, the game's cell code is the port's code **with edges
removed** in **1231 of 1235** disputed cells - the port finds crossings the game
does not, and essentially never the reverse.

The lead is in the coverage number: only 26 of 72 disputed corner slots get a
two-sided bracket, and 661 of the 1,659 corners whose value lies in `[700,900]`
get none. A corner goes unbracketed when the game emits no entity beside it at
any level - which is what the lava and ore rejections do to whole neighbourhoods.
Read one chunk at `L = 790` and the pattern is visible directly: cell
`1634,1706.5` keeps its TIGHT edge (714.4 -> 795.9, margin 5.9) and loses its
WIDE one (721.0 -> 875.4, margin 69), and the cell sharing that wide edge
(`1634,1702.5`) is absent from the game entirely. The dropped crossings sit
against cells the game did not emit.

That points at the emission/rejection path, not at the field - i.e. back toward
whether something suppresses a crossing (not merely an entity) in the
neighbourhood of a rejected cell. Note this is a HYPOTHESIS from one chunk plus
the coverage statistics; it has not been tested, and the obvious control is
whether disputed edges are adjacent to rejected cells at a rate above the base
rate of all crossing edges.

## The rejections act on the CROSSING, not on the entity (2026-08-03, #84)

#107 handed over a hypothesis - "disputed edges sit adjacent to rejected cells
above the base rate of all crossing edges" - and named the control. Run, it is
not an enrichment over a base rate. It is a dichotomy, and it refutes the stage
at which the port applies both Vulcanus cliff rejections.

`test/vulcanusCliffRejectionStage.spec.ts`, over the fine sweep's 41 levels at
`[1500,1500]`:

| | |
| --- | --- |
| edges the port has and the game does not | **1235** |
| ... sitting against a cell the game did not emit | **1233** |
| edges both sides agree on (in region) | **36103** |
| ... sitting against a cell the game did not emit | **0** |

Zero, not "fewer". A cell's edge register is the same array slot as its
neighbour's (#103), so this says the game's absences take their crossings with
them, every time.

### The refutation is structural, not a score

The post-filter reading makes a falsifiable prediction, and it does not need any
model to score well. When cell `N` is rejected, a pure post-filter leaves the
shared crossing in `C`'s code, so `C` is emitted still carrying it. Counted with
the port's own rejection predicate, that should happen **1,662 times** across the
41 levels. The game does it **0 times**.

The vacuity arm is the same counter reading the port's own post-filter output
instead of the game's: it fires on all 1,662. So the zero is a property of the
game's cliffs, not a dead branch. (A first attempt at a vacuity arm compared
against the *next* level's game output and also returned 0 - not a broken
control but a stronger result, since the invariant holds independently at all 41
levels.)

Note what this does and does not settle. `tryToAddCliff` really does ignore
`wouldCollide`'s return value - the disassembly reading behind #71/#73 was not
misread. What is refuted is that the OBSERVABLE output behaves like a
post-filter. Whether `wouldCollide` removes the crossings or the game never
computed them there is not decidable from entity dumps, and the port now models
the first because it is the one that can be written.

### The fix, and what it is worth

`rejectAtCrossingStage` in `cliffPlacement.ts` zeroes a rejected cell's four edge
registers after the repair sweep, before any code is read. Scored two ways:

| | matched | wrong | surplus | missing |
| --- | --- | --- | --- | --- |
| collapsed rule, post-filter | 18130 | 1235 | 1366 | 85 |
| collapsed rule, crossing stage | **18654** | **693** | **1200** | 103 |

and at the SHIPPING settings (smoothing 1, the real 120-tile interval,
`cliffiness_basic` rather than a constant) across the three entity regions:
wrong orientations **33 -> 21**, precision 0.9839 -> 0.9858, and the matched set
**identical** at 1525 - this removes wrong edges and costs no recall at all.

It is not free: 18 more of the game's cells go missing under the collapsed rule,
because an edge taken off a survivor can leave its code non-placing. Reported
rather than buried.

Nauvis is unaffected in both directions - it already matched 1.0000 recall and
precision, and enabling the flag there reproduces the same 282 and 52 cells with
0 wrong orientations. So this is not a regression risk on the other planet, but
neither is it corroboration from it: Nauvis has no cells that could move.

### What is left

The predicate, not the stage. 693 wrong orientations and 1200 surplus cells
survive under the collapsed rule, and the remaining absences still follow the
same "the game emitted nothing there" shape - so the lava-box + ore predicate is
catching most of what the game suppresses but not all of it. Chasing that is a
question about WHICH cells the game refuses, and the sweep cannot answer it
where the game emits nothing at any level: those corners get no bracket, so the
field there is still unmeasured. A wider sweep (well outside `[700,900]`) is the
measurement that would close that gap.

## The residual is a SUPPRESSION, and the wider sweep is not worth capturing (2026-08-03, #84)

The section above handed over "a sweep well outside `[700,900]` is the
measurement that would close the gap". **Do not capture it.** The constraints
already on disk answer the question, because
`oracle-vulcanus-cliff-bands`'s `constant1` arm covers the SAME region under the
SAME collapsed rule at 70..1150 - its observations fold straight into the fine
sweep's. `test/vulcanusCliffSuppression.spec.ts`.

### The field's exoneration is much wider than #107 stated

#107 checked 998 two-sided brackets. It left the **one-sided** bounds unused, and
those falsify just as well: a corner the game only ever made the HIGH side at
level `L` is asserted to be above `L`, which a port value below `L` would refute.

| | |
| --- | --- |
| corners constrained from one side only | **1711** |
| of those, contradicting the port's value | **0** |

### The silence is not the field running out of range

Adding the bands' 10 levels widens the window 5x (70..1150 rather than 700..900)
and rescues exactly **1** of the 681 corners the fine sweep left unbracketed.
294 corners whose port value sits in `[700,900]` get **no constraint of any
kind** across all 50 levels - while the port asserts **8,906** crossings on their
edges over those same levels, with **not one** of the 294 where the port is
silent too.

For a field error to produce that it would have to move those corners outside
`[70, 1150]` entirely *and* leave all 1,711 one-sided bounds elsewhere satisfied.
The two sides are not disagreeing about a value; they are disagreeing about
whether anything is emitted at all.

### Two suppressor candidates refuted, each against a base rate

| population | n | rock in the cliff's box | default gate fully shut |
| --- | --- | --- | --- |
| matched (base rate) | 18654 | 1312 = **7.03%** | 8588 = 46.0% |
| surplus | 1200 | 127 = **10.58%** | 617 = 51.4% |
| wrong orientation | 693 | 35 = **5.05%** | 311 = 44.9% |

- **Rocks** - `Surface::wouldCollide`'s unported entity half, the obvious
  candidate. Refuted: 1.5x on the surplus is weak, and the wrong-orientation
  cells are *anti*-correlated at 5.05% against 7.03%. A suppressor cannot be
  anti-correlated with half the defect it is supposed to cause.
- **The default `cliffiness_basic` gate** - a confound check rather than a
  candidate. Flat across all three populations.

**That last row is worth more than the refutation it came from.** The game emits
**8,588** cells where the default gate would be fully shut, so routing
`cliffiness` at a literal 1 genuinely opened it. The collapsed-rule oracle that
#106, #107 and #108 all rest on is not quietly confounded by the gate it claims
to have removed - which had never been checked.

### Where that leaves it

Still the predicate. What is now excluded for the suppression: the field (twice
over, by brackets and by one-sided bounds), rocks, the cliffiness gate, the
smoothing, the repair, and - since #108 - the STAGE. What remains is which cells
the game refuses, and the honest statement is that the list is open: the same
trap #106 fell into is available here, so the next candidate needs a positive
measurement rather than promotion by elimination.

## The ore rule, scored against the lever - and the cascade refuted (2026-08-03, #84)

`oracle-vulcanus-cliff-ore-direction` re-ran `[1500,1500]` with the resources
switched off through `autoplace_controls`, so the ore's effect is a known SET of
cells rather than an inference. Scoring the port's predicate against it gives a
precision and a recall instead of a total to match.
`test/cliffOreCascade.spec.ts`.

| | |
| --- | --- |
| game, resources ON / ALL OFF (in region) | 861 / 892 |
| cells the ore suppresses | **31** |
| cells that APPEAR when ore is added | **0** (the one-way property of #99, re-confirmed on the entity region) |
| cells merely re-coded | 5 |
| our model suppresses | **22**, of which genuinely suppressed **22** |
| | **precision 1.000, recall 0.710** |

**The rule is exactly right where it fires and simply too narrow.** That is a
much more useful statement than "it explains 21 of 31", because it says which
direction is safe to move in.

Attribution of the 31, from the per-control arms: **27 calcite, 4 geyser, 0
tungsten/coal**. Of the 9 our predicate misses, **4 are geyser** cells that
`includeGeyser: false` deliberately excludes (the geyser rolls, so including it
costs precision - measured, still harmful), 5 are calcite, and **all 9 are
adjacent to another suppressed cell**.

### The crossing stage explains 2 remainders for free

The predicate fires on **20** placed cells; the placement loses **22**. The extra
two are neighbours left with a non-placing code after a rejected cell's edges
were zeroed (#108). No tuning - it falls out of the mechanism, and it is the
first thing to reduce the remainder count since the rule was characterised.

### The cascade half of the open question is REFUTED

`vulcanusOreRejection.ts` left it as "a cascade along cliff connections **or** a
wider box". #108 makes the cascade concrete: zeroing a cell's edges changes a
neighbour's code, hence its orientation, hence its collision box, so re-testing
to a fixpoint is exactly that cascade. `rejectionCascades` is the arm.

| | matched | wrong | surplus | missing |
| --- | --- | --- | --- | --- |
| collapsed rule, one pass | 18654 | 693 | 1200 | 103 |
| collapsed rule, fixpoint | 18640 | 700 | 1196 | 110 |

At the SHIPPING settings it is **bit-for-bit identical** - and the collapsed-rule
row is what makes that a result rather than an untriggered branch. A rejected
cell never turns a neighbour into a rejectable orientation.

That leaves the wider-box half, which is the one #88 says must not be tuned into
fitting.

### Half of `[1500,1500]`'s residual is not ore at all

Running BOTH sides with the resources off isolates it:

| | matched | wrong | surplus | missing |
| --- | --- | --- | --- | --- |
| resources ON, both sides | 842 | 16 | 19 | 3 |
| resources OFF, both sides | 876 | **13** | **10** | 3 |

So 13 wrong orientations and 10 surplus cells survive with the ore entirely out
of the picture. Tuning the ore rule cannot reach them, and that non-ore half is
the larger target now.
