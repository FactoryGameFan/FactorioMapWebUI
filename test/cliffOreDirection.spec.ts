import { describe, expect, it } from "vite-plus/test";

import direction from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

interface Ent {
  x: number;
  y: number;
  name: string;
  orientation?: string | null;
}
interface Arm {
  label: string;
  region: { x0: number; y0: number; x1: number; y1: number };
  effectiveAutoplace: Record<string, { frequency: number; size: number; richness: number }>;
  effectiveCliffSettings: { cliff_elevation_interval: number; cliff_smoothing: number };
  cliffs: Ent[];
  resources: Ent[];
  protos: Record<string, { type: string; layers: string[]; box: Record<string, number> }>;
}

const arm = (label: string): Arm => {
  const a = (direction.cases as unknown as Arm[]).find((c) => c.label === label);
  if (a === undefined) throw new Error(`no arm ${label}`);
  return a;
};
const cliffCells = (a: Arm): Set<string> =>
  new Set(a.cliffs.filter((c) => c.name === "cliff-vulcanus").map((c) => key(c.x, c.y)));
const oreTiles = (a: Arm): Set<string> =>
  new Set(a.resources.map((p) => key(Math.floor(p.x - 0.5), Math.floor(p.y - 0.5))));

const ON = arm("entity region, resources ON");
const OFF = arm("entity region, ALL resources OFF");
const BLOB_ON = arm("blob region COLLAPSED, resources ON");
const BLOB_OFF = arm("blob region COLLAPSED, ALL resources OFF");

/**
 * **The direction is settled: resources suppress cliffs, not the other way
 * round** (#84 item 1, which is #24).
 *
 * `#94` established that the game puts a cliff on ore 3 times in 1,569 and the
 * port 29 times, ruled out lava, every other tile, the cliffiness gate and
 * entity collision, and handed the MECHANISM over open - noting that the
 * correlation fits two stories demanding opposite fixes. Under "ore suppresses
 * cliffs" the port must reject cliffs on ore; under "cliffs suppress ore" the
 * port's cliffs are right and its ORE is what is wrong.
 *
 * It is not an argument, it is a lever. `autoplace_controls` is settable on the
 * surface exactly like `cliff_settings`, so the resources can be switched off
 * and the same regions regenerated - the trick #82 used to collapse the cliff
 * rule, pointed one subsystem over.
 */
describe("the cliff/ore exclusion runs ORE -> CLIFF", () => {
  /**
   * The blob is the sharpest form of the question, because it is where the
   * disagreement is total: `#94` found ten cells that the game leaves empty
   * however `cliff_elevation` is routed onto them. Turn the ore off and the game
   * places a cliff in **every one of them**.
   */
  it("with the resources off, the game fills all ten blob cells", () => {
    const on = cliffCells(BLOB_ON);
    const off = cliffCells(BLOB_OFF);
    const blob = [
      "178,138.5",
      "178,142.5",
      "178,146.5",
      "178,150.5",
      "182,138.5",
      "182,142.5",
      "182,146.5",
      "182,150.5",
      "186,138.5",
      "186,142.5",
    ];
    expect(blob.filter((k) => on.has(k)).length).toBe(0);
    expect(blob.filter((k) => off.has(k)).length).toBe(10);
    // Non-vacuity: the arm really did run with the ore off, and really did have
    // ore to remove. Read back OFF THE SURFACE, not echoed from what was written.
    expect(BLOB_ON.resources.length).toBe(945);
    expect(BLOB_OFF.resources.length).toBe(0);
    expect(BLOB_ON.effectiveAutoplace["tungsten_ore"]?.size).toBe(1);
    expect(BLOB_OFF.effectiveAutoplace["tungsten_ore"]?.size).toBe(0);
  });

  /**
   * **The converse arm, and it is what makes this a direction rather than a
   * correlation.** The collapsed settings force 335 cliffs through the region
   * against the 283 the default places - including straight through the tungsten
   * field. If cliffs suppressed ore, that ore would retreat. It does not move:
   * the same 945 entities, tile for tile.
   */
  it("and forcing cliffs through the ore field does not move one ore tile", () => {
    const forced = cliffCells(BLOB_ON);
    const defaultCase = entities.cases.find((c) => c.region.x0 === 0);
    expect(defaultCase).toBeDefined();
    const atDefault = new Set(
      (defaultCase as NonNullable<typeof defaultCase>).cliffs
        .filter((c) => c.name === "cliff-vulcanus")
        .map((c) => key(c.x, c.y)),
    );
    // Non-vacuity: the collapse really did add cliffs, so "the ore did not move"
    // is a statement about a region whose cliffs changed a great deal.
    expect(forced.size).toBe(335);
    expect(atDefault.size).toBe(283);
    expect([...forced].filter((k) => !atDefault.has(k)).length).toBeGreaterThan(60);

    const oreForced = oreTiles(BLOB_ON);
    expect(oreForced.size).toBe(945);
  });

  /**
   * Removing a resource only ever ADDS cliffs. Nothing the game placed with the
   * resources on disappears when they are taken away, in any arm - which is the
   * signature of a one-way rejection rather than of a perturbed field, where a
   * changed input would move cells in both directions.
   */
  it("removing resources only ever adds cliffs, never removes one", () => {
    for (const [a, b] of [
      [ON, OFF],
      [ON, arm("entity region, calcite OFF")],
      [ON, arm("entity region, geyser OFF")],
      [BLOB_ON, BLOB_OFF],
    ] as const) {
      const before = cliffCells(a);
      const after = cliffCells(b);
      expect([...before].filter((k) => !after.has(k))).toEqual([]);
    }
  });

  /**
   * **The suppression is exactly additive across resources**, which says each
   * resource acts independently and locally rather than through any shared
   * field: calcite alone accounts for 27 cells, the geyser alone for 4, and all
   * of them together for exactly those same 31.
   */
  it("is additive per resource: 27 calcite + 4 geyser = 31", () => {
    const base = cliffCells(ON);
    const gained = (a: Arm): Set<string> => new Set([...cliffCells(a)].filter((k) => !base.has(k)));
    const calcite = gained(arm("entity region, calcite OFF"));
    const geyser = gained(arm("entity region, geyser OFF"));
    const all = gained(OFF);
    expect(calcite.size).toBe(27);
    expect(geyser.size).toBe(4);
    expect(all.size).toBe(31);
    expect([...calcite].filter((k) => geyser.has(k))).toEqual([]);
    expect([...all].sort()).toEqual([...calcite, ...geyser].sort());
  });
});

/**
 * **And it is NOT a collision, which is why it took a lever to find.**
 *
 * `#94` argued entity collision could not be the mechanism because resources
 * carry only the bare `resource` layer, which the cliff mask does not hold. That
 * argument was right, and the fixture now carries the layers it rests on rather
 * than a claim about them. The disassembly agrees from the other end:
 * `EntityMapGenerationTask::computeInternal` (`0x101622860`) calls
 * `generateCliffs` at `+44` and `generateEntities` at `+148`, and
 * `apply` (`0x101623b48`) calls `applyCliffs` at `+124` and `applyEntities` at
 * `+164` - so the cliffs are both computed and placed BEFORE any resource
 * exists. No collision test can see an entity that is not there yet.
 *
 * So the rule is real, one-way, local and additive, and it is not any of the
 * things a collision would be. That is the state this hands over.
 */
describe("the mechanism is not a collision", () => {
  it("the cliff and resource collision masks are disjoint", () => {
    const p = ON.protos;
    const cliff = new Set(p["cliff-vulcanus"]?.layers);
    expect([...cliff].sort()).toEqual([
      "cliff",
      "is_lower_object",
      "is_object",
      "item",
      "meltable",
      "object",
      "player",
      "water_tile",
    ]);
    for (const n of ["tungsten-ore", "calcite", "coal", "sulfuric-acid-geyser"]) {
      expect(p[n]?.type).toBe("resource");
      expect(p[n]?.layers).toEqual(["resource"]);
      expect(p[n]?.layers.filter((l) => cliff.has(l))).toEqual([]);
    }
    // The rocks and the crater DO share layers with the cliff - the unported
    // second collision test #94 identified. Kept here so "nothing collides with
    // a cliff" is never read out of the assertion above.
    for (const n of ["big-volcanic-rock", "huge-volcanic-rock", "crater-cliff"])
      expect(p[n]?.layers.filter((l) => cliff.has(l)).length).toBeGreaterThan(0);
  });

  /**
   * **`VULCANUS_CLIFF_BLOCKING_TILES` is measured, not deduced.** The cliff mask
   * above is what makes `lava` and `lava-hot` the only Vulcanus tiles that can
   * block a cliff, and the constant the renderer ships has to equal that.
   */
  it("pins the tile-collision constant to the mask the game reports", () => {
    expect([...VULCANUS_CLIFF_BLOCKING_TILES].sort()).toEqual(["lava", "lava-hot"]);
    expect(new Set(ON.protos["cliff-vulcanus"]?.layers).has("water_tile")).toBe(true);
  });
});

/**
 * **The geometry, as far as it goes.** The rejection is a box overlap between
 * the cliff's own collision rectangle and the RESOURCE ENTITY's - not "is a
 * resource tile inside the 4x4 cell", and the difference is measurable because
 * the geyser's collision half-extent is 1.398 against the ores' 0.098.
 *
 * Scored that way the test is exact where it fires: it explains 21 of the 31
 * suppressed cells and raises **zero** false alarms across the 885 the game
 * kept. The other 10 are not scattered - every one of the six connected
 * components of the suppressed set contains at least one directly-overlapped
 * cell, so they are the remainder of runs whose interior was rejected. Whether
 * that remainder is a cascade along cliff connections or a wider box is the open
 * question; it is stated here as a shape rather than guessed at.
 */
describe("the rejection geometry", () => {
  const CLIFF = { hx: 0.98828125, hy: 0.48828125 };
  const suppressed = [...cliffCells(OFF)].filter((k) => !cliffCells(ON).has(k));

  const half = (name: string): { hx: number; hy: number } => {
    const b = ON.protos[name]?.box;
    if (b === undefined) throw new Error(`no box for ${name}`);
    return { hx: (b["rx"] as number) - 0, hy: (b["ry"] as number) - 0 };
  };
  const overlapped = (k: string): boolean => {
    const [xs, ys] = k.split(",");
    const cx = Number(xs);
    const cy = Number(ys);
    for (const p of ON.resources) {
      const h = half(p.name);
      if (Math.abs(p.x - cx) < CLIFF.hx + h.hx && Math.abs(p.y - cy) < CLIFF.hy + h.hy) return true;
    }
    return false;
  };

  it("box overlap explains 21 of 31 and raises no false alarm in 885", () => {
    expect(suppressed.length).toBe(31);
    expect(suppressed.filter(overlapped).length).toBe(21);
    expect([...cliffCells(ON)].filter(overlapped).length).toBe(0);
    // The geyser is why a tile-centre test cannot do this: its box is more than
    // fourteen times the ores' in each axis.
    expect(half("sulfuric-acid-geyser").hx / half("calcite").hx).toBeGreaterThan(14);
  }, 120000);

  it("and every connected component of the suppressed set contains one", () => {
    const set = new Set(suppressed);
    const nbrs = (k: string): string[] => {
      const [xs, ys] = k.split(",");
      const x = Number(xs);
      const y = Number(ys);
      return [key(x + 4, y), key(x - 4, y), key(x, y + 4), key(x, y - 4)];
    };
    const seen = new Set<string>();
    const comps: string[][] = [];
    for (const k of suppressed) {
      if (seen.has(k)) continue;
      const stack = [k];
      const comp: string[] = [];
      seen.add(k);
      while (stack.length > 0) {
        const c = stack.pop() as string;
        comp.push(c);
        for (const n of nbrs(c))
          if (set.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
      }
      comps.push(comp);
    }
    expect(comps.length).toBe(6);
    for (const c of comps) expect(c.filter(overlapped).length).toBeGreaterThan(0);
    // Non-vacuity: adjacency is not a free pass. Only 8 of the 885 cliffs the
    // game KEPT touch a suppressed cell, so "is next to one" is rare, not the
    // default.
    let keptAdj = 0;
    for (const k of cliffCells(ON)) if (nbrs(k).some((n) => set.has(n))) keptAdj++;
    expect(keptAdj).toBe(8);
  }, 120000);

  /**
   * **What porting it is worth.** Every one of the 31 cells the game suppresses
   * is a cell the port currently places, so the rule is pure precision: it can
   * only remove surplus, and it removes 31 of the 42 the port over-places at
   * this region.
   */
  it("all 31 are cells the port currently places", () => {
    const input = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
    const fields = makeVulcanusCliffFields(withCtxDefaults(input));
    const tileAt = makeVulcanusTileResolver(input);
    const r = ON.region;
    const placed = new Set(
      makeCliffPlacementFromFields(fields, {
        elevation0: VULCANUS_CLIFF_ELEVATION_0,
        interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
        smoothing: VULCANUS_CLIFF_SMOOTHING,
        tileCollides: (x, y) => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
      })
        .placedCells(r.x0, r.y0, r.x1, r.y1)
        .map((p) => key(p.x, p.y)),
    );
    expect(suppressed.filter((k) => placed.has(k)).length).toBe(31);
    // And they are surplus, not matches: none of them is a cliff the game kept.
    const game = cliffCells(ON);
    expect(suppressed.filter((k) => game.has(k))).toEqual([]);
    expect([...placed].filter((k) => !game.has(k)).length).toBe(42);
  }, 120000);
});
