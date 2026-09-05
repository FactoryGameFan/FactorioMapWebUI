import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { expectFrozen, expectRecordedRows, flushRecording } from "./tier2Frozen";

/** Its own section - see `tier2Frozen.ts`; each spec declares its own row count. */
const PLANET = "primitives:eval";

afterAll(flushRecording);

/**
 * Every row this spec records, declared once so a partial record run cannot
 * pass its own count check. See `expectRecordedRows` in `tier2Frozen.ts`.
 *
 * 6 pow branches (five exponents plus cbrt) + 3 sliderToLinear ranges
 * + 2 sliderRescale exponents + 1 seed-var sweep + 1 eval-math sweep
 * + 3 memo pipeline cases.
 */
expectRecordedRows(PLANET, 16);

import { clamp, lerp, max, min, sliderRescale, sliderToLinear } from "../src/noise/eval/math";
import { seedNormalized, seedSmall } from "../src/noise/expressions/vulcanusSeed";

/**
 * Tier 2 of the Rust port's gate for the `eval` layer (#221): strict bit
 * equality between the two ports, folded order-sensitively over a sweep.
 *
 * **It detects divergence; it does not establish correctness.** Both ports
 * could agree and both be wrong. Correctness is tier 1 - the oracle fixtures,
 * which each port is graded against separately, both reading the same files.
 *
 * One block here carries more weight than the others. `sliderRescale` and
 * `sliderToLinear` are the only place in the whole port where both sides call a
 * libm transcendental (`log2`, `2^x`) rather than arithmetic the ISA specifies
 * exactly - V8's on this side, whatever `wasm32-unknown-unknown` compiles in on
 * the other. Tier 1 grades them at seven probe points; this sweeps hundreds. A
 * disagreement between the two libms would surface here and nowhere else.
 */
const wasmPath = join(import.meta.dirname, "..", "src", "noise", "wasm", "engine.wasm");

interface EngineExports {
  memory: WebAssembly.Memory;
  checksum_pow: (exponent: number, useCbrt: number, x0: number, step: number, n: number) => bigint;
  checksum_slider: (
    kind: number,
    s0: number,
    ds: number,
    n: number,
    a: number,
    b: number,
  ) => bigint;
  checksum_seed_vars: (seedStart: number, stride: number, n: number) => bigint;
  checksum_eval_math: (x0: number, step: number, n: number) => bigint;
  checksum_eval_pipeline: (
    seed0: number,
    seed1: number,
    inputScale: number,
    outputScale: number,
    offsetX: number,
    dx: number,
    dy: number,
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

/**
 * `noiseMachinePow` went with `quickMultioctaveNoise.ts` in #227, so the five
 * exponent rows are graded against the frozen table alone - `tier2Frozen.ts`
 * explains why that is still worth running inside `wasm32-unknown-unknown`.
 * `fastCbrt` went with `fastApprox.ts` in #371, so its row is frozen-only too.
 */
describe("The noise machine's `^` folds to its frozen checksums", () => {
  // Bases stay positive - `fastLog2` of a non-positive base is not a value
  // either port promises anything about. The step is not a binary fraction, so
  // the sweep does not sit on values where every candidate agrees.
  const X0 = 0.37;
  const STEP = 0.911;
  const N = 400;

  it("folds 400 bases to the frozen checksum for each of the three branches, plus fastCbrt", async () => {
    const engine = await instantiate();

    // 2.5 takes fastapprox, 0.5 takes the exact sqrt, 2 and 7 take exponentiation
    // by squaring. All four go through the same dispatcher on both sides, so a
    // branch chosen differently moves the checksum.
    for (const exponent of [2.5, 0.5, 2, 7, 0.25]) {
      expectFrozen(
        PLANET,
        `pow exponent=${exponent}`,
        "checksum_pow",
        u64(engine.checksum_pow(exponent, 0, X0, STEP, N)),
      );
    }

    // And the cube root separately, so `ONE_THIRD_F32` is inside the comparison
    // rather than beside it.
    expectFrozen(PLANET, "pow cbrt", "checksum_pow", u64(engine.checksum_pow(0, 1, X0, STEP, N)));
  });

  it("would not agree if a branch were chosen differently", async () => {
    // Anti-vacuity for the block above: the three branches really do return
    // different numbers, so folding them cannot coincide. Without this, an
    // exponent where all three agreed would make the test above vacuous.
    //
    // Asked of the engine since #227 deleted the TypeScript arm. It is the same
    // claim, made about the side that is still running.
    //
    // The exponent that leaves the squaring branch is ONE f32 ULP past 2, not
    // the 2.0000001 the TypeScript arm was handed. `checksum_pow` takes its
    // exponent as an `f32` (`crates/fmw-wasm/src/lib.rs`), so 2.0000001
    // narrows to exactly 2 at the boundary and picks squaring after all.
    // Measured: written with 2.0000001 this test failed, both folds equal.
    const justPastTwo = 2 + 2 ** -22;
    expect(Math.fround(justPastTwo), "the perturbation must survive the f32 boundary").not.toBe(2);

    const engine = await instantiate();
    const squaring = u64(engine.checksum_pow(2, 0, X0, STEP, N));
    const viaFastapprox = u64(engine.checksum_pow(justPastTwo, 0, X0, STEP, N));
    const viaSqrt = u64(engine.checksum_pow(0.5, 0, X0, STEP, N));
    expect(squaring).not.toBe(viaFastapprox);
    expect(squaring).not.toBe(viaSqrt);
  });
});

describe("Rust and TypeScript agree bit for bit on the slider functions", () => {
  // The sweep starts just above zero and crosses the whole usable slider range,
  // including the exact notches (1, 6) and a long tail of values between them.
  const S0 = 0.05;
  const DS = 0.0137;
  const N = 600;

  const sliders = (): number[] => Array.from({ length: N }, (_, i) => S0 + i * DS);

  it("folds 600 slider positions identically for sliderToLinear", async () => {
    let linearRows = 0;
    const engine = await instantiate();
    const ss = sliders();
    // Three ranges, including the asymmetric one fulgora_grid uses and the tiny
    // one moisture_nauvis uses, since `lo`/`hi` reach the arithmetic directly.
    for (const [lo, hi] of [
      [-50, 50],
      [-0.5, 0.5],
      [-1.7, 1.7],
    ]) {
      expectFrozen(
        PLANET,
        `slider linear [${lo}, ${hi}]`,
        "checksum_slider",
        u64(engine.checksum_slider(0, S0, DS, N, lo, hi)),
        foldAll(ss.map((s) => sliderToLinear(s, lo, hi))),
      );
      linearRows++;
    }
    // The planet's total is declared once at module scope, so this block keeps
    // its own count locally: a range dropped from the table above would leave
    // the total short at flush time, which names the planet rather than the
    // block that lost a case.
    expect(linearRows).toBe(3);
  });

  it("folds 600 slider positions identically for the per-operation sliderRescale", async () => {
    let rescaleRows = 0;
    const engine = await instantiate();
    const ss = sliders();
    for (const n of [2, 3]) {
      expectFrozen(
        PLANET,
        `slider rescale n=${n}`,
        "checksum_slider",
        u64(engine.checksum_slider(1, S0, DS, N, n, 0)),
        foldAll(ss.map((s) => sliderRescale(s, n))),
      );
      rescaleRows++;
    }
    expect(rescaleRows).toBe(2);
  });

  /**
   * **A third form used to ship, it did NOT agree between the ports, and it is
   * now deleted** (#270, resolved).
   *
   * `src/noise/eval/sliderRescale.ts` rounded the whole chain once at the end
   * instead of per operation, and four Vulcanus fields plus Nauvis rock size
   * read it. Over the same 600 positions:
   *
   * | form | agreement, n = 2 and n = 3 |
   * | --- | --- |
   * | `sliderToLinear` (per-op f32) | 600 / 600 |
   * | `sliderRescale` (per-op f32) | 600 / 600 |
   * | the rounded-once form | **599 / 600** |
   *
   * One position each: `s = 3.5435` at `n = 2`, `s = 6.3657` at `n = 3`.
   * **Native Rust agrees with V8 exactly at both** - same bits, checked
   * directly - so the difference belonged to the `wasm32-unknown-unknown` libm,
   * not to Rust. `cargo test` on the host cannot see it; only a spec that runs
   * the WASM can. That is the durable lesson here: anything new that reaches a
   * transcendental needs a sweep like this one, not just a fixture.
   *
   * The two per-op forms survive because they narrow every intermediate to f32,
   * and one ULP of f64 is about 29 bits below what survives that. The f64 form
   * had no narrowing to absorb it.
   *
   * It was not fixed by keeping it out of the WASM boundary, because the oracle
   * says it was also the form that disagreed with the GAME - it misses two of
   * the seven probe positions the per-operation form matches. So every caller
   * moved onto the per-operation form and the second implementation is gone;
   * see `test/sliderRescale.spec.ts`.
   *
   * This test keeps the reason recorded and executable. The deleted form lives
   * here now, as a control: without it, "the shipped form folds identically"
   * above could pass for a version that had never been at risk.
   */
  it("the deleted rounded-once form really was a different function", () => {
    const roundedOnce = (v: number, n: number): number =>
      v === 1 ? 1 : 2 ** ((Math.log2(v) / Math.log2(6)) * Math.log2(n));
    const ss = sliders();
    // It really is a different function - otherwise deleting it would have
    // changed nothing and this whole issue was noise.
    expect(foldAll(ss.map((s) => sliderRescale(s, 2)))).not.toBe(
      foldAll(ss.map((s) => roundedOnce(s, 2))),
    );
    // And the exact positions the libm divergence was measured at still behave
    // the way the table says on this side, which is what left room for the two
    // libms to disagree there in the first place.
    for (const [s, n] of [
      [3.5435, 2],
      [6.3657, 3],
    ] as const) {
      expect(roundedOnce(s, n)).not.toBe(sliderRescale(s, n));
    }
  });
});

describe("Rust and TypeScript agree bit for bit on the engine seed variables", () => {
  it("folds 512 seeds identically, including the wrap past 2^32", async () => {
    const engine = await instantiate();
    // A stride that is not a power of two, from a start that puts the sweep
    // over the top of the range - so `seedNormalized` reaches the value where
    // the f32 narrowing gives exactly 1 and plain division does not.
    const START = 0xffff0000;
    const STRIDE = 8_388_617;
    const N = 512;

    const values: number[] = [];
    let seed = START;
    for (let i = 0; i < N; i++) {
      values.push(seedNormalized(seed), seedSmall(seed));
      seed = (seed + STRIDE) >>> 0;
    }
    expectFrozen(
      PLANET,
      "seed vars wrapping",
      "checksum_seed_vars",
      u64(engine.checksum_seed_vars(START, STRIDE, N)),
      foldAll(values),
    );
  });

  it("the sweep really does reach the top of the range", () => {
    // Anti-vacuity for the wrap: without a seed at or near 0xFFFFFFFF the fold
    // above would never exercise the one value that discriminates f32 narrowing
    // from f64 division.
    expect(seedNormalized(0xffffffff)).toBe(1);
    expect(0xffffffff / 2 ** 32).not.toBe(1);
  });
});

describe("Rust and TypeScript agree bit for bit on the DSL math operators", () => {
  it("folds clamp, lerp, min and max identically over 500 points", async () => {
    const engine = await instantiate();
    const X0 = -2.75;
    const STEP = 0.011;
    const N = 500;

    const values: number[] = [];
    for (let i = 0; i < N; i++) {
      const x = X0 + i * STEP;
      values.push(clamp(x, -1, 1), lerp(-3, 7, x), min(x, -x, 0.5, -0), max(x, -x, 0.5, -0));
    }
    expectFrozen(
      PLANET,
      "eval math",
      "checksum_eval_math",
      u64(engine.checksum_eval_math(X0, STEP, N)),
      foldAll(values),
    );
  });

  it("the sweep crosses both clamp bounds and the signed zero, so it is not one branch", () => {
    // Anti-vacuity: a sweep that stayed inside [-1, 1] would make `clamp` the
    // identity and the fold would not test it.
    const X0 = -2.75;
    const STEP = 0.011;
    const N = 500;
    let belowLo = 0;
    let aboveHi = 0;
    let signedZero = 0;
    for (let i = 0; i < N; i++) {
      const x = X0 + i * STEP;
      if (x < -1) belowLo++;
      if (x > 1) aboveHi++;
      if (Object.is(min(x, -x, 0.5, -0), -0)) signedZero++;
    }
    expect(belowLo).toBeGreaterThan(50);
    expect(aboveHi).toBeGreaterThan(50);
    expect(signedZero).toBeGreaterThan(0);
  });

  it("min and max propagate NaN, which is why they are not f64::min and f64::max", () => {
    // NaN is deliberately NOT in the fold - it has many bit patterns, and
    // folding raw bits would compare the two engines' choice of payload rather
    // than the operator. Both sides assert the rule directly instead; the Rust
    // half is `min_and_max_propagate_nan_where_f64_min_would_discard_it`.
    expect(min(1, NaN, 2)).toBeNaN();
    expect(max(1, NaN, 2)).toBeNaN();
  });
});

describe("the composed eval pipeline folds to its frozen checksums", () => {
  // Whole-number step, so coordinates stay integral and `memoRegion` caches
  // rather than bypassing. A fractional step would silently turn the reverse
  // pass into fresh evaluations and this test would still pass, proving nothing
  // about the cache.
  const X0 = -37;
  const Y0 = 91;
  const STEP = 3;
  const N = 24;

  interface PipelineCase {
    readonly seed0: number;
    readonly seed1: number;
    readonly inputScale: number;
    readonly outputScale: number;
    readonly offsetX: number;
    readonly dx: number;
    readonly dy: number;
  }

  // The three shapes real callers use: elevation_lakes' finish_elevation term,
  // nauvis_shared's cliff_level, and vulcanus_elevation's mountain basis - the
  // last of which is the only one with a non-zero offset_x.
  const CASES: readonly PipelineCase[] = [
    { seed0: 123456, seed1: 123, inputScale: 1 / 8, outputScale: 1.5, offsetX: 0, dx: 0, dy: 0 },
    {
      seed0: 123456,
      seed1: 99584,
      inputScale: 1 / 500,
      outputScale: 0.6,
      offsetX: 0,
      dx: 1,
      dy: 0,
    },
    {
      seed0: 654321,
      seed1: 13423,
      inputScale: 1 / 500,
      outputScale: 250,
      offsetX: 10000,
      dx: 2,
      dy: -3,
    },
  ];

  it("folds 1,152 reads - two passes over 576 points - to the frozen checksum", async () => {
    const engine = await instantiate();
    for (const c of CASES) {
      expectFrozen(
        PLANET,
        `pipeline seed1=${c.seed1} dx=${c.dx} dy=${c.dy}`,
        "checksum_eval_pipeline",
        u64(
          engine.checksum_eval_pipeline(
            c.seed0,
            c.seed1,
            c.inputScale,
            c.outputScale,
            c.offsetX,
            c.dx,
            c.dy,
            X0,
            Y0,
            STEP,
            N,
          ),
        ),
      );
    }
  });

  // "the reverse pass is all cache hits" used to sit here. It counted
  // evaluations of the wrapped TypeScript function to prove the memos were
  // inside the comparison. That was a property of the TypeScript memo layer,
  // which #371 deleted; the Rust chain keeps no memo (see CLAUDE.md), so the
  // claim has nothing left to be about. The two-pass fold above still walks
  // the reverse pass, frozen.

  it("the offsets really move the sampled field, so a dx of 0 is not what is being compared", async () => {
    // Anti-vacuity for `dx`/`dy`: if the shift did nothing, the two shifted
    // cases would be indistinguishable from the unshifted one. Asked of the
    // engine since #371, which is the same claim about the side still running.
    const engine = await instantiate();
    const at = (c: PipelineCase): bigint =>
      u64(
        engine.checksum_eval_pipeline(
          c.seed0,
          c.seed1,
          c.inputScale,
          c.outputScale,
          c.offsetX,
          c.dx,
          c.dy,
          X0,
          Y0,
          STEP,
          N,
        ),
      );
    const [a, b] = [CASES[1] as PipelineCase, CASES[2] as PipelineCase];
    expect(at(a)).not.toBe(at({ ...a, dx: 0, dy: 0 }));
    expect(at(b)).not.toBe(at({ ...b, dx: 0, dy: 0 }));
  });
});
