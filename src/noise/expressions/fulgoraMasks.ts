/**
 * The three masks that divide Fulgora's land into natural and artificial.
 *
 * Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
 * lines 250-292. They are defined in the middle of the elevation block, which
 * makes them look like part of the mix chain; nothing in that chain reads them,
 * which is why V1 left them out and why they live here instead.
 *
 * `fulgora_sprawl_mask` sits in the same run of definitions and is NOT ported -
 * no tile probability reads it.
 */
import { memoXY } from "../eval/memoXY";
import type { FulgoraCells } from "./fulgoraCells";
import type { FulgoraElevation } from "./fulgoraElevation";
import type { FulgoraShared } from "./fulgoraShared";

export interface FulgoraMasks {
  /** `max(min(natural > mix_pyramids, 1 - vaults_and_starting_vault), starting_mask)`. */
  readonly naturalMask: (x: number, y: number) => number;
  /** `max(natural_mask, mesa)` - the mask the two natural-side ruin terms use. */
  readonly naturalAndMesaMask: (x: number, y: number) => number;
  /** `1 - max(oil_mask, natural_and_mesa_mask)` - not oil, not natural. */
  readonly artificialMask: (x: number, y: number) => number;
}

export function makeFulgoraMasks(
  shared: FulgoraShared,
  cells: FulgoraCells,
  chain: FulgoraElevation,
): FulgoraMasks {
  const naturalMask = memoXY((x: number, y: number) =>
    Math.max(
      Math.min(
        chain.natural(x, y) > chain.mixPyramids(x, y) ? 1 : 0,
        1 - cells.vaultsAndStartingVault(x, y),
      ),
      shared.startingMask(x, y),
    ),
  );
  const naturalAndMesaMask = memoXY((x: number, y: number) =>
    Math.max(naturalMask(x, y), cells.mesa(x, y)),
  );
  const artificialMask = memoXY(
    (x: number, y: number) => 1 - Math.max(chain.oilMask(x, y), naturalAndMesaMask(x, y)),
  );

  return { naturalMask, naturalAndMesaMask, artificialMask };
}
