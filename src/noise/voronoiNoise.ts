/**
 * Factorio's `voronoi_*` noise primitives - all four ops, for any `jitter` in
 * `[0, 1]`.
 *
 * **Full RE record: `docs/noise/voronoi-NOTES.md`** - the disassembly addresses,
 * the models that were tried and refuted, and the method behind every number
 * quoted below. This file carries the findings at their sites; that one carries
 * how they were established. Companions: `docs/noise/basis-noise-NOTES.md`,
 * `docs/noise/spot-noise-NOTES.md`.
 *
 * Everything here is validated bit-exact at f32 against the real 2.1.12 binary:
 * `oracle-voronoi-jitter0.seed123456.json` (15 series x 175 positions at jitter
 * 0) and `oracle-voronoi-points.seed123456.json` (45 series x 175 positions at
 * jitter 0.6 / 0.8 / 1.0, plus an inversion lattice that recovers the point
 * positions themselves).
 *
 * **The jitter-0 rung is DEGENERATE and turning jitter on is what discriminates.**
 * At jitter 0 every cell is a congruent unit square, so many different underlying
 * algorithms collapse onto identical numbers - reproducing it exactly is no
 * evidence at all about jitter > 0. Two things came out of actually testing it,
 * and both are recorded at their sites rather than here:
 *
 * - the sample-to-point delta has to be rebased on the sample's own cell (the
 *   best absolute form is off by exactly one ulp on 466 of 4200 samples - see
 *   `deltaTo` in {@link makeVoronoi} for the scores of each variant), and
 * - `voronoi_pyramid_noise`'s jitter-0 formula was the unit-square edge distance,
 *   which is simply wrong once the cells are not squares - 0 of 175 at every
 *   jitter x distance_type captured. It was replaced wholesale by a reading of
 *   `runInternal<0..2>`; see `pyramid` in {@link makeVoronoi}.
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
 *    one out** - by one hardcoded `0.75` where an isometry wants `1/sqrt(2)`; see
 *    {@link CHEBYSHEV_FRAME}. It is also the one op whose answer depends on the
 *    per-distance-type search range ({@link pointsSearchRange}), and the one op x
 *    distance_type pair the game refuses outright.
 *
 * Nothing in this file is fitted on the degenerate configuration. The per-cell
 * RNG ({@link cellRandom}) and the point offset ({@link pointForCell}) are both
 * read out of the binary and then confirmed against the game - the RNG against
 * `oracle-voronoi-cellid.multiseed.json` (9 seed series x 256 cells, all exact).
 */

import { f32 } from "./eval/f32";
import { memoXY } from "./eval/memoXY";
import { fastLog2, fastPow2 } from "./fastApprox";

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

/**
 * The per-cell random draw in `[0, 1)` - the value `voronoi_cell_id` returns and
 * the two the jittered point offset is built from.
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
  /**
   * Force the neighbour search ring for **every** op, overriding
   * {@link pointsSearchRange}. **Nothing that renders a map may set this.**
   *
   * It exists so `test/voronoiSearchRange.spec.ts` can plant the WRONG ring and
   * watch the committed game values reject it. Without a hook the alternative is
   * a second copy of the pyramid loop inside the spec, which could drift from
   * this one and would then be testing itself rather than the port - and the
   * whole point of that spec is that `pointsSearchRange` had no non-vacuous test
   * at all until it was written.
   *
   * Until 2026-08-05 this reached `pyramidNoise` alone, so planting a ring on a
   * `d1`/`d2`/`cell_id` field silently did nothing - the hook was lying about
   * its own scope. It is honoured at a single site now ({@link makeVoronoi}'s
   * `searchRing`), which is what keeps that from recurring.
   */
  readonly searchRangeOverride?: 1 | 2;
}

/** The four ops of one voronoi field, each sampled at a world position in tiles. */
export interface Voronoi {
  readonly cellId: (x: number, y: number) => number;
  /**
   * The winning cell's integer lattice coordinates - the STABLE identity of a
   * cell, as opposed to `cellId`, which hashes this pair into `[0, 1)` and can
   * therefore collide between two distinct cells. Anything grouping samples by
   * "which cell am I in" must use this; `cellId` is for the game's own
   * expressions, which only ever consume the float.
   */
  readonly cellIndex: (x: number, y: number) => { cellX: number; cellY: number };
  readonly spotNoise: (x: number, y: number) => number;
  readonly facetNoise: (x: number, y: number) => number;
  readonly pyramidNoise: (x: number, y: number) => number;
}

/**
 * The game's own `VoronoiNoise::getPointsSearchRange()`, which is **per distance
 * type**. Read from the binary, and now confirmed against the game in both
 * directions by `test/voronoiSearchRange.spec.ts`.
 *
 * Read out of `0x101774fd4` in the 2.1.12 arm64 binary: a jump table at
 * `0x102d00a88` holding `[13, 0, 3, 8]` indexed by `DistanceType`, based at
 * `0x101775008`. Entry 0 (chebyshev) branches straight past the compare to the
 * epilogue with `w0` still holding the `mov w0, #1` from before the table, so
 * chebyshev is **pinned at 1**; the other three fall into
 * `fcmp jitter, <threshold>` / `csinc w0, #2, wzr, gt`, i.e. `> threshold ? 2 : 1`.
 * The thresholds are the immediates `#0.5`, `0x3f28f5c3` (= `f32(0.66)`) and
 * `#0.75`. The identical sequence is inlined at the top of every `runInternal`
 * (its own table at `0x102d00a74`), and both the generated point region and the
 * `[-range, +range]` loop bounds use the result.
 *
 * **It was inert until 2026-08-05, and finding the positions where it is not was
 * a task of its own.** Forcing it to 2 for all four distance types passed 95/95
 * voronoi tests, and forcing it to 1 also passed 95/95: all 2100 committed
 * values were indifferent to it, in both directions. `oracle-voronoi-search-
 * range.seed123456.json` is the fixture that ends that, and the whole argument
 * for where to look lives in its capture function and in
 * `test/voronoiSearchRange.spec.ts`. The short version:
 *
 * - Only `voronoi_pyramid_noise` can see the ring at all. `spot`/`facet`/
 *   `cell_id` need a ring-2 point to WIN the argmin; the pyramid only needs one
 *   to be nearly EQUIDISTANT, because it minimises the distance to each pair's
 *   bisector, which for euclidean is `(|f|^2 - |n|^2) / (2 |f - n|)`.
 * - The disagreements are rare - **553 of 16777216** for chebyshev at jitter 1,
 *   over a 4096x4096-tile window at origin `(0, 0)`, stride 1 tile, `seed0`
 *   123456 / `seed1` 0 / `gridSize` 175 (re-measured 2026-08-05; the same window
 *   reads 145 at stride 2 and 39 at stride 4, so the stride is not optional
 *   detail). That ~3.3e-5 density is why 175-position grids never hit one.
 * - **The thresholds themselves are NOT behaviourally pinned.** A disagreement
 *   needs high jitter; sweeps at manhattan 0.5 and euclidean f32(0.66) found
 *   zero. The fixture bounds manhattan's threshold below 0.7 and euclidean's
 *   below 0.9, and that is all the game will say. The exact values `0.5` /
 *   `f32(0.66)` / `0.75` rest on the disassembly plus the weaker table test in
 *   that spec - which is labelled as weaker there.
 *
 * Do not "simplify" this to a constant. Searching two rings unconditionally
 * changes `voronoi_pyramid_noise` for chebyshev, which is Fulgora's
 * `fulgora_road_pyramids`.
 *
 * **Every Fulgora call site, and what each one is exposed to.** This is the
 * complete list from the pinned 2.1.12
 * `space-age/prototypes/planet/planet-fulgora-map-gen.lua`, each row read at the
 * cited line rather than recalled: the three jitters are `fulgora_jitter = 0.6`
 * (:140), `fulgora_road_jitter = 1` (:405) and `fulgora_structure_jitter = 0.8`
 * (:447). Every op now walks the range this function returns, so "port ring" is
 * no longer a separate column - it was one until 2026-08-05, when the three
 * point ops walked a hardcoded 5x5 block instead.
 *
 * | expression | op | dt / jitter | range |
 * | --- | --- | --- | --- |
 * | `fulgora_cells` (:145) | cell_id | manhattan 0.6 | 2 |
 * | `fulgora_pyramids` (:156) | pyramid | manhattan 0.6 | 2 |
 * | `fulgora_spots` (:167) | spot (d1) | euclidean 0.6 | **1** |
 * | `fulgora_road_cells` (:410) | cell_id | chebyshev 1 | **1** |
 * | `fulgora_road_pyramids` (:421) | pyramid | chebyshev 1 | **1** |
 * | `fulgora_structure_cells` (:452) | cell_id | minkowski3 0.8 | 2 |
 * | `fulgora_structure_facets` (:474) | **facet (d2)** | minkowski3 0.8 | 2 |
 *
 * **Adopting it for the point ops moved no value**, which was measured before
 * the change rather than assumed: over a 1400x1400-tile window at stride 1 tile
 * (1960000 positions) at `seed0` 123456 / `seed1` 0 / `gridSize` 175, `spot`,
 * `facet` and `cell_id` are identical at ring 1 and ring 2 in **all six**
 * configurations whose game range is 1. What it buys is faithfulness to the
 * binary plus the two bolded range-1 rows above dropping from 25 cells searched
 * to 9 - measured at **1.7x** (`fulgora_spots`, 94ms -> 55ms) and **2.3x**
 * (`fulgora_road_cells`, 108ms -> 46ms) over a 700x700 sweep.
 *
 * It does **not** fix a wrong answer, and a note here previously predicted it
 * would ("a latent wrong answer for chebyshev facet fields"). That prediction is
 * refuted: chebyshev `facet` agrees at every one of those 1960000 positions. The
 * `d2` op genuinely can see the ring - manhattan at jitter 1 differs at 828 of
 * them - but the game's range there is 2, so the old fixed ring was already
 * right at that configuration.
 */
export function pointsSearchRange(dt: VoronoiDistanceType, jitter: number): 1 | 2 {
  const j = f32(jitter);
  switch (dt) {
    case "chebyshev":
      return 1;
    case "manhattan":
      return j > 0.5 ? 2 : 1;
    case "euclidean":
      return j > f32(0.66) ? 2 : 1;
    case "minkowski3":
      return j > 0.75 ? 2 : 1;
  }
}

/** A point in the sample's grid-unit frame, as the binary's `Vector2f` pairs. */
type Vec2 = readonly [number, number];

/**
 * The Euclidean distance from `s` to the **L1 bisector** of `a` and `b` - the
 * whole of `NoiseOperations::VoronoiNoise::computePyramidNoiseManhattan`
 * (`0x1017758b8`), transcribed instruction for instruction.
 *
 * The name is about which metric's *bisector* is built, not which metric the
 * answer is in: the returned number is a plain `fsqrt` of a squared Euclidean
 * distance. Under L1 the set of points equidistant from `a` and `b` is a
 * polyline - a 45-degree segment flanked by two axis-parallel rays - and the
 * routine builds all three pieces and takes the nearest.
 *
 * Reading the layout: the binary picks a MAJOR axis (the one with the larger
 * separation, x winning ties) with `cset w8, eq` / `cset w9, ne` and then
 * addresses every vector through `bfi x, w8/w9, #2, #1`. `w9` is the major
 * index and `w8` the minor, so this is written as `maj` / `mnr` index math
 * rather than as x/y, which is what makes the two axes provably symmetric.
 *
 * - `p1` and `p2` are the ends of the diagonal segment: each is `a` (resp. `b`)
 *   with its major component replaced by `mid[maj] +/- half the minor
 *   separation`. Checked against the closed form: for `a = (0,0)`,
 *   `b = (dx, dy)` with `dx > |dy| > 0`, the L1 bisector is
 *   `x = (dx + dy)/2 - y` over `y` in `[0, dy]`, whose ends are exactly these.
 * - `q` is the clamped foot on that segment, `r` and `t` the clamped feet on the
 *   two rays, which run along the MINOR axis in direction `sgn`.
 *
 * Two f32 details that a tidier rewrite would lose:
 *
 * - the clamps are `fmaxnm`/`fminnm`, which return the non-NaN operand. A
 *   degenerate segment gives `0/0 = NaN` for `t`, and `fmaxnm(NaN, 0)` is `0` -
 *   so the NaN checks here are the binary's behaviour, not defensive padding.
 * - `p1[mnr]` is `a[mnr]` and `p2[mnr]` is `b[mnr]` by construction, but the
 *   binary re-loads them from the `p` copies, so the ray parameters are formed
 *   against those and not against `a`/`b`.
 *
 * One deviation that is deliberate and already checked, so nobody re-discovers
 * it as a defect: the `Math.min`/`Math.max` pairs here stand in for the binary's
 * `fcsel mi`/`fcsel gt`, which differ only on NaN operands and on the ordering
 * of `+0` against `-0`. Neither input can be NaN (the points are finite), and a
 * `+0`/`-0` disagreement cancels: the only place the choice is observable is
 * `sepX`/`sepY`, which immediately square their result.
 */
function bisectorDistanceL1(a: Vec2, b: Vec2, s: Vec2): number {
  const mid: [number, number] = [f32(f32(a[0] + b[0]) * 0.5), f32(f32(a[1] + b[1]) * 0.5)];
  const hi: [number, number] = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const sepX = f32(Math.min(a[0], b[0]) - hi[0]);
  const sepY = f32(Math.min(a[1], b[1]) - hi[1]);
  // `fcsel s1, s0, s1, gt` then `cset w8, eq`: x is major on a tie.
  const maj = f32(sepY * sepY) > f32(sepX * sepX) ? 1 : 0;
  const mnr = 1 - maj;

  // `fcmp s2, s3` compares b[maj] against a[maj], and its flags drive BOTH the
  // sign chosen for p1 and (still live, 44 bytes later) the one for p2.
  const rising = b[maj] > a[maj];
  const h1 = f32(Math.abs(f32(a[mnr] - mid[mnr])));
  const h2 = f32(Math.abs(f32(b[mnr] - mid[mnr])));
  const p1: [number, number] = [a[0], a[1]];
  p1[maj] = f32(mid[maj] + (rising ? h1 : -h1));
  const p2: [number, number] = [b[0], b[1]];
  p2[maj] = f32(mid[maj] + (rising ? -h2 : h2));

  // `fcsel s6, 1.0, -1.0, eq` on `a[mnr] == max(a[mnr], b[mnr])`.
  const sgn = a[mnr] === hi[mnr] ? 1 : -1;
  const ray: [number, number] = [0, 0];
  ray[mnr] = sgn;

  const dx = f32(p2[0] - p1[0]);
  const dy = f32(p2[1] - p1[1]);
  const dot = f32(f32(dx * f32(s[0] - p1[0])) + f32(dy * f32(s[1] - p1[1])));
  const len2 = f32(f32(dx * dx) + f32(dy * dy));
  const raw = f32(dot / len2);
  const t = Number.isNaN(raw) ? 0 : f32(Math.min(Math.max(raw, 0), 1));
  const q: Vec2 = [f32(p1[0] + f32(dx * t)), f32(p1[1] + f32(dy * t))];

  const uRaw = f32(sgn * f32(s[mnr] - p1[mnr]));
  const u = Number.isNaN(uRaw) ? 0 : Math.max(uRaw, 0);
  const r: Vec2 = [f32(p1[0] + f32(ray[0] * u)), f32(p1[1] + f32(ray[1] * u))];

  const vRaw = f32(-f32(sgn * f32(s[mnr] - p2[mnr])));
  const v = Number.isNaN(vRaw) ? 0 : Math.max(vRaw, 0);
  const w: Vec2 = [f32(p2[0] - f32(ray[0] * v)), f32(p2[1] - f32(ray[1] * v))];

  const sq = (p: Vec2): number =>
    f32(f32(f32(p[0] - s[0]) * f32(p[0] - s[0])) + f32(f32(p[1] - s[1]) * f32(p[1] - s[1])));
  const qd = sq(q);
  const rd = sq(r);
  const wd = sq(w);
  const rays = rd < wd ? rd : wd;
  return f32(Math.sqrt(qd < rays ? qd : rays));
}

/**
 * The 45-degree map `runInternal<0>` puts chebyshev through before handing the
 * pair to {@link bisectorDistanceL1} - **and the constant is `0.75`, not `0.5`.**
 *
 * L-infinity becomes L1 under a 45-degree rotation, so mapping the points this
 * way and then building an L1 bisector is the right construction, and the
 * bisector itself does not care what `k` is - the matrix `[[k, k], [-k, k]]` is
 * `k * sqrt(2)` times a rotation for any `k`, and scaling both points scales the
 * bisector with them. What `k` does control is the Euclidean distance the
 * routine then reports: it comes back multiplied by `k * sqrt(2)`. The isometric
 * choice is therefore `k = 1/sqrt(2) = 0.70710678`.
 *
 * The game uses `fmov s16, #0.75000000` (`0x101772414`, inside
 * `VoronoiNoise::runInternal<DistanceType 0>`; `0x101772864` is the first of the
 * `fmul ..., s16` uses, not the definition), and
 * `0.75 * sqrt(2) = 1.06066... = sqrt(9/8)`, so every chebyshev pyramid value is
 * `sqrt(9/8)` times the true distance to the cell boundary - 6.07% too large.
 *
 * **That is the whole explanation of chebyshev's `sqrt(9/8)` factor**, which
 * Task 2 measured at jitter 0 and attributed to a clamp biting at a segment
 * endpoint. The number was right and the mechanism was not: it is one hardcoded
 * immediate, it applies at every jitter, and nothing about it is geometry.
 */
const CHEBYSHEV_FRAME = 0.75;

function toChebyshevFrame(x: number, y: number): Vec2 {
  const kx = f32(x * CHEBYSHEV_FRAME);
  const ky = f32(y * CHEBYSHEV_FRAME);
  return [f32(kx + ky), f32(ky - kx)];
}

/**
 * Build the four ops for a voronoi field, at any `jitter` in `[0, 1]`.
 *
 * This threw for `jitter !== 0` until R3. The guard is gone because the jittered
 * path is now validated the same way the jitter-0 path was - bit-exact f32
 * against the game, over `oracle-voronoi-points.seed123456.json`'s 45 series -
 * and not merely because the point formula is known.
 */
export function makeVoronoi(p: VoronoiParams): Voronoi {
  const { distanceType } = p;

  /**
   * **`grid_size` is a 16-bit UNSIGNED INTEGER, so a fractional argument is
   * TRUNCATED** - and that is measured against the game, not read off the type.
   *
   * It went untested for a long time because nothing exercised it: every
   * committed voronoi fixture uses an integral grid (175, 64), where truncation
   * is a no-op. Fulgora is what made it reachable - `fulgora_grid` is
   * `175 - slider_to_linear(control:fulgora_islands:frequency, -50, 50)`, which
   * is a genuine float anywhere except the two slider endpoints.
   *
   * Probe (`gridSizeProbe` in `oracle-fulgora-cells.seed123456.json`, 101
   * positions): `voronoi_cell_id` at a fractional `grid_size` of
   * 155.65736389160156 - what `fulgora_grid` really is at islands frequency 2 -
   * against the two integers it sits between.
   *
   * | comparison | agreement |
   * | --- | --- |
   * | fractional == **truncated (155)** | **101/101** |
   * | fractional == rounded (156) | 91/101 |
   * | truncated == rounded | 91/101 |
   *
   * The 10 positions where 155 and 156 disagree are what make this a
   * measurement: had all three agreed, the probe would say nothing.
   *
   * Truncating HERE rather than at the Fulgora call site is deliberate - it is
   * a property of the primitive's parameter type, so every caller gets it.
   */
  const gridSize = Math.trunc(p.gridSize);

  /**
   * The half-width of the cell block every op searches, from the game's own
   * {@link pointsSearchRange} - **all four ops, not just the pyramid**.
   *
   * The binary reads the range once at the top of `runInternal` and uses it for
   * both the generated point region and the `[-range, +range]` loop bounds, so
   * one binding here mirrors one read there. `searchRangeOverride` is the test
   * hook that plants the wrong range; it is honoured at this single site, which
   * is what makes it reach every op rather than only `pyramidNoise`.
   */
  const searchRing = p.searchRangeOverride ?? pointsSearchRange(distanceType, p.jitter);

  /**
   * The per-cell point cache - the whole of this function's performance story.
   *
   * A render sweeps one pixel at a time, and every sample reads a
   * `(2*ring+1)^2` block of cells - 9 or 25 depending on {@link searchRing} -
   * and the pyramid walks its own block twice (once for the argmin, once for the
   * bisector minimum). At `gridSize = 175` a whole 175x175-tile cell is the same
   * cell for 30,625 consecutive samples, so the same six Wang mixes are redone
   * tens of thousands of times per cell without this.
   *
   * **Byte-exact by construction, for the same reason {@link memoXY} is:** the
   * cached object is handed back by identity, so every consumer sees the
   * *identical* f32 pair the first call computed. A cache that changed any value
   * would be a bug, not an optimisation - which is why the **117** pre-existing
   * exact-value tests across `test/voronoiNoise.spec.ts` (95) and
   * `test/voronoiSearchRange.spec.ts` (22) are the correctness proof here and had
   * to pass unchanged. (117, not the 116 an earlier version of this comment said,
   * and not the 120 the version before that. Both were arrived at by arithmetic
   * on remembered totals; this one was counted. The two files hold 123 tests and
   * the caching block holds 6 - `vp test -t "makeVoronoi caching"` reports
   * `6 passed | 95 skipped` on `voronoiNoise.spec.ts` alone. Re-count, do not
   * re-derive.) Confirmed in the
   * other direction too: with all three cache layers stripped out the two files
   * report `1 failed | 122 passed` - every one of the 117 still passes and only
   * `"observes the caches doing work"` fails, which is what makes them a
   * correctness proof rather than a cache test.
   *
   * The key packs the two cell indices into one number, so this is a
   * `Map<number, ...>` rather than a string-keyed one (no per-lookup
   * concatenation on the hot path). `& 0xffff` means cells 65536 apart on an axis
   * collide; at the largest grid this repo uses that is 2^16 * 175 = 11.5M tiles,
   * far outside any map, and Factorio's own world is +/-1M tiles.
   */
  const pointCache = new Map<number, { x: number; y: number }>();
  const offsetAt = (cellX: number, cellY: number): { x: number; y: number } => {
    const key = (cellX & 0xffff) * 0x10000 + (cellY & 0xffff);
    let pt = pointCache.get(key);
    if (pt === undefined) {
      pt = pointOffsetInCell(p.seed0, p.seed1, p.jitter, cellX, cellY);
      pointCache.set(key, pt);
    }
    return pt;
  };

  /**
   * The normalisation divisor. Measured, not assumed: the ratio of the distance
   * in tiles to the value the game reports is 64.0 at `grid_size = 64` across all
   * four distance types, so it is `gridSize` - not half of it, not the cell
   * diagonal. `test/voronoiNoise.spec.ts` fails on `gridSize * 2`.
   */
  const divisor = gridSize;

  /**
   * The sample position in grid units, where the cell lattice has unit spacing.
   *
   * **The incoming coordinates are narrowed to f32 first**, for the same reason
   * `multioctaveNoise`'s `sumOctaves` does it: the noise machine passes f32
   * values between expressions, so whatever computed `(x, y)` handed this call
   * an f32, and narrowing here is what makes the port sample the same point the
   * game did. This is the single entry point for all four ops, so one narrowing
   * covers `cellId`, `spotNoise`, `facetNoise` and `pyramidNoise`.
   *
   * It is a no-op for a raw world coordinate - an integer or quarter tile below
   * 2^24 is already exactly representable - which is why every voronoi fixture
   * committed before Fulgora is unaffected. Fulgora is the first caller to pass
   * a DERIVED coordinate (`fulgora_wx`, and `ox + wobble_x/2` for the spots),
   * and there it matters:
   *
   * | field | f64 coordinate | f32 coordinate |
   * | --- | --- | --- |
   * | `fulgora_pyramids` | 7.11e-6 | **1.19e-7** |
   * | `fulgora_spots` | 7.54e-6 | **1.19e-7** |
   * | `fulgora_cells` | exact | exact |
   *
   * Both continuous ops land on a single f32 ulp. `cell_id` was exact either
   * way, and that is the expected asymmetry rather than a reason to doubt the
   * change: it is a discrete argmin, so a sub-ulp coordinate shift almost never
   * changes WHICH point is nearest - the same reason the absolute-vs-rebased
   * delta above needed an exact-value test to catch.
   */
  const toGrid = (x: number, y: number): [number, number] => [
    f32(f32(x) / divisor),
    f32(f32(y) / divisor),
  ];

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
   * Forming the same delta from ABSOLUTE coordinates is algebraically identical
   * and differs in the last ulp, because `cell + frac` at a cell index of ~11
   * has an f32 spacing of 2^-20 while the rebased form never adds a large number
   * to a small one.
   *
   * Measured over this fixture's 4200 spot and facet samples. The exact
   * expressions, because the two absolute variants do NOT score the same and a
   * bare "the absolute form" is not reproducible:
   *
   * | delta expression | score |
   * | --- | --- |
   * | `f32(ux - (cell + frac))` - inner sum left as a double | 3734/4200 |
   * | `f32(ux - f32(cell + frac))` - inner sum rounded to f32 | 2921/4200 |
   * | `f32(f32(frac + relIndex) - f32(ux - cell))` - what the binary does | **4200/4200** |
   *
   * The first is what this port did before the disassembly was read, and all 466
   * of its misses are exactly one ulp - precisely the size of error that gets
   * mistaken for an accumulation artifact and papered over. Two more orderings
   * (`f32(f32(ux - cell) - frac)` and its negation) also scored 3734, so no
   * amount of re-ordering the absolute form reaches the answer; the rebasing is
   * the thing that matters.
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
    for (let a = -searchRing; a <= searchRing; a++) {
      for (let b = -searchRing; b <= searchRing; b++) {
        // At jitter 0 every offset is exactly 0.5, so this reduces to the cell
        // centre with no special case - confirmed rather than assumed, since
        // `spot_noise` reads exactly 0 (not merely small) at all 25 of the
        // jitter-0 fixture's exact cell centres, for every distance type.
        const o = offsetAt(cx + a, cy + b);
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
   * A one-entry cache over {@link search}, the object-valued analogue of
   * {@link memoXY} - and it is what {@link memoXY} on the three ops cannot do.
   *
   * `cellId`, `spotNoise` and `facetNoise` are three separate expressions in the
   * Fulgora tree that read the SAME field at the SAME pixel (`fulgora_cells` and
   * `fulgora_spots` share a point set; `fulgora_structure_cells` and
   * `fulgora_structure_facets` are the `cell_id`/`d2` pair off one field). Each
   * has its own `memoXY` slot, so without this the 25-cell search runs three
   * times per pixel. The result is returned by identity, so all three see the
   * identical floats.
   */
  let lastUx = NaN;
  let lastUy = NaN;
  let lastSearch: { d1: number; d2: number; cellX: number; cellY: number } | undefined;
  const searchAt = (
    ux: number,
    uy: number,
  ): { d1: number; d2: number; cellX: number; cellY: number } => {
    if (ux === lastUx && uy === lastUy && lastSearch !== undefined) return lastSearch;
    lastUx = ux;
    lastUy = uy;
    lastSearch = search(ux, uy);
    return lastSearch;
  };

  /**
   * The pyramid value: the distance from the sample to the nearest cell
   * boundary, as the **minimum over every neighbour except the nearest** of the
   * distance to that pair's bisector.
   *
   * This is a second loop in the binary, after the `d1`/`d2` loop, seeded with
   * `FLT_MAX` (`mov w8, #0x7f7fffff`) and reduced with `fcsel ... mi`. Skipping
   * the nearest point is not an optimisation - a zero-separation pair has a
   * degenerate bisector and would pin the minimum at 0 everywhere.
   *
   * The two shapes:
   *
   * - **euclidean** (`runInternal<2>`, `0x101773d64`) has a closed form, because
   *   a Euclidean bisector is a straight line: `dot(midpoint, normalize(b - a))`
   *   with both points taken relative to the sample. The zero-length guard on
   *   the normalise is the binary's (`fcmp #0.0` on both components before the
   *   `fdiv`s), not padding.
   * - **manhattan and chebyshev** inline {@link bisectorDistanceL1}, chebyshev
   *   after {@link toChebyshevFrame}.
   *
   * One thing here looks like it must be a mistake and is not: manhattan and
   * chebyshev pass the points as `sampleFrac - delta`, the point **reflected
   * through the sample**, with the sample itself as the third argument
   * (`fsub s24, s24, s22` then `fsub s24, s22, s24`, `0x1017732bc`). A point
   * reflection about `s` is an isometry fixing `s`, so the distance is
   * mathematically unchanged - but it is not unchanged at f32, so it is
   * reproduced literally rather than simplified to the euclidean path's
   * sample-relative form.
   */
  const pyramid = (ux: number, uy: number): number => {
    const cx = Math.floor(ux);
    const cy = Math.floor(uy);
    const sfx = f32(ux - cx);
    const sfy = f32(uy - cy);
    const deltaAt = (a: number, b: number): Vec2 => {
      const o = offsetAt(cx + a, cy + b);
      return [deltaTo(sfx, a, o.x), deltaTo(sfy, b, o.y)];
    };

    // The nearest point. Finding it is ring-insensitive - every ring agrees on
    // WHICH point is nearest - but the same range also bounds the neighbour loop
    // below, where it does change the answer.
    let d1 = Infinity;
    let na = 0;
    let nb = 0;
    for (let a = -searchRing; a <= searchRing; a++) {
      for (let b = -searchRing; b <= searchRing; b++) {
        const [dx, dy] = deltaAt(a, b);
        const d = distanceOf(distanceType, dx, dy);
        if (d < d1) {
          d1 = d;
          na = a;
          nb = b;
        }
      }
    }
    const near = deltaAt(na, nb);

    const reflect = (d: Vec2): Vec2 => [f32(sfx - d[0]), f32(sfy - d[1])];
    const chebyshev = distanceType === "chebyshev";
    const anchor = chebyshev ? toChebyshevFrame(...reflect(near)) : reflect(near);
    const sample: Vec2 = chebyshev ? toChebyshevFrame(sfx, sfy) : [sfx, sfy];

    let best = Infinity;
    for (let a = -searchRing; a <= searchRing; a++) {
      for (let b = -searchRing; b <= searchRing; b++) {
        if (a === na && b === nb) continue;
        const far = deltaAt(a, b);
        let v: number;
        if (distanceType === "euclidean") {
          let nx = f32(far[0] - near[0]);
          let ny = f32(far[1] - near[1]);
          if (nx !== 0 || ny !== 0) {
            const len = f32(Math.sqrt(f32(f32(nx * nx) + f32(ny * ny))));
            nx = f32(nx / len);
            ny = f32(ny / len);
          }
          const mx = f32(f32(near[0] + far[0]) * 0.5);
          const my = f32(f32(near[1] + far[1]) * 0.5);
          v = f32(f32(my * ny) + f32(mx * nx));
        } else {
          const other = chebyshev ? toChebyshevFrame(...reflect(far)) : reflect(far);
          v = bisectorDistanceL1(anchor, other, sample);
        }
        if (v < best) best = v;
      }
    }
    return best;
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
    cellId: memoXY((x, y) => {
      const s = searchAt(...toGrid(x, y));
      return cellRandom(p.seed0, p.seed1, s.cellX, s.cellY);
    }),

    // Deliberately NOT memoXY-wrapped: that helper is typed for number results,
    // and `searchAt` already carries its own one-entry cache, which is the
    // expensive part. Wrapping would add an allocation per call for nothing.
    cellIndex: (x, y) => {
      const s = searchAt(...toGrid(x, y));
      return { cellX: s.cellX, cellY: s.cellY };
    },

    spotNoise: memoXY((x, y) => searchAt(...toGrid(x, y)).d1),

    facetNoise: memoXY((x, y) => {
      const s = searchAt(...toGrid(x, y));
      return f32(s.d2 - s.d1);
    }),

    /**
     * "Like facet noise but the gradient is uniform and represents the distance
     * to the closest edge."
     *
     * Which is exactly what it is: the Euclidean distance from the sample to the
     * nearest **cell boundary**, taken as the minimum over every neighbouring
     * point of the distance to that pair's bisector under `distance_type`. The
     * whole of it is {@link pyramid}, read out of `runInternal<0..2>` in the
     * 2.1.12 binary rather than fitted - which matters, because the jitter-0
     * configuration this used to be fitted on is degenerate and the fitted
     * formula (the distance to the nearest edge of the UNIT SQUARE) scored **0
     * of 175** at every one of the nine captured jitter x distance_type
     * combinations, with errors up to about half a cell.
     *
     * **Chebyshev really is the odd one out, and it is one immediate.** Task 2
     * measured `sqrt(9/8) * edge` at jitter 0 and put it down to a clamp biting
     * at a segment endpoint. The number was right; the mechanism was not. The
     * `sqrt(9/8)` is `0.75 * sqrt(2)`, and the `0.75` is a literal `fmov s16,
     * #0.75000000` in the 45-degree map chebyshev goes through - see
     * {@link CHEBYSHEV_FRAME}. It applies at every jitter, and there is no
     * geometry in it at all.
     *
     * `minkowski3` still throws, because the game's own expression compiler
     * refuses that pair. Its `runInternal<3>` has no pyramid path.
     *
     * **Fulgora needs this, at both of the distance types the old guard
     * refused.** An earlier comment here claimed it did not, which was the one
     * thing the next implementer must not have believed. Against the pinned
     * 2.1.12 `factorio-data`, `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
     * has two jittered pyramid call sites. **Every line number in this file
     * cites the `name =` line of the prototype**, never the `expression =` line
     * below it; two of these used to cite the latter, which made the same site
     * look like two different ones. `fulgora_pyramids` (:156, manhattan,
     * `fulgora_jitter = 0.6` at :140) feeds `fulgora_sprawl_pyramids` (:213) and
     * `fulgora_vault_pyramids` (:220) inside the V1 elevation chain, and
     * `fulgora_pyramids_banding` (:432); and `fulgora_road_pyramids` (:421,
     * chebyshev, `fulgora_road_jitter = 1` at :405).
     */
    pyramidNoise:
      distanceType === "minkowski3"
        ? // NOT wrapped in `memoXY`, and the branch is decided once per field
          // rather than per sample. This started as a workaround: `memoXY`
          // recorded the coordinates BEFORE calling through, so a wrapped
          // throwing function left the slot claiming a value it never produced
          // and the SECOND call at that position returned the previous
          // position's number. `memoXY` itself was fixed on 2026-08-05 (it now
          // assigns after `fn` returns, guarded by `test/memoXY.spec.ts`), so
          // this is no longer load-bearing - it is kept because hoisting a
          // per-field constant out of a per-sample path is right anyway.
          () => {
            throw new Error(
              "voronoi_pyramid_noise does not support minkowski3 - the game's own " +
                'expression compiler rejects it: "Voronoi pyramid noise with ' +
                'Minkowski3 distance is not supported".',
            );
          }
        : memoXY((x, y) => pyramid(...toGrid(x, y))),
  };
}
