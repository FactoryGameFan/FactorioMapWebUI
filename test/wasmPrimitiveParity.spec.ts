import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { expectFrozen, expectRecordedRows, flushRecording } from "./tier2Frozen";

/** Its own section - see `tier2Frozen.ts`; each spec declares its own row count. */
const PLANET = "primitives:primitive";

afterAll(flushRecording);

/**
 * Every row this spec records, declared once so a partial record run cannot
 * pass its own count check. See `expectRecordedRows` in `tier2Frozen.ts`.
 *
 * Five blocks - random penalty, spot candidates, spot selection, starting
 * lakes, distance from nearest point - contributing their own case tables.
 */
expectRecordedRows(PLANET, 18);

import { spotCandidatePoints } from "../src/noise/spotCandidates";
import { selectSpots } from "../src/noise/spotSelection";

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

// Off the lattice, and a step that is not a simple binary fraction.
const X0 = -3.5;
const Y0 = 7.25;
const STEP = 0.37;
const N = 32;

/**
 * The TypeScript arm went with `randomPenalty.ts` in #227, so these rows are
 * graded against the frozen table alone. See `tier2Frozen.ts`.
 */
describe("random_penalty folds to its frozen checksums", () => {
  // `sourceKind` 1 is `x`, which goes negative over half this grid, so the
  // `source <= 0` pass-through and the draw it does NOT consume are inside the
  // comparison. A batch of all-positive sources would never reach that branch.
  const CASES = [
    { rpSeed: 1, amplitude: 1, sourceKind: 0 },
    { rpSeed: 7, amplitude: 2, sourceKind: 0 },
    { rpSeed: 13, amplitude: 0.5, sourceKind: 1 },
  ] as const;

  it("folds a 1,024-position batch to the frozen checksum, over several cases", async () => {
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
      );
    }
  });

  it("would notice the amplitude moving by one ULP", async () => {
    // The anti-vacuity check for this block. A fold that ignored its input
    // would pass the test above.
    //
    // It used to perturb one value of the TypeScript batch by a single ULP and
    // show the fold moved. #227 deleted that arm, so the ULP goes into the one
    // input still reachable from outside: `amplitude` scales every penalty in
    // the batch and crosses the boundary as an f64, so one ULP of it is one ULP
    // the fold has to see.
    const engine = await instantiate();
    const c = CASES[0];
    const at = (amplitude: number): bigint =>
      u64(engine.checksum_random_penalty(c.rpSeed, amplitude, c.sourceKind, X0, Y0, STEP, N));
    expect(at(c.amplitude)).not.toBe(at(c.amplitude + Number.EPSILON * c.amplitude));
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

/**
 * The TypeScript arm went with `startingLakes.ts` in #227, so these rows are
 * graded against the frozen table alone. See `tier2Frozen.ts`.
 *
 * The block lost its companion check, "draws one continuous stream, so more
 * spawns is not more copies of one lake". That one read each lake's offset from
 * its own spawn, and `checksum_starting_lakes` returns a single fold over every
 * coordinate, which cannot be decomposed back into per-lake offsets. Restoring
 * it needs an engine export that emits the lakes rather than their checksum.
 */
describe("starting_lake_positions folds to its frozen checksums", () => {
  const CASES = [
    { seed0: 123456, spawnCount: 1 },
    { seed0: 123456, spawnCount: 4 },
    { seed0: 999, spawnCount: 3 },
    // Below the 0x155 clamp, so the guard against the all-zero taus88 state is
    // inside the comparison.
    { seed0: 0, spawnCount: 2 },
    { seed0: 4294967295, spawnCount: 2 },
  ] as const;

  it("folds every lake to the frozen checksum, including below the seed clamp", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(engine.checksum_starting_lakes(c.seed0, c.spawnCount));
      expectFrozen(
        PLANET,
        `lakes seed0=${c.seed0} spawns=${c.spawnCount}`,
        "checksum_starting_lakes",
        fromWasm,
      );
    }
  });
});

/**
 * `distanceFromNearestPoint` itself survives #227, but its points came from
 * `startingLakePositions`, which did not - so there is no TypeScript arm left
 * to build the same input on. These rows are graded against the frozen table,
 * and both of the block's anti-vacuity checks are asked of the engine instead.
 */
describe("distance_from_nearest_point folds to its frozen checksums", () => {
  // A cap that the grid actually reaches, and one it never does. With every
  // point inside the cap the `bestSq < maxSq` branch is the only one that ever
  // runs, and the capped return would be dead on both sides.
  const CASES = [
    { seed0: 123456, spawnCount: 1, maximumDistance: 1024 },
    { seed0: 123456, spawnCount: 3, maximumDistance: 50 },
    { seed0: 999, spawnCount: 2, maximumDistance: Infinity },
  ] as const;

  it("folds 1,024 grid points to the frozen checksum, capped and uncapped", async () => {
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
      );
    }
  });

  it("actually reaches the cap on the capped case, and never on the uncapped one", async () => {
    // Anti-vacuity for the case list above: if no grid point saturated, the two
    // cases would exercise the same single branch.
    //
    // Asked of the engine since #227 took the TypeScript arm. Raising the cap
    // moves the fold if and only if some point was being clamped by it, which
    // is the claim the old array scan made. The uncapped case is shown the
    // other way round: a cap of 1e300 is indistinguishable from Infinity, so
    // nothing in that grid comes anywhere near saturating.
    const engine = await instantiate();
    const at = (c: (typeof CASES)[number], maximumDistance: number): bigint =>
      u64(
        engine.checksum_distance_from_nearest_point(
          c.seed0,
          c.spawnCount,
          maximumDistance,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
    expect(at(CASES[1], 50)).not.toBe(at(CASES[1], Infinity));
    expect(at(CASES[2], Infinity)).toBe(at(CASES[2], 1e300));
  });

  it("would notice the cap moving by one f32 ULP", async () => {
    // The ULP check this block used to make against a perturbed TypeScript
    // array. The capped case saturates - the test above proves it - so a move
    // in the cap is a move in every value that clamps to it.
    //
    // One f32 ULP, not one f64 ULP. The export folds
    // `f64::from(distance_from_nearest_point(...))` and that function returns
    // an `f32`, so a cap nudged below f32 resolution comes back as the very
    // same number. Measured: written with `Number.EPSILON` this test failed,
    // both folds equal. At 50 the f32 ULP is 2^-18.
    const c = CASES[1];
    const nudged = c.maximumDistance + 2 ** -18;
    expect(Math.fround(nudged), "the perturbation must survive the f32 return").not.toBe(
      c.maximumDistance,
    );

    const engine = await instantiate();
    const at = (maximumDistance: number): bigint =>
      u64(
        engine.checksum_distance_from_nearest_point(
          c.seed0,
          c.spawnCount,
          maximumDistance,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
    expect(at(c.maximumDistance)).not.toBe(at(nudged));
  });
});
