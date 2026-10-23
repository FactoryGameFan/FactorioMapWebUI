import { describe, expect, it } from "vite-plus/test";
import { readAquiloResourceControls, readResourceControls } from "../src/model/resourceReads";
import { RESOURCE_CATALOG } from "../src/noise/resources/resourceCatalog";

describe("readResourceControls", () => {
  it("reads each catalog resource's control, defaulting absent ones to 1/1/1", () => {
    const controls = readResourceControls({
      autoplaceControls: {
        "iron-ore": { frequency: 2, size: 1.5, richness: 3 },
        // coal, copper, stone, crude-oil, uranium-ore absent
      },
    });
    expect(controls["iron-ore"]).toEqual({ frequency: 2, size: 1.5, richness: 3 });
    expect(controls.coal).toEqual({ frequency: 1, size: 1, richness: 1 });
    // one entry per catalog resource
    expect(Object.keys(controls).sort()).toEqual(RESOURCE_CATALOG.map((r) => r.controlName).sort());
  });
});

describe("readAquiloResourceControls", () => {
  it("reads a preset with none of the three controls as neutral 1/1, not size 0", () => {
    expect(readAquiloResourceControls({ autoplaceControls: {} })).toEqual({
      crudeOil: { frequency: 1, size: 1 },
      lithiumBrine: { frequency: 1, size: 1 },
      fluorineVent: { frequency: 1, size: 1 },
    });
  });

  it("reads each control from its own key and keeps a size of 0", () => {
    const c = readAquiloResourceControls({
      autoplaceControls: {
        aquilo_crude_oil: { frequency: 2, size: 3, richness: 4 },
        lithium_brine: { frequency: 1, size: 0, richness: 1 },
        fluorine_vent: { frequency: 0.5, size: 1.5, richness: 1 },
      },
    });
    expect(c.crudeOil).toEqual({ frequency: 2, size: 3 });
    expect(c.lithiumBrine).toEqual({ frequency: 1, size: 0 });
    expect(c.fluorineVent).toEqual({ frequency: 0.5, size: 1.5 });
  });
});
