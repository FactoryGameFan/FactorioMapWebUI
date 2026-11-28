# aquilo-real-surface-entities

Captures every well and iceberg on a real Aquilo surface over the app's
default window, tiles -512..511 at map seed 123456. The engine's `all`,
`resources` and `rocks` views are graded against it (#553).

```bash
node --experimental-strip-types scripts/probes/aquilo-real-surface-entities/capture.ts
```

Run it from the repository root. It takes about 10 seconds and runs Factorio
2.1.23 twice through `factorio-oracle`, with `--factorio` and `--version`. It
stops unless each report's `buildLine` names 2.1.23. It writes
`test/fixtures/oracle-aquilo-real-surface-entities.seed123456.json`.

## What it does

1. **Surface.** `game.planets["aquilo"].create_surface()`. The seed must read
   back as 3111923328 (map seed 123456) and the three controls
   (`aquilo_crude_oil`, `lithium_brine`, `fluorine_vent`) as 1/1/1. No chunk
   may exist before the request.
2. **Generate.** One `request_to_generate_chunks({16, 16}, 18)`, then
   `force_generate_chunk_requests()`: the window and two chunks of margin, the
   way a game start asks for its spawn area.
3. **Read.** Every `resource` and `simple-entity` whose tile,
   `floor(position)`, is in the window or within 3 tiles of it, at its exact
   position; every chunk `is_chunk_generated` reports; and `get_tile` at every
   tile of the window. The window may hold nothing else but the wells'
   `aquilo-tiles-*-explosion` entities.
4. **Two arms.** The first run has no data-stage mod: the map a player gets.
   The second removes `created_effect` from the three wells. Both must place
   the same entities and generate the same chunks, or nothing is written. The
   tiles that differ between them are the wells' tile rewrite; the fixture
   keeps only their count.

## Result (2026-11-27, 2.1.23 build 87750)

- **635 entities in the window**: 60 `crude-oil`, 16 `fluorine-vent`, 51
  `lithium-brine`, 460 `lithium-iceberg-big`, 48 `lithium-iceberg-huge`. Two
  more stand in the 3-tile ring. 1,369 chunks report generated, -18..18.
- **The map preview queues 1,501 in the same window** (`--report-quantities`,
  run through `scripts/probes/real-surface-counts/capture.py`'s functions on
  2026-11-27), 2.4 times as many: 61 crude oil, 52 lithium brine, 19 vents, 59
  huge and 1,310 big icebergs. Over -256..255 it is 551 against 198. The
  preview skips the apply step and reads the raw tiles.
- **The wells' tile rewrite moves no entity.** The two arms agree on every
  entity and chunk. It rewrites 2,756 tiles of the window, 2,120 of them
  outside every well's 3 x 3 footprint, at most 5 tiles from a well. The
  outer explosion is a random `cluster` of seven, so the engine cannot
  reproduce it and does not draw it.
- **Re-running it wrote a byte-identical file** (`cmp`).
