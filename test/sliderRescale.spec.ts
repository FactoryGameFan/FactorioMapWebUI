import { describe, expect, it } from "vite-plus/test";

import elevationFixture from "./fixtures/oracle-fulgora-elevation.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { sliderRescale } from "../src/noise/eval/math";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { sliderRescale as sliderRescaleViaRocks } from "../src/noise/rocks/rockCatalog";

/**
 * `slider_rescale` had TWO implementations, and this spec is what stops it
 * growing a third (#270).
 *
 * `core/prototypes/noise-functions.lua:16` defines it as a **noise-function**,
 * not a Lua function - so the noise machine evaluates it, rounding every
 * operation to f32. `src/noise/eval/math.ts` does that. The other one, in
 * `src/noise/eval/sliderRescale.ts`, evaluated the whole chain in f64 and
 * rounded once at the end; it was read by four Vulcanus fields and by Nauvis
 * rock size, and it is now deleted.
 *
 * **The oracle says which one is the game's**, and that is the anchor for
 * everything below: at the seven probe positions in
 * `oracle-fulgora-elevation.seed123456.json` the per-operation form matches all
 * seven and the rounded-once form misses two. That is not a tie broken on
 * taste.
 *
 * ## What is covered by an assertion here, and what by the type checker
 *
 * Deleting `src/noise/eval/sliderRescale.ts` makes any missed call site a type
 * error, and `vp check` type-checks, so the compiler covers the call sites this
 * file cannot reach cheaply (`vulcanusResources.ts` holds its four values in
 * locals, `vulcanusBiomes.ts` folds its two into an unexported `volcanism`).
 * The two that ARE reachable get real assertions: `scaleMultiplier` is on the
 * `VulcanusHelpers` interface, and the rocks module re-exports the function
 * itself, so identity settles that side.
 *
 * ## Why the input space is 12 values, not a range
 *
 * `PERCENT_STEPS` in `src/model/controlScale.ts` is `Math.fround` of twelve
 * exact fractions, and those are the only slider settings a user can select.
 * Measured across them, the two forms return a different f64 at **10 of 12**
 * for every `n` that ships, and a different f32 at 3 of 12 for `n = 2`, 4 of 12
 * for `n = 3`, and **0 of 12** for `n = 1.5`. So the Nauvis rock change is
 * invisible at f32 granularity at every reachable setting - it is taken to
 * remove the second implementation, not to move a pixel.
 */

/** `Math.fround` of the twelve exact fractions in `src/model/controlScale.ts`. */
const STEPS = [1 / 6, 1 / 4, 1 / 3, 1 / 2, 3 / 4, 1, 4 / 3, 3 / 2, 2, 3, 4, 6].map(Math.fround);

/**
 * The deleted form, kept HERE rather than in `src/` because its only remaining
 * job is to be the control. Without it, "the shipped form matches the oracle"
 * could pass for a version that had never been at risk, and the reason the
 * other implementation was wrong would stop being recorded anywhere.
 */
function roundedOnce(v: number, n: number): number {
  if (v === 1) return 1;
  return 2 ** ((Math.log2(v) / Math.log2(6)) * Math.log2(n));
}

const probe = elevationFixture.sliderRescaleProbe as Record<string, number>;

describe("slider_rescale is the per-operation f32 form, everywhere (#270)", () => {
  it("matches the game at all seven probe positions, exactly", () => {
    const positions = Object.keys(probe);
    expect(positions.length).toBe(7);
    for (const s of positions) {
      expect(Math.fround(sliderRescale(Number(s), 2)), `s=${s}`).toBe(Math.fround(probe[s]));
    }
  });

  it("the rounded-once form misses the game at exactly two of those seven", () => {
    // The control. If this ever reports 0, the two forms have become the same
    // function and every other assertion in this file is vacuous.
    // Sorted numerically because the fixture's key order is the capture's, not
    // ours - it really does list 5 before 0.5.
    const missed = Object.keys(probe)
      .filter((s) => Math.fround(roundedOnce(Number(s), 2)) !== Math.fround(probe[s]))
      .map(Number)
      .sort((a, b) => a - b);
    expect(missed).toEqual([0.5, 5]);
  });

  it("the two forms really do disagree at the slider positions a user can pick", () => {
    // Second half of the control, on the input space that actually ships. A
    // raw-value disagreement is what the consumers below would see, since they
    // read the return value into f64 arithmetic without narrowing it.
    for (const n of [2, 3, 1.5]) {
      const differing = STEPS.filter((s) => sliderRescale(s, n) !== roundedOnce(s, n));
      expect(differing.length, `n=${n}`).toBe(10);
    }
  });

  it("makeVulcanusHelpers reads it, at every reachable volcanism setting", () => {
    for (const s of STEPS) {
      const helpers = makeVulcanusHelpers(
        withCtxDefaults({ seed0: 123456, vulcanusVolcanismFrequency: s }),
      );
      expect(helpers.scaleMultiplier, `volcanism frequency = ${s}`).toBe(sliderRescale(s, 3));
    }
  });

  it("the rocks module re-exports the one function rather than a second copy", () => {
    // Identity, not equality of results: two implementations that agree at the
    // default slider would pass a value comparison and still be two.
    expect(sliderRescaleViaRocks).toBe(sliderRescale);
  });

  it("keeps the endpoints the whole scale is defined by", () => {
    for (const n of [2, 3, 1.5]) {
      expect(sliderRescale(1, n), `n=${n}`).toBe(1);
      expect(sliderRescale(6, n), `n=${n}`).toBe(n);
    }
  });
});
