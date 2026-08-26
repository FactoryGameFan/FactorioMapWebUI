# Nauvis trees - a port survey of the four TypeScript files

A structural read of `src/noise/trees/` taken on 2026-08-25, before the Rust
port of that layer began (#226, phase 6). Written for the same reason the
resource survey was: so the port does not re-derive the dependency order, the
exact signatures, or the comments in those files that record a measurement
rather than an intention.

**This is a snapshot of a moving target.** The code is the authority; when the
two disagree, the code wins and this file is stale. Line numbers are from
2026-08-25.

**The port it was written for has LANDED.** The Rust lives in
`crates/fmw-noise/src/trees/` - `asymmetric_ramps.rs`, `catalog.rs`, `shared.rs`
and `field.rs`, mirroring these four 1:1. Everything below held up, including
the per-field counts in section 0, which the Rust froze unchanged on the first
run. Two things this survey could not know:

- The 16 crc32 seeds are no longer copied constants on the Rust side.
  `catalog.rs` carries a CRC-32 in its own test module and checks all 16 against
  their names, so a copied magic number cannot be wrong on both ports at once.
- The tier-2 tree block needed a different laziness shape from the resource
  block, because `TreeFields` borrows a `TreeBase`. See CLAUDE.md's
  "Structure conventions to copy for the next layer".

Sibling: `docs/nauvis-resources-port-survey.md`, and the port it produced. Two
conventions from that work carry and are not repeated at every line: reproduce
the TypeScript faithfully rather than fixing it, and a finding gets its own
issue.

---

## 0. The headline difference from resources: the metric WORKS here

The resource layer's exact f32 match count degenerated to 0 of 31,400, because
its fields run to ~12,300 in magnitude
(see CLAUDE.md's "When the exact-match count degenerates" section). **Trees are not like that.** Every tree
value is a probability in roughly `[-3, 0.45]`, and the fixtures score:

| fixture | positions | off-grid | snapped | unsnapped |
| --- | --- | --- | --- | --- |
| `oracle-trees` | 26 | 14 | **120 / 442** | 85 / 442 |
| `oracle-trees-controls` | 17 | 7 | **9 / 51** | 8 / 51 |

So the house metric applies: freeze an exact count per field, never a bound.
Measured on the TypeScript side on 2026-08-25, snapped with
`test/captureGrid.ts`, comparing `Math.fround(port) === expected`:

| field | exact / 26 | worst |
| --- | --- | --- |
| `tree_small_noise` | **26** | **0** |
| `tree_04` | 11 | 9.536743e-7 |
| `tree_09` | 11 | 1.192093e-6 |
| `trees_forest_path_cutout_faded` | 9 | 5.960464e-8 |
| `tree_08_red` | 9 | 9.536743e-7 |
| `tree_02` | 8 | 1.192093e-6 |
| `tree_07` | 8 | 1.430511e-6 |
| `tree_09_red` | 8 | 9.536743e-7 |
| `tree_03` | 7 | 9.536743e-7 |
| `tree_06_brown` | 7 | 9.536743e-7 |
| `tree_09_brown` | 5 | 9.536743e-7 |
| `tree_08_brown` | 4 | 9.536743e-7 |
| `tree_05` | 2 | 2.384186e-6 |
| `tree_06` | 2 | 1.430511e-6 |
| `tree_01` | 1 | 2.384186e-6 |
| `tree_02_red` | 1 | 1.430511e-6 |
| `tree_08` | 1 | 9.536743e-7 |

and on `oracle-trees-controls` (`treesFrequency = 3`, `treesSize = 2`, 17
positions): `tree_01` 3, `tree_08` 2, `tree_09_red` 4.

Read these by DEPTH, as CLAUDE.md says. `tree_small_noise` is bit-exact because
it is one bare `multioctave_noise` with nothing beneath it. Every species stacks
a temperature tree, a moisture tree, two `asymmetric_ramps`, a distance term and
a three-octave noise, and lands at 1 to 11.

**Re-measure before freezing; do not copy these.** The equivalent table in
`test/captureGrid.ts` records `83 / 442` unsnapped and `118 / 442` snapped for
`oracle-trees`, and `9 / 51` and `10 / 51` for the controls fixture. The
measurements above differ by a constant **+2** on `oracle-trees` and **-1** on
the controls fixture, in BOTH arms - which is the signature of the port having
moved since that table was taken on 2026-08-18, not of a methodology difference.
Nothing asserts those numbers, so they drifted quietly. Several narrowing fixes
landed in between (#273, #279, #290, #293, #309).

---

## 1. Dependency order (build bottom-up in Rust)

```
asymmetricRamps.ts   (leaf: no imports at all)
treeCatalog.ts       (leaf: no imports at all)
      |
treeShared.ts        (imports ../multioctaveNoise, ../expressions/nauvisShared)
      |
treeField.ts
```

External imports, by file:

| File | Outside `trees/` |
| --- | --- |
| `asymmetricRamps.ts` | none |
| `treeCatalog.ts` | none |
| `treeShared.ts` | `../multioctaveNoise` -> `makeMultioctaveNoise`; `../expressions/nauvisShared` -> `makeNauvisShared`, type `NauvisShared` |
| `treeField.ts` | `../eval/math` -> `clamp`; `../distanceFromNearestPoint`; `../fastApprox` -> `fastPow`; `../expressions/moisture` -> `makeMoisture`; `../expressions/temperature` -> `makeTemperature`; `../multioctaveNoise`; `../expressions/nauvisShared` |

**Every one of those already exists in Rust.** `multioctave_noise::Prepared`,
`expressions::nauvis_shared::NauvisShared`,
`expressions::nauvis_climate::{Moisture, Temperature}`,
`distance_from_nearest_point`, `fast_approx::fast_pow`, and
`eval::math::{clamp, min, max}`. Nothing new has to be ported underneath this
layer - which makes trees the last Nauvis field layer with no prerequisites.

The only `src/` consumer is `src/noise/preview/renderTrees.ts:43`, which takes
`makeTreeDensity`. `makeTreeSpeciesFields` is exported for the specs.

---

## 2. `asymmetricRamps.ts` - 21 lines, one expression

```ts
export function asymmetricRamps(input, fromBottom, fromTop, toTop, toBottom): number {
  return Math.min((input - fromTop) / (fromTop - fromBottom), (toTop - input) / (toBottom - toTop));
}
```

`asymmetric_ramps` from `core/prototypes/noise-functions.lua:114-124`. Two
opposing linear ramps combined with `min`: the output crosses 0 at `fromTop` and
`toTop`, and -1 at `fromBottom` and `toBottom`. The peak depends on how far
apart the tops are, so it is positive when they are apart and negative when they
cross.

**No clamp and no upper bound, deliberately.** The game's own comment says it is
"designed to be used with a group of asymmetric_ramps inside a shared min()",
which is exactly how every species uses it. A port that clamped it would look
tidier and be wrong.

---

## 3. `treeCatalog.ts` - pure data, 15 species

```ts
export interface TreeSpecies {
  readonly name: string;          // "tree_01" - the game's noise-expression name
  readonly seed1Name: string;     // "tree-01" - the STRING passed as seed1 in the Lua
  readonly seed1: number;         // crc32(utf8(seed1Name))
  readonly cap: number;           // the leading min(cap, ...)
  readonly tempRamp: readonly [number, number, number, number];
  readonly moistRamp: readonly [number, number, number, number];
  readonly inputScaleDiv: number; // input_scale = (1 / inputScaleDiv) * control:trees:frequency
  readonly outputScale: number;
  readonly sizeOffset: number;    // the constant in `- sizeOffset + 0.2 * control:trees:size`
}
export const TREE_SMALL_NOISE_SEED1 = 2343395516;   // crc32("tree-small")
export const TREE_SPECIES: readonly TreeSpecies[];  // 15 rows, DESCENDING cap
```

Every species shares one expression shape, so a row fully describes it:

```text
min(cap,
    trees_forest_path_cutout_faded,
    min(0, asymmetric_ramps{input = temperature, ...tempRamp},
           asymmetric_ramps{input = moisture,    ...moistRamp})
    + min(0, distance/20 - 3)
    - sizeOffset + 0.2 * control:trees:size
    + tree_small_noise * 0.1
    + multioctave_noise{persistence 0.65, octaves 3, seed1 = <seed1Name>,
                        input_scale = (1/inputScaleDiv) * control:trees:frequency,
                        output_scale = outputScale})
```

The 15 rows, in file order (which is descending `cap`):

| name | seed1 | cap | tempRamp | moistRamp | 1/scale | outputScale | sizeOffset |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tree_01` | 545692666 | 0.45 | 0,10,14,15 | 0.6,0.7,1,2 | 25 | 0.8 | 0.5 |
| `tree_04` | 1357672309 | 0.45 | 13,14,16,17 | 0.7,0.9,1,2 | 30 | 0.8 | 0.5 |
| `tree_05` | 669736931 | 0.45 | 15,16,35,45 | 0.6,0.7,1,2 | 40 | 0.8 | **0.45** |
| `tree_02` | 3113208384 | 0.4 | 0,10,14,15 | 0.4,0.5,0.7,0.8 | 25 | 0.75 | 0.5 |
| `tree_03` | 3465083606 | 0.4 | 15,16,35,45 | 0.4,0.5,0.7,0.8 | 35 | 0.75 | 0.5 |
| `tree_07` | 3387244239 | 0.4 | 13,14,16,17 | 0.5,0.6,0.9,1 | 40 | 0.75 | **0.45** |
| `tree_02_red` | 2142693989 | 0.3 | 0,10,14,15 | 0.2,0.3,0.5,0.6 | 25 | 0.7 | 0.5 |
| `tree_08` | 1499079518 | 0.3 | 13,14,16,17 | 0.3,0.4,0.6,0.7 | 30 | 0.7 | 0.5 |
| `tree_09` | 777851848 | 0.3 | 15,16,35,45 | 0.2,0.3,0.5,0.6 | 25 | 0.7 | 0.5 |
| `tree_06` | 3202485849 | 0.2 | 0,10,14,15 | 0.1,0.2,0.3,0.4 | 22 | 0.6 | 0.5 |
| `tree_08_brown` | 3606254248 | 0.2 | 13,14,16,17 | 0.2,0.3,0.4,0.5 | 30 | 0.6 | 0.5 |
| `tree_09_brown` | 1887705372 | 0.2 | 15,16,35,45 | 0.1,0.2,0.3,0.4 | 25 | 0.6 | 0.5 |
| `tree_06_brown` | 2261543413 | 0.1 | 0,10,14,15 | 0,0.1,0.2,0.3 | 22 | 0.5 | 0.5 |
| `tree_08_red` | 889647812 | 0.1 | 13,14,16,17 | 0.1,0.2,0.3,0.4 | 30 | 0.5 | 0.5 |
| `tree_09_red` | 140958580 | 0.1 | 15,16,35,45 | 0,0.1,0.2,0.3 | 25 | 0.5 | 0.5 |

Comments worth carrying:

- `:53-66` (**measurement, and a methodology warning**) - `sizeOffset` is the
  ONE genuinely per-species term: 0.45 for `tree_05` and `tree_07`, 0.5 for the
  other 13. Modelling it as a shared constant made those two disagree with the
  game by a near-constant **5.01e-2 everywhere**. The warning attached to it is
  the transferable part: the shape claim was originally checked by filtering
  common terms out of the Lua and eyeballing the remainder, **the filter dropped
  every line containing `control:trees:size`, and `sizeOffset` was therefore the
  one term excluded from the check.** `treeCatalogExpressions.spec.ts` now
  rebuilds each row's Lua string and diffs it character for character instead.
- `:28-31` - `seed1` is a STRING in the Lua and Factorio hashes it with crc32.
  The numbers here are precomputed so the module has no runtime dependency on
  the codec; `treeCatalog.spec.ts` asserts each against `crc32`. **Pin these in
  Rust the way `NAUVIS_OFFSET_X_SEED1` is pinned** - a wrong seed produces a
  perfectly plausible forest.
- `:32-35` - rows are ordered by descending `cap` because `treeField`'s
  early-out converges faster that way. Order does not change the result, since
  the composition is a `max`. Keep the order anyway: the early-out's frequency
  is what makes the render affordable.

---

## 4. `treeShared.ts` - three fields, one prepared struct

```ts
export function makeTreeShared(params: TreeSharedParams, shared?: NauvisShared): TreeShared
export interface TreeShared {
  smallNoise:            (x, y) => number;  // tree_small_noise
  forestPathCutout:      (x, y) => number;  // trees_forest_path_cutout
  forestPathCutoutFaded: (x, y) => number;  // trees_forest_path_cutout_faded
}
```

From `core/prototypes/noise-programs.lua`:

```text
tree_small_noise               = multioctave_noise{persistence 0.75, octaves 3,
                                                   seed1 'tree-small',
                                                   input_scale 0.2, output_scale 0.5}
forest_paths                   = (forest_path_billows   - 0.07) * 3
nauvis_hills_paths             = (nauvis_hills          - 0.1)  * 3
nauvis_bridge_paths            = (nauvis_bridge_billows - 0.07) * 5
trees_forest_path_cutout       = min(nauvis_bridge_paths, nauvis_hills_paths, forest_paths)
trees_forest_path_cutout_faded = trees_forest_path_cutout * 0.3 + tree_small_noise * 0.1
```

**`tree_small_noise`'s `input_scale` is a flat 0.2** and is NOT scaled by
`control:trees:frequency`, unlike every species' own noise term. That asymmetry
is easy to "tidy" away.

The optional `shared` parameter lets a caller reuse an existing `NauvisShared`
rather than rebuilding the billow fields. In Rust that wants to be a borrow, and
`treeField` is the caller that uses it.

---

## 5. `treeField.ts` - the layer, and the early-out

```ts
export const BASIS_ABS_MAX = 1.8;
export interface TreeFieldParams {
  seed0: number;
  treesFrequency?, treesSize?, segmentationMultiplier?: number;
  moistureFrequency?, moistureBias?: number;
  temperatureFrequency?, temperatureBias?: number;
  startingAreaMoistureSize?, startingAreaMoistureFrequency?: number;
  startingPositions?: readonly Point[];
}
export interface TreeSpeciesField {
  species: TreeSpecies;
  evalAt:  (x, y) => number;
  cheapAt: (x, y) => number;                                    // evalAt minus its own noise
  cheapFrom: (temperature, moisture, distanceTerm, smallTerm) => number;
  noiseAt: (x, y) => number;
  maxNoise: number;
}
export function makeTreeSpeciesFields(params): TreeSpeciesField[]
export function makeTreeDensity(params): (x, y) => number
```

Private constants: `TREE_OCTAVES = 3`, `TREE_PERSISTENCE = 0.65`.

### The bodies that matter

```ts
sizeTerm = -species.sizeOffset + 0.2 * treesSize;               // hoisted per species

cheapFrom(t, m, distanceTerm, smallTerm) =
  Math.min(0, asymmetricRamps(t, ...tempRamp), asymmetricRamps(m, ...moistRamp))
  + distanceTerm + sizeTerm + smallTerm;

cheapAt(x, y) = cheapFrom(temperature(x,y), moisture(x,y),
                          Math.min(0, distanceFromNearestPoint(x, y, spawn) / 20 - 3),
                          smallNoise(x, y) * 0.1);

evalAt(x, y) = Math.min(species.cap, forestPathCutoutFaded(x, y), cheapAt(x, y) + noise(x, y));
```

**The four addends in `cheapFrom` are in a load-bearing ORDER**
(`climate + distanceTerm + sizeTerm + smallTerm`). Float addition is not
associative and `treeFieldEarlyOut.spec.ts` asserts the density path is
bit-identical to full evaluation, so a reordering breaks it.

### `maxNoiseFor` - a bound that must be computed the game's way

```ts
const invP2 = 1 / (P * P);
const norm  = Math.sqrt((invP2 - 1) / (fastPow(invP2, octaves) - 1));
let amps = 0, amp = norm;
for (let k = 0; k < octaves; k++) { amps += amp; amp /= P; }
return species.outputScale * amps * BASIS_ABS_MAX;
```

**`fastPow`, NOT `**`.** `multioctaveNoise` normalises with the game's fastapprox
pow, so a bound computed with an exact pow is not a bound. In Rust that is
`fast_pow(invp2 as f32, octaves as f32)` widened back to f64 - note it takes and
returns `f32` there while the TypeScript takes numbers and narrows internally.

`BASIS_ABS_MAX = 1.8` is a **measured** maximum plus a margin, not an analytic
bound - the basis range is not a clean +/-sqrt(3).
`treeFieldEarlyOut.spec.ts` asserts both that the bound holds against hard
sampling and that the early-out is bit-identical to full evaluation.

### `makeTreeDensity` - the shape the renderer uses

```ts
t = temperature(x,y); m = moisture(x,y);
distanceTerm = Math.min(0, distanceFromNearestPoint(x, y, spawn) / 20 - 3);
smallTerm = smallNoise(x, y) * 0.1;
cutoutFaded = <deferred>; best = 0;
for (const f of fields) {
  if (f.species.cap <= best) continue;                 // cap bounds it
  const cheap = f.cheapFrom(t, m, distanceTerm, smallTerm);
  if (cheap + f.maxNoise <= best) continue;            // so does cheap + maxNoise
  if (!haveCutout) { cutoutFaded = forestPathCutout(x,y) * 0.3 + smallTerm; haveCutout = true; }
  const v = Math.min(f.species.cap, cutoutFaded, cheap + f.noiseAt(x, y));
  if (v > best) best = v;
}
return clamp(best, 0, 1);
```

Three things here are performance decisions with correctness consequences, and
all three must be ported rather than simplified:

1. **The climate stack is evaluated ONCE per pixel**, not once per species. It
   costs more than the 3-octave species noise the early-out saves, so computing
   it per species dominated the whole render before this shape.
2. **`cutoutFaded` is inlined and DEFERRED** so it reuses `smallTerm` instead of
   re-evaluating `tree_small_noise`, and so pixels where every species is
   skipped never pay for the billows. Note it is
   `forestPathCutout(x,y) * 0.3 + smallTerm` - the same value
   `forestPathCutoutFaded` returns, reached without a second `smallNoise` call.
3. **`max` is not an approximation.** The game's
   `EntityMapGenerationTask::generateEntities` arbitrates one winning entity per
   tile by MAX probability and rolls once against it, so `max_i p_i` is exactly
   the probability the game rolls where a tree wins. See
   `docs/noise/placement-roll-NOTES.md`.

Measured while writing this survey: over a 60x60 grid at step 13.5 / 11.25 from
(-400, -400), the early-out agrees with a naive `max` over `evalAt` at **3,600
of 3,600 points**, with 1,081 of them non-zero - so the sweep is not vacuous.
That is the property the Rust port has to preserve, and it is cheap to re-assert
on the Rust side.

---

## 6. Pure versus prepared - the split to build in Rust

**Pure free functions**: `asymmetric_ramps`, everything in `treeCatalog.ts`, and
`maxNoiseFor`.

**Prepared structs**, one per (seed, controls):

1. `TreeShared` - a `Prepared` multioctave for `tree_small_noise` plus a
   borrowed or owned `NauvisShared`. Exposes the three fields.
2. `TreeSpeciesField` - one `Prepared` per species plus the hoisted `sizeTerm`
   and `maxNoise`, 15 of them.
3. `TreeDensity` - the 15 fields plus `Temperature`, `Moisture`, `TreeShared`
   and the spawn list.

There is **no memo and no cache anywhere in this layer**, and no cross-position
read, so the Rust port keeps the phase-3 convention: evaluate top to bottom into
locals. Unlike `resources`, nothing here needs a `RefCell`.

---

## 7. `Math.max` / `Math.min` argument order - complete inventory

Argument order is load-bearing: `Math.max(-0, +0)` is `+0` and `f64::max` may
return either. Use `eval::math::{min, max, min2, max2}` and keep the order as
written. Note several of these are THREE-argument, which maps to
`eval::math::min(&[a, b, c])`.

| Location | Expression |
| --- | --- |
| `asymmetricRamps.ts:20` | `Math.min(fromRamp, toRamp)` - the `from` ramp first |
| `treeShared.ts:55-59` | `Math.min(bridge * 5, hills * 3, forestPath * 3)` - **three args, bridge first** |
| `treeField.ts:181` | `Math.min(0, tempRamp, moistRamp)` - **three args, the literal 0 first, temperature before moisture** |
| `treeField.ts:193`, `:227` | `Math.min(0, distance / 20 - 3)` - literal first |
| `treeField.ts:198` | `Math.min(species.cap, forestPathCutoutFaded, cheapAt + noise)` - **three args, cap first** |
| `treeField.ts:249` | `Math.min(f.species.cap, cutoutFaded, cheap + f.noiseAt(x, y))` - the same three, same order |
| `treeField.ts:252` | `clamp(best, 0, 1)` |

**`clamp` here is `eval/math`'s, NOT the local `min(max(v, lo), hi)` the
resource layer uses.** `src/noise/eval/math.ts:9` is the comparison form
`v < lo ? lo : v > hi ? hi : v`, which maps to `eval::math::clamp` in Rust. The
two differ on a negative zero. Picking the wrong one is a one-token slip that
nothing in tier 1 would show.

Also order-sensitive: `if (v > best) best = v` at `treeField.ts:250` is a strict
`>` and NOT a `Math.max`, exactly as the two spot-field loops in `resources` are
- it keeps `best` on a NaN or a tie.

---

## 8. Where the f32 narrowing goes

**`src/noise/trees/` contains no `f32` call at all** - grep it. Every narrowing
happens inside the primitives it calls: `multioctaveNoise`, `makeMoisture`,
`makeTemperature`, `distanceFromNearestPoint` (f32 end to end) and `fastPow`.
The layer's own arithmetic is f64.

That is the same asymmetry `resourceMath.ts` has, and the resource port's rule
applies unchanged: **preserve it, do not harmonise it.** In Rust the primitives
return `f32` and must be widened with `f64::from(...)` at the call site rather
than kept narrow.

The one place to be careful is `maxNoiseFor`, which mixes them: `fastPow`
narrows, the surrounding `sqrt`, division and accumulation do not.

---

## 9. Version skew

No `2.0.77` or `2.1.9` string appears in `src/noise/trees/`. The catalog was
verified against `~/GitHub/factorio-data` at tag **2.1.11**
(`base/prototypes/entity/trees.lua`), and both fixtures are 2.1.11 captures.
CLAUDE.md records that 2.1.14, 2.1.15 and 2.1.16 are ONE oracle for map-gen
because the data Lua is byte-identical across them, so "predates the installed
binary" overstates staleness here.

**If a count disagrees, check the capture grid before the version** (#295).
Fourteen of `oracle-trees`'s 26 positions and seven of the controls fixture's 17
are off the 1/256 grid, so `snapPosition` is genuinely load-bearing on both -
it is worth 85 -> 120 and 8 -> 9. That is a much larger share of off-grid
positions than the tile fixtures had, where the snap was inert.

---

## 10. Existing tests, and what each is for

| spec | what it holds |
| --- | --- |
| `test/treeCatalog.spec.ts` | each `seed1` against `crc32(seed1Name)` |
| `test/treeCatalogExpressions.spec.ts` | each row rebuilt into Lua and diffed against the game data character for character |
| `test/treeShared.spec.ts` | the three shared fields |
| `test/treeField.spec.ts` | species list, per-species shape, the control levers |
| `test/treeFieldEarlyOut.spec.ts` | `BASIS_ABS_MAX` holds under hard sampling, AND the early-out is bit-identical to full evaluation |
| `test/treeOracle.spec.ts` | both fixtures against the game |

The Rust port needs equivalents for the last two in particular: the bound and
the bit-identity are what make the early-out safe, and neither is visible to a
fixture count.
