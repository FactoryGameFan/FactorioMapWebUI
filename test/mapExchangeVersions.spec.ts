import { describe, expect, it } from "vite-plus/test";

import fixture from "./fixtures/map-exchange-2.1.12.strings.json";
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
  });
});
