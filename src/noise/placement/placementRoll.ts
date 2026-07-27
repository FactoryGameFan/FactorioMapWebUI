/**
 * The game's per-tile entity placement roll, in a deliberately approximate form.
 *
 * Reverse-engineered in `docs/noise/placement-roll-NOTES.md`: `generateEntities`
 * seeds taus88 once per chunk from the chunk position (no `map_seed`), then walks
 * the chunk's tiles in DECREASING tile index, drawing one `U` per tile and placing
 * the arbitrated winner where `U < probability`.
 *
 * Two departures, both deliberate (see the 2026-07-27 spec):
 *
 * 1. **No cross-overlay arbitration.** The game picks one winner per tile by max
 *    probability across every entity autoplacer in the chunk - including ones this
 *    app has never ported. We roll each overlay separately, and give each its own
 *    `salt` so their streams do not correlate. The salt is the one value here with
 *    no counterpart in the game.
 * 2. **No jitter draws.** The game spends two extra draws per PLACEMENT to offset
 *    the entity within its tile, which makes its draw count data-dependent. Dropping
 *    them fixes the count at one draw per tile - which is what makes `roll(x, y)` a
 *    pure function of world position, and therefore safe for the tiled renderer.
 */
import { seededState, taus88Next } from "../taus88";

/** Tiles per chunk edge; 1024 tiles per chunk. */
const CHUNK = 32;
const TILES_PER_CHUNK = CHUNK * CHUNK;

/** Placed entities paint a (2*1+1) = 3x3 mark. Uniform across all roll overlays. */
export const PLACEMENT_MARK_RADIUS_PX = 1;

/**
 * Per-overlay stream salts. Values are arbitrary and carry no meaning beyond being
 * distinct - EXCEPT `vulcanusRocks`, which is 0 so that one overlay reproduces the
 * game's own seed word exactly, letting the unit test pin the RE'd constants.
 */
export const PLACEMENT_SALT = {
  vulcanusRocks: 0,
  nauvisRocks: 0x5f1e21,
  enemyBases: 0xa3c07b,
  vulcanusGeyser: 0x1d94e5,
  crudeOil: 0x76b3af,
} as const;

/** `max(341, 0x3FBE2C + 7919*chunkX + 7907*chunkY + salt)` in u32 arithmetic. */
export function placementRollWord(chunkX: number, chunkY: number, salt: number): number {
  const sum = (0x3fbe2c + Math.imul(7919, chunkX) + Math.imul(7907, chunkY) + salt) >>> 0;
  return Math.max(341, sum);
}

function chunkRolls(chunkX: number, chunkY: number, salt: number): Float64Array {
  const st = seededState(placementRollWord(chunkX, chunkY, salt));
  const out = new Float64Array(TILES_PER_CHUNK);
  // Draws are consumed in decreasing tile index, so draw k belongs to tile 1023-k.
  for (let k = 0; k < TILES_PER_CHUNK; k++) {
    out[TILES_PER_CHUNK - 1 - k] = taus88Next(st) / 4294967296;
  }
  return out;
}

/**
 * Build `roll(x, y) -> U in [0, 1)` for one overlay. Place where `U < probability`.
 *
 * Caching: a single-slot (chunkX, chunkY) check in front of a `Map`. Renderers sweep
 * row-major, so the single slot hits for 32 consecutive pixels and the Map catches
 * the revisit when the next pixel row re-enters a chunk already built. Building a
 * chunk costs 1024 taus88 steps, amortised to ~1 step per tile over the chunk.
 */
export function makePlacementRoll(salt: number): (x: number, y: number) => number {
  const cache = new Map<string, Float64Array>();
  let lastX = NaN;
  let lastY = NaN;
  let last: Float64Array | null = null;

  return (x, y) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const cx = Math.floor(tx / CHUNK);
    const cy = Math.floor(ty / CHUNK);
    if (cx !== lastX || cy !== lastY || last === null) {
      const key = `${cx},${cy}`;
      let rolls = cache.get(key);
      if (rolls === undefined) {
        rolls = chunkRolls(cx, cy, salt);
        cache.set(key, rolls);
      }
      last = rolls;
      lastX = cx;
      lastY = cy;
    }
    return last[(ty & 31) * CHUNK + (tx & 31)];
  };
}
