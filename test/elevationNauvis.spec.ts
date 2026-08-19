import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-elevation-nauvis.seed123456.json";
import noCliffFixture from "./fixtures/oracle-elevation-nauvis-no-cliff.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { makeElevationNauvis } from "../src/noise/expressions/elevationNauvis";

// Parity-test only where the game's own starting_lake_distance saturated at 1024;
// near spawn is asserted separately (computed starting lakes make it faithful too).
// (The fixture also carries a `distance` array as captured oracle context; the spec
// keys purely off startingLakeDistance and does not assert `distance` directly.)
const SATURATED = (i: number) => fixture.startingLakeDistance[i] >= 1024;

describe("elevationNauvis reproduces the game's elevation_nauvis tree", () => {
  const evalAt = makeElevationNauvis({ seed0: fixture.seed0 });

  it("has parity-testable far points (guards against a fixture regen dropping them)", () => {
    expect(fixture.positions.filter((_p, i) => SATURATED(i)).length).toBeGreaterThanOrEqual(12);
  });

  it("matches the water mask (elevation < 0) away from the coastline", () => {
    for (let i = 0; i < fixture.positions.length; i++) {
      if (!SATURATED(i)) continue;
      const exp = fixture.elevation[i];
      if (Math.abs(exp) < 1e-3) continue; // coastline: sign is ambiguous within the floor
      const s = snapPosition(fixture.positions[i]);
      expect(evalAt(s.x, s.y) < 0).toBe(exp < 0);
    }
  });

  it("matches the numeric elevation to the f32 coordinate floor (far field)", () => {
    let worst = 0;
    let worstLabel = "";
    for (let i = 0; i < fixture.positions.length; i++) {
      if (!SATURATED(i)) continue;
      const p = fixture.positions[i];
      const s = snapPosition(p);
      const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - fixture.elevation[i]);
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    // Was 8e-3, explained as "the pure f32-floor divergence" amplified ~20x by
    // elevation_magnitude, with the worst "~4.08e-3 (deep field)". Three parts of
    // that were wrong, and the first is the one that mattered:
    //
    // - The dominant cause was the CAPTURE, not the arithmetic. 14 of these 26
    //   positions were recorded off the game's 1/256 MapPosition grid, so the
    //   game sampled a different point (#186). Snapping them takes this set from
    //   2/17 exact at worst 3.922e-3 to 3/17 at worst 3.853e-4, a 10x drop.
    // - The worst was never at the deep-field point. (12345.75, 6789.125) is ON
    //   the 1/256 grid and measures 3.574e-7 here - the SMALLEST residual in the
    //   set. The worst sits on the r=3300 ring, which is off-grid.
    // - 4.08e-3 is stale; the tree measured 3.922e-3 before the snap.
    //
    // Calibrated just above the measured post-snap worst. A residual survives the
    // snap here and reaches on-grid rows too (on-grid worst 3.072e-4 against
    // off-grid 3.853e-4, the same order), so unlike temperature the snap is not
    // the whole story for this tree. That remainder is tracked in #255 - it is
    // NOT a reason to raise this bound. See `test/captureGrid.ts`.
    expect(worst, `worst ${worstLabel}`).toBeLessThan(4e-4);
  });

  it("matches near-spawn elevation too (computed starting lakes)", () => {
    let worst = 0;
    let worstLabel = "";
    let checked = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      if (SATURATED(i)) continue;
      const p = fixture.positions[i];
      const s = snapPosition(p);
      const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - fixture.elevation[i]);
      checked++;
      if (err > worst) {
        worst = err;
        worstLabel = `@(${p.x},${p.y})`;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6);
    // All 9 near-spawn positions are already ON the 1/256 grid, so the snap is
    // the identity here and this number is unchanged by it - the control that
    // says the snap only moved rows it should have. Measured worst 1.907e-6
    // (the comment's "~2.87e-6" predates the basisNoise f32 kernel). This band is
    // the ONE seam this tree adds beyond lakes: it exercises the computed
    // starting_lake_positions (startingLakes.ts), so a drift in the computed lake
    // positions trips it. The bound was 1e-4, ~52x the measured worst; it is now
    // calibrated to that worst, which makes the guard real.
    expect(worst, `worst ${worstLabel}`).toBeLessThan(2e-6);
  });
});

// elevation_nauvis_no_cliff = elevation_nauvis_function(added_cliff_elevation = 0) - the
// cliffiness field's dependency (Task 6 / cliff_elevation_nauvis). Same standard grid and
// the same bounds as the elevation_nauvis block above, for the same reasons: the sample
// coordinates are snapped onto the game's 1/256 MapPosition grid (see test/captureGrid.ts),
// which took the far set from 3.920e-3 to 3.834e-4 at seed 123456 and from 1.237e-3 to
// 3.090e-4 at seed 777771. Positions are identical between the two fixtures (same standard
// grid), which lets the structural check below index them 1:1.
describe("elevationNauvis(withCliffElevation:false) reproduces elevation_nauvis_no_cliff", () => {
  for (const c of noCliffFixture.cases) {
    const evalAt = makeElevationNauvis({ seed0: c.seed, withCliffElevation: false });
    const noCliffSaturated = (i: number) => c.startingLakeDistance[i] >= 1024;

    it(`matches the numeric elevation to the f32 coordinate floor (far field, seed=${c.seed})`, () => {
      let worst = 0;
      let worstLabel = "";
      for (let i = 0; i < noCliffFixture.positions.length; i++) {
        if (!noCliffSaturated(i)) continue;
        const p = noCliffFixture.positions[i];
        const s = snapPosition(p);
        const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - c.elevation[i]);
        if (err > worst) {
          worst = err;
          worstLabel = `@(${p.x},${p.y})`;
        }
      }
      expect(worst, `worst ${worstLabel}`).toBeLessThan(4e-4);
    });

    it(`matches near-spawn elevation too (computed starting lakes, seed=${c.seed})`, () => {
      let worst = 0;
      let worstLabel = "";
      let checked = 0;
      for (let i = 0; i < noCliffFixture.positions.length; i++) {
        if (noCliffSaturated(i)) continue;
        const p = noCliffFixture.positions[i];
        const s = snapPosition(p);
        const err = Math.abs(Math.fround(evalAt(s.x, s.y)) - c.elevation[i]);
        checked++;
        if (err > worst) {
          worst = err;
          worstLabel = `@(${p.x},${p.y})`;
        }
      }
      expect(checked).toBeGreaterThanOrEqual(6);
      expect(worst, `worst ${worstLabel}`).toBeLessThan(2e-6);
    });
  }

  it("differs from elevation_nauvis (with-cliff) where added_cliff_elevation != 0, and matches where the outer min() masks it", () => {
    // fixture (seed 123456, WITH cliff term) and noCliffFixture (seed 123456, no-cliff
    // term) share the exact same standard grid, so positions[i] line up 1:1. The final
    // elevation is min(wlc_elevation, starting_lake); wherever starting_lake wins,
    // added_cliff_elevation (which only feeds wlc_elevation) has no effect and the two
    // trees coincide even though the term itself is nonzero - hence "NOT assumed" that
    // no-cliff <= with-cliff, and this checks BOTH outcomes actually occur.
    expect(fixture.positions).toEqual(noCliffFixture.positions);
    const noCliff123456 = noCliffFixture.cases.find((c) => c.seed === fixture.seed0);
    expect(noCliff123456).toBeDefined();
    let numDiffer = 0;
    let numEqual = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      const withCliff = fixture.elevation[i];
      const noCliff = noCliff123456!.elevation[i];
      if (Math.abs(withCliff - noCliff) < 1e-6) {
        numEqual++;
      } else {
        numDiffer++;
      }
    }
    // Observed on the current fixture: 17 differ, 9 equal - both outcomes are real, not
    // an artifact of a too-small grid.
    expect(numDiffer).toBeGreaterThan(0);
    expect(numEqual).toBeGreaterThan(0);
  });
});

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-elevation-nauvis still has off-grid positions", () => {
    expect(countOffGrid(fixture.positions)).toBe(14);
  });
  it("oracle-elevation-nauvis-no-cliff still has off-grid positions", () => {
    expect(countOffGrid(noCliffFixture.positions)).toBe(14);
  });
});
