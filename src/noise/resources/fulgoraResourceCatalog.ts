/**
 * Fulgora's one resource: scrap.
 *
 * Unlike the Nauvis and Vulcanus catalogs there is no `threshold` mode here, and
 * no `region` function, because scrap does not use
 * `resource_autoplace_all_patches`. Its autoplace is a bare
 * `probability_expression` + `richness_expression` pair, and the probability is
 * capped at 0.5 by the Lua's own `min`, so it never saturates into a patch.
 * It ROLLS.
 */
import { makeFulgoraScrap } from "../expressions/fulgoraScrap";
import type { FulgoraScrapControls } from "../expressions/fulgoraScrap";
import { PLACEMENT_SALT, makePlacementSet } from "../placement/placementRoll";
import type { PlacementCollisionBox } from "../placement/placementRoll";
import type { FulgoraStack } from "../tiles/fulgoraCatalog";

/**
 * `map_color = {0.9, 0.9, 0.9}` from the prototype, times 255.
 * Confirmed against the game's own preview pixels: 1098 of 1825 changed pixels
 * are exactly this triple.
 */
export const SCRAP_MAP_COLOR: readonly [number, number, number] = [229, 229, 229];

/**
 * Scrap's `collision_box`, read off the RUNNING GAME rather than from the Lua.
 * The shared `resource()` helper declares `{{-0.1,-0.1},{0.1,0.1}}`, and the
 * game snaps it to the 1/256 grid, so the half-extent is 0.09765625.
 *
 * **It cannot reject anything**, against the Vulcanus geyser's 1.398 half-extent
 * where collision did all of the work. It is passed anyway, and
 * `test/fulgoraScrapDensity.spec.ts` asserts it is inert, so that a reader does
 * not have to wonder whether it was forgotten.
 */
export const SCRAP_COLLISION_BOX: PlacementCollisionBox = {
  w: 0.09765625 * 2,
  h: 0.09765625 * 2,
};

/**
 * The shipped scrap placement predicate.
 *
 * **No `tileAllowed` gate**, and that is a finding rather than an omission: the
 * `fulgora_elevation > fulgora_coastline + 10` term inside the probability put
 * expected scrap on ocean at exactly 0.00 over 262,144 tiles.
 * `test/fulgoraScrap.spec.ts` asserts it.
 */
export function makeFulgoraScrapPlacement(
  stack: FulgoraStack,
  controls: FulgoraScrapControls = {},
): (x: number, y: number) => boolean {
  const scrap = makeFulgoraScrap(stack, controls);
  return makePlacementSet({
    salt: PLACEMENT_SALT.fulgoraScrap,
    probability: scrap.probability,
    collisionBox: () => SCRAP_COLLISION_BOX,
  });
}
