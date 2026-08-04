import { describe, expect, it } from "vite-plus/test";

import ore from "./fixtures/oracle-vulcanus-cliff-ore-direction.seed123456.json";

/**
 * **`crater-cliff` moves under the ore lever too - and it is a DIFFERENT effect
 * from the 31, with a mechanism class nobody in #84 has considered** (#84).
 *
 * Found while checking whether the 31 suppressed `cliff-vulcanus` cells were
 * really absent or merely renamed. They are absent (first block). But the same
 * dump shows something nobody had looked at: the arms disagree about
 * **crater-cliff**.
 *
 * | arm | `crater-cliff` in `[1500,1500]` |
 * | --- | --- |
 * | resources ON | **0** |
 * | calcite OFF | **8** |
 * | ALL resources OFF | **8** |
 * | geyser OFF | **0** |
 *
 * So calcite suppresses crater-cliffs, exactly as it suppresses `cliff-vulcanus`
 * - and `crater_cliff`'s probability expression cannot see it either:
 *
 * ```lua
 * -- decoratives-vulcanus.lua
 * expression = "0.5 * (vulcanus_rock_noise + 0.5 * aux - 0.5 * moisture)
 *               * (1 - max(vulcanus_basalts_biome, vulcanus_ashlands_biome))
 *               * place_every_n(21,21,0,0)"
 * ```
 *
 * Its 47-node closure contains no resource region, and neither do the two biomes
 * it reads. Same impossibility, second entity type.
 *
 * **But crater-cliffs differ from the 31 in the one way that matters.** They are
 * AUTOPLACED entities, placed during `applyEntities`, and entity autoplace
 * **rolls**. Removing calcite removes rolls, which shifts the per-chunk
 * `RandomGenerator` stream and moves everything drawn after it. That is a
 * mechanism class #84 has never considered, and it explains craters without any
 * noise dependency at all.
 *
 * **It cannot explain the 31.** `cliff-vulcanus` comes from `generateCliffs` and
 * `applyCliffs`, both of which run before any entity is rolled -
 * `computeInternal` calls `generateCliffs` at `+0x2c`, before it even builds the
 * `NoiseCache` the `generateEntities` passes use. A cliff decided before the
 * first roll cannot be moved by a change to the roll sequence.
 *
 * **The RNG-stream reading is a HYPOTHESIS here, not a result.** Nothing in this
 * file tests it; it is recorded because it is the first mechanism class in this
 * investigation that is not already closed, and because the alternative - that
 * craters share the 31's unknown cause - would be a much bigger claim needing
 * much better evidence.
 *
 * **The fixture hazard, which is the practical takeaway.** The arms of
 * `oracle-vulcanus-cliff-ore-direction` disagree about how many crater-cliffs
 * exist, so any comparison across arms over "all cliff entities" is confounded by
 * an effect that has nothing to do with the cliff generator. Every spec in #84
 * filters to `name === "cliff-vulcanus"` and is therefore correct - but that was
 * inherited convention rather than a guarded decision, and this file makes it a
 * guarded one.
 */

const K = (x: number, y: number): string => `${String(x)},${String(y)}`;

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
  cliffs: Ent[];
}
const CASES = ore.cases as unknown as Case[];
const arm = (label: string): Case => {
  const c = CASES.find((q) => q.label === label);
  if (c === undefined) throw new Error(`no arm ${label}`);
  return c;
};
const inRegion = (c: Case, e: { x: number; y: number }): boolean =>
  e.x >= c.region.x0 && e.x < c.region.x1 && e.y >= c.region.y0 && e.y < c.region.y1;
const named = (label: string, name: string): Ent[] =>
  arm(label).cliffs.filter((e) => e.name === name && inRegion(arm(label), e));

describe("the 31 are absent, not renamed", () => {
  /**
   * **The check the repo has been burned by not doing.** #94's lesson was that a
   * `name === "cliff-vulcanus"` filter threw away the answer a fixture already
   * held. So: is there a cliff entity of ANY prototype at the 31 positions in
   * the resources-ON arm?
   *
   * There is not - not at the position, and not within a tile of it. The 31 are
   * genuinely missing rather than reclassified, which is a prerequisite of every
   * result in #84 and had never been stated.
   */
  it("finds no cliff entity of any name at the 31 suppressed positions", () => {
    const on = arm("entity region, resources ON");
    const off = arm("entity region, ALL resources OFF");
    const onVulc = new Set(
      named("entity region, resources ON", "cliff-vulcanus").map((e) => K(e.x, e.y)),
    );
    const offVulc = named("entity region, ALL resources OFF", "cliff-vulcanus").map((e) =>
      K(e.x, e.y),
    );
    const suppressed = offVulc.filter((k) => !onVulc.has(k));
    expect(suppressed.length).toBe(31);

    const onAny = on.cliffs.filter((e) => inRegion(on, e));
    const held = suppressed.filter((k) => {
      const [xs, ys] = k.split(",");
      const x = Number(xs);
      const y = Number(ys);
      return onAny.some((e) => Math.abs(e.x - x) <= 1 && Math.abs(e.y - y) <= 1);
    });
    expect(held).toEqual([]);
    // Non-vacuity: the ON arm is not simply empty of cliff entities.
    expect(onAny.length).toBeGreaterThan(800);
    void off;
  });
});

describe("crater-cliff moves under the lever, and it is a separate effect", () => {
  /**
   * The counts. Calcite is the control that moves them; the geyser is not.
   */
  it("has 0 crater-cliffs with the resources on and 8 with calcite off", () => {
    expect(named("entity region, resources ON", "crater-cliff").length).toBe(0);
    expect(named("entity region, geyser OFF", "crater-cliff").length).toBe(0);
    expect(named("entity region, calcite OFF", "crater-cliff").length).toBe(8);
    expect(named("entity region, ALL resources OFF", "crater-cliff").length).toBe(8);
  });

  /**
   * The same eight, in the same places, in both arms that switch calcite off -
   * so this is one reproducible ring rather than a scatter of near-misses. Their
   * fractional coordinates are the signature of the entity generator's jitter,
   * which is what puts them off the 4-tile cliff lattice.
   */
  it("places the same eight in both calcite-off arms", () => {
    const a = named("entity region, calcite OFF", "crater-cliff")
      .map((e) => K(e.x, e.y))
      .sort((x, y) => x.localeCompare(y));
    const b = named("entity region, ALL resources OFF", "crater-cliff")
      .map((e) => K(e.x, e.y))
      .sort((x, y) => x.localeCompare(y));
    expect(a).toEqual(b);
    expect(a.length).toBe(8);
    // Off-lattice: cliff cells sit at integer x and half-integer y.
    expect(a.every((k) => !Number.isInteger(Number(k.split(",")[0])))).toBe(true);
  });

  /**
   * **And they are nowhere near the 31**, so crater placement cannot be the
   * mechanism behind them even before the ordering argument. The closest a
   * crater gets to any suppressed cell is **16.375** tiles - against a crater's
   * own 2.8-tile collision box, and with the next-nearest at 28.4.
   */
  it("keeps the craters far from every suppressed cell", () => {
    const onVulc = new Set(
      named("entity region, resources ON", "cliff-vulcanus").map((e) => K(e.x, e.y)),
    );
    const suppressed = named("entity region, ALL resources OFF", "cliff-vulcanus")
      .filter((e) => !onVulc.has(K(e.x, e.y)))
      .map((e) => ({ x: e.x, y: e.y }));
    const craters = named("entity region, ALL resources OFF", "crater-cliff");
    let nearest = Infinity;
    for (const s of suppressed)
      for (const c of craters)
        nearest = Math.min(nearest, Math.max(Math.abs(c.x - s.x), Math.abs(c.y - s.y)));
    expect(suppressed.length).toBe(31);
    expect(craters.length).toBe(8);
    expect(nearest).toBeCloseTo(16.375, 3);
  });

  /**
   * **The fixture hazard, guarded.** Comparing "all cliff entities" across these
   * arms mixes the 31 with the 8, and the two have different causes. Anything in
   * #84 that compares arms must filter by prototype name; this arm fails loudly
   * if the unfiltered counts are ever treated as comparable.
   */
  it("shows the unfiltered totals are NOT comparable across arms", () => {
    const all = (label: string): number =>
      arm(label).cliffs.filter((e) => inRegion(arm(label), e)).length;
    const vulcOnly = (label: string): number => named(label, "cliff-vulcanus").length;
    // The unfiltered difference over-counts the suppression by exactly the 8.
    expect(all("entity region, ALL resources OFF") - all("entity region, resources ON")).toBe(39);
    expect(
      vulcOnly("entity region, ALL resources OFF") - vulcOnly("entity region, resources ON"),
    ).toBe(31);
  });
});
