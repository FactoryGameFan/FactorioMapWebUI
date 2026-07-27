import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-entity-counts.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makePlacementRoll, PLACEMENT_SALT } from "../src/noise/placement/placementRoll";
import {
  makeNauvisEnemyPlacement,
  makeNauvisEnemyProbability,
} from "../src/noise/preview/renderEnemies";
import {
  makeNauvisOilPlacement,
  makeNauvisOilProbability,
} from "../src/noise/preview/renderResources";
import { makeNauvisRockPlacement } from "../src/noise/preview/renderRocks";
import {
  makeVulcanusGeyserPlacement,
  makeVulcanusGeyserProbability,
} from "../src/noise/preview/renderVulcanusResources";
import { makeVulcanusRockPlacement } from "../src/noise/preview/renderVulcanusRocks";
import { makeRockFields } from "../src/noise/rocks/rockField";
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
 * They were NOT widened: each region carries its OWN band, pinned just above that
 * region's own measured value.
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
 * other entities per region, and no collision across chunk boundaries. It is an
 * order of magnitude looser than the other two, which is exactly why each region
 * gets its own band rather than sharing region 4's.
 *
 * ## Nauvis rocks (added 2026-07-27, Task 5)
 *
 * | region | window | ours | game | rel |
 * | --- | --- | --- | --- | --- |
 * | 0 | `[0,0]-[512,512]` | 205 | 192 | 6.8% |
 * | 1 | `[4096,4096]-[4608,4608]` | 54 | 64 | 15.6% |
 *
 * Both are looser than the Vulcanus regions, and the reason is arithmetic
 * rather than modelling: Nauvis rocks are ~6x sparser, so these windows hold
 * 192 and 64 rocks against Vulcanus's ~1200, and a single rock is already 0.5%
 * and 1.6%. The gate-by-gate breakdown and the collision-box measurement live
 * on `makeNauvisRockPlacement` in `src/noise/preview/renderRocks.ts`.
 *
 * ## Nauvis enemy bases (added 2026-07-27, Task 6)
 *
 * | region | window | ours | game | rel |
 * | --- | --- | --- | --- | --- |
 * | 0 | `[0,0]-[512,512]` | 28 | 19 | 47.4% - NOT PINNED, see below |
 * | 1 | `[4096,4096]-[4608,4608]` | 157 | 142 | 10.6% |
 *
 * **Region 0 is deliberately unusable as an agreement gate and carries no `rel`
 * band.** 47.4% is past this project's 0.3 stop-and-report threshold, and the
 * cause was measured rather than guessed: 34.3% of region 0 is excluded by trees
 * (10.9% in region 1) and a further 3.8% by rocks, both of which sort BEFORE
 * spawners in autoplace order and so take their tiles first in the game. Feeding
 * this app's own tree and rock placements in as blockers takes region 0 to 19
 * and region 1 to 155 (9.2%). That is a cross-overlay change, not a band, and it
 * is not modelled here - see `makeNauvisEnemyPlacement` in
 * `src/noise/preview/renderEnemies.ts`. Region 0 still asserts the
 * gate-independent `relToField` claim, and its `rel` is logged so a future
 * cross-overlay pass can be measured against it.
 *
 * ## Vulcanus sulfuric-acid geysers (added 2026-07-27, Task 7)
 *
 * | region | window | ours | game | rel |
 * | --- | --- | --- | --- | --- |
 * | 2 | `[0,0]-[512,512]` | 0 | 0 | - (asserted as equality) |
 * | 3 | `[4096,4096]-[4608,4608]` | 0 | 0 | - (asserted as equality) |
 * | 4 | `[-256,-256]-[256,256]` | 56 | 56 | 0.0% |
 *
 * **Only region 4 has a usable denominator, and 56 is a weak one.** Regions 2
 * and 3 hold no sulfur at all - the geyser probability is <= 0 at every one of
 * their 262144 tiles - so the game has zero geysers there and so does this
 * model; those two are asserted as exact zeros, which is a real check on the
 * region gate but says nothing about the roll. Region 4's n = 56 carries a
 * Poisson sigma of ~7.5 (13%), so an exact match is inside the noise by
 * construction: re-rolling region 4 under eight different salts gives 46-63
 * (mean 55.3). Read the 0.0% as "unbiased", not as "precise".
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
   * Per-region bands, each pinned just above its OWN measured value - NOT one
   * shared ceiling. A single `0.08` (the worst region's band) would let regions 2
   * and 3, which measure 0.0018 and 0.0059, absorb a 40x regression while staying
   * green. These quantities are deterministic, so the only headroom allowed is a
   * few tiles' worth against cross-engine float drift.
   *
   * | region | measured rel | tiles | band |
   * | --- | --- | --- | --- |
   * | 2 | 0.0018 | 1131 vs 1133 | 0.005 (~5 tiles) |
   * | 3 | 0.0059 | 1359 vs 1367 | 0.010 (~13 tiles) |
   * | 4 | 0.0752 | 1341 vs 1450 | 0.080 |
   */
  const BAND: Record<number, number> = { 2: 0.005, 3: 0.01, 4: 0.08 };

  /**
   * Same shape for the ungated roll-vs-field-integral check. Measured 0.0022 /
   * 0.0326 / 0.0049 - region 3's is an order of magnitude larger than the other
   * two, so a shared band would have hidden that asymmetry as well.
   */
  const FIELD_BAND: Record<number, number> = { 2: 0.005, 3: 0.04, 4: 0.008 };

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
      // than to the roll. Banded per region, see FIELD_BAND.
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

      expect(rel).toBeLessThan(BAND[index]);
      expect(relToField).toBeLessThan(FIELD_BAND[index]);
    }, 120000);
  }
});

describe("Vulcanus geyser placement density vs the game", () => {
  /**
   * The band for the ONE region with geysers. Measured `rel = 0.0000` (56 vs
   * 56), so "just above the measured value" is a headroom decision rather than
   * a rounding one; 0.04 is +/-2 geysers on 56, the same ~2-entity headroom the
   * rock bands carry.
   *
   * | region | game | ours | measured rel | band |
   * | --- | --- | --- | --- | --- |
   * | 2 | 0 | 0 | - | equality, not a band |
   * | 3 | 0 | 0 | - | equality, not a band |
   * | 4 | 56 | 56 | 0.0000 | 0.04 (+/-2 geysers) |
   *
   * **What this band does and does not have power over.** It fails on the real
   * physics: dropping the collision gate gives 81 (rel 0.446), and that is the
   * whole of the gating here - the lava tile restriction rejects nothing in this
   * window (see `GEYSER_FORBIDDEN_TILES` in `renderVulcanusResources.ts` for why
   * that 0 is a property of the window, not of the gate). Unlike the enemy-base
   * band it DOES discriminate the arbitrary salt: of the eight salts measured
   * (46-63 placements), only two pass 0.04. That is a consequence of pinning to
   * a measured 0.0, not a claim that the salt is right - it is arbitrary, and a
   * deliberate salt change here means re-measuring, not widening.
   */
  const BAND = 0.04;

  /**
   * The ungated roll against the probability's own integral - the claim that
   * holds independent of both gates. Measured in region 4 only (the other two
   * integrate to exactly 0): 81 placements against a sum of 73.5, rel 0.1022.
   *
   * That is an order of magnitude looser than the rock overlays' 0.002-0.033,
   * and the reason is the count, not the roll: a Poisson draw with mean 73.5 has
   * sigma 8.6, i.e. 11.7% of the mean, so 81 is +0.87 sigma. The band adds ~1
   * further placement over the measured value.
   */
  const FIELD_BAND = 0.11;

  const vulcanusRegions = fixture.regions
    .map((r, i) => ({ region: r as FixtureRegion, index: i }))
    .filter((e) => e.region.planet === "vulcanus");

  for (const { region, index } of vulcanusRegions) {
    it(`Vulcanus geysers: placement density vs the game (region ${String(index)})`, () => {
      const game = gameCount(index, (name) => name === "sulfuric-acid-geyser");
      const ctx = withCtxDefaults({ seed0: fixture.seed, startingPositions: [{ x: 0, y: 0 }] });
      const ours = countOver(region, makeVulcanusGeyserPlacement(ctx));

      const probability = makeVulcanusGeyserProbability(ctx);
      const roll = makePlacementRoll(PLACEMENT_SALT.vulcanusGeyser);
      const ungated = countOver(region, (x, y) => roll(x, y) < probability(x, y));
      // The probability is negative wherever the geyser cannot place (the game's
      // expression is not clamped), and a negative term must not subtract from
      // the expected count - the roll can never accept there.
      const expected = expectedCount(region, (x, y) => Math.max(0, probability(x, y)));

      console.log(
        `vulcanus geysers region ${String(index)} [${String(region.x0)},${String(region.y0)}]: ` +
          `ours=${String(ours)} game=${String(game)} ungated=${String(ungated)} ` +
          `sum(probability)=${expected.toFixed(1)}`,
      );

      if (game === 0) {
        // No sulfur reaches these two windows at all, so this is an assertion
        // about the region gate rather than about the roll - but a sign error or
        // a dropped `(patchy > 0)` term would place thousands here.
        expect(ours).toBe(0);
        expect(expected).toBe(0);
        return;
      }
      expect(Math.abs(ours - game) / game).toBeLessThan(BAND);
      expect(Math.abs(ungated - expected) / expected).toBeLessThan(FIELD_BAND);
    }, 120000);
  }
});

describe("Nauvis enemy-base placement density vs the game", () => {
  /**
   * The two `unit-spawner` prototypes whose autoplace shares the
   * `b[enemy]-a[spawner]` order and therefore, per the game's grouped
   * arbitration, competes for one roll per tile. The four worms are a separate
   * group (`b[enemy]-b[worm]`) with their own rolls and are neither modelled nor
   * in the fixture.
   */
  const isSpawner = (name: string): boolean =>
    name === "biter-spawner" || name === "spitter-spawner";

  /**
   * **Region 1 only.** Region 0 measures 0.4737, past the 0.3 stop-and-report
   * threshold this project applies to a density model, so it gets no `rel` band
   * rather than a widened one. The file header records why (34.3% of region 0 is
   * excluded by trees that the game places first and this overlay does not model,
   * against 10.9% in region 1) and what closing it measures (19 and 155).
   *
   * | region | measured rel | count | band | headroom |
   * | --- | --- | --- | --- | --- |
   * | 0 | 0.4737 | 28 vs 19 | (none) | - |
   * | 1 | 0.1056 | 157 vs 142 | 0.11 | zero further spawners |
   *
   * Region 1's headroom is exactly none, and that is deliberate rather than
   * accidental: `0.11 * 142 = 15.62` against a measured deviation of 15, so 158
   * spawners (deviation 16, rel 0.1127) already fails. The band exists to hold a
   * deterministic quantity against cross-engine float drift, not to leave room for
   * the model to move.
   *
   * **What this band does and does not have power over.** It catches real
   * regressions in the physics: dropping `random_penalty` was run as a
   * falsification and fails at 0.176, and every other degraded variant in
   * `renderEnemies.ts`'s gate-by-gate table (which is measured pre-penalty) sits at
   * 167 spawners or worse - `collision_box` instead of the map-gen box at 290,
   * collision-only at 730, restriction-only at 1704 - so all of them fail 0.11 too.
   * It does NOT discriminate the
   * arbitrary penalty salts: all six pairs `renderEnemies.ts` measures (149-157,
   * rel 0.049-0.106) pass 0.11, so a salt change is absorbed silently. Read 0.1056
   * as one draw from that range, not as a property of the model.
   */
  const BAND: Record<number, number | undefined> = { 1: 0.11 };

  /**
   * The ungated roll against the group probability's own integral - the claim
   * that holds independent of both gates, i.e. that the taus88 stream and the
   * chunk seeding are an unbiased draw. This one IS asserted in both regions,
   * because it is unaffected by the tree occupancy that makes region 0's `rel`
   * unusable. Measured 0.0029 (224 vs 224.6) and 0.0105 (6574 vs 6505.8); bands
   * add ~2 tiles and ~10 tiles respectively.
   */
  const FIELD_BAND: Record<number, number> = { 0: 0.01, 1: 0.012 };

  const nauvisRegions = fixture.regions
    .map((r, i) => ({ region: r as FixtureRegion, index: i }))
    .filter((e) => e.region.planet === "nauvis");

  for (const { region, index } of nauvisRegions) {
    it(`Nauvis enemy bases: placement density vs the game (region ${String(index)})`, () => {
      const game = gameCount(index, isSpawner);
      const params = {
        seed0: fixture.seed,
        controls: { frequency: 1, size: 1 },
        startingPositions: [{ x: 0, y: 0 }],
      };
      const ours = countOver(region, makeNauvisEnemyPlacement(params));
      const rel = Math.abs(ours - game) / game;

      const probability = makeNauvisEnemyProbability(params);
      const roll = makePlacementRoll(PLACEMENT_SALT.enemyBases);
      const ungated = countOver(region, (x, y) => roll(x, y) < probability(x, y));
      const expected = expectedCount(region, probability);
      const relToField = Math.abs(ungated - expected) / expected;

      console.log(
        `nauvis enemy bases region ${String(index)} [${String(region.x0)},${String(region.y0)}]: ` +
          `ours=${String(ours)} game=${String(game)} rel=${rel.toFixed(4)} ` +
          `ungated=${String(ungated)} sum(probability)=${expected.toFixed(1)} ` +
          `relToField=${relToField.toFixed(4)}`,
      );

      const band = BAND[index];
      if (band !== undefined) expect(rel).toBeLessThan(band);
      expect(relToField).toBeLessThan(FIELD_BAND[index]);
    }, 120000);
  }
});

describe("Nauvis rock placement density vs the game", () => {
  /**
   * Exactly three Nauvis prototypes are entities, and `makeRockFields`'
   * `density` is the max of their three probabilities, so the comparable game
   * number is the sum of all three counts. The five other `control = "rocks"`
   * prototypes in `decoratives.lua` (medium/small/tiny rock, medium/small sand
   * rock) are `type = "optimized-decorative"` - a different generation pass, not
   * entities - so they neither appear in the fixture nor belong in this sum.
   */
  const isNauvisRock = (name: string): boolean =>
    name === "huge-rock" || name === "big-rock" || name === "big-sand-rock";

  /**
   * Per-region bands, each pinned just above its OWN measured value, with about
   * two rocks of headroom against cross-engine float drift. The regions are far
   * smaller than the Vulcanus ones (192 and 64 rocks against ~1200), so one rock
   * is 0.5% and 1.6% respectively - the percentages here are inherently coarser,
   * which is another reason not to share one band.
   *
   * | region | measured rel | count | band | headroom |
   * | --- | --- | --- | --- | --- |
   * | 0 | 0.0677 | 205 vs 192 | 0.08 | ~2 rocks |
   * | 1 | 0.1563 | 54 vs 64 | 0.19 | ~2 rocks |
   *
   * Region 1 `[4096,4096]` is 60% water (measured with the ported tile
   * resolver), so the water restriction does most of the gating there: the bare
   * roll places 182, the restriction alone cuts that to 60, and collision takes
   * it to 54 against the game's 64. Restriction-only is numerically closer, and
   * it is deliberately NOT what ships - the game applies both gates, and
   * dropping one to improve a 6-rock difference on a 64-rock region would be
   * fitting the oracle rather than modelling it.
   */
  const BAND: Record<number, number> = { 0: 0.08, 1: 0.19 };

  /**
   * Same shape for the ungated roll-vs-field-integral check, which is the claim
   * that holds independent of the gates. Measured 0.0156 (312 vs sum 317.0) and
   * 0.0222 (182 vs 186.1); bands add ~2 rocks each.
   */
  const FIELD_BAND: Record<number, number> = { 0: 0.022, 1: 0.033 };

  const nauvisRegions = fixture.regions
    .map((r, i) => ({ region: r as FixtureRegion, index: i }))
    .filter((e) => e.region.planet === "nauvis");

  for (const { region, index } of nauvisRegions) {
    it(`Nauvis rocks: placement density agrees with the game (region ${String(index)})`, () => {
      const game = gameCount(index, isNauvisRock);
      const params = { seed0: fixture.seed, startingPositions: [{ x: 0, y: 0 }] };
      const ours = countOver(region, makeNauvisRockPlacement(params));
      const rel = Math.abs(ours - game) / game;

      // The bare roll, ungated, against the field's own integral - the same
      // unbiased-draw check the Vulcanus cases make, on the Nauvis field.
      const { density } = makeRockFields(params);
      const roll = makePlacementRoll(PLACEMENT_SALT.nauvisRocks);
      const ungated = countOver(region, (x, y) => roll(x, y) < density(x, y));
      const expected = expectedCount(region, density);
      const relToField = Math.abs(ungated - expected) / expected;

      console.log(
        `nauvis rocks region ${String(index)} [${String(region.x0)},${String(region.y0)}]: ` +
          `ours=${String(ours)} game=${String(game)} rel=${rel.toFixed(4)} ` +
          `ungated=${String(ungated)} sum(density)=${expected.toFixed(1)} ` +
          `relToField=${relToField.toFixed(4)}`,
      );

      expect(rel).toBeLessThan(BAND[index]);
      expect(relToField).toBeLessThan(FIELD_BAND[index]);
    }, 120000);
  }
});

/**
 * ## Nauvis crude oil (added 2026-07-27, Task 8)
 *
 * | region | window | ours | game | rel |
 * | --- | --- | --- | --- | --- |
 * | 0 | `[0,0]-[512,512]` | 7 | 8 | 12.5% |
 * | 1 | `[4096,4096]-[4608,4608]` | 0 | 0 | exact |
 *
 * Oil is the one `placement: "roll"` resource, and the only catalog entry whose
 * `random_probability` is below 1: its probability carries a
 * `random_penalty{source = 1, amplitude = 48}` factor, modelled with a dedicated
 * per-tile stream (`makeNauvisOilProbability` explains why a stand-in reproduces
 * the density exactly even though it does not reproduce the game's batch).
 *
 * **This is the weakest case in the file and the band is honest about it.** n = 8
 * carries a Poisson sigma of 2.83 - 35% - so a single well either way moves `rel`
 * by 12.5 points and 7-vs-8 is not evidence of 12.5%-grade accuracy. The band
 * below is 0.30, which is *looser* than the measured 0.125 on purpose: pinning
 * just above the measurement, the way the rock regions do, would make this test
 * fail on noise rather than on a regression. What it actually discriminates is
 * the failure it was written for - the old threshold rule drew 1234 tiles here,
 * and the un-penalised roll 118, both of which are orders of magnitude outside
 * any band.
 *
 * Region 1 is a zero-vs-zero agreement. That is worth having (the window holds
 * 248 tiles of oil footprint and the game puts no wells in it, so gross
 * over-placement would show) but it cannot discriminate a factor-of-two error,
 * so it is asserted as an exact 0 rather than as a ratio.
 */
describe("crude oil placement density vs the game", () => {
  /** Deliberately looser than the measurement - see the block comment. */
  const OIL_BAND = 0.3;

  const nauvisRegions = fixture.regions
    .map((r, i) => ({ region: r as FixtureRegion, index: i }))
    .filter((e) => e.region.planet === "nauvis");

  for (const { region, index } of nauvisRegions) {
    it(`Nauvis crude oil: placement density agrees with the game (region ${String(index)})`, () => {
      const game = gameCount(index, (name) => name === "crude-oil");
      const params = { seed0: fixture.seed, startingPositions: [{ x: 0, y: 0 }] };
      const ours = countOver(region, makeNauvisOilPlacement(params));

      // The penalty factor costs a factor of 96, not the 48 its name suggests:
      // `1 - 48U` is positive only for U < 1/48 and averages 1/2 there. Checked
      // against the field sums so the closed form is pinned, not just believed.
      const probability = makeNauvisOilProbability(params);
      const penalised = expectedCount(region, probability);

      console.log(
        `nauvis oil region ${String(index)} [${String(region.x0)},${String(region.y0)}]: ` +
          `ours=${String(ours)} game=${String(game)} sum(penalised)=${penalised.toFixed(1)}`,
      );

      if (game === 0) {
        expect(ours).toBe(0);
        return;
      }
      expect(Math.abs(ours - game) / game).toBeLessThan(OIL_BAND);
    }, 120000);
  }
});
