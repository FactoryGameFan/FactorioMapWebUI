import { describe, expect, it } from "vite-plus/test";

import sweep from "./fixtures/oracle-vulcanus-cliff-fine-sweep.seed123456.json";
import { CLIFF_CODE_TO_ORIENTATION } from "../src/noise/cliffs/cliffCatalog";

/**
 * **What the game's grid-4 cliff elevation actually IS, per corner** (#84) - and
 * the measurement that **refutes the conclusion of `vulcanusCliffBands.spec.ts`.**
 *
 * That spec found the port's placement disagreeing with the game at
 * `[1500,1500]`'s high bands with the smoothing off, the gate a constant and the
 * repair ruled out, and concluded the remaining suspect had to be the FIELD -
 * the port's value sits a median 18.8 and a maximum 69.0 units from the level at
 * the disputed edges, so a field difference of that order would explain it. That
 * inference was sound about what it excluded and **wrong about what it implied**,
 * because it never measured the game's field; it only measured that *something*
 * differs.
 *
 * This does measure it. Sweeping `cliff_elevation_0` across `[700, 900]` step 5
 * under the same collapsed rule turns each placed cell into one-sided
 * constraints on its corners: a crossing edge at level `L` says "this corner
 * > L, that one < L", and its sign says which is which. Accumulated over 41
 * levels that brackets a corner to the step.
 *
 * **Only POSITIVE observations are used.** An absent cliff is ambiguous - the
 * lava and ore rejections drop whole cells - but a PRESENT crossing is not,
 * because `fixImpossibleCellsSweep` only ever writes `0` (verified line by line)
 * and so can delete a crossing but never invent one, and the rejections are
 * post-filters that never touch the edge registers.
 *
 * The verdict: **the port's grid-4 field is right.** 997 of 998 two-sided
 * brackets contain it, at a mean bracket width of 5.72, in the worst region -
 * and the one exception misses by **2.6e-5**, i.e. the port's value sits
 * essentially exactly ON a swept level, where `crossesCliff`'s strict test
 * yields no crossing and so no observation. That is the bracket's open endpoint,
 * not a field error. At the disputed-edge corners specifically, every bracketed
 * one contains the port's value.
 *
 * (Was 996 of 998 missing by 6.7e-4 until the `multioctave_noise` octave-offset
 * fix; that primitive feeds `cliff_elevation`, so tightening it by 164x moved one
 * borderline corner inside its bracket and shrank the remaining miss 26x. The
 * conclusion was already right - this only sharpens it.)
 *
 * So the field is exonerated by direct measurement, and #84's residual is
 * somewhere else. What the sweep also shows is where to look: the corners
 * involved in the crossings the game DROPS are systematically the ones it gives
 * no two-sided bracket for, i.e. the ones sitting where the game emits no
 * entities at all.
 */

const codeForOrientation = new Map<number, number>();
for (const [c, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
  codeForOrientation.set(id, Number(c));

/**
 * Per edge (L, R, T, B): the corner index offsets of `(a, b)` as `cross(a, b)`
 * saw them, so the crossing's SIGN can be read as "which corner is the high one".
 * `+1` is `a < boundary < b` and `-1` is `a > boundary > b`.
 */

/** Every one-sided constraint the game asserted, folded into per-corner brackets. */

describe("the game's grid-4 cliff elevation, measured per corner", () => {
  it("covers 700..900 step 5 with every override applied", () => {
    expect(sweep.cases.length).toBe(41);
    for (const c of sweep.cases) {
      expect(c.effective?.cliff_smoothing).toBe(0);
      expect(c.effective?.cliff_elevation_interval).toBe(1000000);
      expect(c.effective?.cliff_elevation_0).toBe(c.level);
    }
  });
});
