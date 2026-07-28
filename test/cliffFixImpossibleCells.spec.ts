import { describe, expect, it } from "vite-plus/test";

import { isCliffPlaced } from "../src/noise/cliffs/cliffCatalog";
import { makeCliffFields } from "../src/noise/cliffs/cliffFields";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";

/**
 * `fixImpossibleCells`, the game's per-chunk repair sweep, ported 2026-07-28.
 *
 * The headline result is a NEGATIVE one and is pinned here so it cannot quietly
 * revert to folklore: **this pass does not move Nauvis at all**, which falsifies
 * the claim - carried in `cliffs-NOTES.md` from 2026-07-20 - that Nauvis's ~6%
 * cliff residual "is `fixImpossibleCells`". It is not. See the notes for what
 * that leaves (`tryToAddCliff`'s `wouldCollide`, still untested).
 */
const key = (p: { x: number; y: number }): string => `${String(p.x)},${String(p.y)}`;

function nauvisCells(seed: number, fix: boolean): string[] {
  const fields = makeCliffFields({
    seed0: seed,
    controls: { frequency: 1, continuity: 1 },
    settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
  });
  return makeCliffPlacementFromFields(fields, {
    elevation0: 10,
    interval: 40,
    fixImpossibleCells: fix,
  })
    .placedCells(512, 512, 1024, 1024)
    .map(key)
    .sort();
}

describe("fixImpossibleCells", () => {
  it("does not change Nauvis by a single cell, at either oracle seed", () => {
    // Measured 2026-07-28: identical cell SETS, not merely identical counts, at
    // both seeds the cliff oracle covers. Nauvis's `cliffiness_nauvis` is a hard
    // 0-or-10 gate, so the crossing configurations it produces are already legal
    // and the sweep finds nothing to repair.
    //
    // This is the assertion that retires "the residual is fixImpossibleCells".
    // If it ever fails, that conclusion needs revisiting - it does not mean the
    // port drifted.
    for (const seed of [123456, 777771]) {
      expect(nauvisCells(seed, true)).toEqual(nauvisCells(seed, false));
    }
  }, 120000);

  it("does fire on Vulcanus, so the pass is not a no-op everywhere", () => {
    // The necessary companion to the Nauvis test above: without this, "no
    // change on Nauvis" would be equally consistent with the port doing nothing
    // at all. Vulcanus's continuous `cliffiness_basic` produces configurations
    // the orientation table rejects, and the sweep repairs them.
    const ctx = withCtxDefaults({ seed0: 123456, startingPositions: [{ x: 0, y: 0 }] });
    const fields = makeVulcanusCliffFields(ctx);
    const cells = (fix: boolean): string[] =>
      makeCliffPlacementFromFields(fields, {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
        fixImpossibleCells: fix,
      })
        .placedCells(0, 0, 256, 256)
        .map(key)
        .sort();
    expect(cells(true)).not.toEqual(cells(false));
  }, 120000);

  it("defaults to ON, because the game always runs it", () => {
    // `crossingsForChunk` calls it unconditionally at its tail, so an omitted
    // option must mean enabled. Contrast `smoothing`, which defaults to Nauvis's
    // 0 rather than the prototype's 1 - the two options deliberately default
    // differently and it would be easy to "tidy" them into agreeing.
    const ctx = withCtxDefaults({ seed0: 123456, startingPositions: [{ x: 0, y: 0 }] });
    const fields = makeVulcanusCliffFields(ctx);
    const bands = {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing: VULCANUS_CLIFF_SMOOTHING,
    };
    const omitted = makeCliffPlacementFromFields(fields, bands)
      .placedCells(0, 0, 256, 256)
      .map(key)
      .sort();
    const explicit = makeCliffPlacementFromFields(fields, { ...bands, fixImpossibleCells: true })
      .placedCells(0, 0, 256, 256)
      .map(key)
      .sort();
    expect(omitted).toEqual(explicit);
  }, 120000);

  it("accepts exactly the codes the orientation table does, plus 0", () => {
    // The legality predicate the sweep uses is not a second table: the game's
    // `code <= 0x50` jump tables and its `code >= 0xC0` bitmask
    // (0x0001000000001003 -> codes 0xC0, 0xC1, 0xCC, 0xF0) together accept
    // exactly `isCliffPlaced(code)` plus code 0. Pinning the four high codes
    // means a change to CLIFF_PLACED_TABLE that broke that correspondence would
    // fail here rather than silently changing what the sweep repairs.
    expect([0xc0, 0xc1, 0xcc, 0xf0].every((c) => isCliffPlaced(c))).toBe(true);
    const highPlaced = [];
    for (let c = 0xc0; c <= 0xff; c++) if (isCliffPlaced(c)) highPlaced.push(c);
    expect(highPlaced).toEqual([0xc0, 0xc1, 0xcc, 0xf0]);
    // Nothing in 0x51..0xBF is accepted.
    for (let c = 0x51; c < 0xc0; c++) expect(isCliffPlaced(c)).toBe(false);
  });
});
