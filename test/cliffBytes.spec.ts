import { describe, expect, it } from "vite-plus/test";
import { bytesToBase64 } from "../src/codec/base64";
import { crc32 } from "../src/codec/crc32";
import { deflateLevel9 } from "../src/codec/deflate";
import { decodeExchangeString, ExchangeStringError } from "../src/codec/mapExchangeString";
import { toMapGenSettingsJson } from "../src/io/jsonExport";
import { presetFromDecoded } from "../src/model/convert";
import builtins from "./fixtures/builtin-presets.json";
import fixture212 from "./fixtures/map-exchange-2.1.12.strings.json";
import fixture214 from "./fixtures/map-exchange-2.1.14.strings.json";
import fixture215 from "./fixtures/map-exchange-2.1.15.strings.json";
import fixture216 from "./fixtures/map-exchange-2.1.16.strings.json";
import fixture217 from "./fixtures/map-exchange-2.1.17.strings.json";
import fixture219 from "./fixtures/map-exchange-2.1.19.strings.json";
import fixture220 from "./fixtures/map-exchange-2.1.20.strings.json";
import fixture221 from "./fixtures/map-exchange-2.1.21.strings.json";
import fixture222 from "./fixtures/map-exchange-2.1.22.strings.json";
import fixture223 from "./fixtures/map-exchange-2.1.23.strings.json";
import fixture224 from "./fixtures/map-exchange-2.1.24.strings.json";
import fixture225 from "./fixtures/map-exchange-2.1.25.strings.json";
import gameParse from "./fixtures/map-exchange-parsed.water-and-cliffs.2.1.23-game.dump.json";
import gameParse225 from "./fixtures/map-exchange-parsed.water-and-cliffs.2.1.25-game.dump.json";

/**
 * Bytes 76-79 of the tail are `cliff_smoothing`, bytes 80-83 are `richness`, and
 * byte 84 is the COUNT of `territory_settings.units` (2.1.23 game probes, 2026-11).
 * Before that the codec called them richness, an unknown float and
 * "cliffSmoothing". A round-trip cannot see a wrong name, so these tests grade
 * the names against the game's own `helpers.parse_map_exchange_string`.
 *
 * Ground truth is the game's parse in
 * `map-exchange-parsed.water-and-cliffs.2.1.23-game.dump.json` and
 * `...2.1.25-game.dump.json` (probe: `scripts/probes/exchange-cliff-bytes/`). The
 * 2.1.25 build reads every version's string; a 2.1.23 game refuses 2.1.24+. NEVER grade these fields
 * against a surface's `map_gen_settings`: the Nauvis planet forces
 * `cliff_smoothing` to 0 whatever the string carries.
 */

const FIXTURES: Record<string, { strings: Record<string, string> }> = {
  "2.1.12": fixture212,
  "2.1.14": fixture214,
  "2.1.15": fixture215,
  "2.1.16": fixture216,
  "2.1.17": fixture217,
  "2.1.19": fixture219,
  "2.1.20": fixture220,
  "2.1.21": fixture221,
  "2.1.22": fixture222,
  "2.1.23": fixture223,
  "2.1.24": fixture224,
  "2.1.25": fixture225,
};

type GameParse = Record<
  string,
  { ok: boolean; cliff_settings?: { cliff_smoothing: number; richness: number } }
>;
const GAME = gameParse.parsed as GameParse;
const GAME_225 = gameParse225.parsed as GameParse;

/** Offset of the four cliff-settings floats, found by their known values. */
function findCliffFloats(payload: Uint8Array, values: number[]): number {
  const want = new Uint8Array(new Float32Array(values).buffer);
  for (let i = 0; i + want.length <= payload.length; i++) {
    if (want.every((b, k) => payload[i + k] === b)) return i;
  }
  throw new Error("cliff floats not found in payload");
}

function restring(body: Uint8Array): string {
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  new DataView(out.buffer).setUint32(body.length, crc32(body), true);
  return `>>>${bytesToBase64(deflateLevel9(out))}<<<`;
}

describe("cliff bytes carry the game's names", () => {
  describe.each(Object.keys(FIXTURES))("water-and-cliffs, format %s", (version) => {
    const str = FIXTURES[version]?.strings["water-and-cliffs"] as string;
    const tail = decodeExchangeString(str).tail;

    it("reads richness 0.5 and smoothing 1, with the cliff elevations the case set", () => {
      expect(tail["cliff.richness"]).toBeCloseTo(0.5, 6);
      expect(tail["cliff.cliffSmoothing"]).toBeCloseTo(1, 6);
      expect(tail["cliff.cliffElevation0"]).toBeCloseTo(20, 4);
      expect(tail["cliff.cliffElevationInterval"]).toBeCloseTo(60, 4);
      expect(tail["territory.unitCount"]).toBe(0);
    });

    it("agrees with the 2.1.25 game's own parse", () => {
      const game = GAME_225[version];
      expect(game?.ok).toBe(true);
      expect(tail["cliff.richness"]).toBeCloseTo(game?.cliff_settings?.richness as number, 6);
      expect(tail["cliff.cliffSmoothing"]).toBeCloseTo(
        game?.cliff_settings?.cliff_smoothing as number,
        6,
      );
    });

    it("agrees with the 2.1.23 game's parse where that build could read it", () => {
      const game = GAME[version];
      if (game?.ok) {
        expect(tail["cliff.richness"]).toBeCloseTo(game.cliff_settings?.richness as number, 6);
        expect(tail["cliff.cliffSmoothing"]).toBeCloseTo(
          game.cliff_settings?.cliff_smoothing as number,
          6,
        );
      } else {
        // A 2.1.23 game refuses a newer map version; the 2.1.25 parse above
        // grades 2.1.24 and 2.1.25 instead.
        expect(["2.1.24", "2.1.25"]).toContain(version);
      }
    });
  });

  it("control: the game's parse and the raw slots both say richness is the SECOND float", () => {
    // Independent of the codec's names. The game says smoothing 1 and richness
    // 0.5; the raw payload holds f32 1 then f32 0.5 after the two elevations.
    // The old labelling (richness first) would read 1 here and fail.
    const str = fixture223.strings["water-and-cliffs"];
    const payload = decodeExchangeString(str).payload;
    const at = findCliffFloats(payload, [20, 60, 1, 0.5]);
    const view = new DataView(payload.buffer, payload.byteOffset);
    expect(view.getFloat32(at + 8, true)).toBe(GAME["2.1.23"]?.cliff_settings?.cliff_smoothing);
    expect(view.getFloat32(at + 12, true)).toBe(GAME["2.1.23"]?.cliff_settings?.richness);
    const tail = decodeExchangeString(str).tail;
    expect(tail["cliff.richness"]).toBe(view.getFloat32(at + 12, true));
    expect(tail["cliff.richness"]).not.toBe(view.getFloat32(at + 8, true));
  });

  describe("territory unit count (byte 84)", () => {
    const def = builtins.presets["Default"] as string;

    it("refuses a non-zero count instead of decoding the territory data as the tail", () => {
      const good = decodeExchangeString(def);
      const body = good.payload.slice(0, -4);
      const at = findCliffFloats(body, [10, 40, 1, 1]) + 16;
      expect(body[at]).toBe(0);
      const enc = new TextEncoder();
      const lstr = (s: string) => Uint8Array.from([s.length, ...enc.encode(s)]);
      // Count 1, then what the game reads for it: one unit name, two
      // expression strings and a u32 (the game parsed this shape cleanly).
      const territory = Uint8Array.from([
        ...lstr("small-demolisher"),
        ...lstr(""),
        ...lstr(""),
        7,
        0,
        0,
        0,
      ]);
      const patched = new Uint8Array(body.length + territory.length);
      patched.set(body.subarray(0, at), 0);
      patched[at] = 1;
      patched.set(territory, at + 1);
      patched.set(body.subarray(at + 1), at + 1 + territory.length);

      expect(() => decodeExchangeString(restring(patched))).toThrow(ExchangeStringError);
      expect(() => decodeExchangeString(restring(patched))).toThrow(/territory/);
    });

    it("control: the same string with the count left at 0 decodes", () => {
      const good = decodeExchangeString(def);
      expect(
        decodeExchangeString(restring(good.payload.slice(0, -4))).tail["territory.unitCount"],
      ).toBe(0);
    });
  });

  describe("JSON export", () => {
    it("writes the game's cliff_smoothing and richness for Default", () => {
      const p = presetFromDecoded("Default", decodeExchangeString(builtins.presets["Default"]));
      const cs = (toMapGenSettingsJson(p) as { cliff_settings: Record<string, number> })
        .cliff_settings;
      expect(cs["cliff_smoothing"]).toBeCloseTo(1, 6);
      expect(cs["richness"]).toBeCloseTo(1, 6);
    });

    it("writes richness 0.5 and smoothing 1 for water-and-cliffs", () => {
      const str = fixture223.strings["water-and-cliffs"];
      const p = presetFromDecoded("wc", decodeExchangeString(str));
      const cs = (toMapGenSettingsJson(p) as { cliff_settings: Record<string, number> })
        .cliff_settings;
      expect(cs["richness"]).toBeCloseTo(GAME["2.1.23"]?.cliff_settings?.richness as number, 6);
      expect(cs["cliff_smoothing"]).toBeCloseTo(
        GAME["2.1.23"]?.cliff_settings?.cliff_smoothing as number,
        6,
      );
      expect(cs["richness"]).toBeCloseTo(0.5, 6);
    });
  });
});
