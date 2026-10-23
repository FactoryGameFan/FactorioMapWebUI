# planet-autoplace

What Gleba and Aquilo put on the ground, and whether an Aquilo well rewrites
tiles during map generation. Stage 0 of adding the two planets; the answers
decide what Stages 1 and 3 build.

```bash
node --experimental-strip-types scripts/probes/planet-autoplace/capture.ts
```

Run from the repository root. It runs the game twice through `factorio-oracle`
against the 2.1.23 headless install (about 10 seconds in all), asserts the
`buildLine` and the derived surface seeds (Gleba 3215206427, Aquilo
3111923328) and writes `test/fixtures/oracle-planet-autoplace.2.1.23.json`.
The region is chunks -8..8, so tiles -256..255 are read. `REGION_CHUNKS`
widens it.

## Findings (Factorio 2.1.23, map seed 123456, derived seeds)

### (a) Gleba: plants and nests enter through their controls

Gleba's own `autoplace_settings.entity` lists only `stone`,
`copper-stromatolite` and `iron-stromatolite`. Yet the region holds 7,020
trees, 162 plants and 9 pentapod nests, all `gleba-spawner-small` (no large
`gleba-spawner` at all). Generating Gleba again with one control at size 0
(read back as 0):

| surface                   |  tree | plant | unit-spawner |
| ------------------------- | ----: | ----: | -----------: |
| as is                     | 7,020 |   162 |            9 |
| `gleba_plants` size 0     |     0 |     0 |           10 |
| `gleba_enemy_base` size 0 | 7,020 |   162 |            0 |

So frankh's rule holds: the planet's own list plus every entity whose
`autoplace.control` is one of the planet's controls. The data stage lists
`gleba_plants` as 12 prototypes (`plant:jellystem`, `plant:yumako-tree`, and
ten `tree:` ones such as `boompuff`, `funneltrunk`, `water-cane`) and
`gleba_enemy_base` as `unit-spawner:gleba-spawner` and `gleba-spawner-small`
(`byControl` in the fixture). Two side notes. Zeroing plants moved the nest
count from 9 to 10: the same 9 small nests plus 1 large `gleba-spawner`, the
only large one in either run. Why is not measured. One guess is that nests
avoid plants, so freeing the ground lets one more fit. Gleba also has 513
`cliff-gleba` cliffs, from `gleba_cliff`.

### (b) Aquilo has no cliffs

Zero `cliff` entities in the region. The surface's `cliff_settings` reads back
with an empty `name` and `control`, so there is nothing to place. Stage 1 does
not need cliffs for Aquilo. What does exist is 180 `simple-entity`s
(159 `lithium-iceberg-big`, 21 `lithium-iceberg-huge`) and 19 wells (11
`crude-oil`, 4 `lithium-brine`, 4 `fluorine-vent`).

### (c) The well rewrite runs during map generation

Each of the 19 wells leaves two `aquilo-tiles-inner/outer-explosion` entities
(38 in all), and the tiles around them are rewritten. The clean test: generate
the same Aquilo world twice, once as shipped and once with `created_effect`
removed from the three resources in `data-final-fixes`. The wells sit at
identical positions in both runs (asserted). Over all 262,144 tiles:

- Within 3 tiles of a well (the 7x7s, 867 tiles): **387 differ**. Every
  change lands on `snow-lumpy`, `snow-patchy` or `ice-rough`, from
  `ammoniacal-ocean`, `ammoniacal-ocean-2` or `brash-ice`.
- Elsewhere: 70 differ, all to `ice-rough` or `snow-patchy` (the outer
  explosion's cluster reaches past 7x7). No other tile changed.
- With the effect removed, 0 explosion entities exist.

This could not have read zero by accident: 15 of the 19 wells (8 of 11
`crude-oil`, 3 of 4 `fluorine-vent`, all 4 `lithium-brine`) have ocean inside
their 7x7, and a positive control agrees: a well created by script on the
no-wells surface rewrites 40 to 46 tiles when placed on ocean (and 8 on
`brash-ice`; 0 on `crude-oil` and `fluorine-vent` over land).

**The brief's size-0 control is confounded, and that is a finding of its
own.** With the three resource controls at size 0 the near-well diff is the
same 387, but 681 tiles differ away from the wells, including
`ammoniacal-ocean>brash-ice`, `>ice-smooth` and `>snow-crests`, which no
explosion writes. Cause: `aquilo_island_peaks` (in `aquilo_elevation`) takes
the max over the crude-oil, lithium-brine and fluorine-vent spot noises, so
the resource controls reshape the islands. Stage 1 (Aquilo) must port the
`aquilo_*_spots` expressions as part of elevation, not only as resources. The
size-0 numbers stay in the fixture (`aquiloNoWells`, `wellRewrite`) with that
caveat; `effectToggle` is the clean result.

The preview PNG does not show the rewrite. A preview captured with
`created_effect` stripped differs from the full preview in 0 pixels (see the
`oracle-preview-aquilo-full.seed123456.png` entry in
`test/fixtures/PROVENANCE.json`). So a render graded against the preview PNG
need not model the rewrite.

## Traps

- The Aquilo control names are `aquilo_crude_oil`, `lithium_brine` and
  `fluorine_vent`. An unknown name in `autoplace_controls` is dropped silently.
- The three resources report an empty `autoplace.control` in the data stage;
  their controls act through `control:<name>:size` inside the probability
  expressions (`planet-aquilo-map-gen.lua`).
- The effect strip is a data-stage change, so it needs its own run. A tile
  comparison between two runs is only valid because the seed, the wells and the
  build are asserted equal first.
