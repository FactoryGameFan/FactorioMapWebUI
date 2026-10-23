# spot_noise - reverse-engineering notes

Source: Factorio 2.1.11 (build 86962), probed headless via `noise-expression`
prototypes read back with `LuaSurface.calculate_tile_properties`, and
independently cross-checked against a disassembly of the (non-stripped) shipped
executable - every selection phase confirmed instruction-for-instruction (see
"Binary-RE cross-check" below). Companion to `docs/noise/basis-noise-NOTES.md`,
which covers `basis_noise` (solved the same two ways).

`spot_noise` places every ore patch. All three stages are now solved
(2026-07-17), each confirmed against the binary:

- **Candidate RNG** (see "Candidate RNG - SOLVED"): canonical L'Ecuyer taus88,
  seeded per region with three small primes. Implementation
  `src/noise/spotCandidates.ts`, fixtures `test/fixtures/spot-candidates.game.json`.
- **Spot selection** (see "Spot selection - SOLVED"): dart-throw over the
  candidate stream with a 15/16-per-rejection squared-spacing decay, skip
  round-robin, density target sampled at the accepted spots, favorability-sorted
  trim with self-similar hard-target shrink. Implementation
  `src/noise/spotSelection.ts`, 55 game-captured configurations in
  `test/fixtures/spot-selection.game.json`.
- **Field rendering** (see "Field rendering - SOLVED"): each selected spot is a
  linear cone `peak * (1 - dist/radius)`; overlapping cones combine by **max**
  over a `basement_value` floor.

Community consensus was that this function is "black magic"; none of the facts
below appear to be publicly documented.

## The technique: candidate points are directly observable

Force `spot_noise` to place exactly **one spot** with constant radius/quantity.
The output field is then a single cone, and the cone's apex **is** the candidate
point. Because the cone is linear in distance,

```
|p - c| = radius * (1 - value(p) / peak)
```

every sample gives a circle around the unknown centre `c`, so `c` trilaterates
exactly from the samples around the apex (observed residual 0.0000, giving exact
integer coordinates). This turns a hidden RNG stream into something you can read
off a heightmap.

## Confirmed

- **The cone formula is exact.** Peak height measured 23.8732 for
  quantity=10000, radius=20; `3 * q / (pi * r^2)` = 23.8732. Also 66.3144 vs
  66.3146 predicted at radius=12. Falloff is linear in distance, reaching 0 at
  `radius`.
- **Candidate points are at integer coordinates.** Trilateration residual 0.0000.
- **Regions are CENTRED on multiples of `region_size`**, not aligned to it:
  `region_index = floor((x + region_size/2) / region_size)`. Verified with one
  spot per region over a 5x5-region area: exactly 25 cones, and the indices come
  out one-per-region only for origin -512 (with origin 0, some indices appear
  twice and others none). A window of `[0, region_size)` therefore straddles
  **four** regions - which is why it shows two spots when `candidate_spot_count = 1`.
- **Default candidate point count = `(region_size / spacing)^2`.** The game's own
  default spacing is `45.254833995939045` = `32 * sqrt(2)`, and with
  `region_size = 1024` that is `(1024 / (32*sqrt(2)))^2` = **exactly 512**.
- **Candidate points are spaced, not uniform random.** Min nearest-neighbour
  distance 17.03 over 354 points in a 1024^2 region; uniform-random points would
  give ~1.35. Mean NN 33.4 against the 45.25 spacing parameter. Consistent with
  the docs' "minimum spacing to *try* to achieve" - a Poisson-disk / jittered
  process, not a plain PRNG draw.

## Gotchas (each one cost a run)

- **`maximum_spot_basement_radius = 0` suppresses every spot.** The field comes
  back entirely `basement_value` with no cones at all. This silently defeats any
  probe that sets it to 0 as an apparently harmless default.
- **`hard_region_target_quantity` takes 0/1**, not `true`/`false`. The game's own
  calls in `core/prototypes/noise-functions.lua` pass integers.
- **`skip_offset = 1` with `skip_span = 1` is legal.** An older version of this
  note said only offset 0 works with span 1 and anything else hard-crashes the
  game. That was wrong. `scripts/probes/spot-skip-offset` (2026-10-22, 2.1.23 and
  2.0.77, fixture `test/fixtures/oracle-spot-skip-offset.json`) ran Gleba's own
  `gleba_simple_spot` call with offset 1 and an offset 0 control, one process
  each. Offset 1 ran cleanly, returned a field with 177 of 512 positions on a
  cone, and differed from offset 0 at 14 positions (never higher). That fits the
  binary: the game draws `candidate_spot_count * skip_span` accepted spots and
  keeps indices `skip_offset, skip_offset + skip_span, ...`, so with span 1 offset
  1 is offset 0 minus the first spot. Offset 5 with span 1 also ran without a
  crash (field not inspected).
- **`density_expression` is quantity per unit area**, so it is a small number.
  The regional target is `average density * region area`; with `density = 1` and
  `region_size = 1024` the target is 1048576, i.e. ~104 spots of quantity 10000.
- The canonical parameter set to copy is `core/prototypes/noise-functions.lua`
  (`starting_patches` / `regular_patches`) - not the API docs, which do not make
  the above clear.

## The candidate-point cache (a hard crash, and what it reveals)

Probing many `skip_offset` values in one map crashed the game once (the cause
is not the offset - see the `skip_offset` gotcha above):

```
SpotNoiseCache.cpp:150: this->candidateSpotCount == candidateSpotCount was not true
```

This corroborates the documented claim that the candidate series is shared across
expressions with the same `seed0`, `seed1`, `region_size` and
`suggested_minimum_candidate_point_spacing` - the game caches it on exactly that
key and **asserts** that every expression sharing the key agrees on the count.
This is the likely cause of the recorded crash, but it is read from the assertion
text, not reproduced: `scripts/probes/spot-skip-offset` put two expressions with
counts 22 and 23 on one key, plus offset, span and offset-past-span variants, and
`calculate_tile_properties` raised no assertion in any of them. The assertion
probably needs another path, such as chunk generation.

Practical consequence: to vary `candidate_spot_count` or `skip_offset` you need
**one headless run per value**. Recovering generation *order* is then a matter of
running `candidate_spot_count = 1, 2, 3, ...` and diffing the resulting cone sets;
the newly-appearing cone is the next point in the series. (Note this must be done
per region - see the region-centring result above, or the diffs will interleave
points from four different regions.)

## Candidate RNG - SOLVED (2026-07-17, v2.1.11)

The complete algorithm, verified bit-exact against the game:

```
W    = (0x3FBE2C + 7927*seed1 + 7919*rx + 7907*ry)  mod 2^32
word = max(W XOR seed0, 0x155)
s1 = s2 = s3 = word                      -- canonical L'Ecuyer taus88 state
V[k] = taus88 output k (output taken after the state update)
candidate i = (V[2i], V[2i+1])           -- x then y, 2 draws per candidate
world coord = region_index * region_size + (V mod region_size) - region_size/2
```

- `(rx, ry)` is the region *index* (regions centred on multiples of
  `region_size`). 7907/7919/7927 are three consecutive primes; 7919 is the
  1000th prime. Bit 0 of the `0x3FBE2C` base is unobservable (dead in all three
  taus88 words) and irrelevant to output.
- The `max(word, 0x155)` clamp guards the taus88 all-zero fixed point: measured
  words 0..341 all behave as 341 and 342 is untouched; the clamp applies to the
  *final* word, after the seed0 XOR (proven by driving each side to a tiny value
  independently).
- Blind validation: candidate sets predicted *before* the game ran matched
  exactly for 6/6 random (seed0, seed1, region, region_size) combinations,
  including the game's real `region_size = 1024`, negative region indices, and
  seeds up to 2^32-1. Combined with the taus88 identification below (1280
  observed bits, 88-bit state, zero contradictions), the model is exact.

Why the seeding facts measured earlier fall out of this: seed0 bit 0 is dead
because taus88's state words ignore their low 1/3/4 bits; the "index-dependent
XOR scatter" of seed0's low bits is just the F2-linear propagation of a state
XOR through a linear generator; and the seed1 "avalanche" is nothing more than
multiplication by 7927.

### How it was cracked (method notes for the next primitive)

1. **The published "not GF(2)-linear" conclusion (below) was wrong** - or
   rather, over-claimed. Berlekamp-Massey on 40 draws returns complexity ~n/2
   for *any* linear generator with state larger than ~20 bits; it only rules
   out tiny LFSRs. taus88's 88-bit state was never actually excluded.
2. The decisive (and free) test: treat the 88 initial-state bits as GF(2)
   unknowns, expand the generator symbolically, and Gauss-eliminate the 1280
   observed bit equations. taus88 with canonical constants came back consistent
   at rank exactly 88; lfsr113/xorshift128/xorshift32 and every draw-order
   variant contradicted. The recovered state forward-reproduced all 40 draws.
3. Two clues pointed at taus88 before any solve: Factorio's `RandomGenerator`
   carries three 32-bit words, and "seed0 bit 0 ignored" matches s1's dead
   bit 0 exactly.
4. With the generator known, **CRT across region sizes is unnecessary**: a
   power-of-two region size exposes the draw's low bits directly as linear
   equations, so 6 candidates (132 bits) over-determine the 88-bit state from
   ONE run - and the unknown draw order is recovered by trying all 720
   permutations (44 excess bits make false positives ~2^-44). One headless run
   with ~30 probe expressions (different seeds routed onto arbitrary
   `property_expression_names` keys) recovered the whole seeding matrix.

The original structural findings (all confirmed by the solution) follow.

All of the below is measured against 2.1.11 by CRT-combining
runs at region sizes 2048/2050/2058/2066 (pairwise-coprime-ish, product > 2^32)
and cross-checking against 512/1000/1024.

### The coordinate is a 32-bit integer reduced mod the region size

```
world_coord = (V mod region_size) - region_size/2       (V is a 32-bit value)
```

**Proof it is exactly 32-bit:** CRT over the four region runs gives V modulo
~2.23e12, yet every recovered V for 20 candidates x 2 axes lands below 2^32. By
chance that is (2^32 / 2.23e12)^40 ~ 10^-100. So each candidate carries a full
u32 quantity and the region size only enters as a final `mod`. The same V stream
reproduces across *all* region sizes - region_size is not part of the RNG key,
only the reduction.

### The spacing parameter does not consume draws

`suggested_minimum_candidate_point_spacing = 0.001` vs `= 45.25` produce
**identical** candidate values. So the "Poisson-disk" spacing acts later, during
spot *selection*, not during candidate generation. `candidate_spot_count = 1,2,3,
...` therefore walks a single fixed draw stream `V[0], V[1], ...` (x then y per
candidate), and the k-th accepted point is deterministic.

### The stream looked non-linear - a WRONG conclusion, kept as a warning

Berlekamp-Massey linear complexity of every bit-plane of 40 consecutive draws is
~n/2 (18-22 of 40). This was read as "not F2-linear, rules out taus88/LFSR" -
but BM needs ~2x the state size in samples, so 40 draws only rule out
generators with < ~20 state bits. taus88 (88 bits) shows exactly this ~n/2
signature on short streams. The direct symbolic GF(2) solve (see above) is the
correct test, and it identified taus88 from the same 40 draws.

Also ruled out by direct solve on the 40-draw stream: LCG over 2^32/2^31/2^48/
2^64, PCG-not-attempted-blind, `finalizer(LCG-state)` for finalizer in
{murmur3 fmix32, fmix64, single xorshifts, identity} on interleaved / x-only /
y-only orderings, 64-bit LCG whose (hi,lo) = (Vx,Vy), and Wang hash of the index.
The specific non-linear generator is **still unidentified** (PCG32-XSH-RR is the
natural remaining suspect but was not blind-solved).

### Seeding - historical partial findings (all explained by the solved law)

- **`seed0` bit 0 is ignored.** `0 == 1`, `123456 == 123457`, `2^31 == 2^31+1`
  all give identical candidates.
- **`seed1` fully avalanches** the value: `V[0]` vs `seed1` shows no low-order /
  LCG structure (well-mixed).
- **`seed0`'s low bits (bit >= 1) enter `V` through a GF(2)-affine (XOR-linear)
  bit-scatter.** `seed0 = 48`'s XOR-delta equals `seed0=16` XOR `seed0=32`
  exactly (full 32-bit), and additive combos like `seed0=1234` predict the
  coordinate exactly. Each seed0 bit XORs a fixed spread 32-bit mask into
  `(Vx,Vy)`.
- That seed0 scatter is **`seed1`-independent** (byte-identical masks at seed1=0
  and seed1=5, for bits 1 and 4) but **index-dependent** (bit-1 mask is
  `dVy=0x080` for `V[0]` but `dVx=66` for `V[1]`). So seed0 does *not* separate
  as one global linear term - the linear map is per-candidate. Contrast
  `basis-noise-NOTES.md`, where seed0 low bits below ~384 were *fully ignored*;
  here they are a positional dither. The two primitives seed **differently**.

Net: `V(seed0,seed1,region,index) = NonLinear(seed1,region,index) XOR
L_index(seed0)`, with `L_index` GF(2)-linear in seed0 but varying with index.

### Reproducing

The recovered 20-candidate stream (seed0=123456, seed1=0) is in
`spot-candidate-stream.seed123456.json` alongside these notes; 11 further
game-captured candidate sets (random seeds/regions plus the clamp edge cases)
are in `test/fixtures/spot-candidates.game.json`. Probe harness (not committed,
needs a Factorio install): one headless `--create` run with a mod registering
`spot_noise` probe expressions (literal seeds, `candidate_spot_count = 6`,
radius 20, quantity 10000), routed onto arbitrary `property_expression_names`
keys; `on_init` coarse-scans each region window at stride 8, fine-scans each
blob at stride 1, and the apex of each cone IS the candidate (integer coords,
peak `3q/(pi r^2)`). Gotcha from this session: mods for 2.1.x must declare
`"factorio_version": "2.1"`.

## Spot selection - SOLVED (2026-07-17, v2.1.11)

The algorithm that turns the candidate stream into rendered spots, verified
exactly on 55 game-captured configurations (density/favorability/quantity
expressions, spacing 0.001..100000, counts 6..24, skip sets, hard targets,
region sizes 1024/2048):

```
1. DART-THROW over the candidate stream, in generation order.
     spacingSq = suggested_minimum_candidate_point_spacing^2
     accept candidate iff distSq(candidate, a) >= spacingSq for every
       previously accepted a; on each rejection spacingSq *= 15/16.
     Walk until candidate_spot_count * skip_span spots are accepted.
     (No cap observed through ~170 tried; rejected candidates never return.)
2. SKIP: accepted spot j (acceptance order) belongs to set j mod skip_span;
   an expression renders the set matching its skip_offset.
3. TARGET: regional quantity target = mean of density_expression over the
   set's accepted spot positions, times region_size^2. (Proven to sample the
   ACCEPTED spots, not the first candidates and not a uniform average, via
   step-function densities on seeds whose acceptance shifts the sample.)
4. TRIM: stable-sort the set by favorability (evaluated at each spot)
   descending (ties keep acceptance order; negative favorability does NOT
   exclude a spot); walk in that order accumulating spot_quantity_expression
   (evaluated at the spot); keep while accumulated < target. With
   hard_region_target_quantity=1 the last kept spot's quantity is cut to hit
   the target exactly and its cone shrinks SELF-SIMILARLY: radius and peak
   both scale by (q'/q)^(1/3) (measured peak ratio 0.7937 = (1/2)^(1/3) for a
   half-quantity shrink).
```

The decay constant is exact and was the hard part: per-rejection factor on
*distances* is sqrt(15/16) = 0.9682458. Bounds from 2000+ accept/reject events
narrowed it to (0.968235, 0.968263); 12 seeds where sqrt(15/16), 61/63 and
e^(-1/31) predict *different accepted sets* then scored 12/12, 4/12, 0/12.
I.e. the game compares squared distances and knocks 1/16 off the squared
threshold per rejection - "suggested minimum spacing ... to try to achieve".

Notable dead ends measured on the way: acceptance under constant favorability
is generation order (dens1..6 kept exactly the first k candidates); the sort
was proven with fav = -x; `candidate_spot_count` is NOT the stream length but
the accepted-spot count (streams ran to index 169 for 6 spots at spacing 1e5);
linear and harmonic spacing decay are excluded by the same event bounds.

## Binary-RE cross-check - every phase confirmed (2026-07-17)

The field-derived selection algorithm was independently verified against a
disassembly of the shipped 2.1.11 executable (the same non-stripped Mach-O the
`basis_noise` seeding was cracked from - see basis-noise-NOTES.md). The
`ThreadSafeSpotNoiseCache::SpotListGenerator` methods are named exactly for each
phase and match `src/noise/spotSelection.ts` instruction-for-instruction:

- **`generatePoints`** - the dart-throw. `spacingSq = spacing*spacing`; the
  reject path is literally `fmul spacingSq, spacingSq, #0.9375` (**15/16**, the
  hard-won decay constant, sitting as an immediate); acceptance is
  `distSq >= spacingSq` against every accepted spot. On rejection it draws a
  *new* candidate (two more taus88 outputs) with the decayed threshold. **No
  tried cap** - since `spacingSq` decays geometrically to 0, acceptance is
  eventually guaranteed, so the game has nothing like `spotSelection.ts`'s
  `MAX_TRIED` (that is a pure safety net). The inline candidate RNG re-confirms
  the primes `0x1ee3/0x1eef/0x1ef7` (7907/7919/7927) and base `0x3fbe2c`.
- **`generateSpotList`** - the skip set. Copies accepted indices
  `skip_offset, skip_offset + skip_span, skip_offset + 2*skip_span, ...` into the
  working set, i.e. exactly `accepted.filter(j => j % span === offset)`. So the
  target and trim below **run per skip set**, not globally (resolves the old open
  question). Order of operations: `generatePoints` -> select skip set -> evaluate
  the density/favorability/quantity/radius expressions at those spots ->
  `sortSpotCandidates` -> `placeSpots`.
- **`computeRegionTargetQuantity`** - `sum(density over the set) / count`
  (`fdiv` by the spot count = mean) `* region_size^2` (`mul w,w,w` then `fmul`).
  Mean density over the *selected* spots times region area, exactly as measured.
- **`sortSpotCandidates`** - a `std::__stable_sort` (stable, so ties keep
  acceptance order) over an index array, comparator `fav[a]`/`fav[b]`. The
  base-case `fcmp fav[last], fav[first]; b.le (no-swap)` puts higher favorability
  first: **descending**, matching `.sort((a,b) => b.fav - a.fav || a.j - b.j)`.
- **`placeSpots`** - the trim. Accumulates `quantity` in sorted order while
  `acc < target`; with `hard_region_target_quantity` the last spot's quantity is
  cut to `target - acc` and its cone shrinks self-similarly: `ratio = q'/q`, then
  `exp2(log2(ratio) * 0.33333334)` = **`cbrt(q'/q)`** scales the radius, and
  `peak = 3*q' / (pi * r'^2)` (constants `3.0` and `pi` are right there). Exactly
  `coneScale = Math.cbrt(q2 / q)`.

Two rendering-side details the *selection* function deliberately does not model,
now pinned for whoever wires up the renderer:

- The effective radius is `min(maximum_spot_basement_radius, radius_expression)`
  (a `fcsel` in `placeSpots`), and a spot with **non-positive quantity or radius
  is skipped** (not emitted, not counted toward the target) - which is the
  mechanism behind the documented `maximum_spot_basement_radius = 0` "no spots"
  gotcha.
- `SpotNoise` object field offsets, for reference when reading the disassembly:
  `+0x38` density reg, `+0x3c` quantity reg, `+0x40` radius reg, `+0x44`
  favorability reg, `+0x48` seed1/seed0, `+0x54` maximum_spot_basement_radius,
  `+0x58` region_size, `+0x5c` candidate_spot_count*skip_span, `+0x60` spacing,
  `+0x64` skip_offset, `+0x68` skip_span, `+0x6c` hard_region_target_quantity.

## Field rendering - SOLVED (2026-07-17, binary)

The last open corner - how the selected spots become the output field - is
`NoiseOperations::SpotNoise::run`, and it is a plain max-of-cones over a
basement:

```
out[query] = basement_value                       # initial fill, from SpotNoise+0x50
for each spot within the region bounds:
  for each query position with |query - spot| <= maximum_spot_basement_radius:
    dist = sqrt((query.x - spot.x)^2 + (query.y - spot.y)^2)
    cone = spot.peak - dist * spot.slope          # peak at centre, 0 at spot.radius
    out[query] = max(out[query], cone)            # MAX, not sum
```

- **Overlapping cones combine by MAX** (`fcsel s0, out, cone, gt`), never summed.
  So two adjacent patches produce the higher of the two cones at each tile, not a
  piled-up total.
- **`basement_value`** (`SpotNoise+0x50`) is both the initial fill and the floor:
  a tile far from every spot reads `basement_value`, and since the cone runs
  linearly negative past `spot.radius`, the basement also wins in the annulus
  between `spot.radius` and `maximum_spot_basement_radius`.
- **`maximum_spot_basement_radius`** (`+0x54`) is the per-query **cull radius**: a
  spot is only tested against query points within it (`dist > it -> skip`). Set it
  to 0 and every query is skipped -> the field is uniformly `basement_value`,
  which is the documented "no spots" gotcha, now fully explained (nothing is
  placed *and* nothing would render).
- `spot.slope = spot.peak / spot.radius` (stored by `placeSpots`), so
  `cone = peak * (1 - dist/radius)` - the exact linear cone the selection notes'
  `|p-c| = radius*(1 - value/peak)` trilateration assumed. Spot struct is
  `{x@0, y@4, quantity@8, peak@0xc, slope@0x10}` (20 bytes).
- Spots are looked up per region via `ThreadSafeSpotNoiseCache::getSpotListFuture`
  (async, mutex-guarded, SHA1-keyed cache), then bounds-culled by
  `computeRegionBounds` before the inner loop - both pure optimizations.

`spot_noise` is now understood end to end: candidate RNG, selection, and
rendering, each confirmed against the binary.

## `starting_patches` (2.1.11) and the `favorabilityBatch` primitive change (2026-07-20, M3b)

Two additions from porting `starting_patches` (`core/prototypes/noise-functions.lua`,
the near-spawn guaranteed ore field), verified against a `has_starting_area_placement=1`
oracle fixture and cross-checked against the Steam app's bundled 2.1.11 Lua directly
(see `docs/noise/M3-session-handoff.md`'s "stale data-dump" finding - the numbers
below are the CURRENT 2.1.11 values; an earlier draft used 2.0.77 numbers from a
stale `~/Downloads` dump and got several of them wrong).

**The 2.1.11 `starting_patches` expression, as implemented (`startingPatches.ts`):**

- `starting_resource_placement_radius = 150` (not 120 in 2.0.77).
- `region_size = radius * 3 = 450` (not `radius * 2 = 300`).
- `candidate_spot_count = 32`, `suggested_minimum_candidate_point_spacing = 48`
  (not 32).
- `spot_quantity_expression = starting_area_spot_quantity` (a per-set constant, not
  per-spot-varying).
- `spot_radius_expression = starting_rq_factor * starting_area_spot_quantity^(1/3)`
  - also the constant quantity, so every candidate spot has the same base radius;
    the hard-target trim then shrinks the *last* kept spot's radius/peak
    self-similarly by `coneScale` (same mechanism as regular patches).
- `maximum_spot_basement_radius = 2 * starting_rq_factor *
  starting_area_spot_quantity^(1/3)` (~29.5 tiles for iron at default controls) -
  a flat `128` in the 2.0.77 dump. Unlike regular patches (cull 128, radius capped
  at 32 - so the cone is already deep below basement by the cull), this cull sits
  close to the actual cone radius, so it is a genuine HARD cull: the cone is still
  above basement right up to the cutoff, producing a real discontinuity to
  basement at the boundary. This is the game's own behavior, not a port artifact.
- `hard_region_target_quantity = 1`.
- `seed1 = seed1 + 1` for the candidate/selection stream (a distinct stream from
  the regular set, which uses the bare `seed1`); the `blobs0` blob-noise term
  still uses the bare `seed1` - only the spot-selection RNG gets the `+1`.
- `spot_favorability_expression = starting_resources_lake_mask * starting_modulation
  * origin_excluder * 2 - min(1, distance / starting_resource_placement_radius)`,
  where `starting_resources_lake_mask = clamp((elevation - 1) / 10, 0, 1)` (the
  map's `elevation` PROPERTY - `elevation_nauvis` on default Nauvis, NOT the
  `elevation_lakes` literal an earlier draft assumed),
  `origin_excluder = distance > 40` (avoid the crash site/landing spot), and
  `starting_modulation = starting_resource_placement_radius > distance`.
  **This is fully deterministic - there is NO `random_penalty` term.** The 2.0.77
  dump had `+ random_penalty_at(0.5, 1)` appended to the favorability expression;
  that term does not exist in 2.1.11's `starting_patches`. An earlier M3b draft
  assumed it was there (by analogy with `regular_patches`' quantity jitter) and
  needed a batched favorability primitive to reproduce it - see below for why that
  primitive was built anyway, and why it ends up unused.

**`selectSpots` primitive changes** (`src/noise/spotSelection.ts`), built to cover
the case where a favorability expression DOES contain a `random_penalty` term:

- New `favorabilityBatch` option on `SpotExpressions`, mirroring the existing
  `quantityBatch`: an optional `(spots) => number[]` evaluated once over the whole
  skip-set in acceptance order (before the sort/trim), for favorability expressions
  whose `random_penalty` batch semantics (docs/noise/random-penalty-NOTES.md) make
  a single spot's favorability depend on the whole spot list and its order. When
  present it overrides the per-spot `favorability` callback.
- The hard-target trim's `coneScale` shrink now goes through `fastCbrt` (was
  `Math.cbrt`), matching the fastapprox-cbrt fix already applied to the cone
  radius/peak/slope and blob-amplitude cube roots (random-penalty-NOTES.md's
  "fastapprox `cbrt`, not the trim boundary" finding) - consistency, not a new bug.
- **`makeStartingPatches` does NOT end up using `favorabilityBatch`.** Since
  2.1.11's starting favorability turned out deterministic (no `random_penalty`),
  it passes a plain per-spot `favorability` callback to `selectSpots`, same shape
  as `regularPatches.ts`'s density/radius callbacks. `favorabilityBatch` was built
  to cover the case the plan (correctly, per the 2.0.77-derived spec) anticipated,
  and is exercised by the 55-config `spot-selection.game.json` fixture regression
  suite, but no shipped resource expression currently needs it - it stands ready
  for whatever primitive needs it next (spec risk item, closed as "not needed
  here, kept for the next caller").

## Nothing left open

`basis_noise` seeding (the sibling primitive a client-side preview needs) is also
solved - see `basis-noise-NOTES.md`. The remaining work for a client-side map
preview is plumbing (evaluating whole noise programs), not cracking primitives.
