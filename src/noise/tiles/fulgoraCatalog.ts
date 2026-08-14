/**
 * Fulgora's land / oil-ocean split - the autoplace argmax over the four
 * `oil-ocean-*` tiles.
 *
 * Transcribed from `space-age/prototypes/tile/tiles-fulgora.lua` (the
 * `probability_expression` on each of the four ocean tiles) and `water_base`
 * from `base/prototypes/noise-expressions.lua:69`.
 *
 * **The ocean tiles are checked first, and that is a dominance argument rather
 * than a shortcut.** Fulgora's eight land tiles carry probabilities of order 1
 * (`fulgoran-dunes` is `1 + fulgora_dunes`, `fulgoran-sand` is
 * `1 - fulgora_dunes`, and so on), while an ocean tile whose mask is on scores
 * `50 * 1000 * ...` or `100 * 2000 * ...` - four orders of magnitude more. So
 * wherever an ocean probability is positive it wins, and the land tiles only
 * have to be resolved against each other. Three of the eight are modelled here
 * (`fulgoran-dunes`, `fulgoran-sand`, `fulgoran-rock` - the ones that read only
 * fields this port already has); the rest need the road and ruins layer.
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

/**
 * What the preview needs to colour a Fulgora tile.
 *
 * The two shallow variants share a map colour and so do the two deep ones, so
 * the ocean side collapses to two members rather than four - see the header
 * comment on the ocean argmax. The land side names real tiles, because they do
 * NOT share colours.
 *
 * Only three land tiles are reachable until the road and ruins layer lands.
 */
export type FulgoraTile = "fulgoran-dunes" | "fulgoran-sand" | "fulgoran-rock" | "shallow" | "deep";

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
 * Resolve a Fulgora world position to a tile: `shallow`, `deep`, or one of the
 * three natural land tiles this port models (`fulgoran-dunes`,
 * `fulgoran-sand`, `fulgoran-rock`).
 *
 * `ctx.seed0` is `map_seed` as the noise program sees it - the FULGORA SURFACE
 * seed, so derive it with `surfaceSeedForPlanet("fulgora", mapSeed)` before
 * constructing. The oracle harness sets the surface seed explicitly, which is
 * why the spec passes its fixture seed raw.
 *
 * **OPEN FINDING, not yet resolved.** At the 828 fixture positions where the
 * game placed one of these three tiles, this three-way argmax over their
 * `probability_expression`s (transcribed verbatim from
 * `tiles-fulgora.lua`, byte-checked against the source) matches the game on
 * only 783 (94.6%) - see `test/fulgoraLandTiles.spec.ts`. This is NOT a port
 * bug: `fulgora_rock`, `fulgora_dunes` and `fulgora_mix_oil` were queried
 * directly from a live Fulgora surface at several disputed positions and
 * matched this port to ~1e-7, and the game's own evaluation of the composite
 * formulas (queried as whole expression strings) matched this port's
 * arithmetic exactly. At one measured position (-1628, 872) the game's own
 * `fulgoran-rock` formula scores 2.254 against `fulgoran-dunes`'s 1.615 - yet
 * `get_tile` there is `fulgoran-dunes`. So highest-value-wins over these three
 * formulas is demonstrably not the whole selection rule, unlike the Nauvis
 * 21-tile catalog (`resolve.ts`, argmax validated 100%) and the ocean argmax
 * above. A rival explanation - the game samples tile autoplace at the tile
 * CENTRE rather than the corner - was tested and refuted: every offset from
 * -0.5 to 0.5 scores worse than the corner on both land accuracy and land/ocean
 * misses (see `test/fulgoraLandTiles.spec.ts` for the measured table).
 *
 * 43 of the 45 mismatches ARE Chebyshev-1 adjacent to a position this resolver
 * already classifies the game's way. The base rate for that adjacency among
 * all 828 scoped positions is 47.8% (these three tiles interleave far more
 * often than land and ocean do), much higher than the ocean residual's 3.8%
 * base rate - but a higher base rate does not by itself weaken the signal:
 * `P(X >= 43 | n = 45, p = 0.478) = 4.6e-12` (binomial tail), a STRONGER
 * p-value than the ocean residual's ~1e-10. What it does not do is identify
 * the mechanism: unlike the ocean residual (traced to the game placing a tile
 * its own expressions score unplaceable, pointing at a post-argmax correction
 * pass), no mechanism has been found here. It is the same open question, not
 * yet answered.
 */
export function makeFulgoraTileResolver(ctx: FulgoraCtx): (x: number, y: number) => FulgoraTile {
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);

  // Not `memoXY`-wrapped, unlike every field below it: that helper is typed for
  // numbers, and there is nothing to gain here anyway - every expensive read
  // this function makes is already memoized inside the chain.
  return (x: number, y: number): FulgoraTile => {
    const e = chain.elevation(x, y);
    const mask = chain.oilMask(x, y);
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
    const bestOcean = bestProbability(bestShallow, bestDeep);

    // The ocean early-out is what keeps the ocean question as cheap as it was
    // in V1: 55% of sampled positions never touch the land layer at all.
    //
    // `> 0` rather than `>= 0`: a probability of exactly 0 does not place a
    // tile, and `-inf` (above the tile's water level) fails it too. Both are
    // reachable - the mask being off makes every term exactly 0 - so an ocean
    // probability of exactly 0 correctly falls through to the land argmax
    // below rather than taking this branch.
    if (bestOcean > 0) return bestDeep > bestShallow ? "deep" : "shallow";

    // `fulgoran-sand` is `1 - fulgora_dunes`, and `fulgora_dunes` is
    // `0.66 - abs(n)`, so sand is `0.34 + abs(n)` - never below 0.34. Some land
    // tile is therefore always placeable and there is no fallback to model.
    const dunesField = chain.dunes(x, y);
    const dunes = 1 + dunesField;
    const sand = 1 - dunesField;
    const rock = 0.8 + chain.rock(x, y) * 2 - Math.max(0, chain.mixOil(x, y)) * 6;

    if (rock > dunes && rock > sand) return "fulgoran-rock";
    return dunes > sand ? "fulgoran-dunes" : "fulgoran-sand";
  };
}
