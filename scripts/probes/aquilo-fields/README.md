# aquilo-fields

Captures the Aquilo fields that the wells, icebergs and island peaks read, at
positions that contain them, at three lever settings. It also lists every
well and iceberg near the origin, with the tile under each one. Stage 1
(Aquilo) grades its Rust port against both files.

```bash
node --experimental-strip-types scripts/probes/aquilo-fields/capture.ts
```

Run it from the repository root. It takes about 30 seconds and runs eight
games through `factorio-oracle`, each with `--factorio` and `--version`. It
stops unless each report's `buildLine` names the version asked for. It writes:

- `test/fixtures/oracle-aquilo-entity-fields.seed123456.json` (the fields)
- `test/fixtures/oracle-aquilo-entities.seed123456.json` (the census)

## What it does

1. **Angle.** One run reads `aquilo_angle` at the origin on 2.1.23, with the
   surface seed forced to 123456. The four starting cones sit at
   `(d sin a, -d cos a)` for their own distance `d` and angle `a`, from
   `starting_spot_at_angle` in `core/prototypes/noise-functions.lua`.
2. **Pool.** 16,384 points on the 1/256 grid, all within 1,200 tiles of the
   origin, fixed by a seeded generator. They come in a cycle of 16 slots: 8
   spread evenly over the disk of radius 1,200, 2 over radius 600, 2 over
   radius 300, and 1 around each starting cone (a disk of twice the cone's
   radius, at least 2 tiles). Without the cone slots, the radius-1
   `aquilo_starting_flourine_vent_tiny` cone would be hit by almost no point
   of an even spread. Points are drawn by rejection from a square, so no
   `Math.sin` decides a position. The cone centres are rounded to the 1/256
   grid before use, for the same reason.
3. **Scout.** One run on 2.1.23 reads the nine quota fields over the whole
   pool for each lever case.
4. **Pick.** Per case, in pool order: the first 64 positions where each quota
   field passes its test, then the first 128 positions not already kept.
5. **Capture.** One run per version reads every field at each case's
   positions. All three cases must agree bit for bit between 2.1.23 and
   2.0.77, or nothing is written.
6. **Census.** Two runs per version on the planet's own surface with its
   derived seed. See below.

### The lever cases

Each case sets all three Aquilo resource controls and reads them back. The
names are `aquilo_crude_oil`, `lithium_brine` and `fluorine_vent`; an unknown
name is dropped without an error, so the read-back is the check.

| case      | `aquilo_crude_oil` | `lithium_brine` | `fluorine_vent` |
| --------- | -----------------: | --------------: | --------------: |
| `default` |                1/1 |             1/1 |             1/1 |
| `size0`   |                1/0 |             1/0 |             1/0 |
| `moved`   |            1.5/0.5 |           0.5/2 |           2/1/6 |

Each cell is frequency/size; richness is 1 everywhere. The `default` case uses
`game.planets["aquilo"].create_surface()`. The other two use
`game.create_surface()` with that surface's `map_gen_settings`. To show the
copy does not change anything, the `default` case is also read on such a copy.
It came back bit-identical to the planet surface.

### The fields

`aquilo_starting_crude_oil`, `aquilo_starting_lithium_brine`,
`aquilo_starting_flourine_vent`, `aquilo_starting_flourine_vent_tiny`,
`aquilo_starting_mask`, the three `aquilo_*_spots`, the three
`aquilo_*_probability`, `aquilo_island_peaks`, `aquilo_wobble_x`,
`aquilo_wobble_y`, `aquilo_aux`, `aquilo_elevation`,
`aquilo_high_frequency_peaks`, `aquilo_snow_ice`, `aquilo_tile_variant`,
`entity:lithium-iceberg-huge:probability`,
`entity:lithium-iceberg-big:probability`, and the 9 `tile:<name>:probability`
scores. Names keep the game's `flourine` spelling.

The iceberg scores are read two ways in one run: the property name
`entity:<name>:probability`, and a data-stage noise expression holding the
iceberg prototype's own `probability_expression`. The script also checks that
the prototype's expression is the one in `decoratives-aquilo.lua`:
`(aquilo_high_frequency_peaks - 0.8) * 0.1` for huge and
`(aquilo_high_frequency_peaks - 0.7) * 0.8` for big.

Values cross Lua as numbers. `-0`, `inf`, `-inf` and `nan` go as strings,
since `table_to_json` loses or garbles them. Any `nan` stops the run, and every
value must be an exact f32.

### The quotas

| quota field                           | test   |
| ------------------------------------- | ------ |
| the three `aquilo_*_spots`            | `> -1` |
| the four `aquilo_starting_*` cones    | `> 0`  |
| the two `entity:*:probability` scores | `> 0`  |

`aquilo_starting_mask` is not a cone and has no quota.

## Fixture shapes

**Fields.** `cases.<label>` holds `controls` (the values read back),
`positions` (a list of `[x, y]`) and `fields` (name to a list of f32 bits as
8-digit hex, one per position, in the same order). The top level also holds
`aquiloAngle`, `coneClusterCentres`, `icebergExpressions`, `icebergRoutes`
(which route answered, per version and case), `quotas` (per case and field:
the test, hits in the pool, positions kept, any shortfall, and the lowest and
highest value over the pool) and
`finalPassing` (how many kept positions pass each test).

**Census.** `entities` is a list of
`[name, x, y, tile, tileWithoutEffect, amount]`, sorted by name, x, y.
`totals` counts by name. `tilesUnder` and `tilesUnderWithoutEffect` count, per
entity name, the tile under its position in each arm. `amount` is `false` for
an iceberg.

## Result (2026-10-23, 2.1.23 build 87750 and 2.0.77 build 84539)

`buildLine`s: `Version: 2.1.23 (build 87750, linux64, headless)` and
`Version: 2.0.77 (build 84539, linux64, headless)`.

### Fields

- **The two versions agree.** All fields, all positions, all three cases are
  bit-identical between 2.1.23 and 2.0.77. The controls read back the same on
  both.
- **The batch does not change the values.** The 16,384-position scout and the
  final batch agree at all 15,390 shared quota values.
- **Re-running wrote byte-identical files** (both fixtures, `cmp`).
- **Both iceberg routes answer on both versions**, bit-identical in every
  case. So `entity:<name>:probability` works in `calculate_tile_properties`
  on 2.0.77 and 2.1.23, and it equals the prototype's `probability_expression`
  evaluated alone. The fixture stores it under the `entity:` name.
- **`aquilo_angle`** at forced seed 123456 is `0.10347962` (`3dd3ed20`).
- **Fluorine size 1/6 reads back as `0.1666666716337204`**, the f32 nearest
  1/6. The engine stores control values as f32. A port should use the
  read-back value in `controls`, not 1/6.
- **Size 0 gives the basement, not NaN.** In the `size0` case all three
  `aquilo_*_spots` fields read exactly -1 at all 16,384 pool positions (the
  pool range is -1..-1, and `bf800000` at every kept position), and the three `aquilo_*_probability` fields read 0 at every kept
  position. No NaN came back anywhere (the script stops on one).

Quota counts (pool hits / kept). Every quota was met except the spots at size
0:

| quota field                               |   default |     size0 |     moved |
| ----------------------------------------- | --------: | --------: | --------: |
| `aquilo_crude_oil_spots`                  |  529 / 64 | **0 / 0** |  515 / 64 |
| `aquilo_lithium_brine_spots`              |  354 / 64 | **0 / 0** | 1213 / 64 |
| `aquilo_flourine_vent_spots`              |  662 / 64 | **0 / 0** |  130 / 64 |
| `aquilo_starting_crude_oil`               |  299 / 64 |  299 / 64 |  299 / 64 |
| `aquilo_starting_lithium_brine`           |  260 / 64 |  260 / 64 |  260 / 64 |
| `aquilo_starting_flourine_vent`           |  256 / 64 |  256 / 64 |  256 / 64 |
| `aquilo_starting_flourine_vent_tiny`      |  246 / 64 |  246 / 64 |  246 / 64 |
| `entity:lithium-iceberg-huge:probability` | 4116 / 64 | 4116 / 64 | 4116 / 64 |
| `entity:lithium-iceberg-big:probability`  | 5117 / 64 | 5117 / 64 | 5117 / 64 |
| positions kept                            |       632 |       452 |       626 |

- **The size-0 spot shortfall is the finding, not a pool problem.** With
  size 0 the spot radius is 0, and no position is above the basement. The
  quota was not shrunk; `quotas.size0` records a shortfall of 64 for each.
- **The `moved` fluorine quota was met, narrowly.** At size 1/6 the spot
  radius is about 18.4 tiles, and 130 pool positions are above -1.
- **Most spot hits are in the skirt, not the cone.** The `> -1` test also
  passes on the negative skirt between a cone's edge and twice its radius.
  Positions where the spot field is above 0 and the starting mask is above 0
  (so the spot term of `aquilo_*_probability` is positive) number 15, 18 and 17
  (crude oil, lithium brine, fluorine vent) at `default`, and 10, 5 and 15 at
  `moved`.
- **`aquilo_starting_mask` is thin off its clamps.** It is graded at only 21
  (`default`), 13 (`size0`) and 22 (`moved`) positions strictly between -1
  and 1. Every other position sits at a clamp.
- **The starting cones and the icebergs do not depend on the levers.** Their
  pool hit counts are the same in all three cases.

### Census (derived seed 3111923328, default levers)

The planet's own surface, with its derived seed read back as 3111923328 and
the three controls read back as 1/1/1. `request_to_generate_chunks({0, 0}, 8)`
and `force_generate_chunk_requests()`, then every `resource` and
`simple-entity` over tiles -256..255 (the `planet-autoplace` region). The
wells' `created_effect` rewrites tiles near them during map generation
(`planet-autoplace` measured this), so the census is taken twice: as shipped,
and with `created_effect` removed from the three resources in
`data-final-fixes`. The entity list (name and position) is asserted identical
in both arms. `tileWithoutEffect` is the tile the autoplace saw.

Totals match `oracle-planet-autoplace.2.1.23.json`: 11 `crude-oil`, 4
`lithium-brine`, 4 `fluorine-vent`, 159 `lithium-iceberg-big`, 21
`lithium-iceberg-huge`. 2.0.77 gave the same list: names, positions, amounts
and both tile columns.

Tiles under each entity, with the effect removed:

| entity                 | tiles under, effect removed                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `crude-oil`            | ice-rough 3, ice-smooth 3, snow-crests 1, ammoniacal-ocean 2, ammoniacal-ocean-2 2       |
| `lithium-brine`        | ice-rough 2, ice-smooth 1, ammoniacal-ocean-2 1                                          |
| `fluorine-vent`        | ammoniacal-ocean 2, ammoniacal-ocean-2 2                                                 |
| `lithium-iceberg-big`  | ice-rough 28, ice-smooth 34, snow-crests 20, snow-flat 31, snow-lumpy 33, snow-patchy 13 |
| `lithium-iceberg-huge` | ice-rough 2, ice-smooth 4, snow-crests 3, snow-flat 6, snow-lumpy 4, snow-patchy 2       |

As shipped, every well that stood on ocean stands on `snow-lumpy` instead (9
of 19: 4 crude oil, 1 lithium brine, all 4 fluorine vents). The icebergs read
the same tile in both arms.

What this says for Task 6's `tile_allowed`:

- **Wells are placed on ocean.** 9 of the 19 wells stand on
  `ammoniacal-ocean` or `ammoniacal-ocean-2` before the rewrite, so a well
  overlay that excludes ocean is wrong. Read the `tileWithoutEffect` column,
  never `tile`: the shipped column shows `snow-lumpy` under all 4 fluorine
  vents, and that tile is the rewrite's, not the autoplace's.
- **No well stood on `brash-ice`, `snow-flat` or `snow-patchy` here.** With
  only 19 wells, that absence is not proof that those tiles are excluded.
- **Icebergs stood only on the six land tiles** (all 180 of them), never on
  either ocean or `brash-ice`. The census does not say why: a tile
  restriction and a collision rule would look the same here.

Wells sit at tile centres (x.5, y.5). Icebergs sit on a 1/16-tile grid.

One `fluorine-vent`, at (-40.5, -67.5), has an amount of exactly 420,000.
That is the value of the tiny cone's richness term (`420000` times richness
1). It sits 78.7 tiles from the origin. This fits the guaranteed vent
(`aquilo_starting_flourine_vent_tiny`, radius 1, distance 80). The probe did
not read that field at the derived seed, so this is a fit, not a measurement.
