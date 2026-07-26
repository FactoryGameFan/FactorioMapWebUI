import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-tile-names.natural-mapseed123456.json";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";

/**
 * The end-to-end guard the port was missing: does the app render the Vulcanus a
 * player actually gets from a map seed?
 *
 * `vulcanusTiles.spec.ts` validates the tile argmax against a surface whose seed
 * was FORCED to the map seed - good for the expression port, blind to the seed
 * plumbing. A real save derives the surface seed instead
 * (`mapSeed + crc32("vulcanus")`), so for a long time the preview faithfully
 * rendered a world nobody could visit. This fixture is captured from a save at
 * `--map-gen-seed 123456` with the surface seed left alone, and the resolver is
 * asked for it through `surfaceSeedForPlanet` rather than a literal - so
 * dropping the derivation fails here even though every expression is still
 * correct.
 *
 * Measured 96.59% (368/381). The residual is the same near-tie boundary flips
 * `vulcanusTiles.spec.ts` documents at 98.16% on its own sample (the
 * `random_penalty` approximation at ore-patch edges plus the far-field f32
 * coordinate floor); a different 381 points simply catch a few more of them.
 * The number that matters is the contrast with the raw map seed, which scores
 * 9.71% - a wrong seed is not a subtle regression, it is a different planet.
 */
describe("Vulcanus renders the surface a real save at map seed 123456 produces", () => {
  const mapSeed = fixture.mapSeed;

  it("derives the surface seed the game itself chose", () => {
    expect(surfaceSeedForPlanet("vulcanus", mapSeed)).toBe(fixture.seed0);
  });

  it("agrees with the placed tile at a high fraction of positions", () => {
    const resolve = makeVulcanusTileResolver({ seed0: surfaceSeedForPlanet("vulcanus", mapSeed) });
    let agree = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      if (resolve(p.x, p.y).name === fixture.tileNames[i]) agree++;
    }
    // Floor 0.955 (measured 0.9659), the same headroom-over-measured that
    // `vulcanusTiles.spec.ts` uses for its own sample.
    expect(agree / fixture.positions.length).toBeGreaterThan(0.955);
  });

  it("scores near-zero at the RAW map seed, which is what the bug looked like", () => {
    const resolve = makeVulcanusTileResolver({ seed0: mapSeed });
    let agree = 0;
    for (let i = 0; i < fixture.positions.length; i++) {
      const p = fixture.positions[i];
      if (resolve(p.x, p.y).name === fixture.tileNames[i]) agree++;
    }
    // ~9.7%: chance-level for this tile distribution. Asserting the FAILURE mode
    // keeps the test above honest - it could otherwise pass on a fixture that
    // was insensitive to the seed at all.
    expect(agree / fixture.positions.length).toBeLessThan(0.2);
  });
});
