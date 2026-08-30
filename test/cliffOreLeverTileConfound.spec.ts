import { describe, expect, it } from "vite-plus/test";

import lever from "./fixtures/oracle-vulcanus-tile-lever.seed123456.json";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/cliffs/cliffCatalog";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { DEFAULT_VULCANUS_RESOURCE_CONTROLS } from "../src/noise/eval/ctx";

/**
 * **`autoplace_controls` is NOT an entity-only lever - it moves 5% of the tiles -
 * but no moved tile is cliff-blocking** (#84).
 *
 * Every ore result in #84 uses the same instrument: switch a resource off through
 * `map_gen_settings.autoplace_controls` and see which cliffs come back. That
 * instrument was assumed to remove entities and nothing else. It does more, and
 * the Lua says so outright.
 *
 * `space-age/prototypes/planet/planet-vulcanus-map-gen.lua` defines
 *
 * ```lua
 * vulcanus_calcite_size   = "slider_rescale(control:calcite:size, 2)"
 * vulcanus_calcite_region = "max(vulcanus_starting_calcite,
 *                                min(1 - vulcanus_starting_circle,
 *                                    vulcanus_place_non_metal_spots(749, 12, 1,
 *                                      vulcanus_calcite_size * ..., control:calcite:frequency, ...)))"
 * ```
 *
 * and `space-age/prototypes/tile/tiles-vulcanus.lua` feeds that region straight
 * into a **tile** range:
 *
 * ```lua
 * name = "volcanic_jagged_ground_range",
 * expression = "5 * min(10, max(vulcanus_calcite_region + 0.2, ...))"
 * ```
 *
 * So `calcite size = 0` changes which tile the argmax picks. That is a route from
 * the lever to `Surface::wouldCollide`'s TILE half - exactly the kind of route
 * #124 was left looking for after it closed the entity half.
 *
 * **It is real, and it is inert for cliffs.** Only `lava` and `lava-hot` carry
 * `tile_collision_masks.lava()`, and nothing crosses that boundary:
 *
 * | arm | tiles changed (of 16384) | blocking gained | blocking lost |
 * | --- | --- | --- | --- |
 * | calcite OFF | **841** | **0** | **0** |
 * | ALL resources OFF | **1066** | **0** | **0** |
 *
 * Every change is ground-to-ground - `volcanic-jagged-ground` to
 * `volcanic-folds`, `-folds-warm`, `-soil-dark`, `-soil-light`, `-folds-flat`.
 *
 * **Two things make the zero mean something.** 1682 of the 16384 sampled tiles
 * ARE blocking, so there was a boundary to cross; and each arm records the
 * `autoplace_controls` the SURFACE read back, so "no tile moved" cannot be
 * confused with "the override never applied".
 *
 * **What it does NOT prove.** The grid is stride-2, i.e. 25% of the region, so a
 * blocking flip at an unsampled tile is bounded rather than excluded by the
 * capture alone. Our own tile model - whose response to this lever the capture
 * independently corroborates below - says there are none across all 65536.
 *
 * **Where it leaves #84.** Both halves of `Surface::wouldCollide` are now closed
 * against the ore: the entity half by #124 (disjoint masks, ordering, and
 * `applyEntities` skipping rather than destroying) and the tile half here, on the
 * game's own data. That sits badly with #124's other finding - that the ore acts
 * at the destroy stage, where `wouldCollide` is the only thing that destroys -
 * and the three cannot all be right. That tension is the finding to carry
 * forward, not something to smooth over: the n=1 destroy result is the least
 * corroborated of the three.
 */

const BLOCKING = VULCANUS_CLIFF_BLOCKING_TILES;

interface Case {
  label: string;
  autoplaceControls: Record<string, { frequency: number; size: number; richness: number }> | null;
  effectiveAutoplace: Record<string, { frequency: number; size: number; richness: number }>;
  positions: { x: number; y: number }[];
  tileNames: string[];
}
const CASES = lever.cases as unknown as Case[];
const arm = (label: string): Case => {
  const c = CASES.find((q) => q.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};
const ON = arm("resources ON");

interface Diff {
  changed: number;
  gained: number;
  lost: number;
  kinds: Set<string>;
}
const diff = (label: string): Diff => {
  const a = arm(label);
  const out: Diff = { changed: 0, gained: 0, lost: 0, kinds: new Set() };
  for (let i = 0; i < ON.tileNames.length; i++) {
    const before = ON.tileNames[i];
    const after = a.tileNames[i];
    if (before === after) continue;
    out.changed++;
    out.kinds.add(`${before} -> ${after}`);
    if (!BLOCKING.has(before) && BLOCKING.has(after)) out.gained++;
    if (BLOCKING.has(before) && !BLOCKING.has(after)) out.lost++;
  }
  return out;
};

describe("the resource lever moves tiles in the GAME", () => {
  /**
   * **The non-vacuity pair, first.** The override reached the generator - the
   * surface reports `calcite.size = 0` back - and the sample really does contain
   * blocking tiles, 1682 of them, so a flip had somewhere to show.
   */
  it("proves the override applied and that blocking tiles are in the sample", () => {
    expect(arm("calcite OFF").effectiveAutoplace.calcite).toEqual({
      frequency: 1,
      size: 0,
      richness: 1,
    });
    // ...and the untouched controls stay at 1, so the arm is not a blanket reset.
    expect(arm("calcite OFF").effectiveAutoplace.tungsten_ore).toEqual({
      frequency: 1,
      size: 1,
      richness: 1,
    });
    expect(ON.effectiveAutoplace.calcite).toEqual({ frequency: 1, size: 1, richness: 1 });

    expect(ON.tileNames.length).toBe(16384);
    expect(ON.tileNames.filter((t) => BLOCKING.has(t)).length).toBe(1682);
    // Positions are identical across arms, so the diff is index-aligned.
    for (const label of ["calcite OFF", "ALL resources OFF"])
      expect(arm(label).positions).toEqual(ON.positions);
  });

  /**
   * **841 tiles move when calcite alone is switched off** - 5.1% of the sample.
   * So the lever every ore result in #84 relies on is not entity-only.
   */
  it("finds 841 tiles change under calcite OFF and 1066 under ALL OFF", () => {
    expect(diff("calcite OFF").changed).toBe(841);
    expect(diff("ALL resources OFF").changed).toBe(1066);
  });

  /**
   * **...and not one of them crosses the cliff-blocking boundary.** So the
   * confound is real and inert for cliffs: `constCollideWithTile` cannot see any
   * of it, and every ore result in #84 stands.
   */
  it("moves no tile into or out of the blocking set", () => {
    for (const label of ["calcite OFF", "ALL resources OFF"]) {
      const d = diff(label);
      expect(d.gained).toBe(0);
      expect(d.lost).toBe(0);
      // Every observed change is ground-to-ground.
      for (const k of d.kinds) {
        const [before, after] = k.split(" -> ");
        expect(BLOCKING.has(before)).toBe(false);
        expect(BLOCKING.has(after)).toBe(false);
      }
    }
  });

  /**
   * The shape of the change, pinned because it is the mechanism showing through:
   * `volcanic_jagged_ground_range` is the expression `vulcanus_calcite_region`
   * feeds, and jagged ground is what loses when the region collapses.
   */
  it("shows jagged ground losing the argmax", () => {
    const kinds = [...diff("calcite OFF").kinds];
    expect(kinds.filter((k) => k.startsWith("volcanic-jagged-ground -> ")).length).toBeGreaterThan(
      3,
    );
  });
});

/**
 * **Our own tile model reproduces the effect, which is worth more than it
 * looks.** The capture is a 25% sample; the port can answer over all 65536
 * tiles. The two agree on the rate to within 0.05 percentage points, which is
 * independent corroboration of the port's response to a lever nobody had ever
 * pointed at it - and it is what lets the port's "0 blocking flips anywhere" be
 * read as covering the tiles the capture did not sample.
 */
describe("our port reproduces the same tile response", () => {
  const REGION = lever.region as { x0: number; y0: number; x1: number; y1: number };
  const BASE = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
  const OFF = { frequency: 1, size: 0 };

  it("moves 3335 of 65536 tiles under calcite OFF, none of them blocking", () => {
    const on = makeVulcanusTileResolver(BASE);
    const off = makeVulcanusTileResolver({
      ...BASE,
      vulcanusResourceControls: { ...DEFAULT_VULCANUS_RESOURCE_CONTROLS, calcite: OFF },
    });
    let changed = 0;
    let gained = 0;
    let lost = 0;
    for (let x = REGION.x0; x < REGION.x1; x++)
      for (let y = REGION.y0; y < REGION.y1; y++) {
        const a = on(x, y).name;
        const b = off(x, y).name;
        if (a === b) continue;
        changed++;
        if (!BLOCKING.has(a) && BLOCKING.has(b)) gained++;
        if (BLOCKING.has(a) && !BLOCKING.has(b)) lost++;
      }
    expect(changed).toBe(3335);
    expect(gained).toBe(0);
    expect(lost).toBe(0);

    // The rates agree: 3335/65536 against the game's 841/16384.
    const portRate = changed / 65536;
    const gameRate = diff("calcite OFF").changed / 16384;
    expect(Math.abs(portRate - gameRate)).toBeLessThan(0.001);
  }, 300000);

  /**
   * **Tungsten moves nothing here**, which is the control: `vulcanus_metal_tile`
   * reads `vulcanus_tungsten_ore_probability`, but there is no tungsten in this
   * region - it is the resource that fills `[0,0]`, where #126 measured the ore
   * suppressing zero cliffs. A lever with no region to act on moves no tile, and
   * that is the arm proving the 3335 above is calcite's doing rather than an
   * artifact of rebuilding the resolver.
   */
  it("changes nothing when tungsten is switched off in a region with none", () => {
    const on = makeVulcanusTileResolver(BASE);
    const off = makeVulcanusTileResolver({
      ...BASE,
      vulcanusResourceControls: { ...DEFAULT_VULCANUS_RESOURCE_CONTROLS, tungstenOre: OFF },
    });
    let changed = 0;
    for (let x = REGION.x0; x < REGION.x1; x++)
      for (let y = REGION.y0; y < REGION.y1; y++) if (on(x, y).name !== off(x, y).name) changed++;
    expect(changed).toBe(0);
  }, 300000);
});
