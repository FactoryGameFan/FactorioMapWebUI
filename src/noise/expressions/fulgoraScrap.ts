/**
 * Fulgora's scrap `probability_expression`, from
 * `space-age/prototypes/planet/planet-fulgora-map-gen.lua` at 2.1.14.
 *
 * **No new field.** Every term it reads was ported and oracle-covered by V1 and
 * V2, so this module is composition only. That made the COMPOSITION the one
 * untested link, which `test/fulgoraScrap.spec.ts` closes against the game's own
 * evaluation of the whole expression.
 *
 * Three properties drive everything downstream:
 *
 * - **It is capped at 0.5 and never saturates.** `min(..., 0.5)` wraps the whole
 *   inner term. Nauvis and Vulcanus solid ores saturate to about 1 and are drawn
 *   as solid patches; scrap cannot be, which is why the overlay ROLLS.
 * - **It can go negative**, entirely through `fulgora_structure_subnoise < -1` -
 *   1002 positions in a 1024x1024 window, none from `road_paving_2c > 1` or
 *   `starting_mask > 1`, and none above 1. Hence the clamp. Summing the raw
 *   values understates the placement expectation by about 6%.
 * - **It excludes water on its own.** `fulgora_elevation > fulgora_coastline +
 *   10` put expected scrap on ocean at exactly 0.00 over 262,144 tiles, so the
 *   renderer needs no tile gate.
 */
import { f32 } from "../eval/f32";
import { sliderToLinear } from "../eval/math";
import { memoXY } from "../eval/memoXY";
import type { FulgoraStack } from "../tiles/fulgoraCatalog";

/** `fulgora_coastline`, a program constant. Same value as `fulgoraElevation.ts`. */
const COASTLINE = 80;

export interface FulgoraScrapControls {
  /** `control:scrap:frequency` (wire value). Neutral/default = 1. */
  readonly frequency?: number;
  /** `control:scrap:size` (wire value). Neutral/default = 1. */
  readonly size?: number;
}

export interface FulgoraScrap {
  /** The per-tile placement probability, clamped to `[0, 1]`. */
  readonly probability: (x: number, y: number) => number;
}

export function makeFulgoraScrap(
  stack: FulgoraStack,
  controls: FulgoraScrapControls = {},
): FulgoraScrap {
  const { shared, cells, chain, masks, roads } = stack;
  const frequency = controls.frequency ?? 1;
  const size = controls.size ?? 1;

  // Both cuts are loop-invariant: they depend only on the sliders.
  const cellsCut = Math.min(f32(0.1 * frequency), f32(0.05 + f32(0.05 * frequency)));
  const spotsCut = f32(1.2 + f32(0.4 * sliderToLinear(size, -1, 1)));
  const enabled = size > 0 ? 1 : 0;

  const probability = memoXY((x: number, y: number) => {
    if (enabled === 0) return 0;
    const structTerm =
      (roads.structureCells(x, y) < cellsCut ? 1 : 0) *
      f32(1 + roads.structureSubnoise(x, y)) *
      (chain.elevation(x, y) > COASTLINE + 10 ? 1 : 0) *
      masks.artificialMask(x, y);
    const vaultTerm =
      (roads.spotsPrebanding(x, y) < spotsCut ? 1 : 0) *
      f32(cells.vaultsAndStartingVault(x, y) * 10);
    const inner = Math.min(f32(structTerm + vaultTerm), 0.5);
    const raw = f32(
      f32(1 - shared.startingMask(x, y)) * f32(inner * f32(1 - roads.roadPaving2c(x, y))),
    );
    // The game rolls `U < probability`, so a negative value is simply never,
    // and a value above 1 always. Clamping here is what makes the expectation
    // sum meaningful and keeps the roll honest.
    return raw < 0 ? 0 : raw > 1 ? 1 : raw;
  });

  return { probability };
}
