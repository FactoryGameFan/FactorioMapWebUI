import { describe, expect, it } from "vite-plus/test";
import rockDensityFixture from "./fixtures/oracle-rock-density.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { makeMultioctaveNoise } from "../src/noise/multioctaveNoise";
import { distanceFromNearestPoint } from "../src/noise/distanceFromNearestPoint";
import { ROCK_SEED1 } from "../src/noise/rocks/rockCatalog";

// Independently recompute max_i probability_i from the same primitives, so a
// wrong seed1, penalty, multiplier, or region_box band fails loudly. This is NOT
// the game oracle (that is Task 3) - it locks the wiring/composition.

// Reconstruct rock_density = rock_noise - max(0, 1.1 - distance/32) from the ported
// primitives and compare to the game. The absolute bound was 1e-3, described as
// accommodating "the known far-field basisNoise f32 floor". That floor was mostly
// the capture: 14 of these 26 positions were recorded off the game's 1/256
// MapPosition grid (#186). Snapping the sample coordinate the way the game does
// (test/captureGrid.ts) takes this from 8/26 exact at worst 1.570e-3 to 18/26 at
// worst 8.508e-8 - 18,455x, and ALL 14 off-grid rows become exact. Note the old
// bound only passed through its relative escape, since 1.570e-3 exceeded the
// 1e-3 absolute half; at 2e-7 the absolute half passes outright. Combined
// tolerance is still the same
// combined-tolerance PATTERN as the enemy/resource oracle specs, but with ABS_TOL
// scaled to this field's [-1,1] range (theirs is 1.0 for fields that run in the
// thousands, which would be a no-op gate here).
describe("rock_density vs oracle", () => {
  it("matches the game's rock_density named expression at seed 123456", () => {
    const seed0 = rockDensityFixture.seed0;
    const noise = makeMultioctaveNoise({
      seed0,
      seed1: ROCK_SEED1,
      octaves: 4,
      persistence: 0.9,
      inputScale: 0.15,
      outputScale: 1,
    });
    const spawn = [{ x: 0, y: 0 }];
    let worstAbs = 0;
    let worstRel = 0;
    for (let i = 0; i < rockDensityFixture.positions.length; i++) {
      const p = snapPosition(rockDensityFixture.positions[i]);
      const game = rockDensityFixture.values[i];
      const rockNoise = noise(p.x, p.y) + 0.25; // slider_rescale(1,1.5)=1 at default size
      const distance = distanceFromNearestPoint(p.x, p.y, spawn);
      const port = rockNoise - Math.max(0, 1.1 - distance / 32);
      const abs = Math.abs(port - game);
      const rel = abs / Math.max(1, Math.abs(game));
      if (abs > worstAbs) worstAbs = abs;
      if (rel > worstRel) worstRel = rel;
    }
    expect(worstAbs < 2e-7 || worstRel < 1e-2).toBe(true);
  });
});

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-rock-density still has off-grid positions", () => {
    expect(countOffGrid(rockDensityFixture.positions)).toBe(14);
  });
});
