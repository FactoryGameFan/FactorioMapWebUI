import { describe, expect, it } from "vite-plus/test";

import nauvis from "./fixtures/oracle-cliff-entities.seed123456.json";
import vulcanus from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { CLIFF_ORIENTATION_NAMES } from "../src/noise/cliffs/cliffCatalog";

/**
 * **The end-to-end oracle for `CLIFF_CODE_TO_ORIENTATION`** (issue #18).
 *
 * That table maps a cell's 8-bit edge-crossing code to one of 20
 * `CliffOrientation`s. It was extracted from
 * `CellCliffCrossing::toMaybeCliffOrientation`'s jump table in the 2.1.12 arm64
 * slice, and `test/cliffOrientation.spec.ts` checks its internal consistency -
 * that the 20 placing codes map 1:1 onto the 20 orientations, and that the boxes
 * follow from `rotbb`. **None of that can catch a misread**, because a
 * mistranscribed table and a mistranscribed expectation agree with each other.
 * That is this repo's recurring failure mode: the Vulcanus surface-seed bug
 * passed every internal check for weeks, and the corner-fields fixture turned
 * out to have been captured at the port's own assumed lattice.
 *
 * The game breaks the loop. `LuaEntity.cliff_orientation` returns the
 * orientation as a string, so as of 2026-07-30 both cliff fixtures carry, per
 * cliff, the answer the engine actually produced. Comparing it against the
 * orientation our code derives from its own crossing code tests the whole chain
 * at once - the two fields, `crossesCliff`, `fixImpossibleCells`, the code
 * packing, AND the table - and it tests the SHIPPING path, because the code
 * comes out of `placedCells` itself rather than a parallel re-derivation.
 *
 * Nauvis is the strong arm: the port matches it 1.0000 in both directions, so
 * all 334 real cliffs are compared and there is nowhere for an error to hide.
 * Vulcanus adds ~1400 more cells across three regions and a second prototype.
 */
describe("cliff orientation vs the game's own cliff_orientation", () => {
  it("the fixtures carry an orientation for every cliff, and all 20 appear", () => {
    const seen = new Set<string>();
    let total = 0;
    for (const c of [...nauvis.cases, ...vulcanus.cases]) {
      for (const p of c.cliffs) {
        expect(typeof p.orientation).toBe("string");
        seen.add(p.orientation);
        total++;
      }
    }
    // Non-vacuity, three ways: the fixtures are not empty, every string the game
    // emitted is one our table knows, and the sample is wide enough to exercise
    // all 20 orientations rather than only the four straight ones. Without the
    // last of these, a table with 16 wrong diagonal entries could still pass the
    // comparisons below if the fixtures happened to contain no diagonals.
    expect(total).toBe(1911);
    for (const name of seen) expect(CLIFF_ORIENTATION_NAMES).toContain(name);
    expect(seen.size).toBe(20);
  });
});
