import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { bytesToBase64 } from "../src/codec/base64";
import { crc32 } from "../src/codec/crc32";
import { deflateLevel9 } from "../src/codec/deflate";
import {
  decodeExchangeString,
  encodeExchangeString,
  encodePayload,
  ExchangeStringError,
  tailToBytes,
} from "../src/codec/mapExchangeString";
import fixtures from "./fixtures/builtin-presets.json";
import mapExchangeParsed from "./fixtures/map-exchange-parsed.default-seed123456.dump.json";
import nauvisDump from "./fixtures/map-gen-settings.default-nauvis.dump.json";
import mapDefaults from "./fixtures/map-settings.example.json";

const presets = fixtures.presets as Record<string, string>;
const NAMES = Object.keys(presets);

// Positive single-toggle fixtures (captured from Factorio 2.1.9): the Default
// preset with exactly one enemy toggle flipped. They pin the peaceful_mode and
// no_enemies_mode byte offsets, which are byte-identical (false) across all 9
// builtins on their own.
const peacefulFixture = readFileSync("test/fixtures/defaultgenwithpeaceful.txt", "utf8").trim();
const noEnemiesFixture = readFileSync(
  "test/fixtures/defaultmodenoenemiespeacefulunchecked.txt",
  "utf8",
).trim();

// Ground-truth starting_points fixtures (captured from Factorio 2.1.9, seed
// 123456): minimal Space-Age maps that differ only in starting_points, which
// pins the variable-length mid-block trailer.
const startingPointFixtures: [string, string, { x: number; y: number }[]][] = [
  ["origin", "test/fixtures/starting-points-1-origin.txt", [{ x: 0, y: 0 }]],
  ["x450", "test/fixtures/starting-points-1-x450.txt", [{ x: 450, y: 0 }]],
  ["y450", "test/fixtures/starting-points-1-y450.txt", [{ x: 0, y: 450 }]],
  [
    "2pt",
    "test/fixtures/starting-points-2pt.txt",
    [
      { x: 0, y: 0 },
      { x: 450, y: 0 },
    ],
  ],
];

describe("decodeExchangeString", () => {
  it.each(NAMES)("decodes %s as format 2.1.9.3 with a valid CRC", (name) => {
    const decoded = decodeExchangeString(presets[name] as string);
    expect(decoded.version).toEqual([2, 1, 9, 3]);
    expect(decoded.flagByte).toBe(0);
  });

  it.each(NAMES)("payload size of %s matches the recorded _decodeStatus", (name) => {
    const status = (fixtures._decodeStatus as Record<string, string>)[name] as string;
    const expectedSize = Number(/\((\d+) bytes/.exec(status)?.[1]);
    expect(decodeExchangeString(presets[name] as string).payload.length).toBe(expectedSize);
  });

  it("ignores whitespace/newlines inside the base64 body", () => {
    const wrapped = presets["Default"] as string;
    const compact = wrapped.replaceAll(/\s+/g, "");
    const rewrapped = `>>>\n${compact.slice(3, -3).replaceAll(/(.{57})/g, "$1\n")}\n<<<`;
    expect(decodeExchangeString(rewrapped).payload).toEqual(decodeExchangeString(wrapped).payload);
  });

  it("reads 28 autoplace controls from Default, in ordinal key order", () => {
    const controls = decodeExchangeString(presets["Default"] as string).autoplaceControls;
    const keys = Object.keys(controls);
    expect(keys).toHaveLength(28);
    // Wire order is ordinal (code-point) sorted; JS default sort is code-unit
    // order, identical for these ASCII names ('-' 0x2d sorts before '_' 0x5f).
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("coal");
    expect(keys).toContain("vulcanus_coal");
    expect(keys).toContain("aquilo_crude_oil");
    expect(controls["coal"]).toEqual({ frequency: 1, size: 1, richness: 1 });
  });

  it("Rich Resources differs from Default exactly by richness 2.0 on the six nauvis resources", () => {
    const def = decodeExchangeString(presets["Default"] as string).autoplaceControls;
    const rich = decodeExchangeString(presets["Rich Resources"] as string).autoplaceControls;
    expect(Object.keys(rich)).toEqual(Object.keys(def));
    const changed: string[] = [];
    for (const [name, value] of Object.entries(rich)) {
      const base = def[name] as (typeof rich)[string];
      if (
        value.frequency !== base.frequency ||
        value.size !== base.size ||
        value.richness !== base.richness
      ) {
        changed.push(name);
        expect(value.frequency).toBe(base.frequency);
        expect(value.size).toBe(base.size);
        expect(value.richness).toBe(2);
      }
    }
    expect(changed.sort()).toEqual([
      "coal",
      "copper-ore",
      "crude-oil",
      "iron-ore",
      "stone",
      "uranium-ore",
    ]);
  });

  it.each(NAMES)(
    "mid block of %s splits into count + defaultEnable + seed + width + height + areaToGenerateAtStart + startingArea + peaceful + noEnemies + startingPoints",
    (name) => {
      const mid = decodeExchangeString(presets[name] as string).mid;
      expect(mid.autoplaceSettingsCount).toBe(0);
      expect(typeof mid.defaultEnableAllAutoplaceControls).toBe("boolean");
      expect(mid.areaToGenerateAtStart.leftTop).toEqual({ x: -224, y: -224 });
      expect(mid.areaToGenerateAtStart.rightBottom).toEqual({ x: 224, y: 224 });
      expect(mid.areaToGenerateAtStart.trailer.length).toBe(4);
      expect(mid.startingPoints).toEqual([{ x: 0, y: 0 }]);
      expect(mid.width).toBe(2000000);
      expect(typeof mid.seed).toBe("number");
      expect(typeof mid.startingArea).toBe("number");
      expect(typeof mid.peacefulMode).toBe("boolean");
      expect(typeof mid.noEnemiesMode).toBe("boolean");
    },
  );

  it("types seed and starting_area from the mid-block", () => {
    const mid = decodeExchangeString(presets["Default"] as string).mid;
    expect(mid.seed).toBe(34658944); // 0x0210DA80, Default's baked seed
    expect(mid.startingArea).toBeCloseTo(1.0, 6);
    expect(mid.startingPoints).toEqual([{ x: 0, y: 0 }]);
  });

  it("types area_to_generate_at_start as the constant (-224,-224)-(+224,+224) box for every sample", () => {
    // area_to_generate_at_start is a vestigial engine field: it is absent from the
    // 2.x MapGenSettings Lua type and from helpers.parse_map_exchange_string, and
    // is byte-identical across the whole corpus and across generated fixtures that
    // vary starting_area (up to 5.0), map size (down to 64x64) and starting_points.
    // The two corners use the same 0x7fff-sentinel + absolute-int32 MapPosition
    // encoding validated against the game for starting_points.
    const samples = [
      ...NAMES.map((n) => presets[n] as string),
      ...startingPointFixtures.map(([, path]) => readFileSync(path, "utf8").trim()),
      readFileSync("test/fixtures/starting-area-5.txt", "utf8").trim(),
      readFileSync("test/fixtures/map-64x64.txt", "utf8").trim(),
    ];
    for (const s of samples) {
      const area = decodeExchangeString(s).mid.areaToGenerateAtStart;
      expect(area.leftTop).toEqual({ x: -224, y: -224 });
      expect(area.rightBottom).toEqual({ x: 224, y: 224 });
      expect([...area.trailer]).toEqual([0x00, 0x00, 0x01, 0x80]);
    }
  });

  it("decodes peaceful_mode and no_enemies_mode as false for every builtin", () => {
    for (const name of NAMES) {
      const mid = decodeExchangeString(presets[name] as string).mid;
      expect(mid.peacefulMode).toBe(false);
      expect(mid.noEnemiesMode).toBe(false);
    }
  });

  it("types the mid-block head: autoplace_settings count 0, default_enable_all_autoplace_controls true", () => {
    for (const name of NAMES) {
      const mid = decodeExchangeString(presets[name] as string).mid;
      expect(mid.autoplaceSettingsCount).toBe(0);
      expect(mid.defaultEnableAllAutoplaceControls).toBe(true);
    }
  });

  it("rejects a payload with a non-empty autoplace_settings dict (unsupported by the fixed schema)", () => {
    const decoded = decodeExchangeString(presets["Default"] as string);
    const tampered = {
      ...decoded,
      mid: { ...decoded.mid, autoplaceSettingsCount: 1 },
    };
    const restrung = `>>>${bytesToBase64(deflateLevel9(encodePayload(tampered)))}<<<`;
    expect(() => decodeExchangeString(restrung)).toThrow(/autoplace_settings/);
  });

  it("decodes peaceful_mode true (and no_enemies false) from the peaceful fixture", () => {
    const mid = decodeExchangeString(peacefulFixture).mid;
    expect(mid.peacefulMode).toBe(true);
    expect(mid.noEnemiesMode).toBe(false);
  });

  it("decodes no_enemies_mode true (and peaceful false) from the no-enemies fixture", () => {
    const mid = decodeExchangeString(noEnemiesFixture).mid;
    expect(mid.noEnemiesMode).toBe(true);
    expect(mid.peacefulMode).toBe(false);
  });

  it.each([
    ["peaceful", () => peacefulFixture],
    ["no-enemies", () => noEnemiesFixture],
  ])("round-trips the %s fixture byte-for-byte", (_label, get) => {
    const decoded = decodeExchangeString(get());
    expect(encodeExchangeString(decoded)).toBe(get());
  });

  it.each(startingPointFixtures)(
    "decodes starting_points from the %s fixture",
    (_label, path, expected) => {
      const mid = decodeExchangeString(readFileSync(path, "utf8").trim()).mid;
      expect(mid.startingPoints).toEqual(expected);
    },
  );

  it("decodes starting_points as the single origin point for every builtin", () => {
    for (const name of NAMES) {
      const mid = decodeExchangeString(presets[name] as string).mid;
      expect(mid.startingPoints).toEqual([{ x: 0, y: 0 }]);
    }
  });

  it("rejects a starting point whose sentinel is not 0x7fff (delta-encoded positions unsupported)", () => {
    // The origin fixture's one starting point is exactly 11 bytes (count + 2-byte
    // sentinel + int32 x + int32 y) sitting just before the empty
    // property_expression_names count and the tail. Corrupt the sentinel there.
    const decoded = decodeExchangeString(readFileSync(startingPointFixtures[0][1], "utf8").trim());
    const body = decoded.payload.slice(0, -4);
    const spBlockStart = body.length - tailToBytes(decoded.tail, decoded.version).length - 1 - 11;
    body[spBlockStart + 1] = 0x00; // sentinel low byte: 0x7fff -> 0x7f00
    const crc = crc32(body);
    const tampered = new Uint8Array(body.length + 4);
    tampered.set(body, 0);
    new DataView(tampered.buffer).setUint32(body.length, crc, true);
    const restrung = `>>>${bytesToBase64(deflateLevel9(tampered))}<<<`;
    expect(() => decodeExchangeString(restrung)).toThrow(/starting_points/);
  });

  it("agrees field-for-field with the game's own helpers.parse_map_exchange_string", () => {
    // map-exchange-parsed.default-seed123456.dump.json is the authoritative parse
    // of starting-points-1-origin.txt (byte-identical to a default seed-123456
    // Space-Age map) produced in-game by helpers.parse_map_exchange_string. It
    // validates the whole mid-block decoder against ground truth, and confirms
    // area_to_generate_at_start is absent from the game's parsed table (it is a
    // vestigial serialization field with no public MapGenSettings member).
    const oracle = mapExchangeParsed.map_gen_settings as Record<string, unknown>;
    const mid = decodeExchangeString(
      readFileSync("test/fixtures/starting-points-1-origin.txt", "utf8").trim(),
    ).mid;
    expect(mid.seed).toBe(oracle["seed"]);
    expect(mid.width).toBe(oracle["width"]);
    expect(mid.height).toBe(oracle["height"]);
    expect(mid.startingArea).toBeCloseTo(oracle["starting_area"] as number, 6);
    expect(mid.peacefulMode).toBe(oracle["peaceful_mode"]);
    expect(mid.noEnemiesMode).toBe(oracle["no_enemies_mode"]);
    expect(mid.defaultEnableAllAutoplaceControls).toBe(
      oracle["default_enable_all_autoplace_controls"],
    );
    expect(mid.startingPoints).toEqual(oracle["starting_points"]);
    expect("area_to_generate_at_start" in oracle).toBe(false);
  });

  it("types map width and height from the mid-block (Ribbon world proves the height offset)", () => {
    expect(decodeExchangeString(presets["Default"] as string).mid.height).toBe(2000000);
    // Ribbon world is the only fixture with a non-default height (128), which is
    // what pins the u32 height offset at mid+10.
    expect(decodeExchangeString(presets["Ribbon world"] as string).mid.height).toBe(128);
    expect(decodeExchangeString(presets["Ribbon world"] as string).mid.width).toBe(2000000);
  });

  it("property_expression_names is empty in Default and pinned in Lakes, Island, Ribbon world", () => {
    expect(decodeExchangeString(presets["Default"] as string).propertyExpressionNames).toEqual({});
    const lakesKeys = [
      "aux",
      "cliff_elevation",
      "cliffiness",
      "elevation",
      "moisture",
      "trees_forest_path_cutout",
    ];
    expect(
      Object.keys(decodeExchangeString(presets["Lakes"] as string).propertyExpressionNames),
    ).toEqual(lakesKeys);
    expect(
      Object.keys(decodeExchangeString(presets["Island"] as string).propertyExpressionNames),
    ).toEqual(lakesKeys);
    expect(
      Object.keys(decodeExchangeString(presets["Ribbon world"] as string).propertyExpressionNames),
    ).toEqual(["elevation", "trees_forest_path_cutout"]);
  });

  it.each(NAMES)("tail of %s is fully typed: opaqueTail is empty", (name) => {
    expect(
      (decodeExchangeString(presets[name] as string).tail.opaqueTail as Uint8Array).length,
    ).toBe(0);
  });

  it("resolves the cliff anomaly: Default cliff name is 'cliff', others are ''", () => {
    expect(decodeExchangeString(presets["Default"] as string).tail["cliff.name"]).toBe("cliff");
    for (const name of NAMES.filter((n) => n !== "Default")) {
      expect(decodeExchangeString(presets[name] as string).tail["cliff.name"]).toBe("");
    }
  });

  it("decodes the cliff control string (empty across the corpus)", () => {
    expect(decodeExchangeString(presets["Default"] as string).tail["cliff.control"]).toBe("");
  });

  it("types the cliff floats and the pollution section for Default", () => {
    const t = decodeExchangeString(presets["Default"] as string).tail;
    expect(t["cliff.cliffElevation0"]).toBeCloseTo(10, 4);
    expect(t["cliff.cliffElevationInterval"]).toBeCloseTo(40, 4);
    expect(t["cliff.richness"]).toBeCloseTo(1, 6);
    expect(t["cliff.unknownFloat"]).toBeCloseTo(1, 6);
    expect(t["cliff.cliffSmoothing"]).toBe(0);
    expect(t["pollution.enabled"]).toBe(true);
    expect(t["pollution.diffusionRatio"]).toBeCloseTo(0.02, 9);
    expect(t["pollution.minToDiffuse"]).toBeCloseTo(15, 9);
    expect(t["pollution.expectedMaxPerChunk"]).toBeCloseTo(150, 9);
    expect(t["pollution.enemyAttackPollutionConsumptionModifier"]).toBeCloseTo(1, 9);
  });

  it("cliff_smoothing and richness match the Nauvis dump exactly", () => {
    const t = decodeExchangeString(presets["Default"] as string).tail;
    expect(t["cliff.cliffSmoothing"]).toBe(nauvisDump.cliff_settings.cliff_smoothing);
    expect(t["cliff.richness"]).toBeCloseTo(nauvisDump.cliff_settings.richness, 6);
  });

  it("types enemy_evolution and enemy_expansion for Default", () => {
    const t = decodeExchangeString(presets["Default"] as string).tail;
    expect(t["enemyEvolution.timeFactor"]).toBeCloseTo(0.000004, 12);
    expect(t["enemyEvolution.destroyFactor"]).toBeCloseTo(0.002, 9);
    expect(t["enemyEvolution.pollutionFactor"]).toBeCloseTo(0.0000009, 12);
    expect(t["enemyExpansion.maxExpansionDistance"]).toBe(5);
    expect(t["enemyExpansion.otherBaseCoefficient"]).toBeCloseTo(3.0, 9);
    expect(t["enemyExpansion.maxExpansionCooldown"]).toBe(216000);
  });

  it("Death world has a higher enemy_evolution time_factor than Default", () => {
    const def = decodeExchangeString(presets["Default"] as string).tail;
    const dw = decodeExchangeString(presets["Death world"] as string).tail;
    expect(dw["enemyEvolution.timeFactor"]).not.toBe(def["enemyEvolution.timeFactor"]);
  });

  it("types the unit_group section for Default, matching every map-settings.example.json default", () => {
    const t = decodeExchangeString(presets["Default"] as string).tail;
    const ug = mapDefaults.unit_group;
    expect(t["unitGroup.minGroupGatheringTime"]).toBe(ug.min_group_gathering_time);
    expect(t["unitGroup.maxGroupGatheringTime"]).toBe(ug.max_group_gathering_time);
    expect(t["unitGroup.maxWaitTimeForLateMembers"]).toBe(ug.max_wait_time_for_late_members);
    expect(t["unitGroup.maxGroupRadius"]).toBeCloseTo(ug.max_group_radius, 6);
    expect(t["unitGroup.minGroupRadius"]).toBeCloseTo(ug.min_group_radius, 6);
    expect(t["unitGroup.maxMemberSpeedupWhenBehind"]).toBeCloseTo(
      ug.max_member_speedup_when_behind,
      6,
    );
    expect(t["unitGroup.maxMemberSlowdownWhenAhead"]).toBeCloseTo(
      ug.max_member_slowdown_when_ahead,
      6,
    );
    expect(t["unitGroup.maxGroupSlowdownFactor"]).toBeCloseTo(ug.max_group_slowdown_factor, 6);
    expect(t["unitGroup.maxGroupMemberFallbackFactor"]).toBeCloseTo(
      ug.max_group_member_fallback_factor,
      6,
    );
    expect(t["unitGroup.memberDisownDistance"]).toBeCloseTo(ug.member_disown_distance, 6);
    expect(t["unitGroup.tickToleranceWhenMemberArrives"]).toBe(
      ug.tick_tolerance_when_member_arrives,
    );
    expect(t["unitGroup.maxGatheringUnitGroups"]).toBe(ug.max_gathering_unit_groups);
    expect(t["unitGroup.maxUnitGroupSize"]).toBe(ug.max_unit_group_size);
  });

  it("types the path_finder section incl. overload arrays for Default, matching every map-settings.example.json default", () => {
    const t = decodeExchangeString(presets["Default"] as string).tail;
    const pf = mapDefaults.path_finder;
    expect(t["pathFinder.fwd2bwdRatio"]).toBe(pf.fwd2bwd_ratio);
    expect(t["pathFinder.goalPressureRatio"]).toBeCloseTo(pf.goal_pressure_ratio, 6);
    expect(t["pathFinder.maxStepsWorkedPerTick"]).toBe(pf.max_steps_worked_per_tick);
    expect(t["pathFinder.maxWorkDonePerTick"]).toBe(pf.max_work_done_per_tick);
    expect(t["pathFinder.usePathCache"]).toBe(pf.use_path_cache);
    expect(t["pathFinder.shortCacheSize"]).toBe(pf.short_cache_size);
    expect(t["pathFinder.longCacheSize"]).toBe(pf.long_cache_size);
    expect(t["pathFinder.shortCacheMinCacheableDistance"]).toBe(
      pf.short_cache_min_cacheable_distance,
    );
    expect(t["pathFinder.shortCacheMinAlgoStepsToCache"]).toBe(
      pf.short_cache_min_algo_steps_to_cache,
    );
    expect(t["pathFinder.longCacheMinCacheableDistance"]).toBe(
      pf.long_cache_min_cacheable_distance,
    );
    expect(t["pathFinder.cacheMaxConnectToCacheStepsMultiplier"]).toBe(
      pf.cache_max_connect_to_cache_steps_multiplier,
    );
    expect(t["pathFinder.cacheAcceptPathStartDistanceRatio"]).toBeCloseTo(
      pf.cache_accept_path_start_distance_ratio,
      6,
    );
    expect(t["pathFinder.cacheAcceptPathEndDistanceRatio"]).toBeCloseTo(
      pf.cache_accept_path_end_distance_ratio,
      6,
    );
    expect(t["pathFinder.negativeCacheAcceptPathStartDistanceRatio"]).toBeCloseTo(
      pf.negative_cache_accept_path_start_distance_ratio,
      6,
    );
    expect(t["pathFinder.negativeCacheAcceptPathEndDistanceRatio"]).toBeCloseTo(
      pf.negative_cache_accept_path_end_distance_ratio,
      6,
    );
    expect(t["pathFinder.cachePathStartDistanceRatingMultiplier"]).toBe(
      pf.cache_path_start_distance_rating_multiplier,
    );
    expect(t["pathFinder.cachePathEndDistanceRatingMultiplier"]).toBe(
      pf.cache_path_end_distance_rating_multiplier,
    );
    expect(t["pathFinder.staleEnemyWithSameDestinationCollisionPenalty"]).toBeCloseTo(
      pf.stale_enemy_with_same_destination_collision_penalty,
      6,
    );
    expect(t["pathFinder.ignoreMovingEnemyCollisionDistance"]).toBeCloseTo(
      pf.ignore_moving_enemy_collision_distance,
      6,
    );
    expect(t["pathFinder.enemyWithDifferentDestinationCollisionPenalty"]).toBeCloseTo(
      pf.enemy_with_different_destination_collision_penalty,
      6,
    );
    expect(t["pathFinder.generalEntityCollisionPenalty"]).toBeCloseTo(
      pf.general_entity_collision_penalty,
      6,
    );
    expect(t["pathFinder.generalEntitySubsequentCollisionPenalty"]).toBeCloseTo(
      pf.general_entity_subsequent_collision_penalty,
      6,
    );
    expect(t["pathFinder.extendedCollisionPenalty"]).toBeCloseTo(pf.extended_collision_penalty, 6);
    expect(t["pathFinder.maxClientsToAcceptAnyNewRequest"]).toBe(
      pf.max_clients_to_accept_any_new_request,
    );
    expect(t["pathFinder.maxClientsToAcceptShortNewRequest"]).toBe(
      pf.max_clients_to_accept_short_new_request,
    );
    expect(t["pathFinder.directDistanceToConsiderShortRequest"]).toBe(
      pf.direct_distance_to_consider_short_request,
    );
    expect(t["pathFinder.shortRequestMaxSteps"]).toBe(pf.short_request_max_steps);
    expect(t["pathFinder.shortRequestRatio"]).toBeCloseTo(pf.short_request_ratio, 6);
    expect(t["pathFinder.minStepsToCheckPathFindTermination"]).toBe(
      pf.min_steps_to_check_path_find_termination,
    );
    expect(t["pathFinder.startToGoalCostMultiplierToTerminatePathFind"]).toBeCloseTo(
      pf.start_to_goal_cost_multiplier_to_terminate_path_find,
      6,
    );
    expect(t["pathFinder.overloadLevels"]).toEqual(pf.overload_levels);
    expect(t["pathFinder.overloadMultipliers"]).toEqual(pf.overload_multipliers);
    expect(t["pathFinder.negativePathCacheDelayInterval"]).toBe(
      pf.negative_path_cache_delay_interval,
    );
  });

  it("types difficulty/asteroids/max_failed and closes the opaque tail for Default", () => {
    const t = decodeExchangeString(presets["Default"] as string).tail;
    expect(t["difficulty.technologyPriceMultiplier"]).toBeCloseTo(
      mapDefaults.difficulty_settings.technology_price_multiplier,
      6,
    );
    expect(t["difficulty.spoilTimeModifier"]).toBeCloseTo(
      mapDefaults.difficulty_settings.spoil_time_modifier,
      6,
    );
    expect(t["asteroids.spawningRate"]).toBeCloseTo(mapDefaults.asteroids.spawning_rate, 6);
    expect(t["asteroids.maxRayPortalsExpandedPerTick"]).toBe(
      mapDefaults.asteroids.max_ray_portals_expanded_per_tick,
    );
    expect(t["maxFailedBehaviorCount"]).toBe(mapDefaults.max_failed_behavior_count);
    // Whole MapSettings typed: no bytes left over.
    expect((t["opaqueTail"] as Uint8Array).length).toBe(0);
  });

  it("Marathon has technology_price_multiplier 4", () => {
    const t = decodeExchangeString(presets["Marathon"] as string).tail;
    expect(t["difficulty.technologyPriceMultiplier"]).toBeCloseTo(4.0, 6);
  });

  it("rejects a missing envelope", () => {
    expect(() => decodeExchangeString("eNqLjgUAARUAuQ==")).toThrow(ExchangeStringError);
    expect(() => decodeExchangeString(">>>eNqLjgUAARUAuQ==")).toThrow(ExchangeStringError);
  });

  it("rejects invalid base64 and invalid zlib streams", () => {
    expect(() => decodeExchangeString(">>>!!!!<<<")).toThrow(ExchangeStringError);
    expect(() => decodeExchangeString(">>>AAAAAAAA<<<")).toThrow(ExchangeStringError);
  });

  it("rejects a payload whose CRC does not match", () => {
    const good = decodeExchangeString(presets["Default"] as string);
    const corrupted = good.payload.slice();
    corrupted[20] = (corrupted[20] as number) ^ 0xff;
    const tampered = `>>>${bytesToBase64(deflateLevel9(corrupted))}<<<`;
    expect(() => decodeExchangeString(tampered)).toThrow(/CRC/);
  });

  it("rejects a payload with an unsupported format version", () => {
    const good = decodeExchangeString(presets["Default"] as string);
    const body = good.payload.slice(0, -4);
    body[0] = 3; // version major 2 -> 3 (uint16 LE low byte)
    const crc = crc32(body);
    const tampered = new Uint8Array(body.length + 4);
    tampered.set(body, 0);
    new DataView(tampered.buffer).setUint32(body.length, crc, true);
    const restrung = `>>>${bytesToBase64(deflateLevel9(tampered))}<<<`;
    expect(() => decodeExchangeString(restrung)).toThrow(/unsupported exchange format 3\.1\.9\.3/);
  });
});
