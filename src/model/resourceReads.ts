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
import type { AquiloResourceControls, GlebaControls } from "../noise/wasm/request";
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

/**
 * The three Aquilo resource autoplace controls (`aquilo_crude_oil`,
 * `lithium_brine`, `fluorine_vent`). An absent control reads as the neutral
 * 1/1, never size 0: a preset imported from a Nauvis-era string carries none of
 * them, and size 0 would remove the wells and reshape the islands. A control
 * that IS present keeps whatever it holds, a size of 0 included.
 */
export function readAquiloResourceControls(preset: {
  autoplaceControls: Record<string, AutoplaceSetting>;
}): Required<AquiloResourceControls> {
  const read = (name: string) => {
    const c = preset.autoplaceControls[name];
    return c ? { frequency: c.frequency, size: c.size } : { frequency: 1, size: 1 };
  };
  return {
    crudeOil: read("aquilo_crude_oil"),
    lithiumBrine: read("lithium_brine"),
    fluorineVent: read("fluorine_vent"),
  };
}

/**
 * Gleba's levers: `gleba_water` frequency and size, `gleba_plants` frequency
 * (the plants noise the tile scores read) and size, and the `gleba_stone`,
 * `gleba_cliff` and `gleba_enemy_base` controls the entity views read. An
 * absent control reads as the neutral 1, as for Aquilo; a present one keeps
 * what it holds.
 */
export function readGlebaControls(preset: {
  autoplaceControls: Record<string, AutoplaceSetting>;
}): Required<GlebaControls> {
  const water = preset.autoplaceControls.gleba_water;
  const plants = preset.autoplaceControls.gleba_plants;
  const stone = preset.autoplaceControls.gleba_stone;
  const cliff = preset.autoplaceControls.gleba_cliff;
  const enemy = preset.autoplaceControls.gleba_enemy_base;
  return {
    waterFrequency: water ? water.frequency : 1,
    waterSize: water ? water.size : 1,
    plantsFrequency: plants ? plants.frequency : 1,
    stoneFrequency: stone ? stone.frequency : 1,
    stoneSize: stone ? stone.size : 1,
    stoneRichness: stone ? stone.richness : 1,
    plantsSize: plants ? plants.size : 1,
    cliffFrequency: cliff ? cliff.frequency : 1,
    cliffContinuity: cliff ? cliff.size : 1,
    enemyFrequency: enemy ? enemy.frequency : 1,
    enemySize: enemy ? enemy.size : 1,
  };
}
