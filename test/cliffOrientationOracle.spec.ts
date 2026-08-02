import { describe, expect, it } from "vite-plus/test";

import nauvis from "./fixtures/oracle-cliff-entities.seed123456.json";
import vulcanus from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { CLIFF_ORIENTATION_NAMES, cliffOrientationForCode } from "../src/noise/cliffs/cliffCatalog";
import {
  makeCliffPlacement,
  makeCliffPlacementFromFields,
} from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (p: { x: number; y: number }): string => `${String(p.x)},${String(p.y)}`;

const orientationOf = (code: number): string | undefined => {
  const id = cliffOrientationForCode(code);
  return id === undefined ? undefined : CLIFF_ORIENTATION_NAMES[id];
};

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

  it("agrees with the game on NAUVIS, exactly, for every cliff", () => {
    for (const c of nauvis.cases) {
      const r = nauvis.region;
      const placed = makeCliffPlacement({
        seed0: c.seed,
        controls: { frequency: 1, continuity: 1 },
        settings: { cliffElevation0: 10, cliffElevationInterval: 40, richness: 1 },
      }).placedCells(r.x0, r.y0, r.x1, r.y1);
      const ours = new Map(placed.map((p) => [key(p), p.code]));

      const wrong: string[] = [];
      for (const p of c.cliffs) {
        // Nauvis is exact in both directions, so this really is every cliff.
        // Asserted rather than skipped: a silent `continue` is how a shrinking
        // comparison set stops being noticed.
        const code = ours.get(key(p));
        expect(code).toBeDefined();
        const got = orientationOf(code as number);
        if (got !== p.orientation)
          wrong.push(`${key(p)} ours=${String(got)} game=${p.orientation}`);
      }
      expect(wrong).toEqual([]);
      expect(ours.size).toBe(c.cliffs.length);
    }
  }, 120000);

  /**
   * **Vulcanus still does not agree everywhere, and this is issue #18's
   * residual seen up close.**
   *
   * Nauvis passing exactly means the table above is right, so a disagreement
   * here is a disagreement about the CROSSINGS - the four edges - not about the
   * lookup. Measured 2026-08-01, after the `multisample` grid-units fix (#83),
   * over the cells the port and the game both place:
   *
   * | region | matched | wrong orientation | was, before #83 |
   * | --- | --- | --- | --- |
   * | `[0,0]` | 283 | 7 = 2.5% | 228 / 68 = **29.8%** |
   * | `[1500,1500]` | 861 | 26 = 3.0% | 830 / 67 = 8.1% |
   * | `[-1200,800]` | 387 | 4 = 1.0% | 342 / 40 = 11.7% |
   * | total | 1531 | **37 = 2.4%** | 1400 / 175 = 12.5% |
   *
   * Note the comparison set GREW as the error shrank - the port now matches 131
   * more of the game's cliffs - so this is not 175 falling to 37 by comparing
   * fewer cells.
   *
   * This is a far sharper instrument than the counts in
   * `vulcanusCliffEntities.spec.ts`: a cell can land in the right place for the
   * wrong reason, and 37 of them still do. Before #83 the dominant failure was
   * **exactly two edges differing** (125 of 175), which is one of the cell's two
   * crossings sitting on a different side - a single corner on the wrong side of
   * a band boundary - spread evenly over the four edges (L:87 R:80 T:87 B:89),
   * so never a directional off-by-one.
   *
   * **This arm deliberately runs WITHOUT the lava rejection**, which is not the
   * shipping path and is the point. Rejection only ever REMOVES cells, so
   * leaving it off compares the larger set (1531 rather than 1518) and cannot
   * hide a bad crossing behind a cell that got dropped for an unrelated reason.
   * On the shipping path the same measurement is 31 / 1518 = 2.04%; the
   * rejection removes 6 wrong ones with the 185 false positives it is there for.
   *
   * Causes tested against this metric before #83, none of which explained it,
   * kept because each is a closed door:
   *
   * - **The fields were exonerated at the site they were sampled.** Re-running
   *   PR #57's substitution - the game's own corner elevation and cliffiness, at
   *   `[1500,1500]` - left the mismatch at 67/830, identical to the digit, while
   *   a +3 elevation bias moved it to 122/793. The substitution was live and the
   *   metric sensitive to it. What that could not see is that the fixture had
   *   been captured through `calculate_tile_properties`, a DIFFERENT channel
   *   from the one the cliff generator reads - which is exactly what #83 turned
   *   out to be. A field can be right at the right site and still be the wrong
   *   field for the consumer.
   * - **`fixImpossibleCells` was not it.** Turning it off moved the total from
   *   12.5% to 14.3%, and region `[0,0]` from 29.8% to 30.8%.
   * - **Chunk borders were not it.** `generateCliffs` passes `tryToAddCliff` a
   *   `!onChunkBorder` flag, and `fixImpossibleCells` cannot clear a border
   *   edge, so the outer ring of each 8x8 chunk was the obvious suspect. Border
   *   cells were wrong 13.3% of the time against interior's 11.9% - no
   *   concentration - and the game places cliffs uniformly across all 64
   *   in-chunk positions (17-36 each), so that flag suppresses nothing.
   *
   * The count is pinned as an upper bound so the residual can only shrink.
   */
  it("agrees with the game on VULCANUS wherever the port places the same cell", () => {
    const ctx = withCtxDefaults({ seed0: vulcanus.seed, startingPositions: [{ x: 0, y: 0 }] });
    const fields = makeVulcanusCliffFields(ctx);
    let compared = 0;
    const wrong: string[] = [];
    for (const c of vulcanus.cases) {
      const r = c.region;
      const placed = makeCliffPlacementFromFields(fields, {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
      }).placedCells(r.x0, r.y0, r.x1, r.y1);
      const ours = new Map(placed.map((p) => [key(p), p.code]));
      // `crater-cliff` is placed by the entity autoplace, not on the cliff
      // lattice, so its positions are fractional. Excluded, as everywhere else.
      for (const p of c.cliffs.filter((q) => q.name === "cliff-vulcanus")) {
        const code = ours.get(key(p));
        if (code === undefined) continue;
        compared++;
        const got = orientationOf(code);
        if (got !== p.orientation)
          wrong.push(`${key(p)} ours=${String(got)} game=${p.orientation}`);
      }
    }
    // Non-vacuity: this arm skips cells the port does not place, so without a
    // floor a port that placed NOTHING would pass on an empty comparison. 1531
    // is the measured matched count (2026-08-01, placement without the lava
    // rejection, which is what is built above). The floor is raised with the
    // bound below for a reason: a change that shrinks BOTH numbers has not
    // fixed anything, it has stopped comparing.
    expect(compared).toBeGreaterThan(1500);
    // Measured 37. An upper bound, not an equality, so improving the rule does
    // not require editing this line - but tight enough that a regression fails.
    // Do NOT raise it to make a change pass: this number going up means the
    // crossings got worse, which is the whole thing #18 is about.
    expect(wrong.length).toBeLessThanOrEqual(37);
  }, 120000);
});
