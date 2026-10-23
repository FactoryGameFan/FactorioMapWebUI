# preview-tile-correction

Asks one question: does the game's map preview PNG show tiles before or after
tile correction (`TileCorrectionMapGenerationTask`, see
`docs/noise/tile-correction-NOTES.md`)?

```bash
node --experimental-strip-types scripts/probes/preview-tile-correction/capture.ts
```

Run it from the repository root. It runs Factorio 2.1.23 twice, through
`factorio-oracle`, and takes about 10 seconds. It writes
`test/fixtures/oracle-preview-tile-correction.json`. The header of
`capture.ts` explains the design.

## What it compares

For every tile in four 96 x 96 blocks, it reads three things:

- **raw** - the highest of the game's own tile scores. The scores come from
  `calculate_tile_properties` with the property name `tile:<name>:probability`.
  This property name works in 2.1.23. A second route, a data-stage copy of each
  tile's `autoplace.probability_expression`, returns the same value at every
  position, and the probe stops if they ever differ.
- **filled** - `get_tile` after the block and its neighbours are generated.
- **the PNG pixel** - from the committed terrain-only preview, matched to a tile
  through `map_color`.

All of it uses map seed 123456 and the derived surface seeds the PNGs use, with
the same terrain-only mod and the same disabled controls.

## Result (2026-10-22, 2.1.23 build 87750)

| block                             | tiles where filled and raw agree | PNG matches there | tiles where they differ | PNG shows raw | PNG shows filled |
| --------------------------------- | -------------------------------: | ----------------: | ----------------------: | ------------: | ---------------: |
| Nauvis, around (229, -19)         |                            9,177 |             9,177 |                      39 |            39 |                0 |
| Vulcanus, around (-361, 11)       |                            8,760 |             8,760 |                     456 |           454 |                0 |
| Fulgora control 1, chunk (-3, 11) |                            8,494 |             8,494 |                     722 |           722 |                0 |
| Fulgora control 2, chunk (-11, 0) |                            8,493 |             8,493 |                     723 |           717 |                0 |

The 8 remaining differing tiles fall where both tiles share one map colour, so
the PNG cannot tell them apart.

**The preview PNG does not run tile correction.** There are 1,940 tiles where
`get_tile` differs from the raw winner. The PNG shows the `get_tile` tile at
none of them. It shows the raw tile at 1,932, and the other 8 share a colour.
1,436 of the Fulgora ones lose by at least 0.001 in score, too wide for the two
noise kernels to explain, so those are tiles the game rewrote. The control
could have failed: a PNG that ran correction would show the filled tile there.
Where the two readings agree, the PNG matches every one of 34,924 tiles, so the
pixel grid and the colour table are right.

The two target pixels are not correction either. At both, the PNG draws the
game's own raw winner, and our scores differ from the game's:

| tile                | game's raw scores (top two)                               | ours, same point kernel                                   |
| ------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| Nauvis (229, -19)   | grass-1 1.3117774, grass-3 1.3117646                      | grass-1 1.3117714, grass-3 1.3117754                      |
| Vulcanus (-361, 11) | volcanic-cracks 0.3580069, volcanic-cracks-warm 0.3568015 | volcanic-cracks 0.3562072, volcanic-cracks-warm 0.3568015 |

The right column came from a one-off run of the engine at `At::point`, the same
kernel `calculate_tile_properties` uses. It is not committed. Task 1's grid
numbers are in `docs/noise/tile-correction-NOTES.md`.

The binary agrees. In 2.1.23 the preview worker's code calls
`BasicTilesMapGenerationTask::generateBasicTiles` directly and makes no direct
call to `TileCorrectionMapGenerationTask` or
`MapGenerator::correctAndSelectTileTransitions` (`objdump` over the
`MapPreviewGenerator` functions). That checks direct calls only.

## Arm B does not isolate a chunk

The design planned a second arm: generate one chunk alone, in a separate run,
so correction would have no neighbours to read. It does not work that way.
`is_chunk_generated` reports only that one chunk, even after reading its
neighbours. But its tiles equal arm A's at all 1,024 positions on Nauvis,
Vulcanus and Fulgora. In the Fulgora chunk, all 112 corrected control tiles
come back corrected. The game corrects a chunk generated alone, so this lever
cannot switch correction off. The neighbour chunks also return tiles that
mostly match arm A.

## Traps

- `table_to_json` writes `-inf` and `nan` as bare words. The Lua sends them as
  strings and `capture.ts` turns them back into numbers.
- Nauvis's own surface already holds chunks -7 to 6 from map creation, which
  touch the target's chunk. Both arms use a copy made with
  `game.create_surface(name, nauvis.map_gen_settings)`. Arm A checks the copy
  against the real surface over the whole block.
- `test/oracle/decodePng.ts` imports without a file extension, which bare Node
  does not resolve. `capture.ts` adds a small resolve hook rather than editing
  that file.
