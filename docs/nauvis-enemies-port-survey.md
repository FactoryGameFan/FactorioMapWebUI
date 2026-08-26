# Nauvis enemy bases - a port survey of the two TypeScript files

A structural read of `src/noise/enemies/enemyCatalog.ts` and
`src/noise/enemies/enemyBaseField.ts`, taken on 2026-08-26, before the Rust port
of that layer began (#226, phase 6). Written for the same reason the resource,
tree, and cliff/rock surveys were: so the port does not re-derive the dependency
order, the exact signatures, or the comments in those files that record a
measurement rather than an intention.

**This is a snapshot of a moving target.** The code is the authority; when the
two disagree, the code wins and this file is stale. Line numbers are from
2026-08-26.

**The port it was written for has LANDED.** The Rust lives in
`crates/fmw-noise/src/enemies/` - `catalog.rs` and `field.rs`, mirroring the two
TypeScript files. Section 0's magnitude buckets are frozen exactly as measured
here and passed on the first Rust run, and tier 2 was bit-identical across all
84 fields on its first run too. Four things this survey got wrong or could not
know:

- **Section 4 said to fold the spot field separately. That was backwards.** The
  argument was that a `max` hides its operands, as the tile argmax and the rock
  max do. Checking the magnitudes refutes it: the spot field runs from -1000 to
  about +1 while the blob term is roughly +/-0.15, so the composed field is
  DOMINATED by the spot field rather than masking it. The block is two fields,
  not three, and folding the spot field would also have meant reimplementing the
  region scan in the parity spec, which the TypeScript does not expose.
- **Section 2.1's #270 alarm is real about the divergence and wrong about the
  consequence.** `powf` against `r * r * r` is genuinely different at 25.4% of
  the radii, but the consumer narrows: the cone's `peak` is `f32(f32(3q) / ...)`,
  and an f32 carries about 1.2e-7 of relative precision. Bracketed by planting,
  tier 2 sees a 1e-7 relative change in `quantity` and does NOT see 1e-9 or
  1e-12. One f64 ULP is 2.2e-16, so the swap is invisible to every tier - and so
  is a one-ULP wasm-libm difference. Write `powf` because the reference writes
  it, not because anything would catch you.
- **Section 5's open question is answered.** `probability` DOES go red under
  poison, but thinly: one position of 1032 crosses zero, 42 becoming 43. The
  field test above it is the real gate.
- The distance-scalar test needed its constants computed rather than
  transcribed. A hand-typed `239.424_242_780_712_2` was wrong in the seventh
  digit; the value is `239.424_266_788_582_1`.

Siblings: `docs/nauvis-resources-port-survey.md`,
`docs/nauvis-trees-port-survey.md` and
`docs/nauvis-cliff-rock-fields-port-survey.md`. Conventions from that work carry
and are not repeated at every line: reproduce the TypeScript faithfully rather
than fixing it, a finding gets its own issue, and `snapPosition` runs before
anything is scored against a fixture.

---

## 0. The headline: the exact-match count MEASURES MAGNITUDE here, not accuracy

This is the most important thing in the survey and it is easy to get wrong.

`enemy_base_probability` scores 210 of 1032 exact at seed 123456 and 127 of 1032
at seed 777771. Those look like ordinary tier-1 counts. They are not. Split by
the magnitude of the game's own value:

| bucket | seed 123456 | seed 777771 | worst residual |
| --- | --- | --- | --- |
| basement, `\|v\| >= 100` | **209 / 239** (87.4%) | **126 / 159** (79.2%) | 4.29e-5 |
| mid, `1 <= \|v\| < 100` | **0 / 602** | **0 / 658** | 9.76e-6 |
| live, `\|v\| < 1` | **1 / 191** | **1 / 215** | 4.17e-6 |

Essentially the entire headline count is the basement. The field's basement is
`-1000`, so those positions run near `-1007`, where one f32 ULP is about 6e-5 -
larger than the whole residual. They are exact for free. Where the field is
actually doing something, the port matches 2 positions of 406 across both seeds.

This is CLAUDE.md's "a clamp flatters it" rule in a new costume, and it is
halfway to the resource layer's degeneration. **Freeze the three buckets, not
the headline.** A single frozen 210 would go green on a port whose cone
arithmetic was badly wrong, and would move for reasons that have nothing to do
with the cones - a fixture recapture that shifted the basement/live split would
change it on its own.

The residual to explain is therefore **4.17e-6 on values below 1**, which is
about 70 f32 ULPs at that magnitude. That is the same order as the resource
layer's cone residual and probably the same family of causes; do not expect the
count to close.

---

## 1. What the fixture grades

| property | value |
| --- | --- |
| fixture | `oracle-enemy-base.seed123456.json`, Factorio 2.1.11 |
| positions | 1032 |
| seeds | 2 (123456, 777771) |
| off-grid positions | **0** |
| controls | default (`enemy-base` frequency and size both 1) |
| game value range | -1006.91 to 0.82 (seed 123456), -1020.24 to 0.96 (777771) |
| positions with a positive value | **42** and **48** of 1032 |
| positions at or above the 0.25 cap | 17 and 21 |

Three consequences:

- **The snap is the identity**, exactly as on the two cliff fixtures. Snapped and
  raw score identically, 210/210 and 127/127. Assert the off-grid count is 0 and
  compare both arms, rather than applying a snap that buys nothing -
  `test/captureGrid.ts`'s own rule for a snap that has reached zero.
- **The live region is about 4% of the fixture.** `probability` is
  `clamp(min(field, 0.25), 0, 1)`, which is 0 at 990 of 1032 positions. Grading
  `probability` on its own would be nearly vacuous; grade `field`.
- **Neither control lever is graded by tier 1**, because the capture is at the
  defaults and both levers are dead there: `size` enters as `sqrt(size)`, and
  `frequency` as a plain multiplier on `enemy_frequency`. Tier 2 has to move
  them, the way the tree levers are moved.

---

## 2. `enemyCatalog.ts` - 103 lines, constants and four scalars

```
ENEMY_SEED1                    123
ENEMY_REGION_SIZE              512
ENEMY_CANDIDATE_SPOT_COUNT     100
ENEMY_SPACING                  45.254833995939045
ENEMY_BASEMENT                 -1000
ENEMY_MAX_SPOT_BASEMENT_RADIUS 128
ENEMY_PLACEMENT_CAP            0.25
STARTING_AREA_RADIUS           150
ENEMY_RANDOM_PENALTY_AMPLITUDE 0.1
ENEMY_SPAWNER_MAP_GEN_BOX      { w: 7.4, h: 6.4 }
```

and the four distance-dependent scalars:

```
intensity(d) = clamp(d, 0, 2400) / 325
radius(d)    = max(0, sqrt(size) * (15 + 4*intensity))
quantity(d)  = (PI/90) * radius^3
frequency(d) = (1e-5 + 3e-6*intensity) * controls.frequency
density(d)   = quantity * max(0, frequency)
```

At the default controls, measured:

| d | radius | quantity | density |
| --- | --- | --- | --- |
| 0 | 15.000000 | 117.8097 | 1.178097e-3 |
| 325 | 19.000000 | 239.4243 | 3.112515e-3 |
| 1000 | 27.307692 | 710.8245 | 1.366970e-2 |
| **2400** | 44.538462 | 3083.9903 | 9.916215e-2 |
| 6000 | 44.538462 | 3083.9903 | 9.916215e-2 |

**All four saturate at d = 2400**, because `intensity` clamps there. The fixture
positions start at (768.5, 768.25), a distance of about 1086, so they sit inside
the live range - a sweep placed past 2400 would grade the clamp and nothing else.

### 2.1 `radius ** 3` is a REAL hazard, measured

`enemySpotQuantity` writes `radius ** 3`, which in JavaScript is `Math.pow`.
The obvious Rust translation `r * r * r` is **not** the same function.
Measured over every integer distance from 0 to 2400 at six size sliders,
14,406 radii in all:

> `r ** 3` and `r * r * r` differ at **3,653 of 14,406 (25.4%)**, worst relative
> 2.220e-16 - one f64 ULP.

CLAUDE.md already records the settled answer for this shape: `p ** octaves` is
**`powf`, not `powi`**, because `powi` disagrees with V8 by one ULP. So write
`radius.powf(3.0)`, never `powi(3)` and never a hand-expanded product.

**And this is the layer's #270 exposure.** Nauvis has reached no transcendental
until now, so no Nauvis value has ever been computed by the wasm libm. `powf`
is one. The mitigation used elsewhere - compute it in V8 and pass the value in -
does **not** apply, because `quantity` is evaluated per SPOT at a
position-dependent distance, not once per render. So this has to be graded
rather than sidestepped, and tier 2 is the only tier that can see it: `cargo
test` runs on the host libm (#270).

**A one-ULP error here can have a DISCRETE effect**, which is what makes it worth
this much attention. `quantity` feeds `select_spots`, which sorts by favorability
and trims against a region target. A spot that survives the trim on one port and
not the other moves a whole cone, not a ULP.

### 2.2 Two constants that are documentation, not arithmetic

`ENEMY_RANDOM_PENALTY_AMPLITUDE` and `ENEMY_SPAWNER_MAP_GEN_BOX` are read by the
RENDER path (`renderEnemies.ts`), not by the field. Port them with the catalog so
the render PR does not have to come back for them, but they grade nothing here.
`ENEMY_SPAWNER_MAP_GEN_BOX` carries a warning worth keeping verbatim: it is
`map_generator_bounding_box`, deliberately NOT `collision_box`, and neither
Nauvis nor Vulcanus rocks declare that field - so check for it FIRST when porting
any further overlay.

---

## 3. `enemyBaseField.ts` - 137 lines

```
enemy_base_probability =
    spotField + blobTerm - 0.3 + min(0, (20/STARTING_AREA_RADIUS)*distance - 20)

spotField = max(ENEMY_BASEMENT, max over nearby spots of (peak - dist*slope))
blobTerm  = (basis(1/8) + basis(1/24) + 2*basis(1/64) - 0.5)
              * (radius(d) / 150) * (0.1 + 0.9*clamp(d/3000, 0, 1))
```

Points that need care:

- **The cone is f32 per operation and the file says so.** `peak`, `cone` and
  `radius` are all wrapped in `f32(...)`. Mirror every one of those narrowing
  points exactly - CLAUDE.md's rule, and the resource layer's most expensive
  lesson.
- **There is no `min(32, ...)` radius cap.** That clamp is resource-only, and the
  header calls it out. `coneScale` is always 1 here, because
  `hardRegionTargetQuantity` is `false`.
- **`favorability` is the constant 1**, so every candidate is equally favoured and
  the trim is by acceptance order. That is a legitimate `SpotExpression`, not a
  missing feature.
- **The blob reads THREE `basis_noise` calls at plain divided coordinates** -
  `x/8`, `x/24`, `x/64` - through the low-level `basisNoise`, not through
  `basisNoiseExpr`. The `2 *` on the third is an `output_scale` of 2 written at
  the call site. `basisNoise` is the op #191 deliberately did NOT change, and
  these are exactly the "unported NAUVIS chains where the whole expression is
  un-narrowed" that note points at. **Port it as written and re-score; do not
  narrow it on the way in.**
- **`min(0, ...)` and the outer `max`** go through `min2`/`max2` in the
  TypeScript's argument order, for the signed-zero reason.
- **The region scan is `[-128, +128]` in both axes**, from
  `ENEMY_MAX_SPOT_BASEMENT_RADIUS`, with `regionIndex(c) = floor((c + 256) / 512)`.
  A spot further than 128 from the sample is skipped by `d2 > R*R` before its
  radius is ever computed.

### 3.1 The region cache: copy `vulcanus_biomes`, not the rest of Nauvis

Every other Nauvis layer evaluates top to bottom in one pass with no memo,
because every read is at the same `(x, y)`. **This one is not like that**: it
reads selected spots from up to four neighbouring regions, so it needs a real
cache. `expressions/vulcanus_biomes.rs` already has the shape:

```rust
region_cache: RefCell<BTreeMap<(i64, i64), Vec<SelectedSpot>>>,
```

`RefCell` so `eval` can stay `&self` while the closures handed to `select_spots`
borrow it, and `BTreeMap` rather than `HashMap` because a determinism-critical
port should not carry a container whose iteration order is unspecified.

Everything else already exists. `select_spots` takes `hard_region_target_quantity`
and a constant `favorability`; `SelectedSpot` carries `cone_scale`;
`SpotRegionKey`, `spot_candidate_points` and `distance_from_nearest_point` are all
ported and graded. **No new primitive is needed.**

---

## 4. Tier 2

The block adds 3 fields, taking `NauvisParity::FIELD_COUNT` from **82 to 85**:
`enemy_base_field`, `enemy_base_probability` and the spot field on its own.

Fold the spot field separately from the composed field. The blob term and the
starting-area term both move smoothly, so a composed fold is dominated by them;
the spot field is where a wrong trim or a wrong cone shows, and it is the half a
`max` against `-1000` most easily hides.

- **Build it lazily**, behind a `OnceCell`, like the resource and cliff blocks.
  Constructing it does no work until a spot is asked for, but the cache it owns
  should not be built for the 82 fields that never read it.
- **`NauvisCtx` needs two levers**: `enemy_frequency` and `enemy_size`. Both are
  dead at the default, so the sweep must move them or neither is graded anywhere.
- **The sweep windows need spots in them.** The live region is 4% of the tier-1
  fixture, and the existing tier-2 windows were chosen for ore and trees. Freeze a
  per-window count of positions above the basement, the way the resource block
  freezes its per-resource hit counts, or a window with no enemy base in it folds
  `-1000` on both sides and grades nothing.

## 5. Poison

No new op, so no new hook - everything under this composes `basis_noise`,
`distance_from_nearest_point` and `spot_selection`, all of which carry theirs.
List the new tier-1 tests in `POISONED_TESTS` anyway and watch them go red, for
the reason the resource block's entry gives: a named list is what stops a future
change making a test unreachable from every hook.

**Check `probability` separately.** It is `clamp(min(field, 0.25), 0, 1)`, and
990 of 1032 positions clamp to 0. A numeric perturbation of a value pinned at a
clamp bound does not move it, so a test that grades only `probability` may stay
green under poison - the same shape as the cliff gate, for a different reason.
Measure it; do not assume either way.
