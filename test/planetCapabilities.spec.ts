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

  // Every planet is open to every visitor. Gleba was dev-mode only until #454's
  // last slice; a planet that is not ready must be left out of PLANETS, not
  // hidden behind a flag the panel reads.
  it.each(PLANETS)("%s: the preview renders it for every visitor", (planet) => {
    expect(PLANET_CAPABILITIES[planet].rendered).toBe(true);
    expect(Object.keys(PLANET_CAPABILITIES[planet])).not.toContain("devOnly");
  });

  it.each(PLANETS)("%s: rendered is false exactly when views is empty", (planet) => {
    const { rendered, views } = PLANET_CAPABILITIES[planet];
    expect(rendered).toBe(views.length > 0);
  });
});
