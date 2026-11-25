# enemy-spot-spacing

Reads the game's own full `enemy_base_probability` on Nauvis, so the spot-noise
candidate spacing can be graded against the game over the whole expression.

```bash
python3 -I scripts/probes/enemy-spot-spacing/capture.py \
  /home/eric/factorio-headless/2.1.23/factorio
```

It runs `~/.cargo/bin/factorio-oracle` four times and writes
`test/fixtures/oracle-enemy-base-full.2.1.23.json`. The script asserts every run
reads `Version: 2.1.23 (build 87750, linux64, headless)`.

## What it reads

Two seeds (123456 and 777771), each on a `create_surface()` surface with the seed
forced. At each of 16,384 positions (a 128 x 128 grid, 16-tile pitch, over
[-1024, 1024)) one `calculate_tile_properties` call reads:

- `full`: the game's named `enemy_base_probability`, nothing redefined;
- `full_45`: the same expression text redefined with
  `suggested_minimum_candidate_point_spacing = 45.254833995939045`. It is the
  control. It shows the redefinition is faithful, so the old spacing and the
  game differ in spacing alone. The fixture stores it as the positions where it
  differs from `full` (579 and 836 of them).

## What it found

The game never gets the spacing from `32 * sqrt(2)`. `SpotNoise::compile`
(0x307033d in 2.1.23, the same code in 2.0.77 and 2.1.25) derives it from the
count: `f32(0.5 * sqrt(u32(region_size * region_size) / count))`. For the
enemy-base field that is `f32(0.5 * sqrt(2621))` = 25.597850799560547.

The port used 45.254833995939045 and matched 15,805 and 15,548 of 16,384
positions. With the derived spacing it matches all 16,384 at both seeds. The
2.1.11 enemy fixture scores the same at both spacings, so it could not see this.
