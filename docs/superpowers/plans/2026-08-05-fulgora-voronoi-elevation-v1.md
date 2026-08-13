# Fulgora V1: Voronoi Primitive + Elevation Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Fulgora in the client-side map preview as faithful oil-ocean tiles against flat land, by reverse-engineering Factorio's `VoronoiNoise` primitive and porting the `fulgora_elevation` expression chain.

**Architecture:** A planet-agnostic `voronoiNoise.ts` primitive is cracked first, oracle-first, against the real game via `sampleExpression()`. Three `fulgora*` expression modules then transcribe the ~44-node elevation DAG on top of it, every node `memoXY`-wrapped. A tile catalog resolves the four oil-ocean tiles by argmax and a renderer paints three colours.

**Tech Stack:** TypeScript, Vue 3 + Pinia (untouched here), Vite+ (`pnpm vp`), Vitest-compatible specs, Factorio headless as the oracle - **2.1.14** from Task 7 on (this plan was written against 2.1.12; Steam moved the binary on 2026-08-13).

**Spec:** `docs/superpowers/specs/2026-08-04-fulgora-elevation-preview-design.md`

## Global Constraints

- **Factorio version is 2.1.14** (was 2.1.12 when this plan was written). Run `pnpm refs:sync --check` before trusting any reading from `~/GitHub/factorio-data` or `factorioLuaAPI/`. **`-> in sync` is not enough - read the version it PRINTS**, because it pins to whatever the Steam binary currently is, not to what this plan assumed. The Fulgora map-gen Lua is byte-identical 2.1.12 -> 2.1.14 (empty `git diff` over `space-age/prototypes/planet/`, `noise-programs.lua`, `noise-functions.lua`, `base/prototypes/noise-expressions.lua`), so Tasks 1-6's findings carry over unchanged; only the fixture provenance moves.
- **Port the 2.1.7-FIXED voronoi search range**, not the pre-2.1.7 3x3 neighbourhood. Fulgora runs jitter 0.6 / 0.8 / 1.0, where the two differ.
- **Fulgora's surface seed is `(mapSeed + crc32("fulgora")) >>> 0`** - use `surfaceSeedForPlanet("fulgora", mapSeed)` from `src/model/planetSurfaceSeed.ts`. Never pass a raw map seed to a Fulgora field.
- **Every field-DAG node is wrapped in `memoXY`** from `src/noise/eval/memoXY.ts`.
- **Acceptance is f32.** Compare with `Math.fround`. The Voronoi primitive is exact arithmetic - no `fastapprox` floor applies to it.
- **Every new fixture needs a `test/fixtures/PROVENANCE.json` entry** (version `2.1.14` for anything captured from Task 7 on, evidence `stated`) or `test/fixtureProvenance.spec.ts` fails. Landing a 2.1.14 fixture also trips `test/factorioTarget.spec.ts` until `FACTORIO_TARGET_VERSION` is bumped in the same commit - that is the guard working, not a break.
- **Never edit a fixture or an expected value to make a test pass.** A mismatch is a real finding.
- **Use hyphens (`-`), never em or en dashes,** in every file this plan creates.
- Run commands through pnpm: `pnpm vp test`, `pnpm vp check --fix`, `pnpm run verify`. A root dependency needs `pnpm add -w` followed by a bare `pnpm install`.
- Oracle specs are gated `it.skipIf(!oracleAvailable())` so CI (no Factorio) stays green.
- Branch off `main`; never commit to `main` directly. `main` is protected by ruleset `EJ`.

---

## File Structure

**Created:**

| path | responsibility |
| --- | --- |
| `src/noise/voronoiNoise.ts` | the primitive: point generation, 4 distance types, 4 ops, per-cell point cache |
| `src/noise/expressions/fulgoraShared.ts` | `fulgora_grid`, wobble fields, `ox`/`oy`/`wx`/`wy`, starting cones and masks |
| `src/noise/expressions/fulgoraCells.ts` | `cells` / `pyramids` / `spots` + `blanks` / `mesa` / `sprawl` / `vaults` |
| `src/noise/expressions/fulgoraElevation.ts` | the mix chain -> `sand_basins` -> `fulgora_elevation`, plus `oil_mask` |
| `src/noise/tiles/fulgoraCatalog.ts` | oil-ocean argmax; land sentinel |
| `src/noise/preview/renderFulgoraTerrain.ts` | the pixel sweep |
| `test/voronoiNoise.spec.ts` | fixture-driven primitive tests (CI-safe) |
| `test/voronoiSearchRange.spec.ts` | the named jitter=1 search-range regression guard |
| `test/fulgoraExpressions.spec.ts` | fixture-driven expression tests (CI-safe) |
| `test/fulgoraAgreement.spec.ts` | heavy `get_tile` agreement - **its own file**, see Global Constraints rationale |
| `test/fulgoraSurfaceSeed.spec.ts` | the surface-seed guard |
| `docs/noise/voronoi-NOTES.md` | measured findings for the primitive |
| `docs/noise/fulgora-elevation-NOTES.md` | measured findings for the chain |

**Modified:**

| path | change |
| --- | --- |
| `test/oracle/oracle.ts` | add `sampleVoronoi()` convenience wrapper |
| `test/oracle/capture.ts` | add the Fulgora/Voronoi capture entries |
| `src/noise/preview/elevationRenderRequest.ts` | Fulgora branch in the planet dispatch |
| `src/noise/preview/elevationRender.worker.ts` | route the Fulgora branch |
| `test/fixtures/PROVENANCE.json` | entries for every new fixture |
| `docs/noise/client-preview-ROADMAP.md` | mark Fulgora V1 |

---

## A note on the RE tasks (Tasks 2-6)

Tasks 2 through 6 are reverse-engineering. **Their implementation body cannot be
written in advance, because it is the unknown being measured.** Writing
speculative implementation code here would be exactly the failure the spec warns
about - a port and a fixture agreeing with each other while both disagree with
the game.

So each RE task is structured as: **capture real ground truth -> commit it as a
fixture -> write the test that gates on it -> fit the implementation until the
test passes.** The probe code, the capture command, the test, and the
falsification criterion are all fully specified. The fitted constant or formula
is not, and must come from the measurement.

Every RE task carries a **vacuity guard**: a deliberately wrong variant that must
make the test fail. If it does not, the test is not measuring anything and the
task is not done.

---

### Task 1: Oracle wrapper for voronoi probes

**Files:**
- Modify: `test/oracle/oracle.ts` (append near `sampleExpression`, ~line 1291)
- Test: `test/oracle/oracle.spec.ts`

**Interfaces:**
- Consumes: `sampleExpression(expression, positions, opts)` from `test/oracle/oracle.ts`.
- Produces: `buildVoronoiExpression(p: VoronoiProbe): string` and `type VoronoiProbe`, used by every later capture task.

- [ ] **Step 1: Write the failing test**

In `test/oracle/oracle.spec.ts`:

```ts
import { buildVoronoiExpression } from "./oracle";

describe("buildVoronoiExpression", () => {
  it("emits a voronoi call with every parameter, distance_type quoted", () => {
    const expr = buildVoronoiExpression({
      op: "voronoi_cell_id",
      x: "x",
      y: "y",
      seed1: "'fulgora_cells'",
      gridSize: 175,
      distanceType: "manhattan",
      jitter: 0.6,
    });
    expect(expr).toContain("voronoi_cell_id{");
    expect(expr).toContain("seed0 = map_seed");
    expect(expr).toContain("seed1 = 'fulgora_cells'");
    expect(expr).toContain("grid_size = 175");
    expect(expr).toContain("distance_type = 'manhattan'");
    expect(expr).toContain("jitter = 0.6");
  });

  it("passes x and y through verbatim so offset inputs can be probed", () => {
    const expr = buildVoronoiExpression({
      op: "voronoi_spot_noise",
      x: "x + 87.5",
      y: "y + 87.5",
      seed1: "1",
      gridSize: 64,
      distanceType: "euclidean",
      jitter: 0,
    });
    expect(expr).toContain("x = x + 87.5");
    expect(expr).toContain("y = y + 87.5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vp test test/oracle/oracle.spec.ts -t buildVoronoiExpression`
Expected: FAIL - `buildVoronoiExpression` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `test/oracle/oracle.ts`:

```ts
/** The four voronoi noise ops. Names match the game's expression names. */
export type VoronoiOp =
  | "voronoi_cell_id"
  | "voronoi_spot_noise"
  | "voronoi_facet_noise"
  | "voronoi_pyramid_noise";

/** `distance_type` enum: chebyshev 0, manhattan 1, euclidean 2, minkowski3 3. */
export type VoronoiDistanceTypeName =
  | "chebyshev"
  | "manhattan"
  | "euclidean"
  | "minkowski3";

export interface VoronoiProbe {
  readonly op: VoronoiOp;
  /** Verbatim Lua for the x argument, e.g. "x" or "x + 87.5". */
  readonly x: string;
  /** Verbatim Lua for the y argument. */
  readonly y: string;
  /** Verbatim Lua for seed1 - a quoted NoiseLayerID string, or a number. */
  readonly seed1: string;
  readonly gridSize: number;
  readonly distanceType: VoronoiDistanceTypeName;
  readonly jitter: number;
}

/** Build the noise-expression source for one voronoi probe. */
export function buildVoronoiExpression(p: VoronoiProbe): string {
  return (
    `${p.op}{x = ${p.x}, y = ${p.y}, seed0 = map_seed, seed1 = ${p.seed1}, ` +
    `grid_size = ${p.gridSize}, distance_type = '${p.distanceType}', jitter = ${p.jitter}}`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vp test test/oracle/oracle.spec.ts -t buildVoronoiExpression`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add test/oracle/oracle.ts test/oracle/oracle.spec.ts
git commit -m "test(oracle): add buildVoronoiExpression probe builder for voronoi RE"
```

---

### Task 2: R1 - closed-form geometry at jitter = 0

At `jitter = 0` every point sits at its cell centre, so the RNG is out of the
picture entirely and all four ops reduce to geometry. This task settles the four
distance formulas, the normalisation divisor, and `pyramid_noise`'s definition.

**Files:**
- Modify: `test/oracle/capture.ts`
- Create: `test/fixtures/oracle-voronoi-jitter0.seed123456.json`
- Create: `src/noise/voronoiNoise.ts`
- Create: `test/voronoiNoise.spec.ts`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `buildVoronoiExpression`, `VoronoiProbe` (Task 1).
- Produces: `distanceOf(dt, dx, dy): number`, `type VoronoiDistanceType`, and a jitter-0-only `makeVoronoi` returning `{ cellId, spotNoise, facetNoise, pyramidNoise }`. Task 6 keeps these exact names.

- [ ] **Step 1: Verify the reference data matches the binary**

Run: `pnpm refs:sync --check`
Expected: `-> in sync`, target 2.1.12. **Stop and resync if not** - the search-range fix landed in 2.1.7 and a stale checkout misrepresents it.

- [ ] **Step 2: Add the capture entry**

In `test/oracle/capture.ts`, add:

```ts
const VORONOI_DISTANCE_TYPES = [
  "chebyshev",
  "manhattan",
  "euclidean",
  "minkowski3",
] as const;

const VORONOI_OPS = [
  "voronoi_cell_id",
  "voronoi_spot_noise",
  "voronoi_facet_noise",
  "voronoi_pyramid_noise",
] as const;

/**
 * Positions chosen to exercise cell interiors, cell boundaries and the far
 * corners bug #130905 identified. grid_size 64 with a 0.5 offset keeps every
 * probe off an exact integer boundary, where an f32 tie could flip which point
 * wins for reasons that are not the formula.
 */
function voronoiPositions(gridSize: number): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      out.push({ x: i * (gridSize / 6) + 0.5, y: j * (gridSize / 6) + 0.5 });
    }
  }
  return out;
}

async function captureVoronoiJitter0(workDir: string): Promise<void> {
  const gridSize = 64;
  const positions = voronoiPositions(gridSize);
  const rows: Record<string, number[]> = {};
  for (const op of VORONOI_OPS) {
    for (const distanceType of VORONOI_DISTANCE_TYPES) {
      const expr = buildVoronoiExpression({
        op,
        x: "x",
        y: "y",
        seed1: "1",
        gridSize,
        distanceType,
        jitter: 0,
      });
      rows[`${op}:${distanceType}`] = await sampleExpression(expr, positions, {
        workDir,
        seed: 123456,
        spaceAge: false,
      });
    }
  }
  await writeFixture("oracle-voronoi-jitter0.seed123456.json", {
    seed: 123456,
    gridSize,
    jitter: 0,
    seed1: 1,
    positions,
    values: rows,
  });
}
```

- [ ] **Step 3: Capture the fixture**

Run: `node --experimental-strip-types test/oracle/capture.ts voronoi-jitter0`
Expected: `test/fixtures/oracle-voronoi-jitter0.seed123456.json` written, 16 keys x 144 values.

Sanity-read before proceeding: at jitter 0, `voronoi_cell_id` must be **constant across each cell** and `voronoi_spot_noise` must be **0 at exact cell centres**. If either fails, the probe is wrong, not the game.

- [ ] **Step 4: Add the PROVENANCE entry**

In `test/fixtures/PROVENANCE.json`:

```json
"oracle-voronoi-jitter0.seed123456.json": {
  "factorioVersion": "2.1.12",
  "evidence": "stated",
  "note": "Captured from the local 2.1.12 binary via sampleExpression at jitter 0, where points sit at cell centres and the RNG is not involved."
}
```

- [ ] **Step 5: Write the failing test**

In `test/voronoiNoise.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { distanceOf, makeVoronoi } from "../src/noise/voronoiNoise";

const fx = JSON.parse(
  readFileSync(new URL("./fixtures/oracle-voronoi-jitter0.seed123456.json", import.meta.url), "utf8"),
) as {
  seed: number; gridSize: number; jitter: number; seed1: number;
  positions: { x: number; y: number }[];
  values: Record<string, number[]>;
};

describe("distanceOf - the four distance types", () => {
  it("matches the documented formulas", () => {
    expect(distanceOf("chebyshev", 3, -4)).toBe(4);
    expect(distanceOf("manhattan", 3, -4)).toBe(7);
    expect(distanceOf("euclidean", 3, -4)).toBe(5);
    // minkowski3 uses abs() on BOTH terms - forums.factorio.com/viewtopic.php?p=685547
    expect(distanceOf("minkowski3", 3, -4)).toBeCloseTo((27 + 64) ** (1 / 3), 12);
  });

  it("minkowski3 is not signed - a negative term must not cancel", () => {
    expect(distanceOf("minkowski3", 3, -3)).toBeGreaterThan(0);
  });
});

describe("voronoi at jitter 0 matches the game", () => {
  for (const key of Object.keys(fx.values)) {
    const [op, distanceType] = key.split(":");
    it(`${op} / ${distanceType}`, () => {
      const v = makeVoronoi({
        seed0: fx.seed,
        seed1: fx.seed1,
        gridSize: fx.gridSize,
        jitter: fx.jitter,
        distanceType: distanceType as never,
      });
      const call = {
        voronoi_cell_id: v.cellId,
        voronoi_spot_noise: v.spotNoise,
        voronoi_facet_noise: v.facetNoise,
        voronoi_pyramid_noise: v.pyramidNoise,
      }[op]!;
      const expected = fx.values[key];
      fx.positions.forEach((p, i) => {
        expect(Math.fround(call(p.x, p.y))).toBe(Math.fround(expected[i]));
      });
    });
  }
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vp test test/voronoiNoise.spec.ts`
Expected: FAIL - `src/noise/voronoiNoise.ts` does not exist.

- [ ] **Step 7: Implement `distanceOf` and the jitter-0 ops**

Create `src/noise/voronoiNoise.ts`. `distanceOf` is fully determined by the docs
and can be written now:

```ts
export type VoronoiDistanceType =
  | "chebyshev"
  | "manhattan"
  | "euclidean"
  | "minkowski3";

/**
 * The four `distance_type` functions, verbatim from
 * factorioLuaAPI/auxiliary/noise-expressions.html (2.1.12). minkowski3 takes
 * abs() on both terms - the docs said otherwise until the erratum at
 * forums.factorio.com/viewtopic.php?p=685547.
 */
export function distanceOf(dt: VoronoiDistanceType, dx: number, dy: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  switch (dt) {
    case "chebyshev":
      return Math.max(ax, ay);
    case "manhattan":
      return ax + ay;
    case "euclidean":
      return Math.sqrt(ax * ax + ay * ay);
    case "minkowski3":
      return (ax * ax * ax + ay * ay * ay) ** (1 / 3);
  }
}
```

**The remaining bodies are the measurement.** Implement `makeVoronoi` for
`jitter === 0` only (points at cell centres), then fit these three unknowns
against the fixture:

1. **The normalisation divisor.** The docs say `tile_distance = grid_size * distance`, so the first hypothesis is a plain divide by `gridSize`. Check `spotNoise` against `distanceOf(...) / gridSize` and read the residual - a constant ratio names the true divisor.
2. **`facetNoise`** - documented as `d2 - d1`, normalised the same way. Confirm the sign and that a cell boundary reads 0.
3. **`pyramidNoise`** - documented as "like facet noise but the gradient is uniform and represents the distance to the closest edge". The binary carries a dedicated `computePyramidNoiseManhattan`, so **expect it to differ per distance type** and do not assume one formula covers all four.

`cellId` at jitter 0 still needs the per-cell RNG; leave it throwing
`new Error("cellId requires the R2 hash - Task 3")` and mark its three fixture
cases `it.skip` with a comment naming Task 3. Do not fake a value.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vp test test/voronoiNoise.spec.ts`
Expected: PASS for all 12 non-`cell_id` cases plus both `distanceOf` tests; 4 skipped.

- [ ] **Step 9: Vacuity guard**

Temporarily change the normalisation divisor to `gridSize * 2` and re-run.
Expected: the `spot_noise` cases FAIL. Revert.
If they still pass, the comparison is not discriminating - fix it before committing.

- [ ] **Step 10: Commit**

```bash
git add src/noise/voronoiNoise.ts test/voronoiNoise.spec.ts test/oracle/capture.ts \
        test/fixtures/oracle-voronoi-jitter0.seed123456.json test/fixtures/PROVENANCE.json
git commit -m "feat(noise): voronoi distance types + jitter-0 geometry, oracle-validated"
```

---

### Task 3: R2 - the per-cell `cell_id` hash

`voronoi_cell_id` is the per-cell RNG exposed directly as a float, so it is the
cheapest way to see the hash.

**Files:**
- Modify: `test/oracle/capture.ts`
- Create: `test/fixtures/oracle-voronoi-cellid.multiseed.json`
- Modify: `src/noise/voronoiNoise.ts`
- Modify: `test/voronoiNoise.spec.ts`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `distanceOf`, `makeVoronoi` (Task 2).
- Produces: `cellRandom(seed0, seed1, cellX, cellY): number` returning a float in `[0, 1)`. Task 4 reuses it for point offsets.

- [ ] **Step 1: Capture `cell_id` across seeds and cells**

Add to `test/oracle/capture.ts` a `captureVoronoiCellId` that samples
`voronoi_cell_id` at the centre of every cell in a 16x16 cell block, for
`seed0` in `[123456, 1, 4294967295]` and `seed1` in `[0, 1, 137]`, at
`gridSize = 64`, `jitter = 0`. Sampling at cell centres means one value per
cell with no boundary ambiguity.

Run: `node --experimental-strip-types test/oracle/capture.ts voronoi-cellid`
Expected: 9 series x 256 values.

Add the PROVENANCE entry (same shape as Task 2, note: "cell_id sampled at cell centres across 3 seed0 x 3 seed1").

- [ ] **Step 2: Write the failing test**

Append to `test/voronoiNoise.spec.ts`:

```ts
describe("cellRandom reproduces the game's per-cell draw", () => {
  const cf = JSON.parse(
    readFileSync(new URL("./fixtures/oracle-voronoi-cellid.multiseed.json", import.meta.url), "utf8"),
  ) as {
    gridSize: number;
    series: { seed0: number; seed1: number; cells: { cx: number; cy: number }[]; values: number[] }[];
  };

  for (const s of cf.series) {
    it(`seed0=${s.seed0} seed1=${s.seed1}`, () => {
      s.cells.forEach((c, i) => {
        expect(Math.fround(cellRandom(s.seed0, s.seed1, c.cx, c.cy))).toBe(Math.fround(s.values[i]));
      });
    });
  }

  it("is not constant across cells", () => {
    const s = cf.series[0];
    expect(new Set(s.values).size).toBeGreaterThan(100);
  });

  it("changes with seed0", () => {
    const a = cf.series.find((s) => s.seed0 === 123456)!;
    const b = cf.series.find((s) => s.seed0 === 1)!;
    expect(a.values).not.toEqual(b.values);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vp test test/voronoiNoise.spec.ts -t cellRandom`
Expected: FAIL - `cellRandom` is not exported.

- [ ] **Step 4: Fit the hash**

**This is the measurement.** Try the hash families already cracked in this repo,
in this order, and stop at the first that reproduces all 9 series:

1. `basisNoiseTablesFromSeed(seed0, seed1)`'s seeding path - `src/noise/basisNoise.ts`, and see `docs/noise/basis-noise-NOTES.md` for how `Noise::setSeed(unsigned int, unsigned char)` was read out of the binary.
2. `taus88` - `src/noise/taus88.ts`, which drove `spot_noise`'s point stream (`docs/noise/spot-noise-NOTES.md`). A Voronoi point set is structurally the same problem, so this is the strongest prior.
3. A plain integer hash of `(seed0, seed1, cellX, cellY)` - try the mix used by `Noise::setSeed` before inventing one.

Useful discriminators: whether swapping `cellX` and `cellY` swaps the value (symmetric mix), whether negative cell indices behave like their two's-complement `u32`, and whether `seed1` enters as a word or a byte (`setSeed`'s second parameter is `unsigned char`, which is a strong hint).

**If none fits, stop and disassemble** - `lipo -thin arm64` then objdump
`NoiseOperations::VoronoiPoints::VoronoiPoints`. Do not ship a hash that matches
8 of 9 series.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/voronoiNoise.spec.ts`
Expected: PASS, including the 4 `cell_id` cases from Task 2 - **un-skip them now.**

- [ ] **Step 6: Vacuity guard**

Temporarily swap `cellX` and `cellY` in `cellRandom` and re-run.
Expected: at least one series FAILS. Revert.

- [ ] **Step 7: Commit**

```bash
git add src/noise/voronoiNoise.ts test/voronoiNoise.spec.ts test/oracle/capture.ts \
        test/fixtures/oracle-voronoi-cellid.multiseed.json test/fixtures/PROVENANCE.json
git commit -m "feat(noise): fit voronoi per-cell hash from cell_id, all 9 seed series exact"
```

---

### Task 4: R3 - jittered point offsets, and whether `distance_type` moves points

`spot_noise` is a cone whose apex sits **on** the point, so sampling a fine grid
over one cell recovers that point's actual coordinates - it inverts the RNG's
output back into a 2D position.

**Files:**
- Modify: `test/oracle/capture.ts`
- Create: `test/fixtures/oracle-voronoi-points.seed123456.json`
- Modify: `src/noise/voronoiNoise.ts`
- Modify: `test/voronoiNoise.spec.ts`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `cellRandom` (Task 3), `distanceOf` (Task 2).
- Produces: `pointForCell(seed0, seed1, gridSize, jitter, cellX, cellY): { x: number; y: number }`. Task 6 caches its results.

- [ ] **Step 1: Capture the inversion grid**

Add `captureVoronoiPoints` to `test/oracle/capture.ts`: for `gridSize = 64`,
`jitter` in `[0.6, 0.8, 1]`, sample `voronoi_spot_noise` on a 64x64 lattice at
0.5-tile spacing covering one known cell, under **both** `manhattan` and
`euclidean`. Record the lattice and the values.

Note the harness gotcha in `test/oracle/README.md`: `MapPosition` is 1/256
fixed-point, so keep offsets at or above 1/256. A 0.5 spacing is safe.

Run: `node --experimental-strip-types test/oracle/capture.ts voronoi-points`

Add the PROVENANCE entry.

- [ ] **Step 2: Write the failing test**

Append to `test/voronoiNoise.spec.ts`:

```ts
describe("pointForCell recovers the jittered point positions", () => {
  const pf = JSON.parse(
    readFileSync(new URL("./fixtures/oracle-voronoi-points.seed123456.json", import.meta.url), "utf8"),
  ) as {
    seed: number; seed1: number; gridSize: number;
    series: {
      jitter: number; distanceType: string; cellX: number; cellY: number;
      lattice: { x: number; y: number }[]; values: number[];
    }[];
  };

  /** The cone apex is the lattice minimum - that IS the point, to lattice resolution. */
  function apexOf(s: (typeof pf.series)[number]): { x: number; y: number } {
    let best = 0;
    for (let i = 1; i < s.values.length; i++) if (s.values[i] < s.values[best]) best = i;
    return s.lattice[best];
  }

  for (const s of pf.series) {
    it(`jitter ${s.jitter} / ${s.distanceType} - point within half a lattice step`, () => {
      const got = pointForCell(pf.seed, pf.seed1, pf.gridSize, s.jitter, s.cellX, s.cellY);
      const apex = apexOf(s);
      expect(Math.abs(got.x - apex.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(got.y - apex.y)).toBeLessThanOrEqual(0.5);
    });
  }

  it("point placement does NOT depend on distance_type", () => {
    const m = pf.series.find((s) => s.distanceType === "manhattan" && s.jitter === 0.6)!;
    const e = pf.series.find((s) => s.distanceType === "euclidean" && s.jitter === 0.6)!;
    expect(m.cellX).toBe(e.cellX);
    expect(m.cellY).toBe(e.cellY);
    const am = apexOf(m);
    const ae = apexOf(e);
    expect(Math.abs(am.x - ae.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(am.y - ae.y)).toBeLessThanOrEqual(0.5);
  });

  it("jitter 0 puts the point exactly at the cell centre", () => {
    const p = pointForCell(pf.seed, pf.seed1, pf.gridSize, 0, 3, 5);
    expect(p.x).toBe(3 * pf.gridSize + pf.gridSize / 2);
    expect(p.y).toBe(5 * pf.gridSize + pf.gridSize / 2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vp test test/voronoiNoise.spec.ts -t pointForCell`
Expected: FAIL - `pointForCell` is not exported.

- [ ] **Step 4: Fit the offsets**

**Measurement.** Per the docs, `jitter` 0 puts the point at the cell centre and 1
puts it anywhere in the cell, so the shape is almost certainly

```
point = cellOrigin + gridSize * (0.5 + jitter * (draw - 0.5))
```

with one `draw` per axis. What must be measured is **where the two draws come
from**: the same stream as `cellRandom`, consecutive draws from it, or a separate
stream. Recover the apexes from the fixture, solve for the two draws per cell,
and compare them against `cellRandom`'s output for that cell.

**The `distance_type` independence test above is load-bearing** - Task 6's shared
point cache depends on it. If it fails, the cache must be keyed by distance type
too, and Task 6's interface changes.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/voronoiNoise.spec.ts`
Expected: PASS.

- [ ] **Step 6: Vacuity guard**

Temporarily hardcode `pointForCell` to return the cell centre regardless of
jitter and re-run.
Expected: the jitter 0.6 / 0.8 / 1 cases FAIL (the jitter-0 case correctly still
passes). Revert.

- [ ] **Step 7: Commit**

```bash
git add src/noise/voronoiNoise.ts test/voronoiNoise.spec.ts test/oracle/capture.ts \
        test/fixtures/oracle-voronoi-points.seed123456.json test/fixtures/PROVENANCE.json
git commit -m "feat(noise): recover voronoi point offsets by spot-noise inversion"
```

---

### Task 5: R4 - the 2.1.7 search range

Pre-2.1.7 the ops searched only a 3x3 cell neighbourhood and missed the true
nearest point at high jitter (forums.factorio.com/130905, fixed in 2.1.7 per
`changelog.txt` line 849). Fulgora runs jitter up to 1.0, so this is the
difference between right and plausible.

**Files:**
- Modify: `test/oracle/capture.ts`
- Create: `test/fixtures/oracle-voronoi-jitter1.seed123456.json`
- Modify: `src/noise/voronoiNoise.ts`
- Create: `test/voronoiSearchRange.spec.ts`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `pointForCell` (Task 4), `distanceOf` (Task 2).
- Produces: `pointsSearchRange(jitter: number): number` - the neighbourhood radius in cells.

- [ ] **Step 1: Capture the high-jitter stress set**

Add `captureVoronoiJitter1`: at `jitter = 1`, `gridSize = 64`, sample all four
ops under all four distance types at positions **in the far corners of their
cells** - `(cx*64 + 63.5, cy*64 + 63.5)` and the other three corners - across a
6x6 cell block. These are precisely where a 3x3 search and a wider one disagree.

Run: `node --experimental-strip-types test/oracle/capture.ts voronoi-jitter1`

Add the PROVENANCE entry, with the note naming bug #130905 and the 2.1.7 fix.

- [ ] **Step 2: Write the failing test**

Create `test/voronoiSearchRange.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { makeVoronoi, pointsSearchRange } from "../src/noise/voronoiNoise";

const fx = JSON.parse(
  readFileSync(new URL("./fixtures/oracle-voronoi-jitter1.seed123456.json", import.meta.url), "utf8"),
) as {
  seed: number; seed1: number; gridSize: number; jitter: number;
  positions: { x: number; y: number }[];
  values: Record<string, number[]>;
};

describe("voronoi search range - the 2.1.7 fix", () => {
  it("searches more than the 3x3 neighbourhood at jitter 1", () => {
    // Pre-2.1.7 behaviour was radius 1. forums.factorio.com/130905, fixed 2.1.7
    // (changelog.txt line 849). Our binary is 2.1.12, so it must exceed 1.
    expect(pointsSearchRange(1)).toBeGreaterThan(1);
  });

  for (const key of Object.keys(fx.values)) {
    const [op, distanceType] = key.split(":");
    it(`${op} / ${distanceType} at jitter 1, cell corners`, () => {
      const v = makeVoronoi({
        seed0: fx.seed, seed1: fx.seed1, gridSize: fx.gridSize,
        jitter: fx.jitter, distanceType: distanceType as never,
      });
      const call = {
        voronoi_cell_id: v.cellId, voronoi_spot_noise: v.spotNoise,
        voronoi_facet_noise: v.facetNoise, voronoi_pyramid_noise: v.pyramidNoise,
      }[op]!;
      fx.positions.forEach((p, i) => {
        expect(Math.fround(call(p.x, p.y))).toBe(Math.fround(fx.values[key][i]));
      });
    });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vp test test/voronoiSearchRange.spec.ts`
Expected: FAIL - `pointsSearchRange` is not exported.

- [ ] **Step 4: Determine the range**

**Measurement.** Implement `pointsSearchRange` and widen it until every fixture
case passes. Radius 2 is the first candidate; a jitter-dependent
`1 + ceil(jitter)` is the second. Record which cell actually supplied the winning
point for each failing corner probe - that names the required radius directly
rather than by trial.

**Backstop:** if the empirical answer is ambiguous, read
`NoiseOperations::VoronoiNoise::getPointsSearchRange() const` out of the binary
(`lipo -thin arm64` first).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/voronoiSearchRange.spec.ts`
Expected: PASS.

- [ ] **Step 6: Vacuity guard - this one is the whole point of the task**

Temporarily force `pointsSearchRange` to return `1` (the pre-2.1.7 behaviour) and
re-run.
Expected: at least one case FAILS. Revert.
**If nothing fails, the fixture positions are not in the corners where the two
behaviours differ - regenerate them before committing.** A guard that cannot see
the regression it exists to catch is worse than no guard.

- [ ] **Step 7: Commit**

```bash
git add src/noise/voronoiNoise.ts test/voronoiSearchRange.spec.ts test/oracle/capture.ts \
        test/fixtures/oracle-voronoi-jitter1.seed123456.json test/fixtures/PROVENANCE.json
git commit -m "feat(noise): port the 2.1.7 voronoi search range, guarded at jitter 1"
```

---

### Task 6: Assemble `makeVoronoi` with a per-cell point cache

**Files:**
- Modify: `src/noise/voronoiNoise.ts`
- Modify: `test/voronoiNoise.spec.ts`
- Create: `docs/noise/voronoi-NOTES.md`

**Interfaces:**
- Consumes: everything from Tasks 2-5.
- Produces: the final `makeVoronoi(p): VoronoiField` exactly as the spec declares. Tasks 8+ import only this.

- [ ] **Step 1: Write the failing test**

Append to `test/voronoiNoise.spec.ts`:

```ts
describe("makeVoronoi caching", () => {
  it("returns identical values on repeat calls at the same position", () => {
    const v = makeVoronoi({
      seed0: 123456, seed1: 1, gridSize: 175, jitter: 0.6, distanceType: "manhattan",
    });
    expect(v.pyramidNoise(500.5, -320.25)).toBe(v.pyramidNoise(500.5, -320.25));
  });

  it("two fields sharing seed/grid/jitter agree on cell boundaries across distance types", () => {
    // fulgora_cells (manhattan) and fulgora_spots (euclidean) share a point set.
    const a = makeVoronoi({ seed0: 7, seed1: 11, gridSize: 175, jitter: 0.6, distanceType: "manhattan" });
    const b = makeVoronoi({ seed0: 7, seed1: 11, gridSize: 175, jitter: 0.6, distanceType: "euclidean" });
    for (let i = 0; i < 50; i++) {
      const x = i * 37.5 + 0.5;
      const y = i * -21.25 + 0.5;
      expect(a.cellId(x, y)).toBe(b.cellId(x, y));
    }
  });

  it("a fresh field with the same parameters reproduces the same values", () => {
    const p = { seed0: 99, seed1: 3, gridSize: 64, jitter: 1, distanceType: "chebyshev" } as const;
    expect(makeVoronoi(p).facetNoise(12.5, 88.5)).toBe(makeVoronoi(p).facetNoise(12.5, 88.5));
  });
});
```

Note: the second test asserts `cellId` agreement, not `spotNoise` - the point set
is shared but the *distance* differs by type, so only cell identity must match.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vp test test/voronoiNoise.spec.ts -t "makeVoronoi caching"`
Expected: FAIL.

- [ ] **Step 3: Implement the cache**

Key a `Map<string, {x, y}>` (or a numeric key `cellX * 65536 + cellY` if cell
indices stay in range) on the cell index, populated through `pointForCell`. The
cache lives in the closure `makeVoronoi` returns, so it persists across a whole
render sweep. Wrap each of the four returned ops in `memoXY`.

```ts
import { memoXY } from "./eval/memoXY";

export interface VoronoiField {
  cellId(x: number, y: number): number;
  spotNoise(x: number, y: number): number;
  facetNoise(x: number, y: number): number;
  pyramidNoise(x: number, y: number): number;
}

export function makeVoronoi(p: {
  seed0: number; seed1: number; gridSize: number;
  jitter: number; distanceType: VoronoiDistanceType;
}): VoronoiField {
  const points = new Map<number, { x: number; y: number }>();
  const pointAt = (cx: number, cy: number): { x: number; y: number } => {
    const key = (cx & 0xffff) * 0x10000 + (cy & 0xffff);
    let pt = points.get(key);
    if (pt === undefined) {
      pt = pointForCell(p.seed0, p.seed1, p.gridSize, p.jitter, cx, cy);
      points.set(key, pt);
    }
    return pt;
  };
  // ... nearest / second-nearest search over pointsSearchRange(p.jitter),
  //     then the four ops, each wrapped in memoXY.
}
```

- [ ] **Step 4: Run the whole primitive suite**

Run: `pnpm vp test test/voronoiNoise.spec.ts test/voronoiSearchRange.spec.ts`
Expected: PASS, everything, nothing skipped.

- [ ] **Step 5: Write the notes**

Create `docs/noise/voronoi-NOTES.md`. Record, for each finding, **how it was
measured** - the repo has been burned by notes that state a cause with no stated
measurement. Cover: the normalisation divisor and the residual that identified
it; the fitted hash and which candidates were rejected; the point-offset formula;
the measured search range and the corner probes that pinned it; and the fact that
point placement is independent of `distance_type` (or is not, if Task 4 found
otherwise).

- [ ] **Step 6: Commit**

```bash
git add src/noise/voronoiNoise.ts test/voronoiNoise.spec.ts docs/noise/voronoi-NOTES.md
git commit -m "feat(noise): makeVoronoi factory with shared per-cell point cache"
```

---

### Task 7: `fulgoraShared.ts` - grid, wobble, offsets, starting cones

**Files:**
- Create: `src/noise/expressions/fulgoraShared.ts`
- Create: `test/fulgoraExpressions.spec.ts`
- Modify: `test/oracle/capture.ts`
- Create: `test/fixtures/oracle-fulgora-shared.seed123456.json`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `multioctaveNoise` + `MultioctaveParams` (`src/noise/multioctaveNoise.ts`), `sliderToLinear` (`src/noise/eval/math.ts:66`), `startingSpotAtAngle` + `StartingSpotAtAngleParams` (`src/noise/expressions/vulcanusShared.ts:42`), `memoXY`.
- Produces: `makeFulgoraShared(ctx: FulgoraCtx): FulgoraShared` where `FulgoraShared` exposes `grid: number` and the fields `wobbleX`, `wobbleY`, `wobbleMask`, `wx`, `wy`, `ox`, `oy`, `startingCone`, `startingVaultCone`, `startingMask`, `startingVaultMask`, each `(x: number, y: number) => number`. Tasks 8 and 9 consume these exact names.

Source: `~/GitHub/factorio-data/space-age/prototypes/planet/planet-fulgora-map-gen.lua:22-124`.

- [x] **Step 1: Capture the fixture**

Add `captureFulgoraShared` sampling these named expressions through the
Space-Age Fulgora surface - note `spaceAge: true, planet: "fulgora"`:

`fulgora_grid`, `fulgora_wobble_influence`, `fulgora_wobble_mask`,
`fulgora_wobble_x`, `fulgora_wobble_y`, `fulgora_wx`, `fulgora_wy`,
`fulgora_starting_cone`, `fulgora_starting_vault_cone`,
`fulgora_starting_mask`, `fulgora_starting_vault_mask`

at ~120 positions spanning near-spawn (within one grid cell) and far field
(several thousand tiles out), at seed 123456.

Run: `node --experimental-strip-types test/oracle/capture.ts fulgora-shared`

Add the PROVENANCE entry.

- [x] **Step 2: Write the failing test**

Create `test/fulgoraExpressions.spec.ts` with a fixture-driven loop asserting
`Math.fround(ours(x, y))` equals `Math.fround(expected[i])` for each field.

Include a **grid-size probe test** for the open question in the spec:

```ts
it("fulgora_grid at default frequency is 175", () => {
  expect(makeFulgoraShared({ seed0: 1, islandsFrequency: 1, islandsSize: 1 }).grid).toBe(175);
});

it("records whether grid_size is integral at non-default frequency", () => {
  // grid_size is documented as a constant 16-bit UNSIGNED INTEGER, but
  // 175 - slider_to_linear(freq, -50, 50) need not be integral. The fixture
  // answers whether the game truncates, rounds, or never yields a fraction.
  const g = makeFulgoraShared({ seed0: 1, islandsFrequency: 2, islandsSize: 1 }).grid;
  expect(Number.isInteger(g)).toBe(true);
});
```

If that second assertion fails against the game, **change the implementation to
match the game, not the test's expectation** - and record the answer in
`docs/noise/fulgora-elevation-NOTES.md`.

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: FAIL - the module does not exist.

- [x] **Step 4: Implement**

Transcribe lines 22-124 of the Lua. Every field goes through `memoXY`. The
multioctave calls, verbatim from the Lua:

- `wobble_influence`: persistence 0.5, seed1 `1`, octaves 3, inputScale `128 / grid / 20`, outputScale 3
- `wobble_x`: persistence 0.7, seed1 `crc32("fulgora_wobble_x")`, octaves 4, inputScale `5 / grid`, outputScale `grid * 0.07`
- `wobble_y`: same but seed1 `crc32("fulgora_wobble_y")`

`wobbleMask = clamp(wobbleInfluence + 0.6, 0, 1)`;
`ox = x + grid/2`, `oy = y + grid/2`;
`wx = ox + wobbleX * wobbleMask`, `wy = oy + wobbleY * wobbleMask`.

`startingCone` is `max(0, A, B)` over **two** `starting_spot_at_angle` calls
(angle `map_seed / 360`; the second at distance 1, radius `grid/4`, distortions
scaled 0.25). `startingVaultCone` is a single call at angle
`map_seed / 360 + 180`. Pass the current `(x, y)` as `xFromStart`/`yFromStart`,
matching how `vulcanusBiomes.ts:257` calls it.

Use `crc32` from `src/codec/crc32.ts` for string `seed1` values, as
`nauvisShared.ts` does.

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/noise/expressions/fulgoraShared.ts test/fulgoraExpressions.spec.ts \
        test/oracle/capture.ts test/fixtures/oracle-fulgora-shared.seed123456.json \
        test/fixtures/PROVENANCE.json
git commit -m "feat(noise): port fulgora grid, wobble and starting-cone fields"
```

---

### Task 8: `fulgoraCells.ts` - the Voronoi layer and island classification

**Files:**
- Create: `src/noise/expressions/fulgoraCells.ts`
- Modify: `test/fulgoraExpressions.spec.ts`
- Modify: `test/oracle/capture.ts`
- Create: `test/fixtures/oracle-fulgora-cells.seed123456.json`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `makeVoronoi` (Task 6), `FulgoraShared` (Task 7).
- Produces: `makeFulgoraCells(shared, ctx): FulgoraCells` exposing `cells`, `pyramids`, `spots`, `spotsInv`, `blanks`, `mesa`, `sprawl`, `vaults`, `vaultsAndStartingVault`, each `(x, y) => number`.

Source: Lua lines 126-205.

- [ ] **Step 1: Capture the fixture**

Sample `fulgora_cells`, `fulgora_pyramids`, `fulgora_spots`, `fulgora_blanks`,
`fulgora_mesa`, `fulgora_sprawl`, `fulgora_vaults`,
`fulgora_vaults_and_starting_vault` at the same ~120 positions, seed 123456,
`spaceAge: true, planet: "fulgora"`.

Run: `node --experimental-strip-types test/oracle/capture.ts fulgora-cells`

Add the PROVENANCE entry.

- [ ] **Step 2: Write the failing test**

Extend the fixture loop in `test/fulgoraExpressions.spec.ts`, and add the
structural assertions the classification must satisfy:

```ts
it("blanks / sprawl / mesa / vaults partition every position", () => {
  const c = makeFulgoraCells(shared, ctx);
  for (const p of positions) {
    const sum = c.blanks(p.x, p.y) + c.sprawl(p.x, p.y) + c.mesa(p.x, p.y) + c.vaults(p.x, p.y);
    expect(Math.fround(sum)).toBe(1);
  }
});

it("cells and pyramids share one point field - both change together with seed", () => {
  const a = makeFulgoraCells(makeFulgoraShared({ ...ctx, seed0: 1 }), { ...ctx, seed0: 1 });
  const b = makeFulgoraCells(makeFulgoraShared({ ...ctx, seed0: 2 }), { ...ctx, seed0: 2 });
  expect(a.cells(500.5, 500.5)).not.toBe(b.cells(500.5, 500.5));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts -t fulgoraCells`
Expected: FAIL.

- [ ] **Step 4: Implement**

Three Voronoi fields, parameters verbatim from the Lua:

| field | x, y | seed1 | grid | distance | jitter |
| --- | --- | --- | --- | --- | --- |
| `cells` | `wx`, `wy` | `crc32("fulgora_cells")` | `grid` | `manhattan` | 0.6 |
| `pyramids` | `wx`, `wy` | `crc32("fulgora_cells")` | `grid` | `manhattan` | 0.6 |
| `spots` | `ox + wobbleX/2`, `oy + wobbleY/2` | `crc32("fulgora_cells")` | `grid` | `euclidean` | 0.6 |

`cells` and `pyramids` share one `makeVoronoi` instance (identical parameters);
`spots` needs its own because the distance type differs - but per Task 4 the
point field is the same, so the cache is not duplicated work.

Classification: `blanks = cells < 0.33`, `mesa = cells > 0.75`,
`sprawl = (cells > 0.5) - mesa`, `vaults = 1 - blanks - sprawl - mesa`,
`vaultsAndStartingVault = max(vaults, startingVaultMask)`. Comparisons yield
1 or 0, matching the engine's boolean-to-number convention.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/noise/expressions/fulgoraCells.ts test/fulgoraExpressions.spec.ts \
        test/oracle/capture.ts test/fixtures/oracle-fulgora-cells.seed123456.json \
        test/fixtures/PROVENANCE.json
git commit -m "feat(noise): port fulgora voronoi cells, pyramids, spots and island classes"
```

---

### Task 9: `fulgoraElevation.ts` - the mix chain

**Files:**
- Create: `src/noise/expressions/fulgoraElevation.ts`
- Modify: `test/fulgoraExpressions.spec.ts`
- Modify: `test/oracle/capture.ts`
- Create: `test/fixtures/oracle-fulgora-elevation.seed123456.json`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `FulgoraShared` (Task 7), `FulgoraCells` (Task 8).
- Produces: `makeFulgoraElevation(shared, cells, ctx): FulgoraElevation` exposing `basis`, `basisOil`, `rock`, `dunes`, `scrapMedium`, `natural`, `sprawlPyramids`, `vaultPyramids`, `moats`, `mixPyramids`, `mixNatural`, `mixMoats`, `vaultSpots`, `mixSpots`, `oilMask`, `mixOil`, `sandBasins`, `elevation`, each `(x, y) => number`. Task 10 consumes `elevation`, `oilMask`, `dunes`, `scrapMedium`.

Source: Lua lines 206-336, plus `fulgora_dunes` (513) and `fulgora_scrap_medium` (371).

- [ ] **Step 1: Capture the fixture**

Sample every name above (game names: `fulgora_basis`, `fulgora_basis_oil`,
`fulgora_rock`, `fulgora_dunes`, `fulgora_scrap_medium`, `fulgora_natural`,
`fulgora_sprawl_pyramids`, `fulgora_vault_pyramids`, `fulgora_moats`,
`fulgora_mix_pyramids`, `fulgora_mix_natural`, `fulgora_mix_moats`,
`fulgora_vault_spots`, `fulgora_mix_spots`, `fulgora_oil_mask`,
`fulgora_mix_oil`, `fulgora_sand_basins`, `fulgora_elevation`) at the same
positions.

Run: `node --experimental-strip-types test/oracle/capture.ts fulgora-elevation`

Add the PROVENANCE entry.

- [ ] **Step 2: Write the failing test**

Extend the fixture loop, and add:

```ts
it("elevation straddles the coastline - the fixture is not all land or all ocean", () => {
  const e = makeFulgoraElevation(shared, cells, ctx);
  const vals = positions.map((p) => e.elevation(p.x, p.y));
  expect(vals.some((v) => v > 80)).toBe(true);
  expect(vals.some((v) => v <= 80)).toBe(true);
});

it("oil_mask is exactly mix_spots < 0", () => {
  const e = makeFulgoraElevation(shared, cells, ctx);
  for (const p of positions) {
    expect(e.oilMask(p.x, p.y)).toBe(e.mixSpots(p.x, p.y) < 0 ? 1 : 0);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts -t fulgoraElevation`
Expected: FAIL.

- [ ] **Step 4: Implement**

Transcribe the chain. Constants: `artificialCap = 0.25`, `coastline = 80`,
`coastlineDrop = 20`.

Multioctave parameters, verbatim:

- `basis`: at `(wx, wy)`, persistence 0.5, seed1 `crc32("fulgora_basis")`, octaves 6, inputScale `128 / grid / 7.5`, outputScale 0.5
- `basisOil`: at `(x + 1.5*wobbleX, y + 1.5*wobbleY)`, persistence 0.65, seed1 `crc32("fulgora_basis_oil")`, octaves 4, inputScale `1/10`, outputScale **1** (the Lua omits it, so the default applies)
- `rock`: `0.33 + abs(multioctave(x, y, persistence 0.7, seed1 crc32("fulgora_rock"), octaves 4, inputScale 1/3))`
- `dunes`: `0.66 - abs(multioctave(x, y, persistence 0.7, seed1 crc32("fulgora_dunes"), octaves 3, inputScale 1/6))`
- `scrapMedium`: `multioctave(x, y, persistence 0.7, seed1 crc32("fulgora_scrap_medium"), octaves 3, inputScale 1/18)`

Then, in order:

```
natural            = basis * 2 * sliderRescale(islandsSize, 2) - 0.85
sprawlPyramids     = pyramids * (sprawl + mesa * min(1, abs(0.9 - 0.2*basisOil + 0.05*rock)))
vaultPyramids      = max(vaults * pyramids, 0.5 * startingVaultCone)
vaultPyramidsStart = max(vaultPyramids, 0.5 * startingCone)
moats              = min(cap, 1.5 * max(-0.05 - vaultPyramidsStart*2, (vaultPyramidsStart - 0.35)*2))
mixPyramids        = min(cap, (sprawlPyramids - 0.185) * 4)
mixNatural         = max(natural, mixPyramids)
mixMoats           = lerp(mixNatural, moats, max(vaultsAndStartingVault, startingMask))
vaultSpots         = min(cap, -10 + 11.5 * max(vaults*spotsInv,
                                               startingVaultMask*(0.5 + 0.5*startingVaultCone),
                                               startingMask*(0.5 + 0.5*startingCone)))
mixSpots           = max(mixMoats, vaultSpots) + max(0, startingCone - 0.8)
oilMask            = mixSpots < 0
mixOil             = lerp(mixSpots, min(-0.01, mixSpots - 0.4 + 0.6*basisOil), oilMask)
sandBasins         = min(mixOil, 0.6 - mixOil)
preElevation       = sandBasins * 60 + 80
elevation          = preElevation + ((sandBasins > 0) - 0.5) * 20
```

**Do not port** `fulgora_natural_mask`, `fulgora_natural_and_mesa_mask`,
`fulgora_sprawl_mask` or `fulgora_artificial_mask` - nothing in this chain reads
them (verified in the spec); they belong to the deferred tile layer.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/fulgoraExpressions.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/noise/expressions/fulgoraElevation.ts test/fulgoraExpressions.spec.ts \
        test/oracle/capture.ts test/fixtures/oracle-fulgora-elevation.seed123456.json \
        test/fixtures/PROVENANCE.json
git commit -m "feat(noise): port the fulgora_elevation chain, oracle-validated to f32"
```

---

### Task 10: `fulgoraCatalog.ts` - the oil-ocean argmax, checked against `get_tile`

**Files:**
- Create: `src/noise/tiles/fulgoraCatalog.ts`
- Create: `test/fulgoraAgreement.spec.ts`
- Modify: `test/oracle/capture.ts`
- Create: `test/fixtures/oracle-fulgora-tiles.seed123456.json`
- Modify: `test/fixtures/PROVENANCE.json`

**Interfaces:**
- Consumes: `FulgoraElevation` (Task 9).
- Produces: `type FulgoraSurface = "land" | "shallow" | "deep"` and `makeFulgoraSurfaceResolver(ctx): (x: number, y: number) => FulgoraSurface`. Task 11 consumes both.

- [ ] **Step 1: Capture real tile names**

Use the existing `sampleTileNames` path (see `test/oracle/capture.ts`'s cliff
entries for the pattern) over a Fulgora region at seed 123456 - a 256x256 tile
block offset a few thousand tiles from spawn, so it contains both islands and
ocean. Record `{x, y, name}` per tile.

Run: `node --experimental-strip-types test/oracle/capture.ts fulgora-tiles`

Add the PROVENANCE entry.

- [ ] **Step 2: Write the failing test**

Create `test/fulgoraAgreement.spec.ts` - **its own file**, per the Global
Constraints, because `test/previewAgreement.spec.ts` is already the suite's
unsplittable wall-clock floor:

```ts
const OCEAN_TILES = new Set([
  "oil-ocean-shallow", "oil-ocean-shallow-2", "oil-ocean-deep", "oil-ocean-deep-2",
]);

describe("fulgora land/ocean binary agrees with the game", () => {
  it("matches get_tile on every sampled tile", () => {
    const resolve = makeFulgoraSurfaceResolver(ctx);
    let mismatches: { x: number; y: number; ours: string; game: string }[] = [];
    for (const t of tiles) {
      const oursIsOcean = resolve(t.x, t.y) !== "land";
      const gameIsOcean = OCEAN_TILES.has(t.name);
      if (oursIsOcean !== gameIsOcean) {
        mismatches.push({ x: t.x, y: t.y, ours: resolve(t.x, t.y), game: t.name });
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });

  it("the sample contains both land and ocean - otherwise the check is vacuous", () => {
    const names = new Set(tiles.map((t) => t.name));
    expect([...names].some((n) => OCEAN_TILES.has(n))).toBe(true);
    expect([...names].some((n) => !OCEAN_TILES.has(n))).toBe(true);
  });

  it("shallow and deep are distinguished, not collapsed", () => {
    const resolve = makeFulgoraSurfaceResolver(ctx);
    const got = new Set(tiles.map((t) => resolve(t.x, t.y)));
    expect(got.has("shallow")).toBe(true);
    expect(got.has("deep")).toBe(true);
  });
});
```

The `mismatches.slice(0, 10)` assertion before the count exists so a failure
**names the first offending coordinates** instead of printing only a number.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vp test test/fulgoraAgreement.spec.ts`
Expected: FAIL - the module does not exist.

- [ ] **Step 4: Implement**

```ts
/** water_base(max, influence) from base/prototypes/noise-expressions.lua:69. */
function waterBase(maxElevation: number, influence: number, elevation: number): number {
  return maxElevation >= elevation
    ? influence * Math.min(maxElevation - elevation, 1)
    : Number.NEGATIVE_INFINITY;
}
```

Per tile, with `e = elevation(x, y)`, `m = oilMask(x, y)`,
`s = scrapMedium(x, y) + dunes(x, y)`:

- `shallow  = 50 * m * waterBase(80, 1000, e) * Math.max(-s, 0)`
- `shallow2 = 50 * m * waterBase(80, 1000, e) * Math.max(s, 0)`
- `deep     = 100 * m * waterBase(20, 2000, e)`
- `deep2    = (-Math.min(0, e - 60)/100 + Math.max(0, dunes - Math.max(0, e/100))) * deep`

Return `"land"` when the best ocean probability is `<= 0` or `-Infinity`,
otherwise `"deep"` if `max(deep, deep2) > max(shallow, shallow2)` else
`"shallow"`. `shallow` and `shallow2` share a map colour and so do `deep` and
`deep2`, so the pair distinction never reaches the palette - only the
shallow-versus-deep comparison does.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vp test test/fulgoraAgreement.spec.ts`
Expected: PASS, 0 mismatches.

**If mismatches appear, do not relax the assertion.** Read the coordinates it
printed and check them against the `|scrapMedium + dunes| ~ 0` thin spot the spec
flags - that is the one place the dominance argument was known to be weak.

- [ ] **Step 6: Commit**

```bash
git add src/noise/tiles/fulgoraCatalog.ts test/fulgoraAgreement.spec.ts \
        test/oracle/capture.ts test/fixtures/oracle-fulgora-tiles.seed123456.json \
        test/fixtures/PROVENANCE.json
git commit -m "feat(noise): fulgora oil-ocean argmax, 100% get_tile agreement"
```

---

### Task 11: Render and wire Fulgora into the preview

**Files:**
- Create: `src/noise/preview/renderFulgoraTerrain.ts`
- Modify: `src/noise/preview/elevationRenderRequest.ts`
- Modify: `src/noise/preview/elevationRender.worker.ts`
- Create: `test/fulgoraSurfaceSeed.spec.ts`
- Modify: `test/fulgoraExpressions.spec.ts`

**Interfaces:**
- Consumes: `makeFulgoraSurfaceResolver`, `FulgoraSurface` (Task 10), `surfaceSeedForPlanet` (`src/model/planetSurfaceSeed.ts`).
- Produces: `renderFulgoraTerrain(opts: RenderFulgoraTerrainOptions): ImageData`, mirroring `renderVulcanusTerrain`'s option shape (`seed0`, `width`, `height`, `originX?`, `originY?`, `tilesPerPixel?`, `ctx?`).

- [ ] **Step 1: Write the failing surface-seed guard**

Create `test/fulgoraSurfaceSeed.spec.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";
import { renderFulgoraTerrain } from "../src/noise/preview/renderFulgoraTerrain";

function hash(img: ImageData): number {
  let h = 2166136261;
  for (let i = 0; i < img.data.length; i++) h = Math.imul(h ^ img.data[i], 16777619);
  return h >>> 0;
}

describe("fulgora surface seed", () => {
  it("renders at mapSeed + crc32('fulgora'), not the raw map seed", () => {
    const mapSeed = 123456;
    const derived = surfaceSeedForPlanet("fulgora", mapSeed);
    expect(derived).not.toBe(mapSeed);

    const opts = { width: 48, height: 48, tilesPerPixel: 8 };
    const atDerived = renderFulgoraTerrain({ ...opts, seed0: derived });
    const atRaw = renderFulgoraTerrain({ ...opts, seed0: mapSeed });
    // The oracle FORCES the surface seed to the map seed, so oracle agreement
    // cannot catch a raw-seed regression. This can.
    expect(hash(atDerived)).not.toBe(hash(atRaw));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vp test test/fulgoraSurfaceSeed.spec.ts`
Expected: FAIL - `renderFulgoraTerrain` does not exist.

- [ ] **Step 3: Implement the renderer**

Mirror `src/noise/preview/renderVulcanusTerrain.ts`. Build one resolver per
render and sweep:

```ts
const COLORS: Record<FulgoraSurface, [number, number, number]> = {
  // fulgoran-sand's own map_color, so V1 reads as Fulgora and M2 can replace
  // the flat land with a real argmax without the palette jumping.
  land: [118, 68, 56],
  shallow: [74, 42, 43],
  deep: [56, 36, 40],
};
```

- [ ] **Step 4: Wire the dispatch**

In `src/noise/preview/elevationRenderRequest.ts`, add a Fulgora branch alongside
the Vulcanus one so `view: "terrain"` reaches `renderFulgoraTerrain`, with the
other terrain-family views falling back to terrain exactly as they already do
when a planet lacks that overlay. Thread `control:fulgora_islands:frequency` and
`:size` through the request's ctx. Route it in `elevationRender.worker.ts`.

Add a dev-mode grayscale `fulgora_elevation` view, gated the same way the
existing dev views are.

- [ ] **Step 5: Add a render regression test**

Append to `test/fulgoraExpressions.spec.ts` a hash-pinning test over four
windows - near-spawn, far field, off-origin, and a second seed - at
`tilesPerPixel` 1 and 8, so any accidental change to the chain shows up as a
changed hash rather than silently.

- [ ] **Step 6: Run the full suite**

Run: `pnpm run verify`
Expected: exit 0. Report the actual output; do not claim a pass without it.

- [ ] **Step 7: Commit**

```bash
git add src/noise/preview/renderFulgoraTerrain.ts src/noise/preview/elevationRenderRequest.ts \
        src/noise/preview/elevationRender.worker.ts test/fulgoraSurfaceSeed.spec.ts \
        test/fulgoraExpressions.spec.ts
git commit -m "feat(preview): render Fulgora terrain and wire the planet dispatch"
```

---

### Task 12: Measure perf, write the notes, update the roadmap

**Files:**
- Create: `docs/noise/fulgora-elevation-NOTES.md`
- Modify: `docs/noise/client-preview-ROADMAP.md`

- [ ] **Step 1: Measure per-pixel cost**

Time a 1024x1024 render at `tilesPerPixel` 1 and divide. The spec's estimate is
**~12 us/px, ~2 s tiled** - explicitly an estimate, so **record the measurement
whether or not it agrees**, and if it disagrees say so rather than quietly
restating the estimate.

- [ ] **Step 2: If it is far slower, profile before optimising**

The Vulcanus lesson is that the visibly-expensive machinery was not the
bottleneck - an un-memoized DAG was, at ~81% of a CPU profile in raw
`basisNoise`. Check `memoXY` coverage first; the chain has ~31 `basis_noise`
octaves per pixel and no node should evaluate twice.

- [ ] **Step 3: Write the notes**

Create `docs/noise/fulgora-elevation-NOTES.md`. For every finding, state **how it
was measured**. Include the grid-size integrality answer from Task 7, the
per-pixel timing, and the count of `get_tile` mismatches from Task 10 (`0`, or
the coordinates if not).

- [ ] **Step 4: Update the roadmap**

Mark Fulgora V1 in `docs/noise/client-preview-ROADMAP.md`, and record what is
deferred: road/ruin tiles, `fulgoran-dust`, scrap, cliffs, and the island finder.

- [ ] **Step 5: Final verification**

Run: `pnpm run verify`
Expected: exit 0. Paste the output.

Run: `pnpm refs:sync --check`
Expected: `-> in sync` - confirms nothing was ported against a drifted reference.

- [ ] **Step 6: Commit and open the PR**

```bash
git add docs/noise/fulgora-elevation-NOTES.md docs/noise/client-preview-ROADMAP.md
git commit -m "docs(fulgora): record measured findings and mark V1 on the roadmap"
git push -u origin feat/fulgora-voronoi-elevation
gh pr create --base main --title "feat: Fulgora V1 - Voronoi primitive + elevation preview (#27)"
```

---

## Self-Review

**Spec coverage.** Section 3's module layout -> Tasks 2/6/7/8/9/10/11. Section 4's
interface and four-rung ladder -> Tasks 2-6, one task per rung plus assembly.
Section 4's fixtures, including the jitter=1 stress set -> Tasks 2, 3, 4, 5.
Section 5's reachability finding -> Task 9 Step 4, which names the four nodes not
to port and the two that look deferred but are not. Section 6's classification
and its empirical check -> Task 10. Section 7's render, UI, acceptance bar, both
guards and CI placement -> Tasks 10, 11, 12. Section 8's three open questions ->
Task 7 Step 2 (grid integrality), Task 4 Step 2 (distance-type independence),
Task 10 Step 5 (the thin spot). Section 9's risks -> Task 3 Step 4 and Task 5
Step 4 both name their disassembly backstop.

**Placeholder scan.** The RE tasks deliberately do not contain fitted constants,
because those are the measurements; each states its candidate set, its
discriminators, its falsification criterion and its backstop instead. Every other
step carries runnable code or an exact command.

**Type consistency.** `distanceOf` / `VoronoiDistanceType` (Task 2) are used
unchanged in Tasks 4-6. `cellRandom` (Task 3) feeds `pointForCell` (Task 4),
which feeds `makeVoronoi`'s cache (Task 6). `FulgoraShared` -> `FulgoraCells` ->
`FulgoraElevation` -> `makeFulgoraSurfaceResolver` -> `renderFulgoraTerrain` is
one chain with matching names at each boundary. `FulgoraSurface`'s three members
match the three `COLORS` keys in Task 11.
