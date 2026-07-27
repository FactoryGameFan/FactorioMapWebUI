import { describe, expect, it } from "vite-plus/test";
import { RESOURCE_CATALOG } from "../src/noise/resources/resourceCatalog";
import { makeResourceResolver, pickWinner } from "../src/noise/resources/resolveResource";

const byName = (n: string) => RESOURCE_CATALOG.find((r) => r.name === n)!;

describe("pickWinner (order-priority overlay)", () => {
  it("returns null when nothing is present", () => {
    expect(pickWinner([])).toBe(null);
  });

  it("prefers order 'b' over order 'c' regardless of listing order", () => {
    const iron = byName("iron-ore"); // order b, patchSetIndex 0
    const uranium = byName("uranium-ore"); // order c, patchSetIndex 5
    expect(pickWinner([uranium, iron])).toBe(iron);
    expect(pickWinner([iron, uranium])).toBe(iron);
  });

  it("within an order, lower patchSetIndex wins", () => {
    const copper = byName("copper-ore"); // b, index 1
    const stone = byName("stone"); // b, index 3
    expect(pickWinner([stone, copper])).toBe(copper);
  });

  it("crude-oil (c, index 4) beats uranium (c, index 5)", () => {
    expect(pickWinner([byName("uranium-ore"), byName("crude-oil")])).toBe(byName("crude-oil"));
  });
});

describe("resource placement modes", () => {
  it("crude oil is the one roll resource; the rest threshold", () => {
    // Oil is singled out by its prototype, not by taste: `random_probability`
    // below 1 is exactly what puts a `random_penalty` factor on the probability
    // (`core/lualib/resource-autoplace.lua:103-105`), and oil's 1/48 is the only
    // one in the catalog. So this asserts the two properties agree, which is the
    // thing that would actually break if a resource were added.
    for (const p of RESOURCE_CATALOG) {
      expect(p.placement).toBe(p.randomProbability < 1 ? "roll" : "threshold");
    }
    expect(RESOURCE_CATALOG.filter((p) => p.placement === "roll").map((p) => p.name)).toEqual([
      "crude-oil",
    ]);
  });

  it("the resolver no longer returns oil, because the roll pass paints it", () => {
    // The regression this guards: oil used to be thresholded here, which painted
    // its entire patch extent as solid ore - 1234 tiles in [0,0]-[512,512] where
    // the game has 8 wells. A window with plenty of oil footprint must now yield
    // no oil from the resolver at all.
    const resolve = makeResourceResolver({ seed0: 123456, controls: {} });
    let oilTiles = 0;
    for (let y = 0; y < 512; y += 3) {
      for (let x = 0; x < 512; x += 3) {
        if (resolve(x, y)?.name === "crude-oil") oilTiles++;
      }
    }
    expect(oilTiles).toBe(0);
  });
});

describe("makeResourceResolver", () => {
  const resolve = makeResourceResolver({
    seed0: 123456,
    controls: {}, // all default to freq/size/richness 1
  });

  it("returns null at spawn (no regular patches inside the fade-in radius)", () => {
    expect(resolve(0, 0)).toBe(null);
  });

  it("finds resource patches out in the world, and every winner is a catalog member", () => {
    const names = new Set(RESOURCE_CATALOG.map((r) => r.name));
    let found = 0;
    for (let y = 512; y < 1536 && found < 3; y += 16) {
      for (let x = 512; x < 1536; x += 16) {
        const w = resolve(x, y);
        if (w) {
          expect(names.has(w.name)).toBe(true);
          found++;
          break;
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it("omits a resource whose size control is 0 (never wins)", () => {
    const ironOff = makeResourceResolver({
      seed0: 123456,
      controls: { "iron-ore": { frequency: 1, size: 0, richness: 1 } },
    });
    // Scan; iron must never be returned when its size is 0.
    for (let y = 512; y < 1536; y += 32) {
      for (let x = 512; x < 1536; x += 32) {
        expect(ironOff(x, y)?.name).not.toBe("iron-ore");
      }
    }
  });
});

describe("makeResourceResolver (M3b: starting patches near spawn)", () => {
  // iron-ore is order "b", patchSetIndex 0 - the highest-priority resource, so if
  // its own field is present at a tile it always wins regardless of what else
  // overlaps there. STARTING_RESOURCE_PLACEMENT_RADIUS is 150: the regular field's
  // fade-in (REGULAR_PATCH_FADE_IN_DISTANCE) makes regular density (and therefore
  // the regular field, including its blob term) exactly 0 for every distance < 150,
  // so a resource found strictly inside that radius can only come from the
  // starting-patch term this task wires in - a scan there is a real RED/GREEN
  // discriminator (verified: unwired, this scan finds nothing and the test fails).
  it("returns iron-ore at some near-spawn tile inside its guaranteed starting patch", () => {
    const resolve = makeResourceResolver({
      seed0: 123456,
      controls: { "iron-ore": { frequency: 1, size: 1, richness: 1 } },
    });
    let found = false;
    for (let y = -140; y <= 140 && !found; y += 4) {
      for (let x = -140; x <= 140; x += 4) {
        if (resolve(x, y)?.name === "iron-ore") {
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
  });
});
