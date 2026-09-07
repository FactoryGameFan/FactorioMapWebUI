import { describe, it, expect } from "vite-plus/test";
import { elevationCtxFromPreset } from "../src/model/elevationPreviewCtx";
import { getBuiltinPreset } from "../src/model/builtins";
import { writeMapType } from "../src/model/mapType";
import type { Preset } from "../src/model/types";

function lakesPreset(): Preset {
  const p = getBuiltinPreset("Default");
  writeMapType(p.propertyExpressionNames, "lakes");
  return p;
}

describe("elevationCtxFromPreset", () => {
  it("marks a Lakes preset supported with its label", () => {
    const r = elevationCtxFromPreset(lakesPreset());
    expect(r.supported).toBe(true);
    expect(r.mapTypeLabel).toBe("Lakes elevation");
    expect(r.mapType).toBe("lakes");
  });

  it("marks the default (Nauvis) preset supported with its label and map type", () => {
    const r = elevationCtxFromPreset(getBuiltinPreset("Default"));
    expect(r.supported).toBe(true);
    expect(r.mapTypeLabel).toBe("Nauvis elevation");
    expect(r.mapType).toBe("nauvis");
  });

  it("marks an Island preset supported with its label and map type", () => {
    const p = getBuiltinPreset("Default");
    writeMapType(p.propertyExpressionNames, "island");
    const r = elevationCtxFromPreset(p);
    expect(r.supported).toBe(true);
    expect(r.mapTypeLabel).toBe("Island elevation");
    expect(r.mapType).toBe("island");
  });

  it("marks a modded/unknown elevation unsupported, preserving its label", () => {
    const p = getBuiltinPreset("Default");
    p.propertyExpressionNames["elevation"] = "elevation_modded_x";
    const r = elevationCtxFromPreset(p);
    expect(r.supported).toBe(false);
    expect(r.mapTypeLabel).toBe("elevation_modded_x");
  });

  it("derives waterLevel = 10*log2(size) and segmentation = frequency", () => {
    const p = lakesPreset();
    p.autoplaceControls.water = { frequency: 0.5, size: 4, richness: 1 };
    const r = elevationCtxFromPreset(p);
    expect(r.ctx.waterLevel).toBeCloseTo(20, 10); // 10*log2(4)
    expect(r.ctx.segmentationMultiplier).toBe(0.5);
  });

  it("falls back to renderer defaults when water is absent", () => {
    const p = lakesPreset();
    delete p.autoplaceControls.water;
    const r = elevationCtxFromPreset(p);
    expect(r.ctx.waterLevel).toBe(0); // 10*log2(1)
    expect(r.ctx.segmentationMultiplier).toBe(1);
  });

  it("guards a disabled (size 0) water control against -Infinity", () => {
    const p = lakesPreset();
    p.autoplaceControls.water = { frequency: 1, size: 0, richness: 1 };
    expect(elevationCtxFromPreset(p).ctx.waterLevel).toBe(0);
  });

  it("maps starting points, defaulting to a single origin spawn when empty", () => {
    const p = lakesPreset();
    p.startingPoints = [{ x: 12, y: -8 }];
    expect(elevationCtxFromPreset(p).ctx.startingPositions).toEqual([{ x: 12, y: -8 }]);
    p.startingPoints = [];
    expect(elevationCtxFromPreset(p).ctx.startingPositions).toEqual([{ x: 0, y: 0 }]);
  });

  it("defaults the climate fields (freq 1, bias 0, starting-area size/freq 1) when the pen is empty", () => {
    const r = elevationCtxFromPreset(lakesPreset());
    expect(r.ctx.moistureFrequency).toBe(1);
    expect(r.ctx.moistureBias).toBe(0);
    expect(r.ctx.auxFrequency).toBe(1);
    expect(r.ctx.auxBias).toBe(0);
    expect(r.ctx.startingAreaMoistureSize).toBe(1);
    expect(r.ctx.startingAreaMoistureFrequency).toBe(1);
  });

  it("exposes per-resource control levers, defaulting absent resources to 1/1/1", () => {
    const p = lakesPreset();
    p.autoplaceControls["iron-ore"] = { frequency: 2, size: 0.5, richness: 3 };
    const r = elevationCtxFromPreset(p);
    expect(r.resourceControls["iron-ore"]).toEqual({ frequency: 2, size: 0.5, richness: 3 });
    expect(r.resourceControls.coal).toEqual({ frequency: 1, size: 1, richness: 1 });
  });

  it("reads enemy-base frequency/size, defaulting to 1/1 when absent", () => {
    const p = lakesPreset();
    delete p.autoplaceControls["enemy-base"];
    expect(elevationCtxFromPreset(p).enemyControls).toEqual({ frequency: 1, size: 1 });

    p.autoplaceControls["enemy-base"] = { frequency: 2, size: 0.5, richness: 1 };
    expect(elevationCtxFromPreset(p).enemyControls).toEqual({ frequency: 2, size: 0.5 });
  });

  it("reads nauvis_cliff frequency/size->continuity, defaulting to 1/1 when absent", () => {
    const p = lakesPreset();
    delete p.autoplaceControls["nauvis_cliff"];
    expect(elevationCtxFromPreset(p).cliffControls).toEqual({ frequency: 1, continuity: 1 });

    p.autoplaceControls["nauvis_cliff"] = { frequency: 2, size: 0.5, richness: 1 };
    expect(elevationCtxFromPreset(p).cliffControls).toEqual({ frequency: 2, continuity: 0.5 });
  });

  it("reads trees frequency/size, defaulting to 1/1 when absent", () => {
    const p = lakesPreset();
    delete p.autoplaceControls.trees;
    expect(elevationCtxFromPreset(p).treeControls).toEqual({ frequency: 1, size: 1 });

    p.autoplaceControls.trees = { frequency: 3, size: 2, richness: 1 };
    expect(elevationCtxFromPreset(p).treeControls).toEqual({ frequency: 3, size: 2 });
  });

  it("reads vulcanus_volcanism frequency/size, defaulting to 1/1 when absent", () => {
    const p = lakesPreset();
    delete p.autoplaceControls.vulcanus_volcanism;
    expect(elevationCtxFromPreset(p).vulcanusVolcanismControls).toEqual({ frequency: 1, size: 1 });

    p.autoplaceControls.vulcanus_volcanism = { frequency: 2, size: 3, richness: 1 };
    expect(elevationCtxFromPreset(p).vulcanusVolcanismControls).toEqual({ frequency: 2, size: 3 });
  });

  it("exposes cliffSettings from preset.cliffSettings", () => {
    const p = lakesPreset();
    // A COMPLETE CliffSettings - name/control/cliffSmoothing carry the Default
    // preset's real wire values. The assertion below then also proves the ctx
    // narrows to the three render-relevant fields and drops these three, which
    // a partial object could not express (it did not satisfy the type at all).
    p.cliffSettings = {
      name: "cliff",
      control: "",
      cliffSmoothing: 0,
      cliffElevation0: 12,
      cliffElevationInterval: 30,
      richness: 2,
    };
    expect(elevationCtxFromPreset(p).cliffSettings).toEqual({
      cliffElevation0: 12,
      cliffElevationInterval: 30,
      richness: 2,
    });
  });

  it("reads control:aux/moisture/starting_area_moisture:* off the preset's property_expression_names", () => {
    const p = lakesPreset();
    p.propertyExpressionNames["control:aux:frequency"] = "4.000000";
    p.propertyExpressionNames["control:aux:bias"] = "-0.300000";
    p.propertyExpressionNames["control:moisture:frequency"] = "0.500000";
    p.propertyExpressionNames["control:moisture:bias"] = "0.450000";
    p.propertyExpressionNames["control:starting_area_moisture:size"] = "2.000000";
    p.propertyExpressionNames["control:starting_area_moisture:frequency"] = "3.000000";

    const r = elevationCtxFromPreset(p);
    expect(r.ctx.auxFrequency).toBe(4);
    expect(r.ctx.auxBias).toBeCloseTo(-0.3, 6);
    expect(r.ctx.moistureFrequency).toBe(0.5);
    expect(r.ctx.moistureBias).toBeCloseTo(0.45, 6);
    expect(r.ctx.startingAreaMoistureSize).toBe(2);
    expect(r.ctx.startingAreaMoistureFrequency).toBe(3);
  });

  // The app has no UI for control:temperature:*, so the only way it ever gets a
  // non-default value is an imported exchange string. Nothing consumed
  // `temperature` before the trees overlay, so these were parsed and dropped.
  it("reads control:temperature:* off the preset's property_expression_names", () => {
    const p = lakesPreset();
    p.propertyExpressionNames["control:temperature:frequency"] = "2.000000";
    p.propertyExpressionNames["control:temperature:bias"] = "-0.250000";

    const r = elevationCtxFromPreset(p);
    expect(r.ctx.temperatureFrequency).toBe(2);
    expect(r.ctx.temperatureBias).toBeCloseTo(-0.25, 6);
  });

  it("defaults control:temperature:* to the game's 1 / 0 when absent", () => {
    const r = elevationCtxFromPreset(lakesPreset());
    expect(r.ctx.temperatureFrequency).toBe(1);
    expect(r.ctx.temperatureBias).toBe(0);
  });
});
