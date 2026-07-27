# Per-tile placement roll (approximate) - design

Point-in-time design record (not a living doc). Written 2026-07-27, after
Vulcanus V3 shipped and both of its flagged judgement calls were revisited.

Closes the mechanism side of issue #9. The other judgement call from V3 - `all`
on Vulcanus measuring 2.13x the terrain baseline, past the ~2x gate - is **not**
addressed here; see "Deliberately out of scope".

## The problem

Five overlays draw a *region* where the game draws *entities*, because each one
thresholds a probability field instead of rolling against it.

Vulcanus rocks are the clearest case. Both rock expressions are
`min(0.2 * (1 - k * ashlands), ...)`, so the field is a **plateau**, not a
gradient, and raising the threshold clips it rather than thinning it:

| threshold | coverage |
| --- | --- |
| 0.02 | 7.03% |
| 0.08 | 5.50% |
| 0.12 | 3.81% |
| 0.19 | 2.37% |

Even at 0.19, a hair under the cap, a third of the ink survives. There is no
threshold that produces scattered rocks. What the overlay honestly draws is
"rocky ground". The same shape of problem affects the geyser (probability caps
around 0.065), Nauvis crude oil (its `random_probability` factor makes it vanish
under a threshold) and Nauvis enemy bases.

## What is built

The per-chunk placement roll reverse-engineered in
`docs/noise/placement-roll-NOTES.md`, in a **deliberately approximate** form:

```
word = max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY + salt)   # u32
s1 = s2 = s3 = word                                            # taus88
draws are assigned to the chunk's 1024 tiles in DECREASING tile index
place the entity where U < probability(x, y)
```

Two departures from the game, both intentional:

1. **No cross-overlay arbitration.** The game picks one winning entity per tile
   by max probability and rolls once. We roll each overlay independently.
2. **No jitter draws.** The game spends two extra draws per *placement* to
   offset the entity within its tile, which makes its draw count
   data-dependent.

Departure 2 is what makes this tractable, and it is worth being precise about
why. With a fixed one-draw-per-tile count, `U` depends only on the chunk
coordinate and the tile's index within the chunk - so `roll(x, y)` is a **pure
function of world position**. That is the property the tiled renderer depends
on, and its absence is one of the two reasons the 2026-07-22 spec
(`2026-07-22-rocks-overlay-and-density-dither-design.md`) shelved this mechanism
as a 3-5 session project. The other reason was that the game's shared stream
drags in every entity autoplacer in the chunk, including worms and fish.
**Departure 1 removes that coupling and departure 2 restores purity, so the
earlier costing no longer applies.** This is a reversal with a reason, not an
oversight.

Departure 1 introduces one artifact that has to be handled: with a single shared
stream, a tile whose `U` is 0.01 would place for *every* overlay whose
probability exceeds 0.01, visibly correlating rocks with ore with spawners. The
per-overlay `salt` decorrelates the streams. It is the one value in this design
with no counterpart in the game, and it exists solely to stand in for the
arbitration we are not doing.

### Module

`src/noise/placement/placementRoll.ts`

```ts
makePlacementRoll(salt: number): { roll(x: number, y: number): number } // U in [0,1)
```

Chunk = `Math.floor(x/32), Math.floor(y/32)`; tile index within chunk =
`(y & 31) * 32 + (x & 31)` (JS bitwise `& 31` and `Math.floor` both behave
correctly for negative world coordinates); draw *k* is assigned to tile index
`1023 - k`, so the first draw belongs to the last tile. `U = (taus88Next(st) >>>
0) / 2**32`, giving `U` in `[0, 1)`.

Salts are distinct arbitrary constants, one per overlay, declared together in
the module so the set is visible at a glance rather than scattered across five
call sites. Their values carry no meaning beyond being different from each
other.

Each chunk's 1024 values are computed once and memoised in a `Map` owned by the
roll instance. Instances are created per render, so a worker tile holds only the
chunks it touches (16 chunks, ~64 KB, at the current tile size).

`src/noise/taus88.ts` already provides `seededState` and `taus88Next`; nothing
new is needed there.

### Per-overlay changes

| overlay | today | after |
| --- | --- | --- |
| Vulcanus rocks | `density >= 0.02` | `roll(x,y) < density(x,y)` |
| Vulcanus geysers | blob where `patchy > 0` | roll against the geyser's own probability |
| Nauvis rocks | `density >= 0.02` | `roll(x,y) < density(x,y)` |
| Nauvis enemy bases | `min(ebp, 0.25) >= 0.05` | roll against `min(ebp, 0.25)` |
| Nauvis crude oil | `probability >= 0.5` | roll against `probability * random_penalty{source:1, amplitude:48}` |

Existing exclusions (water, starting-area clearing) are unchanged - the roll
replaces the threshold test, nothing else.

The four solid ores and uranium **keep** the `>= 0.5` threshold: they are
genuinely dense in-game and were not in scope. `ResourceParams` therefore gains
a `placement: "threshold" | "roll"` field, so the renderer selects by data
rather than special-casing crude oil by name.

`VULCANUS_ROCK_FOOTPRINT_THRESHOLD`, `ROCK_FOOTPRINT_THRESHOLD` and
`ENEMY_FOOTPRINT_THRESHOLD` become unreachable and are deleted.

### Mark size

A placed tile paints a uniform **3x3** mark for all five overlays, through a
`paintMark` helper extracted from the existing `paintCliffCells` (which already
does block-paint plus `skipPixel`). Cliffs keep their own radius of 2.

Uniform rather than per-prototype: at 1 tile/px a faithful footprint would draw
a 1x1 crude-oil cell and a 3x3 spawner differently, and the legibility that
buys does not justify a per-entity size table.

## Validation

**Density oracle.** `test/oracle/captureEntityCounts.ts` force-generates chunks,
then counts entities by name with `find_entities_filtered` over chunk-aligned
regions near and far from spawn, on both planets - Vulcanus through the
`game.planets['vulcanus'].create_surface()` recipe the V1/V3 captures already
use. Output: `test/fixtures/oracle-entity-counts.seed123456.json`, plus its
`PROVENANCE.json` entry (`fixtureProvenance.spec.ts` fails without one).

The comparison is count-per-region. The game rolls once per tile and places one
entity per success, so our placed-tile count and its entity count are directly
comparable.

**The band is set from the first measurement, not guessed.** A wrong
probability field misses by multiples; the RNG deviation should sit in the low
percent. If the first measurement lands far off, that is a finding to report -
not a number to widen the band around.

**Unit tests:**

- the seed word against the constants in `placement-roll-NOTES.md`
- the reverse-index assignment (draw *k* -> tile `1023 - k`)
- world-anchoring: `roll(x, y)` is independent of the render window, so
  `tiledEquality.spec.ts` stays byte-identical across all views
- decorrelation: two salts' placement sets over a window intersect at roughly
  the product of their rates, not the minimum - the artifact the salt exists to
  prevent

## Risks

**Oil's `random_penalty` is a batch op.** Its value at a point depends on the
batch's extent and order. `random-penalty-NOTES.md` pins that for the
resource-spot path, not for the noise-evaluation path this needs. If it does not
resolve quickly, oil rolls against the un-penalised probability with the
deviation documented, or returns to the threshold as a re-opened item. **It does
not block the other four.**

**The geyser has no probability field yet.** Only `sulfuricAcidRegionPatchy > 0`
is computed today (gap #4 in `vulcanus-resources-NOTES.md`). Porting and
oracle-validating the real expression is a prerequisite for that overlay, not
for the mechanism.

**White-noise clumping.** The 2026-07-22 spec identified this: a
`hash(x,y) < density` test thresholds into clumps and holes, and that spec
required a blue-noise mask to avoid it. This design walks into it deliberately,
because the game's own roll *is* white noise - so the clumping is the game's
look, not an artifact of ours, and a blue-noise mask would trade fidelity for
tidiness. If the rendered result reads badly, the fallback is a blue-noise mask
with the same density, which keeps the density oracle valid and changes only
which tiles are chosen. Flagged for a human eyeball, like the coverage question
that prompted this work.

**Perf.** One map lookup and one compare per pixel per overlay, with 1024 draws
amortised across a chunk. Expected to disappear against the existing per-pixel
field cost, but this touches a path already past the perf gate, so it is
measured rather than assumed.

## Deliberately out of scope

- **The 2.13x perf breach.** The fused, arbitrated single-pass render would fix
  both the breach and departure 1 above, and is the natural follow-on. It is not
  bundled here: it rewrites how every overlay is invoked, and landing a risky
  refactor together with a new mechanism makes both harder to judge.
- **Trees.** The 2026-07-22 spec wanted them stippled too, and they are a sixth
  consumer of this mechanism. Left out to keep the change reviewable.
- **Nauvis solid ores and uranium.** Dense in-game; the threshold is right.
- **Tile-exact placement.** Requires the full cross-subsystem simulator the
  M3.5 spike stopped on. Nothing here moves toward it.

## Documentation to update

- `docs/noise/vulcanus-rocks-NOTES.md` - rewrite "The render is a threshold, and
  it does not look like the game"
- `docs/noise/placement-roll-NOTES.md` - record what was built versus what the
  spike stopped on
- `docs/noise/client-preview-ROADMAP.md` - the per-resource render rule entry
- `test/fixtures/PROVENANCE.json` - the new fixture
- issue #9 - closes
