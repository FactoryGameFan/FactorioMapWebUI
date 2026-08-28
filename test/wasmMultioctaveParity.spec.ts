import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { expectFrozen, expectRecordedRows, flushRecording } from "./tier2Frozen";

/**
 * All five primitive/eval parity specs record into one section, so
 * `tier2Coverage.spec.ts` can enumerate the module's exports and require a
 * frozen row for each. The row NAME is the export, which is what makes that
 * check possible.
 */
const PLANET = "primitives:multioctave";

afterAll(flushRecording);

/**
 * Every row this spec records, declared once so a partial record run cannot
 * pass its own count check. See `expectRecordedRows` in `tier2Frozen.ts`.
 *
 * 3 cases each for the plain, variable-persistence and quick multioctaves.
 */
expectRecordedRows(PLANET, 9);

import { makeMultioctaveNoise } from "../src/noise/multioctaveNoise";
import { makeQuickMultioctaveNoise } from "../src/noise/quickMultioctaveNoise";
import { makeVariablePersistenceMultioctaveNoise } from "../src/noise/variablePersistenceMultioctaveNoise";

/**
 * Tier 2 of the Rust port's gate for the multioctave family: strict bit
 * equality between the two ports over a shared grid, folded order-sensitively.
 * Companion to `test/wasmBasisNoiseParity.spec.ts`, which does the same for the
 * leaf these three compose.
 *
 * **These are the first COMPOSED ops in the port.** `basis_noise` is a leaf;
 * each of these calls it N times per point and threads an f32 accumulator
 * between the calls. That accumulator is where a precision mistake compounds
 * rather than cancels, so a fold over 4,096 points is a much sharper instrument
 * here than it was for the leaf.
 *
 * **It detects divergence; it does not establish correctness.** Both ports
 * could agree and both be wrong - and for this family that is not a theoretical
 * worry, it is what actually happened: the TypeScript evaluated
 * `quick_multioctave_noise` in f64 for a year while its spec called the gap a
 * "documented f32 floor". A Rust port written from that reference would have
 * matched it bit for bit and this file would have been green. Correctness is
 * tier 1 - the oracle fixtures - which each port is graded against separately,
 * both reading the same files.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  checksum_multioctave_noise: (
    seed0: number,
    seed1: number,
    octaves: number,
    persistence: number,
    inputScale: number,
    outputScale: number,
    x0: number,
    y0: number,
    step: number,
    n: number,
  ) => bigint;
  checksum_variable_persistence: (
    seed0: number,
    seed1: number,
    octaves: number,
    inputScale: number,
    outputScale: number,
    offsetX: number,
    persistence: number,
    x0: number,
    y0: number,
    step: number,
    n: number,
  ) => bigint;
  checksum_quick_multioctave: (
    seed0: number,
    seed1: number,
    octaves: number,
    inputScale: number,
    outputScale: number,
    oosm: number,
    oism: number,
    offsetX: number,
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

/** Walk the same grid the Rust exports walk: rows outer, columns inner. */
function foldGrid(
  evaluate: (x: number, y: number) => number,
  x0: number,
  y0: number,
  step: number,
  n: number,
  perturbIndex = -1,
): bigint {
  const buf = new Float32Array(1);
  const bits = new Uint32Array(buf.buffer);
  let acc = 0n;
  let k = 0;
  for (let j = 0; j < n; j++) {
    const y = y0 + j * step;
    for (let i = 0; i < n; i++) {
      let v = evaluate(x0 + i * step, y);
      if (k === perturbIndex) {
        buf[0] = v;
        bits[0] += 1;
        v = buf[0];
      }
      acc = foldF64(acc, v);
      k++;
    }
  }
  return acc;
}

// Off the lattice, and a step that is not a simple binary fraction, so the grid
// walks many cells and few points land on the exact lattice zeros the kernel
// returns there.
const X0 = -3.5;
const Y0 = 7.25;
const STEP = 0.37;
const N = 64;

describe("Rust and TypeScript multioctave_noise agree bit for bit", () => {
  // Parameters chosen so nothing degenerate hides a mistake: a persistence with
  // no exact f32 form (so the RMS normalisation's fastapprox path runs and the
  // `1/P == 1` shortcut does not), several octave counts, and two seeds.
  const CASES = [
    { seed0: 123456, seed1: 5, octaves: 6, persistence: 0.65, inputScale: 1 / 32, outputScale: 1 },
    { seed0: 123456, seed1: 0, octaves: 1, persistence: 0.5, inputScale: 0.125, outputScale: 2 },
    { seed0: 654321, seed1: 260, octaves: 4, persistence: 0.7, inputScale: 0.08, outputScale: 0.6 },
  ] as const;

  it("folds 4,096 grid points to the identical checksum, over several cases", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(
        engine.checksum_multioctave_noise(
          c.seed0,
          c.seed1,
          c.octaves,
          c.persistence,
          c.inputScale,
          c.outputScale,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
      const fn = makeMultioctaveNoise({
        seed0: c.seed0,
        seed1: c.seed1,
        octaves: c.octaves,
        persistence: c.persistence,
        inputScale: c.inputScale,
        outputScale: c.outputScale,
      });
      expectFrozen(
        PLANET,
        `multioctave octaves=${c.octaves} p=${c.persistence} seed1=${c.seed1}`,
        "checksum_multioctave_noise",
        fromWasm,
        foldGrid(fn, X0, Y0, STEP, N),
      );
    }
  });

  it("would notice a single point differing by one ULP", async () => {
    // The anti-vacuity check for this file. A fold that ignored its input, or a
    // comparison of something against itself, would pass the test above and
    // catch nothing.
    const engine = await instantiate();
    const c = CASES[0];
    const fromWasm = u64(
      engine.checksum_multioctave_noise(
        c.seed0,
        c.seed1,
        c.octaves,
        c.persistence,
        c.inputScale,
        c.outputScale,
        X0,
        Y0,
        STEP,
        N,
      ),
    );
    const fn = makeMultioctaveNoise({ ...c });
    expect(foldGrid(fn, X0, Y0, STEP, N, 1234)).not.toBe(fromWasm);
  });

  it("is sensitive to persistence, which drives the fastapprox normalisation", async () => {
    // Guards the shape where the export ignores an argument. Persistence is the
    // one that reaches `fastLog2`/`fastPow2`, ported alongside these ops.
    const engine = await instantiate();
    const at = (persistence: number): bigint =>
      u64(engine.checksum_multioctave_noise(123456, 5, 6, persistence, 1 / 32, 1, X0, Y0, STEP, N));
    expect(at(0.65)).not.toBe(at(0.66));
  });
});

describe("Rust and TypeScript variable_persistence_multioctave_noise agree bit for bit", () => {
  // Persistence is a single value per call here rather than per point. The real
  // op takes a spatially varying one, but computing a per-point persistence
  // would put arithmetic that is NOT the op under test on both sides of the
  // comparison, where a difference would read as an op divergence. The per-tile
  // path is graded by tier 1, which feeds the fixture's captured
  // `persistenceField`. Several values are used here instead.
  const CASES = [
    {
      seed0: 123456,
      seed1: 14,
      octaves: 5,
      inputScale: 1 / 8,
      outputScale: 1,
      offsetX: 0,
      p: 0.75,
    },
    {
      seed0: 123456,
      seed1: 5,
      octaves: 4,
      inputScale: 0.1,
      outputScale: 0.8,
      offsetX: 40000,
      p: 0.62,
    },
    { seed0: 654321, seed1: 7, octaves: 3, inputScale: 0.2, outputScale: 2, offsetX: 5000, p: 0.9 },
  ] as const;

  it("folds 4,096 grid points to the identical checksum, over several cases", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(
        engine.checksum_variable_persistence(
          c.seed0,
          c.seed1,
          c.octaves,
          c.inputScale,
          c.outputScale,
          c.offsetX,
          c.p,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
      const fn = makeVariablePersistenceMultioctaveNoise({
        seed0: c.seed0,
        seed1: c.seed1,
        octaves: c.octaves,
        inputScale: c.inputScale,
        outputScale: c.outputScale,
        offsetX: c.offsetX,
      });
      // Handed to both sides UN-narrowed. This used to be `Math.fround(c.p)`,
      // with a comment explaining that the WASM boundary took `persistence` as
      // an f32 - which was true, and was the bug: the accumulator multiply is
      // `f32(acc * persistence)` against an f64 persistence, so narrowing here
      // made the two sides agree by construction on the one term that actually
      // differed. Two of the cases above (0.62, 0.9) are not f32-exact, so this
      // comparison now grades the operand width. See #226 and #254.
      expectFrozen(
        PLANET,
        `varpersist octaves=${c.octaves} offset=${c.offsetX} p=${c.p}`,
        "checksum_variable_persistence",
        fromWasm,
        foldGrid((x, y) => fn(x, y, c.p), X0, Y0, STEP, N),
      );
    }
  });

  it("is sensitive to offset_x, which is a single world-space translation here", async () => {
    // Not a per-octave shift - the port once carried a fitted `-7936` that was
    // an alias of zero. A checksum that did not move with offset_x would mean
    // the argument was being dropped.
    const engine = await instantiate();
    const at = (offsetX: number): bigint =>
      u64(
        engine.checksum_variable_persistence(
          123456,
          14,
          5,
          1 / 8,
          1,
          offsetX,
          0.75,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
    expect(at(0)).not.toBe(at(5000));
  });
});

describe("Rust and TypeScript quick_multioctave_noise agree bit for bit", () => {
  // The climate trees' own shapes, plus the fixture's 6-octave case. The
  // multipliers deliberately include values with no exact f32 form (0.6, 0.65,
  // 0.55), because narrowing the parameters is the single biggest term of this
  // op's f32 fix and a port that skipped it would still pass on 0.5 and 2.
  const CASES = [
    {
      seed0: 123456,
      seed1: 999,
      octaves: 6,
      inputScale: 0.08,
      outputScale: 1.5,
      oosm: 0.5,
      oism: 0.5,
      offsetX: 0,
    },
    {
      seed0: 123456,
      seed1: 5,
      octaves: 4,
      inputScale: 1 / 32,
      outputScale: 1 / 20,
      oosm: 3,
      oism: 1 / 3,
      offsetX: 40000,
    },
    {
      seed0: 654321,
      seed1: 42,
      octaves: 5,
      inputScale: 0.1,
      outputScale: 1,
      oosm: 0.65,
      oism: 0.55,
      offsetX: 12000,
    },
  ] as const;

  it("folds 4,096 grid points to the identical checksum, over several cases", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      const fromWasm = u64(
        engine.checksum_quick_multioctave(
          c.seed0,
          c.seed1,
          c.octaves,
          c.inputScale,
          c.outputScale,
          c.oosm,
          c.oism,
          c.offsetX,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
      const fn = makeQuickMultioctaveNoise({
        seed0: c.seed0,
        seed1: c.seed1,
        octaves: c.octaves,
        inputScale: c.inputScale,
        outputScale: c.outputScale,
        octaveOutputScaleMultiplier: c.oosm,
        octaveInputScaleMultiplier: c.oism,
        offsetX: c.offsetX,
      });
      expectFrozen(
        PLANET,
        `quick octaves=${c.octaves} oism=${c.oism} seed1=${c.seed1}`,
        "checksum_quick_multioctave",
        fromWasm,
        foldGrid(fn, X0, Y0, STEP, N),
      );
    }
  });

  it("is sensitive to the octave multipliers, which are narrowed to f32", async () => {
    const engine = await instantiate();
    const at = (oism: number, oosm: number): bigint =>
      u64(engine.checksum_quick_multioctave(123456, 5, 4, 0.1, 1, oosm, oism, 0, X0, Y0, STEP, N));
    expect(at(0.55, 0.65)).not.toBe(at(0.56, 0.65));
    expect(at(0.55, 0.65)).not.toBe(at(0.55, 0.66));
  });

  it("re-seeds per octave, so a one-octave call differs from the same seed at two", async () => {
    // This op decorrelates octaves by re-seeding (`seed0 + k`), not by an x
    // shift. A port that reused octave 0's tables for every octave would still
    // agree with itself and pass everything above.
    const engine = await instantiate();
    const at = (octaves: number): bigint =>
      u64(engine.checksum_quick_multioctave(123456, 5, octaves, 0.1, 1, 1, 1, 0, X0, Y0, STEP, N));
    // With oosm = oism = 1 every octave is the same scale and amplitude, so if
    // the seed did NOT advance, two octaves would be exactly twice one. It does
    // advance, so it is not.
    expect(at(2)).not.toBe(at(1));
  });
});
