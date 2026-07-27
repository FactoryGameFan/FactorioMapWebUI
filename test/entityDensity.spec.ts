import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-entity-counts.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makePlacementRoll, PLACEMENT_SALT } from "../src/noise/placement/placementRoll";
import { makeVulcanusRockPlacement } from "../src/noise/preview/renderVulcanusRocks";
import { makeVulcanusRockFields } from "../src/noise/rocks/vulcanusRockField";

/**
 * Does the placement pipeline put down about as many entities as the game?
 *
 * `src/noise/placement/placementRoll.ts` drops the game's cross-overlay
 * arbitration and its per-placement jitter draws, so individual positions are NOT
 * expected to match. The only claim on the table is DENSITY, and this file tests
 * exactly that claim against `test/fixtures/oracle-entity-counts.seed123456.json`
 * (captured from the real game by `test/oracle/entityCounts.ts`).
 *
 * ## History: this file used to pin a 2x over-placement
 *
 * As first written (2026-07-27, Task 4) these tests were a *characterization of a
 * defect*: the bare roll placed 2467 / 2820 / 2448 rocks against the game's 1133 /
 * 1367 / 1450, a ratio of 2.18 / 2.06 / 1.69. The cause was two gates the game
 * applies inside its arbitration loop and the port did not
 * (`docs/noise/placement-roll-NOTES.md`: the winner is picked by max probability
 * "subject to collision-mask and tile-restriction checks"):
 *
 * 1. **`tile_restriction`** - no rock may sit on `lava` or `lava-hot`, which are
 *    21% of region 2. Worth ~24%.
 * 2. **Collision rejection** - rocks are big off-grid entities and the roll's hits
 *    cluster, so most neighbours in a cluster collide with the rock already placed.
 *
 * Task 4.5 added both (`makePlacementSet`), and the assertions below were
 * re-measured and rewritten as the agreement test they were always meant to be.
 * They were NOT widened: the band is the worst measured value plus headroom.
 *
 * ## The measurement, after both gates (2026-07-27, Factorio 2.1.12, seed 123456)
 *
 * | region | window | ours | game | rel |
 * | --- | --- | --- | --- | --- |
 * | 2 | `[0,0]-[512,512]` | 1131 | 1133 | 0.2% |
 * | 3 | `[4096,4096]-[4608,4608]` | 1359 | 1367 | 0.6% |
 * | 4 | `[-256,-256]-[256,256]` | 1341 | 1450 | 7.5% |
 *
 * Region 4 is the spawn-centred window, where the port's remaining
 * approximations concentrate: no cross-overlay arbitration against the ~1500
 * other entities per region, and no collision across chunk boundaries. It is the
 * band-setter.
 */

interface FixtureRegion {
  planet: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Count tiles a predicate accepts over a region, one sample per tile. */
function countOver(region: FixtureRegion, accept: (x: number, y: number) => boolean): number {
  let n = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) if (accept(x, y)) n++;
  }
  return n;
}

/** Sum a probability field over a region - the expected ungated placement count. */
function expectedCount(
  region: FixtureRegion,
  probability: (x: number, y: number) => number,
): number {
  let sum = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) sum += probability(x, y);
  }
  return sum;
}

/** Sum the game's count over one region for every name matching `match`. */
function gameCount(regionIndex: number, match: (name: string) => boolean): number {
  return fixture.counts
    .filter((c) => c.region === regionIndex && match(c.name))
    .reduce((a, c) => a + c.count, 0);
}

describe("placement density vs the game", () => {
  /**
   * All FOUR Vulcanus rock prototypes count, not just the two whose names end in
   * `volcanic-rock`. `decoratives-vulcanus.lua` gives `huge-volcanic-rock-hot`
   * and `big-volcanic-rock-hot` the SAME `probability_expression`s as their cold
   * twins (`vulcanus_rock_huge` / `vulcanus_rock_big`); the pairs differ only by
   * `tile_restriction` (hot tiles vs cold tiles), and the union of those two
   * restrictions is what `makeVulcanusRockPlacement` models. Our `density` is
   * `max(rock_huge, rock_big)`, i.e. the probability a rock of any of the four
   * wins the tile, so the comparable game number is the sum of all four.
   */
  const isVulcanusRock = (name: string): boolean =>
    name.endsWith("volcanic-rock") || name.endsWith("volcanic-rock-hot");

  /**
   * Measured 0.0018 / 0.0059 / 0.0752 (see the file header). Pinned just above
   * the worst. This is a ceiling on a quantity that is deterministic, so a
   * regression moves it, not noise.
   */
  const BAND = 0.08;

  const vulcanusRegions = fixture.regions
    .map((r, i) => ({ region: r as FixtureRegion, index: i }))
    .filter((e) => e.region.planet === "vulcanus");

  // One `it` per region rather than two: each sweeps 262144 tiles of the Vulcanus
  // field stack, and the suite already has a test that times out under load.
  for (const { region, index } of vulcanusRegions) {
    it(`Vulcanus rocks: placement density agrees with the game (region ${String(index)})`, () => {
      const game = gameCount(index, isVulcanusRock);
      const ctx = withCtxDefaults({ seed0: fixture.seed, startingPositions: [{ x: 0, y: 0 }] });
      const ours = countOver(region, makeVulcanusRockPlacement(ctx));
      const rel = Math.abs(ours - game) / game;

      // The bare roll, ungated, against the field's own integral. This is the one
      // claim that holds independent of the gates: the roll is an unbiased uniform
      // draw, so the tiles it accepts must match the field's integral. It is what
      // says the RE'd taus88 stream, the chunk seeding and the caching are sound -
      // and it is what localised the original 2x error to the missing gates rather
      // than to the roll. Measured 0.0022 / 0.0326 / 0.0049; pinned just above the
      // worst.
      const { density } = makeVulcanusRockFields(ctx);
      const roll = makePlacementRoll(PLACEMENT_SALT.vulcanusRocks);
      const ungated = countOver(region, (x, y) => roll(x, y) < density(x, y));
      const expected = expectedCount(region, density);
      const relToField = Math.abs(ungated - expected) / expected;

      console.log(
        `vulcanus rocks region ${String(index)} [${String(region.x0)},${String(region.y0)}]: ` +
          `ours=${String(ours)} game=${String(game)} rel=${rel.toFixed(4)} ` +
          `ungated=${String(ungated)} sum(density)=${expected.toFixed(1)} ` +
          `relToField=${relToField.toFixed(4)}`,
      );

      expect(rel).toBeLessThan(BAND);
      expect(relToField).toBeLessThan(0.05);
    }, 120000);
  }
});
