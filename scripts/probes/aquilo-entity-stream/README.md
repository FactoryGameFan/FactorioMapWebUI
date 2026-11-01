# aquilo-entity-stream

Captures Aquilo's real surface near the origin: which tiles are land and which
are water, which chunks were generated, and every well and iceberg the game
placed. A Rust test replays the game's per-chunk entity stream against this
surface and must place every entity in the same spot (#492). A real surface
runs tile correction, which our resolver does not, so the replay needs the
game's own land and water.

```bash
node --experimental-strip-types scripts/probes/aquilo-entity-stream/capture.ts
```

Run it from the repository root. It takes about 10 seconds and runs two games
through `factorio-oracle`, each with `--factorio` and `--version`. It stops
unless each report's `buildLine` names the version asked for. It writes
`test/fixtures/oracle-aquilo-surface.seed123456.json`.

## What it does

1. **Data stage.** Removes `created_effect` from `crude-oil`,
   `lithium-brine` and `fluorine-vent`. That effect rewrites tiles near each
   well during map generation. The stream must be replayed on the tiles from
   before the rewrite, so this is the "stripped arm" of
   `scripts/probes/aquilo-fields`.
2. **Surface.** `game.planets["aquilo"].create_surface()`. The seed must read
   back as 3111923328 (map seed 123456) and the three controls
   (`aquilo_crude_oil`, `lithium_brine`, `fluorine_vent`) as 1/1/1.
3. **Generate.** `request_to_generate_chunks({0, 0}, 8)`, then
   `force_generate_chunk_requests()`.
4. **Read.** `get_tile(x, y).name` for every tile with x and y in
   -320..319, `is_chunk_generated` for every chunk in -10..9, and every
   `resource` and `simple-entity` on the surface with no area filter.
5. **Check.** Both versions must return the same land, tile counts, chunks
   and entities. The census region (tiles -256..255), read with the census's
   own query, must equal `oracle-aquilo-entities.seed123456.json`. Otherwise
   nothing is written.

## Fixture shape

- `window` is the tile square read: `x0`, `y0`, `width`, `height`.
- `tileLegend` names the nine tiles. The first six (snow and ice) are land.
  The last three (`brash-ice` and both oceans) are water. Every tile read
  must be one of them.
- `land` has one row per y, from -320 down. Each row is a list of run
  lengths: water, land, water, and so on, always starting with water. A row
  that starts on land begins with 0. Each row sums to 640.
- `tileCounts` counts each tile name over the window.
- `generatedChunks` lists each `[cx, cy]` that `is_chunk_generated` says is
  done, sorted.
- `entities` lists every entity as `[name, x, y]`, sorted by name, x, y.
  `totals` counts them by name.

## Result (2026-10-31, 2.1.23 build 87750 and 2.0.77 build 84539)

- **The two versions agree** on land, tile counts, generated chunks, and every
  entity's name, position and amount.
- **Re-running wrote a byte-identical file** (`cmp`).
- **209 entities**: 11 `crude-oil`, 4 `lithium-brine`, 4 `fluorine-vent`, 168
  `lithium-iceberg-big`, 22 `lithium-iceberg-huge`. The 10 beyond the census
  are all icebergs. No well stands outside tiles -256..255.
- **289 chunks were generated**, exactly -8..8. The outer ring (-10, -9 and 9)
  still returns real tile names, never `out-of-map`.
- **Land is 10,741 of 409,600 tiles** (2.6%). `brash-ice` is 5,507,
  `ammoniacal-ocean` 202,103 and `ammoniacal-ocean-2` 191,249.
- **An area query matches by bounding box, not by position.** The census's
  query over tiles -256..255 finds 199 entities and matches the census
  exactly. Only 198 of them stand inside that square. The 199th is the
  `lithium-iceberg-big` at (-56.8125, 256.6875), whose box reaches back over
  the edge. So "199 inside" means "199 found by the area query".
