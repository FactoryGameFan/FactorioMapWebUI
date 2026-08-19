import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-resources.seed123456.json";
import { countOffGrid, snapPosition } from "./captureGrid";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import { makeVulcanusBiomes } from "../src/noise/expressions/vulcanusBiomes";
import { makeVulcanusCracks } from "../src/noise/expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../src/noise/expressions/vulcanusHelpers";
import { makeVulcanusResources } from "../src/noise/expressions/vulcanusResources";
import { makeVulcanusSpawn } from "../src/noise/expressions/vulcanusSpawn";

describe("makeVulcanusResources", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);
  const positions = fixture.positions;

  // Bounds are the measured worst residual over all 1085 fixture points, with
  // modest headroom. Re-measured 2026-08-18 after the sample coordinate was
  // snapped onto the game's 1/256 MapPosition grid (see test/captureGrid.ts):
  //
  //   array                        before      after
  //   basaltsFavorability          3.351e-6    3.351e-6
  //   mountainsFavorability        2.775e-4    6.536e-5
  //   mountainsSulfurFavorability  2.775e-4    3.674e-5
  //   ashlandsFavorability         1.356e-4    3.733e-6
  //   startingTungsten             3.135e-4    2.743e-5
  //   startingCoal                 1.911e-4    1.418e-5
  //   startingCalcite              3.003e-4    2.230e-5
  //   startingSulfur               3.216e-4    1.397e-5
  //   tungstenRegion               3.745e-6    3.745e-6
  //   coalRegion                   5.525e-6    5.525e-6
  //   calciteRegion                1.656e-4    6.757e-6
  //   sulfuricAcidRegion           1.627e-4    6.781e-6
  //   sulfuricAcidPatches          2.942e-3    7.153e-8      (41,100x)
  //   sulfuricAcidRegionPatchy     3.941e-4    4.336e-6
  //
  // 21 of the 1085 positions were CAPTURED off the 1/256 grid, so the game
  // evaluated at a different point than the fixture records (#186). Before the
  // snap, 10 of these 14 arrays had their worst residual on one of those 21 rows;
  // after it, one does. For 13 of the 14 the post-snap worst now equals the
  // on-grid-only worst exactly - the off-grid excess is gone rather than reduced.
  //
  // The previous comment here explained the sulfuricAcidPatches outlier as "a tiny
  // positional mismatch on those irrational coordinates (implied offset 2.3e-3 to
  // 3.7e-3 tiles ... most likely because a ring position's exact float
  // representation differs by a ULP or two through the coordinate's construction
  // path)". The offset was real and the size was right, but the mechanism was not:
  // at 354.0533905932738 one f32 ulp is 3.052e-5 and one f64 ulp is 5.684e-14,
  // against a measured displacement of 2.609e-3 - 86x and 4.6e10x too large. It is
  // the game's int32/256 fixed-point truncation, which is also why every measured
  // displacement falls inside [0, 1/256) = [0, 3.906e-3). The old bound of 3.5e-3
  // was covering exactly that.
  const check = (field: (x: number, y: number) => number, want: number[], bound: number): void => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = snapPosition(positions[i]);
      worst = Math.max(worst, Math.abs(field(p.x, p.y) - want[i]));
    }
    expect(worst, `worst ${worst.toExponential(4)}`).toBeLessThan(bound);
  };

  it("vulcanus_basalts_resource_favorability matches the oracle", () => {
    check(resources.basaltsFavorability, fixture.basaltsFavorability, 4e-6);
  });

  it("vulcanus_mountains_resource_favorability matches the oracle", () => {
    check(resources.mountainsFavorability, fixture.mountainsFavorability, 8e-5);
  });

  it("vulcanus_mountains_sulfur_favorability matches the oracle", () => {
    check(resources.mountainsSulfurFavorability, fixture.mountainsSulfurFavorability, 5e-5);
  });

  it("vulcanus_ashlands_resource_favorability matches the oracle", () => {
    check(resources.ashlandsFavorability, fixture.ashlandsFavorability, 5e-6);
  });

  /**
   * The four starting-spot fields are scored by EXACT f32 match count, not by a
   * residual bound, and that changed with #279.
   *
   * `src/noise/eval/f32.ts` says to prefer an exact count, and these four are
   * the case that shows why. Narrowing `starting_spot_at_angle` per operation
   * moved every one of them a long way toward the game:
   *
   *   field              before   after
   *   startingTungsten    614     1082   of 1085
   *   startingCoal        611      974
   *   startingCalcite     547      969
   *   startingSulfur      618     1049
   *
   * A worst-residual bound cannot see any of that - it reports one outlier and
   * is blind to 422 points becoming exact. Worse, on `startingCalcite` it
   * reported the change as a REGRESSION: the worst residual went 2.2888e-5 to
   * 3.0518e-5 and tripped a 3e-5 bound, while the field itself nearly doubled
   * its exact matches. That is #162's pathology with the sign flipped.
   *
   * **The bound was not widened; it was replaced by a stronger assertion, and
   * the residual is still asserted underneath.** A frozen count fails on any
   * regression, including ones a bound would pass. The residual bounds below are
   * kept at the measured values so both signals survive.
   *
   * Why calcite's worst residual is allowed to be larger than the others': it
   * sits at `(-2332.9, 2333.7)`, where the field's own value is **-133.94**. One
   * f32 ULP at that magnitude is 1.53e-5, so 3.0518e-5 is TWO ULPs, and an
   * absolute bound on a field that ranges to +/-134 is a ULP-scale bound only at
   * the deep-field points. Exactly 2 of the 1085 positions exceed 3e-5. This is
   * the far-from-origin f32 coordinate floor the other Vulcanus specs document,
   * not a defect in the expression - which now scores 152/152 against the game's
   * own captured `starting_spot_at_angle` values (`crates/fmw-noise/src/fixtures.rs`).
   *
   * If a count DROPS, read it - do not adjust it. Up is worth taking.
   */
  const exactMatches = (field: (x: number, y: number) => number, want: number[]): number => {
    let exact = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = snapPosition(positions[i]);
      if (Math.fround(field(p.x, p.y)) === Math.fround(want[i])) exact++;
    }
    return exact;
  };

  it("vulcanus_starting_tungsten matches the oracle", () => {
    expect(exactMatches(resources.startingTungsten, fixture.startingTungsten)).toBe(1082);
    check(resources.startingTungsten, fixture.startingTungsten, 4e-5);
  });

  it("vulcanus_starting_coal matches the oracle", () => {
    expect(exactMatches(resources.startingCoal, fixture.startingCoal)).toBe(974);
    check(resources.startingCoal, fixture.startingCoal, 2e-5);
  });

  it("vulcanus_starting_calcite matches the oracle", () => {
    expect(exactMatches(resources.startingCalcite, fixture.startingCalcite)).toBe(969);
    check(resources.startingCalcite, fixture.startingCalcite, 3.06e-5);
  });

  it("vulcanus_starting_sulfur matches the oracle", () => {
    expect(exactMatches(resources.startingSulfur, fixture.startingSulfur)).toBe(1049);
    check(resources.startingSulfur, fixture.startingSulfur, 2e-5);
  });

  it("vulcanus_tungsten_ore_region matches the oracle", () => {
    check(resources.tungstenRegion, fixture.tungstenRegion, 5e-6);
  });

  it("vulcanus_coal_region matches the oracle", () => {
    check(resources.coalRegion, fixture.coalRegion, 7e-6);
  });

  it("vulcanus_calcite_region matches the oracle", () => {
    check(resources.calciteRegion, fixture.calciteRegion, 9e-6);
  });

  it("vulcanus_sulfuric_acid_region matches the oracle", () => {
    check(resources.sulfuricAcidRegion, fixture.sulfuricAcidRegion, 9e-6);
  });

  it("vulcanus_sulfuric_acid_patches matches the oracle", () => {
    check(resources.sulfuricAcidPatches, fixture.sulfuricAcidPatches, 1e-7);
  });

  it("vulcanus_sulfuric_acid_region_patchy matches the oracle", () => {
    check(resources.sulfuricAcidRegionPatchy, fixture.sulfuricAcidRegionPatchy, 6e-6);
  });

  // AMENDED 2026-07-24 after Task 1's fixture landed. The original plan asserted
  // `check(resources.metalTile, fixture.metalTile, 4)` on the premise that
  // rp -> 1 makes metal_tile exactly `max(0, 1000 * region)`. The captured oracle
  // disproves that: worst |diff| is 132.86 (idx 341: region 0.4387, approx
  // 438.70, oracle 305.84), ~30x the proposed tolerance, and at small regions the
  // penalty flips placement outright (idx 733/769 have region > 0 but
  // metal_tile == 0). random_penalty is a batch op and cannot be reproduced
  // per-pixel, so rp -> 1 stays - but it is an UPPER BOUND, not an equality.
  //
  // The envelope assertion below is strictly stronger than a tolerance: it pins
  // our tungstenRegion AND proves rp -> 1 is the documented ceiling. Verified to
  // hold at all 1085 fixture points with zero violations; the implied p over the
  // 8 region > 0 points spans [0.9077, 0.9748].
  it("vulcanus_metal_tile sits inside the random_penalty envelope", () => {
    let violations = 0;
    let worstBelow = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = snapPosition(positions[i]);
      const region = resources.tungstenRegion(p.x, p.y);
      const lo = Math.max(0, 1000 * ((1 + region) * 0.9 - 1));
      const hi = Math.max(0, 1000 * ((1 + region) * 1.0 - 1));
      const got = fixture.metalTile[i];
      if (got < lo - 1e-3 || got > hi + 1e-3) violations++;
      worstBelow = Math.max(worstBelow, hi - got);
    }
    expect(violations).toBe(0);
    // Guard against a degenerate pass: if our region were 0 everywhere, lo and hi
    // would both collapse to 0 and every point would trivially satisfy the
    // envelope. At least one point must have a non-trivial envelope width.
    expect(worstBelow).toBeGreaterThan(1);
  });
});

describe("makeVulcanusResources at a non-default frequency (smoke test)", () => {
  // `region_size = base + base/frequency` (vulcanusResources.ts's `placeSpots`) is an
  // integer only at the default frequency (f = 1); `makeSpotNoise` floors it
  // (`Math.floor(p.regionSize)`) because `selectSpots` uses it as an integer modulus.
  // No oracle fixture exists at a non-default frequency (the game oracle was only
  // captured at f = 1), so this CANNOT check fidelity against the game - it only
  // guards against the flooring producing garbage (NaN, an exploding value, or a
  // field that never leaves its basement floor) at a fractional region_size. See
  // docs/noise/vulcanus-resources-NOTES.md's "Known gaps" #1.
  it("coal region stays finite and varies at frequency 1.5 (region_size 1066.67 -> 1066)", () => {
    const ctx = withCtxDefaults({
      seed0: fixture.seed0,
      vulcanusResourceControls: {
        tungstenOre: { frequency: 1, size: 1 },
        vulcanusCoal: { frequency: 1.5, size: 1 },
        calcite: { frequency: 1, size: 1 },
        sulfuricAcidGeyser: { frequency: 1, size: 1 },
      },
    });
    const helpers = makeVulcanusHelpers(ctx);
    const spawn = makeVulcanusSpawn(ctx, helpers);
    const cracks = makeVulcanusCracks(ctx, helpers);
    const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
    const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);

    let sawNonBasement = false;
    for (let x = -3000; x <= 3000; x += 200) {
      for (let y = -3000; y <= 3000; y += 200) {
        const v = resources.coalRegion(x, y);
        expect(Number.isFinite(v)).toBe(true);
        // Sane envelope, not a fidelity bound - just enough to catch a flooring bug
        // that sends the field to NaN or off to some absurd magnitude. -1 is the
        // spot-noise basement, but `min(1 - startingCircle, placed)` legitimately
        // dips well under it near spawn (measured -2.27 at (0, 0) even at the
        // DEFAULT frequency, so this is not a floor-related artifact) - the lower
        // bound here has generous slack; the point is catching an exploding or NaN
        // value, not pinning the basement exactly.
        expect(v).toBeGreaterThanOrEqual(-5);
        expect(v).toBeLessThan(5);
        if (v > -0.999) sawNonBasement = true;
      }
    }
    // Guards against a degenerate pass: an all-basement field would trivially
    // satisfy the finite/envelope checks above without proving the region logic
    // (spot selection, cone placement) still runs at a fractional region_size.
    expect(sawNonBasement).toBe(true);
  });
});

// Anti-vacuity for the 1/256 capture-grid snap applied above. These fixtures
// record sample coordinates the game never evaluated at (#186); `snapPosition`
// recovers where it did. If a re-capture ever lands every position on the grid
// these counts reach 0, at which point the snap is the identity and should be
// deleted rather than left looking load-bearing. See test/captureGrid.ts.
describe("capture-grid snap is not vacuous", () => {
  it("oracle-vulcanus-resources still has off-grid positions", () => {
    expect(countOffGrid(fixture.positions)).toBe(21);
  });
});
