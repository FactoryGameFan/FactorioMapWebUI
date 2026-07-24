import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-resources.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusBiomes } from "../src/noise/expressions/vulcanusBiomes";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { makeVulcanusResources } from "../src/noise/expressions/vulcanusResources";
import { makeVulcanusSpawn } from "../src/noise/expressions/vulcanusSpawn";

describe("makeVulcanusResources", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);
  const positions = fixture.positions;

  // Bounds are the measured worst residual (over all 1085 fixture points) with
  // modest headroom - f32 rounding noise, same floor documented across the other
  // vulcanus specs. Measured worst residuals (2026-07-24):
  //   basaltsFavorability          2.4e-5
  //   mountainsFavorability        2.7e-4
  //   mountainsSulfurFavorability  2.7e-4
  //   ashlandsFavorability         1.4e-4
  //   startingTungsten             3.1e-4
  //   startingCoal                 1.9e-4
  //   startingCalcite              3.0e-4
  //   startingSulfur               3.2e-4
  const check = (field: (x: number, y: number) => number, want: number[], bound: number): void => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      worst = Math.max(worst, Math.abs(field(p.x, p.y) - want[i]));
    }
    expect(worst).toBeLessThan(bound);
  };

  it("vulcanus_basalts_resource_favorability matches the oracle", () => {
    check(resources.basaltsFavorability, fixture.basaltsFavorability, 1e-4);
  });

  it("vulcanus_mountains_resource_favorability matches the oracle", () => {
    check(resources.mountainsFavorability, fixture.mountainsFavorability, 5e-4);
  });

  it("vulcanus_mountains_sulfur_favorability matches the oracle", () => {
    check(resources.mountainsSulfurFavorability, fixture.mountainsSulfurFavorability, 5e-4);
  });

  it("vulcanus_ashlands_resource_favorability matches the oracle", () => {
    check(resources.ashlandsFavorability, fixture.ashlandsFavorability, 3e-4);
  });

  it("vulcanus_starting_tungsten matches the oracle", () => {
    check(resources.startingTungsten, fixture.startingTungsten, 5e-4);
  });

  it("vulcanus_starting_coal matches the oracle", () => {
    check(resources.startingCoal, fixture.startingCoal, 3e-4);
  });

  it("vulcanus_starting_calcite matches the oracle", () => {
    check(resources.startingCalcite, fixture.startingCalcite, 5e-4);
  });

  it("vulcanus_starting_sulfur matches the oracle", () => {
    check(resources.startingSulfur, fixture.startingSulfur, 5e-4);
  });
});
