# Vulcanus V2 - Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Vulcanus's three solid ore patches (tungsten, calcite, coal) as a client-side overlay, and restore the three resource-coupling terms the V1 tile catalog left stubbed.

**Architecture:** A new `src/noise/expressions/vulcanusResources.ts` factory joins the existing `makeVulcanus*` chain (helpers -> spawn -> cracks -> biomes -> resources). It exposes four region closures plus `metalTile`. Both consumers read it: the tile argmax (`vulcanusCatalog.ts`) for the coupling terms, and a new overlay renderer for the patches. The spot machinery reuses the already-ported `selectSpots` / `spotCandidatePoints` primitives.

**Tech Stack:** TypeScript, Vue 3, Vite+ (`vp`) with Vitest-compatible tests importing from `"vite-plus/test"`. Factorio 2.1.11 headless + Space Age as the oracle.

## Global Constraints

- Source of truth is `~/GitHub/factorio-data` at tag **2.1.11**. Run `git -C ~/GitHub/factorio-data checkout 2.1.11` before reading any Lua. Do **not** use `~/Downloads/factorio 4/data` (2.0.77, stale).
- **Never edit a fixture or an expected value to make a test pass.** A mismatch is a real finding. This is a standing repo rule.
- Use hyphens (`-`), never em/en dashes, in all files.
- Run `pnpm vp check --fix` before every commit; the full gate is `pnpm run verify`.
- `random_penalty_between(0.9, 1, 1)` is approximated as **1** throughout (see spec, Approximations). Every place this substitution happens gets a comment saying so.
- Richness is **not** ported. No `control:*:richness`, no `vulcanus_starting_area_multiplier`, no `vulcanus_richness_multiplier`.
- Nauvis output must be unchanged. Nothing in `src/noise/resources/resourceCatalog.ts`, `regularPatches.ts`, `resourcePatches.ts`, `resolveResource.ts` or `renderResources.ts` may be modified.
- The spec this implements: `docs/superpowers/specs/2026-07-24-vulcanus-v2-resources-design.md`.

## File Structure

**Create:**

- `src/noise/expressions/vulcanusResources.ts` - the four region closures + `metalTile`, the `vulcanus_spot_noise` wrapper, the four favorabilities, the three `place_*_spots` wrappers, the four `starting_*` spots.
- `src/noise/resources/vulcanusResourceCatalog.ts` - the 3-entry overlay catalog (name, control name, `map_color`, which region).
- `src/noise/preview/renderVulcanusResources.ts` - the overlay compositor.
- `test/vulcanusResources.spec.ts` - oracle parity for every new expression.
- `test/fixtures/oracle-vulcanus-resources.seed123456.json` - captured ground truth.
- `docs/noise/vulcanus-resources-NOTES.md` - findings, residuals, perf numbers.

**Modify:**

- `test/oracle/capture.ts` - add `captureVulcanusResources()`.
- `src/noise/eval/ctx.ts` - one new optional `EvalCtx` field for the resource control levers.
- `src/noise/tiles/vulcanusCatalog.ts` - three new `VulcanusTileFields`; restore four stubbed branches; build the new factory in `makeVulcanusTileResolver`.
- `src/noise/preview/renderVulcanusTerrain.ts` - no change needed (ctx passthrough already exists).
- `src/noise/preview/elevationRenderRequest.ts` - dispatch `view: "resources"` for Vulcanus.
- `src/model/resourceReads.ts` - emit Vulcanus control names too.
- `src/components/ElevationPreviewPanel.vue` - un-gate the Resources toggle for Vulcanus.
- `test/vulcanusTiles.spec.ts` - raise the `get_tile` agreement floor.
- `docs/noise/client-preview-ROADMAP.md` - mark V2 done.

---

### Task 1: Capture the oracle fixture

Nothing can be TDD'd against the game until the ground truth is on disk. This task produces only a fixture. It requires a local Factorio 2.1.11 + Space Age install; the capture is manual and gated, exactly like the existing `vulcanus-cracks` capture.

**Files:**

- Modify: `test/oracle/capture.ts` (add `captureVulcanusResources`, register it in the `want(...)` dispatch near line 2270)
- Create: `test/fixtures/oracle-vulcanus-resources.seed123456.json` (generated, committed)

**Interfaces:**

- Consumes: the existing `sampleExpression(expression, positions, {workDir, seed, spaceAge, planet})` helper and the `Position` type already in `capture.ts`.
- Produces: a fixture whose keys later tasks read - `positions`, `seed0`, `planet`, and one `number[]` per expression: `basaltsFavorability`, `mountainsFavorability`, `mountainsSulfurFavorability`, `ashlandsFavorability`, `startingTungsten`, `startingCoal`, `startingCalcite`, `startingSulfur`, `tungstenRegion`, `coalRegion`, `calciteRegion`, `sulfuricAcidRegion`, `sulfuricAcidPatches`, `sulfuricAcidRegionPatchy`, `metalTile`.

- [ ] **Step 1: Add the capture function**

Insert after `captureVulcanusCracks` in `test/oracle/capture.ts`. The position grid mirrors the cracks capture exactly (a near grid plus three rings plus one deep-field point) so residual bounds are comparable across the Vulcanus specs.

```ts
async function captureVulcanusResources(): Promise<void> {
  const seed = 123456;
  const planet = "vulcanus";
  const positions: Position[] = [];
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      positions.push({ x: gx * 13 - 30 + 0.5, y: gy * 17 - 40 + 0.25 });
    }
  }
  for (const r of [500, 1500, 3300]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      positions.push({ x: r * Math.cos(a) + 0.5, y: r * Math.sin(a) + 0.25 });
    }
  }
  positions.push({ x: 12345.75, y: 6789.125 });

  const sample = async (expression: string): Promise<number[]> => {
    const workDir = await mkdtemp(join(tmpdir(), "oracle-capture-"));
    try {
      return await sampleExpression(expression, positions, {
        workDir,
        seed,
        spaceAge: true,
        planet,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const named: Record<string, string> = {
    basaltsFavorability: "vulcanus_basalts_resource_favorability",
    mountainsFavorability: "vulcanus_mountains_resource_favorability",
    mountainsSulfurFavorability: "vulcanus_mountains_sulfur_favorability",
    ashlandsFavorability: "vulcanus_ashlands_resource_favorability",
    startingTungsten: "vulcanus_starting_tungsten",
    startingCoal: "vulcanus_starting_coal",
    startingCalcite: "vulcanus_starting_calcite",
    startingSulfur: "vulcanus_starting_sulfur",
    tungstenRegion: "vulcanus_tungsten_ore_region",
    coalRegion: "vulcanus_coal_region",
    calciteRegion: "vulcanus_calcite_region",
    sulfuricAcidRegion: "vulcanus_sulfuric_acid_region",
    sulfuricAcidPatches: "vulcanus_sulfuric_acid_patches",
    sulfuricAcidRegionPatchy: "vulcanus_sulfuric_acid_region_patchy",
    metalTile: "vulcanus_metal_tile",
  };

  const captured: Record<string, number[]> = {};
  for (const [key, expression] of Object.entries(named)) {
    captured[key] = await sample(expression);
    console.log(`  captured ${expression}`);
  }

  const fixture = {
    _comment:
      "Ground truth from Factorio 2.1.11 (Space Age enabled) via the test/oracle harness. Vulcanus V2 resource expressions (favorabilities, starting spots, the four regions, the sulfuric-acid patchy chain and vulcanus_metal_tile), each routed onto elevation over a scattered near+far grid, against a real Vulcanus surface (game.planets['vulcanus'].create_surface()) with default control sliders. Regenerate: node --experimental-strip-types test/oracle/capture.ts vulcanus-resources",
    seed0: seed,
    planet,
    positions,
    ...captured,
  };
  const out = join(FIXTURES, "oracle-vulcanus-resources.seed123456.json");
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${out} (${positions.length} points)`);
}
```

- [ ] **Step 2: Register it in the dispatch**

Next to the existing `if (want("vulcanus-cracks")) await captureVulcanusCracks();` line (~2270):

```ts
if (want("vulcanus-resources")) await captureVulcanusResources();
```

- [ ] **Step 3: Run the capture**

Run: `node --experimental-strip-types test/oracle/capture.ts vulcanus-resources`

Expected: 15 `captured ...` lines, then `wrote .../oracle-vulcanus-resources.seed123456.json (61 points)`.

If Factorio or Space Age is not installed locally, this task cannot proceed - stop and report that, rather than hand-writing a fixture.

- [ ] **Step 4: Sanity-check the fixture is not degenerate**

Run: `node -e "const f=require('./test/fixtures/oracle-vulcanus-resources.seed123456.json'); for (const k of ['tungstenRegion','coalRegion','calciteRegion','metalTile']) { const v=f[k]; console.log(k, 'min', Math.min(...v), 'max', Math.max(...v)); }"`

Expected: each region spans a range (not all-identical). A field that is constant across all 61 points means the probe did not resolve the expression - investigate before continuing. `metalTile` being all-zero is *plausible* (no tungsten near these points) but must be cross-checked against `tungstenRegion` being all-negative before it is accepted.

- [ ] **Step 5: Commit**

```bash
git add test/oracle/capture.ts test/fixtures/oracle-vulcanus-resources.seed123456.json
git commit -m "test(vulcanus): capture V2 resource oracle fixture"
```

---

### Task 2: Resource control levers on EvalCtx

The region expressions read `control:tungsten_ore:frequency|size`, `control:vulcanus_coal:*`, `control:calcite:*` and `control:sulfuric_acid_geyser:*`. `makeVulcanusTileResolver` takes only an `EvalCtxInput`, so the levers ride there - as **one** field, not eight.

**Files:**

- Modify: `src/noise/eval/ctx.ts`
- Test: `test/vulcanusResourceCtx.spec.ts` (create)

**Interfaces:**

- Produces: `VulcanusResourceLevers`, `VulcanusResourceControls`, `DEFAULT_VULCANUS_RESOURCE_CONTROLS`, and the `EvalCtx.vulcanusResourceControls` field (required on `EvalCtx`, optional on `EvalCtxInput`, defaulted by `withCtxDefaults`). Tasks 3-8 consume these exact names.

- [ ] **Step 1: Write the failing test**

Create `test/vulcanusResourceCtx.spec.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import { withCtxDefaults } from "../src/noise/eval/ctx";

describe("EvalCtx vulcanusResourceControls", () => {
  it("defaults every Vulcanus resource lever to the neutral 1", () => {
    const ctx = withCtxDefaults({ seed0: 1 });
    expect(ctx.vulcanusResourceControls).toEqual({
      tungstenOre: { frequency: 1, size: 1 },
      vulcanusCoal: { frequency: 1, size: 1 },
      calcite: { frequency: 1, size: 1 },
      sulfuricAcidGeyser: { frequency: 1, size: 1 },
    });
  });

  it("honors an explicit override without mutating the shared default", () => {
    const ctx = withCtxDefaults({
      seed0: 1,
      vulcanusResourceControls: {
        tungstenOre: { frequency: 2, size: 3 },
        vulcanusCoal: { frequency: 1, size: 1 },
        calcite: { frequency: 1, size: 1 },
        sulfuricAcidGeyser: { frequency: 1, size: 1 },
      },
    });
    expect(ctx.vulcanusResourceControls.tungstenOre).toEqual({ frequency: 2, size: 3 });
    expect(withCtxDefaults({ seed0: 1 }).vulcanusResourceControls.tungstenOre).toEqual({
      frequency: 1,
      size: 1,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vp test test/vulcanusResourceCtx.spec.ts`
Expected: FAIL - `vulcanusResourceControls` is `undefined`.

- [ ] **Step 3: Implement**

In `src/noise/eval/ctx.ts`, add above `EvalCtx`:

```ts
/**
 * `control:<resource>:frequency|size` for one Vulcanus resource. Richness is
 * deliberately absent: the client preview renders placement, not yield, so no
 * Vulcanus richness expression is ported (see the V2 design spec).
 */
export interface VulcanusResourceLevers {
  readonly frequency: number;
  readonly size: number;
}

/** The four Vulcanus resource autoplace controls, keyed by their in-code name. */
export interface VulcanusResourceControls {
  readonly tungstenOre: VulcanusResourceLevers;
  readonly vulcanusCoal: VulcanusResourceLevers;
  readonly calcite: VulcanusResourceLevers;
  readonly sulfuricAcidGeyser: VulcanusResourceLevers;
}

/** Neutral/default sliders - the same `1` convention as `vulcanusVolcanismFrequency`. */
export const DEFAULT_VULCANUS_RESOURCE_CONTROLS: VulcanusResourceControls = {
  tungstenOre: { frequency: 1, size: 1 },
  vulcanusCoal: { frequency: 1, size: 1 },
  calcite: { frequency: 1, size: 1 },
  sulfuricAcidGeyser: { frequency: 1, size: 1 },
};
```

Add to the `EvalCtx` interface, after `temperatureBias`:

```ts
  /**
   * `control:<resource>:frequency|size` for the four Vulcanus resources (V2).
   * Consumed only by `makeVulcanusResources`; every other planet ignores it.
   */
  vulcanusResourceControls: VulcanusResourceControls;
```

Add to `withCtxDefaults`'s returned object:

```ts
    vulcanusResourceControls:
      input.vulcanusResourceControls ?? DEFAULT_VULCANUS_RESOURCE_CONTROLS,
```

Do **not** add it to `DEFAULT_CTX_FIELDS` - that object is spread in places that expect plain scalars, and the frozen module-level constant above is the single owner of the default.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vp test test/vulcanusResourceCtx.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Confirm nothing else broke**

Run: `pnpm vp check --fix && pnpm vp test`
Expected: all green. `EvalCtx` gained a required field, so any object literal built without `withCtxDefaults` would fail type-check here - fix by routing it through `withCtxDefaults`, never by making the field optional on `EvalCtx`.

- [ ] **Step 6: Commit**

```bash
git add src/noise/eval/ctx.ts test/vulcanusResourceCtx.spec.ts
git commit -m "feat(vulcanus): plumb Vulcanus resource control levers through EvalCtx"
```

---

### Task 3: Favorabilities and starting spots

The two cheapest halves of the new module, and the ones with no spot-noise risk. Getting them landed first means Task 4's residuals cannot be blamed on them.

**Files:**

- Create: `src/noise/expressions/vulcanusResources.ts`
- Create: `test/vulcanusResources.spec.ts`

**Interfaces:**

- Consumes: `EvalCtx` + `DEFAULT_VULCANUS_RESOURCE_CONTROLS` (Task 2); `VulcanusHelpers` (`wobbleX`, `wobbleY`, `wobbleLargeX`, `wobbleLargeY`); `VulcanusSpawn` (`startingArea`, `startingCircle`, `startingDirection`, `ashlandsAngle`, `mountainsAngle`, `basaltsAngle`, `VULCANUS_STARTING_AREA_RADIUS`); `VulcanusBiomes` (`basaltsBiomeFull`, `mountainsBiomeFull`, `ashlandsBiomeFull`, `mountainVolcanoSpots`); `startingSpotAtAngle` from `vulcanusShared`; `sliderRescale` from `../eval/sliderRescale`; `memoXY`; `clamp`/`min`/`max` from `../eval/math`.
- Produces (used by Tasks 4-7): the module and its partial `VulcanusResources` interface. Task 4 fills in the region members.

- [ ] **Step 1: Write the failing test**

Create `test/vulcanusResources.spec.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-resources.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusBiomes } from "../src/noise/expressions/vulcanusBiomes";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { makeVulcanusResources } from "../src/noise/expressions/vulcanusResources";
import { makeVulcanusSpawn } from "../src/noise/expressions/vulcanusSpawn";

describe("makeVulcanusResources", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);
  const positions = fixture.positions;

  // Bounds are the measured worst residual with modest headroom, dominated by
  // the deep-field point (index 60) - the f32 coordinate floor documented across
  // the other vulcanus specs.
  const check = (
    field: (x: number, y: number) => number,
    want: number[],
    bound: number,
  ): void => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      worst = Math.max(worst, Math.abs(field(p.x, p.y) - want[i]));
    }
    expect(worst).toBeLessThan(bound);
  };

  it("vulcanus_basalts_resource_favorability matches the oracle", () => {
    check(resources.basaltsFavorability, fixture.basaltsFavorability, 4e-3);
  });

  it("vulcanus_mountains_resource_favorability matches the oracle", () => {
    check(resources.mountainsFavorability, fixture.mountainsFavorability, 4e-3);
  });

  it("vulcanus_mountains_sulfur_favorability matches the oracle", () => {
    check(resources.mountainsSulfurFavorability, fixture.mountainsSulfurFavorability, 4e-3);
  });

  it("vulcanus_ashlands_resource_favorability matches the oracle", () => {
    check(resources.ashlandsFavorability, fixture.ashlandsFavorability, 4e-3);
  });

  it("vulcanus_starting_tungsten matches the oracle", () => {
    check(resources.startingTungsten, fixture.startingTungsten, 4e-3);
  });

  it("vulcanus_starting_coal matches the oracle", () => {
    check(resources.startingCoal, fixture.startingCoal, 4e-3);
  });

  it("vulcanus_starting_calcite matches the oracle", () => {
    check(resources.startingCalcite, fixture.startingCalcite, 4e-3);
  });

  it("vulcanus_starting_sulfur matches the oracle", () => {
    check(resources.startingSulfur, fixture.startingSulfur, 4e-3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vp test test/vulcanusResources.spec.ts`
Expected: FAIL - cannot resolve `../src/noise/expressions/vulcanusResources`.

- [ ] **Step 3: Implement**

Create `src/noise/expressions/vulcanusResources.ts`:

```ts
/**
 * Vulcanus's resource region fields (`planet-vulcanus-map-gen.lua` lines ~560-862,
 * `~/GitHub/factorio-data` tag 2.1.11). These are read by BOTH consumers: the tile
 * argmax (`vulcanus_metal_tile`, `vulcanus_calcite_region` and
 * `vulcanus_sulfuric_acid_region_patchy` appear inside four `*_range` expressions)
 * and the resource overlay - which is why they live here in `expressions/` rather
 * than beside the renderer.
 *
 * Two deliberate approximations, per the V2 design spec:
 *
 * 1. `random_penalty_between(0.9, 1, 1)` -> 1. It appears in every `*_probability`
 *    expression. `random_penalty` is a batch op whose value depends on the whole
 *    batch and its order (docs/noise/random-penalty-NOTES.md), so a per-pixel
 *    renderer cannot reproduce it; at rp = 1 the probability collapses to
 *    `1000 * region` and the penalty only perturbs the razor edge of a patch.
 * 2. Richness is not ported at all - the preview renders placement, not yield.
 */
import { distanceFromNearestPoint } from "../distanceFromNearestPoint";
import type { EvalCtx } from "../eval/ctx";
import { clamp, max, min } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import { sliderRescale } from "../eval/sliderRescale";
import type { VulcanusBiomes } from "./vulcanusBiomes";
import type { VulcanusCracks } from "./vulcanusCracks";
import type { VulcanusHelpers } from "./vulcanusHelpers";
import { startingSpotAtAngle } from "./vulcanusShared";
import { VULCANUS_STARTING_AREA_RADIUS, type VulcanusSpawn } from "./vulcanusSpawn";

export interface VulcanusResources {
  /** `vulcanus_basalts_resource_favorability` (tungsten). */
  basaltsFavorability(x: number, y: number): number;
  /** `vulcanus_mountains_resource_favorability` (calcite) - buffer 0.4, minus the volcano-peak term. */
  mountainsFavorability(x: number, y: number): number;
  /** `vulcanus_mountains_sulfur_favorability` - buffer 0.3, NO volcano-peak term. */
  mountainsSulfurFavorability(x: number, y: number): number;
  /** `vulcanus_ashlands_resource_favorability` (coal). */
  ashlandsFavorability(x: number, y: number): number;
  /** `vulcanus_starting_tungsten`. */
  startingTungsten(x: number, y: number): number;
  /** `vulcanus_starting_coal`. */
  startingCoal(x: number, y: number): number;
  /** `vulcanus_starting_calcite`. */
  startingCalcite(x: number, y: number): number;
  /** `vulcanus_starting_sulfur` (max of two spots). */
  startingSulfur(x: number, y: number): number;
}

/** `vulcanus_ore_spacing` (suggested_minimum_candidate_point_spacing). */
export const VULCANUS_ORE_SPACING = 128;

export function makeVulcanusResources(
  ctx: EvalCtx,
  helpers: VulcanusHelpers,
  spawn: VulcanusSpawn,
  biomes: VulcanusBiomes,
  _cracks: VulcanusCracks,
): VulcanusResources {
  const r = VULCANUS_STARTING_AREA_RADIUS;
  const dir = spawn.startingDirection;
  const levers = ctx.vulcanusResourceControls;

  // vulcanus_resource_wobble_x = vulcanus_wobble_x + 0.25 * vulcanus_wobble_large_x
  // (and y). Note this is a DIFFERENT combination from vulcanusSpawn's three-wobble
  // sum - resources use two wobbles, one of them quarter-weighted.
  const wobbleX = memoXY((x, y) => helpers.wobbleX(x, y) + 0.25 * helpers.wobbleLargeX(x, y));
  const wobbleY = memoXY((x, y) => helpers.wobbleY(x, y) + 0.25 * helpers.wobbleLargeY(x, y));

  // slider_rescale(control:<x>:size, 2) - the "size" the region expressions scale by.
  const tungstenSize = sliderRescale(levers.tungstenOre.size, 2);
  const coalSize = sliderRescale(levers.vulcanusCoal.size, 2);
  const calciteSize = sliderRescale(levers.calcite.size, 2);
  const sulfurSize = sliderRescale(levers.sulfuricAcidGeyser.size, 2);

  // --- favorabilities --------------------------------------------------------
  // All four share clamp((biome_full * (starting_area < 0.01) - buffer) * contrast, 0, 1).
  // `contrast` is 2 everywhere; only `buffer` and the mountains volcano term differ.
  const CONTRAST = 2;
  const favorability = (
    biomeFull: (x: number, y: number) => number,
    buffer: number,
  ): ((x: number, y: number) => number) =>
    memoXY((x, y) =>
      clamp((biomeFull(x, y) * (spawn.startingArea(x, y) < 0.01 ? 1 : 0) - buffer) * CONTRAST, 0, 1),
    );

  const basaltsFavorability = favorability((x, y) => biomes.basaltsBiomeFull(x, y), 0.3);
  const ashlandsFavorability = favorability((x, y) => biomes.ashlandsBiomeFull(x, y), 0.3);
  const mountainsSulfurFavorability = favorability((x, y) => biomes.mountainsBiomeFull(x, y), 0.3);

  // mountains (calcite) is the odd one out: buffer 0.4 AND it subtracts the
  // volcano-peak indicator. Do not collapse it with mountainsSulfurFavorability.
  const mountainsMainRegion = favorability((x, y) => biomes.mountainsBiomeFull(x, y), 0.4);
  const mountainsFavorability = memoXY((x, y) =>
    clamp(mountainsMainRegion(x, y) - (biomes.mountainVolcanoSpots(x, y) > 0.78 ? 1 : 0), 0, 1),
  );

  // --- starting spots --------------------------------------------------------
  // `x_from_start`/`y_from_start` are the raw world (x, y) at the default origin
  // spawn (the Task 2 finding recorded in vulcanusShared.ts).
  const startingTungsten = memoXY((x, y) =>
    startingSpotAtAngle({
      angle: spawn.basaltsAngle - 10 * dir,
      distance: 450 * r,
      // Deliberately NOT slider-scaled in the source: "don't use the slider for
      // radius because it can make tungsten in the safe area".
      radius: 30 / 1.5,
      xDistortion: 0.5 * wobbleX(x, y),
      yDistortion: 0.5 * wobbleY(x, y),
      xFromStart: x,
      yFromStart: y,
    }),
  );

  const startingCoal = memoXY((x, y) =>
    startingSpotAtAngle({
      angle: spawn.ashlandsAngle + 15 * dir,
      distance: 180 * r,
      radius: 30 * coalSize,
      xDistortion: 0.5 * wobbleX(x, y),
      yDistortion: 0.5 * wobbleY(x, y),
      xFromStart: x,
      yFromStart: y,
    }),
  );

  const startingCalcite = memoXY((x, y) =>
    startingSpotAtAngle({
      angle: spawn.mountainsAngle - 20 * dir,
      distance: 350 * r,
      radius: (35 / 1.5) * calciteSize,
      xDistortion: 0.5 * wobbleX(x, y),
      yDistortion: 0.5 * wobbleY(x, y),
      xFromStart: x,
      yFromStart: y,
    }),
  );

  const startingSulfur = memoXY((x, y) =>
    max(
      startingSpotAtAngle({
        angle: spawn.mountainsAngle + 10 * dir,
        distance: 590 * r,
        radius: 30,
        xDistortion: 0.75 * wobbleX(x, y),
        yDistortion: 0.75 * wobbleY(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
      startingSpotAtAngle({
        angle: spawn.mountainsAngle + 30 * dir,
        distance: 200 * r,
        radius: 25 * sulfurSize,
        xDistortion: 0.75 * wobbleX(x, y),
        yDistortion: 0.75 * wobbleY(x, y),
        xFromStart: x,
        yFromStart: y,
      }),
    ),
  );

  return {
    basaltsFavorability,
    mountainsFavorability,
    mountainsSulfurFavorability,
    ashlandsFavorability,
    startingTungsten,
    startingCoal,
    startingCalcite,
    startingSulfur,
  };
}
```

Note: `min` and `distanceFromNearestPoint` are imported for Task 4; if the linter flags them as unused now, add them in Task 4 instead of leaving unused imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vp test test/vulcanusResources.spec.ts`
Expected: PASS (8 tests).

If a favorability mismatches, first check the `< 0.01` comparison direction and the buffer values (0.3 vs 0.4) - those are the two easiest to invert. **Do not widen the bound to make it pass.**

- [ ] **Step 5: Commit**

```bash
git add src/noise/expressions/vulcanusResources.ts test/vulcanusResources.spec.ts
git commit -m "feat(vulcanus): port resource favorabilities and starting ore spots"
```

---

### Task 4: The spot-noise wrapper and the four regions

The risky half. This is where `spot_favorability_expression` runs with a discriminating (0/1) favorability for the first time in this codebase, and where the wobbled sample position determines region membership.

**Files:**

- Modify: `src/noise/expressions/vulcanusResources.ts`
- Modify: `test/vulcanusResources.spec.ts`

**Interfaces:**

- Consumes: `selectSpots` + `SelectedSpot` from `../spotSelection`, `SpotRegionKey` from `../spotCandidates`, `fastCbrt` from `../fastApprox`, `makeMultioctaveNoise` from `../multioctaveNoise`, plus everything Task 3 built.
- Produces: `VulcanusResources` gains `tungstenRegion`, `coalRegion`, `calciteRegion`, `sulfuricAcidRegion`, `sulfuricAcidPatches`, `sulfuricAcidRegionPatchy`, `metalTile`. Tasks 5-7 consume these names.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` in `test/vulcanusResources.spec.ts`:

```ts
  it("vulcanus_tungsten_ore_region matches the oracle", () => {
    check(resources.tungstenRegion, fixture.tungstenRegion, 4e-3);
  });

  it("vulcanus_coal_region matches the oracle", () => {
    check(resources.coalRegion, fixture.coalRegion, 4e-3);
  });

  it("vulcanus_calcite_region matches the oracle", () => {
    check(resources.calciteRegion, fixture.calciteRegion, 4e-3);
  });

  it("vulcanus_sulfuric_acid_region matches the oracle", () => {
    check(resources.sulfuricAcidRegion, fixture.sulfuricAcidRegion, 4e-3);
  });

  it("vulcanus_sulfuric_acid_patches matches the oracle", () => {
    check(resources.sulfuricAcidPatches, fixture.sulfuricAcidPatches, 4e-3);
  });

  it("vulcanus_sulfuric_acid_region_patchy matches the oracle", () => {
    check(resources.sulfuricAcidRegionPatchy, fixture.sulfuricAcidRegionPatchy, 4e-3);
  });

  // AMENDED 2026-07-24 after Task 1's fixture landed. The original plan asserted
  // `check(resources.metalTile, fixture.metalTile, 4)` on the premise that
  // rp -> 1 makes metal_tile exactly `max(0, 1000 * region)`. The captured oracle
  // disproves that: worst |diff| is 132.86 (idx 341: region 0.4387, approx
  // 438.70, oracle 305.84), ~30x the proposed tolerance, and at small regions the
  // penalty flips placement outright (idx 733/769 have region > 0 but
  // metal_tile == 0). random_penalty is a batch op and cannot be reproduced
  // per-pixel, so rp -> 1 stays - but it is an UPPER BOUND, not an equality.
  //
  // The envelope assertion below is strictly stronger than a tolerance: it pins
  // our tungstenRegion AND proves rp -> 1 is the documented ceiling. Verified to
  // hold at all 1085 fixture points with zero violations; the implied p over the
  // 8 region > 0 points spans [0.9077, 0.9748].
  it("vulcanus_metal_tile sits inside the random_penalty envelope", () => {
    let violations = 0;
    let worstBelow = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const region = resources.tungstenRegion(p.x, p.y);
      const lo = Math.max(0, 1000 * ((1 + region) * 0.9 - 1));
      const hi = Math.max(0, 1000 * ((1 + region) * 1.0 - 1));
      const got = fixture.metalTile[i];
      if (got < lo - 1e-3 || got > hi + 1e-3) violations++;
      worstBelow = Math.max(worstBelow, hi - got);
    }
    expect(violations).toBe(0);
    // Guard against a degenerate pass: if our region were 0 everywhere, lo and hi
    // would both collapse to 0 and every point would trivially satisfy the
    // envelope. At least one point must have a non-trivial envelope width.
    expect(worstBelow).toBeGreaterThan(1);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vp test test/vulcanusResources.spec.ts`
Expected: FAIL - `resources.tungstenRegion is not a function` (7 new failures, 8 prior tests still passing).

- [ ] **Step 3: Implement the spot-noise wrapper**

First rename the factory's unused-in-Task-3 parameter: `_cracks: VulcanusCracks` becomes `cracks: VulcanusCracks`. Task 4 is where it starts being read (`place_metal_spots` subtracts `hairlineCracks / 30000`), so the underscore that kept the linter quiet is no longer wanted. Use `cracks.hairlineCracks(...)` in the code below.

Then add to `src/noise/expressions/vulcanusResources.ts`. First the imports:

```ts
import { fastCbrt } from "../fastApprox";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import type { SpotRegionKey } from "../spotCandidates";
import { selectSpots, type SelectedSpot } from "../spotSelection";
```

Then module-level constants, next to `VULCANUS_ORE_SPACING`:

```ts
/** `basement_value` for every Vulcanus resource spot_noise call. */
const BASEMENT_VALUE = -1;
/** `maximum_spot_basement_radius` - the per-query cone cull radius. */
const MAX_SPOT_BASEMENT_RADIUS = 128;
/** `skip_span` - all four resources partition one candidate stream three ways. */
const SKIP_SPAN = 3;

const f32 = Math.fround;
```

Then, inside `makeVulcanusResources` (after the wobbles, before the favorabilities):

```ts
  const distanceAt = memoXY((x, y) => distanceFromNearestPoint(x, y, ctx.startingPositions));
  /** `vulcanus_ore_dist = max(1, distance / 4000)`. */
  const oreDist = (x: number, y: number): number => max(1, distanceAt(x, y) / 4000);

  interface SpotNoiseParams {
    /** `seed1` (the `seed` parameter of vulcanus_spot_noise). */
    readonly seed1: number;
    readonly candidateSpotCount: number;
    readonly skipOffset: number;
    /** `region_size`. Fractional values are floored - see the note below. */
    readonly regionSize: number;
    /** `density_expression`, evaluated at accepted spot positions. */
    readonly density: (x: number, y: number) => number;
    /** `spot_quantity_expression`, evaluated at accepted spot positions. */
    readonly quantity: (x: number, y: number) => number;
    /** `spot_radius_expression`, evaluated at accepted spot positions. */
    readonly radius: (x: number, y: number) => number;
    /** `spot_favorability_expression`, evaluated at accepted spot positions. */
    readonly favorability: (x: number, y: number) => number;
  }

  /**
   * `vulcanus_spot_noise{...}` - the shared noise-function wrapper.
   *
   * The wrapper samples at `(x + resource_wobble_x, y + resource_wobble_y)`, so the
   * WOBBLED coordinate is what selects the region and what the cone distance is
   * measured from. Using the raw coordinate for region lookup produces a
   * plausible-looking but wrong field.
   *
   * `hard_region_target_quantity = 0` => no last-spot shrink, so `coneScale` is
   * always 1; it is still applied below so the cone math stays faithful if that
   * ever changes.
   */
  const makeSpotNoise = (p: SpotNoiseParams): ((x: number, y: number) => number) => {
    // region_size can be fractional at a non-default frequency slider (500 + 500/f).
    // selectSpots uses it as an integer modulus, so floor it. Only the default
    // (f = 1, an exact integer) is oracle-covered - see vulcanus-resources-NOTES.md.
    const rs = Math.floor(p.regionSize);
    const half = rs / 2;
    const regionIndex = (c: number): number => Math.floor((c + half) / rs);

    const cache = new Map<string, SelectedSpot[]>();
    const regionSpots = (rX: number, rY: number): SelectedSpot[] => {
      const key = `${rX},${rY}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const regionKey: SpotRegionKey = {
        seed0: ctx.seed0,
        seed1: p.seed1,
        regionX: rX,
        regionY: rY,
      };
      const spots = selectSpots(regionKey, {
        density: p.density,
        quantity: p.quantity,
        favorability: p.favorability,
        regionSize: rs,
        candidateSpotCount: p.candidateSpotCount,
        spacing: VULCANUS_ORE_SPACING,
        skipSpan: SKIP_SPAN,
        skipOffset: p.skipOffset,
        hardRegionTargetQuantity: false,
      });
      cache.set(key, spots);
      return spots;
    };

    return (x: number, y: number): number => {
      const sx = x + wobbleX(x, y);
      const sy = y + wobbleY(x, y);
      let best = BASEMENT_VALUE;
      const rXlo = regionIndex(sx - MAX_SPOT_BASEMENT_RADIUS);
      const rXhi = regionIndex(sx + MAX_SPOT_BASEMENT_RADIUS);
      const rYlo = regionIndex(sy - MAX_SPOT_BASEMENT_RADIUS);
      const rYhi = regionIndex(sy + MAX_SPOT_BASEMENT_RADIUS);
      for (let rX = rXlo; rX <= rXhi; rX++) {
        for (let rY = rYlo; rY <= rYhi; rY++) {
          for (const s of regionSpots(rX, rY)) {
            const dx = sx - s.x;
            const dy = sy - s.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > MAX_SPOT_BASEMENT_RADIUS * MAX_SPOT_BASEMENT_RADIUS) continue;
            // Same f32 cone arithmetic as the Nauvis regular patches: the game
            // renders the cone in the f32 noise machine (see regularPatches.ts).
            const radius = f32(p.radius(s.x, s.y) * s.coneScale);
            if (radius <= 0) continue;
            const peak = f32(f32(3 * s.quantity) / f32(f32(Math.PI * radius) * radius));
            const cone = f32(peak - f32(f32(Math.sqrt(d2)) * f32(peak / radius)));
            if (cone > best) best = cone;
          }
        }
      }
      return best;
    };
  };
```

`fastCbrt` is imported for parity with `regularPatches`' cone-scale path; if it ends up unused because `hardRegionTargetQuantity` is false, drop the import rather than leaving it dangling.

- [ ] **Step 4: Implement the three `place_*_spots` wrappers and the four regions**

Still inside `makeVulcanusResources`, after the favorabilities and starting spots:

```ts
  /** The shared `size` expression: `slider_rescale(size, 2) * min(1.2, ore_dist) * 25`. */
  const sizeExpr =
    (sizeRescaled: number) =>
    (x: number, y: number): number =>
      sizeRescaled * min(1.2, oreDist(x, y)) * 25;

  interface PlaceParams {
    readonly seed1: number;
    readonly candidateSpotCount: number;
    readonly skipOffset: number;
    readonly size: (x: number, y: number) => number;
    /** RAW `control:<x>:frequency` (NOT slider_rescaled - the source passes it through). */
    readonly frequency: number;
    readonly favor: (x: number, y: number) => number;
  }

  /** The spot_noise half shared by all three `vulcanus_place_*_spots` functions. */
  const placeSpots = (p: PlaceParams, regionBase: number): ((x: number, y: number) => number) =>
    makeSpotNoise({
      seed1: p.seed1,
      candidateSpotCount: p.candidateSpotCount,
      skipOffset: p.skipOffset,
      regionSize: regionBase + regionBase / p.frequency,
      density: (x, y) => p.favor(x, y) * 4,
      quantity: (x, y) => p.size(x, y) * p.size(x, y),
      radius: (x, y) => p.size(x, y),
      favorability: (x, y) => (p.favor(x, y) > 0.9 ? 1 : 0),
    });

  /** `vulcanus_place_metal_spots` - region_size 500 + 500/freq, plus the crack term. */
  const placeMetalSpots = (p: PlaceParams): ((x: number, y: number) => number) => {
    const spot = placeSpots(p, 500);
    return (x, y) =>
      min(
        clamp(-1 + 4 * p.favor(x, y), -1, 1),
        spot(x, y) - cracks.hairlineCracks(x, y) / 30000,
      );
  };

  /** `vulcanus_place_sulfur_spots` - region_size 450 + 450/freq. */
  const placeSulfurSpots = (p: PlaceParams): ((x: number, y: number) => number) => {
    const spot = placeSpots(p, 450);
    return (x, y) => min(2 * p.favor(x, y) - 1, spot(x, y));
  };

  /** `vulcanus_place_non_metal_spots` - region_size 400 + 400/freq. */
  const placeNonMetalSpots = (p: PlaceParams): ((x: number, y: number) => number) => {
    const spot = placeSpots(p, 400);
    return (x, y) => min(2 * p.favor(x, y) - 1, spot(x, y));
  };

  // --- the four regions ------------------------------------------------------
  // Each is max(starting_<ore>, min(1 - starting_circle, place_*(...))).
  const region = (
    starting: (x: number, y: number) => number,
    placed: (x: number, y: number) => number,
  ): ((x: number, y: number) => number) =>
    memoXY((x, y) => max(starting(x, y), min(1 - spawn.startingCircle(x, y), placed(x, y))));

  const tungstenRegion = region(
    startingTungsten,
    placeMetalSpots({
      seed1: 789,
      candidateSpotCount: 15,
      skipOffset: 2,
      size: sizeExpr(tungstenSize),
      frequency: levers.tungstenOre.frequency,
      favor: basaltsFavorability,
    }),
  );

  const coalRegion = region(
    startingCoal,
    placeNonMetalSpots({
      seed1: 782349,
      candidateSpotCount: 12,
      skipOffset: 1,
      size: sizeExpr(coalSize),
      frequency: levers.vulcanusCoal.frequency,
      favor: ashlandsFavorability,
    }),
  );

  const calciteRegion = region(
    startingCalcite,
    placeNonMetalSpots({
      seed1: 749,
      candidateSpotCount: 12,
      skipOffset: 1,
      size: sizeExpr(calciteSize),
      frequency: levers.calcite.frequency,
      favor: mountainsFavorability,
    }),
  );

  const sulfuricAcidRegion = region(
    startingSulfur,
    placeSulfurSpots({
      seed1: 759,
      candidateSpotCount: 9,
      skipOffset: 0,
      size: sizeExpr(sulfurSize),
      frequency: levers.sulfuricAcidGeyser.frequency,
      favor: mountainsSulfurFavorability,
    }),
  );

  // --- the sulfuric-acid patchy chain (terrain input only, no overlay) --------
  const patchNoise = makeMultioctaveNoise({
    seed0: ctx.seed0,
    seed1: 21000,
    octaves: 2,
    persistence: 0.7,
    inputScale: 1 / 3,
    outputScale: 1,
  });
  const sulfuricAcidPatches = memoXY((x, y) => 0.8 * Math.abs(patchNoise(x, y)));
  const sulfuricAcidRegionPatchy = memoXY(
    (x, y) => (1 + sulfuricAcidRegion(x, y)) * (0.5 + 0.5 * sulfuricAcidPatches(x, y)) - 1,
  );

  // vulcanus_metal_tile = max(0, vulcanus_tungsten_ore_probability), where
  // probability = (control:tungsten_ore:size > 0) * 1000 * ((1 + region) * rp - 1)
  // and rp -> 1 (approximation 1), so it collapses to 1000 * region.
  const metalTile = memoXY((x, y) =>
    levers.tungstenOre.size > 0 ? max(0, 1000 * tungstenRegion(x, y)) : 0,
  );
```

Add all seven to the returned object and to the `VulcanusResources` interface (with the same doc-comment style as Task 3's members).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/vulcanusResources.spec.ts`
Expected: PASS (15 tests).

Debug order if a region mismatches, cheapest first:

1. `sulfuricAcidPatches` - a pure multioctave, no spot machinery. If *this* is wrong, the problem is the noise params, not spot selection.
2. Whether the wobble is applied to the sample position (it must be) and whether region indexing uses the wobbled coordinate (it must).
3. `skipOffset` / `seed1` / `candidateSpotCount` per resource, against the table in the spec.
4. Only then suspect `selectSpots` itself. A `selectSpots` bug surfacing here is a **genuine finding** (the favorability-sorted trim has never run with a discriminating favorability) - write it up in `docs/noise/vulcanus-resources-NOTES.md` and fix `selectSpots`, do not special-case it in this module. Re-run `pnpm vp test` in full afterwards: `selectSpots` is shared with Nauvis M3.

- [ ] **Step 6: Commit**

```bash
git add src/noise/expressions/vulcanusResources.ts test/vulcanusResources.spec.ts
git commit -m "feat(vulcanus): port the resource spot-noise wrapper and four region fields"
```

---

### Task 5: Restore the tile coupling

**Files:**

- Modify: `src/noise/tiles/vulcanusCatalog.ts`
- Modify: `test/vulcanusTiles.spec.ts:20-44` (the comment and the agreement floor)

**Interfaces:**

- Consumes: `makeVulcanusResources` and its `metalTile` / `calciteRegion` / `sulfuricAcidRegionPatchy` members (Task 4).
- Produces: `VulcanusTileFields` gains `metalTile`, `calciteRegion`, `sulfuricAcidRegionPatchy`. No other consumer.

- [ ] **Step 1: Measure the current agreement**

Run: `pnpm vp test test/vulcanusTiles.spec.ts`

Note the reported agreement (currently documented as 96.85%, 369/381). Record the exact number - Step 6 compares against it. If the test does not print it, add a temporary `console.log(agreement)` and remove it before committing.

- [ ] **Step 2: Add the three fields to `VulcanusTileFields`**

In `src/noise/tiles/vulcanusCatalog.ts`, extend the interface (~line 47):

```ts
  /** `vulcanus_metal_tile = max(0, vulcanus_tungsten_ore_probability)` (V2). */
  metalTile(x: number, y: number): number;
  /** `vulcanus_calcite_region` (V2). */
  calciteRegion(x: number, y: number): number;
  /** `vulcanus_sulfuric_acid_region_patchy` (V2). */
  sulfuricAcidRegionPatchy(x: number, y: number): number;
```

- [ ] **Step 3: Restore the four stubbed branches**

`lava_basalts_range` (~line 117) - the `100` becomes the real cap:

```ts
  const lavaBasaltsRange = (x: number, y: number): number =>
    100 *
    min(
      f.basaltsBiome(x, y) *
        lavaSpawnExcluder(x, y) *
        rangeSelectBase(f.elev(x, y), -5000, 0, 1, -1000, 1),
      100 * (1 - f.metalTile(x, y)),
    );
```

`lava_hot_basalts_range` (~line 129) - same cap:

```ts
  const lavaHotBasaltsRange = (x: number, y: number): number =>
    200 *
    min(
      f.basaltsBiome(x, y) *
        lavaSpawnExcluder(x, y) *
        rangeSelectBase(f.elev(x, y), -5000, min(0, 5 * (-2 + 4 * f.rockNoise(x, y))), 1, -1000, 1),
      100 * (1 - f.metalTile(x, y)),
    );
```

`volcanic_cracks_warm_range` (~line 145) - drop the "dropped" comment, add the term:

```ts
  const volcanicCracksWarmRange = (x: number, y: number): number =>
    f.basaltsBiome(x, y) * rangeSelectBase(f.elev(x, y), 8, 22, 1, 0, 5) +
    (f.aux(x, y) - 0.05) +
    50000 * f.metalTile(x, y);
```

`volcanic_smooth_stone_warm_range` (~line 153):

```ts
  const volcanicSmoothStoneWarmRange = (x: number, y: number): number =>
    f.basaltsBiome(x, y) * rangeSelectBase(f.elev(x, y), 8, 20, 1, 0, 5) -
    (f.aux(x, y) - 0.05) +
    50000 * f.metalTile(x, y);
```

`volcanic_jagged_ground_range` (~line 174) - restore the `max(...)`:

```ts
  const volcanicJaggedGroundRange = (x: number, y: number): number =>
    5 *
    min(
      10,
      max(
        f.calciteRegion(x, y) + 0.2,
        rangeSelectBase(f.elev(x, y), 1010, 2000, 2, -10, 1) + 3 * (f.aux(x, y) - 0.5),
      ),
    );
```

`volcanic_soil_light_range` (~line 217) - restore the third `max` arm:

```ts
  const volcanicSoilLightRange = (x: number, y: number): number =>
    max(
      volcanicSoilLightRangeMountains(x, y),
      volcanicSoilLightRangeAshlands(x, y),
      10 * (f.sulfuricAcidRegionPatchy(x, y) + 0.2),
    );
```

Also update the `makeVulcanusTileCatalog` doc comment (~line 105) - it currently documents the three approximations as active. Replace with a note that V2 restored them and that the only remaining approximation is `random_penalty -> 1`.

- [ ] **Step 4: Wire the factory into the resolver**

In `makeVulcanusTileResolver` (~line 344), add the import and build the factory after `elevation`:

```ts
import { makeVulcanusResources } from "../expressions/vulcanusResources";
```

```ts
  const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);
```

and add to the `fields` object:

```ts
    metalTile: (x, y) => resources.metalTile(x, y),
    calciteRegion: (x, y) => resources.calciteRegion(x, y),
    sulfuricAcidRegionPatchy: (x, y) => resources.sulfuricAcidRegionPatchy(x, y),
```

- [ ] **Step 5: Run the parity test**

Run: `pnpm vp test test/vulcanusTiles.spec.ts`
Expected: PASS, with agreement **higher** than the Step 1 number.

- [ ] **Step 6: Judge the result**

- **Agreement went up** (ideally to 1.0): raise the assertion floor in `test/vulcanusTiles.spec.ts` to just below the new value, and rewrite the block comment at lines ~12-27 to state the new number and that the V2 stubs are gone.
- **Agreement unchanged or lower:** the coupling port is wrong. **Stop. Do not relax the bound and do not proceed to Task 6.** Report the number, and diff a few mismatching positions' per-tile probabilities against the oracle to find which restored term is at fault.

- [ ] **Step 7: Commit**

```bash
pnpm vp check --fix
git add src/noise/tiles/vulcanusCatalog.ts test/vulcanusTiles.spec.ts
git commit -m "feat(vulcanus): restore the three resource-coupling terms in the tile catalog"
```

---

### Task 6: The overlay catalog and renderer

**Files:**

- Create: `src/noise/resources/vulcanusResourceCatalog.ts`
- Create: `src/noise/preview/renderVulcanusResources.ts`
- Test: `test/vulcanusResourceRender.spec.ts` (create)

**Interfaces:**

- Consumes: `makeVulcanusResources` (Task 4), `EvalCtxInput` / `withCtxDefaults`, `renderVulcanusTerrain` (for the test's base image).
- Produces: `VULCANUS_RESOURCE_CATALOG: VulcanusResourceParams[]`, `renderVulcanusResources(base, opts)` with `RenderVulcanusResourcesOptions`. Task 7 calls the renderer.

- [ ] **Step 1: Write the failing test**

Create `test/vulcanusResourceRender.spec.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusResources } from "../src/noise/expressions/vulcanusResources";
import { makeVulcanusBiomes } from "../src/noise/expressions/vulcanusBiomes";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { makeVulcanusSpawn } from "../src/noise/expressions/vulcanusSpawn";
import { renderVulcanusTerrain } from "../src/noise/preview/renderVulcanusTerrain";
import { renderVulcanusResources } from "../src/noise/preview/renderVulcanusResources";
import { VULCANUS_RESOURCE_CATALOG } from "../src/noise/resources/vulcanusResourceCatalog";

const SEED = 123456;

describe("renderVulcanusResources", () => {
  it("catalog carries the three solid ores with their map_colors", () => {
    expect(VULCANUS_RESOURCE_CATALOG.map((r) => r.name)).toEqual([
      "tungsten-ore",
      "calcite",
      "coal",
    ]);
    expect(VULCANUS_RESOURCE_CATALOG.map((r) => r.controlName)).toEqual([
      "tungsten_ore",
      "calcite",
      "vulcanus_coal",
    ]);
    expect(VULCANUS_RESOURCE_CATALOG[0].mapColor).toEqual([98, 86, 150]);
    expect(VULCANUS_RESOURCE_CATALOG[1].mapColor).toEqual([204, 179, 179]);
    expect(VULCANUS_RESOURCE_CATALOG[2].mapColor).toEqual([0, 0, 0]);
  });

  it("paints ore pixels and leaves the rest of the terrain untouched", () => {
    const opts = {
      seed0: SEED,
      width: 64,
      height: 64,
      originX: -1600,
      originY: -1600,
      tilesPerPixel: 8,
    };
    const base = renderVulcanusTerrain(opts);
    const before = new Uint8ClampedArray(base.data);
    renderVulcanusResources(base, {
      seed0: SEED,
      originX: opts.originX,
      originY: opts.originY,
      tilesPerPixel: opts.tilesPerPixel,
    });

    const colors = new Set(VULCANUS_RESOURCE_CATALOG.map((r) => r.mapColor.join(",")));
    let changed = 0;
    for (let o = 0; o < base.data.length; o += 4) {
      const same =
        base.data[o] === before[o] &&
        base.data[o + 1] === before[o + 1] &&
        base.data[o + 2] === before[o + 2];
      if (same) continue;
      changed++;
      // Every changed pixel must be exactly one of the three ore colors.
      expect(colors.has(`${base.data[o]},${base.data[o + 1]},${base.data[o + 2]}`)).toBe(true);
    }
    // A 512x512-tile window centred on spawn contains the starting patches, so
    // this must not be empty - an all-zero result means the overlay never fired.
    expect(changed).toBeGreaterThan(0);
  });

  it("draws nothing when every resource's size slider is 0", () => {
    const opts = {
      seed0: SEED,
      width: 32,
      height: 32,
      originX: -1600,
      originY: -1600,
      tilesPerPixel: 8,
    };
    const base = renderVulcanusTerrain(opts);
    const before = new Uint8ClampedArray(base.data);
    const off = { frequency: 1, size: 0 };
    renderVulcanusResources(base, {
      seed0: SEED,
      originX: opts.originX,
      originY: opts.originY,
      tilesPerPixel: opts.tilesPerPixel,
      ctx: {
        vulcanusResourceControls: {
          tungstenOre: off,
          vulcanusCoal: off,
          calcite: off,
          sulfuricAcidGeyser: off,
        },
      },
    });
    expect(Array.from(base.data)).toEqual(Array.from(before));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vp test test/vulcanusResourceRender.spec.ts`
Expected: FAIL - modules not found.

- [ ] **Step 3: Implement the catalog**

Create `src/noise/resources/vulcanusResourceCatalog.ts`:

```ts
/**
 * The three solid Vulcanus ores rendered by the V2 overlay, in the game's
 * registration order (space-age/prototypes/entity/resources.lua). All three are
 * autoplace `order = "b"`, so ties fall back to registration order - in practice
 * they occupy disjoint biomes (basalts / mountains / ashlands), so overlap is
 * effectively impossible and priority is a formality.
 *
 * The sulfuric acid geyser is deliberately absent: it is a fluid placed at
 * `density * 0.025` (scattered points, not a solid patch), deferred to V3. Its
 * region field is still computed, because the tile catalog reads it.
 */
import type { VulcanusResources } from "../expressions/vulcanusResources";

export interface VulcanusResourceParams {
  /** Entity/prototype name. */
  readonly name: string;
  /** Autoplace control name - the `control:<x>:*` levers and the preset dict key. */
  readonly controlName: string;
  /** `map_color`, scaled to 0..255 (rounded), as the game's preview tints it. */
  readonly mapColor: readonly [number, number, number];
  /** Which `VulcanusResources` region decides this ore's footprint. */
  readonly region: (r: VulcanusResources) => (x: number, y: number) => number;
}

export const VULCANUS_RESOURCE_CATALOG: readonly VulcanusResourceParams[] = [
  {
    name: "tungsten-ore",
    controlName: "tungsten_ore",
    // map_color = {98/256, 86/256, 150/256}
    mapColor: [98, 86, 150],
    region: (r) => r.tungstenRegion,
  },
  {
    name: "calcite",
    controlName: "calcite",
    // map_color = {0.8, 0.7, 0.7}
    mapColor: [204, 179, 179],
    region: (r) => r.calciteRegion,
  },
  {
    name: "coal",
    controlName: "vulcanus_coal",
    // map_color = {0, 0, 0} (base/prototypes/entity/resources.lua)
    mapColor: [0, 0, 0],
    region: (r) => r.coalRegion,
  },
];
```

- [ ] **Step 4: Implement the renderer**

Create `src/noise/preview/renderVulcanusResources.ts`:

```ts
/**
 * Composite the Vulcanus ore overlay onto a terrain ImageData: sweep the same
 * pixel grid as renderVulcanusTerrain and, where a resource wins, paint its
 * `map_color` opaque. Mutates `base` in place. Mirrors renderResources (Nauvis).
 *
 * Two differences from the Nauvis renderer:
 *
 * - **No water exclusion.** Vulcanus has no water tile; lava plays that visual
 *   role but the game expresses ore exclusion through the biome favorabilities,
 *   not a tile test.
 * - Placement is written as the game's probability rather than a bare
 *   `region > 0`, so the `size = 0` disable case and the `random_penalty -> 1`
 *   substitution stay visible at the call site:
 *
 *     probability = (control:<x>:size > 0) * 1000 * ((1 + region) * rp - 1)
 *                 = (size > 0) * 1000 * region                 [rp -> 1]
 *
 *   and the overlay draws where `probability >= 0.5`, i.e. `region >= 0.0005` -
 *   the same threshold convention renderResources uses.
 */
import type { EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { makeVulcanusBiomes } from "../expressions/vulcanusBiomes";
import { makeVulcanusCracks } from "../expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../expressions/vulcanusHelpers";
import { makeVulcanusResources } from "../expressions/vulcanusResources";
import { makeVulcanusSpawn } from "../expressions/vulcanusSpawn";
import { VULCANUS_RESOURCE_CATALOG } from "../resources/vulcanusResourceCatalog";

/** The overlay's placement threshold: probability >= 0.5 (see the module comment). */
const PROBABILITY_THRESHOLD = 0.5;

export interface RenderVulcanusResourcesOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params (notably `vulcanusResourceControls`, `startingPositions`). */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
}

export function renderVulcanusResources(
  base: ImageData,
  opts: RenderVulcanusResourcesOptions,
): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ctx = withCtxDefaults({ seed0: opts.seed0, ...opts.ctx });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);

  const levers = ctx.vulcanusResourceControls;
  const active = VULCANUS_RESOURCE_CATALOG.map((params) => {
    const key =
      params.controlName === "tungsten_ore"
        ? levers.tungstenOre
        : params.controlName === "calcite"
          ? levers.calcite
          : levers.vulcanusCoal;
    return { params, region: params.region(resources), enabled: key.size > 0 };
  }).filter((r) => r.enabled);

  if (active.length === 0) return;

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      for (const r of active) {
        // probability = 1000 * region (rp -> 1); draw at >= 0.5.
        if (1000 * r.region(wx, wy) < PROBABILITY_THRESHOLD) continue;
        const o = (py * width + px) * 4;
        base.data[o] = r.params.mapColor[0];
        base.data[o + 1] = r.params.mapColor[1];
        base.data[o + 2] = r.params.mapColor[2];
        base.data[o + 3] = 255;
        break; // first in catalog order wins
      }
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/vulcanusResourceRender.spec.ts`
Expected: PASS (3 tests).

If "paints ore pixels" reports `changed === 0`, the window may genuinely contain no ore - widen it to `originX/Y: -4096, tilesPerPixel: 128` and re-check before concluding the renderer is broken.

- [ ] **Step 6: Commit**

```bash
pnpm vp check --fix
git add src/noise/resources/vulcanusResourceCatalog.ts src/noise/preview/renderVulcanusResources.ts test/vulcanusResourceRender.spec.ts
git commit -m "feat(vulcanus): add the resource overlay catalog and renderer"
```

---

### Task 7: Wire the overlay into the render pipeline and the UI

**Files:**

- Modify: `src/noise/preview/elevationRenderRequest.ts:196-212`
- Modify: `src/model/resourceReads.ts`
- Modify: `src/model/elevationPreviewCtx.ts` (add `vulcanusResourceControls` to the preview ctx)
- Modify: `src/components/ElevationPreviewPanel.vue:63-109, ~228-238`
- Test: `test/previewClient.spec.ts`, `test/elevationPreviewPanel.spec.ts` (extend)

**Interfaces:**

- Consumes: `renderVulcanusResources` + `RenderVulcanusResourcesOptions` (Task 6), `VulcanusResourceControls` (Task 2).
- Produces: `ElevationRenderRequest` gains `vulcanusResourceControls?: VulcanusResourceControls`; `ElevationPreviewCtx` gains the same field.

- [ ] **Step 1: Write the failing test**

Add to `test/previewClient.spec.ts`:

```ts
it("renders the Vulcanus resource overlay for view: resources", () => {
  const common = {
    id: 1,
    seed0: 123456,
    planet: "vulcanus" as const,
    width: 48,
    height: 48,
    originX: -1600,
    originY: -1600,
    tilesPerPixel: 8,
  };
  const terrain = runRenderRequest({ ...common, view: "terrain" });
  const withOre = runRenderRequest({ ...common, id: 2, view: "resources" });
  expect(Array.from(new Uint8ClampedArray(withOre.buffer))).not.toEqual(
    Array.from(new Uint8ClampedArray(terrain.buffer)),
  );
});

it("leaves Vulcanus terrain alone for the Nauvis-only overlays", () => {
  const common = {
    id: 3,
    seed0: 123456,
    planet: "vulcanus" as const,
    width: 32,
    height: 32,
    originX: -1600,
    originY: -1600,
    tilesPerPixel: 8,
  };
  const terrain = runRenderRequest({ ...common, view: "terrain" });
  for (const view of ["enemies", "cliffs", "trees", "rocks"] as const) {
    const other = runRenderRequest({ ...common, id: 4, view });
    expect(Array.from(new Uint8ClampedArray(other.buffer))).toEqual(
      Array.from(new Uint8ClampedArray(terrain.buffer)),
    );
  }
});
```

(Match the existing import of `runRenderRequest` already used in that spec.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vp test test/previewClient.spec.ts`
Expected: FAIL - the first test's two buffers are identical, because Vulcanus currently returns plain terrain for every terrain-family view.

- [ ] **Step 3: Add the request field and dispatch**

In `src/noise/preview/elevationRenderRequest.ts`, add to the request interface (near `resourceControls`):

```ts
  /**
   * Vulcanus resource control levers - consumed only when `planet: "vulcanus"`
   * and `view: "resources"`. Defaults to all-neutral.
   */
  vulcanusResourceControls?: VulcanusResourceControls;
```

with `import type { VulcanusResourceControls } from "../eval/ctx";` and
`import { renderVulcanusResources } from "./renderVulcanusResources";`.

Replace the Vulcanus early-return body (lines ~196-212) with:

```ts
    if (planet === "vulcanus") {
      // V2 ports the resource overlay only. The other four Nauvis overlays
      // (enemies, cliffs, trees, rocks) have no Vulcanus meaning, so a
      // terrain-family view that asks for one still gets plain terrain rather
      // than a Nauvis field composited onto Vulcanus colors.
      image = renderVulcanusTerrain({
        seed0: req.seed0,
        width: req.width,
        height: req.height,
        originX: req.originX,
        originY: req.originY,
        tilesPerPixel: req.tilesPerPixel,
        ctx: {
          startingPositions: req.startingPositions,
          vulcanusResourceControls: req.vulcanusResourceControls,
        },
      });
      if (req.view === "resources" || req.view === "all") {
        renderVulcanusResources(image, {
          seed0: req.seed0,
          originX: req.originX,
          originY: req.originY,
          tilesPerPixel: req.tilesPerPixel,
          ctx: {
            startingPositions: req.startingPositions,
            vulcanusResourceControls: req.vulcanusResourceControls,
          },
        });
      }
      return { id: req.id, buffer: image.data.buffer, width: req.width, height: req.height };
    }
```

Note the terrain call now also receives the levers - the coupling terms depend on them, so terrain and overlay must see the same controls.

- [ ] **Step 4: Run the test**

Run: `pnpm vp test test/previewClient.spec.ts`
Expected: PASS.

- [ ] **Step 5: Read the Vulcanus levers off the preset**

In `src/model/resourceReads.ts`, add below the existing export:

```ts
/**
 * The four Vulcanus resource autoplace controls, read off the same
 * `autoplaceControls` dict (keys are the game's control names), defaulting to the
 * neutral 1/1. Richness is not read - V2 renders placement, not yield.
 */
export function readVulcanusResourceControls(preset: {
  autoplaceControls: Record<string, AutoplaceSetting>;
}): VulcanusResourceControls {
  const read = (name: string): VulcanusResourceLevers => {
    const c = preset.autoplaceControls[name];
    return c ? { frequency: c.frequency, size: c.size } : { frequency: 1, size: 1 };
  };
  return {
    tungstenOre: read("tungsten_ore"),
    vulcanusCoal: read("vulcanus_coal"),
    calcite: read("calcite"),
    sulfuricAcidGeyser: read("sulfuric_acid_geyser"),
  };
}
```

with `import type { VulcanusResourceControls, VulcanusResourceLevers } from "../noise/eval/ctx";`.

In `src/model/elevationPreviewCtx.ts`, add `vulcanusResourceControls: VulcanusResourceControls;` to `ElevationPreviewCtx` and `vulcanusResourceControls: readVulcanusResourceControls(preset),` next to the existing `resourceControls:` line (~119).

In `src/components/ElevationPreviewPanel.vue`, pass it through in the `renderer.render({...})` call next to `resourceControls`:

```ts
        vulcanusResourceControls: info.vulcanusResourceControls,
```

- [ ] **Step 6: Un-gate the Resources toggle for Vulcanus**

In `src/components/ElevationPreviewPanel.vue`:

Add a computed next to `nauvisOverlaysAvailable`:

```ts
// Resources is the one overlay with a Vulcanus port (V2), so it gates more
// broadly than the other four: Nauvis-with-Nauvis-map-type, OR Vulcanus.
const resourcesAvailable = computed(
  () => nauvisOverlaysAvailable.value || planet.value === "vulcanus",
);
```

Change `effectiveView` so Vulcanus honors the dev-mode pick between terrain and resources, and defaults to the composite otherwise:

```ts
const effectiveView = computed(() => {
  if (planet.value === "vulcanus") {
    // Only "terrain" and "resources" have a Vulcanus port; anything else the
    // user last picked on Nauvis falls back to the composite.
    if (ui.devMode && (view.value === "terrain" || view.value === "resources")) return view.value;
    return "resources";
  }
  if (!nauvisMapType.value) return "elevation";
  return ui.devMode ? view.value : "all";
});
```

Update the block comment above `effectiveView` (lines ~86-104): item 1 no longer says "Vulcanus, always terrain".

In the template, change the Resources button's `:disabled` and title from `nauvisOverlaysAvailable` to `resourcesAvailable`, and adjust the title text so it reads correctly on Vulcanus (e.g. `resourcesAvailable ? undefined : 'Resources view is only available for the Nauvis map type'`).

Also update the comment block at lines ~63-74 - it currently asserts all five overlays are Nauvis-only.

- [ ] **Step 7: Extend the panel test**

Add to `test/elevationPreviewPanel.spec.ts`, matching that file's existing mounting helper:

```ts
it("enables the Resources toggle on Vulcanus", async () => {
  const wrapper = await mountPanel({ planet: "vulcanus" });
  const btn = wrapper.get('[data-test="view-resources"]');
  expect(btn.attributes("disabled")).toBeUndefined();
});
```

If `mountPanel` in that spec does not accept a `planet` option, follow whatever pattern the existing Vulcanus assertions in that file use rather than inventing a new one.

- [ ] **Step 8: Run the full suite**

Run: `pnpm run verify`
Expected: all green (`vp check`, `vp test`, `preview:test`).

- [ ] **Step 9: Commit**

```bash
git add src/noise/preview/elevationRenderRequest.ts src/model/resourceReads.ts src/model/elevationPreviewCtx.ts src/components/ElevationPreviewPanel.vue test/previewClient.spec.ts test/elevationPreviewPanel.spec.ts
git commit -m "feat(vulcanus): wire the resource overlay into the render pipeline and panel"
```

---

### Task 8: Measure perf, write the notes, update the roadmap

**Files:**

- Create: `docs/noise/vulcanus-resources-NOTES.md`
- Modify: `docs/noise/client-preview-ROADMAP.md`
- Modify: `docs/noise/vulcanus-tiles-NOTES.md` (the three approximations it documents are gone)

- [ ] **Step 1: Measure the terrain-only regression**

Run: `FMW_PERF=1 pnpm perf`

Record the Vulcanus terrain per-pixel number. Compare against the ~12 us/px V1 baseline recorded in the roadmap. If `pnpm perf` has no Vulcanus case, add one mirroring the existing Nauvis terrain case, and measure both before (via `git stash`) and after.

- [ ] **Step 2: Apply the gate**

- **Within ~2x of baseline:** record the number and move on.
- **Worse than ~2x:** stop and investigate before merging. First suspects, in order: (a) the per-region `selectSpots` cache being rebuilt because the wobbled coordinate crosses region boundaries constantly - check the cache hit rate; (b) `memoXY` missing on a hot closure (the `place_*` wrappers are *not* memoized, only the regions are); (c) the 3x3 region scan being wider than necessary at `region_size` 1000 vs the cull radius 128. Report what you found either way.

- [ ] **Step 3: Write the notes doc**

Create `docs/noise/vulcanus-resources-NOTES.md` covering:

- Source lines in `planet-vulcanus-map-gen.lua` and `tiles-vulcanus.lua` (as in the spec).
- The per-resource parameter table (seed, count, offset, region_size, favorability, wrapper).
- The two approximations, and that `rp -> 1` is the only one affecting terrain.
- Measured oracle residuals per expression (the actual worst values, not the test bounds).
- The `get_tile` agreement before (96.85%) and after.
- The perf numbers from Step 1.
- **Untested:** non-default frequency sliders produce a fractional `region_size` (`500 + 500/f`), which this port floors. Only `f = 1` is oracle-covered. Flag it as the first thing to check if a non-default-frequency preset renders wrong.
- Any `selectSpots` finding from Task 4.

- [ ] **Step 4: Update the roadmap and the V1 tile notes**

In `docs/noise/client-preview-ROADMAP.md`, mark V2 complete and note that V3 (the geyser overlay) now only needs renderer work, since `sulfuricAcidRegion` already exists.

In `docs/noise/vulcanus-tiles-NOTES.md`, replace the "resource-term approximations" passage - all three are restored.

- [ ] **Step 5: Final gate**

Run: `pnpm run verify`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add docs/noise/
git commit -m "docs(vulcanus): record V2 resource port, residuals, parity and perf"
```

---

## Self-Review Notes

Checked against the spec:

- **Scope** - three solid ores (T6 catalog), starting patches (T3), all three coupling terms (T5), sulfur field without overlay (T4 computes it; T6's catalog deliberately omits it).
- **Approximations** - `rp -> 1` appears in T4's `metalTile`, T6's renderer comment, and T8's notes. Richness is absent throughout.
- **Verification** - per-expression oracle (T1 fixture, T3/T4 specs), `get_tile` parity with a stop-condition (T5 Step 6), Nauvis isolation (nothing in the Nauvis resource modules is touched; T7's second test asserts the other four overlays stay no-ops on Vulcanus), perf gate (T8).
- **Names** - `VulcanusResources` members are defined in T3/T4 and consumed under the same names in T5 (`metalTile`, `calciteRegion`, `sulfuricAcidRegionPatchy`) and T6 (`tungstenRegion`, `calciteRegion`, `coalRegion`). `VulcanusResourceControls` / `VulcanusResourceLevers` / `DEFAULT_VULCANUS_RESOURCE_CONTROLS` are defined in T2 and used in T3, T4, T6, T7.
