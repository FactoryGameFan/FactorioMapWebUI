import { describe, expect, it } from "vite-plus/test";
import { PLANETS } from "../src/model/planets";
import { PLANET_CAPABILITIES } from "../src/model/planetCapabilities";

describe("PLANET_CAPABILITIES", () => {
  it("has exactly the five PLANETS keys", () => {
    expect(Object.keys(PLANET_CAPABILITIES).sort()).toEqual([...PLANETS].sort());
  });

  it.each(PLANETS)("%s: no fallToTerrain entry is also a rendered view", (planet) => {
    const { views, fallToTerrain } = PLANET_CAPABILITIES[planet];
    for (const v of fallToTerrain) expect(views as readonly string[]).not.toContain(v);
  });

  it.each(PLANETS)("%s: rendered is false exactly when views is empty", (planet) => {
    const { rendered, views } = PLANET_CAPABILITIES[planet];
    expect(rendered).toBe(views.length > 0);
  });
});
