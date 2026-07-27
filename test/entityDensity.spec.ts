import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-entity-counts.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makePlacementRoll, PLACEMENT_SALT } from "../src/noise/placement/placementRoll";
import { makeVulcanusRockFields } from "../src/noise/rocks/vulcanusRockField";

/**
 * Does the approximate placement roll put down about as many entities as the game?
 *
 * `src/noise/placement/placementRoll.ts` drops the game's cross-overlay
 * arbitration and its per-placement jitter draws, so individual positions are NOT
 * expected to match. The only claim on the table is DENSITY, and this file tests
 * exactly that claim against `test/fixtures/oracle-entity-counts.seed123456.json`
 * (captured from the real game by `test/oracle/entityCounts.ts`).
 *
 * # READ THIS BEFORE TRUSTING A GREEN RUN
 *
 * **The density does NOT currently agree.** Measured 2026-07-27 against the
 * Factorio 2.1.12 capture, the roll places roughly **twice** as many Vulcanus
 * rocks as the game does. These tests pin that ratio rather than asserting
 * agreement, so the file is a characterization of an open defect, not a
 * validation - the test names say "over-places" for that reason. Do not read a
 * green run here as "our rocks match the game".
 *
 * ## The measurement
 *
 * | region | window | ours | game | ours/game |
 * | --- | --- | --- | --- | --- |
 * | 2 | `[0,0]-[512,512]` | 2467 | 1133 | 2.18 |
 * | 3 | `[4096,4096]-[4608,4608]` | 2820 | 1367 | 2.06 |
 * | 4 | `[-256,-256]-[256,256]` | 2448 | 1450 | 1.69 |
 *
 * ## The diagnosis (measured, not guessed)
 *
 * Neither the roll nor the probability field is wrong. The gap is two gates the
 * game applies inside its arbitration loop and this port does not
 * (`docs/noise/placement-roll-NOTES.md`: the winner is picked by max probability
 * "subject to collision-mask and tile-restriction checks"):
 *
 * 1. **`tile_restriction`.** All four Vulcanus rock prototypes restrict to
 *    `vulcanus_tiles_cold` / `vulcanus_tiles_hot`
 *    (`decoratives-vulcanus.lua:37-60`), whose union is every Vulcanus tile
 *    EXCEPT `lava` and `lava-hot`. Those are 21.0% of region 2 - and our own tile
 *    resolver independently agrees (0.2104 vs the game's 0.2105), so this is a
 *    missing gate, not a terrain mismatch. Dropping lava tiles takes region 2
 *    from 2467 to 1873.
 * 2. **Collision rejection.** Rocks are big off-grid entities
 *    (`huge-volcanic-rock`'s collision box is 3 x 2.2 tiles) and the roll's hits
 *    cluster, so in the game most neighbours in a cluster collide with the
 *    already-placed rock and are skipped. Replaying our own placements in the
 *    game's tile order through a sequential collision filter with that box gives
 *    1144 / 1397 / 1370 against the game's 1133 / 1367 / 1450 - within 1.0% /
 *    2.2% / 5.5%.
 *
 * So the roll and the field reproduce the game's density to within a few percent
 * once those two gates are applied; the shipped overlay just does not apply them
 * yet. Fixing that is what should retire the ratios below - when it lands, these
 * assertions must be re-measured and rewritten as the agreement test they were
 * meant to be, NOT widened.
 */

interface FixtureRegion {
  planet: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Count tiles the roll places over a region, one sample per tile. */
function placedCount(
  region: FixtureRegion,
  salt: number,
  probability: (x: number, y: number) => number,
): number {
  const roll = makePlacementRoll(salt);
  let n = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) if (roll(x, y) < probability(x, y)) n++;
  }
  return n;
}

/** Sum a probability field over a region - the expected placement count. */
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
   * `tile_restriction` (hot tiles vs cold tiles). Our `density` is
   * `max(rock_huge, rock_big)`, i.e. the probability a rock of any of the four
   * wins the tile, so the comparable game number is the sum of all four.
   */
  const isVulcanusRock = (name: string): boolean =>
    name.endsWith("volcanic-rock") || name.endsWith("volcanic-rock-hot");

  /** Measured 2026-07-27, Factorio 2.1.12, seed 123456. See the file header. */
  const OVER_PLACEMENT_RATIO: Record<number, number> = { 2: 2.18, 3: 2.06, 4: 1.69 };

  const vulcanusRegions = fixture.regions
    .map((r, i) => ({ region: r as FixtureRegion, index: i }))
    .filter((e) => e.region.planet === "vulcanus");

  // One `it` per region rather than two: each sweeps 262144 tiles of the Vulcanus
  // field stack, and the suite already has a test that times out under load.
  for (const { region, index } of vulcanusRegions) {
    it(`Vulcanus rocks: the roll over-places vs the game by a pinned ratio (region ${String(index)})`, () => {
      const game = gameCount(index, isVulcanusRock);
      const ctx = withCtxDefaults({ seed0: fixture.seed, startingPositions: [{ x: 0, y: 0 }] });
      const { density } = makeVulcanusRockFields(ctx);
      const ours = placedCount(region, PLACEMENT_SALT.vulcanusRocks, density);
      const expected = expectedCount(region, density);
      const relToField = Math.abs(ours - expected) / expected;
      console.log(
        `vulcanus rocks region ${String(index)} [${String(region.x0)},${String(region.y0)}]: ` +
          `ours=${String(ours)} game=${String(game)} ratio=${(ours / game).toFixed(3)} ` +
          `sum(density)=${expected.toFixed(1)} relToField=${relToField.toFixed(4)}`,
      );

      // toBeCloseTo(v, 1) is |diff| < 0.05. Everything here is deterministic, so
      // this is a tight pin on a known disagreement, not a tolerance.
      expect(ours / game).toBeCloseTo(OVER_PLACEMENT_RATIO[index], 1);

      // The one unconditional claim in this file: the roll is an unbiased uniform
      // draw against the field, so the tiles it places must match the field's
      // integral. That is what says the RE'd taus88 stream, the chunk seeding and
      // the caching are sound, and it is what localises the defect above to the
      // two missing gates rather than to the roll. Measured 0.0022 / 0.0326 /
      // 0.0049; pinned just above the worst.
      expect(relToField).toBeLessThan(0.05);
    }, 120000);
  }
});
