import { describe, expect, it } from "vite-plus/test";
import { decodeExchangeString } from "../src/codec/mapExchangeString";
import { tailToNested, writeMapSettingsToTail } from "../src/model/mapSettings";
import fixtures from "./fixtures/builtin-presets.json";
import mapDefaults from "./fixtures/map-settings.example.json";

const presets = fixtures.presets as Record<string, string>;

describe("tailToNested", () => {
  it("reshapes the flat Default tail into nested sections, sampling across every section", () => {
    const tail = decodeExchangeString(presets["Default"] as string).tail;
    const { cliff, mapSettings } = tailToNested(tail);

    expect(cliff.cliffSmoothing).toBeCloseTo(1, 6);
    expect(cliff.richness).toBeCloseTo(1, 6);

    expect(mapSettings.pollution.enabled).toBe(true);
    expect(mapSettings.pollution.diffusionRatio).toBeCloseTo(0.02, 9);
    expect(mapSettings.enemyEvolution.timeFactor).toBeCloseTo(0.000004, 12);
    expect(mapSettings.enemyExpansion.maxExpansionCooldown).toBe(216000);
    expect(mapSettings.unitGroup.maxUnitGroupSize).toBe(200);
    expect(mapSettings.pathFinder.overloadLevels).toEqual([0, 100, 500]);
    expect(mapSettings.pathFinder.overloadMultipliers).toEqual([2, 3, 4]);
    expect(mapSettings.difficulty.technologyPriceMultiplier).toBe(1);
    expect(mapSettings.asteroids.maxRayPortalsExpandedPerTick).toBe(100);
    expect(mapSettings.maxFailedBehaviorCount).toBe(3);
  });

  it("Marathon has technologyPriceMultiplier 4", () => {
    const tail = decodeExchangeString(presets["Marathon"] as string).tail;
    const { mapSettings } = tailToNested(tail);
    expect(mapSettings.difficulty.technologyPriceMultiplier).toBe(4);
  });

  // Comprehensive semantic gate: every mapSettings scalar for Default must equal
  // its documented default in map-settings.example.json, section by section, with
  // one documented exception (minExpansionCooldown - see below). This is the
  // strongest single check that nothing across the whole tail is mislabeled.
  it("Default mapSettings matches map-settings.example.json defaults in every section (except minExpansionCooldown)", () => {
    const tail = decodeExchangeString(presets["Default"] as string).tail;
    const { mapSettings: m } = tailToNested(tail);

    // pollution
    const p = mapDefaults.pollution;
    expect(m.pollution.enabled).toBe(p.enabled);
    expect(m.pollution.diffusionRatio).toBeCloseTo(p.diffusion_ratio, 9);
    expect(m.pollution.minToDiffuse).toBeCloseTo(p.min_to_diffuse, 9);
    expect(m.pollution.ageing).toBeCloseTo(p.ageing, 9);
    expect(m.pollution.expectedMaxPerChunk).toBeCloseTo(p.expected_max_per_chunk, 9);
    expect(m.pollution.minToShowPerChunk).toBeCloseTo(p.min_to_show_per_chunk, 9);
    expect(m.pollution.minPollutionToDamageTrees).toBeCloseTo(p.min_pollution_to_damage_trees, 9);
    expect(m.pollution.pollutionWithMaxForestDamage).toBeCloseTo(
      p.pollution_with_max_forest_damage,
      9,
    );
    expect(m.pollution.pollutionPerTreeDamage).toBeCloseTo(p.pollution_per_tree_damage, 9);
    expect(m.pollution.pollutionRestoredPerTreeDamage).toBeCloseTo(
      p.pollution_restored_per_tree_damage,
      9,
    );
    expect(m.pollution.maxPollutionToRestoreTrees).toBeCloseTo(p.max_pollution_to_restore_trees, 9);
    expect(m.pollution.enemyAttackPollutionConsumptionModifier).toBeCloseTo(
      p.enemy_attack_pollution_consumption_modifier,
      9,
    );

    // enemy_evolution
    const ee = mapDefaults.enemy_evolution;
    expect(m.enemyEvolution.enabled).toBe(ee.enabled);
    expect(m.enemyEvolution.timeFactor).toBeCloseTo(ee.time_factor, 12);
    expect(m.enemyEvolution.destroyFactor).toBeCloseTo(ee.destroy_factor, 9);
    expect(m.enemyEvolution.pollutionFactor).toBeCloseTo(ee.pollution_factor, 12);

    // enemy_expansion - minExpansionCooldown is a documented template-vs-engine
    // divergence: the wire value is genuinely 36000, not the example.json 14400.
    const ex = mapDefaults.enemy_expansion;
    expect(m.enemyExpansion.enabled).toBe(ex.enabled);
    expect(m.enemyExpansion.maxExpansionDistance).toBe(ex.max_expansion_distance);
    expect(m.enemyExpansion.minExpansionDistance).toBe(ex.min_expansion_distance);
    expect(m.enemyExpansion.friendlyBaseInfluenceRadius).toBe(ex.friendly_base_influence_radius);
    expect(m.enemyExpansion.enemyBuildingInfluenceRadius).toBe(ex.enemy_building_influence_radius);
    expect(m.enemyExpansion.buildingCoefficient).toBeCloseTo(ex.building_coefficient, 9);
    expect(m.enemyExpansion.otherBaseCoefficient).toBeCloseTo(ex.other_base_coefficient, 9);
    expect(m.enemyExpansion.neighbouringChunkCoefficient).toBeCloseTo(
      ex.neighbouring_chunk_coefficient,
      9,
    );
    expect(m.enemyExpansion.neighbouringBaseChunkCoefficient).toBeCloseTo(
      ex.neighbouring_base_chunk_coefficient,
      9,
    );
    expect(m.enemyExpansion.maxCollidingTilesCoefficient).toBeCloseTo(
      ex.max_colliding_tiles_coefficient,
      9,
    );
    expect(m.enemyExpansion.settlerGroupMinSize).toBe(ex.settler_group_min_size);
    expect(m.enemyExpansion.settlerGroupMaxSize).toBe(ex.settler_group_max_size);
    expect(m.enemyExpansion.evolutionGroupSizeFactor).toBeCloseTo(
      ex.evolution_group_size_factor,
      9,
    );
    expect(m.enemyExpansion.minExpansionCooldown).toBe(36000); // documented divergence, NOT ex.min_expansion_cooldown (14400)
    expect(m.enemyExpansion.maxExpansionCooldown).toBe(ex.max_expansion_cooldown);

    // unit_group
    const ug = mapDefaults.unit_group;
    expect(m.unitGroup.minGroupGatheringTime).toBe(ug.min_group_gathering_time);
    expect(m.unitGroup.maxGroupGatheringTime).toBe(ug.max_group_gathering_time);
    expect(m.unitGroup.maxWaitTimeForLateMembers).toBe(ug.max_wait_time_for_late_members);
    expect(m.unitGroup.maxGroupRadius).toBeCloseTo(ug.max_group_radius, 6);
    expect(m.unitGroup.minGroupRadius).toBeCloseTo(ug.min_group_radius, 6);
    expect(m.unitGroup.maxMemberSpeedupWhenBehind).toBeCloseTo(
      ug.max_member_speedup_when_behind,
      6,
    );
    expect(m.unitGroup.maxMemberSlowdownWhenAhead).toBeCloseTo(
      ug.max_member_slowdown_when_ahead,
      6,
    );
    expect(m.unitGroup.maxGroupSlowdownFactor).toBeCloseTo(ug.max_group_slowdown_factor, 6);
    expect(m.unitGroup.maxGroupMemberFallbackFactor).toBeCloseTo(
      ug.max_group_member_fallback_factor,
      6,
    );
    expect(m.unitGroup.memberDisownDistance).toBeCloseTo(ug.member_disown_distance, 6);
    expect(m.unitGroup.tickToleranceWhenMemberArrives).toBe(ug.tick_tolerance_when_member_arrives);
    expect(m.unitGroup.maxGatheringUnitGroups).toBe(ug.max_gathering_unit_groups);
    expect(m.unitGroup.maxUnitGroupSize).toBe(ug.max_unit_group_size);

    // path_finder
    const pf = mapDefaults.path_finder;
    expect(m.pathFinder.fwd2bwdRatio).toBe(pf.fwd2bwd_ratio);
    expect(m.pathFinder.goalPressureRatio).toBeCloseTo(pf.goal_pressure_ratio, 6);
    expect(m.pathFinder.maxStepsWorkedPerTick).toBe(pf.max_steps_worked_per_tick);
    expect(m.pathFinder.maxWorkDonePerTick).toBe(pf.max_work_done_per_tick);
    expect(m.pathFinder.usePathCache).toBe(pf.use_path_cache);
    expect(m.pathFinder.shortCacheSize).toBe(pf.short_cache_size);
    expect(m.pathFinder.longCacheSize).toBe(pf.long_cache_size);
    expect(m.pathFinder.shortCacheMinCacheableDistance).toBe(pf.short_cache_min_cacheable_distance);
    expect(m.pathFinder.shortCacheMinAlgoStepsToCache).toBe(pf.short_cache_min_algo_steps_to_cache);
    expect(m.pathFinder.longCacheMinCacheableDistance).toBe(pf.long_cache_min_cacheable_distance);
    expect(m.pathFinder.cacheMaxConnectToCacheStepsMultiplier).toBe(
      pf.cache_max_connect_to_cache_steps_multiplier,
    );
    expect(m.pathFinder.cacheAcceptPathStartDistanceRatio).toBeCloseTo(
      pf.cache_accept_path_start_distance_ratio,
      6,
    );
    expect(m.pathFinder.cacheAcceptPathEndDistanceRatio).toBeCloseTo(
      pf.cache_accept_path_end_distance_ratio,
      6,
    );
    expect(m.pathFinder.negativeCacheAcceptPathStartDistanceRatio).toBeCloseTo(
      pf.negative_cache_accept_path_start_distance_ratio,
      6,
    );
    expect(m.pathFinder.negativeCacheAcceptPathEndDistanceRatio).toBeCloseTo(
      pf.negative_cache_accept_path_end_distance_ratio,
      6,
    );
    expect(m.pathFinder.cachePathStartDistanceRatingMultiplier).toBe(
      pf.cache_path_start_distance_rating_multiplier,
    );
    expect(m.pathFinder.cachePathEndDistanceRatingMultiplier).toBe(
      pf.cache_path_end_distance_rating_multiplier,
    );
    expect(m.pathFinder.staleEnemyWithSameDestinationCollisionPenalty).toBeCloseTo(
      pf.stale_enemy_with_same_destination_collision_penalty,
      6,
    );
    expect(m.pathFinder.ignoreMovingEnemyCollisionDistance).toBeCloseTo(
      pf.ignore_moving_enemy_collision_distance,
      6,
    );
    expect(m.pathFinder.enemyWithDifferentDestinationCollisionPenalty).toBeCloseTo(
      pf.enemy_with_different_destination_collision_penalty,
      6,
    );
    expect(m.pathFinder.generalEntityCollisionPenalty).toBeCloseTo(
      pf.general_entity_collision_penalty,
      6,
    );
    expect(m.pathFinder.generalEntitySubsequentCollisionPenalty).toBeCloseTo(
      pf.general_entity_subsequent_collision_penalty,
      6,
    );
    expect(m.pathFinder.extendedCollisionPenalty).toBeCloseTo(pf.extended_collision_penalty, 6);
    expect(m.pathFinder.maxClientsToAcceptAnyNewRequest).toBe(
      pf.max_clients_to_accept_any_new_request,
    );
    expect(m.pathFinder.maxClientsToAcceptShortNewRequest).toBe(
      pf.max_clients_to_accept_short_new_request,
    );
    expect(m.pathFinder.directDistanceToConsiderShortRequest).toBe(
      pf.direct_distance_to_consider_short_request,
    );
    expect(m.pathFinder.shortRequestMaxSteps).toBe(pf.short_request_max_steps);
    expect(m.pathFinder.shortRequestRatio).toBeCloseTo(pf.short_request_ratio, 6);
    expect(m.pathFinder.minStepsToCheckPathFindTermination).toBe(
      pf.min_steps_to_check_path_find_termination,
    );
    expect(m.pathFinder.startToGoalCostMultiplierToTerminatePathFind).toBeCloseTo(
      pf.start_to_goal_cost_multiplier_to_terminate_path_find,
      6,
    );
    expect(m.pathFinder.overloadLevels).toEqual(pf.overload_levels);
    expect(m.pathFinder.overloadMultipliers).toEqual(pf.overload_multipliers);
    expect(m.pathFinder.negativePathCacheDelayInterval).toBe(pf.negative_path_cache_delay_interval);

    // difficulty
    expect(m.difficulty.technologyPriceMultiplier).toBeCloseTo(
      mapDefaults.difficulty_settings.technology_price_multiplier,
      6,
    );
    expect(m.difficulty.spoilTimeModifier).toBeCloseTo(
      mapDefaults.difficulty_settings.spoil_time_modifier,
      6,
    );

    // asteroids
    expect(m.asteroids.spawningRate).toBeCloseTo(mapDefaults.asteroids.spawning_rate, 6);
    expect(m.asteroids.maxRayPortalsExpandedPerTick).toBe(
      mapDefaults.asteroids.max_ray_portals_expanded_per_tick,
    );

    // top-level
    expect(m.maxFailedBehaviorCount).toBe(mapDefaults.max_failed_behavior_count);
  });
});

describe("writeMapSettingsToTail", () => {
  it("is the inverse of tailToNested's reads (round-trips edited values)", () => {
    const tail = decodeExchangeString(presets["Default"] as string).tail;
    const { mapSettings } = tailToNested(tail);
    const edited = {
      ...mapSettings,
      enemyEvolution: { ...mapSettings.enemyEvolution, enabled: false, timeFactor: 0.5 },
      enemyExpansion: { ...mapSettings.enemyExpansion, maxExpansionDistance: 99 },
      pollution: { ...mapSettings.pollution, diffusionRatio: 0.09, minPollutionToDamageTrees: 42 },
      difficulty: { ...mapSettings.difficulty, technologyPriceMultiplier: 4 },
      asteroids: { ...mapSettings.asteroids, spawningRate: 2 },
    };

    writeMapSettingsToTail(tail, edited);
    const after = tailToNested(tail).mapSettings;

    expect(after.enemyEvolution.enabled).toBe(false);
    expect(after.enemyEvolution.timeFactor).toBe(0.5);
    expect(after.enemyExpansion.maxExpansionDistance).toBe(99);
    expect(after.pollution.diffusionRatio).toBe(0.09);
    expect(after.pollution.minPollutionToDamageTrees).toBe(42);
    expect(after.difficulty.technologyPriceMultiplier).toBe(4);
    expect(after.asteroids.spawningRate).toBe(2);
  });

  it("skips a field whose value is undefined (preserves the original)", () => {
    const tail = decodeExchangeString(presets["Default"] as string).tail;
    const original = tail["enemyEvolution.timeFactor"];
    const { mapSettings } = tailToNested(tail);
    const edited = {
      ...mapSettings,
      enemyEvolution: {
        ...mapSettings.enemyEvolution,
        timeFactor: undefined as unknown as number,
      },
    };

    writeMapSettingsToTail(tail, edited);

    expect(tail["enemyEvolution.timeFactor"]).toBe(original);
  });
});
