import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/oracle-starting-spot.seed123456.json";
import { startingSpotAtAngle } from "../src/noise/expressions/vulcanusShared";

// starting_spot_at_angle (core/prototypes/noise-functions.lua):
//   angle_rad = angle / 180 * pi
//   delta_x   = distance * sin(angle_rad) - x_from_start + x_distortion
//   delta_y   = -distance * cos(angle_rad) - y_from_start + y_distortion
//   result    = 1 - (delta_x*delta_x + delta_y*delta_y)^0.5 / radius
//
// Expectations below are hand-derived directly from that formula (not copied
// from the implementation), picked so the trig terms either vanish exactly
// (sin(90deg) = 1, cos(90deg) ~ 0) or cancel to a clean Pythagorean triple.
describe("startingSpotAtAngle reproduces starting_spot_at_angle", () => {
  it("is 1 exactly on-center (x_from_start cancels distance*sin at angle=90)", () => {
    // angle_rad = pi/2, sin = 1, cos ~ 0 (negligible, ~6.12e-17).
    // delta_x = 170*1 - 170 + 0 = 0; delta_y = -170*~0 - 0 + 0 ~ 0.
    const result = startingSpotAtAngle({
      angle: 90,
      distance: 170,
      radius: 350,
      xDistortion: 0,
      yDistortion: 0,
      xFromStart: 170,
      yFromStart: 0,
    });
    expect(result).toBeCloseTo(1, 10);
  });

  it("is 0 exactly at `radius` distance (pure x_distortion offset, angle=0/distance=0)", () => {
    // angle_rad = 0, sin = 0, cos = 1.
    // delta_x = 0*0 - 0 + 350 = 350; delta_y = -0*1 - 0 + 0 = 0.
    // sqrt(350^2 + 0^2) = 350; result = 1 - 350/350 = 0.
    const result = startingSpotAtAngle({
      angle: 0,
      distance: 0,
      radius: 350,
      xDistortion: 350,
      yDistortion: 0,
      xFromStart: 0,
      yFromStart: 0,
    });
    expect(result).toBeCloseTo(0, 10);
  });

  it("matches a distorted case built on a 3-4-5 (scaled) triangle", () => {
    // angle_rad = pi/2, sin = 1, cos ~ 0 (negligible).
    // delta_x = 50*1 - 5 + 3 = 48; delta_y = -50*~0 - 4 + 40 ~ 36.
    // sqrt(48^2 + 36^2) = sqrt(2304 + 1296) = sqrt(3600) = 60.
    // result = 1 - 60/100 = 0.4.
    const result = startingSpotAtAngle({
      angle: 90,
      distance: 50,
      radius: 100,
      xDistortion: 3,
      yDistortion: 40,
      xFromStart: 5,
      yFromStart: 4,
    });
    // EXACT, because the expression now narrows every operation (#279).
    //
    // The answer is 0.3999999761581421 - one f32 ULP BELOW `f32(0.4)`, which is
    // 0.4000000059604645. It is not `f32(0.4)` and it is not 0.4: the chain
    // rounds eight times on the way here, and the accumulated result lands a
    // ULP short. That is the arithmetic being pinned, so it is asserted as the
    // one value it can be.
    //
    // This used to be `toBeCloseTo(0.4, 9)`, which the f32 form misses by
    // 2.384e-8. Exact equality is TIGHTER than that tolerance, not looser - it
    // admits one value where the tolerance admitted a range. What the case is
    // FOR is unchanged: a flipped sign on either delta, or `radius` applied the
    // wrong way, moves this nowhere near 0.4.
    expect(result).toBe(0.3999999761581421);
  });
});

describe("startingSpotAtAngle against the oracle (Factorio 2.1.12, Space Age, Vulcanus)", () => {
  it("matches every fixture point/config to the f32 coordinate floor", () => {
    // x_from_start/y_from_start resolve to the raw world (x, y) at this
    // default origin spawn (Task 2 finding), so callers pass the sampled
    // position itself for both.
    let worst = 0;
    let worstLabel = "";
    let exact = 0;
    let compared = 0;
    for (const c of fixture.cases) {
      for (let i = 0; i < fixture.positions.length; i++) {
        const p = fixture.positions[i];
        const result = startingSpotAtAngle({
          angle: c.angle,
          distance: c.distance,
          radius: c.radius,
          xDistortion: c.xDistortion,
          yDistortion: c.yDistortion,
          xFromStart: p.x,
          yFromStart: p.y,
        });
        compared++;
        if (Math.fround(result) === Math.fround(c.values[i])) exact++;
        const err = Math.abs(Math.fround(result) - Math.fround(c.values[i]));
        if (err > worst) {
          worst = err;
          worstLabel = `angle=${c.angle} distance=${c.distance} @(${p.x},${p.y})`;
        }
      }
    }
    // **EXACT at every one of the 152 captured cases** (#279). This was 88 of
    // 152 while the expression evaluated in f64; narrowing per operation, with
    // an f32 `pi` and f32 `sin`/`cos`, closes it completely. The Rust port's
    // tier-1 test asserts the identical count from the identical fixture, so
    // the two ports are graded against the same number - see
    // `crates/fmw-noise/src/fixtures.rs`.
    //
    // The residual bound is kept underneath, now at 0. It used to be 3e-6
    // against an observed worst of ~1.41e-6, and a bound is what let 64 of these
    // cases sit inexact without anything saying so (#162). Do not let either
    // assertion move: below 152 means the narrowing has been disturbed.
    expect(compared, "4 cases x 38 positions").toBe(152);
    expect(exact, `exact f32 matches`).toBe(152);
    expect(worst, `worst ${worstLabel}`).toBe(0);
  });
});
