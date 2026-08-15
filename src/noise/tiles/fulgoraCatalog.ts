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
 * have to be resolved against each other. All eight are modelled here and
 * resolved in an eight-way argmax, using the road and ruins layer for the five
 * that need it (`fulgoran-dust`, `fulgoran-paving`, `fulgoran-walls`,
 * `fulgoran-conduit`, `fulgoran-machinery`).
 *
 * The argument has one thin spot and it is named here rather than hidden: the
 * two shallow tiles split on the SIGN of `scrap_medium + dunes`, one taking
 * `max(-s, 0)` and the other `max(s, 0)`, so where `s` is near zero both are
 * near zero and a land tile could win on a technicality. `deep` covers most of
 * that region (it does not read `s` at all), and the remainder is checked
 * against the game rather than argued: `test/fulgoraAgreement.spec.ts` compares
 * 5057 real `get_tile` results, 2796 of them ocean.
 */
import { makeFulgoraCells, type FulgoraCells } from "../expressions/fulgoraCells";
import { makeFulgoraElevation, type FulgoraElevation } from "../expressions/fulgoraElevation";
import { makeFulgoraMasks } from "../expressions/fulgoraMasks";
import { makeFulgoraRoads, type FulgoraRoads } from "../expressions/fulgoraRoads";
import { makeFulgoraRuins, type FulgoraRuins } from "../expressions/fulgoraRuins";
import { makeFulgoraShared, type FulgoraCtx } from "../expressions/fulgoraShared";

/**
 * What the preview needs to colour a Fulgora tile.
 *
 * The two shallow variants share a map colour and so do the two deep ones, so
 * the ocean side collapses to two members rather than four - see the header
 * comment on the ocean argmax. The land side names real tiles, because they do
 * NOT share colours - all eight are resolved against each other in the land
 * argmax below.
 */
export type FulgoraTile =
  | "fulgoran-dust"
  | "fulgoran-dunes"
  | "fulgoran-sand"
  | "fulgoran-rock"
  | "fulgoran-paving"
  | "fulgoran-walls"
  | "fulgoran-conduit"
  | "fulgoran-machinery"
  | "shallow"
  | "deep";

/** The eight land probabilities in a fixed order, so the tie-break is stable. */
const LAND_ORDER = [
  "fulgoran-dust",
  "fulgoran-dunes",
  "fulgoran-sand",
  "fulgoran-rock",
  "fulgoran-paving",
  "fulgoran-walls",
  "fulgoran-conduit",
  "fulgoran-machinery",
] as const;

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
 * The eight land `probability_expression`s, evaluated in {@link LAND_ORDER}.
 *
 * Split out of the resolver so the oracle spec can bound-check the values
 * themselves rather than only the argmax's winner. That distinction matters:
 * four of the eight (`fulgoran-walls`, `-conduit`, `-machinery`, `-paving`)
 * are bare named expressions the game reports directly, but the other four are
 * COMPOSITES - arithmetic over several named expressions, written out in
 * `tiles-fulgora.lua` and transcribed here. A composite can be mis-transcribed
 * (a `max` arity, an operator precedence, a sign) in a way that still produces
 * a plausible argmax, so the argmax alone is not a check on it.
 *
 * `test/fulgoraExpressions.spec.ts` compares all four composites against the
 * game's own evaluation of the same expression strings. Keep this the ONLY
 * place the formulas are written - a copy in the spec would be checking the
 * copy, not the port.
 */
function landProbabilitiesFrom(
  cells: FulgoraCells,
  chain: FulgoraElevation,
  roads: FulgoraRoads,
  ruins: FulgoraRuins,
): (x: number, y: number) => number[] {
  return (x: number, y: number): number[] => {
    // `fulgoran-dust` reads `max(0, natural, 2 * mesa * pyramids)` - a THREE
    // argument max, not `max(0, natural)` times something.
    const dust =
      chain.scrapMedium(x, y) +
      Math.max(0, chain.natural(x, y), 2 * cells.mesa(x, y) * cells.pyramids(x, y)) * 2 -
      0.9 +
      chain.rock(x, y) +
      roads.roadDust(x, y) * cells.sprawl(x, y);

    const dunesField = chain.dunes(x, y);
    return [
      dust,
      1 + dunesField,
      1 - dunesField,
      0.8 + chain.rock(x, y) * 2 - Math.max(0, chain.mixOil(x, y)) * 6,
      ruins.tileRuinPaving(x, y),
      ruins.tileRuinWalls(x, y),
      ruins.tileRuinConduit(x, y),
      ruins.tileRuinMachinery(x, y),
    ];
  };
}

/**
 * The Fulgora field DAG, built once.
 *
 * Three call sites used to build their own copy - the tile resolver, the land
 * probabilities and (from Task 3) the scrap field. Building one shared
 * `FulgoraStack` and passing it to all three avoids paying to construct the
 * DAG more than once and lets consumers that query the SAME position
 * back-to-back reuse each other's `memoXY` result.
 *
 * What it does NOT buy is cross-pass reuse. `memoXY` is a SINGLE-ENTRY cache,
 * and the terrain pass and the resources/scrap pass are each a full
 * sequential sweep of the render region, run one after the other - by the
 * time the second pass reaches a position, the first pass's cache has long
 * since moved off it, so nothing survives to be shared regardless of how many
 * stacks are in play. `VulcanusStack` in `vulcanusCatalog.ts` takes an
 * `opts.cacheShared` flag that wraps specific fields in `memoRegion` (a
 * multi-entry cache) precisely to recover that case; `FulgoraStack` has no
 * such option, so it does not mirror that Vulcanus behaviour.
 */
export interface FulgoraStack {
  readonly ctx: FulgoraCtx;
  readonly shared: ReturnType<typeof makeFulgoraShared>;
  readonly cells: ReturnType<typeof makeFulgoraCells>;
  readonly chain: ReturnType<typeof makeFulgoraElevation>;
  readonly masks: ReturnType<typeof makeFulgoraMasks>;
  readonly roads: ReturnType<typeof makeFulgoraRoads>;
  readonly ruins: ReturnType<typeof makeFulgoraRuins>;
}

export function makeFulgoraStack(ctx: FulgoraCtx): FulgoraStack {
  const shared = makeFulgoraShared(ctx);
  const cells = makeFulgoraCells(shared, ctx);
  const chain = makeFulgoraElevation(shared, cells, ctx);
  const masks = makeFulgoraMasks(shared, cells, chain);
  const roads = makeFulgoraRoads(shared, cells, ctx);
  const ruins = makeFulgoraRuins(cells, masks, roads, ctx);
  return { ctx, shared, cells, chain, masks, roads, ruins };
}

/**
 * The eight land probabilities at a position, in {@link LAND_ORDER}, built from
 * their own layer stack.
 *
 * For tests and analysis only - the renderer goes through
 * {@link makeFulgoraTileResolver}, which shares one layer stack (and therefore
 * one set of memo caches) between the ocean branch and this. Constructing both
 * against the same `ctx` is correct but evaluates each field twice.
 *
 * "Twice" only counts THIS function against {@link makeFulgoraTileResolver} -
 * it is narrower than it reads now that {@link makeFulgoraScrap} (Task 3) is a
 * third consumer of the same DAG. A caller that builds all three independently
 * (rather than sharing one `FulgoraStack`, as `makeFulgoraScrap` is designed
 * to accept) pays for the tree a third time, not a second.
 */
export function makeFulgoraLandProbabilities(ctx: FulgoraCtx): (x: number, y: number) => number[] {
  const stack = makeFulgoraStack(ctx);
  const { cells, chain, roads, ruins } = stack;
  return landProbabilitiesFrom(cells, chain, roads, ruins);
}

/**
 * The per-position body of the tile resolver, shared between
 * {@link makeFulgoraTileResolver} and {@link makeFulgoraTileResolverFrom} so
 * both paths run byte-identical code.
 *
 * **OPEN FINDING: highest-value-wins over these `probability_expression`s,
 * transcribed verbatim from `tiles-fulgora.lua`, is demonstrably not the whole
 * selection rule.** At (-1628, 872) the game's own `fulgoran-rock` formula
 * scores 2.2537 against `fulgoran-dunes`'s 1.6149 - yet `get_tile` there is
 * `fulgoran-dunes`. See `test/fulgoraLandTiles.spec.ts` for the measured
 * agreement count, the confusion pairs, the boundary-adjacency statistics, and
 * the refuted rival explanations (a sub-tile centre-sampling offset, an
 * inflated probability formula).
 */
function resolveFrom(
  chain: FulgoraElevation,
  landProbabilities: (x: number, y: number) => number[],
): (x: number, y: number) => FulgoraTile {
  // Not `memoXY`-wrapped, unlike every field below it: that helper is typed for
  // numbers, and there is nothing to gain here anyway - every expensive read
  // this function makes is already memoized inside the chain.
  return (x: number, y: number): FulgoraTile => {
    const e = chain.elevation(x, y);
    const mask = chain.oilMask(x, y);
    // `s`'s SIGN is what picks between the two shallow variants below
    // (`shallow` takes `max(-s, 0)`, `shallow2` takes `max(s, 0)`) - see the
    // header comment's "thin spot" paragraph for why a value near zero can let
    // a land tile win on a technicality.
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

    // The ocean early-out is what keeps the ocean question cheap: measured
    // directly on the render-cost benchmark window (1024x1024 at (-512,-512),
    // seed 123456), 79.7% of pixels resolve here and never touch the land
    // layer below - see `docs/noise/fulgora-elevation-NOTES.md`'s Task 12 for
    // the measurement (the `oracle-fulgora-tiles` fixture's own ocean share,
    // 55.3%, is a coastline-concentrated sample and understates this).
    //
    // `> 0` rather than `>= 0`: a probability of exactly 0 does not place a
    // tile, and `-inf` (above the tile's water level) fails it too. Both are
    // reachable - the mask being off makes every term exactly 0 - so an ocean
    // probability of exactly 0 correctly falls through to the land argmax
    // below rather than taking this branch.
    if (bestOcean > 0) return bestDeep > bestShallow ? "deep" : "shallow";

    const probabilities = landProbabilities(x, y);

    // A manual loop rather than `bestProbability(...probabilities)`: this
    // needs the winning INDEX, not just the winning value, so it can look the
    // name up in `LAND_ORDER`. The comparison logic is identical to
    // `bestProbability` - a NaN loses rather than poisoning the max, matching
    // `LAND_ORDER[0]` ("fulgoran-dust") only if EVERY probability were NaN at
    // once. Checked directly rather than assumed: none of the eight land
    // formulas divides, and none multiplies a mask by `-Infinity` the way
    // `water_base` does, so none can produce NaN from a `0 * -Infinity` the
    // way the ocean branch's `deep`/`deep2` do. Measured zero NaNs across all
    // 5057 `oracle-fulgora-tiles` fixture positions and a dense 169,303-point
    // sweep of [-8000, 8000]^2 - the all-NaN case this comment describes has
    // not been observed anywhere.
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < probabilities.length; i++) {
      const v = probabilities[i] as number;
      if (v > bestValue) {
        bestValue = v;
        bestIndex = i;
      }
    }
    return LAND_ORDER[bestIndex] as FulgoraTile;
  };
}

/**
 * Resolve a Fulgora world position to a tile: `shallow`, `deep`, or one of the
 * eight land tiles, argmaxed against each other.
 *
 * `ctx.seed0` is `map_seed` as the noise program sees it - the FULGORA SURFACE
 * seed, so derive it with `surfaceSeedForPlanet("fulgora", mapSeed)` before
 * constructing. The oracle harness sets the surface seed explicitly, which is
 * why the spec passes its fixture seed raw.
 */
export function makeFulgoraTileResolver(ctx: FulgoraCtx): (x: number, y: number) => FulgoraTile {
  return makeFulgoraTileResolverFrom(makeFulgoraStack(ctx));
}

/** As {@link makeFulgoraTileResolver}, but over a stack the caller already built. */
export function makeFulgoraTileResolverFrom(
  stack: FulgoraStack,
): (x: number, y: number) => FulgoraTile {
  const { cells, chain, roads, ruins } = stack;
  const landProbabilities = landProbabilitiesFrom(cells, chain, roads, ruins);
  return resolveFrom(chain, landProbabilities);
}
