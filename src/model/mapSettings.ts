import type { TailBlock } from "../codec/mapExchangeString";

/**
 * Nested, typed views of the map-exchange tail, derived from the flat
 * dotted-key `TailBlock` purely for JSON export / display.
 * The `enemyEvolution` / `enemyExpansion` sections plus the Advanced-tab subset
 * of `pollution`, `difficulty`, and `asteroids` ARE round-trip editable -
 * `presetToEncodable` overlays them back onto the tail via `writeMapSettingsToTail`
 * (see that function for the exact editable keys). Every other section/field here
 * is derived read-only for JSON export / display; `Preset.opaqueTailB64` (the raw
 * serialized tail) remains the round-trip source of truth for those, so encoding
 * stays byte-exact and independent of these views. `cliff.unknownFloat`,
 * `pathFinder.trailingA`, and `opaqueTail` are byte-level round-trip artifacts,
 * not JSON fields, and are intentionally excluded here.
 */

export interface CliffSettings {
  name: string;
  control: string;
  cliffElevation0: number;
  cliffElevationInterval: number;
  cliffSmoothing: number;
  richness: number;
}

export interface PollutionSettings {
  enabled: boolean;
  diffusionRatio: number;
  minToDiffuse: number;
  ageing: number;
  expectedMaxPerChunk: number;
  minToShowPerChunk: number;
  minPollutionToDamageTrees: number;
  pollutionWithMaxForestDamage: number;
  pollutionPerTreeDamage: number;
  pollutionRestoredPerTreeDamage: number;
  /**
   * `undefined` for a 2.1.19 (or later) import. Factorio 2.1.18 removed
   * `PollutionSettings::max_pollution_to_restore_trees` from the game and from
   * the exchange string's tail; older strings still carry it, and it round-trips
   * through them untouched. Nothing in the UI edits it.
   */
  maxPollutionToRestoreTrees: number | undefined;
  enemyAttackPollutionConsumptionModifier: number;
}

export interface EnemyEvolutionSettings {
  enabled: boolean;
  timeFactor: number;
  destroyFactor: number;
  pollutionFactor: number;
}

export interface EnemyExpansionSettings {
  enabled: boolean;
  maxExpansionDistance: number;
  minExpansionDistance: number;
  friendlyBaseInfluenceRadius: number;
  enemyBuildingInfluenceRadius: number;
  buildingCoefficient: number;
  otherBaseCoefficient: number;
  neighbouringChunkCoefficient: number;
  neighbouringBaseChunkCoefficient: number;
  maxCollidingTilesCoefficient: number;
  settlerGroupMinSize: number;
  settlerGroupMaxSize: number;
  evolutionGroupSizeFactor: number;
  minExpansionCooldown: number;
  maxExpansionCooldown: number;
}

export interface UnitGroupSettings {
  minGroupGatheringTime: number;
  maxGroupGatheringTime: number;
  maxWaitTimeForLateMembers: number;
  maxGroupRadius: number;
  minGroupRadius: number;
  maxMemberSpeedupWhenBehind: number;
  maxMemberSlowdownWhenAhead: number;
  maxGroupSlowdownFactor: number;
  maxGroupMemberFallbackFactor: number;
  memberDisownDistance: number;
  tickToleranceWhenMemberArrives: number;
  maxGatheringUnitGroups: number;
  maxUnitGroupSize: number;
}

export interface PathFinderSettings {
  fwd2bwdRatio: number;
  goalPressureRatio: number;
  maxStepsWorkedPerTick: number;
  maxWorkDonePerTick: number;
  usePathCache: boolean;
  shortCacheSize: number;
  longCacheSize: number;
  shortCacheMinCacheableDistance: number;
  shortCacheMinAlgoStepsToCache: number;
  longCacheMinCacheableDistance: number;
  cacheMaxConnectToCacheStepsMultiplier: number;
  cacheAcceptPathStartDistanceRatio: number;
  cacheAcceptPathEndDistanceRatio: number;
  negativeCacheAcceptPathStartDistanceRatio: number;
  negativeCacheAcceptPathEndDistanceRatio: number;
  cachePathStartDistanceRatingMultiplier: number;
  cachePathEndDistanceRatingMultiplier: number;
  staleEnemyWithSameDestinationCollisionPenalty: number;
  ignoreMovingEnemyCollisionDistance: number;
  enemyWithDifferentDestinationCollisionPenalty: number;
  generalEntityCollisionPenalty: number;
  generalEntitySubsequentCollisionPenalty: number;
  extendedCollisionPenalty: number;
  maxClientsToAcceptAnyNewRequest: number;
  maxClientsToAcceptShortNewRequest: number;
  directDistanceToConsiderShortRequest: number;
  shortRequestMaxSteps: number;
  shortRequestRatio: number;
  minStepsToCheckPathFindTermination: number;
  startToGoalCostMultiplierToTerminatePathFind: number;
  overloadLevels: number[];
  overloadMultipliers: number[];
  negativePathCacheDelayInterval: number;
}

export interface DifficultySettings {
  technologyPriceMultiplier: number;
  spoilTimeModifier: number;
}

export interface AsteroidsSettings {
  spawningRate: number;
  maxRayPortalsExpandedPerTick: number;
}

export interface MapSettings {
  pollution: PollutionSettings;
  enemyEvolution: EnemyEvolutionSettings;
  enemyExpansion: EnemyExpansionSettings;
  unitGroup: UnitGroupSettings;
  pathFinder: PathFinderSettings;
  difficulty: DifficultySettings;
  asteroids: AsteroidsSettings;
  maxFailedBehaviorCount: number;
}

/**
 * Reshape the flat dotted-key tail into nested, JSON-serializable views for
 * export/display. Reads each known dotted key explicitly (rather than a
 * blind generic split) so byte-level round-trip artifacts -
 * `cliff.unknownFloat`, `pathFinder.trailingA`, and `opaqueTail` - are never
 * dragged into the result.
 */
export function tailToNested(tail: TailBlock): { cliff: CliffSettings; mapSettings: MapSettings } {
  const cliff: CliffSettings = {
    name: tail["cliff.name"] as string,
    control: tail["cliff.control"] as string,
    cliffElevation0: tail["cliff.cliffElevation0"] as number,
    cliffElevationInterval: tail["cliff.cliffElevationInterval"] as number,
    cliffSmoothing: tail["cliff.cliffSmoothing"] as number,
    richness: tail["cliff.richness"] as number,
  };

  const mapSettings: MapSettings = {
    pollution: {
      enabled: tail["pollution.enabled"] as boolean,
      diffusionRatio: tail["pollution.diffusionRatio"] as number,
      minToDiffuse: tail["pollution.minToDiffuse"] as number,
      ageing: tail["pollution.ageing"] as number,
      expectedMaxPerChunk: tail["pollution.expectedMaxPerChunk"] as number,
      minToShowPerChunk: tail["pollution.minToShowPerChunk"] as number,
      minPollutionToDamageTrees: tail["pollution.minPollutionToDamageTrees"] as number,
      pollutionWithMaxForestDamage: tail["pollution.pollutionWithMaxForestDamage"] as number,
      pollutionPerTreeDamage: tail["pollution.pollutionPerTreeDamage"] as number,
      pollutionRestoredPerTreeDamage: tail["pollution.pollutionRestoredPerTreeDamage"] as number,
      maxPollutionToRestoreTrees: tail["pollution.maxPollutionToRestoreTrees"] as
        | number
        | undefined,
      enemyAttackPollutionConsumptionModifier: tail[
        "pollution.enemyAttackPollutionConsumptionModifier"
      ] as number,
    },
    enemyEvolution: {
      enabled: tail["enemyEvolution.enabled"] as boolean,
      timeFactor: tail["enemyEvolution.timeFactor"] as number,
      destroyFactor: tail["enemyEvolution.destroyFactor"] as number,
      pollutionFactor: tail["enemyEvolution.pollutionFactor"] as number,
    },
    enemyExpansion: {
      enabled: tail["enemyExpansion.enabled"] as boolean,
      maxExpansionDistance: tail["enemyExpansion.maxExpansionDistance"] as number,
      minExpansionDistance: tail["enemyExpansion.minExpansionDistance"] as number,
      friendlyBaseInfluenceRadius: tail["enemyExpansion.friendlyBaseInfluenceRadius"] as number,
      enemyBuildingInfluenceRadius: tail["enemyExpansion.enemyBuildingInfluenceRadius"] as number,
      buildingCoefficient: tail["enemyExpansion.buildingCoefficient"] as number,
      otherBaseCoefficient: tail["enemyExpansion.otherBaseCoefficient"] as number,
      neighbouringChunkCoefficient: tail["enemyExpansion.neighbouringChunkCoefficient"] as number,
      neighbouringBaseChunkCoefficient: tail[
        "enemyExpansion.neighbouringBaseChunkCoefficient"
      ] as number,
      maxCollidingTilesCoefficient: tail["enemyExpansion.maxCollidingTilesCoefficient"] as number,
      settlerGroupMinSize: tail["enemyExpansion.settlerGroupMinSize"] as number,
      settlerGroupMaxSize: tail["enemyExpansion.settlerGroupMaxSize"] as number,
      evolutionGroupSizeFactor: tail["enemyExpansion.evolutionGroupSizeFactor"] as number,
      minExpansionCooldown: tail["enemyExpansion.minExpansionCooldown"] as number,
      maxExpansionCooldown: tail["enemyExpansion.maxExpansionCooldown"] as number,
    },
    unitGroup: {
      minGroupGatheringTime: tail["unitGroup.minGroupGatheringTime"] as number,
      maxGroupGatheringTime: tail["unitGroup.maxGroupGatheringTime"] as number,
      maxWaitTimeForLateMembers: tail["unitGroup.maxWaitTimeForLateMembers"] as number,
      maxGroupRadius: tail["unitGroup.maxGroupRadius"] as number,
      minGroupRadius: tail["unitGroup.minGroupRadius"] as number,
      maxMemberSpeedupWhenBehind: tail["unitGroup.maxMemberSpeedupWhenBehind"] as number,
      maxMemberSlowdownWhenAhead: tail["unitGroup.maxMemberSlowdownWhenAhead"] as number,
      maxGroupSlowdownFactor: tail["unitGroup.maxGroupSlowdownFactor"] as number,
      maxGroupMemberFallbackFactor: tail["unitGroup.maxGroupMemberFallbackFactor"] as number,
      memberDisownDistance: tail["unitGroup.memberDisownDistance"] as number,
      tickToleranceWhenMemberArrives: tail["unitGroup.tickToleranceWhenMemberArrives"] as number,
      maxGatheringUnitGroups: tail["unitGroup.maxGatheringUnitGroups"] as number,
      maxUnitGroupSize: tail["unitGroup.maxUnitGroupSize"] as number,
    },
    pathFinder: {
      fwd2bwdRatio: tail["pathFinder.fwd2bwdRatio"] as number,
      goalPressureRatio: tail["pathFinder.goalPressureRatio"] as number,
      maxStepsWorkedPerTick: tail["pathFinder.maxStepsWorkedPerTick"] as number,
      maxWorkDonePerTick: tail["pathFinder.maxWorkDonePerTick"] as number,
      usePathCache: tail["pathFinder.usePathCache"] as boolean,
      shortCacheSize: tail["pathFinder.shortCacheSize"] as number,
      longCacheSize: tail["pathFinder.longCacheSize"] as number,
      shortCacheMinCacheableDistance: tail["pathFinder.shortCacheMinCacheableDistance"] as number,
      shortCacheMinAlgoStepsToCache: tail["pathFinder.shortCacheMinAlgoStepsToCache"] as number,
      longCacheMinCacheableDistance: tail["pathFinder.longCacheMinCacheableDistance"] as number,
      cacheMaxConnectToCacheStepsMultiplier: tail[
        "pathFinder.cacheMaxConnectToCacheStepsMultiplier"
      ] as number,
      cacheAcceptPathStartDistanceRatio: tail[
        "pathFinder.cacheAcceptPathStartDistanceRatio"
      ] as number,
      cacheAcceptPathEndDistanceRatio: tail["pathFinder.cacheAcceptPathEndDistanceRatio"] as number,
      negativeCacheAcceptPathStartDistanceRatio: tail[
        "pathFinder.negativeCacheAcceptPathStartDistanceRatio"
      ] as number,
      negativeCacheAcceptPathEndDistanceRatio: tail[
        "pathFinder.negativeCacheAcceptPathEndDistanceRatio"
      ] as number,
      cachePathStartDistanceRatingMultiplier: tail[
        "pathFinder.cachePathStartDistanceRatingMultiplier"
      ] as number,
      cachePathEndDistanceRatingMultiplier: tail[
        "pathFinder.cachePathEndDistanceRatingMultiplier"
      ] as number,
      staleEnemyWithSameDestinationCollisionPenalty: tail[
        "pathFinder.staleEnemyWithSameDestinationCollisionPenalty"
      ] as number,
      ignoreMovingEnemyCollisionDistance: tail[
        "pathFinder.ignoreMovingEnemyCollisionDistance"
      ] as number,
      enemyWithDifferentDestinationCollisionPenalty: tail[
        "pathFinder.enemyWithDifferentDestinationCollisionPenalty"
      ] as number,
      generalEntityCollisionPenalty: tail["pathFinder.generalEntityCollisionPenalty"] as number,
      generalEntitySubsequentCollisionPenalty: tail[
        "pathFinder.generalEntitySubsequentCollisionPenalty"
      ] as number,
      extendedCollisionPenalty: tail["pathFinder.extendedCollisionPenalty"] as number,
      maxClientsToAcceptAnyNewRequest: tail["pathFinder.maxClientsToAcceptAnyNewRequest"] as number,
      maxClientsToAcceptShortNewRequest: tail[
        "pathFinder.maxClientsToAcceptShortNewRequest"
      ] as number,
      directDistanceToConsiderShortRequest: tail[
        "pathFinder.directDistanceToConsiderShortRequest"
      ] as number,
      shortRequestMaxSteps: tail["pathFinder.shortRequestMaxSteps"] as number,
      shortRequestRatio: tail["pathFinder.shortRequestRatio"] as number,
      minStepsToCheckPathFindTermination: tail[
        "pathFinder.minStepsToCheckPathFindTermination"
      ] as number,
      startToGoalCostMultiplierToTerminatePathFind: tail[
        "pathFinder.startToGoalCostMultiplierToTerminatePathFind"
      ] as number,
      overloadLevels: tail["pathFinder.overloadLevels"] as number[],
      overloadMultipliers: tail["pathFinder.overloadMultipliers"] as number[],
      negativePathCacheDelayInterval: tail["pathFinder.negativePathCacheDelayInterval"] as number,
    },
    difficulty: {
      technologyPriceMultiplier: tail["difficulty.technologyPriceMultiplier"] as number,
      spoilTimeModifier: tail["difficulty.spoilTimeModifier"] as number,
    },
    asteroids: {
      spawningRate: tail["asteroids.spawningRate"] as number,
      maxRayPortalsExpandedPerTick: tail["asteroids.maxRayPortalsExpandedPerTick"] as number,
    },
    maxFailedBehaviorCount: tail["maxFailedBehaviorCount"] as number,
  };

  return { cliff, mapSettings };
}

/**
 * Overlay the round-trip-editable MapSettings sections back onto a flat
 * `TailBlock` - the inverse of the corresponding reads in `tailToNested`.
 *
 * Writes ONLY these keys: the full enemyEvolution / enemyExpansion sections,
 * plus the hand-picked Advanced-tab subset of pollution
 * (enabled, ageing, enemyAttackPollutionConsumptionModifier,
 * minPollutionToDamageTrees, pollutionRestoredPerTreeDamage, diffusionRatio),
 * difficulty (technologyPriceMultiplier, spoilTimeModifier), and asteroids
 * (spawningRate). It deliberately does NOT touch unitGroup, pathFinder, or the
 * other pollution/difficulty keys - those stay carried opaquely via
 * `opaqueTailB64`. Do not assume the "map settings" name means every section is
 * handled; wiring a new control means adding its key here first.
 *
 * A field is copied only when `value !== undefined`, so a field that decoded
 * genuinely absent is not spuriously added. (Optional tail fields decode to
 * `null`, not `undefined`; `null` is copied and re-emitted as presence-byte 0,
 * still byte-exact.) A `false` / `0` edit IS written - that is the point of the
 * undefined-check rather than a truthiness check.
 *
 * Used by `presetToEncodable` to make these sections round-trip-editable while
 * every other tail byte round-trips unchanged from `opaqueTailB64`.
 */
export function writeMapSettingsToTail(tail: TailBlock, mapSettings: MapSettings): void {
  const put = (key: string, value: number | boolean | undefined) => {
    if (value !== undefined) tail[key] = value;
  };
  const { enemyEvolution, enemyExpansion, pollution, difficulty, asteroids } = mapSettings;

  put("enemyEvolution.enabled", enemyEvolution.enabled);
  put("enemyEvolution.timeFactor", enemyEvolution.timeFactor);
  put("enemyEvolution.destroyFactor", enemyEvolution.destroyFactor);
  put("enemyEvolution.pollutionFactor", enemyEvolution.pollutionFactor);

  put("enemyExpansion.enabled", enemyExpansion.enabled);
  put("enemyExpansion.maxExpansionDistance", enemyExpansion.maxExpansionDistance);
  put("enemyExpansion.minExpansionDistance", enemyExpansion.minExpansionDistance);
  put("enemyExpansion.friendlyBaseInfluenceRadius", enemyExpansion.friendlyBaseInfluenceRadius);
  put("enemyExpansion.enemyBuildingInfluenceRadius", enemyExpansion.enemyBuildingInfluenceRadius);
  put("enemyExpansion.buildingCoefficient", enemyExpansion.buildingCoefficient);
  put("enemyExpansion.otherBaseCoefficient", enemyExpansion.otherBaseCoefficient);
  put("enemyExpansion.neighbouringChunkCoefficient", enemyExpansion.neighbouringChunkCoefficient);
  put(
    "enemyExpansion.neighbouringBaseChunkCoefficient",
    enemyExpansion.neighbouringBaseChunkCoefficient,
  );
  put("enemyExpansion.maxCollidingTilesCoefficient", enemyExpansion.maxCollidingTilesCoefficient);
  put("enemyExpansion.settlerGroupMinSize", enemyExpansion.settlerGroupMinSize);
  put("enemyExpansion.settlerGroupMaxSize", enemyExpansion.settlerGroupMaxSize);
  put("enemyExpansion.evolutionGroupSizeFactor", enemyExpansion.evolutionGroupSizeFactor);
  put("enemyExpansion.minExpansionCooldown", enemyExpansion.minExpansionCooldown);
  put("enemyExpansion.maxExpansionCooldown", enemyExpansion.maxExpansionCooldown);

  put("pollution.enabled", pollution.enabled);
  put("pollution.ageing", pollution.ageing);
  put(
    "pollution.enemyAttackPollutionConsumptionModifier",
    pollution.enemyAttackPollutionConsumptionModifier,
  );
  put("pollution.minPollutionToDamageTrees", pollution.minPollutionToDamageTrees);
  // The map-gen GUI's "Absorbed per damaged tree" tracks this field (confirmed
  // by an in-game sentinel-import check), not pollutionPerTreeDamage.
  put("pollution.pollutionRestoredPerTreeDamage", pollution.pollutionRestoredPerTreeDamage);
  put("pollution.diffusionRatio", pollution.diffusionRatio);

  put("difficulty.technologyPriceMultiplier", difficulty.technologyPriceMultiplier);
  put("difficulty.spoilTimeModifier", difficulty.spoilTimeModifier);

  put("asteroids.spawningRate", asteroids.spawningRate);
}
