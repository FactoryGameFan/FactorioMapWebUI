# How the game places autoplaced entities - `generateEntities` (2.1.23)

Reverse-engineered 2026-10-31 for #492 from the Factorio **2.1.23 Linux
headless** build (build 87750), which ships DWARF debug info. DWARF is the
debug data that maps machine code back to source files and lines. Every
`file.cpp:line` below comes from those line records, so it names the game's
own source.

This file replaces the open parts of `placement-roll-NOTES.md`. That file is
the history: a 2.1.11 macOS read from 2026-07-20, with no source lines, and
the salted-roll design the other planets still ship. Read it for why things
were built as they were. Read this one for what the game does.

**Marks.** "READ" means seen in the code. "INFERRED" means a conclusion drawn
from code that was read, but not traced instruction by instruction.
"MEASURED" means checked against game output, with the test named.

Where it is used: `crates/fmw-noise/src/placement/generate.rs` (the model, in
its module docs) and `crates/fmw-noise/src/placement/aquilo.rs` (Aquilo's five
autoplacers). Aquilo is the only planet that runs it so far, because it is the
only planet whose every entity autoplacer is ported.

## How it was read

Binary:
`/home/eric/Projects/factorio-oracle/installs/factorio-headless-2.1.23/factorio/bin/x64/factorio`.

The method is disassembly plus DWARF line and inlining records:
`objdump -d -C -M intel` for the code, and `llvm-symbolizer --inlining` for
the inlined call chain and source line of each instruction. The helper script
that joins the two is in the appendix at the end of this file. The annotated
dumps it made were scratch files and are not kept; the script remakes them
from the addresses in the next table.

## Functions and addresses

| function | address | size |
| --- | --- | --- |
| `EntityMapGenerationTask::generateEntities(NoiseCache&)` | `0x1989690` | 3358 |
| `EntityMapGenerationTask::computeInternal()` | `0x1986d40` | 9199 |
| `EntityMapGenerationTask::apply(Surface&)` (inlines `applyEntities`) | `0x198ada0` | 5136 |
| `EntityMapGenerationTask::buildArea(Surface&)` | `0x19860a0` | 1995 |
| `CompiledMapGenSettings::prepareAutoplacers<EntityPrototype>` | `0x20b22d0` | 3105 |
| `NoiseProgram::getChunkNoiseCache(ChunkPosition const&)` | `0x1989130` | 1307 |
| `EntityPrototype::buildPosition(MapPosition const&, Direction)` | `0x16bd810` | - |
| `AutoplaceSpecification::AutoplaceSpecification(PropertyTree const&, string const&, string const&)` | `0x3090ce0` | 2868 |

`generateEntityOnTile`, `tryToAddEntity`, `wouldCollide` and `isInArea` have
no symbols of their own in this build. They are fully inlined into
`generateEntities`. DWARF still names them (`EntityMapGenerationTask.cpp:512-610`).

Below, `cpp:N` is short for `EntityMapGenerationTask.cpp:N`.

## 1. Collecting and grouping autoplacers

**Resources are NOT a separate path (READ).** `generateEntities` has exactly
3 call sites, all in `computeInternal` (`0x1987b7a`, `0x1987b99`,
`0x1987bb8`, cpp:144/152/147). A task-mode byte at `this+0x10` picks one.
Normal map generation is mode 0: cpp:147 calls `generateEntities`, then
`generateDecoratives` (cpp:289) with its own fresh random generator. No
`generateResources` or similar symbol exists. The only other resource placer
is the map editor's `ResourceEditor::tryPlaceResource`. Resources, rocks,
trees and enemies all share one list, one loop and one random stream.

**The list (READ).** `generateEntities` reads the vector at
`CompiledMapGenSettings+0x1f8` (`[this+0x70]+0x1f8`, cpp:369), unless the
pointer at `this+0x80` is non-null (an override list, used by mode 1, the
regenerate path). `CompiledMapGenSettings::compile` fills `+0x1f8` by calling
`prepareAutoplacers<EntityPrototype>` (at `0x20ae71f`). Each entry is 16
bytes: `{EntityPrototype*, probability register u32 (+8), richness register
u32 (+0xc)}` (cpp:376-377).

`prepareAutoplacers<EntityPrototype>` (`CompiledMapGenSettings.cpp:176-222`)
walks every `EntityPrototype`. It skips any whose `autoplace` (`proto+0x470`)
is null (:179), and any whose frequency, size or richness from the map-gen
settings is "none" (:182-188, `getAutoplaceFrequencySizeRichness`). Then it
**sorts** them (:194) with `AutoplaceSpecification::operator<`
(`AutoplaceSpecification.hpp:31-35`). That is a three-key compare by raw bytes
(`memcmp`, a shorter prefix sorts first):

1. `spec+0x1a0`: the constructor's 3rd argument. It is the literal `"entity"`
   for every entity (`EntityPrototype.cpp:388`, built inline as
   `0x69746e65`/`0x7974`), so it is constant here.
2. `spec+0x10`: **`order`** (`AutoplaceSpecification.cpp:66` reads the key
   `"order"`).
3. `spec+0x180`: the constructor's 2nd argument, the **prototype name**
   (`proto+0x8`).

The sort is `std::sort` (introsort, not stable), but names are unique, so the
order is total.

**Groups (READ).** In `generateEntities`, after one autoplacer is done
(cpp:420-424, `0x1989bc7..0x1989c95`), the next entry's `order`
(`spec+0x10`/`+0x18`) is `memcmp`'d against the current one. If they are
equal, the next autoplacer joins the same group: its arbitration continues
into the same per-tile buffers. If they differ, or the list ends, the group so
far is rolled. **The group key is exactly the autoplace `order` string.** It
is not the type, and not whether the entity is a resource.

Aquilo at 2.1.23, in ascending byte order (5 groups, one autoplacer each):

| # | order | entity | type | placeable-off-grid |
| --- | --- | --- | --- | --- |
| 1 | `a[resources]-a[fluorine]` | fluorine-vent | resource | no |
| 2 | `a[resources]-b[lithium]` | lithium-brine | resource | no |
| 3 | `a[rock]-a[huge]` | lithium-iceberg-huge | simple-entity | yes |
| 4 | `a[rock]-b[big]` | lithium-iceberg-big | simple-entity | yes |
| 5 | `c` | crude-oil (the base prototype; Aquilo overrides only its expressions) | resource | no |

`a[resources]` sorts before `a[rock]` because `e` (0x65) is below `o` (0x6f).
The planet's `autoplace_settings.entity` lists exactly these 5
(`planet-map-gen.lua:479-488`).

## 2. Within a group: arbitration (READ, cpp:378-416)

Per chunk there are three buffers of N = 1024 entries (the `NoiseCache` size,
`[cache+0x10]`): `best[i]` (float) starts at -inf (cpp:366-367,
`0xff800000`), `winner[i]` (prototype pointer) starts null (:364), and
`bestRich[i]` (float) starts at 0 (:365).

For each autoplacer in the group, for `i = N-1` down to 0 (cpp:378,
`dec r12`):

1. Find the tile `(tx, ty) = (floor(x[i]), floor(y[i]))` (:380). Look it up
   in the 96 by 96 working area: the chunk plus 32 tiles on each side, copied
   from the surface by `buildArea` (cpp:101-103). If that tile's collision
   mask collides with the prototype's `collision_mask` (`proto+0x2f0`), skip
   (:381-393). Only the one tile under the position is tested here, not the
   box.
2. Win if `prob[i] > best[i]`, or if `prob[i] == best[i]` and
   `rich[i] > bestRich[i]` (:394, `ucomiss`; a NaN never wins). Otherwise
   skip.
3. If the spec has `tile_restriction` entries (`spec+0x140..0x148`), the tile
   (and its neighbours, for transition pairs) must satisfy one (:395,
   `AutoplaceSpecification.cpp:127-191`). With no restriction, this passes.
4. Store `best[i] = prob[i]`, `winner[i] = proto`, `bestRich[i] = rich[i]`
   (:414-416).

Because `best` starts at -inf, **any finite probability wins an empty tile**,
including 0 and negative values. So `winner[i]` is set on every tile that
passes the tile-mask and tile-restriction checks, whatever its probability.

Ties: when probability and richness are both equal, the first autoplacer in
sorted order (by name) keeps the tile, since the compare is a strict `>`.

## 3. The roll loop (READ, cpp:426-470)

After a group's arbitration, for `i = N-1` down to 0 (the same decreasing
index):

- `winner[i]` is null: **no draw**. Reset and continue (cpp:433).
- `placement_density == 0` (`spec+0x30`, `AutoplaceSpecification.cpp:65`, key
  `"placement_density"`, default 1): no draw (cpp:441).
- Otherwise, for `attempt in 0..placement_density` (cpp:441): draw `U`
  (cpp:442, `RandomGenerator::uniformDouble`, `RandomGenerator.cpp:78`). If
  `(double)best[i] > U`, call `generateEntityOnTile` (cpp:450). The loop does
  not stop after a success.
- Then reset `best[i] = -inf` and `winner[i] = null` (cpp:469-470).
  `bestRich` is NOT reset. That matters only for a -inf tie (see "What is not
  settled").

So per group, draws = (tiles with a winner) times `placement_density`, plus
jitter draws. **A tile whose probability is 0 (or negative) still uses a
draw**, as long as it passed the mask and restriction checks.

`U = taus88() * 2^-32` as a double (the constant at `0xffb878` is
2.3283064365386963e-10). Place if and only if `prob > U`, strictly.

## 4. Seeding the random stream (READ)

`newRandomGenerator()` (`EntityMapGenerationTask.hpp:88`) runs at cpp:358,
once per `generateEntities` call:

```
w = 0x3FBE2C + 7919 * chunkX + 7907 * chunkY      (u32: imul 0x1eef, imul 0x1ee3)
w = (w < 342) ? 341 : w                             (RandomGenerator.cpp:16)
s1 = s2 = s3 = w
```

There is no map seed, no salt, and no re-seeding between groups. **One stream
per chunk, shared by every group in sorted order.** The `ChunkPosition` is
`this+0x60`/`+0x64`. The map seed reaches placement only through the
probability fields.

The taus88 step (`RandomGenerator.cpp:83-89`) is the standard one:

```
b = ((s1 << 13) ^ s1) >> 19;  s1 = ((s1 & 0xFFFFFFFE) << 12) ^ b
b = ((s2 <<  2) ^ s2) >> 25;  s2 = ((s2 & 0xFFFFFFF8) <<  4) ^ b
b = ((s3 <<  3) ^ s3) >> 11;  s3 = ((s3 & 0xFFFFFFF0) << 17) ^ b
return s1 ^ s2 ^ s3
```

Decoratives (cpp:289) and the variation picker in `applyEntities` (cpp:238)
each build their own generator from the same formula. Neither touches the
entity stream.

## 5. Tile order (READ)

`getChunkNoiseCache` (`NoiseProgram.cpp:33-34`, `NoiseCache.cpp:38-60`):
N = 0x400. Register 0 is x = `chunkX * 32 + col`, register 1 is
y = `chunkY * 32 + row`, and the index is `i = row * 32 + col` (x fastest),
at integer tile corners. Walking `i` from 1023 down means (col 31, row 31)
first, then x decreasing, then y decreasing.

So the probabilities are read at each tile's integer corner, on the chunk
grid. `aquilo.rs` reads `aquilo_high_frequency_peaks` there with the grid
kernel. Read at the tile centre on the point kernel instead, 7 of the
census's 199 entities fall outside their own probability (MEASURED, noted in
`placement/aquilo.rs`).

## 6. `generateEntityOnTile` (READ, cpp:512-542)

Positions are fixed point, 1/256 tile. Start at `pos = (tx * 256, ty * 256)`.

1. `proto->asResourceEntity()` (vtable slot `+0x510`; non-null only for a
   `ResourceEntityPrototype`), cpp:520:
   - `pos += (128, 128)`: the tile centre (`0xff88d0` = {0x80, 0x80}), cpp:522.
   - If `bestRich[i] <= 0` (or NaN): return with nothing queued (cpp:525). No
     draws.
   - No jitter, whatever the flags say.
2. Otherwise, if the flag `placeable-off-grid` is set (`proto+0x328` bit 0x10,
   `EntityPrototype.hpp:521`), cpp:530-534: **two draws**, x first (cpp:532),
   then y (cpp:533): `pos.x += trunc(U1 * 256)`, `pos.y += trunc(U2 * 256)`
   (`0xff5f10` = 256.0). Then each component is masked with `& 0xFFFFFFF0`
   (`cutBits`, `FixedPointNumber.hpp:78`). The net offset on each axis is
   `floor(16 U) / 16` tile.
3. Otherwise: `pos = proto->buildPosition(pos, direction 0)` (vtable `+0x128`,
   `EntityPrototype::buildPosition` at `0x16bd810`). This is ordinary grid
   snapping by tile size. No draws.

Then `wouldCollide` (cpp:589-610), the tile half only:

- The box is `map_generator_bounding_box` (`proto+0x28c` left-top, `+0x294`
  right-bottom) plus `pos`, axis aligned. That field defaults to a copy of
  `collision_box` (`EntityPrototype.cpp` about :293 copies it; :294 overwrites
  it only when `map_generator_bounding_box` is present).
- Every tile from `floor(lt)` to `floor(rb)` inclusive, on both axes, must lie
  inside the 96 by 96 working area (`isInArea`, 0..95), and its tile mask must
  not collide with the prototype's `collision_mask`. Otherwise nothing is
  queued.
- On a pass, push a record `{force, richness, protoID, direction = 0,
  position}` (24 bytes) onto `this+0x18..0x28` (`tryToAddEntity`,
  cpp:565-567).

**The jitter draws come before this check, so an entity that fails the tile
check still used them (READ).** Entity-against-entity collision is NOT tested
here.

## 7. Entity-against-entity collision happens later, in apply (READ)

`apply(Surface&)` (cpp:160-170) runs `applyCliffs`, `applyDecoratives`, then
`applyEntities` (cpp:237-267). `applyEntities` walks the queued records **in
queue order**: group order, then decreasing tile index, then attempt order.

- Cliffs with crater placement go to `CliffCraterPlacer` (cpp:254-255).
- Otherwise `Surface::mapGeneratorWouldCollide` (`Surface.cpp:493-495`): the
  box is `BoundingBox(proto.map_generator_bounding_box, record.direction)`
  plus the position, then `Surface::collide(box, proto.collision_mask,
  nullptr, 0)`. If anything collides, the record is dropped (cpp:258).
- Otherwise the entity is created with `amount = richness` (cpp:260-264).

So the rule "a later order won't be placed if something is already there" is
real, and it is enforced here: earlier groups' entities are already on the
surface when later records are tested. **This step draws nothing from the
placement stream.** So a chunk's stream depends only on the fields, the tile
masks, the tile restrictions and the chunk position, never on entity
collisions.

### Inside `Surface::collide` (READ as decompiled C, 2026-11-12)

Read from Ghidra's decompiler, not from objdump: the 2.1.23 binary imported
with only the DWARF and GNU demangler analyzers (about 5 minutes), and
signatures rebuilt from the mangled names. The `decompiling-with-ghidra` skill
in `wormeyman/wormeyman-skills` has the script and the steps. As a control,
`generateEntities` decompiled to the same arbitration compare that section 2
read by hand. Struct offsets below are as the C shows them; field names are
not in the debug info.

`Surface::collide(box, mask, entity, forPlayer)`, `0x18eea40`, 487 bytes:

- A box whose `left_top` equals its `right_bottom` (zero area) never collides.
- **Tiles are tested first** (`constCollideWithTile`). A tile hit returns at
  once, as result kind 4, before any entity is looked at.
- Only then `collideWithEntity(box, mask, entity, filter, <empty filter>)`. A
  hit returns kind 3 with that entity.

`Surface::collideWithEntity`, `0x18eec80`, 909 bytes:

- If bit `0x4` of the mask's flag byte (`mask + 0x20`) is set, no entity is
  tested at all. Which named flag that is was not read (INFERRED:
  `colliding_with_tiles_only`).
- Candidates come from the box's `getAABB`, with both corners shifted right
  by 9 (positions are in 1/256 tile, so the buckets are 2 by 2 tiles), both
  ends inclusive. Each chunk (bucket index shifted right by 4) holds a
  linked list per bucket.
- `entity` is skipped by identity. `mapGeneratorWouldCollide` passes
  `nullptr`, so this does not matter for map generation.
- **No shared layer means no collision**: the other entity's mask comes from
  `CollisionMaskIndex::indexToCollisionMask` (index at entity `+0x6c`), and
  all four 64-bit ANDs zero skips it. With a shared layer, three flag-bit
  rules can still skip it; one is "both masks identical and bit `0x1` clear in
  both". The meaning of bits `0x1`, `0x4` and `0x8` here was not decoded.
- **The overlap test belongs to the entity already on the surface**: its
  vtable slot `+0x248` is called with the new box. Which method that is was
  not resolved, so how a rotated box is tested is still open.

## 8. Resource against simple-entity, and Aquilo's specifics

| | resource (fluorine-vent, lithium-brine, crude-oil) | simple-entity iceberg (huge, big) |
| --- | --- | --- |
| position | tile centre | tile corner + `floor(16 U) / 16` per axis |
| draws per success | 0 | 2 |
| needs richness > 0 | yes | no |
| `collision_mask` | `{resource}` (`collision-mask-defaults.lua:187`) | `{item, object, player, water_tile}` |
| map-gen box | `collision_box`, all three 2.8 x 2.8 (+-1.4) | huge +-1.85 x +-1.25, big +-1.0 x +-0.75 |

No Aquilo entity declares `map_generator_bounding_box`, `tile_restriction` or
`placement_density` (grep of the 2.1.23 data).

Aquilo tile masks: snow and ice are `ground()` = `{ground_tile}`.
`ammoniacal-ocean`, `ammoniacal-ocean-2` and `brash-ice` use
`ammoniacal_ocean()` = `{water_tile, item, player, doodad, floor}`, with
`resource` **commented out** (`tile-collision-masks.lua`). What follows from
those masks and the code paths above (INFERRED, then MEASURED by the replay
below):

- The three wells pass the candidate check on **every** tile, ocean included.
  So each well group spends exactly 1,024 draws per chunk, whatever its
  probability field.
- Icebergs are rejected on ocean and brash ice (`water_tile`). Each iceberg
  group spends one draw per land tile, plus 2 per success.
- Crude oil (group 5) starts after 1,024 + 1,024 + (huge draws) + (big draws).
  Its place in the stream depends on how many icebergs rolled a success in
  that chunk.
- At apply, wells and icebergs never block each other (no shared layer).
  Wells block wells (`resource` layer): fluorine vents first, then brine,
  then oil. Huge icebergs block big ones.

**Huge and big icebergs are never arbitrated against each other.** They are
separate `order` groups. Big's probability is the higher of the two wherever
either is above 0 (`aquilo-NOTES.md`), so a single arbitration would place no
huge icebergs. Separate groups place huge first, and big fills the gaps. That
is how the game gets about 12% huge (22 of 190 on the real surface below).

## 9. What this explains on the other planets (INFERRED, not yet tested)

- **Issue #22 item 1, huge rocks.** On Vulcanus and Nauvis, huge rocks never
  win a max-probability argmax, yet the game places 20-30% huge. Huge and big
  rocks have different `order` strings (`a[landscape]-c[rock]-a[huge]` and
  `-b[big]` on Vulcanus), so they are separate groups, as on Aquilo. That
  explains the mixed population in principle. It has not been re-run on
  those planets.
- **The Vulcanus geyser.** The geyser's `order` is `c`, the last group on
  Vulcanus, so its draws start after every earlier group's. A roll seeded with
  salt 0 that starts at the chunk's first draw cannot match it unless every
  earlier group used nothing. That is probably why such a roll placed only 0 to
  1 of the game's 44 geysers (`rust-wasm-port.md`, "Vulcanus"). The geyser goes
  through this same function; it is not a separate path. Not tested.
- **Vulcanus solid ores share `order` `"b"`**, so they form one group with
  more than one prototype. Porting them needs the richness tie-break, which
  `generate.rs` does not have (see below).

## 10. Corrections to the 2.1.11 macOS notes

`placement-roll-NOTES.md` holds up, with these corrections:

- "2 jitter draws per PLACED entity" is wrong both ways. They are drawn per
  successful roll **only for placeable-off-grid non-resources**, and they are
  drawn even when the entity then fails the tile check.
- "Rolls over tiles in decreasing index" is right, but it is per group, and
  only over tiles with a winner. Tiles with probability 0 still draw.
- The `+848..+964` grouping loop is the `order` compare in section 1.
- Arbitration is max probability with a richness tie-break, scoped to one
  `order` group. Groups share space through apply-time collision, not through
  arbitration. That confirms the "groups processed sequentially with shared
  space" hypothesis there, for the stream; the shared-space half is the apply
  step in section 7.

## Simulator pseudocode

```
const N = 1024
fn chunk_rng(cx, cy):
    w = u32(0x3FBE2C + 7919*cx + 7907*cy)        # wrapping i32 maths, then as u32
    if w < 342: w = 341
    return taus88(s1=w, s2=w, s3=w)

fn uniform(rng): return rng.next_u32() as f64 * 2^-32

# autoplacers: active entity prototypes, sorted by (order, name) bytewise
groups = split autoplacers into runs of equal `order`

fn generate_chunk(cx, cy) -> list of records:
    rng = chunk_rng(cx, cy)
    queue = []
    best = [-inf; N]; winner = [null; N]; bestRich = [0.0; N]
    for group in groups:
        for ap in group:                              # sorted order within the group
            for i in N-1 down to 0:
                (tx, ty) = (cx*32 + i%32, cy*32 + i/32)
                if tile_mask(tx, ty) & ap.collision_mask: continue
                p = prob_f32(ap, tx, ty); r = rich_f32(ap, tx, ty)
                if !(p > best[i] or (p == best[i] and r > bestRich[i])): continue
                if !tile_restriction_ok(ap, tx, ty): continue
                best[i] = p; winner[i] = ap; bestRich[i] = r
        for i in N-1 down to 0:
            ap = winner[i]
            if ap != null:
                (tx, ty) = (cx*32 + i%32, cy*32 + i/32)
                for attempt in 0 .. ap.placement_density:     # default 1
                    U = uniform(rng)
                    if (best[i] as f64) > U:
                        on_tile(ap, tx, ty, bestRich[i], rng, queue)
            best[i] = -inf; winner[i] = null                  # bestRich NOT reset
    return queue

fn on_tile(ap, tx, ty, rich, rng, queue):                     # positions in 1/256 tile
    pos = (tx*256, ty*256)
    if ap.is_resource:
        pos += (128, 128)
        if !(rich > 0): return
    elif ap.placeable_off_grid:
        dx = trunc(uniform(rng) * 256); dy = trunc(uniform(rng) * 256)   # x first
        pos = ((pos.x + dx) & ~15, (pos.y + dy) & ~15)
    else:
        pos = build_position(ap, pos, dir=0)                  # normal grid snap
    box = ap.map_gen_box + pos                                # defaults to collision_box
    for each tile t in [floor(box.lt) .. floor(box.rb)] (inclusive, both axes):
        if t outside chunk +-32 tiles: return
        if tile_mask(t) & ap.collision_mask: return
    queue.push({ap, pos, rich})

fn apply_chunk(queue, surface):                               # main thread, queue order
    for rec in queue:
        box = rec.ap.map_gen_box (direction 0) + rec.pos
        if surface.collides(box, rec.ap.collision_mask): continue   # tiles + existing entities
        surface.create(rec.ap, rec.pos, amount=rec.rich)
```

## Measured against the game (Aquilo, 2026-10-31)

All at map seed 123456, which gives the derived Aquilo surface seed
3111923328, at default levers.

### A real surface: 209 of 209 entities

Ground truth is `test/fixtures/oracle-aquilo-surface.seed123456.json`, written
by `scripts/probes/aquilo-entity-stream/capture.ts`. It holds the whole
surface at chunk radius 8 (289 chunks, -8..8), with the wells'
`created_effect` stripped so the tiles are the ones before the wells' tile
rewrite. 2.1.23 and 2.0.77 returned the same land, chunks and entities. It has
209 entities: 11 `crude-oil`, 4 `lithium-brine`, 4 `fluorine-vent`, 168
`lithium-iceberg-big`, 22 `lithium-iceberg-huge`. The probe's `README.md` has
the rest.

The replay (`aquilo_real_surface_replay_places_every_entity_the_game_did` in
`crates/fmw-noise/src/fixtures.rs`) runs `generate_chunk` with our probability
fields and **the game's own land and water** from the fixture. It then applies
each queue as `applyEntities` does: in queue order, dropping an entity whose
map-gen box meets an already placed one that shares a collision layer
(well with well, iceberg with iceberg). Result: **209 of 209 placed, at the
same positions to the 1/16 tile, and nothing extra.**

Two apply rules were MEASURED there, not read from the binary
(`Surface::collide` was not read):

- **Boxes that only touch collide.** With strict overlap instead, the replay
  keeps icebergs the game dropped. The control is
  `aquilo_real_surface_replay_needs_touching_boxes_to_collide`, which asserts
  that the strict rule places more than 209 and matches fewer.
- **Chunks are applied row-major**, y outer and x inner. The order decides
  which of two entities on either side of a chunk edge survives. In a scratch
  Python simulator (not kept in the repo), a spiral order gave 206 of 209 and
  the reverse order 191.

**Why it needs the game's land.** A real surface runs tile correction (see
`tile-correction-NOTES.md`), and our resolver does not. Tile correction moves
the shore by a few tiles: about 136 land/water flips against our tiles in the
640 by 640 window. Every land tile is an iceberg candidate and spends a draw,
so a moved shore shifts every later draw in the chunk. Replayed on OUR tiles
in the scratch simulator, only 60 of the 159 big icebergs in the census window
matched. That gap is how tile correction was found to matter. A change of land
subtype (snow against ice) changes nothing for the stream, because every land
tile admits an iceberg.

### The preview: the whole 1024 by 1024 PNG, 3 pixels at the edge

The game's map preview runs no tile correction, so on our tiles (which are the
preview's tiles) the stream reproduces the preview PNG. The preview draws by a
rule that was MEASURED against its PNG, not read from code
(`preview_footprint` in `generate.rs`):

- **No entity-against-entity collision.** Every queued entity is drawn.
- An entity covers the tiles from `floor(left)` to `ceil(right) - 1` on each
  axis. So a box edge that lands exactly on a tile line does not take the
  tile past it. (The generator's tile check is inclusive there; the drawing
  is not.)
- **Each entity is drawn only inside its own chunk**, the chunk that
  generated it.
- Where two entities overlap, the first in queue order wins.

The test is "matches the full PNG on every pixel" in
`test/wasmAquiloRenderParity.spec.ts`, against
`test/fixtures/oracle-preview-aquilo-full.seed123456.png` (tiles -512..511,
one tile per pixel). **0 pixels differ inside a 4-pixel border, and 3 differ
at the bottom edge.** Our per-colour pixel counts equal the game's (crude oil
475, lithium brine 451, fluorine vent 157), except 3 more iceberg pixels.

The 3 belong to one huge iceberg at (211.375, 511.6875). Its box reaches tile
row 512, one row past the capture. The game did not draw it and we do. The
leading explanation is that the preview has no tiles past its own area, so
the generator's tile check finds no ground there. That was seen once and not
read from code. Only 4 of our entities cross the capture edge at all, and the
other 3 (big icebergs beside it) are fully covered by neighbours, so they
cannot confirm or refute it. The app renders a continuous map, so the engine
does not copy an edge that only a fixed-size capture has.

### The tiny vent

`the_tiny_vent_lands_where_the_game_puts_it` (`fixtures.rs`): the radius-1
cone at distance 80 has probability 1 on each tile corner inside it, so the
generator queues a vent on each corner its chunk reaches. The first in queue
order is (-40.5, -67.5), which is the census's vent. The rounded centre would
be (-42, -68), but (-41, -68) comes first in decreasing tile order. A real
surface keeps only that first vent, because the others' 2.8-tile boxes
overlap it. The preview draws them all.

## What `generate.rs` does not port, and why each is unreachable today

- **`placement_density`.** The attempt count per tile. No entity prototype
  sets it (only decoratives do), so it is the default 1.
- **Grid snapping** (`buildPosition`), for entities that are neither
  resources nor off-grid. No caller has one.
- **The richness tie-break** inside a group with more than one prototype.
  Every Aquilo group holds one prototype. `generate_chunk` refuses (panics on)
  a group of two rather than quietly using a rule the game does not. Vulcanus's
  solid ores share `order` `"b"`, so Vulcanus needs it.
- **`tile_restriction`.** No Aquilo entity declares one.

Two smaller gaps in the Aquilo inputs:

- **The richness slider is not passed to the engine.** A well places only where
  its richness is above 0. The app's smallest richness step is 1/6, so
  richness is always above 0 and `aquilo.rs` treats it so. **An imported
  string with an Aquilo richness of 0 would draw wells the game does not
  place.**
- **The ABI's Aquilo `placement_sweep_box` slot is kept but not read.** A
  pixel reads only its own chunk, so a tiled render needs no halo. The slot
  stays so the request layout does not move.

## What is not settled

1. **`Surface::collide` internals (partly read, see "Inside
   `Surface::collide`" in section 7).** That it includes tiles, tests them
   first, and needs a shared layer is now READ. Still open: the existing
   entity's box test (vtable `+0x248`), and the meaning of the mask flag bits
   that skip a shared-layer pair. The edge rule (touching collides) is
   MEASURED above, on Aquilo only.
2. **Order of chunks in apply.** Row-major is MEASURED above on one surface,
   generated by `request_to_generate_chunks({0, 0}, 8)` and
   `force_generate_chunk_requests()`. The order comes from the chunk
   generator's scheduling, not from this function, and was not read. A map
   explored in another order might apply chunks differently.
3. **The generation-time tile grid.** `buildArea` copies tiles from the
   surface (cpp:101-103). The replay shows they are the post-correction
   tiles, at least for this surface. Which stages have run on the
   neighbouring chunks when it copies was not read.
4. **Exactness of the probability value.** The roll compares the noise
   program's f32 output widened to f64. Our fields are bit-exact at tier 1;
   any 1-ULP difference would flip only rolls where `U` lands on that ULP.
5. **A -inf tie with a stale `bestRich`.** If a later group's first
   autoplacer reports exactly -inf, it wins only if its richness beats the
   previous group's stale value. Irrelevant unless an expression gives -inf.
6. **Modes 1 and 2 (`this+0x10`).** Only mode 0 (normal generation) was
   traced into its callees. Modes 1 and 2 look like regenerate paths that use
   the override lists at `+0x80`/`+0x88`.
7. **Whether `getAutoplaceFrequencySizeRichness` drops anything at other
   settings.** At default settings all 5 Aquilo entities are active (the
   209/209 replay depends on it). A control set to "none" would remove a
   group and shift every later group's draws. `generate_chunk` is always
   given all five groups; the wells' size-0 case is handled by the
   probability being 0, which still draws (section 3).
   **On Aquilo no slider can drop a group, read from the data (2.1.23).**
   That function reads the autoplace spec's own `control`, and none of the
   five has one. The wells come from `resource_autoplace_settings`, which
   leaves it commented out (`core/lualib/resource-autoplace.lua:137`,
   `--control = autoplace_control_name, -- doesn't work for planet-specific
   controls.`) and puts the size gate inside the probability instead (`:139`,
   `(var('control:<name>:size') > 0) * (...)`). The two icebergs' autoplace
   tables (`decoratives-aquilo.lua:430`, `:535`) hold only `order` and
   `probability_expression`. So size 0 makes the probability 0, and the group
   still spends its draws. A planet whose entities DO carry a `control` (base
   Nauvis resources outside Space Age's planet controls, for example) needs
   this checked before its port.

## How to re-check

```bash
# The model's unit tests, the Aquilo wiring, and the two real-surface tests.
cargo test -p fmw-noise placement::
cargo test -p fmw-noise aquilo_real_surface_replay
cargo test -p fmw-noise the_tiny_vent_lands_where_the_game_puts_it

# The preview: the whole-PNG test, the overlap test and the tiling test.
pnpm vp test test/wasmAquiloRenderParity.spec.ts

# Re-capture the real surface (about 10 seconds, needs both headless installs).
node --experimental-strip-types scripts/probes/aquilo-entity-stream/capture.ts
```

`scripts/verify-rust.sh` lists the two `fixtures.rs` tests under
`POISONED_TESTS`, so the poison phase must turn them red: the roll goes
through `poison::bool_result` in `generate.rs`.

## Appendix: the annotation helper

This joins `objdump` and `llvm-symbolizer --inlining` so each instruction shows
its inlined call chain and source line, printed only when the chain changes.
Usage: `python3 annotate.py <binary> <start-hex> <size> > out.txt`, with an
address and size from the table at the top.

```python
#!/usr/bin/env python3
"""Disassemble [start, start+size) and annotate each instruction with the
inlined call chain + source file:line from llvm-symbolizer, printing the
chain only when it changes.

usage: annotate.py <binary> <start-hex> <size> > out.txt
"""
import re
import subprocess
import sys

binary, start_s, size_s = sys.argv[1], sys.argv[2], sys.argv[3]
start = int(start_s, 16)
size = int(size_s, 0)

asm = subprocess.run(
    ["objdump", "-d", "-C", "--no-show-raw-insn", "-M", "intel",
     f"--start-address={start:#x}", f"--stop-address={start + size:#x}", binary],
    capture_output=True, text=True, check=True).stdout

lines = []
addrs = []
for ln in asm.splitlines():
    m = re.match(r"\s*([0-9a-f]+):\s*(.*)", ln)
    if m:
        a = int(m.group(1), 16)
        lines.append((a, m.group(2)))
        addrs.append(a)

inp = "\n".join(f"{a:#x}" for a in addrs) + "\n"
sym = subprocess.run(
    ["llvm-symbolizer", f"--obj={binary}", "--inlining", "--functions=short",
     "--demangle"],
    input=inp, capture_output=True, text=True, check=True).stdout

blocks = sym.strip("\n").split("\n\n")
chains = {}
for a, blk in zip(addrs, blocks):
    parts = blk.strip().split("\n")
    frames = []
    for i in range(0, len(parts) - 1, 2):
        fn = parts[i]
        loc = parts[i + 1]
        loc = re.sub(r"^.*/(src|Factorio|include)/", r"\1/", loc)
        if loc.startswith("include/"):
            continue
        loc = re.sub(r":0$", "", loc)
        frames.append(f"{fn} @ {loc.rsplit(':',1)[0] if loc.count(':')>=2 else loc}")
    chains[a] = frames

prev = None
for a, text in lines:
    ch = chains.get(a)
    key = tuple(ch) if ch else None
    if key != prev:
        if ch:
            print("    ;; " + "  <-  ".join(ch))
        prev = key
    print(f"{a:x}: {text}")
```
