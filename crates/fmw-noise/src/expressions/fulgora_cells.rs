//! Fulgora's Voronoi layer and the island classification built on it, ported
//! from `src/noise/expressions/fulgoraCells.ts`.
//!
//! Transcribed from `space-age/prototypes/planet/planet-fulgora-map-gen.lua`
//! lines 126-205 (byte-identical 2.1.12 -> 2.1.14).
//!
//! This is where Fulgora's shape comes from: the map is a Voronoi tiling and
//! every island in a rendered preview is one cell. `cells` gives each cell a
//! stable pseudo-random id in `[0, 1)`, and the four class fields slice that id
//! into what the cell becomes - most of the map is `blanks`, which turns into
//! oil ocean.

use crate::expressions::fulgora_shared::{FulgoraCtx, SharedFields};
use crate::voronoi_noise::{Voronoi, VoronoiDistanceType, VoronoiParams};

/// `seed1` for every Voronoi field here: `crc32(utf8("fulgora_cells"))`.
///
/// All three calls use the same string on purpose - `pyramids` and `spots`
/// share `cells`' seed so they describe the SAME tiling rather than three
/// unrelated ones.
const SEED1_CELLS: u32 = 1_512_814_397; // 0x5A2BB73D

/// `fulgora_jitter` - a named expression in the Lua, constant 0.6.
const FULGORA_JITTER: f64 = 0.6;

/// Every named expression this layer defines, at one position.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CellFields {
    pub cells: f64,
    pub pyramids: f64,
    pub spots: f64,
    pub spots_inv: f64,
    pub blanks: f64,
    pub mesa: f64,
    pub sprawl: f64,
    pub vaults: f64,
    pub vaults_and_starting_vault: f64,
    /// The stable integer cell index of the manhattan tiling.
    ///
    /// Carried alongside `cells` because two distinct cells CAN share a
    /// `cells` value - the XOR combine forces exactly two colliding pairs - so
    /// anything that groups by island must group by this rather than by the
    /// float.
    pub cell_index: (i32, i32),
}

/// The two Voronoi fields, with their per-cell point caches.
///
/// This is the one part of the Fulgora chain that must be `&mut`: the caches
/// live inside `Voronoi`, and they are what make a sweep affordable.
///
/// No `Clone` or `Debug`: `Voronoi` has neither, and giving this one would mean
/// giving them to a cache whose contents are an implementation detail.
pub struct FulgoraCells {
    /// `cells` and `pyramids` are the SAME field read through two different
    /// ops - identical seed, grid, distance type and jitter - so they share one
    /// instance and therefore one point cache. Two instances would be correct
    /// and would double the point generation for nothing.
    manhattan: Voronoi,
    /// `spots` needs its own instance because the distance type differs, and it
    /// is sampled at DIFFERENT coordinates too - `ox + wobble_x/2`, half the
    /// distortion `wx` applies - so the moats sit slightly off the islands they
    /// belong to.
    euclidean: Voronoi,
}

impl FulgoraCells {
    #[must_use]
    pub fn new(ctx: &FulgoraCtx, grid: f64) -> Self {
        let common = |distance_type| VoronoiParams {
            seed0: ctx.seed0,
            seed1: SEED1_CELLS,
            grid_size: grid,
            jitter: FULGORA_JITTER,
            distance_type,
            search_range_override: None,
        };
        Self {
            manhattan: Voronoi::new(&common(VoronoiDistanceType::Manhattan)),
            euclidean: Voronoi::new(&common(VoronoiDistanceType::Euclidean)),
        }
    }

    /// Evaluate every field of this layer at one position.
    pub fn eval(&mut self, shared: &SharedFields) -> CellFields {
        let cells = f64::from(self.manhattan.cell_id(shared.wx, shared.wy));
        let pyramids = f64::from(self.manhattan.pyramid_noise(shared.wx, shared.wy));
        let cell_index = self.manhattan.cell_index(shared.wx, shared.wy);
        let spots = f64::from(self.euclidean.spot_noise(
            shared.ox + shared.wobble_x / 2.0,
            shared.oy + shared.wobble_y / 2.0,
        ));
        let spots_inv = 1.0 - spots;

        // Comparisons yield 1 or 0, matching the engine's boolean-to-number
        // convention. The four classes PARTITION every position - `vaults` is
        // the remainder rather than its own comparison, so the sum is 1 by
        // construction.
        let blanks = f64::from(u8::from(cells < 0.33));
        let mesa = f64::from(u8::from(cells > 0.75));
        let sprawl = f64::from(u8::from(cells > 0.5)) - mesa;
        let vaults = 1.0 - blanks - sprawl - mesa;
        let vaults_and_starting_vault = vaults.max(shared.starting_vault_mask);

        CellFields {
            cells,
            pyramids,
            spots,
            spots_inv,
            blanks,
            mesa,
            sprawl,
            vaults,
            vaults_and_starting_vault,
            cell_index,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::fulgora_shared::FulgoraShared;

    /// The four classes partition every position, which is the property that
    /// makes defining `vaults` as the remainder safe.
    #[test]
    fn the_four_classes_partition_every_position() {
        let ctx = FulgoraCtx::new(123_456);
        let shared = FulgoraShared::with_host_trig(&ctx);
        let mut cells = FulgoraCells::new(&ctx, shared.grid);
        let mut saw_each = [false; 4];
        for k in 0..400 {
            let (x, y) = (f64::from(k) * 13.25 - 2000.0, f64::from(k) * -9.5 + 800.0);
            let f = cells.eval(&shared.eval(x, y));
            assert_eq!(
                f.blanks + f.sprawl + f.mesa + f.vaults,
                1.0,
                "classes must sum to 1 at ({x}, {y})"
            );
            for (i, v) in [f.blanks, f.sprawl, f.mesa, f.vaults].iter().enumerate() {
                if *v == 1.0 {
                    saw_each[i] = true;
                }
            }
        }
        // Non-vacuity: the sweep really does reach all four classes, so the sum
        // above is being checked on more than one branch.
        assert_eq!(saw_each, [true; 4], "the sweep missed a class");
    }

    /// `spots` is sampled at HALF the distortion `wx`/`wy` apply, on its own
    /// euclidean instance. Reading it at `wx`/`wy` instead gives a different
    /// number, which is what this pins.
    #[test]
    fn spots_reads_half_distorted_coordinates_not_the_full_ones() {
        let ctx = FulgoraCtx::new(123_456);
        let shared = FulgoraShared::with_host_trig(&ctx);
        let mut cells = FulgoraCells::new(&ctx, shared.grid);
        let mut differing = 0;
        for k in 0..64 {
            let (x, y) = (f64::from(k) * 11.5 - 300.0, f64::from(k) * 7.25 - 200.0);
            let s = shared.eval(x, y);
            let got = cells.eval(&s).spots;
            let at_full = f64::from(cells.euclidean.spot_noise(s.wx, s.wy));
            if got != at_full {
                differing += 1;
            }
        }
        assert!(
            differing > 32,
            "only {differing} of 64 points distinguish the half-distorted \
             coordinates from the full ones"
        );
    }
}
