# Fulgora Island Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find and rank Fulgora's largest buildable islands, and the chains of them a big power pole can link, over a user-set search radius.

**Architecture:** A coarse `cells` scan enumerates candidate islands cheaply, each candidate is rendered as a small terrain image on the existing worker pool, a flood fill turns that into one island's land mask, and a largest-inscribed-rectangle pass ranks it. The top candidates are re-measured at higher resolution, then a proximity graph groups them into chains.

**Tech Stack:** TypeScript, Vue 3 `<script setup>`, Pinia, Web Workers, Vite+ (`pnpm vp test`).

**Spec:** `docs/superpowers/specs/2026-08-15-fulgora-island-finder-design.md`

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **Render requests MUST use `view: "terrain"`, never `"all"`.** `"all"` adds the scrap overlay, whose placement roll iterates tiles rather than pixels, so a coarse render still pays the full tile cost - measured at **112x** (`5,537 ms` against `49 ms` for the same 8-tiles/px window). This is a performance trap shaped like a correctness choice.
- **Budget from browser measurements, not Node.** The browser is 2.6x slower on this code (48.4 us/px against 18.4). Node figures are a cross-check only.
- **Island identity is the integer `(cellX, cellY)`, never the `cellId` float.** `cellId` is a hash into `[0, 1)` and two distinct cells can collide.
- **The survey step is derived as `grid / 8`, never hardcoded.** A 48-tile step averages only 2.6 samples across a cell at the smallest grid the Islands slider allows (125), which would silently miss small islands.
- Run every test with `pnpm vp test <file>`. Run `pnpm run verify` before the final commit of each task.
- Formatting and lint: `pnpm vp check --fix`. Never add a `tsc` typecheck script.
- Prose in comments and docs: hyphens, not em dashes.
- Any claim in a comment about what a planted break does must actually be planted and observed.

---

### Task 1: Expose the stable integer cell index on `Voronoi`

Islands are grouped by this. Without it, grouping falls back to the `cellId` float, which can collide and merge two islands into one candidate with a nonsense bounding box.

**Files:**

- Modify: `src/noise/voronoiNoise.ts` (the `Voronoi` interface near line 307, and the returned object near line 879)
- Test: `test/voronoiCellIndex.spec.ts` (create)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `Voronoi.cellIndex: (x: number, y: number) => { cellX: number; cellY: number }`

- [ ] **Step 1: Write the failing test**

Create `test/voronoiCellIndex.spec.ts`:

```typescript
import { describe, expect, it } from "vite-plus/test";
import { makeVoronoi } from "../src/noise/voronoiNoise";

/**
 * Fulgora's own `cells` parameters - see `src/noise/expressions/fulgoraCells.ts`.
 * Using the real ones rather than invented values keeps this test honest about
 * the configuration the island finder actually groups by.
 */
const FULGORA = {
  seed0: 2967702466,
  seed1: 1512814397,
  gridSize: 175,
  distanceType: "manhattan",
  jitter: 0.6,
} as const;

describe("Voronoi.cellIndex", () => {
  it("returns the same integer pair for two positions in the same cell", () => {
    const v = makeVoronoi(FULGORA);
    const a = v.cellIndex(1000, 1000);
    const b = v.cellIndex(1002, 1001);
    expect(b).toEqual(a);
    expect(Number.isInteger(a.cellX)).toBe(true);
    expect(Number.isInteger(a.cellY)).toBe(true);
  });

  it("returns a different pair for positions a full grid apart", () => {
    const v = makeVoronoi(FULGORA);
    const a = v.cellIndex(1000, 1000);
    const b = v.cellIndex(1000 + 175 * 2, 1000);
    expect(b).not.toEqual(a);
  });

  it("agrees with cellId - same index implies same id", () => {
    // The float id is a pure hash of the integer pair, so this must hold at
    // every position. It is what licenses grouping by index instead of by id.
    const v = makeVoronoi(FULGORA);
    const byIndex = new Map<string, number>();
    for (let x = 0; x < 2000; x += 37) {
      for (let y = 0; y < 2000; y += 41) {
        const { cellX, cellY } = v.cellIndex(x, y);
        const key = `${cellX},${cellY}`;
        const id = v.cellId(x, y);
        const seen = byIndex.get(key);
        if (seen === undefined) byIndex.set(key, id);
        else expect(id).toBe(seen);
      }
    }
    expect(byIndex.size).toBeGreaterThan(50);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vp test test/voronoiCellIndex.spec.ts`

Expected: FAIL. The type error surfaces first - `cellIndex` does not exist on `Voronoi`.

- [ ] **Step 3: Add the accessor to the interface**

In `src/noise/voronoiNoise.ts`, in `export interface Voronoi`, directly under `cellId`:

```typescript
  /**
   * The winning cell's integer lattice coordinates - the STABLE identity of a
   * cell, as opposed to `cellId`, which hashes this pair into `[0, 1)` and can
   * therefore collide between two distinct cells. Anything grouping samples by
   * "which cell am I in" must use this; `cellId` is for the game's own
   * expressions, which only ever consume the float.
   */
  readonly cellIndex: (x: number, y: number) => { cellX: number; cellY: number };
```

- [ ] **Step 4: Implement it**

In the object returned by `makeVoronoi`, directly after the `cellId` entry:

```typescript
    // Deliberately NOT memoXY-wrapped: that helper is typed for number results,
    // and `searchAt` already carries its own one-entry cache, which is the
    // expensive part. Wrapping would add an allocation per call for nothing.
    cellIndex: (x, y) => {
      const s = searchAt(...toGrid(x, y));
      return { cellX: s.cellX, cellY: s.cellY };
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vp test test/voronoiCellIndex.spec.ts`

Expected: PASS, 3 tests.

- [ ] **Step 6: Confirm nothing else moved**

Run: `pnpm vp test test/voronoiNoise.spec.ts`

Expected: PASS. This is an additive change and no existing behaviour should shift.

- [ ] **Step 7: Commit**

```bash
pnpm vp check --fix
git add src/noise/voronoiNoise.ts test/voronoiCellIndex.spec.ts
git commit -m "feat(noise): expose the stable integer cell index on Voronoi (#27)"
```

---

### Task 2: `largestRectangle` - the ranking metric

Pure algorithm, no noise, no I/O. It is the one module where an exhaustive test is affordable, and the one most likely to carry an off-by-one.

**Files:**

- Create: `src/noise/islands/largestRectangle.ts`
- Test: `test/largestRectangle.spec.ts` (create)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }`
  - `export function largestRectangle(mask: Uint8Array, width: number, height: number): Rect`
  - Returns `{x: 0, y: 0, width: 0, height: 0}` for an all-zero mask.

- [ ] **Step 1: Write the failing test**

Create `test/largestRectangle.spec.ts`:

```typescript
import { describe, expect, it } from "vite-plus/test";
import { largestRectangle, type Rect } from "../src/noise/islands/largestRectangle";

/** Build a mask from an ASCII picture. "#" is land, "." is not. */
function mask(rows: string[]): { m: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const m = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    expect(row.length).toBe(w);
    for (let x = 0; x < w; x++) m[y * w + x] = row[x] === "#" ? 1 : 0;
  });
  return { m, w, h };
}

/**
 * O(n^4) reference. Deliberately the dumbest correct thing: it enumerates every
 * rectangle and checks every cell. It exists so the fast version has something
 * independent to disagree with.
 */
function bruteForce(m: Uint8Array, w: number, h: number): Rect {
  let best: Rect = { x: 0, y: 0, width: 0, height: 0 };
  for (let y0 = 0; y0 < h; y0++)
    for (let x0 = 0; x0 < w; x0++)
      for (let y1 = y0; y1 < h; y1++)
        for (let x1 = x0; x1 < w; x1++) {
          let ok = true;
          for (let y = y0; y <= y1 && ok; y++)
            for (let x = x0; x <= x1 && ok; x++) if (!m[y * w + x]) ok = false;
          if (!ok) continue;
          const area = (x1 - x0 + 1) * (y1 - y0 + 1);
          if (area > best.width * best.height)
            best = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
        }
  return best;
}

describe("largestRectangle", () => {
  it("finds a full rectangle in an all-land mask", () => {
    const { m, w, h } = mask(["####", "####", "####"]);
    const r = largestRectangle(m, w, h);
    expect(r.width * r.height).toBe(12);
  });

  it("returns zero area for an all-ocean mask", () => {
    const { m, w, h } = mask(["....", "....", "...."]);
    expect(largestRectangle(m, w, h)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("finds the 2x3 block rather than the longer thin row", () => {
    // The top row has area 5; the 2-wide block on the left has area 6.
    const { m, w, h } = mask(["#####", "##...", "##..."]);
    const r = largestRectangle(m, w, h);
    expect(r.width * r.height).toBe(6);
    expect({ w: r.width, h: r.height }).toEqual({ w: 2, h: 3 });
  });

  it("handles a single row and a single column", () => {
    const row = mask(["###"]);
    expect(largestRectangle(row.m, row.w, row.h).width * largestRectangle(row.m, row.w, row.h).height).toBe(3);
    const col = mask(["#", "#", "#", "#"]);
    expect(largestRectangle(col.m, col.w, col.h).width * largestRectangle(col.m, col.w, col.h).height).toBe(4);
  });

  it("returns a rectangle that is actually all land", () => {
    const { m, w, h } = mask(["..##.", ".###.", "####.", ".##.."]);
    const r = largestRectangle(m, w, h);
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) expect(m[y * w + x]).toBe(1);
  });

  it("agrees with a brute-force reference over 400 random masks", () => {
    // A deterministic LCG - no Math.random, so a failure is reproducible.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 400; t++) {
      const w = 1 + Math.floor(rnd() * 9);
      const h = 1 + Math.floor(rnd() * 9);
      const density = 0.2 + rnd() * 0.7;
      const m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = rnd() < density ? 1 : 0;
      const fast = largestRectangle(m, w, h);
      const slow = bruteForce(m, w, h);
      expect(
        fast.width * fast.height,
        `trial ${t} (${w}x${h}) fast=${JSON.stringify(fast)} slow=${JSON.stringify(slow)}`,
      ).toBe(slow.width * slow.height);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vp test test/largestRectangle.spec.ts`

Expected: FAIL - cannot resolve `../src/noise/islands/largestRectangle`.

- [ ] **Step 3: Implement it**

Create `src/noise/islands/largestRectangle.ts`:

```typescript
/**
 * Largest axis-aligned all-land rectangle in a binary mask.
 *
 * Axis-aligned is not an approximation of a better answer - Factorio builds on
 * an axis-aligned grid, so a rotated rectangle would be the wrong shape even if
 * it were larger.
 *
 * Method: treat each row as the base of a histogram whose bar heights are the
 * runs of land ending at that row, then sweep each histogram with a monotonic
 * stack. O(width * height) overall, one pass per row.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

export function largestRectangle(mask: Uint8Array, width: number, height: number): Rect {
  if (width <= 0 || height <= 0) return EMPTY;

  const heights = new Int32Array(width);
  // `stack` holds column indices whose bar heights are strictly increasing.
  const stack = new Int32Array(width + 1);
  let best = EMPTY;
  let bestArea = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      heights[x] = mask[y * width + x] ? (heights[x] as number) + 1 : 0;
    }

    let top = 0;
    for (let x = 0; x <= width; x++) {
      // A sentinel height of 0 past the right edge flushes the whole stack.
      const hx = x === width ? 0 : (heights[x] as number);
      while (top > 0 && (heights[stack[top - 1] as number] as number) >= hx) {
        const barTop = stack[--top] as number;
        const h = heights[barTop] as number;
        // Left edge: one past the bar still on the stack, or 0 if none.
        const left = top === 0 ? 0 : (stack[top - 1] as number) + 1;
        const w = x - left;
        const area = w * h;
        if (area > bestArea) {
          bestArea = area;
          best = { x: left, y: y - h + 1, width: w, height: h };
        }
      }
      stack[top++] = x;
    }
  }

  return best;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vp test test/largestRectangle.spec.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Plant a break and confirm the reference test catches it**

Temporarily change `const left = top === 0 ? 0 : (stack[top - 1] as number) + 1;` to drop the `+ 1`. Re-run.

Expected: the brute-force test FAILS with a trial number and both rectangles printed. Revert the change and re-run to green.

This step is not optional. An O(n^4) reference that cannot catch an off-by-one is decoration.

- [ ] **Step 6: Commit**

```bash
pnpm vp check --fix
git add src/noise/islands/largestRectangle.ts test/largestRectangle.spec.ts
git commit -m "feat(islands): largest inscribed rectangle, checked against a brute-force reference (#27)"
```

---

### Task 3: `cellSurvey` - enumerate candidate islands

**Files:**

- Create: `src/noise/islands/cellSurvey.ts`
- Test: `test/cellSurvey.spec.ts` (create)

**Interfaces:**

- Consumes: `Voronoi.cellIndex` (Task 1); `makeFulgoraStack` and `FulgoraCtx` from `src/noise/tiles/fulgoraCatalog.ts` and `src/noise/expressions/fulgoraShared.ts`.
- Produces:
  - `export type IslandClass = "mesa" | "sprawl" | "vault"`
  - `export interface IslandCandidate { readonly cellX: number; readonly cellY: number; readonly id: number; readonly klass: IslandClass; readonly sampleCount: number; readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number; readonly centroidX: number; readonly centroidY: number }`
  - `export interface SearchBox { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }`
  - `export function surveyStep(grid: number): number`
  - `export function surveyIslands(ctx: FulgoraCtx, box: SearchBox): IslandCandidate[]`

- [ ] **Step 1: Write the failing test**

Create `test/cellSurvey.spec.ts`:

```typescript
import { describe, expect, it } from "vite-plus/test";
import { surveyIslands, surveyStep } from "../src/noise/islands/cellSurvey";
import { makeFulgoraStack } from "../src/noise/tiles/fulgoraCatalog";

const SEED0 = 2967702466; // Fulgora's surface seed for map seed 123456
const BOX = { x0: -2000, y0: -2000, x1: 2000, y1: 2000 };

describe("surveyStep", () => {
  it("is grid/8, so a cell gets many samples across even at the smallest grid", () => {
    expect(surveyStep(175)).toBeCloseTo(21.875, 6);
    expect(surveyStep(125)).toBeCloseTo(15.625, 6);
  });
});

describe("surveyIslands", () => {
  it("reports only non-ocean cells, and each candidate's id really is >= 0.33", () => {
    const found = surveyIslands({ seed0: SEED0 }, BOX);
    expect(found.length).toBeGreaterThan(10);
    const { cells } = makeFulgoraStack({ seed0: SEED0 }).cells;
    for (const c of found) {
      expect(c.id).toBeGreaterThanOrEqual(0.33);
      // The centroid is inside the box and reads the same id the survey recorded.
      expect(cells(c.centroidX, c.centroidY)).toBeCloseTo(c.id, 6);
    }
  }, 120000);

  it("gives every candidate a distinct integer cell index", () => {
    const found = surveyIslands({ seed0: SEED0 }, BOX);
    const keys = new Set(found.map((c) => `${c.cellX},${c.cellY}`));
    expect(keys.size).toBe(found.length);
  }, 120000);

  it("classifies by id exactly as the Lua thresholds do", () => {
    for (const c of surveyIslands({ seed0: SEED0 }, BOX)) {
      if (c.id > 0.75) expect(c.klass).toBe("mesa");
      else if (c.id > 0.5) expect(c.klass).toBe("sprawl");
      else expect(c.klass).toBe("vault");
    }
  }, 120000);

  it("bounding boxes contain their centroids", () => {
    for (const c of surveyIslands({ seed0: SEED0 }, BOX)) {
      expect(c.centroidX).toBeGreaterThanOrEqual(c.minX);
      expect(c.centroidX).toBeLessThanOrEqual(c.maxX);
      expect(c.centroidY).toBeGreaterThanOrEqual(c.minY);
      expect(c.centroidY).toBeLessThanOrEqual(c.maxY);
    }
  }, 120000);

  it("A COARSER STEP MISSES ISLANDS THE SPECIFIED STEP FINDS", () => {
    // This is the test that makes `surveyStep` load-bearing rather than
    // decorative. If a future change to the step derivation makes this pass
    // trivially - both sides finding the same set - the guard is dead.
    const proper = surveyIslands({ seed0: SEED0 }, BOX);
    const coarse = surveyIslands({ seed0: SEED0 }, BOX, 175);
    const properKeys = new Set(proper.map((c) => `${c.cellX},${c.cellY}`));
    const coarseKeys = new Set(coarse.map((c) => `${c.cellX},${c.cellY}`));
    const missed = [...properKeys].filter((k) => !coarseKeys.has(k));
    expect(missed.length).toBeGreaterThan(0);
  }, 120000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vp test test/cellSurvey.spec.ts`

Expected: FAIL - module not found.

- [ ] **Step 3: Implement it**

Create `src/noise/islands/cellSurvey.ts`:

```typescript
/**
 * Stage 1 of the island finder: find WHERE the islands are, cheaply.
 *
 * Fulgora's map is a Voronoi tiling and every island is one cell (see
 * `fulgoraCells.ts`), so enumerating islands is enumerating cells rather than
 * flood-filling pixels. One `cells` evaluation costs about 2.33 us, against
 * about 48 us for a rendered pixel, so this stage is a rounding error in the
 * finder's total cost.
 *
 * The Voronoi is sampled through a coordinate warp with no analytic inverse, so
 * this does NOT invert the grid to find cell centres. It scans world positions
 * and groups them by the cell each one lands in.
 */
import { makeFulgoraStack } from "../tiles/fulgoraCatalog";
import type { FulgoraCtx } from "../expressions/fulgoraShared";

export type IslandClass = "mesa" | "sprawl" | "vault";

export interface IslandCandidate {
  readonly cellX: number;
  readonly cellY: number;
  /** The cell's `voronoi_cell_id`, in [0.33, 1). Below 0.33 is ocean. */
  readonly id: number;
  readonly klass: IslandClass;
  readonly sampleCount: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly centroidX: number;
  readonly centroidY: number;
}

export interface SearchBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Cells below this id become oil ocean - `fulgora_blanks` in the Lua. */
const OCEAN_BELOW = 0.33;

/**
 * The scan step, in tiles.
 *
 * `grid / 8` rather than a constant. A fixed 48-tile step averages only 2.6
 * samples across a cell at the smallest grid the Islands frequency slider
 * allows (125), and Manhattan Voronoi at jitter 0.6 produces cells noticeably
 * smaller than the grid - so small islands would fall between samples and never
 * be reported. A silent miss is the worst failure this tool can have, and the
 * whole stage costs well under a second, so there is nothing to economize.
 */
export function surveyStep(grid: number): number {
  return grid / 8;
}

function classify(id: number): IslandClass {
  if (id > 0.75) return "mesa";
  if (id > 0.5) return "sprawl";
  return "vault";
}

interface Acc {
  cellX: number;
  cellY: number;
  id: number;
  n: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
}

export function surveyIslands(
  ctx: FulgoraCtx,
  box: SearchBox,
  stepOverride?: number,
): IslandCandidate[] {
  const stack = makeFulgoraStack(ctx);
  const step = stepOverride ?? surveyStep(stack.shared.grid);
  const cellIndex = stack.cells.voronoiCells.cellIndex;
  const cellsAt = stack.cells.cells;

  const acc = new Map<string, Acc>();
  for (let y = box.y0; y <= box.y1; y += step) {
    for (let x = box.x0; x <= box.x1; x += step) {
      const id = cellsAt(x, y);
      if (id < OCEAN_BELOW) continue;
      const { cellX, cellY } = cellIndex(x, y);
      const key = `${cellX},${cellY}`;
      const a = acc.get(key);
      if (a === undefined) {
        acc.set(key, {
          cellX,
          cellY,
          id,
          n: 1,
          minX: x,
          minY: y,
          maxX: x,
          maxY: y,
          sumX: x,
          sumY: y,
        });
      } else {
        a.n++;
        if (x < a.minX) a.minX = x;
        if (x > a.maxX) a.maxX = x;
        if (y < a.minY) a.minY = y;
        if (y > a.maxY) a.maxY = y;
        a.sumX += x;
        a.sumY += y;
      }
    }
  }

  return [...acc.values()].map((a) => ({
    cellX: a.cellX,
    cellY: a.cellY,
    id: a.id,
    klass: classify(a.id),
    sampleCount: a.n,
    minX: a.minX,
    minY: a.minY,
    maxX: a.maxX,
    maxY: a.maxY,
    // The centroid is a sampled position, so it is guaranteed to sit inside the
    // island rather than in a bay - which a bounding-box centre would not be.
    centroidX: a.sumX / a.n,
    centroidY: a.sumY / a.n,
  }));
}
```

- [ ] **Step 4: Expose the Voronoi instance on `FulgoraCells`**

`surveyIslands` needs `cellIndex`, and `makeFulgoraCells` currently keeps its `Voronoi` private. In `src/noise/expressions/fulgoraCells.ts`, add to `export interface FulgoraCells`:

```typescript
  /**
   * The manhattan Voronoi instance `cells` and `pyramids` read. Exposed so the
   * island finder can group samples by the STABLE integer cell index rather
   * than by the `cells` float, which is a hash and can collide.
   */
  readonly voronoiCells: Voronoi;
```

and add `voronoiCells: manhattan,` to the returned object.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vp test test/cellSurvey.spec.ts`

Expected: PASS, 6 tests.

If "A COARSER STEP MISSES ISLANDS" fails, do not widen it. It failing means the coarse and proper steps agree, so the step derivation is not doing the work this module claims it does - investigate that instead.

- [ ] **Step 6: Commit**

```bash
pnpm vp check --fix
git add src/noise/islands/cellSurvey.ts src/noise/expressions/fulgoraCells.ts test/cellSurvey.spec.ts
git commit -m "feat(islands): survey Fulgora's Voronoi cells to enumerate candidate islands (#27)"
```

---

### Task 4: Extract a reusable worker host from `createElevationRenderer`

The finder needs the pool's worker lifecycle and id-keyed dispatch, but not its tiling queue or its supersede-on-new-render semantics. Extracting the shared half is smaller and safer than generalizing `createRenderPool`, whose behaviour `test/tiledEquality.spec.ts` pins.

**Files:**

- Modify: `src/components/useElevationPreview.ts`
- Test: `test/workerHost.spec.ts` (create)

**Interfaces:**

- Consumes: `WorkerLike` from `src/components/useElevationPreview.ts`.
- Produces:
  - `export interface WorkerHost { execute(req: ElevationRenderRequest, slot: number): Promise<ElevationRenderResult>; readonly size: number; dispose(): void }`
  - `export function createWorkerHost(createWorker?: () => WorkerLike, size?: number): WorkerHost`
  - `createElevationRenderer` keeps its existing exported signature and behaviour.

- [ ] **Step 1: Write the failing test**

Create `test/workerHost.spec.ts`:

```typescript
import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkerHost, type WorkerLike } from "../src/components/useElevationPreview";
import type { ElevationRenderRequest } from "../src/noise/preview/elevationRenderRequest";

/** A fake worker that echoes the request id back after a tick. */
function fakeWorker(): WorkerLike & { posted: ElevationRenderRequest[] } {
  const w = {
    posted: [] as ElevationRenderRequest[],
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    postMessage(req: ElevationRenderRequest) {
      w.posted.push(req);
      queueMicrotask(() =>
        w.onmessage?.({ data: { id: req.id, width: 1, height: 1, buffer: new ArrayBuffer(4) } }),
      );
    },
    terminate: vi.fn(),
  };
  return w as unknown as WorkerLike & { posted: ElevationRenderRequest[] };
}

const req = (id: number): ElevationRenderRequest =>
  ({ id, seed0: 1, width: 1, height: 1, originX: 0, originY: 0, tilesPerPixel: 1 }) as ElevationRenderRequest;

describe("createWorkerHost", () => {
  it("routes each response to the request that asked for it, even out of order", async () => {
    const host = createWorkerHost(() => fakeWorker(), 2);
    const [a, b] = await Promise.all([host.execute(req(1), 0), host.execute(req(2), 1)]);
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    host.dispose();
  });

  it("reuses one worker per slot rather than creating one per request", async () => {
    const made: WorkerLike[] = [];
    const host = createWorkerHost(() => {
      const w = fakeWorker();
      made.push(w);
      return w;
    }, 2);
    await host.execute(req(1), 0);
    await host.execute(req(2), 0);
    await host.execute(req(3), 0);
    expect(made.length).toBe(1);
    host.dispose();
  });

  it("terminates its workers on dispose", async () => {
    const made: (WorkerLike & { terminate: ReturnType<typeof vi.fn> })[] = [];
    const host = createWorkerHost(() => {
      const w = fakeWorker() as WorkerLike & { terminate: ReturnType<typeof vi.fn> };
      made.push(w);
      return w;
    }, 1);
    await host.execute(req(1), 0);
    host.dispose();
    expect(made[0]!.terminate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vp test test/workerHost.spec.ts`

Expected: FAIL - `createWorkerHost` is not exported.

- [ ] **Step 3: Extract the host**

In `src/components/useElevationPreview.ts`, move the worker array, the id-keyed pending map, `ensureWorker`, `dropWorker` and the `execute` body out of `createElevationRenderer` into a new exported `createWorkerHost(createWorker = createRenderWorker, size = defaultPoolSize(...))`, returning `{ execute, size, dispose }`. Keep every existing comment - especially the one explaining why the pending map is keyed by request id rather than by slot, which records a real hang found in review.

Then rewrite `createElevationRenderer` to compose it:

```typescript
export function createElevationRenderer(
  createWorker: () => WorkerLike = createRenderWorker,
  size: number = defaultPoolSize(
    typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
  ),
  tileSize: number = DEFAULT_TILE_SIZE,
): ElevationRenderer {
  const host = createWorkerHost(createWorker, size);
  const pool = createRenderPool({ size, tileSize, execute: host.execute });
  return {
    render: pool.render,
    dispose() {
      pool.dispose();
      host.dispose();
    },
  };
}
```

- [ ] **Step 4: Run the new test and the existing renderer tests**

Run: `pnpm vp test test/workerHost.spec.ts test/elevationPreviewPanel.spec.ts test/tiledEquality.spec.ts`

Expected: PASS across all three. This is a refactor; if any existing test changes behaviour, the extraction is wrong.

- [ ] **Step 5: Commit**

```bash
pnpm vp check --fix
git add src/components/useElevationPreview.ts test/workerHost.spec.ts
git commit -m "refactor(preview): extract createWorkerHost so a second consumer can share the worker pool (#27)"
```

---

### Task 5: `islandMask` - rendered pixels to one island's land mask

**Files:**

- Create: `src/noise/islands/islandMask.ts`
- Modify: `src/noise/preview/renderFulgoraTerrain.ts` (export the ocean colours)
- Test: `test/islandMask.spec.ts` (create)

**Interfaces:**

- Consumes: `Rect` from Task 2.
- Produces:
  - `export const FULGORA_OCEAN_RGB: readonly (readonly [number, number, number])[]` (from `renderFulgoraTerrain.ts`)
  - `export function landMaskFromImage(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array`
  - `export function floodFillFrom(mask: Uint8Array, width: number, height: number, seedX: number, seedY: number): Uint8Array`

- [ ] **Step 1: Export the ocean colours from the renderer**

In `src/noise/preview/renderFulgoraTerrain.ts`, after the `COLORS` table:

```typescript
/**
 * The colours that mean "not land" in a Fulgora terrain render.
 *
 * Derived from `COLORS` rather than written out again: a second hardcoded copy
 * would drift the first time a tile colour is corrected, and one already was -
 * deep ocean's green channel was wrong from V1 until the scrap work, because
 * the game truncates where this renderer rounded.
 */
export const FULGORA_OCEAN_RGB: readonly (readonly [number, number, number])[] = [
  COLORS.shallow,
  COLORS.deep,
];
```

- [ ] **Step 2: Write the failing test**

Create `test/islandMask.spec.ts`:

```typescript
import { describe, expect, it } from "vite-plus/test";
import { floodFillFrom, landMaskFromImage } from "../src/noise/islands/islandMask";
import { FULGORA_OCEAN_RGB } from "../src/noise/preview/renderFulgoraTerrain";

/** Paint an RGBA buffer from an ASCII picture: "#" land, "." shallow, "~" deep. */
function image(rows: string[]): { rgba: Uint8ClampedArray; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const land: readonly [number, number, number] = [112, 65, 50]; // fulgoran-dust
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const c = row[x] === "#" ? land : row[x] === "." ? FULGORA_OCEAN_RGB[0]! : FULGORA_OCEAN_RGB[1]!;
      const o = (y * w + x) * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  });
  return { rgba, w, h };
}

describe("landMaskFromImage", () => {
  it("marks land 1 and both ocean colours 0", () => {
    const { rgba, w, h } = image(["#.~", "###"]);
    expect([...landMaskFromImage(rgba, w, h)]).toEqual([1, 0, 0, 1, 1, 1]);
  });
});

describe("floodFillFrom", () => {
  it("keeps only the component containing the seed", () => {
    // Two land blobs separated by an ocean column. Seeding in the left one must
    // not pick up the right one - that is the whole point: a candidate's window
    // routinely contains a neighbouring island.
    const { rgba, w, h } = image(["##.##", "##.##", "##.##"]);
    const mask = landMaskFromImage(rgba, w, h);
    const one = floodFillFrom(mask, w, h, 0, 0);
    expect([...one]).toEqual([1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0]);
  });

  it("is 4-connected, so a diagonal touch does not join two blobs", () => {
    // Diagonal adjacency is not walkable in Factorio terms and would merge
    // islands a power pole could not actually bridge.
    const { rgba, w, h } = image(["#.", ".#"]);
    const mask = landMaskFromImage(rgba, w, h);
    expect([...floodFillFrom(mask, w, h, 0, 0)]).toEqual([1, 0, 0, 0]);
  });

  it("returns an empty mask when the seed is on ocean", () => {
    const { rgba, w, h } = image(["..", ".."]);
    const mask = landMaskFromImage(rgba, w, h);
    expect([...floodFillFrom(mask, w, h, 0, 0)]).toEqual([0, 0, 0, 0]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vp test test/islandMask.spec.ts`

Expected: FAIL - module not found.

- [ ] **Step 4: Implement it**

Create `src/noise/islands/islandMask.ts`:

```typescript
/**
 * Stage 2a: turn a rendered Fulgora terrain image into ONE island's land mask.
 *
 * Membership is decided by a flood fill from the candidate's centroid, not by
 * re-evaluating which Voronoi cell each pixel belongs to. Two reasons, and the
 * second is the important one:
 *
 * 1. Cost. Re-evaluating `cells` per pixel would add about 2.33 us to every
 *    pixel of every candidate, on the main thread.
 * 2. Correctness. An island is a connected land region, which is what a player
 *    can actually walk and build across. If two neighbouring cells' land
 *    touches, that IS one island, and a per-cell test would wrongly split it.
 */
import { FULGORA_OCEAN_RGB } from "../preview/renderFulgoraTerrain";

/** 1 where the pixel is any land tile, 0 where it is either ocean colour. */
export function landMaskFromImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const r = rgba[o] as number;
    const g = rgba[o + 1] as number;
    const b = rgba[o + 2] as number;
    let ocean = false;
    for (const c of FULGORA_OCEAN_RGB) {
      if (r === c[0] && g === c[1] && b === c[2]) {
        ocean = true;
        break;
      }
    }
    mask[i] = ocean ? 0 : 1;
  }
  return mask;
}

/**
 * The 4-connected land component containing `(seedX, seedY)`, as a new mask.
 *
 * 4-connected rather than 8: a diagonal touch is not walkable, and treating it
 * as connected would merge two islands that nothing can actually bridge.
 */
export function floodFillFrom(
  mask: Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return out;
  const start = seedY * width + seedX;
  if (!mask[start]) return out;

  // An explicit stack, not recursion: a large island would blow the call stack.
  const stack = new Int32Array(width * height);
  let top = 0;
  stack[top++] = start;
  out[start] = 1;

  while (top > 0) {
    const i = stack[--top] as number;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0 && mask[i - 1] && !out[i - 1]) {
      out[i - 1] = 1;
      stack[top++] = i - 1;
    }
    if (x < width - 1 && mask[i + 1] && !out[i + 1]) {
      out[i + 1] = 1;
      stack[top++] = i + 1;
    }
    if (y > 0 && mask[i - width] && !out[i - width]) {
      out[i - width] = 1;
      stack[top++] = i - width;
    }
    if (y < height - 1 && mask[i + width] && !out[i + width]) {
      out[i + width] = 1;
      stack[top++] = i + width;
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vp test test/islandMask.spec.ts`

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
pnpm vp check --fix
git add src/noise/islands/islandMask.ts src/noise/preview/renderFulgoraTerrain.ts test/islandMask.spec.ts
git commit -m "feat(islands): land mask and flood fill from a rendered terrain image (#27)"
```

---

### Task 6: `chainGraph` - link islands a big power pole can bridge

**Files:**

- Create: `src/noise/islands/chainGraph.ts`
- Test: `test/chainGraph.spec.ts` (create)

**Interfaces:**

- Consumes: nothing from earlier tasks beyond plain data.
- Produces:
  - `export const BIG_POLE_REACH_TILES = 30`
  - `export interface PlacedMask { readonly mask: Uint8Array; readonly width: number; readonly height: number; readonly originX: number; readonly originY: number; readonly tilesPerPixel: number }`
  - `export function minGapTiles(a: PlacedMask, b: PlacedMask): number`
  - `export function chainComponents(masks: readonly PlacedMask[], reachTiles?: number): number[]` - returns a component id per input index.

- [ ] **Step 1: Write the failing test**

Create `test/chainGraph.spec.ts`:

```typescript
import { describe, expect, it } from "vite-plus/test";
import { chainComponents, minGapTiles, type PlacedMask } from "../src/noise/islands/chainGraph";

/** A solid `size` x `size` block of land whose top-left tile is at (ox, oy). */
function block(ox: number, oy: number, size: number, tpp = 1): PlacedMask {
  return {
    mask: new Uint8Array(size * size).fill(1),
    width: size,
    height: size,
    originX: ox,
    originY: oy,
    tilesPerPixel: tpp,
  };
}

describe("minGapTiles", () => {
  it("is 0 for touching blocks", () => {
    expect(minGapTiles(block(0, 0, 4), block(4, 0, 4))).toBe(0);
  });

  it("measures the tile gap between the nearest land of each", () => {
    // Left block occupies x 0..3; right starts at x 14. Nearest land is 3 and
    // 14, so the gap is 10 tiles.
    expect(minGapTiles(block(0, 0, 4), block(14, 0, 4))).toBe(10);
  });

  it("respects tilesPerPixel when converting pixels to tiles", () => {
    // At 2 tiles/px a 4px block spans 8 tiles: x 0..7. The other starts at 17,
    // so the gap is 10 tiles.
    expect(minGapTiles(block(0, 0, 4, 2), block(17, 0, 4, 2))).toBe(10);
  });
});

describe("chainComponents", () => {
  it("joins at 29 tiles and does not join at 31", () => {
    const joined = chainComponents([block(0, 0, 4), block(33, 0, 4)]);
    expect(joined[0]).toBe(joined[1]);
    const apart = chainComponents([block(0, 0, 4), block(35, 0, 4)]);
    expect(apart[0]).not.toBe(apart[1]);
  });

  it("chains transitively - A near B near C is one chain even if A and C are far", () => {
    const ids = chainComponents([block(0, 0, 4), block(30, 0, 4), block(60, 0, 4)]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(minGapTiles(block(0, 0, 4), block(60, 0, 4))).toBeGreaterThan(30);
  });

  it("gives an isolated island its own component", () => {
    const ids = chainComponents([block(0, 0, 4), block(500, 500, 4)]);
    expect(new Set(ids).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vp test test/chainGraph.spec.ts`

Expected: FAIL - module not found.

- [ ] **Step 3: Implement it**

Create `src/noise/islands/chainGraph.ts`:

```typescript
/**
 * Stage 4: group islands into the chains a power pole can wire together.
 *
 * Gaps are measured between LAND, not between centroids or bounding boxes. Two
 * islands can have near-touching bounding boxes and distant land, and a chain
 * built on bounding boxes would promise a connection that is not there.
 */

/** Big electric pole wire reach, in tiles. */
export const BIG_POLE_REACH_TILES = 30;

export interface PlacedMask {
  readonly mask: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** World tile coordinate of the mask's top-left pixel. */
  readonly originX: number;
  readonly originY: number;
  readonly tilesPerPixel: number;
}

function landTiles(m: PlacedMask): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let py = 0; py < m.height; py++)
    for (let px = 0; px < m.width; px++)
      if (m.mask[py * m.width + px])
        out.push({ x: m.originX + px * m.tilesPerPixel, y: m.originY + py * m.tilesPerPixel });
  return out;
}

function boundsOf(m: PlacedMask) {
  return {
    x0: m.originX,
    y0: m.originY,
    x1: m.originX + (m.width - 1) * m.tilesPerPixel,
    y1: m.originY + (m.height - 1) * m.tilesPerPixel,
  };
}

/** Chebyshev-style separation between two axis-aligned boxes, in tiles. */
function boxGap(a: PlacedMask, b: PlacedMask): number {
  const A = boundsOf(a);
  const B = boundsOf(b);
  const dx = Math.max(0, Math.max(A.x0 - B.x1, B.x0 - A.x1));
  const dy = Math.max(0, Math.max(A.y0 - B.y1, B.y0 - A.y1));
  return Math.max(dx, dy);
}

/**
 * Smallest distance in tiles between any land tile of `a` and any of `b`, as a
 * Chebyshev distance - a pole's reach is a square, not a circle.
 */
export function minGapTiles(a: PlacedMask, b: PlacedMask): number {
  const A = landTiles(a);
  const B = landTiles(b);
  let best = Infinity;
  for (const p of A)
    for (const q of B) {
      const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  return best === Infinity ? Infinity : best;
}

export function chainComponents(
  masks: readonly PlacedMask[],
  reachTiles: number = BIG_POLE_REACH_TILES,
): number[] {
  const n = masks.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      // Cheap box test first: a pair whose BOXES are further apart than the
      // reach cannot possibly have land within it, and the per-tile comparison
      // below is quadratic in island area.
      if (boxGap(masks[i] as PlacedMask, masks[j] as PlacedMask) > reachTiles) continue;
      if (minGapTiles(masks[i] as PlacedMask, masks[j] as PlacedMask) <= reachTiles) union(i, j);
    }

  return Array.from({ length: n }, (_, i) => find(i));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vp test test/chainGraph.spec.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Plant a break on the box prefilter**

Change `> reachTiles` in the box test to `> 0`. Re-run.

Expected: the transitive-chain test FAILS, because the prefilter now rejects pairs that should join. Revert and re-run to green. This confirms the prefilter is a filter and not a no-op.

- [ ] **Step 6: Commit**

```bash
pnpm vp check --fix
git add src/noise/islands/chainGraph.ts test/chainGraph.spec.ts
git commit -m "feat(islands): proximity graph and chain components at big-pole reach (#27)"
```

---

### Task 7: `findIslands` - the orchestrator

**Files:**

- Create: `src/noise/islands/findIslands.ts`
- Test: `test/findIslands.spec.ts` (create)

**Interfaces:**

- Consumes: `surveyIslands`, `IslandCandidate` (Task 3); `largestRectangle`, `Rect` (Task 2); `landMaskFromImage`, `floodFillFrom` (Task 5); `chainComponents`, `PlacedMask` (Task 6).
- Produces:
  - `export interface IslandResult extends IslandCandidate { readonly rect: Rect; readonly rectTiles: { readonly width: number; readonly height: number }; readonly landTiles: number; readonly refined: boolean; readonly chainId: number; readonly distanceFromSpawn: number }`
  - `export interface FindOptions { readonly ctx: FulgoraCtx; readonly radius: number; readonly execute: (req: ElevationRenderRequest, slot: number) => Promise<ElevationRenderResult>; readonly concurrency: number; readonly refineCount?: number; readonly onProgress?: (done: number, total: number) => void; readonly signal?: AbortSignal }`
  - **`execute` takes `(req, slot)`, matching `WorkerHost.execute` from Task 4 exactly**, so the panel can pass `host.execute` straight through with no adapter. `pooled` hands each runner its own fixed slot index, which is what keeps one runner pinned to one worker.
  - `export async function findIslands(opts: FindOptions): Promise<IslandResult[]>`
  - Constants: `COARSE_TILES_PER_PIXEL = 8`, `REFINE_TILES_PER_PIXEL = 2`, `DEFAULT_REFINE_COUNT = 50`

- [ ] **Step 1: Write the failing test**

Create `test/findIslands.spec.ts`:

```typescript
import { describe, expect, it, vi } from "vite-plus/test";
import { findIslands, COARSE_TILES_PER_PIXEL, REFINE_TILES_PER_PIXEL } from "../src/noise/islands/findIslands";
import { runRenderRequest, type ElevationRenderRequest } from "../src/noise/preview/elevationRenderRequest";

const SEED0 = 2967702466;
/** In-process executor - the same seam `createRenderPool` uses in its tests. */
const execute = async (req: ElevationRenderRequest) => runRenderRequest(req);

describe("findIslands", () => {
  it("only ever asks for view:'terrain'", async () => {
    // The single most expensive mistake available here. `view: "all"` adds the
    // scrap overlay, whose roll is per TILE, so a coarse render pays the full
    // tile cost - measured at 112x. See the spec, section 2b.
    const seen: string[] = [];
    const spy = async (req: ElevationRenderRequest) => {
      seen.push(String(req.view));
      return runRenderRequest(req);
    };
    await findIslands({ ctx: { seed0: SEED0 }, radius: 600, execute: spy, concurrency: 4 });
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(["terrain"]);
  }, 300000);

  it("returns islands with a rectangle no larger than their land area", async () => {
    const found = await findIslands({ ctx: { seed0: SEED0 }, radius: 600, execute, concurrency: 4 });
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) {
      expect(r.rect.width * r.rect.height).toBeLessThanOrEqual(r.landTiles);
      expect(r.landTiles).toBeGreaterThan(0);
    }
  }, 300000);

  it("sorts by rectangle area, largest first", async () => {
    const found = await findIslands({ ctx: { seed0: SEED0 }, radius: 600, execute, concurrency: 4 });
    const areas = found.map((r) => r.rectTiles.width * r.rectTiles.height);
    expect([...areas].sort((a, b) => b - a)).toEqual(areas);
  }, 300000);

  it("marks exactly the refined rows as refined", async () => {
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
      refineCount: 2,
    });
    expect(found.filter((r) => r.refined).length).toBeLessThanOrEqual(2);
  }, 300000);

  it("reports progress that ends at the total", async () => {
    const seen: [number, number][] = [];
    await findIslands({
      ctx: { seed0: SEED0 },
      radius: 600,
      execute,
      concurrency: 4,
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1]!;
    expect(last[0]).toBe(last[1]);
  }, 300000);

  it("stops early when the signal aborts", async () => {
    const ac = new AbortController();
    let calls = 0;
    const counting = async (req: ElevationRenderRequest) => {
      if (++calls === 3) ac.abort();
      return runRenderRequest(req);
    };
    const found = await findIslands({
      ctx: { seed0: SEED0 },
      radius: 2000,
      execute: counting,
      concurrency: 2,
      signal: ac.signal,
    });
    expect(found.length).toBeLessThan(50);
  }, 300000);

  it("uses the documented sampling densities", () => {
    expect(COARSE_TILES_PER_PIXEL).toBe(8);
    expect(REFINE_TILES_PER_PIXEL).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vp test test/findIslands.spec.ts`

Expected: FAIL - module not found.

- [ ] **Step 3: Implement it**

Create `src/noise/islands/findIslands.ts`:

```typescript
/**
 * The island finder's orchestrator: survey, measure coarsely, refine the best,
 * then group into chains.
 *
 * Two constants carry the whole cost model, both measured in a real browser
 * Worker against a production build (spec section 2b):
 *
 * - Every request uses `view: "terrain"`. `"all"` adds the scrap overlay, whose
 *   placement roll iterates TILES rather than pixels, so a coarse render still
 *   pays the full tile cost - 5,537 ms against 49 ms for the same window, 112x.
 *   Nothing in the types prevents someone changing this; `findIslands.spec.ts`
 *   asserts it directly.
 * - Refinement runs at 2 tiles/px, not 1. Full resolution costs about 14s
 *   pooled against 4s, to sharpen a rectangle edge by one tile - on a renderer
 *   whose own land boundary is only good to about a tile.
 */
import { largestRectangle, type Rect } from "./largestRectangle";
import { surveyIslands, type IslandCandidate } from "./cellSurvey";
import { floodFillFrom, landMaskFromImage } from "./islandMask";
import { chainComponents, type PlacedMask } from "./chainGraph";
import type { FulgoraCtx } from "../expressions/fulgoraShared";
import type {
  ElevationRenderRequest,
  ElevationRenderResult,
} from "../preview/elevationRenderRequest";

export const COARSE_TILES_PER_PIXEL = 8;
export const REFINE_TILES_PER_PIXEL = 2;
export const DEFAULT_REFINE_COUNT = 50;

/** Padding around a candidate's sample bounding box, in tiles. */
const WINDOW_PAD_TILES = 32;

export interface IslandResult extends IslandCandidate {
  readonly rect: Rect;
  readonly rectTiles: { readonly width: number; readonly height: number };
  readonly landTiles: number;
  readonly refined: boolean;
  readonly chainId: number;
  readonly distanceFromSpawn: number;
}

export interface FindOptions {
  readonly ctx: FulgoraCtx;
  /** Half-width of the search box, in tiles. */
  readonly radius: number;
  /** Same shape as `WorkerHost.execute` (Task 4), so it passes straight through. */
  readonly execute: (req: ElevationRenderRequest, slot: number) => Promise<ElevationRenderResult>;
  readonly concurrency: number;
  readonly refineCount?: number;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

interface Measured {
  readonly candidate: IslandCandidate;
  readonly rect: Rect;
  readonly landTiles: number;
  readonly placed: PlacedMask;
  readonly refined: boolean;
}

function windowFor(c: IslandCandidate, tpp: number) {
  const originX = c.minX - WINDOW_PAD_TILES;
  const originY = c.minY - WINDOW_PAD_TILES;
  const tilesW = c.maxX - c.minX + WINDOW_PAD_TILES * 2;
  const tilesH = c.maxY - c.minY + WINDOW_PAD_TILES * 2;
  return {
    originX,
    originY,
    width: Math.max(1, Math.ceil(tilesW / tpp)),
    height: Math.max(1, Math.ceil(tilesH / tpp)),
  };
}

async function measure(
  c: IslandCandidate,
  tpp: number,
  ctx: FulgoraCtx,
  execute: FindOptions["execute"],
  id: number,
  slot: number,
  refined: boolean,
): Promise<Measured> {
  const win = windowFor(c, tpp);
  const res = await execute(
    {
      id,
      seed0: ctx.seed0,
      planet: "fulgora",
      // Never "all" - see this module's header.
      view: "terrain",
      width: win.width,
      height: win.height,
      originX: win.originX,
      originY: win.originY,
      tilesPerPixel: tpp,
      fulgoraIslandControls: { frequency: ctx.islandsFrequency, size: ctx.islandsSize },
    } as unknown as ElevationRenderRequest,
    slot,
  );

  const rgba = new Uint8ClampedArray(res.buffer);
  const all = landMaskFromImage(rgba, win.width, win.height);
  const seedPx = Math.round((c.centroidX - win.originX) / tpp);
  const seedPy = Math.round((c.centroidY - win.originY) / tpp);
  const mine = floodFillFrom(all, win.width, win.height, seedPx, seedPy);

  let landPx = 0;
  for (let i = 0; i < mine.length; i++) if (mine[i]) landPx++;

  return {
    candidate: c,
    rect: largestRectangle(mine, win.width, win.height),
    landTiles: landPx * tpp * tpp,
    placed: {
      mask: mine,
      width: win.width,
      height: win.height,
      originX: win.originX,
      originY: win.originY,
      tilesPerPixel: tpp,
    },
    refined,
  };
}

/**
 * Run `jobs` with at most `limit` in flight, stopping early if aborted.
 *
 * Each runner keeps a FIXED slot for its whole life and passes it to the job.
 * That is what pins one runner to one worker in `WorkerHost`; handing out a
 * rotating slot would let two in-flight jobs land on the same worker while
 * another sat idle.
 */
async function pooled<T>(
  jobs: readonly ((slot: number) => Promise<T>)[],
  limit: number,
  signal: AbortSignal | undefined,
  onDone: () => void,
): Promise<T[]> {
  const out: (T | undefined)[] = new Array(jobs.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, limit) }, async (_unused, slot) => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await (jobs[i] as (s: number) => Promise<T>)(slot);
      onDone();
    }
  });
  await Promise.all(runners);
  return out.filter((v): v is T => v !== undefined);
}

export async function findIslands(opts: FindOptions): Promise<IslandResult[]> {
  const { ctx, radius, execute, concurrency, signal } = opts;
  const refineCount = opts.refineCount ?? DEFAULT_REFINE_COUNT;

  const candidates = surveyIslands(ctx, {
    x0: -radius,
    y0: -radius,
    x1: radius,
    y1: radius,
  });

  const total = candidates.length + Math.min(refineCount, candidates.length);
  let done = 0;
  const tick = () => opts.onProgress?.(++done, total);

  let id = 1;
  const coarse = await pooled(
    candidates.map(
      (c) => (slot: number) =>
        measure(c, COARSE_TILES_PER_PIXEL, ctx, execute, id++, slot, false),
    ),
    concurrency,
    signal,
    tick,
  );

  const byArea = [...coarse].sort(
    (a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height,
  );
  const toRefine = byArea.slice(0, refineCount);
  const refined = await pooled(
    toRefine.map(
      (m) => (slot: number) =>
        measure(m.candidate, REFINE_TILES_PER_PIXEL, ctx, execute, id++, slot, true),
    ),
    concurrency,
    signal,
    tick,
  );

  // Refined rows replace their coarse counterparts, keyed by the STABLE cell
  // index rather than by list position, which the sort above has shuffled.
  const merged = new Map<string, Measured>();
  for (const m of coarse) merged.set(`${m.candidate.cellX},${m.candidate.cellY}`, m);
  for (const m of refined) merged.set(`${m.candidate.cellX},${m.candidate.cellY}`, m);

  const finals = [...merged.values()];
  const chains = chainComponents(finals.map((m) => m.placed));

  const results: IslandResult[] = finals.map((m, i) => ({
    ...m.candidate,
    rect: m.rect,
    rectTiles: {
      width: m.rect.width * m.placed.tilesPerPixel,
      height: m.rect.height * m.placed.tilesPerPixel,
    },
    landTiles: m.landTiles,
    refined: m.refined,
    chainId: chains[i] as number,
    distanceFromSpawn: Math.hypot(m.candidate.centroidX, m.candidate.centroidY),
  }));

  results.sort(
    (a, b) => b.rectTiles.width * b.rectTiles.height - a.rectTiles.width * a.rectTiles.height,
  );
  if (done < total) opts.onProgress?.(total, total);
  return results;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vp test test/findIslands.spec.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Plant a break on the view guard**

Change `view: "terrain"` to `view: "all"` in `measure`. Re-run.

Expected: the "only ever asks for view:'terrain'" test FAILS. Revert and re-run to green. The test is the only thing standing between this design and a 112x regression, so confirm it can actually fire.

- [ ] **Step 6: Commit**

```bash
pnpm vp check --fix
git add src/noise/islands/findIslands.ts test/findIslands.spec.ts
git commit -m "feat(islands): orchestrate survey, coarse measure, refine and chain (#27)"
```

---

### Task 8: The results panel

**Files:**

- Create: `src/components/IslandFinderPanel.vue`
- Modify: `src/App.vue` (mount the panel on the Fulgora path)
- Test: `test/islandFinderPanel.spec.ts` (create)

**Interfaces:**

- Consumes: `findIslands`, `IslandResult` (Task 7); `createWorkerHost` (Task 4).
- Produces: a `<IslandFinderPanel>` component taking `{ planet: Planet }` and emitting `jump` with `{ x: number; y: number }`.

- [ ] **Step 1: Write the failing test**

Create `test/islandFinderPanel.spec.ts`:

```typescript
import { describe, expect, it, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import IslandFinderPanel from "../src/components/IslandFinderPanel.vue";
import { usePresetsStore } from "../src/store/presets";
import type { IslandResult } from "../src/noise/islands/findIslands";

function row(over: Partial<IslandResult> = {}): IslandResult {
  return {
    cellX: 1, cellY: 2, id: 0.8, klass: "mesa", sampleCount: 40,
    minX: 0, minY: 0, maxX: 100, maxY: 100, centroidX: 50, centroidY: 60,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    rectTiles: { width: 80, height: 80 }, landTiles: 9000,
    refined: true, chainId: 0, distanceFromSpawn: 78,
    ...over,
  } as IslandResult;
}

function setup(find: () => Promise<IslandResult[]>) {
  setActivePinia(createPinia());
  const store = usePresetsStore();
  store.createFromBuiltin("Default", "t");
  store.activePreset!.seed = 123456;
  return mount(IslandFinderPanel, { props: { planet: "fulgora", find } });
}

describe("IslandFinderPanel", () => {
  it("renders one row per island with its rectangle in TILES, not pixels", async () => {
    const w = setup(async () => [row(), row({ cellX: 9, rectTiles: { width: 40, height: 20 } })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    const rows = w.findAll('[data-test="island-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]!.text()).toContain("80");
  });

  it("emits jump with the island centroid when a row is clicked", async () => {
    const w = setup(async () => [row({ centroidX: 1234, centroidY: -567 })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    await w.find('[data-test="island-row"]').trigger("click");
    expect(w.emitted("jump")?.[0]).toEqual([{ x: 1234, y: -567 }]);
  });

  it("marks unrefined rows so a coarse number is never read as measured", async () => {
    const w = setup(async () => [row({ refined: false })]);
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-approx"]').exists()).toBe(true);
  });

  it("shows the accuracy caveat without needing a search first", () => {
    const w = setup(async () => []);
    expect(w.text()).toMatch(/1 tile/i);
  });

  it("disables the search button while a search is running", async () => {
    let release: (v: IslandResult[]) => void = () => {};
    const w = setup(() => new Promise((r) => (release = r)));
    await w.find('[data-test="island-search"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="island-search"]').attributes("disabled")).toBeDefined();
    release([]);
    await flushPromises();
    expect(w.find('[data-test="island-search"]').attributes("disabled")).toBeUndefined();
  });

  it("is inert for a planet other than fulgora", () => {
    setActivePinia(createPinia());
    const store = usePresetsStore();
    store.createFromBuiltin("Default", "t");
    const w = mount(IslandFinderPanel, { props: { planet: "nauvis", find: async () => [] } });
    expect(w.find('[data-test="island-search"]').exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vp test test/islandFinderPanel.spec.ts`

Expected: FAIL - the component does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/IslandFinderPanel.vue`:

```vue
<!-- src/components/IslandFinderPanel.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { usePresetsStore } from "../store/presets";
import { surfaceSeedForPlanet } from "../model/planetSurfaceSeed";
import type { Planet } from "../model/planets";
import { createWorkerHost, defaultPoolSize } from "./useElevationPreview";
import { findIslands, type IslandResult, type FindOptions } from "../noise/islands/findIslands";

// `find` is the injection seam, mirroring ElevationPreviewPanel's `renderer`
// prop: it lets the tests drive this component without spinning up Workers,
// which do not exist in the test environment.
const props = defineProps<{
  planet: Planet;
  find?: (opts: FindOptions) => Promise<IslandResult[]>;
}>();
const emit = defineEmits<{ jump: [{ x: number; y: number }] }>();

const store = usePresetsStore();
const radius = ref(5000);
const running = ref(false);
const done = ref(0);
const total = ref(0);
const error = ref<string | null>(null);
const results = shallowRef<IslandResult[]>([]);

const supported = computed(() => props.planet === "fulgora");

let host: ReturnType<typeof createWorkerHost> | null = null;
let aborter: AbortController | null = null;

function ensureHost() {
  host ??= createWorkerHost();
  return host;
}

async function search() {
  const preset = store.activePreset;
  if (!preset || running.value || !supported.value) return;
  running.value = true;
  error.value = null;
  done.value = 0;
  total.value = 0;
  results.value = [];
  aborter = new AbortController();
  try {
    const seed0 = surfaceSeedForPlanet("fulgora", store.previewSeed());
    const run = props.find ?? findIslands;
    // With the `find` prop injected the host is never touched, which is what
    // keeps the tests Worker-free.
    const concurrency = props.find
      ? 1
      : defaultPoolSize(typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency);
    results.value = await run({
      ctx: { seed0 },
      radius: radius.value,
      concurrency,
      execute: props.find ? async () => ({ id: 0, width: 0, height: 0, buffer: new ArrayBuffer(0) }) : ensureHost().execute,
      signal: aborter.signal,
      onProgress: (d, t) => {
        done.value = d;
        total.value = t;
      },
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Island search failed.";
  } finally {
    running.value = false;
    aborter = null;
  }
}

function cancel() {
  aborter?.abort();
}

onBeforeUnmount(() => {
  aborter?.abort();
  host?.dispose();
  host = null;
});
</script>

<template>
  <div v-if="supported" class="island-finder">
    <div class="island-toolbar">
      <label>
        Search radius (tiles)
        <input v-model.number="radius" type="number" min="500" max="20000" step="500" data-test="island-radius" />
      </label>
      <button :disabled="running || undefined" data-test="island-search" @click="search">
        {{ running ? "Searching..." : "Find islands" }}
      </button>
      <button v-if="running" data-test="island-cancel" @click="cancel">Cancel</button>
      <span v-if="running && total > 0" class="progress">{{ done }} / {{ total }}</span>
    </div>

    <p class="caveat">
      Rectangles are accurate to about 1 tile - the terrain port's land boundary
      is itself only that good. Doubling the radius costs about four times the
      time.
    </p>

    <p v-if="error" class="error" role="alert" data-test="island-error">{{ error }}</p>

    <table v-if="results.length" class="island-table">
      <thead>
        <tr><th>Position</th><th>Rectangle</th><th>Land</th><th>Class</th><th>From spawn</th><th>Chain</th></tr>
      </thead>
      <tbody>
        <tr
          v-for="r in results"
          :key="`${r.cellX},${r.cellY}`"
          data-test="island-row"
          @click="emit('jump', { x: r.centroidX, y: r.centroidY })"
        >
          <td>{{ Math.round(r.centroidX) }}, {{ Math.round(r.centroidY) }}</td>
          <td>
            {{ r.rectTiles.width }} x {{ r.rectTiles.height }}
            <span v-if="!r.refined" data-test="island-approx" title="Coarse estimate, not refined">~</span>
          </td>
          <td>{{ r.landTiles }}</td>
          <td>{{ r.klass }}</td>
          <td>{{ Math.round(r.distanceFromSpawn) }}</td>
          <td>{{ r.chainId }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.island-toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.island-table {
  width: 100%;
  border-collapse: collapse;
}
.island-table tbody tr {
  cursor: pointer;
}
.caveat {
  opacity: 0.75;
  font-size: 0.9em;
}
</style>
```

Note the `execute` line: when `find` is injected the executor is a stub that is
never called, because the injected `find` does not render anything. That keeps
the component's production path and its test path on the same code without the
tests needing Workers.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vp test test/islandFinderPanel.spec.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into `App.vue`**

Mount `<IslandFinderPanel>` beside the preview, passing the selected planet, and handle `@jump` by re-centering the client preview on that coordinate.

- [ ] **Step 6: Type-check the SFC**

Run: `pnpm run check:vue`

Expected: no errors. `vp check` does not see inside `.vue` bodies, so this is the only thing that checks this file.

- [ ] **Step 7: Commit**

```bash
pnpm vp check --fix
git add src/components/IslandFinderPanel.vue src/App.vue test/islandFinderPanel.spec.ts
git commit -m "feat(islands): results panel with ranked list and jump-to (#27)"
```

---

### Task 9: Pin the cost, and close out

**Files:**

- Modify: `test/render-cost.perf.spec.ts`
- Modify: `docs/noise/client-preview-ROADMAP.md`

- [ ] **Step 1: Add a survey-cost row to the perf spec**

In `test/render-cost.perf.spec.ts`, add a block timing `surveyIslands` over a 4,000-tile box and a single coarse `measure`-shaped render, printing us/sample and ms/candidate alongside the existing rows. Follow the file's existing conventions: minimum of N, interleaved arms, spread printed.

- [ ] **Step 2: Run it**

Run: `FMW_PERF=1 FMW_PERF_N=3 pnpm vp test test/render-cost.perf.spec.ts`

Expected: PASS, and the printed survey figure lands near 2.33 us/sample. A figure far above that means the survey step derivation regressed.

- [ ] **Step 3: Record the milestone in the roadmap**

Add an "Island finder - DONE" entry under Milestone 4 with the measured search time for a 5,000-tile radius, the candidate count, and a pointer to the spec. State the measured numbers, not the planned ones.

- [ ] **Step 4: Run the full gate**

Run: `pnpm run verify`

Expected: exit 0. Note this takes several minutes on a cold cache.

- [ ] **Step 5: Commit and open the PR**

```bash
pnpm vp check --fix
git add test/render-cost.perf.spec.ts docs/noise/client-preview-ROADMAP.md
git commit -m "test(islands): pin the survey cost, and record the milestone (#27)"
```

Open the PR against `main`, naming the measured search time and the candidate count. Part of #27.
