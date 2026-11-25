/**
 * Two of the four engine "seed vars" that drive Vulcanus's biome rotation
 * (`vulcanus_ashlands_angle = map_seed_normalized * 3600`,
 * `vulcanus_starting_direction = -1 + 2*(map_seed_small & 1)` -
 * `~/GitHub/factorio-data` `space-age/prototypes/planet/planet-vulcanus-map-gen.lua`).
 * Both are pure functions of `seed0` (= `map_seed`, the wire seed), documented
 * (not merely RE'd) in the game's own noise-expressions reference as "16 least
 * significant bits from map_seed" and "0-1 normalized value of map_seed"
 * respectively, and confirmed bit-exact against 12 oracle-sampled seeds
 * spanning the 32-bit range - see docs/noise/vulcanus-seed-vars-NOTES.md for
 * the derivation, residuals, and the `x_from_start`/`y_from_start` finding
 * (out of scope for this file: they resolved to `== x, y` at the default
 * spawn and needed no port).
 */

/**
 * `map_seed_normalized`: `Math.fround(seed0 / (2^32 - 1))`. The divisor is
 * `4294967295`, not `2^32` (#531): the game maps the whole u32 range onto the
 * CLOSED interval `[0, 1]`, so `seedNormalized(0xFFFFFFFF)` is exactly `1`. The
 * old `2^32` divisor also gave 1 there, because the f32 rounding absorbs the
 * difference at the very top of the range, and that is why the 12 oracle seeds
 * could not tell the two apart; 601 of 606 probed seeds agreed and 5 did not.
 * The game's own value was read on all 606 (`test/bearingChain.spec.ts`).
 * See docs/noise/vulcanus-seed-vars-NOTES.md for the first derivation.
 */
export function seedNormalized(seed0: number): number {
  return Math.fround(seed0 / 4294967295);
}

/**
 * `map_seed_small`: the 16 least significant bits of `seed0`. Implemented
 * with `&`, whose `ToInt32` coercion is bit-identical to `seed0 % 65536` for
 * every `seed0` in `[0, 2^32)` (verified for all 12 oracle fixture rows,
 * including the two above `2^31`). Only this value's parity
 * (`seedSmall(seed0) & 1`) is consumed downstream
 * (`vulcanus_starting_direction`).
 */
export function seedSmall(seed0: number): number {
  return seed0 & 0xffff;
}
