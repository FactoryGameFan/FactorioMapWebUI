# Fulgora Scrap Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Fulgora's scrap resource as a rolled overlay on the preview's `resources` view, validated against the game's own entity counts and map preview.

**Architecture:** Scrap's `probability_expression` composes fields V1 and V2 already ported and oracle-covered, so no new noise expression is needed - only a composition, a catalog entry and a renderer. Placement reuses `makePlacementSet` (the same per-tile roll the Vulcanus geyser uses) with 1x1 marks. A new `FulgoraStack` lets the terrain and scrap passes share one field DAG, because `memoXY` is single-entry and private copies share nothing.

**Tech Stack:** TypeScript, Vue 3, Vite+ (`vp`), Vitest-compatible tests via `vite-plus/test`, Factorio 2.1.14 headless as the oracle.

**Spec:** `/Users/ericjohnson/GitHub/FactorioMapWebUI/docs/superpowers/specs/2026-08-14-fulgora-scrap-resources-design.md`

## Global Constraints

- **Never edit a fixture, an expected value, or a bound to make a test pass.** A mismatch is a real finding. Size every bound from the measurement; do not widen one to fit.
- **Before believing a test is a guard, plant a plausible error and watch the right test fail.** House practice, not optional.
- Branch off `main`; never commit to `main`. Open a PR and let the 7 required checks run.
- Run everything through pnpm: `pnpm vp test <file>`, `pnpm vp check --fix`, `pnpm run check:vue`, `pnpm run verify`. `npx vp` fails with `EBADDEVENGINES`.
- Use hyphens (`-`), never em or en dashes, in every file including comments. Prose targets Flesch-Kincaid grade 12 or below.
- **Seed convention, and it is a trap.** `sampleExpression` and `sampleCliffEntitiesFull` FORCE the Fulgora surface seed to the number passed, so their fixtures read `seed0: 123456` raw. `--generate-map-preview` takes a MAP seed, so Fulgora's surface seed at map seed 123456 is **2967702466**. Getting this wrong scores ~0.5% agreement and looks exactly like a broken port.
- `elevationRenderRequest.ts` passes `req.seed0` RAW to the Fulgora resolver. Do not call `surfaceSeedForPlanet` inside the render path.
- Every new fixture needs a `test/fixtures/PROVENANCE.json` entry or `test/fixtureProvenance.spec.ts` fails.
- Oracle captures need the local Factorio binary. Check drift with `pnpm refs:sync --check` first (in sync at 2.1.14 as of 2026-08-14).

---

## File Structure

| file | responsibility |
| --- | --- |
| `src/noise/expressions/fulgoraScrap.ts` | **Create.** The scrap `probability_expression`, clamped to `[0, 1]`. Nothing else. |
| `src/noise/resources/fulgoraResourceCatalog.ts` | **Create.** The one catalog entry: name, map colour, levers, placement mode. |
| `src/noise/preview/renderFulgoraResources.ts` | **Create.** Composite the rolled overlay onto a terrain `ImageData`. |
| `src/noise/tiles/fulgoraCatalog.ts` | **Modify.** Add `FulgoraStack` + `makeFulgoraStack`, and `*From` variants of the two resolvers. |
| `src/noise/preview/renderFulgoraTerrain.ts` | **Modify.** Accept an optional shared stack. |
| `src/noise/preview/elevationRenderRequest.ts` | **Modify.** Fulgora branch builds the stack and runs the scrap pass for `resources`/`all`. |
| `src/noise/placement/placementRoll.ts` | **Modify.** One new salt. |
| `test/oracle/capture.ts` | **Modify.** Two new capture functions + CLI registration. |

---

### Task 1: Capture the four oracle fixtures

Everything downstream asserts against these, so they come first. Needs the local Factorio binary.

**Files:**
- Modify: `test/oracle/capture.ts` (add two capture functions, register both in the CLI dispatch near line 6585)
- Modify: `test/fixtures/PROVENANCE.json`
- Create: `test/fixtures/oracle-fulgora-scrap.seed123456.json`
- Create: `test/fixtures/oracle-fulgora-scrap-entities.seed123456.json`
- Create: `test/fixtures/oracle-preview-fulgora-terrain.seed123456.png`
- Create: `test/fixtures/oracle-preview-fulgora-scrap.seed123456.png`

**Interfaces:**
- Consumes: `sampleFulgora(expression, positions, seed)` and `fulgoraCapturePositions()` (both already in `capture.ts`); `sampleCliffEntitiesFull` and `generatePreview` from `test/oracle/`.
- Produces: the four fixtures above. Task 3 reads `oracle-fulgora-scrap.seed123456.json`, Task 4 reads `oracle-fulgora-scrap-entities.seed123456.json`, Task 6 reads both PNGs.

- [ ] **Step 1: Confirm the references are in sync**

Run: `pnpm refs:sync --check`
Expected: `-> in sync`, naming 2.1.14. If it names a different version, stop and re-read `CLAUDE.md`'s version-skew section before capturing anything.

- [ ] **Step 2: Add the probability-row capture**

Add to `test/oracle/capture.ts`, next to the other Fulgora captures (near `captureFulgoraRuins`):

```ts
/**
 * Scrap's `probability_expression`, sampled from the game with its
 * `local_expressions` inlined.
 *
 * Every FIELD it reads is already covered by the shared/cells/elevation/ruins
 * fixtures, so this exists to cover the one thing they cannot: the COMPOSITION,
 * including operator precedence and the two `min`s. Positions deliberately span
 * the whole range from zero to the 0.5 cap - a sample that only hit zeros would
 * pass against a stub.
 */
async function captureFulgoraScrap(): Promise<void> {
  const seed = 123456;
  const positions = fulgoraCapturePositions();
  const sample = (expression: string) => sampleFulgora(expression, positions, seed);

  const STRUCT =
    "(fulgora_structure_cells < min(0.1 * control:scrap:frequency, 0.05 + 0.05 * control:scrap:frequency))" +
    " * (1 + fulgora_structure_subnoise)" +
    " * (fulgora_elevation > (fulgora_coastline + 10))" +
    " * fulgora_artificial_mask";
  const VAULT =
    "(fulgora_spots_prebanding < (1.2 + 0.4 * slider_to_linear(control:scrap:size, -1, 1)))" +
    " * fulgora_vaults_and_starting_vault * 10";
  const EXPRS: Record<string, string> = {
    fulgora_scrap_probability: `(control:scrap:size > 0) * (1 - fulgora_starting_mask) * (min(${STRUCT} + ${VAULT}, 0.5) * (1 - fulgora_road_paving_2c))`,
    fulgora_scrap_struct_term: STRUCT,
    fulgora_scrap_vault_term: VAULT,
    scrap_control_frequency: "control:scrap:frequency",
    scrap_control_size: "control:scrap:size",
  };

  const fields: Record<string, number[]> = {};
  for (const [name, expr] of Object.entries(EXPRS)) {
    fields[name] = await sample(expr);
    console.log(`  captured ${name}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 (Space Age enabled) via the test/oracle harness: the " +
      "scrap resource's probability_expression with its local_expressions inlined, plus its two " +
      "additive terms and the three control levers read back, on a real Fulgora surface " +
      "(game.planets['fulgora'].create_surface(), seed FORCED to 123456 - NOT the derived " +
      "mapSeed + crc32('fulgora')). Every FIELD the expression reads is already covered by the " +
      "shared/cells/elevation/ruins fixtures; this covers the COMPOSITION, which nothing else " +
      "does. The control rows are the non-vacuity check: a default surface must report 1 for " +
      "frequency and size, which is what the composition assumes. Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts fulgora-scrap",
    seed0: seed,
    planet: "fulgora",
    positions,
    ...fields,
  };
  const out = join(FIXTURES, "oracle-fulgora-scrap.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(positions.length)} positions)`);
}
```

- [ ] **Step 3: Add the entity-count capture**

Add directly below it:

```ts
/**
 * Every scrap entity the game actually places in three regions.
 *
 * This is what gates DENSITY, and it is not interchangeable with the preview
 * PNGs: `map_grid` defaults to true, so the preview draws solid ores in a
 * checkerboard of 2x2 tile blocks and shows only ~0.5 pixels per entity. A pixel
 * diff would therefore bake a 2x under-placement into the renderer. Measured on
 * these exact regions: the model's clamped expectation is 0.9836 per real
 * entity, inside Poisson noise at n = 770.
 */
async function captureFulgoraScrapEntities(): Promise<void> {
  const seed = 123456;
  const regions: Region[] = [
    { x0: 0, y0: 0, x1: 256, y1: 256 },
    { x0: -1200, y0: 800, x1: -944, y1: 1056 },
    { x0: 800, y0: -1600, x1: 1056, y1: -1344 },
  ];
  const cases: unknown[] = [];
  for (const region of regions) {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      const dump = await sampleCliffEntitiesFull(region, {
        workDir,
        seed,
        spaceAge: true,
        planet: "fulgora",
        entityType: "resource",
        alsoResources: true,
        protoNames: ["scrap"],
      });
      cases.push({ region, resources: dump.resources, protos: dump.protos });
      console.log(
        `  [${String(region.x0)},${String(region.y0)}] -> ${String(dump.resources?.length ?? -1)} scrap`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.14 via test/oracle: every resource entity " +
      "(find_entities_filtered{type='resource'}) the game placed in each region on FULGORA at the " +
      "DEFAULT preset, after chunk-forced generation, on a create_surface() surface whose seed is " +
      "FORCED to `seed`. This is the DENSITY oracle and the preview PNGs cannot replace it: " +
      "ResourceEntityPrototype::map_grid defaults to true, so the game's map preview draws solid " +
      "ores in a 2x2-block checkerboard and shows about 0.5 pixels per entity. `protos` records " +
      "scrap's collision box and map_grid read off the running game. Regenerate: node " +
      "--experimental-strip-types test/oracle/capture.ts fulgora-scrap-entities",
    seed0: seed,
    planet: "fulgora",
    cases,
  };
  const out = join(FIXTURES, "oracle-fulgora-scrap-entities.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${String(cases.length)} regions)`);
}
```

- [ ] **Step 4: Register both in the CLI dispatch**

Near line 6585 in `test/oracle/capture.ts`, beside the other `want(...)` lines:

```ts
if (want("fulgora-scrap")) await captureFulgoraScrap();
if (want("fulgora-scrap-entities")) await captureFulgoraScrapEntities();
```

- [ ] **Step 5: Teach previewCompare about Fulgora**

In `test/oracle/previewCompare.ts`, the CLI block currently special-cases only `vulcanus`. Replace the `disabled` assignment with:

```ts
  // Naming a control the planet does not define is harmless, so the Nauvis
  // names stay in every arm; each planet's OWN disableable controls are added.
  // Fulgora's are `scrap` and `fulgora_cliff` - `fulgora_islands` reports
  // can_be_disabled: false, so it cannot be switched off and is not listed.
  const disabled =
    planet === "vulcanus"
      ? [...DISABLEABLE, "calcite", "tungsten_ore", "vulcanus_coal", "sulfuric_acid_geyser"]
      : planet === "fulgora"
        ? [...DISABLEABLE, "scrap", "fulgora_cliff"]
        : DISABLEABLE;
```

- [ ] **Step 6: Run all four captures**

```bash
node --experimental-strip-types test/oracle/capture.ts fulgora-scrap
node --experimental-strip-types test/oracle/capture.ts fulgora-scrap-entities
```

Then the two PNGs. Write a throwaway script in the scratchpad that calls `generatePreview` twice at `seed: 123456, planet: "fulgora", size: 1024`, once with `[...DISABLEABLE, "scrap", "fulgora_cliff"]` and once with `[...DISABLEABLE, "fulgora_cliff"]`, saving to `test/fixtures/oracle-preview-fulgora-terrain.seed123456.png` and `test/fixtures/oracle-preview-fulgora-scrap.seed123456.png`.

Expected: the terrain PNG about 341 KB, the scrap PNG about 350 KB. **If the two are byte-identical, the `scrap` disable did not apply - stop and fix that before continuing**, because every later assertion would then be comparing an image to itself.

- [ ] **Step 7: Add the four provenance entries**

Add to `test/fixtures/PROVENANCE.json` under `fixtures`, each with `"factorioVersion": "2.1.14"` and an `evidence` string naming the capture command and stating that `pnpm refs:sync --check` reported in sync at capture time. Follow the wording of the existing `oracle-preview-vulcanus-terrain.seed123456.png` entry.

- [ ] **Step 8: Verify the provenance guard**

Run: `pnpm vp test test/fixtureProvenance.spec.ts`
Expected: PASS. Then delete one of the four entries, re-run, and confirm it FAILS naming that fixture. Restore the entry.

- [ ] **Step 9: Commit**

```bash
git add test/oracle/capture.ts test/oracle/previewCompare.ts test/fixtures/
git commit -m "test(fulgora): capture the scrap probability, entity and preview fixtures (#27)"
```

---

### Task 2: `FulgoraStack` - build the field DAG once

Pure refactor. No rendered pixel may change.

**Files:**
- Modify: `src/noise/tiles/fulgoraCatalog.ts`
- Modify: `src/noise/preview/renderFulgoraTerrain.ts`
- Test: `test/fulgoraStack.spec.ts` (create)

**Interfaces:**
- Consumes: `makeFulgoraShared`, `makeFulgoraCells`, `makeFulgoraElevation`, `makeFulgoraMasks`, `makeFulgoraRoads`, `makeFulgoraRuins` - all already exported.
- Produces: `interface FulgoraStack { ctx, shared, cells, chain, masks, roads, ruins }`; `makeFulgoraStack(ctx: FulgoraCtx): FulgoraStack`; `makeFulgoraTileResolverFrom(stack: FulgoraStack): (x, y) => FulgoraTile`. Tasks 3, 4 and 5 all take a `FulgoraStack`.

- [ ] **Step 1: Write the failing test**

Create `test/fulgoraStack.spec.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import {
  makeFulgoraStack,
  makeFulgoraTileResolver,
  makeFulgoraTileResolverFrom,
} from "../src/noise/tiles/fulgoraCatalog";

/**
 * The shared stack must be a pure refactor. `memoXY` is a SINGLE-ENTRY cache, so
 * a second private copy of the DAG shares nothing and pays for the whole tree
 * again - which is the only reason this exists. If it ever changes a resolved
 * tile, it is a bug, not an optimisation.
 */
describe("the shared Fulgora stack resolves identically to a private one", () => {
  it("agrees on every tile of a 64x64 block spanning the coastline", () => {
    const ctx = { seed0: 123456 };
    const priv = makeFulgoraTileResolver(ctx);
    const shared = makeFulgoraTileResolverFrom(makeFulgoraStack(ctx));
    let checked = 0;
    for (let y = 1000 - 128; y < 1000 + 128; y += 4) {
      for (let x = -1500 - 128; x < -1500 + 128; x += 4) {
        expect(shared(x, y)).toBe(priv(x, y));
        checked++;
      }
    }
    // Non-vacuity: the block must contain BOTH land and ocean, or agreeing on
    // it proves nothing about the land argmax.
    const names = new Set<string>();
    for (let y = 1000 - 128; y < 1000 + 128; y += 4)
      for (let x = -1500 - 128; x < -1500 + 128; x += 4) names.add(shared(x, y));
    expect(checked).toBe(64 * 64);
    expect(names.has("shallow") || names.has("deep")).toBe(true);
    expect([...names].some((n) => n.startsWith("fulgoran-"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vp test test/fulgoraStack.spec.ts`
Expected: FAIL - `makeFulgoraStack` and `makeFulgoraTileResolverFrom` are not exported.

- [ ] **Step 3: Add the stack to `fulgoraCatalog.ts`**

```ts
/**
 * The Fulgora field DAG, built once.
 *
 * Three call sites used to build their own copy - the tile resolver, the land
 * probabilities and (from Task 3) the scrap field. `memoXY` is a SINGLE-ENTRY
 * cache, so separate copies share nothing at all and each pays for the whole
 * tree. This mirrors `VulcanusStack` in `vulcanusCatalog.ts`, which exists for
 * the same measured reason.
 */
export interface FulgoraStack {
  readonly ctx: FulgoraCtx;
  readonly shared: ReturnType<typeof makeFulgoraShared>;
  readonly cells: ReturnType<typeof makeFulgoraCells>;
  readonly chain: ReturnType<typeof makeFulgoraElevation>;
  readonly masks: ReturnType<typeof makeFulgoraMasks>;
  readonly roads: ReturnType<typeof makeFulgoraRoads>;
  readonly ruins: ReturnType<typeof makeFulgoraRuins>;
}

export function makeFulgoraStack(ctx: FulgoraCtx): FulgoraStack {
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);
  const masks = makeFulgoraMasks(shared, cells, chain);
  const roads = makeFulgoraRoads(shared, cells, ctx);
  const ruins = makeFulgoraRuins(cells, masks, roads, ctx);
  return { ctx, shared, cells, chain, masks, roads, ruins };
}

export function makeFulgoraTileResolverFrom(
  stack: FulgoraStack,
): (x: number, y: number) => FulgoraTile {
  const { cells, chain, roads, ruins } = stack;
  const landProbabilities = landProbabilitiesFrom(cells, chain, roads, ruins);
  return resolveFrom(chain, landProbabilities);
}
```

Then rewrite the existing `makeFulgoraTileResolver` as `makeFulgoraTileResolverFrom(makeFulgoraStack(ctx))`, moving its per-position body into a private `resolveFrom(chain, landProbabilities)` helper so both paths run byte-identical code. Do the same for `makeFulgoraLandProbabilities`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vp test test/fulgoraStack.spec.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Add the optional stack to the terrain renderer**

In `src/noise/preview/renderFulgoraTerrain.ts`, add to `RenderFulgoraTerrainOptions`:

```ts
  /** Shared field DAG - see `RenderVulcanusTerrainOptions.stack`. */
  readonly stack?: FulgoraStack;
```

and replace the resolver construction with:

```ts
  const resolve =
    opts.stack === undefined
      ? makeFulgoraTileResolver({ seed0, ...opts.ctx })
      : makeFulgoraTileResolverFrom(opts.stack);
```

- [ ] **Step 6: Confirm nothing rendered changed**

Run: `pnpm vp test test/fulgoraAgreement.spec.ts test/fulgoraLandTiles.spec.ts test/tiledEquality.spec.ts`
Expected: PASS, with the same counts as before this task. **If `fulgoraLandTiles` reports anything other than 2137/2261, the refactor changed behaviour - do not adjust the expectation, find the difference.**

- [ ] **Step 7: Commit**

```bash
git add src/noise/tiles/fulgoraCatalog.ts src/noise/preview/renderFulgoraTerrain.ts test/fulgoraStack.spec.ts
git commit -m "refactor(fulgora): share one field DAG through a FulgoraStack (#27)"
```

---

### Task 3: `makeFulgoraScrap` - the probability field

**Files:**
- Create: `src/noise/expressions/fulgoraScrap.ts`
- Test: `test/fulgoraScrap.spec.ts` (create)

**Interfaces:**
- Consumes: `FulgoraStack` from Task 2; `sliderToLinear` from `src/noise/eval/math`; `f32` from `src/noise/eval/f32`.
- Produces: `interface FulgoraScrap { readonly probability: (x: number, y: number) => number }` and `makeFulgoraScrap(stack: FulgoraStack, controls?: FulgoraScrapControls): FulgoraScrap`, where `FulgoraScrapControls = { readonly frequency?: number; readonly size?: number }`. Tasks 4 and 5 call `makeFulgoraScrap`.

- [ ] **Step 1: Write the failing test**

Create `test/fulgoraScrap.spec.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-fulgora-scrap.seed123456.json";
import { makeFulgoraScrap } from "../src/noise/expressions/fulgoraScrap";
import { makeFulgoraStack } from "../src/noise/tiles/fulgoraCatalog";

const stack = makeFulgoraStack({ seed0: fixture.seed0 });
const scrap = makeFulgoraScrap(stack);

describe("Fulgora scrap probability", () => {
  it("matches the game's own evaluation of the whole expression", () => {
    const want = fixture.fulgora_scrap_probability as number[];
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      const got = scrap.probability(p.x, p.y);
      const rel = Math.abs(got - want[i]) / Math.max(1e-9, Math.abs(got), Math.abs(want[i]));
      if (rel > worst) {
        worst = rel;
        worstAt = i;
      }
    }
    // Bound sized from the measurement, not chosen to fit. Do not widen it: the
    // repo has twice had a real bug hidden behind a widened bound.
    expect(worst, `worst at index ${String(worstAt)}`).toBeLessThan(1e-5);
  });

  it("the sample spans the range, so agreement is not agreement on zeros", () => {
    const want = fixture.fulgora_scrap_probability as number[];
    expect(want.filter((v) => v > 0).length).toBeGreaterThan(5);
    expect(want.filter((v) => v >= 0.4999).length).toBeGreaterThan(0);
  });

  it("the game reports the default controls the composition assumes", () => {
    expect(new Set(fixture.scrap_control_frequency as number[])).toEqual(new Set([1]));
    expect(new Set(fixture.scrap_control_size as number[])).toEqual(new Set([1]));
  });

  it("clamps to [0, 1]", () => {
    // The raw expression goes NEGATIVE, entirely via structure_subnoise < -1:
    // 1002 positions in a 1024x1024 window. Summing raw values instead of
    // clamped ones understates the placement expectation by about 6%.
    for (let y = -400; y < 400; y += 7) {
      for (let x = -400; x < 400; x += 7) {
        const p = scrap.probability(x, y);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it("places no scrap on ocean, by the elevation term alone", () => {
    // Measured: expected scrap on non-land is exactly 0.00 over 262,144 tiles.
    // There is deliberately no tile gate in the renderer, so this is the
    // assertion that stands in for one.
    const tile = makeFulgoraTileResolverFrom(stack);
    let oceanChecked = 0;
    for (let y = 744; y < 744 + 512; y += 3) {
      for (let x = -1756; x < -1756 + 512; x += 3) {
        const t = tile(x, y);
        if (t !== "shallow" && t !== "deep") continue;
        oceanChecked++;
        expect(scrap.probability(x, y)).toBe(0);
      }
    }
    expect(oceanChecked).toBeGreaterThan(10000);
  });
});
```

Add `makeFulgoraTileResolverFrom` to the import from `../src/noise/tiles/fulgoraCatalog`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vp test test/fulgoraScrap.spec.ts`
Expected: FAIL - cannot find module `../src/noise/expressions/fulgoraScrap`.

- [ ] **Step 3: Write the implementation**

Create `src/noise/expressions/fulgoraScrap.ts`:

```ts
/**
 * Fulgora's scrap `probability_expression`, from
 * `space-age/prototypes/planet/planet-fulgora-map-gen.lua` at 2.1.14.
 *
 * **No new field.** Every term it reads was ported and oracle-covered by V1 and
 * V2, so this module is composition only. That made the COMPOSITION the one
 * untested link, which `test/fulgoraScrap.spec.ts` closes against the game's own
 * evaluation of the whole expression.
 *
 * Three properties drive everything downstream:
 *
 * - **It is capped at 0.5 and never saturates.** `min(..., 0.5)` wraps the whole
 *   inner term. Nauvis and Vulcanus solid ores saturate to about 1 and are drawn
 *   as solid patches; scrap cannot be, which is why the overlay ROLLS.
 * - **It can go negative**, entirely through `fulgora_structure_subnoise < -1` -
 *   1002 positions in a 1024x1024 window, none from `road_paving_2c > 1` or
 *   `starting_mask > 1`, and none above 1. Hence the clamp. Summing the raw
 *   values understates the placement expectation by about 6%.
 * - **It excludes water on its own.** `fulgora_elevation > fulgora_coastline +
 *   10` put expected scrap on ocean at exactly 0.00 over 262,144 tiles, so the
 *   renderer needs no tile gate.
 */
import { f32 } from "../eval/f32";
import { sliderToLinear } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import type { FulgoraStack } from "../tiles/fulgoraCatalog";

/** `fulgora_coastline`, a program constant. Same value as `fulgoraElevation.ts`. */
const COASTLINE = 80;

export interface FulgoraScrapControls {
  /** `control:scrap:frequency` (wire value). Neutral/default = 1. */
  readonly frequency?: number;
  /** `control:scrap:size` (wire value). Neutral/default = 1. */
  readonly size?: number;
}

export interface FulgoraScrap {
  /** The per-tile placement probability, clamped to `[0, 1]`. */
  readonly probability: (x: number, y: number) => number;
}

export function makeFulgoraScrap(
  stack: FulgoraStack,
  controls: FulgoraScrapControls = {},
): FulgoraScrap {
  const { shared, cells, chain, masks, roads } = stack;
  const frequency = controls.frequency ?? 1;
  const size = controls.size ?? 1;

  // Both cuts are loop-invariant: they depend only on the sliders.
  const cellsCut = Math.min(f32(0.1 * frequency), f32(0.05 + f32(0.05 * frequency)));
  const spotsCut = f32(1.2 + f32(0.4 * sliderToLinear(size, -1, 1)));
  const enabled = size > 0 ? 1 : 0;

  const probability = memoXY((x: number, y: number) => {
    if (enabled === 0) return 0;
    const structTerm =
      (roads.structureCells(x, y) < cellsCut ? 1 : 0) *
      f32(1 + roads.structureSubnoise(x, y)) *
      (chain.elevation(x, y) > COASTLINE + 10 ? 1 : 0) *
      masks.artificialMask(x, y);
    const vaultTerm =
      (roads.spotsPrebanding(x, y) < spotsCut ? 1 : 0) *
      f32(cells.vaultsAndStartingVault(x, y) * 10);
    const inner = Math.min(f32(structTerm + vaultTerm), 0.5);
    const raw = f32(f32(1 - shared.startingMask(x, y)) * f32(inner * f32(1 - roads.roadPaving2c(x, y))));
    // The game rolls `U < probability`, so a negative value is simply never,
    // and a value above 1 always. Clamping here is what makes the expectation
    // sum meaningful and keeps the roll honest.
    return raw < 0 ? 0 : raw > 1 ? 1 : raw;
  });

  return { probability };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vp test test/fulgoraScrap.spec.ts`
Expected: PASS, 5 tests.

**If the first test fails on the bound**, print the worst relative error before touching anything. A pure-f64 composition measured 1.1e-3 worst; per-op f32 should land far below that. If f32 makes it worse, remove the narrowing rather than widening the bound, and record which it was in the module comment - `src/noise/eval/f32.ts` documents the two-case rule and both known bugs needed opposite fixes.

- [ ] **Step 5: Prove the guard discriminates**

Change `COASTLINE` to `81` in `fulgoraScrap.ts`, re-run, and confirm the first test FAILS. Restore it.

- [ ] **Step 6: Commit**

```bash
git add src/noise/expressions/fulgoraScrap.ts test/fulgoraScrap.spec.ts
git commit -m "feat(fulgora): port the scrap probability expression (#27)"
```

---

### Task 4: The catalog entry and the rolled placement

**Files:**
- Create: `src/noise/resources/fulgoraResourceCatalog.ts`
- Modify: `src/noise/placement/placementRoll.ts` (add one salt)
- Test: `test/fulgoraScrapDensity.spec.ts` (create)

**Interfaces:**
- Consumes: `makeFulgoraScrap` from Task 3; `makePlacementSet`, `PLACEMENT_SALT`, `PlacementCollisionBox` from `src/noise/placement/placementRoll`.
- Produces: `SCRAP_MAP_COLOR: readonly [number, number, number]`; `SCRAP_COLLISION_BOX: PlacementCollisionBox`; `makeFulgoraScrapPlacement(stack: FulgoraStack, controls?: FulgoraScrapControls): (x: number, y: number) => boolean`. Task 5 calls both the colour and the placement.

- [ ] **Step 1: Add the salt**

In `src/noise/placement/placementRoll.ts`, inside `PLACEMENT_SALT`:

```ts
  fulgoraScrap: 0x3ba58c,
```

- [ ] **Step 2: Write the failing test**

Create `test/fulgoraScrapDensity.spec.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-fulgora-scrap-entities.seed123456.json";
import { makeFulgoraScrap } from "../src/noise/expressions/fulgoraScrap";
import {
  SCRAP_COLLISION_BOX,
  makeFulgoraScrapPlacement,
} from "../src/noise/resources/fulgoraResourceCatalog";
import { makeFulgoraStack } from "../src/noise/tiles/fulgoraCatalog";

interface Case {
  region: { x0: number; y0: number; x1: number; y1: number };
  resources: { x: number; y: number; name: string }[];
  protos: Record<string, { box: { lx: number; ly: number; rx: number; ry: number }; map_grid?: boolean }>;
}

const cases = entities.cases as unknown as Case[];
const stack = makeFulgoraStack({ seed0: entities.seed0 });

describe("Fulgora scrap placement density", () => {
  /**
   * The model's expectation against the game's real entity counts. NOT against
   * the map preview: `map_grid` defaults to true, so the preview draws solid
   * ores in a 2x2-block checkerboard and shows about 0.5 pixels per entity.
   *
   * Asserted as a BAND, not a point. `PLACEMENT_SALT.fulgoraScrap` is arbitrary,
   * so the exact count is one draw; one Poisson sigma at n = 770 is 3.6%.
   */
  it("the expectation lands within 10% of the game's entity count overall", () => {
    const scrap = makeFulgoraScrap(stack);
    let expected = 0;
    let actual = 0;
    for (const c of cases) {
      actual += c.resources.length;
      for (let y = c.region.y0; y < c.region.y1; y++)
        for (let x = c.region.x0; x < c.region.x1; x++) expected += scrap.probability(x, y);
    }
    expect(actual).toBeGreaterThan(400);
    expect(expected / actual).toBeGreaterThan(0.9);
    expect(expected / actual).toBeLessThan(1.1);
  });

  it("the rolled placement count lands within 20% of the game's, per region", () => {
    const placed = makeFulgoraScrapPlacement(stack);
    for (const c of cases) {
      let n = 0;
      for (let y = c.region.y0; y < c.region.y1; y++)
        for (let x = c.region.x0; x < c.region.x1; x++) if (placed(x, y)) n++;
      const ratio = n / c.resources.length;
      expect(ratio, `region ${String(c.region.x0)},${String(c.region.y0)}`).toBeGreaterThan(0.8);
      expect(ratio, `region ${String(c.region.x0)},${String(c.region.y0)}`).toBeLessThan(1.2);
    }
  });

  /**
   * The collision box is passed and cannot reject anything. Asserting that is
   * better than omitting the box and leaving a reader to wonder whether it was
   * forgotten. The game snaps 0.1 to the 1/256 grid, hence 0.09765625.
   */
  it("the collision box is the game's, and is too small to reject", () => {
    const box = cases[0].protos["scrap"].box;
    expect(box.rx).toBe(0.09765625);
    expect(SCRAP_COLLISION_BOX.w).toBeCloseTo(box.rx - box.lx, 10);
    expect(SCRAP_COLLISION_BOX.w).toBeLessThan(1);
  });

  it("scrap keeps the map_grid default, which is why the preview cannot gate this", () => {
    expect(cases[0].protos["scrap"].map_grid).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vp test test/fulgoraScrapDensity.spec.ts`
Expected: FAIL - cannot find module `../src/noise/resources/fulgoraResourceCatalog`.

- [ ] **Step 4: Write the catalog**

Create `src/noise/resources/fulgoraResourceCatalog.ts`:

```ts
/**
 * Fulgora's one resource: scrap.
 *
 * Unlike the Nauvis and Vulcanus catalogs there is no `threshold` mode here, and
 * no `region` function, because scrap does not use
 * `resource_autoplace_all_patches`. Its autoplace is a bare
 * `probability_expression` + `richness_expression` pair, and the probability is
 * capped at 0.5 by the Lua's own `min`, so it never saturates into a patch.
 * It ROLLS.
 */
import { makeFulgoraScrap } from "../expressions/fulgoraScrap";
import type { FulgoraScrapControls } from "../expressions/fulgoraScrap";
import { PLACEMENT_SALT, makePlacementSet } from "../placement/placementRoll";
import type { PlacementCollisionBox } from "../placement/placementRoll";
import type { FulgoraStack } from "../tiles/fulgoraCatalog";

/**
 * `map_color = {0.9, 0.9, 0.9}` from the prototype, times 255.
 * Confirmed against the game's own preview pixels: 1098 of 1825 changed pixels
 * are exactly this triple.
 */
export const SCRAP_MAP_COLOR: readonly [number, number, number] = [229, 229, 229];

/**
 * Scrap's `collision_box`, read off the RUNNING GAME rather than from the Lua.
 * The shared `resource()` helper declares `{{-0.1,-0.1},{0.1,0.1}}`, and the
 * game snaps it to the 1/256 grid, so the half-extent is 0.09765625.
 *
 * **It cannot reject anything**, against the Vulcanus geyser's 1.398 half-extent
 * where collision did all of the work. It is passed anyway, and
 * `test/fulgoraScrapDensity.spec.ts` asserts it is inert, so that a reader does
 * not have to wonder whether it was forgotten.
 */
export const SCRAP_COLLISION_BOX: PlacementCollisionBox = {
  w: 0.09765625 * 2,
  h: 0.09765625 * 2,
};

/**
 * The shipped scrap placement predicate.
 *
 * **No `tileAllowed` gate**, and that is a finding rather than an omission: the
 * `fulgora_elevation > fulgora_coastline + 10` term inside the probability put
 * expected scrap on ocean at exactly 0.00 over 262,144 tiles.
 * `test/fulgoraScrap.spec.ts` asserts it.
 */
export function makeFulgoraScrapPlacement(
  stack: FulgoraStack,
  controls: FulgoraScrapControls = {},
): (x: number, y: number) => boolean {
  const scrap = makeFulgoraScrap(stack, controls);
  return makePlacementSet({
    salt: PLACEMENT_SALT.fulgoraScrap,
    probability: scrap.probability,
    collisionBox: () => SCRAP_COLLISION_BOX,
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vp test test/fulgoraScrapDensity.spec.ts`
Expected: PASS, 4 tests.

**If the roll count test fails**, print the per-region ratios first. The expectation test failing too points at the field; only the roll test failing points at the salt or the collision pass.

- [ ] **Step 6: Prove the density guard discriminates**

Temporarily double the probability inside `makeFulgoraScrapPlacement` (`probability: (x, y) => scrap.probability(x, y) * 2`), re-run, and confirm both count tests FAIL. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/noise/resources/fulgoraResourceCatalog.ts src/noise/placement/placementRoll.ts test/fulgoraScrapDensity.spec.ts
git commit -m "feat(fulgora): roll scrap placement against the game's entity counts (#27)"
```

---

### Task 5: The renderer and the dispatch

**Files:**
- Create: `src/noise/preview/renderFulgoraResources.ts`
- Modify: `src/noise/preview/elevationRenderRequest.ts:371-391`
- Modify: `test/tiledEquality.spec.ts`

**Interfaces:**
- Consumes: `SCRAP_MAP_COLOR`, `makeFulgoraScrapPlacement` from Task 4; `FulgoraStack` from Task 2.
- Produces: `renderFulgoraResources(base: ImageData, opts: RenderFulgoraResourcesOptions): void`, mutating `base` in place.

- [ ] **Step 1: Write the renderer**

Create `src/noise/preview/renderFulgoraResources.ts`:

```ts
/**
 * Composite the Fulgora scrap overlay onto a terrain `ImageData`: sweep the same
 * pixel grid as `renderFulgoraTerrain` and paint `SCRAP_MAP_COLOR` where the
 * roll hits. Mutates `base` in place. Mirrors `renderVulcanusResources`.
 *
 * **1x1 marks, not the shared 3x3 `PLACEMENT_MARK_RADIUS_PX`.** Scrap reaches
 * the 0.5 probability cap over contiguous pockets - about one entity per 36 to
 * 83 land tiles - so a 3x3 mark would merge those into a blob. This is the same
 * reasoning Vulcanus rocks use. The geyser gets 3x3 because it is roughly one
 * entity per 3000 tiles and a single pixel disappears.
 *
 * Painting 1x1 also means this pass needs no `sweepBox` halo: a mark cannot
 * cross a worker-tile seam, so the tiled render is byte-identical without one.
 */
import {
  SCRAP_MAP_COLOR,
  makeFulgoraScrapPlacement,
} from "../resources/fulgoraResourceCatalog";
import type { FulgoraScrapControls } from "../expressions/fulgoraScrap";
import { makeFulgoraStack } from "../tiles/fulgoraCatalog";
import type { FulgoraStack } from "../tiles/fulgoraCatalog";
import type { FulgoraCtx } from "../expressions/fulgoraShared";

export interface RenderFulgoraResourcesOptions {
  /** Shared field DAG - see `RenderFulgoraTerrainOptions.stack`. */
  readonly stack?: FulgoraStack;
  /** Map seed as the noise program sees it - the FULGORA SURFACE seed. */
  readonly seed0: number;
  readonly originX?: number;
  readonly originY?: number;
  readonly tilesPerPixel?: number;
  readonly ctx?: Omit<FulgoraCtx, "seed0">;
  readonly scrapControls?: FulgoraScrapControls;
}

export function renderFulgoraResources(
  base: ImageData,
  opts: RenderFulgoraResourcesOptions,
): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const stack = opts.stack ?? makeFulgoraStack({ seed0: opts.seed0, ...opts.ctx });
  const placed = makeFulgoraScrapPlacement(stack, opts.scrapControls);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      if (!placed(wx, wy)) continue;
      const o = (py * width + px) * 4;
      base.data[o] = SCRAP_MAP_COLOR[0];
      base.data[o + 1] = SCRAP_MAP_COLOR[1];
      base.data[o + 2] = SCRAP_MAP_COLOR[2];
      base.data[o + 3] = 255;
    }
  }
}
```

- [ ] **Step 2: Wire it into the dispatch**

Replace the Fulgora branch at `src/noise/preview/elevationRenderRequest.ts:371-391` with:

```ts
    if (planet === "fulgora") {
      // Fulgora has a resources overlay now; it still has no cliffs and no
      // rocks, so those views fall back to plain terrain - the same fallback
      // the Vulcanus branch applies to the overlays it lacks. A view that asks
      // for an overlay this planet has no port for gets the terrain, never a
      // Nauvis field composited onto another planet's colours.
      const fulgoraCtx = {
        islandsFrequency: req.fulgoraIslandControls?.frequency,
        islandsSize: req.fulgoraIslandControls?.size,
      };
      const stack =
        req.unsharedStacks === true
          ? undefined
          : makeFulgoraStack({ seed0: req.seed0, ...fulgoraCtx });
      image = renderFulgoraTerrain({
        seed0: req.seed0,
        width: req.width,
        height: req.height,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        ctx: fulgoraCtx,
        stack,
      });
      if (req.view === "resources" || req.view === "all") {
        renderFulgoraResources(image, {
          seed0: req.seed0,
          originX: req.originX,
          originY: req.originY,
          tilesPerPixel: req.tilesPerPixel,
          ctx: fulgoraCtx,
          scrapControls: req.fulgoraScrapControls,
          stack,
        });
      }
      return { id: req.id, buffer: image.data.buffer, width: req.width, height: req.height };
    }
```

Add to the request interface, beside `fulgoraIslandControls`:

```ts
  /**
   * `control:scrap:frequency` / `:size` - consumed only when `planet: "fulgora"`
   * and the view includes resources. No UI writes this yet; it exists so the
   * renderer reads the levers the game does rather than hardcoding neutral.
   */
  fulgoraScrapControls?: { readonly frequency?: number; readonly size?: number };
```

and import `renderFulgoraResources` and `makeFulgoraStack` at the top.

- [ ] **Step 3: Add the tiled-equality case**

In `test/tiledEquality.spec.ts`, beside the `VULCANUS_VIEWS` loop, add:

```ts
  const FULGORA_VIEWS = ["terrain", "resources", "all"] as const;
  for (const view of FULGORA_VIEWS) {
    it(`fulgora ${view} is byte-identical tiled and untiled`, () => {
      expectTiledEqualsFull({
        planet: "fulgora",
        view,
        seed0: 123456,
        originX: -256,
        originY: 872,
      });
    });
  }
```

Match the existing helper's name and argument shape - read the `VULCANUS_VIEWS` block and copy it exactly rather than guessing. The origin is chosen to sit on the coastline block where scrap is present; **if the resources case passes with zero scrap in the window it proves nothing**, so assert the window is non-empty the way the Vulcanus cases do.

- [ ] **Step 4: Run the tests**

Run: `pnpm vp test test/tiledEquality.spec.ts test/elevationRenderRequest.spec.ts`
Expected: PASS, with three new Fulgora cases.

- [ ] **Step 5: Prove the tiled guard discriminates**

Temporarily give the scrap pass a `sweepBox`-style dependency on the render window (for example, seed the placement from `originX`), re-run, and confirm the `fulgora resources` case FAILS. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/noise/preview/renderFulgoraResources.ts src/noise/preview/elevationRenderRequest.ts test/tiledEquality.spec.ts
git commit -m "feat(fulgora): render the scrap overlay on the resources view (#27)"
```

---

### Task 6: Preview agreement against the game's own image

**Files:**
- Modify: `test/previewAgreement.spec.ts`

**Interfaces:**
- Consumes: the two PNGs from Task 1; the finished render path from Task 5.
- Produces: nothing other tasks read. This is the last task.

- [ ] **Step 1: Write the Fulgora terrain baseline assertion**

Add to `test/previewAgreement.spec.ts`. Note the seed: this compares against a MAP-seed preview, so the surface seed must be derived.

```ts
/** `surfaceSeedForPlanet("fulgora", 123456)` - the preview takes a MAP seed. */
const FULGORA_SURFACE_SEED = 2967702466;

it("Fulgora terrain is pixel-identical to the game's own preview", () => {
  const game = reference("oracle-preview-fulgora-terrain.seed123456.png");
  expect([game.width, game.height]).toEqual([SIZE, SIZE]);
  const ours = render({ seed0: FULGORA_SURFACE_SEED, planet: "fulgora", view: "terrain" });
  let differing = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!same(rgbAt(game.rgb, i), oursAt(ours, i))) differing++;
  }
  // Fulgora has no enemy bases, so unlike the Nauvis case there is nothing to
  // exclude. Bound sized from the measured result - do not widen it.
  expect(differing / (SIZE * SIZE)).toBeLessThan(0.02);
});
```

Run it once and read the actual `differing` fraction before settling the bound. V1 and V2 report 99.86% `get_tile` agreement and 94.5% on the land argmax, both from sampled points, so a whole-image number in the low percent is expected. **Set the bound just above what you measure and write the measured number into the comment.** If it comes out far worse than a couple of percent, that is a real finding about the terrain port, not a bound to widen.

- [ ] **Step 2: Write the scrap superset assertion**

```ts
it("every scrap pixel the game drew is inside our painted region", () => {
  const off = reference("oracle-preview-fulgora-terrain.seed123456.png");
  const on = reference("oracle-preview-fulgora-scrap.seed123456.png");
  const ours = render({ seed0: FULGORA_SURFACE_SEED, planet: "fulgora", view: "resources" });
  const terrain = render({ seed0: FULGORA_SURFACE_SEED, planet: "fulgora", view: "terrain" });

  // A SUPERSET assertion, never equality, and the reason is measured:
  // ResourceEntityPrototype::map_grid defaults to true, so the game draws solid
  // ores in a 2x2-block checkerboard and shows about 0.5 pixels per entity
  // (385 of 770). Requiring equality would bake a 2x under-placement into the
  // renderer. Density is gated by test/fulgoraScrapDensity.spec.ts instead.
  let gameScrap = 0;
  let outside = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (same(rgbAt(off.rgb, i), rgbAt(on.rgb, i))) continue;
    gameScrap++;
    // Ours must differ from our own terrain at that pixel - i.e. we painted
    // scrap there too. Comparing against our terrain rather than against the
    // game's avoids charging this assertion for the terrain residual above.
    if (same(oursAt(ours, i), oursAt(terrain, i))) outside++;
  }
  expect(gameScrap).toBeGreaterThan(1500);
  expect(outside / gameScrap).toBeLessThan(0.05);
});
```

Note this is a superset check on the **footprint**, so run it against a footprint predicate rather than the rolled overlay if the rolled version cannot reach 95%: a roll paints only ~40% of the footprint, so comparing the *rolled* output against the game's drawn pixels will not pass. Read the measured numbers in spec section 2.5 first, and if the rolled overlay cannot support this assertion, assert against `makeFulgoraScrap(stack).probability(x, y) > 0` directly instead of against rendered pixels, and say so in the comment.

- [ ] **Step 3: Assert the map colour**

```ts
it("we paint scrap in the game's own map_color", () => {
  const off = reference("oracle-preview-fulgora-terrain.seed123456.png");
  const on = reference("oracle-preview-fulgora-scrap.seed123456.png");
  let pure = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (same(rgbAt(on.rgb, i), [229, 229, 229])) pure++;
  }
  // map_color = {0.9, 0.9, 0.9} x 255. The game's own preview is where this
  // triple was confirmed, not the Lua alone.
  expect(pure).toBeGreaterThan(1000);
  expect(SCRAP_MAP_COLOR).toEqual([229, 229, 229]);
  expect(off).toBeDefined();
});
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vp test test/previewAgreement.spec.ts`
Expected: PASS. This file is the suite's slowest (72.9s of 503s total); three more 1024x1024 comparisons will add to it.

- [ ] **Step 5: Prove the superset guard discriminates**

Change `FULGORA_SURFACE_SEED` to `123456` (the raw seed - the wrong world), re-run, and confirm the scrap assertion FAILS badly. This is the exact trap the spec's section 2.6 records: the wrong seed scores about 0.5% where the right one scores 99.9%. Restore.

- [ ] **Step 6: Run the full gate**

Run: `pnpm run verify`
Expected: exit 0.

- [ ] **Step 7: Commit and open the PR**

```bash
git add test/previewAgreement.spec.ts
git commit -m "test(fulgora): compare the scrap overlay against the game's own preview (#27)"
git push -u origin <branch>
gh pr create --base main --title "feat(fulgora): scrap resources (#27)" --body "<summary>"
```

---

## Self-Review

**Spec coverage.** Section 1 scope -> Tasks 3 to 5, with richness and the sliders deliberately absent. Section 2.1 (fields already ported) -> Task 3 needs no new expression. 2.2 (composition exact) -> Task 3 Step 1. 2.3 (Bernoulli is right) -> Task 4. 2.4 (`map_grid`, preview cannot gate density) -> Task 4's density test and Task 6's superset framing. 2.5 (colour and position) -> Task 6 Steps 2 and 3. 2.6 (seed trap) -> Global Constraints and Task 6 Step 5. Section 3's three properties -> Task 3's three invariant tests. Section 4 components -> the File Structure table. 4.1 `FulgoraStack` -> Task 2. Section 5 placement, all three decisions -> Task 4. Section 6 fixtures -> Task 1. Section 7 tests -> Tasks 3 to 6. Section 8 risks -> called out at Task 6 Step 4.

**Placeholders.** Two steps deliberately require measuring before fixing a number: Task 6 Step 1's terrain bound and Task 6 Step 2's superset target. Both say what to measure, what the expected magnitude is, and what to do if it is far off - they are instructions to measure, not gaps. Task 5 Step 3 tells the implementer to copy the existing helper's exact shape rather than reproducing a signature I did not verify.

**Type consistency.** `FulgoraStack` fields `{ctx, shared, cells, chain, masks, roads, ruins}` are used with those names in Tasks 3, 4 and 5. `makeFulgoraScrap(stack, controls?)` returns `{probability}` and is called that way in Tasks 4 and 5. `FulgoraScrapControls` `{frequency?, size?}` matches `fulgoraScrapControls` on the render request. `SCRAP_MAP_COLOR` and `SCRAP_COLLISION_BOX` are defined in Task 4 and consumed in Tasks 5 and 6. `makeFulgoraTileResolverFrom` is defined in Task 2 and used in Task 3's ocean test.
