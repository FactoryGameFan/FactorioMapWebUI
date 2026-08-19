import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-biomes.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusBiomes } from "../src/noise/expressions/vulcanusBiomes";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { makeVulcanusSpawn } from "../src/noise/expressions/vulcanusSpawn";

describe("makeVulcanusBiomes", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const positions = fixture.positions;
  const v = fixture.values;

  // Each bound is the measured worst residual (rounded up with modest headroom),
  // NOT a loosened tolerance.
  //
  // The sample coordinate is snapped onto the game's 1/256 MapPosition grid first
  // (see test/captureGrid.ts). 22 of these 434 positions were captured off it, so
  // the game evaluated at a different point than the fixture records (#186). Those
  // 22 rows set the worst residual in all eight arrays; snapping them dropped the
  // whole fixture from 3.092e-4 to 4.634e-5 and took the spot-noise volcano field
  // from 3.821e-5 to 2.027e-6 (19x).
  //
  // The old comment attributed this to "the far-from-origin f32 coordinate floor".
  // That was the wrong mechanism: the displacement was the capture, not the
  // arithmetic. The volcano-spot cone field does still carry a real f32 cone-edge
  // residual, and the whole chain now lands under 6e-5, with the spot-noise field
  // itself at 2.027e-6 - still the signal that the spot_noise arg mapping is right.
  const check = (fn: (x: number, y: number) => number, want: number[], bound: number): void => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = snapPosition(positions[i]);
      worst = Math.max(worst, Math.abs(fn(p.x, p.y) - want[i]));
    }
    expect(worst, `worst ${worst.toExponential(4)}`).toBeLessThan(bound);
  };

  it("mountain_volcano_spots matches the oracle (spot-noise volcano field)", () => {
    check(biomes.mountainVolcanoSpots, v.mountain_volcano_spots, 3e-6);
  });

  it("vulcanus_mountains_raw_volcano matches the oracle", () => {
    check(biomes.mountainsRawVolcano, v.vulcanus_mountains_raw_volcano, 6e-5);
  });

  it("vulcanus_mountains_biome_full matches the oracle", () => {
    check(biomes.mountainsBiomeFull, v.vulcanus_mountains_biome_full, 6e-5);
  });

  it("vulcanus_ashlands_biome_full matches the oracle", () => {
    check(biomes.ashlandsBiomeFull, v.vulcanus_ashlands_biome_full, 6e-5);
  });

  it("vulcanus_basalts_biome_full matches the oracle", () => {
    check(biomes.basaltsBiomeFull, v.vulcanus_basalts_biome_full, 6e-5);
  });

  it("vulcanus_mountains_biome (clamped 0-1) matches the oracle", () => {
    check(biomes.mountainsBiome, v.vulcanus_mountains_biome, 3e-6);
  });

  it("vulcanus_ashlands_biome (clamped 0-1) matches the oracle", () => {
    check(biomes.ashlandsBiome, v.vulcanus_ashlands_biome, 9e-6);
  });

  it("vulcanus_basalts_biome (clamped 0-1) matches the oracle", () => {
    check(biomes.basaltsBiome, v.vulcanus_basalts_biome, 7e-6);
  });
});

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-vulcanus-biomes still has off-grid positions", () => {
    expect(countOffGrid(fixture.positions)).toBe(22);
  });
});
