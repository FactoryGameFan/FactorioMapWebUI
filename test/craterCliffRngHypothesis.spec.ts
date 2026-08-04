import { describe, expect, it } from "vite-plus/test";

import ore from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";
import levers from "./fixtures/oracle-vulcanus-cliff-suppressor-levers.seed123456.json";

/**
 * **The crater-cliff RNG hypothesis: n is ONE, both of its supporting rows are
 * VACUOUS, and a documented mechanism explains craters without it** (#84).
 *
 * #130 recorded "calcite suppresses crater-cliffs" and proposed a mechanism
 * class new to #84 - entity autoplace ROLLS, so removing calcite shifts the
 * per-chunk RNG stream. It marked itself a hypothesis and said "nothing here
 * tests it". This is that test, and it needs no capture: every fact below is in
 * fixtures that were already committed, one of them since #111.
 *
 * The hypothesis is not refuted. What is refuted is the evidence for it.
 *
 * ## 1. n is ONE crater, not eight
 *
 * The eight `crater-cliff` entities are eight segments of a **single ring** -
 * centre `(1646.62, 1679.75)`, radii 4.95 to 7.00, against the prototype's own
 * `crater_radius = 7` (`decoratives-vulcanus.lua`). FFF #386 describes exactly
 * this: "a ring of special cliffs where sections of the ring can randomly be
 * removed."
 *
 * So the effective sample size is **1**, and #130's table invites reading it as
 * 8. This is [[below-chance-needs-a-clustered-null]] in a second place.
 *
 * ## 2. The spatial reading would have been vacuous
 *
 * All eight segments sit within **0.33 tiles** of a calcite entity, which looks
 * like a smoking gun for a local mechanism and is not one: their chunk `(51,52)`
 * holds **805 calcite entities over 1024 tiles - 78.6% coverage**. A ring landing
 * on calcite there is the expected outcome, not a surprising one. Worth
 * recording because the check is cheap and the wrong conclusion is attractive.
 *
 * ## 3. #130's control row is VACUOUS
 *
 * Its table offers "geyser OFF -> 0 craters" as the arm distinguishing calcite
 * from resources generally. **There are zero geysers in the crater's chunk** -
 * all 19 in the region sit in chunks `(48,48)`, `(48,49)` and `(53,54)`. The
 * lever is non-vacuous globally (it removes all 19, and moves `cliff-vulcanus`
 * 885 -> 889) and inert *for this chunk's stream by construction*. It cannot
 * discriminate anything about the ring, and #130 read it as if it could.
 *
 * ## 4. A lever with NOTHING to do with calcite also produces craters
 *
 * Unread in `oracle-vulcanus-cliff-suppressor-levers` since #111:
 *
 * | arm | `cliff-vulcanus` | `crater-cliff` |
 * | --- | --- | --- |
 * | default, resources ON | 885 | **0** |
 * | resources OFF via controls | 916 | 8 |
 * | **LAVA TILES OFF only** | 1053 | **7** |
 * | resources OFF + LAVA TILES OFF | 1082 | **18** |
 *
 * **Craters appear with calcite still ON.** Every #84 spec filters to
 * `name === "cliff-vulcanus"`, so the column had never been looked at - the same
 * failure #94 caught once already.
 *
 * ## 5. And that one is a DATA FACT, not a hypothesis
 *
 * `crater-cliff` overrides the default cliff mask with an explicit
 * `{item, object, player, water_tile}`. On Vulcanus only `lava` and `lava-hot`
 * carry `water_tile`. So lava blocks crater segments **by prototype**, and row 3
 * of that table needs no RNG at all.
 *
 * ## Where that leaves calcite
 *
 * Its route is still unexplained, and the RNG stream is still the only unclosed
 * candidate - but two others are closed here rather than assumed:
 *
 * - **Not entity collision.** `collision-mask-defaults.lua` gives `resource` the
 *   mask `{resource}`, disjoint from every cliff mask including
 *   `crater-cliff`'s. That is #124's prototype-level argument, extended to the
 *   second entity type rather than assumed to carry over.
 * - **Not lava tiles.** #128 measured calcite moving **zero** blocking tiles.
 *
 * A third fact falls out of the same file and closes a route this session had to
 * consider: the default `cliff` mask carries **`not_colliding_with_itself`**, so
 * cliffs never collide with cliffs of their own prototype. `applyCliffs` adds
 * each cliff to the surface *before* testing the next one, so without that flag
 * the whole run would be order-dependent.
 *
 * ## Status
 *
 * **The RNG hypothesis is UNSUPPORTED, not refuted.** It has n = 1, no surviving
 * control, and a competing documented mechanism for the phenomenon it was
 * invented to explain. Testing it properly needs a lever that changes the roll
 * count in the crater's own chunk without touching that chunk's tiles or lava -
 * switching off one of the rock prototypes listed before `crater-cliff` in
 * `autoplace_settings.entity` would do it. That is one new capture arm, and it
 * is worth having a real control before spending it.
 */

interface Ent {
  x: number;
  y: number;
  name: string;
}
interface Res {
  x: number;
  y: number;
  name: string;
}
interface Case {
  label: string;
  cliffs: Ent[];
  resources?: Res[];
}

const oreCases = ore.cases as unknown as Case[];
const leverCases = levers.cases as unknown as Case[];
const arm = (cases: Case[], label: string): Case => {
  const c = cases.find((v) => v.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};
const named = (c: Case, name: string): Ent[] => c.cliffs.filter((e) => e.name === name);
const chunkOf = (v: number): number => Math.floor(v / 32);

const ON = arm(oreCases, "entity region, resources ON");
const CALCITE_OFF = arm(oreCases, "entity region, calcite OFF");
const GEYSER_OFF = arm(oreCases, "entity region, geyser OFF");
const RING = named(CALCITE_OFF, "crater-cliff");

describe("the eight craters are ONE ring, so n is 1", () => {
  it("has all eight segments on a circle of the prototype's crater_radius", () => {
    expect(RING.length).toBe(8);
    const cx = RING.reduce((a, e) => a + e.x, 0) / RING.length;
    const cy = RING.reduce((a, e) => a + e.y, 0) / RING.length;
    const radii = RING.map((e) => Math.hypot(e.x - cx, e.y - cy));
    // `crater_radius = 7` in decoratives-vulcanus.lua, and the segment centres
    // sit on it. The bound carries a tolerance because `(cx, cy)` is the
    // centroid of the SURVIVING segments, not the crater's true centre - a ring
    // missing a section has a centroid slightly off it, which is worth a hair
    // rather than a rounder-looking assertion that would fail on the next ring.
    for (const r of radii) {
      expect(r).toBeGreaterThan(4.9);
      expect(r).toBeLessThan(7.1);
    }
    // One ring means one chunk, which is what makes the effective sample size 1.
    const chunks = new Set(RING.map((e) => `${String(chunkOf(e.x))},${String(chunkOf(e.y))}`));
    expect(chunks.size).toBe(1);
  });
});

describe("the spatial coincidence with calcite is vacuous", () => {
  /**
   * Every segment is within a third of a tile of a calcite entity - and the
   * chunk is 78.6% calcite, so that is the expected outcome. Both halves are
   * asserted, because the first without the second is the wrong conclusion.
   */
  it("puts every segment within 0.4 tiles of calcite", () => {
    const cal = (ON.resources ?? []).filter((r) => r.name === "calcite");
    for (const e of RING) {
      const d = Math.min(...cal.map((r) => Math.hypot(e.x - r.x, e.y - r.y)));
      expect(d).toBeLessThan(0.4);
    }
  });

  it("but the ring's chunk is 78.6% calcite, so that means nothing", () => {
    const cal = (ON.resources ?? []).filter((r) => r.name === "calcite");
    const [cx, cy] = [chunkOf(RING[0].x), chunkOf(RING[0].y)];
    const inChunk = cal.filter((r) => chunkOf(r.x) === cx && chunkOf(r.y) === cy).length;
    expect(inChunk).toBe(805);
    expect(inChunk / 1024).toBeGreaterThan(0.75);
  });
});

describe("#130's geyser control cannot discriminate anything", () => {
  /**
   * The lever works - it removes all 19 geysers and moves `cliff-vulcanus` - and
   * it is inert for the crater's chunk by construction, because no geyser is in
   * it. Both arms are needed: "the lever did something" and "it did nothing
   * HERE" are different claims.
   */
  it("removes every geyser and still moves cliff-vulcanus", () => {
    expect((ON.resources ?? []).filter((r) => r.name === "sulfuric-acid-geyser").length).toBe(19);
    expect(
      (GEYSER_OFF.resources ?? []).filter((r) => r.name === "sulfuric-acid-geyser").length,
    ).toBe(0);
    expect(named(ON, "cliff-vulcanus").length).toBe(885);
    expect(named(GEYSER_OFF, "cliff-vulcanus").length).toBe(889);
  });

  it("but touches no entity in the crater's own chunk", () => {
    const [cx, cy] = [chunkOf(RING[0].x), chunkOf(RING[0].y)];
    const gey = (ON.resources ?? []).filter((r) => r.name === "sulfuric-acid-geyser");
    expect(gey.length).toBeGreaterThan(0);
    expect(gey.filter((r) => chunkOf(r.x) === cx && chunkOf(r.y) === cy).length).toBe(0);
    expect(named(GEYSER_OFF, "crater-cliff").length).toBe(0);
  });
});

describe("a lever unrelated to calcite also produces craters", () => {
  /**
   * The row that had been sitting unread in the #111 fixture. Resources are ON
   * in the lava arm, so calcite is not necessary for craters to appear - and
   * `crater-cliff`'s explicit mask carries `water_tile`, which on Vulcanus only
   * `lava` and `lava-hot` have, so the mechanism is a prototype-level data fact.
   */
  it("brings back 7 craters with LAVA TILES OFF and calcite still ON", () => {
    expect(named(arm(leverCases, "default, resources ON"), "crater-cliff").length).toBe(0);
    expect(named(arm(leverCases, "LAVA TILES OFF only"), "crater-cliff").length).toBe(7);
  });

  it("and 18 when both levers are pulled, more than either alone", () => {
    const both = named(arm(leverCases, "resources OFF, LAVA TILES OFF"), "crater-cliff").length;
    const res = named(arm(leverCases, "resources OFF via controls"), "crater-cliff").length;
    const lava = named(arm(leverCases, "LAVA TILES OFF only"), "crater-cliff").length;
    expect(res).toBe(8);
    expect(lava).toBe(7);
    expect(both).toBe(18);
    expect(both).toBeGreaterThan(Math.max(res, lava));
  });
});
