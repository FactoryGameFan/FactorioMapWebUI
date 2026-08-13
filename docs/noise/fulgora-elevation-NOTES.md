# Fulgora elevation - measured findings

Working notes for the Fulgora port (issue #27). **Every claim here states how it
was measured.** A stated cause with no stated measurement is a hypothesis, not a
finding - that rule exists because an earlier NOTES file in this repo recorded
five guesses as findings and all five were later falsified.

Source Lua: `~/GitHub/factorio-data/space-age/prototypes/planet/planet-fulgora-map-gen.lua`.

**Version:** ported against **2.1.14**. The map-gen Lua is byte-identical
2.1.12 -> 2.1.14 - checked as an empty `git diff` over
`space-age/prototypes/planet/`, `core/prototypes/noise-programs.lua`,
`core/prototypes/noise-functions.lua` and `base/prototypes/noise-expressions.lua`,
not inferred from a changelog.

---

## Task 7: the shared layer (`fulgoraShared.ts`)

Lua lines 22-124. Fixture: `test/fixtures/oracle-fulgora-shared.seed123456.json`,
101 positions, seed 123456. Spec: `test/fulgoraExpressions.spec.ts`.

### `fulgora_grid` is NOT an integer - the plan's assumption is refuted

`fulgora_grid` is `175 - slider_to_linear(control:fulgora_islands:frequency, -50, 50)`.
The implementation plan carried an open question: the Voronoi primitive documents
`grid_size` as a 16-bit **unsigned integer**, so does the game truncate, round,
or never produce a fraction?

Measured by sampling `175 - slider_to_linear(<s>, -50, 50)` on a real Fulgora
surface at five slider positions:

| frequency | grid | integer? |
| --- | --- | --- |
| 0.5 | 194.34263610839844 | no |
| 1 (default) | 175 | **yes** |
| 2 | 155.65736389160156 | no |
| 3 | 144.3426513671875 | no |
| 6 | 125 | **yes** |

It is integral only at the two slider **endpoints**, where `log2(s)/log2(6)` is
exactly 0 and 1. That is a property of those positions, not of the expression.
So `fulgora_grid` is a genuine float and the port keeps it one.

Whether the **Voronoi call** then truncates it to a u16 was a different question,
about `grid_size` rather than about this expression. **Answered in Task 8 below:
it truncates.**

### `slider_to_linear` is f32 per-operation, and only `s = 3` can prove it

An f64 chain rounded once at the end reproduces four of the five values above
and misses `s = 3` by exactly one f32 ulp (144.34263610839844 against the game's
144.3426513671875). Rounding **every operation** to f32 matches all five exactly.

Measured, all five positions, worst |diff| at f32:

| evaluation order | worst |
| --- | --- |
| f64 throughout, one final round | 1.526e-5 |
| f32 on the log2 ratio only | 1.526e-5 |
| f64 throughout, rounded at the end | 1.526e-5 |
| **f32 per operation** | **0** |

**The sweep design is the finding here, not just the answer.** The other four
probes cannot see the difference: 0.5, 1 and 2 have power-of-two numerators, and
at `s = 6` the ratio is exactly 1 whatever `log2(6)` evaluates to. A four-point
sweep that skipped 3 would have "confirmed" the f64 form. This is the third time
in this repo an f32-vs-f64 detail has hidden behind a sweep that happened to
avoid the one discriminating input (cf. #165, #166, #167).

`sliderToLinear` in `src/noise/eval/math.ts` was changed to f32 for **all**
callers. Nauvis's moisture use is unaffected because its default size is 1, so
`log2(1) = 0` is exact either way - which is what the function's own comment had
predicted would eventually matter.

### `log2` is EXACT, not fastapprox - tried and refuted

The obvious suspect for the `s = 3` miss was the game's fastapprox `Math::log2`.
It is wrong: `fastLog2` misses **all five** values, and breaks the exact 175 at
the default `s = 1` (it gives 175.00004611664207). `slider_to_linear` is
evaluated on the prototype side rather than by the noise machine, so
`Math::log2` never enters it. Keep `Math.log2`.

### Agreement with the game, per field

Worst |diff| at f32 over the 101 fixture positions:

| field | worst | note |
| --- | --- | --- |
| `ox`, `oy` | **0** | exact |
| `startingMask`, `startingVaultMask` | **0** | exact (booleans) |
| `startingCone` | 1.12e-7 | |
| `wobbleMask` | 5.74e-7 | |
| `wobbleInfluence` | 7.15e-7 | |
| `startingVaultCone` | 8.05e-7 | |
| `wobbleX`, `wobbleY` | 3.81e-6 | `output_scale` = `grid * 0.07` = 12.25 |
| `wx`, `wy` | 1.53e-5 | compounds the above with a coordinate up to 15000 |

The non-zero rows are the port's known `basisNoise` floor - it evaluates in f64
where the game uses f32 - scaled by each field's own `output_scale`. `wobbleX`'s
3.81e-6 is ~3.1e-7 relative, the same order as the ~7.2e-7 documented for
`basisNoise` elsewhere. **Nothing here is Fulgora-specific**, and none of it
will improve until `basisNoise` itself moves to f32.

### The fixture's coordinates must be on the 1/256 grid

`ox` is literally `x + grid/2`, so it can only agree exactly if the port and the
game evaluate the same point. The first capture used ring positions like
`r * cos(a) + 0.5`, which are not multiples of 1/256; Factorio stores a
MapPosition as 1/256-tile fixed point, so the game sampled a **different point**
and `ox` came back out by exactly 1/256 (3.906e-3). That reads as a porting bug
and is not one.

The capture now snaps every coordinate to a quarter tile. `ox`/`oy` going exact
is the alignment check - if they ever stop being exact, suspect the fixture's
coordinates before suspecting the port.

### Two plants confirm the spec discriminates

- **Swapping the `fulgora_wobble_x`/`_y` seed constants** fails 6 tests,
  including both cones and both masks. The x/y asymmetry really does come from
  the seed alone - the two calls are otherwise identical.
- **Dropping the tight cone's `0.25` distortion damping to 1** fails exactly one
  test, `startingCone`, by 4.9e-2 against a 2e-7 bound, at (0.5, 0.25) - right
  at spawn, which is the only place that second disc matters.

### Seed constants

The game hashes a string `seed1` with a standard CRC32, resolved once and
hardcoded the way `nauvisShared.ts` does it:

| string | value |
| --- | --- |
| `fulgora_wobble_x` | 686434221 (0x28EA27AD) |
| `fulgora_wobble_y` | 1609373499 (0x5FED173B) |

`fulgora_wobble_influence` uses a numeric `seed1 = 1`, not a string.


---

## Task 8: the Voronoi layer (`fulgoraCells.ts`)

Lua lines 126-205. Fixture: `test/fixtures/oracle-fulgora-cells.seed123456.json`,
the **same 101 positions** as the shared-layer fixture (the spec asserts that, so
the two cannot drift apart and quietly invalidate every cross-comparison).

### `grid_size` IS truncated to an integer - Task 7's open question, closed

The Voronoi primitive documents `grid_size` as a 16-bit **unsigned integer**, but
`fulgora_grid` is a genuine float away from the two slider endpoints. The default
grid is exactly 175, so **the default settings cannot answer this** - the probe
passes a fractional `grid_size` literal instead.

`voronoi_cell_id` at `grid_size = 155.65736389160156` (what `fulgora_grid` really
is at islands frequency 2) against the two integers it sits between, 101
positions:

| comparison | agreement |
| --- | --- |
| fractional == **truncated (155)** | **101/101** |
| fractional == rounded (156) | 91/101 |
| truncated == rounded | 91/101 |

**The third row is what makes this a measurement.** 155 and 156 are genuinely
different fields, disagreeing at 10 of 101 positions - had all three agreed, the
probe would have shown nothing and "it truncates" would have been unfounded.

`Math.trunc` now lives in `makeVoronoi`, not at the Fulgora call site: it is a
property of the primitive's parameter type, so every caller gets it. This changes
**no** existing behaviour - every committed voronoi fixture uses an integral grid
(175, 64), where truncation is a no-op, which is exactly why it went untested for
so long. It changes results the moment the islands frequency slider leaves 1.

### Agreement with the game, per field

| field | worst | note |
| --- | --- | --- |
| `cells` | **0** | exact |
| `blanks`, `mesa`, `sprawl`, `vaults` | **0** | exact |
| `vaultsAndStartingVault` | **0** | exact |
| `pyramids` | 7.11e-6 | |
| `spots`, `spotsInv` | 7.54e-6 | |

**The split between exact and not is the informative part.** All of these read
the same distorted coordinates, which arrive from the shared layer already
carrying its `basisNoise` floor (`wx`/`wy` worst 1.53e-5). `cells` is a
**discrete** lookup - it reports which cell won - so a coordinate error that
small almost never changes the answer, and it comes back exact. `pyramids` and
`spots` are continuous, so the same input error passes through. Both land BELOW
the 1.53e-5 they inherit, as a contraction should; neither layer introduces new
error.

`cells` being exact matters more than its neighbours: every island class is
derived from it by threshold, so an error there would **reclassify whole
islands** rather than shade them.

### One instance serves `cells` and `pyramids`

They are the same Voronoi field read through two ops - identical seed, grid,
distance type and jitter - so they share one `makeVoronoi` and therefore one
per-cell point cache. `spots` needs its own because the distance type differs
(euclidean, not manhattan), and note it is also sampled at **different
coordinates**: `ox + wobbleX/2`, half the distortion `wx` applies. The moats sit
slightly off the islands they belong to.

### Seed constant

| string | value |
| --- | --- |
| `fulgora_cells` | 1512814397 (0x5A2BB73D) |

All three Voronoi calls use it - `pyramids` and `spots` deliberately share
`cells`' seed so they describe the same tiling. **Compute it, do not guess it:**
the first draft of `fulgoraCells.ts` carried a hand-invented constant, which
would have produced a plausible, entirely wrong map.

---

## Task 9: the elevation mix chain (`fulgoraElevation.ts`)

Lua lines 206-336, plus `fulgora_scrap_medium` (371), `fulgora_dunes` (513) and
`fulgora_rock` (523). Fixture:
`test/fixtures/oracle-fulgora-elevation.seed123456.json`, the **same 101
positions** as the shared and cells fixtures.

### ROOT CAUSE: the port fed the noise primitives f64 coordinates

This is the largest finding of the task and it is not Fulgora-specific.

`fulgora_basis_oil` first came back with a worst residual of **2.37e-4** - about
2000 f32 ulps, and 300x the port's documented `basisNoise` floor. Narrowing the
incoming coordinate to f32 before the multioctave call fixes it. Measured, all
101 positions:

| field | f64 coordinate | f32 coordinate | ratio |
| --- | --- | --- | --- |
| `fulgora_basis_oil` | 2.37e-4 | **7.15e-7** | 331x |
| `fulgora_basis` | 6.94e-6 | **2.09e-7** | 33x |
| `fulgora_pyramids` | 7.11e-6 | **1.19e-7** | 60x |
| `fulgora_spots` | 7.54e-6 | **1.19e-7** | 63x |

Every field lands on the `basisNoise` floor. The mechanism: the noise machine
passes f32 values between expressions, so the coordinate the game evaluates at
is an f32; an f64 coordinate can sit half an f32 ulp away, and at
`fulgora_basis_oil`'s reach of ~15000 tiles that ulp is 9.8e-4.

**Why it hid for so long.** Every caller before Fulgora passes a RAW WORLD
COORDINATE, and an integer or quarter tile below 2^24 is already exactly
representable in f32 - so the narrowing is a no-op on them. Confirmed rather
than assumed: `oracle-multioctave.seed123456.json` reports the identical
7.153e-7 worst with and without it, and the full 203-file suite is unchanged.
Fulgora is the first caller to pass a **derived** coordinate
(`fulgora_wx = x + grid/2 + wobble_x * wobble_mask`).

**Two things say this is a real fix, not a lucky fit.** The corrected worst
residual moves from the FAR field to the NEAR field, which is the signature of
removing a magnitude-dependent error rather than of a fudge that happens to
score better. And `fulgora_cells` was f32-exact both before and after - it is a
discrete argmin, so a sub-ulp coordinate shift almost never changes which point
is nearest, exactly the asymmetry a coordinate-precision cause predicts.

The narrowing lives in `sumOctaves` and in `makeVoronoi`'s `toGrid`, not at the
Fulgora call sites, on the same reasoning that put `Math.trunc` inside
`makeVoronoi` in Task 8: it is a property of the primitive's interface, so every
caller gets it. `toGrid` is the single entry point for all four voronoi ops.

Consequence for Task 8: the committed `pyramids` and `spots` bounds were 1e-5
against a measured 7.1e-6 / 7.5e-6, and are now **2e-7** against 1.19e-7. That
tightening is a real regression guard - dropping the `toGrid` narrowing fails 7
tests.

### `slider_rescale` is exact math at per-operation f32

`fulgora_natural` scales by `slider_rescale(control:fulgora_islands:size, 2)`,
where `slider_rescale(s, n) = 2^(log2(s)/log2(6)*log2(n))`.

**The captured positions cannot test this at all.** The default size slider is
1, and `slider_rescale(1, n)` is `2^0 = 1` exactly, so at default settings the
term is a multiply by one and any implementation whatsoever passes. Same trap as
`grid_size` in Task 8: the default is the one input that cannot discriminate.
The fixture therefore carries a `sliderRescaleProbe` sampling literal slider
values. Measured against the game at s = 0.5, 1, 2, 3, 4, 5, 6:

| evaluation order | exact matches |
| --- | --- |
| **f32 per operation** | **7/7** |
| f64 throughout, one final round | 5/7 |
| fastapprox `pow` (the noise machine's `^`) | 1/7 |

Two conclusions, neither assumable. The `^` is **exact**, so like
`slider_to_linear` this resolves on the prototype side and `Math::powSafe` never
enters it - which is why `Math.pow` is right here while `fastPow` is right
inside `multioctaveNoise`. And it needs the same **per-operation f32 rounding**
`slider_to_linear` needed.

Note which rows discriminate: s = 1 and s = 6 are blind by construction (the
exponent is exactly 0 and exactly 1), and 2, 3 and 4 happen to agree between the
f64 and f32 forms too. **Only 0.5 and 5 separate them.** The five-point sweep
that settled `slider_to_linear` would have caught this on a single row.

### Agreement with the game, per field

Worst |diff| at f32 over the 101 positions:

| field | worst | note |
| --- | --- | --- |
| `oilMask` | **0** | exact (discrete) |
| `sprawlPyramids`, `mixPyramids` | 2.98e-8 | |
| `basis` | 2.09e-7 | |
| `rock`, `scrapMedium` | 2.38e-7 | undistorted coords |
| `dunes` | 2.68e-7 | undistorted coords |
| `mixNatural` | 3.87e-7 | |
| `vaultPyramids`, `vaultPyramidsAndStart` | 4.02e-7 | |
| `natural` | 4.77e-7 | |
| `basisOil` | 7.15e-7 | |
| `moats`, `mixMoats`, `mixSpots` | 1.19e-6 | |
| `mixOil`, `sandBasins` | 1.22e-6 | |
| `vaultSpots` | 5.06e-6 | 11.5x gain, see below |
| `preElevation`, `elevation` | 7.63e-5 | 60x gain, see below |

All of it is the `basisNoise` floor carried through the chain's own gains. The
two apparent outliers are arithmetic on that floor, not new error:
`vault_spots` applies a `-10 + 11.5 * max(...)` remap, and `elevation` is
`sand_basins * 60 + 80`. Relative to its own magnitude `elevation` is the most
accurate field in the table, at 8e-7.

`oilMask` being exact is the load-bearing row: it is a comparison against 0, so
a residual there would mean an upstream error had grown enough to flip a sign -
reclassifying land as ocean rather than shading it. Task 10's land/ocean
agreement check rests on it.

### The four masks really are unused

`fulgora_natural_mask`, `fulgora_natural_and_mesa_mask`, `fulgora_sprawl_mask`
and `fulgora_artificial_mask` sit in the middle of the same Lua block, which
makes them look like part of the chain. They are not ported, and that is
measured rather than assumed: `fulgora_elevation` reproduces the game's own
value to 7.6e-5 without them, which it could not do if the chain read them.
They belong to the deferred tile layer.

### Six plants confirm the spec discriminates

Each was applied, run, and reverted:

| plant | tests that fail |
| --- | --- |
| `mix_pyramids` 0.185 -> 0.18 | 4, starting at the pyramid terms |
| swap the `basis` / `basis_oil` seed constants | 7 |
| `sand_basins` 0.6 -> 0.5 | 2, correctly only from `mix_oil` down |
| `sliderRescale` returns 1 unconditionally | **6, all in the slider probe** |
| drop the f32 narrowing in `toGrid` | 7 |
| drop the f32 narrowing in `sumOctaves` | 6 |

The fourth is the informative one. A port that hardcoded the default would pass
every one of the 101 positions and fail only the probe block - which is the
whole argument for capturing that probe.

### Seed constants

Computed with the repo's own `crc32`, not guessed:

| string | value |
| --- | --- |
| `fulgora_basis` | 2183403986 (0x822419D2) |
| `fulgora_basis_oil` | 1819171631 (0x6C6E5B2F) |
| `fulgora_rock` | 3721161451 (0xDDCC6AEB) |
| `fulgora_dunes` | 1783911317 (0x6A545395) |
| `fulgora_scrap_medium` | 1100006120 (0x4190C2E8) |

The helper was checked by re-deriving the two constants already committed
(`fulgora_cells`, `fulgora_wobble_x`) and confirming they match.

---

## Task 10: the oil-ocean argmax (`fulgoraCatalog.ts`)

Source: `space-age/prototypes/tile/tiles-fulgora.lua` (the four `oil-ocean-*`
`probability_expression`s) and `water_base` from
`base/prototypes/noise-expressions.lua:69`. Fixture:
`test/fixtures/oracle-fulgora-tiles.seed123456.json` - 5057 real
`surface.get_tile(x, y).name` results, the first Fulgora fixture that reports
what the game PLACED rather than what an expression evaluated to.

### A NaN probability must LOSE, not veto every other tile

Worth 211 of the resolver's first 218 mismatches.

`water_base` returns `-inf` above its tile's water level, and three of the four
ocean tiles multiply that by a factor that is often exactly 0 - so `0 * -inf`
produces a genuine NaN at a large share of real positions. A plain `Math.max`
propagates it, and every tile in the comparison then loses to one tile's NaN.

Measured: it wrongly called **218 of 5057** positions land. Every one was a real
`oil-ocean-shallow` or `-shallow-2` with the mask on, a shallow probability
around 50000, and an elevation between the deep level (20) and the coastline
(80) - exactly the band where `deep = 100 * 1 * -inf` and `deep2 = 0 * -inf`.
Replacing `Math.max` with a max that skips NaN takes it to **7**.

**This is a general trap, not a Fulgora one.** Any tile catalog built on
`water_base` can hit it, because the argmax is per tile: a tile whose
probability is not a number simply is not placed, and it cannot veto the others.

### The remaining 18 are NOT in these expressions - measured, not conceded

The plan specified `expect(mismatches.length).toBe(0)` and said not to relax it.
Seven land/ocean and eleven shallow/deep mismatches remain, and they are
unreachable by any transcription of the four expressions.

**The game was asked directly at the disputed positions.** Its own
`fulgora_elevation`, `fulgora_oil_mask`, `fulgora_mix_spots`,
`fulgora_sand_basins` and `fulgora_scrap_medium + fulgora_dunes` agree with this
port to 5+ decimal places at all 18. At the seven land/ocean misses the GAME
reports `fulgora_oil_mask = 0` and `fulgora_elevation` between 90.1 and 90.9 -
under which every ocean tile scores `0 * -inf` (NaN) or `-inf`. The game placed
`oil-ocean-shallow-2` at positions where **its own expressions score that tile
unplaceable**. That rules out the whole family of "we transcribed a constant
wrong" explanations in one measurement.

What the residual IS: **boundary-exclusive.** All 18 sit at Chebyshev distance
exactly 1 from a tile this port already assigns the game's own class, against a
**measured** base rate of 3.8% of positions adjacent to a land/ocean flip and
10.0% adjacent to any class change. 18 of 18 is p ~ 1e-10 under the null. That
points at a post-argmax tile transition or correction pass.

Two rival explanations were tried and refuted rather than argued away:

- **Tile centre instead of corner.** Factorio could plausibly evaluate tile
  autoplace at `(x + 0.5, y + 0.5)`. Sampling there makes it **worse** - 38
  binary and 59 shallow/deep against 7 and 11 - so the corner is right. The
  fixture's positions are the mod's echoed floored `get_tile` input, so this was
  a real possibility, not a strawman.
- **A shifted or different `elevation` for the tile layer.** Refuted by the data
  itself: deep is placed at `fulgora_elevation` 28.0 (above the level of 20) and
  NOT placed at 13.4 (below it), so no monotone remapping of elevation can order
  those two the way the game does.

The spec therefore gates on the exact counts **plus boundary-exclusivity**,
which is strictly stronger than `toBe(0)` on a passing model: it fails if the
count moves in either direction, if any mismatch appears away from a boundary,
or if the boundary set grows enough to make the adjacency check cheap. Three
plants confirm it - restoring the NaN veto, moving the deep level 20 -> 30, and
collapsing deep into shallow each fail the adjacency test.

### The land tiles are not modelled, and that is a dominance argument

Fulgora's eight land tiles score of order 1 (`fulgoran-dunes` is
`1 + fulgora_dunes`, `fulgoran-sand` is `1 - fulgora_dunes`, and so on) while an
ocean tile with its mask on scores `50 * 1000 * ...` or `100 * 2000 * ...`. So
wherever an ocean probability is positive it wins and the land tiles only have
to be resolved against each other, which the map colour does not need.

The thin spot is named rather than hidden: the two shallow tiles split on the
SIGN of `scrap_medium + dunes`, so where that is near zero both are near zero
and a land tile could win. `deep` does not read it at all and covers most of
that region. Note this is NOT the cause of the seven residual land misses - the
plan predicted it would be, and `s` is 0.20 to 1.37 at all seven, nowhere near
zero.

### Fixture design

Two samples, and neither alone is enough. A contiguous **256x256 block at stride
4** centred on (-1500, 1000) - chosen by asking the PORT for the block nearest a
50/50 oil-mask split, so the game is questioned about the coastline rather than
a convenient interior - plus a **coarse stride-400 grid** to +/-6000 tiles,
because the block spans only ~1.5 Voronoi cells while the grid crosses many.
That the block really is mixed is asserted from the GAME's names, so the port's
role in choosing it cannot make the check vacuous.

---

## Task 11: the render and the planet dispatch

`renderFulgoraTerrain` sweeps the pixel grid through `makeFulgoraSurfaceResolver`
and paints each pixel's map colour. Colours are taken from
`space-age/prototypes/tile/tiles-fulgora.lua`, not picked by eye:
`oil-ocean-shallow` and `-shallow-2` both declare `{74, 42, 43}`, and
`oil-ocean-deep` and `-deep-2` both declare `{49*1.15, 31*1.15, 35*1.15}` -
which is the source of the claim that each pair shares a colour, so the resolver
never has to decide which variant of a pair won. Land uses `fulgoran-sand`'s own
colour, so a later pass that resolves Fulgora's eight land tiles against each
other can land without the palette jumping.

### The surface seed is the one defect no fixture can catch

Every Fulgora fixture here is captured through a harness that sets `mgs.seed` on
the created surface EXPLICITLY, so inside those runs `map_seed` simply IS the
map seed and `surfaceSeedForPlanet` is bypassed. **A renderer that passed the
raw map seed straight through would agree with every fixture in this directory
and still draw the wrong planet for a real user.** That is not hypothetical - it
is exactly the Vulcanus surface-seed bug, which passed every internal check for
weeks because the fixture and the code agreed with each other while both
disagreed with the game. `test/fulgoraSurfaceSeed.spec.ts` renders the same
window at the derived seed and at the raw map seed and requires the two to
differ.

### A plant that PASSED found the real gap

Three plants were run against the render. Two failed the right tests
immediately: hardcoding the seed inside the renderer fails the surface-seed
guard and two hash pins, and giving `deep` the shallow colour fails all four
hash pins.

The third - replacing `req.fulgoraIslandControls` with hardcoded neutral values
in the request dispatch - **passed everything**. Every render test called
`renderFulgoraTerrain` directly, so nothing exercised the request layer, and
both levers default to the one value that hides its own implementation
(frequency 1 makes the Voronoi grid exactly 175, so its truncation is a no-op;
size 1 makes `slider_rescale(size, 2)` exactly 1, so `fulgora_natural`'s scaling
term vanishes). A lever that silently does nothing is precisely what the request
layer can hide.

`test/fulgoraSurfaceSeed.spec.ts` now covers the dispatch: each lever is moved
OFF its default and required to change the image, omitting them is required to
equal passing the neutral pair, and the re-run plant fails both. **A plant that
passes is a coverage finding, not a clean bill of health.**

### The render was checked against the game's own tiles, not by eye

At 4 tiles/px the render looks mottled at a ~10-tile scale rather than showing
the big smooth islands Fulgora is known for, which reads as wrong. It is not.
Painting the 64x64 captured block from the GAME's own `get_tile` names beside
the port's resolution of the same points makes the two visually
indistinguishable - as the measured 99.86% agreement says they should be. The
fine structure is Fulgora's real coastline at that zoom, and the eyeball
impression was the thing that was wrong.

### Overlay fallback

Fulgora has no overlay ports at all - not resources, not cliffs, not rocks - so
every terrain-family view resolves to plain Fulgora terrain, the same fallback
the Vulcanus branch applies to the overlays it lacks. A view that asks for an
overlay this planet has no port for gets the terrain, never a Nauvis field
composited onto another planet's colours. The panel gates the toggles to match,
so no control is offered that would silently do nothing.

---

## Task 12: measured render cost

**~3.91 us/px**, at 1024x1024 and `tilesPerPixel` 1, min of 3 interleaved
iterations through `test/render-cost.perf.spec.ts`'s existing harness (seed
123456, origin (-512, -512)) - so it is comparable with the rows already
recorded there rather than being a fresh one-off measurement.

**The implementation plan estimated ~12 us/px. The measurement disagrees, and
favourably**: Fulgora is roughly 3x cheaper than estimated and the cheapest
planet in the table.

| render | us/px |
| --- | --- |
| **fulgora terrain (the only Fulgora view)** | **3.91** |
| nauvis terrain | 8.02 |
| vulcanus terrain | 14.94 |
| vulcanus resources (the default Vulcanus view) | 21.46 |

The reason is structural, not luck. Nauvis and Vulcanus each run a 19-to-21-tile
argmax per pixel over a catalog whose members are separate expression trees;
Fulgora resolves a 3-way class from ONE chain, and its four ocean probabilities
share every field they read. The chain's ~31 `basis_noise` octaves per pixel are
the whole cost.

Two things follow. **No profiling or optimisation was done, because the
prerequisite for doing any was not met** - the Vulcanus lesson (an un-memoized
DAG at ~81% of a CPU profile) prompted a `memoXY` audit, and every node in
`fulgoraShared`, `fulgoraCells` and `fulgoraElevation` is already wrapped. And a
512x512 preview costs about **1.0 s untiled**, so the existing 64-tile worker
pool has ample headroom; nothing here needs the tiling budget the plan reserved.

The row is now permanent in the perf spec rather than a number in this file, so
a future regression shows up in `pnpm perf` alongside the other planets.
