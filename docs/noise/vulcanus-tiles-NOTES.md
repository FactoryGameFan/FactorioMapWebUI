# Vulcanus tile catalog + argmax (Task 10)

Ports the Vulcanus tile-autoplace argmax: the placed tile at a pixel is the one
whose `probability_expression` is highest, and its `map_color` is painted. This is
the same mechanism as Nauvis M2 (`src/noise/tiles/catalog.ts` + `resolve.ts`),
validated against the game's `get_tile` oracle with Space Age enabled.

Source: `~/GitHub/factorio-data` (tag 2.1.11)
`space-age/prototypes/tile/tiles-vulcanus.lua` (tiles + the `*_range` named
noise-expressions, lines ~200-1030) and
`space-age/prototypes/planet/planet-vulcanus-map-gen.lua`
(`mountain_lava_spots` ~line 452, `vulcanus_rock_noise` ~line 872).

`tile_lightening = 28`, so `map_color = {r = tile_lightening + N, ...}` means the
stored byte is `28 + N`. Literal `{r, g, b}` colors are used verbatim.

## The 19 tiles (registration order = argmax tie-break order)

Ties keep the first tile in catalog order (strict `>` never displaces the running
winner), exactly like the Nauvis resolver. Order below is the data-file order.

| # | tile name | map_color [r,g,b] | probability_expression |
|---|-----------|-------------------|------------------------|
| 1 | volcanic-jagged-ground | [58,58,48] | volcanic_jagged_ground_range |
| 2 | lava | [150,49,30] | max(lava_basalts_range, lava_mountains_range) |
| 3 | lava-hot | [255,138,57] | max(lava_hot_basalts_range, lava_hot_mountains_range) |
| 4 | volcanic-cracks-hot | [58,33,23] | volcanic_cracks_hot_range |
| 5 | volcanic-cracks-warm | [58,38,33] | volcanic_cracks_warm_range |
| 6 | volcanic-cracks | [43,42,43] | volcanic_cracks_cold_range |
| 7 | volcanic-folds-flat | [44,43,44] | volcanic_folds_flat_range |
| 8 | volcanic-ash-light | [53,53,53] | volcanic_ash_light_range |
| 9 | volcanic-ash-dark | [53,53,53] | volcanic_ash_dark_range |
| 10 | volcanic-ash-flats | [53,53,53] | volcanic_ash_flats_range |
| 11 | volcanic-pumice-stones | [46,46,46] | volcanic_pumice_stones_range |
| 12 | volcanic-smooth-stone | [50,50,58] | volcanic_smooth_stone_range |
| 13 | volcanic-smooth-stone-warm | [54,50,50] | volcanic_smooth_stone_warm_range |
| 14 | volcanic-ash-cracks | [67,67,67] | volcanic_ash_cracks_range |
| 15 | volcanic-folds | [43,43,43] | volcanic_folds_range |
| 16 | volcanic-folds-warm | [65,45,45] | volcanic_folds_warm_range |
| 17 | volcanic-soil-dark | [48,51,43] | volcanic_soil_dark_range |
| 18 | volcanic-soil-light | [58,48,43] | volcanic_soil_light_range |
| 19 | volcanic-ash-soil | [48,48,43] | volcanic_ash_soil_range |

Note three tiles share [53,53,53] (ash-light/dark/flats) - a color tie is decided
by which tile's probability wins, not by the color.

## Field bindings

`range_select_base(input, from, to, slope, min, max)` =
`clamp(min(input-from, to-input)/slope, min, max)` - already ported as
`rangeSelectBase` in `src/noise/rocks/rockCatalog.ts` (re-used, not reimplemented).

Underlying fields (Tasks 7-9), keyed to the game name used inside the ranges:

- `vulcanus_elev` -> `elevation.elev` (RAW `vulcanus_elev`, NOT the `max(-500,...)`
  clamped `vulcanus_elevation`; the ranges reference `vulcanus_elev`).
- `vulcanus_mountains_biome` / `vulcanus_ashlands_biome` / `vulcanus_basalts_biome`
  -> `biomes.mountainsBiome` / `ashlandsBiome` / `basaltsBiome` (clamped 0..1).
- `mountain_volcano_spots` -> `biomes.mountainVolcanoSpots`.
- `aux` -> `climate.aux` (`vulcanus_aux`); `moisture` -> `climate.moisture`.
- `distance` -> `distance_from_nearest_point{points = starting_positions}`.
- `mountain_lava_spots`, `vulcanus_rock_noise` -> ported here (below).

### Two helpers ported for this task

`vulcanus_rock_noise` (map-gen line ~872), a plain multioctave:
`multioctave_noise{seed0 = map_seed, seed1 = 137, octaves = 4, persistence = 0.65,
input_scale = 0.1, output_scale = 0.4}` (the commented-out `control:rocks:frequency`
slider term is not applied - it is commented out in the source).

`mountain_lava_spots` (map-gen line ~452):
```
clamp(vulcanus_threshold(mountain_volcano_spots * 1.95 - 0.95,
                         0.4 * clamp(vulcanus_threshold(vulcanus_mountains_biome, 0.5), 0, 1))
      * vulcanus_threshold(clamp(vulcanus_plasma(17453, 0.2, 0.4, 10, 20) / 20, 0, 1), 1.8),
      0, 1)
```
Uses `helpers.threshold`, `helpers.plasma`, `biomes.mountainVolcanoSpots`,
`biomes.mountainsBiome`.

## The `*_range` expressions (verbatim, with resource approximations flagged)

LAVA:
- `lava_spawn_excluder = distance > 10` (boolean -> 1/0).
- `lava_basalts_range = 100 * min(basalts_biome * lava_spawn_excluder * range_select_base(elev, -5000, 0, 1, -1000, 1), 100 * (1 - metal))`
- `lava_mountains_range = 1100 * range_select_base(mountain_lava_spots, 0.2, 10, 1, 0, 1)`
- `lava_hot_basalts_range = 200 * min(basalts_biome * lava_spawn_excluder * range_select_base(elev, -5000, min(0, 5*(-2+4*rock_noise)), 1, -1000, 1), 100 * (1 - metal))`
- `lava_hot_mountains_range = 1000 * range_select_base(mountain_lava_spots, 0.05, 0.3, 1, 0, 1)`

BASALTS:
- `volcanic_cracks_hot_range = basalts_biome * range_select_base(elev, 0, 8, 1, 0, 20)`
- `volcanic_cracks_warm_range = basalts_biome * range_select_base(elev, 8, 22, 1, 0, 5) + (aux - 0.05) + 50000 * metal`
- `volcanic_cracks_cold_range = (0.5 - ashlands_biome) * range_select_base(elev, 20, 100, 1, 0, 1) + (aux - 0.3)`
- `volcanic_smooth_stone_warm_range = basalts_biome * range_select_base(elev, 8, 20, 1, 0, 5) - (aux - 0.05) + 50000 * metal`
- `volcanic_smooth_stone_range = (0.5 - ashlands_biome) * range_select_base(elev, 20, 100, 1, 0, 1) - (aux - 0.3)`

MOUNTAINS:
- `volcanic_folds_flat_range = 2*(mountains_biome - 0.5) - 0.15*mountain_volcano_spots`
- `volcanic_folds_range = 2*(mountains_biome - 0.5) + (aux - 0.5) + 0.5*(mountain_volcano_spots - 0.1)`
- `volcanic_folds_warm_range = 2*(mountains_biome - 0.5) + 3*(mountain_volcano_spots - 0.85) - 2*(aux - 0.5)`
- `volcanic_jagged_ground_range = 5 * min(10, max(calcite_region + 0.2, range_select_base(elev, 1010, 2000, 2, -10, 1) + 3*(aux - 0.5)))`
- `volcanic_soil_light_range_mountains = min(0.8, 4*(mountains_biome - 0.25)) - 0.35*mountain_volcano_spots - 3*(aux - 0.2)`
- `volcanic_soil_dark_range_mountains = min(0.8, 4*(mountains_biome - 0.25)) - 0.35*mountain_volcano_spots - 1*(aux - 0.5)`

ASHLANDS:
- `volcanic_ash_flats_range = 2*(ashlands_biome - 0.5) - 1.5*(aux - 0.25) - 1.5*(moisture - 0.6)`
- `volcanic_ash_light_range = 2*(ashlands_biome - 0.5) - 1.5*(moisture - 0.6)`
- `volcanic_ash_dark_range = min(1, 4*(ashlands_biome - 0.25)) + max(-1.5*(aux - 0.25), 0.01 - 1.5*abs(aux - 0.5) - 1.5*(moisture - 0.66))`
- `volcanic_pumice_stones_range = 2*(ashlands_biome - 0.5) + 1.5*(aux - 0.5) + 1.5*(moisture - 0.66)`
- `volcanic_ash_cracks_range = min(1, 4*(ashlands_biome - 0.25)) + 1.5*(aux - 0.5) - 1.5*(moisture - 0.66)`
- `volcanic_ash_soil_range = 2*(ashlands_biome - 0.5)`
- `volcanic_soil_light_range_ashlands = 2*(ashlands_biome - 0.5) + 1.5*(moisture - 0.8)`
- `volcanic_soil_dark_range_ashlands = 2*(ashlands_biome - 0.5) - 1.5*(aux - 0.25) + 1.5*(moisture - 0.8)`

COMBINE SHARED:
- `volcanic_soil_light_range = max(soil_light_mountains, soil_light_ashlands, 10*(sulfuric_acid_region_patchy + 0.2))`
- `volcanic_soil_dark_range = max(soil_dark_mountains, soil_dark_ashlands)`

## Resource-term coupling (restored in V2 - was approximated away in V1)

V1 shipped without the V2 resource expressions and approximated the three
coupling sites at their no-resource default (`vulcanus_metal_tile -> 0`,
`vulcanus_calcite_region`/`vulcanus_sulfuric_acid_region_patchy` dropped from
their `max(...)` branch). **V2 (`docs/noise/vulcanus-resources-NOTES.md`) ported
`vulcanus_metal_tile`, `vulcanus_calcite_region`, and
`vulcanus_sulfuric_acid_region_patchy` for real** (Task 5,
`src/noise/tiles/vulcanusCatalog.ts`), and all six coupling sites below now read
the live fields instead of a stub. This passage previously described those three
as active approximations; it does not anymore - see V2's notes doc for what
replaced them and for the one approximation that remains.

The six coupling sites, now live:

1. `lava_basalts_range` / `lava_hot_basalts_range`: `100 * (1 - metal_tile)`
   inside `min(basalts_term, 100 * (1 - metal_tile))`. In practice this cap still
   rarely binds (`basalts_term <= 1` almost everywhere), but it is no longer
   hardcoded to `100`.
2. `volcanic_cracks_warm_range` / `volcanic_smooth_stone_warm_range`:
   `+ 50000 * metal_tile`, a large boost that dominates whenever `metal_tile > 0`
   (i.e. inside a tungsten-ore region), pushing those two tiles to win the argmax
   there.
3. `volcanic_jagged_ground_range`: `max(calcite_region + 0.2, elev_term)` - the
   calcite branch now genuinely competes with the elevation-band branch.
4. `volcanic_soil_light_range`: `max(mountains, ashlands, 10 * (sulfuric_region_patchy + 0.2))`
   - the sulfuric-acid branch now genuinely competes with the other two.

**One approximation remains, inside `vulcanus_metal_tile` itself** (not in the
tile catalog): the game's `vulcanus_metal_tile` reads
`random_penalty_between(0.9, 1, 1)`, a batch op a per-pixel renderer cannot
reproduce, approximated as `1`. This makes our `metal_tile` an **upper bound**
on the game's value (see `docs/noise/vulcanus-resources-NOTES.md` for the
measured envelope - worst divergence 132.86, zero envelope violations across
1085 fixture points). This is the only resource-term approximation left
anywhere in the tile catalog; the tile-argmax coupling above is otherwise exact.

Restoring the three fields raised `get_tile` agreement from 96.85% (369/381) to
98.16% (374/381) - see `docs/noise/vulcanus-resources-NOTES.md` for the
characterization of the 7 mismatches that remain (all far-field f32
argmax-boundary flips at points where the restored fields sit at their
no-patch floor, unrelated to the coupling restoration).

## Validation

`test/vulcanusTiles.spec.ts` compares `makeVulcanusTileResolver` tile names against
`test/fixtures/oracle-vulcanus-tile-names.seed123456.json` (captured via the
`get_tile` Space-Age chunk-generate path, `captureVulcanusTileNames`). Agreement is
reported in the report file. High agreement with only sparse, resource-localized
mismatches confirms the port; widespread mismatches would indicate a genuinely wrong
`*_range` transcription, not the resource approximation.
