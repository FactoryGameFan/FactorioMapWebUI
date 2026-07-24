import { describe, expect, it } from "vite-plus/test";

import { renderVulcanusTerrain } from "../src/noise/preview/renderVulcanusTerrain";
import { renderVulcanusResources } from "../src/noise/preview/renderVulcanusResources";
import { VULCANUS_RESOURCE_CATALOG } from "../src/noise/resources/vulcanusResourceCatalog";

const SEED = 123456;

describe("renderVulcanusResources", () => {
  it("catalog carries the three solid ores with their map_colors", () => {
    expect(VULCANUS_RESOURCE_CATALOG.map((r) => r.name)).toEqual([
      "tungsten-ore",
      "calcite",
      "coal",
    ]);
    expect(VULCANUS_RESOURCE_CATALOG.map((r) => r.controlName)).toEqual([
      "tungsten_ore",
      "calcite",
      "vulcanus_coal",
    ]);
    // map_color = {98/256, 86/256, 150/256} -> Math.round(v * 255): {98, 86, 149}
    expect(VULCANUS_RESOURCE_CATALOG[0].mapColor).toEqual([98, 86, 149]);
    // map_color = {0.8, 0.7, 0.7} -> {204, 179, 179}
    expect(VULCANUS_RESOURCE_CATALOG[1].mapColor).toEqual([204, 179, 179]);
    // map_color = {0, 0, 0}
    expect(VULCANUS_RESOURCE_CATALOG[2].mapColor).toEqual([0, 0, 0]);
  });

  it("paints ore pixels and leaves the rest of the terrain untouched", () => {
    const opts = {
      seed0: SEED,
      width: 64,
      height: 64,
      originX: -1600,
      originY: -1600,
      tilesPerPixel: 8,
    };
    const base = renderVulcanusTerrain(opts);
    const before = new Uint8ClampedArray(base.data);
    renderVulcanusResources(base, {
      seed0: SEED,
      originX: opts.originX,
      originY: opts.originY,
      tilesPerPixel: opts.tilesPerPixel,
    });

    const colors = new Set(VULCANUS_RESOURCE_CATALOG.map((r) => r.mapColor.join(",")));
    let changed = 0;
    for (let o = 0; o < base.data.length; o += 4) {
      const same =
        base.data[o] === before[o] &&
        base.data[o + 1] === before[o + 1] &&
        base.data[o + 2] === before[o + 2];
      if (same) continue;
      changed++;
      // Every changed pixel must be exactly one of the three ore colors.
      expect(colors.has(`${base.data[o]},${base.data[o + 1]},${base.data[o + 2]}`)).toBe(true);
    }
    // A 512x512-tile window centred on spawn contains the starting patches, so
    // this must not be empty - an all-zero result means the overlay never fired.
    expect(changed).toBeGreaterThan(0);
  });

  it("draws nothing when every resource's size slider is 0", () => {
    const opts = {
      seed0: SEED,
      width: 32,
      height: 32,
      originX: -1600,
      originY: -1600,
      tilesPerPixel: 8,
    };
    const base = renderVulcanusTerrain(opts);
    const before = new Uint8ClampedArray(base.data);
    const off = { frequency: 1, size: 0 };
    renderVulcanusResources(base, {
      seed0: SEED,
      originX: opts.originX,
      originY: opts.originY,
      tilesPerPixel: opts.tilesPerPixel,
      ctx: {
        vulcanusResourceControls: {
          tungstenOre: off,
          vulcanusCoal: off,
          calcite: off,
          sulfuricAcidGeyser: off,
        },
      },
    });
    expect(Array.from(base.data)).toEqual(Array.from(before));
  });
});
