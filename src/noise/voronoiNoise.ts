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
 * `cellId` is the exception: it is a hash of the cell rather than geometry, so it
 * needs the per-cell RNG whatever the jitter. That RNG is {@link cellRandom}, and
 * it is NOT fitted on the degenerate configuration - it is read out of the binary
 * and validated against `oracle-voronoi-cellid.multiseed.json` (9 seed series x
 * 256 cells, all exact), so Task 4 can build the jittered point offsets on it.
 */

import { fastLog2, fastPow2 } from "./fastApprox";

const f32 = Math.fround;

/** f32(1/3), the exact multiplier the binary uses (`0x3eaaaaab`) for the cube root. */
const ONE_THIRD_F32 = f32(1 / 3);

export type VoronoiDistanceType = "chebyshev" | "manhattan" | "euclidean" | "minkowski3";

/**
 * Thomas Wang's 32-bit integer mix, which is the whole of the voronoi RNG.
 *
 * Read straight out of `NoiseOperations::VoronoiPoints::VoronoiPoints` in the
 * 2.1.12 arm64 binary - the six constants `0x7ed55d16`, `0xc761c23c`,
 * `0x165667b1`, `0xd3a2646c`, `0xfd7046c5`, `0xb55a4f09` appear there verbatim
 * as immediates. This primitive is **not** taus88: none of the seeding shapes
 * that solved `basis_noise` or `spot_noise` produce a consistent word here, and
 * a brute-force inversion over all 2^32 taus88 seed words found no additive
 * `(cellX, cellY)` lattice at all.
 *
 * Written with `| 0` at each step because the additions must wrap as `uint32`;
 * the shifts already do.
 */
function wangHash(a: number): number {
  a = (((a + 0x7ed55d16) | 0) + (a << 12)) | 0;
  a = a ^ 0xc761c23c ^ (a >>> 19);
  a = (((a + 0x165667b1) | 0) + (a << 5)) | 0;
  a = (((a + 0xd3a2646c) | 0) ^ (a << 9)) | 0;
  a = (((a + 0xfd7046c5) | 0) + (a << 3)) | 0;
  a = a ^ 0xb55a4f09 ^ (a >>> 16);
  return a >>> 0;
}

/** Rotate a `uint32` right by 16 - the binary's `ror w8, w8, #0x10` on the Y cell index. */
function ror16(a: number): number {
  return ((a >>> 16) | (a << 16)) >>> 0;
}

/**
 * The per-cell seed word: the field seed mixed with both cell coordinates.
 *
 * `seed0 + seed1` is a plain 32-bit sum, confirmed in the constructor rather
 * than inferred from a fit: `VoronoiNoise::VoronoiNoise` does
 * `w8 = asNoiseLayerID(seed1) + (uint)seed0` and stores it at `+0x20`. A string
 * `seed1` therefore enters as its `NoiseLayerID` (the crc32 this repo already
 * uses elsewhere), not as a byte - so `Noise::setSeed`'s `unsigned char` second
 * parameter, which is the hint the brief flagged, does not apply to this
 * primitive.
 *
 * **The Y coordinate is rotated by 16 bits and the X coordinate is not.** That
 * asymmetry is the only thing keeping the field from being degenerate, and the
 * fixture shows exactly what it buys: because the two terms are XORed, cells
 * `(0, 0)` and `(-1, -1)` collide (both reduce to the bare seed, since
 * `ror16(0) == 0` and `ror16(~0) == ~0`), as do `(-1, 0)` and `(0, -1)` - and
 * those two pairs are the ONLY duplicate values in each of the 9 captured
 * series. Without the rotation every diagonal `(k, k)` would collide with them.
 */
function cellSeed(seed0: number, seed1: number, cellX: number, cellY: number): number {
  const seed = (seed0 + seed1) >>> 0;
  return (seed ^ wangHash(cellX >>> 0) ^ wangHash(ror16(cellY >>> 0))) >>> 0;
}

/**
 * The per-cell random draw in `[0, 1)` - what `voronoi_cell_id` returns, and the
 * value Task 4 needs for the jittered point offset.
 *
 * The binary draws THREE numbers per cell off the same word, as `wangHash(w)`,
 * `wangHash(w + 1)` and `wangHash(w + 2)` - the first two are the point's x and
 * y offset within the cell, and the third is the id. (The compiler folds the
 * `+1` / `+2` into the hash's first addend, which is why `0x7ed56d17` and
 * `0x7ed57d18` appear in the disassembly alongside `0x7ed55d16`.) So the id is
 * `+ 2`, and using `+ 0` would silently hand back the x offset.
 *
 * The conversion is `(double)u32 * 2^-32` narrowed to f32, exactly as the binary
 * does it (`ucvtf d0, w8` / `fmul` by `0x3df0000000000000` / `fcvt s14, d0`).
 * Doing the multiply in f32 would round twice.
 */
/**
 * Which of the three draws off a cell's word to take.
 *
 * The draw index is a parameter rather than three copies of the decode because
 * the Wang mix must exist in exactly one place - Task 4 needs draws 0 and 1 for
 * the point offset while `voronoi_cell_id` needs draw 2, and a second transcription
 * of six magic constants is precisely the kind of divergence that renders a
 * plausible-but-wrong Fulgora.
 */
export type CellDraw = 0 | 1 | 2;

/** Draw 0: the point's x offset within its cell. */
export const CELL_DRAW_OFFSET_X: CellDraw = 0;
/** Draw 1: the point's y offset within its cell. */
export const CELL_DRAW_OFFSET_Y: CellDraw = 1;
/** Draw 2: the value `voronoi_cell_id` reports. The default, for compatibility. */
export const CELL_DRAW_ID: CellDraw = 2;

export function cellRandom(
  seed0: number,
  seed1: number,
  cellX: number,
  cellY: number,
  draw: CellDraw = CELL_DRAW_ID,
): number {
  const w = cellSeed(seed0, seed1, cellX, cellY);
  return f32(wangHash((w + draw) >>> 0) / 2 ** 32);
}

/**
 * Where a cell's point actually sits, in **world tiles**.
 *
 * Read out of `NoiseOperations::VoronoiPoints::VoronoiPoints` in the 2.1.12
 * arm64 binary rather than fitted. Draws 0 and 1 come off the cell's word (see
 * {@link cellRandom}) and are turned into an in-cell offset by a single 2-lane
 * sequence - one lane per axis, so x and y are handled identically:
 *
 * ```
 * fmul.2s  v1, v1, v0[0]   ; * jitter
 * fsub     s0, s11, s0     ; s11 = 1.0   (fmov s11, #1.00000000)
 * fmul     s0, s0, s12     ; s12 = 0.5   (fmov s12, #0.50000000)
 * fadd.2s  v13, v1, v0     ; jitter * r + (1 - jitter) * 0.5
 * ```
 *
 * Two details are load-bearing and neither is guessable from the docs:
 *
 * - **`jitter` is narrowed to f32 first.** The prototype field is written by
 *   `ldr d0, [x20, #0x88]` / `fcvt s0, d0` / `str s0, [x19, #0x28]`, so a Lua
 *   `jitter = 0.6` is stored as `f32(0.6)` and every arithmetic step below is
 *   f32. Carrying the double through instead is wrong in the last ulp, which is
 *   exactly the size of error that gets absorbed into a fudge factor.
 * - **The constructor stores the in-cell FRACTION only** (`str d13, [x22]`, two
 *   f32, followed by the id at `+0x8`); the cell index is added by the consumer.
 *   The offset is therefore in grid units, and this function scales it by
 *   `gridSize` to return tiles.
 *
 * At `jitter === 0` this collapses to exactly `0.5`, independently confirming
 * the cell-centre premise the jitter-0 rung was built on.
 *
 * **Point placement does NOT depend on `distance_type`, and that is settled
 * structurally, not by a fit.** `VoronoiPoints`' constructor is handed the whole
 * `VoronoiNoise` and loads exactly three fields from it across its entire 1508
 * bytes: `+0x20` (seed, `ldr w9`), `+0x24` (grid size, `ldr h0`) and `+0x28`
 * (jitter, `ldr s0`). `distance_type` is a byte at `+0x26` - written by
 * `VoronoiNoise`'s own constructor as `bl parseDistanceType` / `strb w0, [x19,
 * #0x26]` - and is never read by the point generator at all. The fixture agrees:
 * the inverted apexes are identical under manhattan and euclidean at every
 * jitter. So one point field can be shared across ops that differ only in
 * distance type, which is what Fulgora's `fulgora_cells` (manhattan) and
 * `fulgora_spots` (euclidean) do.
 */
export function pointForCell(
  seed0: number,
  seed1: number,
  gridSize: number,
  jitter: number,
  cellX: number,
  cellY: number,
): { x: number; y: number } {
  const o = pointOffsetInCell(seed0, seed1, jitter, cellX, cellY);
  return { x: cellX * gridSize + gridSize * o.x, y: cellY * gridSize + gridSize * o.y };
}

/**
 * The in-cell fraction {@link pointForCell} is built from, in **grid units** -
 * literally the pair of f32s the constructor stores.
 *
 * Everything downstream works in grid units (see this file's header, point 1),
 * so the search loop adds this to an integer cell index directly rather than
 * going out to tiles and back.
 */
function pointOffsetInCell(
  seed0: number,
  seed1: number,
  jitter: number,
  cellX: number,
  cellY: number,
): { x: number; y: number } {
  const j = f32(jitter);
  const base = f32(f32(1 - j) * 0.5);
  const offset = (draw: CellDraw): number =>
    f32(f32(j * cellRandom(seed0, seed1, cellX, cellY, draw)) + base);
  return { x: offset(CELL_DRAW_OFFSET_X), y: offset(CELL_DRAW_OFFSET_Y) };
}

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

/** Parameters of one voronoi field. */
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
 * One ring is provably enough for `jitter <= 1`: the offset
 * `jitter * r + (1 - jitter) * 0.5` with `r` in `[0, 1)` stays inside `[0, 1)`
 * for any jitter in `[0, 1]`, so every point lies within its own cell and the
 * nearest two are always in the 3x3 neighbourhood. Two rings is a deliberate
 * superset - it is what both the jitter-0 and the jittered fits were measured
 * over, and it costs 25 distance evaluations instead of 9.
 */
const SEARCH_RING = 2;

/**
 * Build the four ops for a voronoi field, at any `jitter` in `[0, 1]`.
 *
 * This threw for `jitter !== 0` until R3. The guard is gone because the jittered
 * path is now validated the same way the jitter-0 path was - bit-exact f32
 * against the game, over `oracle-voronoi-points.seed123456.json`'s 45 series -
 * and not merely because the point formula is known.
 */
export function makeVoronoi(p: VoronoiParams): Voronoi {
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

  /**
   * The sample-to-point delta in grid units, **rebased on the sample's own
   * cell** - and that rebasing is load-bearing at f32, not a tidy-up.
   *
   * `runInternal<0>` computes the sample's in-cell fraction ONCE, then forms
   * each neighbour's delta from that fraction and the neighbour's RELATIVE index:
   *
   * ```
   * 101772528: scvtf s25, w30      ; (float) the sample's own cell index
   * 10177252c: fsub  s23, s23, s25 ; sampleFrac = ux - cellIndex
   * ...
   * 101772598: scvtf s27, w12      ; (float) the neighbour's RELATIVE index
   * 1017725a0: ldp   s28, s29, [x21] ; the neighbour's stored in-cell fraction
   * 1017725a4: fadd  s28, s28, s1  ; frac + relative index
   * 1017725ac: fabd  s28, s28, s23 ; |that - sampleFrac|
   * ```
   *
   * Forming the same delta from ABSOLUTE coordinates (`ux - (cell + frac)`) is
   * algebraically identical and differs in the last ulp, because `cell + frac`
   * at a cell index of ~11 has an f32 spacing of 2^-20 while the rebased form
   * never adds a large number to a small one. Measured over this fixture's 4200
   * spot and facet samples: the absolute form scores **3734/4200**, the rebased
   * form **4200/4200**. All the misses are exactly one ulp, which is precisely
   * the size of error that gets mistaken for an accumulation artifact and
   * papered over.
   *
   * The point itself is unchanged either way - `cell_id` was already 175/175 on
   * all 12 of its series under the absolute form, because a one-ulp shift almost
   * never changes WHICH point is nearest. So the exact-value test is what caught
   * this; an argmin test never could have.
   */
  const deltaTo = (sampleFrac: number, rel: number, offset: number): number =>
    f32(f32(offset + rel) - sampleFrac);

  /**
   * The two smallest distances to a cell point, in grid units, ascending, plus
   * the nearest point's cell - `cell_id` reports the cell that OWNS the sample,
   * which at jitter > 0 need not be the containing cell, so the argmin has to
   * come out of the same search rather than a second one that could disagree.
   */
  const search = (
    ux: number,
    uy: number,
  ): { d1: number; d2: number; cellX: number; cellY: number } => {
    const cx = Math.floor(ux);
    const cy = Math.floor(uy);
    const sfx = f32(ux - cx);
    const sfy = f32(uy - cy);
    let d1 = Infinity;
    let d2 = Infinity;
    let bx = cx;
    let by = cy;
    for (let a = -SEARCH_RING; a <= SEARCH_RING; a++) {
      for (let b = -SEARCH_RING; b <= SEARCH_RING; b++) {
        // At jitter 0 every offset is exactly 0.5, so this reduces to the cell
        // centre with no special case - confirmed rather than assumed, since
        // `spot_noise` reads exactly 0 (not merely small) at all 25 of the
        // jitter-0 fixture's exact cell centres, for every distance type.
        const o = pointOffsetInCell(p.seed0, p.seed1, p.jitter, cx + a, cy + b);
        const d = distanceOf(distanceType, deltaTo(sfx, a, o.x), deltaTo(sfy, b, o.y));
        if (d < d1) {
          d2 = d1;
          d1 = d;
          bx = cx + a;
          by = cy + b;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    return { d1, d2, cellX: bx, cellY: by };
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
    /**
     * The draw of whichever cell OWNS the sample - the cell whose point is
     * nearest, which at jitter > 0 need not be the containing cell.
     *
     * At jitter 0 the two always coincide, which is why this used to read
     * `Math.floor(ux)` directly with no search. That shortcut is exactly the kind
     * of degeneracy the jitter-0 rung could not discriminate.
     */
    cellId: (x, y) => {
      const s = search(...toGrid(x, y));
      return cellRandom(p.seed0, p.seed1, s.cellX, s.cellY);
    },

    spotNoise: (x, y) => search(...toGrid(x, y)).d1,

    facetNoise: (x, y) => {
      const s = search(...toGrid(x, y));
      return f32(s.d2 - s.d1);
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
      // **R3 finding: this formula is WRONG for jitter > 0, and measurably so.**
      // `edgeDistance` is the distance to the nearest edge of the UNIT SQUARE,
      // which is what a cell is only when every point sits at its centre. With
      // the points scattered the cells are general convex polygons and the
      // square is not even an approximation: scored against the game it is
      // **0 of 175** at every one of the nine jitter x distance_type
      // combinations captured, with errors up to 0.49 in grid units - about half
      // a cell.
      //
      // That is exactly the outcome this file's header warned about: the
      // jitter-0 rung is degenerate, several different algorithms collapse onto
      // the same numbers there, and reproducing it exactly is no evidence at all
      // about jitter > 0. The other three ops came through unchanged; this one
      // did not, and it is a real finding rather than a rounding problem.
      //
      // It throws instead of returning the square's answer because a
      // half-cell-wrong number that still looks like a plausible pyramid is
      // precisely the failure mode the whole exercise exists to avoid. Solving
      // it needs the real clamped point-to-segment distance over the cell's
      // actual polygon, which is its own rung of work and is not needed by
      // Fulgora (`fulgora_cells` and `fulgora_spots` use facet and spot noise).
      if (p.jitter !== 0) {
        throw new Error(
          `voronoi_pyramid_noise is validated at jitter 0 only (got ${String(p.jitter)}); ` +
            "its unit-square edge distance scores 0/175 against the game at every " +
            "jitter > 0 captured - see the comment here before using it.",
        );
      }
      const e = edgeDistance(...toGrid(x, y));
      if (distanceType !== "chebyshev") return e;
      return f32(Math.sqrt(f32(1.125 * f32(e * e))));
    },
  };
}
