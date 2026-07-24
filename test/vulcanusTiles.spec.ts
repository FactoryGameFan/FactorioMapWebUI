import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-tile-names.seed123456.json";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";

/**
 * Task 10: the Vulcanus tile argmax + map_color port, validated against the
 * `get_tile` oracle (Space Age, real Vulcanus surface). `resolveVulcanusTile`
 * evaluates every tile's `probability_expression` and paints the argmax's
 * `map_color` - this asserts it names the SAME tile the game placed.
 *
 * Agreement is NOT expected to be 100%. As of V2 (Task 5) the three resource-coupling
 * terms (`vulcanus_metal_tile`, `vulcanus_calcite_region`,
 * `vulcanus_sulfuric_acid_region_patchy`) are fully restored in every `*_range`
 * expression that references them - V1's no-resource-default stubs are gone. The
 * remaining gap is the game's `random_penalty_between(0.9, 1, 1)` inside
 * `vulcanus_metal_tile`, which this port approximates as `1` (an upper bound) because
 * `random_penalty` is a whole-batch operation a per-pixel renderer cannot reproduce
 * (see `src/noise/expressions/vulcanusResources.ts`); at a patch edge where the game
 * rolled a low penalty, that can flip placement outright, so a residual sliver of
 * disagreement right at ore-patch boundaries is expected, not a bug.
 *
 * Measured 98.16% (374/381), up from V1's 96.85% (369/381) - restoring the coupling
 * terms fixed 5 of the original 12 mismatches. The 7 that remain are all far from any
 * resource patch (`metalTile`/`calciteRegion`/`sulfuricAcidRegionPatchy` all read their
 * no-patch floor there) and are ADJACENT-tile flips within one biome family
 * (folds-flat/folds, smooth-stone/cracks-warm, ash-soil/pumice, ash-flats/ash-light,
 * cracks-hot/cracks-warm), spread across radii 230-2079 - the same known far-field f32
 * coordinate floor in elevation/aux/moisture tipping a near-tie argmax across a range
 * boundary that was already present in V1, now with the resource terms ruled out as a
 * cause. No single range expression is systematically wrong (that would cluster many
 * cells of one tile), so this is precision floor, not a bug.
 */
describe("makeVulcanusTileResolver vs get_tile oracle", () => {
  const resolve = makeVulcanusTileResolver({ seed0: fixture.seed0 });
  const positions = fixture.positions;
  const want = fixture.tileNames;

  it("agrees with the placed tile at a high fraction of positions", () => {
    let agree = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const got = resolve(p.x, p.y).name;
      if (got === want[i]) agree++;
    }
    const agreement = agree / positions.length;
    // Floor 0.978 (measured 0.9816, up from V1's 0.9685): high enough that a
    // genuinely wrong range transcription fails it, with modest headroom for the
    // remaining boundary-flip count.
    expect(agreement).toBeGreaterThan(0.978);
  });
});
