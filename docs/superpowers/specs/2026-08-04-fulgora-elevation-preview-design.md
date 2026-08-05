# Fulgora V1: the Voronoi primitive and the elevation / oil-ocean preview

Design record, 2026-08-04. Point-in-time, not a living document.

Issue: [#27 - Fulgora & large island finder](https://github.com/wormeyman/FactorioMapWebUI/issues/27).

## 1. Scope, and why #27 is split

#27 asks for two things: Fulgora, and a tool that finds large islands or island
chains that regular power poles can bridge. They share almost nothing. One is
noise reverse-engineering; the other is connected-component analysis over an
elevation field plus UI. The island finder needs no new noise primitives and
would already run today against the Nauvis island map type.

They are therefore separate projects. **Fulgora goes first** (Eric's call,
2026-08-04); the island finder gets its own spec afterwards and inherits the
field this one produces.

Within Fulgora, this spec covers **V1 only**:

- the `VoronoiNoise` primitive,
- the `fulgora_elevation` expression chain,
- the four oil-ocean tiles, rendered against flat land,
- Fulgora appearing in the preview's planet dispatch.

### Non-goals

Explicitly out of scope, each a later spec:

- the road / ruin tile layer (`fulgora_road_*`, `fulgora_structure_*`,
  `fulgora_tile_ruin_*`) and `fulgoran-dust` - which is where
  `voronoi_facet_noise` and the `chebyshev` / `minkowski3` distance types get
  *consumed*. The primitive itself implements and fixture-covers all four ops
  and all four distance types (section 4); nothing in the V1 **expression
  chain** reaches beyond `manhattan` and `euclidean`,
- scrap resources - the autoplace expression reads `fulgora_structure_cells` and
  `fulgora_road_paving_2c`, so it is gated behind the tile layer,
- cliffs (`fulgora_cliffiness` reads `fulgora_road_pyramids`, same gate),
- the island finder.

The staging mirrors Vulcanus V1 -> V2 -> V3.

## 2. Research: what the deterministic sources already settle

This section exists because it changes the risk profile. It was gathered before
any disassembly, at Eric's direction.

### The API docs specify all four ops semantically

`factorioLuaAPI/auxiliary/noise-expressions.html` (2.1.12) documents behaviour,
not just signatures:

| op | documented meaning |
| --- | --- |
| `voronoi_spot_noise` | distance to the closest point; 0 at the point, rising in a cone around it |
| `voronoi_facet_noise` | distance to 2nd-closest minus distance to closest; 0 at a cell boundary |
| `voronoi_pyramid_noise` | "like facet noise but the gradient is uniform and represents the distance to the closest edge" |
| `voronoi_cell_id` | a random value 0 to 1, constant across a cell |

Shared parameters: `x`, `y`, `seed0` (constant), `seed1` (`NoiseLayerID`,
constant), `grid_size` (**constant 16-bit unsigned integer**), `distance_type`
(enum), `jitter` (constant 0-1, default 0.5; 0 = point at cell centre, 1 =
anywhere in the cell).

`distance_type` enum: `chebyshev` = 0, `manhattan` = 1, `euclidean` = 2,
`minkowski3` = 3, the last being `(abs(x)^3 + abs(y)^3)^(1/3)`.

### Two documented corrections, both already reflected in the 2.1.12 mirror

- The return is a **normalised** distance, not a tile distance. Bilka:
  "It's indeed based on grid size, you can get the tile distance with
  `tile_distance = grid_size * distance`."
  ([forum](https://forums.factorio.com/viewtopic.php?p=680325))
- `minkowski3` takes `abs()` on both terms.
  ([forum](https://forums.factorio.com/viewtopic.php?p=685547))

### The version-skew landmine

Bug [#130905](https://forums.factorio.com/130905): the voronoi ops searched only
the current and immediately-neighbouring grid cells, so at high jitter they
missed the true nearest point. Genhis: "Thanks for the report, it's fixed for
2.1." Local `changelog.txt` line 849 places the fix in **2.1.7**:

> Fixed voronoi noise expressions not finding the closest point in high-jitter
> situations.

Our binary and `factorio-data` are both 2.1.12, so we port the **fixed**, wider
search. `NoiseOperations::VoronoiNoise::getPointsSearchRange() const` is a real
symbol in the unstripped binary.

This is not academic. Fulgora runs `fulgora_jitter = 0.6`,
`fulgora_structure_jitter = 0.8`, `fulgora_road_jitter = 1` - all high. A
textbook 3x3 Voronoi would produce a plausible Fulgora that is wrong, which is
this codebase's recurring failure mode.

### FFF context

- [FFF-401](https://factorio.com/blog/post/fff-401) explains `cliff_smoothing = 0`
  in the preset: "The smoothing was a nightmare for planets that need more
  precise cliff placement like Fulgora."
- [FFF-399](https://www.factorio.com/blog/post/fff-399) confirms the three island
  classes map onto the Lua's `fulgora_mesa` / `fulgora_sprawl` / `fulgora_vaults`
  split, and states that most islands are detached but "it is possible for two or
  more islands to overlap, potentially creating an even larger island" - which is
  exactly what #27's finder will hunt.
- [FFF-390](https://factorio.com/blog/post/fff-390) covers the noise-expression
  engine generally.
- [FFF-398](https://factorio.com/blog/post/fff-398) is atmospheric only; it
  carries no map-gen numbers.

### What remains genuinely unknown

Five things, all narrow:

1. the per-cell jitter-offset RNG from `(seed0, seed1, cellX, cellY)`,
2. `cell_id`'s 0-1 draw,
3. `pyramid_noise`'s exact formula - `computePyramidNoiseManhattan` is a
   dedicated symbol, so it is per-distance-type,
4. the 2.1.7 search range,
5. the normalisation divisor per distance type.

### Already solved elsewhere in this repo

`starting_spot_at_angle` (Vulcanus), string `seed1` hashing (crc32, see
`nauvisShared.ts`), `multioctave_noise`, `slider_to_linear` / `slider_rescale`,
`lerp` / `clamp`. `controlCatalog.ts:85-87` already carries `fulgora_islands`
(frequency + size), `fulgora_cliff` and `scrap`, so the **editor already supports
Fulgora presets** - only the preview is missing.

## 3. Architecture

| file | holds |
| --- | --- |
| `src/noise/voronoiNoise.ts` | the primitive: 4 ops x 4 distance types + point generation. Planet-agnostic, beside `basisNoise.ts` / `spotCandidates.ts` / `taus88.ts` |
| `src/noise/expressions/fulgoraShared.ts` | `fulgora_grid`, wobble fields, `ox`/`oy`/`wx`/`wy`, jitter constants, starting cones and masks |
| `src/noise/expressions/fulgoraCells.ts` | `cells` / `pyramids` / `spots` and the `blanks` / `mesa` / `sprawl` / `vaults` classification |
| `src/noise/expressions/fulgoraElevation.ts` | `natural` -> `mix_*` -> `sand_basins` -> `pre_elevation` -> `fulgora_elevation`, plus `oil_mask` |
| `src/noise/tiles/fulgoraCatalog.ts` | ocean-tile argmax over `water_base`; land as a sentinel |
| `src/noise/preview/renderFulgoraTerrain.ts` | the pixel sweep |

Plus dispatch wiring in `elevationRenderRequest.ts` and
`elevationRender.worker.ts`; notes in `docs/noise/voronoi-NOTES.md` and
`docs/noise/fulgora-elevation-NOTES.md`; fixtures with `PROVENANCE.json` entries
(`fixtureProvenance.spec.ts` fails on a fixture without one).

### Three decisions baked in from the start

- **Surface seed via `planetSurfaceSeed.ts`.** Fulgora generates at
  `mapSeed + crc32("fulgora")`, not `mapSeed`. This is the exact bug that cost a
  session on Vulcanus, and it disagrees totally (9.7% tile agreement), not
  subtly. The oracle harness *forces* the surface seed to the map seed, so oracle
  agreement is structurally blind to it - it needs its own assertion (section 7).
- **`memoXY` on every DAG node.** Vulcanus shipped without it and ran ~50x slow
  because shared nodes re-evaluated per access. Fulgora's chain is deeper and
  `fulgora_pyramids` alone feeds six consumers.
- **Voronoi points cached per grid cell**, not per pixel. A sweep revisits the
  same cells thousands of times and the search range makes each lookup touch
  several.

## 4. The `VoronoiNoise` primitive

### Interface

```ts
export type VoronoiDistanceType =
  | "chebyshev" | "manhattan" | "euclidean" | "minkowski3";

export function makeVoronoi(p: {
  seed0: number;
  seed1: number;            // crc32 of the NoiseLayerID string
  gridSize: number;         // u16 per the docs
  jitter: number;           // 0..1
  distanceType: VoronoiDistanceType;
}): {
  cellId(x: number, y: number): number;
  spotNoise(x: number, y: number): number;
  facetNoise(x: number, y: number): number;
  pyramidNoise(x: number, y: number): number;
};
```

A factory rather than four standalone functions, because the point field is
shared and **Fulgora deliberately exploits that**: `fulgora_cells` and
`fulgora_pyramids` pass byte-identical parameters (`seed1 = 'fulgora_cells'`,
manhattan, jitter 0.6), and `fulgora_spots` shares seed, grid and jitter but
switches to euclidean.

That last case rests on a claim to **verify, not assume**: that point *placement*
is independent of `distance_type`, which only chooses which point is nearest.
`VoronoiPoints`' constructor takes the whole `VoronoiNoise`, so the claim is not
free. At jitter 0.6 the check is concrete - invert the points under euclidean
(rung R3 below) and compare against those inferred under manhattan. If they
match, one cached point field serves all three nodes, which is most of the
per-pixel Voronoi cost.

`facetNoise` is implemented and fixture-covered even though V1 does not consume
it: it falls out of the same nearest / second-nearest search, and leaving it out
would mean re-opening the primitive for M2.

### The ladder

Oracle-first (Eric's call, 2026-08-04). `sampleExpression()` in
`test/oracle/oracle.ts` takes an arbitrary expression string, so it can probe a
bare `voronoi_cell_id{...}` directly with parameters we choose, ~1.7 s per run -
no Fulgora involvement needed. Four rungs, each independently falsifiable:

- **R1 - `jitter = 0`.** Every point sits at its cell centre, so all four ops
  reduce to closed-form geometry and the RNG vanishes. Settles the distance
  formulas, the normalisation divisor, and `pyramid_noise`'s definition. Carries
  a **vacuity guard**: a deliberately wrong normalisation must make the probe
  fail, or the probe is measuring nothing.
- **R2 - `cell_id`.** It *is* the per-cell RNG exposed as a float. Dump a large
  cell range across several `(seed0, seed1)` pairs and fit against hash families
  already cracked here: `basis_noise` seeding, `taus88`, `Noise::setSeed`.
- **R3 - point offsets.** Invert `spot_noise` minima at jitter > 0 to recover
  each point's true coordinates - the cone apex sits on the point - then test
  whether those offsets come off the same stream as `cell_id`. This is the trick
  that broke `spot_noise`'s selection phase.
- **R4 - search range.** Construct probes at jitter = 1 where a 3x3 search and a
  5x5 search give *different* answers, and read which the game agrees with. This
  measures the 2.1.7 fix rather than trusting the changelog.

If a rung stalls, the backstop is objdump of that one function -
`getPointsSearchRange` for R4, `VoronoiPoints` for R3 - not a general
disassembly effort. The binary is unstripped; `lipo -thin` before objdump, per
`docs/noise/basis-noise-NOTES.md`.

### Fixtures

`test/fixtures/oracle-voronoi.seed123456.json`: 4 ops x 4 distance types x
jitter {0, 0.6, 0.8, 1}, at positions covering cell interiors, cell boundaries,
and the far corners the bug report identifies.

`test/fixtures/oracle-voronoi-jitter1.seed123456.json`: a dedicated high-jitter
stress set built specifically around the far-corner geometry from #130905, so a
regression to the pre-2.1.7 3x3 search **fails a named test** instead of quietly
shifting island shapes.

Both get `PROVENANCE.json` entries: version 2.1.12, evidence `stated`.

## 5. The Fulgora elevation chain

**44 named expressions are reachable from `fulgora_elevation`** (4 of them bare
constants: `fulgora_jitter` 0.6, `fulgora_artificial_cap` 0.25,
`fulgora_coastline` 80, `fulgora_coastline_drop` 20), plus `fulgora_dunes` and
`fulgora_scrap_medium` for the ocean tiles and the `water_base` noise-function -
46 in total.

Reachability was traced rather than assumed, and it cuts both ways:

- **Four nodes that look central are not reachable** and are deferred to M2:
  `fulgora_natural_mask`, `fulgora_natural_and_mesa_mask`, `fulgora_sprawl_mask`,
  `fulgora_artificial_mask`. They feed only the ruin tiles. `fulgora_mix_moats`
  gates on `vaults_and_starting_vault` and `starting_mask`, not on
  `natural_mask`.
- **Two that look like M2 material are reachable and are in V1**:
  `fulgora_rock` and `fulgora_basis_oil`, both via `fulgora_sprawl_pyramids`.
  They are defined in a later `data:extend` block than their consumer, which is
  legal - the data stage resolves by name - and is exactly how a
  port-by-reading-order would miss them.

Only three nodes touch Voronoi: `cells` (manhattan), `pyramids` (manhattan, same
parameters as `cells`), `spots` (euclidean, input offset to
`ox + wobble_x / 2`, `oy + wobble_y / 2`).

`water_base(max_elevation, influence)` resolves, from
`base/prototypes/noise-expressions.lua`, to:

```
if(max_elevation >= elevation, influence * min(max_elevation - elevation, 1), -inf)
```

and `planet-map-gen.lua:340` sets `elevation = "fulgora_elevation"`.

## 6. The land / ocean classification

Dropping land tiles from an argmax is what cost Vulcanus ~3% tile agreement, so
doing it here needs an argument rather than a hope. There is one, and it is
structural.

`water_base` returns **`-inf`** whenever `elevation > max_elevation`. Above
elevation 80 no ocean tile can win at all. Below it, the shallow pair evaluates
to roughly

```
50 * oil_mask * 1000 * min(80 - elevation, 1) * |scrap_medium + dunes|
```

- order 10^4 - against land tiles that are order 1 (`1 + fulgora_dunes`,
`1 - fulgora_dunes`, `0.8 + rock*2 - max(0, mix_oil)*6`). **Ocean wins by about
four orders of magnitude wherever it is eligible**, so the land/ocean boundary is
exact even with land tiles absent. This is the opposite of the Vulcanus case,
where the dropped tiles were genuinely competitive.

Two consequences:

- `oil-ocean-shallow` and `oil-ocean-shallow-2` share `map_color {74, 42, 43}`,
  and the two deep variants share theirs. Their split is
  `max(-(scrap_medium + dunes), 0)` versus `max(+(scrap_medium + dunes), 0)`, a
  partition - exactly one is live. **The pair is a colour no-op.** Both
  probabilities are still needed for the shallow-versus-deep comparison, just not
  for the palette.
- The dominance argument thins where `|scrap_medium + dunes|` approaches 0, which
  collapses the shallow probability. That gets a **targeted fixture**, not a
  shrug.

And the argument is not trusted on its own. Per Eric's call (2026-08-04), an
oracle check samples the game's actual `get_tile` over a Fulgora region and
asserts our land/ocean binary matches **100%** - a measurement, not a proof. The
tile-probe harness already exists (`TILE_PROBE_NAME`, `buildTileMapGenSettings`
in `test/oracle/oracle.ts`).

## 7. Rendering, UI, and testing

### Render

`renderFulgoraTerrain.ts` sweeps pixels and paints three colours: deep
`{56, 36, 40}`, shallow `{74, 42, 43}`, and land flat at `{118, 68, 56}` - the
game's own `fulgoran-sand` map colour, so V1 reads as Fulgora rather than as a
placeholder, and M2 can replace it with a real argmax without the palette
jumping.

Data flow follows the Vulcanus composite path: one cached `FulgoraStack` per
render, handed to the tile resolver; every node `memoXY`-wrapped; Voronoi points
cached per grid cell across the whole sweep.

### UI

- Planet dispatch in `elevationRenderRequest.ts` and the worker. Fulgora
  currently renders "unavailable"; it begins serving `view: "terrain"`, with
  other terrain-family views falling back to terrain exactly as they already do
  when a planet lacks that overlay.
- Seed from `planetSurfaceSeed("fulgora")`.
- `control:fulgora_islands:frequency` -> `fulgora_grid`, `:size` ->
  `fulgora_natural`, threaded through ctx the way Vulcanus threads its resource
  controls. Both sliders already exist in `controlCatalog.ts`.
- Dev mode gets a grayscale `fulgora_elevation` view: nearly free, useful for
  debugging the sand-basin inversion, and the substrate the island finder will
  later read.

### Acceptance bar

In order of strength:

1. the Voronoi primitive matches its fixtures **exactly at f32** - it is exact
   arithmetic, so no `fastapprox` floor applies, unlike `basis_noise`;
2. every ported expression matches oracle samples to the f32 floor;
3. the land/ocean binary matches the game's `get_tile` at **100%** over a
   sampled region.

### Two guards that exist because their absence has bitten this repo

- **Surface-seed assertion.** Fulgora at `mapSeed + crc32("fulgora")` must render
  differently from a `mapSeed`-forced render. The oracle forces the surface seed,
  so oracle agreement cannot see this.
- **Jitter=1 stress fixture.** Fails loudly if the search range regresses to the
  pre-2.1.7 3x3 behaviour.

### CI placement

The heavy agreement spec lives in its **own file**,
`test/fulgoraAgreement.spec.ts`, not appended to `test/previewAgreement.spec.ts`.
Vitest shards by file, and `previewAgreement.spec.ts` is already 67 s of the 68 s
suite - an unsplittable floor. A new file can land on a different shard instead
of stacking onto it.

### Performance

Voronoi is probably not the cost. Per pixel it is roughly 25 distance
evaluations per node over a cached point field, while the chain's eight
multioctave fields total **~31 `basis_noise` octaves per pixel**, which is the
real budget. That places Fulgora in Vulcanus's post-`memoXY` neighbourhood
(~12 us/px, ~2 s tiled at 1024^2). **An estimate to be measured, not a promise** -
it is recorded here so a later measurement can contradict it.

## 8. Open questions to resolve during implementation

- **Is `grid_size` truncated, rounded, or always integral in practice?** The docs
  type it as a constant 16-bit unsigned integer, but
  `fulgora_grid = 175 - slider_to_linear(control:fulgora_islands:frequency, -50, 50)`
  is not obviously integral. This changes island size at non-default frequency
  and is cheap to probe, but easy never to notice. Resolve in R1.
- **Does `distance_type` affect point placement?** Section 4 assumes not.
  Resolved by R3.
- **Does the `|scrap_medium + dunes| ~ 0` thin spot ever actually flip a tile?**
  Resolved by the targeted fixture plus the `get_tile` comparison.

## 9. Risks

- **The `cell_id` hash may not fit any known family** (R2). Backstop: objdump
  `VoronoiPoints`. This is the single largest schedule risk.
- **Version skew.** `pnpm refs:sync --check` before trusting any reading; the
  2.1.7 search-range change is a live example of a fix landing inside the window
  this repo's fixtures span.
- **Perf.** If the ~31-octave estimate proves optimistic, the lever is the same
  one Vulcanus used - `memoXY` coverage and region caching - not algorithmic
  change.
