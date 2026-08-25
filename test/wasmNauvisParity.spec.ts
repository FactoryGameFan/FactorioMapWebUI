import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";
import { makeAux } from "../src/noise/expressions/aux";
import { makeElevationIsland } from "../src/noise/expressions/elevationIsland";
import { makeElevationLakes } from "../src/noise/expressions/elevationLakes";
import { makeElevationNauvis } from "../src/noise/expressions/elevationNauvis";
import { makeMoisture } from "../src/noise/expressions/moisture";
import {
  makeNauvisShared,
  NAUVIS_OFFSET_X_SEED1,
  NAUVIS_OFFSET_Y_SEED1,
} from "../src/noise/expressions/nauvisShared";
import { makeTemperature } from "../src/noise/expressions/temperature";
import { makeTileCatalog } from "../src/noise/tiles/catalog";

/**
 * Tier 2 of the Rust port's gate for the Nauvis expression core (#226): strict
 * bit equality between the two ports over a swept grid, folded
 * order-sensitively, one named field at a time.
 *
 * **It detects divergence; it does not establish correctness.** Both ports can
 * agree and both be wrong, and here they demonstrably are - `elevation_nauvis`
 * reaches the game at 8 of 26 captured positions on both sides. That is what
 * tier 1 grading each against the game separately is for.
 *
 * ## It has a SHELF LIFE, and #227 is the deadline
 *
 * This compares Rust against TypeScript, and #227 deletes the TypeScript. It
 * can only ever be written while both exist, which is why it lands with the
 * expression core rather than at the end of phase 6.
 *
 * ## The sweep deliberately leaves the f32 grid, and that is LOAD-BEARING
 *
 * The steps are not binary fractions, so 1,430 of the 1,452 sampled positions
 * have at least one coordinate off the f32 grid. That is the whole point: #309
 * was a narrowing difference every tier-3 window missed, because all four of
 * those use binary origins and steps and so agree by construction.
 *
 * Measured, not argued. Planting a pure coordinate narrowing in
 * `nauvis_shared::hills_offset_raw_x` - `f64::from(x as f32) * scale` in place
 * of `x * scale`, which is a no-op wherever `x` is already f32-exact:
 *
 * ```text
 * tier 1 (oracle-cliff-offset-raw, every coordinate f32-exact)   GREEN
 * tier 2 (this spec)                                             RED at hillsOffsetRawX
 * ```
 *
 * So this spec is not a second opinion on what tier 1 already covers. It is the
 * only thing in the gate that can see that class of change on Nauvis.
 *
 * ## No trig crosses this boundary
 *
 * Fulgora's and Vulcanus's parity specs compute their bearings' sine and cosine
 * in V8 and hand them to the module, because #270 measured the wasm libm
 * disagreeing with V8 and `starting_spot_at_angle` is un-narrowed f64. Nauvis
 * reaches no transcendental at all, so there is nothing to lift. If a future
 * Nauvis field reaches one, it needs the same treatment.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  nauvis_field_count: () => number;
  checksum_nauvis: (
    seed0: number,
    waterLevel: number,
    segmentationMultiplier: number,
    moistureFrequency: number,
    moistureBias: number,
    auxFrequency: number,
    auxBias: number,
    temperatureFrequency: number,
    temperatureBias: number,
    startingAreaMoistureSize: number,
    startingAreaMoistureFrequency: number,
    field: number,
    x0: number,
    y0: number,
    step: number,
    n: number,
  ) => bigint;
}

async function instantiate(): Promise<EngineExports> {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as EngineExports;
}

/** A WASM `u64` arrives in JavaScript as a SIGNED BigInt. See wasmEngine.spec.ts. */
const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

const scratch = new DataView(new ArrayBuffer(8));
function foldF64(acc: bigint, value: number): bigint {
  let hash = acc === 0n ? FNV_OFFSET_BASIS : acc;
  scratch.setFloat64(0, value, true);
  for (let i = 0; i < 8; i++) {
    hash ^= BigInt(scratch.getUint8(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/** Rows outer, exactly as `checksum_nauvis` sweeps. */
function foldGrid(f: (x: number, y: number) => number, c: Case): bigint {
  let acc = 0n;
  for (let j = 0; j < c.n; j++) {
    const y = c.y0 + j * c.step;
    for (let i = 0; i < c.n; i++) {
      acc = foldF64(acc, f(c.x0 + i * c.step, y));
    }
  }
  return acc;
}

const SEED0 = 123456;

interface Case {
  readonly label: string;
  readonly waterLevel: number;
  readonly segmentationMultiplier: number;
  readonly moistureFrequency: number;
  readonly moistureBias: number;
  readonly auxFrequency: number;
  readonly auxBias: number;
  readonly temperatureFrequency: number;
  readonly temperatureBias: number;
  readonly startingAreaMoistureSize: number;
  readonly startingAreaMoistureFrequency: number;
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly n: number;
}

const DEFAULT_CONTROLS = {
  waterLevel: 0,
  segmentationMultiplier: 1,
  moistureFrequency: 1,
  moistureBias: 0,
  auxFrequency: 1,
  auxBias: 0,
  temperatureFrequency: 1,
  temperatureBias: 0,
  startingAreaMoistureSize: 1,
  startingAreaMoistureFrequency: 1,
} as const;

// Two windows, and neither is on the f32 grid - see the header. The near one
// straddles spawn so the starting-lake, starting-island and starting-area
// moisture terms are all live; the far one is past every one of their reaches,
// where different branches of the same expressions decide the result.
const CASES: readonly Case[] = [
  {
    label: "default controls, near spawn",
    ...DEFAULT_CONTROLS,
    x0: -213.3,
    y0: -147.7,
    step: 7.3,
    n: 22,
  },
  {
    label: "default controls, far field",
    ...DEFAULT_CONTROLS,
    x0: 4801.3,
    y0: -3902.7,
    step: 11.9,
    n: 22,
  },
  {
    label: "every control moved, near spawn",
    waterLevel: 5,
    segmentationMultiplier: 2,
    moistureFrequency: 3,
    moistureBias: 0.2,
    auxFrequency: 0.5,
    auxBias: -0.15,
    temperatureFrequency: 4,
    temperatureBias: 7,
    startingAreaMoistureSize: 4,
    startingAreaMoistureFrequency: 3,
    x0: -213.3,
    y0: -147.7,
    step: 7.3,
    n: 22,
  },
];

/**
 * The TypeScript accessors, in the order `NauvisStack::field` selects them.
 *
 * Fields 5 and 6 are reconstructed here rather than read off `makeNauvisShared`,
 * which does not expose the two raw warp fields. That is the same
 * reconstruction `test/nauvisShared.spec.ts` uses, and it is the one pair in
 * this list whose TypeScript side is spec-local rather than shipped code - so
 * read their agreement as covering the Rust accessor and the seeds, not the
 * shipped call site. Fields 7 and 8 consume them through shipped code.
 */
function tsFields(c: Case): ((x: number, y: number) => number)[] {
  const shared = makeNauvisShared({
    seed0: SEED0,
    segmentationMultiplier: c.segmentationMultiplier,
  });
  const offsetInputScale = shared.nauvisSeg / 500;
  const rawXTables = basisNoiseTablesFromSeed(SEED0, NAUVIS_OFFSET_X_SEED1);
  const rawYTables = basisNoiseTablesFromSeed(SEED0, NAUVIS_OFFSET_Y_SEED1);

  const elevationCommon = {
    seed0: SEED0,
    waterLevel: c.waterLevel,
    segmentationMultiplier: c.segmentationMultiplier,
  };

  // Hoisted, because the tile layer reads all three and rebuilding them per
  // tile would be 21 copies of the same chain.
  const elevationNauvis = makeElevationNauvis(elevationCommon);
  const auxAt = makeAux({
    seed0: SEED0,
    segmentationMultiplier: c.segmentationMultiplier,
    frequency: c.auxFrequency,
    bias: c.auxBias,
  });
  const moistureAt = makeMoisture({
    seed0: SEED0,
    segmentationMultiplier: c.segmentationMultiplier,
    moistureFrequency: c.moistureFrequency,
    moistureBias: c.moistureBias,
    startingAreaMoistureSize: c.startingAreaMoistureSize,
    startingAreaMoistureFrequency: c.startingAreaMoistureFrequency,
  });

  // `makeTileResolver` is deliberately NOT used to build this env, and the
  // reason is a live bug rather than a style choice: `TileResolverParams` has
  // no `waterLevel` field, so the resolver builds its elevation tree at
  // water level 0 whatever the caller asked for. That is issue #320 - it costs
  // 322 of 2,401 resolved tiles at `waterLevel = 5`. Tier 2 grades the tile
  // FORMULAS, so it reads the shipped `probability` closures over an env built
  // from the shipped expression trees, and leaves the plumbing gap to its own
  // change.
  const catalog = makeTileCatalog(SEED0);
  const envAt = (x: number, y: number) => ({
    x,
    y,
    elevation: elevationNauvis(x, y),
    aux: auxAt(x, y),
    moisture: moistureAt(x, y),
  });

  return [
    shared.hills,
    shared.cliffLevel,
    shared.plateaus,
    shared.bridgeBillows,
    shared.forestPathBillows,
    (x, y) => basisNoise(x * offsetInputScale, y * offsetInputScale, rawXTables),
    (x, y) => basisNoise(x * offsetInputScale, y * offsetInputScale, rawYTables),
    shared.hillsOffset,
    shared.cliffRingbreak,
    elevationNauvis,
    makeElevationNauvis({ ...elevationCommon, withCliffElevation: false }),
    makeElevationLakes(elevationCommon),
    makeElevationIsland(elevationCommon),
    auxAt,
    moistureAt,
    makeTemperature({
      seed0: SEED0,
      frequency: c.temperatureFrequency,
      bias: c.temperatureBias,
    }),
    // The 21 tile probabilities, in catalog order, then the argmax over them.
    ...catalog.map((t) => (x: number, y: number) => t.probability(envAt(x, y))),
    (x: number, y: number) => {
      const env = envAt(x, y);
      let winner = 0;
      let best = catalog[0].probability(env);
      for (let i = 1; i < catalog.length; i++) {
        const p = catalog[i].probability(env);
        if (p > best) {
          best = p;
          winner = i;
        }
      }
      return winner;
    },
  ];
}

const FIELD_NAMES = [
  "hills",
  "cliffLevel",
  "plateaus",
  "bridgeBillows",
  "forestPathBillows",
  "hillsOffsetRawX",
  "hillsOffsetRawY",
  "hillsOffset",
  "cliffRingbreak",
  "elevationNauvis",
  "elevationNauvisNoCliff",
  "elevationLakes",
  "elevationIsland",
  "aux",
  "moisture",
  "temperature",
  // The 21 tiles, spelled out rather than derived from the catalog. Derived,
  // a reordering would silently relabel every failure instead of failing;
  // `the tile field names match the catalog's own order` is the check.
  "tile:deepwater",
  "tile:water",
  "tile:grass-1",
  "tile:grass-2",
  "tile:grass-3",
  "tile:grass-4",
  "tile:dry-dirt",
  "tile:dirt-1",
  "tile:dirt-2",
  "tile:dirt-3",
  "tile:dirt-4",
  "tile:dirt-5",
  "tile:dirt-6",
  "tile:dirt-7",
  "tile:sand-1",
  "tile:sand-2",
  "tile:sand-3",
  "tile:red-desert-0",
  "tile:red-desert-1",
  "tile:red-desert-2",
  "tile:red-desert-3",
  "resolvedTileIndex",
] as const;

const wasmChecksum = (engine: EngineExports, c: Case, field: number): bigint =>
  u64(
    engine.checksum_nauvis(
      SEED0,
      c.waterLevel,
      c.segmentationMultiplier,
      c.moistureFrequency,
      c.moistureBias,
      c.auxFrequency,
      c.auxBias,
      c.temperatureFrequency,
      c.temperatureBias,
      c.startingAreaMoistureSize,
      c.startingAreaMoistureFrequency,
      field,
      c.x0,
      c.y0,
      c.step,
      c.n,
    ),
  );

describe("Rust and TypeScript agree bit for bit across the Nauvis expression core", () => {
  it("covers every field the module exposes", async () => {
    // The module owns the count, so a field added to the Rust chain cannot
    // silently go untested - this assertion names the gap instead.
    const engine = await instantiate();
    expect(engine.nauvis_field_count()).toBe(FIELD_NAMES.length);
  });

  it("folds every field to the identical checksum, over every case", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fields = tsFields(c);
      expect(fields.length, "accessor list length").toBe(FIELD_NAMES.length);
      for (let f = 0; f < fields.length; f++) {
        expect(wasmChecksum(engine, c, f), `${c.label}: ${FIELD_NAMES[f]}`).toBe(
          foldGrid(fields[f], c),
        );
      }
    }
  }, 120000);

  it("sweeps coordinates that are mostly NOT on the f32 grid, unlike tier 3", () => {
    // Anti-vacuity for the header's claim, and the reason this spec can see
    // what tier 3 cannot. Every tier-3 window uses a binary origin and step, so
    // every one of its coordinates is f32-exact and a narrowing difference is
    // invisible there by construction. Asserted rather than described, because
    // the property lives in a few literals that otherwise look arbitrary.
    const offGrid = (w: { x0: number; y0: number; step: number; n: number }): number => {
      let count = 0;
      for (let j = 0; j < w.n; j++) {
        for (let i = 0; i < w.n; i++) {
          const x = w.x0 + i * w.step;
          const y = w.y0 + j * w.step;
          if (!Object.is(Math.fround(x), x) || !Object.is(Math.fround(y), y)) count++;
        }
      }
      return count;
    };

    // 1,430 of 1,452, not all of them: an individual x lands back on the grid
    // now and then (`-213.3 + 7.3` is exactly -206), and at 22 positions both
    // coordinates do at once. Those 22 cannot discriminate a narrowing, which
    // is exactly why the count is frozen rather than asserted as "all".
    const total = CASES.reduce((n, c) => n + c.n * c.n, 0);
    expect(total).toBe(3 * 22 * 22);
    expect(CASES.reduce((n, c) => n + offGrid(c), 0)).toBe(1430);

    // The control, and the whole point: a tier-3-shaped window - binary origin,
    // binary step - is entirely ON the grid, so a sweep over it could not fail
    // for a narrowing reason no matter how many fields it folded.
    expect(offGrid({ x0: 512.5, y0: -1024.25, step: 0.5, n: 22 })).toBe(0);
    expect(offGrid({ x0: 3000.75, y0: 3000.75, step: 8, n: 22 })).toBe(0);
  });

  it("the tile field names match the catalog's own order", () => {
    // FIELD_NAMES spells the 21 tiles out rather than deriving them, so that a
    // reordering fails here instead of silently relabelling every downstream
    // failure. This is the check that keeps the two in step.
    const fromCatalog = makeTileCatalog(SEED0).map((t) => `tile:${t.name}`);
    const fromNames = FIELD_NAMES.filter((n) => n.startsWith("tile:"));
    expect(fromNames).toEqual(fromCatalog);
    expect(fromCatalog).toHaveLength(21);
    // And the tile block sits immediately after the 16 expression fields, so
    // `FIELD_NAMES[16 + i]` really is `TILE_ORDER[i]`'s probability.
    expect(FIELD_NAMES[16]).toBe("tile:deepwater");
    expect(FIELD_NAMES[36]).toBe("tile:red-desert-3");
    expect(FIELD_NAMES[37]).toBe("resolvedTileIndex");
  });

  it("the resolved tile index really is an index into the catalog", async () => {
    // `resolvedTileIndex` crosses the ABI as an f64, so a wrong widening or an
    // off-by-one would still fold to *some* number on both sides. This pins
    // that the values are integral and inside 0..21 - which the checksum
    // cannot say, because it folds raw bits.
    const c = CASES[0];
    const fields = tsFields(c);
    const resolved = fields[37];
    const seen = new Set<number>();
    for (let j = 0; j < c.n; j++) {
      for (let i = 0; i < c.n; i++) {
        const v = resolved(c.x0 + i * c.step, c.y0 + j * c.step);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(21);
        seen.add(v);
      }
    }
    // Anti-vacuity: a window that resolved to one constant tile would satisfy
    // everything above and grade nothing.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("the cases actually differ from each other, field by field", async () => {
    // Three cases that folded to the same numbers would be one case run three
    // times. Every field must move between the two default-control windows
    // (different geometry), and the moved-control case must move a field only
    // a control can reach.
    const engine = await instantiate();
    for (let f = 0; f < FIELD_NAMES.length; f++) {
      expect(
        wasmChecksum(engine, CASES[0], f),
        `${FIELD_NAMES[f]} is the same near and far`,
      ).not.toBe(wasmChecksum(engine, CASES[1], f));
    }
    // `temperature` reads none of the geometry-independent controls except its
    // own two, so it is the sharpest check that the control block is wired.
    expect(wasmChecksum(engine, CASES[0], 15)).not.toBe(wasmChecksum(engine, CASES[2], 15));
  });
});
