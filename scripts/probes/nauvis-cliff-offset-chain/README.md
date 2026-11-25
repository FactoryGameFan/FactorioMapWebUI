# nauvis-cliff-offset-chain

Reads the game's Nauvis cliff-offset chain and its cliffiness gate at the
corners where the old f64 chain and the game's per-step f32 chain disagree, so
the port can be graded against the game at the places that matter.

```bash
python3 -I scripts/probes/nauvis-cliff-offset-chain/capture.py /tmp/w \
  /home/eric/factorio-headless/2.1.23/factorio
```

It runs `~/.cargo/bin/factorio-oracle` six times (about 10 seconds each) and
writes `test/fixtures/oracle-nauvis-cliff-offset-gate.2.1.23.json`. Check the
runs' `buildLine`: the script asserts it reads
`Version: 2.1.23 (build 87750, linux64, headless)`.

## What it reads

Six cases: seeds 123456, 777771 and 1, each at water frequency 1 (the default)
and 3. One `calculate_tile_properties` call per case reads
`nauvis_hills_offset_raw_x`, `nauvis_hills_offset_raw_y`, `nauvis_hills_offset`,
`nauvis_cliff_ringbreak` and `cliffiness_nauvis` at:

- the 19 **flip corners**, listed in `FLIPS` in the script. These are corners of
  the 4-tile cliff lattice (tile = 4 x lattice index) where the f64 chain and
  the f32 chain disagree on whether `cliffiness_nauvis` is 0 or 10. They came
  from scanning a 2048 x 2048 lattice (8192 x 8192 tiles) per case with both
  builds of the port. At the default water frequency there are 0, 1 and 0 of
  them; at frequency 3 there are 9, 4 and 5;
- a 5 x 5 spread of ordinary lattice corners per case. None of the indices is a
  round number, because round coordinates make the f32 and f64 products agree.

## What it found

The chain from `nauvis_hills_offset_raw_x` to the ringbreak is f32 at every step
in the game:

- the point kernel computes `(x + offset) * scale` as `addss; mulss`
  (0x2519d3a-0x2519d48 in 2.1.23), with `scale = f32(nauvis_seg / 500)`;
- the warp is `x + 12 * normalized`, and `normalize` is `primary / sqrt(bias +
  primary * primary + secondary * secondary)`, each operation rounded to f32;
- the ringbreak is `abs(hills - hills_offset)`.

The port had all of it in f64. Narrowing only the coordinate product fixed the
raw columns but left `hillsOffset` and `ringbreak` at 30 and 32 of 38 on the
2.1.11 fixture. Narrowing every step gives 38 of 38 on all four columns at both
seeds, and the game's gate answer at all 19 flip corners. The old chain matches
0 of 19.
