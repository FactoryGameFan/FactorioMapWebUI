# Per-tile placement roll (approximate) - design

Point-in-time design record (not a living doc). Written 2026-07-27, after
Vulcanus V3 shipped and both of its flagged judgement calls were revisited.

Closes the mechanism side of issue #9, and closes the other V3 judgement call
too - `all` on Vulcanus measuring 2.13x the terrain baseline, past the ~2x gate -
by a much smaller change than the one first considered. See "Performance".

Standing priority that shaped both halves (Eric, 2026-07-27): **on both planets
cliffs matter more than rocks, and rocks may be approximate.** Every trade below
spends rock fidelity and protects cliff fidelity.

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
under a threshold), Nauvis enemy bases, and Nauvis rocks - which get away with a
threshold today only because the same 0.02 constant happens to paint ~1.6%
there.

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
- rock lattice: placed density at the chosen lattice tracks lattice 1 over the
  same window - the lattice degrades *where* rocks land, not *how many*. The
  bound comes from the coverage/clumping measurement at 1, 2 and 4, on the same
  rule as the oracle band: measured first, then pinned.

## Performance

`all` on Vulcanus is 27.01 us/px against a 12.68 terrain baseline - 2.13x, past
the ~2x gate. The useful framing is not the ratio but the deficit:

| | us/px |
| --- | --- |
| terrain | 12.68 |
| + cliffs (the floor - cliffs must stay exact) | 19.24 = **1.52x** |
| gate at 2x | 25.36 |
| current `all` | 27.01 |
| **deficit** | **1.65** |

Terrain plus cliffs is already 1.52x and is not negotiable, which leaves 6.1
us/px of budget for resources + rocks + geyser against the 7.1 they spend. The
whole problem is 1.65 us/px, and it is taken out of rocks.

**Coarse rock field sampling.** Rocks cost 3.69 us/px, essentially all of it
evaluating the probability field per tile; the roll itself is one array lookup
and a compare. So the two are decoupled: **evaluate the rock probability field
on a 2x2 tile lattice, and keep rolling every tile** against the nearest lattice
value. Every tile still rolls, so density is preserved and the density oracle
stays valid - only the field's spatial resolution degrades. Expected cost ~0.92
us/px, saving ~2.77, which clears the gate on its own. Applies to both planets'
rock renderers.

The risk is aliasing, not correctness. `vulcanus_decorative_knockout` runs at
`input_scale = 1/3`, so its patchiness lives at roughly a 5-tile wavelength: a
2-tile lattice should hold it, a 4-tile lattice would start smearing the
patchiness that makes rocks read as rocks. Implementation measures coverage and
clumping at lattice 1, 2 and 4 and picks from the measurement rather than
assuming 2.

Nothing else is touched. Cliffs keep their full per-sample cost, which is the
point.

## Approach B (fused, arbitrated single pass) - considered and dropped

B was the alternative: one sweep, shared fields evaluated once, every overlay's
probability computed from them, max-probability arbitration, one roll, paint the
winner. It is the game's actual rule, and it would remove the salt.

Dropped on the arithmetic:

- Its ceiling is the sum of the three overlay marginals, 13.66 us/px - and the
  real deficit is 1.65. It is sized four times larger than the problem.
- **It cannot help cliffs**, the largest marginal at 6.56. Cliff corners sit on
  a 4-tile lattice, so that pass samples at lattice positions while a fused
  sweep evaluates at pixel positions - different coordinates share nothing.
  Cliffs are also a separate generator in Factorio, not an entity autoplacer, so
  they do not belong in the arbitration either.
- Its non-perf benefit is arbitration replacing the salt, which improves
  fidelity of **rock and ore contention** - precisely the fidelity that is
  allowed to be approximate.
- It would rewrite how every overlay is invoked and change `all` from the union
  of the overlays to a strict subset, invalidating the premise of an existing
  test.

A cheaper variant of the same idea - caching shared per-pixel fields in
`Float32Array`s for the render's lifetime instead of restructuring loops - was
also considered. Same ceiling, same inability to help cliffs, and unnecessary
once rocks are sampled coarsely.

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

**Perf.** The roll adds one map lookup and one compare per pixel per overlay,
with 1024 draws amortised across a chunk - expected to disappear against the
existing per-pixel field cost. The saving comes from the rock lattice above. The
whole path is re-benchmarked at the end: `all` on Vulcanus must land under 2x
the terrain baseline, and Nauvis must not regress.

## Deliberately out of scope

- **Vulcanus cliff entity-level validation.** With cliffs ranked above rocks,
  this is now the largest open correctness item on either planet, and it is not
  a perf question at all. Nauvis cliffs were checked against a real
  `find_entities_filtered{type="cliff"}` dump at ~94% tile-for-tile; Vulcanus
  has no equivalent capture, so what is proven there is that one noise field
  matches to 5e-6 and that the placement geometry is the same code scoring 94%
  on Nauvis - not that the composition reproduces the game's actual cliff
  positions. Should be the next spec.
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
- `docs/noise/vulcanus-cliffs-NOTES.md` - the "Performance, and a known
  duplication" section records the 2.13x breach; update it with the resolution
  and the new measurement, including that fusing was costed and dropped
- `docs/noise/client-preview-ROADMAP.md` - the per-resource render rule entry
- `test/fixtures/PROVENANCE.json` - the new fixture
- issue #9 - closes
