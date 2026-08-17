# Rust/WASM noise engine: port `src/noise/` out of TypeScript

Design record, 2026-08-16. Point-in-time, not a living document.

Tracking issue: [#215 - Port `src/noise/` to Rust/WASM inside the app](https://github.com/wormeyman/FactorioMapWebUI/issues/215),
which carries a sub-issue per phase and the progress bar. The measurements this
spec builds on live in that issue's body and its two comments; they are cited
here, never re-derived.

Related: [#214](https://github.com/wormeyman/FactorioMapWebUI/issues/214)
(`basisNoise` op order), [#162](https://github.com/wormeyman/FactorioMapWebUI/issues/162)
(the 7.153e-7 residual), [#27](https://github.com/wormeyman/FactorioMapWebUI/issues/27)
(Fulgora and the island finder).

## 1. Scope

`src/noise/` is 16,598 lines of reverse-engineered Factorio map generation. It
renders client-side previews for Nauvis, Vulcanus and Fulgora, and backs the
Fulgora island finder. Correctness means agreement with the game at f32, graded
against oracle fixtures captured from the real binary.

This spec covers moving the arithmetic to Rust, compiled to WebAssembly, running
inside the existing app behind the current `execute` seam.

Three layers come out of today's directory:

| layer | lines | goes where |
| --- | ---: | --- |
| root primitives, `eval/`, `expressions/`, `preview/` render loops, `cliffs/`, `tiles/`, `resources/`, `trees/`, `rocks/`, `placement/`, `enemies/` | the remainder, about 15,000 | **Rust** |
| `islands/`, `preview/tiling.ts` | **1,137** | TypeScript for now; re-decided in phase 7 |
| catalogs, constants, request and result types | a subset of 2,357; not yet split | TypeScript, permanently |

Only the middle number is exact. The third row is not a clean file boundary, and
that is worth knowing before anyone plans against it: the ten files whose names
contain "catalog" total 2,357 lines, but `tiles/vulcanusCatalog.ts` and
`tiles/fulgoraCatalog.ts` hold `makeVulcanusStack` and `makeFulgoraStack`, which
are tile resolvers and do port. So the catalog-only share is smaller than 2,357
and the Rust share is larger than 14,241. Splitting those files is a phase 5 and
phase 6 job, not a thing to guess at now.

### 1.1 Non-goals

- **The Vue UI, the `F*` component kit and the Pinia store.** Untouched.
- **`src/codec/`.** Its constraint is byte-exact reproduction of the game's
  zlib level-9 stream through `pako {level: 9, legacyHash: true}`, at 9 of 9
  fixtures. A Rust rewrite there is real work with no measured payoff.
- **WASM threads.** They need `SharedArrayBuffer` plus COOP and COEP
  cross-origin isolation, which would touch response headers and put the
  preview-service fetch at risk. One module instance per existing Web Worker
  needs none of that.
- **A standalone CLI or a separate app.** The engine crate would make both easy
  later. Neither is built here.
- **SIMD.** #215 measured the basis kernel as gather-bound: LLVM vectorised it
  into 45 four-lane f32 operations and f32 beat scalar f64 by only 1.27x,
  because each corner needs three table lookups and NEON has no gather
  instruction. Voronoi is integer hashing plus a branchy search, also scalar.

### 1.2 Why the middle row is a deferral, not a rejection

`islands/` is 1,051 lines of flood fill, Chebyshev graph building, largest-
rectangle search, grouping and ranking. `preview/tiling.ts` is box arithmetic.
None of it does f32 chain arithmetic, none of it has an oracle fixture, and
"more accurate in Rust" is not a meaningful claim about a flood fill.

#215 measured the finder's own logic at well under 1% of a search:
`chainComponents` runs about 365 ms at radius 5,000, against renders in the tens
of seconds.

But a 13x speedup on everything around it necessarily grows that share. Phase 7
re-decides with a real end-to-end number rather than a projection. Keeping it in
TypeScript through the migration also keeps `test/findIslands.spec.ts` - the
heaviest file in the suite at 134.6s - working as a live integration check on
the Rust engine at every phase.

### 1.3 Why the third row stays TypeScript for good

Five files outside `src/noise/` import from it. What they pull is almost
entirely not arithmetic:

| file | what it imports |
| --- | --- |
| `src/model/elevationPreviewCtx.ts` | `Point`, `VulcanusResourceControls`, `ResourceControlLevers`, `ENEMY_CONTROL_NAME`, cliff catalog types |
| `src/model/resourceReads.ts` | `RESOURCE_CATALOG`, control lever types |
| `src/components/renderPool.ts` | `planTiles`, `ImageBox`, the request and result types |
| `src/components/useElevationPreview.ts` | the request and result types |
| `src/components/IslandFinderPanel.vue` | `findIslands` and its option types |

These are labels, colors, marker sizes, names and types. Moving them to Rust
would need either a codegen step with its own sync gate, or a second hand-kept
copy that can drift from the one the Vue layer reads. Both cost something and
buy no measured speed.

## 2. What is already decided

Five calls were made before this spec was written. Each one changes the plan, so
each is recorded with its reason.

### 2.1 Fix #214 in TypeScript first, before any Rust exists

`src/noise/basisNoise.ts` evaluates in f64 with no narrowing, and its falloff is
`(1 - d) ** 3`. The game's kernel is f32, branchless, uses `t * (t * t)`, and
folds four corners pairwise rather than left to right. A Rust spike measured the
game's shape as **both faster and more accurate**: 3.46 against 4.40 ns/point,
and 2.384e-7 against 2.612e-7 worst absolute error on `oracle-basis`, where the
TypeScript port's own header claims 3.1e-7.

So the Rust wants the game's shape. The problem is that `basisNoise` sits
beneath every planet. Adopting the correct kernel in Rust alone would make the
Rust deliberately disagree with the TypeScript in the last bit, everywhere - and
that kills bit-diffing as a gate for the **entire** engine, not for one
primitive.

Fixing the TypeScript first costs one pull request and buys three things:

1. Strict bit equality is available as a gate for the whole port (section 7,
   tier 2).
2. The gradient table becomes committed constants on both sides at once. #214
   measured V8's `Math.cos` and `Math.sin` as differing from libm in the last
   bit, so a table derived at load time is a portability hazard in either
   language.
3. #162's 7.153e-7 residual gets its lead followed on its own merits, with the
   full 213-file suite as the safety net, rather than as a side effect of a
   port.

Rejected alternatives are in section 12.

### 2.2 A vertical slice before breadth

The obvious order is primitives, then `eval`, then every planet's expressions,
then every renderer. That order leaves the ABI, the worker wiring, the CSP
change and the wasm loading path all unexercised until the same late moment, on
the largest possible surface.

Instead, phase 3 ports **only** the Fulgora landmask path end to end. #215
already scoped it: Voronoi, the elevation chain, `oilMask`, `scrapMedium`,
`dunes`, `waterBase` and the ocean argmax. About 3,000 lines. It is also the
most valuable single path, because it is the island search that measures 126
seconds today.

This does not change the end state. The TypeScript math is deleted in one step,
in phase 7, once all three planets render from WASM.

### 2.3 The `.wasm` is committed, and the gate rebuilds it

`vp build` has no non-JS step today, and the `build` CI job needs no toolchain
and no secrets. The workflow comment calls that out on purpose.

Committing the module keeps both properties: `vp build` treats it as an asset,
and `deploy:app` still works from a machine with no Rust installed. The risk a
committed binary carries is silent staleness, so the `rust` CI job rebuilds it
and compares. That is the same generated-file-in-sync pattern already running
for `worker-configuration.d.ts` through `wrangler types --check`, which exists
because that file once drifted silently and nothing caught it.

Whether byte identity is achievable across macOS and an ubuntu runner is a
measurement, not an assumption. Phase 0b makes it before the gate is designed
around it (section 8.2).

### 2.4 Zero dependencies in anything that ships

Not "zero dependencies". The sharper rule is that nothing reaching a user has a
dependency, asserted in CI, while dev-dependencies are allowed under
`cargo-deny` and `cargo-audit`. Section 4.2 gives the reasoning and section 11
the policy.

### 2.5 The Rust gate needs no ruleset change

Ruleset `EJ` requires status checks by name: `verify` and `build`, with
`strict: true` and no bypass actors. Adding a required check is normally a
two-step, because requiring a check that does not yet exist on `main` blocks the
pull request that introduces it.

That is avoidable here. The job named `verify` does no work of its own - it
asserts `needs.static.result` and `needs.tests.result`. Adding a `rust` job to
its `needs`, with one more assertion, makes a red Rust gate turn `verify` red,
which blocks the merge. No new required check name appears, so nothing is added
that could block every pull request forever if it were later renamed.

## 3. The end state

- `crates/fmw-noise` holds every bit-exact computation for all three planets and
  all views.
- `crates/fmw-wasm` holds the boundary and nothing else.
- `src/noise/` still exists, holding `islands/`, `preview/tiling.ts`, the
  catalogs, the constants and the request and result types.
- `src/noise/preview/elevationRenderRequest.ts` keeps its public shape:
  `runRenderRequest(req) -> { id, buffer, width, height }`. Its body delegates
  to the WASM instance.
- No TypeScript in the repository performs noise arithmetic.

## 4. Repo layout and the dependency line

### 4.1 Layout

```
Cargo.toml            workspace
Cargo.lock            committed; every build runs --locked
rust-toolchain.toml   exact version, wasm32-unknown-unknown, rustfmt, clippy
.cargo/config.toml    minimal explicit flags; no target-cpu=native
deny.toml             cargo-deny
crates/
  fmw-noise/          lib. the engine. no runtime dependencies.
    src/primitives/   taus88, basis, multioctave, voronoi, spot, fastapprox
    src/eval/         f32-typed helpers, memo caches, ctx
    src/expressions/  per-planet trees
    src/render/       the per-pixel loops
    tests/            fixture tests, reading ../../test/fixtures/*.json
  fmw-wasm/           cdylib. the ABI and the exports. no logic.
src/noise/wasm/engine.wasm   the committed build artifact
```

The Rust tests read fixtures through
`concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/fixtures/...")`, so there is
one ground truth and not two. That requirement is what drives section 11's
dev-dependency decision.

`vp test` includes only `test/**/*.spec.ts`, so nothing under `crates/` is
picked up by the JavaScript runner. `fmt.ignorePatterns` needs no change,
because oxfmt does not touch `.rs` files.

### 4.2 The dependency line

**Nothing that ships has a dependency.** A CI step asserts it:
`cargo tree --edges normal` for `fmw-noise` and `fmw-wasm` lists only workspace
crates. That is a hard invariant and a cheap one, and it sidesteps the whole
supply-chain question for everything a user downloads.

Dev-dependencies are a different question, because they do not reach the
artifact. Exactly one is planned: `serde_json`, so the Rust fixture tests read
the same JSON the TypeScript specs read.

The alternative - a hand-written reader for the fixture shapes - was considered
and rejected. It is roughly 120 lines of parser, written to avoid the most
audited crate in the ecosystem, in a repository whose whole discipline is that
ground truth must not be duplicated. It also would not remove the supply-chain
question, only relocate it to code nobody reviews.

## 5. Determinism policy

Bit-exactness is the product here, so build determinism is a correctness
requirement rather than a preference.

| rule | why |
| --- | --- |
| `rust-toolchain.toml` pins the exact version and the `wasm32-unknown-unknown` target, plus `rustfmt` and `clippy` | the counterpart to `.node-version`; a compiler change is a codegen change |
| `Cargo.lock` committed; every build `--locked` | a resolution that happens at build time is a build that is not reproducible |
| no `mul_add`, no fast-math, no `-ffast-math` equivalent | Rust does not contract `x * y + z` into a fused multiply-add by default. This rule is about keeping it that way. Go's spec permits that fusion and arm64 performs it, which is one of the two reasons Rust was chosen |
| `clippy::suboptimal_flops` explicitly allowed, with a comment | that lint **recommends** `a.mul_add(b, c)`. It lives in `nursery`, so it is off today. The `allow` exists so that turning `nursery` on later cannot silently push the port toward FMA |
| no `-C target-cpu=native` | it makes codegen machine-specific, which defeats reproducible builds and could change vectorisation |
| `simd128` off, pinned | #215 measured SIMD at 1.27x on a gather-bound kernel. Turning it on would not change results, since LLVM will not reassociate floats without fast-math, but it does change the binary and therefore the byte-identity gate - for no measured gain |
| `relaxed_simd` off | its FMA operations are explicitly non-deterministic across engines |
| no `HashMap` iteration reaching output | use `BTreeMap`, sorted iteration or index arrays. The Voronoi cache is a direct-mapped array anyway (section 8.4) |
| trig as committed constants, never a runtime `sin`/`cos` | V8 and libm differ in the last bit. Phase 0a puts the same literals on the TypeScript side |

One property is worth stating because it is a genuine gain, not just a
constraint. **WebAssembly's scalar float arithmetic is specified as
deterministic IEEE-754.** There is no FMA instruction in the MVP, no
reassociation, and no `sin` or `cos` at all - any transcendental has to be code
we compiled. So once the engine is WASM, the host JavaScript engine can no
longer introduce the kind of drift that V8's `Math.cos` does today.

## 6. The `execute` seam and the ABI

### 6.1 What does not change

```ts
export function runRenderRequest(req: ElevationRenderRequest): ElevationRenderResult
```

One call, fill a buffer. `elevationRender.worker.ts` still posts the result and
transfers `result.buffer`. `createWorkerHost` and `defaultPoolSize` are
untouched, and both the preview panel and the island finder keep sharing the
pool. This shape is why WASM did so well in the spike: one boundary crossing per
sweep, not one per sample.

### 6.2 Module and instance lifetime

- The `.wasm` is imported with `new URL("./engine.wasm", import.meta.url)`, so
  Vite emits it as a hashed asset with the right MIME type and no plugin is
  needed.
- The main thread compiles it **once** into a `WebAssembly.Module` and
  `postMessage`s that module to each worker. `Module` is structured-cloneable,
  so N workers cost one compile rather than N.
- Each worker instantiates once at start and reuses the instance for every
  request.

### 6.3 The request encoding

The request crosses as a flat little-endian buffer written into linear memory:
a fixed header of `u32` and `f64` fields, then length-prefixed tails for
`startingPositions`, `startingLakePositions` and the control maps.

- Hand-written writer in TypeScript, hand-written reader in Rust. No
  dependency on either side.
- The buffer carries a **version word**. A mismatch is a hard error, not a
  best-effort parse.
- **Control names cross as indices, never strings.** The module exports
  `catalog_names()`, which writes its own ordered name list into linear memory,
  and a TypeScript spec asserts that list equals the TypeScript catalog. One
  test, no codegen step, and no way for the two orderings to drift apart
  silently.
- A committed round-trip fixture pins the encoding: a known request, its exact
  bytes, and the decoded struct. Neither side can change the layout without the
  other going red.

### 6.4 The result, and the one copy

Reading the render output is zero-copy: a `Uint8ClampedArray` view over linear
memory at the offset the module returns.

Sending it is not. `postMessage` cannot transfer a view over WebAssembly memory,
so the worker `slice`s once into a fresh `ArrayBuffer` and transfers that. At
1024x1024 that is 4 MB, well under a millisecond, against renders measured in
seconds.

This is written down rather than described as zero-copy because a wrong belief
about where a copy happens is exactly the kind of thing that gets repeated.

### 6.5 Errors

Expected errors return a status code in the result header. They do not trap.

`voronoi_pyramid_noise` rejects `minkowski3`, as the game's own expression
compiler does. A trap would poison the instance for every later request in that
worker. `panic = "abort"` stays on for genuine bugs, and `createWorkerHost`
already drops and recreates a worker that dies.

## 7. The cross-check harness

Three tiers. Only one of them is authority.

### 7.1 Tier 1 - oracle fixtures. The only correctness gate

Every Rust module ships a test that reads the same `test/fixtures/oracle-*.json`
its TypeScript counterpart reads, and asserts the same bound.

**A mismatch is a finding, never a bound to widen.** Widening a bound has hidden
a real defect twice on this port, once worth 131x and once worth 40x, and both
times the widened test still passed. The check that matters when a bound looks
wrong is how the field compares to its siblings: an order of magnitude worse
than fields of similar depth is a bug, not a floor.

Adding a fixture means adding its entry in `test/fixtures/PROVENANCE.json`.
`test/fixtureProvenance.spec.ts` enforces that in both directions and needs no
Factorio install.

### 7.2 Tier 2 - parity against the TypeScript

A shared point-grid definition per module - seed, origin, step, count - and a
fold of every result's raw bits into one value. Identical folds mean bit-
identical output at every point, which is far stronger than "agrees to 1e-7".

This detects **divergence**. It does not establish correctness. The TypeScript
is a port too, not ground truth.

Two changes from the spike:

**Build the `.wasm` from phase 1, not phase 4.** The spike proves a 1,518-byte
module with no `wasm-bindgen` and no `wasm-opt`. If the module exports
`checksum_<module>(seed, x0, y0, step, n) -> u64` from the first week, every
parity test is an ordinary TypeScript spec that loads the module and compares in
process. No dump binary, no committed intermediate file, no file for the two
sides to drift through - and the wasm loading path is exercised from the start
instead of arriving as a late surprise.

**Use FNV-1a, not XOR.** The spike's XOR fold earned its place: four
implementations across three languages all folded to `021e0ada` over 1,000,000
points, and it caught a real sentinel bug in the Go arm (zero is a valid cache
tag, and Go zero-initialises slices) that the timings would have kept. But XOR
is blind to order and cancels pairs. Swap two points, or break two points
identically, and the fold does not move. FNV-1a over the result bytes is
order-sensitive. XOR stays only where order genuinely does not matter.

Strict bit equality is available as the tier-2 assertion only because #214 is
fixed in TypeScript first (section 2.1). Without that, everything downstream of
`basisNoise` - which is everything - could only be graded at fixture tolerance.

### 7.3 Tier 3 - whole-image parity

Byte-identical RGBA from the Rust renderer against the TypeScript renderer, for
the same request, across every planet and view. Plus the four PNG oracle
fixtures:

- `oracle-preview-nauvis-terrain.seed123456.png`
- `oracle-preview-vulcanus-terrain.seed123456.png`
- `oracle-preview-fulgora-terrain.seed123456.png`
- `oracle-preview-fulgora-scrap.seed123456.png`

**Those PNGs use a different seed convention from every JSON fixture in the
repository, and getting it wrong looks exactly like a broken port.** They come
from `factorio --generate-map-preview --map-gen-seed`, which takes a **map**
seed, so the surface seed is `mapSeed + crc32(planet)`. Every `oracle-*.json`
comes from `sampleExpression`, which sets the surface seed directly. Comparing a
correct Fulgora scrap field against the PNG with the raw seed scored 0.5%
overlap; with `surfaceSeedForPlanet("fulgora", 123456)` = 2967702466 the same
comparison scored 99.9%. Nothing about the 0.5% run announced itself as a seed
problem.

Label every seed in this port's code, comments and issues as MAP or SURFACE.

### 7.4 Anti-vacuity, at every tier

A `poison` cargo feature perturbs exactly one result by one bit. The gate builds
with it once and asserts that each tier goes red.

A parity test that passes against a deliberately broken port is worth nothing,
and this repository has caught vacuous guards exactly this way before - the
`unstubGlobals` flags in `vite.config.ts` are only known to work because
`test/mockLeakGuards.spec.ts` plants failures that discriminate.

## 8. Phasing and the gate at each phase

Each phase is a sub-issue of #215, so the progress bar tracks it.

### 8.1 Phase 0a - fix `basisNoise` in TypeScript (#214)

Its own pull request, no Rust involved. Adopt f32 throughout, `t * (t * t)`, the
branchless corner selection, the pairwise fold, and the gradient table as
committed constants rather than values derived from `Math.cos` at load.

Re-baseline every affected bound against the full suite. The change touches
Nauvis, Vulcanus and Fulgora at once, which is why #214 says it wants its own
session rather than a tail-end edit.

**Gate:** `pnpm run verify` green, every fixture bound justified by a measured
number, and the #162 residual re-measured and recorded whether or not it moves.

### 8.2 Phase 0b - is the wasm32 build byte-reproducible? (#218)

A spike. Build one trivial crate on macOS and on an ubuntu runner with `--locked`
on the pinned toolchain, and compare sha256.

Zero dependencies means no registry paths land in the binary, and `strip = true`
plus `panic = "abort"` remove most of what is left, so the odds look good. That
is a prediction, and this phase exists to replace it with a measurement.

**Gate:** the answer is recorded either way. If yes, the `rust` job asserts byte
identity. If no, it rebuilds and runs the fixture tests against the freshly
built module - weaker, but still catches a `.wasm` that no longer matches its
source.

### 8.3 Phase 0c - land the gate, empty (#219)

The whole Rust workspace and CI job, holding one trivial crate and one trivial
test.

This is deliberate. Never let the change that introduces a gate be the first
change the gate blocks - the same reasoning as the documented two-step for
required status checks.

**Gate:** the `rust` job is green on `main`, and a planted failure in each of its
steps turns the required `verify` check red.

### 8.4 Phase 1 - primitives, 2,336 lines (#220)

`taus88`, `basisNoise`, `multioctaveNoise`, `quickMultioctaveNoise`,
`variablePersistenceMultioctaveNoise`, `fastApprox`, `voronoiNoise`,
`spotCandidates`, `spotSelection`, `distanceFromNearestPoint`, `randomPenalty`,
`startingLakes`.

All of the measured speedup and all of the bit-exactness risk live here. The
rest of the port is transcription.

Two things to carry in rather than rediscover:

- **Zero is a valid cache tag.** The Voronoi direct-mapped cache measured 31.6
  against 138.4 ns/point, so it is worth having - and it is exactly where the Go
  spike's bug was, because a zero-initialised tag array makes cell (0, 0) read
  uninitialised offsets.
- **A fitted constant against `basis_noise` is only determined modulo 256.**
  That has caused a wrong finding twice on this port.

**Gate:** tier 1 and tier 2 per module, plus the poison build.

### 8.5 Phase 2 - the `eval` layer, 494 lines (#221)

`ctx`, `f32`, `math`, `memoRegion`, `memoXY`, `multisample`, `primitives`,
`sliderRescale`.

The `f32()` discipline disappears into the type system - roughly 175
`Math.fround` calls per sample stop being calls at all. That is why composition
measured at 13.2x against 7.5x for the leaf kernel: `sumOctaves` is dense in
exactly those calls and in f32/f64 mixing that Rust gets for free.

Two rules carry across rather than being re-derived:

- **`memoXY` records its coordinates after the wrapped function returns.** A
  function that throws must not leave the slot claiming a position it never
  produced a value for; otherwise the next call at that position returns the
  previous position's number instead of throwing again.
- **The two-case f32 rule.** An f32-sized residual on a scaled coordinate has at
  least two causes needing opposite fixes: narrow the product, or narrow the
  constant. In Rust the second case becomes literal typing - `y * 0.8f32` is not
  `((y * 0.8f64) as f32)` - so the class changes shape rather than vanishing.

**Gate:** tier 1 against `oracle-multioctave-wrappers`, `oracle-multisample`,
`oracle-multisample-grid`, `oracle-fastpow` and `oracle-seed-vars`; tier 2;
poison.

### 8.6 The CSP change (#222)

Lands with or before phase 3, which is when WASM first runs in the deployed app.
Section 10 has the detail.

### 8.7 Phase 3 - the Fulgora landmask vertical slice (#223)

Voronoi, the elevation chain, `oilMask`, `scrapMedium`, `dunes`, `waterBase` and
the ocean argmax. About 3,000 lines. Plus the whole of section 6.

**Gate:**

- Tier 3 whole-image parity on `view: "landmask"`.
- `test/findIslands.spec.ts` passes unchanged against the WASM engine.
- The CSP change and its rewritten guard have landed.
- An **in-browser** measurement of the speedup, repeated 3 to 5 times on a quiet
  machine, reporting the spread. Never a single shot, and never in the same
  command as the build: four single-shot Rust runs taken right after
  `cargo build` all landed on E-cores, agreed with each other, and were wrong by
  2.3x.

### 8.8 Phase 4 - the rest of Fulgora (#224)

The eight land-tile formulas, roads, ruins, and scrap resources.
`expressions/fulgoraCells`, `fulgoraElevation`, `fulgoraMasks`, `fulgoraRoads`,
`fulgoraRuins`, `fulgoraScrap`, `fulgoraShared`, plus `tiles/fulgoraCatalog`,
`preview/renderFulgoraTerrain` and `preview/renderFulgoraResources`.

**Gate:** tier 1 across `oracle-fulgora-*`, tier 2, tier 3 against both Fulgora
PNGs at surface seed 2967702466 (section 7.3).

### 8.9 Phase 5 - Vulcanus (#225)

`expressions/vulcanus*`, `tiles/vulcanusCatalog`, the cliff stack, the resource
stack and the rock overlay.

The heaviest specs in the suite live here - `vulcanusCliffRejectionStage` at
52.1s, `vulcanusStackCache` at 47.8s, `cliffOreCascade` at 30.1s,
`vulcanusCliffBands` at 28.4s - so this phase has the largest test surface to
rebuild and the largest effect on CI either way.

Two findings must survive transcription rather than being rediscovered:
`multisample` offsets are in the caller's grid units, not the sampled field's;
and `cliff_removal_probability` is the mechanism by which ore suppresses cliffs.

**Gate:** tier 1 across the Vulcanus fixtures, tier 2, tier 3 against
`oracle-preview-vulcanus-terrain.seed123456.png` at surface seed 1249936247,
which `previewAgreement.spec.ts` already carries as a constant for this reason.

### 8.10 Phase 6 - Nauvis and the five overlays (#226)

`expressions/elevationLakes`, `elevationNauvis`, `elevationIsland`, `moisture`,
`temperature`, `aux`, `nauvisShared`, plus `resources/`, `enemies/`, the Nauvis
half of `cliffs/`, `trees/`, `rocks/` and `placement/`.

The largest phase by line count and the one with the most fixtures behind it,
but the least research risk: the primitives were settled in phase 1 and every
expression here has committed ground truth.

**Gate:** tier 1 across the Nauvis fixtures, tier 2, tier 3 against
`oracle-preview-nauvis-terrain.seed123456.png`, and `previewAgreement.spec.ts`
passing against the WASM engine.

At the end of this phase the Rust engine renders every planet and every view,
and the TypeScript math is dead code.

### 8.11 Phase 7 - cut over and delete (#227)

`src/noise/` is imported by **155 of the 213 spec files**, so this is the largest
single piece of the migration and must not be a bulk delete. Two populations,
handled differently:

- **The 98 specs that read a fixture.** Their assertions were rebuilt in Rust as
  each phase landed, so removing them is a subtraction rather than a gap. Verify
  that per file rather than assuming it.
- **The ~57 specs that import `src/noise/` and read no fixture** - memo
  behaviour, catalog shape, request routing. Inventoried one at a time. Some
  move to cargo tests, some become parity or seam tests, and some test an
  implementation that no longer exists and simply go.

Also here:

- Re-decide whether `islands/` and `preview/tiling.ts` cross into Rust, with a
  real end-to-end number for what they then cost as a share.
- Re-measure the CI shard balance. Do **not** quote one run: three runs over
  identical spec files have spanned 294 to 469 seconds on this repository, a 59%
  swing on unchanged code.

**Gate:** `src/noise/` holds orchestration and catalogs only, `pnpm run verify`
is green, and the deployed app renders all three planets from WASM with
`pnpm run verify:deploy` confirming the build that shipped.

## 9. Build and CI integration

### 9.1 The build

`src/noise/wasm/engine.wasm` is committed. It is loaded with
`new URL("./engine.wasm", import.meta.url)`, so Vite emits it as a hashed asset.

**`vp build` gains no non-JS step**, stays about a second of Rolldown, and needs
no Rust toolchain. `deploy:app` is unchanged.

A `scripts/build-wasm.sh` regenerates the module. It is not part of `vp build`,
and it is not part of `verify` - it is the thing the gate checks the output of.

### 9.2 The local gate

`verify:rust` chains into `pnpm run verify`, **last**, after `vp test`. `verify`
already measures about 3m30s cold, and a cold `cargo build` should not sit in
front of the phases that fail fastest.

The `vp run --cache test` phase is unaffected: its content-keyed cache covers
the TypeScript test phase only.

### 9.3 CI

A new `rust` job, alongside `static`, `tests` and `build`:

| step | |
| --- | --- |
| checkout | pinned to a full commit SHA, with the release in a trailing comment, like every other action here |
| install the toolchain | from `rust-toolchain.toml`, so the pin lives in one place |
| `cargo fmt --check` | |
| `cargo clippy --all-targets --all-features -- -D warnings` | warnings are errors, as they effectively are on the TypeScript side |
| `cargo test --locked` | |
| `cargo deny check` | |
| zero-shipped-dependencies assertion | `cargo tree --edges normal` lists only workspace crates |
| wasm rebuild and compare | in whichever form phase 0b settles |

It names package.json scripts where it can, never underlying commands, so there
stays exactly one definition of each phase and CI cannot drift from local.

`permissions: contents: read`. No secrets. No cargo registry credentials, since
nothing is published.

**The `verify` job gains `rust` in its `needs` and one more result assertion.**
It must keep asserting `needs.*.result` explicitly rather than relying on
`needs:` alone: a job whose dependency failed is *skipped*, and a skipped
required check does not block a merge.

No ruleset PUT (section 2.5).

## 10. The CSP change

WebAssembly compilation needs `'wasm-unsafe-eval'` in `script-src`. Nothing else
in `public/_headers` moves: `connect-src 'self'` already covers fetching the
module, and the worker is same-origin so `default-src 'self'` covers it.

`test/buildStamp.spec.ts:200` currently asserts the policy does not contain the
substring `unsafe-eval`. A substring match cannot tell `'unsafe-eval'` from
`'wasm-unsafe-eval'`.

**Do not widen it.** Split `script-src` on whitespace and assert two things:

1. the token list does **not** contain exactly `'unsafe-eval'`
2. the token list **does** contain `'wasm-unsafe-eval'`, so the narrow token
   cannot be quietly dropped and break the app instead

Plant a failure for both halves, so neither assertion can go vacuous.

Then verify live in Chrome after the deploy, the way the zlib-asm policy was
verified: load the app, confirm zero `securitypolicyviolation` events, and
confirm a deliberately injected inline `<script>` is **still blocked** as the
control. A run with no violations proves nothing unless the control fires.

## 11. Cargo supply-chain policy

The npm side is governed by `minimumReleaseAge: 1440` in `pnpm-workspace.yaml`,
Renovate rules that carry their reasoning in the pull request body, and
SHA-pinned GitHub Actions. Cargo has no equivalent of the first one on stable:
`-Zmin-publish-age` (rust-lang/cargo#15973) is unstable.

Three things instead:

1. **Zero dependencies in anything that ships**, asserted in CI. This removes
   the question entirely for everything a user downloads.
2. **`cargo-deny` in the `rust` job** for advisories, licences and bans;
   `cargo-audit` locally, already installed at 0.22.2 through Homebrew.
3. **A Renovate `cargo` rule with `minimumReleaseAge: "3 days"`**, matching the
   npm side, with `prBodyNotes` carrying the reasoning. This governs what gets
   **proposed**, which is the half cargo can still govern.

Two cautions inherited from the npm side:

- **`enabled: false` disables security updates too.** Any crate held that way
  needs re-checking against the advisory database by hand. That rule was learned
  when `brace-expansion` sat on a live advisory for a week because a note said
  the red audit line was expected.
- **Validate any Renovate config edit.** A config that fails to parse makes
  Renovate do nothing at all, silently, which is indistinguishable from "no
  updates available".

## 12. Alternatives considered and rejected

| alternative | why not |
| --- | --- |
| **Go instead of Rust** | Go's spec permits fusing `x * y + z` into an FMA and arm64 does it, so bit-exactness needs a hand-written `float32()` at every site and forgetting one is silent. Go's standard WASM ships a garbage collector at multiple megabytes, which would mean the TypeScript engine lives on forever beside it. Rust is also 2.6x ahead on the code a real port would write (31.6 against 81.4 ns/point). Go *was* bit-exact in the spike |
| **Adopt the game's `basisNoise` shape in Rust only** | kills bit-diffing as a gate for the entire engine, since `basisNoise` sits beneath every planet, to save one pull request |
| **Transcribe the current TypeScript exactly, fix the op order later** | keeps the gate but deliberately writes a kernel known to be wrong, and makes the eventual fix a simultaneous two-language change touching every fixture |
| **Port `islands/` now** | worth about 1% of a search. Costs rewriting the heaviest spec file in the suite, and moves the finder's user-visible behaviour - ranking, the clipped marker, progress, gps tags - across a language boundary while it is still changing weekly |
| **Generate the catalogs from Rust** | a codegen step and a sync gate, for label and color tables the Vue layer reads and no renderer computes |
| **Build the `.wasm` during `vp build`** | the `build` CI job, `deploy:app` and every contributor would need the Rust toolchain, and `vp build` would go from about a second to a cargo build |
| **Commit the `.wasm` with no rebuild gate** | nothing would detect a module that no longer matches its source. `worker-configuration.d.ts` drifted silently in exactly this way until `wrangler types --check` landed |
| **`wasm-bindgen`** | the spike hit 1,518 bytes without it, and the boundary is one call per sweep. It would add a dependency and a build step to generate glue for a single function |
| **`wasm-opt`** | another toolchain in the gate. Revisit if a measurement shows the module is too large or too slow; there is no such measurement today |
| **WASM threads** | need `SharedArrayBuffer` plus COOP and COEP, which would touch headers and risk the preview-service fetch. One module per existing Worker needs none of it |
| **A hand-written JSON reader to reach zero dev-dependencies** | about 120 lines of parser risk to avoid the most audited crate in the ecosystem, in code nobody reviews |
| **Keep the spike's XOR fold** | blind to order, and cancels pairs. It earned its place by catching the Go sentinel bug; FNV-1a keeps that property and adds order sensitivity |

## 13. Open questions

These are genuinely open. They are not placeholders for decisions that were
avoided.

1. **Is the wasm32 build byte-reproducible across macOS and ubuntu?** Phase 0b
   answers it, and the answer changes the shape of the build gate (section 2.3).
2. **How large is the full module?** 1,518 bytes is a 150-line kernel. The full
   port is about 15,000 lines of TypeScript. There is no garbage collector and
   no runtime baseline, which was the actual question against Go, but the number
   is unknown until phase 3 produces a real one.
3. **What does the port do to CI wall time?** Adding a `rust` job adds about 28
   seconds of checkout and install plus the cargo build, and phase 7 removes a
   large share of the TypeScript suite. Both effects are real and neither is
   estimated here, because a single run on this repository has measured a 59%
   spread on unchanged code.
4. **Does `islands/` cross into Rust?** Deferred to phase 7 on purpose, so the
   call is made on a measured share rather than a projected one.
5. **Does fixing #214 move #162's 7.153e-7 residual?** #214 points the right
   way on 38 points of one fixture. It does not close a residual measured across
   a wider set. Phase 0a records the answer either way.
