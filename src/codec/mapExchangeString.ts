import { base64ToBytes, bytesToBase64 } from "./base64";
import { BinaryReader } from "./binaryReader";
import { BinaryWriter } from "./binaryWriter";
import { crc32 } from "./crc32";
import { deflateLevel9, inflate } from "./deflate";
import { readFields, writeFields, type FieldValue, type Schema } from "./fieldSchema";

export interface AutoplaceSetting {
  frequency: number;
  size: number;
  richness: number;
}

export type FormatVersion = [number, number, number, number];

export interface MidBlock {
  /**
   * Count of the autoplace_settings dict (u8 at mid offset 0). Always 0 across
   * the corpus (empty dict). A non-zero count injects a variable-length dict
   * that the fixed-width mid-block schema cannot represent, so decode rejects
   * it (see decodeExchangeString) rather than silently misparsing.
   */
  autoplaceSettingsCount: number;
  /** default_enable_all_autoplace_controls (bool at mid offset 1, immediately before seed). */
  defaultEnableAllAutoplaceControls: boolean;
  /** Map generation seed (u32 LE at mid offset 2). */
  seed: number;
  /** Map width in tiles (u32 LE at mid offset 6). */
  width: number;
  /** Map height in tiles (u32 LE at mid offset 10). */
  height: number;
  /**
   * area_to_generate_at_start: the region the engine pre-generates around
   * spawn, serialized as a BoundingBox between height and starting_area. This
   * is a VESTIGIAL field - it is absent from the 2.x MapGenSettings Lua type
   * and from helpers.parse_map_exchange_string, and no map-gen-settings knob
   * moves it (confirmed by fixtures varying starting_area, map size and
   * starting_points, plus the ignored legacy JSON key). The engine always
   * writes the same constant (-224,-224)-(+224,+224) box. Typed structurally
   * from the same 0x7fff-sentinel + absolute-int32 MapPosition encoding
   * validated against the game for starting_points.
   */
  areaToGenerateAtStart: AreaToGenerateAtStart;
  /** Starting-area size scale (f32 LE at mid offset 38). */
  startingArea: number;
  /** peaceful_mode flag (bool at mid offset 42, first byte after starting_area). */
  peacefulMode: boolean;
  /** no_enemies_mode flag (bool at mid offset 43). */
  noEnemiesMode: boolean;
  /**
   * starting_points (MapGenSettings.starting_points, array[MapPosition]): the
   * variable-length trailer of the mid-block, immediately after no_enemies_mode.
   * Wire layout: a u8 count, then per point an int16 0x7fff sentinel ("absolute
   * int32 coords follow") plus x and y as signed int32 in Factorio 1/256
   * fixed-point. Stored here as TILE coordinates (raw int32 / 256, exact in
   * f64). Verified against four ground-truth fixtures incl. a two-point map.
   */
  startingPoints: MapPosition[];
}

/** A Factorio MapPosition in tile units (raw wire int32 / 256, exact in f64). */
export interface MapPosition {
  x: number;
  y: number;
}

/** A starting point is a plain MapPosition; kept as a named alias for clarity. */
export type StartingPoint = MapPosition;

export interface AreaToGenerateAtStart {
  /** Top-left corner (tile units). Constant (-224, -224) across the corpus. */
  leftTop: MapPosition;
  /** Bottom-right corner (tile units). Constant (+224, +224) across the corpus. */
  rightBottom: MapPosition;
  /**
   * 4 trailing bytes after the two corners: `00 00 01 80`, unidentified
   * (possibly an orientation or flag) and constant across the corpus. Carried
   * verbatim for byte-exact round-trip.
   */
  trailer: Uint8Array;
}

export interface DecodedExchange {
  version: FormatVersion;
  flagByte: number;
  autoplaceControls: Record<string, AutoplaceSetting>;
  /** The MapGenSettings block between autoplace and property_expression_names: a fixed head, the area_to_generate_at_start box, the starting_area/enemy-flag rest, and the variable-length starting_points trailer - all typed. */
  mid: MidBlock;
  propertyExpressionNames: Record<string, string>;
  /**
   * Payload bytes after property_expression_names, excluding the trailing
   * CRC. The full cliff block plus every MapSettings section (pollution,
   * enemy_evolution, enemy_expansion, unit_group, path_finder, difficulty,
   * asteroids, max_failed_behavior_count) is typed via TAIL_SCHEMA;
   * `opaqueTail` is the dynamically-sized trailer that normally decodes to
   * length 0 for every known fixture.
   */
  tail: TailBlock;
  crc: number;
  /** The full inflated payload (including CRC), for round-trip tests. */
  payload: Uint8Array;
}

export class ExchangeStringError extends Error {}

// version (8) + flag (1) + autoplace count (1) + mid prefix (44) + starting_points
// count (>=1) + property count (1) + CRC (4). The mid-block is no longer fixed
// width: its starting_points trailer is variable-length.
const MIN_PAYLOAD_LENGTH = 60;

// int16 sentinel prefixing each serialized MapPosition: "absolute int32 coords
// follow". All observed data uses it; the alternative (delta-encoded positions)
// is rejected by decode rather than silently misparsed.
const MAP_POSITION_SENTINEL = 0x7fff;

// Factorio stores MapPosition coordinates as 1/256-tile fixed-point int32s.
const POSITION_FRACTIONAL_UNITS = 256;

// The 4 trailing bytes of area_to_generate_at_start after its two corners.
const AREA_TRAILER_LENGTH = 4;

// The mid-block splits into a fixed head (through height), the fixed-width but
// struct-shaped area_to_generate_at_start, a fixed rest (starting_area and the
// two enemy flags), then the variable-length starting_points trailer. The two
// struct fields (area corners + starting_points) use the 0x7fff-sentinel
// MapPosition encoding, which the generic fieldSchema cannot express, so they
// are read/written by custom loops around these two schemas.
//
// Head: a length-prefixed autoplace_settings dict (empty: one 0x00 count byte)
// followed by default_enable_all_autoplace_controls (0x01 = true) immediately
// before seed - matching flameSla's 1.x field order and the self-consistent
// `00 01` in every fixture. Field names/types cross-checked against the 2.x
// MapGenSettings type (https://lua-api.factorio.com/latest/types/MapGenSettings.html).
export const MID_BLOCK_HEAD_SCHEMA: Schema = [
  { name: "autoplaceSettingsCount", type: "u8" },
  { name: "defaultEnableAllAutoplaceControls", type: "bool" },
  { name: "seed", type: "u32" },
  { name: "width", type: "u32" },
  { name: "height", type: "u32" },
];

// Rest: starting_area (f32), then peaceful_mode and no_enemies_mode - the two
// bytes pinned by the single-toggle fixtures defaultgenwithpeaceful.txt and
// defaultmodenoenemiespeacefulunchecked.txt (each flips exactly its byte).
export const MID_BLOCK_REST_SCHEMA: Schema = [
  { name: "startingArea", type: "f32" },
  { name: "peacefulMode", type: "bool" },
  { name: "noEnemiesMode", type: "bool" },
];

/**
 * Read one serialized MapPosition: a 0x7fff int16 sentinel followed by x,y as
 * signed int32 in 1/256 fixed-point, returned as tile units (raw int32 / 256,
 * exact in f64). A non-sentinel value means a delta-encoded position, which
 * this codec does not support - it throws rather than silently misparse
 * (mirrors the autoplace count guard). `context` names the field for the error.
 */
function readMapPosition(reader: BinaryReader, context: string): MapPosition {
  const sentinel = reader.readUint16();
  if (sentinel !== MAP_POSITION_SENTINEL) {
    throw new ExchangeStringError(
      `unsupported ${context} encoding (sentinel ${sentinel.toString(16)}, expected 7fff); delta-encoded positions are not handled`,
    );
  }
  return {
    x: reader.readInt32() / POSITION_FRACTIONAL_UNITS,
    y: reader.readInt32() / POSITION_FRACTIONAL_UNITS,
  };
}

/** The exact inverse of readMapPosition. */
function writeMapPosition(writer: BinaryWriter, point: MapPosition): void {
  writer.writeUint16(MAP_POSITION_SENTINEL);
  writer.writeInt32(Math.round(point.x * POSITION_FRACTIONAL_UNITS));
  writer.writeInt32(Math.round(point.y * POSITION_FRACTIONAL_UNITS));
}

/** Read the area_to_generate_at_start BoundingBox: two corners + a 4-byte trailer. */
function readAreaToGenerateAtStart(reader: BinaryReader): AreaToGenerateAtStart {
  return {
    leftTop: readMapPosition(reader, "area_to_generate_at_start"),
    rightBottom: readMapPosition(reader, "area_to_generate_at_start"),
    trailer: reader.readBytes(AREA_TRAILER_LENGTH),
  };
}

/** The exact inverse of readAreaToGenerateAtStart. */
function writeAreaToGenerateAtStart(writer: BinaryWriter, area: AreaToGenerateAtStart): void {
  writeMapPosition(writer, area.leftTop);
  writeMapPosition(writer, area.rightBottom);
  writer.writeBytes(area.trailer);
}

/**
 * Read the variable-length starting_points trailer: a u8 count, then that many
 * serialized MapPositions.
 */
function readStartingPoints(reader: BinaryReader): MapPosition[] {
  const count = reader.readUint8();
  const points: MapPosition[] = [];
  for (let i = 0; i < count; i++) {
    points.push(readMapPosition(reader, "starting_points"));
  }
  return points;
}

/** The exact inverse of readStartingPoints. */
function writeStartingPoints(writer: BinaryWriter, points: MapPosition[]): void {
  writer.writeUint8(points.length);
  for (const point of points) {
    writeMapPosition(writer, point);
  }
}

/**
 * The exchange formats this decoder understands, newest last.
 *
 * **This is a known-good list, not a range, and that is deliberate.** The
 * mid-block and tail schemas here are EMPIRICAL - derived by reading bytes, not
 * from a published spec - so accepting an unseen format would risk decoding a
 * changed layout into plausible-looking wrong values, which is far worse than a
 * clean rejection. A version earns its place here only once a fixture proves a
 * real string of that format decodes AND re-encodes byte-for-byte
 * (`test/mapExchangeVersions.spec.ts`).
 *
 * - `2.1.9.3` - the format the nine builtin presets were captured in.
 * - `2.1.12.2` - what Factorio 2.1.12 emits. Added 2026-07-28, when the fixture
 *   audit (#7) found the app rejected strings copied from the current game
 *   outright. The payload layout is unchanged: all five varied captures
 *   (seeds, autoplace controls, water/cliffs/starting_area, peaceful/no_enemies)
 *   round-trip byte-exact. Only the tag moved.
 *
 * Note the two directions are not symmetric, and only one was broken: 2.1.12
 * accepts a `2.1.9.3` string fine (verified through the game's own
 * `helpers.parse_map_exchange_string`), so EXPORT was never affected - the app's
 * output stayed loadable throughout. Import was the broken half.
 */
export const SUPPORTED_VERSIONS: readonly FormatVersion[] = [
  [2, 1, 9, 3],
  [2, 1, 12, 2],
];

/** Human-readable list for UI and error messages, e.g. "2.1.9.3, 2.1.12.2". */
export const SUPPORTED_VERSIONS_LABEL = SUPPORTED_VERSIONS.map((v) => v.join(".")).join(", ");

export interface TailBlock {
  [key: string]: string | number | boolean | Uint8Array | null | (string | number | boolean)[];
}

// The tail, walked as one flat schema (dotted names encode section membership).
// Grew across Phase 1c; the entire MapSettings tail is now typed and
// "opaqueTail" decodes to length 0 for every fixture. It stays as the final,
// dynamically-sized schema entry so round-trip remains byte-exact even if a
// future format revision adds fields we haven't typed yet.
export const TAIL_SCHEMA: Schema = [
  { name: "cliff.name", type: "string" },
  { name: "cliff.control", type: "string" },
  { name: "cliff.cliffElevation0", type: "f32" },
  { name: "cliff.cliffElevationInterval", type: "f32" },
  { name: "cliff.richness", type: "f32" },
  // Unidentified 4th cliff float; both fixtures observed so far carry 1.0.
  // Kept typed (rather than folded into an opaque span) purely for
  // byte-exactness until its meaning is confirmed.
  { name: "cliff.unknownFloat", type: "f32" },
  // Single byte (u8, not part of a float) - Default-tail offset 23. Matches
  // the Nauvis dump's cliff_settings.cliff_smoothing (0) exactly.
  { name: "cliff.cliffSmoothing", type: "u8" },
  // Unlike a plain bool, this is presence-flag + value (2 bytes) - the byte
  // immediately preceding it (cliff.cliffSmoothing) is NOT part of this
  // field; byte-fitting against pollution.diffusionRatio's known offset
  // proved the extra flag byte belongs here, matching every other section's
  // "enabled" convention (see enemyEvolution/enemyExpansion below).
  { name: "pollution.enabled", type: { optional: "bool" } },
  { name: "pollution.diffusionRatio", type: { optional: "f64" } },
  { name: "pollution.minToDiffuse", type: { optional: "f64" } },
  { name: "pollution.ageing", type: { optional: "f64" } },
  { name: "pollution.expectedMaxPerChunk", type: { optional: "f64" } },
  { name: "pollution.minToShowPerChunk", type: { optional: "f64" } },
  { name: "pollution.minPollutionToDamageTrees", type: { optional: "f64" } },
  { name: "pollution.pollutionWithMaxForestDamage", type: { optional: "f64" } },
  { name: "pollution.pollutionPerTreeDamage", type: { optional: "f64" } },
  { name: "pollution.pollutionRestoredPerTreeDamage", type: { optional: "f64" } },
  { name: "pollution.maxPollutionToRestoreTrees", type: { optional: "f64" } },
  { name: "pollution.enemyAttackPollutionConsumptionModifier", type: { optional: "f64" } },
  // Both "enabled" fields below decode as an optional bool (flag byte + value
  // byte), not a plain bool like pollution.enabled - byte-fitting showed a
  // plain bool is one byte short of the real layout for these two sections.
  { name: "enemyEvolution.enabled", type: { optional: "bool" } },
  { name: "enemyEvolution.timeFactor", type: { optional: "f64" } },
  { name: "enemyEvolution.destroyFactor", type: { optional: "f64" } },
  { name: "enemyEvolution.pollutionFactor", type: { optional: "f64" } },
  { name: "enemyExpansion.enabled", type: { optional: "bool" } },
  { name: "enemyExpansion.maxExpansionDistance", type: { optional: "u32" } },
  { name: "enemyExpansion.minExpansionDistance", type: { optional: "u32" } },
  { name: "enemyExpansion.friendlyBaseInfluenceRadius", type: { optional: "u32" } },
  { name: "enemyExpansion.enemyBuildingInfluenceRadius", type: { optional: "u32" } },
  { name: "enemyExpansion.buildingCoefficient", type: { optional: "f64" } },
  { name: "enemyExpansion.otherBaseCoefficient", type: { optional: "f64" } },
  { name: "enemyExpansion.neighbouringChunkCoefficient", type: { optional: "f64" } },
  { name: "enemyExpansion.neighbouringBaseChunkCoefficient", type: { optional: "f64" } },
  { name: "enemyExpansion.maxCollidingTilesCoefficient", type: { optional: "f64" } },
  { name: "enemyExpansion.settlerGroupMinSize", type: { optional: "u32" } },
  { name: "enemyExpansion.settlerGroupMaxSize", type: { optional: "u32" } },
  { name: "enemyExpansion.evolutionGroupSizeFactor", type: { optional: "f64" } },
  { name: "enemyExpansion.minExpansionCooldown", type: { optional: "u32" } },
  { name: "enemyExpansion.maxExpansionCooldown", type: { optional: "u32" } },
  // unit_group has no "enabled" field - it starts directly with its first value.
  { name: "unitGroup.minGroupGatheringTime", type: { optional: "u32" } },
  { name: "unitGroup.maxGroupGatheringTime", type: { optional: "u32" } },
  { name: "unitGroup.maxWaitTimeForLateMembers", type: { optional: "u32" } },
  { name: "unitGroup.maxGroupRadius", type: { optional: "f64" } },
  { name: "unitGroup.minGroupRadius", type: { optional: "f64" } },
  { name: "unitGroup.maxMemberSpeedupWhenBehind", type: { optional: "f64" } },
  { name: "unitGroup.maxMemberSlowdownWhenAhead", type: { optional: "f64" } },
  { name: "unitGroup.maxGroupSlowdownFactor", type: { optional: "f64" } },
  // These two decode as f64 despite their integer-looking JSON defaults (3, 10)
  // and "factor count"-sounding names - byte-fitting against the anchor offsets
  // (maxUnitGroupSize@339) confirms f64, not u32.
  { name: "unitGroup.maxGroupMemberFallbackFactor", type: { optional: "f64" } },
  { name: "unitGroup.memberDisownDistance", type: { optional: "f64" } },
  { name: "unitGroup.tickToleranceWhenMemberArrives", type: { optional: "u32" } },
  { name: "unitGroup.maxGatheringUnitGroups", type: { optional: "u32" } },
  { name: "unitGroup.maxUnitGroupSize", type: { optional: "u32" } },
  { name: "pathFinder.fwd2bwdRatio", type: { optional: "u32" } },
  { name: "pathFinder.goalPressureRatio", type: { optional: "f64" } },
  // Two unmapped bytes (01 01 in Default) between goalPressureRatio and
  // maxStepsWorkedPerTick; byte-fitting the anchor values around them (2000,
  // 8000, etc.) confirms this gap, round-trip-only, values unknown.
  { name: "pathFinder.trailingA", type: { opaque: 2 } },
  // f64, not u32 as the JSON's integer-looking default (1000) suggests -
  // byte-fitting against the exact 1000.0 double pattern confirms f64.
  { name: "pathFinder.maxStepsWorkedPerTick", type: { optional: "f64" } },
  { name: "pathFinder.maxWorkDonePerTick", type: { optional: "u32" } },
  { name: "pathFinder.usePathCache", type: "bool" },
  // Bare u32 (no presence flag), unlike every other numeric field in this
  // section - byte-fitting shows the byte right after usePathCache is the
  // raw value 5, not a 0/1 flag.
  { name: "pathFinder.shortCacheSize", type: "u32" },
  { name: "pathFinder.longCacheSize", type: { optional: "u32" } },
  // f64, not u32 - same anchor-driven correction as maxStepsWorkedPerTick.
  { name: "pathFinder.shortCacheMinCacheableDistance", type: { optional: "f64" } },
  { name: "pathFinder.shortCacheMinAlgoStepsToCache", type: { optional: "u32" } },
  { name: "pathFinder.longCacheMinCacheableDistance", type: { optional: "f64" } },
  { name: "pathFinder.cacheMaxConnectToCacheStepsMultiplier", type: { optional: "u32" } },
  { name: "pathFinder.cacheAcceptPathStartDistanceRatio", type: { optional: "f64" } },
  { name: "pathFinder.cacheAcceptPathEndDistanceRatio", type: { optional: "f64" } },
  { name: "pathFinder.negativeCacheAcceptPathStartDistanceRatio", type: { optional: "f64" } },
  { name: "pathFinder.negativeCacheAcceptPathEndDistanceRatio", type: { optional: "f64" } },
  // f64, not u32 - same anchor-driven correction as maxStepsWorkedPerTick.
  { name: "pathFinder.cachePathStartDistanceRatingMultiplier", type: { optional: "f64" } },
  { name: "pathFinder.cachePathEndDistanceRatingMultiplier", type: { optional: "f64" } },
  { name: "pathFinder.staleEnemyWithSameDestinationCollisionPenalty", type: { optional: "f64" } },
  { name: "pathFinder.ignoreMovingEnemyCollisionDistance", type: { optional: "f64" } },
  {
    name: "pathFinder.enemyWithDifferentDestinationCollisionPenalty",
    type: { optional: "f64" },
  },
  { name: "pathFinder.generalEntityCollisionPenalty", type: { optional: "f64" } },
  { name: "pathFinder.generalEntitySubsequentCollisionPenalty", type: { optional: "f64" } },
  { name: "pathFinder.extendedCollisionPenalty", type: { optional: "f64" } },
  { name: "pathFinder.maxClientsToAcceptAnyNewRequest", type: { optional: "u32" } },
  { name: "pathFinder.maxClientsToAcceptShortNewRequest", type: { optional: "u32" } },
  { name: "pathFinder.directDistanceToConsiderShortRequest", type: { optional: "u32" } },
  { name: "pathFinder.shortRequestMaxSteps", type: { optional: "u32" } },
  { name: "pathFinder.shortRequestRatio", type: { optional: "f64" } },
  { name: "pathFinder.minStepsToCheckPathFindTermination", type: { optional: "u32" } },
  {
    name: "pathFinder.startToGoalCostMultiplierToTerminatePathFind",
    type: { optional: "f64" },
  },
  // Both overload arrays are optional-wrapped (presence flag) with a single
  // BYTE count (countType: "u8"), not the u32 count a bare `{ array }` reads -
  // byte-fitting the exact [0,100,500] / [2.0,3.0,4.0] patterns pins the count
  // to one byte. overloadMultipliers' elements are f64, not u32 - the JSON's
  // integer-looking defaults (2, 3, 4) are floats on the wire.
  { name: "pathFinder.overloadLevels", type: { optional: { array: "u32", countType: "u8" } } },
  {
    name: "pathFinder.overloadMultipliers",
    type: { optional: { array: "f64", countType: "u8" } },
  },
  { name: "pathFinder.negativePathCacheDelayInterval", type: { optional: "u32" } },
  // Wire order for the final MapSettings fields does not follow the JSON key
  // order (difficulty_settings, ..., asteroids, max_failed_behavior_count) -
  // byte-fitting shows max_failed_behavior_count comes FIRST here, as a bare
  // u32 (no presence flag).
  { name: "maxFailedBehaviorCount", type: "u32" },
  // Bare f64s (no presence flag), unlike most numeric fields in this tail -
  // byte-fitting the exact 1.0/4.0 double patterns (Marathon flips
  // technologyPriceMultiplier to 4.0 right after maxFailedBehaviorCount)
  // confirms both are plain, not optional-wrapped.
  { name: "difficulty.technologyPriceMultiplier", type: "f64" },
  { name: "difficulty.spoilTimeModifier", type: "f64" },
  { name: "asteroids.spawningRate", type: { optional: "f64" } },
  { name: "asteroids.maxRayPortalsExpandedPerTick", type: { optional: "u32" } },
  { name: "opaqueTail", type: { opaque: 0 } }, // width set dynamically below
];

// Fields of TAIL_SCHEMA excluding the trailing dynamic "opaqueTail".
const TAIL_FIXED_SCHEMA: Schema = TAIL_SCHEMA.filter((f) => f.name !== "opaqueTail");

function readTail(reader: BinaryReader): TailBlock {
  const out = readFields(reader, TAIL_FIXED_SCHEMA) as TailBlock;
  out["opaqueTail"] = reader.remaining();
  return out;
}

function writeTail(writer: BinaryWriter, tail: TailBlock): void {
  writeFields(writer, TAIL_FIXED_SCHEMA, tail as Record<string, FieldValue>);
  writer.writeBytes(tail["opaqueTail"] as Uint8Array);
}

/** Bytes for the full tail (fixed prefix + opaque remainder), for the Preset-model interim bridge. */
export function tailToBytes(tail: TailBlock): Uint8Array {
  const writer = new BinaryWriter();
  writeTail(writer, tail);
  return writer.toBytes();
}

/** The inverse of tailToBytes, for the Preset-model interim bridge. */
export function bytesToTail(bytes: Uint8Array): TailBlock {
  return readTail(new BinaryReader(bytes));
}

export function decodeExchangeString(input: string): DecodedExchange {
  const compact = input.replaceAll(/\s+/g, "");
  if (!compact.startsWith(">>>") || !compact.endsWith("<<<") || compact.length < 7) {
    throw new ExchangeStringError("not a map exchange string (missing >>> <<< envelope)");
  }

  let compressed: Uint8Array;
  try {
    compressed = base64ToBytes(compact.slice(3, -3));
  } catch {
    throw new ExchangeStringError("envelope body is not valid base64");
  }

  let payload: Uint8Array;
  try {
    payload = inflate(compressed);
  } catch {
    throw new ExchangeStringError("body is not a valid zlib stream");
  }
  if (payload.length < MIN_PAYLOAD_LENGTH) {
    throw new ExchangeStringError(`payload too short (${payload.length} bytes)`);
  }

  const crcOffset = payload.length - 4;
  const storedCrc = new DataView(payload.buffer, payload.byteOffset + crcOffset, 4).getUint32(
    0,
    true,
  );
  const computedCrc = crc32(payload.subarray(0, crcOffset));
  if (storedCrc !== computedCrc) {
    throw new ExchangeStringError(
      `CRC mismatch: stored ${storedCrc.toString(16)}, computed ${computedCrc.toString(16)}`,
    );
  }

  try {
    const reader = new BinaryReader(payload.subarray(0, crcOffset));
    const version: FormatVersion = [
      reader.readUint16(),
      reader.readUint16(),
      reader.readUint16(),
      reader.readUint16(),
    ];
    if (!SUPPORTED_VERSIONS.some((sv) => version.every((v, i) => v === sv[i]))) {
      throw new ExchangeStringError(
        `unsupported exchange format ${version.join(".")} (supported: ${SUPPORTED_VERSIONS_LABEL})`,
      );
    }
    const flagByte = reader.readUint8();

    const autoplaceControls: Record<string, AutoplaceSetting> = {};
    const autoplaceCount = reader.readUint8();
    for (let i = 0; i < autoplaceCount; i++) {
      const name = reader.readString();
      autoplaceControls[name] = {
        frequency: reader.readFloat32(),
        size: reader.readFloat32(),
        richness: reader.readFloat32(),
      };
    }

    const midHead = readFields(reader, MID_BLOCK_HEAD_SCHEMA);
    if (midHead["autoplaceSettingsCount"] !== 0) {
      throw new ExchangeStringError(
        `unsupported autoplace_settings dict (count ${String(midHead["autoplaceSettingsCount"])}); only the empty dict is handled by the fixed mid-block schema`,
      );
    }
    const areaToGenerateAtStart = readAreaToGenerateAtStart(reader);
    const midRest = readFields(reader, MID_BLOCK_REST_SCHEMA);
    const mid = {
      ...midHead,
      areaToGenerateAtStart,
      ...midRest,
      startingPoints: readStartingPoints(reader),
    } as unknown as MidBlock;

    const propertyExpressionNames: Record<string, string> = {};
    const propertyCount = reader.readUint8();
    for (let i = 0; i < propertyCount; i++) {
      const key = reader.readString();
      propertyExpressionNames[key] = reader.readString();
    }

    const tail = readTail(reader);

    return {
      version,
      flagByte,
      autoplaceControls,
      mid,
      propertyExpressionNames,
      tail,
      crc: storedCrc,
      payload,
    };
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ExchangeStringError(`payload truncated: ${error.message}`);
    }
    throw error;
  }
}

export interface EncodableExchange {
  version: FormatVersion;
  flagByte: number;
  autoplaceControls: Record<string, AutoplaceSetting>;
  mid: MidBlock;
  propertyExpressionNames: Record<string, string>;
  tail: TailBlock;
}

/**
 * Assemble the uncompressed payload (through the trailing CRC) as the exact
 * inverse of decodeExchangeString. Autoplace keys AND property_expression_names
 * keys are both emitted in code-point (ordinal) sort order (spec Sections 4 and
 * 5) so edited presets stay canonical; the mid-block and tail are re-emitted
 * verbatim. `.sort()` compares UTF-16 code units, which equals code-point order
 * for the ASCII prototype names Factorio uses.
 */
export function encodePayload(input: EncodableExchange): Uint8Array {
  const w = new BinaryWriter();
  for (const part of input.version) {
    w.writeUint16(part);
  }
  w.writeUint8(input.flagByte);

  const controlNames = Object.keys(input.autoplaceControls).sort();
  w.writeUint8(controlNames.length);
  for (const name of controlNames) {
    const control = input.autoplaceControls[name] as AutoplaceSetting;
    w.writeString(name);
    w.writeFloat32(control.frequency);
    w.writeFloat32(control.size);
    w.writeFloat32(control.richness);
  }

  writeFields(w, MID_BLOCK_HEAD_SCHEMA, input.mid as unknown as Record<string, FieldValue>);
  writeAreaToGenerateAtStart(w, input.mid.areaToGenerateAtStart);
  writeFields(w, MID_BLOCK_REST_SCHEMA, input.mid as unknown as Record<string, FieldValue>);
  writeStartingPoints(w, input.mid.startingPoints);

  const propertyKeys = Object.keys(input.propertyExpressionNames).sort();
  w.writeUint8(propertyKeys.length);
  for (const key of propertyKeys) {
    w.writeString(key);
    w.writeString(input.propertyExpressionNames[key] as string);
  }

  writeTail(w, input.tail);

  const body = w.toBytes();
  const payload = new Uint8Array(body.length + 4);
  payload.set(body, 0);
  new DataView(payload.buffer).setUint32(body.length, crc32(body), true);
  return payload;
}

/**
 * Encode a full map-exchange string: payload -> zlib deflate@9 -> base64,
 * wrapped in the >>> <<< envelope on a single line (the game ignores interior
 * whitespace on import, and the captured fixtures carry none).
 */
export function encodeExchangeString(input: EncodableExchange): string {
  const compressed = deflateLevel9(encodePayload(input));
  return `>>>${bytesToBase64(compressed)}<<<`;
}
