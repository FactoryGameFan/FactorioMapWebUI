import { describe, expect, it } from "vite-plus/test";

import cliffinessFixture from "./fixtures/oracle-cliffiness.seed123456.json";
import lakesFixture from "./fixtures/oracle-elevation-lakes.seed123456.json";
import nauvisFixture from "./fixtures/oracle-elevation-nauvis.seed123456.json";
import helpersFixture from "./fixtures/oracle-vulcanus-helpers.seed123456.json";
import velevFixture from "./fixtures/oracle-vulcanus-elevation.seed123456.json";
import { snapPosition } from "./captureGrid";
import { makeCliffiness } from "../src/noise/cliffs/cliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { f32 } from "../src/noise/eval/f32";
import { makeElevationLakes } from "../src/noise/expressions/elevationLakes";
import { makeElevationNauvis } from "../src/noise/expressions/elevationNauvis";
import { makeVulcanusBiomes } from "../src/noise/expressions/vulcanusBiomes";
import { makeVulcanusClimate } from "../src/noise/expressions/vulcanusClimate";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusElevation } from "../src/noise/expressions/vulcanusElevation";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { makeVulcanusSpawn } from "../src/noise/expressions/vulcanusSpawn";

/**
 * What #269's narrowing did to the SHIPPED fields that read `basisNoiseExpr`.
 *
 * `test/basisOutputScale.spec.ts` grades the primitive itself against the game
 * and answers the modelling question. This file is the other half: every field
 * downstream of that primitive, scored by EXACT f32 matches, so the change
 * cannot move a shipped field without saying so.
 *
 * ## Why this file has to exist (#256)
 *
 * When #269 landed, `pnpm run verify` passed with ZERO failures - and the model
 * under five expression files had just changed. Every oracle spec covering
 * those callers asserts a combined abs/rel bound (`cliffFields.spec.ts` uses
 * `max(1.0, 1e-2 * |game|)`, `vulcanusHelpers.spec.ts` uses 4e-3 on
 * `mountain_plasma`), and those bounds are wide enough to swallow the entire
 * difference. A green gate was not evidence of anything.
 *
 * That is #256 in one measurement: 6 of 93 oracle-reading specs compare
 * f32-exact, and none of the six sat here. #162 is the standing record of what
 * a tolerance costs when it hides a real bug for a year.
 *
 * ## Reading the counts
 *
 * These are frozen EXACT counts, not bounds. If one moves, read it - do not
 * adjust it. The `before` number on each line is what the field scored with the
 * un-narrowed `output_scale * basis` that shipped until #269, measured on this
 * same tree by reverting only `basisNoiseExpr` and re-running.
 *
 * None is a full house, and that is expected: these are deep composed chains
 * carrying other unported narrowings (the #279 family). This file measures ONE
 * term's contribution, which is why the control lines - the ones that must NOT
 * move - matter as much as the ones that improve.
 */

/** Exact f32 agreement with the game, the only comparison this file makes. */
const scoreExact = (got: readonly number[], want: readonly number[]): number =>
  got.reduce((n, g, i) => (f32(g) === want[i] ? n + 1 : n), 0);

describe("#269's narrowing, scored on the shipped fields that read it", () => {
  /**
   * `mountain_plasma` is `abs(A - B)` of two `basis_noise` calls at output
   * scales 125 and 625, with nothing composed on top - the shallowest exposed
   * expression in the tree, so it shows the term most directly. 7 -> 11 of 38.
   */
  it("vulcanus mountain_plasma reaches 38 of 38", () => {
    const helpers = makeVulcanusHelpers(withCtxDefaults({ seed0: helpersFixture.seed0 }));
    const mountainPlasma = helpers.plasma(102, 2.5, 10, 125, 625);
    const got = helpersFixture.positions.map((p) => mountainPlasma(p.x, p.y));
    expect(scoreExact(got, helpersFixture.mountainPlasma)).toBe(38);
  });

  /**
   * The elevation chain reads `basis_noise` at output scales 250 and 150 plus
   * both `plasma` pairs (125/625 and 0.15/0.75). 114 -> 116 of 434 on both
   * fields - a small move because the chain is an amplified sum where the
   * mountains blend reaches ~1000, so other terms dominate the residual.
   *
   * Positions are snapped onto the game's 1/256 MapPosition grid: 22 of these
   * 434 were captured off it, so the game evaluated a different point than the
   * fixture records (#186).
   */
  it("vulcanus elev and elevation improve and hold at 171 of 434", () => {
    const ctx = withCtxDefaults({ seed0: velevFixture.seed0 });
    const helpers = makeVulcanusHelpers(ctx);
    const spawn = makeVulcanusSpawn(ctx, helpers);
    const cracks = makeVulcanusCracks(ctx, helpers);
    const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
    const climate = makeVulcanusClimate(ctx, helpers, cracks);
    const elevation = makeVulcanusElevation(ctx, helpers, biomes, cracks, climate);

    const snapped = velevFixture.positions.map(snapPosition);
    expect(
      scoreExact(
        snapped.map((s) => elevation.elev(s.x, s.y)),
        velevFixture.elev,
      ),
    ).toBe(171);
    expect(
      scoreExact(
        snapped.map((s) => elevation.elevation(s.x, s.y)),
        velevFixture.elevation,
      ),
    ).toBe(171);
  });

  /**
   * The three controls that must NOT move, each for a different reason.
   *
   * `elevation_lakes` reads `basis_noise` at output scale 1.5, which IS
   * f32-exact - so the constant half of the fix is the identity there and only
   * the product half can reach it. 13 of 17 before and after.
   *
   * `elevation_nauvis` reaches `cliff_level` at output scale 0.6, where the
   * constant half DOES bite - and still does not move, because at 3 of 17 the
   * residual is dominated by terms this change does not touch.
   *
   * `cliffiness_nauvis` is a 0/10 gate at output scale 0.51. It was already
   * perfect at 1024 of 1024 on both seeds and stays perfect: the strongest
   * statement in the file, because a gate that discretises a continuous field
   * is exactly where a silent behaviour change shows up as flipped tiles.
   *
   * Both elevation fields are scored only where the game's own
   * `starting_lake_distance` saturated at 1024 - the same subset their own
   * specs use - and on snapped coordinates (#186).
   */
  it("the fields the fix cannot reach do not move", () => {
    const lakes = makeElevationLakes({ seed0: lakesFixture.seed0 });
    const lakeIdx = lakesFixture.positions
      .map((_p, i) => i)
      .filter((i) => lakesFixture.startingLakeDistance[i] >= 1024);
    expect(lakeIdx.length).toBe(17);
    expect(
      scoreExact(
        lakeIdx.map((i) => {
          const s = snapPosition(lakesFixture.positions[i]);
          return lakes(s.x, s.y);
        }),
        lakeIdx.map((i) => lakesFixture.elevation[i]),
      ),
    ).toBe(13);

    const nauvis = makeElevationNauvis({ seed0: nauvisFixture.seed0 });
    const nauvisIdx = nauvisFixture.positions
      .map((_p, i) => i)
      .filter((i) => nauvisFixture.startingLakeDistance[i] >= 1024);
    expect(nauvisIdx.length).toBe(17);
    expect(
      scoreExact(
        nauvisIdx.map((i) => {
          const s = snapPosition(nauvisFixture.positions[i]);
          return nauvis(s.x, s.y);
        }),
        nauvisIdx.map((i) => nauvisFixture.elevation[i]),
      ),
    ).toBe(3);

    for (const c of cliffinessFixture.cases) {
      const cliffiness = makeCliffiness({
        seed0: c.seed,
        controls: { frequency: 1, continuity: 1 },
        settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
      });
      const exact = cliffinessFixture.positions.reduce(
        (n, p, i) => (cliffiness(p.x, p.y) === c.values[i] ? n + 1 : n),
        0,
      );
      expect(exact, `cliffiness gate seed=${c.seed}`).toBe(cliffinessFixture.positions.length);
    }
  });
});
