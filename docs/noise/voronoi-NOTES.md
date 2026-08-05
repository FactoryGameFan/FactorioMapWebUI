# voronoi\_\* - reverse-engineering notes

Source: Factorio **2.1.12**, arm64 macOS Steam build (unstripped - see
`CLAUDE.md`, "The binary is the oracle"). Probed headless via `noise-expression`
prototypes read back with `LuaSurface.calculate_tile_properties`, and read
instruction-for-instruction out of the disassembly. Companion to
`docs/noise/basis-noise-NOTES.md` and `docs/noise/spot-noise-NOTES.md`.

All four ops - `voronoi_cell_id`, `voronoi_spot_noise`, `voronoi_facet_noise`,
`voronoi_pyramid_noise` - across all four `distance_type`s and jitters
`{0, 0.6, 0.8, 1}` are solved and **bit-exact at f32**. Implementation
`src/noise/voronoiNoise.ts`; 126 tests in `test/voronoiNoise.spec.ts` and
`test/voronoiSearchRange.spec.ts`. Fixtures:

| fixture | what it pins |
| --- | --- |
| `oracle-voronoi-jitter0.seed123456.json` | 15 series x 175 positions, jitter 0 |
| `oracle-voronoi-points.seed123456.json` | 45 series x 175 positions at jitter 0.6/0.8/1, plus an inversion lattice recovering the point positions |
| `oracle-voronoi-cellid.multiseed.json` | 9 seed series x 256 cells - the RNG alone |
| `oracle-voronoi-search-range.seed123456.json` | the positions where the neighbour ring is observable |

**Read this file for the METHOD, not just the answer.** Several of the numbers
below were first obtained with the wrong mechanism attached, and in one case
(chebyshev's `sqrt(9/8)`) a correct number with a wrong stated cause survived two
tasks. Where a claim has no stated measurement here, treat it as a hypothesis.

---

## 0. The single most important lesson: jitter 0 is a DEGENERATE configuration

At `jitter = 0` every cell's point sits exactly at the cell centre, so every cell
is a congruent unit square and a large family of different algorithms produce
**identical** numbers. Reproducing it perfectly is no evidence at all about
`jitter > 0`.

How that was learned, rather than reasoned: Task 2 fitted
`voronoi_pyramid_noise` as the distance to the nearest edge of the unit square,
and it matched **175 of 175** at jitter 0 for every distance type. When
`oracle-voronoi-points.seed123456.json` arrived, the same formula scored **0 of
175** at every one of the nine captured jitter x distance_type combinations, with
errors up to about half a cell.

The rule that came out of it, and which the rest of this file follows: **a model
validated only on a degenerate configuration has not been validated.** Every
finding below is stated with the jitter it was measured at.

---

## 1. Normalisation: divide the DELTAS by `grid_size`, not the distance

The docs say the returned distance "is based on the grid size" and that
`tile_distance = grid_size * distance`, which reads like "compute the distance in
tiles, then divide by `grid_size` at the end". The two are algebraically
identical and differ only in f32 rounding.

**Method.** Both forms were implemented and scored against the fixture, per
distance type:

| form | minkowski3 score |
| --- | --- |
| distance in tiles, divided at the end | 110 / 175 |
| deltas converted to grid units first | **175 / 175** |

The other three distance types score 175/175 either way and **cannot
discriminate**. `minkowski3` can because its cube root runs through the game's
fastapprox `log2`/`exp2` pair, which amplifies a sub-ulp input difference past
one ulp of output.

Corroborated in the disassembly: the sample position is converted to grid units
before the point loop is entered.

Related, same method: `minkowski3` must use the fastapprox pair and not
`Math.cbrt` - an exact cube root scores **25 / 175**. The ~1e-5 relative error is
a property of the game, not an approximation introduced by the port. And
`minkowski3` takes `abs()` on both terms; the docs said otherwise until the
erratum at forums.factorio.com/viewtopic.php?p=685547, and `runInternal<3>`
settles it by clearing both lanes' sign bits with `bic.2s v0, #0x80, lsl #24`
before cubing.

The divisor itself is `grid_size` and not half of it or the cell diagonal:
measured as the ratio of the distance in tiles to the reported value, which is
exactly 64.0 at `grid_size = 64` for all four distance types. `test/voronoiNoise.spec.ts`
fails on `gridSize * 2`.

---

## 2. The per-cell hash: Thomas Wang's 32-bit mix, READ not fitted

```
cellSeed(cx, cy) = (seed0 + seed1) ^ wang(cx) ^ wang(ror16(cy))
```

with three draws off that word - `wang(w + 0)` and `wang(w + 1)` are the point's
x and y offset inside its cell, and `wang(w + 2)` is the value `voronoi_cell_id`
reports. Each draw is converted `(double)u32 * 2^-32` and then narrowed to f32
(`ucvtf d0, w8` / `fmul` by `0x3df0000000000000` / `fcvt s14, d0`); doing the
multiply in f32 would round twice.

**Method: read out of `NoiseOperations::VoronoiPoints::VoronoiPoints` in the
2.1.12 arm64 binary.** The six Wang constants `0x7ed55d16`, `0xc761c23c`,
`0x165667b1`, `0xd3a2646c`, `0xfd7046c5`, `0xb55a4f09` appear verbatim as
immediates. The `+1` / `+2` draws are visible because the compiler folds them
into the mix's first addend, so `0x7ed56d17` and `0x7ed57d18` sit alongside
`0x7ed55d16`. The rotation is a literal `ror w8, w8, #0x10`, **on the Y index
only**. `seed0 + seed1` is a plain 32-bit sum read in `VoronoiNoise::VoronoiNoise`
(`w8 = asNoiseLayerID(seed1) + (uint)seed0`, stored at `+0x20`), so a string
`seed1` enters as its `NoiseLayerID` crc32 - `Noise::setSeed`'s
`unsigned char` second parameter does **not** apply to this primitive.

Then confirmed behaviourally against `oracle-voronoi-cellid.multiseed.json`:
9 seed series x 256 cells, **all exact**.

### The candidates that were rejected, and the evidence against each

Recording these because each is the obvious next guess and re-testing them costs
hours.

- **taus88** (the RNG behind `basis_noise` and `spot_noise`). Refuted by
  **exhaustive inversion over all 2^32 seed words, in both axes**: no additive
  `(cellX, cellY)` lattice exists at all. This is a search, not a spot check.
- **`basis_noise`-style seeding.** Refuted by a **discrimination probe**: the
  candidate word is identical for `seed1` in `{0, 1, 137}`, while all three
  captured series differ at every cell. One shared word cannot produce three
  different series.
- **A symmetric `F(cx) ^ F(cy)` with no rotation.** Refuted by a **prediction it
  makes and the fixture denies**: without the rotation, every diagonal `(k, k)`
  collides with `(0, 0)`. It does not - `(1, 1)` is distinct. What the rotation
  buys is visible in the fixture too: `(0, 0)` collides with `(-1, -1)` (both
  reduce to the bare seed, since `ror16(0) == 0` and `ror16(~0) == ~0`), as does
  `(-1, 0)` with `(0, -1)`, and **those two pairs are the only duplicate values
  in each of the 9 captured series**.

---

## 3. The point offset: `f32(f32(j*r) + f32(f32(1-j)*0.5))`, with `jitter` narrowed FIRST

Read out of the same constructor as a single 2-lane sequence, one lane per axis,
so x and y are handled identically:

```
fmul.2s  v1, v1, v0[0]   ; * jitter
fsub     s0, s11, s0     ; s11 = 1.0   (fmov s11, #1.00000000)
fmul     s0, s0, s12     ; s12 = 0.5   (fmov s12, #0.50000000)
fadd.2s  v13, v1, v0     ; jitter * r + (1 - jitter) * 0.5
```

Two details are load-bearing:

- **`jitter` is narrowed to f32 before any arithmetic.** The prototype field is
  read as a double and immediately converted: `ldr d0, [x20, #0x88]` /
  `fcvt s0, d0` / `str s0, [x19, #0x28]`. So a Lua `jitter = 0.6` is stored as
  `f32(0.6)`. **Method for why this matters: carrying the double through instead
  scores 2939 / 4200** on the fixture's spot and facet samples. That is the size
  of error that gets absorbed into a fudge factor rather than diagnosed.
- **The constructor stores the in-cell FRACTION only** (`str d13, [x22]`, two
  f32, then the id at `+0x8`); the cell index is added by the consumer. The
  offset is therefore in grid units.

At `jitter === 0` this collapses to exactly `0.5`, independently confirming the
cell-centre premise the jitter-0 rung was built on. Corroborated behaviourally:
`spot_noise` reads exactly `0` - not merely small - at all 25 of the jitter-0
fixture's exact cell centres, for every distance type.

### Point placement does NOT depend on `distance_type` - settled structurally

`VoronoiPoints`' constructor is handed the whole `VoronoiNoise` and, across its
entire 1508 bytes, loads exactly three fields out of it: `+0x20` (seed,
`ldr w9`), `+0x24` (grid size, `ldr h0`) and `+0x28` (jitter, `ldr s0`).
`distance_type` is a byte at `+0x26`, written by `VoronoiNoise`'s own constructor
(`bl parseDistanceType` / `strb w0, [x19, #0x26]`), and the point generator
**never reads it**. The fixture agrees: the inverted apexes are identical under
manhattan and euclidean at every jitter.

That is what makes one shared point cache legitimate across ops that differ only
in distance type - which is exactly what Fulgora's `fulgora_cells` (manhattan)
and `fulgora_spots` (euclidean) do off one `seed1`.

### But `cell_id` does NOT agree across distance types - the obvious test is false

Worth stating loudly, because "the points are shared" invites the wrong
corollary. Point **placement** is distance-type-blind; which point is **nearest**
is chosen under the metric, and the metrics disagree near a boundary.

**Method.** 400 x 400 sample grid, stride 3.25 tiles, origin `(-650, -650)`,
`gridSize` 175, `jitter` 0.6, `seed0` 7, `seed1` 11:

| pair | `cellId` disagreements |
| --- | --- |
| manhattan vs euclidean | 10933 / 160000 = 6.83% |
| manhattan vs chebyshev | 20915 / 160000 = 13.07% |
| euclidean vs minkowski3 | 4250 / 160000 = 2.66% |

Task 6's own brief specified a test asserting the opposite (50 positions,
manhattan vs euclidean at jitter 0.6); it fails at two of them, `i = 25` and
`i = 29`. The test that replaced it asserts the invariant that IS a consequence
of a shared point set: since `|v|_inf <= |v|_2 <= |v|_1` for any single vector
and `min` preserves the ordering, `spotNoise` must satisfy
`chebyshev <= euclidean <= manhattan` at every position **whatever point wins in
each**. Its non-vacuity is measured, not asserted: changing one field's `seed1`
to 999 - a different point set, everything else identical - violates the ordering
at **30036 of 40000** positions.

`minkowski3` is deliberately excluded from that chain even though
`|v|_inf <= |v|_3 <= |v|_2` holds exactly, because its fastapprox cube root
breaks the ordering at near-ties on **1927 of 40000** positions. That is the port
faithfully reproducing the game.

---

## 4. The sample-to-point delta must be REBASED on the sample's own cell

This is the finding most likely to be lost in a rewrite, because the two forms
are algebraically identical.

`runInternal<0>` computes the sample's in-cell fraction **once**, then forms each
neighbour's delta from that fraction and the neighbour's **relative** index:

```
101772528: scvtf s25, w30       ; (float) the sample's own cell index
10177252c: fsub  s23, s23, s25  ; sampleFrac = ux - cellIndex
...
101772598: scvtf s27, w12       ; (float) the neighbour's RELATIVE index
1017725a0: ldp   s28, s29, [x21]; the neighbour's stored in-cell fraction
1017725a4: fadd  s28, s28, s1   ; frac + relative index
1017725ac: fabd  s28, s28, s23  ; |that - sampleFrac|
```

**Method: score every ordering against the fixture's 4200 spot and facet
samples.** The exact expressions, because the two absolute variants do not score
the same and "the absolute form" is not reproducible:

| delta expression | score |
| --- | --- |
| `f32(ux - (cell + frac))` - inner sum left as a double | 3734 / 4200 |
| `f32(ux - f32(cell + frac))` - inner sum rounded to f32 | 2921 / 4200 |
| `f32(f32(frac + relIndex) - f32(ux - cell))` - what the binary does | **4200 / 4200** |

Two more orderings (`f32(f32(ux - cell) - frac)` and its negation) also scored
3734, so no amount of re-ordering the absolute form reaches the answer - the
rebasing is the thing.

**All 466 misses of the best absolute form are exactly one ulp.** `cell + frac`
at a cell index of ~11 has an f32 spacing of `2^-20`, while the rebased form
never adds a large number to a small one.

**And `cell_id` scores 100% under the wrong form**, on all 12 of its series,
because a one-ulp shift almost never changes *which* point is nearest. So an
argmin test could never have caught this; only the exact-value test did.

---

## 5. `voronoi_pyramid_noise`: minimum over BISECTORS, not over points

The docs say "like facet noise but the gradient is uniform and represents the
distance to the closest edge", and that is literally what it is: the Euclidean
distance from the sample to the nearest cell boundary, computed as the
**minimum over every neighbour EXCEPT the nearest** of the distance to that
pair's bisector under `distance_type`.

It is a second loop in the binary, after the `d1`/`d2` loop, seeded with
`FLT_MAX` (`mov w8, #0x7f7fffff`) and reduced with `fcsel ... mi`. Skipping the
nearest point is **not** an optimisation: a zero-separation pair has a degenerate
bisector and would pin the minimum at 0 everywhere.

Two shapes:

- **euclidean** (`runInternal<2>`, `0x101773d64`) has a closed form, because a
  Euclidean bisector is a straight line: `dot(mid, normalize(b - a))` with both
  points taken relative to the sample. The zero-length guard on the normalise is
  the binary's own (`fcmp #0.0` on both components before the `fdiv`s), not
  defensive padding.
- **manhattan and chebyshev** inline an L1-bisector routine
  (`computePyramidNoiseManhattan`, `0x1017758b8`), chebyshev after a 45-degree
  map. Under L1 the equidistant set is a **polyline** - a 45-degree segment
  flanked by two axis-parallel rays - and the routine builds all three pieces,
  clamps a foot onto each, and takes the nearest of the three.

**The reflection is not a no-op and must be reproduced literally.** manhattan and
chebyshev pass the points as `sampleFrac - delta`, i.e. the point **reflected
through the sample**, with the sample itself as the third argument (`fsub s24,
s24, s22` then `fsub s24, s22, s24`, `0x1017732bc`). A point reflection about `s`
is an isometry fixing `s`, so this is mathematically redundant - but **it is not
redundant at f32: removing it fails 6 of the captured series.** Method: delete it
and re-run. Do not "simplify" it to the euclidean path's sample-relative form.

Two f32 details in the L1 routine that a tidier rewrite would lose:

- the clamps are `fmaxnm`/`fminnm`, which return the non-NaN operand. A
  degenerate segment gives `0/0 = NaN`, and `fmaxnm(NaN, 0)` is `0` - so the NaN
  handling is the binary's behaviour, not padding.
- `p1[mnr]` is `a[mnr]` and `p2[mnr]` is `b[mnr]` by construction, but the binary
  re-loads them from the `p` copies, so the ray parameters are formed against
  those.

One deviation is deliberate and already checked: `Math.min`/`Math.max` stand in
for `fcsel mi`/`fcsel gt`, which differ only on NaN operands and on the ordering
of `+0` against `-0`. Neither input can be NaN, and the only place the `+0`/`-0`
choice is observable immediately squares its result.

### chebyshev's `sqrt(9/8)` is ONE HARDCODED IMMEDIATE - and this is the best argument in the effort for reading the binary

L-infinity becomes L1 under a 45-degree rotation, so mapping the points and then
building an L1 bisector is the right construction. The bisector does not care
what the scale `k` is - `[[k, k], [-k, k]]` is `k * sqrt(2)` times a rotation for
any `k`, and scaling both points scales the bisector with them. What `k` controls
is the **distance the routine then reports**, which comes back multiplied by
`k * sqrt(2)`. A true isometry wants `k = 1/sqrt(2) = 0.70710678`.

The game uses `fmov s16, #0.75000000` at `0x101772864`. And
`0.75 * sqrt(2) = 1.06066... = sqrt(9/8)`, so **every chebyshev pyramid value is
6.07% larger than the true distance to the cell boundary.**

Task 2 measured that `sqrt(9/8)` factor at jitter 0 and attributed it to a clamp
biting at a segment endpoint. **The number was right and the stated mechanism was
wrong**, and the difference is not cosmetic: the clamp story predicts the factor
varies with jitter and with position, and a port built on it would have been
tuned rather than fixed. There is no geometry in it at all - it is one immediate,
at every jitter.

If you take one methodological point from this file, take this one: a model that
reproduces a number is not thereby a model of the mechanism, and the binary is
cheap to read.

### The game REJECTS `voronoi_pyramid_noise` x `minkowski3`

Measured by asking the game: the expression fails at **compile time** with
"Voronoi pyramid noise with Minkowski3 distance is not supported". All 15 other
op x distance_type pairs compile. `runInternal<3>` has no pyramid path at all.
The port throws the same message.

---

## 6. `getPointsSearchRange` is PER DISTANCE TYPE

```
chebyshev  -> 1, always
manhattan  -> jitter > 0.5       ? 2 : 1
euclidean  -> jitter > f32(0.66) ? 2 : 1
minkowski3 -> jitter > 0.75      ? 2 : 1
```

**Method: read from the jump table.** `VoronoiNoise::getPointsSearchRange` is at
`0x101774fd4`; the table is at file offset `0x102d00a88`, holding `[13, 0, 3, 8]`
indexed by `DistanceType`, based at `0x101775008`. Entry 0 (chebyshev) branches
straight past the compare to the epilogue with `w0` still holding the
`mov w0, #1` from before the table, so **chebyshev is pinned at 1**. The other
three fall into `fcmp jitter, <threshold>` / `csinc w0, #2, wzr, gt`. The
thresholds are the immediates `#0.5`, `0x3f28f5c3` (= `f32(0.66)`) and `#0.75`.
The identical sequence is inlined at the top of every `runInternal` (its own
table at `0x102d00a74`), and both the generated point region and the
`[-range, +range]` loop bounds use the result.

This is the bug Factorio fixed in 2.1.7 (forums.factorio.com/130905).

### It was INERT for a whole task, and finding where it is not was a task of its own

Forcing the range to 2 for all four distance types passed 95/95 voronoi tests.
Forcing it to 1 **also** passed 95/95. All 2100 committed values were indifferent
to it, in both directions. A constant would have shipped.

`oracle-voronoi-search-range.seed123456.json` ends that. The argument for where
to look:

- **Only `voronoi_pyramid_noise` can see the ring at all.** `spot`/`facet`/
  `cell_id` need a ring-2 point to **win** the argmin; the pyramid only needs one
  to be nearly **EQUIDISTANT**, because it minimises the distance to each pair's
  bisector, which for euclidean is `(|f|^2 - |n|^2) / (2 |f - n|)`.
- The disagreements are rare - **113 in a 4096x4096-tile sweep** for chebyshev at
  jitter 1 - which is why 175-position grids never hit one.

### The "a wider ring can only lower a min" argument is FALSE

It sounds airtight and it is not, and it is the argument that keeps getting
re-derived. It targets the **nearest-point** loop, where a wider ring genuinely
cannot change the answer at `jitter <= 1`. But the pyramid's answer comes from
its **bisector** minimum, where a ring-2 point does not have to be nearest - it
only has to be nearly equidistant with the nearest, which puts its bisector close
to the sample. **Chebyshev at jitter 1 shows 177 disagreeing positions in a
4096^2 sweep.**

### The thresholds themselves are NOT behaviourally pinned

Stated so nobody over-claims the fixture. A disagreement needs high jitter;
sweeps at manhattan 0.5 and euclidean `f32(0.66)` found **zero** differences. The
fixture bounds manhattan's threshold below 0.7 and euclidean's below 0.9, and
that is all the game will say. The exact values rest on the disassembly plus a
weaker table test in `test/voronoiSearchRange.spec.ts`, which is labelled as
weaker there.

### The fixed `SEARCH_RING = 2` used by the other three ops

Re-measured **2026-08-05 with the window recorded**, because the previous version
of this measurement quoted "a 1024x1024-tile sweep" and "58 of 262144", and those
two only reconcile at an unstated stride of 2. A measurement nobody can reproduce
is not reusable, which is the standard this repo holds.

> `seed0 = 123456`, `seed1 = 0`, `gridSize = 175`; window origin `(0, 0)`,
> **512 x 512 tiles at stride 1 tile** (262144 samples); `d1`, `d2` and `cell_id`
> captured at each `distance_type` x `jitter` in `{0.6, 0.8, 1}` with
> `SEARCH_RING = 2`, then again with `SEARCH_RING = 1`, compared value for value.

- **`d1` and `cell_id` differed in NONE of the 12 configurations** - 0 / 262144,
  twelve times.
- **`d2` differed in exactly one**: manhattan at jitter 1, **496 / 262144**. The
  game's range there is 2, so the fixed ring agrees with it; a hardcoded 1 would
  have been wrong.

For `d1` and `cell_id` the surplus ring is not merely unobserved, it is
**impossible**: the own cell's point has `max(|dx|,|dy|) < 1` at any
`jitter <= 1`, and every ring-2 point exceeds 1 on an axis, so under chebyshev a
ring-2 point can never win. Euclidean at jitter 0.6 is bounded the same way - own
cell within `0.8 * sqrt(2) = 1.131`, ring-2 at least `1.2`. **The genuinely
unproved class is `d2`/facet at a distance type whose game range is 1.**

### Every Fulgora call site, and what each is exposed to

From the pinned 2.1.12 `space-age/prototypes/planet/planet-fulgora-map-gen.lua`,
each row read at its line: `fulgora_jitter = 0.6` (:140),
`fulgora_road_jitter = 1` (:405), `fulgora_structure_jitter = 0.8` (:447).

| expression | op | dt / jitter | game range | port ring | status |
| --- | --- | --- | --- | --- | --- |
| `fulgora_cells` (:145) | cell_id | manhattan 0.6 | 2 | 2 | agrees |
| `fulgora_pyramids` (:156) | pyramid | manhattan 0.6 | 2 | 2 (per type) | correct |
| `fulgora_spots` (:167) | spot (d1) | euclidean 0.6 | 1 | 2 | provably safe |
| `fulgora_road_cells` (:410) | cell_id | chebyshev 1 | 1 | 2 | provably safe |
| `fulgora_road_pyramids` (:421) | pyramid | chebyshev 1 | 1 (per type) | - | pinned by fixture |
| `fulgora_structure_cells` (:452) | cell_id | minkowski3 0.8 | 2 | 2 | agrees |
| `fulgora_structure_facets` (:474) | **facet (d2)** | minkowski3 0.8 | 2 | 2 | agrees |

**The one `d2` site lands on game range 2**, which is the fixed ring, so it
agrees by construction. The residual risk from pinning `SEARCH_RING` at 2 is
therefore nil for what Fulgora ships, rather than "measured to be small". An
earlier list here omitted `fulgora_road_cells` and both `fulgora_structure_*`,
which is how the residual came to be described as merely measured.

---

## 7. The 1/256 `MapPosition` snapping trap

**Cost Task 2 a wrong score of 79/175 and a plausible-looking model error.**

Factorio's `MapPosition` is a fixed-point type with 1/256-tile resolution. A
probe position that is not representable in 1/256 gets snapped before the
expression sees it, so the game evaluates at a slightly different point than the
capture script recorded. The resulting residual is around **4e-5** - small,
smooth, and entirely consistent with "our formula is nearly right", which is
exactly what makes it dangerous. It reads as a model error and invites a fudge
factor.

**Method that found it:** re-probe at positions that ARE representable (any
multiple of 1/256; the fixtures use `.5` and `.25`) and watch the residual go to
zero rather than shrink. All voronoi fixtures now sample only representable
positions.

Generalises beyond this primitive: any oracle capture that feeds the game a
position must use representable coordinates, or it is measuring the snap.

---

## 8. Performance: the caches, and why they cannot change a value

`makeVoronoi` returns a closure holding three caches, added 2026-08-05:

1. a `Map<number, {x, y}>` of **in-cell point offsets**, keyed by the packed cell
   index `(cx & 0xffff) * 0x10000 + (cy & 0xffff)`;
2. a **one-entry cache over the `d1`/`d2`/argmin search**, so `cellId`,
   `spotNoise` and `facetNoise` read at one pixel run the 25-cell search once
   rather than three times;
3. `memoXY` on each of the four returned ops.

Why it matters: a render sweeps one pixel at a time and each sample touches a
`(2*ring+1)^2` block, while the pyramid walks its block twice. At
`gridSize = 175` a single cell is the same cell for 30,625 consecutive samples,
so without the cache the same six Wang mixes are redone tens of thousands of
times per cell. This is the same lever that took the Vulcanus renderer ~50x
faster with no output change.

**All three are byte-exact by construction**: each hands back the *identical*
float or object the first call produced, never a recomputed one. **The
correctness proof is that all 120 pre-existing exact-value tests pass unchanged**
- a cache that changed any value is a bug, not an optimisation.

One trap, recorded because it is invisible: `memoXY` records the coordinates
**before** calling through, so wrapping a function that throws leaves the slot
claiming a value it never produced, and the next call at that position returns
the *previous* position's number instead of throwing. `pyramidNoise`'s
minkowski3 rejection is therefore hoisted out of the memo, and
`test/voronoiNoise.spec.ts` asserts the throw survives a repeat call at a primed
position.

`searchRangeOverride` on `VoronoiParams` is a test hook that plants the wrong
ring so the committed game values can reject it. Its "nothing that renders a map
may set this" was documentation only until 2026-08-05; it is now a spec in
`test/voronoiSearchRange.spec.ts` that walks `src/**` and permits the declaration
alone, confirmed to discriminate by planting an offender.
