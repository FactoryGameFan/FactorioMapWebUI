import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-rocks.seed123456.json";
import { withCtxDefaults } from "../src/noise/eval/ctx";
import {
  DECORATIVE_KNOCKOUT_SEED1,
  makeVulcanusDecorativeKnockout,
  makeVulcanusRockFields,
} from "../src/noise/rocks/vulcanusRockField";

describe("Vulcanus rocks", () => {
  const ctx = withCtxDefaults({ seed0: fixture.seed0 });
  const fields = makeVulcanusRockFields(ctx);
  const positions = fixture.positions;
  const v = fixture.values;

  const worst = (fn: (x: number, y: number) => number, want: number[]): number => {
    let w = 0;
    for (let i = 0; i < positions.length; i++) {
      w = Math.max(w, Math.abs(fn(positions[i].x, positions[i].y) - want[i]));
    }
    return w;
  };

  it("vulcanus_decorative_knockout matches the oracle", () => {
    const knockout = makeVulcanusDecorativeKnockout(fixture.seed0);
    // `input_scale = 1/3` makes this the highest-frequency multioctave in the
    // Vulcanus port, tied with sulfuricAcidPatches - and high frequency
    // amplifies the game's f32 coordinate floor, because a coordinate error of
    // e (which grows with |x|) becomes a phase error of e/3. The residual grows
    // smoothly with distance rather than jumping, which is what distinguishes a
    // precision floor from a porting error:
    //
    //   r < 300        2.22e-5   (298 points)
    //   300 <= r < 900 6.40e-5   (112 points)
    //   r >= 900       1.18e-4   (24 points)
    //
    // Bounds are the measured worst with headroom, not loosened tolerances.
    expect(worst(knockout, v.vulcanus_decorative_knockout)).toBeLessThan(2e-4);

    // The near-field bound is the real regression guard - it is where the
    // preview actually renders, and a structural error (wrong seed, octave
    // count, persistence) could not agree to 2e-5 anywhere.
    let nearWorst = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (Math.max(Math.abs(p.x), Math.abs(p.y)) >= 300) continue;
      nearWorst = Math.max(
        nearWorst,
        Math.abs(knockout(p.x, p.y) - v.vulcanus_decorative_knockout[i]),
      );
    }
    expect(nearWorst).toBeLessThan(5e-5);
  });

  it("vulcanus_rock_huge matches the oracle", () => {
    // Composed of aux, moisture, vulcanus_ashlands_biome, vulcanus_rock_noise
    // and the knockout - each already oracle-validated on its own - so the bound
    // is the worst of those compounded, dominated by the biome term (whose own
    // spec carries 5e-4).
    expect(worst(fields.rockHuge, v.vulcanus_rock_huge)).toBeLessThan(5e-4);
  });

  it("vulcanus_rock_big matches the oracle", () => {
    expect(worst(fields.rockBig, v.vulcanus_rock_big)).toBeLessThan(5e-4);
  });

  it("density is the clamped max of the two, which is the game's own arbitration", () => {
    // Per-tile arbitration is max probability, so max() here is exact rather
    // than an approximation - see docs/noise/placement-roll-NOTES.md.
    for (let i = 0; i < positions.length; i++) {
      const { x, y } = positions[i];
      const want = Math.min(
        1,
        Math.max(0, Math.max(v.vulcanus_rock_huge[i], v.vulcanus_rock_big[i])),
      );
      expect(Math.abs(fields.density(x, y) - want)).toBeLessThan(5e-4);
    }
  });

  it("probabilities stay well under 1, so no threshold yields a solid footprint", () => {
    // Both expressions are capped at 0.2 * (1 - k * ashlands_biome), so the
    // overlay cannot use the ores' `>= 0.5` rule - it rolls per tile against
    // this capped density instead (renderVulcanusRocks.ts). This is the same
    // shape of problem as the sulfuric-acid geyser and Nauvis rocks. If a
    // future version raises the cap, this fails and the roll's behavior
    // (heavier clustering from a higher-density field) should be revisited.
    // The cap is exactly 0.2, but the game evaluates it in f32, so the observed
    // peak is 0.20000000298023224 - f32(0.2) rounded up. Compare with a tick of
    // slack rather than pretending the constant comes back exact.
    const peak = Math.max(...v.vulcanus_rock_huge, ...v.vulcanus_rock_big);
    expect(peak).toBeLessThanOrEqual(0.2 + 1e-6);
    // ...and the field is not trivially empty over the sample.
    expect(peak).toBeGreaterThan(0.05);
  });

  it("pins the knockout seed", () => {
    expect(DECORATIVE_KNOCKOUT_SEED1).toBe(1300000);
  });
});
