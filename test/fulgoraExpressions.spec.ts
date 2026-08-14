import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-fulgora-shared.seed123456.json";
import cellsFixture from "./fixtures/oracle-fulgora-cells.seed123456.json";
import elevationFixture from "./fixtures/oracle-fulgora-elevation.seed123456.json";
import ruinsFixture from "./fixtures/oracle-fulgora-ruins.seed123456.json";
import { makeFulgoraShared } from "../src/noise/expressions/fulgoraShared";
import { makeFulgoraCells } from "../src/noise/expressions/fulgoraCells";
import { makeFulgoraElevation } from "../src/noise/expressions/fulgoraElevation";
import { makeFulgoraMasks } from "../src/noise/expressions/fulgoraMasks";
import { makeFulgoraRoads } from "../src/noise/expressions/fulgoraRoads";
import { makeVoronoi } from "../src/noise/voronoiNoise";
import { renderFulgoraTerrain } from "../src/noise/preview/renderFulgoraTerrain";
import { sliderRescale } from "../src/noise/eval/math";

/**
 * Shared by every describe block that reads `oracle-fulgora-ruins.seed123456.json`
 * (masks here; Tasks 3 and 4 add the road/structure and ruins layers on top of
 * the same fixture). Module scope on purpose - the existing `check` helpers
 * above are each trapped inside their own `describe` and are not reachable from
 * anywhere else, and this one needs to be reachable from more than one.
 */
const checkRuins = (fn: (x: number, y: number) => number, want: number[], bound: number): void => {
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < ruinsFixture.positions.length; i++) {
    const p = ruinsFixture.positions[i] as { x: number; y: number };
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
      `(${String((ruinsFixture.positions[worstAt] as { x: number; y: number } | undefined)?.x)}, ` +
      `${String((ruinsFixture.positions[worstAt] as { x: number; y: number } | undefined)?.y)})`,
  ).toBeLessThanOrEqual(bound);
};

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
   * the split is the interesting part rather than the sizes. All three read the
   * same distorted coordinates. `cells` is a DISCRETE lookup - it returns which
   * cell won, so a sub-ulp coordinate error almost never changes the answer,
   * and it comes back f32-EXACT. `pyramids` and `spots` are continuous, so the
   * same input error passes straight through.
   *
   * Measured worst over the 101 positions: **1.19e-7 each, a single f32 ulp.**
   *
   * These bounds were 1e-5 when Task 8 landed, against a measured 7.11e-6 and
   * 7.54e-6, and the 60x improvement is not a change to this layer at all - it
   * is `makeVoronoi` narrowing its incoming coordinates to f32, which is what
   * the game does. Fulgora is the first caller to hand a voronoi op a DERIVED
   * coordinate rather than a raw world position, so it is the first place the
   * difference was observable. See the comment on `toGrid`.
   */
  it("matches fulgora_pyramids", () => {
    check(cells.pyramids, cellsFixture.fulgora_pyramids, 2e-7);
  });

  it("matches fulgora_spots and fulgora_spots_inv", () => {
    check(cells.spots, cellsFixture.fulgora_spots, 2e-7);
    check(cells.spotsInv, cellsFixture.fulgora_spots_inv, 2e-7);
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

/**
 * `slider_rescale(s, n) = 2^(log2(s)/log2(6)*log2(n))`
 * (`core/prototypes/noise-functions.lua:16`). `fulgora_natural` reads it as
 * `slider_rescale(control:fulgora_islands:size, 2)`.
 *
 * **The 101 captured positions cannot test this at all**, which is the reason
 * the fixture carries a separate probe. The default islands size slider is 1,
 * and `slider_rescale(1, n)` is `2^0 = 1` exactly for every `n` - so at default
 * settings the term is a multiply by one and any implementation whatsoever
 * would pass. Same trap as `grid_size` in the cells fixture: the default is the
 * one input that cannot discriminate.
 *
 * The probe passes literal slider values instead. Measured against the game
 * (2.1.14, `slider_rescale(s, 2)` at s = 0.5, 1, 2, 3, 4, 5, 6):
 *
 * | evaluation order | exact matches |
 * | --- | --- |
 * | **f32 per operation** | **7/7** |
 * | f64 throughout, one final round | 5/7 (misses 0.5 and 5 by 1 ulp) |
 * | fastapprox `pow` (the noise machine's `^`) | 1/7 |
 *
 * Two things follow, and neither was assumable. `slider_rescale` is **exact**
 * math, not the noise machine's fastapprox `^` - so like `slider_to_linear` it
 * is resolved on the prototype side. And it needs the same **per-operation f32
 * rounding** `slider_to_linear` needed.
 *
 * Note which values discriminate: s = 1 and s = 6 are blind by construction
 * (the exponent is exactly 0 and exactly 1), and s = 2, 3 and 4 happen to agree
 * between the f64 and f32 forms as well. Only **0.5 and 5** separate them, so
 * the sweep that settled `slider_to_linear` - 0.5, 1, 2, 3, 6 - would have
 * caught this on a single row.
 */
describe("slider_rescale", () => {
  const probe = elevationFixture.sliderRescaleProbe as Record<string, number>;

  it.each(Object.entries(probe))("matches the game at slider %s", (s, want) => {
    expect(Math.fround(sliderRescale(Number(s), 2))).toBe(Math.fround(want));
  });

  it("is exactly 1 at the default slider, and that is why the probe exists", () => {
    // Pins the reason this block cannot be folded into the position sweep.
    expect(sliderRescale(1, 2)).toBe(1);
    expect(probe["1"]).toBe(1);
  });

  it("the probe discriminates - not every candidate passes it", () => {
    // An f64 chain rounded once at the end. If this ever stops failing, the
    // probe has lost its power and the f32 rounding above is untested.
    const f64Form = (s: number, n: number) =>
      Math.fround(Math.pow(2, (Math.log2(s) / Math.log2(6)) * Math.log2(n)));
    const misses = Object.entries(probe)
      .filter(([s, want]) => f64Form(Number(s), 2) !== Math.fround(want))
      .map(([s]) => Number(s))
      .sort((a, b) => a - b);
    expect(misses).toEqual([0.5, 5]);
  });
});

/**
 * Fulgora's elevation mix chain.
 * Source: `planet-fulgora-map-gen.lua:206-336`, plus `fulgora_dunes` (513),
 * `fulgora_rock` (523) and `fulgora_scrap_medium` (371).
 *
 * Fixture positions are IDENTICAL to the shared and cells fixtures.
 *
 * `fulgora_natural_mask`, `fulgora_natural_and_mesa_mask`, `fulgora_sprawl_mask`
 * and `fulgora_artificial_mask` are defined in the middle of this same Lua
 * block and are deliberately NOT ported. That they are not needed is not an
 * assumption - `fulgora_elevation` here reproduces the game's own value to
 * 7.6e-5 without them, which it could not do if the chain read them.
 */
describe("makeFulgoraElevation", () => {
  const ctx = { seed0: elevationFixture.seed0 };
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const elevation = makeFulgoraElevation(shared, cells, ctx);
  const positions = elevationFixture.positions;

  /**
   * Compare at f32, with `bound` the measured worst for that field plus modest
   * headroom - never a blanket tolerance, so a regression in one field cannot
   * hide behind another's slack. Measured worst over the 101 positions:
   *
   * | field | worst | bound |
   * | --- | --- | --- |
   * | `oilMask` | **0** | 0 |
   * | `sprawlPyramids`, `mixPyramids` | 2.98e-8 | 1e-7 |
   * | `basis` | 2.09e-7 | 3e-7 |
   * | `rock`, `scrapMedium` | 2.38e-7 | 4e-7 |
   * | `dunes` | 2.68e-7 | 4e-7 |
   * | `mixNatural` | 3.87e-7 | 6e-7 |
   * | `vaultPyramids`, `vaultPyramidsAndStart` | 4.02e-7 | 6e-7 |
   * | `natural` | 4.77e-7 | 7e-7 |
   * | `basisOil` | 7.15e-7 | 1e-6 |
   * | `moats`, `mixMoats`, `mixSpots` | 1.19e-6 | 2e-6 |
   * | `mixOil`, `sandBasins` | 1.22e-6 | 2e-6 |
   * | `vaultSpots` | 5.06e-6 | 7e-6 |
   * | `preElevation`, `elevation` | 7.63e-5 | 1e-4 |
   *
   * **Every one of these is the port's `basisNoise` floor, carried through the
   * chain's own gains** - nothing here is a Fulgora-specific error. The two
   * apparent outliers are both arithmetic on that floor rather than new error:
   * `vaultSpots` applies a `-10 + 11.5 * ...` remap, so it multiplies its input
   * residual by 11.5, and `elevation` is `sandBasins * 60 + 80`, so 1.22e-6
   * becomes 7.3e-5. In relative terms `elevation` is the most accurate field in
   * the table, at 8e-7 of its own magnitude.
   *
   * `oilMask` being **exact** is the load-bearing row. It is a discrete
   * comparison, so a residual there would mean an upstream error had grown
   * enough to flip a sign - reclassifying land as ocean rather than shading it.
   */
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
      `worst residual ${worst.toExponential(3)} at position ${String(worstAt)} ` +
        `(${String((positions[worstAt] as { x: number; y: number } | undefined)?.x)}, ` +
        `${String((positions[worstAt] as { x: number; y: number } | undefined)?.y)})`,
    ).toBeLessThanOrEqual(bound);
  };

  it("shares its position set with the shared-layer fixture", () => {
    expect(positions).toEqual(fixture.positions);
  });

  it("matches the five multioctave sources", () => {
    check(elevation.basis, elevationFixture.fulgora_basis, 3e-7);
    check(elevation.basisOil, elevationFixture.fulgora_basis_oil, 1e-6);
    check(elevation.rock, elevationFixture.fulgora_rock, 4e-7);
    check(elevation.dunes, elevationFixture.fulgora_dunes, 4e-7);
    check(elevation.scrapMedium, elevationFixture.fulgora_scrap_medium, 4e-7);
  });

  it("matches fulgora_natural", () => {
    check(elevation.natural, elevationFixture.fulgora_natural, 7e-7);
  });

  it("matches the pyramid terms", () => {
    check(elevation.sprawlPyramids, elevationFixture.fulgora_sprawl_pyramids, 1e-7);
    check(elevation.vaultPyramids, elevationFixture.fulgora_vault_pyramids, 6e-7);
    check(elevation.vaultPyramidsAndStart, elevationFixture.fulgora_vault_pyramids_and_start, 6e-7);
    check(elevation.mixPyramids, elevationFixture.fulgora_mix_pyramids, 1e-7);
  });

  it("matches fulgora_moats", () => {
    check(elevation.moats, elevationFixture.fulgora_moats, 2e-6);
  });

  it("matches the mix chain", () => {
    check(elevation.mixNatural, elevationFixture.fulgora_mix_natural, 6e-7);
    check(elevation.mixMoats, elevationFixture.fulgora_mix_moats, 2e-6);
    // 11.5x its input residual, by the `-10 + 11.5 * max(...)` remap - the one
    // step in the chain with a gain worth naming.
    check(elevation.vaultSpots, elevationFixture.fulgora_vault_spots, 7e-6);
    check(elevation.mixSpots, elevationFixture.fulgora_mix_spots, 2e-6);
  });

  it("matches fulgora_oil_mask", () => {
    // Discrete, so it should be EXACT. If it ever is not, an upstream residual
    // has grown large enough to flip a sign at some position - which reclassifies
    // land as ocean rather than shading it, and is a real defect, not a rounding
    // tolerance to widen.
    check(elevation.oilMask, elevationFixture.fulgora_oil_mask, 0);
  });

  it("matches fulgora_mix_oil and fulgora_sand_basins", () => {
    check(elevation.mixOil, elevationFixture.fulgora_mix_oil, 2e-6);
    check(elevation.sandBasins, elevationFixture.fulgora_sand_basins, 2e-6);
  });

  it("matches fulgora_pre_elevation and fulgora_elevation", () => {
    // 60x sand_basins, so 1.22e-6 there arrives as 7.6e-5 here. Relative to a
    // field that runs 70-150, this is the most accurate row in the fixture.
    check(elevation.preElevation, elevationFixture.fulgora_pre_elevation, 1e-4);
    check(elevation.elevation, elevationFixture.fulgora_elevation, 1e-4);
  });

  it("elevation straddles the coastline - the fixture is not all land or all ocean", () => {
    const vals = (positions as { x: number; y: number }[]).map((p) =>
      elevation.elevation(p.x, p.y),
    );
    expect(vals.some((v) => v > 80)).toBe(true);
    expect(vals.some((v) => v <= 80)).toBe(true);
  });

  it("oil_mask is exactly mix_spots < 0", () => {
    for (const p of positions as { x: number; y: number }[]) {
      expect(elevation.oilMask(p.x, p.y)).toBe(elevation.mixSpots(p.x, p.y) < 0 ? 1 : 0);
    }
  });

  it("oil_mask takes both values in the fixture, so the check is not vacuous", () => {
    expect(new Set(elevationFixture.fulgora_oil_mask).size).toBe(2);
  });

  it("elevation is pre_elevation plus or minus half the coastline drop", () => {
    // The final step adds ((sand_basins > 0) - 0.5) * 20, so the two differ by
    // exactly +10 or -10 everywhere - never by anything else.
    for (const p of positions as { x: number; y: number }[]) {
      const d = elevation.elevation(p.x, p.y) - elevation.preElevation(p.x, p.y);
      expect(Math.abs(d), `at (${String(p.x)}, ${String(p.y)})`).toBeCloseTo(10, 9);
    }
  });
});

/**
 * Hash-pinning over the rendered image.
 *
 * The per-field specs above compare against the game, which is the real check.
 * This one catches a different failure: a change anywhere in the chain that
 * moves the picture without moving any field far enough to break its bound -
 * a reordered `max`, a lost `memoXY`, a palette edit, an off-by-one in the
 * pixel sweep. None of those are visible to a residual test.
 *
 * Four windows, each at two scales. `tilesPerPixel: 1` walks contiguous tiles
 * and so exercises the memo caches the way a real render does; `8` steps past
 * them and lands on a completely different set of Voronoi cells. The far-field
 * window matters on its own because that is where the f32 coordinate narrowing
 * bites (see `sumOctaves`), and the second seed is what would catch a constant
 * accidentally hardcoded from the fixture seed.
 *
 * A changed hash is NOT automatically a bug - it is a prompt to say which
 * change caused it. Re-pin deliberately, never to make the suite green.
 */
describe("renderFulgoraTerrain is stable", () => {
  const hash = (img: ImageData): string => {
    let h = 2166136261;
    for (let i = 0; i < img.data.length; i++) h = Math.imul(h ^ (img.data[i] as number), 16777619);
    return (h >>> 0).toString(16).padStart(8, "0");
  };

  const WINDOWS: ReadonlyArray<{
    name: string;
    seed0: number;
    originX: number;
    originY: number;
    hashes: Readonly<Record<number, string>>;
  }> = [
    {
      name: "near spawn",
      seed0: 123456,
      originX: -64,
      originY: -64,
      hashes: { 1: "eb312806", 8: "df976957" },
    },
    {
      name: "far field",
      seed0: 123456,
      originX: 6000,
      originY: -4000,
      hashes: { 1: "8577e6aa", 8: "50277b5f" },
    },
    {
      name: "off origin",
      seed0: 123456,
      originX: -1524,
      originY: 976,
      hashes: { 1: "156859be", 8: "14cb5c16" },
    },
    {
      name: "second seed",
      seed0: 987654,
      originX: -64,
      originY: -64,
      hashes: { 1: "84f3a789", 8: "c9aa4f56" },
    },
  ];

  it.each(WINDOWS)("$name renders a stable image", ({ seed0, originX, originY, hashes }) => {
    for (const tilesPerPixel of [1, 8] as const) {
      const img = renderFulgoraTerrain({
        seed0,
        width: 32,
        height: 32,
        originX,
        originY,
        tilesPerPixel,
      });
      expect(img.width).toBe(32);
      expect(hash(img), `tilesPerPixel ${String(tilesPerPixel)}`).toBe(hashes[tilesPerPixel]);
    }
  });

  it("the windows are not all the same picture", () => {
    // Four identical hashes would pin nothing. Renders that differ prove each
    // window is actually reaching different terrain.
    const seen = new Set(
      WINDOWS.map((w) =>
        hash(
          renderFulgoraTerrain({
            seed0: w.seed0,
            width: 32,
            height: 32,
            originX: w.originX,
            originY: w.originY,
            tilesPerPixel: 8,
          }),
        ),
      ),
    );
    expect(seen.size).toBe(WINDOWS.length);
  });

  it("tilesPerPixel 1 and 8 disagree, so both scales are real", () => {
    const at = (tilesPerPixel: number) =>
      hash(
        renderFulgoraTerrain({
          seed0: 123456,
          width: 32,
          height: 32,
          originX: -64,
          originY: -64,
          tilesPerPixel,
        }),
      );
    expect(at(1)).not.toBe(at(8));
  });
});

describe("makeFulgoraMasks", () => {
  const ctx = { seed0: ruinsFixture.seed0 };
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);
  const masks = makeFulgoraMasks(shared, cells, chain);

  /**
   * The three masks are built from comparisons and `max`/`min`, so every value
   * is exactly 0 or 1 and the bound is 0 - not a tolerance, an identity. A
   * non-integer here means a comparison was ported as arithmetic.
   */
  it("matches the game exactly on all three masks", () => {
    checkRuins(masks.naturalMask, ruinsFixture.fulgora_natural_mask, 0);
    checkRuins(masks.naturalAndMesaMask, ruinsFixture.fulgora_natural_and_mesa_mask, 0);
    checkRuins(masks.artificialMask, ruinsFixture.fulgora_artificial_mask, 0);
  });

  it("the masks are not all one value, so the test above discriminates", () => {
    const distinct = (v: number[]) => new Set(v).size;
    expect(distinct(ruinsFixture.fulgora_natural_mask)).toBe(2);
    expect(distinct(ruinsFixture.fulgora_artificial_mask)).toBe(2);
  });
});

describe("makeFulgoraRoads", () => {
  const ctx = { seed0: ruinsFixture.seed0 };
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const roads = makeFulgoraRoads(shared, cells, ctx);

  /**
   * Compare at f32, `bound` the measured worst residual for that field with
   * modest headroom - never a blanket tolerance, so a regression in one field
   * cannot hide behind another's slack. Measured worst, 101 positions:
   *
   * | field | worst | bound |
   * | --- | --- | --- |
   * | `roadCells`, `structureCells` | **0** | 0 |
   * | `roadPyramids` | **0** | 0 |
   * | `roadPavingThin`, `roadPaving2`, `roadPaving2b`, `roadPaving2c`, `roadDust` | **0** | 0 |
   * | `pyramidsBanding` | 9.54e-7 | 1.5e-6 |
   * | `spotsPrebanding` | 3.58e-6 | 5e-6 |
   * | `spotsBanding` | 3.64e-6 | 5e-6 |
   * | `structureFacets` | 7.63e-6 | 1e-5 |
   * | `structureSubnoise` | 3.91e-5 | 5e-5 |
   *
   * `roadCells` and `structureCells` are cell IDs, and `roadPavingThin` through
   * `roadDust` are built from comparisons/lerps of comparisons, so all seven are
   * exact by construction - a non-zero residual there would mean a rounding
   * error grew large enough to flip a comparison, not a tolerance to widen.
   * `roadPyramids` is continuous but ALSO came back bit-exact: unlike
   * `cells.pyramids` in `fulgoraCells.ts`, it is sampled at the RAW (x, y) with
   * no wobble distortion, so the input is already on the f32 grid the game
   * itself samples - no coordinate-rounding error to carry through.
   *
   * The rest carry the port's known `basisNoise` floor (this port evaluates it
   * in f64 where the game uses f32), scaled by how the expression composes it.
   * `structureSubnoise` is the largest because it is sampled at a coordinate up
   * to `x + 10000 * structureCells` - the derived-coordinate f32-narrowing case
   * `makeMultioctaveNoise` handles internally (see the file header); without
   * that narrowing this field misses by two more orders of magnitude.
   *
   * The `%` question (Step 4) did not arise: `pyramidsBanding` and
   * `spotsBanding` both passed comfortably against the brief's starting bounds,
   * and the fixture's own `fulgora_spots_prebanding` / `fulgora_pyramids_banding`
   * arrays never go negative (checked directly), so JS `%`'s sign convention was
   * never exercised at any of the 101 positions - there is nothing here to
   * distinguish flooring modulo from C `fmod`.
   */
  it("matches the game on the road and structure layer", () => {
    checkRuins(roads.roadCells, ruinsFixture.fulgora_road_cells, 0);
    checkRuins(roads.structureCells, ruinsFixture.fulgora_structure_cells, 0);
    checkRuins(roads.roadPyramids, ruinsFixture.fulgora_road_pyramids, 0);
    checkRuins(roads.structureFacets, ruinsFixture.fulgora_structure_facets, 1e-5);
    checkRuins(roads.structureSubnoise, ruinsFixture.fulgora_structure_subnoise, 5e-5);
    checkRuins(roads.pyramidsBanding, ruinsFixture.fulgora_pyramids_banding, 1.5e-6);
    checkRuins(roads.spotsPrebanding, ruinsFixture.fulgora_spots_prebanding, 5e-6);
    checkRuins(roads.spotsBanding, ruinsFixture.fulgora_spots_banding, 5e-6);
    checkRuins(roads.roadPavingThin, ruinsFixture.fulgora_road_paving_thin, 0);
    checkRuins(roads.roadPaving2, ruinsFixture.fulgora_road_paving_2, 0);
    checkRuins(roads.roadPaving2b, ruinsFixture.fulgora_road_paving_2b, 0);
    checkRuins(roads.roadPaving2c, ruinsFixture.fulgora_road_paving_2c, 0);
    checkRuins(roads.roadDust, ruinsFixture.fulgora_road_dust, 0);
  });
});
