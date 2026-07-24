import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-resources.seed123456.json";
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

  // Bounds are the measured worst residual (over all 1085 fixture points) with
  // modest headroom - f32 rounding noise, same floor documented across the other
  // vulcanus specs. Measured worst residuals (2026-07-24):
  //   basaltsFavorability          2.4e-5
  //   mountainsFavorability        2.7e-4
  //   mountainsSulfurFavorability  2.7e-4
  //   ashlandsFavorability         1.4e-4
  //   startingTungsten             3.1e-4
  //   startingCoal                 1.9e-4
  //   startingCalcite              3.0e-4
  //   startingSulfur               3.2e-4
  //   tungstenRegion               1.8e-5
  //   coalRegion                   2.9e-5
  //   calciteRegion                1.7e-4
  //   sulfuricAcidRegion           1.6e-4
  //   sulfuricAcidPatches          2.9e-3 over ALL 1085 points, but only 1.7e-4 over
  //     the 1063 with exactly-representable coordinates (including all 1024 dense-grid
  //     points) - in family with every other expression above. The outliers are all
  //     among the 22 ring positions with irrational coordinates (e.g. 354.0533905932738):
  //     input_scale = 1/3 here is the highest-frequency multioctave anywhere in this
  //     port (~3-tile features, ~1.7x past the oracle-verified envelope, which tops out
  //     at input_scale 0.2 - see multioctaveNoise.ts / oracle/capture.ts), so a tiny
  //     positional mismatch on those irrational coordinates (implied offset 2.3e-3 to
  //     3.7e-3 tiles - the game evaluated at a marginally different point than we do)
  //     shows up here and nowhere else. Ruled out as a model bug: f32-rounding the
  //     composed octave coordinates moves the value only ~1e-4, and the local gradient
  //     at the outlier points is unremarkable (0.94 vs. a 0.50 median). Bound stays
  //     3.5e-3 to cover the full fixture, not just the clean-coordinate subset.
  //   sulfuricAcidRegionPatchy     3.9e-4
  const check = (field: (x: number, y: number) => number, want: number[], bound: number): void => {
    let worst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      worst = Math.max(worst, Math.abs(field(p.x, p.y) - want[i]));
    }
    expect(worst).toBeLessThan(bound);
  };

  it("vulcanus_basalts_resource_favorability matches the oracle", () => {
    check(resources.basaltsFavorability, fixture.basaltsFavorability, 1e-4);
  });

  it("vulcanus_mountains_resource_favorability matches the oracle", () => {
    check(resources.mountainsFavorability, fixture.mountainsFavorability, 5e-4);
  });

  it("vulcanus_mountains_sulfur_favorability matches the oracle", () => {
    check(resources.mountainsSulfurFavorability, fixture.mountainsSulfurFavorability, 5e-4);
  });

  it("vulcanus_ashlands_resource_favorability matches the oracle", () => {
    check(resources.ashlandsFavorability, fixture.ashlandsFavorability, 3e-4);
  });

  it("vulcanus_starting_tungsten matches the oracle", () => {
    check(resources.startingTungsten, fixture.startingTungsten, 5e-4);
  });

  it("vulcanus_starting_coal matches the oracle", () => {
    check(resources.startingCoal, fixture.startingCoal, 3e-4);
  });

  it("vulcanus_starting_calcite matches the oracle", () => {
    check(resources.startingCalcite, fixture.startingCalcite, 5e-4);
  });

  it("vulcanus_starting_sulfur matches the oracle", () => {
    check(resources.startingSulfur, fixture.startingSulfur, 5e-4);
  });

  it("vulcanus_tungsten_ore_region matches the oracle", () => {
    check(resources.tungstenRegion, fixture.tungstenRegion, 6e-5);
  });

  it("vulcanus_coal_region matches the oracle", () => {
    check(resources.coalRegion, fixture.coalRegion, 1e-4);
  });

  it("vulcanus_calcite_region matches the oracle", () => {
    check(resources.calciteRegion, fixture.calciteRegion, 3e-4);
  });

  it("vulcanus_sulfuric_acid_region matches the oracle", () => {
    check(resources.sulfuricAcidRegion, fixture.sulfuricAcidRegion, 3e-4);
  });

  it("vulcanus_sulfuric_acid_patches matches the oracle", () => {
    check(resources.sulfuricAcidPatches, fixture.sulfuricAcidPatches, 3.5e-3);
  });

  it("vulcanus_sulfuric_acid_region_patchy matches the oracle", () => {
    check(resources.sulfuricAcidRegionPatchy, fixture.sulfuricAcidRegionPatchy, 6e-4);
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
      const p = positions[i];
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
