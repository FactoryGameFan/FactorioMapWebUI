# gleba-real-surface

Reads the tiles a real Gleba surface places, so the engine's Gleba terrain can
be graded against what a player's map shows (#454). It reads Nauvis too
(`FMW_PLANET`, below).

```bash
node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
FMW_CHUNK_ORDER=columns \
  FMW_OUT=test/fixtures/oracle-gleba-real-surface-columns.seed123456.json \
  node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
FMW_PLANET=aquilo node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
```

`FMW_PLANET` picks the planet (`gleba` by default, or `aquilo`); the fixture is
then `test/fixtures/oracle-<planet>-real-surface.seed123456.json`. Each planet
disables the controls its own terrain PNG disabled.

Run it from the repository root. Each run starts Factorio 2.1.23 once, through
`factorio-oracle`, and takes about 2 seconds. The first command writes
`test/fixtures/oracle-gleba-real-surface.seed123456.json`, the second the
columns arm beside it. Set `FMW_FACTORIO_2_1_23` to the install's root folder if
it is not at `/home/eric/factorio-headless/2.1.23/factorio`.

`FMW_PLANET` picks another planet (`gleba` by default; `nauvis`, `aquilo` and
`fulgora` are wired too), and `FMW_X0`, `FMW_Y0` and `FMW_SIDE` move and size
the window (default -128, -128, 256; chunk aligned). The Nauvis fixtures:

```bash
FMW_PLANET=nauvis node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
FMW_PLANET=nauvis FMW_X0=384 FMW_Y0=-320 \
  FMW_OUT=test/fixtures/oracle-nauvis-real-surface-coast.seed123456.json \
  node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
```

**Nauvis uses a fresh surface**, not the game's own `nauvis` surface: that one
generates its spawn chunks before `on_init` runs, so the disabled controls do
not reach them (a first try read 1,645 ore and stone entities in the window).
The fresh surface takes the `nauvis` surface's map-gen settings and the map
seed, and `pregenerated` is empty.

A tile that may not touch some candidates (`allowed_neighbors`, made symmetric
by the game) lists them under `notAllowed` in `tiles`. Nauvis has 38 such
pairs: `deepwater` against each of the 19 land tiles, both ways round.

`FMW_MARGIN_CHUNKS` sets the chunks requested around the window (default 2).
Fulgora's three fixtures:

```bash
FMW_PLANET=fulgora FMW_MARGIN_CHUNKS=6 \
  FMW_OUT=test/fixtures/oracle-fulgora-real-surface-radius10.seed123456.json \
  node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
FMW_PLANET=fulgora node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
FMW_PLANET=fulgora FMW_CHUNK_ORDER=rows \
  FMW_OUT=test/fixtures/oracle-fulgora-real-surface-rows.seed123456.json \
  node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
```

The rows arm's order is decoded now: see "Fulgora, and the order near the edge
of a request" in `docs/noise/tile-correction-NOTES.md`. Correction within about
two chunks of the requested area's edge depends on where that edge is, so a
wider margin reads the window as the inside of a generated area.

**Vulcanus** (`FMW_PLANET=vulcanus`) disables the four ore controls as its
terrain PNG did. Its fixtures:

```bash
FMW_PLANET=vulcanus node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
FMW_PLANET=vulcanus FMW_CHUNK_ORDER=each \
  FMW_OUT=test/fixtures/oracle-vulcanus-real-surface-each.seed123456.json \
  node --experimental-strip-types scripts/probes/gleba-real-surface/capture.ts
```

Lava and lava-hot may touch only each other: 34 pairs, both ways round. On Vulcanus
the `columns` arm equals `radius` at every tile, and `radius` and `each` (chunks
made strictly one at a time) are each reproduced at every tile in the game's request order.

## What it reads

Map seed 123456 and Gleba's own `create_surface()`, so the surface seed is the
derived one, 3215206427. The same terrain-only data-stage mod and the same
disabled controls as the terrain preview PNG. None of those controls reaches a
terrain field. The script refuses to write if any entity is left in the window.

It generates the window -128..127 and a margin of at least two chunks, then
reads `get_tile(x, y).name` at every tile. It also reads each tile's
`map_color` and effective `layer` from the prototypes at runtime. The surface
holds no chunk before the first request (`pregenerated` is empty).

## Why a real surface

A real surface runs `TileCorrectionMapGenerationTask` after the tile argmax
(`docs/noise/tile-correction-NOTES.md`). The game's map preview PNG does not.
Eric chose the real surface as the target on 2026-11-26: the engine should show
what the map will actually look like.

## The order chunks are made in changes the map

Tile correction reads and writes the chunks around the one it corrects, so the
result depends on the order the chunks are corrected in. `FMW_CHUNK_ORDER`
picks how the chunks are requested. Tiles that differ in the 65,536-tile window,
measured 2026-11-26:

| arm (`FMW_CHUNK_ORDER`)                       | vs `radius` | vs `rows` |
| --------------------------------------------- | ----------: | --------: |
| `radius`: one request, radius 6 (the fixture) |           0 |        16 |
| `columns`: chunk by chunk, x outer, y inner   |           0 |        16 |
| `rows`: chunk by chunk, y outer, x inner      |          16 |         0 |
| `each`: `rows`, forcing each chunk at once    |          16 |         0 |
| `reverse`: `rows` backwards                   |         450 |       446 |

So a game start, which asks for its spawn area with one radius request, gives
the columns result. The engine corrects in columns order and matches the
`radius` and `columns` captures at every tile. It does not reproduce `rows`
(16 tiles off, near two chunk corners): a row-by-row request does not correct
in strict row order, and the order it does use was not decoded. A probe that
stopped a row-by-row run part way found chunks generated well beyond the
neighbours of the ones requested.

A player who explores in some other order can get a slightly different map, by
up to a few hundred tiles in this window. No preview can know that order.

The fixture is compact: each row is a string with one character per tile,
indexing `names` through `alphabet`.
