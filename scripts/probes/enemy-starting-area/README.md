# enemy-starting-area

Reads the game's own `starting_area_radius` and `enemy_base_probability` at six
starting-area settings, so the port's radius term can be graded against the game
instead of against itself.

```bash
python3 scripts/probes/enemy-starting-area/make_probe.py make /tmp/w/probe
for a in sa0_5 sa0_75 sa1 sa2 sa3 sa6; do
  ~/.cargo/bin/factorio-oracle run --probe /tmp/w/probe/$a/probe.json \
    --work-dir /tmp/w/work-$a \
    --factorio /home/eric/factorio-headless/2.1.23/factorio --version 2.1.23
done
python3 scripts/probes/enemy-starting-area/make_probe.py merge /tmp/w \
  test/fixtures/oracle-enemy-base-starting-area.seed123456.json
```

Check each run's `buildLine`: it must read
`Version: 2.1.23 (build 87750, linux64, headless)`. Each arm takes about a second.

## What it reads

Each arm is a Nauvis save at map seed 123456 with `map_gen_settings.starting_area`
set to 0.5, 0.75, 1, 2, 3 or 6 and every other setting at its default. One
`calculate_tile_properties` call reads two named noise expressions at 241
positions: the origin and six rays out to 520 tiles, one point every 13 tiles.
Every coordinate is a multiple of 1/4, which is on the 1/256 capture grid.

| key      | the game's expression    |
| -------- | ------------------------ |
| `rv_sar` | `starting_area_radius`   |
| `rv_ebp` | `enemy_base_probability` |

Values are printed with `%.17g`, so they read back as the exact f32.

## What it found

- `starting_area_radius` is `f32(150 * f32(starting_area))`: 75, 112.5, 150, 300,
  450 and 900 for the six arms.
- The enemy field's `min(0, 20 / radius * distance - 20)` term follows it. With
  the right radius the port is exact at all 241 positions in every arm. With the
  old constant 150 it is exact at 241 / 174 / 174 / 102 / 36 / 0 positions
  (starting area 1, 0.5, 0.75, 2, 3, 6).
- Three of the nine built-in presets are not at starting area 1: both Death
  worlds carry 0.75 (radius 112.5) and Ribbon world 3 (radius 450). The
  Rust test `the_enemy_field_follows_the_games_starting_area_radius` and
  `test/startingAreaRadius.spec.ts` read the fixture this probe produces.
