import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-fulgora-shared.seed123456.json";
import cellsFixture from "./fixtures/oracle-fulgora-cells.seed123456.json";
import { makeFulgoraShared } from "../src/noise/expressions/fulgoraShared";
import { makeFulgoraCells } from "../src/noise/expressions/fulgoraCells";
import { makeVoronoi } from "../src/noise/voronoiNoise";

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

/**
 * Fulgora's Voronoi layer and the island classification built on it.
 * Source: `planet-fulgora-map-gen.lua:126-205`.
 *
 * Fixture positions are IDENTICAL to the shared-layer fixture, so the two line
 * up index-for-index.
 */
describe("makeFulgoraCells", () => {
  const ctx = { seed0: cellsFixture.seed0 };
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const positions = cellsFixture.positions;

  const check = (fn: (x: number, y: number) => number, want: number[], bound: number): void => {
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i] as { x: number; y: number };
      const d = Math.abs(Math.fround(fn(p.x, p.y)) - Math.fround(want[i] as number));
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    expect(
      worst,
      `worst residual ${worst.toExponential(3)} at position ${String(worstAt)}`,
    ).toBeLessThanOrEqual(bound);
  };

  it("shares its position set with the shared-layer fixture", () => {
    // The two fixtures are compared field-against-field elsewhere; if they ever
    // drift apart, every such comparison silently becomes meaningless.
    expect(positions).toEqual(fixture.positions);
  });

  it("matches fulgora_cells", () => {
    // EXACT, and that is a real check rather than a lucky one: cell_id is what
    // every island class is derived from, so an error here would reclassify
    // whole islands rather than shade them.
    check(cells.cells, cellsFixture.fulgora_cells, 0);
  });

  /**
   * `pyramids` and `spots` carry a small residual where `cells` does not, and
   * the split is the interesting part rather than the sizes.
   *
   * All three read the same distorted coordinates, which arrive from the shared
   * layer already carrying its `basisNoise` f64-vs-f32 floor (`wx`/`wy` worst
   * 1.53e-5). `cells` is a DISCRETE lookup - it returns which cell won, so a
   * coordinate error that small almost never changes the answer, and it comes
   * back f32-EXACT. `pyramids` and `spots` are continuous, so the same input
   * error passes straight through to the output.
   *
   * Measured worst over the 101 positions: pyramids 7.11e-6, spots 7.54e-6 -
   * both below the 1.53e-5 they inherit, as a contraction should be. Nothing
   * here is new error introduced by this layer.
   */
  it("matches fulgora_pyramids", () => {
    check(cells.pyramids, cellsFixture.fulgora_pyramids, 1e-5);
  });

  it("matches fulgora_spots and fulgora_spots_inv", () => {
    check(cells.spots, cellsFixture.fulgora_spots, 1e-5);
    check(cells.spotsInv, cellsFixture.fulgora_spots_inv, 1e-5);
  });

  it("matches the four island classes", () => {
    check(cells.blanks, cellsFixture.fulgora_blanks, 0);
    check(cells.mesa, cellsFixture.fulgora_mesa, 0);
    check(cells.sprawl, cellsFixture.fulgora_sprawl, 0);
    check(cells.vaults, cellsFixture.fulgora_vaults, 0);
  });

  it("matches fulgora_vaults_and_starting_vault", () => {
    check(cells.vaultsAndStartingVault, cellsFixture.fulgora_vaults_and_starting_vault, 0);
  });

  it("blanks / sprawl / mesa / vaults partition every position", () => {
    for (const p of positions as { x: number; y: number }[]) {
      const sum =
        cells.blanks(p.x, p.y) +
        cells.sprawl(p.x, p.y) +
        cells.mesa(p.x, p.y) +
        cells.vaults(p.x, p.y);
      expect(Math.fround(sum), `partition at (${String(p.x)}, ${String(p.y)})`).toBe(1);
    }
  });

  it("populates all four classes, so the partition test is not vacuous", () => {
    // A classification that returned "blanks" everywhere would also sum to 1.
    const count = (f: (x: number, y: number) => number) =>
      (positions as { x: number; y: number }[]).filter((p) => f(p.x, p.y) === 1).length;
    for (const [name, f] of [
      ["blanks", cells.blanks],
      ["sprawl", cells.sprawl],
      ["mesa", cells.mesa],
      ["vaults", cells.vaults],
    ] as const) {
      expect(count(f), `${name} never occurs in the fixture`).toBeGreaterThan(0);
    }
  });

  it("cells and pyramids move together with the seed", () => {
    const a = makeFulgoraCells(makeFulgoraShared({ seed0: 1 }), { seed0: 1 });
    const b = makeFulgoraCells(makeFulgoraShared({ seed0: 2 }), { seed0: 2 });
    expect(a.cells(500.5, 500.5)).not.toBe(b.cells(500.5, 500.5));
    expect(a.pyramids(500.5, 500.5)).not.toBe(b.pyramids(500.5, 500.5));
  });
});

/**
 * The plan left this open at Task 7 and it is answerable here: the Voronoi
 * primitive documents `grid_size` as a 16-bit UNSIGNED INTEGER, but
 * `fulgora_grid` is a genuine float away from the two slider endpoints. Does
 * the CALL truncate it?
 *
 * **Measured: yes, it truncates.** `voronoi_cell_id` sampled at a fractional
 * grid_size of 155.65736389160156 (what `fulgora_grid` really is at islands
 * frequency 2) against the two integers it sits between, 101 positions:
 *
 * | comparison | agreement |
 * | --- | --- |
 * | fractional == **truncated (155)** | **101/101** |
 * | fractional == rounded (156) | 91/101 |
 * | truncated == rounded | 91/101 |
 *
 * The 10 positions where 155 and 156 disagree are what make this a measurement
 * rather than a coincidence - had all three agreed, the probe would say nothing.
 *
 * The default grid is exactly 175, so this changes NO default render. It
 * matters the moment the islands frequency slider moves off 1.
 */
describe("voronoi grid_size is truncated to an integer", () => {
  const probe = cellsFixture.gridSizeProbe;

  it("the probe discriminates - 155 and 156 are genuinely different fields", () => {
    const differing = probe.truncated.filter((v, i) => v !== probe.rounded[i]).length;
    expect(differing).toBeGreaterThan(0);
  });

  it("a fractional grid_size behaves exactly like its truncation", () => {
    expect(probe.fractional).toEqual(probe.truncated);
  });

  it("makeVoronoi truncates gridSize, matching the game", () => {
    const params = {
      seed0: cellsFixture.seed0,
      seed1: 12345,
      jitter: 0.6,
      distanceType: "manhattan",
    } as const;
    const fractional = makeVoronoi({ ...params, gridSize: probe.fractionalGridSize });
    const truncated = makeVoronoi({ ...params, gridSize: probe.truncatedGridSize });
    const rounded = makeVoronoi({ ...params, gridSize: probe.roundedGridSize });

    let sameAsTruncated = 0;
    let sameAsRounded = 0;
    for (const p of cellsFixture.positions as { x: number; y: number }[]) {
      if (fractional.cellId(p.x, p.y) === truncated.cellId(p.x, p.y)) sameAsTruncated++;
      if (fractional.cellId(p.x, p.y) === rounded.cellId(p.x, p.y)) sameAsRounded++;
    }
    const n = cellsFixture.positions.length;
    expect(sameAsTruncated, "fractional should equal truncated everywhere").toBe(n);
    expect(sameAsRounded, "fractional should NOT equal rounded everywhere").toBeLessThan(n);
  });
});
