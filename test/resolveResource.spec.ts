import { describe, expect, it } from "vite-plus/test";
import { RESOURCE_CATALOG } from "../src/noise/resources/resourceCatalog";

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
});
