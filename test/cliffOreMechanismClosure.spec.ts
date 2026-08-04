import { describe, expect, it } from "vite-plus/test";

import richness from "./fixtures/oracle-vulcanus-cliff-ore-richness.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { DEFAULT_VULCANUS_RESOURCE_CONTROLS, withCtxDefaults } from "../src/noise/eval/ctx";

/**
 * **Every route from a resource control to a cliff is now closed, and the effect
 * is still there. That is the finding** (#84).
 *
 * The ore -> cliff rule has been characterised since #99: switch the resources
 * off and 31 cliffs come back at `[1500,1500]`, one-way, spatially local, fitted
 * at precision 1.000 by box overlap with the actual resource positions. What has
 * never been found is HOW. This file records that the search space is now
 * exhausted rather than merely unexplored, so nobody re-walks it.
 *
 * | route | closed by | evidence |
 * | --- | --- | --- |
 * | the cliff FIELD reads a resource | this file + the game's data | `cliff_elevation = cliff_elevation_from_elevation = elevation = vulcanus_elevation`, whose 47-node expression closure contains **no** resource region; and our port's raw cell set is bit-identical under every lever arm |
 * | `Surface::wouldCollide` does something else | disassembly (#128 notes) | it is exactly: per-orientation box, degenerate early-out, `constCollideWithTile`, `collideWithEntity` - both with the cliff's own mask at `proto+0x2b0`. No third input |
 * | its ENTITY half | #124 | resource masks are `{resource}` at prototype level against the cliff's eight layers - disjoint; and cliffs are computed and applied before any entity exists |
 * | its TILE half | #128 | the lever moves 841 tiles but **none** crosses the `lava`/`lava-hot` boundary, on the game's own data, with 1682 blocking tiles in the sample |
 * | the lever perturbs something STRUCTURAL | this file | `control:calcite:richness` at x2 and x0.5 changes the compiled settings while touching neither ore positions nor tiles - and moves **zero** cliffs |
 *
 * The last row is the one this file adds, and it was the only route #128 left
 * open. `richness` appears in `vulcanus_calcite_richness` alone - not in
 * `vulcanus_calcite_probability`, which decides where the ore lands, nor in
 * `vulcanus_calcite_region`, which drives the `volcanic_jagged_ground_range`
 * tile. So it hands the generator a different `CompiledMapGenSettings` with the
 * same world in it. **The cliffs do not move, cell for cell, at either setting.**
 *
 * So the lever is not a structural perturbation: the effect genuinely tracks ore
 * PRESENCE. And nothing that can see ore presence can reach a cliff.
 *
 * **Do not read this as "the rule is wrong".** The rule reproduces the game at
 * precision 1.000 over 31 cells and survives out of sample (#126). Something in
 * the model of map generation this port is built on is missing, and the useful
 * next step is to find what map generation does that none of these five rows
 * covers - not to re-test one of them.
 */

const BANDS = {
  elevation0: VULCANUS_CLIFF_ELEVATION_0,
  interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
  smoothing: VULCANUS_CLIFF_SMOOTHING,
};
const BASE = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const OFF = { frequency: 1, size: 0 };

interface Ent {
  x: number;
  y: number;
  name: string;
  orientation?: string;
}
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface Case {
  label: string;
  region: Region;
  effectiveAutoplace: Record<string, { frequency: number; size: number; richness: number }>;
  cliffs: Ent[];
  resources: Ent[];
}
const CASES = richness.cases as unknown as Case[];
const arm = (label: string): Case => {
  const c = CASES.find((q) => q.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};
const REGION = richness.region as unknown as Region;
const inR = (p: { x: number; y: number }): boolean =>
  p.x >= REGION.x0 && p.x < REGION.x1 && p.y >= REGION.y0 && p.y < REGION.y1;

const cliffKeys = (c: Case): string[] =>
  c.cliffs
    .filter((e) => e.name === "cliff-vulcanus" && inR(e))
    .map((e) => `${String(e.x)},${String(e.y)}:${e.orientation ?? ""}`)
    .sort((a, b) => a.localeCompare(b));
const resourceKeys = (c: Case): string[] =>
  c.resources
    .map((e) => `${String(e.x)},${String(e.y)}:${e.name}`)
    .sort((a, b) => a.localeCompare(b));

describe("richness moves the settings but not the world - and not the cliffs", () => {
  /**
   * **The non-vacuity arm.** The override reached the generator: the surface
   * reports the changed richness back, at both settings. Without it, "nothing
   * moved" and "nothing was asked" are the same output.
   */
  it("proves the richness override applied", () => {
    expect(arm("calcite richness x2").effectiveAutoplace.calcite).toEqual({
      frequency: 1,
      size: 1,
      richness: 2,
    });
    expect(arm("calcite richness x0.5").effectiveAutoplace.calcite).toEqual({
      frequency: 1,
      size: 1,
      richness: 0.5,
    });
    expect(arm("default").effectiveAutoplace.calcite).toEqual({
      frequency: 1,
      size: 1,
      richness: 1,
    });
  });

  /**
   * The premise the control rests on, measured rather than argued from the Lua:
   * richness leaves the ore exactly where it was. 3933 entities, same positions,
   * same names.
   */
  it("leaves every resource entity where it was", () => {
    const base = resourceKeys(arm("default"));
    expect(base.length).toBe(3933);
    for (const label of ["calcite richness x2", "calcite richness x0.5"])
      expect(resourceKeys(arm(label))).toEqual(base);
  });

  /**
   * **And the cliffs do not move - cell for cell, orientation for orientation.**
   * So handing the generator a different `CompiledMapGenSettings` with the same
   * world in it changes nothing, which refutes the structural-perturbation
   * reading of the lever and leaves the effect tracking ore PRESENCE.
   */
  it("moves not one cliff at either richness", () => {
    const base = cliffKeys(arm("default"));
    expect(base.length).toBe(861);
    for (const label of ["calcite richness x2", "calcite richness x0.5"])
      expect(cliffKeys(arm(label))).toEqual(base);
  });
});

describe("the cliff field cannot see the resources", () => {
  /**
   * Our port's raw queue - crossings plus the repair pass, before any rejection -
   * is **bit-identical** under every arm of the lever: same cells, same codes.
   * The game's own expression graph says the same thing independently:
   * `cliff_elevation = cliff_elevation_from_elevation = elevation =
   * vulcanus_elevation = max(-500, vulcanus_elev)`, and walking that expression's
   * full transitive closure reaches no `*_region` belonging to any resource.
   *
   * This is the arm that rules out "the lever moves the contour" - which would
   * otherwise be the obvious explanation for cells appearing when the ore is
   * switched off.
   */
  it("produces an identical raw cell set under every lever arm", () => {
    const cells = (controls?: typeof DEFAULT_VULCANUS_RESOURCE_CONTROLS): string[] => {
      const ctx = withCtxDefaults(
        controls === undefined ? BASE : { ...BASE, vulcanusResourceControls: controls },
      );
      return makeCliffPlacementFromFields(makeVulcanusCliffFields(ctx), BANDS)
        .placedCells(REGION.x0 - 64, REGION.y0 - 64, REGION.x1 + 64, REGION.y1 + 64)
        .map((p) => `${String(p.x)},${String(p.y)}:${String(p.code)}`)
        .sort((a, b) => a.localeCompare(b));
    };
    const on = cells();
    expect(on.length).toBe(2277);
    expect(cells({ ...DEFAULT_VULCANUS_RESOURCE_CONTROLS, calcite: OFF })).toEqual(on);
    expect(cells({ ...DEFAULT_VULCANUS_RESOURCE_CONTROLS, sulfuricAcidGeyser: OFF })).toEqual(on);
    expect(
      cells({
        tungstenOre: OFF,
        vulcanusCoal: OFF,
        calcite: OFF,
        sulfuricAcidGeyser: OFF,
      }),
    ).toEqual(on);
  }, 300000);
});
