/**
 * The Vulcanus rock placement-probability field.
 *
 * Vulcanus lists four rock ENTITIES in `planet_map_gen.vulcanus()`'s
 * `autoplace_settings.entity`: `huge-volcanic-rock`, `big-volcanic-rock` and
 * their `-hot` variants. Between them they use only **two** probability
 * expressions - the hot variants reuse the cold ones' - so the field is
 *
 *   density = clamp(max(vulcanus_rock_huge, vulcanus_rock_big), 0, 1)
 *
 * Per-tile arbitration is max probability
 * (`docs/noise/placement-roll-NOTES.md`), so taking the max is exact: it is the
 * probability the game rolls where a rock wins.
 *
 * From `space-age/prototypes/decorative/decoratives-vulcanus.lua:308-318`:
 *
 * ```
 * vulcanus_rock_huge = min(0.2 * (1 - 0.75 * vulcanus_ashlands_biome),
 *                          -1.2 + 1.2 * min(aux, -0.1 + 1.1 * moisture)
 *                               + vulcanus_rock_noise
 *                               + 0.5 * vulcanus_decorative_knockout)
 * vulcanus_rock_big  = min(0.2 * (1 - 0.5 * vulcanus_ashlands_biome),
 *                          -1.0 + <the same three terms>)
 * ```
 *
 * The file also defines `vulcanus_rock_medium/cluster/small/tiny`. Those are
 * **decoratives**, not entities - they appear in `autoplace_settings.decorative`
 * - and the game's map preview charts entities, not decoratives, so they are
 * deliberately not part of this field.
 *
 * **There is no `rocks` slider on Vulcanus.** The planet's `autoplace_controls`
 * list carries the entry commented out, with the reason in the source:
 * `--["rocks"] = {}, -- can't add the rocks control otherwise nauvis rocks spawn`
 * (`planet-map-gen.lua:43`). So unlike Nauvis's `makeRockDensity`, nothing here
 * takes a frequency or size lever - `vulcanus_rock_noise` even has its
 * `control:rocks:frequency` term commented out at its definition site.
 *
 * The overlay (`renderVulcanusRocks.ts`) no longer thresholds `density` - it
 * rolls the field through `makePlacementSet`
 * (`src/noise/placement/placementRoll.ts`), placing where the roll's per-tile
 * `U < density(x, y)` AND the game's two arbitration gates pass: the rocks'
 * `tile_restriction` (no `lava` / `lava-hot`) and collision rejection against
 * rocks already placed in the same chunk. Rolling `density` alone over-places by
 * ~2x against the game - see `test/entityDensity.spec.ts`.
 */

import { clamp } from "../eval/math";
import type { EvalCtx } from "../eval/ctx";
import { makeVulcanusBiomes } from "../expressions/vulcanusBiomes";
import { makeVulcanusClimate } from "../expressions/vulcanusClimate";
import { makeVulcanusCracks } from "../expressions/vulcanusCracks";
import { makeVulcanusHelpers } from "../expressions/vulcanusHelpers";
import { makeVulcanusSpawn } from "../expressions/vulcanusSpawn";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import { makeVulcanusRockNoise } from "../tiles/vulcanusCatalog";

/** `seed1` of `vulcanus_decorative_knockout`'s multioctave call. */
export const DECORATIVE_KNOCKOUT_SEED1 = 1300000;

/**
 * `vulcanus_decorative_knockout` (`planet-vulcanus-map-gen.lua:867`), commented
 * there as "small wavelength noise (5 tiles-ish) to make decoratives patchy":
 *
 * ```
 * multioctave_noise{x = x, y = y, persistence = 0.7, seed0 = map_seed,
 *                   seed1 = 1300000, octaves = 2, input_scale = 1/3}
 * ```
 *
 * No `output_scale` is given, so it defaults to 1.
 */
export function makeVulcanusDecorativeKnockout(seed0: number): (x: number, y: number) => number {
  return makeMultioctaveNoise({
    seed0,
    seed1: DECORATIVE_KNOCKOUT_SEED1,
    octaves: 2,
    persistence: 0.7,
    inputScale: 1 / 3,
    outputScale: 1,
  });
}

export interface VulcanusRockFields {
  /** `vulcanus_rock_huge`. */
  readonly rockHuge: (x: number, y: number) => number;
  /** `vulcanus_rock_big`. */
  readonly rockBig: (x: number, y: number) => number;
  /** `clamp(max(huge, big), 0, 1)` - what the overlay's placement roll rolls against. */
  readonly density: (x: number, y: number) => number;
}

/** Build the Vulcanus rock probability fields for one seed/ctx. */
export function makeVulcanusRockFields(ctx: EvalCtx): VulcanusRockFields {
  const helpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const climate = makeVulcanusClimate(ctx, helpers, cracks);
  const rockNoise = makeVulcanusRockNoise(ctx.seed0);
  const knockout = makeVulcanusDecorativeKnockout(ctx.seed0);

  // The three terms both expressions share, before their own offset and cap.
  const shared = (x: number, y: number): number =>
    1.2 * Math.min(climate.aux(x, y), -0.1 + 1.1 * climate.moisture(x, y)) +
    rockNoise(x, y) +
    0.5 * knockout(x, y);

  const rockHuge = (x: number, y: number): number =>
    Math.min(0.2 * (1 - 0.75 * biomes.ashlandsBiome(x, y)), -1.2 + shared(x, y));

  const rockBig = (x: number, y: number): number =>
    Math.min(0.2 * (1 - 0.5 * biomes.ashlandsBiome(x, y)), -1.0 + shared(x, y));

  const density = (x: number, y: number): number =>
    clamp(Math.max(rockHuge(x, y), rockBig(x, y)), 0, 1);

  return { rockHuge, rockBig, density };
}
