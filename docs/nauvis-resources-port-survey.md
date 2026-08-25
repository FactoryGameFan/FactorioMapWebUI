# Nauvis resources - a port survey of the six TypeScript files

A structural read of `src/noise/resources/` taken on 2026-08-25, before the Rust
port of that layer began (#226, phase 6). It exists so the port does not have to
re-derive the dependency order, the exact signatures, or - the part worth most -
the ~25 comments in those files that record a measurement rather than an
intention.

**This is a snapshot of a moving target.** The code is the authority; when the
two disagree, the code wins and this file is stale. Line numbers are from
2026-08-25.

Two conventions from the port apply throughout and are not repeated at every
line: score by exact f32 match count where that discriminates, and reproduce the
TypeScript faithfully rather than fixing it - a finding gets its own issue. See
`CLAUDE.md`'s "Rust/WASM noise engine" section.

**Read `gh issue view 261` before choosing a scoring metric for this layer.**
Exact-match scoring returns **0 of 14,980** on the resource fixtures, so the
metric that gave 153/153 on tiles degenerates here.

---

## 1. Dependency order (build bottom-up in Rust)

```
resourceCatalog.ts        (leaf: no imports at all)
      |
resourceMath.ts           (imports ../fastApprox {fastCbrt}; type ResourceParams)
      |                    |
regularPatches.ts     startingPatches.ts
      |                    |
       resourcePatches.ts
              |
        resolveResource.ts
```

External imports, by file:

| File | Outside `resources/` |
| --- | --- |
| `resourceCatalog.ts` | none |
| `resourceMath.ts` | `../fastApprox` -> `fastCbrt` |
| `regularPatches.ts` | `../basisNoise` -> `basisNoise`, `basisNoiseTablesFromSeed`, type `BasisNoiseTables`; `../distanceFromNearestPoint` -> `distanceFromNearestPoint`, type `Point`; `../eval/f32` -> `f32`; `../fastApprox` -> `fastCbrt`; `../randomPenalty` -> `randomPenaltyBatch`; `../spotSelection` -> `selectSpots`, type `SelectedSpot`; `../spotCandidates` -> type `SpotRegionKey` |
| `startingPatches.ts` | the same, minus `randomPenalty`, plus `../expressions/elevationNauvis` -> `makeElevationNauvis` |
| `resourcePatches.ts` | `../distanceFromNearestPoint` -> `distanceFromNearestPoint`, type `Point` |
| `resolveResource.ts` | `../distanceFromNearestPoint` -> type `Point` |

Dependency signatures the port will need:

```ts
export const f32 = Math.fround;                                    // eval/f32.ts:113
export function fastCbrt(x: number): number;                       // fastApprox.ts:90, x must be > 0
export function basisNoise(x: number, y: number, tables: BasisNoiseTables): number;
export function basisNoiseTablesFromSeed(seed0: number, seed1: number): BasisNoiseTables;
export function distanceFromNearestPoint(x: number, y: number, points: readonly Point[], maximumDistance?: number): number;
export function randomPenaltyBatch(positions: readonly RandomPenaltyPosition[], source: readonly number[], params: { seed: number; amplitude: number }): number[];
export function selectSpots(key: SpotRegionKey, p: SpotSelectParams): SelectedSpot[];
export interface SelectedSpot { x: number; y: number; quantity: number; coneScale: number }
export interface SpotRegionKey { seed0: number; seed1: number; regionX: number; regionY: number }
export function makeElevationNauvis(params: ElevationNauvisParams): (x: number, y: number) => number;
```

---

## 2. `resourceCatalog.ts` - pure data

```ts
export type ResourcePlacement = "threshold" | "roll";
export interface ResourceParams {
  readonly name: string; readonly controlName: string;
  readonly order: "b" | "c"; readonly patchSetIndex: number;
  readonly baseDensity: number; readonly baseSpotsPerKm2: number;
  readonly candidateSpotCount: number;
  readonly regularRqFactor: number;   // regular_rq_factor_multiplier / 10
  readonly startingRqFactor: number;  // starting_rq_factor_multiplier / 7
  readonly seed1: number; readonly randomProbability: number;
  readonly randomSpotSizeMin: number; readonly randomSpotSizeMax: number;
  readonly additionalRichness: number; readonly minimumRichness: number;
  readonly richnessPostMultiplier: number;
  readonly hasStartingAreaPlacement: boolean;
  readonly mapColor: readonly [number, number, number];
  readonly placement: ResourcePlacement;
}
export const RESOURCE_CATALOG: readonly ResourceParams[];  // 6 entries, patchSetIndex order
```

| idx | name | baseDensity | spots/km2 | candidates | regularRq | startingRq | randProb | spotSize | addRich | placement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | iron-ore | 10 | 2.5 | 22 | 1.1/10 | 1.5/7 | 1 | 0.25..2 | 0 | threshold |
| 1 | copper-ore | 8 | 2.5 | 22 | 1.1/10 | 1.2/7 | 1 | 0.25..2 | 0 | threshold |
| 2 | coal | 8 | 2.5 | 21 | 1.0/10 | 1.1/7 | 1 | 0.25..2 | 0 | threshold |
| 3 | stone | 4 | 2.5 | 21 | 1.0/10 | 1.1/7 | 1 | 0.25..2 | 0 | threshold |
| 4 | crude-oil | 8.2 | 1.8 | 21 | 1/10 | 1/7 | **1/48** | 1..1 | **220000** | **roll** |
| 5 | uranium-ore | 0.9 | 1.25 | 21 | 1/10 | 1/7 | 1 | 2..4 | 0 | threshold |

Oil and uranium carry `hasStartingAreaPlacement: false` and order `"c"`.

**Keep the rq factors as DIVISIONS.** They are written `1.1 / 10` and `1.5 / 7`,
and `1.1 / 10` is not bitwise `0.11` in f64. Folding them to decimals changes
the number.

Comments worth carrying:

- `:50-58` (**measurement**) - `"roll"` is right for crude oil alone, whose
  probability carries a `random_penalty{source = 1, amplitude = 48}` factor
  positive on only ~1 tile in 48. Thresholding it paints the whole patch extent
  as solid ore: **1,234 tiles against the game's 8 entities** in
  `[0,0]-[512,512]`.
- `:149-152` (**trap**) - uranium shares oil's autoplace order `"c"` but NOT its
  penalty; `random_probability` is 1, so a threshold is right for it.
- `:8-13` - the Lua-folding rule, and which defaults were applied here.

---

## 3. `resourceMath.ts` - all pure, and it uses NO `f32`

```ts
export const DOUBLE_DENSITY_DISTANCE = 1300;
export const REGULAR_PATCH_FADE_IN_DISTANCE = 300;
export const STARTING_RESOURCE_PLACEMENT_RADIUS = 150;
export interface ResourceControls { readonly frequency: number; readonly size: number }

export function sizeEffectiveDistanceAt(distance, params): number
export function regularDensityAt(distance, params, controls): number
export function regularSpotQuantityBaseAt(distance, params, controls): number
export function regularSpotHeightTypicalAt(distance, params, controls): number
export function regularBlobAmplitudeMaximumDistance(params): number
export function regularBlobAmplitudeAt(distance, params, controls): number
export function startingAmount(params, controls): number
export function startingAreaSpotQuantity(params, controls): number
export function startingModulation(distance): number
export function startingDensityAt(distance, params, controls): number
export function startingSpotRadius(params, controls): number
export function startingFavorabilityBaseAt(distance, elevation, _params, _controls): number
export function startingBlobAmplitude(params, controls): number
export function basementValue(params, controls): number
```

Private: `REGULAR_BLOB_AMPLITUDE_MULTIPLIER = 1/8`,
`STARTING_BLOB_AMPLITUDE_MULTIPLIER = 1/8`, `STARTING_PATCHES_SPLIT = 0.5`,
`clamp(v, lo, hi) = Math.min(Math.max(v, lo), hi)` (`:30`), and
`startingSign(params)` (`:33`) returning `hasStartingAreaPlacement ? 1 : 0`.

Bodies where the shape matters:

- `sizeEffectiveDistanceAt` = `sign === -1 ? distance : distance - 300`.
- `regularDensityAt` = `baseDensity * freq * size * fadeIn * doubleUp`, with
  `fadeIn = clamp((distance - 150) / 300, 0, 1)` (1 when sign is -1) and
  `doubleUp = 1 + clamp(sizeEffectiveDistanceAt(d) / 1300, 0, 1)`. Left to
  right as written (`:58`).
- `regularSpotQuantityBaseAt` = `(1000000 / baseSpotsPerKm2 / frequency) * regularDensityAt(...)`
  - **two sequential divides**, not `1e6 / (spots * freq)`.
- `regularSpotHeightTypicalAt` = `fastCbrt(meanSize * quantityBase) / ((PI/3) * rq * rq)`,
  `meanSize = (min + max) / 2`.
- `regularBlobAmplitudeMaximumDistance` = `1300 + 300` when sign is not -1.
- `regularBlobAmplitudeAt` = `(1/8) * Math.min(atMax, atD)`.
- `startingAmount` = `20000 * baseDensity * (frequency + 1) * size`.
- `startingAreaSpotQuantity` = `startingAmount / 0.5 / frequency` - two divides.
- `startingModulation(d)` = `d < 150 ? 1 : 0`.
- `startingDensityAt` = `(startingAmount / (PI*150*150)) * startingModulation(d)`.
- `startingFavorabilityBaseAt` = `clamp((elevation-1)/10, 0, 1) * startingModulation(d) * (d > 40 ? 1 : 0) * 2 - Math.min(1, d / 150)`.
- `startingBlobAmplitude` = `((1/8) / ((PI/3) * srq * srq)) * fastCbrt(startingAreaSpotQuantity)`.
- `basementValue` = `-6 * Math.max(regularBlobAmplitudeAt(maxDistance), startingBlobAmplitude(...))`.

`startingSpotRadius` is exported and **unused by the other five files** - only
`test/resourceMath.spec.ts:99` calls it. `startingPatches.ts` recomputes the same
thing inline, in f32.

Comments worth carrying:

- `:81-83` (**measurement + trap**) - the game evaluates this cube root through
  its fastapprox `pow`; exact `Math.cbrt` leaves a ~7e-5 relative error that
  dominates the blob term.
- `:145-157` - the full starting favorability expression, and that in 2.1.11 it
  is **deterministic**: no `random_penalty` term.
- `:183-187` (**trap**) - `basementValue` references the starting term even for
  regular-only resources, because both `spot_noise` calls share the basement.
  So oil and uranium still need `startingBlobAmplitude`.
- `:1-11` - `sign` mirrors the Lua ternary (-1 / 0 / 1); the -1 branches never
  fire for the six base resources but are kept for fidelity.

---

## 4. `regularPatches.ts` - prepared per (params, ctx)

```ts
const REGULAR_SPACING = 45.254833995939045;   // = 32*sqrt(2), hard-coded; copy the literal
const REGION_SIZE = 1024;
const MAX_SPOT_BASEMENT_RADIUS = 128;
const MAX_SPOT_RADIUS = 32;
const regionIndex = (c) => Math.floor((c + REGION_SIZE / 2) / REGION_SIZE);

export interface RegularPatchesCtx {
  readonly seed0: number;
  readonly controls: { frequency: number; size: number; richness: number };
  readonly startingPositions?: readonly Point[];   // default [{x:0,y:0}]
  readonly skipSpan?: number;                      // default 1
  readonly skipOffset?: number;                    // default 0
}
export interface RegularPatches {
  field(x: number, y: number): number;
  probability(x: number, y: number): number;
  richness(x: number, y: number): number;
}
export function makeRegularPatches(params: ResourceParams, ctx: RegularPatchesCtx): RegularPatches
```

Captured state (the Rust struct): controls `{frequency, size}` - richness
deliberately excluded - spawn points, `basisNoiseTablesFromSeed(seed0, seed1)`,
`basementValue`, skip span/offset, `source = randomSpotSizeMax`,
`amplitude = randomSpotSizeMax - randomSpotSizeMin`, and a mutable region memo
keyed `"rX,rY"` (a `RefCell<HashMap<(i64,i64), Vec<SelectedSpot>>>` in Rust).

```ts
// spot quantity batch (:94-103)
jitter = randomPenaltyBatch(spots, spots.map(() => source), { seed: 1, amplitude });
out[i] = f32(jitter[i] * f32(regularSpotQuantityBaseAt(distanceAt(s.x, s.y), params, controls)));

// selectSpots (:117-128): density = regularDensityAt(distanceAt(x,y)), quantity = () => 0,
//   quantityBatch = spotQuantityBatch, favorability = () => 1, regionSize = 1024,
//   candidateSpotCount = params.candidateSpotCount, spacing = REGULAR_SPACING,
//   skipSpan, skipOffset, hardRegionTargetQuantity = false

// cone (:150-157)
radius = Math.min(MAX_SPOT_RADIUS, f32(params.regularRqFactor * fastCbrt(s.quantity)));
peak   = f32(f32(3 * s.quantity) / f32(f32(Math.PI * radius) * radius));
cone   = f32(peak - f32(f32(Math.sqrt(d2)) * f32(peak / radius)));
if (cone > best) best = cone;          // NOT Math.max - NaN semantics differ

// blob (:164-167)
blobs0 = basisNoise(x/8, y/8) + basisNoise(x/24, y/24);
extra  = 1.5 * basisNoise(x/64, y/64);
blobTerm = (blobs0 + extra - 1/3) * regularBlobAmplitudeAt(distanceAt(x,y), params, controls);

field = spotFieldAt + blobTermAt;
```

Cull when `d2 > 128*128`; region scan bounds from `regionIndex(x +/- 128)` and
`regionIndex(y +/- 128)`, inclusive.

```ts
probability = (x,y) => ctx.controls.size > 0 ? clamp(field(x,y), 0, 1) : 0;
richness = (x,y) => {
  if (ctx.controls.size <= 0) return 0;
  let r = field(x,y) / params.randomProbability;
  r += params.additionalRichness;
  if (params.minimumRichness > 0) r = Math.max(r, params.minimumRichness);
  return params.richnessPostMultiplier * ctx.controls.richness * r * richnessDistanceFactor(distanceAt(x,y));
};
richnessDistanceFactor = (d) => Math.max((1300 - 300 + d) / (1300 * 2), 1);
```

Comments worth carrying:

- `:10-17` (**measurement - the empirical unknown, resolved against the
  oracle**) - a spot's `regular_spot_quantity_expression` is
  `random_penalty_between(min,max,1) * quantityBase(distance)`, and the game
  evaluates that over ALL skip-set accepted spots as **one batch**, in
  acceptance order, seeded from the first spot, streamed, **before** the trim -
  not per spot. Supplied through `selectSpots`' `quantityBatch`.
- `:19-23` (**measurement**) - matching the game's f32 cone plus `fastCbrt`
  radius pins the field within **~0.7 units everywhere**; exact `Math.cbrt` in
  f64 left ~3 units and 4.8e-2 relative at cone edges.
- `:88-91` (**trap**) - a spot's jitter depends on the whole spot list, not just
  itself.
- `:146-149` - regular patches have no hard-target shrink, so `coneScale` is
  always 1.

---

## 5. `startingPatches.ts` - prepared, and it differs from regular in six ways

```ts
const STARTING_SPACING = 48;
const STARTING_REGION_SIZE = 450;
const STARTING_CANDIDATE_SPOT_COUNT = 32;
const regionIndex = (c) => Math.floor((c + 450/2) / 450);

export interface StartingPatchesCtx {
  readonly seed0: number;
  readonly controls: { frequency: number; size: number; richness: number };
  readonly startingPositions?: readonly Point[];
  readonly segmentationMultiplier?: number;
  readonly waterLevel?: number;
  readonly startingLakePositions?: readonly Point[];
  readonly skipSpan?: number;    // default 1
  readonly skipOffset?: number;  // default 0
}
export interface StartingPatches { field(x: number, y: number): number }  // field ONLY
export function makeStartingPatches(params: ResourceParams, ctx: StartingPatchesCtx): StartingPatches
```

Captured state adds the elevation evaluator - `makeElevationNauvis({seed0,
waterLevel, segmentationMultiplier, startingPositions: spawn,
startingLakePositions})`, the heaviest construction in the layer - plus the
constant `quantity = startingAreaSpotQuantity(params, controls)` and
`maxBasementRadius = 2 * params.startingRqFactor * fastCbrt(quantity)`.

The six differences from `regularPatches`, all oracle-verified:

1. `regionSize` 450, `candidateSpotCount` 32, `spacing` 48,
   `hardRegionTargetQuantity: true`.
2. The candidate stream keys on **`seed1: params.seed1 + 1`** (`:134`), while
   the blob noise still uses the **bare `params.seed1`** (`:102`).
3. Spot quantity is the **constant** `startingAreaSpotQuantity`; favorability is
   deterministic, with no `random_penalty` term.
4. The cone radius base uses that **constant** quantity, then `coneScale`:
   ```ts
   rBase  = f32(params.startingRqFactor * fastCbrt(quantity));   // CONSTANT, not s.quantity
   radius = f32(rBase * s.coneScale);
   peak   = f32(f32(3 * s.quantity) / f32(f32(Math.PI * radius) * radius));  // s.quantity HERE
   cone   = f32(peak - f32(f32(Math.sqrt(d2)) * f32(peak / radius)));
   ```
   Using `s.quantity` for the radius double-applies the shrink to the last spot
   (`:169-172`).
5. **No `min(32, ...)` cap** on the radius, and `maxBasementRadius` is a HARD
   cull rather than a safe over-cull: the starting cone (radius ~10.5) is still
   above basement at the ~29.5-tile cutoff, so it produces a real discontinuous
   drop to basement - the game's behaviour (`:111-115`).
6. The blob has **no `1/64, 1.5` octave** and subtracts **`1/4`, not `1/3`**:
   `blobTerm = (basisNoise(x/8,y/8) + basisNoise(x/24,y/24) - 1/4) * startingBlobAmplitude(...)`.

**The trap that an earlier draft got wrong** (`:88-93`, oracle-proven): the lake
mask `clamp((elevation - 1)/10, 0, 1)` reads the map's `elevation` PROPERTY,
which on the default Nauvis map is **`elevation_nauvis`, not `elevation_lakes`**.
A non-default map type would feed its own elevation; that generalisation is
deferred.

---

## 6. `resourcePatches.ts` - thin combinator

```ts
export interface ResourcePatchesCtx {
  readonly seed0: number;
  readonly controls: { frequency: number; size: number; richness: number };
  readonly startingPositions?: readonly Point[];
  readonly segmentationMultiplier?: number;
  readonly waterLevel?: number;
  readonly startingLakePositions?: readonly Point[];
  readonly regularSkipSpan?: number;    // default 1
  readonly regularSkipOffset?: number;  // default 0
  readonly startingSkipSpan?: number;   // default 1
  readonly startingSkipOffset?: number; // default 0
}
export function makeResourcePatches(params: ResourceParams, ctx: ResourcePatchesCtx): ResourcePatches
```

Always builds `regular`. When `!params.hasStartingAreaPlacement` it **returns
the `RegularPatches` object unchanged** (structural subtype). Otherwise:

```ts
field       = (x,y) => Math.max(starting.field(x,y), regular.field(x,y));  // starting FIRST
probability = size > 0 ? clamp(field, 0, 1) : 0;
richness    = size <= 0 ? 0
            : richnessPostMultiplier * controls.richness * field(x,y) * richnessDistanceFactor(distanceAt(x,y));
```

In Rust this wants an enum - `RegularOnly(..)` / `Combined { starting, regular,
spawn }` - rather than a trait object, to keep the delegate-verbatim property.

---

## 7. `resolveResource.ts` - pure ranking plus one resolver

```ts
export function comparePriority(a: ResourceParams, b: ResourceParams): number   // PURE
export function pickWinner(present: readonly ResourceParams[]): ResourceParams | null  // PURE
export function makeResourceResolver(ctx: ResourceResolverCtx): (x, y) => ResourceParams | null
```

Private: `DEFAULT_LEVERS = {frequency:1, size:1, richness:1}`,
`REGULAR_SKIP_SPAN = 6`, `STARTING_SKIP_SPAN = 4`,
`orderRank(o) = o === "b" ? 0 : 1`.

`comparePriority` = `orderRank(a.order) - orderRank(b.order) || a.patchSetIndex - b.patchSetIndex`.
JavaScript's `||` falls through on 0, so in Rust this is `ord.then(idx_cmp)`.
`pickWinner` replaces `best` only on a strict `< 0`, so ties keep the earlier
element.

The build loop **skips `placement === "roll"`**, then skips `levers.size <= 0`,
then builds with `regularSkipSpan: 6`, `regularSkipOffset: params.patchSetIndex`,
`startingSkipSpan: 4`, `startingSkipOffset: params.patchSetIndex`. It sorts by
`comparePriority` and returns the first field whose `probability(x,y) >= 0.5`.

Comments worth carrying:

- `:83-90` and `:97-101` (**trap, with regression history**) - crude oil is
  deliberately absent from the result. A roll needs the chunk stream and the
  collision gate a per-tile pure resolver cannot express, and **leaving oil in
  this loop is what used to paint its whole patch extent as solid ore.**
  `pickWinner` still ranks oil correctly; it is a pure priority function.
- `:58-62` (**names an issue**) - `comparePriority` is exported because
  `renderResources` needs the same rule for a resource this resolver does not
  hold. "Two copies of the rule is how the oil-vs-uranium inversion of #22
  item 3 got in."
- `:15-19` - the four solids register first, so their starting-set index equals
  their regular `patchSetIndex`, which is why the starting offset reuses it.

---

## 8. Pure versus prepared - the split to build in Rust

**Pure free functions**: everything exported from `resourceMath.ts`, everything
in `resourceCatalog.ts`, and `comparePriority` / `pickWinner`.

**Prepared structs**, one per (seed, controls):

1. `RegularPrepared` - controls, spawn, basis tables `(seed0, seed1)`, basement,
   skip span/offset, penalty source and amplitude, region memo. Exposes `field`,
   `probability`, `richness`.
2. `StartingPrepared` - the above plus the elevation evaluator, the constant
   `quantity`, `maxBasementRadius`, and the `seed1 + 1` region key. Exposes
   `field` only.
3. `ResourcePatchesPrepared` - the `RegularOnly` / `Combined` enum.
4. `ResourceResolverPrepared` - a `Vec<(ResourceParams, ResourcePatchesPrepared)>`
   pre-sorted by `comparePriority`.

The memo is **per instance**, not shared between resources. The comment about
resources sharing a stream refers to the RNG skip partitioning, not the cache.

---

## 9. `Math.max` / `Math.min` argument order - complete inventory

Argument order is load-bearing: `Math.max(-0, +0)` is `+0` and `f64::max` may
return either. Use `eval::math::{min2, max2}` and keep the order as written.

| Location | Expression |
| --- | --- |
| `resourceMath.ts:30` | `clamp = Math.min(Math.max(v, lo), hi)` - max first |
| `resourceMath.ts:106` | `Math.min(atMax, atD)` - max-distance value first |
| `resourceMath.ts:170` | `Math.min(1, distance / 150)` - literal first |
| `resourceMath.ts:194` | `Math.max(regular, startingBlobAmplitude(...))` - regular first |
| `regularPatches.ts:72` | `clamp` as above |
| `regularPatches.ts:150` | `Math.min(MAX_SPOT_RADIUS, f32(rq * fastCbrt(q)))` - the cap 32 first |
| `regularPatches.ts:174` | `Math.max((1300 - 300 + d) / (1300 * 2), 1)` - expression first |
| `regularPatches.ts:188` | `Math.max(r, params.minimumRichness)`, guarded by `> 0` |
| `resourcePatches.ts:55` | `clamp` as above |
| `resourcePatches.ts:92` | `Math.max(starting.field(...), regular.field(...))` - **starting first** |
| `resourcePatches.ts:96-100` | `Math.max((1300 - 300 + d) / (1300 * 2), 1)` |

**Two comparisons that are deliberately NOT `Math.max`**:
`if (cone > best) best = cone` at `regularPatches.ts:157` and
`startingPatches.ts:177`. The strict `>` keeps `basement` on a NaN or a tie.
`f64::max` would differ; hand-write the comparison.

Also order-sensitive: `Math.floor` in both `regionIndex`s, `Math.sqrt(d2)`
inside an `f32(...)`, `Math.round` in `color255`, and `Math.PI` used as an f64
literal and then narrowed through a product.

---

## 10. Where the f32 narrowing goes

- `f32(3 * s.quantity)` and `f32(Math.PI * radius)` - the literal `3` and
  `Math.PI` are narrowed **through the product**, not pre-narrowed. **Do not
  pre-narrow `Math.PI`**; that is a different computation from what is written.
- `f32(params.regularRqFactor * fastCbrt(...))` and
  `f32(params.startingRqFactor * fastCbrt(quantity))` - product narrowed.
- `f32(rBase * s.coneScale)` (`startingPatches.ts:174`).
- `f32(jitter[i] * f32(regularSpotQuantityBaseAt(...)))` - **two separate
  roundings, both required**.
- **`resourceMath.ts` uses no `f32` at all.** Its arithmetic is f64 and only
  `fastCbrt` narrows internally. Preserve that asymmetry; do not harmonise it.
- `maxBasementRadius` (`startingPatches.ts:116`) is f64 and NOT narrowed - it is
  only a cull threshold.
- The blob offsets `(blobs0 + extra - 1/3)` and `(blobs0 - 1/4)` are f64 and not
  narrowed, with `1/3` written as a division.

`src/noise/eval/f32.ts:1-113` is the authoritative writeup of "narrow the
product versus narrow the constant", with the 131x and 40x measurements.
`src/noise/fastApprox.ts:79-88` records that the exponent is `f32(1/3)` and not
the double `1/3` - worth 3.0% of all inputs (#163), where the double scores 0/24
and the f32 form 24/24.

---

## 11. Version skew - the 2.1.9 constants are already in this code

No `2.0.77` or `2.1.9` string appears in `src/noise/resources/`; the record
lives in `docs/fixture-version-audit.md:117-126`. `starting_patches` changed
materially between **2.0.77 and 2.1.9**, and every one of those changes is
visible in the TypeScript as a 2.1.9+ value:

| Lua change (2.0.77 -> 2.1.9) | Where it shows here |
| --- | --- |
| `starting_resource_placement_radius` 120 -> 150 | `STARTING_RESOURCE_PLACEMENT_RADIUS = 150` |
| `region_size` radius\*2 -> radius\*3 | `STARTING_REGION_SIZE = 450` |
| spacing 32 -> 48 | `STARTING_SPACING = 48` |
| `maximum_spot_basement_radius` fixed 128 -> scaled by patch size | `maxBasementRadius = 2 * rq * cbrt(q)` |
| `random_penalty_at(0.5, 1)` dropped from favorability | no penalty term in `startingFavorabilityBaseAt` |
| new `origin_excluder = "distance > 40"` | the `d > 40 ? 1 : 0` factor |
| distance term clamped | `Math.min(1, d / 150)` |
| lake term extracted, `elevation_lakes` -> `elevation` | reads `elevation_nauvis` |

`regular_patches` was untouched in the same window. If the port ever disagrees
with a fixture, **check which version produced the fixture before touching a
constant** - and note that neither `core/lualib/resource-autoplace.lua` nor
`base/prototypes/entity/resources.lua` moved at all between 2.0.77 and 2.1.12,
so guessing by filename would clear these fixtures wrongly.
