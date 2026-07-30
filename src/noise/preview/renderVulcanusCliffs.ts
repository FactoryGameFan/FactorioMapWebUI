/**
 * Composite the Vulcanus cliff footprint onto a terrain ImageData. Mirrors
 * renderCliffs (Nauvis), reusing the same placement geometry and the same
 * `CLIFF_MAP_COLOR` mark - `cliff-vulcanus` declares
 * `map_color = {144, 119, 87}` in `space-age/prototypes/entity/entities.lua`,
 * byte-identical to Nauvis's `cliff`, so no second colour is needed.
 *
 * Two differences from the Nauvis renderer:
 *
 * - **Lava exclusion happens at PLACEMENT, not at paint time.** Nauvis skips
 *   water-coloured pixels as it paints; here the cells never exist. That is not
 *   a stylistic choice - `tryToAddCliff` runs a real collision test and drops
 *   the entity, so a paint-time skip would leave the cell in `placedCells` and
 *   the specs that score against `find_entities_filtered` would still count it.
 *
 *   **This comment used to say the opposite** ("Lava plays that visual role but
 *   is not a water tile, and the game does not exclude cliffs from it here"),
 *   which was wrong in both halves: `tile_collision_masks.lava()` sets
 *   `water_tile = true`, which IS a layer the cliff's own mask holds, and the
 *   game excludes cliffs from lava for exactly that reason (issue #18).
 * - **No levers.** Vulcanus has no cliff autoplace control, so there is nothing
 *   to disable the pass and nothing to rescale the interval; the bands are the
 *   planet constants from `vulcanusCliffFields.ts`.
 */
import type { EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { makeCliffPlacementFromFields } from "../cliffs/cliffPlacement";
import {
  VULCANUS_CLIFF_ELEVATION_0,
  VULCANUS_CLIFF_ELEVATION_INTERVAL,
  VULCANUS_CLIFF_SMOOTHING,
  makeVulcanusCliffFields,
} from "../cliffs/vulcanusCliffFields";
import { paintCliffCells } from "./renderCliffs";
import {
  type VulcanusStack,
  makeVulcanusTileResolver,
  makeVulcanusTileResolverFrom,
} from "../tiles/vulcanusCatalog";

/**
 * The Vulcanus tiles whose `CollisionMask` shares a layer with the cliff's, so a
 * cliff whose collision box touches one is never placed.
 *
 * `tile_collision_masks.lava()` sets `water_tile = true` and the cliff mask
 * holds `water_tile`; no other Vulcanus tile does. Notably
 * `volcanic-jagged-ground` - the tile the ore patches paint, which the Lua
 * itself labels "CLIFF TILE" - is `tile_collision_masks.ground()`, which the
 * cliff mask does not touch, so ore does NOT exclude cliffs. That distinction is
 * the whole reason the earlier ore-separation work correctly found no exclusion
 * rule while this one exists.
 */
export const VULCANUS_CLIFF_BLOCKING_TILES: ReadonlySet<string> = new Set(["lava", "lava-hot"]);

export interface RenderVulcanusCliffsOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params (notably `startingPositions`). */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
  /**
   * World box to enumerate placed cliff cells over. Defaults to the pixel grid's
   * own world box. The tiled renderer widens this so a cell centered just
   * outside a tile still paints the part of its mark that falls inside - see
   * renderCliffs' identical option for the full rationale.
   */
  readonly cellQueryBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
  /**
   * The composite's one `VulcanusStack`, as `renderVulcanusRocks` takes it. The
   * lava rejection needs a tile resolver, and building a private one here would
   * duplicate the whole field DAG - `memoXY` is single-entry, so separate copies
   * share nothing at all.
   */
  readonly sharedStack?: VulcanusStack;
}

export function renderVulcanusCliffs(base: ImageData, opts: RenderVulcanusCliffsOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ctx = withCtxDefaults({ seed0: opts.seed0, ...opts.ctx });
  const shared = opts.sharedStack;
  // As in `makeVulcanusRockPlacement`: derived from the ported tile resolver,
  // NOT from rendered pixel colours. The collision box reaches tiles outside the
  // render window, so reading back the ImageData would make the answer depend on
  // the window and break tiled equality.
  const tileAt =
    shared === undefined ? makeVulcanusTileResolver(ctx) : makeVulcanusTileResolverFrom(shared);
  const placement = makeCliffPlacementFromFields(makeVulcanusCliffFields(ctx, shared), {
    elevation0: VULCANUS_CLIFF_ELEVATION_0,
    interval: VULCANUS_CLIFF_ELEVATION_INTERVAL,
    smoothing: VULCANUS_CLIFF_SMOOTHING,
    tileCollides: (x, y) => VULCANUS_CLIFF_BLOCKING_TILES.has(tileAt(x, y).name),
  });

  const box = opts.cellQueryBox ?? {
    x0: originX,
    y0: originY,
    x1: originX + width * tpp,
    y1: originY + height * tpp,
  };

  paintCliffCells(base, placement.placedCells(box.x0, box.y0, box.x1, box.y1), {
    originX,
    originY,
    tilesPerPixel: tpp,
  });
}
