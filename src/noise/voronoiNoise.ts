/**
 * Factorio's `voronoi_*` noise primitives, **at `jitter = 0` only**.
 *
 * At jitter 0 every cell's point sits exactly at the cell centre, so the per-cell
 * RNG cannot move it and all four ops reduce to pure geometry. That is what makes
 * this rung portable without the hash: everything here is fitted against
 * `test/fixtures/oracle-voronoi-jitter0.seed123456.json`, captured from the real
 * 2.1.12 binary, and matches it exactly at f32 on all 175 sampled positions.
 *
 * Three things about this file are measurements rather than readings of the docs,
 * and each would be easy to get plausibly wrong:
 *
 * 1. **Everything is computed in GRID UNITS.** The docs say the returned distance
 *    "is based on the grid size" and that `tile_distance = grid_size * distance`,
 *    which reads like "compute the distance in tiles, then divide by grid_size".
 *    The two are algebraically identical and differ only in f32 rounding, and
 *    three of the four distance types cannot tell them apart. `minkowski3` can:
 *    dividing at the end scores 110/175 where dividing the deltas first scores
 *    175/175, because its cube root runs through fastapprox and amplifies the
 *    difference past one ulp. The disassembly agrees - the sample position is
 *    converted to grid units before the point loop.
 * 2. **`minkowski3` uses the game's fastapprox `log2`/`exp2` pair, not `Math.cbrt`.**
 *    An exact cube root scores 25/175. This costs ~1e-5 relative accuracy, which
 *    is a deliberate property of the game and not an approximation introduced here.
 * 3. **`voronoi_pyramid_noise` differs per distance type, and chebyshev is the odd
 *    one out** - see {@link makeVoronoi}. It is also the one op x distance_type
 *    pair the game refuses outright.
 *
 * `cellId` is deliberately not implemented: it is a hash of the cell and needs the
 * RNG whatever the jitter, which is Task 3's job.
 */

import { fastLog2, fastPow2 } from "./fastApprox";

const f32 = Math.fround;

/** f32(1/3), the exact multiplier the binary uses (`0x3eaaaaab`) for the cube root. */
const ONE_THIRD_F32 = f32(1 / 3);

export type VoronoiDistanceType = "chebyshev" | "manhattan" | "euclidean" | "minkowski3";

/** `(a * a) * a` with an f32 rounding at each step, matching the binary's two `fmul`s. */
function cubeF32(a: number): number {
  return f32(f32(a * a) * a);
}

/**
 * The four `distance_type` functions, from
 * `factorioLuaAPI/auxiliary/noise-expressions.html` (2.1.12), computed in f32
 * throughout because the game does.
 *
 * `minkowski3` takes `abs()` on both terms. The docs said otherwise until the
 * erratum at forums.factorio.com/viewtopic.php?p=685547, and the binary settles
 * it directly: `runInternal<3>` clears both lanes' sign bits with
 * `bic.2s v0, #0x80, lsl #24` before cubing. Without that a negative term would
 * cancel a positive one and the "distance" could reach zero away from any point.
 *
 * It then goes through the fastapprox pair rather than a real cube root -
 * `Math::log2f`, multiply by f32(1/3), `Math::exp2f` - which is worth ~1e-5
 * relative error and is required for a bit-exact match.
 */
export function distanceOf(dt: VoronoiDistanceType, dx: number, dy: number): number {
  const ax = f32(Math.abs(dx));
  const ay = f32(Math.abs(dy));
  switch (dt) {
    case "chebyshev":
      return f32(Math.max(ax, ay));
    case "manhattan":
      return f32(ax + ay);
    case "euclidean":
      return f32(Math.sqrt(f32(f32(ax * ax) + f32(ay * ay))));
    case "minkowski3": {
      const sum = f32(cubeF32(ax) + cubeF32(ay));
      // The binary guards the log with `fcmp s1, #0.0` / `b.eq`, returning the
      // zero it preloaded. log2(0) is -Infinity, so this is not defensive padding.
      if (sum === 0) return 0;
      return fastPow2(f32(fastLog2(sum) * ONE_THIRD_F32));
    }
  }
}

/** Parameters of one voronoi field. `jitter` must be 0 - see {@link makeVoronoi}. */
export interface VoronoiParams {
  readonly seed0: number;
  readonly seed1: number;
  readonly gridSize: number;
  readonly jitter: number;
  readonly distanceType: VoronoiDistanceType;
}

/** The four ops of one voronoi field, each sampled at a world position in tiles. */
export interface Voronoi {
  readonly cellId: (x: number, y: number) => number;
  readonly spotNoise: (x: number, y: number) => number;
  readonly facetNoise: (x: number, y: number) => number;
  readonly pyramidNoise: (x: number, y: number) => number;
}

/**
 * Two rings of neighbouring cells around the sample's own cell.
 *
 * One ring is provably enough at jitter 0 (the points are a regular lattice), so
 * this is a deliberate superset: it is what the fit was measured over, and it
 * keeps the search from being the thing that has to change first when Task 4
 * turns jitter on.
 */
const SEARCH_RING = 2;

/**
 * Build the four ops for a voronoi field **at jitter 0**.
 *
 * Throws for any other jitter rather than returning cell-centre values that would
 * be wrong by an unbounded amount: a silently-degraded field would render a
 * plausible Fulgora that passes its own tests, which is the failure this whole
 * exercise exists to avoid.
 */
export function makeVoronoi(p: VoronoiParams): Voronoi {
  if (p.jitter !== 0) {
    throw new Error(
      `makeVoronoi supports jitter 0 only (got ${String(p.jitter)}); ` +
        "a jittered field needs the per-cell RNG - Task 4.",
    );
  }
  const { gridSize, distanceType } = p;

  /**
   * The normalisation divisor. Measured, not assumed: the ratio of the distance
   * in tiles to the value the game reports is 64.0 at `grid_size = 64` across all
   * four distance types, so it is `gridSize` - not half of it, not the cell
   * diagonal. `test/voronoiNoise.spec.ts` fails on `gridSize * 2`.
   */
  const divisor = gridSize;

  /** The sample position in grid units, where the cell lattice has unit spacing. */
  const toGrid = (x: number, y: number): [number, number] => [f32(x / divisor), f32(y / divisor)];

  /** The two smallest distances to a lattice point, in grid units, ascending. */
  const twoNearest = (ux: number, uy: number): [number, number] => {
    const cx = Math.floor(ux);
    const cy = Math.floor(uy);
    let d1 = Infinity;
    let d2 = Infinity;
    for (let a = cx - SEARCH_RING; a <= cx + SEARCH_RING; a++) {
      for (let b = cy - SEARCH_RING; b <= cy + SEARCH_RING; b++) {
        // At jitter 0 the cell's point IS its centre. Confirmed rather than
        // assumed: spot_noise reads exactly 0 (not merely small) at all 25 of
        // the fixture's exact cell centres, for every distance type.
        const d = distanceOf(distanceType, f32(ux - (a + 0.5)), f32(uy - (b + 0.5)));
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    return [d1, d2];
  };

  /**
   * Distance from the sample to the nearest edge of its own cell, in grid units.
   * At jitter 0 every cell is the unit square, so this is the smallest of the
   * four in-cell fractional offsets.
   */
  const edgeDistance = (ux: number, uy: number): number => {
    const a = f32(ux - Math.floor(ux));
    const b = f32(uy - Math.floor(uy));
    return f32(Math.min(a, f32(1 - a), b, f32(1 - b)));
  };

  return {
    cellId: () => {
      throw new Error("cellId requires the R2 hash - Task 3");
    },

    spotNoise: (x, y) => twoNearest(...toGrid(x, y))[0],

    facetNoise: (x, y) => {
      const [d1, d2] = twoNearest(...toGrid(x, y));
      return f32(d2 - d1);
    },

    /**
     * "Like facet noise but the gradient is uniform and represents the distance
     * to the closest edge."
     *
     * **This genuinely differs per distance type, and it is CHEBYSHEV that is the
     * odd one out** - not manhattan, despite `computePyramidNoiseManhattan` being
     * the only per-type symbol in the binary. Manhattan and euclidean both return
     * the plain edge distance; chebyshev returns `sqrt(9/8)` times it, 6.07%
     * more.
     *
     * That factor is an artifact of the game's construction rather than geometry.
     * Under the Chebyshev metric with points at cell centres the Voronoi cells are
     * exactly the grid squares, so the true distance to the nearest edge is the
     * edge distance on the nose. The binary computes the pyramid as a
     * **point-to-segment** distance - project onto the edge, clamp the parameter
     * to [0, 1], then `fsqrt` the Euclidean distance to the result - and for
     * chebyshev the clamp bites, so the distance is taken to a segment ENDPOINT.
     * The output shows it: the values are exactly the hypotenuse of `edge` and
     * `edge / (2 * sqrt(2))`, which is where `sqrt(1 + 1/8)` comes from.
     *
     * It is written as a square root and not as a multiply by 1.06066 because
     * that distinction is measurable: multiplying by the f32 nearest constant
     * matches only 102 of 175 sampled positions, while the square root matches
     * all 175.
     *
     * **These formulas are fitted on a DEGENERATE configuration and must not be
     * extrapolated.** At jitter 0 every cell is a congruent unit square, so `d1`,
     * `d2`, the cell edges and `edge` are all rigid functions of the in-cell
     * fraction, and many different underlying algorithms collapse to identical
     * numbers. Reproducing jitter 0 exactly is therefore no evidence at all about
     * jitter > 0; the real algorithm is the clamped point-to-segment distance
     * described above. {@link makeVoronoi}'s `jitter !== 0` throw is what keeps
     * this from being reused where it has not been validated - that guard exists
     * for this reason, not as defensive padding.
     */
    pyramidNoise: (x, y) => {
      if (distanceType === "minkowski3") {
        throw new Error(
          "voronoi_pyramid_noise does not support minkowski3 - the game's own " +
            'expression compiler rejects it: "Voronoi pyramid noise with ' +
            'Minkowski3 distance is not supported".',
        );
      }
      const e = edgeDistance(...toGrid(x, y));
      if (distanceType !== "chebyshev") return e;
      return f32(Math.sqrt(f32(1.125 * f32(e * e))));
    },
  };
}
