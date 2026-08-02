import { describe, expect, it } from "vite-plus/test";

import fx from "./fixtures/oracle-multisample-grid.seed123456.json";

/** The cell column a set of cliffs sits in, ignoring off-lattice crater-cliffs. */
const columns = (cliffs: readonly { x: number; y: number; name: string }[]): number[] =>
  [
    ...new Set(
      cliffs.filter((c) => c.name === "cliff-vulcanus" && Number.isInteger(c.x)).map((c) => c.x),
    ),
  ].sort((a, b) => a - b);

const arm = (i: number) => fx.cases[i];

/**
 * **`multisample`'s offsets are in GRID UNITS, not tiles - issue #18's root cause.**
 *
 * `docs/noise/vulcanus-multisample-NOTES.md` established
 * `multisample(e, dx, dy) == e(x + dx, y + dy)` at 150/150 comparisons, and that
 * is correct - **for `LuaSurface.calculate_tile_properties`, whose noise program
 * has a 1-tile grid**. It was never checked in any other channel, and the
 * primitive's own documentation says it evaluates "in a separate noise program
 * with a larger grid" whose "sub-grids are copied to the main program". That
 * phrase is load-bearing.
 *
 * This asks the same question through the CLIFF GENERATOR, whose grid is the
 * 4-tile corner lattice. A probe expression is routed onto `cliff_elevation`
 * with the placement rule collapsed (`cliff_smoothing = 0`, a single contour via
 * `cliff_elevation_interval = 1e6`, the cliffiness gate held open by
 * `richness = 4`), so cliffs appear exactly where the routed field crosses
 * `cliff_elevation_0 = 71`. With `x` as the field the contour is vertical and
 * the cliffs land in one column, so a shift in the field moves the column.
 *
 * | arm | column | |
 * | --- | --- | --- |
 * | `x` | 70 | baseline |
 * | `multisample(x, 0, 0)` | 70 | identical to baseline |
 * | `multisample(x, 4, 0)` | **54** | shifted **16 tiles**, not 4 |
 * | `multisample(x, 0, 4)` | 70 | null control holds |
 *
 * **A `dx` of 4 moved the field by 16 tiles = 4 x the 4-tile grid step.** So the
 * offsets are scaled by the consuming program's grid, and Vulcanus's
 * `vulcanus_basalt_lakes_multisample` - a `min` over `{0,1}x{0,1}` - is a
 * min-filter spanning **4 tiles** for the cliff generator and **1 tile** for
 * every per-tile consumer. `min` is an erosion operator, so the cliff channel's
 * elevation is markedly smoother; the port used the 1-tile field for both and
 * was therefore too rough, over-placing cliffs by ~40%.
 *
 * Fixing it took the Vulcanus cliff port from recall 0.806/0.938/0.853 with
 * 12.5% wrong orientations to **recall 1.000/0.973/0.965 with 2.4%**, and the
 * level-set sweep from a 1.20-1.49 over-placement below elevation 120 to
 * 1.00-1.09 at every level. See `test/vulcanusElevationLevels.spec.ts`.
 *
 * Note what is NOT wrong: the multisample port itself, and the per-tile
 * consumers. `calculate_tile_properties` and the tile renderer both live in the
 * 1-tile channel, where `e(x + dx, y + dy)` is exactly right.
 */
describe("multisample offsets are in the consuming program's grid units", () => {
  it("captured four arms, all with the collapsed settings applied", () => {
    expect(fx.cases).toHaveLength(4);
    for (const c of fx.cases) {
      expect(c.effective?.cliff_elevation_0).toBe(71);
      expect(c.effective?.cliff_elevation_interval).toBe(1000000);
      expect(c.effective?.cliff_smoothing).toBe(0);
      expect(c.effective?.richness).toBe(4);
    }
    // Non-vacuity: each arm actually placed cliffs, so a column comparison is
    // comparing something.
    for (const c of fx.cases) expect(columns(c.cliffs).length).toBeGreaterThan(0);
  });

  it("puts the baseline contour in exactly one column", () => {
    // `x` crosses 71 between the corners at 68 and 72, so the straddling cell is
    // cx=17, centred at 17*4+2 = 70. A single column is what makes a shift
    // unambiguous.
    expect(columns(arm(0).cliffs)).toEqual([70]);
  });

  it("POSITIVE CONTROL: a dx of 4 moves the contour 16 tiles, not 4", () => {
    // This is the measurement. 4 tiles would leave the column at 70 or move it
    // one cell to 66; 16 tiles moves it four cells to 54, and that is what the
    // game does.
    expect(columns(arm(2).cliffs)).toEqual([54]);
    const shift = 70 - 54;
    expect(shift).toBe(16);
    // Stated as the ratio it implies, which is the actual finding: the offset is
    // multiplied by the 4-tile grid step.
    expect(shift / 4).toBe(4);
  });

  it("multisample(x, 0, 0) is the identity - so zero offset is not the story", () => {
    expect(columns(arm(1).cliffs)).toEqual(columns(arm(0).cliffs));
  });

  it("NULL CONTROL: shifting y cannot move a vertical contour", () => {
    // Catches an axis mix-up, which would otherwise be indistinguishable from a
    // scaling effect.
    expect(columns(arm(3).cliffs)).toEqual(columns(arm(0).cliffs));
  });
});
