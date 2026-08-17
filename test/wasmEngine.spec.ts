import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = join(import.meta.dirname, "..");
const wasmPath = join(repoRoot, "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  scratch_ptr: () => number;
  scratch_len: () => number;
  fnv1a64: (len: number) => bigint;
  fold_f64: (acc: bigint, value: number) => bigint;
}

async function instantiate(): Promise<EngineExports> {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as EngineExports;
}

/**
 * A WASM `u64` arrives in JavaScript as a SIGNED BigInt: 0xcbf29ce484222325
 * comes back as -0x340d631b7bdddcdb, its two's complement. Measured against
 * this exact module in Node. No error is raised - the number is just wrong in a
 * way that looks like a broken checksum, so every u64 crossing goes through
 * here.
 */
const u64 = (x: bigint): bigint => BigInt.asUintN(64, x);

describe("the committed WASM engine", () => {
  it("agrees with the published FNV-1a 64 vectors", async () => {
    const engine = await instantiate();
    const ptr = engine.scratch_ptr();
    const hash = (s: string): bigint => {
      const bytes = new TextEncoder().encode(s);
      expect(bytes.length).toBeLessThanOrEqual(engine.scratch_len());
      new Uint8Array(engine.memory.buffer, ptr, bytes.length).set(bytes);
      return u64(engine.fnv1a64(bytes.length));
    };
    expect(hash("")).toBe(0xcbf29ce484222325n);
    expect(hash("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(hash("foobar")).toBe(0x85944171f73967e8n);
  });

  it("folds f64 results in an order-sensitive way", async () => {
    const engine = await instantiate();
    const a = u64(engine.fold_f64(u64(engine.fold_f64(0n, 1.5)), 2.5));
    const b = u64(engine.fold_f64(u64(engine.fold_f64(0n, 2.5)), 1.5));
    expect(a).not.toBe(b);
  });

  it("is small enough that the size trend stays worth watching", () => {
    // NOT a budget. A hard assertion at the measured size would be a number to
    // widen every phase, which is the habit this repo has been burned by. It is
    // a tripwire: phase 0c's module measures 599 bytes, so anything past 64 KB
    // before the noise math lands means something unintended got linked in.
    const bytes = readFileSync(wasmPath).byteLength;
    expect(bytes).toBeLessThan(64 * 1024);
  });
});
