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
import { makeFulgoraRuins } from "../src/noise/expressions/fulgoraRuins";
import { makeFulgoraLandProbabilities } from "../src/noise/tiles/fulgoraCatalog";
import { makeVoronoi } from "../src/noise/voronoiNoise";
import { renderFulgoraTerrain } from "../src/noise/preview/renderFulgoraTerrain";
import { sliderRescale } from "../src/noise/eval/math";

/**
 * Build the bound-checked comparator for one fixture's position list.
 *
 * Every `describe` block below compares the same way: walk the fixture's
 * positions, evaluate the ported field, and assert the WORST absolute residual
 * against the game's value stays within that field's own bound. Only the
 * position list differs, so it is the only parameter.
 *
 * **Compare at f32.** Both sides are narrowed with `Math.fround` first. The
 * game reports f32 values and this port evaluates in f32, so an f64 comparison
 * would be measuring JavaScript's extra precision rather than the port.
 *
 * **`bound` is the measured worst residual for that one field, with modest
 * headroom - never a blanket tolerance.** Each caller passes its own, so a
 * regression in one field cannot hide behind another field's slack, and a
 * field that should be exact is bounded at 0 rather than at "small". Widening
 * a bound to make a test pass has hidden a real defect twice on this port; see
 * `src/noise/eval/f32.ts` for both cases and what to check instead.
 *
 * The failure message names the worst position AND its coordinates, so a red
 * test points at a place on the map you can sample directly.
 */
const makeCheck =
  (positions: readonly { x: number; y: number }[]) =>
  (fn: (x: number, y: number) => number, want: number[], bound: number): void => {
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
    const at = positions[worstAt] as { x: number; y: number } | undefined;
    expect(
      worst,
      `worst residual ${worst.toExponential(3)} at position ${String(worstAt)} ` +
        `(${String(at?.x)}, ${String(at?.y)})`,
    ).toBeLessThanOrEqual(bound);
  };

/**
 * Shared by every describe block that reads `oracle-fulgora-ruins.seed123456.json`
 * (the masks, the road/structure layer and the ruins layer all sample the same
 * fixture). Module scope because more than one block needs it; the per-block
 * comparators below are built from the same factory and stay local.
 */
const checkRuins = makeCheck(ruinsFixture.positions);

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
   * See `makeCheck` for how the comparison works and what a `bound` means.
   * Measured worst, 101 positions:
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
  const check = makeCheck(positions);

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

  const check = makeCheck(positions);

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
  const check = makeCheck(positions);

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
 * Five windows, each at two scales. `tilesPerPixel: 1` walks contiguous tiles
 * and so exercises the memo caches the way a real render does; `8` steps past
 * them and lands on a completely different set of Voronoi cells. The far-field
 * window matters on its own because that is where the f32 coordinate narrowing
 * bites (see `sumOctaves`), and the second seed is what would catch a constant
 * accidentally hardcoded from the fixture seed.
 *
 * **The first four windows are 100% ocean at `tilesPerPixel: 1`** - measured
 * by counting colours in each rendered window, not assumed from the hashes.
 * The `tpp: 8` column is the POST-Task-5 breakdown (all eight land tiles);
 * before this task's eight-way argmax, the same four windows' `tpp: 8` pixels
 * split across only `dunes`/`rock`/`sand` (e.g. near spawn was dunes 43, rock
 * 74, sand 31 - the same 148 land pixels, previously argmaxed over three
 * tiles instead of eight), which is why re-pinning those hashes when the
 * palette widened was expected rather than a bug:
 *
 * | window | `tpp: 1` | `tpp: 8` |
 * | --- | --- | --- |
 * | near spawn | deep 969, shallow 55 - no land | deep 329, shallow 547, rock 53, paving 25, dunes 22, sand 19, machinery 10, walls 8, dust 6, conduit 5 |
 * | far field | deep 915, shallow 109 - no land | deep 319, shallow 357, rock 100, paving 66, walls 56, dunes 48, sand 29, conduit 25, machinery 15, dust 9 |
 * | off origin | deep 941, shallow 83 - no land | deep 369, shallow 334, paving 86, rock 74, walls 37, dunes 34, dust 29, sand 23, conduit 23, machinery 15 |
 * | second seed | deep 118, shallow 906 - no land | deep 313, shallow 502, rock 49, paving 40, dunes 30, dust 28, sand 23, walls 22, machinery 11, conduit 6 |
 *
 * The ocean halves (`deep`/`shallow` counts) are UNCHANGED from the pre-Task-5
 * measurement in all four windows - a second, independent confirmation
 * (alongside `fulgoraAgreement.spec.ts`'s pinned 7-and-11) that the land
 * argmax did not move the land/ocean boundary.
 *
 * That is the scale a real render actually uses, so the fifth window
 * (`land core`) exists to give the eight land colours coverage at `tpp: 1`
 * too - without it a land-argmax regression could only be caught at `tpp: 8`,
 * past the memo caches, on a different set of Voronoi cells entirely.
 *
 * **Its origin was chosen by measurement, not by guess.** A sweep evaluated
 * the resolver's 32x32 `tpp: 1` footprint at every point on a 128-tile grid
 * across the full [-6000, 6000] square (step 128, ~8800 candidate origins,
 * ~46s) and kept every origin whose footprint contained at least four distinct
 * land tiles - 3637 of them qualified, most with all eight. `(-5872, 3088)` was
 * picked from that set because its footprint contains all EIGHT land tiles and
 * NO ocean tile at all, with no tile reduced to a token pixel: `fulgoran-rock`
 * 370, `fulgoran-walls` 244, `fulgoran-paving` 179, `fulgoran-dunes` 125,
 * `fulgoran-conduit` 63, `fulgoran-sand` 31, `fulgoran-machinery` 9,
 * `fulgoran-dust` 3 (of 1024 pixels). A regression that recolours or
 * misclassifies any of the eight land tiles has a real chance of moving this
 * window's `tpp: 1` hash, which none of the other four can offer.
 *
 * Re-pinning the first four windows' `tpp: 8` hashes when this task's palette
 * landed was expected, not a bug: those windows already contain land pixels at
 * `tpp: 8` (see the table above), and the palette gained five new colours plus
 * changed all three land tiles it already had (`fulgoran-dust` is new;
 * `fulgoran-dunes`/`-sand`/`-rock` are unchanged tile CLASSES but some
 * positions that used to fall through to one of those three - because only
 * three land tiles existed to argmax against - now correctly resolve to one of
 * the five new tiles instead, changing pixels these windows already painted).
 * Their `tpp: 1` hashes did NOT move, confirming the "100% ocean" measurement
 * above still holds after the palette change.
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
      hashes: { 1: "eb312806", 8: "7d185bba" },
    },
    {
      name: "far field",
      seed0: 123456,
      originX: 6000,
      originY: -4000,
      hashes: { 1: "8577e6aa", 8: "ae435250" },
    },
    {
      name: "off origin",
      seed0: 123456,
      originX: -1524,
      originY: 976,
      hashes: { 1: "156859be", 8: "1ea17751" },
    },
    {
      name: "second seed",
      seed0: 987654,
      originX: -64,
      originY: -64,
      hashes: { 1: "84f3a789", 8: "0febee19" },
    },
    {
      // Land-centred: (-5872, 3088), seed 123456. All eight land tiles, no
      // ocean at all - see the header comment above for how this origin was
      // chosen and what it contains.
      name: "land core",
      seed0: 123456,
      originX: -5872,
      originY: 3088,
      hashes: { 1: "a3a580a9", 8: "82ca093c" },
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
    // Five identical hashes would pin nothing. Renders that differ prove each
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
    expect(distinct(ruinsFixture.fulgora_natural_and_mesa_mask)).toBe(2);
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
   * | `structureFacets` | **0** | 0 |
   * | `structureSubnoise` | 2.98e-7 | 4e-7 |
   * | `pyramidsBanding` | 9.54e-7 | 1.5e-6 |
   * | `spotsPrebanding` | 3.58e-6 | 5e-6 |
   * | `spotsBanding` | 3.64e-6 | 5e-6 |
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
   * `structureFacets` is ALSO now bit-exact, and it did not start that way -
   * it was 7.63e-6 (the worst of the thirteen at the time) until a fix-round
   * review caught that `structure_cells`/`structure_facets` sample at
   * `y * 0.8`, and the engine's `0.8` is an f32 CONSTANT
   * (0.80000001192092895508), not the f64 literal this port was using
   * (0.80000000000000004441) - two different numbers. Narrowing the PRODUCT
   * (`f32(y * 0.8)`) does nothing at all (still 7.63e-6); only narrowing the
   * CONSTANT itself (`y * f32(0.8)`, see the call site) does. This is a
   * different defect from `structureSubnoise`'s below - that one needed the
   * product narrowed, this one needs the constant narrowed - do not conflate
   * the two fixes or assume one covers the other.
   *
   * The rest carry the port's known `basisNoise` floor (this port evaluates it
   * in f64 where the game uses f32), scaled by how the expression composes it -
   * and for `pyramidsBanding` that scaling is an EXACT, checked identity, not
   * just a family resemblance: it is `(cells.pyramids(x, y) * 8) % 1`, an f32
   * multiply by a power of two is exact in IEEE 754, and the measured worst
   * residuals confirm it - `cells.pyramids` 1.1920928955078125e-7,
   * `pyramidsBanding` 9.5367431640625e-7, a ratio of exactly 8, both at the
   * SAME fixture position (index 45 of 101). `spotsPrebanding` does NOT close
   * this cleanly the same way (measured ratio to `startingVaultCone`'s
   * residual is 4.44, not the 4.5 its `(1 - cone) / 2 * 9` coefficients would
   * predict, and the two worst cases fall at different positions, 43 vs 47) -
   * see `docs/noise/fulgora-elevation-NOTES.md`'s Task 13 for the full
   * decomposition and why that one stays a family resemblance, not an
   * identity.
   * `structureSubnoise` used to be the worst of the thirteen by a wide margin -
   * 3.91e-5, an order of magnitude above every other continuous field - because
   * narrowing only happened where its coordinate crossed into
   * `makeMultioctaveNoise`. The engine evaluates every op in f32, so
   * `10000 * structure_cells` is itself an f32 multiply; narrowing the PRODUCT
   * (see the file header) drops the residual to 2.98e-7, back in line with its
   * siblings - a 131x improvement, not a wider tolerance.
   *
   * The `%` question (Step 4) did not arise: `pyramidsBanding` and
   * `spotsBanding` both passed comfortably against the brief's starting bounds.
   * The OPERANDS that would decide it are `cells.pyramids(x, y) * 8` (for
   * `pyramidsBanding`) and `fulgora_spots_prebanding` itself (for
   * `spotsBanding`) - not `fulgora_pyramids_banding`, which is the fixture's
   * POST-modulo result and cannot discriminate a sign convention either way
   * (checked directly: it spans 0.002517 to 0.999766, and a flooring modulo
   * never leaves `[0, 1)` regardless of its operand's sign). The real operands,
   * `fulgora_pyramids * 8` (minimum 0.022018) and `fulgora_spots_prebanding`
   * (minimum 0.70791), never go negative at these 101 positions, so JS `%`'s
   * sign convention was never exercised here - see
   * `docs/noise/fulgora-elevation-NOTES.md`'s Task 13 for the wider-map sweep.
   */
  it("matches the game on the road and structure layer", () => {
    checkRuins(roads.roadCells, ruinsFixture.fulgora_road_cells, 0);
    checkRuins(roads.structureCells, ruinsFixture.fulgora_structure_cells, 0);
    checkRuins(roads.roadPyramids, ruinsFixture.fulgora_road_pyramids, 0);
    checkRuins(roads.structureFacets, ruinsFixture.fulgora_structure_facets, 0);
    checkRuins(roads.structureSubnoise, ruinsFixture.fulgora_structure_subnoise, 4e-7);
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

describe("makeFulgoraRuins", () => {
  const ctx = { seed0: ruinsFixture.seed0 };
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);
  const masks = makeFulgoraMasks(shared, cells, chain);
  const roads = makeFulgoraRoads(shared, cells, ctx);
  const ruins = makeFulgoraRuins(cells, masks, roads, ctx);

  /**
   * Compare at f32, `bound` the measured worst residual for that field with
   * modest headroom - never a blanket tolerance, so a regression in one field
   * cannot hide behind another's slack. Measured worst, 101 positions:
   *
   * | field | worst | bound |
   * | --- | --- | --- |
   * | `ruinsPaving` | 2.38e-7 | 4e-7 |
   * | `ruinsWalls` | 3.87e-7 | 6e-7 |
   * | `tileRuinMachinery` | 3.80e-7 | 6e-7 |
   * | `tileRuinConduit` | 4.17e-7 | 6e-7 |
   * | `tileRuinPaving`, `tileRuinWalls` | 4.77e-7 | 7e-7 |
   *
   * `ruinsWalls` and `ruinsPaving` are raw multioctave fields, so they carry the
   * same `basisNoise` floor as `fulgora_dunes`/`fulgora_rock` in
   * `fulgoraElevation.ts` (both 4e-7) - nothing Fulgora- or ruins-specific.
   *
   * **This table was wrong once.** The first Step 4 pass measured
   * `tileRuinWalls`/`tileRuinConduit`/`tileRuinMachinery` at 1.90e-5, 9.95e-6
   * and 1.21e-5 - all three above the brief's `1e-5` starting bound - and
   * WIDENED their bounds to 3e-5/1.5e-5/2e-5 to make the test pass, in direct
   * violation of the "tighten only" rule (the report at the time also
   * incorrectly claimed no bound had been loosened). That was the wrong call:
   * the three had inherited `structureFacets`' 7.63e-6 residual (scaled 4x, 2x
   * and 2.5x by their own coefficients), and `structureFacets` itself was
   * wrong, not at its floor - see the fix in `fulgoraRoads.ts`'s comment table
   * above. Once `structureFacets` came back bit-exact, all three fields here
   * dropped 24x-40x to the row above, back under their own basisNoise floor
   * and comfortably under the brief's original `1e-5` with no widening at all.
   *
   * `tileRuinConduit` and `tileRuinMachinery` have ONLY the `artificialMask`
   * term, so their masked-in branch (where the residual above is even
   * reachable) is exercised at just the 9 of 101 positions where
   * `artificial_mask` is 1 - weaker evidence than the other rows in this
   * table, not stronger, though the wider land argmax closes most of that gap:
   * `test/fulgoraLandTiles.spec.ts`'s 2261-position gate (not the 828-position
   * three-tile subset, which contains zero `fulgoran-conduit` or
   * `fulgoran-machinery` positions and so could never have covered these two
   * fields at all) measures `fulgoran-conduit` at 147/147 and
   * `fulgoran-machinery` at 108/108, both 100% recall.
   */
  it("matches the game on the two ruins noise fields", () => {
    checkRuins(ruins.ruinsWalls, ruinsFixture.fulgora_ruins_walls, 6e-7);
    checkRuins(ruins.ruinsPaving, ruinsFixture.fulgora_ruins_paving, 4e-7);
  });

  it("matches the game on all four tile_ruin outputs", () => {
    checkRuins(ruins.tileRuinPaving, ruinsFixture.fulgora_tile_ruin_paving, 7e-7);
    checkRuins(ruins.tileRuinWalls, ruinsFixture.fulgora_tile_ruin_walls, 7e-7);
    checkRuins(ruins.tileRuinConduit, ruinsFixture.fulgora_tile_ruin_conduit, 6e-7);
    checkRuins(ruins.tileRuinMachinery, ruinsFixture.fulgora_tile_ruin_machinery, 6e-7);
  });

  /**
   * `tile_ruin_conduit` and `tile_ruin_machinery` subtract `road_paving_2c`
   * OUTSIDE the artificial-mask product as well as inside it, so they are
   * negative over most of the map rather than zero. A port that dropped the
   * trailing term would still pass a "close to the fixture" check wherever the
   * mask is 0 unless the fixture actually varies there.
   */
  it("the conduit field is not constant off the artificial mask", () => {
    const off = ruinsFixture.fulgora_tile_ruin_conduit.filter(
      (_v: number, i: number) => ruinsFixture.fulgora_artificial_mask[i] === 0,
    );
    expect(new Set(off).size).toBeGreaterThan(1);
  });
});

/**
 * The four COMPOSITE land-tile probabilities, checked against the game.
 *
 * **Why these four needed their own rows.** Eight land tiles compete in the
 * argmax. Four of them (`fulgoran-paving`, `-walls`, `-conduit`, `-machinery`)
 * declare a bare `fulgora_tile_ruin_*` name, so the game reports their
 * probability directly and the block above already bounds it. The other four
 * write the arithmetic out in `tiles-fulgora.lua` and name nothing, so until
 * now the ONLY thing standing behind their transcription was the argmax's
 * winner - and that argmax carries a 5.5% residual nobody has explained (124
 * of 2261 land positions, `test/fulgoraLandTiles.spec.ts`). An unexplained
 * residual cannot clear a formula. These rows close that gap by sampling the
 * verbatim expression strings through the game and comparing the port's own
 * `landProbabilitiesFrom` against them.
 *
 * Measured worst over the 101 positions:
 *
 * | tile | expression | worst | bound |
 * | --- | --- | --- | --- |
 * | `fulgoran-dunes` | `1 + fulgora_dunes` | 3.58e-7 | 5e-7 |
 * | `fulgoran-sand` | `1 - fulgora_dunes` | 3.58e-7 | 5e-7 |
 * | `fulgoran-dust` | `scrap_medium + max(0, natural, 2*mesa*pyramids)*2 - 0.9 + rock + road_dust*sprawl` | 8.05e-7 | 1e-6 |
 * | `fulgoran-rock` | `0.8 + fulgora_rock * 2 - max(0, fulgora_mix_oil) * 6` | 6.80e-6 | 9e-6 |
 *
 * **`fulgoran-rock` is 19x its siblings, and that is its own coefficients, not
 * a defect - the arithmetic is checked, not asserted.** It multiplies
 * `fulgora_mix_oil` by **6**, and `mixOil`'s own measured worst is 1.22e-6
 * (see the `makeFulgoraElevation` table above), so that term alone predicts
 * `6 x 1.22e-6 = 7.3e-6`; the `fulgora_rock * 2` term adds at most
 * `2 x 2.38e-7`. The measured 6.80e-6 sits just under that ceiling, which is
 * what a chain carrying its inputs' `basisNoise` floor through its own gains
 * looks like. If this row ever needs a bound above ~9e-6 the thing to check is
 * `mixOil`, not this expression - and read the `makeFulgoraRuins` table above
 * first, where widening a bound instead of asking that question hid a real
 * 24x-40x defect on this same branch.
 *
 * `dunes` and `sand` land above `fulgora_dunes`' own 2.68e-7 for a duller
 * reason: `1 +/- dunes` shifts the magnitude to ~1.6-2.0, where one f32 ULP is
 * 1.19e-7, so the result is a couple of ULPs at the new magnitude.
 */
describe("the four composite land-tile probabilities", () => {
  const landProbabilities = makeFulgoraLandProbabilities({ seed0: ruinsFixture.seed0 });

  // Index into LAND_ORDER in `src/noise/tiles/fulgoraCatalog.ts`. Only the four
  // composites are checked here; 4-7 are the tile_ruin fields above.
  const at =
    (index: number) =>
    (x: number, y: number): number =>
      landProbabilities(x, y)[index] as number;

  it("matches the game on all four", () => {
    checkRuins(at(0), ruinsFixture.fulgoran_dust_probability, 1e-6);
    checkRuins(at(1), ruinsFixture.fulgoran_dunes_probability, 5e-7);
    checkRuins(at(2), ruinsFixture.fulgoran_sand_probability, 5e-7);
    checkRuins(at(3), ruinsFixture.fulgoran_rock_probability, 9e-6);
  });

  /**
   * The capture routed four separate expressions, and this is what proves it
   * rather than assuming it. `fulgoran-dunes` is `1 + fulgora_dunes` and
   * `fulgoran-sand` is `1 - fulgora_dunes`, so the GAME's own two rows must
   * sum to exactly 2 at every position. They do - 101 of 101, worst deviation
   * 0 - which no copy-paste of one expression into both slots could produce.
   * It also pins the sign: swapping the two rows would leave every other
   * assertion in this block passing.
   */
  it("the game's dunes and sand rows sum to exactly 2", () => {
    const dunes = ruinsFixture.fulgoran_dunes_probability;
    const sand = ruinsFixture.fulgoran_sand_probability;
    for (let i = 0; i < dunes.length; i++) {
      const sum = Math.fround(Math.fround(dunes[i] as number) + Math.fround(sand[i] as number));
      expect(sum, `dunes + sand at position ${String(i)}`).toBe(2);
    }
  });

  /**
   * A constant row would make every bound above pass for the wrong reason -
   * the mask-gated fields in the block above are exactly where that risk is
   * real. All four of these vary at every position, so none of them is being
   * checked against a flat line.
   */
  it("no row is constant", () => {
    for (const [name, row] of [
      ["dust", ruinsFixture.fulgoran_dust_probability],
      ["dunes", ruinsFixture.fulgoran_dunes_probability],
      ["sand", ruinsFixture.fulgoran_sand_probability],
      ["rock", ruinsFixture.fulgoran_rock_probability],
    ] as const) {
      expect(new Set(row).size, `${name} distinct values`).toBe(row.length);
    }
  });
});
