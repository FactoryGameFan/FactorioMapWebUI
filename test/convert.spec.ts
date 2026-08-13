import { describe, expect, it } from "vite-plus/test";
import { decodeExchangeString, encodeExchangeString } from "../src/codec/mapExchangeString";
import { presetFromDecoded, presetToEncodable } from "../src/model/convert";
import fixtures from "./fixtures/builtin-presets.json";
import fixture214 from "./fixtures/map-exchange-2.1.14.strings.json";

const presets = fixtures.presets as Record<string, string>;

function roundTrip(preset: ReturnType<typeof presetFromDecoded>): string {
  return encodeExchangeString(presetToEncodable(preset));
}

/**
 * The user-facing path for the 2.1.14 import fix: paste a string from the
 * current game, get a Preset, export it again.
 *
 * The tail layout is version-dependent from 2.1.14 on, and this bridge stores
 * the tail as opaque base64 (`opaqueTailB64`) - so it has to carry the format
 * version with it or the re-read picks the wrong schema. `Preset.formatVersion`
 * is what carries it; these tests are what stop that being silently dropped.
 */
describe("2.1.14 presets survive the Preset bridge", () => {
  it("round-trips every 2.1.14 capture byte-exact through Preset and back", () => {
    for (const [label, original] of Object.entries(fixture214.strings)) {
      const preset = presetFromDecoded("x", decodeExchangeString(original));
      expect(preset.formatVersion.join("."), `${label} formatVersion`).toBe("2.1.14.1");
      expect(roundTrip(preset), `${label} re-encode`).toBe(original);
    }
  });

  it("keeps the 2.1.14-only field readable after the opaque-tail hop", () => {
    // opaqueTailB64 is written by tailToBytes and re-read by bytesToTail. If
    // either used the wrong schema the field would vanish or land misaligned.
    const original = fixture214.strings["default-seed123456"];
    const preset = presetFromDecoded("x", decodeExchangeString(original));
    const tail = decodeExchangeString(roundTrip(preset)).tail;
    expect(tail["enemyExpansion.buildBaseUnitDispatchCooldown"]).toBe(1800);
  });

  it("still round-trips a 2.1.9.3 builtin through the same bridge", () => {
    // The older schema must keep working through the version-aware bridge.
    const original = presets["Default"] as string;
    const preset = presetFromDecoded("x", decodeExchangeString(original));
    expect(preset.formatVersion.join(".")).toBe("2.1.9.3");
    expect(roundTrip(preset)).toBe(original);
  });
});

describe("presetToEncodable enemy overlay", () => {
  it("re-encodes an unedited Default byte-identically (overlay is a no-op)", () => {
    const original = presets["Default"] as string;
    const preset = presetFromDecoded("x", decodeExchangeString(original));
    expect(roundTrip(preset)).toBe(original);
  });

  it("flows an edited evolution timeFactor into the re-encoded string", () => {
    const preset = presetFromDecoded("x", decodeExchangeString(presets["Default"] as string));
    preset.mapSettings.enemyEvolution.timeFactor = 0.5;
    const tail = decodeExchangeString(roundTrip(preset)).tail;
    expect(tail["enemyEvolution.timeFactor"]).toBeCloseTo(0.5, 12);
  });

  it("persists a section enabled toggled to false (falsy-edit guard)", () => {
    const preset = presetFromDecoded("x", decodeExchangeString(presets["Default"] as string));
    preset.mapSettings.enemyExpansion.enabled = false;
    const tail = decodeExchangeString(roundTrip(preset)).tail;
    expect(tail["enemyExpansion.enabled"]).toBe(false);
  });

  it("persists a numeric enemy field set to 0 (falsy-edit guard)", () => {
    const preset = presetFromDecoded("x", decodeExchangeString(presets["Default"] as string));
    preset.mapSettings.enemyExpansion.maxExpansionDistance = 0;
    const tail = decodeExchangeString(roundTrip(preset)).tail;
    expect(tail["enemyExpansion.maxExpansionDistance"]).toBe(0);
  });
});

describe("presetToEncodable map-settings overlay", () => {
  it("round-trips an untouched Default preset byte-exact", () => {
    const original = presets["Default"] as string;
    const preset = presetFromDecoded("x", decodeExchangeString(original));
    expect(roundTrip(preset)).toBe(original);
  });

  it("persists pollution.enabled toggled to false as present-false", () => {
    const preset = presetFromDecoded("x", decodeExchangeString(presets["Default"] as string));
    preset.mapSettings.pollution.enabled = false;
    const tail = decodeExchangeString(roundTrip(preset)).tail;
    expect(tail["pollution.enabled"]).toBe(false);
  });

  it("persists a numeric pollution field set to 0", () => {
    const preset = presetFromDecoded("x", decodeExchangeString(presets["Default"] as string));
    preset.mapSettings.pollution.minPollutionToDamageTrees = 0;
    const tail = decodeExchangeString(roundTrip(preset)).tail;
    expect(tail["pollution.minPollutionToDamageTrees"]).toBe(0);
  });

  it("round-trips edited technology price multiplier, spoiling, spawning, diffusion", () => {
    const preset = presetFromDecoded("x", decodeExchangeString(presets["Default"] as string));
    preset.mapSettings.difficulty.technologyPriceMultiplier = 4;
    preset.mapSettings.difficulty.spoilTimeModifier = 2;
    preset.mapSettings.asteroids.spawningRate = 2;
    preset.mapSettings.pollution.diffusionRatio = 0.09;
    const tail = decodeExchangeString(roundTrip(preset)).tail;
    expect(tail["difficulty.technologyPriceMultiplier"]).toBeCloseTo(4, 12);
    expect(tail["difficulty.spoilTimeModifier"]).toBeCloseTo(2, 12);
    expect(tail["asteroids.spawningRate"]).toBeCloseTo(2, 12);
    expect(tail["pollution.diffusionRatio"]).toBeCloseTo(0.09, 12);
  });

  it("re-setting diffusionRatio to its decoded value re-encodes byte-exact", () => {
    const original = presets["Default"] as string;
    const preset = presetFromDecoded("x", decodeExchangeString(original));
    // No-op edit at the decoded value must not perturb bytes. Route through a
    // temp so it is not a literal self-assignment (oxlint no-self-assign).
    const decoded = preset.mapSettings.pollution.diffusionRatio;
    preset.mapSettings.pollution.diffusionRatio = decoded;
    expect(roundTrip(preset)).toBe(original);
  });
});
