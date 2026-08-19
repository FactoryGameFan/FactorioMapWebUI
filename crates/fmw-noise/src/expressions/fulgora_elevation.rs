//! Fulgora's elevation mix chain, ported from
//! `src/noise/expressions/fulgoraElevation.ts`.
//!
//! Everything between the Voronoi layer and `fulgora_elevation` itself.
//! Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
//! lines 206-336, plus `fulgora_scrap_medium` (371), `fulgora_dunes` (513) and
//! `fulgora_rock` (523). Byte-identical 2.1.12 -> 2.1.14.
//!
//! The shape of the chain: `natural` is the organic landscape (one big
//! multioctave field, thresholded near sea level), the `*_pyramids` terms are
//! the Voronoi relief restricted to the island classes that get built on, and
//! the rest is a sequence of `max`/`lerp` steps that composite them, cut moats
//! out of vault islands, punch spots into vault centres, then flood the low
//! ground with oil. The last two steps invert everything above 0.6 so inland
//! sand sits in bowls with cliffs facing inwards, and finally step the whole
//! field by +/-10 at the coast so the cliff generator has a sharp edge to bite
//! on.
//!
//! `fulgora_natural_mask`, `fulgora_natural_and_mesa_mask`,
//! `fulgora_sprawl_mask` and `fulgora_artificial_mask` are deliberately NOT
//! ported. They are defined in the middle of the same Lua block, which makes
//! them look like part of the chain, but nothing here reads them - they feed
//! the deferred tile layer.

use crate::eval::math::lerp;
use crate::eval::math::slider_rescale;
use crate::expressions::fulgora_cells::CellFields;
use crate::expressions::fulgora_shared::Prepared;
use crate::expressions::fulgora_shared::{FulgoraCtx, SharedFields};
use crate::multioctave_noise::MultioctaveParams;
use crate::poison;

/// `seed1` for each multioctave call: `crc32` of the Lua's string seed.
///
/// **Computed, never guessed.** A wrong seed here produces a perfectly
/// plausible map that no residual-size check would flag - it is a different
/// noise field, not a slightly wrong one.
const SEED1_BASIS: u32 = 2_183_403_986; // crc32("fulgora_basis")        = 0x822419D2
const SEED1_BASIS_OIL: u32 = 1_819_171_631; // crc32("fulgora_basis_oil")    = 0x6C6E5B2F
const SEED1_ROCK: u32 = 3_721_161_451; // crc32("fulgora_rock")         = 0xDDCC6AEB
const SEED1_DUNES: u32 = 1_783_911_317; // crc32("fulgora_dunes")        = 0x6A545395
const SEED1_SCRAP_MEDIUM: u32 = 1_100_006_120; // crc32("fulgora_scrap_medium") = 0x4190C2E8

/// `fulgora_artificial_cap` - a named expression in the Lua, constant 0.25.
/// "The upper limit of pyramids, making them plateaus instead."
const ARTIFICIAL_CAP: f64 = 0.25;

/// `fulgora_coastline` - constant 80.
pub const COASTLINE: f64 = 80.0;

/// `fulgora_coastline_drop` - constant 20. Applied as +/- half, at the coast.
const COASTLINE_DROP: f64 = 20.0;

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ElevationFields {
    pub basis: f64,
    pub basis_oil: f64,
    pub rock: f64,
    pub dunes: f64,
    pub scrap_medium: f64,
    pub natural: f64,
    pub sprawl_pyramids: f64,
    pub vault_pyramids: f64,
    pub vault_pyramids_and_start: f64,
    pub moats: f64,
    pub mix_pyramids: f64,
    pub mix_natural: f64,
    pub mix_moats: f64,
    pub vault_spots: f64,
    pub mix_spots: f64,
    pub oil_mask: f64,
    pub mix_oil: f64,
    pub sand_basins: f64,
    pub pre_elevation: f64,
    pub elevation: f64,
}

/// The per-render constants of the elevation chain.
pub struct FulgoraElevation {
    basis: Prepared,
    basis_oil: Prepared,
    rock: Prepared,
    dunes: Prepared,
    scrap_medium: Prepared,
    /// `slider_rescale(size, 2)`, hoisted out of the per-position path because
    /// it depends only on the slider.
    ///
    /// At the default size of 1 it is exactly 1, which is why every one of the
    /// 101 captured positions is blind to how it is evaluated - the fixture
    /// carries a separate seven-point probe for that, and tier 1 grades it
    /// there.
    size_rescale: f64,
}

impl FulgoraElevation {
    #[must_use]
    pub fn new(ctx: &FulgoraCtx, grid: f64) -> Self {
        let seed0 = ctx.seed0;
        // The five multioctave sources, verbatim from the Lua. Only `basis`
        // reads the distorted coordinates and only `basis` sets an
        // `output_scale`; where the Lua omits it the engine default of 1
        // applies.
        Self {
            basis: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: SEED1_BASIS,
                octaves: 6.0,
                persistence: 0.5,
                input_scale: 128.0 / grid / 7.5,
                output_scale: 0.5,
            }),
            basis_oil: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: SEED1_BASIS_OIL,
                octaves: 4.0,
                persistence: 0.65,
                input_scale: 1.0 / 10.0,
                output_scale: 1.0,
            }),
            rock: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: SEED1_ROCK,
                octaves: 4.0,
                persistence: 0.7,
                input_scale: 1.0 / 3.0,
                output_scale: 1.0,
            }),
            dunes: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: SEED1_DUNES,
                octaves: 3.0,
                persistence: 0.7,
                input_scale: 1.0 / 6.0,
                output_scale: 1.0,
            }),
            scrap_medium: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: SEED1_SCRAP_MEDIUM,
                octaves: 3.0,
                persistence: 0.7,
                input_scale: 1.0 / 18.0,
                output_scale: 1.0,
            }),
            size_rescale: f64::from(slider_rescale(ctx.islands_size, 2.0)),
        }
    }

    /// Evaluate every field of this layer at one position.
    #[must_use]
    pub fn eval(
        &self,
        x: f64,
        y: f64,
        shared: &SharedFields,
        cells: &CellFields,
    ) -> ElevationFields {
        let basis = f64::from(self.basis.eval(shared.wx, shared.wy));

        // The distortion here is 1.5x the wobble and does NOT go through
        // `wobble_mask` - so unlike `wx`/`wy`, the oil noise is displaced even
        // where the mask has turned the island distortion off.
        let basis_oil = f64::from(
            self.basis_oil
                .eval(x + 1.5 * shared.wobble_x, y + 1.5 * shared.wobble_y),
        );

        let rock = 0.33 + f64::from(self.rock.eval(x, y)).abs();
        let dunes = 0.66 - f64::from(self.dunes.eval(x, y)).abs();
        let scrap_medium = f64::from(self.scrap_medium.eval(x, y));

        let natural = basis * 2.0 * self.size_rescale - 0.85;

        // Mesas take the pyramid relief scaled by an oil/rock term; sprawl cells
        // take it whole; every other class takes none of it. `sprawl` and `mesa`
        // are mutually exclusive 0/1 flags, so the bracket is one or the other.
        let sprawl_pyramids = cells.pyramids
            * (cells.sprawl + cells.mesa * (0.9 - 0.2 * basis_oil + 0.05 * rock).abs().min(1.0));

        let vault_pyramids = (cells.vaults * cells.pyramids).max(0.5 * shared.starting_vault_cone);
        let vault_pyramids_and_start = vault_pyramids.max(0.5 * shared.starting_cone);

        // The moat is a V cut around the pyramid: the first arm falls away below
        // the island, the second rises with it, and `max` takes whichever is
        // nearer the surface. The -0.05 floor is what guarantees some oil ocean
        // in the moat.
        let moats = ARTIFICIAL_CAP.min(
            1.5 * (-0.05 - vault_pyramids_and_start * 2.0)
                .max((vault_pyramids_and_start - 0.35) * 2.0),
        );

        let mix_pyramids = ARTIFICIAL_CAP.min((sprawl_pyramids - 0.185) * 4.0);
        let mix_natural = natural.max(mix_pyramids);
        let mix_moats = lerp(
            mix_natural,
            moats,
            cells.vaults_and_starting_vault.max(shared.starting_mask),
        );

        // "normal spot inverse is roughly 0.5 to 1, but the lower bound can be a
        // bit less in corners" - hence the steep `-10 + 11.5 *` remap, which
        // turns that narrow band into a plateau with near-vertical sides before
        // the cap flattens its top. The two starting terms carry a +0.5 bump so
        // spawn blends in.
        let vault_spots = ARTIFICIAL_CAP.min(
            -10.0
                + 11.5
                    * crate::eval::math::max(&[
                        cells.vaults * cells.spots_inv,
                        shared.starting_vault_mask * (0.5 + 0.5 * shared.starting_vault_cone),
                        shared.starting_mask * (0.5 + 0.5 * shared.starting_cone),
                    ]),
        );

        let mix_spots = mix_moats.max(vault_spots) + (shared.starting_cone - 0.8).max(0.0);

        // Comparisons yield 1 or 0, matching the engine's convention.
        let oil_mask = f64::from(u8::from(mix_spots < 0.0));

        // Inside the mask, drop the field further by an oil-noise amount - but
        // the `min(-0.01, ...)` guarantees the result stays negative, so
        // applying the noise can never lift an oil area back out of the mask it
        // was chosen by.
        let mix_oil = lerp(
            mix_spots,
            (-0.01f64).min(mix_spots - 0.4 + 0.6 * basis_oil),
            oil_mask,
        );

        // The inversion: above 0.3 the field folds back down, so high inland
        // ground becomes a bowl whose cliffs face inwards. This is what makes
        // inland sand areas negative, and why the tile layer needs `oil_mask`
        // rather than a plain "elevation < coastline" test to decide where
        // liquid goes.
        let sand_basins = mix_oil.min(0.6 - mix_oil);

        let pre_elevation = sand_basins * 60.0 + COASTLINE;

        // The coastal step: +10 on land, -10 in water, so the coastline is a
        // cliff face rather than a gradual slope the cliff smoothing could
        // smear.
        let elevation =
            pre_elevation + (f64::from(u8::from(sand_basins > 0.0)) - 0.5) * COASTLINE_DROP;

        ElevationFields {
            basis,
            basis_oil,
            rock,
            dunes,
            scrap_medium,
            natural,
            sprawl_pyramids,
            vault_pyramids,
            vault_pyramids_and_start,
            moats,
            mix_pyramids,
            mix_natural,
            mix_moats,
            vault_spots,
            mix_spots,
            oil_mask,
            mix_oil,
            sand_basins,
            pre_elevation,
            elevation: poison::f64_result(elevation),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::fulgora_cells::FulgoraCells;
    use crate::expressions::fulgora_shared::FulgoraShared;

    fn chain(seed0: u32) -> (FulgoraShared, FulgoraCells, FulgoraElevation) {
        let ctx = FulgoraCtx::new(seed0);
        let shared = FulgoraShared::with_host_trig(&ctx);
        let cells = FulgoraCells::new(&ctx, shared.grid);
        let elevation = FulgoraElevation::new(&ctx, shared.grid);
        (shared, cells, elevation)
    }

    /// The coastal step is exactly +/-10 and lands on `pre_elevation`, so the
    /// two differ by 20 across the waterline and never by anything else.
    #[test]
    fn the_coastal_step_is_exactly_plus_or_minus_ten() {
        let (shared, mut cells, elev) = chain(123_456);
        let mut land = 0;
        let mut water = 0;
        for k in 0..300 {
            let (x, y) = (f64::from(k) * 17.5 - 2500.0, f64::from(k) * -11.25 + 900.0);
            let s = shared.eval(x, y);
            let c = cells.eval(&s);
            let f = elev.eval(x, y, &s, &c);
            let step = f.elevation - f.pre_elevation;
            if f.sand_basins > 0.0 {
                assert_eq!(step, 10.0);
                land += 1;
            } else {
                assert_eq!(step, -10.0);
                water += 1;
            }
        }
        // Non-vacuity: the sweep crosses the waterline, so both branches ran.
        assert!(land > 0 && water > 0, "land={land} water={water}");
    }

    /// `oil_mask` is exactly `mix_spots < 0`, and inside it `mix_oil` stays
    /// NEGATIVE - which is what stops the oil noise lifting an area back out of
    /// the mask that selected it.
    ///
    /// **The bound is `< 0`, not `<= -0.01`, and the difference is `lerp`.**
    /// `lerp(a, b, t)` is `a + (b - a) * t`, so at `t = 1` it is `a + (b - a)`,
    /// which is NOT exactly `b` in f64. A first draft of this test asserted
    /// `mix_oil <= -0.01` on the strength of the `min(-0.01, ...)` and failed at
    /// `-0.009999999999999995`. The code is right and the assertion was wrong;
    /// the TypeScript's `lerp` has the same shape, so both ports land on the
    /// same number.
    #[test]
    fn the_oil_mask_is_a_one_way_door() {
        let (shared, mut cells, elev) = chain(123_456);
        let mut inside = 0;
        for k in 0..500 {
            let (x, y) = (f64::from(k) * 9.25 - 1200.0, f64::from(k) * 6.5 - 800.0);
            let s = shared.eval(x, y);
            let c = cells.eval(&s);
            let f = elev.eval(x, y, &s, &c);
            assert_eq!(f.oil_mask, f64::from(u8::from(f.mix_spots < 0.0)));
            if f.oil_mask == 1.0 {
                inside += 1;
                assert!(f.mix_oil < 0.0, "mix_oil escaped the mask: {}", f.mix_oil);
            }
        }
        assert!(inside > 0, "the sweep never entered the oil mask");
    }

    /// The default islands slider makes `slider_rescale(1, 2)` exactly 1, which
    /// is why the 101 captured positions cannot grade it.
    #[test]
    fn the_default_size_slider_makes_the_rescale_exactly_one() {
        let ctx = FulgoraCtx::new(123_456);
        let elev = FulgoraElevation::new(&ctx, 175.0);
        assert_eq!(elev.size_rescale, 1.0);
    }
}
