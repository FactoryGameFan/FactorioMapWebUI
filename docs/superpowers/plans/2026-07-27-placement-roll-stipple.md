# Per-tile placement roll (approximate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the probability *threshold* in five overlays with the game's per-tile placement *roll*, so they draw scattered entities instead of solid regions, and take the Vulcanus `all` view back under the 2x perf gate by sampling the rock field on a coarse lattice.

**Architecture:** A new `src/noise/placement/placementRoll.ts` turns the reverse-engineered per-chunk taus88 stream (`docs/noise/placement-roll-NOTES.md`) into a pure function of world position, by dropping the game's data-dependent jitter draws so every tile consumes exactly one draw. Each of the five overlay renderers swaps `probability >= THRESHOLD` for `roll(x, y) < probability(x, y)` and paints a uniform 3x3 mark. A per-overlay salt keeps the five streams uncorrelated, standing in for the cross-overlay arbitration this approximation skips.

**Tech Stack:** TypeScript, Vue 3, Vite+ (`vp`) for test/lint/typecheck, Vitest-compatible tests importing from `"vite-plus/test"`, Factorio 2.1.12 headless as the oracle.

**Spec:** `docs/superpowers/specs/2026-07-27-placement-roll-stipple-design.md`

## Global Constraints

- **Run every command through pnpm.** `pnpm vp test <file>`, `pnpm vp check --fix`, `pnpm run verify`. A bare `vp` fails with `EBADDEVENGINES`.
- **Full gate is `pnpm run verify`** (`vp check` + `vp test` + `preview:test`). Every task ends green.
- **Three tests are known-flaky under full-suite load** and are NOT caused by this work: `treeFieldEarlyOut` and two `vulcanusCliffs` cases sit at the 5s default timeout and measure 5.2-7.5s in parallel. They pass when run alone. Do not "fix" them; re-run the single file to confirm before investigating.
- **Never edit a fixture or an expected value to make a test pass.** A mismatch is a real finding. This applies with full force to the oracle band in Task 4.
- **Hyphens, not em dashes or en dashes,** in every file.
- **Fixtures require a `PROVENANCE.json` entry.** `test/fixtureProvenance.spec.ts` fails without one.
- **Priority that governs every trade in this plan** (Eric, 2026-07-27): on both planets cliffs matter more than rocks, and rocks may be approximate. Never spend cliff fidelity to buy rock fidelity or speed.
- **Commit after each task**, using the repo's Conventional Commits style, ending with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Be9DNQpAjbHYr6FwXMg914
  ```
- **Branch:** `feat/placement-roll-stipple` (already exists, holds the two spec commits).

## File Structure

**Created**

| file | responsibility |
| --- | --- |
| `src/noise/placement/placementRoll.ts` | the roll: chunk seed word, 1024-draw chunk table, cached `roll(x, y)` |
| `test/placementRoll.spec.ts` | unit tests for the above |
| `test/oracle/entityCounts.ts` | headless capture of per-region entity counts (Nauvis + Vulcanus) |
| `test/entityDensity.spec.ts` | asserts placed-tile counts against the captured game counts |
| `test/fixtures/oracle-entity-counts.seed123456.json` | the captured ground truth |

**Modified**

| file | change |
| --- | --- |
| `src/noise/preview/renderCliffs.ts` | `paintCliffCells` generalised to `paintMark`, re-exported |
| `src/noise/preview/renderVulcanusRocks.ts` | threshold -> roll, 3x3 mark, lattice field sampling |
| `src/noise/preview/renderRocks.ts` | threshold -> roll, 3x3 mark, lattice field sampling |
| `src/noise/preview/renderEnemies.ts` | threshold -> roll, 3x3 mark |
| `src/noise/preview/renderResources.ts` | roll for `placement: "roll"` resources |
| `src/noise/resources/resolveResource.ts` | winner selection honours `placement` |
| `src/noise/resources/resourceCatalog.ts` | new `placement` field |
| `src/noise/resources/vulcanusResourceCatalog.ts` | geyser gains a real `probability` |
| `src/noise/rocks/rockCatalog.ts`, `src/noise/rocks/vulcanusRockField.ts` | delete dead thresholds |
| `src/noise/enemies/enemyCatalog.ts` | delete dead threshold |
| `test/elevationRenderRequest.spec.ts`, `test/vulcanusRender.spec.ts` | re-probe the overlap windows |

---

### Task 1: The placement roll module

**Files:**
- Create: `src/noise/placement/placementRoll.ts`
- Test: `test/placementRoll.spec.ts`

**Interfaces:**
- Consumes: `seededState`, `taus88Next` from `src/noise/taus88.ts`.
- Produces:
  ```ts
  export const PLACEMENT_SALT: {
    readonly vulcanusRocks: 0;
    readonly nauvisRocks: number;
    readonly enemyBases: number;
    readonly vulcanusGeyser: number;
    readonly crudeOil: number;
  };
  export function placementRollWord(chunkX: number, chunkY: number, salt: number): number;
  export function makePlacementRoll(salt: number): (x: number, y: number) => number;
  ```
  `makePlacementRoll` returns `roll(x, y)` giving `U` in `[0, 1)`. Callers place where `roll(x, y) < probability(x, y)`.

Note `vulcanusRocks` salt is **0** on purpose: with salt 0 the word is exactly the game's own, so Step 1's test pins the reverse-engineered constants rather than our arithmetic.

- [ ] **Step 1: Write the failing tests**

```ts
// test/placementRoll.spec.ts
import { describe, expect, it } from "vite-plus/test";
import {
  PLACEMENT_SALT,
  makePlacementRoll,
  placementRollWord,
} from "../src/noise/placement/placementRoll";
import { seededState, taus88Next } from "../src/noise/taus88";

describe("placementRollWord", () => {
  // docs/noise/placement-roll-NOTES.md: generateEntities +52..+104 seeds
  // word = max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY), u32, no map_seed.
  it("reproduces the reverse-engineered chunk seed word at salt 0", () => {
    for (const [cx, cy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, -1],
      [37, -94],
    ] as const) {
      const expected = Math.max(341, (0x3fbe2c + Math.imul(7919, cx) + Math.imul(7907, cy)) >>> 0);
      expect(placementRollWord(cx, cy, 0)).toBe(expected);
    }
  });

  it("clamps to 341 rather than returning a tiny word", () => {
    // Choose a salt that drives the sum to 5 before the clamp.
    const salt = (5 - 0x3fbe2c) >>> 0;
    expect(placementRollWord(0, 0, salt)).toBe(341);
  });

  it("gives different words for different salts", () => {
    expect(placementRollWord(3, 4, PLACEMENT_SALT.nauvisRocks)).not.toBe(
      placementRollWord(3, 4, PLACEMENT_SALT.vulcanusRocks),
    );
  });
});

describe("makePlacementRoll", () => {
  it("assigns draws in DECREASING tile index - the first draw is the last tile", () => {
    const roll = makePlacementRoll(0);
    const st = seededState(placementRollWord(0, 0, 0));
    const first = taus88Next(st) / 4294967296;
    // tile index 1023 = (y & 31) * 32 + (x & 31) with x = 31, y = 31
    expect(roll(31, 31)).toBe(first);
  });

  it("returns U in [0, 1)", () => {
    const roll = makePlacementRoll(PLACEMENT_SALT.enemyBases);
    for (let y = -40; y < 40; y += 7) {
      for (let x = -40; x < 40; x += 7) {
        const u = roll(x, y);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
      }
    }
  });

  it("is a pure function of world position - independent of visit order", () => {
    const a = makePlacementRoll(PLACEMENT_SALT.nauvisRocks);
    const b = makePlacementRoll(PLACEMENT_SALT.nauvisRocks);
    const pts: [number, number][] = [
      [0, 0],
      [1000, -1000],
      [-33, 64],
      [31, 31],
      [-1, -1],
    ];
    const forward = pts.map(([x, y]) => a(x, y));
    const backward = [...pts].reverse().map(([x, y]) => b(x, y));
    expect(backward.reverse()).toEqual(forward);
  });

  it("handles negative world coordinates without collapsing chunks", () => {
    const roll = makePlacementRoll(0);
    // (-1, -1) is tile index 1023 of chunk (-1, -1); (31, 31) is tile 1023 of chunk (0, 0).
    expect(roll(-1, -1)).not.toBe(roll(31, 31));
  });

  it("decorrelates salts: two overlays' placements intersect at ~the product of their rates", () => {
    const a = makePlacementRoll(PLACEMENT_SALT.nauvisRocks);
    const b = makePlacementRoll(PLACEMENT_SALT.enemyBases);
    const p = 0.2;
    let na = 0;
    let nb = 0;
    let both = 0;
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        const ha = a(x, y) < p;
        const hb = b(x, y) < p;
        if (ha) na++;
        if (hb) nb++;
        if (ha && hb) both++;
      }
    }
    const n = 200 * 200;
    // Independent => both/n ~= (na/n)*(nb/n) ~= 0.04. Correlated (shared stream)
    // would give both ~= min(na, nb) ~= 0.2*n. 0.06 is comfortably between.
    expect(both / n).toBeLessThan(0.06);
    expect(both / n).toBeGreaterThan(0.02);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vp test test/placementRoll.spec.ts`
Expected: FAIL - cannot resolve `../src/noise/placement/placementRoll`.

- [ ] **Step 3: Write the implementation**

```ts
// src/noise/placement/placementRoll.ts
/**
 * The game's per-tile entity placement roll, in a deliberately approximate form.
 *
 * Reverse-engineered in `docs/noise/placement-roll-NOTES.md`: `generateEntities`
 * seeds taus88 once per chunk from the chunk position (no `map_seed`), then walks
 * the chunk's tiles in DECREASING tile index, drawing one `U` per tile and placing
 * the arbitrated winner where `U < probability`.
 *
 * Two departures, both deliberate (see the 2026-07-27 spec):
 *
 * 1. **No cross-overlay arbitration.** The game picks one winner per tile by max
 *    probability across every entity autoplacer in the chunk - including ones this
 *    app has never ported. We roll each overlay separately, and give each its own
 *    `salt` so their streams do not correlate. The salt is the one value here with
 *    no counterpart in the game.
 * 2. **No jitter draws.** The game spends two extra draws per PLACEMENT to offset
 *    the entity within its tile, which makes its draw count data-dependent. Dropping
 *    them fixes the count at one draw per tile - which is what makes `roll(x, y)` a
 *    pure function of world position, and therefore safe for the tiled renderer.
 */
import { seededState, taus88Next } from "../taus88";

/** Tiles per chunk edge; 1024 tiles per chunk. */
const CHUNK = 32;
const TILES_PER_CHUNK = CHUNK * CHUNK;

/**
 * Per-overlay stream salts. Values are arbitrary and carry no meaning beyond being
 * distinct - EXCEPT `vulcanusRocks`, which is 0 so that one overlay reproduces the
 * game's own seed word exactly, letting the unit test pin the RE'd constants.
 */
export const PLACEMENT_SALT = {
  vulcanusRocks: 0,
  nauvisRocks: 0x5f1e21,
  enemyBases: 0xa3c07b,
  vulcanusGeyser: 0x1d94e5,
  crudeOil: 0x76b3af,
} as const;

/** `max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY + salt)` in u32 arithmetic. */
export function placementRollWord(chunkX: number, chunkY: number, salt: number): number {
  const sum = (0x3fbe2c + Math.imul(7919, chunkX) + Math.imul(7907, chunkY) + salt) >>> 0;
  return Math.max(341, sum);
}

function chunkRolls(chunkX: number, chunkY: number, salt: number): Float64Array {
  const st = seededState(placementRollWord(chunkX, chunkY, salt));
  const out = new Float64Array(TILES_PER_CHUNK);
  // Draws are consumed in decreasing tile index, so draw k belongs to tile 1023-k.
  for (let k = 0; k < TILES_PER_CHUNK; k++) {
    out[TILES_PER_CHUNK - 1 - k] = taus88Next(st) / 4294967296;
  }
  return out;
}

/**
 * Build `roll(x, y) -> U in [0, 1)` for one overlay. Place where `U < probability`.
 *
 * Caching: a single-slot (chunkX, chunkY) check in front of a `Map`. Renderers sweep
 * row-major, so the single slot hits for 32 consecutive pixels and the Map catches
 * the revisit when the next pixel row re-enters a chunk already built. Building a
 * chunk costs 1024 taus88 steps, amortised to ~1 step per tile over the chunk.
 */
export function makePlacementRoll(salt: number): (x: number, y: number) => number {
  const cache = new Map<string, Float64Array>();
  let lastX = NaN;
  let lastY = NaN;
  let last: Float64Array | null = null;

  return (x, y) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    if (cx !== lastX || cy !== lastY || last === null) {
      const key = `${cx},${cy}`;
      let rolls = cache.get(key);
      if (rolls === undefined) {
        rolls = chunkRolls(cx, cy, salt);
        cache.set(key, rolls);
      }
      last = rolls;
      lastX = cx;
      lastY = cy;
    }
    return last[(ty & 31) * CHUNK + (tx & 31)];
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vp test test/placementRoll.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm vp check --fix && pnpm run verify
git add src/noise/placement/placementRoll.ts test/placementRoll.spec.ts
git commit -m "feat(placement): the per-chunk placement roll, approximated to a pure function"
```

---

### Task 2: Extract `paintMark` from the cliff painter

**Files:**
- Modify: `src/noise/preview/renderCliffs.ts:63-96`
- Test: `test/renderCliffs.spec.ts` (existing; add one case)

**Interfaces:**
- Produces: `export function paintMark(base: ImageData, px: number, py: number, color: readonly [number, number, number], radius: number, skipPixel?: (r: number, g: number, b: number) => boolean): void` - paints a `(2*radius+1)` square centred on the pixel, clipped to the image, re-checking `skipPixel` per painted pixel.
- `paintCliffCells` keeps its signature and calls `paintMark` per cell, so cliff behavior is unchanged.

This task is a pure refactor: **no rendered pixel may change.** The existing cliff tests are the guard.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/renderCliffs.spec.ts
import { paintMark } from "../src/noise/preview/renderCliffs";

describe("paintMark", () => {
  const blank = (w: number, h: number): ImageData =>
    ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData;

  it("paints a (2r+1) square centred on the pixel", () => {
    const img = blank(7, 7);
    paintMark(img, 3, 3, [10, 20, 30], 1);
    let painted = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] === 255) painted++;
    expect(painted).toBe(9);
    const o = (3 * 7 + 3) * 4;
    expect([img.data[o], img.data[o + 1], img.data[o + 2]]).toEqual([10, 20, 30]);
  });

  it("clips at the image edge instead of wrapping", () => {
    const img = blank(7, 7);
    paintMark(img, 0, 0, [10, 20, 30], 1);
    let painted = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] === 255) painted++;
    expect(painted).toBe(4); // the in-image quadrant of a 3x3
    const wrapped = (0 * 7 + 6) * 4;
    expect(img.data[wrapped + 3]).toBe(0);
  });

  it("honours skipPixel per painted pixel", () => {
    const img = blank(3, 3);
    const o = (1 * 3 + 1) * 4;
    img.data[o] = 99;
    paintMark(img, 1, 1, [10, 20, 30], 1, (r) => r === 99);
    expect(img.data[o]).toBe(99); // skipped
    expect(img.data[0]).toBe(10); // neighbour painted
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vp test test/renderCliffs.spec.ts`
Expected: FAIL - `paintMark` is not exported.

- [ ] **Step 3: Extract the helper**

In `src/noise/preview/renderCliffs.ts`, add `paintMark` and rewrite `paintCliffCells`'s body to call it:

```ts
/**
 * Paint one square mark centred on a pixel, clipped to the image. Shared by the
 * cliff painter and the placement-roll overlays; `skipPixel` is re-checked per
 * painted pixel so a thickened mark still respects an exclusion (e.g. water).
 */
export function paintMark(
  base: ImageData,
  px: number,
  py: number,
  color: readonly [number, number, number],
  radius: number,
  skipPixel?: (r: number, g: number, b: number) => boolean,
): void {
  const { width, height } = base;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = py + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = px + dx;
      if (x < 0 || x >= width) continue;
      const o = (y * width + x) * 4;
      if (skipPixel?.(base.data[o], base.data[o + 1], base.data[o + 2]) === true) continue;
      base.data[o] = color[0];
      base.data[o + 1] = color[1];
      base.data[o + 2] = color[2];
      base.data[o + 3] = 255;
    }
  }
}
```

Then in `paintCliffCells`, replace the inner double loop with:

```ts
  for (const { x: wx, y: wy } of cells) {
    const cx = Math.floor((wx - originX) / tpp);
    const cy = Math.floor((wy - originY) / tpp);
    paintMark(base, cx, cy, CLIFF_MAP_COLOR, CLIFF_MARK_RADIUS_PX, skipPixel);
  }
```

- [ ] **Step 4: Verify the refactor changed nothing**

Run: `pnpm vp test test/renderCliffs.spec.ts test/vulcanusRender.spec.ts test/tiledEquality.spec.ts`
Expected: PASS. Cliff output is byte-identical; `tiledEquality` proves it across all views.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm vp check --fix && pnpm run verify
git add src/noise/preview/renderCliffs.ts test/renderCliffs.spec.ts
git commit -m "refactor(preview): extract paintMark from the cliff painter"
```

---

### Task 3: Vulcanus rocks roll instead of threshold

**Files:**
- Modify: `src/noise/preview/renderVulcanusRocks.ts`
- Modify: `src/noise/rocks/vulcanusRockField.ts` (delete `VULCANUS_ROCK_FOOTPRINT_THRESHOLD`)
- Test: `test/vulcanusRender.spec.ts` (existing rock case + the composite-order case)

**Interfaces:**
- Consumes: `makePlacementRoll`, `PLACEMENT_SALT.vulcanusRocks` (Task 1); `paintMark` (Task 2).
- Produces: nothing new.

**Mark radius is 1 (a 3x3 mark)** for every roll overlay in this plan. Define it once, in `src/noise/placement/placementRoll.ts`:

```ts
/** Placed entities paint a (2*1+1) = 3x3 mark. Uniform across all roll overlays. */
export const PLACEMENT_MARK_RADIUS_PX = 1;
```

- [ ] **Step 1: Write the failing test**

```ts
// in test/vulcanusRender.spec.ts, replacing the body of
// "paints Vulcanus rocks for view:'rocks', in the shared ROCK_MAP_COLOR"
// keep that test, and ADD this one after it:

it("rolls Vulcanus rocks rather than thresholding - coverage drops well below the 7% plateau", () => {
  const common = {
    id: 21,
    seed0: 123456,
    planet: "vulcanus" as const,
    width: 256,
    height: 256,
    originX: -128,
    originY: -128,
    tilesPerPixel: 1,
    waterLevel: 0,
    segmentationMultiplier: 1,
    startingPositions: [{ x: 0, y: 0 }],
  };
  const terrain = new Uint8ClampedArray(runRenderRequest({ ...common, view: "terrain" }).buffer);
  const rocks = new Uint8ClampedArray(runRenderRequest({ ...common, id: 22, view: "rocks" }).buffer);
  let changed = 0;
  for (let o = 0; o < rocks.length; o += 4) {
    if (rocks[o] !== terrain[o] || rocks[o + 1] !== terrain[o + 1] || rocks[o + 2] !== terrain[o + 2])
      changed++;
  }
  const coverage = changed / (common.width * common.height);
  // The threshold render painted 7.03% of this window (docs/noise/vulcanus-rocks-NOTES.md).
  // A roll against a field that caps at 0.2 must paint far less, even with a 3x3 mark.
  expect(coverage).toBeLessThan(0.05);
  expect(coverage).toBeGreaterThan(0); // and it must still paint SOMETHING
}, 15000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vp test test/vulcanusRender.spec.ts -t "rolls Vulcanus rocks"`
Expected: FAIL - coverage is ~0.07, above the 0.05 bound.

- [ ] **Step 3: Implement the roll**

In `src/noise/preview/renderVulcanusRocks.ts`, replace the imports and the sweep:

```ts
import { ROCK_MAP_COLOR } from "../rocks/rockCatalog";
import { makeVulcanusRockFields } from "../rocks/vulcanusRockField";
import {
  PLACEMENT_MARK_RADIUS_PX,
  PLACEMENT_SALT,
  makePlacementRoll,
} from "../placement/placementRoll";
import { paintMark } from "./renderCliffs";
```

```ts
  const { density } = makeVulcanusRockFields(ctx);
  const roll = makePlacementRoll(PLACEMENT_SALT.vulcanusRocks);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      if (roll(wx, wy) >= density(wx, wy)) continue;
      paintMark(base, px, py, ROCK_MAP_COLOR, PLACEMENT_MARK_RADIUS_PX);
    }
  }
```

Update the file's doc comment: it currently says the render is "a threshold on the probability field, not a placement" and points at issue #9. Replace that paragraph with a statement that it now rolls, that positions are not tile-exact (no arbitration, no jitter draws), and that density is the property under test.

Delete `VULCANUS_ROCK_FOOTPRINT_THRESHOLD` from `src/noise/rocks/vulcanusRockField.ts` along with the comment paragraph that explains the plateau/threshold trade, replacing it with a one-line pointer to the roll.

- [ ] **Step 4: Run and re-probe the composite-order window**

Run: `pnpm vp test test/vulcanusRender.spec.ts`

The new coverage test should PASS. The composite-order test
("composites Vulcanus rocks and cliffs ON TOP of resource patches") may now FAIL
on `overRocks > 0`, because rock coverage dropped and its window was probed
against the old 7% render.

If it fails, **re-probe rather than loosening the assertion**: write a temporary
spec that, for several candidate windows, prints `resources n rocks` (excluding
cliff pixels) using `runRenderRequest` diffs, pick a window with a comfortable
count, update the test's `common` block and its comment with the new numbers, and
delete the temporary spec. The existing comment in that test documents this exact
procedure and the reason for it.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm vp check --fix && pnpm run verify
git add src/noise/preview/renderVulcanusRocks.ts src/noise/rocks/vulcanusRockField.ts test/vulcanusRender.spec.ts
git commit -m "feat(vulcanus): roll Vulcanus rocks per tile instead of thresholding"
```

---

### Task 4: Density oracle - capture and assert

**Files:**
- Create: `test/oracle/entityCounts.ts`
- Create: `test/fixtures/oracle-entity-counts.seed123456.json`
- Create: `test/entityDensity.spec.ts`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `sampleCliffEntities` in `test/oracle/oracle.ts:692` as the model - the probe-mod scaffolding (`buildCliffInfoJson`, `buildCliffModList`, `buildConfigIni`, `buildFactorioArgs`, chunk forcing) is the same; only the `control.lua` body and the dump filename differ. Space-Age routing uses the existing `spaceAge: true, planet: "vulcanus"` options (`OracleOptions`, `test/oracle/oracle.ts:519`).
- Produces: `export async function sampleEntityCounts(region: Region, names: readonly string[], opts: OracleOptions): Promise<Record<string, number>>`.

**This task requires a Factorio install.** The capture is manual and its output is committed; the spec that reads the fixture runs in CI without Factorio.

Capture all five entity names in one pass even though only Vulcanus rocks roll so far - a capture run is expensive and the later tasks each add their assertion to this same fixture.

Entity names: Nauvis `huge-rock`, `big-rock`, `crude-oil`, `biter-spawner`, `spitter-spawner`; Vulcanus `huge-volcanic-rock`, `big-volcanic-rock`, `huge-volcanic-rock-hot`, `big-volcanic-rock-hot`, `sulfuric-acid-geyser`.

- [ ] **Step 1: Write the capture**

`test/oracle/entityCounts.ts` mirrors `sampleCliffEntities`, with this `control.lua` body (region and names interpolated):

```lua
local REGION = {{X0, Y0}, {X1, Y1}}
local NAMES = { "name-a", "name-b" }
script.on_event(defines.events.on_tick, function()
  local surface = SURFACE_EXPR
  surface.request_to_generate_chunks({x = 0, y = 0}, 0)
  surface.force_generate_chunk_requests()
  local counts = {}
  for _, name in pairs(NAMES) do
    counts[name] = surface.count_entities_filtered({area = REGION, name = name})
  end
  helpers.write_file("entity-counts.json", helpers.table_to_json(counts))
  error("done")
end)
```

`SURFACE_EXPR` is `game.surfaces[1]` for Nauvis and the Space-Age
`create_surface()` expression the existing Vulcanus captures use. Chunk forcing
must cover the whole region, exactly as the cliff probe does - copy its call
shape rather than inventing one.

- [ ] **Step 2: Run the capture**

```bash
pnpm refs:sync --check   # confirm the reference version matches the binary first
node --experimental-strip-types test/oracle/entityCounts.ts
```

Regions: two per planet, both chunk-aligned - one near spawn (`0,0 -> 512,512`) and one far (`4096,4096 -> 4608,4608`). Seed 123456. Write the fixture as:

```json
{
  "_comment": "Ground truth from Factorio <version> via test/oracle. Per-region entity counts (count_entities_filtered by name) after chunk-forced generation, at the DEFAULT preset. Compared against the placement roll's placed-tile count in test/entityDensity.spec.ts - density only; individual positions are NOT expected to match (see docs/superpowers/specs/2026-07-27-placement-roll-stipple-design.md). Regenerate: node --experimental-strip-types test/oracle/entityCounts.ts",
  "seed": 123456,
  "regions": [{ "planet": "nauvis", "x0": 0, "y0": 0, "x1": 512, "y1": 512 }],
  "counts": [{ "planet": "nauvis", "region": 0, "name": "huge-rock", "count": 0 }]
}
```

- [ ] **Step 3: Add the PROVENANCE entry**

Add an entry for `oracle-entity-counts.seed123456.json` with the binary's version and `"evidence": "stated"`. Run `pnpm vp test test/fixtureProvenance.spec.ts` - it must pass.

- [ ] **Step 4: Write the density spec, MEASURE FIRST**

`test/entityDensity.spec.ts` sums our placed tiles over each region by calling the
overlay's field and roll directly (not through a render, so no mark thickening or
image clipping distorts the count):

```ts
// test/entityDensity.spec.ts
import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-entity-counts.seed123456.json" with { type: "json" };
import { PLACEMENT_SALT, makePlacementRoll } from "../src/noise/placement/placementRoll";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusRockFields } from "../src/noise/rocks/vulcanusRockField";

/** Count tiles the roll places over a region, one sample per tile. */
function placedCount(
  region: { x0: number; y0: number; x1: number; y1: number },
  salt: number,
  probability: (x: number, y: number) => number,
): number {
  const roll = makePlacementRoll(salt);
  let n = 0;
  for (let y = region.y0; y < region.y1; y++)
    for (let x = region.x0; x < region.x1; x++) if (roll(x, y) < probability(x, y)) n++;
  return n;
}

describe("placement density vs the game", () => {
  it("Vulcanus rocks: placed count tracks the game's entity count", () => {
    const region = fixture.regions.find((r) => r.planet === "vulcanus")!;
    const gameCount = fixture.counts
      .filter((c) => c.planet === "vulcanus" && c.name.endsWith("volcanic-rock"))
      .reduce((a, c) => a + c.count, 0);
    const ctx = withCtxDefaults({ seed0: fixture.seed, startingPositions: [{ x: 0, y: 0 }] });
    const { density } = makeVulcanusRockFields(ctx);
    const ours = placedCount(region, PLACEMENT_SALT.vulcanusRocks, density);
    const rel = Math.abs(ours - gameCount) / gameCount;
    console.log(`vulcanus rocks: ours=${ours} game=${gameCount} rel=${rel.toFixed(3)}`);
    expect(rel).toBeLessThan(BAND);
  }, 30000);
});
```

**Run it with a deliberately huge `BAND` first (e.g. 10), read the logged `rel`,
then set `BAND` from what you measured** - a small round number above the observed
value, and record the observed value in a comment. If `rel` exceeds ~0.3, STOP:
that is a finding about the probability field or the roll, not a number to widen.
Report it rather than proceeding.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm vp check --fix && pnpm run verify
git add test/oracle/entityCounts.ts test/entityDensity.spec.ts test/fixtures/oracle-entity-counts.seed123456.json test/fixtures/PROVENANCE.json
git commit -m "test(placement): density oracle for the placement roll, Vulcanus rocks first"
```

---

### Task 5: Nauvis rocks roll instead of threshold

**Files:**
- Modify: `src/noise/preview/renderRocks.ts`
- Modify: `src/noise/rocks/rockCatalog.ts` (delete `ROCK_FOOTPRINT_THRESHOLD`)
- Test: `test/elevationRenderRequest.spec.ts` (the composite-order case), `test/entityDensity.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4.

- [ ] **Step 1: Write the failing density assertion**

Add to `test/entityDensity.spec.ts`, alongside the Vulcanus case, a Nauvis rocks
case summing the game's `huge-rock` + `big-rock` counts against
`placedCount(region, PLACEMENT_SALT.nauvisRocks, density)` where `density` comes
from `makeRockDensity({ seed0: fixture.seed, rocksFrequency: 1, rocksSize: 1, startingPositions: [{ x: 0, y: 0 }] })`
(`src/noise/rocks/rockField.ts`). Use the same measure-then-pin rule as Task 4.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vp test test/entityDensity.spec.ts`
Expected: FAIL - the Nauvis renderer still thresholds, so nothing has changed yet;
the assertion itself exercises the roll and will report a `rel` you must read.

- [ ] **Step 3: Implement the roll**

Same edit shape as Task 3, keeping the water skip:

```ts
  const roll = makePlacementRoll(PLACEMENT_SALT.nauvisRocks);
  ...
      if (isWater(base.data[o], base.data[o + 1], base.data[o + 2])) continue;
      const wx = originX + px * tpp;
      if (roll(wx, wy) >= density(wx, wy)) continue;
      paintMark(base, px, py, ROCK_MAP_COLOR, PLACEMENT_MARK_RADIUS_PX, isWater);
```

Note `isWater` is passed to `paintMark` too: the 3x3 mark must not spill onto a
water pixel that the 1px render could never have touched.

Delete `ROCK_FOOTPRINT_THRESHOLD` and rewrite the file's "Interim fidelity"
comment, which currently points at the superseded 2026-07-22 dither spec.

- [ ] **Step 4: Run and re-probe the Nauvis overlap window**

Run: `pnpm vp test test/elevationRenderRequest.spec.ts test/entityDensity.spec.ts`

The `view 'all'` composite test asserts `rocksOver > 0` - pixels painted by BOTH
rocks and resources. That window already had only ~4 such pixels at the old 1.6%
coverage, and the roll lowers rock coverage further, so **expect this to fail**.
Re-probe for a window with a workable count exactly as the test's own comment
describes, update the `req` block and the comment's numbers, and if no window
gives a comfortable count, split the rocks-over-resources assertion into its own
test with its own window rather than weakening the union assertions.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm vp check --fix && pnpm run verify
git add src/noise/preview/renderRocks.ts src/noise/rocks/rockCatalog.ts test/elevationRenderRequest.spec.ts test/entityDensity.spec.ts
git commit -m "feat(preview): roll Nauvis rocks per tile instead of thresholding"
```

---

### Task 6: Nauvis enemy bases roll instead of threshold

**Files:**
- Modify: `src/noise/preview/renderEnemies.ts`
- Modify: `src/noise/enemies/enemyCatalog.ts` (delete `ENEMY_FOOTPRINT_THRESHOLD`)
- Test: `test/entityDensity.spec.ts`, `test/renderEnemies.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4. `makeEnemyBaseField(...).probability(x, y)` already returns `clamp(min(field, 0.25), 0, 1)` (`src/noise/enemies/enemyBaseField.ts:135`), which is exactly the value to roll against - no new math.

- [ ] **Step 1: Write the failing density assertion**

Add a Nauvis enemy case to `test/entityDensity.spec.ts` summing the game's
`biter-spawner` + `spitter-spawner` counts against
`placedCount(region, PLACEMENT_SALT.enemyBases, f.probability)`. Measure-then-pin.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vp test test/entityDensity.spec.ts -t "enemy"`
Expected: FAIL until the band is set from the measured `rel`.

- [ ] **Step 3: Implement the roll**

```ts
  const roll = makePlacementRoll(PLACEMENT_SALT.enemyBases);
  ...
      if (isWater(base.data[o], base.data[o + 1], base.data[o + 2])) continue;
      const wx = originX + px * tpp;
      if (roll(wx, wy) >= f.probability(wx, wy)) continue;
      paintMark(base, px, py, ENEMY_MAP_COLOR, PLACEMENT_MARK_RADIUS_PX, isWater);
```

Delete `ENEMY_FOOTPRINT_THRESHOLD`.

- [ ] **Step 4: Run the enemy render tests**

Run: `pnpm vp test test/renderEnemies.spec.ts test/elevationRenderRequest.spec.ts`

Any existing test asserting a *solid* enemy footprint (contiguous red region, or a
specific painted-pixel count) is now describing the old behavior. Rewrite such an
assertion to describe placement - painted pixels are `ENEMY_MAP_COLOR`, coverage
is far below the old footprint, and at least one pixel is painted - rather than
deleting the test.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm vp check --fix && pnpm run verify
git add src/noise/preview/renderEnemies.ts src/noise/enemies/enemyCatalog.ts test/renderEnemies.spec.ts test/entityDensity.spec.ts test/elevationRenderRequest.spec.ts
git commit -m "feat(preview): roll Nauvis enemy bases per tile instead of thresholding"
```

---

### Task 7: Vulcanus geyser - real probability, then roll

**Files:**
- Modify: `src/noise/resources/vulcanusResourceCatalog.ts`
- Modify: `src/noise/preview/renderVulcanusResources.ts`
- Test: `test/vulcanusResourceRender.spec.ts`, `test/entityDensity.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces: `VulcanusResourceParams` gains
  `readonly placement: "threshold" | "roll"` and
  `readonly probability?: (r: VulcanusResources) => (x: number, y: number) => number`.

**The geyser needs no new noise expression.** Its probability is already written
down in the catalog's own comment (`vulcanusResourceCatalog.ts:80`, from
`planet-vulcanus-map-gen.lua:849`):

```
probability = (control:sulfuric_acid_geyser:size > 0) * 0.025 * ((patchy > 0) + 2 * patchy)
```

and `sulfuricAcidRegionPatchy` is already ported and oracle-validated. This is a
formula over an existing field, so the spec's "the geyser has no probability field
yet" risk is smaller than written - record that correction in the notes.

- [ ] **Step 1: Write the failing test**

```ts
// test/vulcanusResourceRender.spec.ts
it("geyser probability follows the game's expression: 0.025 * ((patchy > 0) + 2*patchy)", () => {
  const ctx = withCtxDefaults({ seed0: 123456, startingPositions: [{ x: 0, y: 0 }] });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);
  const entry = VULCANUS_RESOURCE_CATALOG.find((p) => p.name === "sulfuric-acid-geyser")!;
  expect(entry.placement).toBe("roll");
  const prob = entry.probability!(resources);
  let sawPositive = false;
  for (let y = -512; y < 512; y += 37) {
    for (let x = -512; x < 512; x += 37) {
      const patchy = resources.sulfuricAcidRegionPatchy(x, y);
      const expected = 0.025 * ((patchy > 0 ? 1 : 0) + 2 * patchy);
      expect(prob(x, y)).toBeCloseTo(expected, 12);
      if (expected > 0) sawPositive = true;
    }
  }
  expect(sawPositive).toBe(true);
  // The cap the spec quotes - if this ever exceeds ~0.065 the expression is wrong.
  expect(prob(0, 0)).toBeLessThan(0.07);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vp test test/vulcanusResourceRender.spec.ts -t "geyser probability"`
Expected: FAIL - `placement` and `probability` do not exist on the catalog entry.

- [ ] **Step 3: Implement**

Add `placement: "threshold"` to the three solid ore entries. On the geyser entry
set `placement: "roll"` and:

```ts
    probability: (r) => (x, y) => {
      const patchy = r.sulfuricAcidRegionPatchy(x, y);
      return 0.025 * ((patchy > 0 ? 1 : 0) + 2 * patchy);
    },
```

Replace the entry's long "this does not pretend to place one" comment with a short
statement of the expression and its source line.

In `renderVulcanusResources`, build a roll and branch per entry:

```ts
  const geyserRoll = makePlacementRoll(PLACEMENT_SALT.vulcanusGeyser);
  ...
      for (const r of active) {
        if (r.params.placement === "roll") {
          if (geyserRoll(wx, wy) >= r.probability!(wx, wy)) continue;
          paintMark(base, px, py, r.params.mapColor, PLACEMENT_MARK_RADIUS_PX);
          break;
        }
        const probability = 1000 * r.region(wx, wy);
        if (probability < PROBABILITY_THRESHOLD) continue;
        // ...existing opaque single-pixel paint, unchanged...
        break;
      }
```

Catalog order still decides contention, and the geyser is still last - so a solid
ore continues to win a shared tile, which is the behavior the catalog comment
already documents.

- [ ] **Step 4: Run, and add the geyser density assertion**

Run: `pnpm vp test test/vulcanusResourceRender.spec.ts test/vulcanusRender.spec.ts`

Then add the `sulfuric-acid-geyser` case to `test/entityDensity.spec.ts` with the
measure-then-pin rule, and run `pnpm vp test test/entityDensity.spec.ts`.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm vp check --fix && pnpm run verify
git add src/noise/resources/vulcanusResourceCatalog.ts src/noise/preview/renderVulcanusResources.ts test/vulcanusResourceRender.spec.ts test/entityDensity.spec.ts
git commit -m "feat(vulcanus): place geysers by roll against their real probability"
```

---

### Task 8: Nauvis crude oil - the `random_penalty` question, timeboxed

**Files:**
- Modify: `src/noise/resources/resourceCatalog.ts`, `src/noise/resources/resolveResource.ts`, `src/noise/preview/renderResources.ts`
- Test: `test/resolveResource.spec.ts`, `test/entityDensity.spec.ts`
- Docs: `docs/noise/random-penalty-NOTES.md`

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces: `ResourceParams` gains `readonly placement: "threshold" | "roll"`.
  `makeResourceResolver` returns the winner using `probability >= 0.5` for
  `"threshold"` resources and `roll(x, y) < probability(x, y)` for `"roll"` ones.

**This is the one task that may not land.** Per the spec: the game multiplies
oil's probability by `random_penalty{x, y, source = 1, amplitude = 48}`
(`core/lualib/resource-autoplace.lua:103-105`), and `random_penalty` is a **batch**
op whose value depends on the batch's extent and order
(`src/noise/randomPenalty.ts`). Our notes pin that for the resource-spot path, not
the noise-evaluation path.

**Timebox the investigation to one sitting.** If the batch extent and order for
the noise path are not settled by then, take fallback (a) below, write down what
was learned, and move on. Do not let oil block Task 9.

- [ ] **Step 1: Investigate the batch extent, then choose**

Determine whether the noise-evaluation batch for `random_penalty` is the 32x32
chunk (which would make it composable with the roll's chunk structure) or
something else. Record the finding in `docs/noise/random-penalty-NOTES.md`
regardless of outcome. Then pick:

- **(a) Fallback, no factor.** Oil rolls against the un-penalised
  `clamp(all_patches, 0, 1)`. Density will be ~48x too high - so oil is
  **excluded from the density oracle** and that exclusion is documented as a known
  gap, not hidden.
- **(b) Full.** Oil rolls against `probability * random_penalty{...}` evaluated
  per chunk in the game's order, and joins the oracle like the others.

- [ ] **Step 2: Write the failing test**

```ts
// test/resolveResource.spec.ts
it("crude oil is a roll resource; the four solids and uranium are thresholds", () => {
  for (const p of RESOURCE_CATALOG) {
    expect(p.placement).toBe(p.name === "crude-oil" ? "roll" : "threshold");
  }
});

it("a roll resource can lose a tile it would have won under the threshold rule", () => {
  // Same field, same tile: threshold semantics accept every tile with p >= 0.5,
  // the roll accepts only those whose U falls under p.
  const resolve = makeResourceResolver({ seed0: 123456, controls: {} });
  let thresholdWins = 0;
  let rollWins = 0;
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const w = resolve(x, y);
      if (w?.name === "crude-oil") rollWins++;
      if (w !== null) thresholdWins++;
    }
  expect(rollWins).toBeLessThan(thresholdWins);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vp test test/resolveResource.spec.ts`
Expected: FAIL - `placement` is not a property of `ResourceParams`.

- [ ] **Step 4: Implement**

Add `placement: "threshold"` to the five non-oil catalog entries and
`placement: "roll"` to `crude-oil`. In `makeResourceResolver`, build
`const oilRoll = makePlacementRoll(PLACEMENT_SALT.crudeOil)` and change the
per-tile loop to:

```ts
  return (x, y) => {
    for (const f of fields) {
      const p = f.patches.probability(x, y);
      if (f.params.placement === "roll") {
        if (oilRoll(x, y) < p) return f.params;
        continue;
      }
      if (p >= 0.5) return f.params;
    }
    return null;
  };
```

In `renderResources`, paint a roll winner with
`paintMark(base, px, py, winner.mapColor, PLACEMENT_MARK_RADIUS_PX, isWater)` and
leave threshold winners on the existing single-pixel paint, so ore patches keep
their exact edges.

- [ ] **Step 5: Run, then gate and commit**

```bash
pnpm vp test test/resolveResource.spec.ts test/renderResources.spec.ts test/entityDensity.spec.ts
pnpm vp check --fix && pnpm run verify
git add -A src/noise/resources src/noise/preview/renderResources.ts test docs/noise/random-penalty-NOTES.md
git commit -m "feat(preview): place crude oil by roll rather than a 0.5 threshold"
```

---

### Task 9: Coarse rock field sampling - the perf fix

**Files:**
- Modify: `src/noise/preview/renderVulcanusRocks.ts`, `src/noise/preview/renderRocks.ts`
- Test: `test/rockLattice.spec.ts` (create)

**Interfaces:**
- Produces: `export const ROCK_FIELD_LATTICE: number` in `src/noise/rocks/rockCatalog.ts` - the tile stride at which the rock probability field is evaluated. **Every tile still rolls.**

Only the *field* is sampled coarsely. The roll stays per tile, so density is
preserved and the density oracle from Task 4 stays valid; what degrades is *where*
rocks land, not *how many*.

- [ ] **Step 1: Measure before choosing**

Write a temporary spec that, for lattice 1, 2 and 4, reports over a 512x512 world
window on both planets: placed count, and a clumping proxy (the fraction of placed
tiles whose 4-neighbourhood contains another placed tile). Run it, record the three
rows, and **pick the largest lattice whose placed count stays within a few percent
of lattice 1 and whose clumping proxy does not jump.** The spec's expectation is 2
- `vulcanus_decorative_knockout` runs at `input_scale = 1/3`, roughly a 5-tile
wavelength, so a 4-tile lattice would start smearing the patchiness. Confirm or
refute that from the measurement; do not assume it.

- [ ] **Step 2: Write the failing test**

```ts
// test/rockLattice.spec.ts
import { describe, expect, it } from "vite-plus/test";
import { ROCK_FIELD_LATTICE } from "../src/noise/rocks/rockCatalog";
import { PLACEMENT_SALT, makePlacementRoll } from "../src/noise/placement/placementRoll";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusRockFields } from "../src/noise/rocks/vulcanusRockField";

describe("coarse rock field sampling", () => {
  it("preserves placed density: the lattice degrades WHERE, not HOW MANY", () => {
    const ctx = withCtxDefaults({ seed0: 123456, startingPositions: [{ x: 0, y: 0 }] });
    const { density } = makeVulcanusRockFields(ctx);
    const count = (stride: number): number => {
      const roll = makePlacementRoll(PLACEMENT_SALT.vulcanusRocks);
      let n = 0;
      for (let y = -256; y < 256; y++)
        for (let x = -256; x < 256; x++) {
          const sx = Math.floor(x / stride) * stride;
          const sy = Math.floor(y / stride) * stride;
          if (roll(x, y) < density(sx, sy)) n++;
        }
      return n;
    };
    const fine = count(1);
    const coarse = count(ROCK_FIELD_LATTICE);
    expect(Math.abs(coarse - fine) / fine).toBeLessThan(DENSITY_TOLERANCE);
  }, 30000);
});
```

`DENSITY_TOLERANCE` comes from Step 1's measurement, with the measured value in a
comment beside it.

- [ ] **Step 3: Implement**

In both rock renderers, snap the field lookup to the lattice while keeping the roll
per tile:

```ts
  const L = ROCK_FIELD_LATTICE;
  ...
      const wx = originX + px * tpp;
      const sx = Math.floor(wx / L) * L;
      const sy = Math.floor(wy / L) * L;
      if (roll(wx, wy) >= density(sx, sy)) continue;
```

Hoist `sy` out of the inner loop. Note the existing single-slot `memoXY` cache on
the field DAG now hits far more often, which is where the saving comes from.

- [ ] **Step 4: Re-benchmark against the gate**

```bash
pnpm perf
```

Record the new table. **`all` on Vulcanus must be under 2x the terrain baseline**
(the pre-change numbers were terrain 12.68, `all` 27.01 = 2.13x; the gate is
25.36). Nauvis must not regress. If `all` is still over, do not tune the lattice
past what Step 1's measurement supports - report the shortfall with both tables.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm vp check --fix && pnpm run verify
git add src/noise/preview/renderRocks.ts src/noise/preview/renderVulcanusRocks.ts src/noise/rocks/rockCatalog.ts test/rockLattice.spec.ts
git commit -m "perf(preview): sample the rock probability field on a coarse lattice"
```

---

### Task 10: Documentation and issue closure

**Files:**
- Modify: `docs/noise/vulcanus-rocks-NOTES.md`, `docs/noise/placement-roll-NOTES.md`, `docs/noise/vulcanus-cliffs-NOTES.md`, `docs/noise/client-preview-ROADMAP.md`
- GitHub: issue #9

- [ ] **Step 1: Rewrite the rocks notes**

In `docs/noise/vulcanus-rocks-NOTES.md`, replace "The render is a threshold, and it
does not look like the game" with what the roll does, keeping the plateau
coverage table as the *reason* the threshold could never work. Add the measured
post-roll coverage and the lattice choice from Task 9.

- [ ] **Step 2: Update the placement-roll notes**

In `docs/noise/placement-roll-NOTES.md`, add a section recording what was actually
built versus what the M3.5 spike stopped on: the two departures, why dropping the
jitter draws restores per-position purity, the salt, and the density-oracle result
per overlay. The STOP-AND-REPORT section stays - it is still the correct account of
the tile-exact version.

- [ ] **Step 3: Update the cliffs notes and the roadmap**

In `docs/noise/vulcanus-cliffs-NOTES.md`, update "Performance, and a known
duplication" with the new measurement and the resolution, including that fusing the
passes was costed and dropped because it cannot help cliffs at all. In
`docs/noise/client-preview-ROADMAP.md`, update the per-resource render rule entry.

- [ ] **Step 4: Close issue #9**

```bash
gh issue comment 9 --body-file <written-up summary>
gh issue close 9
```

The comment states which of the four consumers landed, the measured density
agreement per overlay, and - if Task 8 took fallback (a) - that oil is placed
without its `random_penalty` factor and why, with a new issue opened for it.

- [ ] **Step 5: Final gate and commit**

```bash
pnpm run verify && pnpm perf
git add docs/
git commit -m "docs: record the placement roll as built, and close out issue #9"
```

---

## Self-Review

**Spec coverage.** Module (T1), `paintMark` (T2), all five overlays (T3, T5, T6,
T7, T8), mark size (defined in T3, used by all), density oracle plus PROVENANCE
(T4, extended in T5-T8), unit tests for word/reverse-index/world-anchoring/
decorrelation (T1) and the rock lattice (T9), performance (T9), documentation and
issue closure (T10). The spec's three risks each have a home: oil's batch op is
T8's timebox with an explicit fallback, the geyser is T7 (and the plan corrects
the spec - the expression already exists in a comment, so no new noise port), and
white-noise clumping is a judgement call surfaced by T9's clumping proxy and the
rendered result.

**Deletions covered.** `VULCANUS_ROCK_FOOTPRINT_THRESHOLD` (T3),
`ROCK_FOOTPRINT_THRESHOLD` (T5), `ENEMY_FOOTPRINT_THRESHOLD` (T6).

**Type consistency.** `makePlacementRoll(salt: number)` returns
`(x, y) => number` everywhere; `PLACEMENT_SALT` keys are used verbatim
(`vulcanusRocks`, `nauvisRocks`, `enemyBases`, `vulcanusGeyser`, `crudeOil`);
`PLACEMENT_MARK_RADIUS_PX` is defined in T3 and used unchanged in T5-T8;
`paintMark`'s signature is fixed in T2 and every later call matches it;
`placement: "threshold" | "roll"` has the same shape on both `ResourceParams` and
`VulcanusResourceParams`.

**Known test churn, called out rather than discovered.** Both composite-order
tests hold windows probed against the old solid-footprint renders, and lower
coverage will likely empty their overlap sets: T3 re-probes the Vulcanus window,
T5 the Nauvis one. Both say re-probe, never loosen. Any enemy test asserting a
solid footprint is rewritten in T6 to describe placement.

**Two numbers this plan deliberately does not contain:** the oracle band (T4) and
the lattice tolerance (T9). Both are measured first and pinned second, because a
guessed band is how a wrong field passes.
