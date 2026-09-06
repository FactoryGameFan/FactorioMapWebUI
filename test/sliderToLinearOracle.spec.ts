import { describe, expect, it } from "vite-plus/test";
import { sliderToLinear } from "../src/noise/eval/math";
import fixture from "./fixtures/oracle-slider-to-linear.seed123456.json";

/**
 * Grades `slider_to_linear` against the game's own answers, and settles #324.
 *
 * The fixture is `scripts/probes/cliff-slider-to-linear` run against Factorio
 * 2.1.17. The probe registers `slider_to_linear(x, lo, hi)` as the elevation
 * property, so the capture positions ARE the slider positions and `y` picks the
 * range - which means these are the noise machine's own values, not a GUI
 * helper's. `slider_to_linear` is a `type = "noise-function"`
 * (`core/prototypes/noise-functions.lua:10`), so it is inlined into its callers
 * and evaluated by the machine; the cliff gate calls it at
 * `noise-programs.lua:358`.
 *
 * **Scored by EXACT match, not a tolerance.** The game's values are f32 and so
 * are ours, so equality is the honest comparison and a bound would only hide
 * which candidate is right - the whole disagreement here is at the 1e-7 level
 * that any reasonable tolerance would pass. See `docs/rust-wasm-port.md` on
 * reading an exact count.
 *
 * **The RANGE is what discriminates, not the slider.** Only `(-1.7, 1.7)` has
 * bounds that are not exactly representable in f32, and it is the only such
 * range in the whole of `factorio-data`. On every other range, narrowing the
 * bounds is a no-op - which is exactly why this went unseen for so long, since
 * `fulgora_grid`'s `(-50, 50)` was the range every earlier measurement used.
 */

const f = Math.fround;

/** What `src/noise/eval/math.ts` did BEFORE #324: every operation narrowed, the bounds not. */
const withoutBoundsNarrowing = (s: number, lo: number, hi: number): number => {
  const ratio = f(f(Math.log2(s)) / f(Math.log2(6)));
  return f(lo + f(f(0.5 * f(hi - lo)) * f(1 + ratio)));
};

/** What `src/noise/cliffs/cliffCatalog.ts` did before #324 deleted it: all f64. */
const plainF64 = (s: number, lo: number, hi: number): number =>
  lo + 0.5 * (hi - lo) * (1 + Math.log2(s) / Math.log2(6));

const RANGES = [
  { key: "narrow", lo: -1, hi: 1, boundsExactInF32: true },
  { key: "wide", lo: -1.7, hi: 1.7, boundsExactInF32: false },
  { key: "fulgora", lo: -50, hi: 50, boundsExactInF32: true },
] as const;

const gameValues = (key: (typeof RANGES)[number]["key"]): number[] =>
  fixture[key] as unknown as number[];

const countExact = (
  impl: (s: number, lo: number, hi: number) => number,
  { key, lo, hi }: (typeof RANGES)[number],
): number => fixture.sliders.filter((s, i) => impl(s, lo, hi) === gameValues(key)[i]).length;

describe("slider_to_linear against the game (#324)", () => {
  it("the fixture is the shape the probe wrote, so a silent truncation cannot pass", () => {
    expect(fixture.sliders).toHaveLength(13);
    for (const { key, lo, hi } of RANGES) {
      expect(gameValues(key)).toHaveLength(13);
      expect(fixture.ranges[key]).toEqual([lo, hi]);
    }
    // The bound claim the whole finding rests on: exactly one range has bounds
    // that f32 cannot hold exactly.
    expect(RANGES.filter((r) => !r.boundsExactInF32).map((r) => r.key)).toEqual(["wide"]);
    for (const { lo, hi, boundsExactInF32 } of RANGES) {
      expect(f(lo) === lo && f(hi) === hi).toBe(boundsExactInF32);
    }
  });

  it("the shipped implementation matches the game exactly at all 39 points", () => {
    for (const range of RANGES) {
      expect(countExact(sliderToLinear, range)).toBe(13);
    }
  });

  /**
   * The controls. Both are cells where every candidate must agree, so they
   * cannot discriminate the hypothesis and are free to fail on their own. If
   * these break, the capture is not measuring `slider_to_linear` and no count
   * above may be read.
   */
  it("controls: s = 6 lands on hi and s = 1 on the midpoint of an f32-exact range", () => {
    const at = (key: (typeof RANGES)[number]["key"], s: number) =>
      gameValues(key)[fixture.sliders.indexOf(s)];
    expect(at("narrow", 6)).toBe(1);
    expect(at("fulgora", 6)).toBe(50);
    expect(at("wide", 6)).toBe(f(1.7));
    expect(at("narrow", 1)).toBe(0);
    expect(at("fulgora", 1)).toBe(0);
  });

  /**
   * The anti-vacuity half. A test that only asserts the shipped form is right
   * cannot show that the assertion is capable of failing, and both of these
   * WERE the shipped behaviour until #324.
   */
  it("both rejected forms score strictly worse, and only the non-dyadic range says so", () => {
    const narrowing = RANGES.map((r) => countExact(withoutBoundsNarrowing, r));
    // Identical to the shipped form wherever the bounds are f32-exact...
    expect(narrowing[0]).toBe(13);
    expect(narrowing[2]).toBe(13);
    // ...and wrong on 8 of 13 where they are not.
    expect(narrowing[1]).toBe(5);

    const f64 = RANGES.map((r) => countExact(plainF64, r));
    expect(f64).toEqual([2, 1, 2]);
    // It fails a control outright: at s = 6 it returns 1.7, the game f32(1.7).
    expect(plainF64(6, -1.7, 1.7)).not.toBe(gameValues("wide")[fixture.sliders.indexOf(6)]);
  });

  it("s = 1 on (-1.7, 1.7) is the sharpest single point: exactly 0 against 4.77e-8", () => {
    const i = fixture.sliders.indexOf(1);
    expect(gameValues("wide")[i]).toBe(0);
    expect(sliderToLinear(1, -1.7, 1.7)).toBe(0);
    // No tolerance is needed to tell these apart.
    expect(withoutBoundsNarrowing(1, -1.7, 1.7)).toBeCloseTo(4.7683716530855236e-8, 15);
    expect(withoutBoundsNarrowing(1, -1.7, 1.7)).not.toBe(0);
  });
});
