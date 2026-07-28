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
outstanding. **Before any of this is re-attacked, the benchmark needs fixing:**
run-to-run variance is 5-23% and a single 5-iteration run spread the Vulcanus
terrain render 22.7%, so `pnpm perf`'s median-of-3 cannot resolve a change of the
size any of these fixes would produce.

The cliff pass is more expensive than its sample count suggests. Corners sit on
a 4-tile lattice, so at 1 tile/px it evaluates one elevation sample per 16
pixels, yet it adds ~6.5 us/px. Each Vulcanus renderer builds its **own** field
stack (helpers, spawn, cracks, biomes, climate, elevation) rather than reusing
the terrain render's - the same duplication V2 documented for resources - so on
the `all` path the Vulcanus DAG is evaluated four times per pixel region.

## Not validated

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
