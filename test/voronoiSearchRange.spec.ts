/**
 * The only test in the repo that can see `VoronoiNoise::getPointsSearchRange()`.
 *
 * Task 4b read that function out of the 2.1.12 arm64 binary - chebyshev pinned
 * at 1, the other three `jitter > threshold ? 2 : 1` against `0.5`, `f32(0.66)`
 * and `0.75` - and its reviewer re-derived every part. The reading was never in
 * doubt. What was missing is that **nothing tested it**: forcing the port's
 * range to 2 for all four distance types passed all 95 voronoi tests, and
 * forcing it to 1 also passed all 95. All 2100 committed voronoi values are
 * indifferent to it, so a wrong range would have been silent.
 *
 * That matters because the range is not a constant of the universe. Factorio bug
 * [130905](https://forums.factorio.com/130905) was a real behavioural change:
 * before 2.1.7 the voronoi ops searched only the immediate neighbourhood and
 * missed the true nearest point at high jitter, and `changelog.txt` puts the fix
 * in 2.1.7. Fulgora runs jitter 0.6, 0.8 and 1.0.
 *
 * **Only `voronoi_pyramid_noise` can discriminate the ring**, which is a
 * geometric fact and not an accident of these fixtures:
 *
 * - `spot`/`facet`/`cell_id` reduce to the two smallest point distances. Every
 *   point stays inside its own cell for `jitter <= 1`, so a ring-2 point is more
 *   than a grid unit away on one axis and effectively never displaces either.
 * - The pyramid's second loop instead minimises the distance to the BISECTOR of
 *   the nearest point and each other point. For euclidean that distance is
 *   `(|f|^2 - |n|^2) / (2 |f - n|)`, which is small whenever `|f| ~= |n|`
 *   **however far away `f`'s cell index is**. A ring-2 point only has to be
 *   nearly equidistant, not nearer - so the pyramid sees the wider ring where
 *   nothing else does.
 *
 * The disagreements are rare (113 in a 4096x4096 tile sweep for chebyshev at
 * jitter 1), which is exactly why the existing 175-position grids never hit one.
 */
import { describe, expect, it } from "vite-plus/test";

import searchRangeFixture from "./fixtures/oracle-voronoi-search-range.seed123456.json";
import {
  makeVoronoi,
  pointsSearchRange,
  type VoronoiDistanceType,
} from "../src/noise/voronoiNoise";

const fx = searchRangeFixture as {
  seed: number;
  seed1: number;
  gridSize: number;
  series: {
    distanceType: string;
    jitter: number;
    expectedRange: number;
    positions: { x: number; y: number }[];
    values: number[];
  }[];
};

const f32 = Math.fround;

const build = (
  s: (typeof fx.series)[number],
  searchRangeOverride?: 1 | 2,
): ReturnType<typeof makeVoronoi> =>
  makeVoronoi({
    seed0: fx.seed,
    seed1: fx.seed1,
    gridSize: fx.gridSize,
    jitter: s.jitter,
    distanceType: s.distanceType as VoronoiDistanceType,
    searchRangeOverride,
  });

describe("voronoi_pyramid_noise at positions where the search range is observable", () => {
  for (const s of fx.series) {
    const label = `${s.distanceType} jitter=${String(s.jitter)} (game range ${String(s.expectedRange)})`;

    /** The acceptance: exact f32, no tolerance, at every captured position. */
    it(`matches the game exactly - ${label}`, () => {
      const v = build(s);
      for (const [i, pos] of s.positions.entries()) {
        expect(f32(v.pyramidNoise(pos.x, pos.y))).toBe(f32(s.values[i]));
      }
    });

    /**
     * **The guard that makes the test above non-vacuous**, and the reason
     * `searchRangeOverride` exists at all.
     *
     * Every captured position was selected because the port's ring-1 and ring-2
     * answers differ there by more than 2%, so planting the OTHER ring must fail
     * at EVERY position - not merely somewhere. If a future change makes this
     * pass, the ring has stopped mattering at these positions and the fixture
     * above has quietly become another 40 values that endorse nothing.
     */
    it(`rejects the other search range at every position - ${label}`, () => {
      const wrong = s.expectedRange === 1 ? 2 : 1;
      const v = build(s, wrong);
      for (const [i, pos] of s.positions.entries()) {
        expect(f32(v.pyramidNoise(pos.x, pos.y))).not.toBe(f32(s.values[i]));
      }
    });

    /** The right range is the one `pointsSearchRange` picks, unprompted. */
    it(`is the range pointsSearchRange returns - ${label}`, () => {
      expect(pointsSearchRange(s.distanceType as VoronoiDistanceType, s.jitter)).toBe(
        s.expectedRange,
      );
    });
  }

  /**
   * Both directions are covered, which is the property that stops this being a
   * one-sided test. A function that returned 2 unconditionally would pass every
   * manhattan/euclidean series and fail chebyshev; one that returned 1
   * unconditionally would do the reverse.
   */
  it("pins both branches - at least one series wants 1 and at least one wants 2", () => {
    const ranges = new Set(fx.series.map((s) => s.expectedRange));
    expect(ranges).toEqual(new Set([1, 2]));
  });
});

/**
 * **The WEAKER guard, and it is labelled weak deliberately.**
 *
 * The three thresholds cannot be pinned behaviourally. A ring-1/ring-2
 * disagreement needs high jitter: a 4096x4096-tile sweep at manhattan `0.5` and
 * another at euclidean `0.66` found ZERO disagreeing positions, so no capture
 * from the game can distinguish `> 0.5` from `> 0.7` for manhattan, or from
 * `>= 0.5`. What the fixture above does constrain is each threshold from ABOVE -
 * manhattan's must be below 0.7 and euclidean's below 0.9, because the game
 * takes the ring-2 answer at those jitters.
 *
 * So this block pins the function's own return values rather than any observed
 * behaviour. **It is a transcription check, not a behavioural test**: it would
 * catch someone deleting the per-distance-type table, collapsing it to a
 * constant, or flipping a comparison, but it CANNOT tell you the transcription
 * was right in the first place. That evidence is the disassembly at
 * `0x101774fd4` (see `pointsSearchRange`'s doc comment), independently
 * re-derived by Task 4b's reviewer, plus the five behavioural series above.
 */
describe("pointsSearchRange's own table (weaker guard - see the block comment)", () => {
  it("pins chebyshev at 1 for every jitter", () => {
    for (const j of [0, 0.25, 0.5, 0.66, 0.75, 0.9, 1]) {
      expect(pointsSearchRange("chebyshev", j)).toBe(1);
    }
  });

  /**
   * The comparison is strict `>` (`csinc w0, w8, wzr, gt`), so the threshold
   * itself is still 1 and the next representable f32 above it is 2. `f32(0.66)`
   * is the literal `0x3f28f5c3`; the double `0.66` is larger than it, which is
   * why euclidean's threshold has to be narrowed before comparing.
   */
  it.each([
    ["manhattan", 0.5],
    ["euclidean", f32(0.66)],
    ["minkowski3", 0.75],
  ] as const)("steps %s from 1 to 2 strictly above %s", (dt, threshold) => {
    const justAbove = f32(threshold + Math.abs(threshold) * 2 ** -23);
    expect(justAbove).toBeGreaterThan(threshold);
    expect(pointsSearchRange(dt, threshold)).toBe(1);
    expect(pointsSearchRange(dt, justAbove)).toBe(2);
    expect(pointsSearchRange(dt, 0)).toBe(1);
    expect(pointsSearchRange(dt, 1)).toBe(2);
  });

  /**
   * `jitter` is narrowed to f32 BEFORE the compare - `ldr d0` / `fcvt s0, d0` in
   * `VoronoiNoise`'s constructor stores the prototype's double as an f32 - so a
   * double that sits above a threshold but rounds back down onto it must still
   * give 1. Dropping the narrowing would answer 2 here.
   *
   * Note which way `0.66` falls: the double `0.66` is BELOW `f32(0.66)`, so a
   * Lua `jitter = 0.66` lands exactly on euclidean's threshold and, because the
   * comparison is strict, gets range 1.
   */
  it("narrows jitter to f32 before comparing", () => {
    const above = f32(0.66) + 1e-9;
    expect(above).toBeGreaterThan(f32(0.66));
    expect(f32(above)).toBe(f32(0.66));
    expect(pointsSearchRange("euclidean", above)).toBe(1);
    expect(0.66).toBeLessThan(f32(0.66));
    expect(pointsSearchRange("euclidean", 0.66)).toBe(1);
  });
});
