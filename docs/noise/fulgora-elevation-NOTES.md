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

**V1 (land/ocean split only): ~3.91 us/px (4104 ms min-of-3). V2 (this task,
full eight-way land argmax): ~4.78 us/px (5015 ms min-of-3)** - both at
1024x1024 and `tilesPerPixel` 1, min of 3 interleaved iterations through
`test/render-cost.perf.spec.ts`'s existing harness (seed 123456, origin
(-512, -512)), so the two numbers are directly comparable.

**Re-measured 2026-08-13 after Task 14's eight-way land argmax landed, all
four rows from the same run so the table is internally comparable** (do not
diff it against the historical 8.02/14.94/21.46 recorded here previously -
this file's own header warns that absolute ms drifts a few percent between
processes, and comparing across two different table snapshots would repeat
exactly the mistake it warns about):

| render | us/px |
| --- | --- |
| **fulgora terrain (the only Fulgora view)** | **4.78** |
| nauvis terrain | 7.58 |
| vulcanus terrain | 13.82 |
| vulcanus resources (the default Vulcanus view) | 20.23 |

Fulgora rose **22%** (3.91 -> 4.78 us/px) and is still the cheapest planet in
the table. The rise is real signal, not run-to-run noise: 22% is far past the
few-percent drift this harness's own header documents between processes.

**Why it rose, and why not more.** V1's land branch read three scalars
(`dunes`, `rock`, `mixOil`) and argmaxed them. V2 additionally evaluates
`roadDust`, `mesa`, `pyramids`, `sprawl` and the four `tileRuin*` fields (which
themselves pull in the whole masks/roads/ruins chain - two more Voronoi
tilings and one more multioctave field) at every LAND pixel. The ocean
early-out (`if (bestOcean > 0) return ...`) is unchanged, so pixels that hit it
pay nothing extra for any of this - which is why the whole-image average rose
22% rather than several-fold.

**The land share to use here is the benchmark WINDOW's, not the fixture's -
those are two different numbers and an earlier pass conflated them.** The
`oracle-fulgora-tiles` fixture is 2261/5057 = 44.7% land, but that fixture is
deliberately concentrated on the coastline (see its own provenance), so it
overstates how much of a real render is land. Measured directly on the actual
benchmark window (1024x1024 at origin (-512, -512), seed 123456, the same
window `test/render-cost.perf.spec.ts` times): **213,213 of 1,048,576 sampled
points are land - 20.3%.** So **79.7%** of the benchmark image never reaches
the new code at all, not "over half" as a fixture-share estimate would suggest.

**Land-only figure, measured directly rather than inferred from the average.**
`(-5872, 3088)` is land at `tpp: 1` (see `test/fulgoraExpressions.spec.ts`'s
hash-window comment: a 32x32 window there is 1024/1024 land, all eight tiles,
no ocean). That 100%-land property does NOT extend to the benchmark's
1024x1024 scale, though - Fulgora's islands are not that large. Measured from
the same origin at growing window sizes (same resolver, same seed): 32x32
100.0% land, 64x64 94.4%, 96x96 96.0%, 160x160 83.1%, 224x224 70.1%, and it
keeps falling to 26.5% by 1024x1024. A land-only window at the benchmark's own
size does not exist on this map, so the land-only figure below uses the
largest window that stays effectively pure land (96x96, 96.0% land, 9216
points) rather than 1024x1024.

Timed with the same methodology as the headline figure (min-of-N, interleaved
warm-up, `runRenderRequest` at `tpp: 1`, seed 123456), across three separate
process runs: the 96x96 land-core window measured **7.62, 7.88 and 7.86
us/px** (min-of-N per run, N from 9 to 21); the pure 32x32 100%-land window
measured 7.84-8.27 us/px but with a much wider spread (up to 2.19x) because
1024 points is a small timing sample. Two of the three runs also timed nauvis
terrain in the SAME interleaved run for a process-drift-free comparison: nauvis
came back at 7.44 and 7.65 us/px in those runs, against the land-core window's
7.88 and 7.86 - so **the land-only figure lands essentially on par with, and
slightly above, nauvis terrain (7.58 us/px on its own separately-recorded
row above), not below it.** A partially-diluted 160x160 window (83.1% land)
measured 7.39 us/px, consistent with land costing more than ocean and the mix
pulling the average down as the ocean share grows. All land-only figures stay
well under vulcanus terrain (13.82 us/px), so this is still not a regression
in the sense of moving Fulgora out of "cheapest planet" - it is a correction to
how close to nauvis a land-heavy Fulgora viewport actually runs.

**Step 2 (the plan's land-only-window escalation gate) is a no-op as measured,
but the gate itself cannot fire on this kind of change - that is a defect in
the plan, not just in how this task read it.** The plan
(`docs/superpowers/plans/2026-08-13-fulgora-v2-land-tiles.md` Task 6 Step 2)
calls for a land-only measurement only if the WHOLE-IMAGE average crosses ~12
us/px or rises over 3x. Because ~80% of the benchmark window early-outs at the
cheap ocean branch, the whole-image average is dominated by pixels the land
change cannot touch: with ocean at roughly 4 us/px (backed out from the 20.3%
land / 4.78 us/px average using the land-core figure above) and a land share
of 20.3%, the land cost would have to rise past roughly **40+ us/px - a
roughly 5x land-specific regression on top of what V2 already costs** - before
the blended average could cross 12 us/px at all. So the gate, written against
the whole-image average, structurally cannot fire from a land-side change of
the size this task or any plausible next one makes; only measuring the
land-only window directly (as done above) can catch a land-side regression.
This is not a one-off measurement error - the plan should not be read as
"passed" just because Step 2 read as a no-op.

The implementation plan estimated ~12 us/px for Fulgora terrain; even after
V2's land argmax the whole-image measurement is still **~2.5x cheaper than
estimated** - down from V1's ~3x margin, as expected now that the land side
does more work, but nowhere near erasing it. The land-only figure above (~7.9
us/px) is closer to that estimate, as expected of a land-concentrated window.

The reason Fulgora stays cheapest ON A WHOLE-IMAGE AVERAGE is structural, not
luck. Nauvis and Vulcanus each run a 19-to-21-tile argmax per pixel over a
catalog whose members are separate expression trees; Fulgora resolves a 3-way
ocean class from one shared chain, with the land argmax now paid only on the
~20% of pixels that reach it in a typical view. The chain's ~31 `basis_noise`
octaves per pixel were already the whole V1 cost, and remain most of the V2
cost too - but a land-heavy viewport (the land-only figure above) pays close
to nauvis's per-pixel cost, not Fulgora's whole-image average.

**No profiling or optimisation was done for V2, for the same reason as V1: the
prerequisite was not met.** A 22% rise is well inside what this port's
`memoXY` discipline already absorbs, and nothing here crosses a regression
gate that would justify a profiling pass - every node in `fulgoraRoads`,
`fulgoraRuins` and `fulgoraMasks` is wrapped the same way `fulgoraShared`,
`fulgoraCells` and `fulgoraElevation` were for V1. A 512x512 preview now costs
about **1.25 s untiled** (computed from the measured us/px, not separately
timed), against V1's ~1.0 s - still ample headroom under the existing 64-tile
worker pool.

The row is now permanent in the perf spec rather than a number in this file, so
a future regression shows up in `pnpm perf` alongside the other planets.

---

## Task 13: the road, structure and ruins layer (`fulgoraRoads.ts`, `fulgoraRuins.ts`, `fulgoraMasks.ts`)

Lua lines 250-292 (masks), 403-512 (road/structure), 383-402 + 539-578 (ruins).
Fixture: `test/fixtures/oracle-fulgora-ruins.seed123456.json`, the **same 101
positions** as the shared/cells/elevation fixtures. Spec:
`test/fulgoraExpressions.spec.ts`.

### Agreement with the game, per field

Worst |diff| at f32 over the 101 fixture positions:

| field | worst | bound |
| --- | --- | --- |
| `naturalMask`, `naturalAndMesaMask`, `artificialMask` | **0** | 0 |
| `roadCells`, `structureCells`, `roadPyramids`, `structureFacets` | **0** | 0 |
| `roadPavingThin`, `roadPaving2`, `roadPaving2b`, `roadPaving2c`, `roadDust` | **0** | 0 |
| `structureSubnoise` | 2.980e-7 | 4e-7 |
| `pyramidsBanding` | 9.54e-7 | 1.5e-6 |
| `spotsPrebanding` | 3.58e-6 | 5e-6 |
| `spotsBanding` | 3.64e-6 | 5e-6 |
| `ruinsPaving` | 2.384e-7 | 4e-7 |
| `ruinsWalls` | 3.874e-7 | 6e-7 |
| `tileRuinMachinery` | 3.800e-7 | 6e-7 |
| `tileRuinConduit` | 4.172e-7 | 6e-7 |
| `tileRuinPaving`, `tileRuinWalls` | 4.768e-7 | 7e-7 |

Twelve of the twenty-two fields are bit-exact by construction: the three masks
are comparisons/`max`/`min` over 0-or-1 booleans, `roadCells`/`structureCells`
are Voronoi cell IDs, `roadPyramids` is sampled at the raw undistorted
`(x, y)` so it never inherits the wobble-distortion error the rest of the
chain carries, and `structureFacets` plus the five `roadPaving*`/`roadDust`
fields built from comparisons of it are exact once `structureFacets` itself is
(see below). A non-zero residual on any of these twelve would mean a rounding
error had grown large enough to flip a comparison or to move a Voronoi cell
boundary - never slack to widen. The rest carry the port's known `basisNoise`
floor, scaled by each expression's own composition.

**`pyramidsBanding`'s scaling checks out exactly - not just "in the same
family," but arithmetically closed.** `pyramidsBanding` is `(cells.pyramids(x,
y) * 8) % 1`, and multiplying an f32 value by 8 (a power of two) is exact in
IEEE 754 - it cannot introduce new rounding, only scale existing error. Measured
directly: `cells.pyramids`' own worst residual is **1.1920928955078125e-7**
(exactly one f32 ULP near 1.0, matching the 1.19e-7 in the elevation table
above) and `pyramidsBanding`'s worst residual is **9.5367431640625e-7** -
**exactly 8x**, to the full float64 value, no rounding in the ratio at all.
Both worst cases land at the SAME fixture position (index 45 of 101), which is
what makes this a real decomposition rather than a coincidence of two
similarly-sized numbers: it is the identical underlying error, carried through
one exact multiply.

`spotsPrebanding` sits in the same `basisNoise`-floor family but does NOT
decompose as cleanly, and that distinction matters for anyone reading this as
"solved." `spotsPrebanding` is `min(spots, (1 - startingVaultCone) / 2) * 9 +
0.5`; if the `(1 - startingVaultCone) / 2` branch were always the `min()`
winner, the formula's own coefficients predict a `0.5 * 9 = 4.5x` scaling of
`startingVaultCone`'s residual. Measured: `startingVaultCone`'s worst residual
is **8.046627044677734e-7**, `spotsPrebanding`'s is **3.5762786865234375e-6**
- a ratio of **4.444...** (40/9), not 4.5: `startingVaultCone`'s residual times
4.5 is 3.6209821701049805e-6, about 1.3% above the actual figure. The worst
cases also land at DIFFERENT fixture positions (`startingVaultCone` at index
43, `spotsPrebanding` at index 47) - unlike `pyramidsBanding`'s matched index
45, so this is not the same error propagated through one clean multiply. Both
residuals are consistent with the shared `basisNoise` floor (neither is an
order of magnitude outside its siblings), but the exact multiplier is not
confirmed the way `pyramidsBanding`'s is - it is closer to a family
resemblance than a checked identity, and should not be cited as "4.5x" without
this caveat.

### Two f32 findings that needed OPPOSITE fixes

The noise machine evaluates its program f32 per operation, and this port hit
that twice in the road/structure layer, with two different symptoms and two
different remedies - conflating them would have fixed one and silently left
the other broken.

- **`structure_subnoise` samples at `x + 10000 * structure_cells`.** Computing
  the product in f64 and narrowing only where the coordinate crosses into
  `sumOctaves` measured 3.910e-5 - an order of magnitude above every sibling
  field. Narrowing the PRODUCT itself (`x + f32(10000 * structureCells(x,
  y))`) instead of the sum drops it to 2.980e-7, a **131x** improvement.
  Narrowing only the sum (what `sumOctaves`'s own #190 narrowing already does)
  leaves it at 3.910e-5 - no help.
- **`structure_cells` and `structure_facets` sample at `y * 0.8`.** Here
  narrowing the product (`f32(y * 0.8)`) buys **nothing** - still 7.629e-6.
  The defect is the constant itself: the engine's `0.8` literal is the f32
  value 0.80000001192092895508, and JavaScript's `0.8` literal is the f64
  value 0.80000000000000004441 - two different numbers. Narrowing the
  CONSTANT (`y * f32(0.8)`) instead of the product gives exactly **0**.
  Downstream, because `structureFacets` feeds `roadPaving2`/`2b`/`2c`/
  `roadDust` and all four `tileRuin*` fields, this one fix moved
  `tileRuinWalls` from 1.903e-5 to 4.768e-7 (**40x**), `tileRuinConduit` from
  9.95e-6 to 4.172e-7 (**24x**), and `tileRuinMachinery` from 1.21e-5 to
  3.800e-7 (**32x**) - none of which touch `structureSubnoise` or its own
  narrowing at all.

Same-looking symptom (an f32-sized residual on a field reading a scaled
coordinate), opposite fix (narrow the product vs. narrow the constant) - so
the next person chasing an f32 residual here should isolate which term is
wrong before reaching for whichever fix worked last time.

A residual landing at exactly 0 across all 101 positions is what confirms a
mechanism, not "it got smaller": `structureFacets` moving from 7.629e-6 to 0
is the same kind of evidence as `oilMask` and `cells` being exact elsewhere in
this file - a hypothesis that only shrinks a residual is still a hypothesis.

### The `%` sign convention - checked the OPERAND, not the modulo result; CLOSED by a wide sweep

`pyramidsBanding` is `(fulgora_pyramids * 8) % 1` and `spotsBanding` is
`spotsPrebanding % 1` - both JS `%`, whose sign follows the dividend the way
C's `fmod` does, unlike a flooring modulo (whose sign follows the divisor and
is never negative for a positive divisor). Which convention the game's engine
actually implements only matters if the LEFT operand can be negative; if it
can't, both conventions agree and the question is moot for that data.

**The operand is what has to be checked, not the modulo's output.** A modulo
result staying inside `[0, 1)` is consistent with either convention when the
operand is non-negative, but it is ALSO consistent with a flooring modulo fed
a negative operand - a flooring mod never leaves `[0, 1)` regardless of the
operand's sign, so an output-only check cannot rule that case out. Only the
pre-modulo value settles it.

Read directly:

- `fulgora_pyramids` in `test/fixtures/oracle-fulgora-cells.seed123456.json`
  (the same 101 positions): minimum 0.002752, so `* 8` gives a minimum of
  **0.02202** - strictly positive.
- `fulgora_spots_prebanding` in the ruins fixture, which IS the pre-modulo
  operand for `spotsBanding` directly: minimum **0.70791** - strictly
  positive.

So the `%` sign question does not arise at these 101 positions - not because it
was tested and passed, but because the operand it would depend on never went
negative in this sample. That alone left it open for the wider map.

**Closed by sweeping both operands directly, rather than at the 101 fixture
positions.** A one-off vitest spec swept `cells.pyramids(x, y) * 8` (the
`pyramidsBanding` operand) and `spotsPrebanding` (the `spotsBanding` operand)
over `x, y` in `[-20000, 20000]` at an irregular 137-tile stride (chosen so it
never aliases the 175-tile Voronoi grid), at three seeds (123456, 1, 999999) -
85,264 points per seed, 255,792 total:

| seed0 | min(`pyramids * 8`) | min(`spotsPrebanding`) | max(`startingVaultCone`) |
| --- | --- | --- | --- |
| 123456 | 1.907e-6 | 0.51037 | 0.51414 |
| 1 | 1.907e-6 | 0.52019 | 0.68475 |
| 999999 | 1.821e-5 | 0.51357 | 0.51741 |

Both operands stayed strictly positive at all 255,792 points, across three
seeds and a coordinate range far beyond any reachable map radius. **The sign
convention is not reachable in the shipped renderer**, not just absent from
this sample.

For `spotsPrebanding` this also has a construction-level proof, not just a
sweep. `spotsPrebanding = min(spots, (1 - startingVaultCone) / 2) * 9 + 0.5`.
`spots` is `voronoi_spot_noise`'s raw nearest-point distance (`searchAt(...).d1`
in `voronoiNoise.ts`, seeded at `Infinity` and only ever replaced by a
non-negative `distanceOf(...)` result), so `spots >= 0` always.
`startingVaultCone` is `max(0, 1 - dist / radius)` (`startingSpotAtAngle` in
`vulcanusShared.ts`), where `dist` is a Euclidean norm - so `dist / radius >=
0` and the cone is at most 1, achieved only exactly at the spot's centre; the
sweep's observed maxima (0.514-0.685) are consistent with a grid sample never
landing exactly there. So `(1 - startingVaultCone) / 2 >= 0` always, the `min`
of two non-negative numbers is non-negative, and `spotsPrebanding >= 0.5`
everywhere - the operand cannot go negative anywhere in the input space, not
just at the swept points. `pyramids * 8` has the analogous construction
argument (`pyramidNoise` is a distance-to-nearest-cell-boundary value, never
negative by definition of a distance) but was left as a pure sweep here since
no docblock in this port states that non-negativity as an invariant the way
`voronoiNoise.ts` documents `spotNoise`'s.

This corrects the method an earlier pass used: `fulgoraExpressions.spec.ts`'s
`makeFulgoraRoads` block used to state the question "did not arise" because
`fulgora_spots_prebanding` / `fulgora_pyramids_banding` "never go negative
(checked directly)" - but `fulgora_pyramids_banding` is the fixture's
POST-modulo result, not `pyramidsBanding`'s actual operand (`fulgora_pyramids
* 8`, which lives in a different fixture entirely and was never read by that
check). Checking a result array is not the same measurement as checking the
value that feeds the modulo, for the reason above. Both that comment and the
matching one in `test/oracle/capture.ts` now cite the operand instead - this
file exists specifically so that drift doesn't stand unremarked, see the file
header.

---

## Task 14: the eight-way land argmax

Fixture: `test/fixtures/oracle-fulgora-tiles.seed123456.json`, 5057 real
`surface.get_tile(x, y).name` results, 2261 of them land. Spec:
`test/fulgoraLandTiles.spec.ts`.

### 124 of 2261 land positions disagree (94.5%)

Measured by resolving all eight land tiles' `probability_expression`s against
each other (`makeFulgoraTileResolver`) and comparing to the game's own
`get_tile` name at every land position in the fixture: **124 mismatches, 2137
correct.** `fulgoraAgreement.spec.ts`'s land/ocean and shallow/deep counts are
unchanged at exactly 7 and 11 mismatches (of 5057 and 2796 respectively), so
this layer did not move the land/ocean boundary - it only changed which of the
eight tiles a land pixel gets painted.

Per game tile (matched / total):

| game tile | matched | total | rate |
| --- | --- | --- | --- |
| `fulgoran-walls` | 269 | 269 | 100.0% |
| `fulgoran-conduit` | 147 | 147 | 100.0% |
| `fulgoran-machinery` | 108 | 108 | 100.0% |
| `fulgoran-rock` | 478 | 493 | 97.0% |
| `fulgoran-paving` | 663 | 685 | 96.8% |
| `fulgoran-dust` | 201 | 224 | 89.7% |
| `fulgoran-sand` | 98 | 116 | 84.5% |
| `fulgoran-dunes` | 173 | 219 | 79.0% |

**Recall alone cannot clear a formula, and precision is what shows why.**
`fulgoran-walls`, `-conduit` and `-machinery` all recall 100%, which reads as a
clean result - but this port also names them at more positions than the game
does (300, 159 and 115 respectively against the game's 269, 147, 108), so
precision is 89.7%, 92.5% and 93.9%. Perfect recall with under-100% precision
is exactly the signature a uniformly-too-large probability would leave (it
keeps winning every position the game agrees on while also stealing a ring of
neighbours) - so recall by itself cannot distinguish "the formula is right"
from "the formula scores too high." See Task 15 for the check that actually
rules the second one out.

### The confusion pairs, so a regression arrives already localised

A bare count would pass with every miss piled onto one tile. The largest
pairs (game tile -> this port's tile, of 23 distinct pairs total, summing to
all 124 mismatches - full list in `test/fulgoraLandTiles.spec.ts`):

| pair | count |
| --- | --- |
| `fulgoran-dunes -> fulgoran-rock` | 25 |
| `fulgoran-sand -> fulgoran-rock` | 12 |
| `fulgoran-dunes -> fulgoran-walls` | 11 |
| `fulgoran-paving -> fulgoran-rock` | 11 |
| `fulgoran-dust -> fulgoran-rock` | 7 |
| `fulgoran-dust -> fulgoran-sand` | 6 |
| `fulgoran-dunes -> fulgoran-conduit` | 6 |
| `fulgoran-paving -> fulgoran-walls` | 6 |
| `fulgoran-rock -> fulgoran-walls` | 6 |

Every one of the three-tile argmax's confusion pairs (`dunes -> rock`, `sand ->
rock`, `rock -> dunes`, `dunes -> sand`) reappears here alongside new pairs
among the five tiles the three-tile argmax could not see at all.
`fulgoran-walls`, `-conduit` and `-machinery` never appear as the GAME side of
any pair - consistent with their 100% recall above.

### The mismatches are boundary-exclusive, at a stronger signal than V1's

121 of the 124 mismatches (97.6%) are Chebyshev-1 adjacent to a position this
resolver already classifies the way the game does, against a separately
measured base rate of 67.0% (1515/2261) for that same adjacency among all
scoped positions. `P(X >= 121 | n = 124, p = 0.6701) = 1.07e-17` (z is about
7.24, computed from that n and p) - a stronger signal than either the ocean
argmax's ~1e-10 or the three-tile argmax's 4.6e-12, because here both the
count and the fraction rose together as the tile count widened from three to
eight.

**That point-level tail assumes 124 independent samples, and the fixture does
not give it 124 independent samples** - the dense block is a contiguous
256x256 area at stride 4 (see the fixture's own provenance), so nearby
mismatches are spatially correlated rather than drawn independently; this repo
already has the general lesson on file (`below-chance needs a clustered
null`). Clustering the 124 mismatches at Chebyshev distance <= 8 (single-
linkage) gives **79 clusters** (57 singletons, 12 pairs, 5 triples, 3
quadruples, 2 clusters of 8). Of those 79, **76** have every member
individually meeting the Chebyshev-1 adjacency criterion above (the remaining
3 are mixed clusters where at least one member is not itself adjacent). The
cluster-level tail, `P(X >= 76 | n = 79, p = 0.6701) = 1.88e-10`, is the more
defensible number for a spatially clustered sample - eight orders of magnitude
less extreme than the point-level 1.07e-17, but still overwhelming. The
conclusion (this is a real, boundary-exclusive effect, not chance) does not
change; only the tail's precision does.

### The sub-tile sampling offset is refuted, again

A rival explanation - that the game samples tile autoplace at the tile centre
rather than the corner this port (and every Fulgora fixture) uses - was tested
across the whole 828-position three-tile fixture and loses on both metrics at
every offset tried:

| corner offset | land accuracy | land/ocean misses |
| --- | --- | --- |
| 0 (corner) | 783/828 (94.6%) | 18 (best) |
| +0.25 | 755/828 (91.2%) | 54 |
| +0.5 (centre) | 716/828 (86.5%) | 97 |
| -0.5 | 732/828 (88.4%) | 109 |

The corner wins on both the land argmax and the land/ocean split, at every
offset tried, so this is not a sampling-alignment defect. Recorded here so
nobody re-derives it a third time.

**This is the same open question as the ocean residual's 18 boundary-exclusive
mismatches** (Task 10 above) - something runs after the raw per-tile argmax,
at a land/ocean or land/land boundary, and this port does not model it. The
mechanism is unknown.

### A LEAD, not a finding: the tile prototypes' `layer` field correlates with the direction of every mismatch

The tile prototypes in `tiles-fulgora.lua` carry a `layer` field this port
never reads - it has nothing to do with `probability_expression` scoring, so
there was no reason to port it. Checked directly against the pinned file
(`~/GitHub/factorio-data/space-age/prototypes/tile/tiles-fulgora.lua`, values
unchanged across the ports' version range): `fulgoran-paving` 5,
`fulgoran-dust` 6, `fulgoran-dunes` 7, `fulgoran-sand` 8, `fulgoran-rock` 9,
`fulgoran-walls` 10, `fulgoran-conduit` 11, `fulgoran-machinery` 12, and on the
ocean side `oil-ocean-deep` 2, `oil-ocean-deep-2` 3, `oil-ocean-shallow-2` 3,
`oil-ocean-shallow` 4.

**Re-derived directly against the fixture and this port's own resolver
(`makeFulgoraTileResolver`), not transcribed:**

- **120 of the 124 land mismatches** have the GAME's placed tile at the
  LOWER `layer` than this port's resolved tile. Computed from the pinned
  23-pair confusion table in `test/fulgoraLandTiles.spec.ts` (each pair's
  `layer(game) < layer(ours)` checked by hand against the numbers above,
  cross-checked by re-running the actual resolver over all 2261 land
  positions) - both methods agree exactly at 120/124. **The four exceptions
  are all `fulgoran-rock`** (game, layer 9) matched against a LOWER-layer port
  pick: `fulgoran-dunes` (7) at (-1564, 912) and (-1592, 932), `fulgoran-paving`
  (5) at (-1456, 924) and (-1388, 1116) - all four coordinates confirmed by
  direct lookup, matching what was reported.
- **7 of 7 land/ocean mismatches** are the game placing `oil-ocean-shallow-2`
  (layer 3) where this port names a land tile (`fulgoran-rock` at five of the
  seven, `fulgoran-paving` at two) - `layer(game)=3` is below every land
  tile's layer (minimum 5), so "game-lower" holds unconditionally for this
  direction, not just as a majority.
- **8 of 11 shallow/deep mismatches** are the game placing `oil-ocean-deep`
  (layer 2, confirmed - none of the eight are the `oil-ocean-deep-2` variant)
  where this port resolves `shallow` (layer 3 or 4 depending on variant,
  either way above 2) - game-lower again. The remaining 3 run the other way
  (game places a shallow variant, layer 3 or 4; this port resolves `deep`,
  layer 2) - `oil-ocean-shallow` at (-1480, 952), `oil-ocean-shallow-2` at
  (-1428, 984) and (400, -400) - and in these `layer(ours) < layer(game)`, so
  they are genuine exceptions to the pattern, not just unclassified.

135 of 142 mismatches across all three residuals follow the same direction:
**the game favours the lower-`layer` tile at a disputed boundary.**

**Against a base rate, this is not close to chance, however the null is
framed - checked two ways, both far below 96.8-100%:**

- Over all 2261 land positions, comparing each position's own top-scoring
  (`winner`) tile against its runner-up (second-highest-scoring) tile in this
  port's own argmax: the winner is the LOWER-layer tile in **1347/2261 =
  59.6%** of positions. This port's argmax has no reference to `layer` at
  all, so this is a measure of how often layer and score happen to agree by
  construction, not a designed base rate.
- Over every Chebyshev-1-adjacent pair of land positions whose port-resolved
  tiles differ (4536 ordered pairs, land tiles only): the centre position's
  tile is the lower-layer one in 2266/4536 = **50.0%**, which is a
  mathematical necessity of counting ordered pairs symmetrically (every
  differing unordered pair contributes one "lower" and one "higher" instance)
  and is not informative as a null by itself - recorded so nobody re-derives
  it expecting a real signal.

Neither measured base rate came out near a previously-reported 0.52 - this
entry does not carry that number forward, because it could not be
independently reproduced by any base-rate construction tried. What both checks
agree on is that a same-direction rate at or above 96.8% (120/124, and 7/7 and
8/11 above) is far outside a chance range under 60%, whichever of the two
nulls above is used.

**Record this as a LEAD, not a finding.** `layer` is not read anywhere in this
port, and nothing here demonstrates that `layer` is itself the mechanism - it
may just be a PROXY, since it correlates closely with the natural-vs-artificial
grouping (`fulgoran-dust`/`-dunes`/`-sand`/`-rock` are the low layers 6-9,
`fulgoran-walls`/`-conduit`/`-machinery` the high layers 10-12, `paving`
lowest at 5) that already runs through every formula here via
`naturalAndMesaMask`/`artificialMask`. The margins are NOT near-ties either
(median 0.28 across the 124 land mismatches, 22 of 124 above 1.0, max 2.80),
so a simple epsilon tie-break on `layer` would not close the residual by
itself; combined with the 121/124 boundary-adjacency finding above, the shape
that fits is a boundary REWRITE pass after the raw argmax, where the
lower-`layer` tile wins the replacement at a disputed edge - not a different
scoring formula. If someone picks this mechanism up, testing whether `layer`
(or the natural/artificial grouping it tracks) drives a literal post-argmax
boundary-smoothing pass is the first thing to try.

---

## Task 15: the placed tile is not always the argmax of the declared probability expressions

**Headline finding.** Two independent counter-examples establish that
highest-value-wins over the `probability_expression`s, transcribed verbatim
from `tiles-fulgora.lua`, is not the whole selection rule - and neither is a
port defect, because both were checked against the game's own evaluation of
its own formulas, not inferred from this port's arithmetic.

**1. The three-tile case (Task 1).** At `(-1628, 872)` the game's own
`fulgoran-rock` formula scores **2.2537**, above `fulgoran-dunes`'s **1.6149**
- and `get_tile` there is `fulgoran-dunes` anyway. Those two scores were
reconstructed by sampling the named sub-expressions (`fulgora_rock`,
`fulgora_dunes`, `fulgora_mix_oil`) directly from a live Fulgora surface and
applying the tile formula, not inferred.

**2. The ruins case (Task 14), stronger because it needs no reconstruction.**
`fulgora_tile_ruin_walls` is itself a NAMED expression, so the game reports it
directly - no formula has to be applied on this port's side at all. Sampled at
all four `fulgoran-dunes -> fulgoran-walls` mismatches, 2.1.14, seed 123456:

| position | `fulgora_tile_ruin_walls` (game) | `1 + fulgora_dunes` (game) | game places |
| --- | --- | --- | --- |
| (-1420, 892) | 1.868947 | 1.523166 | `fulgoran-dunes` |
| (-1404, 920) | 1.552315 | 1.476634 | `fulgoran-dunes` |
| (-1428, 1032) | 1.453150 | 1.332996 | `fulgoran-dunes` |
| (-1420, 1044) | 1.526603 | 1.210111 | `fulgoran-dunes` |

The game's own walls expression outscores its own dunes expression at all four
positions, and `get_tile` is `fulgoran-dunes` at all four anyway.

**This directly refutes the inflated-probability hypothesis that Task 14's
precision numbers could only raise, not settle.** The margins the game reports
here - 0.3458, 0.0757, 0.1202, 0.3165 - match this port's own margins at those
same four positions to four decimal places. If `tileRuinWalls` were uniformly
too large (the mechanism that would explain walls' 89.7% precision on its
own), this port's margin would exceed the game's; it does not. So the
over-placement Task 14 measured is not this port scoring `tileRuinWalls` too
high - the same post-argmax mechanism is at work here as in the three-tile
case, on a completely different tile pair.

**The mechanism is unknown, and it is the same open question the ocean
residual and the three-tile residual already raised** - not a new defect and
not one this task closes. What is established: it runs after the raw per-tile
argmax, it is boundary-concentrated (Task 14), and a tile-centre sampling
offset is refuted as its cause (Task 14). Reverse-engineering the post-argmax
pass itself is future work.
