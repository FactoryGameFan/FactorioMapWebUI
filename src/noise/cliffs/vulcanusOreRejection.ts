/**
 * The ORE -> CLIFF rejection: a resource entity's collision rectangle overlapping
 * a cliff cell's suppresses that cliff.
 *
 * ## What is established, and what is not
 *
 * **Established, by a lever rather than an argument** (#99,
 * `test/cliffOreDirection.spec.ts`). `autoplace_controls` is settable on the
 * surface exactly like `cliff_settings`, so the game can be re-run with the
 * resources switched off (`size = 0`) over the same regions. It gives both arms:
 * turning the ore off fills all ten cells of the blob the game otherwise leaves
 * empty, and forcing 335 cliffs through the tungsten field against the default's
 * 283 moves the ore not one tile. The rule is therefore
 *
 * - **one-way** - removing a resource only ever ADDS cliffs, never removes one,
 * - **additive** - 27 calcite + 4 geyser = exactly the 31 of all-off, disjoint,
 * - **local**, and shaped like a BOX OVERLAP against the resource ENTITY's
 *   rectangle rather than "a resource tile lies in the 4x4 cell". That
 *   distinction is only visible because `sulfuric-acid-geyser`'s collision
 *   half-extent is 1.398 against the ores' 0.098: a point-at-tile-centre test
 *   explains the calcite cells and cannot explain the geyser ones.
 *
 * **NOT established: the mechanism.** This is a characterised empirical rule,
 * not a port of a known engine path, and the difference matters enough to state
 * at the top of the file. The obvious candidate is refuted:
 * `EntityMapGenerationTask::computeInternal` (`0x101622860`) calls
 * `generateCliffs` at `+44` and `generateEntities` at `+148`, and `apply`
 * (`0x101623b48`) calls `applyCliffs` at `+124` and `applyEntities` at `+164`,
 * so cliffs are both computed and placed BEFORE any resource entity exists. No
 * collision test can see an entity that is not there yet. The masks are disjoint
 * too (resources carry only the `resource` layer, which the cliff mask does not
 * hold).
 *
 * ## Two things here are deliberately NOT the shape you might expect
 *
 * 1. **The cliff rectangle is the prototype's BASE `collision_box`, not the
 *    per-orientation rotbb box** that the lava rejection uses
 *    (`CLIFF_ORIENTATION_COLLISION_BOX`). Those are materially different shapes
 *    - the base box is `+/-0.988 x +/-0.488`, while orientation 4's rotbb is
 *    `[-3.5,-3,4.5,3]`. The base box is the one the rule was measured with, and
 *    since the mechanism is open there is nothing that says the ore rule should
 *    reuse the collision path's shape. `test/cliffOreRejection.spec.ts` scores
 *    BOTH so the choice is a recorded measurement rather than an assumption -
 *    which is the lesson #88/#90 already paid for, where the best-scoring
 *    collision model was the wrong one because it absorbed an unrelated defect.
 * 2. **It does not explain all 31 cells, and it is not tuned until it does.**
 *    Box overlap accounts for 21 of the 31 with zero false alarms in the 885
 *    cliffs the game kept. The other 10 are run remainders - every one of the
 *    six connected components of the suppressed set contains a directly
 *    overlapped cell - and whether that is a cascade along cliff connections or
 *    a wider box is open. Widening the box until all 31 fall out is exactly how
 *    #88 shipped a wrong model that scored perfectly.
 */
import type { VulcanusResourceControls } from "../eval/ctx";
import type { VulcanusResources } from "../expressions/vulcanusResources";
import { makeVulcanusOreFootprint } from "../resources/vulcanusResourceCatalog";
import type { CliffCollisionBox } from "./cliffCatalog";
import { CLIFF_ORIENTATION_COLLISION_BOX, cliffOrientationForCode } from "./cliffCatalog";

/**
 * `cliff-vulcanus`'s prototype `collision_box`, read off a running game
 * (`LuaEntityPrototype.collision_box`) and carried in
 * `oracle-vulcanus-cliff-ore-direction.seed123456.json` as
 * `protos["cliff-vulcanus"].box`, so the fixture holds the number rather than
 * this file asserting it. Quantised to 1/256 because `MapPosition` is 8-bit
 * fixed point: `0.98828125 = 253/256`, `0.48828125 = 125/256`.
 */
export const VULCANUS_CLIFF_BASE_COLLISION_BOX: CliffCollisionBox = [
  -0.98828125, -0.48828125, 0.98828125, 0.48828125,
];

/**
 * The three solid ores' collision half-extent, `0.09765625 = 25/256`, identical
 * across `tungsten-ore`, `calcite` and `coal` (same fixture).
 */
export const VULCANUS_ORE_COLLISION_HALF = 0.09765625;

/**
 * `sulfuric-acid-geyser`'s collision half-extent, `1.3984375 = 358/256` - the
 * 2.8 x 2.8 box from `space-age/prototypes/entity/resources.lua:182`. More than
 * fourteen times the ores' in each axis, which is what makes the geometry
 * measurable at all.
 */
export const VULCANUS_GEYSER_COLLISION_HALF = 1.3984375;

/** Which cliff rectangle the rejection tests with. */
export type CliffRejectionBox = "base" | "orientation";

export interface VulcanusOreRejectionOptions {
  /**
   * Include the sulfuric-acid geyser as a suppressing entity. **Defaults to
   * false**, and that default is a measurement, not caution for its own sake.
   *
   * The three solid ores THRESHOLD off region fields the oracle validates to
   * ~1e-3, and the region saturates, so their footprint boundary is sharp and
   * essentially deterministic. The geyser ROLLS: its placements are
   * salt-dependent, and re-running one region over eight salts gives 46-63
   * entities against the game's 56 (see `makeVulcanusGeyserPlacement`). A geyser
   * our model puts in the wrong place, with a box 14x the ores', removes a cliff
   * the game KEPT - a false rejection, which costs recall. This rule is
   * otherwise pure precision, so recall loss is the one outcome worth gating
   * against. `test/cliffOreRejection.spec.ts` measures the arm both ways.
   */
  readonly includeGeyser?: boolean;
  /**
   * Which cliff rectangle to test with - see the module comment. `"base"` is the
   * shape the rule was measured with and the shipping default.
   */
  readonly box?: CliffRejectionBox;
  /**
   * The geyser placement predicate, when `includeGeyser` is set. Injected rather
   * than built here so the caller can hand over the composite's one
   * `VulcanusStack` - see `geyserPlacementFrom`.
   */
  readonly geyserAt?: (x: number, y: number) => boolean;
}

interface Suppressor {
  readonly half: number;
  readonly occupies: (x: number, y: number) => boolean;
}

/**
 * The cliff rectangle for a cell, relative to its centre. The `"orientation"`
 * variant falls back to the base box for a code that places nothing, which
 * cannot reach the predicate anyway.
 */
function cliffBoxFor(box: CliffRejectionBox, code: number): CliffCollisionBox {
  if (box === "base") return VULCANUS_CLIFF_BASE_COLLISION_BOX;
  const id = cliffOrientationForCode(code);
  return id === undefined ? VULCANUS_CLIFF_BASE_COLLISION_BOX : CLIFF_ORIENTATION_COLLISION_BOX[id];
}

/**
 * Build the `CliffBands.cellRejects` predicate for Vulcanus: true when the
 * cell's cliff rectangle overlaps a resource entity's.
 *
 * ## Why this is cheap
 *
 * It looks like it needs the set of resource entities near the cell, but it does
 * not. A resource entity sits at a tile centre, so the tiles whose centre can
 * possibly overlap follow in closed form from the two rectangles, and the
 * predicate just asks the footprint about each of them. Cell centres sit at
 * integer `x` and half-integer `y` (`cx*4+2`, `cy*4+2.5`), so for the base box
 * against an ore that window is exactly **two tiles**; the geyser's larger box
 * widens it to 4x3. Both are well under the lava rejection's ~30 tile lookups
 * per cell, and no entity enumeration or spatial index is needed.
 *
 * The window is derived rather than hardcoded, and
 * `test/cliffOreRejection.spec.ts` asserts that widening it by a tile on every
 * side changes no cell - so the derivation is guarded, not trusted.
 */
export function makeVulcanusOreRejection(
  resources: VulcanusResources,
  controls: VulcanusResourceControls,
  opts: VulcanusOreRejectionOptions = {},
): (code: number, x: number, y: number) => boolean {
  const boxKind = opts.box ?? "base";
  const suppressors: Suppressor[] = [
    { half: VULCANUS_ORE_COLLISION_HALF, occupies: makeVulcanusOreFootprint(resources, controls) },
  ];
  if (opts.includeGeyser === true && opts.geyserAt !== undefined)
    suppressors.push({ half: VULCANUS_GEYSER_COLLISION_HALF, occupies: opts.geyserAt });

  return (code, x, y) => {
    const [l, t, r, b] = cliffBoxFor(boxKind, code);
    for (const s of suppressors) {
      // An entity centred at (tx + 0.5, ty + 0.5) overlaps when its box and the
      // cliff's do, strictly - the same `<` the measurement used. Solving for tx
      // gives the inclusive tile window below.
      const txMin = Math.floor(x + l - s.half - 0.5) + 1;
      const txMax = Math.ceil(x + r + s.half - 0.5) - 1;
      const tyMin = Math.floor(y + t - s.half - 0.5) + 1;
      const tyMax = Math.ceil(y + b + s.half - 0.5) - 1;
      for (let tx = txMin; tx <= txMax; tx++)
        for (let ty = tyMin; ty <= tyMax; ty++) if (s.occupies(tx, ty)) return true;
    }
    return false;
  };
}
