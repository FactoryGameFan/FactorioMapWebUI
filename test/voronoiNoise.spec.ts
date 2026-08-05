import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-voronoi-jitter0.seed123456.json";
import { distanceOf, makeVoronoi, type VoronoiDistanceType } from "../src/noise/voronoiNoise";

const fx = fixture as {
  seed: number;
  gridSize: number;
  jitter: number;
  seed1: number;
  positions: { x: number; y: number }[];
  values: Record<string, number[]>;
};

const f32 = Math.fround;

describe("distanceOf - the four distance types", () => {
  it("matches the documented formulas", () => {
    expect(distanceOf("chebyshev", 3, -4)).toBe(4);
    expect(distanceOf("manhattan", 3, -4)).toBe(7);
    expect(distanceOf("euclidean", 3, -4)).toBe(5);
  });

  /**
   * The brief expected `minkowski3` to equal `(27 + 64) ** (1/3)` to 12 decimal
   * places. It does not, and that is a finding rather than a tolerance to widen:
   * the binary routes the cube root through Factorio's fastapprox
   * `Math::log2f` / `Math::exp2f` pair (measured in `runInternal<3>`), which is
   * worth ~1e-5 relative error by design.
   *
   * This is not a detail that can be rounded away. Using a real `Math.cbrt`
   * instead matches only 25 of the fixture's 175 sampled positions; the
   * fastapprox pair matches all 175.
   */
  it("computes minkowski3 through fastapprox, NOT an exact cube root", () => {
    const exact = (27 + 64) ** (1 / 3);
    const got = distanceOf("minkowski3", 3, -4);
    expect(got).toBeCloseTo(exact, 3);
    expect(got).not.toBe(exact);
    // Measured 4.44e-5 relative here; bounded at 1e-4, the fastapprox error scale
    // this repo already documents for `fastPow`/`fastCbrt`.
    expect(Math.abs(got - exact) / exact).toBeLessThan(1e-4);
    expect(Math.abs(got - exact) / exact).toBeGreaterThan(1e-6);
  });

  it("minkowski3 is not signed - a negative term must not cancel", () => {
    expect(distanceOf("minkowski3", 3, -3)).toBeGreaterThan(0);
    expect(distanceOf("minkowski3", 3, -3)).toBe(distanceOf("minkowski3", 3, 3));
  });
});

describe("voronoi at jitter 0 matches the game", () => {
  for (const key of Object.keys(fx.values)) {
    const [op, distanceType] = key.split(":");

    // `cellId` is a hash of the cell and needs the R2 RNG whatever the jitter, so
    // it cannot be closed by geometry. Skipped rather than faked - TASK 3 owns it.
    const run = op === "voronoi_cell_id" ? it.skip : it;

    run(`${op} / ${distanceType}`, () => {
      const v = makeVoronoi({
        seed0: fx.seed,
        seed1: fx.seed1,
        gridSize: fx.gridSize,
        jitter: fx.jitter,
        distanceType: distanceType as VoronoiDistanceType,
      });
      const call = {
        voronoi_cell_id: v.cellId,
        voronoi_spot_noise: v.spotNoise,
        voronoi_facet_noise: v.facetNoise,
        voronoi_pyramid_noise: v.pyramidNoise,
      }[op]!;
      const expected = fx.values[key];
      fx.positions.forEach((p, i) => {
        expect(f32(call(p.x, p.y)), `at (${String(p.x)}, ${String(p.y)})`).toBe(f32(expected[i]));
      });
    });
  }

  /**
   * The fixture carries 15 series, not 16, and this pins the reason so a future
   * re-capture cannot quietly "fix" the gap by inventing the missing one.
   */
  it("carries no pyramid_noise x minkowski3 series - the game rejects that pair", () => {
    expect(Object.keys(fx.values)).toHaveLength(15);
    expect(Object.keys(fx.values)).not.toContain("voronoi_pyramid_noise:minkowski3");
  });
});

describe("the restrictions are enforced rather than papered over", () => {
  const base = { seed0: 123456, seed1: 1, gridSize: 64, jitter: 0 } as const;

  it("pyramidNoise throws for minkowski3, naming the game's own restriction", () => {
    const v = makeVoronoi({ ...base, distanceType: "minkowski3" });
    expect(() => v.pyramidNoise(10, 10)).toThrow(/Minkowski3 distance is not supported/);
    // The other three ops are fine with minkowski3 - only pyramid is restricted.
    expect(() => v.spotNoise(10, 10)).not.toThrow();
    expect(() => v.facetNoise(10, 10)).not.toThrow();
  });

  it("cellId throws, naming Task 3", () => {
    const v = makeVoronoi({ ...base, distanceType: "euclidean" });
    expect(() => v.cellId(10, 10)).toThrow(/Task 3/);
  });

  it("makeVoronoi refuses a non-zero jitter instead of silently degrading", () => {
    expect(() => makeVoronoi({ ...base, jitter: 0.5, distanceType: "euclidean" })).toThrow(
      /jitter 0 only/,
    );
  });
});

/**
 * The properties that make the fixture trustworthy, asserted against it directly
 * so that a bad re-capture fails here rather than silently reshaping the model.
 */
describe("jitter-0 invariants hold in the captured ground truth", () => {
  it("spot_noise is EXACTLY 0 at every exact cell centre", () => {
    // `%` is a REMAINDER in JavaScript, not a modulo: it keeps the sign of the
    // dividend, so `-96 % 64` is `-32`, not `32`. A bare `p.x % gridSize` here
    // silently dropped all 16 negative-coordinate centres and checked 9 of 25 -
    // and the negative probes are the ones that exist to catch a truncate-vs-floor
    // cell lookup, so the guard was missing precisely the case it was written for.
    // The exact count is asserted below for the same reason: `> 0` cannot tell a
    // full sweep from a sixth of one.
    const mod = (t: number, m: number): number => ((t % m) + m) % m;
    const centres = fx.positions
      .map((p, i) => ({ p, i }))
      .filter(
        ({ p }) =>
          mod(p.x, fx.gridSize) === fx.gridSize / 2 && mod(p.y, fx.gridSize) === fx.gridSize / 2,
      );
    expect(centres.length).toBe(25);
    expect(centres.filter(({ p }) => p.x < 0 || p.y < 0).length).toBe(16);
    for (const dt of ["chebyshev", "manhattan", "euclidean", "minkowski3"]) {
      for (const { i } of centres) {
        expect(fx.values[`voronoi_spot_noise:${dt}`][i], `${dt} at index ${String(i)}`).toBe(0);
      }
    }
  });

  it("cell_id is constant within a cell and identical across distance types", () => {
    const byCell = new Map<string, Set<number>>();
    fx.positions.forEach((p, i) => {
      const k = `${String(Math.floor(p.x / fx.gridSize))},${String(Math.floor(p.y / fx.gridSize))}`;
      const s = byCell.get(k) ?? new Set<number>();
      s.add(fx.values["voronoi_cell_id:chebyshev"][i]);
      byCell.set(k, s);
    });
    expect(byCell.size).toBeGreaterThan(1);
    for (const [cell, ids] of byCell) expect(ids.size, `cell ${cell}`).toBe(1);

    for (const dt of ["manhattan", "euclidean", "minkowski3"]) {
      expect(fx.values[`voronoi_cell_id:${dt}`]).toEqual(fx.values["voronoi_cell_id:chebyshev"]);
    }
  });
});
