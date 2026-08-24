//! The Vulcanus rock placement-probability field, ported from
//! `src/noise/rocks/vulcanusRockField.ts`.
//!
//! `planet_map_gen.vulcanus()`'s `autoplace_settings.entity` lists FOUR rocks -
//! `huge-volcanic-rock`, `big-volcanic-rock` and their `-hot` variants - and
//! between them they use only TWO probability expressions, because the hot
//! variants reuse the cold ones'. From
//! `space-age/prototypes/decorative/decoratives-vulcanus.lua:308-318`:
//!
//! ```text
//! vulcanus_rock_huge = min(0.2 * (1 - 0.75 * vulcanus_ashlands_biome),
//!                          -1.2 + 1.2 * min(aux, -0.1 + 1.1 * moisture)
//!                               + vulcanus_rock_noise
//!                               + 0.5 * vulcanus_decorative_knockout)
//! vulcanus_rock_big  = min(0.2 * (1 - 0.5 * vulcanus_ashlands_biome),
//!                          -1.0 + <the same three terms>)
//! ```
//!
//! The overlay rolls against `clamp(max(huge, big), 0, 1)`. Taking the max is
//! EXACT rather than an approximation: per-tile arbitration among competing
//! autoplacers is by maximum probability, so that is the probability the game
//! would actually roll where a rock wins.
//!
//! The same Lua file also defines `vulcanus_rock_medium`, `_cluster`, `_small`
//! and `_tiny`. Those prototypes appear in `autoplace_settings.decorative`, not
//! `entity`, and the game's map preview charts entities, so they are
//! deliberately not part of this field.
//!
//! **There is no `rocks` slider on Vulcanus**, so nothing here takes a
//! frequency or size lever. The planet's `autoplace_controls` list carries the
//! entry commented out with the reason in the source:
//! `--["rocks"] = {}, -- can't add the rocks control otherwise nauvis rocks spawn`
//! (`planet-map-gen.lua:43`).

use crate::eval::math::{clamp, max2, min2};
use crate::expressions::vulcanus_stack::VulcanusStack;
use crate::multioctave_noise::{MultioctaveParams, Prepared};

/// `seed1` of `vulcanus_decorative_knockout`'s multioctave call.
pub const DECORATIVE_KNOCKOUT_SEED1: u32 = 1_300_000;

/// `vulcanus_decorative_knockout` (`planet-vulcanus-map-gen.lua:867`),
/// commented there as "small wavelength noise (5 tiles-ish) to make decoratives
/// patchy":
///
/// ```text
/// multioctave_noise{x = x, y = y, persistence = 0.7, seed0 = map_seed,
///                   seed1 = 1300000, octaves = 2, input_scale = 1/3}
/// ```
///
/// No `output_scale` is given, so it defaults to 1 - which makes this one of
/// the sites #269's `output_scale` narrowing cannot reach, because multiplying
/// an f32 by one is a pure exponent shift.
#[must_use]
pub fn vulcanus_decorative_knockout(seed0: u32) -> Prepared {
    Prepared::new(&MultioctaveParams {
        seed0,
        seed1: DECORATIVE_KNOCKOUT_SEED1,
        octaves: 2.0,
        persistence: 0.7,
        input_scale: 1.0 / 3.0,
        output_scale: 1.0,
    })
}

/// The two rock probabilities and the density the overlay rolls against.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RockFields {
    /// `vulcanus_rock_huge`.
    pub rock_huge: f64,
    /// `vulcanus_rock_big`.
    pub rock_big: f64,
    /// `clamp(max(huge, big), 0, 1)`.
    pub density: f64,
}

/// The Vulcanus rock probability field for one stack.
///
/// It borrows the stack rather than rebuilding the chain, for the reason the
/// TypeScript's `sharedStack` plumbing exists: the climate and biome layers it
/// reads are the same ones terrain already built, and a private copy would pay
/// for the whole tree again.
pub struct VulcanusRockFields<'a, 'b> {
    stack: &'a VulcanusStack<'b>,
    knockout: Prepared,
}

impl<'a, 'b> VulcanusRockFields<'a, 'b> {
    #[must_use]
    pub fn new(stack: &'a VulcanusStack<'b>, seed0: u32) -> Self {
        Self {
            stack,
            knockout: vulcanus_decorative_knockout(seed0),
        }
    }

    /// The stack these fields read. Exposed so the placement's tile gate can
    /// ask the same resolver rather than building a second one.
    #[must_use]
    pub fn stack(&self) -> &'a VulcanusStack<'b> {
        self.stack
    }

    /// Both expressions and the density, at one position.
    ///
    /// The three shared terms are computed once, exactly as the TypeScript's
    /// `shared` closure does - not because it is faster, but because splitting
    /// them would give two chances to transcribe the same sum differently.
    #[must_use]
    pub fn eval(&self, x: f64, y: f64) -> RockFields {
        let climate = self.stack.climate(x, y);
        let ashlands = self.stack.biomes(x, y).ashlands_biome;
        let rock_noise = self.stack.rock_noise(x, y);
        let knockout = f64::from(self.knockout.eval(x, y));

        let shared =
            1.2 * min2(climate.aux, -0.1 + 1.1 * climate.moisture) + rock_noise + 0.5 * knockout;

        // `min2` / `max2` rather than `f64::min` / `f64::max`, and in the
        // TypeScript's argument order. The two differ on NaN and on signed
        // zero, where IEEE 754-2019 `maximumNumber` may return EITHER operand,
        // and only an order-sensitive fold over raw bits can see it.
        let rock_huge = min2(0.2 * (1.0 - 0.75 * ashlands), -1.2 + shared);
        let rock_big = min2(0.2 * (1.0 - 0.5 * ashlands), -1.0 + shared);
        RockFields {
            rock_huge,
            rock_big,
            density: clamp(max2(rock_huge, rock_big), 0.0, 1.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::ctx::EvalCtx;
    use crate::expressions::vulcanus_stack::VulcanusBase;

    /// `rock_big >= rock_huge` everywhere, and it is a THEOREM rather than a
    /// seed accident.
    ///
    /// The caps satisfy `0.2*(1 - 0.5a) >= 0.2*(1 - 0.75a)` for every
    /// `a = vulcanus_ashlands_biome` in `[0, 1]`, and the sloped branches
    /// satisfy `-1.0 + T > -1.2 + T` unconditionally, so the `min` of each pair
    /// is `>=` too.
    ///
    /// This is why the placement uses the HUGE collision box everywhere rather
    /// than the box of whichever prototype wins the tile: an argmax rule would
    /// pick the small box at every position on the map, which measured 13-27%
    /// too many rocks against the game.
    #[test]
    fn big_dominates_huge_at_every_position() {
        let ctx = EvalCtx::new(123_456);
        let base = VulcanusBase::with_host_trig(&ctx);
        let biomes = base.biomes_with_host_trig();
        let stack = VulcanusStack::with_host_trig(&base, &biomes);
        let fields = VulcanusRockFields::new(&stack, ctx.seed0);
        let mut saw_variation = false;
        let mut first = None;
        for i in 0..120 {
            let x = f64::from(i) * 17.0 - 1000.0;
            let y = f64::from(i) * -11.0 + 640.0;
            let f = fields.eval(x, y);
            assert!(
                f.rock_big >= f.rock_huge,
                "big {} < huge {} at ({x}, {y})",
                f.rock_big,
                f.rock_huge
            );
            assert_eq!(
                f.density,
                clamp(f.rock_big, 0.0, 1.0),
                "density must be the clamped big at ({x}, {y})"
            );
            // Non-vacuity: a field that returned one constant would satisfy
            // both assertions above perfectly.
            match first {
                None => first = Some(f.rock_big),
                Some(v) => {
                    if (f.rock_big - v).abs() > 1e-9 {
                        saw_variation = true;
                    }
                }
            }
        }
        assert!(saw_variation, "the field did not vary");
    }

    /// The density is genuinely sparse - it is a per-tile probability, not a
    /// mask - and it does reach zero. A field that saturated at 1 would make
    /// the placement roll place everywhere and the overlay would still "work".
    #[test]
    fn the_density_is_sparse_and_stays_inside_zero_to_one() {
        let ctx = EvalCtx::new(123_456);
        let base = VulcanusBase::with_host_trig(&ctx);
        let biomes = base.biomes_with_host_trig();
        let stack = VulcanusStack::with_host_trig(&base, &biomes);
        let fields = VulcanusRockFields::new(&stack, ctx.seed0);
        let mut positive = 0usize;
        let mut total = 0usize;
        for ty in -60..60 {
            for tx in -60..60 {
                let d = fields.eval(f64::from(tx), f64::from(ty)).density;
                assert!((0.0..=1.0).contains(&d), "density {d} at ({tx}, {ty})");
                if d > 0.0 {
                    positive += 1;
                }
                total += 1;
            }
        }
        // The two rock expressions cap at 0.2, so nothing can exceed that even
        // where the field is positive; most of the map sits at 0.
        assert!(positive > 0, "the density was zero everywhere");
        assert!(
            positive * 2 < total,
            "density positive at {positive} of {total} - that is a mask, not a probability"
        );
    }
}
