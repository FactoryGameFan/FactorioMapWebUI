/**
 * Reads the per-resource `control:<res>:frequency|size|richness` levers from a
 * preset's `autoplaceControls` dict (resource autoplace controls are keyed by the
 * resource/entity name, e.g. "iron-ore"), applying the game's defaults (1/1/1) for
 * any resource the preset does not carry.
 *
 * Mirror of `readClimateControls` for the resource overlay; feeds
 * `makeResourceResolver`'s `controls` map. See M3a plan T6.
 */
import type { AutoplaceSetting } from "./types";
import type { VulcanusResourceControls, VulcanusResourceLevers } from "../noise/eval/ctx";
import type { ResourceControlLevers } from "../noise/resources/resourceCatalog";
import { RESOURCE_CATALOG } from "../noise/resources/resourceCatalog";

const DEFAULT_LEVERS: ResourceControlLevers = { frequency: 1, size: 1, richness: 1 };

export function readResourceControls(preset: {
  autoplaceControls: Record<string, AutoplaceSetting>;
}): Record<string, ResourceControlLevers> {
  const out: Record<string, ResourceControlLevers> = {};
  for (const params of RESOURCE_CATALOG) {
    const c = preset.autoplaceControls[params.controlName];
    out[params.controlName] = c
      ? { frequency: c.frequency, size: c.size, richness: c.richness }
      : DEFAULT_LEVERS;
  }
  return out;
}

/**
 * The four Vulcanus resource autoplace controls, read off the same
 * `autoplaceControls` dict (keys are the game's control names), defaulting to the
 * neutral 1/1. Richness is not read - V2 renders placement, not yield.
 */
export function readVulcanusResourceControls(preset: {
  autoplaceControls: Record<string, AutoplaceSetting>;
}): VulcanusResourceControls {
  const read = (name: string): VulcanusResourceLevers => {
    const c = preset.autoplaceControls[name];
    return c ? { frequency: c.frequency, size: c.size } : { frequency: 1, size: 1 };
  };
  return {
    tungstenOre: read("tungsten_ore"),
    vulcanusCoal: read("vulcanus_coal"),
    calcite: read("calcite"),
    sulfuricAcidGeyser: read("sulfuric_acid_geyser"),
  };
}
