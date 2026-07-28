/**
 * Composite the Vulcanus rock overlay onto a terrain ImageData: sweep the same
 * pixel grid as renderVulcanusTerrain, roll the game's per-tile placement draw
 * against the rock probability field, and paint a single `ROCK_MAP_COLOR`
 * pixel wherever it wins. Mutates `base` in place. Mirrors renderRocks
 * (Nauvis), including its choice of a 1x1 mark: "rocks are point-like, and a
 * block would merge scattered rocks into a blob" (renderRocks.ts) - unlike
 * enemy bases/geysers/oil (Tasks 6-8), which keep the 3x3
 * `PLACEMENT_MARK_RADIUS_PX` mark for legibility.
 *
 * All four Vulcanus rock entities declare `map_color = {129, 105, 78}`
 * (`space-age/prototypes/decorative/decoratives-vulcanus.lua`), identical to
 * Nauvis's rocks, so `ROCK_MAP_COLOR` is shared rather than duplicated.
 *
 * Two differences from the Nauvis renderer:
 *
 * - **No water exclusion.** Vulcanus has no water tile.
 * - **No levers.** Vulcanus deliberately omits the `rocks` autoplace control
 *   (see `vulcanusRockField.ts`), so there is no frequency or size to thread.
 *
 * This rolls rather than thresholds: it draws `makePlacementSet`'s per-tile
 * `U` and places where `U < density(x, y)` AND the tile-restriction and
 * collision gates pass. Positions are not tile-exact - there is no
 * cross-overlay arbitration against other autoplacers and no jitter draws
 * within the tile (see `placementRoll.ts`) - but density is the property under
 * test, and this is a faithful roll against it rather than a threshold on it.
 *
 * A 1x1 mark cannot straddle a tile seam, so - unlike cliffs
 * (`renderCliffs.ts`) - this needs no halo-widened sweep box: sweeping exactly
 * this render's own pixel box already reproduces the untiled render tile for
 * tile (see `tiledEquality.spec.ts`'s Vulcanus rocks/all cases). The collision
 * gate does not change that: it is resolved a whole chunk at a time,
 * independent of the render window (see `makePlacementSet`).
 */
import type { EvalCtx, EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { PLACEMENT_SALT, makePlacementSet } from "../placement/placementRoll";
import type { PlacementCollisionBox } from "../placement/placementRoll";
import { ROCK_FIELD_LATTICE, ROCK_MAP_COLOR, latticeSnapped } from "../rocks/rockCatalog";
import { makeVulcanusRockFields } from "../rocks/vulcanusRockField";
import { makeVulcanusTileResolver } from "../tiles/vulcanusCatalog";

export interface RenderVulcanusRocksOptions {
  readonly seed0: number;
  /** World tile at the top-left pixel. Default (0, 0). */
  readonly originX?: number;
  readonly originY?: number;
  /** World tiles per pixel. Default 1. */
  readonly tilesPerPixel?: number;
  /** Non-seed resolver params (notably `startingPositions`). */
  readonly ctx?: Omit<EvalCtxInput, "seed0">;
}

/**
 * The two Vulcanus tiles no rock may sit on. All four rock prototypes restrict
 * to `vulcanus_tiles_cold` / `vulcanus_tiles_hot`
 * (`space-age/prototypes/decorative/decoratives-vulcanus.lua:37-60`), and the
 * union of those two lists is every Vulcanus tile EXCEPT these.
 */
const ROCK_FORBIDDEN_TILES = new Set(["lava", "lava-hot"]);

/**
 * `huge-volcanic-rock`'s collision box, 3 x 2.2 tiles.
 *
 * **Why the huge box everywhere, and not the box of whichever prototype wins the
 * tile.** The obvious rule - `density` is `max(rockHuge, rockBig)`, so use the box
 * of the argmax - is degenerate. `rockBig >= rockHuge` is a theorem, not a seed
 * accident: the caps satisfy `0.2*(1 - 0.5a) >= 0.2*(1 - 0.75a)` for all
 * `a = vulcanus_ashlands_biome` in `[0, 1]`, and the sloped branches satisfy
 * `-1.0 + T > -1.2 + T` unconditionally, so the `min` of each pair is `>=` too.
 * Measured `hugeWinShare = 0.0000` over all three oracle regions, with 16-19% exact
 * ties where both caps bind at `a = 0`. So an argmax rule picks the small 1.5 x 1.5
 * box everywhere. Measured relative error against the game
 * (`test/fixtures/oracle-entity-counts.seed123456.json`, regions 2/3/4):
 *
 * | box rule | region 2 | region 3 | region 4 |
 * | --- | --- | --- | --- |
 * | argmax (`>`), i.e. big everywhere | 23.5% | 27.1% | 13.1% |
 * | argmax with ties to huge | 18.6% | 22.3% | 10.2% |
 * | **huge everywhere** | **0.2%** | **0.6%** | **7.5%** |
 *
 * The game's own population is ~28% huge (region 2: 320 huge, 813 big), which the
 * max-probability arbitration this port models cannot produce at all - it predicts
 * 0% huge. So the tile-level huge/big identity is known WRONG here, not merely
 * unvalidated; the claim this overlay makes is density, not identity. The
 * falsification and a candidate mechanism (per-group arbitration, huge sorting
 * first by autoplace order) are written up in `placement-roll-NOTES.md`.
 *
 * **What the measurement does and does not settle about the box.** It is not a
 * derivation - the exclusion radius was CHOSEN by comparing two candidates. What
 * the counts support is that the game sits BETWEEN the two models, close to the
 * huge end:
 *
 * | region | all-huge (shipped) | game | all-big | game - all-huge |
 * | --- | --- | --- | --- | --- |
 * | 2 | 1131 | 1133 | 1399 | +2 (+0.2%) |
 * | 3 | 1359 | 1367 | 1738 | +8 (+0.6%) |
 * | 4 | 1341 | 1450 | 1640 | +109 (+7.5%) |
 *
 * The all-huge model **under**-counts in all three regions, and the all-big model
 * overshoots by 13-27%. So the game's effective exclusion is *at most* huge-sized -
 * slightly weaker than uniform-huge, nowhere near as weak as uniform-big. Task 4's
 * "the truth sits between the two boxes" reading is the correct one and holds in
 * every region.
 *
 * That residual points the same way as the open anomaly above rather than away from
 * it: a population that is ~28% huge and ~72% big would place *more* rocks than a
 * uniform-huge model, because the big rocks' smaller boxes let neighbours in - which
 * is exactly the direction and rough magnitude of the shortfall. Stated as
 * consistency, NOT as evidence: this overlay does not model the mixed population,
 * and several unmodelled things push the same way (the game also arbitrates against
 * ~1500 other entities per region, and collision is not modelled across chunk
 * boundaries).
 *
 * Region 4's much larger 7.5% residual is worth a caveat rather than a conclusion.
 * It is the densest of the three (1450 rocks vs 1133 and 1367) and the residual is
 * monotone in that ordering, which is what a mixed population would predict - but a
 * 28% density increase against a 40x residual increase is nowhere near proportional,
 * so density alone does not explain it. Region 4 is also the spawn-centred window
 * and the only one with geysers (56), so unmodelled cross-overlay arbitration
 * concentrates there too.
 *
 * Both candidate boxes are real prototype data; measurement chose between them, and
 * a different mechanism could reproduce the same totals.
 */
const VOLCANIC_ROCK_COLLISION_BOX: PlacementCollisionBox = { w: 3, h: 2.2 };

/**
 * The shipped Vulcanus rock placement predicate: the roll against `density`,
 * gated by tile restriction and collision. Exported so `entityDensity.spec.ts`
 * measures the exact predicate the renderer paints, not a re-derivation of it.
 */
export function makeVulcanusRockPlacement(ctx: EvalCtx): (x: number, y: number) => boolean {
  const { density } = makeVulcanusRockFields(ctx);
  // Derived from the ported tile resolver, NOT from rendered pixel colours: the
  // chunk resolver asks about tiles outside the render window, and reading the
  // ImageData would make the answer window-dependent.
  const tileAt = makeVulcanusTileResolver(ctx);
  return makePlacementSet({
    salt: PLACEMENT_SALT.vulcanusRocks,
    // Snapped to `ROCK_FIELD_LATTICE`, which ships at 1 (a no-op that returns
    // `density` itself). The wrapper stays so the lattice is a one-constant
    // experiment rather than a rewrite - see `rockCatalog.ts`.
    probability: latticeSnapped(density, ROCK_FIELD_LATTICE),
    tileAllowed: (x, y) => !ROCK_FORBIDDEN_TILES.has(tileAt(x, y).name),
    collisionBox: () => VOLCANIC_ROCK_COLLISION_BOX,
  });
}

export function renderVulcanusRocks(base: ImageData, opts: RenderVulcanusRocksOptions): void {
  const { width, height } = base;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const tpp = opts.tilesPerPixel ?? 1;

  const ctx = withCtxDefaults({ seed0: opts.seed0, ...opts.ctx });
  const placed = makeVulcanusRockPlacement(ctx);

  for (let py = 0; py < height; py++) {
    const wy = originY + py * tpp;
    for (let px = 0; px < width; px++) {
      const wx = originX + px * tpp;
      if (!placed(wx, wy)) continue;
      const o = (py * width + px) * 4;
      base.data[o] = ROCK_MAP_COLOR[0];
      base.data[o + 1] = ROCK_MAP_COLOR[1];
      base.data[o + 2] = ROCK_MAP_COLOR[2];
      base.data[o + 3] = 255;
    }
  }
}
