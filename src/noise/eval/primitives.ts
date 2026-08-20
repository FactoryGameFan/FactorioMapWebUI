import { basisNoise, basisNoiseTablesFromSeed, type BasisNoiseTables } from "../basisNoise";
import { f32 } from "./f32";

export interface BasisExprParams {
  /** Map seed (basis seed word). */
  readonly seed0: number;
  /** Per-call seed selector (e.g. 123 for finish_elevation's basis term). */
  readonly seed1: number;
  /** Noise units per world tile. */
  readonly inputScale: number;
  /** Overall output multiplier. */
  readonly outputScale: number;
  /** World-space x translation applied before input_scale. Default 0. */
  readonly offsetX?: number;
}

/**
 * `basis_noise{input_scale, output_scale, offset_x}` in expression form. The raw
 * {@link basisNoise} takes noise-space coords and has no output scale, so this
 * adapter maps world `(x, y)` through `((x + offset_x) * input_scale, y *
 * input_scale)` and multiplies by `output_scale` - exactly the game's DSL. Pass
 * prebuilt `tables` to skip the per-seed derivation when sweeping a grid.
 *
 * ## The output scale is narrowed twice, and both are needed (#269)
 *
 * The game evaluates this as `f32(f32(output_scale) * basis)`. That is BOTH
 * cases of the two-case rule in {@link f32} at one call site, which is why
 * neither half alone reaches the game:
 *
 * - **The CONSTANT.** `output_scale` is a program literal the engine holds at
 *   f32. Writing `0.6` in TypeScript is the f64 0.59999999999999997780, and no
 *   amount of rounding the product recovers that.
 * - **The PRODUCT.** `basis_noise` returns an f32 and the multiply is its own
 *   f32 operation, so its result is f32 before anything downstream reads it.
 *
 * Graded against the game at 196 positions and five output scales in
 * `test/basisOutputScale.spec.ts`. Exact f64 equality, never a bound - both
 * sides produce f32 values, so a tolerance would pass for every candidate model
 * at once and measure nothing (#162). The scores that settled it:
 *
 * ```text
 * f32(f32(output_scale) * basis)   196/196 at all five scales   <- the game
 * f32(output_scale * basis)        196, 110, 151, 196, 196      <- #269's proposal
 * output_scale * basis             196,  28,   6,  96,   1      <- what shipped
 * f32(output_scale) * basis        196,   0,   0,   0,   1
 * ```
 *
 * **A power-of-two `output_scale` is immune** and cannot grade this: multiplying
 * an f32 by one is a pure exponent shift, so it can never leave the f32 grid.
 * That is why the older `oracle-basis` fixture, captured at `output_scale = 1`,
 * could not answer the question and a new capture had to.
 *
 * The `input_scale` product is deliberately NOT narrowed here. It decides which
 * point gets sampled rather than what the product rounds to, and narrowing it
 * would evaluate a DIFFERENT point. Whether the game holds `input_scale` at f32
 * too is a separate, unmeasured question tracked on #269.
 */
export function basisNoiseExpr(
  x: number,
  y: number,
  params: BasisExprParams,
  tables: BasisNoiseTables = basisNoiseTablesFromSeed(params.seed0, params.seed1),
): number {
  const offsetX = params.offsetX ?? 0;
  return f32(
    f32(params.outputScale) *
      basisNoise((x + offsetX) * params.inputScale, y * params.inputScale, tables),
  );
}
