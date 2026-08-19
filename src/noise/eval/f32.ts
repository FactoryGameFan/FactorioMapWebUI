/**
 * `f32` - narrow a number to 32-bit float precision.
 *
 * **The game's noise machine evaluates its program in f32, one operation at a
 * time.** JavaScript computes in f64. So a ported expression that does the
 * arithmetic in f64 and rounds once at the end is not the same computation,
 * and the gap shows up as a residual against the oracle fixtures. Narrow at
 * each operation the game performs, not at the end of the chain.
 *
 * ## The two-case rule: find which term is wrong before you fix it
 *
 * An f32-sized residual on a field that reads a scaled coordinate has (at
 * least) two causes. They look identical from the outside and need OPPOSITE
 * fixes, so applying whichever one worked last time fixes half of them and
 * silently leaves the other half broken. This is not a guess - both cases were
 * measured on Fulgora's road layer against a 101-position oracle fixture, and
 * each fix was tried on the other case and did nothing.
 *
 * **Case 1 - narrow the PRODUCT.** `fulgora_structure_subnoise` samples at
 * `x + 10000 * structure_cells`. The multiply is its own f32 operation, so its
 * result is f32 before the add ever happens:
 *
 * ```ts
 * subnoise(x + f32(10000 * structureCells(x, y)), y); // right
 * subnoise(x + 10000 * structureCells(x, y), y); // wrong, 3.910e-5
 * ```
 *
 * Narrowing only where the sum reaches the primitive is a coarser rounding
 * than the game performs. Worst residual 3.910e-5 that way; 2.980e-7 with the
 * product narrowed - **131x**.
 *
 * **Case 2 - narrow the CONSTANT.** `fulgora_structure_cells` samples at
 * `y * 0.8`. Here narrowing the product buys nothing at all, because the term
 * that is wrong is the literal. The engine holds `0.8` as the f32 value
 * 0.80000001192092895508; JavaScript's `0.8` literal is the f64 value
 * 0.80000000000000004441. Those are different numbers, and no amount of
 * rounding the result recovers the difference:
 *
 * ```ts
 * structure.cellId(x, y * f32(0.8)); // right, residual exactly 0
 * structure.cellId(x, f32(y * 0.8)); // wrong, still 7.629e-6 - no help
 * structure.cellId(x, y * 0.8); // wrong, 7.629e-6
 * ```
 *
 * That one-character fix moved four downstream fields by 24x to 40x, none of
 * which touch case 1's field at all.
 *
 * So: isolate the term. If the constant has an exact f32 form (0.5, 2, 0.25),
 * case 2 cannot be your bug and the product is the place to look. If it does
 * not (0.8, 0.1, 0.07), narrow the constant FIRST and re-measure before
 * touching anything else.
 *
 * ## A residual reaching exactly 0 is the confirmation
 *
 * "It got smaller" is a hypothesis, not a finding. A residual landing at
 * exactly 0 across every fixture position is what confirms a mechanism -
 * anything else leaves you unable to say whether you found the cause or just
 * moved closer to it by luck. Case 2 above reaches 0; case 1 lands on its
 * field's `basisNoise` floor, which is a known, separately documented limit
 * rather than an open question.
 *
 * ## Which case applies depends on the ARITY, not just the constant
 *
 * The two cases above are about which TERM is wrong. #273 added a third thing
 * to check, and it is about how many terms there are.
 *
 * `fulgora_rock` is `0.33 + abs(v)` and `fulgora_dunes` is `0.66 - abs(v)`.
 * Both are pure case 2: type the literal and each goes 84/101 and 26/101 to
 * **101/101** at a residual of exactly 0. Narrowing the operations as well buys
 * nothing, because with one operation the comparison's own `Math.fround` is
 * already rounding in the same place the engine does.
 *
 * `fulgora_sprawl_pyramids` reads `abs(0.9 - 0.2 * basisOil + 0.05 * rock)`.
 * Typing those three constants and stopping there makes it **worse** - 99/101
 * down to 97/101 - while narrowing every intermediate takes it to 101/101. With
 * three terms there are two intermediate sums the engine rounds and the port
 * did not, and typing the literals moves the inputs to those unrounded sums
 * without fixing the sums.
 *
 * So: a one-operation expression usually needs only the constant. Anything with
 * an intermediate result needs the constant AND the narrowing, and doing half of
 * it can score worse than doing none. Measure both forms rather than assuming
 * the fix that worked on the neighbouring field transfers.
 *
 * ## Measure cumulatively - an upstream fix can be a downstream field's cause
 *
 * #273 predicted `fulgora_natural` would stall at 99/101 with its `0.85` typed,
 * and it was right about the measurement and wrong about the conclusion. Scored
 * against a fixed baseline the field really does stop at 99. It reaches
 * **101/101** once `fulgora_wobble_mask`'s `0.6` is typed, because `natural`
 * reads `basis`, and `basis` was itself only 98/101 until then.
 *
 * A field that improves without reaching 0 is evidence of another term, and
 * that term is often UPSTREAM rather than in the expression you are reading.
 * Re-score the whole chain after each accepted fix; a one-at-a-time sweep
 * against a frozen baseline under-reports what the fix is worth.
 *
 * ## Do not widen a bound instead
 *
 * A bound in a spec is the measured worst residual for that one field, with
 * modest headroom. It is not a tolerance to tune. Widening one to make a test
 * pass has hidden a real defect twice on this port - once worth 131x and once
 * worth 40x, both of them the cases above. If a bound needs to move, the
 * number to check is how the field compares to its siblings: an order of
 * magnitude worse than fields of similar depth is a bug, not a floor.
 *
 * @see `docs/noise/fulgora-elevation-NOTES.md` - "Two f32 findings that needed
 * OPPOSITE fixes", where both measurements are recorded in full.
 * @see `src/noise/eval/math.ts` - `sliderToLinear` and `sliderRescale`, two
 * more per-operation f32 chains, and the reason the `^` in them stays exact
 * while `multioctaveNoise`'s is fastapprox.
 */
export const f32 = Math.fround;
