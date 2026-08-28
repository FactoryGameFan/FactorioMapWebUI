import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { expectFrozen, expectRecordedRows, flushRecording } from "./tier2Frozen";

/** Its own section - see `tier2Frozen.ts`; each spec declares its own row count. */
const PLANET = "primitives:basisNoise";

afterAll(flushRecording);

/**
 * Every row this spec records, declared once so a partial record run cannot
 * pass its own count check. See `expectRecordedRows` in `tier2Frozen.ts`.
 *
 * 1 default seed pair + 3 alternate seed pairs.
 */
expectRecordedRows(PLANET, 4);

import { basisNoise, basisNoiseTablesFromSeed } from "../src/noise/basisNoise";

/**
 * Tier 2 of the Rust port's gate: strict bit equality between the two ports
 * over a shared point grid, folded order-sensitively (#220).
 *
 * This runs in process against the committed `engine.wasm`, so there is no dump
 * binary, no intermediate file, and no way for the two sides to drift between a
 * capture and a comparison. It is also what keeps the wasm loading path
 * exercised from the first module rather than making it a late surprise.
 *
 * **It detects divergence; it does not establish correctness.** Both ports
 * could agree and both be wrong. Correctness is tier 1 - the oracle fixtures -
 * which each port is graded against separately: `test/basisNoise.spec.ts` here
 * and `crates/fmw-noise/src/fixtures.rs` there, both reading the same files.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  checksum_basis_noise: (
    seed0: number,
    seed1: number,
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

/**
 * The JavaScript half of `fmw_noise::checksum::fold_f64`.
 *
 * Folds RAW BITS, little-endian, and is order-sensitive. FNV-1a rather than the
 * spikes' XOR fold because XOR is blind to order and cancels pairs: swap two
 * points, or break two identically, and an XOR fold does not move.
 */
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

/** The same grid the Rust export walks: rows outer, columns inner. */
function foldTypeScript(
  seed0: number,
  seed1: number,
  x0: number,
  y0: number,
  step: number,
  n: number,
  perturbIndex = -1,
): bigint {
  const tables = basisNoiseTablesFromSeed(seed0, seed1);
  let acc = 0n;
  let k = 0;
  for (let j = 0; j < n; j++) {
    const y = y0 + j * step;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      let v = basisNoise(x, y, tables);
      if (k === perturbIndex) {
        // One ULP up, in f32, which is the smallest difference the two ports
        // could possibly have.
        const buf = new Float32Array(1);
        const bits = new Uint32Array(buf.buffer);
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

const SEED0 = 123456;
const SEED1 = 0;
// Offsets deliberately off the lattice and a step that is not a simple binary
// fraction, so the grid walks many cells and few points land on the exact
// lattice zeros the kernel returns there.
const X0 = -3.5;
const Y0 = 7.25;
const STEP = 0.37;
const N = 64;

describe("Rust and TypeScript basisNoise agree bit for bit", () => {
  it("folds 4,096 grid points to the identical checksum", async () => {
    const engine = await instantiate();
    const fromWasm = u64(engine.checksum_basis_noise(SEED0, SEED1, X0, Y0, STEP, N));
    const fromTs = foldTypeScript(SEED0, SEED1, X0, Y0, STEP, N);

    // Strict equality on a fold of raw bits. Not a tolerance: the two ports
    // must produce the SAME f32 at every one of the 4,096 points.
    expectFrozen(PLANET, "default seed pair", "checksum_basis_noise", fromWasm, fromTs);
  });

  it("would notice a single point differing by one ULP", async () => {
    // The anti-vacuity check for THIS test. A fold that ignored its input, or a
    // comparison that compared something to itself, would pass the test above
    // and catch nothing. Here the TypeScript side is bent at one of 4,096
    // points and the checksums must part.
    const engine = await instantiate();
    const fromWasm = u64(engine.checksum_basis_noise(SEED0, SEED1, X0, Y0, STEP, N));
    const bent = foldTypeScript(SEED0, SEED1, X0, Y0, STEP, N, 1234);
    expect(bent).not.toBe(fromWasm);
  });

  it("agrees on a second seed, so the seed plumbing is graded too", async () => {
    // seed1 is what distinguishes the many basis_noise calls a map-gen program
    // makes, and its LOW BYTE is deliberately not in the taus88 seed word - it
    // picks the salt instead. A port that dropped either would still pass the
    // first test above, which uses seed1 = 0.
    const engine = await instantiate();
    for (const [s0, s1] of [
      [654321, 7],
      [424242, 260],
      [1, 0],
    ] as const) {
      const fromWasm = u64(engine.checksum_basis_noise(s0, s1, X0, Y0, STEP, N));
      expectFrozen(
        PLANET,
        `seeds ${s0}/${s1}`,
        "checksum_basis_noise",
        fromWasm,
        foldTypeScript(s0, s1, X0, Y0, STEP, N),
      );
    }
  });

  it("returns a different checksum for a different seed - but NOT for bit 0", async () => {
    // Guards the shape where the export ignores its arguments entirely.
    const engine = await instantiate();
    const at = (s0: number): bigint => u64(engine.checksum_basis_noise(s0, SEED1, X0, Y0, STEP, N));

    expect(at(SEED0)).not.toBe(at(SEED0 + 2));

    // And seed0's LOW BIT is dead, which is not a bug and is easy to write a
    // wrong test against - this one was written as `SEED0 + 1` first and failed
    // for exactly this reason. The taus88 state words drop their low bits on
    // the first step, so 123456 and 123457 are the same field. The port
    // reproduces that rather than smoothing it over.
    expect(at(SEED0)).toBe(at(SEED0 + 1));

    // The same mechanism at the bottom of the range: every seed below the
    // 0x155 clamp collapses onto one field. Asserted on the Rust side too
    // (`the_seed_word_is_clamped_from_below`); here it crosses the boundary.
    expect(at(0)).toBe(at(340));
    expect(at(0)).not.toBe(at(0x156));
  });
});
