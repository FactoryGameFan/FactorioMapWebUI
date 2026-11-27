# gleba-entities

Reads the stone and the two stromatolites a REAL Gleba surface places, so the
engine's Gleba resource overlay can be graded against what a player's map
holds (#454, slice 3).

```bash
node --experimental-strip-types scripts/probes/gleba-entities/capture.ts
FMW_ARM=default node --experimental-strip-types scripts/probes/gleba-entities/capture.ts
```

Run it from the repository root. Each run starts Factorio 2.1.23 once, through
`factorio-oracle`, and takes about 4 seconds. Set `FMW_FACTORIO_2_1_23` to the
install's root folder if it is not at `/home/eric/factorio-headless/2.1.23/factorio`.
`FMW_OUT` writes somewhere else; `FMW_X0` and `FMW_SIDE` move and size the
window (default -512 and 1024, chunk aligned).

## The two arms

| arm                | controls                                                                         | writes                                                             |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `graded` (default) | `gleba_plants`, `gleba_enemy_base` and `gleba_cliff` at size 0, cliff richness 0 | `test/fixtures/oracle-gleba-real-surface-entities.seed123456.json` |
| `default`          | every control at its default: the map a player gets                              | `...-entities-default.seed123456.json`                             |

Both use map seed 123456, Gleba's own `create_surface()` (so the derived
surface seed 3215206427), no data-stage mod, and ONE
`request_to_generate_chunks` at (16, 16) with radius 18: the window -512..511
and two chunks of margin, the way a game start asks for its spawn area.

The graded arm turns off only what it does not grade. Plants, nests and cliffs
can block a stromatolite when the queue is applied, and the port does not
place them yet, so with them on the graded entities would depend on layers the
engine cannot see. The default arm measures how much that matters.

## What it reads

- Every `stone`, `iron-stromatolite` and `copper-stromatolite` whose tile is in
  the window or the one-tile ring around it, at its exact position in 1/256
  tile. The ring is there because a stromatolite's box reaches one tile past
  its own, so one just outside can cover a window tile. `counts` and `census`
  are the window alone.
- A census of every entity name in the window. The graded arm refuses to write
  if anything else is there.
- (graded arm) Every entity autoplacer the surface runs, read from the
  prototypes at runtime: autoplace `order`, control, flags, collision and
  map-gen boxes, collision layers, tile restrictions. And the collision layers
  of every Gleba tile. These are what the per-chunk generator sorts and tests.
- (graded arm) Eleven fields through `calculate_tile_properties`, as f32 hex
  bits, at 2,560 positions: 512 from a fixed 65,536-position scout pool, 512
  more where each stromatolite probability is above 0, and 1,024 around the
  placed stone (each stone's tile corner and the eight corners around it; 512
  with `gleba_stone_richness` above 0, 512 without).

Re-running either arm writes a byte-identical file.

## What it found (2026-11-26)

|                       | graded | default |
| --------------------- | -----: | ------: |
| `copper-stromatolite` |  1,846 |   1,845 |
| `iron-stromatolite`   |  2,484 |   2,484 |
| `stone`               |    863 |     863 |

- **The autoplace order.** Both stromatolites have the empty `order`, so they
  share one group and are the FIRST group the chunk's stream serves. Then come
  the twelve plants (`a[tree]-...`), then `stone` (`b`), then the two nests
  (`b[enemy]-...`). Stone is the only resource on Gleba.
- **The tile layers.** Every land tile is `ground_tile`; the nine `wetland-*`
  tiles are `floor, resource, water_tile`; the deep lake adds `doodad, item,
  player`. The stromatolites' mask holds `ground_tile` and `player`, so they
  stand only on wetland; stone's is `resource`, so it stands only on land.
- **The two arms differ by one entity.** The default map is missing one copper
  stromatolite, at (134.5, -479.625). Its box reaches up to y = -480.125, past
  the chunk edge at -480, and a water-cane at (134.375, -480.125) stands there.
  The water-cane belongs to the chunk above, which is applied first. So plants,
  nests and cliffs together remove 1 of 5,193 graded entities in this window.
  The scratch probe that listed the entities around that point was not kept.

The engine reproduces the graded arm exactly (5,193 of 5,193 at the game's
positions); see "Gleba (#454), slice 3" in `docs/rust-wasm-port.md`.
