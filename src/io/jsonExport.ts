import type { Preset } from "../model/types";

/**
 * Build the two Factorio JSON documents from a typed `Preset`.
 *
 * The game consumes `map-gen-settings.json` (terrain/resources/cliffs) and
 * `map-settings.json` (pollution, enemies, pathfinder, ...) as snake_case
 * objects. `Preset` carries these as camelCase nested views (`cliffSettings`,
 * `mapSettings`) plus the raw autoplace/property maps. These two functions are
 * pure key-renames from camelCase to the game's snake_case shape; no bytes.
 *
 * The autoplace_settings dict is still opaque and is emitted as its
 * corpus-constant default (empty) so the JSON is a complete, valid game
 * document. peaceful_mode, no_enemies_mode and starting_points are decoded and
 * carried through on the Preset.
 */

export function toMapGenSettingsJson(preset: Preset): object {
  const c = preset.cliffSettings;
  return {
    width: preset.width,
    height: preset.height,
    starting_area: preset.startingArea,
    peaceful_mode: preset.peacefulMode,
    no_enemies_mode: preset.noEnemiesMode,
    default_enable_all_autoplace_controls: preset.defaultEnableAllAutoplaceControls,
    autoplace_controls: Object.fromEntries(
      Object.entries(preset.autoplaceControls).map(([name, s]) => [
        name,
        { frequency: s.frequency, size: s.size, richness: s.richness },
      ]),
    ),
    cliff_settings: {
      name: c.name,
      control: c.control,
      cliff_elevation_0: c.cliffElevation0,
      cliff_elevation_interval: c.cliffElevationInterval,
      cliff_smoothing: c.cliffSmoothing,
      richness: c.richness,
    },
    property_expression_names: { ...preset.propertyExpressionNames },
    starting_points: preset.startingPoints.map((p) => ({ x: p.x, y: p.y })),
    seed: preset.seed,
  };
}

export function toMapSettingsJson(preset: Preset): object {
  const m = preset.mapSettings;
  return {
    difficulty_settings: {
      technology_price_multiplier: m.difficulty.technologyPriceMultiplier,
      spoil_time_modifier: m.difficulty.spoilTimeModifier,
    },
    pollution: {
      enabled: m.pollution.enabled,
      diffusion_ratio: m.pollution.diffusionRatio,
      min_to_diffuse: m.pollution.minToDiffuse,
      ageing: m.pollution.ageing,
      expected_max_per_chunk: m.pollution.expectedMaxPerChunk,
      min_to_show_per_chunk: m.pollution.minToShowPerChunk,
      min_pollution_to_damage_trees: m.pollution.minPollutionToDamageTrees,
      pollution_with_max_forest_damage: m.pollution.pollutionWithMaxForestDamage,
      pollution_per_tree_damage: m.pollution.pollutionPerTreeDamage,
      pollution_restored_per_tree_damage: m.pollution.pollutionRestoredPerTreeDamage,
      // Gone from the game at 2.1.18, so a 2.1.19 import has no value to emit
      // and the key is left out rather than written as null.
      ...(m.pollution.maxPollutionToRestoreTrees === undefined
        ? {}
        : { max_pollution_to_restore_trees: m.pollution.maxPollutionToRestoreTrees }),
      enemy_attack_pollution_consumption_modifier:
        m.pollution.enemyAttackPollutionConsumptionModifier,
    },
    // `steering` is a real Factorio MapSettings section but is NOT carried by
    // the map-exchange string (the decoded tail closes to zero bytes without
    // it), so there is no per-preset data to surface. Emit the game defaults as
    // a constant, matching the other JSON-only fields, so the exported
    // map-settings.json is a complete, valid document.
    steering: {
      default: {
        radius: 1.2,
        separation_force: 0.005,
        separation_factor: 1.2,
        force_unit_fuzzy_goto_behavior: false,
      },
      moving: {
        radius: 3,
        separation_force: 0.01,
        separation_factor: 3,
        force_unit_fuzzy_goto_behavior: false,
      },
    },
    enemy_evolution: {
      enabled: m.enemyEvolution.enabled,
      time_factor: m.enemyEvolution.timeFactor,
      destroy_factor: m.enemyEvolution.destroyFactor,
      pollution_factor: m.enemyEvolution.pollutionFactor,
    },
    enemy_expansion: {
      enabled: m.enemyExpansion.enabled,
      max_expansion_distance: m.enemyExpansion.maxExpansionDistance,
      min_expansion_distance: m.enemyExpansion.minExpansionDistance,
      friendly_base_influence_radius: m.enemyExpansion.friendlyBaseInfluenceRadius,
      enemy_building_influence_radius: m.enemyExpansion.enemyBuildingInfluenceRadius,
      building_coefficient: m.enemyExpansion.buildingCoefficient,
      other_base_coefficient: m.enemyExpansion.otherBaseCoefficient,
      neighbouring_chunk_coefficient: m.enemyExpansion.neighbouringChunkCoefficient,
      neighbouring_base_chunk_coefficient: m.enemyExpansion.neighbouringBaseChunkCoefficient,
      max_colliding_tiles_coefficient: m.enemyExpansion.maxCollidingTilesCoefficient,
      settler_group_min_size: m.enemyExpansion.settlerGroupMinSize,
      settler_group_max_size: m.enemyExpansion.settlerGroupMaxSize,
      evolution_group_size_factor: m.enemyExpansion.evolutionGroupSizeFactor,
      min_expansion_cooldown: m.enemyExpansion.minExpansionCooldown,
      max_expansion_cooldown: m.enemyExpansion.maxExpansionCooldown,
    },
    unit_group: {
      min_group_gathering_time: m.unitGroup.minGroupGatheringTime,
      max_group_gathering_time: m.unitGroup.maxGroupGatheringTime,
      max_wait_time_for_late_members: m.unitGroup.maxWaitTimeForLateMembers,
      max_group_radius: m.unitGroup.maxGroupRadius,
      min_group_radius: m.unitGroup.minGroupRadius,
      max_member_speedup_when_behind: m.unitGroup.maxMemberSpeedupWhenBehind,
      max_member_slowdown_when_ahead: m.unitGroup.maxMemberSlowdownWhenAhead,
      max_group_slowdown_factor: m.unitGroup.maxGroupSlowdownFactor,
      max_group_member_fallback_factor: m.unitGroup.maxGroupMemberFallbackFactor,
      member_disown_distance: m.unitGroup.memberDisownDistance,
      tick_tolerance_when_member_arrives: m.unitGroup.tickToleranceWhenMemberArrives,
      max_gathering_unit_groups: m.unitGroup.maxGatheringUnitGroups,
      max_unit_group_size: m.unitGroup.maxUnitGroupSize,
    },
    path_finder: {
      fwd2bwd_ratio: m.pathFinder.fwd2bwdRatio,
      goal_pressure_ratio: m.pathFinder.goalPressureRatio,
      max_steps_worked_per_tick: m.pathFinder.maxStepsWorkedPerTick,
      max_work_done_per_tick: m.pathFinder.maxWorkDonePerTick,
      use_path_cache: m.pathFinder.usePathCache,
      short_cache_size: m.pathFinder.shortCacheSize,
      long_cache_size: m.pathFinder.longCacheSize,
      short_cache_min_cacheable_distance: m.pathFinder.shortCacheMinCacheableDistance,
      short_cache_min_algo_steps_to_cache: m.pathFinder.shortCacheMinAlgoStepsToCache,
      long_cache_min_cacheable_distance: m.pathFinder.longCacheMinCacheableDistance,
      cache_max_connect_to_cache_steps_multiplier:
        m.pathFinder.cacheMaxConnectToCacheStepsMultiplier,
      cache_accept_path_start_distance_ratio: m.pathFinder.cacheAcceptPathStartDistanceRatio,
      cache_accept_path_end_distance_ratio: m.pathFinder.cacheAcceptPathEndDistanceRatio,
      negative_cache_accept_path_start_distance_ratio:
        m.pathFinder.negativeCacheAcceptPathStartDistanceRatio,
      negative_cache_accept_path_end_distance_ratio:
        m.pathFinder.negativeCacheAcceptPathEndDistanceRatio,
      cache_path_start_distance_rating_multiplier:
        m.pathFinder.cachePathStartDistanceRatingMultiplier,
      cache_path_end_distance_rating_multiplier: m.pathFinder.cachePathEndDistanceRatingMultiplier,
      stale_enemy_with_same_destination_collision_penalty:
        m.pathFinder.staleEnemyWithSameDestinationCollisionPenalty,
      ignore_moving_enemy_collision_distance: m.pathFinder.ignoreMovingEnemyCollisionDistance,
      enemy_with_different_destination_collision_penalty:
        m.pathFinder.enemyWithDifferentDestinationCollisionPenalty,
      general_entity_collision_penalty: m.pathFinder.generalEntityCollisionPenalty,
      general_entity_subsequent_collision_penalty:
        m.pathFinder.generalEntitySubsequentCollisionPenalty,
      extended_collision_penalty: m.pathFinder.extendedCollisionPenalty,
      max_clients_to_accept_any_new_request: m.pathFinder.maxClientsToAcceptAnyNewRequest,
      max_clients_to_accept_short_new_request: m.pathFinder.maxClientsToAcceptShortNewRequest,
      direct_distance_to_consider_short_request: m.pathFinder.directDistanceToConsiderShortRequest,
      short_request_max_steps: m.pathFinder.shortRequestMaxSteps,
      short_request_ratio: m.pathFinder.shortRequestRatio,
      min_steps_to_check_path_find_termination: m.pathFinder.minStepsToCheckPathFindTermination,
      start_to_goal_cost_multiplier_to_terminate_path_find:
        m.pathFinder.startToGoalCostMultiplierToTerminatePathFind,
      overload_levels: [...m.pathFinder.overloadLevels],
      overload_multipliers: [...m.pathFinder.overloadMultipliers],
      negative_path_cache_delay_interval: m.pathFinder.negativePathCacheDelayInterval,
    },
    asteroids: {
      spawning_rate: m.asteroids.spawningRate,
      max_ray_portals_expanded_per_tick: m.asteroids.maxRayPortalsExpandedPerTick,
    },
    max_failed_behavior_count: m.maxFailedBehaviorCount,
  };
}
