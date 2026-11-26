# real-surface-counts

Counts the entities the overlays draw in the game's two pictures of a map, in
the same window: its map preview and a real generated surface.

```bash
python3 -I scripts/probes/real-surface-counts/capture.py \
  /home/eric/factorio-headless/2.1.23/factorio
```

It writes `test/fixtures/oracle-entity-counts-preview-vs-real.2.1.23.json` in
about 10 seconds. It checks that `factorio --version` prints
`Version: 2.1.23 (build 87750, linux64, headless)` and that every run's log
names the same build.

## The two pictures

- **The map preview** is the image on the new-game screen. The game rolls every
  tile and draws every entity the roll accepts. It never runs `apply`, so
  entities that overlap all stay. `--report-quantities` prints how many it
  queued.
- **A real surface** is what a player finds after the game starts. After the
  roll, `apply` drops any entity whose box hits one already placed, including
  trees and rocks. The script force-generates every chunk the window touches
  and counts the entities whose tile, `floor(position)`, lies in the window.
  That is the rule the app's count uses. `count_entities_filtered{area}` would
  also count an entity whose box only touches the window from outside. At
  these windows both rules give the same counts.

The overlays target the real surface. That was decided on 2026-11-25, and
`crates/fmw-noise/src/placement/real_surface_counts.rs` keeps it that way.

## What it reads

Map seed 123456, default settings, origin-centred windows:

| planet   | window | entities                                                |
| -------- | -----: | ------------------------------------------------------- |
| Nauvis   |   1024 | biter and spitter spawners, huge/big/big-sand rock, oil |
| Vulcanus |    256 | the four volcanic rocks, sulfuric-acid geyser           |
| Fulgora  |    512 | scrap                                                   |

The windows are as large as the Rust test can afford in a debug build.
Vulcanus's fields cost about 15 times Nauvis's per tile.

Nauvis is the save's own surface, whose seed is the map seed. Vulcanus and
Fulgora are `create_surface()` surfaces with no seed forced. The game derives
their seed, and the script asserts it is `(map seed + crc32(name)) mod 2^32`,
the seed the preview and the app use. Older Vulcanus fixtures force the RAW
seed instead, so they do not describe the surface a real save would make.

## What it found

| entity (window)      | preview |  real |   app |
| -------------------- | ------: | ----: | ----: |
| spawners (1024)      |     533 |    47 |    75 |
| Nauvis rocks (1024)  |   1,281 |   810 |   841 |
| crude oil (1024)     |      19 |    13 |    12 |
| Vulcanus rocks (256) |     618 |   317 |   282 |
| geysers (256)        |      22 |    19 |    18 |
| scrap (512)          |   1,675 | 1,664 | 1,602 |

The preview shows about 11 times the spawners a real surface gets. The app is
closer to the real surface for every overlay. Spawners are still 60% high,
which is #16: `apply` also tests a spawner against trees and rocks, and across
chunks, while the app tests it against spawners in its own chunk only.

Two other seeds (1 and 987654321) were measured over `[-512, 512)^2` on all
three planets and show the same pattern, except scrap. There the two pictures
differ by under 2%, the app sits 4-7% from both, and at those two seeds it is
slightly closer to the preview. That is why the scrap test is a bound against
the real surface and not a closer-to test.
