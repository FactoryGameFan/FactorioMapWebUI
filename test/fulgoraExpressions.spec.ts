import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-fulgora-shared.seed123456.json";
import { makeFulgoraShared } from "../src/noise/expressions/fulgoraShared";

/**
 * Fulgora's shared layer, checked against the game.
 *
 * Source: `space-age/prototypes/planet/planet-fulgora-map-gen.lua:22-124`,
 * byte-identical 2.1.12 -> 2.1.14.
 *
 * The fixture's `seed0` is used RAW, not run through `surfaceSeedForPlanet`.
 * The oracle harness sets `mgs.seed` on the created Fulgora surface explicitly
 * (`buildSpaceAgeControlLua`), so `map_seed` inside the noise program IS 123456.
 * The surface-seed derivation matters for the app's own render path, where a
 * user supplies a map seed - it does not enter here.
 */
describe("makeFulgoraShared", () => {
  const shared = makeFulgoraShared({ seed0: fixture.seed0 });
  const positions = fixture.positions;

  /**
   * Compare at f32. `bound` is the measured worst residual for that field with
   * modest headroom, NOT a blanket tolerance - each is set from what that field
   * actually achieves, so a regression in one cannot hide behind another's
   * slack. Measured worst, 101 positions:
   *
   * | field | worst | bound |
   * | --- | --- | --- |
   * | `ox`, `oy` | **0** | 0 |
   * | `startingMask`, `startingVaultMask` | **0** | 0 |
   * | `startingCone` | 1.12e-7 | 2e-7 |
   * | `wobbleMask` | 5.74e-7 | 1e-6 |
   * | `startingVaultCone` | 8.05e-7 | 1e-6 |
   * | `wobbleInfluence` | 7.15e-7 | 1e-6 |
   * | `wobbleX`, `wobbleY` | 3.81e-6 | 5e-6 |
   * | `wx`, `wy` | 1.53e-5 | 2e-5 |
   *
   * The non-zero ones are the port's known `basisNoise` floor - it evaluates in
   * f64 where the game uses f32 - scaled by each field's own `output_scale`.
   * `wobbleX` runs at `grid * 0.07` = 12.25, so 3.81e-6 is ~3.1e-7 relative,
   * the same order as the ~7.2e-7 documented elsewhere; `wx`/`wy` compound it
   * with a coordinate up to 15000. Nothing here is Fulgora-specific.
   *
   * The two ZERO rows matter more than the small ones. `ox`/`oy` are literally
   * `x + grid/2`, so they can only be exact if the port and the game are
   * evaluating the same point - they are the alignment check on the fixture's
   * coordinates. They were NOT exact until the capture snapped its positions to
   * a quarter tile; unsnapped, they were out by exactly 1/256.
   */
  const check = (fn: (x: number, y: number) => number, want: number[], bound: number): void => {
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i] as { x: number; y: number };
      const got = Math.fround(fn(p.x, p.y));
      const d = Math.abs(got - Math.fround(want[i] as number));
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    expect(
      worst,
      `worst residual ${worst.toExponential(3)} at position ${String(worstAt)} ` +
        `(${String((positions[worstAt] as { x: number; y: number } | undefined)?.x)}, ` +
        `${String((positions[worstAt] as { x: number; y: number } | undefined)?.y)})`,
    ).toBeLessThanOrEqual(bound);
  };

  it("fulgora_grid is a constant 175 at the default frequency", () => {
    // Sampled per-position by the oracle, so this also proves it does not vary
    // with x/y - it is a program constant, not a field.
    expect(new Set(fixture.fulgora_grid).size).toBe(1);
    expect(shared.grid).toBe(fixture.fulgora_grid[0]);
    expect(shared.grid).toBe(175);
  });

  it("matches fulgora_wobble_influence", () => {
    check(shared.wobbleInfluence, fixture.fulgora_wobble_influence, 1e-6);
  });

  it("matches fulgora_wobble_x", () => {
    check(shared.wobbleX, fixture.fulgora_wobble_x, 5e-6);
  });

  it("matches fulgora_wobble_y", () => {
    check(shared.wobbleY, fixture.fulgora_wobble_y, 5e-6);
  });

  it("matches fulgora_wobble_mask", () => {
    check(shared.wobbleMask, fixture.fulgora_wobble_mask, 1e-6);
  });

  it("matches fulgora_ox and fulgora_oy", () => {
    check(shared.ox, fixture.fulgora_ox, 0);
    check(shared.oy, fixture.fulgora_oy, 0);
  });

  it("matches fulgora_wx and fulgora_wy", () => {
    check(shared.wx, fixture.fulgora_wx, 2e-5);
    check(shared.wy, fixture.fulgora_wy, 2e-5);
  });

  it("matches fulgora_starting_cone", () => {
    check(shared.startingCone, fixture.fulgora_starting_cone, 2e-7);
  });

  it("matches fulgora_starting_vault_cone", () => {
    check(shared.startingVaultCone, fixture.fulgora_starting_vault_cone, 1e-6);
  });

  it("matches fulgora_starting_mask and fulgora_starting_vault_mask", () => {
    check(shared.startingMask, fixture.fulgora_starting_mask, 0);
    check(shared.startingVaultMask, fixture.fulgora_starting_vault_mask, 0);
  });

  it("evaluates both cones somewhere, so the cone tests are not vacuous", () => {
    // The cones are zero far from spawn. If the capture had only far-field
    // points, "matches" above would pass on all-zeros against all-zeros.
    const coneNonZero = fixture.fulgora_starting_cone.filter((v) => v !== 0).length;
    const vaultNonZero = fixture.fulgora_starting_vault_cone.filter((v) => v !== 0).length;
    expect(coneNonZero).toBeGreaterThan(10);
    expect(vaultNonZero).toBeGreaterThan(5);
    // Same for the masks: both values must appear or a constant would pass.
    expect(new Set(fixture.fulgora_starting_mask).size).toBe(2);
    expect(new Set(fixture.fulgora_starting_vault_mask).size).toBe(2);
  });

  it("perturbs wx/wy away from ox/oy, so the wobble is not inert", () => {
    // wx == ox wherever wobbleMask is 0. If the mask were stuck at 0 the wx/wy
    // tests would reduce to re-testing ox/oy.
    const moved = positions.filter((_, i) => fixture.fulgora_wx[i] !== fixture.fulgora_ox[i]);
    expect(moved.length).toBeGreaterThan(20);
  });
});

/**
 * `fulgora_grid` is `175 - slider_to_linear(control:fulgora_islands:frequency,
 * -50, 50)`, and the plan carried an open question about it: the Voronoi
 * primitive documents `grid_size` as a 16-bit UNSIGNED INTEGER, so does the
 * game truncate, round, or never produce a fraction?
 *
 * **Measured against the game, and the "integral" assumption is REFUTED.**
 * `175 - slider_to_linear(<s>, -50, 50)` sampled on a real Fulgora surface
 * (2.1.14, seed 123456):
 *
 * | frequency | grid | integer? |
 * | --- | --- | --- |
 * | 0.5 | 194.34263610839844 | no |
 * | 1 (default) | 175 | yes |
 * | 2 | 155.65736389160156 | no |
 * | 3 | 144.3426513671875 | no |
 * | 6 | 125 | yes |
 *
 * It is integral only at the two slider endpoints, where `log2(s)/log2(6)` is
 * exactly 0 and 1 - a coincidence of those positions, not a property of the
 * expression. So `fulgora_grid` is a genuine float and this port keeps it one.
 *
 * Whether the VORONOI CALL then truncates it to a u16 is a separate question
 * about `grid_size`, and it belongs to the cell layer, not here - `fulgora_grid`
 * itself is what this file owns, and the game hands it back fractional.
 *
 * `s = 3` is also the ONLY row that can see `slider_to_linear`'s f32 rounding:
 * the others have power-of-two numerators, and at `s = 6` the ratio is exactly
 * 1 whatever `log2(6)` is. Dropping it would let an f64 evaluation pass. See
 * `docs/noise/fulgora-elevation-NOTES.md`.
 */
describe("fulgora_grid across the frequency slider", () => {
  // Values read from the game, not derived from the port.
  const GAME: ReadonlyArray<readonly [number, number]> = [
    [0.5, 194.34263610839844],
    [1, 175],
    [2, 155.65736389160156],
    [3, 144.3426513671875],
    [6, 125],
  ];

  it.each(GAME)("matches the game at islands frequency %s", (frequency, want) => {
    const ours = makeFulgoraShared({ seed0: 1, islandsFrequency: frequency }).grid;
    expect(Math.fround(ours)).toBe(Math.fround(want));
  });

  it("is fractional off the slider endpoints, so grid is not an integer", () => {
    // Pins the refutation itself: if a future change starts rounding grid, the
    // table above would still pass at 175/125 but this fails.
    expect(Number.isInteger(makeFulgoraShared({ seed0: 1, islandsFrequency: 2 }).grid)).toBe(false);
    expect(Number.isInteger(makeFulgoraShared({ seed0: 1, islandsFrequency: 1 }).grid)).toBe(true);
  });

  it("shrinks the cell as frequency rises", () => {
    // slider_to_linear increases in s and grid subtracts it, so a higher
    // frequency must mean SMALLER cells - more islands, which is what the
    // control's name promises.
    const grids = GAME.map(([f]) => makeFulgoraShared({ seed0: 1, islandsFrequency: f }).grid);
    for (let i = 1; i < grids.length; i++) {
      expect(grids[i] as number).toBeLessThan(grids[i - 1] as number);
    }
  });
});
