# bearing-chain

Reads the game's own seed-derived bearing values on 606 map seeds, so the port's
formulas can be graded against the game instead of against each other (#531).

```bash
python3 scripts/probes/bearing-chain/make_chain_probe3.py /tmp/w/probe
~/.cargo/bin/factorio-oracle run --probe /tmp/w/probe/probe.json \
  --work-dir /tmp/w/work --factorio <2.1.23 headless install> --version 2.1.23
```

The script takes one optional argument, the folder to write `probe.json` and
`control.lua` into. The oracle writes `oracle-dump.json` under
`/tmp/w/work/write/script-output/`. Check the run's `buildLine` first: it must
read `Version: 2.1.23 (build 87750, linux64, headless)`.

`test/fixtures/oracle-bearing-chain.seeds606.json` holds that dump as `rows`,
wrapped with a `_comment`. The rows are the game's values and were not edited.

## What it reads

600 random seeds (`random.Random(7531)`) and six edge seeds: 0, 1, 2,
4294967295, 16777217 and 4294967294. Each seed gets its own surface
(`game.create_surface` with that seed), and one `calculate_tile_properties` call
at (0, 0) reads 12 noise expressions that copy the Vulcanus definitions in
`planet-vulcanus-map-gen.lua`:

| key        | the game's expression                               |
| ---------- | --------------------------------------------------- |
| `msn`      | `map_seed_normalized`                               |
| `dir`      | `-1 + 2 * (map_seed_small & 1)`                     |
| `ash`      | `map_seed_normalized * 3600`                        |
| `mtn`      | `ash + 120 * dir`                                   |
| `bas`      | `ash + 240 * dir`                                   |
| `prot_deg` | `mtn + 180 * dir`                                   |
| `bas_sin`  | `sin(bas / 180 * pi)`, and `bas_cos` for cosine     |
| `prot_sin` | `sin(prot_deg / 180 * pi)`, and `prot_cos` likewise |
| `fg_deg`   | `map_seed / 360`                                    |
| `fg_sin`   | `sin(map_seed / 360 / 180 * pi)`                    |

Every value is an f32, printed with `%.17g`, so it reads back exactly.

## What it found

- `map_seed_normalized` is `f32(seed / (2^32 - 1))`. The port's `/ 2^32` matched
  601 of 606; the game's form matches all 606.
- Fulgora's bearing holds `map_seed` as an f32 before dividing:
  `f32(f32(seed) / 360)`. The port's `f32(seed / 360)` matched 463 of 606.
- The Vulcanus protector bearing is narrowed: `f32(mountains + 180 * direction)`.
  The port left the sum unrounded and matched 567 of 606.
- The sines and cosines are the game's own polynomial (`src/noise/gameTrig.ts`),
  not libm.
