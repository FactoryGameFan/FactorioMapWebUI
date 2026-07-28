# Vulcanus cliffs - port notes

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

- **No water exclusion.** Vulcanus has no water tile. Lava plays that visual
  role but is not water, and the game does not exclude cliffs from it here.
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
(3553 vs 3684 - smaller working set), while tiled `all` is **17% dearer**. It
lands entirely on the overlays, because each 128px tile re-resolves every 32x32
chunk it overlaps and neighbouring tiles redo the same chunks. That is a THIRD
source of duplication, distinct from the two below, and nothing here touches it.

### What the two mechanisms buy - measured 2026-07-28

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
