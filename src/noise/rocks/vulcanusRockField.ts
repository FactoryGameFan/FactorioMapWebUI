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
 * Interim footprint threshold, the Vulcanus counterpart of Nauvis's
 * `ROCK_FOOTPRINT_THRESHOLD`. Both rock probabilities cap at 0.2, so this is
 * NOT 0.5 - there is no threshold that yields a faithful footprint, because
 * every rock in-game comes from a per-tile roll against that probability.
 *
 * Deliberately the SAME value as Nauvis's, rather than a per-planet number
 * tuned to hit a coverage target. It does not produce the same look, and that
 * is worth knowing: over world [-512, 512)^2 at seed 123456 it paints **7.0%**
 * of the area, where the Nauvis constant was chosen because it painted ~1.6%
 * and read as scattered specks.
 *
 * Raising it barely helps, because `min(cap, ...)` makes the field a plateau
 * rather than a gradient - measured coverage against threshold:
 *
 *   0.02 -> 7.03%   0.08 -> 5.50%   0.12 -> 3.81%   0.19 -> 2.37%
 *
 * i.e. even at 0.19, a hair under the 0.2 cap, a third of the ink survives.
 * There is no threshold that turns this field into scattered points, so tuning
 * one would buy a magic number and not the intended look. The real fix is the
 * per-tile placement roll tracked in issue #9; until then this reads as rocky
 * ground rather than as individual rocks.
 *
 * As with Nauvis, do not chase pixel parity with the game's own preview here:
 * the game charts each placed rock by its collision box (huge-volcanic-rock is
 * 3x2.2 tiles), which is a different quantity again.
 */
export const VULCANUS_ROCK_FOOTPRINT_THRESHOLD = 0.02;

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
  /** `clamp(max(huge, big), 0, 1)` - what the overlay thresholds. */
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
