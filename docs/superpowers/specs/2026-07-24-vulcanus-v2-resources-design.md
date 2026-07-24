# Vulcanus V2 - resource patches + restored terrain coupling

Date: 2026-07-24
Status: design approved, not yet implemented
Follows: `2026-07-23-vulcanus-client-preview-design.md` (V1 terrain, shipped at
`6b9cb5b` / deployed)

## Goal

Render Vulcanus's three solid ore patches (tungsten, calcite, coal) as a
client-side overlay, and close the three resource-coupling approximations that V1
left stubbed in the tile catalog so Vulcanus terrain becomes faithful inside and
around resource regions.

## Scope

**In:**

- The three solid ores: `tungsten-ore`, `calcite`, `coal` (`vulcanus_coal`
  control), each rendered as a solid patch overlay.
- Near-spawn starting patches (`vulcanus_starting_tungsten` / `_coal` /
  `_calcite`), which are `max(...)`-ed into each region.
- All three stubbed terrain terms restored: `vulcanus_metal_tile`,
  `vulcanus_calcite_region`, `vulcanus_sulfuric_acid_region_patchy`.
- The sulfuric-acid region field, computed **as a terrain input only**.

**Out:**

- The sulfuric acid geyser **overlay**. It is a fluid with
  `density * 0.025`, so it renders as scattered points rather than a solid patch -
  a different render mode, deferred to V3. Its field is built here, so V3 is
  mostly renderer work.
- Richness. We render placement, not yield, so `control:*:richness`,
  `vulcanus_starting_area_multiplier` and `vulcanus_richness_multiplier` are not
  ported.
- Decoratives, chimneys, and everything else downstream of these regions.

## Source of truth

`~/GitHub/factorio-data` at tag **2.1.11** (matching the oracle binary):

- `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` lines ~560-862
  (resource wobbles, starting spots, `vulcanus_spot_noise`, favorabilities,
  `place_*_spots`, the four region/probability blocks).
- `space-age/prototypes/tile/tiles-vulcanus.lua` lines ~197, ~211-259, ~295, ~372
  (the coupled `*_range` expressions).

## Approximations (deliberate, stated up front)

1. **`random_penalty_between(0.9, 1, 1)` is approximated as `1`.** It appears in
   every `*_probability` expression. `random_penalty` is a batch operation whose
   value depends on the whole batch and its evaluation order (see
   `docs/noise/random-penalty-NOTES.md`), and the Nauvis M3.5 stipple work was
   deferred for exactly this cross-subsystem coupling. At `rp = 1` the
   probability collapses to `(control:<x>:size > 0) * 1000 * region`, so
   `renderResources`' existing `probability >= 0.5` test reduces to
   `region >= 0.0005`; the penalty only perturbs the razor edge of a patch.
2. **Richness is not computed** (see Scope/Out).

Both are recorded here so they are not mistaken for bugs later.

## Architecture

### New: `src/noise/expressions/vulcanusResources.ts`

`makeVulcanusResources(ctx, helpers, spawn, biomes, cracks)` returns four
`memoXY`'d closures:

| closure | game expression |
| --- | --- |
| `tungstenRegion(x, y)` | `vulcanus_tungsten_ore_region` |
| `calciteRegion(x, y)` | `vulcanus_calcite_region` |
| `coalRegion(x, y)` | `vulcanus_coal_region` |
| `sulfuricAcidRegionPatchy(x, y)` | `vulcanus_sulfuric_acid_region_patchy` |

Internals, ported 1:1:

- **`vulcanus_resource_wobble_x/y`** = `wobble_x + 0.25 * wobble_large_x` (and y),
  from the existing `VulcanusHelpers` wobble closures.

- **`vulcanusSpotNoise(...)`** - the shared `noise-function` wrapper. Evaluates
  `spot_noise` at `(x + resourceWobbleX(x, y), y + resourceWobbleY(x, y))` with
  `seed0 = map_seed`, `seed1 = seed`,
  `suggested_minimum_candidate_point_spacing = 128`, `skip_span = span`,
  `skip_offset = offset`, `hard_region_target_quantity = 0`,
  `basement_value = -1`, `maximum_spot_basement_radius = 128`. Drives the
  already-ported `selectSpots` / `spotCandidatePoints`.

  **The wobbled coordinate is the sample position, so region membership derives
  from the wobbled coordinate, not the raw one.** Getting this backwards yields a
  plausible-looking but wrong field.

- **Favorabilities** (all four, `buffer`/`contrast` inlined):

  ```
  basalts          = clamp((basalts_biome_full  * (starting_area < 0.01) - 0.3) * 2, 0, 1)
  mountains_sulfur = clamp((mountains_biome_full * (starting_area < 0.01) - 0.3) * 2, 0, 1)
  ashlands         = clamp((ashlands_biome_full  * (starting_area < 0.01) - 0.3) * 2, 0, 1)
  mountains        = clamp(main_region - (mountain_volcano_spots > 0.78), 0, 1)
    where main_region = clamp((mountains_biome_full * (starting_area < 0.01) - 0.4) * 2, 0, 1)
  ```

  Note `mountains` uses buffer **0.4** and subtracts the volcano-peak term;
  `mountains_sulfur` is the plain 0.3 variant. They are two distinct expressions.

- **`place_*_spots(seed, count, offset, size, freq, favor_biome)`** - three
  wrappers over `vulcanusSpotNoise`, sharing
  `spacing = 128`, `span = 3`, `density = favor_biome * 4`,
  `quantity = size * size`, `radius = size`,
  `favorability = favor_biome > 0.9`, and differing in:

  | wrapper | `region_size` | outer expression |
  | --- | --- | --- |
  | `place_metal_spots` | `500 + 500/freq` | `min(clamp(-1 + 4*favor, -1, 1), spot - hairline_cracks/30000)` |
  | `place_sulfur_spots` | `450 + 450/freq` | `min(2*favor - 1, spot)` |
  | `place_non_metal_spots` | `400 + 400/freq` | `min(2*favor - 1, spot)` |

- **Regions**, each `max(starting_<ore>, min(1 - startingCircle, place_*(...)))`:

  | region | seed | count | offset | size expr | favorability | wrapper |
  | --- | --- | --- | --- | --- | --- | --- |
  | tungsten | 789 | 15 | 2 | `slider_rescale(control:tungsten_ore:size, 2) * min(1.2, ore_dist) * 25` | basalts | metal |
  | coal | 782349 | 12 | 1 | `slider_rescale(control:vulcanus_coal:size, 2) * min(1.2, ore_dist) * 25` | ashlands | non-metal |
  | calcite | 749 | 12 | 1 | `slider_rescale(control:calcite:size, 2) * min(1.2, ore_dist) * 25` | mountains | non-metal |
  | sulfur | 759 | 9 | 0 | `slider_rescale(control:sulfuric_acid_geyser:size, 2) * min(1.2, ore_dist) * 25` | mountains_sulfur | sulfur |

  with `vulcanus_ore_dist = max(1, distance / 4000)` and
  `vulcanus_starting_circle = 1 + starting_area_radius * (300 - distance) / 50`
  (unclamped, already on `VulcanusSpawn`).

- **`starting_<ore>`** - `startingSpotAtAngle` calls (already ported), using the
  resource wobbles at `0.5 *` distortion. Transcribed verbatim; note
  `vulcanus_starting_tungsten` deliberately uses a bare `30 / 1.5` radius (no
  size slider) while coal and calcite scale theirs by the slider.

- **`sulfuricAcidRegionPatchy`** =
  `(1 + sulfuric_acid_region) * (0.5 + 0.5 * sulfuric_acid_patches) - 1`, where
  `patches = 0.8 * abs(multioctave_noise{persistence = 0.7, seed1 = 21000,
  octaves = 2, input_scale = 1/3})`.

### Changed: `src/noise/tiles/vulcanusCatalog.ts`

`VulcanusTileFields` gains three fields:

- `metalTile(x, y)` = `max(0, 1000 * tungstenRegion(x, y))`
  (`vulcanus_metal_tile = max(0, vulcanus_tungsten_ore_probability)`, with the
  `rp = 1` approximation and the `control:tungsten_ore:size > 0` gate).
- `calciteRegion(x, y)`
- `sulfuricAcidRegionPatchy(x, y)`

Restored branches:

- The four lava ranges regain `100 * (1 - vulcanus_metal_tile)` and
  `+ 50000 * vulcanus_metal_tile` (tiles-vulcanus.lua ~211-259).
- `volcanic_jagged_ground_range` regains the
  `max(vulcanus_calcite_region + 0.2, ...)` branch (~295). Its `+0.2` skirt means
  this changes tiles **outside** the calcite patch, not only under it.
- `volcanic_soil_light_range` regains
  `10 * (vulcanus_sulfuric_acid_region_patchy + 0.2)` (~372), likewise with an
  outside-the-patch skirt.

`makeVulcanusTileResolver` builds `makeVulcanusResources` and threads the three
fields in. Its `ctx` gains the resource control levers (frequency + size only).

### New: `src/noise/resources/vulcanusResourceCatalog.ts`

Three entries, in registration order (`space-age/prototypes/entity/resources.lua`):

| name | control | `map_color` (0-255) |
| --- | --- | --- |
| `tungsten-ore` | `tungsten_ore` | `[98, 86, 150]` |
| `calcite` | `calcite` | `[204, 179, 179]` |
| `coal` | `vulcanus_coal` | `[0, 0, 0]` |

All three are autoplace order `"b"`, so ties fall back to registration order. In
practice the three occupy disjoint biomes, so overlap is effectively impossible
and priority is a formality.

### New: `src/noise/preview/renderVulcanusResources.ts`

Mirrors `renderResources`' structure: sweep the same pixel grid, and where a
resource wins, paint its `map_color` opaque onto the terrain `ImageData` in
place.

Placement keeps the Nauvis renderer's `probability >= 0.5` convention, which
under approximation 1 evaluates to
`control:<x>:size > 0 && region(x, y) >= 0.0005`. Writing it as an explicit
probability (rather than a bare `region > 0`) keeps the `size = 0` disable case
and the `rp = 1` substitution visible at the call site.

One difference from the Nauvis renderer: **no water exclusion.** Vulcanus has
lava, not water, and the game expresses the exclusion through the biome
favorabilities rather than a tile test.

### Wiring

- `elevationRenderRequest.ts`: the `planet === "vulcanus"` early return stops
  skipping the `view: "resources"` branch; it dispatches to
  `renderVulcanusResources` over `renderVulcanusTerrain`. The other Nauvis
  overlays (enemies, cliffs, trees, rocks) stay skipped for Vulcanus.
- `ElevationPreviewPanel.vue`: the Resources toggle un-gates for Vulcanus, and
  `"resources"` becomes Vulcanus's non-dev default view (matching Nauvis's
  `"all"`). Elevation stays disabled for Vulcanus.

## Verification

### Per-expression oracle validation

Extend `test/oracle/capture.ts` to emit
`test/fixtures/oracle-vulcanus-resources.seed123456.json`, sampling via the
Space Age probe surface:

- the four favorability expressions
- the three `place_*_spots` outputs
- the four regions
- `vulcanus_metal_tile`, `vulcanus_sulfuric_acid_region_patchy`

New `test/vulcanusResources.spec.ts` asserts each to the f32 floor, the same bar
as V1's biome/crack/elevation specs.

Two known-risky spots, to be treated as findings rather than tuned around:

1. **`spot_favorability_expression` is exercised for real for the first time.**
   Nauvis passes constant `1`, so `selectSpots`' favorability-sorted trim and
   cbrt hard-shrink have never run with a discriminating (0/1) favorability.
   Residuals here are a genuine `selectSpots` finding.
2. **The wobbled sample position** (see above).

### Tile parity - the acceptance test for the coupling half

`test/vulcanusTiles.spec.ts` currently measures **96.85% (369/381)** against the
`get_tile` oracle, and its own comment attributes the 12 mismatches to these
three stubs. Restoring them should raise it; the assertion floor gets raised to
whatever it actually reaches.

**If agreement does not improve, the coupling port is wrong.** Report that
rather than relaxing the bound. Per the repo's standing rule, no expected value
or fixture is edited to make a test pass.

### Nauvis isolation

`makeVulcanusResources` is reachable only from `makeVulcanusTileResolver` and
`renderVulcanusResources`. Existing Nauvis render and codec tests must stay green
and unmodified.

### Performance

Terrain is ~12 µs/px after the V1 memoXY fix. Coupling means the terrain
resolver now pays for three spot fields even with the overlay off. Structurally
this should be cheap: candidate generation and the density/quantity/radius/
favorability evaluations are per-region and cached by `selectSpots`, leaving the
per-pixel cost at the cone scan plus the wobble.

Measure `pnpm perf` before and after and report the number.
**Gate: a terrain-only regression worse than ~2× is a finding to investigate
before merge, not something to ship with a note.**

## Success criteria

1. All new expressions match the oracle to the f32 floor.
2. `get_tile` agreement in `test/vulcanusTiles.spec.ts` improves from 96.85%.
3. The three ore patches render on Vulcanus, including near-spawn starting
   patches.
4. Nauvis output is unchanged.
5. `pnpm run verify` passes; terrain perf within the stated gate.
