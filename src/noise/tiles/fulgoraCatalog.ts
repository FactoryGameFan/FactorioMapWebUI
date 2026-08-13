/**
 * Fulgora's land / oil-ocean split - the autoplace argmax over the four
 * `oil-ocean-*` tiles.
 *
 * Transcribed from `space-age/prototypes/tile/tiles-fulgora.lua` (the
 * `probability_expression` on each of the four ocean tiles) and `water_base`
 * from `base/prototypes/noise-expressions.lua:69`.
 *
 * **Only the ocean tiles are modelled, and that is a dominance argument rather
 * than a shortcut.** Fulgora's eight land tiles carry probabilities of order 1
 * (`fulgoran-dunes` is `1 + fulgora_dunes`, `fulgoran-sand` is
 * `1 - fulgora_dunes`, and so on), while an ocean tile whose mask is on scores
 * `50 * 1000 * ...` or `100 * 2000 * ...` - four orders of magnitude more. So
 * wherever an ocean probability is positive it wins, and the land tiles only
 * have to be resolved against each other, which the map colour does not need.
 *
 * The argument has one thin spot and it is named here rather than hidden: the
 * two shallow tiles split on the SIGN of `scrap_medium + dunes`, one taking
 * `max(-s, 0)` and the other `max(s, 0)`, so where `s` is near zero both are
 * near zero and a land tile could win on a technicality. `deep` covers most of
 * that region (it does not read `s` at all), and the remainder is checked
 * against the game rather than argued: `test/fulgoraAgreement.spec.ts` compares
 * 5057 real `get_tile` results, 2796 of them ocean.
 */
import { makeFulgoraCells } from "../expressions/fulgoraCells";
import { makeFulgoraElevation } from "../expressions/fulgoraElevation";
import { makeFulgoraShared, type FulgoraCtx } from "../expressions/fulgoraShared";

/** What the preview needs to colour a Fulgora tile. */
export type FulgoraSurface = "land" | "shallow" | "deep";

/**
 * `water_base(max_elevation, influence)` from
 * `base/prototypes/noise-expressions.lua:69`:
 *
 *   `if(max_elevation >= elevation, influence * min(max_elevation - elevation, 1), -inf)`
 *
 * The `-inf` is not decoration - it is what stops a tile being placed above its
 * own water level, and it has to survive the multiplications that follow rather
 * than being clamped to 0 here.
 */
function waterBase(maxElevation: number, influence: number, elevation: number): number {
  return maxElevation >= elevation
    ? influence * Math.min(maxElevation - elevation, 1)
    : Number.NEGATIVE_INFINITY;
}

/** `fulgora_coastline`, and `fulgora_coastline_drop` halved as the deep tiles use it. */
const COASTLINE = 80;
const DEEP_LEVEL = COASTLINE - 50 - 20 / 2; // = 20

/**
 * `Math.max` over tile probabilities, with **NaN losing instead of poisoning**.
 *
 * This is not defensive coding, it is the model. `water_base` returns `-inf`
 * above its tile's water level, and both `oil-ocean-deep-2` and the two shallow
 * tiles multiply that by a factor that is often exactly 0 - so `0 * -inf` makes
 * a genuine NaN at a large share of real positions. A plain `Math.max`
 * propagates it, and every tile in the comparison loses to one tile's NaN.
 *
 * Measured: it wrongly called **218 of 5057** sampled positions land, every one
 * of them a real `oil-ocean-shallow` or `-shallow-2` with the mask on, a
 * positive shallow probability of ~50000, and an elevation between the deep
 * level (20) and the coastline (80) - exactly the band where
 * `deep = 100 * 1 * -inf` and `deep2 = 0 * -inf`. The argmax is per tile, so a
 * tile whose probability is not a number simply is not placed; it cannot veto
 * the others.
 */
function bestProbability(...values: number[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v > best) best = v;
  }
  return best;
}

/**
 * Resolve a Fulgora world position to `land`, `shallow` or `deep`.
 *
 * `ctx.seed0` is `map_seed` as the noise program sees it - the FULGORA SURFACE
 * seed, so derive it with `surfaceSeedForPlanet("fulgora", mapSeed)` before
 * constructing. The oracle harness sets the surface seed explicitly, which is
 * why the spec passes its fixture seed raw.
 */
export function makeFulgoraSurfaceResolver(
  ctx: FulgoraCtx,
): (x: number, y: number) => FulgoraSurface {
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);

  // Not `memoXY`-wrapped, unlike every field below it: that helper is typed for
  // numbers, and there is nothing to gain here anyway - every expensive read
  // this function makes is already memoized inside the chain.
  return (x: number, y: number): FulgoraSurface => {
    const e = chain.elevation(x, y);
    const mask = chain.oilMask(x, y);
    // `fulgora_scrap_medium + fulgora_dunes` - the term whose SIGN chooses
    // between the two shallow variants. They share a map colour, so which one
    // wins never reaches the palette; only whether either beats deep does.
    const s = chain.scrapMedium(x, y) + chain.dunes(x, y);

    const shallowBase = 50 * mask * waterBase(COASTLINE, 1000, e);
    const shallow = shallowBase * Math.max(-s, 0);
    const shallow2 = shallowBase * Math.max(s, 0);

    const deepBase = 100 * mask * waterBase(DEEP_LEVEL, 2000, e);
    const deep2Scale =
      -Math.min(0, e - 60) / 100 + Math.max(0, chain.dunes(x, y) - Math.max(0, e / 100));
    const deep2 = deep2Scale * deepBase;

    const bestShallow = bestProbability(shallow, shallow2);
    const bestDeep = bestProbability(deepBase, deep2);
    const best = bestProbability(bestShallow, bestDeep);

    // `> 0` rather than `>= 0`: a probability of exactly 0 does not place a
    // tile, and `-inf` (above the tile's water level) fails it too. Both are
    // reachable - the mask being off makes every term exactly 0.
    if (!(best > 0)) return "land";
    return bestDeep > bestShallow ? "deep" : "shallow";
  };
}
