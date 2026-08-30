import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-resource-starting.seed123456.json";
import { countOffGrid } from "./captureGrid";

// This fixture samples both the near-spawn starting patches (the feature under
// test) AND the pre-existing far field (d=1500-2500), at large fractional
// coordinates.
//
// That far field used to measure "absolute error up to ~5.3 on field values of
// ~10,000", attributed to "the inherent f32 (single-precision) coordinate-precision
// floor". It was not a precision floor. 22 of these 3745 positions were CAPTURED
// off the game's 1/256 MapPosition grid, so the game evaluated at a different
// point than the fixture records (#186). Snapping the sample coordinate the way
// the game does (test/captureGrid.ts) takes the worst absolute error from
// 4.899 / 4.340 / 5.270 / 4.673 across the four cases to 0.641 / 0.388 / 0.626 /
// 0.376 - and in all four the post-snap worst equals the on-grid-only worst to
// every digit, so the off-grid excess is gone rather than merely smaller.
//
// What remains is a systematic ~0.61 offset present at EVERY point, on-grid ones
// included, on field values near -12,300. That is a real and separate accuracy
// question, invisible to exact-match scoring (0 of 14,980 values match bit-for-bit
// before or after). ABS_TOL is now 0.7 rather than 1.0 - enough for that offset and
// nothing more.
//
// A single f32 noise field spanning ~[-14000, +thousands] needs a COMBINED
// tolerance: an absolute floor for small-magnitude values (catches real bugs
// near zero, where relative error is meaningless) and a relative gate for
// large-magnitude values (accommodates the f32 floor without masking real
// errors). A point only fails if it violates BOTH gates. See
// docs/noise/random-penalty-NOTES.md and the M1 elevation f32-floor precedent
// for the same pattern. regularPatches.spec (M3a) still owns the strict,
// unrelaxed check on the unchanged regular field alone.

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-resource-starting still has off-grid positions", () => {
    expect(countOffGrid(fixture.positions)).toBe(22);
  });
});
