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
point than we did, most likely because a ring position's exact float
representation differs by a ULP or two through the coordinate's construction
path).

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
mismatches sit at radii 230-2079 from spawn, are adjacent-tile flips within
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
   `sliderRescale(v, 2) * min(1.2, oreDist) * 25`, and `sliderRescale` caps at
   2, so `radius <= 2 * 1.2 * 25 = 60`, always under
   `MAX_SPOT_BASEMENT_RADIUS` (128). Unreachable by construction - do not "fix"
   this by adding the cap defensively; it would be dead code.
4. **The sulfuric-acid geyser overlay is deferred to V3** (a scattered-point
   fluid placement, not a solid patch - see `vulcanusResourceCatalog.ts`'s
   module comment). Its region field (`sulfuricAcidRegion` /
   `sulfuricAcidRegionPatchy`) is computed here regardless, because the tile
   catalog reads `sulfuricAcidRegionPatchy` for `volcanic_soil_light_range`.
   So **V3 is mostly renderer work** - the field math is already done and
   oracle-validated.

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
