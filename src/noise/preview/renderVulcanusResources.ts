/**
 * Composite the Vulcanus ore overlay onto a terrain ImageData: sweep the same
 * pixel grid as renderVulcanusTerrain and paint each entry's `map_color`
 * opaque where it wins. Mutates `base` in place. Mirrors renderResources
 * (Nauvis).
 *
 * **Two placement modes, because Vulcanus has two kinds of resource.** The
 * catalog's `placement` field picks per entry (`vulcanusResourceCatalog.ts`):
 *
 * - The three solid ores THRESHOLD. Their probability is
 *
 *     probability = (control:<x>:size > 0) * 1000 * ((1 + region) * rp - 1)
 *                 = (size > 0) * 1000 * region                 [rp -> 1]
 *
 *   which saturates to ~1 inside a patch and 0 outside, so `probability >= 0.5`
 *   (i.e. `region >= 0.0005`) is the patch boundary. Same threshold convention
 *   renderResources uses. Writing it as the game's probability rather than a
 *   bare `region > 0` keeps the `size = 0` disable case and the
 *   `random_penalty -> 1` substitution visible at the call site.
 * - The sulfuric-acid geyser ROLLS. Its probability peaks below 0.09 anywhere on
 *   the map, so there is no threshold that yields a footprint - a geyser is an
 *   individual entity the game rolls for per tile. See
 *   `makeVulcanusGeyserPlacement`.
 *
 * **No water exclusion**, unlike the Nauvis renderer: Vulcanus has no water
 * tile, and ore exclusion is expressed through the biome favorabilities rather
 * than a tile test. The geyser's roll does carry a lava tile gate, which is a
 * different mechanism (a collision mask, not a favorability) - see below.
 *
 * **Paint order: geyser marks first, then the three thresholded ores over the
 * top.** The catalog's module comment explains why a solid ore must win a
 * shared pixel (the game arbitrates by max probability, and calcite saturates to
 * ~1 against the geyser's <0.09). Painting the ores last reproduces that without
 * a colour test: any geyser pixel an ore also claims is simply overwritten. It
 * also keeps the ore pass a per-pixel pure function of world position, which is
 * what `test/tiledEquality.spec.ts` needs.
 */
import type { EvalCtx, EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { makeVulcanusBiomes } from "../expressions/vulcanusBiomes";
import { makeVulcanusCracks } from "../expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../expressions/vulcanusHelpers";
import { makeVulcanusResources } from "../expressions/vulcanusResources";
import type { VulcanusResources } from "../expressions/vulcanusResources";
import { makeVulcanusSpawn } from "../expressions/vulcanusSpawn";
import {
  PLACEMENT_MARK_RADIUS_PX,
  PLACEMENT_SALT,
  makePlacementSet,
} from "../placement/placementRoll";
import type { PlacementCollisionBox } from "../placement/placementRoll";
import {
  RESOURCE_PROBABILITY_THRESHOLD,
  VULCANUS_RESOURCE_CATALOG,
  sulfuricAcidGeyserProbability,
} from "../resources/vulcanusResourceCatalog";
import {
  type VulcanusStack,
  makeVulcanusTileResolver,
  makeVulcanusTileResolverFrom,
} from "../tiles/vulcanusCatalog";
import { paintMark } from "./renderCliffs";

/**
 * The overlay's placement threshold: probability >= 0.5 (see the module
 * comment). Defined in `vulcanusResourceCatalog.ts` because the cliff overlay's
 * ore rejection asks the same question - see `RESOURCE_PROBABILITY_THRESHOLD`.
 */
const PROBABILITY_THRESHOLD = RESOURCE_PROBABILITY_THRESHOLD;

/**
 * The two Vulcanus tiles no geyser may sit on.
 *
 * **Derived from the collision mask, not from a `tile_restriction`.** The geyser
 * prototype declares none (`space-age/prototypes/entity/resources.lua:137-190`,
 * 2.1.12) - that field only appears there inside the shared
 * `resource_autoplace` helper, which this literal prototype does not use. What
 * gates it instead is `type = "resource"`, whose default collision mask is
 * `{layers = {resource = true}}` (`core/lualib/collision-mask-defaults.lua:187`),
 * against the tiles' own masks: on Vulcanus exactly `lava` and `lava-hot` use
 * `tile_collision_masks.lava()`, which lists `resource = true`
 * (`base/prototypes/tile/tile-collision-masks.lua:65`,
 * `space-age/prototypes/tile/tiles-vulcanus.lua:417`, `:459`). Every other
 * Vulcanus tile uses `ground()`, which does not.
 *
 * So the forbidden set coincides with the rock overlay's
 * (`renderVulcanusRocks.ts`) while being reached by a completely different
 * route, and the geyser is a single prototype, so the "all prototypes sharing
 * the overlay must share one `tileAllowed`" precondition in `resolveChunk`'s
 * doc comment is trivially met.
 *
 * **This gate rejects nothing in the one oracle region that has geysers**, which
 * is worth stating so nobody reads its 0 as evidence it is inert: over a
 * +/-2000-tile sample at seed 123456, 426 of 5627 tiles with a positive geyser
 * probability are lava, and the gate rejects 12 of 195 roll hits (~6%). Oracle
 * region 4 simply has no lava where its sulfur is.
 */
const GEYSER_FORBIDDEN_TILES = new Set(["lava", "lava-hot"]);

/**
 * The geyser's `collision_box`, 2.8 x 2.8 tiles
 * (`space-age/prototypes/entity/resources.lua:182`: `{{-1.4,-1.4},{1.4,1.4}}`).
 *
 * **Checked for `map_generator_bounding_box` rather than assumed.** That field
 * overrides the collision box during map generation and cost Task 6 87-132
 * points when it was missed; a grep across `base/`, `core/` and `space-age/` at
 * 2.1.12 returns 8 declarations - the two spawners, the four worms, the base
 * Nauvis tree family and `gleba-spawner-small` - and **no resource**. So the
 * collision box really is the map-gen box here.
 *
 * **There is no argmax box question at all.** The three previous roll overlays
 * each answered it differently (an ordering theorem on Vulcanus rocks, a lattice
 * collapse on Nauvis rocks, identical boxes on the spawners). The geyser is a
 * single prototype with a single box, so the question does not arise.
 */
const GEYSER_COLLISION_BOX: PlacementCollisionBox = { w: 2.8, h: 2.8 };

/**
 * Build the Vulcanus resource field stack `renderVulcanusResources` sweeps.
 *
 * Exported because the cliff overlay needs the same stack for its ore rejection
 * when it runs standalone (with a shared `VulcanusStack` it takes
 * `stack.resources` instead). Assembling the sub-DAG by hand in a second place
 * is precisely the duplication that lets two callers drift onto different
 * fields.
 */
export function buildResources(ctx: EvalCtx): VulcanusResources {
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  return makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);
}

/**
 * The geyser placement predicate over an ALREADY-BUILT resource stack.
 *
 * Exported (unlike the ctx-only `makeVulcanusGeyserPlacement` below) so the
 * cliff overlay's ore rejection can reuse the composite's one `VulcanusStack`
 * instead of building a second field DAG: `memoXY` is single-entry, so a private
 * copy would share nothing and pay for the whole tree again.
 */
export function geyserPlacementFrom(
  ctx: EvalCtx,
  resources: VulcanusResources,
  stack?: VulcanusStack,
): (x: number, y: number) => boolean {
  // Derived from the ported tile resolver, NOT from rendered pixel colours: the
  // chunk resolver asks about tiles outside the render window, and reading the
  // ImageData would make the answer window-dependent.
  const tileAt =
    stack === undefined ? makeVulcanusTileResolver(ctx) : makeVulcanusTileResolverFrom(stack);
  return makePlacementSet({
    salt: PLACEMENT_SALT.vulcanusGeyser,
    probability: sulfuricAcidGeyserProbability(resources),
    tileAllowed: (x, y) => !GEYSER_FORBIDDEN_TILES.has(tileAt(x, y).name),
    collisionBox: () => GEYSER_COLLISION_BOX,
  });
}

/**
 * The shipped sulfuric-acid-geyser placement predicate: the roll against
 * `sulfuricAcidGeyserProbability`, gated by the lava tile restriction and by
 * collision against geysers already placed in the same chunk. Exported so
 * `test/entityDensity.spec.ts` measures the exact predicate the renderer paints.
 *
 * ## The prototype data, from source (2.1.12)
 *
 * | | sulfuric-acid-geyser |
 * | --- | --- |
 * | type | `resource` |
 * | autoplace order | `c` (every other resource is `b`) |
 * | probability | `vulcanus_sulfuric_acid_geyser_probability`, no `random_penalty` |
 * | collision_box | 2.8 x 2.8 |
 * | map_generator_bounding_box | **not declared** - so the collision box is the map-gen box |
 * | tile_restriction | none - the lava gate comes from the collision MASK |
 * | collision_mask | `resource` layer only (the `type = "resource"` default) |
 *
 * ## Measured, against `test/fixtures/oracle-entity-counts.seed123456.json`
 *
 * Factorio 2.1.12, seed 123456. **Only oracle region 4 has a usable
 * denominator**: regions 2 `[0,0]` and 3 `[4096,4096]` contain no sulfur at all
 * (the probability is <= 0 at every one of their 262144 tiles), so the game has
 * 0 geysers there and so does this model. Region 4 `[-256,-256]` has 56.
 *
 * | variant | region 4 (game 56) |
 * | --- | --- |
 * | bare roll, no gates | 81 (44.6%) |
 * | + lava tile restriction only | 81 (44.6%) |
 * | + collision only | 56 (0.0%) |
 * | **+ both gates (shipped)** | **56 (0.0%)** |
 *
 * Collision does all of the work here and the tile restriction none - see
 * `GEYSER_FORBIDDEN_TILES` for why that 0 is a property of this window rather
 * than of the gate.
 *
 * **Do not read the exact 56 as precision.** n = 56 is a small denominator
 * (Poisson sigma ~7.5, i.e. 13%) and the salt is arbitrary. Re-running region 4
 * over eight salts gives **46-63** placements (rel 0.036-0.179), mean 55.3
 * against the game's 56 - so the MODEL is unbiased and the exact hit is one
 * draw from that spread. `PLACEMENT_SALT.vulcanusGeyser` is fixed, so the test
 * is deterministic, but a salt change is a real ~+/-8 move.
 *
 * ## What is not modelled, and why the agreement may be luckier than it looks
 *
 * The geyser's autoplace `order = "c"` carries the game's own comment: *"Other
 * resources are 'b'; oil won't get placed if something else is already there."*
 * Under the sequential-group reading in `placement-roll-NOTES.md` that puts the
 * geyser LAST of every Vulcanus autoplacer - after rocks
 * (`a[landscape]-c[rock]-*`) and after the three solid ores (`b`) - so it is the
 * overlay most exposed to the cross-overlay occupancy Task 6 measured as the
 * dominant residual for enemy bases. Region 4 is also the spawn-centred window
 * where that effect concentrates. Nothing here models it; the model lands on the
 * game's count with it left out.
 */
export function makeVulcanusGeyserPlacement(ctx: EvalCtx): (x: number, y: number) => boolean {
  return geyserPlacementFrom(ctx, buildResources(ctx));
}

/**
 * The geyser probability the renderer rolls against, built from a bare ctx.
 * Exported so `test/entityDensity.spec.ts`'s ungated roll-vs-field-integral
 * check integrates the same field.
 */
export function makeVulcanusGeyserProbability(ctx: EvalCtx): (x: number, y: number) => number {
  return sulfuricAcidGeyserProbability(buildResources(ctx));
}

export interface RenderVulcanusResourcesOptions {
  /** Shared Vulcanus field stack - see `RenderVulcanusTerrainOptions.stack`. */
  stack?: VulcanusStack;
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params (notably `vulcanusResourceControls`, `startingPositions`). */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
  /**
   * World box to sweep for geyser roll hits. Defaults to this render's own pixel
   * box. The tiled renderer widens it by `PLACEMENT_MARK_RADIUS_PX` pixels'
   * worth of tiles (clamped to the full image) so a hit centred just outside
   * this tile still paints the part of its 3x3 mark that falls inside.
   * `paintMark` clips to the pixel grid, so a wider sweep can never paint
   * outside this tile's own bounds. The thresholded ores paint 1x1 and ignore
   * this.
   */
  readonly sweepBox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

export function renderVulcanusResources(
  base: ImageData,
  opts: RenderVulcanusResourcesOptions,
): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ctx = opts.stack?.ctx ?? withCtxDefaults({ seed0: opts.seed0, ...opts.ctx });
  const resources = opts.stack?.resources ?? buildResources(ctx);

  const controls = ctx.vulcanusResourceControls;
  const active = VULCANUS_RESOURCE_CATALOG.filter((p) => p.levers(controls).size > 0);
  if (active.length === 0) return;

  // Pass 1: the rolled entries, painted as 3x3 marks. Unlike rocks (1x1, "a
  // block would merge scattered rocks into a blob"), a geyser is a 2.8 x 2.8
  // entity placed roughly once per 3000 tiles, so a single pixel disappears -
  // the same reasoning enemy bases use for the same mark.
  for (const params of active) {
    if (params.placement !== "roll") continue;
    const placed = geyserPlacementFrom(ctx, resources, opts.stack);
    const box = opts.sweepBox;
    const pxStart = box ? Math.round((box.x0 - originX) / tpp) : 0;
    const pxEnd = box ? Math.round((box.x1 - originX) / tpp) : width;
    const pyStart = box ? Math.round((box.y0 - originY) / tpp) : 0;
    const pyEnd = box ? Math.round((box.y1 - originY) / tpp) : height;
    for (let py = pyStart; py < pyEnd; py++) {
      const wy = originY + py * tpp;
      for (let px = pxStart; px < pxEnd; px++) {
        const wx = originX + px * tpp;
        if (!placed(wx, wy)) continue;
        paintMark(base, px, py, params.mapColor, PLACEMENT_MARK_RADIUS_PX);
      }
    }
  }

  // Pass 2: the thresholded ores, over the top - see the module comment on paint
  // order. First in catalog order wins a pixel.
  const thresholded = active
    .filter((p) => p.placement === "threshold")
    .map((params) => ({ params, region: params.region(resources) }));
  if (thresholded.length === 0) return;

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      for (const r of thresholded) {
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
