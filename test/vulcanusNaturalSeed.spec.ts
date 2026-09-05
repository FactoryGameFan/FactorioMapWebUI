import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-tile-names.natural-mapseed123456.json";
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

  // The two tile-agreement blocks that used to follow - a high fraction at
  // the derived seed, near zero at the raw map seed - graded the TypeScript
  // resolver, which is gone (#371). Both arms live on as
  // `puts_every_vulcanus_tile_where_the_game_puts_it_at_a_real_saves_surface_seed`
  // in crates/fmw-noise/src/fixtures.rs, against this same fixture and as an
  // exact count rather than a fraction. What stays here is the one claim the
  // app's own seed derivation makes about the file.
});
