# Fulgora V2: Land Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Fulgora's eight land tiles against each other, so the preview paints real dunes, sand, rock, dust, paving, walls, conduit and machinery instead of one flat sand colour.

**Architecture:** V1 stopped at the land/ocean split because an ocean tile's probability is four orders of magnitude larger than any land tile's, so the land tiles only ever compete with each other. This plan ports the layer that decides that competition: three masks, a road and structure Voronoi layer, and a ruins layer, then widens the tile catalog's argmax from 3 outcomes to 10. The three land tiles that need no new expressions land first, so the preview improves in the first PR.

**Tech Stack:** TypeScript, Vite+ (`pnpm vp`), Vitest-compatible specs, Factorio 2.1.14 headless as the oracle.

**Spec:** None. Eric chose "plan only, no spec" on 2026-08-13; the expressions are fully specified in `~/GitHub/factorio-data/space-age/prototypes/planet/planet-fulgora-map-gen.lua` and V1 already fixed the file layout, the oracle harness and the acceptance method. The V1 design record is `docs/superpowers/specs/2026-08-04-fulgora-elevation-preview-design.md` and the measured findings are `docs/noise/fulgora-elevation-NOTES.md`; read both before starting.

## Global Constraints

- **Factorio version is 2.1.14.** Run `pnpm refs:sync --check` before trusting any reading from `~/GitHub/factorio-data`. **"in sync" is not enough - read the version it PRINTS**, because it pins to whatever the Steam binary currently is.
- **Fulgora's surface seed is `(mapSeed + crc32("fulgora")) >>> 0`.** Never pass a raw map seed to a Fulgora field. The oracle fixtures use `seed0` RAW because the harness sets `mgs.seed` on the created surface.
- **Every field-DAG node is wrapped in `memoXY`** from `src/noise/eval/memoXY.ts`.
- **Acceptance is f32.** Compare with `Math.fround`. Per-field bounds are set from the measured worst residual with modest headroom, never a blanket tolerance.
- **Never guess a `seed1`.** Compute it with `crc32` from `src/codec/crc32.ts`. The five this plan needs are computed in Task 3 and Task 4 and written out there; a wrong one produces a plausible map that no residual check would flag.
- **Never edit a fixture or an expected value to make a test pass.** A mismatch is a real finding.
- **Every new fixture needs a `test/fixtures/PROVENANCE.json` entry** (version `2.1.14`, evidence `stated`) or `test/fixtureProvenance.spec.ts` fails. Insert it in place; do not re-sort the file. `FACTORIO_TARGET_VERSION` is already 2.1.14, so no target bump is needed.
- **Use hyphens (`-`), never em or en dashes,** in every file this plan creates.
- Run commands through pnpm: `pnpm vp test`, `pnpm vp check --fix`, `pnpm run verify`. `npx vp` fails with `EBADDEVENGINES`.
- Oracle specs are gated `it.skipIf(!oracleAvailable())` so CI stays green with no Factorio installed.
- **Branch off `main`; never commit to `main`.** It is protected by ruleset `EJ` with no bypass actors. Open a PR per task and let the 7 checks run.

---

## File Structure

**Created:**

| path | responsibility |
| --- | --- |
| `src/noise/expressions/fulgoraMasks.ts` | `natural_mask`, `natural_and_mesa_mask`, `artificial_mask` |
| `src/noise/expressions/fulgoraRoads.ts` | the road and structure Voronoi layer, the banding fields, and the four paving stages |
| `src/noise/expressions/fulgoraRuins.ts` | `ruins_walls`, `ruins_paving` and the four `tile_ruin_*` expressions |
| `test/fulgoraLandTiles.spec.ts` | fixture-driven land argmax agreement, its own file for shard balance |
| `test/fixtures/oracle-fulgora-ruins.seed123456.json` | the 22 new expressions at the existing 101 capture positions |

**Modified:**

| path | change |
| --- | --- |
| `src/noise/tiles/fulgoraCatalog.ts` | widen the argmax from land/shallow/deep to the full tile union |
| `src/noise/preview/renderFulgoraTerrain.ts` | 8 more map colours, taken from the Lua |
| `test/fulgoraExpressions.spec.ts` | assert the masks, roads and ruins against the new fixture |
| `test/fulgoraAgreement.spec.ts` | map the widened resolver back down to land/shallow/deep |
| `test/oracle/capture.ts` | a `fulgora-ruins` capture entry |
| `test/fixtures/PROVENANCE.json` | one entry for the new fixture |
| `test/render-cost.perf.spec.ts` | the new Fulgora terrain cost |
| `docs/noise/fulgora-elevation-NOTES.md` | measured findings for V2 |
| `docs/noise/client-preview-ROADMAP.md` | mark Fulgora V2, shrink the deferred list |

**Not ported, deliberately:** `fulgora_sprawl_mask` and `fulgora_decorative_machine_density`. Neither feeds a tile probability. `sprawl_mask` sits in the middle of the same Lua block as the three masks that are ported, which makes it look like part of the layer; nothing in the tile argmax reads it.

---

## Task 1: The three land tiles that need no new expressions

`fulgoran-dunes`, `fulgoran-sand` and `fulgoran-rock` read only `fulgora_dunes`, `fulgora_rock` and `fulgora_mix_oil`, all of which V1 already ports. They are 828 of the 2261 land positions in the fixture (36.6%).

The subset argument that makes this testable: if a tile wins the game's argmax over all eight land tiles, it also wins over any subset that contains it. So at the 828 positions where the game placed one of these three, a correct three-way argmax must pick the same one, and that stays true after Task 5 widens the field.

**Files:**
- Modify: `src/noise/tiles/fulgoraCatalog.ts`
- Modify: `src/noise/preview/renderFulgoraTerrain.ts`
- Modify: `test/fulgoraAgreement.spec.ts:63-91`
- Test: `test/fulgoraLandTiles.spec.ts` (create)

**Interfaces:**
- Consumes: `FulgoraElevation.dunes`, `.rock`, `.mixOil` from `src/noise/expressions/fulgoraElevation.ts`.
- Produces: `export type FulgoraTile`, `export function makeFulgoraTileResolver(ctx: FulgoraCtx): (x: number, y: number) => FulgoraTile`. Task 5 widens the union; nothing else changes signature.

- [ ] **Step 1: Write the failing test**

Create `test/fulgoraLandTiles.spec.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import tilesFixture from "./fixtures/oracle-fulgora-tiles.seed123456.json";
import { makeFulgoraTileResolver } from "../src/noise/tiles/fulgoraCatalog";

/**
 * Does the port pick the same LAND tile the game placed?
 *
 * `fulgoraAgreement.spec.ts` asks the land-versus-ocean question and is where
 * the 18-mismatch boundary residual is documented. This file asks the different
 * question of which land tile wins, so a regression in one cannot be read as
 * the other. Separate file for the same reason that one is separate: the CI
 * shard wall is set by which shard picks up the heavy files.
 *
 * ## Why this task can assert on a SUBSET
 *
 * Only three of the eight land tiles are modelled here. An argmax over a subset
 * agrees with the full argmax wherever the full winner is in the subset - if a
 * tile beats all eight it beats any three that include it. So the assertion is
 * scoped to the positions where the game placed one of the three, and it stays
 * valid unchanged once the other five land.
 */
const SUBSET = new Set(["fulgoran-dunes", "fulgoran-sand", "fulgoran-rock"]);

describe("fulgora land argmax over the three natural tiles", () => {
  const resolve = makeFulgoraTileResolver({ seed0: tilesFixture.seed0 });
  const positions = tilesFixture.positions as { x: number; y: number }[];
  const names = tilesFixture.tileNames;

  const scoped = positions
    .map((p, i) => ({ ...p, game: names[i] as string }))
    .filter((p) => SUBSET.has(p.game));

  it("covers 828 positions, so the assertion below is not vacuous", () => {
    expect(scoped.length).toBe(828);
  });

  it("picks the game's tile at every one of them", () => {
    const wrong = scoped
      .map((p) => ({ ...p, ours: resolve(p.x, p.y) }))
      .filter((p) => p.ours !== p.game);
    expect(wrong.length, `first few: ${JSON.stringify(wrong.slice(0, 5))}`).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vp test test/fulgoraLandTiles.spec.ts`
Expected: FAIL - `makeFulgoraTileResolver` is not exported yet.

- [ ] **Step 3: Widen the catalog**

In `src/noise/tiles/fulgoraCatalog.ts`, replace the `FulgoraSurface` type and rename the resolver. Keep `waterBase`, `bestProbability`, `COASTLINE` and `DEEP_LEVEL` exactly as they are - they are the validated ocean core and nothing here touches them.

```ts
/**
 * What the preview needs to colour a Fulgora tile.
 *
 * The two shallow variants share a map colour and so do the two deep ones, so
 * the ocean side collapses to two members rather than four - see the header
 * comment on the ocean argmax. The land side names real tiles, because they do
 * NOT share colours.
 *
 * Only three land tiles are reachable until the road and ruins layer lands.
 */
export type FulgoraTile = "fulgoran-dunes" | "fulgoran-sand" | "fulgoran-rock" | "shallow" | "deep";

export function makeFulgoraTileResolver(
  ctx: FulgoraCtx,
): (x: number, y: number) => FulgoraTile {
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);

  return (x: number, y: number): FulgoraTile => {
    const e = chain.elevation(x, y);
    const mask = chain.oilMask(x, y);
    const s = chain.scrapMedium(x, y) + chain.dunes(x, y);

    const shallowBase = 50 * mask * waterBase(COASTLINE, 1000, e);
    const shallow = shallowBase * Math.max(-s, 0);
    const shallow2 = shallowBase * Math.max(s, 0);

    const deepBase = 100 * mask * waterBase(DEEP_LEVEL, 2000, e);
    const deep2Scale =
      -Math.min(0, e - 60) / 100 + Math.max(0, chain.dunes(x, y) - Math.max(0, e / 100));
    const deep2 = deep2Scale * deepBase;

    const bestShallow = bestProbability(shallow, shallow2);
    const bestDeep = bestProbability(deepBase, deep2);
    const bestOcean = bestProbability(bestShallow, bestDeep);

    // The ocean early-out is what keeps the ocean question as cheap as it was
    // in V1: 55% of sampled positions never touch the land layer at all.
    if (bestOcean > 0) return bestDeep > bestShallow ? "deep" : "shallow";

    // `fulgoran-sand` is `1 - fulgora_dunes`, and `fulgora_dunes` is
    // `0.66 - abs(n)`, so sand is `0.34 + abs(n)` - never below 0.34. Some land
    // tile is therefore always placeable and there is no fallback to model.
    const dunesField = chain.dunes(x, y);
    const dunes = 1 + dunesField;
    const sand = 1 - dunesField;
    const rock = 0.8 + chain.rock(x, y) * 2 - Math.max(0, chain.mixOil(x, y)) * 6;

    if (rock > dunes && rock > sand) return "fulgoran-rock";
    return dunes > sand ? "fulgoran-dunes" : "fulgoran-sand";
  };
}
```

- [ ] **Step 4: Repoint the renderer**

In `src/noise/preview/renderFulgoraTerrain.ts`, swap the import and the palette. The colours are the `map_color` triples from `space-age/prototypes/tile/tiles-fulgora.lua`, not picked by eye.

```ts
import { type FulgoraTile, makeFulgoraTileResolver } from "../tiles/fulgoraCatalog";

const COLORS: Record<FulgoraTile, readonly [number, number, number]> = {
  "fulgoran-dunes": [125, 71, 59],
  "fulgoran-sand": [118, 68, 56],
  "fulgoran-rock": [131, 85, 66],
  shallow: [74, 42, 43],
  deep: [Math.round(49 * 1.15), Math.round(31 * 1.15), Math.round(35 * 1.15)],
};
```

Then change `makeFulgoraSurfaceResolver` to `makeFulgoraTileResolver` at line 62.

- [ ] **Step 5: Keep the land/ocean spec asserting exactly what it asserted before**

In `test/fulgoraAgreement.spec.ts`, the resolver now returns land tile names where it used to return `"land"`. Collapse them back so the 18-mismatch reasoning in that file stays about the same question. Replace the `gameClass` helper and the `disagreements` signature:

```ts
type Surface = "land" | "shallow" | "deep";

/** The class the game's tile name implies. The `-2` variants share a map colour. */
function gameClass(name: string): Surface {
  if (name.startsWith("oil-ocean-deep")) return "deep";
  if (OCEAN_TILES.has(name)) return "shallow";
  return "land";
}

/** The class OUR tile name implies. Every non-ocean member is land. */
function ourClass(tile: FulgoraTile): Surface {
  return tile === "shallow" || tile === "deep" ? tile : "land";
}
```

Update the import to `type FulgoraTile, makeFulgoraTileResolver`, build the resolver with `makeFulgoraTileResolver`, and wrap each `resolve(...)` result in `ourClass(...)` - there are three call sites (lines 80, 122 and the base-rate loop). The `same` comparators keep their `Surface` types.

- [ ] **Step 6: Run both specs**

Run: `pnpm vp test test/fulgoraLandTiles.spec.ts test/fulgoraAgreement.spec.ts`
Expected: PASS, with `fulgoraAgreement` still reporting exactly 7 and 11 mismatches. **If those two numbers move, stop** - this task cannot change the land/ocean decision, so a move means the ocean path was disturbed.

- [ ] **Step 7: Static checks and commit**

```bash
pnpm vp check --fix && pnpm run check:vue
git add -A && git commit -m "feat(fulgora): resolve dunes, sand and rock in the land argmax (#27)"
```

---

## Task 2: Capture the 22 new expressions from the game, and port the masks

One capture run produces the ground truth for Tasks 2, 3 and 4 at once, at the same 101 positions the shared, cells and elevation fixtures use, so all four line up index for index.

**Files:**
- Modify: `test/oracle/capture.ts` (add `captureFulgoraRuins`, register it near line 3720)
- Create: `test/fixtures/oracle-fulgora-ruins.seed123456.json` (generated)
- Modify: `test/fixtures/PROVENANCE.json`
- Create: `src/noise/expressions/fulgoraMasks.ts`
- Test: `test/fulgoraExpressions.spec.ts`

**Interfaces:**
- Consumes: `FulgoraShared.startingMask`, `FulgoraCells.mesa` / `.vaultsAndStartingVault`, `FulgoraElevation.natural` / `.mixPyramids` / `.oilMask`.
- Produces: `export interface FulgoraMasks { naturalMask; naturalAndMesaMask; artificialMask }`, each `(x: number, y: number) => number`, and `export function makeFulgoraMasks(shared: FulgoraShared, cells: FulgoraCells, chain: FulgoraElevation): FulgoraMasks`.

- [ ] **Step 1: Add the capture entry**

In `test/oracle/capture.ts`, after `captureFulgoraElevation`, add:

```ts
/**
 * Fulgora's road, structure and ruins layer - everything the eight land tiles
 * read that the elevation chain does not.
 *
 * Positions are `fulgoraCapturePositions()`, identical to the shared, cells and
 * elevation fixtures, so all four line up index for index.
 *
 * Two fields here are captured because the port cannot settle them by reading:
 * `fulgora_pyramids_banding` and `fulgora_spots_banding` are the noise
 * machine's `%` operator, whose behaviour on a negative left operand is not
 * stated anywhere in the docs. The fixture decides it.
 */
async function captureFulgoraRuins(): Promise<void> {
  const seed = 123456;
  const planet = "fulgora";
  const positions = fulgoraCapturePositions();
  const sample = (expression: string) => sampleFulgora(expression, positions, seed);

  const NAMES = [
    // The masks.
    "fulgora_natural_mask",
    "fulgora_natural_and_mesa_mask",
    "fulgora_artificial_mask",
    // The road and structure layer, in dependency order.
    "fulgora_road_cells",
    "fulgora_road_pyramids",
    "fulgora_pyramids_banding",
    "fulgora_spots_prebanding",
    "fulgora_spots_banding",
    "fulgora_structure_cells",
    "fulgora_structure_subnoise",
    "fulgora_structure_facets",
    "fulgora_road_paving_thin",
    "fulgora_road_paving_2",
    "fulgora_road_paving_2b",
    "fulgora_road_paving_2c",
    "fulgora_road_dust",
    // The ruins layer.
    "fulgora_ruins_walls",
    "fulgora_ruins_paving",
    "fulgora_tile_ruin_paving",
    "fulgora_tile_ruin_walls",
    "fulgora_tile_ruin_conduit",
    "fulgora_tile_ruin_machinery",
  ] as const;

  const fields: Record<string, number[]> = {};
  for (const name of NAMES) {
    fields[name] = await sample(name);
    console.log(`  captured ${name}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 (Space Age enabled) via the test/oracle harness: " +
      "Fulgora's mask, road/structure and ruins layer - the 22 named expressions the eight " +
      "land tiles read that the elevation chain does not. Positions are IDENTICAL to " +
      "oracle-fulgora-shared/cells/elevation.seed123456.json, so all four line up " +
      "index-for-index. The intermediate paving stages (2, 2b, 2c) are captured as well as " +
      "the four tile_ruin outputs so a transcription error localises instead of surfacing " +
      "blended. Regenerate: node --experimental-strip-types test/oracle/capture.ts fulgora-ruins",
    seed0: seed,
    planet,
    positions,
    ...fields,
  };
  const out = join(FIXTURES, "oracle-fulgora-ruins.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(positions.length)} positions)`);
}
```

Register it beside the others: `if (want("fulgora-ruins")) await captureFulgoraRuins();`

- [ ] **Step 2: Run the capture**

Run: `pnpm refs:sync --check` first and read the version it prints. Then:

```bash
node --experimental-strip-types test/oracle/capture.ts fulgora-ruins
```

Expected: 22 `captured ...` lines and a fixture of 101 positions. If any expression name is rejected by the game, that is a finding about the name, not a reason to drop the field.

- [ ] **Step 3: Add the provenance entry**

In `test/fixtures/PROVENANCE.json`, insert in place inside the top-level **`fixtures`** object, beside the other four Fulgora entries. Do not re-sort the file.

The schema is exactly two keys - `factorioVersion` (a semver string, or the literal `unknown`) and `evidence` (non-empty prose, **not** an enum). `test/fixtureProvenance.spec.ts:55-60` is what enforces that. An entry with a third key, or with `evidence` set to a single word like `"stated"`, is wrong: the word grades confidence in the surrounding sentence, it is not the value.

```json
"oracle-fulgora-ruins.seed123456.json": {
  "factorioVersion": "2.1.14",
  "evidence": "captured <YYYY-MM-DD> via test/oracle/capture.ts fulgora-ruins against a real Fulgora surface (game.planets['fulgora'].create_surface()) on the installed 2.1.14 binary, which pnpm refs:sync --check reported in sync at capture time. Positions are identical to oracle-fulgora-shared/cells/elevation.seed123456.json, so all four line up index-for-index. 22 named expressions: the three masks, the road and structure layer including its intermediate paving stages, and the ruins layer with its four tile_ruin outputs."
}
```

Fill in the real capture date. Read the `oracle-fulgora-shared.seed123456.json` entry first and match its level of detail - these strings explain what a later reader would otherwise have to re-derive.

- [ ] **Step 4: Write the failing mask test**

Append to `test/fulgoraExpressions.spec.ts`:

```ts
describe("makeFulgoraMasks", () => {
  const ctx = { seed0: ruinsFixture.seed0 };
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);
  const masks = makeFulgoraMasks(shared, cells, chain);

  /**
   * The three masks are built from comparisons and `max`/`min`, so every value
   * is exactly 0 or 1 and the bound is 0 - not a tolerance, an identity. A
   * non-integer here means a comparison was ported as arithmetic.
   */
  it("matches the game exactly on all three masks", () => {
    checkRuins(masks.naturalMask, ruinsFixture.fulgora_natural_mask, 0);
    checkRuins(masks.naturalAndMesaMask, ruinsFixture.fulgora_natural_and_mesa_mask, 0);
    checkRuins(masks.artificialMask, ruinsFixture.fulgora_artificial_mask, 0);
  });

  it("the masks are not all one value, so the test above discriminates", () => {
    const distinct = (v: number[]) => new Set(v).size;
    expect(distinct(ruinsFixture.fulgora_natural_mask)).toBe(2);
    expect(distinct(ruinsFixture.fulgora_artificial_mask)).toBe(2);
  });
});
```

Add the fixture import and a `checkRuins` helper modelled on the existing `check` in that file (same f32 comparison, same "name the worst position" failure message, positions from `ruinsFixture.positions`).

**Define `checkRuins` at MODULE scope, not inside a `describe`.** The existing `check` lives inside `describe("makeFulgoraShared")` and is not reachable from anywhere else; Tasks 3 and 4 both need `checkRuins`, so scoping it the same way would force two more copies. Signature:

```ts
const checkRuins = (
  fn: (x: number, y: number) => number,
  want: number[],
  bound: number,
): void => { /* same body shape as `check` */ };
```

- [ ] **Step 5: Run it and watch it fail**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: FAIL - `makeFulgoraMasks` does not exist.

- [ ] **Step 6: Write `fulgoraMasks.ts`**

```ts
/**
 * The three masks that divide Fulgora's land into natural and artificial.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 250-292. They are defined in the middle of the elevation block, which
 * makes them look like part of the mix chain; nothing in that chain reads them,
 * which is why V1 left them out and why they live here instead.
 *
 * `fulgora_sprawl_mask` sits in the same run of definitions and is NOT ported -
 * no tile probability reads it.
 */
import { memoXY } from "../eval/memoXY";
import type { FulgoraCells } from "./fulgoraCells";
import type { FulgoraElevation } from "./fulgoraElevation";
import type { FulgoraShared } from "./fulgoraShared";

export interface FulgoraMasks {
  /** `max(min(natural > mix_pyramids, 1 - vaults_and_starting_vault), starting_mask)`. */
  readonly naturalMask: (x: number, y: number) => number;
  /** `max(natural_mask, mesa)` - the mask the two natural-side ruin terms use. */
  readonly naturalAndMesaMask: (x: number, y: number) => number;
  /** `1 - max(oil_mask, natural_and_mesa_mask)` - not oil, not natural. */
  readonly artificialMask: (x: number, y: number) => number;
}

export function makeFulgoraMasks(
  shared: FulgoraShared,
  cells: FulgoraCells,
  chain: FulgoraElevation,
): FulgoraMasks {
  const naturalMask = memoXY((x: number, y: number) =>
    Math.max(
      Math.min(
        chain.natural(x, y) > chain.mixPyramids(x, y) ? 1 : 0,
        1 - cells.vaultsAndStartingVault(x, y),
      ),
      shared.startingMask(x, y),
    ),
  );
  const naturalAndMesaMask = memoXY((x: number, y: number) =>
    Math.max(naturalMask(x, y), cells.mesa(x, y)),
  );
  const artificialMask = memoXY(
    (x: number, y: number) => 1 - Math.max(chain.oilMask(x, y), naturalAndMesaMask(x, y)),
  );

  return { naturalMask, naturalAndMesaMask, artificialMask };
}
```

- [ ] **Step 7: Run it and watch it pass**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: PASS at bound 0.

- [ ] **Step 8: Commit**

```bash
pnpm vp check --fix && pnpm run check:vue
git add -A
git commit -m "feat(noise): capture the fulgora ruins layer and port the three masks (#27)"
```

---

## Task 3: The road and structure layer

Thirteen expressions plus two constants. All four Voronoi call sites are already supported by `src/noise/voronoiNoise.ts` - its own header table at lines 368-376 lists `fulgora_road_cells` (cell_id, chebyshev, jitter 1, range 1), `fulgora_road_pyramids` (pyramid, same field), `fulgora_structure_cells` (cell_id, minkowski3, jitter 0.8, range 2) and `fulgora_structure_facets` (facet, same field). Nothing in the primitive needs changing.

**Files:**
- Create: `src/noise/expressions/fulgoraRoads.ts`
- Test: `test/fulgoraExpressions.spec.ts`

**Interfaces:**
- Consumes: `FulgoraShared.grid` / `.startingVaultCone`, `FulgoraCells.pyramids` / `.spots`, `FulgoraCtx`.
- Produces: `export interface FulgoraRoads { roadCells; roadPyramids; pyramidsBanding; spotsPrebanding; spotsBanding; structureCells; structureSubnoise; structureFacets; roadPavingThin; roadPaving2; roadPaving2b; roadPaving2c; roadDust }`, each `(x: number, y: number) => number`, and `export function makeFulgoraRoads(shared: FulgoraShared, cells: FulgoraCells, ctx: FulgoraCtx): FulgoraRoads`.

- [ ] **Step 1: Write the failing test**

Append to `test/fulgoraExpressions.spec.ts`. Bounds start generous and get tightened in Step 5 once the worst residual is known.

```ts
describe("makeFulgoraRoads", () => {
  const ctx = { seed0: ruinsFixture.seed0 };
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const roads = makeFulgoraRoads(shared, cells, ctx);

  /**
   * `roadCells` and `structureCells` are cell IDs and the paving stages are
   * built from comparisons, so those are exact - bound 0. The continuous fields
   * carry the port's known basisNoise floor.
   */
  it("matches the game on the road and structure layer", () => {
    checkRuins(roads.roadCells, ruinsFixture.fulgora_road_cells, 0);
    checkRuins(roads.structureCells, ruinsFixture.fulgora_structure_cells, 0);
    checkRuins(roads.roadPyramids, ruinsFixture.fulgora_road_pyramids, 1e-5);
    checkRuins(roads.structureFacets, ruinsFixture.fulgora_structure_facets, 1e-5);
    checkRuins(roads.structureSubnoise, ruinsFixture.fulgora_structure_subnoise, 1e-5);
    checkRuins(roads.pyramidsBanding, ruinsFixture.fulgora_pyramids_banding, 1e-4);
    checkRuins(roads.spotsPrebanding, ruinsFixture.fulgora_spots_prebanding, 1e-5);
    checkRuins(roads.spotsBanding, ruinsFixture.fulgora_spots_banding, 1e-4);
    checkRuins(roads.roadPavingThin, ruinsFixture.fulgora_road_paving_thin, 0);
    checkRuins(roads.roadPaving2, ruinsFixture.fulgora_road_paving_2, 0);
    checkRuins(roads.roadPaving2b, ruinsFixture.fulgora_road_paving_2b, 0);
    checkRuins(roads.roadPaving2c, ruinsFixture.fulgora_road_paving_2c, 0);
    checkRuins(roads.roadDust, ruinsFixture.fulgora_road_dust, 0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: FAIL - `makeFulgoraRoads` does not exist.

- [ ] **Step 3: Write `fulgoraRoads.ts`**

```ts
/**
 * Fulgora's road and structure layer - the Voronoi grids that lay out the
 * ruined city, and the four paving stages built on them.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 403-512.
 *
 * The shape: two more Voronoi tilings on top of the island tiling, one at a
 * third of the island grid for the main roads and one at an eighth for
 * individual structure blocks. `road_cells` gives each road block an id that
 * picks WHICH of three small-road patterns fills it, and the paving stages
 * composite the patterns, then cut structure blocks and district centres back
 * out.
 *
 * Two things here are easy to get wrong by reading:
 *
 * 1. **`structure_cells` and `structure_facets` are sampled at `y * 0.8`**, not
 *    at `y`. The stretch is in the Lua call, not in the grid size.
 * 2. **`structure_subnoise` is sampled at `x + 10000 * structure_cells`** - a
 *    derived coordinate large enough that f64 and f32 evaluation disagree
 *    visibly. `makeMultioctaveNoise` narrows incoming coordinates to f32
 *    internally as of #190; this is the first caller that depends on it.
 */
import { memoXY } from "../eval/memoXY";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import { makeVoronoi, type Voronoi } from "../voronoiNoise";
import type { FulgoraCells } from "./fulgoraCells";
import type { FulgoraCtx, FulgoraShared } from "./fulgoraShared";

/**
 * `seed1` values, computed with `crc32` from `src/codec/crc32.ts` over the UTF-8
 * bytes of the name in the Lua, never guessed. Note `structure_facets` uses the
 * string `'fulgora_structure_cells'` - it is the SAME field read through a
 * different op, exactly as `pyramids` shares `cells`' seed in `fulgoraCells.ts`.
 */
const SEED1_ROAD_CELLS = 2103387040; // crc32("fulgora_road_cells") = 0x7D5F23A0
const SEED1_STRUCTURE_CELLS = 2736009210; // crc32("fulgora_structure_cells") = 0xA3142FFA
const SEED1_STRUCTURE_SUBNOISE = 1886976824; // crc32("fulgora_structure_subnoise") = 0x7078FB38

/** `fulgora_road_jitter` and `fulgora_structure_jitter` - named constants in the Lua. */
const ROAD_JITTER = 1;
const STRUCTURE_JITTER = 0.8;

/** A comparison yields 1 or 0, matching the engine's boolean-to-number convention. */
const gt = (a: number, b: number): number => (a > b ? 1 : 0);
const lt = (a: number, b: number): number => (a < b ? 1 : 0);

export interface FulgoraRoads {
  readonly roadCells: (x: number, y: number) => number;
  readonly roadPyramids: (x: number, y: number) => number;
  readonly pyramidsBanding: (x: number, y: number) => number;
  readonly spotsPrebanding: (x: number, y: number) => number;
  readonly spotsBanding: (x: number, y: number) => number;
  readonly structureCells: (x: number, y: number) => number;
  readonly structureSubnoise: (x: number, y: number) => number;
  readonly structureFacets: (x: number, y: number) => number;
  readonly roadPavingThin: (x: number, y: number) => number;
  readonly roadPaving2: (x: number, y: number) => number;
  readonly roadPaving2b: (x: number, y: number) => number;
  readonly roadPaving2c: (x: number, y: number) => number;
  readonly roadDust: (x: number, y: number) => number;
}

export function makeFulgoraRoads(
  shared: FulgoraShared,
  cells: FulgoraCells,
  ctx: FulgoraCtx,
): FulgoraRoads {
  const seed0 = ctx.seed0;
  const grid = shared.grid;

  // One instance per field, two ops each - same reasoning as `fulgoraCells.ts`.
  const road: Voronoi = makeVoronoi({
    seed0,
    seed1: SEED1_ROAD_CELLS,
    gridSize: grid / 3,
    distanceType: "chebyshev",
    jitter: ROAD_JITTER,
  });
  const structure: Voronoi = makeVoronoi({
    seed0,
    seed1: SEED1_STRUCTURE_CELLS,
    gridSize: grid / 8,
    distanceType: "minkowski3",
    jitter: STRUCTURE_JITTER,
  });
  const subnoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_STRUCTURE_SUBNOISE,
    octaves: 3,
    persistence: 0.7,
    inputScale: 1 / 12,
    outputScale: 1,
  });

  const roadCells = memoXY((x: number, y: number) => road.cellId(x, y));
  const roadPyramids = memoXY((x: number, y: number) => road.pyramidNoise(x, y));

  const structureCells = memoXY((x: number, y: number) => structure.cellId(x, y * 0.8));
  const structureFacets = memoXY((x: number, y: number) => structure.facetNoise(x, y * 0.8));
  const structureSubnoise = memoXY((x: number, y: number) =>
    subnoise(x + 10000 * structureCells(x, y), y),
  );

  const pyramidsBanding = memoXY((x: number, y: number) => (cells.pyramids(x, y) * 8) % 1);
  const spotsPrebanding = memoXY(
    (x: number, y: number) =>
      Math.min(cells.spots(x, y), (1 - shared.startingVaultCone(x, y)) / 2) * 9 + 0.5,
  );
  const spotsBanding = memoXY((x: number, y: number) => spotsPrebanding(x, y) % 1);

  const roadPavingThin = memoXY((x: number, y: number) =>
    Math.max(lt(roadPyramids(x, y), 0.03) * 0.9, lt(structureFacets(x, y), 0.06) * 0.5),
  );

  const roadPaving2 = memoXY((x: number, y: number) => {
    const rc = roadCells(x, y);
    return Math.max(
      lt(roadPyramids(x, y), 0.05) * 0.9,
      lt(pyramidsBanding(x, y), 0.1) * 0.85 * lt(rc, 0.6) * gt(rc, 0.25),
      lt(spotsBanding(x, y), 0.1) * 0.85 * lt(rc, 0.25),
      lt(structureFacets(x, y), 0.1) * 0.85 * gt(rc, 0.6),
    );
  });

  const roadPaving2b = memoXY((x: number, y: number) =>
    lerp(roadPaving2(x, y), lt(structureFacets(x, y), 0.2) * 0.9, gt(structureCells(x, y), 0.8)),
  );

  const roadPaving2c = memoXY((x: number, y: number) => {
    const sp = spotsPrebanding(x, y);
    return lerp(roadPaving2b(x, y), gt(sp, 1) * 0.9, lt(sp, 1.3));
  });

  const roadDust = memoXY(
    (x: number, y: number) => lt(roadPyramids(x, y), 0.08) * 0.9 - roadPaving2c(x, y),
  );

  return {
    roadCells,
    roadPyramids,
    pyramidsBanding,
    spotsPrebanding,
    spotsBanding,
    structureCells,
    structureSubnoise,
    structureFacets,
    roadPavingThin,
    roadPaving2,
    roadPaving2b,
    roadPaving2c,
    roadDust,
  };
}
```

Import `lerp` from `../eval/math` alongside the others.

- [ ] **Step 4: Run it**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: PASS. **If only `pyramidsBanding` or `spotsBanding` fails**, the game's `%` does not match JavaScript's on that input - most likely on a negative left operand, where C `fmod` keeps the dividend's sign and a flooring modulo does not. Print the worst position's inputs and both candidate results before changing anything, and record which one the game agrees with in the NOTES.

- [ ] **Step 5: Tighten the bounds to what was measured**

Make `checkRuins` print the worst residual per field, run once, and replace each generous bound with the measured worst plus modest headroom, in a comment table exactly like the one at `test/fulgoraExpressions.spec.ts:32-47`. A blanket `1e-5` lets a regression in a field that achieves 1e-9 hide.

- [ ] **Step 6: Commit**

```bash
pnpm vp check --fix && pnpm run check:vue
git add -A
git commit -m "feat(noise): port the fulgora road and structure layer (#27)"
```

---

## Task 4: The ruins layer and the four `tile_ruin_*` expressions

**Files:**
- Create: `src/noise/expressions/fulgoraRuins.ts`
- Test: `test/fulgoraExpressions.spec.ts`

**Interfaces:**
- Consumes: `FulgoraMasks`, `FulgoraRoads`, `FulgoraCells.vaultsAndStartingVault`, `FulgoraCtx`.
- Produces: `export interface FulgoraRuins { ruinsWalls; ruinsPaving; tileRuinPaving; tileRuinWalls; tileRuinConduit; tileRuinMachinery }`, each `(x: number, y: number) => number`, and `export function makeFulgoraRuins(cells: FulgoraCells, masks: FulgoraMasks, roads: FulgoraRoads, ctx: FulgoraCtx): FulgoraRuins`.

- [ ] **Step 1: Write the failing test**

```ts
describe("makeFulgoraRuins", () => {
  const ctx = { seed0: ruinsFixture.seed0 };
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);
  const masks = makeFulgoraMasks(shared, cells, chain);
  const roads = makeFulgoraRoads(shared, cells, ctx);
  const ruins = makeFulgoraRuins(cells, masks, roads, ctx);

  it("matches the game on the two ruins noise fields", () => {
    checkRuins(ruins.ruinsWalls, ruinsFixture.fulgora_ruins_walls, 1e-5);
    checkRuins(ruins.ruinsPaving, ruinsFixture.fulgora_ruins_paving, 1e-5);
  });

  it("matches the game on all four tile_ruin outputs", () => {
    checkRuins(ruins.tileRuinPaving, ruinsFixture.fulgora_tile_ruin_paving, 1e-5);
    checkRuins(ruins.tileRuinWalls, ruinsFixture.fulgora_tile_ruin_walls, 1e-5);
    checkRuins(ruins.tileRuinConduit, ruinsFixture.fulgora_tile_ruin_conduit, 1e-5);
    checkRuins(ruins.tileRuinMachinery, ruinsFixture.fulgora_tile_ruin_machinery, 1e-5);
  });

  /**
   * `tile_ruin_conduit` and `tile_ruin_machinery` subtract `road_paving_2c`
   * OUTSIDE the artificial-mask product as well as inside it, so they are
   * negative over most of the map rather than zero. A port that dropped the
   * trailing term would still pass a "close to the fixture" check wherever the
   * mask is 0 unless the fixture actually varies there.
   */
  it("the conduit field is not constant off the artificial mask", () => {
    const off = ruinsFixture.fulgora_tile_ruin_conduit.filter(
      (_v: number, i: number) => ruinsFixture.fulgora_artificial_mask[i] === 0,
    );
    expect(new Set(off).size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: FAIL - `makeFulgoraRuins` does not exist.

- [ ] **Step 3: Write `fulgoraRuins.ts`**

```ts
/**
 * Fulgora's ruins layer - two noise fields and the four expressions that decide
 * which artificial tile a position gets.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 383-402 (the two noise fields) and 539-578 (the four outputs).
 *
 * Each of the four is a probability, fed straight to a tile's
 * `probability_expression`, so they are compared against each other and against
 * the four natural tiles by the argmax in `fulgoraCatalog.ts` - not thresholded
 * here.
 *
 * `paving` and `walls` each have TWO terms under a `max`: one gated by
 * `natural_and_mesa_mask` (ruins scattered on natural ground) and one gated by
 * `artificial_mask` (the built city). `conduit` and `machinery` have only the
 * artificial term, and both subtract `road_paving_2c` a SECOND time outside the
 * mask product - so they go negative on open ground rather than to zero.
 */
import { memoXY } from "../eval/memoXY";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import type { FulgoraCells } from "./fulgoraCells";
import type { FulgoraCtx } from "./fulgoraShared";
import type { FulgoraMasks } from "./fulgoraMasks";
import type { FulgoraRoads } from "./fulgoraRoads";

const SEED1_RUINS_WALLS = 2307136174; // crc32("fulgora_ruins_walls") = 0x89841AAE
const SEED1_RUINS_PAVING = 3946133559; // crc32("fulgora_ruins_paving") = 0xEB353837

export interface FulgoraRuins {
  /** `0.66 - abs(multioctave)` - ridged, same shape as `fulgora_dunes`. */
  readonly ruinsWalls: (x: number, y: number) => number;
  /** `abs(multioctave)` - billows, no offset. */
  readonly ruinsPaving: (x: number, y: number) => number;
  readonly tileRuinPaving: (x: number, y: number) => number;
  readonly tileRuinWalls: (x: number, y: number) => number;
  readonly tileRuinConduit: (x: number, y: number) => number;
  readonly tileRuinMachinery: (x: number, y: number) => number;
}

export function makeFulgoraRuins(
  cells: FulgoraCells,
  masks: FulgoraMasks,
  roads: FulgoraRoads,
  ctx: FulgoraCtx,
): FulgoraRuins {
  const seed0 = ctx.seed0;

  const wallsNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_RUINS_WALLS,
    octaves: 3,
    persistence: 0.7,
    inputScale: 1 / 6,
    outputScale: 1,
  });
  const pavingNoise = makeMultioctaveNoise({
    seed0,
    seed1: SEED1_RUINS_PAVING,
    octaves: 3,
    persistence: 0.7,
    inputScale: 1 / 16,
    outputScale: 1,
  });

  const ruinsWalls = memoXY((x: number, y: number) => 0.66 - Math.abs(wallsNoise(x, y)));
  const ruinsPaving = memoXY((x: number, y: number) => Math.abs(pavingNoise(x, y)));

  const tileRuinPaving = memoXY((x: number, y: number) =>
    Math.max(
      masks.naturalAndMesaMask(x, y) * (3 * ruinsPaving(x, y) * roads.roadPavingThin(x, y) - 0.5),
      masks.artificialMask(x, y) * (4 * roads.roadPaving2c(x, y) + ruinsPaving(x, y) - 1),
    ),
  );

  const tileRuinWalls = memoXY((x: number, y: number) =>
    Math.max(
      masks.naturalAndMesaMask(x, y) * (2 * ruinsWalls(x, y) + ruinsPaving(x, y) - 0.5),
      masks.artificialMask(x, y) *
        (0.25 * ruinsWalls(x, y) +
          0.25 * roads.structureSubnoise(x, y) -
          4 * roads.structureFacets(x, y) -
          roads.roadPaving2c(x, y) +
          2.5),
    ),
  );

  const tileRuinConduit = memoXY(
    (x: number, y: number) =>
      masks.artificialMask(x, y) *
        (ruinsWalls(x, y) +
          roads.structureSubnoise(x, y) +
          2 * roads.structureFacets(x, y) -
          roads.roadPaving2c(x, y) +
          0.2 +
          0.3 * cells.vaultsAndStartingVault(x, y)) -
      roads.roadPaving2c(x, y),
  );

  const tileRuinMachinery = memoXY(
    (x: number, y: number) =>
      masks.artificialMask(x, y) *
        (-ruinsWalls(x, y) +
          1.25 * roads.structureSubnoise(x, y) +
          2.5 * roads.structureFacets(x, y) -
          roads.roadPaving2c(x, y) -
          0.2 +
          0.3 * cells.vaultsAndStartingVault(x, y) +
          2 * (roads.spotsPrebanding(x, y) < 1 ? 1 : 0)) -
      roads.roadPaving2c(x, y),
  );

  return {
    ruinsWalls,
    ruinsPaving,
    tileRuinPaving,
    tileRuinWalls,
    tileRuinConduit,
    tileRuinMachinery,
  };
}
```

- [ ] **Step 4: Run it and tighten the bounds**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: PASS. Then replace the generous `1e-5` bounds with the measured worst plus headroom, as in Task 3 Step 5, with the table in a comment.

- [ ] **Step 5: Commit**

```bash
pnpm vp check --fix && pnpm run check:vue
git add -A
git commit -m "feat(noise): port the fulgora ruins layer and the four tile_ruin expressions (#27)"
```

---

## Task 5: The full eight-way land argmax

**Files:**
- Modify: `src/noise/tiles/fulgoraCatalog.ts`
- Modify: `src/noise/preview/renderFulgoraTerrain.ts`
- Modify: `test/fulgoraLandTiles.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3 and 4.
- Produces: `FulgoraTile` widened to all ten members. `makeFulgoraTileResolver`'s signature is unchanged.

- [ ] **Step 1: Widen the test first**

Rewrite the body of `test/fulgoraLandTiles.spec.ts` to score every land position, not a subset:

```ts
const LAND = new Set([
  "fulgoran-dust",
  "fulgoran-dunes",
  "fulgoran-sand",
  "fulgoran-rock",
  "fulgoran-paving",
  "fulgoran-walls",
  "fulgoran-conduit",
  "fulgoran-machinery",
]);

describe("fulgora land argmax over all eight tiles", () => {
  const resolve = makeFulgoraTileResolver({ seed0: tilesFixture.seed0 });
  const positions = tilesFixture.positions as { x: number; y: number }[];
  const names = tilesFixture.tileNames;

  const scoped = positions
    .map((p, i) => ({ ...p, game: names[i] as string }))
    .filter((p) => LAND.has(p.game));

  const wrong = scoped.map((p) => ({ ...p, ours: resolve(p.x, p.y) })).filter((p) => p.ours !== p.game);

  it("covers 2261 land positions", () => {
    expect(scoped.length).toBe(2261);
  });

  // MEASURE first, then pin the exact number - see the gate note below.
  it("picks the game's tile at every land position bar the known residual", () => {
    expect(wrong.length, `first few: ${JSON.stringify(wrong.slice(0, 5))}`).toBe(/* measured */ 0);
  });

  /**
   * A count alone would pass with every miss piled into one tile. This says
   * WHICH pairs are confused, so a residual arrives already localised.
   */
  it("reports the confusion pairs when it fails", () => {
    const pairs = new Map<string, number>();
    for (const w of wrong) {
      const k = `${w.game} -> ${w.ours}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
    expect([...pairs.entries()].sort((a, b) => b[1] - a[1])).toEqual([]);
  });
});
```

**The gate is an EXACT measured count, not zero, and this is settled rather than open.** Task 1 established - against the game's own expression compiler, not by inference - that the tile the game places is not always the argmax of the declared probability expressions. At (-1628, 872) the game scores `fulgoran-rock` 2.2537 above `fulgoran-dunes` 1.6149 and then places `fulgoran-dunes`. The three-tile subset therefore lands at 783/828 (45 mismatches), and no transcription of those formulas can close it.

So follow `test/fulgoraAgreement.spec.ts`'s established pattern, which Task 1 already applied to `test/fulgoraLandTiles.spec.ts`:

1. Run it once, read the real number, and pin it exactly with `toBe(<n>)`. Never a `toBeLessThan` bound - an exact count fails in both directions, and a bound silently absorbs a future regression.
2. Keep the structural test Task 1 added, updated for the widened scope: the residual must stay boundary-concentrated, asserted against the separately measured base rate so it cannot become a cheap test.
3. Record in the spec header what the number is, when it was measured, and that the mechanism is the same open question as the ocean residual's post-argmax pass.

**Do not change any expression, constant or formula to move that number.** A larger residual than Task 1's 45 is expected simply because the scope widens from 828 to 2261 positions and five more tiles compete. What would be a real finding is the residual ceasing to be boundary-concentrated, or a mismatch pair that Task 1 did not already see - either means a transcription error in Tasks 3 or 4, and the way to localise it is `sampleFulgora` at the disputed positions, not a tuned constant.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vp test test/fulgoraLandTiles.spec.ts`
Expected: FAIL - the resolver returns one of three land tiles, so every game `fulgoran-paving` position is wrong.

- [ ] **Step 3: Widen the resolver**

In `src/noise/tiles/fulgoraCatalog.ts`, widen the type, build the three new layers alongside the chain, and replace the three-way land branch with an eight-way argmax. `bestProbability` already handles a NaN by letting it lose rather than poisoning the comparison, which is what the four ocean tiles needed; reuse it here rather than `Math.max`.

```ts
export type FulgoraTile =
  | "fulgoran-dust"
  | "fulgoran-dunes"
  | "fulgoran-sand"
  | "fulgoran-rock"
  | "fulgoran-paving"
  | "fulgoran-walls"
  | "fulgoran-conduit"
  | "fulgoran-machinery"
  | "shallow"
  | "deep";

/** The eight land probabilities in a fixed order, so the tie-break is stable. */
const LAND_ORDER = [
  "fulgoran-dust",
  "fulgoran-dunes",
  "fulgoran-sand",
  "fulgoran-rock",
  "fulgoran-paving",
  "fulgoran-walls",
  "fulgoran-conduit",
  "fulgoran-machinery",
] as const;
```

Inside the resolver, after the ocean early-out:

```ts
    // `fulgoran-dust` reads `max(0, natural, 2 * mesa * pyramids)` - a THREE
    // argument max, not `max(0, natural)` times something.
    const dust =
      chain.scrapMedium(x, y) +
      Math.max(0, chain.natural(x, y), 2 * cells.mesa(x, y) * cells.pyramids(x, y)) * 2 -
      0.9 +
      chain.rock(x, y) +
      roads.roadDust(x, y) * cells.sprawl(x, y);

    const dunesField = chain.dunes(x, y);
    const probabilities = [
      dust,
      1 + dunesField,
      1 - dunesField,
      0.8 + chain.rock(x, y) * 2 - Math.max(0, chain.mixOil(x, y)) * 6,
      ruins.tileRuinPaving(x, y),
      ruins.tileRuinWalls(x, y),
      ruins.tileRuinConduit(x, y),
      ruins.tileRuinMachinery(x, y),
    ];

    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < probabilities.length; i++) {
      const v = probabilities[i] as number;
      if (v > bestValue) {
        bestValue = v;
        bestIndex = i;
      }
    }
    return LAND_ORDER[bestIndex] as FulgoraTile;
```

Build the new layers once, above the returned closure:

```ts
  const masks = makeFulgoraMasks(shared, cells, chain);
  const roads = makeFulgoraRoads(shared, cells, ctx);
  const ruins = makeFulgoraRuins(cells, masks, roads, ctx);
```

- [ ] **Step 4: Add the eight colours**

In `src/noise/preview/renderFulgoraTerrain.ts`, the full palette, every triple read from `tiles-fulgora.lua`:

```ts
const COLORS: Record<FulgoraTile, readonly [number, number, number]> = {
  "fulgoran-dust": [112, 65, 50],
  "fulgoran-dunes": [125, 71, 59],
  "fulgoran-sand": [118, 68, 56],
  "fulgoran-rock": [131, 85, 66],
  "fulgoran-paving": [120, 94, 67],
  "fulgoran-walls": [114, 75, 65],
  "fulgoran-conduit": [100, 79, 68],
  "fulgoran-machinery": [89, 79, 68],
  shallow: [74, 42, 43],
  deep: [Math.round(49 * 1.15), Math.round(31 * 1.15), Math.round(35 * 1.15)],
};
```

Update the header comment: the "eight land tiles are not resolved against each other yet" paragraph is now false and must go.

- [ ] **Step 5: Run the land spec, then the whole Fulgora set**

```bash
pnpm vp test test/fulgoraLandTiles.spec.ts
pnpm vp test test/fulgoraAgreement.spec.ts test/fulgoraExpressions.spec.ts test/fulgoraSurfaceSeed.spec.ts
```

Expected: the land spec passes at 0 mismatches; `fulgoraAgreement` still reports exactly **7** and **11**. That second check is the important one - the land layer must not move the land/ocean boundary at all.

- [ ] **Step 6: Commit**

```bash
pnpm vp check --fix && pnpm run check:vue
git add -A
git commit -m "feat(preview): resolve all eight fulgora land tiles in the argmax (#27)"
```

---

## Task 6: Measure the cost, then write down what was measured

**Files:**
- Modify: `test/render-cost.perf.spec.ts`
- Modify: `docs/noise/fulgora-elevation-NOTES.md`
- Modify: `docs/noise/client-preview-ROADMAP.md`

- [ ] **Step 1: Re-measure Fulgora terrain**

Run: `pnpm vp test test/render-cost.perf.spec.ts`

V1 measured **3.91 us/px** at 1024x1024, tpp 1, min of 3. This task adds two Voronoi fields and three multioctave fields to every land pixel, so expect a rise. Record the new number the same way (1024x1024, tpp 1, min of 3) and update the row rather than adding a second one.

- [ ] **Step 2: Report the land pixel cost separately if the rise is over 3x**

The ocean early-out means the two costs now differ a lot. If terrain has gone above ~12 us/px, measure a land-only window as well (origin inside a sprawl island) and report both, because a single average over a mostly-ocean map understates what a land-heavy viewport costs. If the rise is smaller, one number is enough and this step is a no-op - say so rather than skipping it silently.

- [ ] **Step 3: Write the NOTES entries**

Append to `docs/noise/fulgora-elevation-NOTES.md`, in that file's established style: every entry states **how it was measured**, not just what is believed. At minimum:

- The measured per-field residuals from Tasks 3 and 4, as the table the specs now carry.
- What the game's `%` operator does on a negative left operand, and which position settled it.
- The land argmax agreement number over 2261 positions, and the confusion pairs if any survive.
- **The headline finding, stated as its own entry: the placed tile is not always the argmax of the declared probability expressions.** Give the worked counter-example with the game's own numbers ((-1628, 872): rock 2.2537, dunes 1.6149, `get_tile` = dunes), the boundary statistic with its computed p-value, and the sub-tile offset table that refutes a sampling-alignment cause. Say plainly that the mechanism is unknown and that it is the same open question as the ocean residual, so a later reader does not re-derive the refutations.
- The new render cost, and the land-versus-ocean split if Step 2 applied.

- [ ] **Step 4: Update the ROADMAP**

In `docs/noise/client-preview-ROADMAP.md`, mark Fulgora V2 under Milestone 4 and rewrite the deferred paragraph at lines 525-533. The land tiles are no longer deferred; scrap resources, cliffs, the island finder and the 18-tile boundary residual still are. Do not delete the boundary-residual sentence - it is still true and still unexplained.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm run verify
git add -A
git commit -m "docs(fulgora): record the V2 land tile findings and the new render cost (#27)"
```

Expected: `verify` passes in roughly 65-90s cold. The suite gains 1 spec file, so the CI shard balance shifts slightly; that is expected and needs no action unless a shard's wall moves by minutes.

---

## Self-Review

**Coverage.** Every one of the 22 expressions has a task: 3 masks in Task 2, 13 road and structure fields in Task 3, 6 ruins fields in Task 4, and the 8 tile probabilities in Tasks 1 and 5. `fulgora_sprawl_mask` and `fulgora_decorative_machine_density` are named as deliberate exclusions with the reason.

**Type consistency.** `makeFulgoraTileResolver` and `FulgoraTile` are introduced in Task 1 and widened in Task 5 without a signature change. `makeFulgoraMasks(shared, cells, chain)`, `makeFulgoraRoads(shared, cells, ctx)` and `makeFulgoraRuins(cells, masks, roads, ctx)` keep the same argument order everywhere they appear. `checkRuins` is defined in Task 2 and used unchanged in Tasks 3 and 4.

**Known gaps, stated rather than hidden.**

1. The bounds in Tasks 3 and 4 are placeholders **by design** and each has an explicit tightening step. They are the one place this plan cannot supply a real number in advance, because the number is the measurement.
2. `makeFulgoraSurfaceResolver` is renamed rather than kept. Nothing outside the three files listed imports it (checked with grep), so this is not a breaking change to any consumer.
3. The plan assumes the game places a land tile wherever no ocean probability is positive. That follows from `fulgoran-sand` being `1 - fulgora_dunes`, which expands to `0.34 + abs(n)` and so can never drop to 0 - at least one land probability is always positive, whatever the noise does. If Task 5 turns up positions where the game placed something outside these twelve tiles, that assumption is what to check first.
