import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/map-exchange-2.1.12.strings.json";
import fixture214 from "./fixtures/map-exchange-2.1.14.strings.json";
import fixture215 from "./fixtures/map-exchange-2.1.15.strings.json";
import fixture216 from "./fixtures/map-exchange-2.1.16.strings.json";
import fixture217 from "./fixtures/map-exchange-2.1.17.strings.json";
import parsed214 from "./fixtures/map-exchange-parsed.2.1.14-default.dump.json";
import parsed215 from "./fixtures/map-exchange-parsed.2.1.15-default.dump.json";
import parsed216 from "./fixtures/map-exchange-parsed.2.1.16-default.dump.json";
import parsed217 from "./fixtures/map-exchange-parsed.2.1.17-default.dump.json";
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
    expect(SUPPORTED_VERSIONS_LABEL).toContain("2.1.15.2");
    expect(SUPPORTED_VERSIONS_LABEL).toContain("2.1.16.0");
    expect(SUPPORTED_VERSIONS_LABEL).toContain("2.1.17.0");
  });
});

/**
 * Every strings fixture records the exchange tag it was captured at, and this
 * asserts that record against the strings themselves.
 *
 * **It exists because the field went silently empty for two versions.** The
 * capture script read the tag from `process.env.EXCHANGE_TAG ?? ""`, which
 * nobody ever set, so `map-exchange-2.1.15` and `map-exchange-2.1.16` shipped
 * with `""` while 2.1.14 carried `"2.1.14.1"`. An empty metadata field reads as
 * "not applicable" rather than "the capture forgot", which is why two versions
 * went by. The script derives it from the captured payload now, and this is the
 * guard that keeps it derived.
 *
 * **The two sides are independent, so this is a cross-check rather than a
 * tautology.** The recorded value comes from the capture script's own
 * `node:zlib` inflate plus a raw `DataView` read of four `u16`s; the expected
 * value here comes from `decodeExchangeString`, which is the thing under test
 * everywhere else in this file. A bug in either one alone fails this.
 *
 * Asserted for EVERY fixture rather than only the ones with a value, because a
 * guard that skips empty tags has a hole in exactly the shape of the bug it
 * guards against.
 */
describe("every fixture records the tag it was captured at", () => {
  const FIXTURES = [
    { version: "2.1.12", fixture },
    { version: "2.1.14", fixture: fixture214 },
    { version: "2.1.15", fixture: fixture215 },
    { version: "2.1.16", fixture: fixture216 },
    { version: "2.1.17", fixture: fixture217 },
  ] as const;

  it.each(FIXTURES)("$version", ({ version, fixture: f }) => {
    const recorded = f._exchangeFormatTag;
    // Not merely non-empty: the first three parts are the game version, so a
    // tag copied from the wrong fixture fails here rather than at the compare.
    expect(recorded, `${version} records no tag`).not.toBe("");
    expect(recorded.startsWith(version + ".")).toBe(true);

    const strings = Object.entries(f.strings as Record<string, string>);
    expect(strings.length).toBeGreaterThanOrEqual(5);
    for (const [label, s] of strings) {
      expect(decodeExchangeString(s).version.join("."), `${version} ${label}`).toBe(recorded);
    }
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

/**
 * Factorio 2.1.15 moved the tag a THIRD time - to `2.1.15.2` - and this time the
 * payload did NOT move. Steam auto-updated the binary on 2026-08-24 and import
 * broke the same morning, which is the same mechanism as 2.1.12 and 2.1.14: the
 * game is the one version nobody here controls.
 *
 * ## Why this reuses the 2.1.14 tail layout rather than getting its own
 *
 * Three independent readings, none of which is "it looked the same":
 *
 * 1. `base/prototypes/map-settings.lua` is byte-identical 2.1.14 -> 2.1.15 - the
 *    file is absent from the tag-to-tag diff entirely. `map-settings.example.json`
 *    DID change, and is a red herring: it was catching up to the 2.1.14 default
 *    change it had missed.
 * 2. Every case re-captured at 2.1.15 inflates to exactly the byte count its
 *    2.1.14 counterpart does, `controls-off`'s odd 750 included. That is pinned
 *    below rather than described.
 * 3. The game's own parse of the new default string is identical to the 2.1.14
 *    parse across all 186 leaf fields.
 *
 * ## The five cases MIRROR 2.1.14's, and that is now a mechanism
 *
 * `scripts/probes/exchange-format/capture.ts` reads each case's settings back
 * out of the previous fixture through `helpers.parse_map_exchange_string`, feeds
 * the DELTA against the default case in as `--map-gen-settings`, and asks the
 * game for its string. So a case cannot drift from what it was at the previous
 * version: there is one definition of what `controls-off` means.
 *
 * The delta is load-bearing, not tidiness. `parse_map_exchange_string` fills in
 * all 28 autoplace controls, and the exchange string writes every control that
 * was supplied EXPLICITLY - so feeding a whole parse back inflates the payload
 * 711 -> 1387 and flattens all five cases to the same length, destroying the
 * only reason there are five. Measured, with the table, in the capture script.
 */
/**
 * Every version AFTER 2.1.14 that reuses its tail layout, each mirrored against
 * the one before it.
 *
 * There are three of these and there will be more, so this is a table rather
 * than a third copy-pasted describe block. Each entry names the version, the exact
 * format tag, its own captures and the game's own parse of its default string,
 * plus the PREVIOUS version's captures - which is what "the five cases mirror
 * setting-for-setting" is checked against.
 *
 * Deliberately NOT derived from `SUPPORTED_VERSIONS`: that would make the spec
 * agree with the codec by construction, and the tag is one of the things being
 * asserted. It is written out here so a wrong tag fails rather than propagates.
 */
const LAYOUT_HEIRS = [
  {
    version: "2.1.15",
    tag: "2.1.15.2",
    strings: fixture215.strings as Record<string, string>,
    parsed: parsed215,
    priorVersion: "2.1.14",
    prior: fixture214.strings as Record<string, string>,
  },
  {
    version: "2.1.16",
    tag: "2.1.16.0",
    strings: fixture216.strings as Record<string, string>,
    parsed: parsed216,
    priorVersion: "2.1.15",
    prior: fixture215.strings as Record<string, string>,
  },
  {
    version: "2.1.17",
    tag: "2.1.17.0",
    strings: fixture217.strings as Record<string, string>,
    parsed: parsed217,
    priorVersion: "2.1.16",
    prior: fixture216.strings as Record<string, string>,
  },
] as const;

/**
 * Factorio moved the format tag again at 2.1.15, again at 2.1.16 and again at
 * 2.1.17, and NONE of them moved the payload. All three were found the same way:
 * Steam auto-updated the binary and import broke, which is the same mechanism as
 * 2.1.12 and 2.1.14 - the game is the one version nobody here controls. 2.1.15
 * and 2.1.16 arrived on the same day; 2.1.17 followed on 2026-09-06 and was
 * caught by `test/factorioTarget.spec.ts` rather than by a user.
 *
 * ## Why these reuse the 2.1.14 tail layout rather than getting their own
 *
 * Three independent readings per version, none of which is "it looked the same":
 *
 * 1. `base/prototypes/map-settings.lua` is absent from each tag-to-tag diff
 *    entirely. At 2.1.15 `map-settings.example.json` DID change and is a red
 *    herring - it was catching up to the 2.1.14 default change it had missed.
 *    2.1.16 changes nothing but `info.json` versions and the changelog, and
 *    2.1.17 adds only `elevated-rail-pictures.lua` to that same set.
 * 2. Every case re-captured inflates to exactly the byte count its predecessor
 *    does, `controls-off`'s odd 750 included. Pinned below rather than described.
 * 3. The game's own parse of each new default string is identical to the
 *    previous one across all 186 leaf fields.
 *
 * ## The tag is NOT guessable from the version number
 *
 * `2.1.9.3`, `2.1.12.2`, `2.1.14.1`, `2.1.15.2`, `2.1.16.0`, `2.1.17.0` - the
 * fourth part does not increase and does not track the patch. Read it off the binary:
 * `factorio --version` prints `Map output version: X.Y.Z-W`, and W is that part.
 * Confirmed against a binary whose tag was already known (2.1.14 prints
 * `2.1.14-1`), so it is a control rather than a pattern match.
 *
 * ## The five cases MIRROR the previous version's, and that is a mechanism
 *
 * `scripts/probes/exchange-format/capture.ts` reads each case's settings back
 * out of the previous fixture through `helpers.parse_map_exchange_string`, feeds
 * the DELTA against the default case in as `--map-gen-settings`, and asks the
 * game for its string. So a case cannot drift from what it meant one version
 * ago: there is one definition of what `controls-off` is.
 *
 * The delta is load-bearing, not tidiness. `parse_map_exchange_string` fills in
 * all 28 autoplace controls, and the exchange string writes every control that
 * was supplied EXPLICITLY - so feeding a whole parse back inflates the payload
 * 711 -> 1387 and flattens all five cases to the same length, destroying the
 * only reason there are five. Measured, with the table, in the capture script.
 */
describe.each(LAYOUT_HEIRS)("exchange format $version", (heir) => {
  it("round-trips every capture byte-for-byte", () => {
    const entries = Object.entries(heir.strings);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const [label, s] of entries) {
      const decoded = decodeExchangeString(s);
      expect(decoded.version.join("."), `${label} format tag`).toBe(heir.tag);
      expect(encodeExchangeString(decoded), `${label} re-encode`).toBe(s);
    }
  });

  it("types the whole tail - opaqueTail stays empty", () => {
    for (const [label, s] of Object.entries(heir.strings)) {
      const tail = decodeExchangeString(s).tail;
      expect((tail.opaqueTail as Uint8Array).length, `${label} opaqueTail`).toBe(0);
    }
  });

  it("carries build_base_unit_dispatch_cooldown, so it shares 2.1.14's layout", () => {
    // Cross-validated against the game's OWN parse of the same string. Given the
    // pre-2.1.14 schema this over-reads the payload end and throws, so the
    // failure is loud - but that is luck rather than design, and the assertion
    // is here so it does not have to be.
    const decoded = decodeExchangeString(heir.strings["default-seed123456"] as string);
    const game = heir.parsed.map_settings.enemy_expansion;
    expect(decoded.tail["enemyExpansion.buildBaseUnitDispatchCooldown"]).toBe(
      game.build_base_unit_dispatch_cooldown,
    );
    expect(decoded.tail["enemyExpansion.maxExpansionCooldown"]).toBe(game.max_expansion_cooldown);
    expect(decoded.tail["enemyExpansion.settlerGroupMaxSize"]).toBe(game.settler_group_max_size);
  });

  it("has a payload the same size as the previous version's, case for case", () => {
    // The reading that says the layout did not move. Sizes are pinned exactly,
    // not bounded: `controls-off` is the case that is a different length from
    // the other four, and if a capture ever flattens them all to one number the
    // five cases have stopped varying anything and this goes red.
    const sizes = Object.keys(heir.prior).map((label) => ({
      label,
      before: decodeExchangeString(heir.prior[label] as string).payload.length,
      after: decodeExchangeString(heir.strings[label] as string).payload.length,
    }));
    for (const { label, before, after } of sizes) {
      expect(after, `${label} payload size vs ${heir.priorVersion}`).toBe(before);
    }
    // Non-vacuity: the cases must not all be the same size, or the check above
    // would pass on a fixture that had lost its layout variation entirely.
    expect(new Set(sizes.map((s) => s.after)).size).toBeGreaterThan(1);
  });

  it("mirrors the previous version's cases setting-for-setting", () => {
    // What makes the size comparison above meaningful: the two fixtures have to
    // be the SAME five cases. Everything outside the version tag must match.
    let compared = 0;
    for (const label of Object.keys(heir.prior)) {
      const a = decodeExchangeString(heir.prior[label] as string);
      const b = decodeExchangeString(heir.strings[label] as string);
      expect(b.autoplaceControls, `${label} autoplace controls`).toEqual(a.autoplaceControls);
      expect(b.mid, `${label} mid-block`).toEqual(a.mid);
      expect(b.propertyExpressionNames, `${label} property expressions`).toEqual(
        a.propertyExpressionNames,
      );
      expect(b.tail, `${label} tail`).toEqual(a.tail);
      compared++;
    }
    expect(compared).toBe(5);
  });
});

describe("older formats keep working", () => {
  it("still decodes 2.1.14 and 2.1.9, so export was never the broken half", () => {
    // Each newer game accepts the strings this app emits - verified in the
    // capture runs themselves, where every case's settings were recovered by
    // handing the game its PREVIOUS version's string. This is our own decoder's
    // half of that: widening the accepted set did not disturb the older tags.
    for (const [label, s] of Object.entries(fixture214.strings)) {
      expect(decodeExchangeString(s).version.join("."), label).toBe("2.1.14.1");
    }
    for (const [name, s] of Object.entries(builtins.presets)) {
      expect(decodeExchangeString(s).version.join("."), name).toBe("2.1.9.3");
    }
  });
});
