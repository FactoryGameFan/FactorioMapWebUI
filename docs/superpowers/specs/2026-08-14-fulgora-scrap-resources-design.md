# Fulgora scrap: the probability port and the rolled overlay

Design record, 2026-08-14. Point-in-time, not a living document.

Issue: [#27 - Fulgora & large island finder](https://github.com/wormeyman/FactorioMapWebUI/issues/27).

## 1. Scope, and why scrap goes first

Fulgora V1 and V2 are merged and deployed. The roadmap defers three things for
this planet: scrap resources, cliffs, and the island finder. They are three
separate projects, and the order is not free:

- **Scrap must come before cliffs.** The scrap Lua carries the game's own
  comment, "Resources prevent cliffs from spawning", and this repo has already
  ported that rejection (`src/noise/cliffs/vulcanusOreRejection.ts`). A Fulgora
  cliff overlay built before scrap exists would over-place cliffs wherever
  scrap sits.
- **The island finder shares almost nothing with either.** It is connected
  component analysis over an elevation field plus UI, with no noise reverse
  engineering, and it would run today against the Nauvis island map type. The
  V1 spec already says it gets its own spec.

This spec covers **scrap only**.

### Non-goals

Each is a later spec, or deliberately dropped:

- **`richness_expression`.** Nothing in the app renders richness for any
  planet, so porting it now would be dead code.
- **The `control:scrap:*` sliders.** Measured, not assumed: the size lever
  moves the footprint from 2.10% to 2.80% of tiles across its full range, 0.5
  to 2, and the mean probability from 0.00728 to 0.00805. The game's own Lua
  comments the frequency term as "limited application". That is a lot of UI
  wiring for a change most users would not see. The renderer still reads the
  levers, so adding the sliders later is wiring only.
- Fulgora cliffs, and the island finder.

## 2. What was measured before this spec was written

This section exists because it changed the design twice. Everything below is a
measurement, not a plan to measure.

### 2.1 Every field scrap reads was already ported and oracle covered

The V1 and V2 work left nothing missing. Checked name by name against the
2.1.14 Lua:

| the expression reads | ported in | oracle fixture |
| --- | --- | --- |
| `fulgora_starting_mask` | `fulgoraShared.ts` | `oracle-fulgora-shared` |
| `fulgora_structure_cells` | `fulgoraRoads.ts` | `oracle-fulgora-ruins` |
| `fulgora_structure_subnoise` | `fulgoraRoads.ts` | `oracle-fulgora-ruins` |
| `fulgora_spots_prebanding` | `fulgoraRoads.ts` | `oracle-fulgora-ruins` |
| `fulgora_road_paving_2c` | `fulgoraRoads.ts` | `oracle-fulgora-ruins` |
| `fulgora_artificial_mask` | `fulgoraMasks.ts` | `oracle-fulgora-ruins` |
| `fulgora_elevation` | `fulgoraElevation.ts` | `oracle-fulgora-elevation` |
| `fulgora_vaults_and_starting_vault` | `fulgoraCells.ts` | `oracle-fulgora-cells` |

`fulgora_coastline` is the constant 80, already in `fulgoraElevation.ts`.
`slider_to_linear` is in `src/noise/eval/math.ts`.

So **no new noise expression is needed**. The one untested link was the
composition itself, which section 2.2 settles.

### 2.2 The composed probability is exact

The game was asked to evaluate the whole `probability_expression`, with its
`local_expressions` inlined, at 80 positions chosen to span the probability
range from zero to the cap. Against the same composition over the ported
fields:

- worst relative error **1.1e-3**,
- **79 of 80** positions within 1e-4,
- sums agreeing to **1.0000**.

The single outlier is a probability of 1.6e-5, where f32 relative error is
expected to be larger. The game also reported `control:scrap:frequency`,
`:size` and `:richness` as 1 on a default surface, which is what the
composition assumes.

### 2.3 The per-tile Bernoulli placement is right

`find_entities_filtered{type = "resource"}` over three 256x256 boxes on a real
generated Fulgora surface, against the model's clamped expectation on the same
boxes in the same world:

| box | model expectation | game entities | ratio |
| --- | --- | --- | --- |
| `[-512, -512]` | 136.0 | 138 | 0.986 |
| `[-256, 0]` | 114.9 | 122 | 0.942 |
| `[0, -256]` | 506.5 | 510 | 0.993 |
| `[256, 256]` | 0.0 | 0 | - |
| **total** | **757.4** | **770** | **0.9836** |

0.9836 sits inside Poisson noise at n = 770, where one sigma is 3.6%. The
fourth box is a true negative in both directions, so the model does not invent
scrap where the game has none.

### 2.4 The game's map preview draws about one pixel per TWO entities

This is the finding that changed the validation plan. Over the same boxes, the
preview's scrap layer holds **385 changed pixels against 770 entities -
0.5000 per entity**, and per box 0.457, 0.508, 0.510.

It is not a half-resolution layer. That was tested and refuted: parity across
`(px % 2, py % 2)` is flat at 24.1% to 25.9%, and only 44.1% of changed pixels
have a horizontal 2x2 mate, where a halved layer would be near 100%. The
changed pixels carry **50 distinct grey levels** across 1825 pixels, so the
resource layer is blended rather than stamped, and a faint enough blend rounds
to the terrain colour and produces no change at all.

**The exact blend rule was not decoded**, and this spec does not assert one.
What it asserts is the consequence: the preview PNG cannot gate scrap density.

### 2.5 What the preview CAN gate

Against the same PNGs:

- **The map colour.** The dominant changed value is `rgb(229, 229, 229)`, which
  is `map_color = {0.9, 0.9, 0.9}` from the prototype times 255. 1098 of 1825
  changed pixels are exactly that.
- **Position.** **99.95%** of the game's scrap pixels fall inside the model's
  footprint (1824 of 1825), and 100% of the 727 shaded ones. Alignment is exact
  at zero offset; a one-tile shift drops to 87.4%, and a wrong-world control
  drops to 0.9%, so the check discriminates rather than passing on anything.

### 2.6 The seed convention differs between the two oracles, and it bites

`sampleExpression` and the entity harness both **force** the Fulgora surface
seed to the seed passed in, which is why every existing Fulgora fixture reads
`seed0: 123456` raw. `--generate-map-preview` does not: it takes a **map** seed,
so at 123456 the Fulgora surface seed is `123456 + crc32("fulgora")` =
**2967702466**.

Getting this wrong is not subtle in its cause and is very subtle in its
symptom. The first overlap run used the raw seed against the preview and scored
0.5%, which reads exactly like a broken port. With the derived seed it is 99.9%.
Any test comparing against a preview PNG must derive the surface seed;
any test comparing against a `sampleExpression` or entity fixture must not.

## 3. The expression

From `space-age/prototypes/planet/planet-fulgora-map-gen.lua` at 2.1.14, with
`local_expressions` inlined:

```
probability =
  (control:scrap:size > 0)
  * (1 - fulgora_starting_mask)
  * ( min( (fulgora_structure_cells < min(0.1 * f, 0.05 + 0.05 * f))
             * (1 + fulgora_structure_subnoise)
             * (fulgora_elevation > (fulgora_coastline + 10))
             * fulgora_artificial_mask
           + (fulgora_spots_prebanding < (1.2 + 0.4 * slider_to_linear(s, -1, 1)))
             * fulgora_vaults_and_starting_vault * 10,
           0.5 )
      * (1 - fulgora_road_paving_2c) )
```

with `f = control:scrap:frequency` and `s = control:scrap:size`.

Three properties of it drive the rest of this design.

**It is capped at 0.5 and never saturates.** The `min(..., 0.5)` is on the
whole inner term. Nauvis and Vulcanus solid ores saturate to about 1 and are
therefore drawn as solid patches; scrap cannot be, which is why section 5
rolls rather than thresholds.

**It can go negative.** Measured over the 1024x1024 preview window: 1002
positions with a negative probability, **all** of them from
`fulgora_structure_subnoise < -1`, none from `road_paving_2c > 1` or
`starting_mask > 1`, and none above 1. The port must clamp to `[0, 1]` before
rolling. Summing the raw values instead understates the expectation by about
6%, which is a mistake this spec made once already.

**It excludes water on its own.** The `fulgora_elevation > fulgora_coastline +
10` term put the expected scrap on ocean at exactly 0.00 over 262,144 tiles.
No tile test is needed. That ships as an assertion, not as a silent absence.

## 4. Components

| file | what |
| --- | --- |
| `src/noise/expressions/fulgoraScrap.ts` | `makeFulgoraScrap(shared, cells, chain, masks, roads, ctx)` returning `{ probability }`, clamped to `[0, 1]`. Takes the built layer stack so `memoXY` caches are shared. |
| `src/noise/resources/fulgoraResourceCatalog.ts` | One entry: `name: "scrap"`, `mapColor: [229, 229, 229]`, `placement: "roll"`, and the `control:scrap:*` levers. Mirrors `vulcanusResourceCatalog.ts`. |
| `src/noise/preview/renderFulgoraResources.ts` | Composites onto a terrain `ImageData`. Mirrors `renderVulcanusResources.ts`. |
| `src/noise/preview/elevationRenderRequest.ts` | The Fulgora branch gains `view === "resources" \|\| view === "all"`. Its comment loses "not resources". |
| `src/noise/preview/renderFulgoraTerrain.ts` | Gains an optional shared stack, as `renderVulcanusTerrain` already has. |

The `view` union already contains `"resources"`, so no new types.

### 4.1 One targeted improvement: a shared `FulgoraStack`

`makeFulgoraTileResolver` builds its own layer stack today, and
`makeFulgoraLandProbabilities` builds a second one. A scrap pass would build a
third. `memoXY` is single-entry, so private copies share nothing and pay for
the whole field DAG again.

Vulcanus already solved this with `VulcanusStack`, and `renderVulcanusResources`
takes one. Fulgora gets the same: a `FulgoraStack` holding `ctx`, `shared`,
`cells`, `chain`, `masks`, `roads`, `ruins` and `scrap`, built once and passed
to both the terrain and the scrap pass. This is a prerequisite for the
`"all"` view costing roughly terrain plus a little, rather than twice terrain.

## 5. Placement

`makePlacementSet` from `src/noise/placement/placementRoll.ts`, with a new
`PLACEMENT_SALT.fulgoraScrap`, exactly as the Vulcanus geyser does.

Three decisions, each with its reason:

- **1x1 marks, not the 3x3 `PLACEMENT_MARK_RADIUS_PX` mark.** Scrap reaches the
  0.5 cap over contiguous pockets, so a 3x3 mark would merge those into a blob.
  This is the same reasoning Nauvis rocks already use. The geyser gets 3x3
  because it is about one entity per 3000 tiles and a single pixel disappears;
  scrap is about one per 36 to 83 land tiles.
- **No `tileAllowed` gate**, per section 3.
- **The collision box cannot reject anything, and is passed anyway.** Read off
  the running game rather than from the Lua: scrap's half-extent is
  **0.09765625**, not the 0.1 declared, because the game snaps it to the 1/256
  grid; its collision layers are `["resource"]`. Against the geyser's 1.398
  half-extent, this cannot make two adjacent tiles conflict. Passing the real
  box and asserting it rejects zero is better than omitting it and leaving a
  reader to wonder whether it was forgotten.

**The salt is arbitrary.** As with the geyser, a different salt is a real move
in the exact count, so the density test asserts a band, not a point. At
n = 770 one Poisson sigma is 3.6%.

## 6. Fixtures

| fixture | size | what |
| --- | --- | --- |
| `oracle-preview-fulgora-terrain.seed123456.png` | ~341 KB | Preview with `scrap` and `fulgora_cliff` forced to `size: 0`. |
| `oracle-preview-fulgora-scrap.seed123456.png` | ~350 KB | Same, with `scrap` on. The pixel difference is the scrap layer. |
| `oracle-fulgora-scrap.seed123456.json` | small | The probability field at sampled positions spanning zero to the cap. |
| `oracle-fulgora-scrap-entities.seed123456.json` | small | Every scrap entity the game placed in each sampled region, from `find_entities_filtered`. Kept separate from the row fixture because it is a different kind of ground truth, the way Vulcanus splits `oracle-vulcanus-resource-entities` from its expression fixtures. |

Both PNGs are already captured. 692 KB against a 32 MB fixtures directory.

`scrap` is `can_be_disabled: true` in the game's own
`autoplace-can-be-disabled.dump.json`, and `fulgora_cliff` likewise, so the
isolation is the game's own mechanism rather than a trick.
`previewCompare.ts` already takes a planet and a disabled list; it needs a
Fulgora arm added to its CLI branch, which currently only special-cases
`vulcanus`.

Every fixture needs a `PROVENANCE.json` entry recording `factorioVersion:
"2.1.14"` and the evidence. `test/fixtureProvenance.spec.ts` fails without one.

## 7. Tests

| test | asserts |
| --- | --- |
| `test/fulgoraScrap.spec.ts` | Bound-checked oracle rows for the probability field. Bounds sized from the measured 1.1e-3, not widened to fit. |
| `test/fulgoraScrap.spec.ts` | Density: rolled placements against the game's entity counts per region, as a band around 1.0. |
| `test/fulgoraScrap.spec.ts` | The ocean invariant: expected scrap on any non-land tile is exactly 0. |
| `test/fulgoraScrap.spec.ts` | The clamp: no position yields a probability outside `[0, 1]`. |
| `test/previewAgreement.spec.ts` | Fulgora terrain against the scrap-off PNG. Nothing covers this today. |
| `test/previewAgreement.spec.ts` | Every scrap pixel the game drew lies inside our painted region, and the painted colour is `rgb(229, 229, 229)`. A **superset** assertion, never equality - see section 2.4. |
| `test/tiledEquality.spec.ts` | The Fulgora resources view is byte-identical tiled and untiled. |

House practice applies: plant a plausible failure and watch the right test
fail, before believing any of these is a guard. The 99.95% figure in section
2.5 means **one** pixel of 1825 is outside the footprint. That one gets
explained rather than rounded away.

## 8. Risks

- **`previewAgreement.spec.ts` is the suite's slowest file**, 72.9s of 503s
  total per-file wall. Two more 1024x1024 comparisons add to it and to CI
  shard balance. The shard count is 4 and the binding constraint is balance,
  not count.
- **The superset assertion is weaker than equality**, and deliberately so. It
  cannot catch our overlay painting too much. The entity-count test is what
  bounds that, so the two are not redundant and neither can be dropped.
- **The preview blend rule is undecoded.** If a future Factorio version changes
  it, the superset assertion still holds but the 0.5 ratio recorded here stops
  being true. Nothing in the test suite depends on the 0.5, by design.

## 9. What is NOT established

- The rule the game's map preview uses to blend a resource's `map_color`, and
  therefore why about half of scrap entities leave no pixel change. Measured
  that it is not a half-resolution layer and that it produces 50 grey levels;
  the rule itself was not decoded.
- Whether `fulgora_structure_subnoise` dropping below -1 is intended by the
  game's authors or incidental. It is faithfully reproduced either way, and the
  clamp is what the game's own placement does with a negative probability.
- Whether scrap interacts with the placement order of any other Fulgora
  autoplacer. The autoplace `order` is `"b"`, and nothing here models
  cross-overlay occupancy. The 0.9836 agreement was reached with it left out.
