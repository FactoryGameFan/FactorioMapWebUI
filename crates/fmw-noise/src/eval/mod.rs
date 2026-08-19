//! The `eval` layer, ported from `src/noise/eval/`.
//!
//! These are the small pieces every named expression is built out of: the
//! coordinate-shift builtin, the DSL's math operators, the two memo shapes the
//! field graph needs, the evaluation context, and the `basis_noise` expression
//! adapter.
//!
//! ## `f32.ts` has no counterpart here, and that is the point of the phase
//!
//! The TypeScript layer exports `f32 = Math.fround` and calls it roughly 175
//! times per sample, because JavaScript computes in f64 while **the game's
//! noise machine evaluates its program in f32, one operation at a time**. In
//! Rust the narrowing is the type, so those calls stop being calls. That is why
//! composition measured at 13.2x against 7.5x for the leaf kernel: `sum_octaves`
//! is dense in exactly those calls.
//!
//! **The class of bug they existed to prevent does not disappear with them - it
//! changes shape.** An f32-sized residual on a scaled coordinate has at least
//! two causes, and they need OPPOSITE fixes:
//!
//! - **Narrow the PRODUCT.** `fulgora_structure_subnoise` samples at
//!   `x + 10000 * structure_cells`. The multiply is its own f32 operation, so
//!   in Rust the product must be computed at `f32` rather than in `f64` and
//!   narrowed at the end. Worst residual 3.910e-5 the coarse way against
//!   2.980e-7 - **131x**.
//! - **Narrow the CONSTANT.** `fulgora_structure_cells` samples at `y * 0.8`,
//!   and here narrowing the product buys nothing, because the term that is
//!   wrong is the literal. The engine holds `0.8` as 0.80000001192092895508;
//!   the f64 literal is 0.80000000000000004441. In Rust this becomes literal
//!   typing: **`y * 0.8f32` is not `((y as f64) * 0.8f64) as f32`.** That
//!   one-character difference moved four downstream fields by 24x to 40x.
//!
//! So the rule carries: isolate the term before fixing it. If the constant has
//! an exact f32 form (0.5, 2, 0.25) the constant cannot be the bug and the
//! product is where to look. If it does not (0.8, 0.1, 0.07), type the literal
//! `f32` first and re-measure.
//!
//! A residual reaching **exactly 0** is the confirmation. "It got smaller" is a
//! hypothesis.
//!
//! @see `src/noise/eval/f32.ts`, which carries both measurements in full, and
//! `docs/noise/fulgora-elevation-NOTES.md`.

pub mod ctx;
pub mod math;
pub mod memo_region;
pub mod memo_xy;
pub mod multisample;
pub mod primitives;
