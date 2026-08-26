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

  /**
   * **NOT a budget.** A hard assertion at the measured size would be a number to
   * widen every phase, which is the habit this repo has been burned by. It is a
   * tripwire for something UNINTENDED getting linked in.
   *
   * Its first form read "anything past 64 KB **before the noise math lands**",
   * and that premise expired rather than the tripwire being wrong: the noise
   * math is landing, which is the whole project. It fired at 70,189 bytes on
   * phase 3.
   *
   * | phase | bytes | what arrived |
   * | --- | ---: | --- |
   * | 0c (#219) | 599 | the boundary, empty |
   * | 1 (#220) | 50,193 | twelve primitives |
   * | 2 (#221) | 63,846 | the `eval` layer |
   * | 3 (#223) | 70,189 | Fulgora's landmask chain |
   * | 4-5 (#224, #225) | 84,171 | the rest of Fulgora, then Vulcanus to elevation |
   * | 5 (#225) | 138,642 | Vulcanus's resources, tiles and render path |
   *
   * **The one non-obvious contributor was measured, not guessed**: stubbing
   * `f64::log2` and `f64::powf` out of `eval/math.rs` and rebuilding gives
   * 65,030 bytes, so the libm those two pull in from `compiler_builtins` costs
   * **5,159 bytes**. #221's pull request said "most of" its 13,653-byte growth
   * was libm; that was an assumption and it was wrong - libm is 38% of it and
   * the rest is the ported code and its tier-2 exports.
   *
   * **It fired again at 138,642 on phase 5, and the growth was measured before
   * the ceiling moved** - which is the whole point of the instruction below, so
   * here is the measurement rather than an assurance:
   *
   * | build | bytes | delta |
   * | --- | ---: | ---: |
   * | phase 4 baseline | 84,171 | - |
   * | + ABI v2, Vulcanus sweep stubbed out | 86,243 | +2,072 |
   * | + the Vulcanus chain | 138,642 | +52,399 |
   *
   * The middle row is the method: stubbing the `render_vulcanus` arm of the
   * dispatch dead-code-eliminates the whole Vulcanus chain, so what is left is
   * the boundary change alone. **The per-planet request block cost 2,072 bytes
   * and the ported math cost 52,399**, which is the shape a phase of ported
   * expressions should have. Nothing unaccounted for got linked in.
   *
   * 256 KB keeps the same roughly 1.8x headroom over the current size that
   * 128 KB kept over phase 3's, which is the order of magnitude a stray
   * dependency or a panic-formatting path would add. Phase 6 is Nauvis and is
   * about the same size again by line count, so expect this to fire once more
   * and expect the same measurement to be taken.
   *
   * **It fired at 265,497 on phase 6, exactly as predicted, and the
   * measurement was taken before the ceiling moved.** Phase 6 landed in four
   * pieces, and the committed module after each is an exact delta needing no
   * interpretation:
   *
   * | build | bytes | delta |
   * | --- | ---: | ---: |
   * | phase 5 baseline (`fe5de8d`) | 178,531 | - |
   * | + the Nauvis expression core (#318) | 199,147 | +20,616 |
   * | + the tile catalog (#321) | 222,018 | +22,871 |
   * | + the resource layer (#322) | 255,189 | +33,171 |
   * | + the tree layer | 265,497 | +10,308 |
   *
   * And the stub-and-rebuild, which is what says nothing unaccounted for got
   * linked in: making `checksum_nauvis` return 0 unconditionally
   * dead-code-eliminates the whole Nauvis chain and gives **178,684 bytes**, so
   * the chain costs 86,813 and what is left sits **153 bytes** from the phase-5
   * baseline. That gap is the two extra `f64` arguments the export grew.
   *
   * **The first attempt at that stub was wrong, and the number it gave was the
   * tell.** `if seed0 !== 0 { return 0; }` cannot be proved dead - `seed0` is a
   * runtime argument - so nothing was eliminated and it "saved" 473 bytes. A
   * stub meant to dead-code-eliminate has to be unconditional. Same lesson as a
   * planted break that plants nothing.
   *
   * 512 KB keeps 1.97x headroom over 265,497, the same order the two previous
   * ceilings kept. `enemies/`, `rocks/rockField.ts`, `cliffs/cliffFields.ts`,
   * the Nauvis render path and tier 3 are still to come, so this has room for
   * them and should not fire again inside phase 6.
   *
   * If this fires again, measure what grew before moving it - the stub-and-
   * rebuild above is the method, and it takes a minute.
   */
  it("is small enough that the size trend stays worth watching", () => {
    const bytes = readFileSync(wasmPath).byteLength;
    expect(bytes).toBeLessThan(512 * 1024);
  });
});
