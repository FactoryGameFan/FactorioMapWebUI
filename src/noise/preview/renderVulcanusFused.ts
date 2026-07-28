/**
 * PROTOTYPE (issue #19 follow-up, not the shipped path): the Vulcanus `all`
 * composite with terrain and the thresholded-ore pass fused into a single pixel
 * loop over a single shared field stack.
 *
 * ## Why fusing is the only way sharing pays
 *
 * `memoXY` is a SINGLE-ENTRY cache - it holds the last `(x, y)` only. So merely
 * handing two consumers the same field objects saves nothing if they walk the
 * image in separate loops: by the time the ore pass reaches pixel P, the cache
 * holds whatever terrain computed last. The two have to ask for the same
 * `(x, y)` back to back. Measured on the current path, terrain + the three
 * overlay marginals sum to EXACTLY the `all` cost (96,310,857 basisNoise calls
 * either way), i.e. today the passes share nothing whatsoever.
 *
 * Fused, the ore regions are close to free: biome fields alone cost 42.0
 * basisNoise/px, the ore regions on their own stack cost 44.1/px, and the two
 * fused cost 44.1/px - so ~42/px, 48.8% of that pair, is pure duplication.
 *
 * ## What this does NOT reach
 *
 * The rock overlay's cost is spent inside `resolveChunk`, which sweeps all 1024
 * tiles of a chunk in reverse index order - a chunk-major traversal that no
 * pixel loop can line up with. Its ~76/px of duplicated biome/climate work is
 * therefore out of reach here and needs a cache that survives across
 * traversals. Fusion alone is estimated to land the `all/terrain` ratio near
 * 2.19, short of the 2x gate.
 *
 * ## Paint order is preserved exactly
 *
 * The shipped order is terrain -> geyser marks (3x3) -> thresholded ore (1x1,
 * over the top) -> rocks -> cliffs, and marks write to neighbouring pixels, so
 * the order is observable. This keeps it by recording the ore decision per
 * pixel during the fused loop and painting it in its original slot, rather than
 * painting ore as it is decided.
 */
import type { EvalCtxInput } from "../eval/ctx";
import {
  type VulcanusStack,
  makeVulcanusStack,
  makeVulcanusTileResolverFrom,
} from "../tiles/vulcanusCatalog";
import { VULCANUS_RESOURCE_CATALOG } from "../resources/vulcanusResourceCatalog";

/** Matches `renderVulcanusResources`'s `PROBABILITY_THRESHOLD`. */
const PROBABILITY_THRESHOLD = 0.5;

export interface FusedTerrainOreResult {
  image: ImageData;
  /** The shared stack, so the caller's later passes can reuse it. */
  stack: VulcanusStack;
  /** Paints the recorded ore decisions. Call in the shipped order slot. */
  paintOre: () => void;
}

/**
 * Renders Vulcanus terrain and decides the thresholded ore pass in ONE loop
 * over ONE stack. Returns the image plus a deferred `paintOre` so the caller
 * can run the geyser pass in between, exactly as the sequential path does.
 */
export function renderVulcanusTerrainOreFused(opts: {
  seed0: number;
  width: number;
  height: number;
  originX?: number;
  originY?: number;
  tilesPerPixel?: number;
  ctx?: Omit<EvalCtxInput, "seed0">;
  /** Wrap the nodes the rock overlay shares with terrain in a cross-traversal cache. */
  cacheShared?: boolean;
}): FusedTerrainOreResult {
  const { width, height, seed0 } = opts;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const stack = makeVulcanusStack({ seed0, ...opts.ctx }, { cacheShared: opts.cacheShared });
  const resolve = makeVulcanusTileResolverFrom(stack);

  const controls = stack.ctx.vulcanusResourceControls;
  const active = VULCANUS_RESOURCE_CATALOG.filter((p) => p.levers(controls).size > 0);
  const thresholded = active
    .filter((p) => p.placement === "threshold")
    .map((params) => ({ params, region: params.region(stack.resources) }));

  const data = new Uint8ClampedArray(width * height * 4);
  // -1 = no ore at this pixel; otherwise an index into `thresholded`.
  const ore = new Int8Array(width * height).fill(-1);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;

      // Terrain first. This call warms every shared node at (wx, wy).
      const color = resolve(wx, wy).color;
      const o = (py * width + px) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;

      // ...and the ore regions read those same warm nodes, at the same (x, y),
      // before the loop moves on. That adjacency is the whole optimisation.
      for (let i = 0; i < thresholded.length; i++) {
        if (1000 * thresholded[i].region(wx, wy) < PROBABILITY_THRESHOLD) continue;
        ore[py * width + px] = i; // first in catalog order wins
        break;
      }
    }
  }

  const image = new ImageData(data, width, height);
  const paintOre = (): void => {
    if (thresholded.length === 0) return;
    for (let i = 0; i < width * height; i++) {
      const idx = ore[i];
      if (idx < 0) continue;
      const c = thresholded[idx].params.mapColor;
      const o = i * 4;
      image.data[o] = c[0];
      image.data[o + 1] = c[1];
      image.data[o + 2] = c[2];
      image.data[o + 3] = 255;
    }
  };

  return { image, stack, paintOre };
}
