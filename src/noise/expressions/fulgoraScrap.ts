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
  /**
   * `fulgora_scrap_struct_term`, the additive term the game's own diagnostic
   * dump names - exported (not just inlined into `probability`) so
   * `test/fulgoraScrap.spec.ts` can compare it against the fixture's own
   * `fulgora_scrap_struct_term` directly, rather than only checking its sign.
   * `probability` composes this function rather than duplicating its body, so
   * the comparison exercises the same code the renderer runs.
   */
  readonly structTerm: (x: number, y: number) => number;
  /** `fulgora_scrap_vault_term` - see {@link structTerm}. */
  readonly vaultTerm: (x: number, y: number) => number;
}

export function makeFulgoraScrap(
  stack: FulgoraStack,
  controls: FulgoraScrapControls = {},
): FulgoraScrap {
  const { shared, cells, chain, masks, roads } = stack;
  const frequency = controls.frequency ?? 1;
  const size = controls.size ?? 1;

  // Both cuts are loop-invariant: they depend only on the sliders.
  //
  // 0.1, 0.05, 1.2 and 0.4 have no exact f32 form, so each is narrowed BEFORE
  // it multiplies anything - `f32.ts`'s case 2 ("narrow the CONSTANT"), the
  // same rule `fulgoraRoads.ts:121` applies to its own inexact 0.8
  // (`structure.cellId(x, y * f32(0.8))`). Narrowing the product instead
  // rounds at f64 literal precision first and can land on a different f32.
  //
  // This rests on the documented rule, not on a fixture measurement: the two
  // forms are IDENTICAL at frequency = size = 1, which is the only setting
  // `oracle-fulgora-scrap.seed123456.json` covers (`scrap_control_frequency`
  // and `scrap_control_size` are both 1 for every position), so no fixture
  // here can discriminate between them. Off the default slider, they can
  // differ: at frequency = 4/3, product-first gives 0.11666666716337204
  // against constant-first's 0.11666667461395264 - one ULP apart.
  const cellsCut = Math.min(f32(f32(0.1) * frequency), f32(f32(0.05) + f32(f32(0.05) * frequency)));
  const spotsCut = f32(f32(1.2) + f32(f32(0.4) * sliderToLinear(size, -1, 1)));
  const enabled = size > 0 ? 1 : 0;

  const structTerm = memoXY(
    (x: number, y: number) =>
      (roads.structureCells(x, y) < cellsCut ? 1 : 0) *
      f32(1 + roads.structureSubnoise(x, y)) *
      (chain.elevation(x, y) > COASTLINE + 10 ? 1 : 0) *
      masks.artificialMask(x, y),
  );
  const vaultTerm = memoXY(
    (x: number, y: number) =>
      (roads.spotsPrebanding(x, y) < spotsCut ? 1 : 0) *
      f32(cells.vaultsAndStartingVault(x, y) * 10),
  );

  const probability = memoXY((x: number, y: number) => {
    if (enabled === 0) return 0;
    const inner = Math.min(f32(structTerm(x, y) + vaultTerm(x, y)), 0.5);
    // Both `1 - <field>` subtractions narrow their field to f32 BEFORE the
    // subtraction, not just the result: `roadPaving2c` and `startingMask`
    // return f64 (e.g. `roadPaving2c`'s `lerp(...) * 0.9` chain ends on the
    // f64 literal 0.9). `f32(1 - 0.9)` is 0.10000000149011612; the game
    // computes `1 - f32(0.9)`, i.e. `1 - 0.8999999761581421` =
    // 0.10000002384185791 - a different f32. This is `f32.ts`'s "narrow the
    // CONSTANT" case, applied at the point of consumption rather than at
    // `roadPaving2c`'s own 0.9/0.85/0.5 literals in `fulgoraRoads.ts`: fixing
    // it there is the broader, arguably more correct fix (it would also
    // straighten out `roadDust`, which reads `roadPaving2c` too), but it
    // re-pins every tile hash downstream of the road/paving layer and risks
    // the `fulgoraLandTiles` 2137/2261 agreement count - out of scope for the
    // scrap composition this module owns. Measured: this drops the fixture's
    // worst relative error from 2.235e-7 to exactly 0, see
    // `test/fulgoraScrap.spec.ts`.
    const raw = f32(
      f32(1 - f32(shared.startingMask(x, y))) * f32(inner * f32(1 - f32(roads.roadPaving2c(x, y)))),
    );
    // The game rolls `U < probability`, so a negative value is simply never,
    // and a value above 1 always. Clamping here is what makes the expectation
    // sum meaningful and keeps the roll honest.
    return raw < 0 ? 0 : raw > 1 ? 1 : raw;
  });

  return { probability, structTerm, vaultTerm };
}
