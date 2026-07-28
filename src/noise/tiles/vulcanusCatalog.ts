/**
 * The 19 Vulcanus autoplace tiles as data (Task 10): name, `map_color`, and a
 * `probability(x, y)` closure, plus the ~24 named `*_range` noise-expressions the
 * tiles' `probability_expression` fields reference. All transcribed verbatim from
 * `space-age/prototypes/tile/tiles-vulcanus.lua` (`~/GitHub/factorio-data`, tag
 * 2.1.11), with the two map-gen helpers `mountain_lava_spots` and
 * `vulcanus_rock_noise` (from `planet-vulcanus-map-gen.lua`) ported alongside.
 *
 * Tile selection is a pure argmax over these 19 `probability` values (the same
 * mechanism as Nauvis `catalog.ts` + `resolve.ts`): the placed tile is the one with
 * the maximum probability, and ties keep the FIRST tile in catalog order (strict `>`
 * never displaces the running winner). Catalog order = data-file registration order.
 *
 * `tile_lightening = 28`: a game `map_color = {r = tile_lightening + N, ...}` stores
 * the byte `28 + N`; literal `{r, g, b}` colors are used verbatim. See
 * `docs/noise/vulcanus-tiles-NOTES.md` for the full tile table and field bindings.
 * V2 restored the three resource-coupling terms (`vulcanus_metal_tile`,
 * `vulcanus_calcite_region`, `vulcanus_sulfuric_acid_region_patchy`) that V1 had
 * approximated away; the only remaining approximation is
 * `random_penalty_between(0.9, 1, 1) -> 1` inside `vulcanus_metal_tile` itself (see
 * `src/noise/expressions/vulcanusResources.ts`).
 */

import type { EvalCtx, EvalCtxInput } from "../eval/ctx";
import { withCtxDefaults } from "../eval/ctx";
import { distanceFromNearestPoint } from "../distanceFromNearestPoint";
import { clamp, max, min } from "../eval/math";
import { makeMultioctaveNoise } from "../multioctaveNoise";
import { makeVulcanusBiomes, type VulcanusBiomes } from "../expressions/vulcanusBiomes";
import { makeVulcanusClimate, type VulcanusClimate } from "../expressions/vulcanusClimate";
import { makeVulcanusCracks } from "../expressions/vulcanusCracks";
import { makeVulcanusElevation, type VulcanusElevation } from "../expressions/vulcanusElevation";
import { makeVulcanusHelpers, type VulcanusHelpers } from "../expressions/vulcanusHelpers";
import { makeVulcanusResources } from "../expressions/vulcanusResources";
import { makeVulcanusSpawn } from "../expressions/vulcanusSpawn";
import { rangeSelectBase } from "../rocks/rockCatalog";

/** A placed Vulcanus tile: its name and `[r, g, b]` map color (0-255 bytes). */
export interface VulcanusTile {
  name: string;
  color: [number, number, number];
  probability(x: number, y: number): number;
}

/**
 * The field closures the tile `*_range` expressions read, wired from Tasks 7-9.
 * `elev` is the RAW `vulcanus_elev` (pre `max(-500,...)` clamp), which the ranges
 * reference by that name.
 */
export interface VulcanusTileFields {
  elev(x: number, y: number): number;
  aux(x: number, y: number): number;
  moisture(x: number, y: number): number;
  mountainsBiome(x: number, y: number): number;
  ashlandsBiome(x: number, y: number): number;
  basaltsBiome(x: number, y: number): number;
  mountainVolcanoSpots(x: number, y: number): number;
  mountainLavaSpots(x: number, y: number): number;
  rockNoise(x: number, y: number): number;
  distance(x: number, y: number): number;
  /** `vulcanus_metal_tile = max(0, vulcanus_tungsten_ore_probability)` (V2). */
  metalTile(x: number, y: number): number;
  /** `vulcanus_calcite_region` (V2). */
  calciteRegion(x: number, y: number): number;
  /** `vulcanus_sulfuric_acid_region_patchy` (V2). */
  sulfuricAcidRegionPatchy(x: number, y: number): number;
}

/**
 * `vulcanus_rock_noise` (planet-vulcanus-map-gen.lua ~line 872): a plain
 * `multioctave_noise{seed1 = 137, octaves = 4, persistence = 0.65, input_scale = 0.1,
 * output_scale = 0.4}`. The commented-out `control:rocks:frequency` slider term in
 * the source is NOT applied (it is commented out).
 */
export function makeVulcanusRockNoise(seed0: number): (x: number, y: number) => number {
  return makeMultioctaveNoise({
    seed0,
    seed1: 137,
    octaves: 4,
    persistence: 0.65,
    inputScale: 0.1,
    outputScale: 0.4,
  });
}

/**
 * `mountain_lava_spots` (planet-vulcanus-map-gen.lua ~line 452):
 *
 *   clamp(vulcanus_threshold(mountain_volcano_spots * 1.95 - 0.95,
 *                            0.4 * clamp(vulcanus_threshold(vulcanus_mountains_biome, 0.5), 0, 1))
 *         * vulcanus_threshold(clamp(vulcanus_plasma(17453, 0.2, 0.4, 10, 20) / 20, 0, 1), 1.8),
 *         0, 1)
 */
export function makeMountainLavaSpots(
  helpers: VulcanusHelpers,
  biomes: VulcanusBiomes,
): (x: number, y: number) => number {
  const plasma = helpers.plasma(17453, 0.2, 0.4, 10, 20);
  return (x: number, y: number): number => {
    const mvs = biomes.mountainVolcanoSpots(x, y);
    const mountainsBiome = biomes.mountainsBiome(x, y);
    const inner = helpers.threshold(
      mvs * 1.95 - 0.95,
      0.4 * clamp(helpers.threshold(mountainsBiome, 0.5), 0, 1),
    );
    const plasmaTerm = helpers.threshold(clamp(plasma(x, y) / 20, 0, 1), 1.8);
    return clamp(inner * plasmaTerm, 0, 1);
  };
}

/**
 * Build the 19-tile Vulcanus catalog from the field closures. Each tile's
 * `probability` is its `probability_expression` transcribed verbatim, including the
 * `vulcanus_metal_tile` / `vulcanus_calcite_region` / `vulcanus_sulfuric_acid_region_patchy`
 * resource-coupling terms (V2).
 */
export function makeVulcanusTileCatalog(f: VulcanusTileFields): VulcanusTile[] {
  // --- named *_range building blocks (shared by multiple tiles) --------------

  // lava_spawn_excluder = distance > 10 (boolean -> 1/0).
  const lavaSpawnExcluder = (x: number, y: number): number => (f.distance(x, y) > 10 ? 1 : 0);

  const lavaBasaltsRange = (x: number, y: number): number =>
    100 *
    min(
      f.basaltsBiome(x, y) *
        lavaSpawnExcluder(x, y) *
        rangeSelectBase(f.elev(x, y), -5000, 0, 1, -1000, 1),
      100 * (1 - f.metalTile(x, y)),
    );

  const lavaMountainsRange = (x: number, y: number): number =>
    1100 * rangeSelectBase(f.mountainLavaSpots(x, y), 0.2, 10, 1, 0, 1);

  const lavaHotBasaltsRange = (x: number, y: number): number =>
    200 *
    min(
      f.basaltsBiome(x, y) *
        lavaSpawnExcluder(x, y) *
        rangeSelectBase(f.elev(x, y), -5000, min(0, 5 * (-2 + 4 * f.rockNoise(x, y))), 1, -1000, 1),
      100 * (1 - f.metalTile(x, y)),
    );

  const lavaHotMountainsRange = (x: number, y: number): number =>
    1000 * rangeSelectBase(f.mountainLavaSpots(x, y), 0.05, 0.3, 1, 0, 1);

  const volcanicCracksHotRange = (x: number, y: number): number =>
    f.basaltsBiome(x, y) * rangeSelectBase(f.elev(x, y), 0, 8, 1, 0, 20);

  const volcanicCracksWarmRange = (x: number, y: number): number =>
    f.basaltsBiome(x, y) * rangeSelectBase(f.elev(x, y), 8, 22, 1, 0, 5) +
    (f.aux(x, y) - 0.05) +
    50000 * f.metalTile(x, y);

  const volcanicCracksColdRange = (x: number, y: number): number =>
    (0.5 - f.ashlandsBiome(x, y)) * rangeSelectBase(f.elev(x, y), 20, 100, 1, 0, 1) +
    (f.aux(x, y) - 0.3);

  const volcanicSmoothStoneWarmRange = (x: number, y: number): number =>
    f.basaltsBiome(x, y) * rangeSelectBase(f.elev(x, y), 8, 20, 1, 0, 5) -
    (f.aux(x, y) - 0.05) +
    50000 * f.metalTile(x, y);

  const volcanicSmoothStoneRange = (x: number, y: number): number =>
    (0.5 - f.ashlandsBiome(x, y)) * rangeSelectBase(f.elev(x, y), 20, 100, 1, 0, 1) -
    (f.aux(x, y) - 0.3);

  const volcanicFoldsFlatRange = (x: number, y: number): number =>
    2 * (f.mountainsBiome(x, y) - 0.5) - 0.15 * f.mountainVolcanoSpots(x, y);

  const volcanicFoldsRange = (x: number, y: number): number =>
    2 * (f.mountainsBiome(x, y) - 0.5) +
    (f.aux(x, y) - 0.5) +
    0.5 * (f.mountainVolcanoSpots(x, y) - 0.1);

  const volcanicFoldsWarmRange = (x: number, y: number): number =>
    2 * (f.mountainsBiome(x, y) - 0.5) +
    3 * (f.mountainVolcanoSpots(x, y) - 0.85) -
    2 * (f.aux(x, y) - 0.5);

  const volcanicJaggedGroundRange = (x: number, y: number): number =>
    5 *
    min(
      10,
      max(
        f.calciteRegion(x, y) + 0.2,
        rangeSelectBase(f.elev(x, y), 1010, 2000, 2, -10, 1) + 3 * (f.aux(x, y) - 0.5),
      ),
    );

  const volcanicSoilLightRangeMountains = (x: number, y: number): number =>
    min(0.8, 4 * (f.mountainsBiome(x, y) - 0.25)) -
    0.35 * f.mountainVolcanoSpots(x, y) -
    3 * (f.aux(x, y) - 0.2);

  const volcanicSoilDarkRangeMountains = (x: number, y: number): number =>
    min(0.8, 4 * (f.mountainsBiome(x, y) - 0.25)) -
    0.35 * f.mountainVolcanoSpots(x, y) -
    1 * (f.aux(x, y) - 0.5);

  const volcanicAshFlatsRange = (x: number, y: number): number =>
    2 * (f.ashlandsBiome(x, y) - 0.5) - 1.5 * (f.aux(x, y) - 0.25) - 1.5 * (f.moisture(x, y) - 0.6);

  const volcanicAshLightRange = (x: number, y: number): number =>
    2 * (f.ashlandsBiome(x, y) - 0.5) - 1.5 * (f.moisture(x, y) - 0.6);

  const volcanicAshDarkRange = (x: number, y: number): number =>
    min(1, 4 * (f.ashlandsBiome(x, y) - 0.25)) +
    max(
      -1.5 * (f.aux(x, y) - 0.25),
      0.01 - 1.5 * Math.abs(f.aux(x, y) - 0.5) - 1.5 * (f.moisture(x, y) - 0.66),
    );

  const volcanicPumiceStonesRange = (x: number, y: number): number =>
    2 * (f.ashlandsBiome(x, y) - 0.5) + 1.5 * (f.aux(x, y) - 0.5) + 1.5 * (f.moisture(x, y) - 0.66);

  const volcanicAshCracksRange = (x: number, y: number): number =>
    min(1, 4 * (f.ashlandsBiome(x, y) - 0.25)) +
    1.5 * (f.aux(x, y) - 0.5) -
    1.5 * (f.moisture(x, y) - 0.66);

  const volcanicAshSoilRange = (x: number, y: number): number => 2 * (f.ashlandsBiome(x, y) - 0.5);

  const volcanicSoilLightRangeAshlands = (x: number, y: number): number =>
    2 * (f.ashlandsBiome(x, y) - 0.5) + 1.5 * (f.moisture(x, y) - 0.8);

  const volcanicSoilDarkRangeAshlands = (x: number, y: number): number =>
    2 * (f.ashlandsBiome(x, y) - 0.5) - 1.5 * (f.aux(x, y) - 0.25) + 1.5 * (f.moisture(x, y) - 0.8);

  const volcanicSoilLightRange = (x: number, y: number): number =>
    max(
      volcanicSoilLightRangeMountains(x, y),
      volcanicSoilLightRangeAshlands(x, y),
      10 * (f.sulfuricAcidRegionPatchy(x, y) + 0.2),
    );

  const volcanicSoilDarkRange = (x: number, y: number): number =>
    max(volcanicSoilDarkRangeMountains(x, y), volcanicSoilDarkRangeAshlands(x, y));

  // --- tiles (registration order) --------------------------------------------
  return [
    {
      name: "volcanic-jagged-ground",
      color: [58, 58, 48],
      probability: volcanicJaggedGroundRange,
    },
    {
      name: "lava",
      color: [150, 49, 30],
      probability: (x, y) => max(lavaBasaltsRange(x, y), lavaMountainsRange(x, y)),
    },
    {
      name: "lava-hot",
      color: [255, 138, 57],
      probability: (x, y) => max(lavaHotBasaltsRange(x, y), lavaHotMountainsRange(x, y)),
    },
    {
      name: "volcanic-cracks-hot",
      color: [58, 33, 23],
      probability: volcanicCracksHotRange,
    },
    {
      name: "volcanic-cracks-warm",
      color: [58, 38, 33],
      probability: volcanicCracksWarmRange,
    },
    {
      name: "volcanic-cracks",
      color: [43, 42, 43],
      probability: volcanicCracksColdRange,
    },
    {
      name: "volcanic-folds-flat",
      color: [44, 43, 44],
      probability: volcanicFoldsFlatRange,
    },
    {
      name: "volcanic-ash-light",
      color: [53, 53, 53],
      probability: volcanicAshLightRange,
    },
    {
      name: "volcanic-ash-dark",
      color: [53, 53, 53],
      probability: volcanicAshDarkRange,
    },
    {
      name: "volcanic-ash-flats",
      color: [53, 53, 53],
      probability: volcanicAshFlatsRange,
    },
    {
      name: "volcanic-pumice-stones",
      color: [46, 46, 46],
      probability: volcanicPumiceStonesRange,
    },
    {
      name: "volcanic-smooth-stone",
      color: [50, 50, 58],
      probability: volcanicSmoothStoneRange,
    },
    {
      name: "volcanic-smooth-stone-warm",
      color: [54, 50, 50],
      probability: volcanicSmoothStoneWarmRange,
    },
    {
      name: "volcanic-ash-cracks",
      color: [67, 67, 67],
      probability: volcanicAshCracksRange,
    },
    {
      name: "volcanic-folds",
      color: [43, 43, 43],
      probability: volcanicFoldsRange,
    },
    {
      name: "volcanic-folds-warm",
      color: [65, 45, 45],
      probability: volcanicFoldsWarmRange,
    },
    {
      name: "volcanic-soil-dark",
      color: [48, 51, 43],
      probability: volcanicSoilDarkRange,
    },
    {
      name: "volcanic-soil-light",
      color: [58, 48, 43],
      probability: volcanicSoilLightRange,
    },
    {
      name: "volcanic-ash-soil",
      color: [48, 48, 43],
      probability: volcanicAshSoilRange,
    },
  ];
}

/** Argmax of a Vulcanus tile catalog at one point (ties keep the first in order). */
export function resolveVulcanusTile(x: number, y: number, catalog: VulcanusTile[]): VulcanusTile {
  let winner = catalog[0];
  let winnerProbability = winner.probability(x, y);
  for (let i = 1; i < catalog.length; i++) {
    const tile = catalog[i];
    const probability = tile.probability(x, y);
    if (probability > winnerProbability) {
      winner = tile;
      winnerProbability = probability;
    }
  }
  return winner;
}

/**
 * Build the full Vulcanus tile resolver for one seed/ctx: compiles the Task 7-9
 * field closures (helpers/spawn/cracks/biomes/climate/elevation) plus the two
 * task-local fields (`mountain_lava_spots`, `vulcanus_rock_noise`) and the 19-tile
 * catalog once, then returns an `(x, y) => VulcanusTile` argmax resolver.
 */
export interface VulcanusStack {
  readonly ctx: EvalCtx;
  readonly helpers: VulcanusHelpers;
  readonly spawn: ReturnType<typeof makeVulcanusSpawn>;
  readonly cracks: ReturnType<typeof makeVulcanusCracks>;
  readonly biomes: VulcanusBiomes;
  readonly climate: VulcanusClimate;
  readonly elevation: VulcanusElevation;
  readonly resources: ReturnType<typeof makeVulcanusResources>;
}

/**
 * The Vulcanus field DAG, built once. Five call sites used to build their own
 * copy of some or all of this (the tile resolver, the resource overlay, the
 * geyser placement, the rock fields, the cliff fields) - and because `memoXY`
 * is a SINGLE-ENTRY cache, separate copies share nothing at all: measured on
 * the `all` path, terrain + the three overlay marginals summed to exactly the
 * combined cost, to the evaluation. Sharing one stack is the precondition for
 * any of that work being reused; it is not sufficient on its own, because two
 * consumers also have to ask for the same (x, y) while it is still cached.
 */
export function makeVulcanusStack(input: EvalCtxInput): VulcanusStack {
  const ctx = withCtxDefaults(input);
  const helpers: VulcanusHelpers = makeVulcanusHelpers(ctx);
  const spawn = makeVulcanusSpawn(ctx, helpers);
  const cracks = makeVulcanusCracks(ctx, helpers);
  const biomes: VulcanusBiomes = makeVulcanusBiomes(ctx, helpers, spawn, cracks);
  const climate: VulcanusClimate = makeVulcanusClimate(ctx, helpers, cracks);
  const elevation: VulcanusElevation = makeVulcanusElevation(ctx, helpers, biomes, cracks, climate);
  const resources = makeVulcanusResources(ctx, helpers, spawn, biomes, cracks);
  return { ctx, helpers, spawn, cracks, biomes, climate, elevation, resources };
}

export function makeVulcanusTileResolver(
  input: EvalCtxInput,
): (x: number, y: number) => VulcanusTile {
  return makeVulcanusTileResolverFrom(makeVulcanusStack(input));
}

/** As {@link makeVulcanusTileResolver}, but over a stack the caller already built. */
export function makeVulcanusTileResolverFrom(
  stack: VulcanusStack,
): (x: number, y: number) => VulcanusTile {
  const { ctx, helpers, biomes, climate, elevation, resources } = stack;

  const mountainLavaSpots = makeMountainLavaSpots(helpers, biomes);
  const rockNoise = makeVulcanusRockNoise(ctx.seed0);

  // Field references are wrapped in arrows (not passed by reference) so the
  // closures stay bound - the same reason `distance` is an arrow.
  const fields: VulcanusTileFields = {
    elev: (x, y) => elevation.elev(x, y),
    aux: (x, y) => climate.aux(x, y),
    moisture: (x, y) => climate.moisture(x, y),
    mountainsBiome: (x, y) => biomes.mountainsBiome(x, y),
    ashlandsBiome: (x, y) => biomes.ashlandsBiome(x, y),
    basaltsBiome: (x, y) => biomes.basaltsBiome(x, y),
    mountainVolcanoSpots: (x, y) => biomes.mountainVolcanoSpots(x, y),
    mountainLavaSpots,
    rockNoise,
    distance: (x, y) => distanceFromNearestPoint(x, y, ctx.startingPositions),
    metalTile: (x, y) => resources.metalTile(x, y),
    calciteRegion: (x, y) => resources.calciteRegion(x, y),
    sulfuricAcidRegionPatchy: (x, y) => resources.sulfuricAcidRegionPatchy(x, y),
  };

  const catalog = makeVulcanusTileCatalog(fields);
  return (x: number, y: number): VulcanusTile => resolveVulcanusTile(x, y, catalog);
}
