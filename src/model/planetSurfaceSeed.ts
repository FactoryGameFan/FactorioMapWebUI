import { crc32 } from "../codec/crc32";
import { PLANETS, type Planet } from "./planets";

/**
 * Planets whose prototype declares an explicit `map_seed_offset`. Only Nauvis
 * does, at 0 (`base/prototypes/planet/planet.lua`) - which is why the map seed
 * a player enters IS the Nauvis surface seed, and is not the surface seed of
 * anything else.
 */
const EXPLICIT_MAP_SEED_OFFSET: Partial<Record<Planet, number>> = {
  nauvis: 0,
};

const encoder = new TextEncoder();

/**
 * The default `map_seed_offset` the engine derives for a planet that does not
 * declare one: **CRC32 of the planet's name** (zlib/ANSI polynomial - the same
 * function the map-exchange codec uses).
 *
 * REVERSE-ENGINEERED from the game, and identified rather than guessed: two
 * planet prototypes that were deep copies of Vulcanus differing only in name
 * ("aaa" vs "aab") came back with unrelated offsets, ruling out registration
 * order or an index; `crc32(name)` then reproduced all seven measured planets
 * (the four Space Age ones plus three custom clones) exactly. See
 * `test/planetSurfaceSeed.spec.ts` for the raw measurements.
 *
 * That the offset is a hash of the NAME is what makes hardcoding unnecessary
 * and makes these values durable: planet names are public prototype API and do
 * not change, so the offsets are pinned by the names, not by a build. A future
 * Factorio release could still change how the default is derived - the measured
 * rows in the spec are the tripwire for that.
 */
function defaultMapSeedOffset(planet: Planet): number {
  return crc32(encoder.encode(planet));
}

/**
 * Per-planet `map_seed_offset`: the constant the game adds to the map seed to
 * get the seed that planet's surface is actually generated with.
 */
export const PLANET_MAP_SEED_OFFSET: Record<Planet, number> = Object.fromEntries(
  PLANETS.map((p) => [p, EXPLICIT_MAP_SEED_OFFSET[p] ?? defaultMapSeedOffset(p)]),
) as Record<Planet, number>;

/**
 * The surface seed `planet` is generated with for a map created at `mapSeed` -
 * i.e. what every noise field downstream (`seed0`) must be given.
 *
 * This is the difference between "the seed the player typed" and "the seed the
 * noise fields see". A save created at map seed S does NOT generate Vulcanus at
 * S; it generates it at `(S + crc32("vulcanus")) mod 2^32`. Rendering a planet
 * at the raw map seed produces a world no player will ever land on (measured
 * against a real save: 9.7% tile agreement at the raw seed, 96.6% at the
 * derived one). Wraps at 2^32 exactly as the game does.
 */
export function surfaceSeedForPlanet(planet: Planet, mapSeed: number): number {
  return (mapSeed + PLANET_MAP_SEED_OFFSET[planet]) >>> 0;
}
