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
    // This window is world [-1600, -1096] x [-1600, -1096] (originX/Y=-1600,
    // tilesPerPixel=8, 64px) - a 512x512-tile square well away from spawn (closest
    // corner is ~1550 tiles out, far past VULCANUS_STARTING_AREA_RADIUS's farthest
    // starting spot at ~236), so any pixels painted here are regular (non-starting)
    // ore patches picked up by the spot-noise search, not starting patches. It must
    // not be empty - an all-zero result means the overlay never fired.
    expect(changed).toBeGreaterThan(0);
  });

  it("wires each ore to its own control - no lever is silently swapped", () => {
    // Every other test uses all-default 1/1 sliders, so a catalog bug that wired
    // (say) tungsten-ore's `levers` accessor to calcite's control would still pass
    // them all (both sliders are on). This isolates one control at a time and
    // checks only that ore's colour appears - genuinely exercising the
    // controlName <-> region wiring in `VULCANUS_RESOURCE_CATALOG`.
    //
    // Window world [-650, -452] x [620, 818] (originX/Y=-650/620, tilesPerPixel=2,
    // 100px) was picked by scanning for the smallest box containing a hit for all
    // three ores' regions (see task-6 investigation) - unlike the window above,
    // each ore paints a non-trivial number of pixels here on its own, so this
    // actually fails if two levers are swapped (confirmed by temporarily swapping
    // two `levers` accessors and watching this test fail).
    const opts = {
      seed0: SEED,
      width: 100,
      height: 100,
      originX: -650,
      originY: 620,
      tilesPerPixel: 2,
    };
    const off = { frequency: 1, size: 0 };
    const on = { frequency: 1, size: 1 };
    const allControlsOff = {
      tungstenOre: off,
      vulcanusCoal: off,
      calcite: off,
      sulfuricAcidGeyser: off,
    };
    // Deliberately hardcoded (not derived from VULCANUS_RESOURCE_CATALOG's own
    // `levers` accessor) so this test exercises that mapping rather than trusting it.
    const controlKeyByOre: Record<string, keyof typeof allControlsOff> = {
      "tungsten-ore": "tungstenOre",
      calcite: "calcite",
      coal: "vulcanusCoal",
    };

    for (const ore of VULCANUS_RESOURCE_CATALOG) {
      const base = renderVulcanusTerrain(opts);
      const before = new Uint8ClampedArray(base.data);
      renderVulcanusResources(base, {
        seed0: SEED,
        originX: opts.originX,
        originY: opts.originY,
        tilesPerPixel: opts.tilesPerPixel,
        ctx: {
          vulcanusResourceControls: {
            ...allControlsOff,
            [controlKeyByOre[ore.name]]: on,
          },
        },
      });

      const otherColors = VULCANUS_RESOURCE_CATALOG.filter((r) => r.name !== ore.name).map((r) =>
        r.mapColor.join(","),
      );
      let paintedOwnColor = 0;
      for (let o = 0; o < base.data.length; o += 4) {
        const same =
          base.data[o] === before[o] &&
          base.data[o + 1] === before[o + 1] &&
          base.data[o + 2] === before[o + 2];
        if (same) continue;
        const key = `${base.data[o]},${base.data[o + 1]},${base.data[o + 2]}`;
        if (key === ore.mapColor.join(",")) {
          paintedOwnColor++;
        } else {
          // A changed pixel painted in another ore's colour means this ore's
          // control leaked into (or was swapped with) another ore's region.
          expect(otherColors.includes(key)).toBe(false);
        }
      }
      // Confirms this ore's own control actually gates its own region - a
      // trivially-empty result would make the check above vacuous.
      expect(paintedOwnColor).toBeGreaterThan(0);
    }
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
