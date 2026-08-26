# Nauvis cliff and rock fields - a port survey of the two TypeScript files

A structural read of `src/noise/cliffs/cliffFields.ts` and
`src/noise/rocks/rockField.ts`, taken on 2026-08-26, before the Rust port of
those two layers began (#226, phase 6). Written for the same reason the
resource and tree surveys were: so the port does not re-derive the dependency
order, the exact signatures, or the comments in those files that record a
measurement rather than an intention.

**This is a snapshot of a moving target.** The code is the authority; when the
two disagree, the code wins and this file is stale. Line numbers are from
2026-08-26.

**The port it was written for has LANDED.** The Rust lives in
`crates/fmw-noise/src/cliffs/fields.rs` and `crates/fmw-noise/src/rocks/field.rs`.
Everything below held up, including every count in section 1 - all four tier-1
tests froze the TypeScript-measured numbers and passed on the first Rust run,
and tier 2 was bit-identical across all 82 fields on its first run too. Four
things this survey could not know:

- The poison question in section 2.3 was answered by building it. With no hook
  on the gate the tier-1 cliffiness test stayed GREEN at 0 mismatches while
  `cliff_elevation` fell from 355 exact to 227, so `poison::bool_result` is
  live on the gate and the measurement is now an assertion of its own.
- **The cliff frequency lever is masked far harder than section 4 assumed.** It
  reaches the block only at the slider's extreme minimum of 1/6; everything from
  0.25 to 6 moves not one field value of 9600. The tier-2 case sets it to 1/6.
- **How blind the gate fold is was measured by planting**, not estimated: it
  misses a 6e-4 shift in `main_cliffiness` and catches 6e-3.
- `cliffCatalog.ts` has its own plain-f64 `sliderToLinear`, separate from the
  game-validated f32-per-operation form in `eval/math.ts`, and `cliffFields.ts`
  is its only consumer. The port reproduces the f64 form and the finding is
  issue #324. Section 2.2 does not mention it because the survey read the call
  site and not the import.

Siblings: `docs/nauvis-resources-port-survey.md` and
`docs/nauvis-trees-port-survey.md`, and the ports they produced. Three
conventions from that work carry and are not repeated at every line: reproduce
the TypeScript faithfully rather than fixing it, a finding gets its own issue,
and `snapPosition` runs before anything is scored against a fixture.

---

## 0. Why these two ship together, and why they are cheap

They are the last two Nauvis *field* layers, and neither needs a new module.
`cliffFields.ts` becomes `crates/fmw-noise/src/cliffs/fields.rs` beside the
already-ported `vulcanus_fields.rs`; `rockField.ts` becomes
`crates/fmw-noise/src/rocks/field.rs` beside `vulcanus_field.rs`. Both are
compositions of parts this port already carries and already grades.

Every dependency is ported. Counted rather than assumed:

| TypeScript import | Rust home | state |
| --- | --- | --- |
| `makeNauvisShared` | `expressions::nauvis_shared::NauvisShared` | ported, graded |
| `makeElevationNauvis` | `expressions::elevation_nauvis::ElevationNauvis` | ported, graded |
| `basisNoiseExpr` | `eval::primitives::basis_noise_expr` | ported, graded |
| `basisNoiseTablesFromSeed` | `basis_noise` | ported, graded |
| `distanceFromNearestPoint` | `distance_from_nearest_point` | ported, graded |
| `sliderToLinear`, `sliderRescale` | `eval::math` | ported, graded |
| `makeMoisture`, `makeAux` | `expressions::nauvis_climate` | ported, graded |
| `makeMultioctaveNoise` | `multioctave_noise::Prepared` | ported, graded |
| `clamp` | `eval::math::clamp` | ported |
| `rangeSelectBase` | `eval::math::range_select_base` | **already there** |

That last row is worth naming. `range_select_base` lives in `eval/math.rs`
because the Vulcanus tile catalog is its heaviest consumer, and its doc comment
already says "the rock port will read it from here rather than restating it."
So the rock port adds no copy of it.

What is genuinely missing is small: seven constants and three helpers spread
across two existing catalog files.

**`cliffs/catalog.rs` needs**, all from `cliffCatalog.ts`:

- `LOW_FREQ_CLIFFINESS_SEED1 = 86883`
- `get_modified_elevation_interval(base_interval, frequency)`
- `get_modified_richness(base_richness, continuity)`
- a `CliffControls` / `CliffSettingsInput` pair, or one flat params struct

**`rocks/catalog.rs` needs**, all from `rockCatalog.ts`:

- `ROCK_SEED1 = 137`
- `NAUVIS_ROCK_MARK_RADIUS_PX = 1`
- `RockControls { frequency, size }`

`rocks/mod.rs` currently opens with "**Vulcanus only.** `rockField.ts` is the
NAUVIS rock field and is deliberately not here." That paragraph is the thing
this port deletes.

---

## 1. What the three fixtures actually grade

All three are already committed, and each grades something different. Measured
on the TypeScript side on 2026-08-26, before any Rust was written, which is the
house order.

| fixture | positions | seeds | off-grid | what it grades |
| --- | --- | --- | --- | --- |
| `oracle-cliff-elevation` | 1024 | 2 | **0** | `cliff_elevation_nauvis`, continuous |
| `oracle-cliffiness` | 1024 | 2 | **0** | `cliffiness_nauvis`, a 0/10 gate |
| `oracle-rock-density` | 26 | 1 | 14 | `rock_density`, an INTERMEDIATE |

### 1.1 The two cliff fixtures are fully on-grid, so the snap is the identity

This is the first phase-6 layer where that is true, and it changes how the test
should be written. `countOffGrid` returns **0** for both, over all 1024
positions. Scoring them snapped and raw gives byte-identical answers:

| field | seed | snapped | raw | worst |
| --- | --- | --- | --- | --- |
| `cliff_elevation_nauvis` | 123456 | **355 / 1024** | 355 / 1024 | 3.933907e-6 |
| `cliff_elevation_nauvis` | 777771 | **281 / 1024** | 281 / 1024 | 4.172325e-6 |

`test/captureGrid.ts` states the rule for this case itself: "If a re-capture
ever lands every position on the grid these counts reach 0, at which point the
snap is the identity and should be deleted rather than left looking
load-bearing." So the cliff tests must not present the snap as if it bought
something. The honest shape is to score at the recorded coordinates and freeze
the off-grid count at 0, so that a future re-capture which introduces off-grid
rows fails loudly instead of quietly needing a snap nobody adds.

### 1.2 `cliffiness_nauvis` is exact, and the fixture is not vacuous

The gate matches the game at **every one of 2,048 positions**, both seeds, zero
mismatches. That is the strongest tier-1 result any Nauvis field has apart from
`temperature`.

An exact score on a discrete field invites the obvious objection: a port that
returned a constant would also score well if the fixture were mostly one value.
It is not. The game returns a non-zero gate at **252 of 1024** positions at seed
123456 and **255 of 1024** at seed 777771, so a constant-0 port would miss about
a quarter of them and a constant-10 port about three quarters. Freeze the
non-zero count beside the mismatch count, the way the resource layer freezes its
no-cone count beside its residual.

### 1.3 `oracle-rock-density` grades an intermediate, not the shipped field

The fixture's values are the game's named `rock_density` expression:

```
rock_density = rock_noise - max(0, 1.1 - distance / 32)
```

with `rock_noise = multioctave(seed1=137, 4 octaves, persistence 0.9,
input_scale 0.15) + 0.25` at the default size. It is **not**
`clamp(max(pHuge, pBig, pSand), 0, 1)`, which is what `makeRockDensity`
returns and what the overlay rolls against.

That distinction has teeth, and it was measured rather than reasoned. At all 26
fixture positions the shipped field returns exactly **0**, because every one of
the three probabilities is negative there - the largest is about -0.097. So the
26 fixture positions grade the shipped field not at all. Tier 1 for rocks can
only grade `rock_density`, and the probabilities above it need tier 2.

| arm | exact | worst |
| --- | --- | --- |
| snapped | **17 / 26** | 8.344650e-8 |
| raw | 7 / 26 | 1.570106e-3 |

**`test/captureGrid.ts`'s table for this fixture has DRIFTED**, the same way its
tree row had. It records `8/26, 1.570e-3` raw and `18/26, 8.508e-8` snapped; the
real figures on 2026-08-26 are **7 and 17**, at worst **8.344650e-8** snapped.
The offset is one in both arms, in the same direction, which is the signature of
the port having moved since the table was taken rather than of a methodology
difference - exactly what the tree row showed. Nothing asserts either row, which
is why both went stale unnoticed. This port corrects the two tree numbers and
the two rock numbers together.

---

## 2. `cliffFields.ts` - 139 lines, two fields

### 2.1 `makeCliffElevation` is two lines

```
cliff_elevation_nauvis(x, y) = 10 + 30 * (hills(x, y) - cliff_level(x, y))
```

Both operands are `NauvisShared` methods that are already ported and already
graded. There is nothing else in it.

### 2.2 `makeCliffiness` is a min of six terms against a cutoff

```
base_cliffiness          = (cliff_ringbreak      - 0.01) * 60
forest_path_cliffiness   = (forest_path_billows  - 0.03) * 12
bridge_path_cliffiness   = (bridge_billows       - 0.05) * 15
elevation_cliffiness     = (elevation_nauvis_no_cliff - 4) / 2
starting_area_cliffiness = -2 + distance * segmentation_multiplier / 120
low_frequency_cliffiness = 4 * (1.5 + basis_noise{...} + low_freq_lever)

main_cliffiness = min(all six)
cliffiness_nauvis = main_cliffiness >= cliff_cutoff ? 10 : 0
```

Five things in that block are easy to get wrong, and four of them are already
called out in the TypeScript's own comments:

1. **`starting_area_cliffiness` uses the PLAIN `segmentation_multiplier`**
   (`control:water:frequency`), not `nauvis_segmentation_multiplier`. The
   `1.5 *` that `NauvisShared` applies internally does not belong here.
2. **Its `distance` is uncapped.** The game's expression has no
   `maximum_distance`, and the source comment records that this was confirmed
   against the oracle out past 14,000 tiles. Pass no cap.
3. **`low_frequency_cliffiness`'s `basis_noise` uses `nauvis_seg / 500`** as its
   input scale - the 1.5-scaled value, unlike term 5. The two terms disagree on
   which multiplier they read and both are correct.
4. **The lever is a `min` of two `slider_to_linear` calls** on different ranges:
   `slider_to_linear(cliff_frequency, -1.7, 1.7)` and
   `slider_to_linear(cliff_richness, -1, 1)`. `cliff_frequency` is
   `40 / interval`, itself derived through `get_modified_elevation_interval`.
5. **`min` is `min2`, in the order the TypeScript writes it.** `Math.min` over
   six terms is not `f64::min` folded any which way. This is CLAUDE.md's signed
   zero rule, and phase 3 shipped 27 sites that had to be fixed for it.

At the default levers `cliff_cutoff` is `2 * (0.5 - 0.5 * slider_to_linear(1, -1, 1))^1.5`
= **0.7071067811865476**, and `slider_to_linear(1, lo, hi)` is 0, so the lever
term is 0 too. A sweep that leaves the cliff controls at 1 exercises none of
that arithmetic, which is the reason tier 2 has to move them.

### 2.3 The poison question, with the margin measured

`cliffiness_nauvis` is a DISCRETE output. CLAUDE.md's rule is that a numeric
hook does not reach one, because a one-ULP nudge changes which side of a
comparison a value falls on essentially never. Whether that applies here is an
empirical question about the *margins*, so they were measured over all 1024
positions at both seeds:

| seed | closest margin to the cutoff | within 1e-5 | within 1e-3 | within 1e-1 |
| --- | --- | --- | --- | --- |
| 123456 | 3.402456e-3 | 0 | 0 | 61 |
| 777771 | 2.344133e-4 | 0 | 1 | 58 |

One f32 ULP at 0.7 is about 6e-8, so the closest position sits roughly 3,900 ULPs
from flipping. **A one-ULP perturbation of any single leaf cannot flip this
gate.**

That is not the whole answer, and the survey should not pretend it is. Poison
bends `basis_noise`'s returned value, and `elevation_cliffiness` sits on top of
a whole `ElevationNauvis` tree with many `basis_noise` calls, so the error that
reaches `main_cliffiness` is an accumulation rather than one ULP. Whether the
accumulation clears 2.34e-4 at the one position that is closest is a question
only a build can answer. **Build with `--features poison`, run the cliffiness
test, and read the result** - do not predict it. If it stays green the field
needs `poison::bool_result` on the gate, the same hook Fulgora's ocean test uses.

---

## 3. `rockField.ts` - 152 lines, one field with three components

```
rock_noise    = multioctave{seed1=137, 4, p=0.9, in=0.15*freq} + size_term
size_term     = 0.25 + 0.75 * (slider_rescale(size, 1.5) - 1)
rock_density  = rock_noise - max(0, 1.1 - distance / 32)

moist_band    = range_select_base(moisture, 0.35, 1,   0.2, -10, 0)
sand_band     = min( range_select_base(aux,      0.3, 1,   0.3, -10, 0),
                     range_select_base(moisture, 0,   0.3, 0.2, -10, 0) )

p_huge = 0.07 * size * (moist_band + rock_density - 1.7)
p_big  = 0.17 * size * (moist_band + rock_density - 1.6)
p_sand = 0.10 * size * (sand_band  + rock_density - 1.6)

density = clamp(max(p_huge, p_big, p_sand), 0, 1)
```

Points that need care:

- **`control:rocks:size` enters twice**, as the outer multiplier and inside
  `rock_noise` through `slider_rescale(size, 1.5)`. The TypeScript hoists the
  size-dependent tail out of the per-pixel loop as `sizeTerm`; the Rust should
  do the same in the constructor, which is the `Prepared` pattern already used
  everywhere in this port.
- **`control:rocks:frequency` enters ONCE**, and not where a reader expects: it
  scales the noise INPUT (`0.15 * freq`), not the probability. Nothing else
  reads it.
- **The three probabilities share `rock_density` but not their band**, and
  `p_sand` reads `aux` where the other two do not. A sweep that only folds
  `density` cannot tell `p_huge` from `p_big`, because they differ by a constant
  factor and a constant offset and the max almost always picks the same one.
  Fold the three separately.
- **`min` and `max` again** go through `min2` / `max2` in the TypeScript's own
  argument order. `sand_band` is a two-argument `min`; the density is a
  three-argument `max` written as `Math.max(pHuge, pBig, pSand)`.
- **The `at()` accessor allocates and `density()` does not**, and the
  TypeScript's comment says why: `density` is the per-tile hot path and `at` is
  called only on tiles that already passed the roll and the water gate - 252 of
  262,144 in one measured region. The Rust does not need the closure-scratch
  trick that shape forced on the TypeScript; returning a small `Copy` struct
  from one function and reading a field off it costs nothing.
- **The rock ARGMAX is not in this port.** `renderRocks.ts` picks the winning
  prototype to get its collision box, and the render path is a later PR. So this
  layer adds no discrete output and needs no `index_result` hook.

### 3.1 Where rocks actually appear, for the tier-2 window

Nauvis rocks are sparse, so a sweep can fold zeros and look bit-identical while
comparing nothing. That is the resource layer's lesson, and it was checked here
rather than assumed. Six 64x64 windows at seed 123456:

| origin | step | positions with density > 0 | max density |
| --- | --- | --- | --- |
| (0, 0) | 1 | 96 / 4096 | 0.0906 |
| (300, -180) | 1 | 92 / 4096 | 0.0936 |
| (512, 512) | 1 | 166 / 4096 | 0.1022 |
| (-800, 640) | 1 | 83 / 4096 | 0.1259 |
| (1024, 1024) | 1 | 76 / 4096 | 0.0705 |
| (0, 0) | 7 | 131 / 4096 | 0.2063 |

Every window carries rocks, so this is easier than resources was - no window
hunt is needed. But the density is 2 to 4 percent non-zero, so **freeze the
non-zero count** the way the resource sweep freezes its per-resource hit counts,
or a window that drifts off the patches will lose its coverage silently. Note
the three probabilities are non-zero everywhere even where the clamped density
is 0, so folding them is never vacuous.

---

## 4. What tier 2 needs

`NauvisParity::FIELD_COUNT` is **76** today: 16 expression fields, 21 tile
probabilities, the tile argmax, 18 resource wrappers, the resolver, then
`tree_small_noise`, two forest-path cutouts, 15 species and the density.

This layer adds six, for **82**: `cliff_elevation`, `cliffiness`, `p_huge`,
`p_big`, `p_sand`, `rock_density`. Add a `CLIFF_ROCK_BASE` beside `TREE_BASE`
and assert the spec's name list against `nauvis_field_count()`, so a field added
later cannot go untested.

Two shape decisions follow from what is already in the file:

- **Build it lazily**, like the resource block. `makeCliffiness` constructs a
  whole `ElevationNauvis` tree, which is the exact cost that made the resource
  block lazy. A `OnceCell` is the right tool; the tree layer's borrowed-`Option`
  shape is not needed here, because nothing in this layer borrows anything with
  a shorter life than the stack.
- **`NauvisCtx` needs new levers**: the cliff frequency and continuity controls,
  the cliff elevation interval and richness settings, and the rock frequency and
  size controls. Move them off their defaults in the sweep. At the default cliff
  levers the whole `low_freq_lever` term is 0 and `cliff_cutoff` is a constant,
  so a default-lever sweep grades none of section 2.2's item 4.

**What tier 2 cannot see here, stated plainly.** The TypeScript exposes
`cliffiness` only as the 0/10 gate, so the fold compares gate answers and is
blind to any difference in `main_cliffiness` that does not cross the cutoff. The
margin table in section 2.3 says how blind: at seed 123456 nothing is within
3.4e-3 of the threshold. Tier 1 has the same limit for the same reason. A
divergence in the six sub-terms smaller than that is invisible to both tiers,
and only the `cliff_elevation` field - which is continuous and shares
`NauvisShared` with four of the six - grades that region at all.

---

## 5. Traps carried forward

- **`snapPosition` before scoring**, except that here it is the identity for the
  two cliff fixtures and must be documented as such rather than applied for
  appearance.
- **Freeze exact counts, never bounds.** The counts in section 1 were measured
  on the TypeScript side first. If the Rust disagrees, read it - do not adjust
  it.
- **The parity sweep needs non-binary origins and steps**, or Rust and
  TypeScript agree by construction. `test/wasmNauvisParity.spec.ts` already
  holds a sweep of that shape; extend it rather than adding a second one.
- **An anti-vacuity assertion is not optional.** For cliffiness that is the
  non-zero gate count; for rocks it is the non-zero density count.
- **A finding in the shipped TypeScript gets an issue, not a fix inside the
  port.** A unilateral fix on the Rust side reads as a port bug in tier 2, which
  is the whole point of having tier 2.
- **Rebuild `engine.wasm` after `cargo fmt`**, not before. Formatting moves line
  numbers, and line numbers move `core::panic::Location` records, which the
  gate's byte comparison sees.
