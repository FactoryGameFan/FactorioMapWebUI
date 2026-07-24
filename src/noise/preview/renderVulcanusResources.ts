/**
 * Composite the Vulcanus ore overlay onto a terrain ImageData: sweep the same
 * pixel grid as renderVulcanusTerrain and, where a resource wins, paint its
 * `map_color` opaque. Mutates `base` in place. Mirrors renderResources (Nauvis).
 *
 * Two differences from the Nauvis renderer:
 *
 * - **No water exclusion.** Vulcanus has no water tile; lava plays that visual
 *   role but the game expresses ore exclusion through the biome favorabilities,
 *   not a tile test.
 * - Placement is written as the game's probability rather than a bare
 *   `region > 0`, so the `size = 0` disable case and the `random_penalty -> 1`
 *   substitution stay visible at the call site:
 *
 *     probability = (control:<x>:size > 0) * 1000 * ((1 + region) * rp - 1)
 *                 = (size > 0) * 1000 * region                 [rp -> 1]
 *
 *   and the overlay draws where `probability >= 0.5`, i.e. `region >= 0.0005` -
 *   the same threshold convention renderResources uses.
 */
import type { EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { makeVulcanusBiomes } from "../expressions/vulcanusBiomes";
import { makeVulcanusCracks } from "../expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../expressions/vulcanusHelpers";
import { makeVulcanusResources } from "../expressions/vulcanusResources";
import { makeVulcanusSpawn } from "../expressions/vulcanusSpawn";
import { VULCANUS_RESOURCE_CATALOG } from "../resources/vulcanusResourceCatalog";

/** The overlay's placement threshold: probability >= 0.5 (see the module comment). */
const PROBABILITY_THRESHOLD = 0.5;

export interface RenderVulcanusResourcesOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params (notably `vulcanusResourceControls`, `startingPositions`). */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
}

export function renderVulcanusResources(
  base: ImageData,
  opts: RenderVulcanusResourcesOptions,
): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ctx = withCtxDefaults({ seed0: opts.seed0, ...opts.ctx });
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);

  const controls = ctx.vulcanusResourceControls;
  const active = VULCANUS_RESOURCE_CATALOG.map((params) => ({
    params,
    region: params.region(resources),
    enabled: params.levers(controls).size > 0,
  })).filter((r) => r.enabled);

  if (active.length === 0) return;

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      for (const r of active) {
        // probability = (size > 0) * 1000 * region (rp -> 1); draw at >= 0.5.
        const probability = 1000 * r.region(wx, wy);
        if (probability < PROBABILITY_THRESHOLD) continue;
        const o = (py * width + px) * 4;
        base.data[o] = r.params.mapColor[0];
        base.data[o + 1] = r.params.mapColor[1];
        base.data[o + 2] = r.params.mapColor[2];
        base.data[o + 3] = 255;
        break; // first in catalog order wins
      }
    }
  }
}
