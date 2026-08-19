import { describe, expect, it } from "vite-plus/test";

import lakesFixture from "./fixtures/oracle-elevation-lakes.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { distanceFromNearestPoint, type Point } from "../src/noise/distanceFromNearestPoint";

// This primitive is plain geometry read off the disassembly
// (DistanceFromNearestPoint::run @0x101759568); the noise DSL rejects a literal
// `points` list, so the cases below are verified against the closed-form distance.
// The game-captured block at the bottom of this file is the oracle check.
describe("distanceFromNearestPoint reproduces the game's geometry", () => {
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 0, y: 40 },
    { x: -50, y: 30 },
  ];

  it("returns the Euclidean distance to the nearest point", () => {
    // Right on a point.
    expect(distanceFromNearestPoint(0, 0, points, 1024)).toBe(0);
    // Between origin and (40,0): closest is origin at distance 10.
    expect(distanceFromNearestPoint(10, 0, points, 1024)).toBeCloseTo(10, 10);
    // (36,0): closest is (40,0) at distance 4.
    expect(distanceFromNearestPoint(36, 0, points, 1024)).toBeCloseTo(4, 10);
    // A 3-4-5 triangle from (0,40): (3,44) -> distance 5.
    expect(distanceFromNearestPoint(3, 44, points, 1024)).toBeCloseTo(5, 10);
  });

  it("caps the result at maximumDistance", () => {
    // Far from every point; capped.
    expect(distanceFromNearestPoint(100000, 100000, points, 1024)).toBe(1024);
    // Exactly at the cap distance stays capped (bestSq == maxSq -> maximumDistance).
    expect(distanceFromNearestPoint(1024, 0, [{ x: 0, y: 0 }], 1024)).toBe(1024);
    // Just inside the cap returns the true distance.
    expect(distanceFromNearestPoint(1000, 0, [{ x: 0, y: 0 }], 1024)).toBeCloseTo(1000, 10);
  });

  it("with no points returns maximumDistance (Infinity by default)", () => {
    expect(distanceFromNearestPoint(5, 5, [], 1024)).toBe(1024);
    expect(distanceFromNearestPoint(5, 5, [])).toBe(Infinity);
  });

  it("quantises points to 1/256 fixed-point (a no-op for integer positions)", () => {
    // A tiny sub-1/256 offset snaps to the nearest grid point; 0.001 < 0.5/256 so it
    // rounds to 0 -> distance 0 (avoids the exact-half tie, whose rounding is unknown).
    expect(distanceFromNearestPoint(0, 0, [{ x: 0.001, y: 0 }])).toBe(0);
    // An exact 1/256 multiple is preserved.
    expect(distanceFromNearestPoint(0, 0, [{ x: 1 / 256, y: 0 }])).toBeCloseTo(1 / 256, 12);
    // Integer positions are untouched.
    expect(distanceFromNearestPoint(0, 0, [{ x: 7, y: 0 }])).toBeCloseTo(7, 12);
  });
});

// The `distance` array in oracle-elevation-lakes is 26 values of
// `distance_from_nearest_point{x = x, y = y, points = starting_positions}`
// captured straight from the game (test/oracle/capture.ts, `captureElevationLakes`).
// Until 2026-08-18 NO spec read it - `grep -rn "\.distance\[" test/` returned
// nothing - so this primitive had no test pinned against game output at all, only
// against arithmetic anyone can do on paper. That gap is #258.
//
// It scores 26/26 exact at worst residual 0, but only with the sample coordinate
// snapped onto the game's 1/256 MapPosition grid: 14 of the 26 positions were
// captured off it (#186), and without the snap this is 18/26 at worst 4.639e-3.
// See test/captureGrid.ts.
//
// What this does and does not pin, so nobody reads more into it than it carries:
// it discriminates a wrong kernel (Chebyshev scores 8/26, Manhattan 0/26,
// squared-distance 0/26, a 0.4-tile point shift 4/26), but it CANNOT separate
// `sqrt(dx*dx + dy*dy)` from `Math.hypot` - those differ on 8 of 26 in raw f64 and
// on 0 of 26 after rounding to f32 - and both point lists here are integer-valued,
// so it cannot see inside `quantise()` either.
describe("distanceFromNearestPoint against the game", () => {
  // The EvalCtx default spawn is the origin, which is what `starting_positions`
  // resolved to for this capture.
  const spawn: Point[] = [{ x: 0, y: 0 }];

  it("matches the game's distance_from_nearest_point at all 26 positions", () => {
    let exact = 0;
    let worst = 0;
    let worstLabel = "";
    for (const [i, raw] of lakesFixture.positions.entries()) {
      const p = snapPosition(raw);
      const err = Math.abs(
        Math.fround(distanceFromNearestPoint(p.x, p.y, spawn)) - lakesFixture.distance[i],
      );
      if (err === 0) exact++;
      if (err > worst) {
        worst = err;
        worstLabel = `@(${raw.x},${raw.y})`;
      }
    }
    expect(lakesFixture.positions.length).toBe(26); // a regen cannot empty the loop
    expect(exact, `worst ${worstLabel}`).toBe(26);
    expect(worst).toBe(0);
  });

  it("every compared fixture value is exactly f32, which is what makes exact scoring legal", () => {
    const f32 = lakesFixture.distance.filter((v) => Math.fround(v) === v).length;
    expect(f32).toBe(26);
  });

  it("still has off-grid positions for the snap to correct", () => {
    expect(countOffGrid(lakesFixture.positions)).toBe(14);
  });
});
