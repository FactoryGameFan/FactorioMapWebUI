# Per-tile entity-placement roll (M3.5) - reverse-engineering notes

Source: Factorio 2.1.11 (build 86962, mac-arm64). Reverse-engineered 2026-07-20 as
the **M3.5 "spike as pure gate"** - a timeboxed investigation to decide whether the
per-tile placement stipple is worth building, or resists as multi-session batch
semantics. **Outcome: STOP-AND-REPORT.** The roll is a per-chunk streamed RNG that
couples resource placement to subsystems this app has not ported (enemies, rocks,
trees). Details below; the decision writeup is at the bottom.

Companion to `random-penalty-NOTES.md`, `spot-noise-NOTES.md`,
`basis-noise-NOTES.md` (same taus88 RNG family). Nothing was implemented; this file
exists so the disassembly does not have to be redone.

## The functions

Located by demangling the (non-stripped) shipped binary:

- `EntityMapGenerationTask::generateEntities(NoiseCache&)` @ `0x10161d1e0` - the
  per-chunk driver. Seeds the RNG, arbitrates a winner per tile, rolls placement.
- `EntityMapGenerationTask::generateEntityOnTile(TilePosition, EntityPrototype const&, float, RandomGenerator&)`
  @ `0x10161f260` - places one entity; also **jitters its sub-tile position** with
  the same RNG.
- `EntityMapGenerationTask::setupAreaPositionModifier()` @ `0x10161bff0` - proves
  `this+0x60` is the `ChunkPosition` (`(32 - chunkPos*32)` area modifier).

Disassemble with (as in the other notes):

```
lldb -b -o "disassemble --name '_ZN23EntityMapGenerationTask16generateEntitiesER10NoiseCache'" "$FACTORIO_BIN"
lldb -b -o "disassemble --name '_ZN23EntityMapGenerationTask20generateEntityOnTileE12TilePositionRK15EntityPrototypefR15RandomGenerator'" "$FACTORIO_BIN"
```

## The roll (place / don't-place)

Per candidate tile (after arbitration, see below):

```
U = taus88() / 2^32              # one draw, U in [0, 1); combined = s1 ^ s2 ^ s3
place the entity if U < probability
```

- `probability` = the winning entity's clamped autoplace probability at that tile
  (`d13`, from noise float-register `[sp+0x50]`), i.e. the same `clamp(all_patches,
  0, 1)` field this app already computes in `regularPatches.ts` / `resourcePatches.ts`.
- Disasm: `generateEntities` `+1104..+1188`. `fcmp d0(U), d13(prob); b.pl <retry>`
  (`b.pl` = U >= prob -> skip), else fall through to `generateEntityOnTile`.
- **Retry count** (issue #22, item 5)**:** the roll sits in a `for attempt in 0..proto->mapGenData[0x28]`
  loop (`+1032`, `+1088`). Each iteration draws one `U` and places when `U < prob`,
  so a tile can consume a *variable* number of draws and (in principle) place more
  than once. For single-tile resources this count is expected to be 1 (pin it
  against `find_entities` before trusting), but it is NOT structurally guaranteed to
  be 1 for every entity type - which matters because...

## The RNG - taus88, per-chunk stream, NOT a per-tile hash

`RandomGenerator` **is taus88** - identical shift constants (13/19/12, 2/25/4,
3/11/17) to the noise RNGs already in `src/noise/taus88.ts`. The unknown was never
the algorithm; it is the seeding and the stream order.

- **Seeded ONCE per chunk**, at `generateEntities` `+52..+104`:

  ```
  word = max(341, 0x3FBE2C + 7919 * chunkX + 7907 * chunkY)      (u32)
  s1 = s2 = s3 = word
  ```

  `chunkX, chunkY` = `this+0x60` = `ChunkPosition` (chunk units; 1 chunk = 32
  tiles). Same base `0x3FBE2C`, primes 7919/7907, and 341 clamp as
  `random_penalty`/`spot_noise`.

- **No `map_seed` (seed0) XOR** in the seed - like `random_penalty`, unlike
  `basis`/`spot`. The map seed does NOT enter the roll RNG. It enters only through
  the **probability field** the roll is compared against (basis/spot noise use
  seed0). Consequence: two maps with different seeds share the *same* per-chunk `U`
  sequence, but roll against *different* probability fields -> different placements.
  Consistent and faithful; just means the stipple RNG itself is seed-independent.

- **Single shared stream, streamed in a fixed order.** The state lives on the stack
  (`sp+0x68`/`sp+0x70`), is updated in place, and is **never re-seeded** inside the
  function. It is consumed by:
  1. the placement rolls, over tiles in **decreasing** tile index (reverse order,
     like `random_penalty`'s last-element-first), and
  2. **2 extra draws per PLACED entity** - `generateEntityOnTile` (`+228..+356`)
     draws `U*256` twice to jitter the entity's within-tile x and y (masked to 1/16
     tile). Only placements consume these; skips do not. So the draw count is
     **data-dependent**: whether tile N rolls the value it does depends on how many
     earlier tiles placed.

## Arbitration (resolves the "cross-resource interaction" question)

Before rolling, `generateEntities` runs an arbitration loop (`+456..+844`) that, per
tile, picks a **single winning entity** among all competing autoplacers by **max
probability**, subject to collision-mask and tile-restriction checks (this is the
game's "oil is order c, won't place if another resource is already there"). It
writes winner-proto + winning-probability + richness into per-tile buffers. Then the
roll phase rolls **once per tile for that one winner**.

> **The "among all competing autoplacers" scope in the paragraph above is FALSIFIED.**
> See "Enemy bases: what Task 6 added to the arbitration picture" at the end of this
> file: one global max-probability arbitration would leave zero spawners in oracle
> region 1, against the game's 142. Arbitration is scoped to autoplace-order groups.
> The rest of the paragraph - one winner per tile, then one roll - still stands.

So resources do NOT each roll independently against a shared stream - there is a
per-tile max-probability arbitration first, then one roll. This app's
`resolveResource.ts` already does an analogous order-priority pick (though by
autoplace order, not max-probability - a discrepancy to revisit if this is ever
built).

### FALSIFIED for Vulcanus rocks: max-probability arbitration cannot produce the game's population (2026-07-27)

**Tracked as issue #22, item 1** (the register of known approximations).

**Read this before porting another roll-based overlay on the strength of the
paragraph above.** The "single winner by max probability" model, applied to the two
Vulcanus rock probability expressions, is provably wrong about *which* prototype
wins - at every tile, at every seed.

The two expressions (`decoratives-vulcanus.lua:308-318`, with
`a = vulcanus_ashlands_biome` and `T` the three shared terms) are:

```
vulcanus_rock_huge = min(0.2 * (1 - 0.75*a), -1.2 + T)
vulcanus_rock_big  = min(0.2 * (1 - 0.50*a), -1.0 + T)
```

`rockBig >= rockHuge` is a theorem, not a seed accident: the caps satisfy
`0.2*(1-0.5a) >= 0.2*(1-0.75a)` for all `a` in `[0, 1]`, and the sloped branches
satisfy `-1.0 + T > -1.2 + T` unconditionally. A `min` of two termwise-`>=` pairs is
`>=`. Measured over three oracle regions (262144 tiles each): `huge` is the argmax at
**0.0000** of placed tiles, with 16-19% exact ties where both caps bind at `a = 0`.

So max-probability arbitration predicts a **0% huge** rock population. The game's
actual population, from `count_entities_filtered` on a real 2.1.12 surface
(`test/fixtures/oracle-entity-counts.seed123456.json`, region 2): **320 huge, 813
big - ~28% huge.** The model does not merely mispredict the split; it excludes huge
rocks entirely.

**What was shipped anyway, and why that is not a contradiction.** The claim the port
makes is DENSITY, not identity. `renderVulcanusRocks.ts` gates the roll with a
uniform `huge-volcanic-rock` collision box (3 x 2.2 tiles) and lands within
0.2% / 0.6% / 7.5% of the game's total rock count across the three regions
(`test/entityDensity.spec.ts`). The small `big` box (1.5 x 1.5), which is what an
argmax rule actually selects given the theorem above, overshoots by 13-27%. So the
*total* is right while the *per-tile prototype identity* is known wrong, and the
comment in `renderVulcanusRocks.ts` says so. Do not read the density agreement as
validation of the arbitration model.

**The residual converges with the anomaly - probably the most useful thing here.**
The game does not sit *on* the all-huge model, it sits just above it, in every
region:

| region | all-huge | game | all-big |
| --- | --- | --- | --- |
| 2 | 1131 | 1133 | 1399 |
| 3 | 1359 | 1367 | 1738 |
| 4 | 1341 | 1450 | 1640 |

That is the signature a mixed population would leave. Roughly 28% huge / 72% big
means most rocks carry the *smaller* box, which lets neighbours in that a uniform
huge box would reject - so the game should place slightly **more** than an all-huge
model and far fewer than an all-big one. It does, in all three regions. The
mixed-population hypothesis below therefore explains two independent observations
(the 28% split and the sign of the density residual) rather than one, which is the
main reason it is worth writing down. It is still a hypothesis: the port models
neither the mixed population nor cross-chunk collision nor the ~1500 other entities
per region, and all of those push the count the same way.

Caveat on region 4, the one with the 7.5% residual: it is the densest of the three
(1450 rocks vs 1133 and 1367) and the residual is monotone in that ordering, which is
what a mixed population predicts - but a 28% density increase against a 40x residual
increase is nowhere near proportional. Region 4 is also the spawn-centred window and
the only one containing geysers, so unmodelled cross-overlay arbitration concentrates
there. Do not treat the region-4 number as a clean measurement of the mixing effect.

**Untested hypothesis for the mechanism - recorded as a handoff, not a finding.**
The section below already notes that autoplacers are processed in **groups**, sorted
by a name `memcmp`. The two rock prototypes' autoplace orders are
`a[landscape]-c[rock]-a[huge]` and `a[landscape]-c[rock]-b[big]`
(`decoratives-vulcanus.lua:40` and `:1817`), so `huge` sorts first. If arbitration
runs *per group* rather than globally - a sequential pass placing huge rocks with
their large box, then a later pass letting big rocks fill the gaps - a mixed
population falls out naturally, and the effective exclusion is set by the huge box
even though big rocks outnumber huge ones. That is consistent with both the observed
~28% split and the measured density, but **nothing here tests it**; it would need a
re-read of the `+848..+964` grouping loop. Nobody should treat it as established.

> **Partially promoted 2026-07-27.** The *global* alternative to this hypothesis is
> now falsified outright by the enemy prototypes - see "Enemy bases: what Task 6
> added to the arbitration picture" at the end of this file. That removes the
> competing explanation; it does NOT establish this one, which additionally needs
> groups processed **sequentially with shared space** (huge rocks claiming tiles, big
> rocks filling gaps). Separate arbitration alone would not produce the mixed
> population. The `+848..+964` re-read is still the work.

### Independently replicated on Nauvis rocks (2026-07-27)

The same falsification holds on a different planet with different expressions, which
is worth more than a second Vulcanus region. `base/prototypes/decorative/decoratives.lua`
(2.1.12) gives `huge-rock` and `big-rock` the SAME `region_box`
(`range_select_base(moisture, 0.35, 1, 0.2, -10, 0)`) and differ only in multiplier
and penalty:

```
huge = 0.07 * control * (region_box + rock_density - 1.7)
big  = 0.17 * control * (region_box + rock_density - 1.6)
```

With `T = region_box + rock_density`, `big > huge` exactly when `T > 1.53` - and
`big` is positive only for `T > 1.6`, `huge` only for `T > 1.7`. So wherever either
can place at all, `big` is strictly ahead: `huge` is the argmax at 0 of the placed
tiles in both Nauvis oracle regions, measured. Max-probability arbitration again
predicts a 0% huge population; the game's region 0 is **42 huge, 149 big, 1 sand -
22% huge**. Two planets, two prototype families, same 20-30% huge population the
model cannot produce.

One thing Nauvis adds that Vulcanus could not: **the argmax is not degenerate in
general.** `big-sand-rock` reads a disjoint climate band (moisture in [0, 0.3] and
aux in [0.3, 1] against `big-rock`'s moisture in [0.35, 1]), so it wins outright in
the desert region - 54 of 54 placed tiles at `[4096,4096]`, against 0 of 205 at the
origin. The game agrees in direction (region 1 is 64 sand rocks and nothing else).
So the argmax is wrong specifically about the size ordering WITHIN a shared band,
not about biome selection. That is a sharper constraint on any replacement model
than "argmax is wrong".

**Do not read that as "the argmax box rule earned its keep on Nauvis" - it did not,
and the next overlay should not adopt one on this precedent.** All three Nauvis rock
boxes collapse to the SAME exclusion neighbourhood on the integer tile lattice:
`big-rock` (2 x 1.9) and `big-sand-rock` (1.5 x 1.5) both reject `|dx| <= 1 &&
|dy| <= 1`, i.e. the 3x3, and `huge-rock` (3 x 2.2, the only 5x5) can never win. So
argmax, uniform-big and uniform-sand accept the identical tile set - pointwise, not
merely in aggregate, since a mixed big/sand pair also tests as 3x3 - and all three
measure 205 / 54 across the two oracle regions. `renderRocks.ts` ships the argmax
because it is the rule the game describes, not because it bought any measurable
accuracy. Whether an argmax box rule matters for a given overlay depends on whether
its prototypes' boxes actually separate on the lattice; measure that before building
one.

Nauvis rocks also have no `tile_restriction` at all: their restriction is the
`simple-entity` default collision mask (`building()` in
`core/lualib/collision-mask-defaults.lua`), which includes `water_tile`. When
looking for an overlay's tile gate, check the collision mask before concluding
there is none.

## Why this is STOP-AND-REPORT (the coupling that kills a cheap port)

The roll stream is shared across **all entity autoplacers in the chunk**, processed
in groups (`+848..+964`, grouped via a name `memcmp`), sharing the one per-chunk
taus88 state. Nauvis entity autoplacers are not just the 6 resources - they include
**enemy bases (spawners/worms), rocks, and any other autoplaced entity**. Whichever
groups sort before the resources consume draws first (and their *placements* consume
2 jitter draws each), so the exact `U` a given resource tile sees depends on the
entire preceding placement sequence in that chunk - including subsystems M1-M3 never
ported.

To reproduce resource stipple faithfully we would need, per chunk:
1. the exact chunk-seed (done: above) and the group/tile iteration order (partially
   mapped: reverse tile order; group order via name sort - needs pinning);
2. every entity autoplacer's probability field, **not just resources** (enemies,
   rocks, ...), to run arbitration and consume the right draws;
3. exact-order taus88 streaming including the 2 data-dependent jitter draws per
   placement; and
4. the per-entity retry count semantics (`proto->mapGenData[0x28]`).

That is multiple sessions and pulls in un-ported systems. Per the spike's charter
(Eric, 2026-07-20: "if the RNG resists as multi-session batch semantics, stop and
report rather than pushing into the render build"), we stop here.

### What a build WOULD look like if revived later

- A per-chunk simulator: iterate the 32x32 chunk's tiles in the game's exact order,
  seed taus88 from `ChunkPosition`, run arbitration over **all** entity autoplacers
  present, stream the rolls + jitter draws, and record placed resource tiles.
  Validate tile-for-tile against a new `surface.find_entities{type="resource"}`
  oracle (model on `captureTileNamesForSeed` in `test/oracle/capture.ts`).
- Cheaper alternative that AVOIDS the coupling (worth considering instead): don't
  reproduce the exact stipple - render each resource where `probability > threshold`
  with a **cosmetic** dither whose *density* matches `probability`, using only the
  already-validated `randomPenalty`/noise primitives. Not tile-exact, but reads as a
  stippled/scattered patch and needs none of the cross-subsystem simulation. This
  also handles the oil `random_probability` case (fold the `* random_penalty{...,
  amplitude=1/random_probability}` factor into `probability()` and dither on it)
  without the un-RE'd stream. This was flagged in the ROADMAP as the "per-resource
  render rule" option.

## WHAT WAS ACTUALLY BUILT (2026-07-27) - the third option

The two sections above are the correct account of the **tile-exact** version, and
they still stand: nothing here reproduces the game's stream. What shipped is
neither the multi-session simulator nor the "cosmetic dither" fallback, but a
third thing the spike did not name - a **real roll against the real probability,
with the two coupling sources deliberately dropped**.

### The two departures, and why they are not fatal

1. **No cross-overlay arbitration.** Each overlay rolls its own probability with
   its own stream instead of arbitrating against every other autoplacer in the
   chunk. This is the departure the spike identified as fatal to *tile-exactness*,
   and it is - positions are not the game's. It is not fatal to *density*, which
   is what the port claims.
2. **No jitter draws.** The game consumes 2 extra draws per placement to jitter
   the entity inside its tile, which is exactly what makes the stream
   data-dependent (tile N's `U` depends on how many earlier tiles placed).

**Dropping (2) is what buys back per-position purity, and that is the load-bearing
trick.** With no data-dependent consumption, a chunk's 1024 draws are a pure
function of `(chunkX, chunkY, salt)`, so `chunkRolls` precomputes all of them and
`roll(x, y)` becomes a pure function of world position. That is what makes the
render window-independent - `test/tiledEquality.spec.ts` compares a tiled render
against a whole one byte-for-byte, and it would fail immediately if `U` depended
on traversal order. It is also why `resolveChunk` may gate *after* rolling
(`placementRoll.ts` documents the two preconditions).

So the departures are not two separate approximations; (2) is the enabling
simplification and (1) is its consequence.

### One stream per overlay, via a salt

`PLACEMENT_SALT` adds a per-overlay constant to the seed word
(`max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY + salt)`), so overlays that would
otherwise share the game's single per-chunk stream get decorrelated ones instead.
`vulcanusRocks` is **0**, which reproduces the game's own word exactly and lets a
unit test pin the RE'd constants; every other value is arbitrary and means
nothing beyond being distinct. Two salts are not placement rolls at all - the
spawner penalties, and later oil's - but stand in for `random_penalty` batch ops
that need the same thing: a deterministic, position-pure uniform per tile.

**A salt change is a real move, not a formality.** Re-running the geyser over
eight salts spans 46-63 placements against the game's 56 (see Task 7 below), so
the exact agreements below are one draw from a spread, not precision.

### Density-oracle result per overlay

Against `test/fixtures/oracle-entity-counts.seed123456.json` (Factorio 2.1.12,
seed 123456), measured by `test/entityDensity.spec.ts` on the exact predicates
the renderers paint:

| overlay | region | ours | game | rel |
| --- | --- | --- | --- | --- |
| Vulcanus rocks | 2 `[0,0]` | 1131 | 1133 | 0.2% |
| Vulcanus rocks | 3 `[4096,4096]` | 1359 | 1367 | 0.6% |
| Vulcanus rocks | 4 `[-256,-256]` | 1341 | 1450 | 7.5% |
| Nauvis rocks | 0 `[0,0]` | 205 | 192 | 6.8% |
| Nauvis rocks | 1 `[4096,4096]` | 54 | 64 | 15.6% |
| Nauvis enemy bases | 0 `[0,0]` | 28 | 19 | 47.4% (unbanded - see below) |
| Nauvis enemy bases | 1 `[4096,4096]` | 157 | 142 | 10.6% |
| Vulcanus geysers | 4 `[-256,-256]` | 56 | 56 | 0.0% |
| Nauvis crude oil | 0 `[0,0]` | 7 | 8 | 12.5% |
| Nauvis crude oil | 1 `[4096,4096]` | 0 | 0 | exact |

Read these with the denominators in mind rather than as a ranking. Vulcanus rocks
carry ~1200 per region and are the only rows where a sub-percent figure means
anything; oil's `n = 8` has a 35% Poisson sigma, and the geyser's exact 56 is one
draw from a 46-63 salt spread. The two 0-vs-0 rows rule out gross over-placement
in windows that have field but no entities, which is worth having and is not a
ratio.

**The enemy-base region 0 row is the one known-unmodelled residual**, and it is
diagnosed rather than mysterious: trees occupy 34.3% of that region and rocks
3.8%, both sort before spawners, and feeding this app's own tree and rock
placements in as blockers gives 19 against the game's 19. That is cross-overlay
OCCUPANCY - see the section below - and it is tracked as **issue #16**, the
successor to issue #9 (which closed when the five overlays landed).

### What this does NOT claim

Tile-exact positions, per-tile prototype identity (falsified for Vulcanus rocks -
the game's population is ~28% huge where max-probability arbitration predicts 0%),
and richness. The retry-count semantics (`proto->mapGenData[0x28]`) are still
unpinned; every overlay here assumes one roll per tile.

## The oil `random_probability` follow-up - DONE 2026-07-27 (Task 8)

For `random_probability < 1` (only crude-oil, 1/48) the game multiplies `probability`
by `random_penalty{source=1, amplitude=1/random_probability}`
(`resource-autoplace.lua:103-105`). This section used to say the factor "only pays off
together with a placement roll", and that was right: applying it under the hard
`>= 0.5` footprint would have made oil vanish, because the penalised probability is
below 0.5 on all but ~1 tile in 48.

Both landed together in Task 8. Oil is now the catalog's one `placement: "roll"`
entry, rolling against `clamp(all_patches,0,1) * (1 - 48U)` with the water tile gate
and the 2.8 x 2.8 collision box, painting a 3x3 mark. Region 0 places 7 against the
game's 8; region 1 places 0 against 0.

**The `random_penalty` batch extent turned out not to be on the critical path**,
which is the part of this worth remembering - the work was budgeted for that RE and
did not need it. `source = 1` is constant and positive, so every tile consumes
exactly one draw and each tile's `U` is marginally uniform however the batch is cut;
density is a sum of marginals and is therefore batch-invariant, and positions were
never claimed. Full argument, the size-1 caveat that would break it, and the measured
table: `docs/noise/random-penalty-NOTES.md`.

## Enemy bases: what Task 6 added to the arbitration picture (2026-07-27)

### Per-group arbitration is no longer a hypothesis - global max-probability is falsified

The "Untested hypothesis for the mechanism" above (arbitration runs per autoplace-order
group, not globally) can be promoted one step: **a single global max-probability
arbitration is ruled out by the enemy fixture**, independently of any rock reasoning.

`behemoth-worm-turret` is `enemy_autoplace_base(8, 5)` (`turrets.lua:1334`), so its
source is `min(m * ebp, 0.65)` with `m = max(0, 1 + 0.016*(distance - 2646))`, against
a spawner's `min(ebp, 0.25)`.

**Wherever `m >= 1` this is a theorem, not a saturation argument.** Both terms of the
worm's `min` dominate the spawner's termwise (`m*ebp >= ebp` and `0.65 > 0.25`), and a
`min` of two termwise-`>=` pairs is `>=`; the inequality is strict for every
`ebp > 0`. So no distance-specific or threshold reasoning is needed - the worm wins
outright. `m >= 1` from `distance >= 2646` tiles, and oracle region 1 spans
`distance` 5792-6516, where `m ~ 51`. (The same holds one step earlier:
`medium-worm-turret` is `(2, 3)`, `m >= 1` from `distance >= 774`, cap 0.35.)

Under one global max-probability arbitration region 1 would therefore hold **0
spawners**. `test/fixtures/oracle-entity-counts.seed123456.json` region 1 holds
**142** (86 biter + 56 spitter).

Note the argument does NOT reach the near-spawn region, and that is worth stating so
nobody over-extends it: at region 0's distances every `distance_factor > 0` multiplier
is clamped to 0, so only `small-worm-turret` (`(0, 2)`) competes there, and its source
is *identical* to a spawner's. Region 1 is what falsifies the global model.

So arbitration is scoped narrower than "all entity autoplacers". Both spawners share
the autoplace order `b[enemy]-a[spawner]` while all four worms share
`b[enemy]-b[worm]` (`base/prototypes/entity/enemy-autoplace-utils.lua`), which is
exactly the split the `+848..+964` name-`memcmp` grouping would produce.
`renderEnemies.ts` models the spawner group and ignores worms entirely.

This does NOT establish the rock hypothesis, which needs groups to be processed
*sequentially with shared space* rather than merely arbitrated separately. It removes
the competing explanation, nothing more.

### `map_generator_bounding_box` beats `collision_box` - check for it first

`EntityPrototype.map_generator_bounding_box` is documented in the prototype API as
"Used instead of the collision box during map generation. ... if the box is bigger,
the entities will be placed farther apart." Both spawners declare it
(`{{-3.7,-3.2},{3.7,3.2}}` = 7.4 x 6.4) alongside a much smaller `collision_box`
(4.4 x 4.4), and using the wrong one is a 132-point error in oracle region 0 and an
87-point error in region 1:

| box used | region 0 (game 19) | region 1 (game 142) |
| --- | --- | --- |
| `collision_box` 4.4 x 4.4 | 61 (221.1%) | 290 (104.2%) |
| `map_generator_bounding_box` 7.4 x 6.4 | 36 (89.5%) | 167 (17.6%) |

(Both rows without `random_penalty`; see below.) Neither Nauvis nor Vulcanus rocks
declare the field (`grep -c` on `decoratives.lua` and `decoratives-vulcanus.lua`
returns 0 for both), so those overlays' use of `collision_box` was correct - but by
luck of the prototypes, not by rule.

**Where the field actually is in 2.1.12, and why the count of grep hits misleads.**
`grep -rn 'map_generator_bounding_box' base/ core/ space-age/` returns **8 textual
hits, which are far more than 8 prototypes**:

| site | prototypes | map-gen box | `collision_box` |
| --- | --- | --- | --- |
| `base/prototypes/entity/enemies.lua:169`, `:830` | biter-spawner, spitter-spawner | 7.4 x 6.4 | 4.4 x 4.4 |
| `base/prototypes/entity/turrets.lua:348` | small-worm-turret | 3.8 x 3.6 | 1.8 x 1.6 |
| `turrets.lua:974` | medium-worm-turret | 4.2 x 4.0 | 2.2 x 2.0 |
| `turrets.lua:1118`, `:1260` | big-worm-turret, behemoth-worm-turret | 4.8 x 4.4 | 2.8 x 2.4 |
| **`base/prototypes/entity/trees.lua:4904`** | **every base Nauvis tree** | **1.6 x 1.6** | **0.8 x 0.8** |
| `space-age/prototypes/entity/enemies.lua:6189` | gleba-spawner-small | 4.7 x 4.7 | 2.7 x 2.7 |

The tree row is the one that matters and the one a hit count hides. `trees.lua:4904`
sits **inside the `for i, tree_data in ipairs(tree_data) do if tree_data.enabled then`
factory at `:4742`**, whose driving table (`:4364`) holds 15 entries, all
`enabled = true`. So a single textual hit sets the map-gen box for the whole base
Nauvis tree family, at **double** their collision box on each axis.

That is directly load-bearing for the cross-overlay finding below, which hands the
next porter a tree-occupancy problem: the exclusion a tree imposes on a spawner is
computed from 1.6 x 1.6, not 0.8 x 0.8, and this repo's measurement of it already
used the map-gen box. `tree-plant` is a **Gleba** plant
(`space-age/prototypes/entity/plants.lua`) and does **not** declare the field; it is
not one of these hits.

### The rolled probability is the FULL autoplace expression, penalty included

The spawners' `probability_expression` is `enemy_autoplace_base(0, seed)`, i.e.
`random_penalty{x = x + seed, y = y, amplitude = 0.1, source = min(ebp, 0.25)}` once
`distance_factor = 0` collapses the multiplier and the cap. Rolling against the bare
`min(ebp, 0.25)` over-places: 36 -> 28 in region 0 and 167 -> 157 in region 1.

`random_penalty` is a batch op whose stream depends on batch order, so
`renderEnemies.ts` draws its two `U`s from the placement-roll taus88 machinery under
their own salts: the distribution is exact, the positional identity is not. **That
choice is worth ~5 points of the answer**, measured - six different salt pairs give
149-157 in region 1 (rel 0.049-0.106) and 27-28 in region 0. Anyone tightening this
model should reproduce the real batch stream rather than treating the current number
as a property of the physics.

### Cross-overlay OCCUPANCY, not just arbitration, is the dominant remaining error

**Tracked as issue #16** (opened 2026-07-27 when issue #9 closed).

Every previous report listed "no cross-overlay arbitration" as an unmodelled
approximation without sizing it. On enemy bases it is measurable and it is the whole
residual in the near-spawn region.

Spawners sort at `b[enemy]-a[spawner]`; trees sort at `a[tree]-...` and rocks at
`a[landscape]-c[rock]-...`, i.e. BEFORE them. Under sequential per-group processing
trees and rocks take their tiles first, and a 7.4 x 6.4 spawner box cannot fit beside
them. Rolling this app's own tree density and rock placement and excluding the tiles
they occupy:

| | region 0 `[0,0]` | region 1 `[4096,4096]` |
| --- | --- | --- |
| area excluded by trees | 34.3% | 10.9% |
| area excluded by rocks | 3.8% | 1.3% |
| game | 19 | 142 |
| model without blockers (shipped) | 28 (47.4%) | 157 (10.6%) |
| model with blockers | 19 (0.0%) | 155 (9.2%) |

Region 0 is the near-spawn, heavily forested window and region 1 is desert, so the
~3x asymmetry in tree cover matches the ~4x asymmetry in residual. Region 0 landing
exactly on the game's 19 is a coincidence at that precision (the salt spread above is
wider), but the direction and the asymmetry are the finding.

**This is not shipped.** It would mean running a tree placement roll that has never
been validated against anything - the trees overlay renders *expected coverage* and
never places an individual tree - inside the enemy chunk resolver, at roughly double
the cost. Recorded here so the next overlay's residual is read against it: an overlay
with a large collision box and a low density is dominated by what the game put down
before it, not by its own field.

## Vulcanus sulfuric-acid geysers: what Task 7 added (2026-07-27)

### The game's own comment is textual evidence for sequential shared space

The geyser prototype's autoplace carries a developer comment
(`space-age/prototypes/entity/resources.lua:186-187`, 2.1.12):

```lua
autoplace =
{
  --control = "sulfuric-acid-geyser",
  order = "c", -- Other resources are "b"; oil won't get placed if something else is already there.
  probability_expression = 0
}
```

That is the same sentence the arbitration section at the top of this file quotes from
the disassembly, but here it is in the game's own source, attached to the mechanism it
describes: **a later autoplace order means "won't get placed if something else is
already there"**. It does not say entities are *arbitrated* against each other by
probability; it says a later group finds the space already taken.

This is the closest thing yet to direct evidence for the "groups processed
sequentially with shared space" half of the rock hypothesis, which the enemy-base
work could only clear the competing explanation for. **It is still not a test.** A
comment states a developer's intent, and the code path is where the truth is - the
`+848..+964` grouping re-read is still the work. But it is worth more than the
hypothesis had before, and it comes from a file nobody had read for this purpose.

It also fixes the geyser's place in the queue: `c` sorts after the three solid ores
(`b`) and after the rocks (`a[landscape]-c[rock]-*`), so **the geyser is last of every
Vulcanus autoplacer** and is therefore the overlay most exposed to the cross-overlay
occupancy above. That prediction is not borne out by the one region that can test it
(see below), which is itself informative.

### The whole gate here is collision; the tile restriction is real but idle

| variant | oracle region 4 `[-256,-256]` (game 56) |
| --- | --- |
| bare roll, no gates | 81 (44.6%) |
| + lava tile restriction only | 81 (44.6%) |
| + collision only | 56 (0.0%) |
| **+ both (shipped)** | **56 (0.0%)** |

The restriction rejects nothing in that window, and it would be wrong to conclude it
is decorative: over a +/-2000-tile sample at the same seed, 426 of 5627 tiles with a
positive geyser probability are lava and the gate rejects 12 of 195 roll hits (~6%).
Region 4 simply has no lava where its sulfur is. **A gate measuring 0 in one window is
not evidence about the gate.**

Two smaller prototype findings, both checked rather than assumed:

- **No `map_generator_bounding_box`** - the 2.1.12 inventory in the table above holds
  eight declaration sites and not one of them is a `resource`, so the geyser's
  `collision_box` (2.8 x 2.8) *is* its map-gen box.
- **The lava gate is a collision MASK, not a `tile_restriction`.** The geyser declares
  no `tile_restriction`; `type = "resource"` defaults to a `{resource = true}`
  collision mask (`core/lualib/collision-mask-defaults.lua:187`) and exactly `lava` and
  `lava-hot` list `resource = true` in their tile masks
  (`base/prototypes/tile/tile-collision-masks.lua:65`). The forbidden set coincides
  with the rock overlay's while being reached by an entirely different route - so
  "same answer" here is a coincidence of the tile data, not a Vulcanus-wide rule.
- **The argmax-box question does not arise**, for a fourth distinct reason: one
  prototype, one box. The four overlays so far have answered it by an ordering theorem
  (Vulcanus rocks), a lattice collapse (Nauvis rocks), identical declarations (the two
  spawners), and now non-existence.

### A comment's arithmetic is not a measurement, even in this repo

`vulcanusResourceCatalog.ts` had claimed since V3 that the geyser's probability "peaks
around 0.065", derived by assuming `vulcanus_sulfuric_acid_region <= 1` and
`vulcanus_sulfuric_acid_patches <= 0.8`. The region is a `max` against
`vulcanus_starting_sulfur`, which has no such cap. Measured over +/-3000 tiles on a
7-tile grid and refined around the argmax: **0.0883 at (2481, -1985)**, where `patchy`
is 1.217 - 36% above the written bound. Nothing depended on the exact figure (the
ordering argument only needs "far below calcite's saturated ~1"), but it is the third
number in this subsystem to have been reasoned rather than measured and be wrong.

A fourth turned up in the same file while pinning Task 7's render test, and it is the
more interesting one because it was the *headline* claim for why the roll was worth
doing: the old blob was said to overstate the geysers' area "by more than an order of
magnitude". Aggregating the shipped predicate over +/-2000 tiles on a 2-tile grid
gives 371 placements at 2.8 x 2.8 = 7.84 tiles each against 12130 sampled footprint
tiles - **0.240, a 4.2x overstatement**. The paper figure multiplied the *pre-collision*
roll rate by the entity area, and collision is exactly the gate that removes most of
those hits (81 -> 56 in oracle region 4). So the error was not arithmetic; it was
quoting a rate from before the very gate the same task had just added.

The roll is still the right change - 4.2x is a large error, and a blob and a stipple
misread differently regardless of area. But **the case for a change was overstated by
the same reasoning style the change was meant to replace**, which is worth more as a
warning than the number is as a fact.

## Coarse rock field sampling: measured, and NOT adopted (2026-07-27, Task 9)

Task 9 was to cut render cost by evaluating the rock probability field on a coarse
lattice while still rolling every tile - degrading *where* rocks land, never *how
many*, so the density oracle stays valid. The mechanism is built and tested
(`ROCK_FIELD_LATTICE` + `latticeSnapped` in `src/noise/rocks/rockCatalog.ts`,
`test/rockLattice.spec.ts`) but **ships at 1, i.e. disabled.**

### Fidelity: density survives, clumping is the cost

Ungated roll over `[-256, 256)^2`, seed 123456:

| planet | L=1 | L=2 | L=4 | clumping L=1 / L=2 / L=4 |
| --- | --- | --- | --- | --- |
| vulcanus | 2448 | 2426 (-0.90%) | 2419 (-1.18%) | 0.349 / 0.372 / 0.390 |
| nauvis | 313 | 310 (-0.96%) | 316 (+0.96%) | 0.259 / 0.229 / 0.199 |

Density holds to ~1% at both strides, as the design predicted. Vulcanus clumping
rises 6.7% at L=2 and 11.8% at L=4 - the smearing the brief anticipated from
`vulcanus_decorative_knockout` running at `input_scale = 1/3` (~5-tile
wavelength), now confirmed rather than assumed. Nauvis's clumping proxy moves the
other way, but that window holds ~313 placements against Vulcanus's ~2448, so it
is noise rather than a counter-example.

### Perf: the gate is unreachable by this route, and not by a small margin

The plan's gate was "Vulcanus `all` under 2x the terrain baseline". Min-of-7
interleaved renders at 512x512 (min, not median - see the noise note below):

| L | terrain | rocks | all | rock marginal | all/terrain |
| --- | --- | --- | --- | --- | --- |
| 1 | 3298 | 4710 | 8261 | 1412 | **2.505** |
| 4 | 3144 | 4021 | 7610 | 877 | **2.421** |

Stride 4 cuts the rock overlay's marginal cost by 38% and the whole render by
7.9%. It does not come close to the gate, and **no lattice can**, because the
arithmetic bounds it: subtracting the rock overlay *entirely* from the L=1 row
leaves 6849 ms against a 3298 ms terrain baseline - **2.077x, still over**. Both
terms there come from the same run, so that bound is robust to the cross-run noise
below.

The premise was wrong about where the money is. Marginal costs over terrain, from
a single min-of-7 run over all five views: cliffs 2133 ms (42%), resources 2013 ms
(40%), rocks 1362 ms (27%) - shares of a 5064 ms overlay budget, summing to over
100% because the `all` path shares a warmed cache. Task 9 targeted the smallest of
the three, and the largest is the one no proposed fix reaches (see
`vulcanus-cliffs-NOTES.md`).

### The benchmark cannot resolve the effect it was asked to gate on

Worth recording independently of rocks. Run-to-run variance on this machine is
5-23%: within one 5-iteration run the Vulcanus terrain render spread 22.7%
between its fastest and slowest iteration, and views the lattice cannot touch
(cliffs, resources) moved ~10% between processes. A median-of-3 - what `pnpm perf`
uses - is not a stable enough estimator to accept or reject a 3-8% change. Every
number above is a **minimum** of 7, which is the right estimator for timing under
additive positive noise, and even then the L=1 vs L=4 terrain baselines differ by
4.7%. The `all/terrain` **ratio** is the only figure here worth quoting across
runs, because both terms share a process.

This is why the L=2 arm looked like it made things *worse* on a first
median-of-3 pass (`all` 8683 -> 8693 ms, ratio 2.354 -> 2.388): the measurement
was noise. Do not tune this constant against `pnpm perf` as it stands.

### Why disabled rather than shipped at 2

Stride 2 buys a saving that this harness cannot distinguish from zero, and stride
4 buys 7.9% for an 11.8% rise in Vulcanus clumping - i.e. it degrades exactly the
placement realism Tasks 3-8 were spent establishing, for a render that is already
tiled across a 64-worker pool (`render-tiling-shipped`), where the user-visible
wall clock is a fraction of these figures. If render cost is attacked again, the
targets are cliffs and resources, and the first requirement is a benchmark that
can measure them.
