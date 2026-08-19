import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-elevation.seed123456.json";
import temperatureFixture from "./fixtures/oracle-vulcanus-temperature.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusBiomes } from "../src/noise/expressions/vulcanusBiomes";
import { makeVulcanusClimate } from "../src/noise/expressions/vulcanusClimate";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import {
  makeVulcanusElevation,
  makeVulcanusTemperature,
} from "../src/noise/expressions/vulcanusElevation";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { makeVulcanusSpawn } from "../src/noise/expressions/vulcanusSpawn";

describe("makeVulcanusElevation", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const climate = makeVulcanusClimate(ctx, helpers, cracks);
  const elevation = makeVulcanusElevation(ctx, helpers, biomes, cracks, climate);
  const positions = fixture.positions;

  // Each bound is the MEASURED worst residual (rounded up with modest headroom),
  // NOT a loosened tolerance. Elevation is an amplified sum (the mountains blend
  // reaches ~1000, ashlands ~300), so any coordinate-level error is scaled up here.
  //
  // This block used to argue that the far-field residual proved "the coordinate
  // floor (not a blend/multisample bug)". The residual was indeed positional, but
  // it was not a precision floor: 22 of these 434 positions were CAPTURED off the
  // game's 1/256 MapPosition grid, so the game evaluated at a different point than
  // the fixture records (#186). Snapping the coordinate the way the game does takes
  // the far bound from 1.332e-1 to 5.234e-3.
  //
  // The rest of that argument still holds and is why NEAR and FAR keep separate
  // bounds: a mis-ordered lerp or wrong multisample neighbours would break near
  // spawn too, and one bound loose enough to cover the far field would hide it.
  // The near set contains no off-grid positions, so its number is unchanged by the
  // snap - the control that says the snap moved only what it should have.
  const NEAR_RADIUS = 300;
  // Measured post-snap worsts: elev/elevation 1.869e-3 near and 5.234e-3 far;
  // temperature 5.471e-4 near and 2.639e-3 far. The far numbers were 1.332e-1 and
  // 1.327e-1 before the sample coordinates were snapped onto the game's 1/256
  // MapPosition grid - 25x and 50x - because 22 of these 434 positions were
  // CAPTURED off that grid, so the game evaluated at a different point than the
  // fixture records (#186). See test/captureGrid.ts. The near sets contain no
  // off-grid positions, so the snap is the identity there and their numbers are
  // unchanged by it, which is the control that says it moved only what it should.
  const NEAR_BOUND = 2e-3;
  const FAR_BOUND = 6e-3;

  const partitionByRadius = (
    positions: { x: number; y: number }[],
  ): { near: number[]; far: number[] } => {
    const near: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      const r = Math.hypot(positions[i].x, positions[i].y);
      (r < NEAR_RADIUS ? near : far).push(i);
    }
    return { near, far };
  };

  const check = (
    fn: (x: number, y: number) => number,
    positions: { x: number; y: number }[],
    want: number[],
    indices: number[],
    bound: number,
  ): void => {
    let worst = 0;
    for (const i of indices) {
      const p = snapPosition(positions[i]);
      worst = Math.max(worst, Math.abs(fn(p.x, p.y) - want[i]));
    }
    expect(worst, `worst ${worst.toExponential(4)}`).toBeLessThan(bound);
  };

  const { near, far } = partitionByRadius(positions);
  expect(near.length).toBeGreaterThan(0);
  expect(far.length).toBeGreaterThan(0);

  it("vulcanus_elev (raw) matches the oracle tightly near spawn", () => {
    check(elevation.elev, positions, fixture.elev, near, NEAR_BOUND);
  });

  it("vulcanus_elev (raw) matches the oracle to the elevation-scale f32 floor far from spawn", () => {
    check(elevation.elev, positions, fixture.elev, far, FAR_BOUND);
  });

  it("vulcanus_elevation (= max(-500, elev)) matches the oracle tightly near spawn", () => {
    check(elevation.elevation, positions, fixture.elevation, near, NEAR_BOUND);
  });

  it("vulcanus_elevation (= max(-500, elev)) matches the oracle far from spawn", () => {
    check(elevation.elevation, positions, fixture.elevation, far, FAR_BOUND);
  });

  // Task 7's deferred temperature, now that vulcanus_elev exists. It reads the RAW
  // elev, so it inherits the same amplified far-field f32 floor (the elev term is the
  // dominant one; -min(elev, elev/100) contributes the elev magnitude directly).
  // Measured worst: 1.33e-1 far from spawn (own fixture, same far r=3000 point),
  // 1.4e-3 near spawn, at control:temperature:bias = 0.
  it("vulcanus_temperature matches the oracle (closes Task 7's deferral)", () => {
    const temperature = makeVulcanusTemperature(ctx, climate, biomes, elevation);
    const tPositions = temperatureFixture.positions;
    const tWant = temperatureFixture.temperature;
    const { near: tNear, far: tFar } = partitionByRadius(tPositions);
    expect(tNear.length).toBeGreaterThan(0);
    expect(tFar.length).toBeGreaterThan(0);
    check(temperature, tPositions, tWant, tNear, NEAR_BOUND);
    check(temperature, tPositions, tWant, tFar, FAR_BOUND);
  });
});

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-vulcanus-elevation still has off-grid positions", () => {
    expect(countOffGrid(fixture.positions)).toBe(22);
  });
  it("oracle-vulcanus-temperature still has off-grid positions", () => {
    expect(countOffGrid(temperatureFixture.positions)).toBe(22);
  });
});
