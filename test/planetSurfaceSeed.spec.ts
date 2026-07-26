import { describe, expect, it } from "vite-plus/test";

import { crc32 } from "../src/codec/crc32";
import { PLANETS } from "../src/model/planets";
import { PLANET_MAP_SEED_OFFSET, surfaceSeedForPlanet } from "../src/model/planetSurfaceSeed";

/**
 * The map seed a player enters is NOT the seed a non-Nauvis planet's surface is
 * generated with. Each planet prototype carries a `map_seed_offset`, and the
 * game creates the surface with `(mapSeed + offset) mod 2^32`. Nauvis declares
 * `map_seed_offset = 0` (`base/prototypes/planet/planet.lua`); the four Space
 * Age planets leave it unset and the engine defaults it to `crc32(name)`.
 *
 * These rows are ground truth measured from Factorio 2.1.12 headless: create a
 * save with Space Age at a known `--map-gen-seed`, then read
 * `game.planets[name].create_surface().map_gen_settings.seed` back WITHOUT
 * overwriting it. See `docs/noise/vulcanus-resources-NOTES.md`.
 */
const MEASURED: { mapSeed: number; seeds: Record<string, number> }[] = [
  {
    mapSeed: 0,
    seeds: {
      nauvis: 0,
      vulcanus: 1249812791,
      gleba: 3215082971,
      fulgora: 2967579010,
      aquilo: 3111799872,
    },
  },
  {
    mapSeed: 1,
    seeds: {
      nauvis: 1,
      vulcanus: 1249812792,
      gleba: 3215082972,
      fulgora: 2967579011,
      aquilo: 3111799873,
    },
  },
  {
    mapSeed: 123456,
    seeds: {
      nauvis: 123456,
      vulcanus: 1249936247,
      gleba: 3215206427,
      fulgora: 2967702466,
      aquilo: 3111923328,
    },
  },
  {
    mapSeed: 123457,
    seeds: {
      nauvis: 123457,
      vulcanus: 1249936248,
      gleba: 3215206428,
      fulgora: 2967702467,
      aquilo: 3111923329,
    },
  },
  {
    mapSeed: 1000000,
    seeds: {
      nauvis: 1000000,
      vulcanus: 1250812791,
      gleba: 3216082971,
      fulgora: 2968579010,
      aquilo: 3112799872,
    },
  },
  // The wrapping row: every non-Nauvis sum here exceeds 2^32, so a version that
  // forgot the mod (or used a signed 32-bit add) fails on this one alone.
  {
    mapSeed: 2801636144,
    seeds: {
      nauvis: 2801636144,
      vulcanus: 4051448935,
      gleba: 1721751819,
      fulgora: 1474247858,
      aquilo: 1618468720,
    },
  },
];

/**
 * Custom planets registered in a probe mod as deep copies of Vulcanus differing
 * ONLY in `name`, measured at map seed 0. `aaa` and `aab` landing on unrelated
 * offsets is what rules out registration order / an index and pins the default
 * to a hash of the name.
 */
const CUSTOM_CLONE_OFFSETS: Record<string, number> = {
  aaa: 4027020077,
  aab: 1762534039,
  vulcanus_copy: 2729456570,
};

const utf8 = new TextEncoder();

describe("the engine's default map_seed_offset is crc32(planet name)", () => {
  it("reproduces every measured Space Age planet offset", () => {
    for (const planet of PLANETS) {
      if (planet === "nauvis") continue; // declares map_seed_offset = 0 explicitly
      expect(crc32(utf8.encode(planet)), planet).toBe(PLANET_MAP_SEED_OFFSET[planet]);
    }
  });

  it("reproduces the custom-planet clones, which is what identifies it as a NAME hash", () => {
    for (const [name, offset] of Object.entries(CUSTOM_CLONE_OFFSETS)) {
      expect(crc32(utf8.encode(name)), name).toBe(offset);
    }
    // Same prototype, different name => different offset. Order/index is out.
    expect(CUSTOM_CLONE_OFFSETS.aaa).not.toBe(CUSTOM_CLONE_OFFSETS.aab);
  });
});

describe("surfaceSeedForPlanet", () => {
  it("reproduces every measured planet seed from the game", () => {
    for (const row of MEASURED) {
      for (const planet of PLANETS) {
        expect(
          surfaceSeedForPlanet(planet, row.mapSeed),
          `${planet} @ mapSeed=${row.mapSeed}`,
        ).toBe(row.seeds[planet]);
      }
    }
  });

  it("is the identity on Nauvis", () => {
    expect(PLANET_MAP_SEED_OFFSET.nauvis).toBe(0);
    for (const mapSeed of [0, 1, 123456, 0xffffffff]) {
      expect(surfaceSeedForPlanet("nauvis", mapSeed)).toBe(mapSeed);
    }
  });

  it("always returns an unsigned 32-bit integer", () => {
    for (const planet of PLANETS) {
      for (const mapSeed of [0, 1, 123456, 0x7fffffff, 0x80000000, 0xffffffff]) {
        const seed = surfaceSeedForPlanet(planet, mapSeed);
        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThanOrEqual(0xffffffff);
      }
    }
  });
});
