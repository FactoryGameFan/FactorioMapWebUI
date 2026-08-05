import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-voronoi-jitter0.seed123456.json";
import cellIdFixture from "./fixtures/oracle-voronoi-cellid.multiseed.json";
import pointsFixture from "./fixtures/oracle-voronoi-points.seed123456.json";
import {
  cellRandom,
  distanceOf,
  makeVoronoi,
  pointForCell,
  type VoronoiDistanceType,
} from "../src/noise/voronoiNoise";

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

    // The four `voronoi_cell_id` series were skipped through Task 2 - they need
    // the per-cell RNG, which geometry cannot close. They run now, and they are a
    // genuinely independent check on `cellRandom`: this fixture was captured
    // separately, at a different seed1, and at 175 scattered positions rather
    // than at cell centres, so it also exercises the cell lookup itself.
    it(`${op} / ${distanceType}`, () => {
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

  /**
   * The jitter guard MOVED in R3; it did not go away.
   *
   * `makeVoronoi` used to throw for any non-zero jitter. `cellId`, `spotNoise`
   * and `facetNoise` are now validated bit-exact at jitter 0.6 / 0.8 / 1.0
   * (36 series x 175 positions, all exact), so the field-wide guard would now be
   * refusing configurations that are known good.
   *
   * `pyramidNoise` is the exception and keeps a guard of its own - see
   * {@link makeVoronoi}'s `pyramidNoise`. Its jitter-0 formula is the distance to
   * the nearest edge of a UNIT SQUARE, which is simply not what a jittered cell
   * looks like, and it scores **0 of 175** against the game at every jitter and
   * every distance type. Leaving it un-guarded would hand back a number that is
   * wrong by up to half the cell.
   */
  it("makeVoronoi accepts a jittered field, but pyramidNoise alone still refuses", () => {
    const jittered = makeVoronoi({ ...base, jitter: 0.6, distanceType: "euclidean" });
    expect(() => jittered.spotNoise(10, 10)).not.toThrow();
    expect(() => jittered.facetNoise(10, 10)).not.toThrow();
    expect(() => jittered.cellId(10, 10)).not.toThrow();
    expect(() => jittered.pyramidNoise(10, 10)).toThrow(/jitter 0/);
    // ...and it is still available at jitter 0, where it IS validated.
    expect(() =>
      makeVoronoi({ ...base, distanceType: "euclidean" }).pyramidNoise(10, 10),
    ).not.toThrow();
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

const cf = cellIdFixture as {
  gridSize: number;
  jitter: number;
  cells: { cx: number; cy: number }[];
  positions: { x: number; y: number }[];
  series: { seed0: number; seed1: number; values: number[] }[];
};

describe("cellRandom reproduces the game's per-cell draw", () => {
  for (const s of cf.series) {
    it(`seed0=${String(s.seed0)} seed1=${String(s.seed1)}`, () => {
      expect(s.values).toHaveLength(cf.cells.length);
      cf.cells.forEach((c, i) => {
        expect(
          f32(cellRandom(s.seed0, s.seed1, c.cx, c.cy)),
          `cell (${String(c.cx)}, ${String(c.cy)})`,
        ).toBe(f32(s.values[i]));
      });
    });
  }

  it("covers all 9 seed series over the full 16x16 cell block", () => {
    expect(cf.series).toHaveLength(9);
    expect(cf.cells).toHaveLength(256);
    // Negative cell indices are half the point of the capture - a hash that
    // mishandled two's complement would be invisible on a 0..15 block.
    expect(cf.cells.filter((c) => c.cx < 0 || c.cy < 0)).toHaveLength(192);
  });

  it("is not constant across cells", () => {
    for (const s of cf.series) expect(new Set(s.values).size).toBeGreaterThan(100);
  });

  it("changes with seed0 and with seed1", () => {
    const at = (seed0: number, seed1: number) =>
      cf.series.find((s) => s.seed0 === seed0 && s.seed1 === seed1)!.values;
    expect(at(123456, 0)).not.toEqual(at(1, 0));
    expect(at(123456, 0)).not.toEqual(at(123456, 1));
  });

  /**
   * `seed0` and `seed1` are added as one 32-bit word before anything else
   * touches them - read out of `VoronoiNoise::VoronoiNoise`, not guessed - so
   * `(123456, 1)` and `(123457, 0)` are the SAME field. That is a real property
   * of the game rather than a limitation here, and pinning it means a later
   * "fix" that separated the two seeds would fail loudly.
   */
  it("mixes seed0 and seed1 as a single 32-bit sum", () => {
    for (const c of cf.cells.slice(0, 16)) {
      expect(cellRandom(123456, 1, c.cx, c.cy)).toBe(cellRandom(123457, 0, c.cx, c.cy));
      expect(cellRandom(0xffffffff, 1, c.cx, c.cy)).toBe(cellRandom(0, 0, c.cx, c.cy));
    }
  });

  /**
   * The XOR combine makes exactly two pairs of cells collide, and the fixture
   * shows exactly two duplicate values per series - so this is the whole of the
   * degeneracy, not a sample of it. It is also the fingerprint that identified
   * the structure: `ror16(0) == 0` and `ror16(0xffffffff) == 0xffffffff`, so
   * both terms cancel for `(0, 0)` and for `(-1, -1)`.
   */
  it("collides on exactly the two cell pairs the XOR combine forces", () => {
    for (const s of cf.series) {
      const byValue = new Map<number, string[]>();
      s.values.forEach((v, i) => {
        const c = cf.cells[i];
        byValue.set(v, [...(byValue.get(v) ?? []), `${String(c.cx)},${String(c.cy)}`]);
      });
      const byName = (a: string, b: string) => a.localeCompare(b);
      const dupes = [...byValue.values()]
        .filter((a) => a.length > 1)
        .map((a) => [...a].sort(byName));
      expect(dupes.sort((a, b) => byName(a[0], b[0]))).toEqual([
        ["-1,-1", "0,0"],
        ["-1,0", "0,-1"],
      ]);
    }
  });

  /**
   * The Y coordinate is rotated 16 bits and X is not. Without that asymmetry the
   * combine would be `wang(cx) ^ wang(cy)`, which cancels on EVERY diagonal - so
   * this asserts the diagonals are distinct, which is the observable difference.
   */
  it("does not collapse on the diagonal - the Y rotation is load-bearing", () => {
    const s = cf.series[0];
    const at = (cx: number, cy: number) =>
      s.values[cf.cells.findIndex((c) => c.cx === cx && c.cy === cy)];
    const diagonal = [-8, -5, -2, 1, 3, 6, 7].map((k) => at(k, k));
    expect(new Set(diagonal).size).toBe(diagonal.length);
  });
});

describe("cellId reads the containing cell's draw", () => {
  it("agrees with cellRandom at every captured cell centre", () => {
    for (const s of cf.series) {
      const v = makeVoronoi({
        seed0: s.seed0,
        seed1: s.seed1,
        gridSize: cf.gridSize,
        jitter: cf.jitter,
        distanceType: "euclidean",
      });
      cf.positions.forEach((p, i) => {
        expect(f32(v.cellId(p.x, p.y)), `at (${String(p.x)}, ${String(p.y)})`).toBe(
          f32(s.values[i]),
        );
      });
    }
  });
});

// ---------------------------------------------------------------------------
// R3: jittered point placement.
// ---------------------------------------------------------------------------

const pf = pointsFixture as {
  seed: number;
  seed1: number;
  gridSize: number;
  series: {
    jitter: number;
    distanceType: string;
    cellX: number;
    cellY: number;
    lattice: { x: number; y: number }[];
    values: number[];
    cellIds: number[];
  }[];
  opPositions: { x: number; y: number }[];
  ops: Record<string, number[]>;
};

/**
 * The apex of `spot_noise`'s cone IS the point, so the lattice minimum recovers
 * it to lattice resolution - here half a tile in each axis, the lattice being
 * the 64x64 tile centres of one whole cell.
 *
 * **The `cellIds` filter is what makes that true, and it is not a nicety.**
 * `spot_noise` is the distance to the nearest point of ANY cell, so a
 * neighbour's point sitting just outside the boundary can own lattice positions
 * inside this cell and win the unrestricted argmin - in which case the recovered
 * "apex" would be a different cell's point and the test would be measuring the
 * wrong thing while still passing or failing for plausible-looking reasons. The
 * game's own `cell_id` says which point won where, so the argmin runs only over
 * the positions this cell actually owns.
 */
function apexOf(s: (typeof pf.series)[number]): { x: number; y: number } {
  const owner = cellRandom(pf.seed, pf.seed1, s.cellX, s.cellY);
  let best = -1;
  for (let i = 0; i < s.values.length; i++) {
    if (f32(s.cellIds[i]) !== owner) continue;
    if (best < 0 || s.values[i] < s.values[best]) best = i;
  }
  // A negative `best` would mean the cell owns NO lattice position, which cannot
  // happen (its own point is inside it) and would make the assertions below
  // vacuous by throwing on `undefined` instead of comparing anything.
  expect(
    best,
    `${s.distanceType} jitter ${String(s.jitter)} owns no lattice position`,
  ).toBeGreaterThanOrEqual(0);
  return s.lattice[best];
}

describe("pointForCell recovers the jittered point positions", () => {
  for (const s of pf.series) {
    it(`jitter ${String(s.jitter)} / ${s.distanceType} - point within half a lattice step`, () => {
      const got = pointForCell(pf.seed, pf.seed1, pf.gridSize, s.jitter, s.cellX, s.cellY);
      const apex = apexOf(s);
      expect(Math.abs(got.x - apex.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(got.y - apex.y)).toBeLessThanOrEqual(0.5);
    });
  }

  /**
   * **The load-bearing test.** Fulgora's `fulgora_cells` (manhattan) and
   * `fulgora_spots` (euclidean) pass identical seed / grid_size / jitter and are
   * meant to share one point field; if placement varied by distance type that
   * cache would have to be keyed by it.
   *
   * The empirical half is here. The structural half is stronger and lives in
   * {@link pointForCell}'s docblock: `VoronoiPoints`' constructor loads exactly
   * three fields from the `VoronoiNoise` it is handed - seed at +0x20, grid size
   * at +0x24, jitter at +0x28 - and `distance_type` is a byte at +0x26 that it
   * never reads. The point generator cannot see the distance type.
   */
  it("point placement does NOT depend on distance_type", () => {
    for (const jitter of [0.6, 0.8, 1]) {
      const m = pf.series.find((s) => s.distanceType === "manhattan" && s.jitter === jitter);
      const e = pf.series.find((s) => s.distanceType === "euclidean" && s.jitter === jitter);
      expect(m, `no manhattan series at jitter ${String(jitter)}`).toBeDefined();
      expect(e, `no euclidean series at jitter ${String(jitter)}`).toBeDefined();
      expect(m!.cellX).toBe(e!.cellX);
      expect(m!.cellY).toBe(e!.cellY);
      // Not "within a tolerance" - the recovered apexes are the SAME lattice
      // position, which is the strongest statement this instrument can make.
      expect(apexOf(m!)).toEqual(apexOf(e!));
    }
  });

  it("jitter 0 puts the point exactly at the cell centre", () => {
    const p = pointForCell(pf.seed, pf.seed1, pf.gridSize, 0, 3, 5);
    expect(p.x).toBe(3 * pf.gridSize + pf.gridSize / 2);
    expect(p.y).toBe(5 * pf.gridSize + pf.gridSize / 2);
  });

  /**
   * The 1/256 `MapPosition` grid cannot have displaced any probe in this
   * fixture, because every lattice coordinate is a multiple of 1/2 a tile.
   *
   * That is the reason this capture does NOT use `snapToMapPosition`: that
   * helper floors, and every negative probe committed before this one happened
   * to be exactly representable, so floor and truncate-toward-zero are
   * indistinguishable in all existing data. Rather than commit to a rounding
   * rule no fixture can discriminate, the lattice avoids needing one - and this
   * asserts the property rather than trusting the capture to have kept it.
   */
  it("every lattice position is exactly representable as a MapPosition", () => {
    let checked = 0;
    for (const s of pf.series) {
      for (const p of s.lattice) {
        expect(Number.isInteger(p.x * 256)).toBe(true);
        expect(Number.isInteger(p.y * 256)).toBe(true);
        checked++;
      }
    }
    // Exact, not `> 0`: 6 series x 64 x 64.
    expect(checked).toBe(6 * 64 * 64);
    // ...and the lattice must actually straddle the cell, or "within half a
    // lattice step" would be trivially satisfiable by a lattice one point wide.
    const xs = new Set(pf.series[0].lattice.map((p) => p.x));
    const ys = new Set(pf.series[0].lattice.map((p) => p.y));
    expect(xs.size).toBe(64);
    expect(ys.size).toBe(64);
  });
});

/**
 * The real acceptance bar: bit-exact f32 agreement with the game on every
 * captured series, which is what "locating the point to within half a tile"
 * emphatically is not.
 *
 * `voronoi_pyramid_noise` is excluded and that exclusion is asserted rather than
 * implicit - see the block below, and {@link makeVoronoi}'s `pyramidNoise`.
 */
describe("the jittered field matches the game exactly", () => {
  for (const key of Object.keys(pf.ops)) {
    const [op, distanceType, jitter] = key.split(":");
    if (op === "voronoi_pyramid_noise") continue;
    it(`${op} / ${distanceType} / jitter ${jitter}`, () => {
      const v = makeVoronoi({
        seed0: pf.seed,
        seed1: pf.seed1,
        gridSize: pf.gridSize,
        jitter: Number(jitter),
        distanceType: distanceType as VoronoiDistanceType,
      });
      const call = {
        voronoi_cell_id: v.cellId,
        voronoi_spot_noise: v.spotNoise,
        voronoi_facet_noise: v.facetNoise,
      }[op]!;
      const expected = pf.ops[key];
      pf.opPositions.forEach((p, i) => {
        expect(f32(call(p.x, p.y)), `at (${String(p.x)}, ${String(p.y)})`).toBe(f32(expected[i]));
      });
    });
  }

  it("covers all three jitters x four distance types for each of the three ported ops", () => {
    const covered = Object.keys(pf.ops).filter((k) => !k.startsWith("voronoi_pyramid_noise"));
    expect(covered).toHaveLength(3 * 3 * 4);
  });

  /**
   * **R3 finding, pinned so it cannot be forgotten or silently "fixed".**
   *
   * `voronoi_pyramid_noise`'s jitter-0 formula is the distance to the nearest
   * edge of the UNIT SQUARE. That is what a Voronoi cell is only when every
   * point sits at its centre; with the points scattered the cells are general
   * convex polygons and the square is not even an approximation. Measured
   * against the game it matches ZERO of 175 positions at every one of the nine
   * captured jitter x distance_type combinations, with errors up to about half a
   * cell.
   *
   * This is exactly the hazard the jitter-0 rung was warned about: that
   * configuration is degenerate, several different algorithms collapse onto the
   * same numbers there, and reproducing it exactly says nothing about jitter > 0.
   * Three of the four ops came through unchanged. This one did not.
   *
   * The test asserts the port REFUSES rather than that it is wrong by some
   * amount - a tolerance here would be an invitation to widen it.
   */
  it("pyramidNoise is refused at jitter > 0, because its jitter-0 formula is wrong there", () => {
    const pyramidKeys = Object.keys(pf.ops).filter((k) => k.startsWith("voronoi_pyramid_noise"));
    expect(pyramidKeys).toHaveLength(3 * 3);
    for (const key of pyramidKeys) {
      const [, distanceType, jitter] = key.split(":");
      const v = makeVoronoi({
        seed0: pf.seed,
        seed1: pf.seed1,
        gridSize: pf.gridSize,
        jitter: Number(jitter),
        distanceType: distanceType as VoronoiDistanceType,
      });
      expect(() => v.pyramidNoise(pf.opPositions[0].x, pf.opPositions[0].y)).toThrow(/jitter 0/);
    }
  });
});
