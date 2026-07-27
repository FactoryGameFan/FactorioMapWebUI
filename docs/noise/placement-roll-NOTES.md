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
- **Retry count:** the roll sits in a `for attempt in 0..proto->mapGenData[0x28]`
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

So resources do NOT each roll independently against a shared stream - there is a
per-tile max-probability arbitration first, then one roll. This app's
`resolveResource.ts` already does an analogous order-priority pick (though by
autoplace order, not max-probability - a discrepancy to revisit if this is ever
built).

### FALSIFIED for Vulcanus rocks: max-probability arbitration cannot produce the game's population (2026-07-27)

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

## The oil `random_probability` follow-up (still folded in)

Unchanged from the ROADMAP decision: for `random_probability < 1` (only crude-oil,
1/48) the game multiplies `probability` by `random_penalty{source=1,
amplitude=1/random_probability}` (`resource-autoplace.lua:103-105`). Applying it with
the current hard `>= 0.5` footprint makes oil vanish, so it only pays off together
with a placement roll (exact) OR a density-matched cosmetic dither (approximate,
above). No standalone change.
