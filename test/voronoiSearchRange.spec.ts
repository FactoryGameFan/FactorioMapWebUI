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
 * The disagreements are rare (553 of 16777216 - a 4096x4096-tile window at
 * origin (0, 0), stride 1 tile, seed0 123456 / seed1 0 / gridSize 175 - for
 * chebyshev at
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
     * above has quietly become another 37 values that endorse nothing. (37 is
     * the whole fixture, not the 40 an earlier version of this comment said: its
     * 5 series hold 8, 11, 6, 11 and 1 positions. The single-position euclidean
     * jitter-0.9 series is worth knowing about - one position is the thinnest a
     * "fails at EVERY position" guard can get.)
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
 * **`d1` / `d2` / `cell_id` use the game's range too, not a fixed 25-cell ring.**
 *
 * The binary applies `getPointsSearchRange()` to the nearest-point loop as well
 * as the pyramid's - the range is read once at the top of `runInternal` and
 * bounds both. This port walked a hardcoded 5x5 for the three point ops, which
 * was justified at the time by "a wider ring can only lower a min, and a ring-2
 * point cannot win the argmin at jitter <= 1".
 *
 * **That justification is sound for `d1`/`cell_id` and was never true of `d2`.**
 * A ring-2 point does not have to win the argmin to change `d2`; it only has to
 * beat the *second* best. Measured on this fixture's own configuration
 * (`seed0` 123456, `seed1` 0, `gridSize` 175), manhattan at jitter 1 over a
 * 1400x1400-tile window at stride 1 tile: **828 of 1960000 positions** have a
 * different `facetNoise` at ring 1 than at ring 2. `spotNoise` and `cellId`
 * differ at **0**, exactly as the old argument predicted.
 *
 * The first test below is what fails before the fix, and it fails for a reason
 * worth naming: `searchRangeOverride` is documented as the hook that "plants the
 * wrong search range", but it only ever reached `pyramidNoise`. Planting ring 1
 * on a `facetNoise` field silently did nothing, so the hook was lying about its
 * own scope.
 */
describe("the point search honours the game's range, not a fixed ring", () => {
  /** Positions from the sweep described above, where ring 1 and ring 2 disagree. */
  const MANHATTAN_J1_FACET_DIFFERS = [
    { x: 0, y: 324 },
    { x: 0, y: 330 },
    { x: 0, y: 335 },
  ];

  /**
   * The sweep's own configuration, spelled out rather than borrowed from `fx` -
   * the fixture above is `seed1 = 1` / `gridSize = 64`, and these positions were
   * measured at `seed1 = 0` / `gridSize = 175`. Keying them to `fx` made both
   * tests below pass vacuously (ring 1 and ring 2 simply agree at (0,324) in the
   * fixture's configuration), which is exactly the failure this comment prevents.
   */
  const SWEEP = { seed0: 123456, seed1: 0, gridSize: 175 } as const;

  const manhattanJ1 = (searchRangeOverride?: 1 | 2): ReturnType<typeof makeVoronoi> =>
    makeVoronoi({
      ...SWEEP,
      jitter: 1,
      distanceType: "manhattan",
      searchRangeOverride,
    });

  it("searchRangeOverride reaches facetNoise, not only pyramidNoise", () => {
    const ring1 = manhattanJ1(1);
    const ring2 = manhattanJ1(2);
    for (const p of MANHATTAN_J1_FACET_DIFFERS) {
      expect(
        f32(ring1.facetNoise(p.x, p.y)),
        `facetNoise at (${String(p.x)},${String(p.y)}) must differ between rings`,
      ).not.toBe(f32(ring2.facetNoise(p.x, p.y)));
    }
  });

  /**
   * The substantive assertion: unprompted, the field walks the ring
   * `pointsSearchRange` names. Manhattan at jitter 1 wants 2, so the default
   * must equal the ring-2 field and differ from the ring-1 field.
   */
  it("defaults to the game's range for facetNoise", () => {
    const dflt = manhattanJ1();
    const ring1 = manhattanJ1(1);
    const ring2 = manhattanJ1(2);
    expect(pointsSearchRange("manhattan", 1)).toBe(2);
    for (const p of MANHATTAN_J1_FACET_DIFFERS) {
      expect(f32(dflt.facetNoise(p.x, p.y))).toBe(f32(ring2.facetNoise(p.x, p.y)));
      expect(f32(dflt.facetNoise(p.x, p.y))).not.toBe(f32(ring1.facetNoise(p.x, p.y)));
    }
  });

  /**
   * **The preservation guard.** Narrowing 25 cells to 9 wherever the game's range
   * is 1 must not move a single value - that is what makes this change safe to
   * take without recapturing every voronoi fixture.
   *
   * Measured over a 1400x1400-tile window at stride 1 tile (1960000 positions)
   * per configuration, at `seed0` 123456 / `seed1` 0 / `gridSize` 175: `spot`,
   * `facet` and `cell_id` are **identical at ring 1 and ring 2 in all six**
   * range-1 configurations. This test re-runs a 120x120 corner of that sweep, so
   * it is a regression guard rather than the original evidence.
   *
   * Note this REFUTES the reason the change was originally proposed - "it removes
   * a latent wrong answer for chebyshev facet fields". There is no such wrong
   * answer to remove: chebyshev facet agrees at every one of those 1960000
   * positions. What the change actually buys is faithfulness to the binary and a
   * 1.7x-2.3x speedup at Fulgora's two range-1 sites.
   */
  it("moves no value where the game's range is 1", () => {
    const RANGE_1_CASES = [
      { distanceType: "chebyshev", jitter: 1 },
      { distanceType: "chebyshev", jitter: 0.6 },
      { distanceType: "manhattan", jitter: 0.5 },
      { distanceType: "euclidean", jitter: 0.66 },
      { distanceType: "minkowski3", jitter: 0.75 },
    ] as const;
    for (const c of RANGE_1_CASES) {
      expect(pointsSearchRange(c.distanceType, c.jitter)).toBe(1);
      const mk = (searchRangeOverride: 1 | 2): ReturnType<typeof makeVoronoi> =>
        makeVoronoi({
          ...SWEEP,
          jitter: c.jitter,
          distanceType: c.distanceType,
          searchRangeOverride,
        });
      const narrow = mk(1);
      const wide = mk(2);
      for (let x = 0; x < 120; x++) {
        for (let y = 0; y < 120; y++) {
          const where = `${c.distanceType} j=${String(c.jitter)} @(${String(x)},${String(y)})`;
          expect(f32(narrow.spotNoise(x, y)), where).toBe(f32(wide.spotNoise(x, y)));
          expect(f32(narrow.facetNoise(x, y)), where).toBe(f32(wide.facetNoise(x, y)));
          expect(narrow.cellId(x, y), where).toBe(wide.cellId(x, y));
        }
      }
    }
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

/**
 * `searchRangeOverride` is a TEST HOOK, and its "nothing that renders a map may
 * set this" was documentation only until this spec.
 *
 * It plants the WRONG neighbour ring so the committed game values can reject it.
 * A field builder that set it - even to the value {@link pointsSearchRange}
 * would have chosen - would be shipping a hardcoded ring that silently stops
 * tracking the game's per-distance-type rule, and no fixture would catch it:
 * `spot`/`facet`/`cell_id` are ring-insensitive, and the pyramid disagreements
 * are rare enough (553 of 16777216 in a 4096x4096-tile chebyshev sweep at
 * jitter 1, stride 1 tile from origin (0, 0)) that a
 * 175-position grid never lands on one. So the guard has to be structural.
 *
 * It greps `src/**` rather than asserting a type, because the field is
 * deliberately part of the public `VoronoiParams` - making it non-optional or
 * moving it behind a symbol would complicate the one caller that legitimately
 * needs it (this file).
 */
describe("searchRangeOverride is confined to tests", () => {
  it("is not set anywhere under src/", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // `resolve` is relative to the Vitest root, which is the repo root.
    const root = resolve("src");
    const files: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${dir}/${e.name}`, `${rel}${e.name}/`);
        else files.push(`${rel}${e.name}`);
      }
    };
    walk(root, "");

    const hits = files.filter((f) =>
      readFileSync(`${root}/${f}`, "utf8").includes("searchRangeOverride"),
    );

    // The declaration in voronoiNoise.ts is the only permitted occurrence, and
    // it is a declaration, never an assignment.
    const offenders = hits.filter((f) => f !== "noise/voronoiNoise.ts");
    expect(
      offenders,
      `searchRangeOverride referenced outside its declaration:\n${offenders.join("\n")}`,
    ).toEqual([]);

    // Non-vacuous twice over: the walk must have seen a real tree, and the
    // identifier must actually be findable by this method. A typo in either
    // would otherwise make an empty `offenders` mean nothing.
    expect(files.length).toBeGreaterThan(50);
    expect(hits).toEqual(["noise/voronoiNoise.ts"]);
  });
});
