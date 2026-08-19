import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-spawn.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { makeVulcanusSpawn } from "../src/noise/expressions/vulcanusSpawn";

describe("makeVulcanusSpawn", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const positions = fixture.positions;

  it("vulcanus_starting_area matches the oracle to the f32 floor", () => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const got = spawn.startingArea(p.x, p.y);
      const want = fixture.startingArea[i];
      worst = Math.max(worst, Math.abs(got - want));
    }
    // Measured worst 2.03e-6 over the 410-point grid spanning spawn.
    expect(worst).toBeLessThan(1e-4);
  });

  it("vulcanus_starting_circle matches the oracle to the f32 floor", () => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const got = spawn.startingCircle(p.x, p.y);
      const want = fixture.startingCircle[i];
      worst = Math.max(worst, Math.abs(got - want));
    }
    // Measured worst 1.17e-6 (pure arithmetic over `distance`, no noise).
    expect(worst).toBeLessThan(1e-4);
  });

  it("vulcanus_ashlands_start matches the oracle to the f32 floor", () => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const got = spawn.ashlandsStart(p.x, p.y);
      const want = fixture.ashlandsStart[i];
      worst = Math.max(worst, Math.abs(got - want));
    }
    // Measured worst 4.26e-6 over the 410-point grid spanning spawn.
    expect(worst).toBeLessThan(1e-4);
  });

  it("computes starting_direction and ashlands_angle from the seed vars", () => {
    // Cross-check against the ctx's own seed-derived free vars (Task 2), not a
    // hand-picked number - this is the exact expression the game uses.
    //
    // **The three angles are narrowed to f32 per operation** (#279), the same
    // as every other term feeding `startingSpotAtAngle`. Written out here rather
    // than as `f32(...)` around the old expression, so this stays a statement of
    // what the game computes instead of a copy of the implementation - the
    // arithmetic and its ORDER are the part being pinned.
    const f = Math.fround;
    expect(spawn.startingDirection).toBe(-1 + 2 * (ctx.mapSeedSmall & 1));
    expect(spawn.ashlandsAngle).toBe(f(ctx.mapSeedNormalized * 3600));
    expect(spawn.mountainsAngle).toBe(f(spawn.ashlandsAngle + f(120 * spawn.startingDirection)));
    expect(spawn.basaltsAngle).toBe(f(spawn.ashlandsAngle + f(240 * spawn.startingDirection)));
    // **At THIS seed the narrowing is the identity**, and that was measured
    // rather than assumed: an anti-vacuity assertion that the narrowed and
    // un-narrowed forms differ FAILS here, because `mapSeedNormalized * 3600`
    // already lands on an f32 for seed 123456. So these three assertions cannot
    // see #279's change, and nothing here should be read as covering it.
    //
    // Where it IS observable is Fulgora's two starting cones, which went 83/101
    // and 85/101 to 101/101 at a residual of exactly 0, and the four Vulcanus
    // starting-spot fields in `vulcanusResources.spec.ts`, which are scored by
    // exact match count for this reason. The narrowing is written here anyway,
    // because the next seed is not promised to be this lucky.
  });
});
