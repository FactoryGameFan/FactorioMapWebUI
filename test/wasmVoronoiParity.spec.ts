import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { expectFrozen, expectRecordedRows, flushRecording } from "./tier2Frozen";

/** Its own section - see `tier2Frozen.ts`; each spec declares its own row count. */
const PLANET = "primitives:voronoi";

afterAll(flushRecording);

/**
 * Every row this spec records, declared once so a partial record run cannot
 * pass its own count check. See `expectRecordedRows` in `tier2Frozen.ts`.
 *
 * 75 value rows - 5 cases x (4 distance types x 4 ops, less the one refused
 * pyramid/minkowski3 pair) - plus one cell-index row per (case, distance
 * type), which has no op dimension because the index is the same whichever op
 * reads it.
 */
expectRecordedRows(PLANET, 95);

/**
 * Tier 2 of the Rust port's gate for the four `voronoi_*` ops: strict bit
 * equality between the two ports over a shared grid, folded order-sensitively.
 *
 * **This is the port's largest and most stateful op.** Each sample walks a 9- or
 * 25-cell block, two of the ops read the same search result, the pyramid walks
 * its block twice, and both ports cache per-cell points across the sweep. A
 * fold over a whole grid is the right instrument for that: a cache that handed
 * back another cell's point, or a search that broke a tie the other way, moves
 * every sample after the mistake rather than one.
 *
 * **The caches are inside the comparison, deliberately.** Each case builds the
 * field once and sweeps it, so a cold cache warms exactly as a render would.
 * The Go spike's direct-mapped cache used a zero-initialised tag array, which
 * made cell (0, 0) read uninitialised offsets - a checksum caught it and the
 * timings did not (spec section 8.4).
 *
 * **It detects divergence; it does not establish correctness.** Both ports
 * could agree and both be wrong. Correctness is tier 1 - the four oracle
 * fixtures, 61,993 graded values - which each port is graded against
 * separately, both reading the same files.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  checksum_voronoi: (
    seed0: number,
    seed1: number,
    gridSize: number,
    jitter: number,
    distanceType: number,
    op: number,
    x0: number,
    y0: number,
    step: number,
    n: number,
  ) => bigint;
  checksum_voronoi_cell_index: (
    seed0: number,
    seed1: number,
    gridSize: number,
    jitter: number,
    distanceType: number,
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

function foldAll(values: readonly number[]): bigint {
  let acc = 0n;
  for (const v of values) acc = foldF64(acc, v);
  return acc;
}

/** The game's own `DistanceType` order, which is what indexes its jump table. */
const DISTANCE_TYPES = ["chebyshev", "manhattan", "euclidean", "minkowski3"] as const;
/** Matches the `op` selector on the Rust export. */
const OPS = ["cellId", "spotNoise", "facetNoise", "pyramidNoise"] as const;

// Off the lattice, and a step that is not a simple binary fraction, so the
// sweep crosses many cells and few samples land on an exact cell centre.
const X0 = -137.5;
const Y0 = 91.25;
const STEP = 3.7;
const N = 40;

function sweep(evaluate: (x: number, y: number) => number): number[] {
  const out: number[] = [];
  for (let j = 0; j < N; j++) {
    const y = Y0 + j * STEP;
    for (let i = 0; i < N; i++) out.push(evaluate(X0 + i * STEP, y));
  }
  return out;
}

// Jitter 0 is degenerate - every cell is a congruent unit square - so the
// jittered rows are what discriminate. Both are here because the jitter-0 row
// is free and a regression would show there first. The grid sizes include a
// FRACTIONAL one, because `grid_size` is a u16 in the game and a fractional
// argument is truncated; a port that rounded instead would differ.
const CASES = [
  { seed0: 123456, seed1: 1, gridSize: 64, jitter: 0 },
  { seed0: 123456, seed1: 1, gridSize: 64, jitter: 0.6 },
  { seed0: 123456, seed1: 1, gridSize: 175, jitter: 0.8 },
  { seed0: 654321, seed1: 7, gridSize: 175, jitter: 1 },
  { seed0: 123456, seed1: 0, gridSize: 155.65736389160156, jitter: 0.6 },
] as const;

describe("the engine's voronoi_* ops fold to their frozen checksums", () => {
  it("folds 1,600 grid points to the frozen checksum, over every op x distance_type x case", async () => {
    const engine = await instantiate();
    let compared = 0;
    for (const c of CASES) {
      for (const [dtIndex, distanceType] of DISTANCE_TYPES.entries()) {
        for (const [opIndex, op] of OPS.entries()) {
          // The game's own expression compiler refuses this pair, and both
          // ports refuse it too - the Rust panics, so it must not be called.
          if (op === "pyramidNoise" && distanceType === "minkowski3") continue;
          const fromWasm = u64(
            engine.checksum_voronoi(
              c.seed0,
              c.seed1,
              c.gridSize,
              c.jitter,
              dtIndex,
              opIndex,
              X0,
              Y0,
              STEP,
              N,
            ),
          );
          compared++;
          expectFrozen(
            PLANET,
            `${op} ${distanceType} jitter=${c.jitter} grid=${c.gridSize} seed0=${c.seed0}`,
            "checksum_voronoi",
            fromWasm,
          );
        }
      }
    }
    // 5 cases x (4 distance types x 4 ops - the 1 refused pyramid/minkowski3
    // pair) = 5 x 15, each a 1,600-point sweep.
    expect(compared).toBe(75);
  });

  it("folds the stable cell INDEX too, which cell_id can collide on", async () => {
    // Two distinct cells can share a `cell_id` - the XOR combine forces exactly
    // two colliding pairs - so a port that returned the wrong cell could still
    // produce the right float. This is the assertion that sees it.
    const engine = await instantiate();
    for (const c of CASES) {
      for (const [dtIndex, distanceType] of DISTANCE_TYPES.entries()) {
        const fromWasm = u64(
          engine.checksum_voronoi_cell_index(
            c.seed0,
            c.seed1,
            c.gridSize,
            c.jitter,
            dtIndex,
            X0,
            Y0,
            STEP,
            N,
          ),
        );
        expectFrozen(
          PLANET,
          `index ${distanceType} jitter=${c.jitter} grid=${c.gridSize}`,
          "checksum_voronoi_cell_index",
          fromWasm,
        );
      }
    }
  });

  it("the fold would notice a single sample differing by one ULP", () => {
    // The anti-vacuity check for the freeze. A fold that ignored its input
    // would freeze to a stable number and catch nothing. This used to bend
    // the TypeScript sweep at one of its 1,600 samples; with that arm gone
    // (#371) it bends a synthetic sweep of the same length, which is the same
    // claim about the same fold.
    const values = sweep((x, y) => Math.sin(x * 0.11) * Math.cos(y * 0.07));
    const perturbed = [...values];
    const buf = new Float32Array(1);
    const bits = new Uint32Array(buf.buffer);
    buf[0] = perturbed[777] as number;
    bits[0] += 1;
    perturbed[777] = buf[0];
    expect(perturbed[777]).not.toBe(values[777]);
    expect(foldAll(perturbed)).not.toBe(foldAll(values));
  });

  it("is sensitive to jitter, grid size and both seeds", async () => {
    // Guards the shape where an export drops an argument. Each of these is
    // reachable only through the parameter it names.
    const engine = await instantiate();
    const at = (seed0: number, seed1: number, gridSize: number, jitter: number): bigint =>
      u64(engine.checksum_voronoi(seed0, seed1, gridSize, jitter, 1, 1, X0, Y0, STEP, N));
    const base = at(123456, 1, 64, 0.6);
    expect(at(123456, 1, 64, 0.61)).not.toBe(base);
    expect(at(123456, 1, 65, 0.6)).not.toBe(base);
    expect(at(123457, 1, 64, 0.6)).not.toBe(base);
    // seed0 and seed1 combine as one 32-bit SUM, so this pair is the same field
    // - which is a property of the game, not a gap in the check above.
    expect(at(123455, 2, 64, 0.6)).toBe(base);
  });

  it("truncates a fractional grid size rather than rounding it", async () => {
    // `grid_size` is a u16 in the game, measured at 101/101 against the
    // truncated value and 91/101 against the rounded one. The fractional case
    // in CASES above would be vacuous if the two agreed here.
    const engine = await instantiate();
    const at = (gridSize: number): bigint =>
      u64(engine.checksum_voronoi(123456, 0, gridSize, 0.6, 1, 1, X0, Y0, STEP, N));
    expect(at(155.65736389160156)).toBe(at(155));
    expect(at(155.65736389160156)).not.toBe(at(156));
  });
});
