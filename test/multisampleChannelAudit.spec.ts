import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/oracle-vulcanus-tile-names.seed123456.json";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import {
  makeVulcanusStack,
  makeVulcanusTileResolverFrom,
  type VulcanusStack,
} from "../src/noise/tiles/vulcanusCatalog";

/**
 * **The channel audit for `multisample` (issue #84 item 4).**
 *
 * #83 found that `multisample`'s offsets are in the CALLING noise program's grid
 * units, so `vulcanus_basalt_lakes_multisample` is a 4-tile min-filter for the
 * cliff generator and a 1-tile one for `calculate_tile_properties`. The port had
 * used the 1-tile field for both. The obvious follow-up question is whether any
 * OTHER consumer reads a `multisample`-bearing field on a grid that is not 1
 * tile - and cliffs being the only coarse-grid consumer was an assumption, not a
 * measurement, which is exactly the status the cliff case had before #83.
 *
 * **The audit surface is far smaller than it looks, and that is a finding.**
 * `multisample` appears in `~/GitHub/factorio-data` @ 2.1.12 in exactly ONE
 * place - `vulcanus_basalt_lakes_multisample`
 * (`space-age/prototypes/planet/planet-vulcanus-map-gen.lua:547`), used only by
 * `vulcanus_elev`. Nothing on Nauvis, Gleba, Fulgora or Aquilo uses the
 * primitive at all. So "audit every consumer of a multisample-bearing field"
 * reduces to "audit every consumer of Vulcanus `elevation`", and that list is
 * short enough to close by reading the planet definition
 * (`space-age/prototypes/planet/planet-map-gen.lua:4-30`):
 *
 * | consumer | reads `elevation`? | grid |
 * | --- | --- | --- |
 * | cliff generator (`cliff_elevation_from_elevation`) | yes | **4** - #83 |
 * | tile generator (the 19 `*_range` expressions) | yes, via `vulcanus_elev` | 1 - measured below |
 * | `vulcanus_temperature` | yes, `min(elev, elev/100)` | 1, same program as tiles |
 * | resources (tungsten / coal / calcite / sulfuric acid) | **no** | n/a |
 * | rocks, geyser | **no** | n/a |
 *
 * The resource line is the one worth stating explicitly, because the generic
 * `resource_autoplace_all_patches` path DOES couple to elevation -
 * `starting_resources_lake_mask = clamp((elevation - 1) / 10, 0, 1)` feeds
 * `starting_patches`' `spot_favorability_expression`
 * (`core/prototypes/noise-programs.lua:270`). Vulcanus does not use that path:
 * each of its four resources is placed by its own `vulcanus_*_region`
 * expression, and grepping those four definitions for `elevation` returns **0**.
 * So the lake mask is a Nauvis-only coupling and no Vulcanus resource can see
 * the multisample. (`src/noise/resources/startingPatches.ts` hardcodes
 * `makeElevationNauvis` for the same reason.)
 *
 * That leaves the tile generator as the only consumer whose grid had to be
 * measured rather than reasoned about, which is what this file does.
 */
describe("multisample channel audit - which consumers read which grid", () => {
  const positions = fixture.positions;
  const want = fixture.tileNames;

  /** A stack whose tile-facing `elev` is the CLIFF generator's 4-tile field. */
  const swappedStack = (base: VulcanusStack): VulcanusStack => ({
    ...base,
    elevation: {
      ...base.elevation,
      elev: (x, y) => base.elevation.cliffElevation(x, y),
      elevation: (x, y) => base.elevation.cliffElevation(x, y),
    },
  });

  const agreement = (resolve: (x: number, y: number) => { name: string }): number => {
    let agree = 0;
    for (let i = 0; i < positions.length; i++)
      if (resolve(positions[i].x, positions[i].y).name === want[i]) agree++;
    return agree / positions.length;
  };

  /**
   * The substitution is only exact if the `max(-500, ...)` clamp never bites,
   * because `cliffElevation` is clamped and `elev` is not. Asserted rather than
   * assumed: if a probe position ever sits below -500 this arm is comparing
   * something subtly different from "the same field at grid 4".
   */
  it("the clamp never bites at these positions, so the swap is exact", () => {
    const stack = makeVulcanusStack({ seed0: fixture.seed0 });
    let min = Infinity;
    for (const p of positions) min = Math.min(min, stack.elevation.elev(p.x, p.y));
    expect(min).toBeGreaterThan(-500);
  }, 120000);

  /**
   * **The tile generator runs at grid 1, measured.** Feeding it the cliff
   * generator's 4-tile elevation instead collapses agreement with the game's own
   * `get_tile` output. The 1-tile field is not merely adequate - it is the one
   * that matches, and the metric is demonstrably sensitive to the difference,
   * which is what stops "no change" from being the vacuous answer it was for
   * PR #57's field substitution.
   *
   * Measured 2026-08-01 over the 381 oracle positions: **0.9816 at grid 1
   * against 0.8609 at grid 4** - 46 tiles the port would name wrongly if the
   * tile generator shared the cliff generator's channel. The gap is the whole
   * point; the grid-4 number is pinned only loosely, as an upper bound well
   * below the grid-1 floor.
   */
  it("TILES read the 1-tile channel - the 4-tile field disagrees with the game", () => {
    const base = makeVulcanusStack({ seed0: fixture.seed0 });
    const atGrid1 = agreement(makeVulcanusTileResolverFrom(base));
    const atGrid4 = agreement(makeVulcanusTileResolverFrom(swappedStack(base)));

    // Grid 1 is the shipping configuration and `vulcanusTiles.spec.ts` owns its
    // floor; repeated here only so the comparison is self-contained.
    console.log(`vulcanus tile agreement: grid1=${atGrid1.toFixed(4)} grid4=${atGrid4.toFixed(4)}`);
    expect(atGrid1).toBeGreaterThan(0.978);
    // The substitution must actually move the answer. Without this, a swap that
    // silently failed to apply would read as "the grids agree".
    expect(atGrid4).toBeLessThan(atGrid1 - 0.02);
  }, 120000);

  /**
   * The same question asked of the binary lava classification, which is the only
   * thing the cliff collision rejection reads. It is exact at grid 1 (49/49 both
   * ways, pinned in `vulcanusTiles.spec.ts`); at grid 4 it is **27 wrong out of
   * 381**.
   *
   * This is the sharper of the two arms for the audit's purpose. A tile-name
   * argmax can flip between two members of one biome family for precision
   * reasons, but lava/not-lava is a wide margin, so a mismatch here means the
   * field is genuinely different rather than near a tie. 0 -> 27 is that.
   *
   * It also settles a question the cliff work left hanging in the other
   * direction: the lava perimeter that costs 13 real cliffs their placement
   * (`vulcanusCliffEntities.spec.ts`) is NOT the tile resolver reading the wrong
   * elevation channel. Reading the other channel makes lava dramatically worse,
   * not better.
   */
  it("LAVA classification is exact at grid 1 and not at grid 4", () => {
    const base = makeVulcanusStack({ seed0: fixture.seed0 });
    const count = (resolve: (x: number, y: number) => { name: string }): number => {
      let mismatch = 0;
      for (let i = 0; i < positions.length; i++) {
        const ours = VULCANUS_CLIFF_BLOCKING_TILES.has(
          resolve(positions[i].x, positions[i].y).name,
        );
        if (ours !== VULCANUS_CLIFF_BLOCKING_TILES.has(want[i])) mismatch++;
      }
      return mismatch;
    };
    const at1 = count(makeVulcanusTileResolverFrom(base));
    const at4 = count(makeVulcanusTileResolverFrom(swappedStack(base)));
    console.log(`vulcanus lava mismatches: grid1=${String(at1)} grid4=${String(at4)} of 381`);
    expect(at1).toBe(0);
    // Non-vacuity in the same breath: the swap must actually change the field.
    expect(at4).toBeGreaterThan(10);
  }, 120000);
});
