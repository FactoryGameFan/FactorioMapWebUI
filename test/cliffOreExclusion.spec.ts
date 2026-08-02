import { describe, expect, it } from "vite-plus/test";

import collapsed from "./fixtures/oracle-vulcanus-cliff-collapsed.seed123456.json";
import corners from "./fixtures/oracle-vulcanus-cliff-corner-fields-entity-regions.seed123456.json";
import entities from "./fixtures/oracle-vulcanus-cliff-entities.seed123456.json";
import resources from "./fixtures/oracle-vulcanus-resource-entities.seed123456.json";
import { CLIFF_ORIENTATION_NAMES, cliffOrientationForCode } from "../src/noise/cliffs/cliffCatalog";
import { makeCliffPlacementFromFields } from "../src/noise/cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeCliffinessBasic,
  makeVulcanusCliffFields,
} from "../src/noise/cliffs/vulcanusCliffFields";
import { VULCANUS_CLIFF_BLOCKING_TILES } from "../src/noise/preview/renderVulcanusCliffs";
import { makeVulcanusTileResolver } from "../src/noise/tiles/vulcanusCatalog";
import { withCtxDefaults } from "../src/noise/eval/ctx";

const seed = 123456;
const input = { seed0: seed, startingPositions: [{ x: 0, y: 0 }] };
const fields = makeVulcanusCliffFields(withCtxDefaults(input));
const tileAt = makeVulcanusTileResolver(input);
const lava = (x: number, y: number): boolean =>
  VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name);
const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

/** Ore tile coordinates per region, keyed by the region's `x0`. */
const oreByRegion = new Map<number, Set<string>>();
for (const c of resources.cases)
  oreByRegion.set(
    c.region.x0,
    new Set(c.resources.map((p) => key(Math.floor(p.x - 0.5), Math.floor(p.y - 0.5)))),
  );

/**
 * Does the 4x4 placement cell centred at `(x, y)` contain an ore tile?
 *
 * "Contains" means the tile's CENTRE falls in the cell, which is the only
 * definition that stays a symmetric 4x4 block on both axes: the cell centre is
 * integral in x and half-integral in y (`CLIFF_CELL_CENTER_*`), so a bound
 * written the same way on both axes silently makes the y block three tiles tall.
 */
const cellHasOre = (x: number, y: number, ore: Set<string>): boolean => {
  const tx0 = x - 2;
  const ty0 = Math.round(y - 2.5);
  for (let tx = tx0; tx < tx0 + 4; tx++)
    for (let ty = ty0; ty < ty0 + 4; ty++) if (ore.has(key(tx, ty))) return true;
  return false;
};

const gameCliffs = (
  cliffs: { x: number; y: number; name: string; orientation: string | null }[],
  r: { x0: number; y0: number; x1: number; y1: number },
): Map<string, string> => {
  const m = new Map<string, string>();
  for (const p of cliffs)
    if (
      p.name === "cliff-vulcanus" &&
      p.x >= r.x0 &&
      p.x < r.x1 &&
      p.y >= r.y0 &&
      p.y < r.y1 &&
      p.orientation !== null
    )
      m.set(key(p.x, p.y), p.orientation);
  return m;
};

const place = (
  r: { x0: number; y0: number; x1: number; y1: number },
  o: {
    elevation0?: number;
    interval?: number;
    smoothing?: number;
    richness?: number;
    withLava?: boolean;
  } = {},
): { x: number; y: number; code: number }[] =>
  makeCliffPlacementFromFields(
    {
      cliffElevation: fields.cliffElevation,
      cliffiness:
        o.richness === undefined ? fields.cliffiness : makeCliffinessBasic(seed, o.richness),
    },
    {
      elevation0: o.elevation0 ?? VULCANUS_CLIFF_ELEVATION_0,
      interval: o.interval ?? VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing: o.smoothing ?? VULCANUS_CLIFF_SMOOTHING,
      tileCollides: o.withLava === false ? undefined : lava,
    },
  ).placedCells(r.x0, r.y0, r.x1, r.y1);

/**
 * **The game does not put cliffs on ore, and the port does. That is what is left**
 * (#84, and it is #24 rather than a new mechanism).
 *
 * The handoff into this session named a "blob": a contiguous patch in region
 * `[0,0]` where the game places no cliff whatever `cliff_elevation` is routed
 * onto it, called the sharpest open lead precisely because a field-independent
 * hole has to be a rule the port does not implement. It is one, and the rule is
 * ore exclusion - the patch is a **tungsten-ore field**.
 *
 * What was eliminated first, each by measurement rather than reading:
 *
 * - **Not lava.** The game's own tiles over `x 160..208, y 124..176` (2,597
 *   `surface.get_tile` samples, 0 lookup misses) are `volcanic-cracks-*` and
 *   `volcanic-smooth-stone*` through the whole blob, with no lava at all. The
 *   previous "not lava" claim came from OUR resolver, which is the thing that
 *   was under suspicion.
 * - **Not the cliffiness gate.** See the gate test below: zero flips.
 * - **Not tile collision of any other kind.** Read off a running game rather
 *   than inferred: `cliff-vulcanus`'s mask is
 *   `cliff, is_lower_object, is_object, item, meltable, object, player,
 *   water_tile`, and of the 18 Vulcanus tiles only `lava` and `lava-hot` share
 *   a layer with it. `VULCANUS_CLIFF_BLOCKING_TILES` is therefore now measured,
 *   not deduced from `tile_collision_masks.lava()`.
 * - **Not entity collision either**, which is the interesting part. Cliffs DO
 *   get a second collision test the port does not implement:
 *   `EntityMapGenerationTask::applyCliffs` (`0x101623c98`) re-tests every
 *   accepted cliff through `Surface::wouldCollide` (`0x10160c088`), which calls
 *   `constCollideWithTile` **and** `collideWithEntity`. But ore cannot be what
 *   that rejects: `tungsten-ore`, `calcite`, `coal` and `sulfuric-acid-geyser`
 *   all carry the bare `resource` layer, which the cliff mask does not hold.
 *   (`big-volcanic-rock`, `huge-volcanic-rock` and `crater-cliff` DO collide -
 *   an unported rule, but only two rocks touch the blob.)
 *
 * So the exclusion is real and its mechanism is still open. It is not a
 * collision, so it is either an ordering effect inside the generation task or
 * something in `resource_autoplace` that the cliff pass reads.
 */
describe("Vulcanus cliffs and ore are near-disjoint in the game, and not in the port", () => {
  it("the game places essentially no cliff on ore", () => {
    const counts: number[] = [];
    for (const c of entities.cases) {
      const ore = oreByRegion.get(c.region.x0);
      expect(ore).toBeDefined();
      const ok = ore as Set<string>;
      // Non-vacuity: there IS ore in each region, so "no cliff on ore" is a
      // real constraint and not an empty set trivially satisfying it.
      expect(ok.size).toBeGreaterThan(900);
      const cliffs = [...gameCliffs(c.cliffs, c.region).keys()];
      expect(cliffs.length).toBeGreaterThan(280);
      counts.push(
        cliffs.filter((k) => {
          const [x, y] = k.split(",");
          return cellHasOre(Number(x), Number(y), ok);
        }).length,
      );
    }
    // 0 / 283, 3 / 885 and 0 / 401. Pinned exactly: three exceptions is the
    // evidence that this is a strong tendency rather than a hard invariant, and
    // a change in that number means the mechanism has changed.
    expect(counts).toEqual([0, 3, 0]);
  }, 120000);

  /**
   * The other half, and the one that costs accuracy: **most of what the port
   * over-places at `[1500,1500]` is on ore.** 26 of its 42 surplus cells sit on
   * an ore tile, against 3 in the game's entire 1,569-cliff population.
   */
  it("and MOST of the port's surplus at [1500,1500] is on ore", () => {
    const c = entities.cases.find((k) => k.region.x0 === 1500);
    expect(c).toBeDefined();
    const r = (c as NonNullable<typeof c>).region;
    const ore = oreByRegion.get(1500) as Set<string>;
    const game = gameCliffs((c as NonNullable<typeof c>).cliffs, r);
    const extra = place(r)
      .map((p) => ({ k: key(p.x, p.y), x: p.x, y: p.y }))
      .filter((p) => !game.has(p.k));
    expect(extra.length).toBe(42);
    expect(extra.filter((p) => cellHasOre(p.x, p.y, ore)).length).toBe(26);
  }, 120000);

  /**
   * **The blob itself, pinned by shape.** With the rule collapsed - a single
   * contour, the gate forced open, smoothing off - the port places ten cells the
   * game does not, and it is the SAME ten in all four collapsed arms whatever
   * the band structure or the gate does. All ten sit on ore.
   *
   * The handoff quoted a looser envelope (`cx 43-48, cy 34-40`, world
   * `x 172-196, y 136-164`); that is the union over the 19-level `cliff_elevation_0`
   * sweep. The arm-invariant core is these ten.
   */
  it("the collapsed arms place the same ten cells the game does not, all on ore", () => {
    const r = collapsed.region;
    const ore = oreByRegion.get(0) as Set<string>;
    const perArm: string[][] = [];
    for (const arm of collapsed.cases) {
      const game = gameCliffs(arm.cliffs, r);
      const extra = place(r, {
        elevation0: arm.effective.cliff_elevation_0,
        interval: arm.effective.cliff_elevation_interval,
        smoothing: arm.effective.cliff_smoothing,
        richness: arm.effective.richness,
      })
        .map((p) => key(p.x, p.y))
        .filter((k) => !game.has(k));
      perArm.push(extra.sort());
    }
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
    ].sort();
    // Identical in every arm: the gate is open in two of them and real in the
    // other two, and the bands differ, so this cannot be a field or gate effect.
    for (const arm of perArm) expect(arm).toEqual(blob);
    for (const k of blob) {
      const [x, y] = k.split(",");
      expect(cellHasOre(Number(x), Number(y), ore)).toBe(true);
    }
  }, 120000);
});

/**
 * **The cliffiness gate is exact, and this measures the BINARY the gate reads.**
 *
 * `cliffiness_basic` is `clamp(qmn, 0, 1) + 0.5` and two thirds of its captured
 * corners sit ON a clamp, so comparing its VALUE there says only that both sides
 * clamped - the vacuity that #84 recorded. What the consumer actually reads is
 * `crossesCliff`'s gate, which is the strict comparison
 * `(cliffiness(p) + cliffiness(q)) / 2 > 0.5` (`0x10160c914`, and
 * `crossingsForChunk` averages the two corners at `0x10160d1cc`). That is a
 * threshold, so a clamped corner is not vacuous for it at all: it is exactly the
 * place where an arbitrarily small error flips the answer.
 *
 * Scored as a boolean over every captured edge of all three regions, the port
 * and the game agree on all 24,960 - with both outcomes well represented, so a
 * constant-true predicate could not pass.
 */
describe("the cliffiness GATE, not its value", () => {
  it("agrees with the game on every captured edge", () => {
    const game = new Map<string, number>();
    for (let n = 0; n < corners.corners.length; n++)
      game.set(corners.corners[n] as string, corners.cliffiness[n] as number);

    let checked = 0;
    let open = 0;
    let flips = 0;
    let onClamp = 0;
    for (const k of game.keys()) {
      const [is, js] = k.split(",");
      const i = Number(is);
      const j = Number(js);
      if (game.get(k) === 0.5) onClamp++;
      for (const [di, dj] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const g2 = game.get(key(i + di, j + dj));
        if (g2 === undefined) continue;
        checked++;
        const gameOpen = (game.get(k) as number) + g2 > 1;
        const oursOpen =
          fields.cliffiness(i * 4, j * 4) + fields.cliffiness((i + di) * 4, (j + dj) * 4) > 1;
        if (gameOpen) open++;
        if (gameOpen !== oursOpen) flips++;
      }
    }
    expect(checked).toBe(24960);
    expect(flips).toBe(0);
    // Non-vacuity: both outcomes are common, and the clamp floor - the case the
    // value comparison could not speak to - is half the corners.
    expect(open).toBe(13661);
    expect(checked - open).toBe(11299);
    expect(onClamp).toBe(6330);
  }, 120000);
});

/**
 * **The shipping accuracy, with the lava rejection the renderer actually
 * applies.** #84's headline - "37 of 1531 matched cells carry a wrong
 * orientation" - is the measurement taken WITHOUT that rejection, which is how
 * the issue was originally written and which `renderVulcanusCliffs` does not do.
 * Both arms are pinned here so the two numbers can never be confused again.
 */
describe("Vulcanus cliff accuracy, both arms", () => {
  const scoreRegion = (
    c: (typeof entities.cases)[number],
    withLava: boolean,
  ): { matched: number; oriWrong: number; oursOnly: number; missed: number } => {
    const game = gameCliffs(c.cliffs, c.region);
    const placed = place(c.region, { withLava });
    let matched = 0;
    let oriWrong = 0;
    const ours = new Set<string>();
    for (const p of placed) {
      const k = key(p.x, p.y);
      ours.add(k);
      const want = game.get(k);
      if (want === undefined) continue;
      matched++;
      if (CLIFF_ORIENTATION_NAMES[cliffOrientationForCode(p.code) as number] !== want) oriWrong++;
    }
    let missed = 0;
    for (const k of game.keys()) if (!ours.has(k)) missed++;
    return { matched, oriWrong, oursOnly: ours.size - matched, missed };
  };

  it("WITH the lava rejection: 33 wrong of 1525 matched", () => {
    const all = entities.cases.map((c) => scoreRegion(c, true));
    expect(all.map((s) => s.oriWrong)).toEqual([5, 25, 3]);
    expect(all.map((s) => s.oursOnly)).toEqual([2, 42, 1]);
    expect(all.map((s) => s.missed)).toEqual([2, 3, 1]);
    expect(all.reduce((n, s) => n + s.matched, 0)).toBe(1525);
  }, 120000);

  it("WITHOUT it: the 37 / 1531 the issue quotes - recall is perfect, precision is not", () => {
    const all = entities.cases.map((c) => scoreRegion(c, false));
    expect(all.map((s) => s.oriWrong)).toEqual([7, 26, 4]);
    // Nothing the game placed is ever missed without the rejection, so every
    // one of the 37 is an orientation error on a cell we agree exists.
    expect(all.map((s) => s.missed)).toEqual([0, 0, 0]);
    expect(all.reduce((n, s) => n + s.matched, 0)).toBe(1531);
    expect(all.reduce((n, s) => n + s.oriWrong, 0)).toBe(37);
  }, 120000);
});
