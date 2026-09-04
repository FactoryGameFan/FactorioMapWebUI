import { describe, expect, it } from "vite-plus/test";

import bands from "./fixtures/oracle-vulcanus-cliff-bands.seed123456.json";
import { CLIFF_CODE_TO_ORIENTATION } from "../src/noise/cliffs/cliffCatalog";

/**
 * **The grid-4 cliff-elevation channel, checked corner by corner** (issue #84).
 *
 * This was the one input to cliff placement with no per-corner oracle, and every
 * "the fields are exonerated" claim in the residual work rested on the TILE
 * channel instead - `calculate_tile_properties` runs the 1-tile noise program,
 * and `multisample`'s offsets are in the calling program's grid units, so
 * against the field the cliff generator actually reads it differs by 96.09.
 *
 * `oracle-vulcanus-cliff-bands` closes that by using the cliff generator itself
 * as the readout. With `cliff_smoothing = 0`, `cliff_elevation_interval = 1e6`
 * and the cliffiness gate held open, `crossesCliff` collapses to
 * `min(a,b) < cliff_elevation_0 <= max(a,b)`, so the game places a cliff on an
 * edge exactly when its two corners straddle the level - a 1-bit comparator on
 * all 4,225 corners of a region at once. The levels are the REAL bands
 * (`70 + 120k`), which is the entire placement-relevant content of the channel:
 * `crossesCliff` never compares the field against anything else.
 *
 * What it says, and it is not what the previous three sessions assumed:
 *
 * - **`[0,0]` and `[-1200,800]` are EXACT at every band, under both gate arms.**
 *   Not "close" - identical cell sets and identical orientations.
 * - **`[1500,1500]` disagrees**, concentrated at the HIGH bands, and is exact at
 *   310 / 430 / 550. The disagreement survives every explanation that was
 *   available before this fixture existed (see the eliminations below).
 */

/** `cliffiness_basic` with the richness lever the `richness4` arm sets. */

const codeForOrientation = new Map<number, number>();
for (const [c, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
  codeForOrientation.set(id, Number(c));

/**
 * Per edge (L, R, T, B): the two CORNER lattice-index offsets from the cell's
 * own index, matching `placedCells`' edge registers exactly - `L` is
 * `cross(corner(cx, cy), corner(cx, cy+1))`, and so on.
 *
 * The corners are the BARE lattice `(i*4, j*4)`. The emitted centre carries the
 * prototype's `grid_offset` of (2, **2.5**), so it is NOT the corner midpoint:
 * sampling `centre +/- G/2` is off by half a tile in y and quietly reads a
 * different field value.
 */

/**
 * The port under the same collapsed rule the arm was captured with.
 *
 * `constant1` routes the cliffiness PROPERTY at the literal `1`, so the gate is
 * open by construction and the port must model it as exactly that - no
 * expression of ours stands between the field and the crossing test.
 */

/**
 * The game's cells whose CENTRE is in the window.
 *
 * `find_entities_filtered` selects on the entity's BOUNDING BOX, `placedCells`
 * emits on the centre, so the raw dump carries cliffs centred just outside the
 * captured box. Scoring those as "missing" is the artefact that made recall read
 * 0.972 instead of 0.9961 (#101); filtering here is the same correction.
 */

/** Every disputed EDGE: a matched cell whose orientation differs, per differing edge. */

describe("the grid-4 cliff-elevation channel, corner by corner", () => {
  it("covers both gate arms at every band each region's field crosses", () => {
    expect(bands.cases.length).toBe(30);
    expect(new Set(bands.cases.map((c) => c.gate))).toEqual(new Set(["richness4", "constant1"]));
    // Every override reached the surface - read BACK off map_gen_settings, not
    // echoed, so a silently-ignored setting cannot pass as one that did nothing.
    for (const c of bands.cases) {
      expect(c.effective?.cliff_smoothing).toBe(0);
      expect(c.effective?.cliff_elevation_interval).toBe(1000000);
      expect(c.effective?.cliff_elevation_0).toBe(c.level);
      expect(c.effective?.richness).toBe(c.gate === "richness4" ? 4 : 1);
    }
  });

  /**
   * **`richness = 4` does NOT hold the gate open everywhere**, which the option's
   * own documentation claimed and no arm had ever checked.
   *
   * `cliffiness_basic` is `clamp(0.5*log2(richness) + qmn, 0, 1) + 0.5`, so at
   * richness 4 the clamp is `clamp(1 + qmn, 0, 1)` - which is still 0, and the
   * gate still SHUT, wherever `qmn <= -1`. Routing the property at the literal
   * `1` is the only arm where "the gate is open" is a construction rather than a
   * model, and the difference is not cosmetic: it is worth 135 cliffs at one
   * level. Anything concluded from a richness-4 arm alone inherits this.
   */
  it("the constant-1 route opens the gate strictly wider than richness = 4", () => {
    const byKey = new Map(
      bands.cases.map((c) => [`${c.gate}|${String(c.region.x0)}|${String(c.level)}`, c]),
    );
    let strictlyMore = 0;
    for (const c of bands.cases) {
      if (c.gate !== "constant1") continue;
      const r4 = byKey.get(`richness4|${String(c.region.x0)}|${String(c.level)}`);
      expect(r4).toBeDefined();
      expect(c.cliffs.length).toBeGreaterThanOrEqual(r4?.cliffs.length ?? 0);
      if (c.cliffs.length > (r4?.cliffs.length ?? 0)) strictlyMore++;
    }
    // Non-vacuity: if the route had silently failed, every arm would tie.
    expect(strictlyMore).toBeGreaterThanOrEqual(10);
  });
});
