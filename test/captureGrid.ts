/**
 * The 1/256 grid an oracle capture's sample coordinates actually landed on.
 *
 * Factorio's `MapPosition` is fixed point - `int32 / 256`. Every coordinate
 * handed to `surface.calculate_tile_properties` is converted on the way in, so
 * a capture that RECORDS a coordinate which is not a multiple of 1/256 made the
 * game evaluate at a slightly different point than the fixture says. That is
 * hazard #186, and it is the reason a residual can look like a precision floor
 * while being nothing of the kind.
 *
 * `test/oracle/capture.ts` builds its far rings as `r * Math.cos(a) + 0.5`,
 * with the comment "fractional offsets keep points off the lattice". Going off
 * the INTEGER lattice was deliberate and correct; going off the 1/256 lattice
 * was not intended and is what these helpers undo. Seventeen committed fixtures
 * carry such positions, all of them ring points.
 *
 * ## The snap is truncation TOWARD ZERO, and that was measured
 *
 * Not rounding, not flooring - `fcvtzs`, the same instruction the disassemblies
 * in `docs/noise/` cite for every other float-to-int conversion in the noise
 * machine. Measured 2026-08-18 over all 17 affected fixtures. Every one improves
 * and none gets worse:
 *
 * | fixture (worst residual) | as recorded | truncated to 1/256 |
 * | --- | --- | --- |
 * | `oracle-temperature` | 17/26 exact, 5.817e-5 | **26/26 exact, 0** |
 * | `oracle-elevation-lakes` `distance` | 18/26, 4.639e-3 | **26/26, 0** |
 * | `oracle-vulcanus-resources` sulfuricAcidPatches | 2.942e-3 | 7.153e-8 (41,100x) |
 * | `oracle-rock-density` | 7/26, 1.570e-3 | 17/26, 8.345e-8 (18,816x) |
 * | `oracle-elevation-lakes` elevation | 6/17, 7.372e-3 | 13/17, 3.815e-6 (1,933x) |
 * | `oracle-moisture` | 15/26, 3.070e-5 | 18/26, 5.960e-8 (515x) |
 * | `oracle-trees` | 85/442, 9.233e-4 | 120/442, 2.593e-6 (356x) |
 * | `oracle-elevation-island` | 4/17, 6.673e-3 | 10/17, 2.564e-5 (260x) |
 * | `oracle-aux` | 10/26, 1.262e-5 | 14/26, 5.960e-8 (212x) |
 * | `oracle-vulcanus-climate` | 60/122, 4.584e-4 | 70/122, 3.359e-6 (136x) |
 * | `oracle-trees-controls` | 8/51, 8.646e-4 | 9/51, 1.139e-5 (76x) |
 * | `oracle-vulcanus-temperature` | 185/434, 1.327e-1 | 189/434, 2.639e-3 (50x) |
 * | `oracle-vulcanus-elevation` | 200/868, 1.332e-1 | 202/868, 5.234e-3 (25x) |
 * | `oracle-elevation-nauvis` | 2/17, 3.922e-3 | 3/17, 3.856e-4 (10x) |
 * | `oracle-vulcanus-cracks` | 76/305, 1.853e-3 | 79/305, 2.067e-4 (9x) |
 * | `oracle-resource-starting` | 4.899 abs | 0.641 abs (7.6x) |
 * | `oracle-vulcanus-biomes` | 1990/3472, 3.092e-4 | 2024/3472, 4.634e-5 (6.7x) |
 *
 * **Four of these rows had DRIFTED, and nothing was asserting them** - the two
 * `oracle-trees` rows and the two `oracle-rock-density` ones. They read
 * 83/118, 9/10 and 8/18 until 2026-08-26; re-measured on both ports the same
 * day they are 85/120, 8/9 and 7/17. The offset is one or two in BOTH arms of
 * each fixture and in the same direction, which is the signature of the port
 * having moved since the table was taken rather than of a methodology
 * difference. The counts are now frozen on the Rust side
 * (`crates/fmw-noise/src/fixtures.rs`), snapped and raw, so a future drift
 * fails a test instead of quietly ageing a comment.
 *
 * ## Why this is a measurement and not a fit
 *
 * Four independent controls, each of which could have failed:
 *
 * 1. **Truncation beats flooring only because of the negative coordinates.** The
 *    two functions are identical on positive numbers. On `oracle-temperature`'s
 *    4 all-positive off-grid rows they agree 4/4; on its 10 rows with a negative
 *    coordinate, truncation is exact where flooring is not **6 times, and
 *    flooring never wins**. Across the Vulcanus and tree fixtures, flooring and
 *    rounding are each WORSE than applying no snap at all in several arrays.
 * 2. **It is the identity on grid-aligned rows, and it behaved like one.** Zero
 *    changes across 18,619 on-grid comparisons.
 * 3. **A wrong grid does worse.** A planted 1/128 snap leaves
 *    `oracle-resource-starting` at 4.899 -> 3.012 where 1/256 gives 0.621.
 * 4. **The residual lands exactly where a snap predicts.** For 13 of the 14
 *    `oracle-vulcanus-resources` arrays the post-snap worst equals the
 *    on-grid-only worst to every digit - the off-grid excess is gone rather than
 *    merely reduced. And every measured displacement falls inside `[0, 1/256)`,
 *    which is the range truncation toward zero produces and nothing else does.
 *
 * That last point also refutes the mechanism `docs/noise/vulcanus-resources-NOTES.md`
 * recorded ("a ring position's exact float representation differs by a ULP or
 * two through the coordinate's construction path"). At `354.0533905932738` one
 * f32 ulp is 3.052e-5 and one f64 ulp is 5.684e-14, against a measured
 * displacement of 2.609e-3 - 86x and 4.6e10x too large respectively.
 *
 * ## Use it on the SAMPLE POSITION only
 *
 * This snaps where the game was asked to evaluate. It says nothing about the
 * precision of the arithmetic that follows, and it must never be applied to a
 * fixture's recorded VALUES - those stay untouched ground truth.
 */

/** Truncate one coordinate toward zero onto the 1/256 `MapPosition` grid. */
export function snapCoord(v: number): number {
  return Math.trunc(v * 256) / 256;
}

/** True when a coordinate is already an exact multiple of 1/256. */
export function isOnCaptureGrid(v: number): boolean {
  return Number.isInteger(v * 256);
}

/**
 * Snap a capture position onto the grid the game sampled it at. Returns a plain
 * `{x, y}` so it can be spread over a fixture position carrying other fields.
 */
export function snapPosition(p: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return { x: snapCoord(p.x), y: snapCoord(p.y) };
}

/**
 * How many of these positions were recorded off the 1/256 grid. Specs assert
 * this so that a re-capture cannot silently empty the set the snap exists for -
 * if it ever reaches 0, the snap has become dead code and should be deleted
 * rather than left to look load-bearing.
 */
export function countOffGrid(
  positions: readonly { readonly x: number; readonly y: number }[],
): number {
  return positions.filter((p) => !isOnCaptureGrid(p.x) || !isOnCaptureGrid(p.y)).length;
}
