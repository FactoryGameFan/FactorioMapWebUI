import { describe, expect, it } from "vite-plus/test";

import {
  CLIFF_ORIENTATION_COLLISION_BOX,
  CLIFF_ORIENTATION_NAMES,
  CLIFF_ORIENTATION_ROTBB,
  cliffBoxCoversTile,
} from "../src/noise/cliffs/cliffCatalog";

/**
 * **`rotbb` boxes are ROTATED, and the port used their bounding box** (issue
 * #84, the lava-perimeter thread).
 *
 * `rotbb(x, y, size, intersect)` (`base/prototypes/entity/entity-util.lua:9`)
 * returns `{{cx - x_dist, cy - y_dist}, {cx + x_dist, cy + y_dist}, 1/8}` - a
 * rectangle **plus an orientation of 1/8**, i.e. 45 degrees. Sixteen of the
 * twenty cliff orientations are built with it; only the four straight ones are
 * written as plain axis-aligned rectangles.
 *
 * `CLIFF_ORIENTATION_COLLISION_BOX` holds the axis-aligned BOUNDING box, which
 * is the right broad phase - `wouldCollide` derives its tile rectangle from a
 * fixed-point floor, and that is what `cliffCollisionTileBox` reproduces. But
 * the collision itself is against the rotated rectangle, and the AABB overruns
 * it at all four corners. Using the AABB is therefore strictly too eager, and
 * only ever in the corners.
 *
 * **How it was found, because the route matters more than the fix.** The
 * negative-space oracle said 13 real Vulcanus cliffs had lava inside their box,
 * and the standing explanation - written into `vulcanusCliffEntities.spec.ts`
 * and the notes - was that our lava mask was "off by about one tile SOMEWHERE".
 * A dense 994-position capture at exactly those boundaries
 * (`oracle-vulcanus-lava-boundary.seed123456.json`) found **zero** lava
 * mismatches, 35/35 correct at the accusing tiles. The mask was innocent; the
 * shape was wrong. Re-testing every hit against the rotated rectangle clears
 * **13 of 13** while keeping 182 of the 185 rejections that remove genuine false
 * positives.
 */
describe("cliff collision boxes are rotated, not axis-aligned", () => {
  it("has a rotbb spec for the 16 diagonal orientations and none for the 4 straight", () => {
    expect(CLIFF_ORIENTATION_ROTBB.length).toBe(CLIFF_ORIENTATION_COLLISION_BOX.length);
    const straight = CLIFF_ORIENTATION_ROTBB.filter((s) => s === null).length;
    expect(straight).toBe(4);
    // The four axis-aligned ones are exactly the straight walls.
    for (let id = 0; id < 4; id++) expect(CLIFF_ORIENTATION_ROTBB[id]).toBeNull();
    for (const name of [0, 1, 2, 3].map((i) => CLIFF_ORIENTATION_NAMES[i]))
      expect(name).toMatch(/^(west-to-east|north-to-south|east-to-west|south-to-north)$/);
  });

  /**
   * The AABB is derived from the same `(x, y, size)` the rotbb spec carries, so
   * the two cannot drift apart silently. This is the invariant that makes the
   * broad phase a genuine superset of the narrow one.
   */
  it("each rotbb's bounding box is the square the AABB table already holds", () => {
    for (const [id, spec] of CLIFF_ORIENTATION_ROTBB.entries()) {
      if (spec === null) continue;
      const [x, y, size] = spec;
      expect(CLIFF_ORIENTATION_COLLISION_BOX[id]).toEqual([x, y, x + size, y + size]);
    }
  });

  /**
   * The point of the whole change: for a rotated box the AABB's corner tiles are
   * NOT covered, and its edge-midpoint tiles are. A test that only checked the
   * centre would pass for the AABB too.
   */
  it("excludes the AABB's corners and keeps the box's own centre", () => {
    let cornersExcluded = 0;
    let centresIncluded = 0;
    let rotated = 0;
    for (const [id, spec] of CLIFF_ORIENTATION_ROTBB.entries()) {
      if (spec === null) continue;
      rotated++;
      const [x, y, size] = spec;
      // Corner tiles of the AABB, in cell-centre-relative coordinates.
      for (const [cx, cy] of [
        [x, y],
        [x + size - 1, y],
        [x, y + size - 1],
        [x + size - 1, y + size - 1],
      ]) {
        if (!cliffBoxCoversTile(id, 0, 0, Math.floor(cx), Math.floor(cy))) cornersExcluded++;
      }
      // The tile containing the rectangle's own centre is inside it under any
      // rotation, so it must survive. Edge midpoints were tried here first and
      // are the WRONG probe: `Math.floor` of an AABB edge can name a tile that
      // is only partly inside the AABB at all (ids 7, 9, 17, 18), so a miss
      // there says nothing about the narrow phase.
      if (cliffBoxCoversTile(id, 0, 0, Math.floor(x + size / 2), Math.floor(y + size / 2)))
        centresIncluded++;
    }
    // 16 rotated orientations x 4 corners = 64 candidate corners, of which
    // **26 are excluded** (measured 2026-08-01). Not a majority: how much of its
    // AABB a rotated rectangle fills depends on `intersect`, and the corner tile
    // is a whole 1x1 square sitting inside the corner rather than the corner
    // point itself. The bound is the measured value with headroom, not a round
    // number - what it has to catch is the narrow phase becoming a no-op, which
    // would give 0.
    expect(cornersExcluded).toBeGreaterThan(20);
    // And the narrow phase must not have eaten the box: every rotated box keeps
    // its own centre. Without this, `cliffBoxCoversTile` could return `false`
    // everywhere and the corner assertion above would still pass.
    expect(rotated).toBe(16);
    expect(centresIncluded).toBe(16);
  });

  /** The four straight orientations are unrotated, so nothing is ever carved off. */
  it("never narrows the four axis-aligned boxes", () => {
    for (let id = 0; id < 4; id++)
      for (let tx = -4; tx <= 4; tx++)
        for (let ty = -4; ty <= 4; ty++) expect(cliffBoxCoversTile(id, 0, 0, tx, ty)).toBe(true);
  });
});
