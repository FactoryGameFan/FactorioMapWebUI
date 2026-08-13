import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/map-exchange-2.1.12.strings.json";
import fixture214 from "./fixtures/map-exchange-2.1.14.strings.json";
import parsed214 from "./fixtures/map-exchange-parsed.2.1.14-default.dump.json";
import builtins from "./fixtures/builtin-presets.json";
import {
  SUPPORTED_VERSIONS,
  SUPPORTED_VERSIONS_LABEL,
  decodeExchangeString,
  encodeExchangeString,
} from "../src/codec/mapExchangeString";

/**
 * The exchange format the game emits is versioned, and it MOVED: Factorio 2.1.12
 * writes `2.1.12.2` where 2.1.9 wrote `2.1.9.3`. Until 2026-07-28 this decoder
 * accepted only the latter, so a string copied out of the current game was
 * rejected outright - found by the fixture audit (#7), which is exactly the
 * "version skew is invisible from the inside" failure that audit exists for.
 *
 * **The layout did not change; only the tag did.** These five captures vary the
 * things most likely to shift a binary layout - seeds, autoplace controls at
 * non-default frequency/size/richness, water/terrain_segmentation/cliff_settings/
 * starting_area, and the peaceful/no_enemies flags that live in the mid-block -
 * and every one re-encodes byte-for-byte.
 *
 * That byte-exactness is the whole point. A format can be *decodable* while
 * being subtly wrong; only round-tripping proves this decoder read every field
 * where the game put it. **A new version does not go into `SUPPORTED_VERSIONS`
 * without a fixture here proving the same.**
 *
 * Regenerate: a probe mod whose `on_init` writes
 * `game.get_map_exchange_string()` and `error("DUMPED-OK")`s, run headless per
 * settings case (the recipe `test/oracle/oracle.ts` uses for every other
 * capture).
 */
describe("exchange format versions", () => {
  it("round-trips every 2.1.12 capture byte-for-byte", () => {
    const entries = Object.entries(fixture.strings);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const [label, s] of entries) {
      const decoded = decodeExchangeString(s);
      expect(decoded.version.join("."), `${label} format tag`).toBe("2.1.12.2");
      expect(encodeExchangeString(decoded), `${label} re-encode`).toBe(s);
    }
  });

  it("still round-trips the 2.1.9.3 builtin presets", () => {
    // The older format must keep working: widening the accepted set is only safe
    // if it did not disturb the format the nine builtins are captured in.
    for (const [name, s] of Object.entries(builtins.presets)) {
      const decoded = decodeExchangeString(s);
      expect(decoded.version.join("."), `${name} format tag`).toBe("2.1.9.3");
      expect(encodeExchangeString(decoded), `${name} re-encode`).toBe(s);
    }
  });

  it("rejects an unknown format rather than guessing at it", () => {
    // The schemas are empirical, so decoding an unseen layout would produce
    // plausible-looking wrong values - worse than a clean failure. Take a real
    // string and corrupt only its version word.
    const real = Object.values(fixture.strings)[0];
    const decoded = decodeExchangeString(real);
    const bogus = encodeExchangeString({ ...decoded, version: [2, 9, 9, 9] });
    expect(() => decodeExchangeString(bogus)).toThrow(/unsupported exchange format 2\.9\.9\.9/);
  });

  it("advertises exactly the versions it accepts", () => {
    expect(SUPPORTED_VERSIONS_LABEL).toBe(SUPPORTED_VERSIONS.map((v) => v.join(".")).join(", "));
    expect(SUPPORTED_VERSIONS_LABEL).toContain("2.1.12.2");
    expect(SUPPORTED_VERSIONS_LABEL).toContain("2.1.14.1");
  });
});

/**
 * Factorio 2.1.14 moved the format again - to `2.1.14.1` - and this time the
 * PAYLOAD moved too, which 2.1.12 did not. `map-settings.lua` gained
 * `enemy_expansion.build_base_unit_dispatch_cooldown` (30 * 60 ticks) between
 * 2.1.12 and 2.1.14, and it is serialized in section order, so it lands after
 * `max_expansion_cooldown` and shifts every section after it.
 *
 * That makes the tail schema VERSION-DEPENDENT for the first time: a 2.1.9.3 or
 * 2.1.12.2 string has no such field and a 2.1.14.1 string does. Decoding one
 * with the other's schema is not a near miss - it over-reads the payload end.
 *
 * Import was the broken half again; export was not. Verified through the game's
 * own `helpers.parse_map_exchange_string` on the 2.1.14 binary: it ACCEPTS the
 * `2.1.9.3` strings this app emits (seed round-trips), so the app's output
 * stayed loadable throughout.
 *
 * Regenerate: same recipe as the 2.1.12 capture - a probe mod whose `on_init`
 * writes `game.get_map_exchange_string()` alongside
 * `helpers.parse_map_exchange_string(s)` and `error("DUMPED-OK")`s, run headless
 * once per settings case with an isolated `--config`. The five cases mirror
 * `map-exchange-2.1.12.strings.json` setting-for-setting.
 */
describe("exchange format 2.1.14", () => {
  it("round-trips every 2.1.14 capture byte-for-byte", () => {
    const entries = Object.entries(fixture214.strings);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const [label, s] of entries) {
      const decoded = decodeExchangeString(s);
      expect(decoded.version.join("."), `${label} format tag`).toBe("2.1.14.1");
      expect(encodeExchangeString(decoded), `${label} re-encode`).toBe(s);
    }
  });

  it("types the whole 2.1.14 tail - opaqueTail stays empty", () => {
    // The guard that catches a shifted layout. A schema that stopped one field
    // short would leave the surplus bytes here while still round-tripping.
    for (const [label, s] of Object.entries(fixture214.strings)) {
      const tail = decodeExchangeString(s).tail;
      expect((tail.opaqueTail as Uint8Array).length, `${label} opaqueTail`).toBe(0);
    }
  });

  it("reads build_base_unit_dispatch_cooldown where the game puts it", () => {
    // Cross-validated against the game's OWN parse of the same string, not
    // against our own re-encode - a self-consistent decoder can still be wrong.
    const decoded = decodeExchangeString(fixture214.strings["default-seed123456"]);
    const game = parsed214.map_settings.enemy_expansion;
    expect(decoded.tail["enemyExpansion.buildBaseUnitDispatchCooldown"]).toBe(
      game.build_base_unit_dispatch_cooldown,
    );
    // Its neighbours must not have shifted to make it fit.
    expect(decoded.tail["enemyExpansion.maxExpansionCooldown"]).toBe(game.max_expansion_cooldown);
    expect(decoded.tail["enemyExpansion.settlerGroupMaxSize"]).toBe(game.settler_group_max_size);
  });

  it("does NOT read that field for the older formats, which do not carry it", () => {
    // The version-conditional half. If the field were unconditional, these two
    // would decode a byte that belongs to unit_group.
    for (const [label, s] of Object.entries(fixture.strings)) {
      const tail = decodeExchangeString(s).tail;
      expect("enemyExpansion.buildBaseUnitDispatchCooldown" in tail, `2.1.12 ${label}`).toBe(false);
    }
    for (const [name, s] of Object.entries(builtins.presets)) {
      const tail = decodeExchangeString(s).tail;
      expect("enemyExpansion.buildBaseUnitDispatchCooldown" in tail, `2.1.9 ${name}`).toBe(false);
    }
  });

  it("agrees with the game's own parse across the whole 2.1.14 tail", () => {
    // Field-for-field against helpers.parse_map_exchange_string, the same
    // cross-validation decode.spec.ts runs for the mid-block. This is what
    // proves the new field did not simply absorb a misalignment.
    const tail = decodeExchangeString(fixture214.strings["default-seed123456"]).tail;
    const game = parsed214.map_settings;
    const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const sections: Record<string, Record<string, unknown>> = {
      pollution: game.pollution,
      enemyEvolution: game.enemy_evolution,
      enemyExpansion: game.enemy_expansion,
      unitGroup: game.unit_group,
      difficulty: game.difficulty_settings,
    };
    let compared = 0;
    for (const [prefix, section] of Object.entries(sections)) {
      for (const [gameKey, gameValue] of Object.entries(section)) {
        const key = `${prefix}.${camel(gameKey)}`;
        if (!(key in tail)) continue;
        expect(tail[key], key).toBe(gameValue);
        compared++;
      }
    }
    // Non-vacuity: a typo in the naming above would silently compare nothing.
    expect(compared).toBeGreaterThanOrEqual(40);
  });
});
