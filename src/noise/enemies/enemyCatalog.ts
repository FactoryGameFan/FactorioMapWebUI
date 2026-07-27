// Enemy base catalog: constants and math functions from Factorio's enemy_base_probability expression

export const ENEMY_CONTROL_NAME = "enemy-base";
export const ENEMY_SEED1 = 123;
export const ENEMY_REGION_SIZE = 512;
export const ENEMY_CANDIDATE_SPOT_COUNT = 100;
export const ENEMY_SPACING = 45.254833995939045;
export const ENEMY_BASEMENT = -1000;
export const ENEMY_MAX_SPOT_BASEMENT_RADIUS = 128;
export const ENEMY_PLACEMENT_CAP = 0.25;
export const STARTING_AREA_RADIUS = 150;
export const ENEMY_MAP_COLOR = [255, 26, 26] as const;

/**
 * `random_penalty{..., amplitude = 0.1}`, the outermost operation of the
 * spawners' actual `probability_expression`.
 *
 * `base/prototypes/entity/enemies.lua` (2.1.12) gives `biter-spawner`
 * `enemy_autoplace_base(0, 6)` and `spitter-spawner` `enemy_autoplace_base(0, 7)`,
 * and `enemy_autoplace_base` (`base/prototypes/noise-expressions.lua:53`) is
 *
 *   random_penalty{ x = x + seed, y = y, amplitude = 0.1,
 *                   source = min(enemy_base_probability * max(0, 1 + 0.002*df*(...)),
 *                                0.25 + df*0.05) }
 *
 * At `distance_factor = 0` - which is what both spawners pass - the multiplier is
 * `max(0, 1) = 1` and the cap is `0.25`, so `source` collapses to exactly
 * `min(enemy_base_probability, 0.25)`, i.e. `makeEnemyBaseField(...).probability`.
 * The penalty is what remains, and it is NOT optional: see
 * `makeNauvisEnemyPlacement` in `src/noise/preview/renderEnemies.ts` for the
 * measured effect of leaving it out.
 */
export const ENEMY_RANDOM_PENALTY_AMPLITUDE = 0.1;

/**
 * Both spawners' `map_generator_bounding_box` - `{{-3.7, -3.2}, {3.7, 3.2}}` in
 * `base/prototypes/entity/enemies.lua:169` (biter) and `:830` (spitter), so
 * 7.4 x 6.4 tiles.
 *
 * This is deliberately NOT `collision_box` (`{{-2.2,-2.2},{2.2,2.2}}`, 4.4 x 4.4).
 * `map_generator_bounding_box` is documented as "Used instead of the collision box
 * during map generation. ... if the box is bigger, the entities will be placed
 * farther apart" (`factorioLuaAPI/prototype-api.json`, `EntityPrototype`), and the
 * two measure very differently - see `makeNauvisEnemyPlacement`.
 *
 * Neither Nauvis nor Vulcanus rocks declare this field, which is why
 * `renderRocks.ts` / `renderVulcanusRocks.ts` correctly use `collision_box`. Check
 * for `map_generator_bounding_box` FIRST when porting any further overlay.
 */
export const ENEMY_SPAWNER_MAP_GEN_BOX = { w: 7.4, h: 6.4 } as const;

export type EnemyControls = {
  frequency: number;
  size: number;
};

// Utility: clamp a value to [lo, hi]
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Enemy intensity as a function of distance from spawn.
 * intensity = clamp(distance, 0, 2400) / 325
 */
export function enemyIntensity(distance: number): number {
  return clamp(distance, 0, 2400) / 325;
}

/**
 * Enemy spot radius as a function of distance and size control.
 * radius = max(0, sqrt(size) * (15 + 4*intensity))
 */
export function enemySpotRadius(distance: number, controls: EnemyControls): number {
  const intensity = enemyIntensity(distance);
  return Math.max(0, Math.sqrt(controls.size) * (15 + 4 * intensity));
}

/**
 * Enemy spot quantity (number of enemies per spot).
 * quantity = (PI/90) * radius^3
 */
export function enemySpotQuantity(distance: number, controls: EnemyControls): number {
  const radius = enemySpotRadius(distance, controls);
  return (Math.PI / 90) * radius ** 3;
}

/**
 * Enemy frequency (spawn probability per tile).
 * frequency = (1e-5 + 3e-6*intensity) * controls.frequency
 */
export function enemyFrequency(distance: number, controls: EnemyControls): number {
  const intensity = enemyIntensity(distance);
  return (1e-5 + 3e-6 * intensity) * controls.frequency;
}

/**
 * Enemy density (enemies per tile).
 * density = enemySpotQuantity * max(0, enemyFrequency)
 */
export function enemyDensity(distance: number, controls: EnemyControls): number {
  const quantity = enemySpotQuantity(distance, controls);
  const frequency = enemyFrequency(distance, controls);
  return quantity * Math.max(0, frequency);
}
