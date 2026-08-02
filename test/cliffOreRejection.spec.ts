import { describe, expect, it } from "vite-plus/test";

import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import direction from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import {
  VULCANUS_CLIFF_BASE_COLLISION_BOX,
  VULCANUS_ORE_COLLISION_HALF,
  makeVulcanusOreRejection,
} from "../src/noise/cliffs/vulcanusOreRejection";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import {
  buildResources,
  geyserPlacementFrom,
  renderVulcanusResources,
} from "../src/noise/preview/renderVulcanusResources";
import { makeVulcanusOreFootprint } from "../src/noise/resources/vulcanusResourceCatalog";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

interface Ent {
  x: number;
  y: number;
  name: string;
}
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface Case {
  region: Region;
  cliffs: Ent[];
}
interface Arm {
  label: string;
  region: Region;
  cliffs: Ent[];
  resources: Ent[];
}

const INPUT = { seed0: 123456, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const resources = buildResources(ctx);
const geyserAt = geyserPlacementFrom(ctx, resources);
const cliffFields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);

const gameCells = (cliffs: Ent[]): Set<string> =>
  new Set(cliffs.filter((e) => e.name === "cliff-vulcanus").map((e) => key(e.x, e.y)));

/** The port's placed cells with the lava rejection but WITHOUT the ore rule. */
const placedWithoutOreRule = (r: Region): { x: number; y: number; code: number }[] =>
  makeCliffPlacementFromFields(cliffFields, {
    elevation0: VULCANUS_CLIFF_ELEVATION_0,
    interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
    smoothing: VULCANUS_CLIFF_SMOOTHING,
    tileCollides: (x, y) => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
  }).placedCells(r.x0, r.y0, r.x1, r.y1);

const regionCase = (x0: number): Case => {
  const c = (entities.cases as unknown as Case[]).find((k) => k.region.x0 === x0);
  if (c === undefined) throw new Error(`no region ${String(x0)}`);
  return c;
};

/**
 * **The ORE -> CLIFF rejection as the renderer actually runs it.**
 *
 * `#99` settled the direction and characterised the rule, then handed over one
 * explicitly open sub-question: it scored the geometry against the GAME's own
 * resource entities, read out of a fixture, and noted that whether driving the
 * rejection from the port's own resource model is accurate enough was
 * "deliberately not attempted here".
 *
 * That is what this file measures. Every score below drives
 * `makeVulcanusOreRejection` off `buildResources` - the same field stack
 * `renderVulcanusResources` paints from - so it is the shipped predicate being
 * scored, not an idealised one.
 */
describe("the ported ore rejection, driven by the port's own resource model", () => {
  /**
   * **The headline, and the gate.** The rule may only ever cost precision. A
   * cell it removes that the game KEPT is a false rejection and costs recall,
   * which is currently 1.000/0.973/0.965 and is the expensive half of this port.
   *
   * Across all three oracle regions the shipped variant raises **zero** false
   * rejections, and at `[1500,1500]` it removes 20 of the 42 surplus cells - a
   * 48% cut in over-placement for no recall at all.
   */
  it("removes 20 surplus cells at [1500,1500] and never a cliff the game kept", () => {
    const reject = makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls);
    const scores = (entities.cases as unknown as Case[]).map((c) => {
      const game = gameCells(c.cliffs);
      const placed = placedWithoutOreRule(c.region);
      const fired = placed.filter((p) => reject(p.code, p.x, p.y));
      return {
        at: key(c.region.x0, c.region.y0),
        game: game.size,
        placed: placed.length,
        fired: fired.length,
        falseRejections: fired.filter((p) => game.has(key(p.x, p.y))).length,
        surplusBefore: placed.filter((p) => !game.has(key(p.x, p.y))).length,
      };
    });

    expect(scores).toEqual([
      { at: "0,0", game: 283, placed: 283, fired: 0, falseRejections: 0, surplusBefore: 2 },
      {
        at: "1500,1500",
        game: 885,
        placed: 900,
        fired: 20,
        falseRejections: 0,
        surplusBefore: 42,
      },
      {
        at: "-1200,800",
        game: 401,
        placed: 387,
        fired: 0,
        falseRejections: 0,
        surplusBefore: 1,
      },
    ]);

    // Every cell it fires on is surplus, so surplus falls by exactly the fired
    // count: 42 -> 22. Precision at [1500,1500] goes 858/900 = 0.953 to
    // 858/880 = 0.975, with the 858 true positives untouched.
    const heavy = scores[1];
    expect(heavy.surplusBefore - heavy.fired).toBe(22);
  }, 120000);

  /**
   * **The two regions where it fires nothing are a result, not a blank.** Both
   * `[0,0]` and `[-1200,800]` have ore, and the port places cliffs across both;
   * the rule simply finds no overlap there. That is consistent with `#94`'s
   * finding that at real settings the port places nothing in the `[0,0]` blob at
   * all - the blob is only reachable when a sweep forces a contour through the
   * ore field - and it is why the rule's whole measurable value sits at
   * `[1500,1500]`.
   */
  it("fires nowhere at the two regions whose surplus is already 1-2 cells", () => {
    for (const x0 of [0, -1200]) {
      const c = regionCase(x0);
      const placed = placedWithoutOreRule(c.region);
      expect(placed.length).toBeGreaterThan(280);
      const surplus = placed.filter((p) => !gameCells(c.cliffs).has(key(p.x, p.y))).length;
      expect(surplus).toBeLessThanOrEqual(2);
    }
  }, 120000);
});

/**
 * **Why the shipped variant is the one it is** - three defaults, each a
 * measurement rather than a preference.
 *
 * `#88`/`#90` already paid for the lesson this table exists to avoid: the
 * best-scoring collision model was the WRONG one, because it scored well by
 * absorbing an unrelated defect. So both alternatives are scored here and left
 * in the record, rather than dismissed in a comment.
 */
describe("the variants that were rejected, and by how much", () => {
  const suppressedTruth = (): Set<string> => {
    const a = (label: string): Arm => {
      const c = (direction.cases as unknown as Arm[]).find((k) => k.label === label);
      if (c === undefined) throw new Error(`no arm ${label}`);
      return c;
    };
    const on = gameCells(a("entity region, resources ON").cliffs);
    const off = gameCells(a("entity region, ALL resources OFF").cliffs);
    return new Set([...off].filter((k) => !on.has(k)));
  };

  it("scores base vs per-orientation box, with and without the geyser", () => {
    const c = regionCase(1500);
    const game = gameCells(c.cliffs);
    const truth = suppressedTruth();
    const placed = placedWithoutOreRule(c.region);

    const score = (box: "base" | "orientation", includeGeyser: boolean) => {
      const reject = makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls, {
        box,
        includeGeyser,
        geyserAt,
      });
      const fired = placed.filter((p) => reject(p.code, p.x, p.y));
      return {
        fired: fired.length,
        correct: fired.filter((p) => truth.has(key(p.x, p.y))).length,
        falseRejections: fired.filter((p) => game.has(key(p.x, p.y))).length,
      };
    };

    expect(truth.size).toBe(31);
    // SHIPPED. The only variant that costs no recall at all.
    expect(score("base", false)).toEqual({ fired: 20, correct: 20, falseRejections: 0 });
    // The geyser arm is not merely risky, it is strictly HARMFUL here: one more
    // false rejection and not one additional correct suppression. Its placements
    // are salt-dependent (46-63 over eight salts against the game's 56) and its
    // box is 14x the ores', so a geyser in the wrong place sweeps a wide area.
    expect(score("base", true)).toEqual({ fired: 21, correct: 20, falseRejections: 1 });
    // The per-orientation box catches one MORE true cell - and pays two kept
    // cliffs for it. Higher `correct` is exactly the trap: recall is the half
    // that must not be traded, so this loses despite the better headline.
    expect(score("orientation", false)).toEqual({ fired: 23, correct: 21, falseRejections: 2 });
    expect(score("orientation", true)).toEqual({ fired: 24, correct: 21, falseRejections: 3 });
  }, 120000);

  /**
   * **The answer to `#99`'s open question, as a number.** Driving the rejection
   * from the port's own ore model instead of the game's entities costs exactly
   * one cell: the fixture-driven geometry explains 21 of the 31, the port-driven
   * one 20. So the port's ore footprint is a faithful substitute here, which is
   * what made it safe to ship the rule at all.
   */
  it("costs exactly one cell against driving it from the game's own entities", () => {
    const c = regionCase(1500);
    const truth = suppressedTruth();
    const placed = placedWithoutOreRule(c.region);
    const reject = makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls);
    const portDriven = placed.filter((p) => reject(p.code, p.x, p.y) && truth.has(key(p.x, p.y)));

    // 21 is `test/cliffOreDirection.spec.ts`'s figure for the same geometry run
    // against the game's resource entities. Re-derived here rather than quoted,
    // so this cannot drift away from that spec silently.
    const arm = (direction.cases as unknown as Arm[]).find(
      (k) => k.label === "entity region, resources ON",
    );
    if (arm === undefined) throw new Error("no ON arm");
    const [l, t, r, b] = VULCANUS_CLIFF_BASE_COLLISION_BOX;
    const fixtureDriven = [...truth].filter((k) => {
      const [xs, ys] = k.split(",");
      const cx = Number(xs);
      const cy = Number(ys);
      return arm.resources.some((p) => {
        const h = p.name === "sulfuric-acid-geyser" ? 1.3984375 : VULCANUS_ORE_COLLISION_HALF;
        return cx + l < p.x + h && p.x - h < cx + r && cy + t < p.y + h && p.y - h < cy + b;
      });
    }).length;

    expect(fixtureDriven).toBe(21);
    expect(portDriven.length).toBe(20);
  }, 120000);

  /**
   * **The gap stays tracked rather than tuned away.** 11 of the 31 the game
   * suppresses are not reproduced: 10 are `#99`'s run remainders (every one of
   * the six connected components of the suppressed set contains a directly
   * overlapped cell, so they are the tails of runs whose interior was rejected)
   * and 1 is the cell the port's ore model misses against the game's entities.
   *
   * Widening the box until all 31 fall out is available and deliberately not
   * done - see the module comment on `vulcanusOreRejection.ts`.
   */
  it("pins the unexplained remainder at 11", () => {
    const c = regionCase(1500);
    const truth = suppressedTruth();
    const placed = placedWithoutOreRule(c.region);
    const reject = makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls);
    const explained = new Set(
      placed.filter((p) => reject(p.code, p.x, p.y)).map((p) => key(p.x, p.y)),
    );
    expect([...truth].filter((k) => !explained.has(k)).length).toBe(11);
  }, 120000);
});

/**
 * The two properties that make the predicate's cheapness safe, and the disable
 * path.
 */
describe("the predicate itself", () => {
  /**
   * **The tile window is derived, so it is guarded rather than trusted.** The
   * predicate does not enumerate entities: it solves the two rectangles for the
   * tiles whose centres can possibly overlap, which is 2 tiles for an ore. A
   * brute-force scan a tile wider on every side, testing the overlap explicitly,
   * must agree on every cell - otherwise the closed form is dropping hits.
   */
  it("agrees with a brute-force scan one tile wider on every side", () => {
    const c = regionCase(1500);
    const placed = placedWithoutOreRule(c.region);
    const reject = makeVulcanusOreRejection(resources, ctx.vulcanusResourceControls);
    const oreAt = makeVulcanusOreFootprint(resources, ctx.vulcanusResourceControls);
    const [l, t, r, b] = VULCANUS_CLIFF_BASE_COLLISION_BOX;
    const h = VULCANUS_ORE_COLLISION_HALF;

    const wide = (x: number, y: number): boolean => {
      for (let tx = Math.floor(x + l - h - 0.5) - 1; tx <= Math.ceil(x + r + h - 0.5) + 1; tx++)
        for (let ty = Math.floor(y + t - h - 0.5) - 1; ty <= Math.ceil(y + b + h - 0.5) + 1; ty++) {
          const px = tx + 0.5;
          const py = ty + 0.5;
          if (x + l < px + h && px - h < x + r && y + t < py + h && py - h < y + b && oreAt(tx, ty))
            return true;
        }
      return false;
    };

    expect(placed.length).toBe(900);
    expect(placed.filter((p) => wide(p.x, p.y) !== reject(p.code, p.x, p.y)).length).toBe(0);
    // Non-vacuity: the brute-force arm really does find the same 20, so "0
    // disagreements" is not two predicates both returning false everywhere.
    expect(placed.filter((p) => wide(p.x, p.y)).length).toBe(20);
  }, 120000);

  /**
   * **A disabled ore suppresses nothing**, which is not a bolted-on special case
   * but the very lever the game was driven with to establish the rule (`size = 0`
   * on `autoplace_controls`, `#99`). It is also the app's own behaviour: a user
   * who turns an ore off must not keep seeing cliffs missing where it was.
   */
  it("fires zero times when every resource control is disabled", () => {
    const c = regionCase(1500);
    const placed = placedWithoutOreRule(c.region);
    const off = withCtxDefaults({
      ...INPUT,
      vulcanusResourceControls: {
        tungstenOre: { frequency: 1, size: 0 },
        calcite: { frequency: 1, size: 0 },
        vulcanusCoal: { frequency: 1, size: 0 },
        sulfuricAcidGeyser: { frequency: 1, size: 0 },
      },
    });
    const reject = makeVulcanusOreRejection(resources, off.vulcanusResourceControls);
    expect(placed.filter((p) => reject(p.code, p.x, p.y)).length).toBe(0);
  }, 120000);

  /**
   * **The two overlays must agree on where the ore is.** The cliff rejection and
   * the ore overlay now share `RESOURCE_PROBABILITY_THRESHOLD`, but sharing a
   * constant is not the same as painting the same footprint. This renders the
   * ore overlay onto a blank image and checks pixel for pixel that an ore-
   * coloured pixel is exactly where the rejection's footprint predicate says ore
   * is - so a cliff can never be suppressed by ore the user cannot see.
   */
  it("suppresses against exactly the footprint the ore overlay paints", () => {
    // The full oracle region, not a corner of it: a 64x64 window at this origin
    // contains no ore at all, so the comparison came back vacuously equal. The
    // `painted > 0` assertion below is what caught that.
    const w = 256;
    const h = 256;
    const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as ImageData;
    renderVulcanusResources(img, { seed0: INPUT.seed0, originX: 1500, originY: 1500, ctx: INPUT });

    const oreColors = new Set(["98,86,149", "204,179,179", "0,0,0"]);
    const oreAt = makeVulcanusOreFootprint(resources, ctx.vulcanusResourceControls);
    let painted = 0;
    let mismatches = 0;
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const o = (py * w + px) * 4;
        const opaque = img.data[o + 3] === 255;
        const isOre =
          opaque &&
          oreColors.has(
            `${String(img.data[o])},${String(img.data[o + 1])},${String(img.data[o + 2])}`,
          );
        if (isOre) painted++;
        if (isOre !== oreAt(1500 + px, 1500 + py)) mismatches++;
      }

    expect(mismatches).toBe(0);
    // Non-vacuity: this window really does contain ore, so a zero above is an
    // agreement rather than two empty sets.
    expect(painted).toBeGreaterThan(0);
  }, 120000);
});
