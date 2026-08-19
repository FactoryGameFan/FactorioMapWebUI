# Vulcanus resources (V2)

Ports the four Vulcanus solid/fluid resource region fields
(`vulcanus_tungsten_ore_region`, `vulcanus_coal_region`, `vulcanus_calcite_region`,
`vulcanus_sulfuric_acid_region` / `_region_patchy`) and the near-spawn starting
spots that feed them, plus a resource overlay (`view: "resources"` on a Vulcanus
preset) for the three solid ores. This is the layer that restores the three
resource-coupling terms V1 had approximated away in the tile catalog
(`docs/noise/vulcanus-tiles-NOTES.md`).

## Source lines

`~/GitHub/factorio-data` tag `2.1.11`:

- `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` (~560-862) - the
  starting spots, favorabilities, `vulcanus_spot_noise` wrapper, the three
  `place_*_spots` functions, the four `*_region` expressions, the sulfuric-acid
  patchy chain, and `vulcanus_ore_dist`.
- `space-age/prototypes/tile/tiles-vulcanus.lua`:
  - `~197` - `vulcanus_metal_tile = max(0, vulcanus_tungsten_ore_probability)`.
  - `~208-229` - `lava_basalts_range` / `lava_hot_basalts_range`, the two sites
    that read `vulcanus_metal_tile` inside `min(..., 100 * (1 - metal_tile))`.
  - `~244-259` - `volcanic_cracks_warm_range` / `volcanic_smooth_stone_warm_range`,
    the two sites with the `+ 50000 * vulcanus_metal_tile` boost term.
  - `~293-296` - `volcanic_jagged_ground_range`, which reads
    `vulcanus_calcite_region` inside its outer `max`.
  - `~370-373` - `volcanic_soil_light_range`, which reads
    `vulcanus_sulfuric_acid_region_patchy` inside its outer `max`.

## Per-resource parameters

All four resources share the `vulcanus_spot_noise` wrapper (`makeSpotNoise` in
`src/noise/expressions/vulcanusResources.ts`), which samples at the
`(resource_wobble_x, resource_wobble_y)`-shifted coordinate, culls to a 128-tile
cone radius (`MAX_SPOT_BASEMENT_RADIUS`), and caches accepted spots per
128-tile-modulus region (`selectSpots`, `skip_span = 3`).

| Resource | `seed1` | candidate count | skip offset | `region_size` base | favorability | `place_*` wrapper |
|---|---|---|---|---|---|---|
| tungsten-ore | 789 | 15 | 2 | 500 | `basaltsFavorability` | `placeMetalSpots` (adds the hairline-cracks term) |
| coal | 782349 | 12 | 1 | 400 | `ashlandsFavorability` | `placeNonMetalSpots` |
| calcite | 749 | 12 | 1 | 400 | `mountainsFavorability` | `placeNonMetalSpots` |
| sulfuric-acid geyser | 759 | 9 | 0 | 450 | `mountainsSulfurFavorability` | `placeSulfurSpots` |

`region_size` in the source is `base + base/control:<x>:frequency` (e.g.
tungsten is `500 + 500/f`); at the default frequency (`f = 1`) this is exactly
`2 * base`, an integer. See "Known gaps" #1 below for the fractional case.

Each resource's `size` expression is the same shape:
`slider_rescale(control:<x>:size, 2) * min(1.2, vulcanus_ore_dist) * 25`, which
feeds both the spot-noise `quantity` (`size^2`) and `radius` (`size`) params.
Radius therefore tops out at `2 * 1.2 * 25 = 60` tiles, well under the 128-tile
cone-cull radius and the game's `maximum_spot_basement_radius` (128) - so that
cap is provably unreachable here and is deliberately not implemented (see
"Known gaps" #3).

Each `*_region` is `max(starting_<ore>, min(1 - starting_circle, place_*(...)))`
- the near-spawn guaranteed spot wins outright, and the placed field is clamped
out entirely inside the starting-area circle.

## The two approximations

1. **`random_penalty_between(0.9, 1, 1)` -> `1`.** It appears in every
   `*_probability` expression (the one actually consumed by
   `entity:<x>:probability`, not the `*_region` fields the tile catalog and
   overlay read). `random_penalty` is a batch op whose value depends on the
   whole batch and its evaluation order (`docs/noise/random-penalty-NOTES.md`),
   so a per-pixel renderer cannot reproduce it. At `rp = 1` the probability
   collapses to `1000 * region`, which is what `vulcanus_metal_tile` (the one
   place this approximation reaches terrain) computes.

   This is a stronger approximation than the design spec originally
   characterized it as. Measured against the 1085-point oracle fixture
   (`test/fixtures/oracle-vulcanus-resources.seed123456.json`):
   `vulcanus_metal_tile` diverges from `max(0, 1000 * region)` by up to
   **132.86** (fixture index 341: region 0.4387, our approximation 438.70,
   oracle 305.84). At small regions the penalty flips placement outright -
   fixture indices 733 and 769 have `region > 0` but the oracle's
   `metal_tile == 0`. The implied `p` (the sampled `random_penalty` value)
   over the eight fixture points with `region > 0` spans **[0.9077, 0.9748]**,
   comfortably inside the game's documented `[0.9, 1]` envelope. And that
   envelope holds with **zero violations across all 1085 fixture points** - `rp
   = 1` is a genuine **upper bound**: `1000 * region` is always `>=` the
   game's actual `metal_tile`, so our footprint is the largest the game could
   ever produce, never smaller. This is why
   `test/vulcanusResources.spec.ts`'s `metalTile` test asserts an envelope
   (`lo <= got <= hi` for `rp` in `[0.9, 1]`) rather than a numeric tolerance -
   a tolerance check would be meaningless against a value that swings by over
   100 depending on batch composition.

2. **Richness is not ported.** The preview renders placement (where ore is),
   not yield (how much). This matches the M3a/M3b Nauvis resource port, which
   made the same call.

## Measured oracle residuals (worst absolute, over all 1085 fixture points)

From `test/vulcanusResources.spec.ts`'s comment block and the Task 3/4 reports:

| Expression | Worst \|delta\| |
|---|---|
| `basaltsFavorability` | 2.42e-5 |
| `mountainsFavorability` | 2.71e-4 |
| `mountainsSulfurFavorability` | 2.71e-4 |
| `ashlandsFavorability` | 1.43e-4 |
| `startingTungsten` | 3.13e-4 |
| `startingCoal` | 1.90e-4 |
| `startingCalcite` | 3.00e-4 |
| `startingSulfur` | 3.21e-4 |
| `tungstenRegion` | 1.79e-5 |
| `coalRegion` | 2.89e-5 |
| `calciteRegion` | 1.66e-4 |
| `sulfuricAcidRegion` | 1.63e-4 |
| `sulfuricAcidPatches` | 2.92e-3 (see the anomaly writeup below) |
| `sulfuricAcidRegionPatchy` | 3.93e-4 |
| `metalTile` | not a tolerance check - see the `rp` envelope above |

All but `sulfuricAcidPatches` sit in the same 1e-5 to 3e-4 f32-rounding band as
every other Vulcanus expression ported so far (biomes, spawn, cracks, helpers).

## The `sulfuricAcidPatches` anomaly and its resolution

Worst residual **2.92e-3**, roughly 10x every other expression in this task -
the one number that raised an eyebrow, since it sits above the "1e-6 to 1e-3"
f32 guideline (though nowhere near the ~1e-2 "something is actually wrong"
threshold).

`sulfuricAcidPatches = 0.8 * abs(multioctave_noise{seed1: 21000, octaves: 2,
persistence: 0.7, input_scale: 1/3, output_scale: 1})`. `abs()` is 1-Lipschitz,
so it cannot amplify an absolute residual - the raw error has to live inside
the `multioctave_noise` call itself.

Resolved by splitting the fixture on coordinate representability: the fixture
is a 36-point near grid + 3 rings of 8 (irrational coordinates, e.g.
`354.0533905932738`) + a 1024-point dense scan grid (integer-ish coordinates).
Over the **1063 exactly-representable positions** (including all 1024
dense-grid points) the worst residual is **1.69e-4** - in family with every
other expression above. **All top-10 residuals are among the 22 ring
positions with irrational coordinates**, with an implied positional offset of
2.3e-3 to 3.7e-3 tiles (i.e. the game evaluated at a marginally different
point than we did).

**SOLVED 2026-08-18, and the mechanism guessed here was wrong.** The offset was
real and its size was right, but it is not a float-representation difference.
The parenthetical used to read "most likely because a ring position's exact
float representation differs by a ULP or two through the coordinate's
construction path". At `354.0533905932738` one f32 ulp is **3.052e-5** and one
f64 ulp is **5.684e-14**, against a measured displacement of **2.609e-3** -
86x and 4.6e10x too large. No accumulation of ulps gets there.

The real mechanism is that Factorio's `MapPosition` is fixed point, `int32 /
256`, so every coordinate is truncated toward zero on the way in. The capture
built these rings as `r * Math.cos(a) + 0.5`, which is not a multiple of 1/256,
so the game sampled a snapped point and the fixture recorded the unsnapped one
(#186). That is also why every measured displacement falls inside
`[0, 1/256) = [0, 3.906e-3)` - the range truncation produces and nothing else
does, and the range this note already reported without noticing what it meant.

Snapping the sample coordinate at read time (`test/captureGrid.ts`) takes
`sulfuric_acid_patches` from **2.942e-3 to 7.153e-8, a factor of 41,100**, and
for 13 of the 14 arrays in this fixture the post-snap worst now equals the
on-grid-only worst exactly - the off-grid excess is gone rather than reduced.
Seventeen committed fixtures were affected; all 17 improved and none got worse.

Note what this does NOT overturn: the `input_scale = 1/3` argument below is
still why this expression showed it most clearly. A higher-frequency field
amplifies a fixed positional mismatch, which is exactly why an error common to
seventeen fixtures surfaced here first and at 2.9e-3 rather than 1e-4.

`input_scale = 1/3` makes this the **highest-frequency multioctave anywhere in
this port** - about 1.7x outside the primitive's oracle-verified envelope
(`multioctaveNoise.ts`'s own oracle coverage tops out at `input_scale = 0.2`).
A higher-frequency noise field amplifies a fixed positional mismatch more, so
a tiny offset that is invisible at `input_scale <= 0.2` shows up here.

Model error was explicitly ruled out: f32-rounding the composed octave
coordinates before evaluating moves the value only ~1e-4, not the observed
~3.6e-3 raw error, and the local gradient at the outlier points is
unremarkable (0.94 vs. a 0.50 median) - not a discontinuity or a sign flip.
The test bound (3.5e-3) stays set to cover the full fixture including the
ring positions, not just the clean-coordinate subset.

## `get_tile` parity: 369/381 (96.85%) before, 374/381 (98.16%) after

Restoring the three coupling terms into `vulcanusCatalog.ts` fixed 5 of the 12
mismatches recorded at V1's ship (`docs/noise/vulcanus-tiles-NOTES.md`,
tile-name oracle `test/fixtures/oracle-vulcanus-tile-names.seed123456.json`).
`test/vulcanusTiles.spec.ts`'s floor was raised from `0.95` to `0.978`.

The 7 that remain all sit where `metalTile`/`calciteRegion`/
`sulfuricAcidRegionPatchy` read their **no-patch floor** - `metalTile ~= 0`,
`calciteRegion ~= -1`, `sulfuricAcidRegionPatchy ~= -1` - at every one of the 7
positions. None of the restored coupling terms are active there. The
mismatches sit at radii 192-2079 from spawn, are adjacent-tile flips within
one biome family (e.g. at (320, 0): `cracks-warm 4.4029` vs.
`smooth-stone-warm 4.3087`, a 0.09 margin), and show no clustering by tile or
region. This is the same pre-existing far-field f32 argmax-boundary floor
already documented for V1 elevation/aux/moisture, now with the resource terms
positively ruled out as a contributing cause (checked point-by-point, not
inferred).

**This contradicts the design spec's original prediction** that the residual
would sit at ore-patch edges, caused by the `random_penalty` approximation's
cap. The cap described above is real in principle (the game's `metal_tile` can
differ from our approximation by over 100 units near a patch), but empirically
it is not what causes any of these 7 remaining mismatches - all 7 have
`region <= 0` (no patch present at all), so the `rp` approximation is not even
in play there.

## Planet surface seeds: the map seed is NOT the Vulcanus seed

Found 2026-07-25, chasing "the client Vulcanus terrain looks nothing like the
headless preview". It was not a V2 regression and not a porting error - the
port was being handed the wrong seed.

**The rule.** A planet's surface is generated at
`(mapSeed + planet.map_seed_offset) mod 2^32`. Nauvis declares
`map_seed_offset = 0` (`base/prototypes/planet/planet.lua`), which is the only
reason "the map seed" and "the surface seed" are the same number there. Every
other planet leaves the field unset, and the engine defaults it to
**`crc32(planet.name)`** (zlib/ANSI polynomial - the same CRC the map-exchange
codec already implements in `src/codec/crc32.ts`).

Measured from Factorio 2.1.12 headless: create a save with Space Age at a known
`--map-gen-seed`, then read
`game.planets[name].create_surface().map_gen_settings.seed` back **without**
overwriting it.

| planet | offset | surface seed at map seed 123456 |
| --- | --- | --- |
| nauvis | 0 | 123456 |
| vulcanus | 1249812791 | 1249936247 |
| gleba | 3215082971 | 3215206427 |
| fulgora | 2967579010 | 2967702466 |
| aquilo | 3111799872 | 3111923328 |

Sampled at map seeds 0, 1, 2, 3, 123456, 123457, 1000000 and 2801636144; the
last wraps 2^32 for every non-Nauvis planet and pins the modulo.

**How the mechanism and the hash were identified** (measured, not inferred):

- Setting `data.raw.planet.vulcanus.map_seed_offset = 12345` in a probe mod
  made the surface seed at map seed 0 come back as exactly `12345` - so the
  prototype field is the mechanism, and the observed values are engine defaults.
- Registering two planets that were deep copies of Vulcanus differing **only**
  in name (`aaa`, `aab`) produced unrelated offsets (4027020077, 1762534039),
  ruling out registration order or an index and pinning the default to a hash
  of the name.
- `crc32(name)` then reproduced all seven measured planets exactly - the four
  Space Age ones plus the three custom clones.

**Durability.** Because the offset is a hash of the name, and planet names are
public prototype API, the values are pinned by the names rather than by a build
- `src/model/planetSurfaceSeed.ts` computes them instead of hardcoding, and
gets modded planets right for free. A future Factorio release changing how the
default is derived is still possible; the measured rows in
`test/planetSurfaceSeed.spec.ts` are the tripwire.

### What was actually wrong, and what it cost

`ElevationPreviewPanel.vue` passed `store.previewSeed()` straight through as
`seed0` for every planet, so the Vulcanus preview rendered a world no player
could ever land on. Nauvis was never affected (offset 0).

Three-way measurement at map seed 123456, over the 172 of the 381 fixture
positions that fall inside a 1024 px origin-centred render:

| comparison | agreement |
| --- | --- |
| `--generate-map-preview --map-preview-planet vulcanus` vs the **natural** (derived-seed) `get_tile` | 154/172 = 89.5% |
| the same preview vs the **forced**-seed-123456 fixture | 20/172 = 11.6% |
| TS tile resolver at seed 1249936247 vs natural `get_tile` (381 pts) | 368/381 = 96.59% |
| TS tile resolver at seed 123456 vs natural `get_tile` (381 pts) | 37/381 = 9.71% |

So `--generate-map-preview` was right the whole time; the app was the outlier.
Two things had disguised this:

- The `get_tile` oracle path **forces** the surface seed
  (`buildSpaceAgeTileControlLua` writes `mgs.seed = <mapSeed>`), so
  `test/fixtures/oracle-vulcanus-tile-names.seed123456.json` describes a
  synthetic surface that no save produces. It is still perfectly good as a
  validation of the expression port - it just cannot see the seed plumbing.
- The client agreed with the repo's own resolver at 172/172, and the resolver
  agreed with that fixture at 97.7%, so every internal check passed. Only a
  comparison against something outside both - a real save - could catch it.

The 10.5% residual in the first row is the same near-tie boundary floor
documented above plus cliff/rock pixels, which have no Vulcanus port.

**Whole-frame confirmation after the fix.** `runRenderRequest` at
`planet: "vulcanus"`, `view: "terrain"`, 1024x1024, 1 tile/px, origin-centred,
seeded through `surfaceSeedForPlanet("vulcanus", 123456)`, diffed pixel-for-
pixel against `factorio --generate-map-preview --map-preview-planet vulcanus
--map-gen-seed 123456 --map-preview-size 1024`:

- **87.61%** of all 1,048,576 pixels match exactly.
- Cliff and rock pixels are 11.34% of the preview and account for **91.52%** of
  every remaining mismatch.
- Excluding them: **98.82%** exact match.

Before the fix the same comparison scored about 11.6%. Nothing about the
expression port changed - only the seed handed to it.

**The guard against a repeat** is
`test/fixtures/oracle-vulcanus-tile-names.natural-mapseed123456.json` +
`test/vulcanusNaturalSeed.spec.ts`: a fixture captured from a save at
`--map-gen-seed 123456` with the surface seed **left alone**, asked for through
`surfaceSeedForPlanet` rather than a literal. It also asserts the failure mode
(the raw map seed must score under 20%), so it cannot quietly pass on a fixture
that turned out to be seed-insensitive.

## Known gaps and deliberate omissions

1. **Non-default frequency sliders give a fractional `region_size`.** The
   source's `region_size = base + base/control:<x>:frequency` is an integer
   only at `f = 1`; `selectSpots` uses `region_size` as an integer modulus, so
   the port floors it (`Math.floor(p.regionSize)`,
   `src/noise/expressions/vulcanusResources.ts` inside `makeSpotNoise`). Only
   `f = 1` is oracle-covered. **This is the first thing to check if a
   non-default-frequency Vulcanus resource preset renders wrong** - the
   flooring is a real, untested approximation, not a proven-safe simplification
   like #3 below.
2. **Near-spawn starting ore patches are unverified.** No fixture point has a
   `starting_*` value above about -0.5 (the closest ring point is still well
   outside any starting spot's radius), so the "inside the spot" regime - where
   `startingSpotAtAngle` returns a strongly positive value - is untested by the
   oracle. Judged acceptable because `startingSpotAtAngle` is a single
   branch-free linear-in-distance expression, already pinned by 1085 points
   spanning roughly -700 to -0.5, and its shape (linear ramp, no clamps beyond
   the caller's own `max`/`min`) does not admit hidden branches that only
   activate near zero.
3. **The `min(maximum_spot_basement_radius, radius)` cap is deliberately
   omitted.** Every Vulcanus resource's radius is
   `sliderRescale(v, 2) * min(1.2, oreDist) * 25`. `sliderRescale` itself is
   NOT bounded (`2^(log2(v)/log2(6)*log2(n))` is unbounded for an arbitrary
   `v`) - it stays `<= 2` here only because the `size` slider's own range is
   bounded to `[1/6, 6]`, so `radius <= 2 * 1.2 * 25 = 60`, always under
   `MAX_SPOT_BASEMENT_RADIUS` (128) for every reachable UI state. This does
   NOT hold for a `size` value outside the slider's range that only an
   imported map-exchange string can carry (e.g. `size = 100` gives radius
   ~178 > 128, where the game's cap would bind and this port's would not) -
   do not "fix" this by adding the cap defensively for the slider-reachable
   range; it would be dead code there.
4. **CLOSED 2026-07-27 (Task 7): the sulfuric-acid geyser rolls.** ~~It renders
   as a patch blob, not as geysers.~~ V3 shipped it (2026-07-26) as a fourth
   `VULCANUS_RESOURCE_CATALOG` entry drawing `sulfuricAcidRegionPatchy > 0` in
   the geyser's `map_color` `[199, 199, 26]` - the region where the game would
   *roll* for a geyser, not where geysers are.

   V2's note that "V3 is mostly renderer work" was wrong, and the correction is
   worth keeping. The field math was indeed done, but the placement rule
   (`planet-vulcanus-map-gen.lua:849`) is

   ```
   probability = (control:sulfuric_acid_geyser:size > 0)
               * 0.025 * ((patchy > 0) + 2 * patchy)
   ```

   There is no threshold that produces a footprint the way `1000 * region` does
   for the three solid ores - every geyser in-game comes from a per-tile RNG
   roll against that probability. The entry now carries
   `placement: "roll"` and `renderVulcanusResources` draws it through
   `makePlacementSet` with the lava tile gate and a 2.8 x 2.8 collision box,
   painting a 3x3 mark per placement. Density is validated against the real game
   in `test/entityDensity.spec.ts` (oracle region 4: 56 against the game's 56;
   the other two Vulcanus regions have no sulfur and both sides are 0). See
   `docs/noise/placement-roll-NOTES.md` for the prototype data and the gate-by-
   gate measurement. Nauvis crude oil, the last overlay issue #9 named, followed
   in Task 8.

   Two things about the OLD blob that were easy to misread, kept because the
   second is exactly what the roll fixed:

   - **It was much smaller than the sulfur spot.** `patchy > 0` requires
     `(1 + region) * (0.5 + 0.5 * patches) > 1`, so it needs `region` well
     above 0 - only the core of a spot, not its full cone. A window holding
     500+ geyser pixels can hold zero of the three ores.
   - **The blob's area was not the geysers' area.** Inside it the game places
     geysers on a few percent of tiles, and each occupies ~3x3. Reading the blob
     as "this much ground is geyser" overstated it by **4.2x**.

   **Two numbers this file carried, both reasoned rather than measured, both
   wrong:**

   - The probability does not "peak near 0.065". That bound assumed
     `region <= 1`, and `vulcanus_sulfuric_acid_region` is a `max` against
     `vulcanus_starting_sulfur`, which is uncapped. Measured over +/-3000 tiles
     at seed 123456: **0.0883** at (2481, -1985).
   - The blob did not overstate the geysers' area "by more than an order of
     magnitude" - that came from multiplying the *pre-collision* roll rate by
     ~9 tiles, and collision rejects most of those hits. Aggregating the shipped
     predicate over +/-2000 tiles on a 2-tile grid: 371 placements at the
     collision box's 2.8 x 2.8 = 7.84 tiles each, against 12130 sampled
     footprint tiles - **0.240, i.e. 4.2x**. The same ratio measured on rendered
     pixels reads 0.24-0.27, because the 3x3 mark inflates the placements by
     about the factor the tile sampling deflates them by; that agreement is
     arithmetic, not corroboration.

   That makes four numbers in this subsystem (with the two the placement-roll
   notes record) that were derived on paper and did not survive measurement.
   **The pattern is the finding**, not any one of them: a bound assembled from
   other bounds inherits every unstated assumption in them, and this file has
   yet to produce one that held.
5. **Cliffs and rocks now both render** (2026-07-26) - this gap is closed as a
   missing-layer gap, though neither is entity-exact. Together they were about
   16.8% of a headless Vulcanus preview's pixels: the tan speckle, `144,119,87`
   (`CLIFF_MAP_COLOR`) and `129,105,78` (`ROCK_MAP_COLOR`). See
   `docs/noise/vulcanus-cliffs-NOTES.md` and
   `docs/noise/vulcanus-rocks-NOTES.md` for what each does and does not prove -
   in particular neither has been checked against a real `find_entities` dump,
   and the rock overlay is a threshold on a plateau-shaped probability field
   rather than a placement.

## `spotSelection.ts` needed no change

Driving Factorio's favorability-sorted trim with a **discriminating 0/1
favorability** for the first time (`p.favor(x, y) > 0.9 ? 1 : 0` - Nauvis's M3
resource port always passes a constant `1`) exposed no bug in that shared
primitive. All 15 `vulcanusResources.spec.ts` tests passed on the first
implementation attempt with no debugging needed in `spotSelection.ts` or
`spotCandidates.ts` (Task 4 report).

## Performance

The V1 baseline (recorded in `docs/noise/client-preview-ROADMAP.md`) is
**~12 us/px** for Vulcanus terrain (post-`memoXY` fix, ~1.4x the Nauvis
terrain cost of ~8 us/px). V2 restored three resource-coupling terms into the
tile catalog (`vulcanusCatalog.ts`), so terrain now evaluates the four ore
region fields (and their upstream favorabilities/starting spots/spot-noise
search) on **every terrain pixel, even with the resource overlay switched
off** - this is the regression risk the task-8 perf gate exists to catch.

Measured with `FMW_PERF=1 pnpm perf` (`test/render-cost.perf.spec.ts`'s new
"vulcanus terrain (V1 tiles + V2 coupling)" case, 1024x1024 @ 1 tile/px, seed
123456, median of 3), before (a `git worktree` checked out at `a0ea049`, the
commit immediately before this V2 branch started, sharing this checkout's
`node_modules` via symlink since the lockfile is unchanged between the two
points) and after (this branch):

| | before (V1, `a0ea049`) | after (V2, this branch) | ratio |
|---|---|---|---|
| Vulcanus terrain, total | 12,497 ms | 14,062 ms | 1.13x |
| Vulcanus terrain, per pixel | 11.92 us/px | 13.41 us/px | 1.13x |

The before number (11.92 us/px) lands almost exactly on the ~12 us/px V1
figure already recorded in `docs/noise/client-preview-ROADMAP.md`, confirming
the worktree measurement is a fair reproduction of that baseline despite
running on a possibly busier machine than the original measurement.

**Gate verdict: PASS.** A ~1.13x increase is well inside the task-8 brief's
~2x regression gate. This matches expectations: V2 adds a small, bounded
amount of per-pixel work (the four region fields plus their upstream
favorabilities/starting spots) on top of an already-`memoXY`-memoized ~200-eval
floor per pixel - not a new O(N) or unmemoized hot path. None of the three
"first suspects" the task-8 brief listed (a thrashing per-region `selectSpots`
cache, a missing `memoXY` on a `place_*` wrapper, or an oversized 3x3 region
scan) needed investigating, since the measured regression never approached the
gate.

**Correction (final-fix pass, 2026-07-24): "vulcanus terrain" above is NOT the
view non-dev users actually get.** Task 7 made `resources` the default
Vulcanus view (`ElevationPreviewPanel.vue`'s `effectiveView` returns
`"resources"` for Vulcanus unless dev mode is on and the user has explicitly
picked `"terrain"`). `renderVulcanusResources` builds its own, independent
Vulcanus field stack (helpers/spawn/cracks/biomes/resources) rather than
reusing the terrain render's - so on the default path the ore DAG and its
upstream (favorabilities, starting spots, spot-noise search) run **twice** per
pixel, once for the terrain paint and once for the resource overlay. The
table above only measured the terrain-only path, understating the cost users
actually pay.

Re-measured with the same harness, now including `test/render-cost.perf.spec.ts`'s
"vulcanus resources (default Vulcanus view)" case:

| | V1 terrain baseline | vulcanus terrain (this branch) | vulcanus resources (this branch, the default view) |
|---|---|---|---|
| Total, 1024x1024 | 12,497 ms | 14,638 ms | 19,107 ms |
| Per pixel | 11.92 us/px | 13.96 us/px | 18.22 us/px |
| Ratio vs. V1 baseline | 1.00x | 1.17x | **1.53x** |

**Gate verdict: still PASS.** 1.53x is well inside the ~2x regression gate, so
this is a record correction, not a regression - but the number the merge
decision should look at is 18.22 us/px / 1.53x (the default path), not the
13.96 us/px / 1.17x terrain-only figure above. The gap between the two
(13.96 -> 18.22 us/px, +30%) is exactly the double field-stack cost described
above, not a separate bug. If this ever needs closing, the fix is sharing one
field stack between the terrain paint and the resource overlay rather than
building `renderVulcanusResources`'s own - not investigated here since the
gate still passes.
