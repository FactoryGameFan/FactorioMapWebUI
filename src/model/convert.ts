import { base64ToBytes, bytesToBase64 } from "../codec/base64";
import {
  bytesToTail,
  tailToBytes,
  type DecodedExchange,
  type EncodableExchange,
} from "../codec/mapExchangeString";
import { tailToNested, writeMapSettingsToTail } from "./mapSettings";
import type { Preset } from "./types";

export function presetFromDecoded(name: string, decoded: DecodedExchange, builtin = false): Preset {
  const { cliff, mapSettings } = tailToNested(decoded.tail);
  return {
    name,
    builtin,
    // Wire 0 is Factorio's "random" sentinel; surface it as null so the
    // "random each new map" state is a single source of truth.
    seed: decoded.mid.seed === 0 ? null : decoded.mid.seed,
    autoplaceControls: structuredClone(decoded.autoplaceControls),
    width: decoded.mid.width,
    height: decoded.mid.height,
    startingArea: decoded.mid.startingArea,
    peacefulMode: decoded.mid.peacefulMode,
    noEnemiesMode: decoded.mid.noEnemiesMode,
    defaultEnableAllAutoplaceControls: decoded.mid.defaultEnableAllAutoplaceControls,
    areaToGenerateAtStart: structuredClone(decoded.mid.areaToGenerateAtStart),
    startingPoints: structuredClone(decoded.mid.startingPoints),
    propertyExpressionNames: structuredClone(decoded.propertyExpressionNames),
    opaqueTailB64: bytesToBase64(tailToBytes(decoded.tail, decoded.version)),
    cliffSettings: cliff,
    mapSettings,
    formatVersion: [...decoded.version],
  };
}

/**
 * Bridge a Preset back to the encoder's input. The flag byte is a constant 0
 * (never observed otherwise); width/height/seed/startingArea/enable flags,
 * areaToGenerateAtStart and startingPoints are typed fields, and the tail is
 * re-emitted verbatim. autoplaceSettingsCount is always 0 (decode rejects
 * anything else), so it is re-emitted as 0. Nested structs are rebuilt as
 * plain objects so a reactive (Vue proxy) Preset round-trips cleanly.
 */
export function presetToEncodable(preset: Preset): EncodableExchange {
  const area = preset.areaToGenerateAtStart;
  // opaqueTailB64 carries every tail byte; overlay only the editable
  // MapSettings sections back onto it (byte-exact for unedited presets, since
  // the overlaid values equal the decoded ones).
  const tail = bytesToTail(base64ToBytes(preset.opaqueTailB64), preset.formatVersion);
  writeMapSettingsToTail(tail, preset.mapSettings);
  return {
    version: preset.formatVersion,
    flagByte: 0,
    autoplaceControls: preset.autoplaceControls,
    mid: {
      autoplaceSettingsCount: 0,
      defaultEnableAllAutoplaceControls: preset.defaultEnableAllAutoplaceControls,
      seed: preset.seed ?? 0,
      width: preset.width,
      height: preset.height,
      areaToGenerateAtStart: {
        leftTop: { x: area.leftTop.x, y: area.leftTop.y },
        rightBottom: { x: area.rightBottom.x, y: area.rightBottom.y },
        trailer: Uint8Array.from(area.trailer),
      },
      startingArea: preset.startingArea,
      peacefulMode: preset.peacefulMode,
      noEnemiesMode: preset.noEnemiesMode,
      startingPoints: preset.startingPoints.map((p) => ({ x: p.x, y: p.y })),
    },
    propertyExpressionNames: preset.propertyExpressionNames,
    tail,
  };
}
