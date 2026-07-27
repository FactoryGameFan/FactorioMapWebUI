import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-cliffs.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  CLIFFINESS_BASIC_SEED1,
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_RICHNESS,
  makeCliffinessBasic,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";

describe("Vulcanus cliffs", () => {
  const positions = fixture.positions;
  const v = fixture.values;

  it("cliffiness_basic matches the oracle to the fastapprox floor", () => {
    const cliffiness = makeCliffinessBasic(fixture.seed0);
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      worst = Math.max(worst, Math.abs(cliffiness(p.x, p.y) - v.cliffiness_basic[i]));
    }
    // Measured worst residual, not a loosened tolerance. `cliffiness_basic` is a
    // single 2-octave quick_multioctave through a clamp, so the residual is the
    // primitive's own fastapprox floor (~2e-6) with nothing compounding it.
    expect(worst).toBeLessThan(5e-6);
  });

  it("the game reports cliff_richness = 1, which is what the port assumes", () => {
    // Vulcanus has no cliff autoplace control (space-age/prototypes/autoplace-controls.lua
    // defines gleba_cliff and fulgora_cliff only), so getModifiedRichness(richness,
    // size) has no lever to move and cliff_richness is pinned at 1. This asserts
    // that from the game rather than from reading the Lua - if a future version
    // gives Vulcanus a cliff control, this fails and VULCANUS_CLIFF_RICHNESS (and
    // the missing frequency lever) need revisiting.
    expect(new Set(v.cliff_richness)).toEqual(new Set([1]));
    expect(VULCANUS_CLIFF_RICHNESS).toBe(1);
  });

  it("cliffiness_basic stays in [0.5, 1.5], the range the placement gate assumes", () => {
    // crossesCliff gates on the AVERAGE of two corners' cliffiness being > 0.5.
    // On Nauvis cliffiness is a hard 0-or-10, so that reads as "either corner is
    // cliffy"; here it is continuous, and the +0.5 floor is what makes the gate
    // fire wherever the clamp is above zero. Pinning the range keeps that
    // reasoning honest.
    const lo = Math.min(...v.cliffiness_basic);
    const hi = Math.max(...v.cliffiness_basic);
    expect(lo).toBeGreaterThanOrEqual(0.5);
    expect(hi).toBeLessThanOrEqual(1.5);
    // The sample must actually exercise both ends, or the bound above is vacuous.
    expect(lo).toBeLessThan(0.51);
    expect(hi).toBeGreaterThan(1.4);
  });

  it("pins the planet's cliff band constants", () => {
    // From planet_map_gen.vulcanus()'s cliff_settings in
    // space-age/prototypes/planet/planet-map-gen.lua:21-26. Unlike Nauvis these
    // are NOT read off the user's preset - the preset describes a Nauvis surface
    // and carries no Vulcanus cliff_settings.
    expect(VULCANUS_CLIFF_ELEVATION_0).toBe(70);
    expect(VULCANUS_CLIFF_ELEVATION_INTERVAL).toBe(120);
    expect(CLIFFINESS_BASIC_SEED1).toBe(123);
  });

  it("places cliffs on the game's 4-tile lattice", () => {
    const ctx = withCtxDefaults({ seed0: fixture.seed0 });
    const placement = makeCliffPlacementFromFields(makeVulcanusCliffFields(ctx), {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
    });
    const cells = placement.placedCells(-256, -256, 256, 256);
    // Vulcanus is cliff-heavy, so an empty result means the port broke, not that
    // the window is quiet.
    expect(cells.length).toBeGreaterThan(50);
    // Same lattice as Nauvis (x = 2, y = 2.5 mod 4) - it is engine geometry, not
    // planet data, and makeCliffPlacementFromFields is shared between the two.
    for (const { x, y } of cells) {
      expect(((x % 4) + 4) % 4).toBe(2);
      expect(((y % 4) + 4) % 4).toBe(2.5);
    }
  });

  it("puts no cliff below cliff_elevation_0", () => {
    // crossesCliff needs max(a, b) >= elevation_0 for a band to exist, so every
    // placed cell must have a corner at or above 70. Vulcanus elevation runs
    // from about -82 to 1556, so this genuinely excludes a large low-lying part
    // of the map rather than being trivially satisfied.
    const ctx = withCtxDefaults({ seed0: fixture.seed0 });
    const fields = makeVulcanusCliffFields(ctx);
    const placement = makeCliffPlacementFromFields(fields, {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
    });
    for (const { x, y } of placement.placedCells(-256, -256, 256, 256)) {
      // The cell's four corners. A corner is at (i*4, j*4 + 0.5) and the center
      // at (i*4 + 2, j*4 + 2.5), so the corners sit at (x +/- 2, y +/- 2).
      const corners = [
        [x - 2, y - 2],
        [x + 2, y - 2],
        [x - 2, y + 2],
        [x + 2, y + 2],
      ];
      const highest = Math.max(...corners.map(([cx, cy]) => fields.cliffElevation(cx, cy)));
      expect(highest).toBeGreaterThanOrEqual(VULCANUS_CLIFF_ELEVATION_0);
    }
  });
});
