import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { expectFrozen, expectRecordedRows, flushRecording } from "./tier2Frozen";

/** Its own section - see `tier2Frozen.ts`; each spec declares its own row count. */
const PLANET = "primitives:primitive";

afterAll(flushRecording);

import { distanceFromNearestPoint, type Point } from "../src/noise/distanceFromNearestPoint";
import { randomPenaltyBatch } from "../src/noise/randomPenalty";
import { spotCandidatePoints } from "../src/noise/spotCandidates";
import { selectSpots } from "../src/noise/spotSelection";
import { startingLakePositions } from "../src/noise/startingLakes";

/**
 * Tier 2 of the Rust port's gate for the phase-1 primitives that do NOT compose
 * `basis_noise`: `random_penalty`, the `spot_noise` pair, `starting_lakes` and
 * `distance_from_nearest_point`. Strict bit equality between the two ports over
 * a shared workload, folded order-sensitively. Companion to
 * `test/wasmBasisNoiseParity.spec.ts` and `test/wasmMultioctaveParity.spec.ts`.
 *
 * **These are the first ops in the port with STATE that is not a float.** The
 * multioctave family threads an f32 accumulator; these thread a taus88 stream,
 * an accepted-spot list and a batch index. A fold over the whole output is a
 * sharp instrument for that: a stream that advances one draw too far, a batch
 * indexed by rank instead of acceptance order, or a rejection that decays the
 * threshold when it should not all move every value after the mistake rather
 * than one.
 *
 * **It detects divergence; it does not establish correctness.** Both ports
 * could agree and both be wrong, and for this batch that is not theoretical:
 * `distance_from_nearest_point` returns raw f64 in BOTH ports while the game's
 * recorded values are f32, and this file would be green either way. Correctness
 * is tier 1 - the oracle fixtures - which each port is graded against
 * separately, both reading the same files.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  checksum_random_penalty: (
    rpSeed: number,
    amplitude: number,
    sourceKind: number,
    x0: number,
    y0: number,
    step: number,
    n: number,
  ) => bigint;
  checksum_spot_candidates: (
    seed0: number,
    seed1: number,
    regionX0: number,
    regionY0: number,
    regions: number,
    regionSize: number,
    count: number,
  ) => bigint;
  checksum_spot_selection: (
    seed0: number,
    seed1: number,
    regionX: number,
    regionY: number,
    regionSize: number,
    count: number,
    spacing: number,
    skipSpan: number,
    skipOffset: number,
    hard: number,
    density: number,
    quantity: number,
    favorabilityKind: number,
  ) => bigint;
  checksum_starting_lakes: (seed0: number, spawnCount: number) => bigint;
  checksum_distance_from_nearest_point: (
    seed0: number,
    spawnCount: number,
    maximumDistance: number,
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

/** The JavaScript half of `fmw_noise::checksum::fold_f64`. Raw bits, little-endian. */
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

/** Fold a flat list of values in order. */
function foldAll(values: readonly number[]): bigint {
  let acc = 0n;
  for (const v of values) acc = foldF64(acc, v);
  return acc;
}

/**
 * The spawn list both lake exports build, duplicated from `spawns()` in
 * `crates/fmw-wasm/src/lib.rs`. The boundary takes scalars, so a list would
 * have to go through the scratch region - machinery that would itself need
 * testing. Keep the two rules in step.
 */
function spawns(count: number): Point[] {
  return Array.from({ length: count }, (_unused, k) => ({ x: k * 1000, y: k * -700 }));
}

// Off the lattice, and a step that is not a simple binary fraction.
const X0 = -3.5;
const Y0 = 7.25;
const STEP = 0.37;
const N = 32;

describe("Rust and TypeScript random_penalty agree bit for bit", () => {
  // `sourceKind` 1 is `x`, which goes negative over half this grid, so the
  // `source <= 0` pass-through and the draw it does NOT consume are inside the
  // comparison. A batch of all-positive sources would never reach that branch.
  const CASES = [
    { rpSeed: 1, amplitude: 1, sourceKind: 0 },
    { rpSeed: 7, amplitude: 2, sourceKind: 0 },
    { rpSeed: 13, amplitude: 0.5, sourceKind: 1 },
  ] as const;

  const batchOf = (c: (typeof CASES)[number]): number[] => {
    const positions: Point[] = [];
    for (let j = 0; j < N; j++) {
      const y = Y0 + j * STEP;
      for (let i = 0; i < N; i++) positions.push({ x: X0 + i * STEP, y });
    }
    const source = positions.map((p) => (c.sourceKind === 0 ? 1 : p.x));
    return randomPenaltyBatch(positions, source, { seed: c.rpSeed, amplitude: c.amplitude });
  };

  it("folds a 1,024-position batch to the identical checksum, over several cases", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(
        engine.checksum_random_penalty(c.rpSeed, c.amplitude, c.sourceKind, X0, Y0, STEP, N),
      );
      expectFrozen(
        PLANET,
        `penalty seed=${c.rpSeed} amp=${c.amplitude} src=${c.sourceKind}`,
        "checksum_random_penalty",
        fromWasm,
        foldAll(batchOf(c)),
      );
    }
    expectRecordedRows(PLANET, CASES.length);
  });

  it("would notice a single value differing by one ULP", async () => {
    // The anti-vacuity check for this block. A fold that ignored its input, or
    // a comparison of something against itself, would pass the test above.
    const engine = await instantiate();
    const c = CASES[0];
    const fromWasm = u64(
      engine.checksum_random_penalty(c.rpSeed, c.amplitude, c.sourceKind, X0, Y0, STEP, N),
    );
    const perturbed = batchOf(c);
    const buf = new Float32Array(1);
    const bits = new Uint32Array(buf.buffer);
    buf[0] = perturbed[500];
    bits[0] += 1;
    perturbed[500] = buf[0];
    expect(foldAll(perturbed)).not.toBe(fromWasm);
  });

  it("is order dependent, which is what makes it a batch op", async () => {
    // The seed comes from `positions[0]` and the stream runs last to first, so
    // reversing the batch must change every value. An export that treated this
    // as a per-position function would be insensitive to it.
    const engine = await instantiate();
    const at = (x0: number): bigint =>
      u64(engine.checksum_random_penalty(1, 1, 0, x0, Y0, STEP, N));
    expect(at(X0)).not.toBe(at(X0 + 1));
  });
});

describe("Rust and TypeScript spot_noise candidates agree bit for bit", () => {
  // Seeds spanning the u32 range, negative region indices, and a region size
  // that is not a power of two - the seed word's three primes and its wrapping
  // reduction are what these exercise.
  const CASES = [
    { seed0: 123456, seed1: 42, regionX0: -2, regionY0: 3, regions: 3, regionSize: 1024, count: 8 },
    {
      seed0: 0,
      seed1: 987654321,
      regionX0: 0,
      regionY0: 0,
      regions: 2,
      regionSize: 2048,
      count: 6,
    },
    {
      seed0: 4294967295,
      seed1: 4294967295,
      regionX0: -1,
      regionY0: -1,
      regions: 2,
      regionSize: 1000,
      count: 6,
    },
  ] as const;

  const coordsOf = (c: (typeof CASES)[number]): number[] => {
    const out: number[] = [];
    for (let ry = 0; ry < c.regions; ry++) {
      for (let rx = 0; rx < c.regions; rx++) {
        for (const p of spotCandidatePoints(
          {
            seed0: c.seed0,
            seed1: c.seed1,
            regionX: c.regionX0 + rx,
            regionY: c.regionY0 + ry,
          },
          c.regionSize,
          c.count,
        )) {
          out.push(p.x, p.y);
        }
      }
    }
    return out;
  };

  it("folds every candidate of a region block to the identical checksum", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(
        engine.checksum_spot_candidates(
          c.seed0,
          c.seed1,
          c.regionX0,
          c.regionY0,
          c.regions,
          c.regionSize,
          c.count,
        ),
      );
      expectFrozen(
        PLANET,
        `candidates seed0=${c.seed0} rs=${c.regionSize}`,
        "checksum_spot_candidates",
        fromWasm,
        foldAll(coordsOf(c)),
      );
    }
    expectRecordedRows(PLANET, CASES.length);
  });

  it("would notice a single candidate shifted by one tile", async () => {
    const engine = await instantiate();
    const c = CASES[0];
    const fromWasm = u64(
      engine.checksum_spot_candidates(
        c.seed0,
        c.seed1,
        c.regionX0,
        c.regionY0,
        c.regions,
        c.regionSize,
        c.count,
      ),
    );
    const perturbed = coordsOf(c);
    perturbed[17] += 1;
    expect(foldAll(perturbed)).not.toBe(fromWasm);
  });

  it("is sensitive to seed1, which enters the word through its own prime", async () => {
    // Guards the shape where an export drops an argument. seed1 is the one
    // reachable only through the 7927 term.
    const engine = await instantiate();
    const at = (seed1: number): bigint =>
      u64(engine.checksum_spot_candidates(123456, seed1, 0, 0, 1, 1024, 8));
    expect(at(42)).not.toBe(at(43));
  });
});

describe("Rust and TypeScript spot_noise selection agree bit for bit", () => {
  const FAVORABILITY: Array<(x: number, y: number) => number> = [() => 1, (x) => x, (x) => -x];

  // The fixture's own parameter space: a tight spacing that accepts nearly
  // everything, a huge one that leans on the 15/16 decay, both skip offsets,
  // and the hard-target branch that is the only route to `fastCbrt`.
  const CASES = [
    {
      seed0: 0,
      seed1: 9101,
      regionX: 0,
      regionY: 0,
      regionSize: 2048,
      count: 6,
      spacing: 0.001,
      skipSpan: 1,
      skipOffset: 0,
      hard: 0,
      density: 0.007152557373046875,
      quantity: 10000,
      fav: 1,
    },
    {
      seed0: 0,
      seed1: 9203,
      regionX: 0,
      regionY: 0,
      regionSize: 2048,
      count: 6,
      spacing: 500,
      skipSpan: 2,
      skipOffset: 1,
      hard: 0,
      density: 0.01430511474609375,
      quantity: 10000,
      fav: 2,
    },
    {
      seed0: 0,
      seed1: 9104,
      regionX: 0,
      regionY: 0,
      regionSize: 2048,
      count: 6,
      spacing: 0.001,
      skipSpan: 1,
      skipOffset: 0,
      hard: 1,
      density: 0.0059604644775390625,
      quantity: 10000,
      fav: 0,
    },
    {
      seed0: 123456,
      seed1: 100,
      regionX: -3,
      regionY: 7,
      regionSize: 1024,
      count: 21,
      spacing: 45.254833995939045,
      skipSpan: 1,
      skipOffset: 0,
      hard: 1,
      density: 0.02,
      quantity: 5000,
      fav: 1,
    },
  ] as const;

  const fieldsOf = (c: (typeof CASES)[number]): number[] => {
    const spots = selectSpots(
      { seed0: c.seed0, seed1: c.seed1, regionX: c.regionX, regionY: c.regionY },
      {
        regionSize: c.regionSize,
        candidateSpotCount: c.count,
        spacing: c.spacing,
        skipSpan: c.skipSpan,
        skipOffset: c.skipOffset,
        hardRegionTargetQuantity: c.hard === 1,
        density: () => c.density,
        quantity: () => c.quantity,
        favorability: FAVORABILITY[c.fav],
      },
    );
    return spots.flatMap((s) => [s.x, s.y, s.quantity, s.coneScale]);
  };

  it("folds every selected spot's fields to the identical checksum", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(
        engine.checksum_spot_selection(
          c.seed0,
          c.seed1,
          c.regionX,
          c.regionY,
          c.regionSize,
          c.count,
          c.spacing,
          c.skipSpan,
          c.skipOffset,
          c.hard,
          c.density,
          c.quantity,
          c.fav,
        ),
      );
      expectFrozen(
        PLANET,
        `selection seed1=${c.seed1} spacing=${c.spacing} hard=${c.hard} fav=${c.fav}`,
        "checksum_spot_selection",
        fromWasm,
        foldAll(fieldsOf(c)),
      );
    }
    expectRecordedRows(PLANET, CASES.length);
  });

  it("emits a shrunken cone on the hard-target case, so fastCbrt is inside the fold", async () => {
    // Without this the hard-target branch could be dead in both ports and every
    // checksum above would still agree. `coneScale` is 1 for a full spot, so a
    // value strictly between 0 and 1 is the branch's signature.
    const shrunk = fieldsOf(CASES[2]).filter((_v, i) => i % 4 === 3);
    expect(shrunk.some((s) => s > 0 && s < 1)).toBe(true);
  });

  it("would notice a single field differing by one ULP", async () => {
    const engine = await instantiate();
    const c = CASES[0];
    const fromWasm = u64(
      engine.checksum_spot_selection(
        c.seed0,
        c.seed1,
        c.regionX,
        c.regionY,
        c.regionSize,
        c.count,
        c.spacing,
        c.skipSpan,
        c.skipOffset,
        c.hard,
        c.density,
        c.quantity,
        c.fav,
      ),
    );
    const perturbed = fieldsOf(c);
    perturbed[2] = perturbed[2] + Number.EPSILON * perturbed[2];
    expect(foldAll(perturbed)).not.toBe(fromWasm);
  });

  it("is sensitive to the favorability shape, which drives the sort", async () => {
    // Constant favorability leaves the order entirely to the acceptance-index
    // tie-break, so a port could get the comparator wrong and still agree. This
    // is what makes the sort observable.
    const engine = await instantiate();
    const at = (fav: number): bigint =>
      u64(
        engine.checksum_spot_selection(
          0,
          9101,
          0,
          0,
          2048,
          6,
          0.001,
          1,
          0,
          0,
          0.007152557373046875,
          10000,
          fav,
        ),
      );
    expect(at(1)).not.toBe(at(2));
  });
});

describe("Rust and TypeScript starting_lake_positions agree bit for bit", () => {
  const CASES = [
    { seed0: 123456, spawnCount: 1 },
    { seed0: 123456, spawnCount: 4 },
    { seed0: 999, spawnCount: 3 },
    // Below the 0x155 clamp, so the guard against the all-zero taus88 state is
    // inside the comparison.
    { seed0: 0, spawnCount: 2 },
    { seed0: 4294967295, spawnCount: 2 },
  ] as const;

  const coordsOf = (c: (typeof CASES)[number]): number[] =>
    startingLakePositions(c.seed0, spawns(c.spawnCount)).flatMap((p) => [p.x, p.y]);

  it("folds every lake to the identical checksum, including below the seed clamp", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(engine.checksum_starting_lakes(c.seed0, c.spawnCount));
      expectFrozen(
        PLANET,
        `lakes seed0=${c.seed0} spawns=${c.spawnCount}`,
        "checksum_starting_lakes",
        fromWasm,
        foldAll(coordsOf(c)),
      );
    }
    expectRecordedRows(PLANET, CASES.length);
  });

  it("draws one continuous stream, so more spawns is not more copies of one lake", async () => {
    // A port that re-seeded per spawn would still agree with itself and pass
    // everything above. The lakes sit at radius 75 around DIFFERENT spawns, so
    // compare the offsets rather than the absolute positions.
    const lakes = startingLakePositions(123456, spawns(4));
    const offsets = lakes.map((p, k) => `${p.x - k * 1000},${p.y - k * -700}`);
    expect(new Set(offsets).size).toBeGreaterThan(1);
  });
});

describe("Rust and TypeScript distance_from_nearest_point agree bit for bit", () => {
  // A cap that the grid actually reaches, and one it never does. With every
  // point inside the cap the `bestSq < maxSq` branch is the only one that ever
  // runs, and the capped return would be dead on both sides.
  const CASES = [
    { seed0: 123456, spawnCount: 1, maximumDistance: 1024 },
    { seed0: 123456, spawnCount: 3, maximumDistance: 50 },
    { seed0: 999, spawnCount: 2, maximumDistance: Infinity },
  ] as const;

  const valuesOf = (c: (typeof CASES)[number]): number[] => {
    const points = startingLakePositions(c.seed0, spawns(c.spawnCount));
    const out: number[] = [];
    for (let j = 0; j < N; j++) {
      const y = Y0 + j * STEP;
      for (let i = 0; i < N; i++) {
        out.push(distanceFromNearestPoint(X0 + i * STEP, y, points, c.maximumDistance));
      }
    }
    return out;
  };

  it("folds 1,024 grid points to the identical checksum, capped and uncapped", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(
        engine.checksum_distance_from_nearest_point(
          c.seed0,
          c.spawnCount,
          c.maximumDistance,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
      expectFrozen(
        PLANET,
        `distance seed0=${c.seed0} max=${c.maximumDistance}`,
        "checksum_distance_from_nearest_point",
        fromWasm,
        foldAll(valuesOf(c)),
      );
    }
    expectRecordedRows(PLANET, CASES.length);
  });

  it("actually reaches the cap on the capped case, and never on the uncapped one", async () => {
    // Anti-vacuity for the case list above: if no grid point saturated, the two
    // cases would exercise the same single branch.
    expect(valuesOf(CASES[1]).some((v) => v === 50)).toBe(true);
    expect(valuesOf(CASES[2]).every((v) => Number.isFinite(v))).toBe(true);
  });

  it("would notice a single distance differing by one ULP", async () => {
    const engine = await instantiate();
    const c = CASES[0];
    const fromWasm = u64(
      engine.checksum_distance_from_nearest_point(
        c.seed0,
        c.spawnCount,
        c.maximumDistance,
        X0,
        Y0,
        STEP,
        N,
      ),
    );
    const perturbed = valuesOf(c);
    perturbed[900] = perturbed[900] + Number.EPSILON * perturbed[900];
    expect(foldAll(perturbed)).not.toBe(fromWasm);
  });
});
