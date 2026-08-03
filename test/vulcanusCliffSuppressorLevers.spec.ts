import { describe, expect, it } from "vite-plus/test";

import levers from "./fixtures/oracle-vulcanus-cliff-suppressor-levers.seed123456.json";
import {
  CLIFF_CODE_TO_ORIENTATION,
  CLIFF_ORIENTATION_COLLISION_BOX,
  CLIFF_ORIENTATION_NAMES,
  cliffCollisionTileBox,
} from "../src/noise/cliffs/cliffCatalog";
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

/**
 * **What suppresses the non-ore cliff residual at `[1500,1500]`** (#84), asked
 * with LEVERS rather than with predicates.
 *
 * #110 left two targets: the ore rule's 9 unreached cells, and a non-ore
 * residual of 13 wrong orientations plus 10 surplus cells that the ore rule
 * cannot touch. Its handoff asked for a lever that isolates the second the way
 * `autoplace_controls` isolated the first, and named identifying the suspect as
 * part of the job. `oracle-vulcanus-cliff-suppressor-levers` supplies two.
 *
 * The answers, in the order they were found:
 *
 * 1. **No placed entity suppresses a Vulcanus cliff.** Switching the whole
 *    `entity` autoplace category off removes every autoplaced entity in the
 *    region - 409 rocks, 115 chimneys, 45 rock explosions and all 8
 *    `crater-cliff`s - and the cliff set does not move by one cell. Rocks were only ever refuted statistically (#109, against our own
 *    rock model); this is the class excluded positively.
 * 2. **Cliffs do not collide with each other**, refuted by the game's own
 *    output rather than by a model: 293 pairs of the game's own cliffs have
 *    overlapping collision rectangles.
 * 3. **Lava suppresses 169 cells, and our rejection gets 166 of them with 5
 *    false positives** - precision 0.9708, recall 0.9822. Its errors are not
 *    spread over the region: they ARE part of the residual, accounting for 3 of
 *    the 10 surplus cells and all 3 of the missing ones.
 * 4. With **neither ore nor lava in the world**, the port's recall is
 *    **1.0000** - it misses nothing the game places - and what remains is 9
 *    wrong orientations and 12 surplus cells in four tight clusters.
 *
 * (4) is the sharpest statement of the residual there has been, and it is the
 * one to hand forward: the crossing field plus the repair produce a set that
 * CONTAINS the game's, so everything left is over-placement, and both rejections
 * are now measured against known sets rather than fitted.
 */

const INPUT = { seed0: levers.seed, startingPositions: [{ x: 0, y: 0 }] };
const ctx = withCtxDefaults(INPUT);
const fields = makeVulcanusCliffFields(ctx);
const tileAt = makeVulcanusTileResolver(INPUT);

const nameToId = new Map(CLIFF_ORIENTATION_NAMES.map((n, i) => [n, i]));
const codeForOrientationId = new Map<number, number>();
for (const [code, id] of Object.entries(CLIFF_CODE_TO_ORIENTATION))
  if (!codeForOrientationId.has(id)) codeForOrientationId.set(id, Number(code));

const R = levers.region;
const inR = (x: number, y: number): boolean => x >= R.x0 && x < R.x1 && y >= R.y0 && y < R.y1;

const armOf = (label: string): (typeof levers.cases)[number] => {
  const c = levers.cases.find((k) => k.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};

/** The arm's `cliff-vulcanus` cells in the region, as `"x,y" -> orientation id`. */
const gameSet = (label: string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const e of armOf(label).cliffs) {
    if (e.name !== "cliff-vulcanus" || !inR(e.x, e.y)) continue;
    const id = nameToId.get(e.orientation ?? "");
    if (id !== undefined) m.set(`${String(e.x)},${String(e.y)}`, id);
  }
  return m;
};

/**
 * The shipping model with the ore out of the picture, so what is left is the
 * crossing field, the repair, and the LAVA rejection alone. `lava: false` drops
 * that rejection too, which is what the lava lever is scored against.
 */
const portSet = (lava: boolean): Map<string, number> =>
  new Map(
    makeCliffPlacementFromFields(fields, {
      elevation0: VULCANUS_CLIFF_ELEVATION_0,
      interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
      smoothing: VULCANUS_CLIFF_SMOOTHING,
      tileCollides: lava
        ? (x, y): boolean => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name)
        : undefined,
      rejectAtCrossingStage: true,
    })
      .placedCells(R.x0, R.y0, R.x1, R.y1)
      .map(
        (p) => [`${String(p.x)},${String(p.y)}`, CLIFF_CODE_TO_ORIENTATION[p.code] ?? -1] as const,
      ),
  );

const score = (ours: Map<string, number>, game: Map<string, number>): Record<string, number> => {
  let matched = 0;
  let wrong = 0;
  let surplus = 0;
  let missing = 0;
  for (const [k, id] of ours) {
    const t = game.get(k);
    if (t === undefined) surplus++;
    else if (t === id) matched++;
    else wrong++;
  }
  for (const k of game.keys()) if (!ours.has(k)) missing++;
  return { matched, wrong, surplus, missing };
};

describe("what suppresses the Vulcanus cliff residual, by lever", () => {
  /**
   * **The entity class, excluded positively.** `autoplace_controls` cannot ask
   * this: a control only reaches prototypes that name one, so the four resources
   * have one and the rocks, the chimneys and `crater-cliff` have none. The
   * `entity` autoplace CATEGORY can be switched off wholesale, and that is the
   * whole class in one arm.
   *
   * The lever's own proof is in the same run three times over - the
   * `autoplace_settings` the surface read BACK,  the 573 entities that vanished,
   * and the 8 `crater-cliff`s that went with them. Without those, "the cliffs did
   * not move" and "the override never applied" are the same observation.
   *
   * A vacuity check on the other side too: `cliff-vulcanus` comes from
   * `cliff_settings`, not from the entity category, so it must SURVIVE the lever.
   * It does, all 916 of them, with identical orientations.
   */
  it("no placed entity suppresses a cliff - the entity category lever moves nothing", () => {
    const base = armOf("resources OFF via controls");
    const lever = armOf("entity autoplace category OFF");

    // The lever landed: the category is off at the source.
    expect(base.effectiveAutoplaceSettings?.entity).toEqual({
      treat_missing_as_default: true,
      settingsCount: 16,
    });
    expect(lever.effectiveAutoplaceSettings?.entity).toEqual({
      treat_missing_as_default: false,
      settingsCount: 0,
    });

    // ...and it emptied the world of exactly the class under suspicion. Every
    // `simple-entity` - which is what the rocks and the chimneys are, and the
    // only autoplaced type on Vulcanus carrying a collision box other than the
    // resources - is gone, along with the rock explosions.
    //
    // What survives is one demolisher and its parts (54 `segment`, plus a
    // corpse, a trail and a smoke cloud). Those are spawned by the unit, not
    // autoplaced, so the lever cannot reach them and they are named here rather
    // than swept into a "non-cliff" total that would then have to read 4.
    const count = (
      arm: typeof base,
      pred: (e: { name: string; type: string }) => boolean,
    ): number => (arm.entities ?? []).filter(pred).length;
    const isRock = (e: { name: string }): boolean => e.name.includes("volcanic-rock");
    const isChimney = (e: { name: string }): boolean => e.name.startsWith("vulcanus-chimney");
    expect(count(base, isRock)).toBe(409);
    expect(count(lever, isRock)).toBe(0);
    expect(count(base, isChimney)).toBe(115);
    expect(count(lever, isChimney)).toBe(0);
    expect(count(base, (e) => e.type === "simple-entity")).toBe(524);
    expect(count(lever, (e) => e.type === "simple-entity")).toBe(0);
    expect(count(base, (e) => e.type === "explosion")).toBe(45);
    expect(count(lever, (e) => e.type === "explosion")).toBe(0);
    const DEMOLISHER = new Set(["segment", "segmented-unit", "corpse", "smoke-with-trigger"]);
    expect(count(lever, (e) => e.type !== "cliff" && !DEMOLISHER.has(e.type))).toBe(0);
    expect(count(lever, (e) => DEMOLISHER.has(e.type))).toBe(58);
    expect(base.cliffs.filter((c) => c.name === "crater-cliff").length).toBe(8);
    expect(lever.cliffs.filter((c) => c.name === "crater-cliff").length).toBe(0);

    // And the cliffs did not move - not in count, not in position, not in
    // orientation. Bit-for-bit, which is a much stronger claim than a total.
    const a = gameSet("resources OFF via controls");
    const b = gameSet("entity autoplace category OFF");
    expect(a.size).toBe(892);
    expect(b.size).toBe(a.size);
    for (const [k, id] of a) expect(b.get(k)).toBe(id);
  });

  /**
   * **Cliffs do not collide with each other.** A tempting candidate, since a
   * cliff IS an entity with a collision box and `tryToAddCliff` places them one
   * at a time - a run that terminates where the port continues looks exactly like
   * a cliff refusing to sit beside its neighbour.
   *
   * It needs no model to refute, because the GAME'S OWN OUTPUT contains the
   * counterexamples: 293 pairs of cliffs the game placed have overlapping
   * collision rectangles. Whatever `tryToAddCliff` tests, it is not that.
   *
   * The port's own set is the vacuity arm - if the counter were broken it would
   * report 0 there too, and it does not.
   */
  it("cliff-vs-cliff box overlap is refuted by the game's own cliffs", () => {
    const boxOf = (k: string, id: number): [number, number, number, number] => {
      const [xs, ys] = k.split(",");
      const [l, t, r, b] = CLIFF_ORIENTATION_COLLISION_BOX[id];
      return [Number(xs) + l, Number(ys) + t, Number(xs) + r, Number(ys) + b];
    };
    const overlappingPairs = (cells: Map<string, number>): number => {
      const list = [...cells].map(([k, id]) => boxOf(k, id));
      let n = 0;
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i];
          const q = list[j];
          if (p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3]) n++;
        }
      return n;
    };
    expect(overlappingPairs(gameSet("resources OFF via controls"))).toBe(293);
    expect(overlappingPairs(portSet(true))).toBe(299);
  }, 120000);

  /**
   * **The lava lever, and the first precision/recall the tile rejection has
   * ever had.** Dropping `lava`/`lava-hot` from the tile autoplace leaves the
   * elevation the crossings read untouched - tiles are downstream of it - and
   * takes away the only thing `tryToAddCliff`'s tile test can reject against. So
   * the cells that APPEAR are the game's own answer to which cliffs lava
   * suppresses, exactly as `autoplace_controls` gave the ore's answer in #110.
   *
   * Before this the rejection was scored only by how much it improved the
   * totals (#84 item 1: "185 false positives dropped, 13 true"), which cannot
   * distinguish a rule that is right from one that is merely profitable. Now:
   * **166 of 169, with 5 false positives.**
   *
   * The 6,709 lava tiles (2,466 `lava` + 4,243 `lava-hot`) that become 0 are the non-vacuity arm, and they are
   * counted in the same run that placed the cliffs - "lava suppresses nothing"
   * and "the tile override never applied" are otherwise one observation.
   *
   * Note `appeared` is 3, not 0: removing lava also REMOVES three cells, because
   * a neighbour that stops being rejected takes back a shared edge and recodes
   * the survivor (#103, #108). So this lever is not one-way the way the ore's
   * was, and the three are reported rather than filtered out.
   */
  it("scores the lava rejection against the lava lever", () => {
    const on = armOf("resources OFF via controls");
    const off = armOf("resources OFF, LAVA TILES OFF");
    expect(on.tileCounts).toEqual({ lava: 2466, "lava-hot": 4243 });
    expect(off.tileCounts).toEqual({ lava: 0, "lava-hot": 0 });
    expect(off.effectiveAutoplaceSettings?.tile).toEqual({
      treat_missing_as_default: false,
      settingsCount: 17,
    });

    const gOn = gameSet("resources OFF via controls");
    const gOff = gameSet("resources OFF, LAVA TILES OFF");
    expect(gOn.size).toBe(892);
    expect(gOff.size).toBe(1058);

    const suppressed = new Set([...gOff.keys()].filter((k) => !gOn.has(k)));
    const appeared = [...gOn.keys()].filter((k) => !gOff.has(k));
    expect(suppressed.size).toBe(169);
    expect(appeared.length).toBe(3);

    const pOn = portSet(true);
    const pOff = portSet(false);
    const ours = new Set([...pOff.keys()].filter((k) => !pOn.has(k)));
    const hit = [...ours].filter((k) => suppressed.has(k)).length;
    expect(ours.size).toBe(171);
    expect(hit).toBe(166);
    expect(hit / ours.size).toBeCloseTo(0.9708, 4); // precision
    expect(hit / suppressed.size).toBeCloseTo(0.9822, 4); // recall
  }, 120000);

  /**
   * **The rejection's errors are the residual, not a scatter.** With 169 true
   * suppressions and 1,058 cells to be wrong about, 8 errors landing on the 26
   * cells the port already disagrees about is the finding - it says the lava
   * rule is not a small independent inaccuracy but a named part of what is left.
   *
   * And they go BOTH WAYS: 3 cells the game rejects and we keep, 5 we reject and
   * it keeps. A box that is uniformly too small or too big cannot produce that,
   * so the shape is wrong rather than the size - which is exactly why this must
   * not be tuned until it fits (#88, where the best-scoring box hid a second
   * defect).
   */
  it("the lava errors are the residual's own cells, and they point both ways", () => {
    const gOn = gameSet("resources OFF via controls");
    const gOff = gameSet("resources OFF, LAVA TILES OFF");
    const pOn = portSet(true);
    const pOff = portSet(false);
    const suppressed = new Set([...gOff.keys()].filter((k) => !gOn.has(k)));
    const ours = new Set([...pOff.keys()].filter((k) => !pOn.has(k)));

    const missedByUs = [...suppressed].filter((k) => !ours.has(k)).sort();
    const falseByUs = [...ours].filter((k) => !suppressed.has(k)).sort();
    expect(missedByUs).toEqual(["1658,1598.5", "1662,1630.5", "1722,1630.5"]);
    expect(falseByUs).toEqual([
      "1638,1598.5",
      "1638,1602.5",
      "1662,1634.5",
      "1674,1658.5",
      "1674,1662.5",
    ]);

    // Every cell we MISS is one of the port's surplus cells, and every cell the
    // port is missing is one we falsely reject. Both directions, no leftovers.
    const shipping = score(pOn, gOn);
    expect(shipping).toEqual({ matched: 876, wrong: 13, surplus: 10, missing: 3 });
    for (const k of missedByUs) expect(gOn.has(k)).toBe(false);
    for (const k of missedByUs) expect(pOn.has(k)).toBe(true);
    const portMissing = [...gOn.keys()].filter((k) => !pOn.has(k)).sort();
    expect(portMissing).toEqual(["1638,1598.5", "1638,1602.5", "1662,1634.5"]);
    expect(portMissing.every((k) => falseByUs.includes(k))).toBe(true);
  }, 120000);

  /**
   * **With neither ore nor lava, the port misses NOTHING.** 1,058 cells, recall
   * 1.0000, precision 0.9802. That is the cleanest reading the crossing field
   * and the repair have had, and it changes the shape of what is left: the port
   * produces a strict SUPERSET of the game's cells, so every remaining defect is
   * an over-placement, and the two rejections are the only things that can
   * remove one.
   *
   * The 12 surplus cells sit in four tight clusters, and every one has the same
   * shape - the port runs a cliff one or two cells past where the game's run
   * ends in an entrance orientation. The 9 wrong orientations are the far side
   * of those same edges (#103), not a separate problem.
   */
  it("with neither ore nor lava the port's recall is 1.0000", () => {
    const gOff = gameSet("resources OFF, LAVA TILES OFF");
    expect(score(portSet(false), gOff)).toEqual({
      matched: 1049,
      wrong: 9,
      surplus: 12,
      missing: 0,
    });

    // The four clusters, as the handoff for whatever comes next.
    const surplus = [...portSet(false).keys()].filter((k) => !gOff.has(k)).sort();
    expect(surplus.length).toBe(12);
    const clusterOf = (k: string): string => {
      const [xs, ys] = k.split(",");
      return `${String(Math.round(Number(xs) / 64))},${String(Math.round(Number(ys) / 64))}`;
    };
    expect(new Set(surplus.map(clusterOf)).size).toBe(4);
  }, 120000);

  /**
   * **The residual sits on the lava perimeter, and that is a rate against a
   * control rather than an impression.** Distance is measured from the cell's
   * own collision box to the nearest tile our resolver calls lava, so a cell
   * whose box already touches lava is 0 and cannot appear here at all (the port
   * would have rejected it).
   *
   * | population | n | lava within 2 tiles of the box |
   * | --- | --- | --- |
   * | matched (control) | 876 | 9 = **1.0%** |
   * | surplus | 10 | 4 = **40%** |
   * | wrong | 13 | 5 = **38%** |
   *
   * A 40x enrichment, and it is what led to the lava lever above. Two cautions
   * kept with the number rather than dropped:
   *
   * - the effective sample size is the number of CLUSTERS, not of cells - four
   *   of them, not 23 - so this is a lead, not a significance claim
   *   (`below-chance-needs-a-clustered-null`); and
   * - one cluster, `[1742..1746, 1530..1542]`, has NO lava within 10 tiles, so
   *   the residual was never going to be lava all the way down. The lever
   *   confirms it: that cluster survives with lava removed from the world.
   */
  it("the residual is enriched at the lava perimeter, against the matched base rate", () => {
    const gOn = gameSet("resources OFF via controls");
    const near = { matched: 0, wrong: 0, surplus: 0 };
    const total = { matched: 0, wrong: 0, surplus: 0 };
    for (const [k, id] of portSet(true)) {
      const [xs, ys] = k.split(",");
      const x = Number(xs);
      const y = Number(ys);
      const code = codeForOrientationId.get(id) ?? 0;
      const b = cliffCollisionTileBox(code, x, y);
      if (b === undefined) continue;
      let gap = Infinity;
      for (let tx = b.left - 2; tx <= b.right + 2; tx++)
        for (let ty = b.top - 2; ty <= b.bottom + 2; ty++) {
          if (!VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(tx, ty).name)) continue;
          const dx = tx < b.left ? b.left - tx : tx > b.right ? tx - b.right : 0;
          const dy = ty < b.top ? b.top - ty : ty > b.bottom ? ty - b.bottom : 0;
          gap = Math.min(gap, Math.hypot(dx, dy));
        }
      const t = gOn.get(k);
      const bucket = t === undefined ? "surplus" : t === id ? "matched" : "wrong";
      total[bucket]++;
      if (gap <= 2) near[bucket]++;
    }
    expect(total).toEqual({ matched: 876, wrong: 13, surplus: 10 });
    expect(near).toEqual({ matched: 9, wrong: 5, surplus: 4 });
    expect(near.surplus / total.surplus).toBeGreaterThan(30 * (near.matched / total.matched));
  }, 120000);
});
