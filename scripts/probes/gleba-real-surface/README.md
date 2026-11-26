# gleba-real-surface

Reads the tiles a real Gleba surface places, so the engine's Gleba terrain can
be graded against what a player's map shows (#454).

```bash
node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
```

Run it from the repository root. It runs Factorio 2.1.23 once, through
`factorio-oracle`, in about 2 seconds, and writes
`test/fixtures/oracle-gleba-real-surface.seed123456.json`. Set
`FMW_FACTORIO_2_1_23` to the install's root folder if it is not at
`/home/eric/factorio-headless/2.1.23/factorio`.

## What it reads

Map seed 123456 and Gleba's own `create_surface()`, so the surface seed is the
derived one, 3215206427. The same terrain-only data-stage mod and the same
disabled controls as the terrain preview PNG. None of those controls reaches a
terrain field. The script refuses to write if any entity is left in the window.

It generates every chunk of the window -128..127, plus two chunks of margin, and
then reads `get_tile(x, y).name` at every tile. It also reads each tile's
`map_color` and `layer` from the prototypes at runtime.

## Why a real surface

A real surface runs `TileCorrectionMapGenerationTask` after the tile argmax
(`docs/noise/tile-correction-NOTES.md`). The game's map preview PNG does not.
Eric chose the real surface as the target on 2026-11-26: the engine should show
what the map will actually look like.

The fixture is compact: each row is a string with one character per tile,
indexing `names` through `alphabet`.
