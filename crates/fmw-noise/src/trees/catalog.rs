//! The 15 Nauvis tree species, as data, ported from
//! `src/noise/trees/treeCatalog.ts`.
//!
//! Every species in `base/prototypes/entity/trees.lua` at 2.1.11 shares exactly
//! one expression shape, so a species is fully described by a parameter row:
//!
//! ```text
//! min(cap,
//!     trees_forest_path_cutout_faded,
//!     min(0, asymmetric_ramps{input = temperature, ...temp_ramp},
//!            asymmetric_ramps{input = moisture,    ...moist_ramp})
//!     + min(0, distance/20 - 3)
//!     - size_offset + 0.2 * control:trees:size
//!     + tree_small_noise * 0.1
//!     + multioctave_noise{persistence 0.65, octaves 3, seed1 = <seed1_name>,
//!                         input_scale = (1/input_scale_div) * control:trees:frequency,
//!                         output_scale = output_scale})
//! ```
//!
//! ## `size_offset` is the one term that varies, and finding that took an oracle
//!
//! It is 0.45 for `tree_05` and `tree_07` and 0.5 for the other 13. Modelling it
//! as a shared constant made those two disagree with the game by a near-constant
//! **5.01e-2 everywhere**.
//!
//! The way it was missed is the transferable part. The shape claim was first
//! checked by filtering the terms common to every species out of the Lua and
//! eyeballing the remainder - and **the filter dropped every line containing
//! `control:trees:size`, which is the line `size_offset` lives on**. So the one
//! term that varies was the one term excluded from the check.
//! `test/treeCatalogExpressions.spec.ts` now rebuilds each row's Lua string and
//! diffs it against the game data character for character instead.

/// One species' autoplace parameters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TreeSpecies {
    /// The game's noise-expression name, e.g. `"tree_01"`.
    pub name: &'static str,
    /// The string passed as `seed1` in the Lua, e.g. `"tree-01"`.
    pub seed1_name: &'static str,
    /// `crc32(utf8(seed1_name))` - the numeric seed the game actually uses.
    pub seed1: u32,
    /// The species' upper bound: the leading `min(cap, ...)`.
    pub cap: f64,
    /// `asymmetric_ramps{input = temperature}`: from_bottom, from_top, to_top,
    /// to_bottom.
    pub temp_ramp: [f64; 4],
    /// `asymmetric_ramps{input = moisture}`, same four.
    pub moist_ramp: [f64; 4],
    /// `input_scale = (1 / input_scale_div) * control:trees:frequency`.
    pub input_scale_div: f64,
    /// The species noise term's `output_scale`.
    pub output_scale: f64,
    /// The constant in `- size_offset + 0.2 * control:trees:size`. See the
    /// module header - this is the only per-species term.
    pub size_offset: f64,
}

/// `tree_small_noise`'s seed1: `crc32(utf8("tree-small"))`.
pub const TREE_SMALL_NOISE_SEED1: u32 = 2_343_395_516;

/// One row of the table below.
///
/// Nine parameters, which clippy dislikes and which is right for a data-row
/// constructor: the alternative is 15 struct literals naming every field, which
/// is the same information three times as long. The order matches the table in
/// `docs/nauvis-trees-port-survey.md`.
#[allow(clippy::too_many_arguments)]
const fn species(
    name: &'static str,
    seed1_name: &'static str,
    seed1: u32,
    cap: f64,
    temp_ramp: [f64; 4],
    moist_ramp: [f64; 4],
    input_scale_div: f64,
    output_scale: f64,
    size_offset: f64,
) -> TreeSpecies {
    TreeSpecies {
        name,
        seed1_name,
        seed1,
        cap,
        temp_ramp,
        moist_ramp,
        input_scale_div,
        output_scale,
        size_offset,
    }
}

/// The 15 species, ordered by DESCENDING `cap`.
///
/// The order does not change the result - the composition is a `max` - but it
/// is load-bearing for cost: `field`'s early-out raises its running best sooner
/// this way, which is what makes the render affordable. Keep it.
pub static TREE_SPECIES: [TreeSpecies; 15] = [
    species(
        "tree_01",
        "tree-01",
        545_692_666,
        0.45,
        [0.0, 10.0, 14.0, 15.0],
        [0.6, 0.7, 1.0, 2.0],
        25.0,
        0.8,
        0.5,
    ),
    species(
        "tree_04",
        "tree-04",
        1_357_672_309,
        0.45,
        [13.0, 14.0, 16.0, 17.0],
        [0.7, 0.9, 1.0, 2.0],
        30.0,
        0.8,
        0.5,
    ),
    species(
        "tree_05",
        "tree-05",
        669_736_931,
        0.45,
        [15.0, 16.0, 35.0, 45.0],
        [0.6, 0.7, 1.0, 2.0],
        40.0,
        0.8,
        0.45,
    ),
    species(
        "tree_02",
        "tree-02",
        3_113_208_384,
        0.4,
        [0.0, 10.0, 14.0, 15.0],
        [0.4, 0.5, 0.7, 0.8],
        25.0,
        0.75,
        0.5,
    ),
    species(
        "tree_03",
        "tree-03",
        3_465_083_606,
        0.4,
        [15.0, 16.0, 35.0, 45.0],
        [0.4, 0.5, 0.7, 0.8],
        35.0,
        0.75,
        0.5,
    ),
    species(
        "tree_07",
        "tree-07",
        3_387_244_239,
        0.4,
        [13.0, 14.0, 16.0, 17.0],
        [0.5, 0.6, 0.9, 1.0],
        40.0,
        0.75,
        0.45,
    ),
    species(
        "tree_02_red",
        "tree-02-red",
        2_142_693_989,
        0.3,
        [0.0, 10.0, 14.0, 15.0],
        [0.2, 0.3, 0.5, 0.6],
        25.0,
        0.7,
        0.5,
    ),
    species(
        "tree_08",
        "tree-08",
        1_499_079_518,
        0.3,
        [13.0, 14.0, 16.0, 17.0],
        [0.3, 0.4, 0.6, 0.7],
        30.0,
        0.7,
        0.5,
    ),
    species(
        "tree_09",
        "tree-09",
        777_851_848,
        0.3,
        [15.0, 16.0, 35.0, 45.0],
        [0.2, 0.3, 0.5, 0.6],
        25.0,
        0.7,
        0.5,
    ),
    species(
        "tree_06",
        "tree-06",
        3_202_485_849,
        0.2,
        [0.0, 10.0, 14.0, 15.0],
        [0.1, 0.2, 0.3, 0.4],
        22.0,
        0.6,
        0.5,
    ),
    species(
        "tree_08_brown",
        "tree-08-brown",
        3_606_254_248,
        0.2,
        [13.0, 14.0, 16.0, 17.0],
        [0.2, 0.3, 0.4, 0.5],
        30.0,
        0.6,
        0.5,
    ),
    species(
        "tree_09_brown",
        "tree-09-brown",
        1_887_705_372,
        0.2,
        [15.0, 16.0, 35.0, 45.0],
        [0.1, 0.2, 0.3, 0.4],
        25.0,
        0.6,
        0.5,
    ),
    species(
        "tree_06_brown",
        "tree-06-brown",
        2_261_543_413,
        0.1,
        [0.0, 10.0, 14.0, 15.0],
        [0.0, 0.1, 0.2, 0.3],
        22.0,
        0.5,
        0.5,
    ),
    species(
        "tree_08_red",
        "tree-08-red",
        889_647_812,
        0.1,
        [13.0, 14.0, 16.0, 17.0],
        [0.1, 0.2, 0.3, 0.4],
        30.0,
        0.5,
        0.5,
    ),
    species(
        "tree_09_red",
        "tree-09-red",
        140_958_580,
        0.1,
        [15.0, 16.0, 35.0, 45.0],
        [0.0, 0.1, 0.2, 0.3],
        25.0,
        0.5,
        0.5,
    ),
];

/// One species by its noise-expression name.
#[must_use]
pub fn species_by_name(name: &str) -> Option<&'static TreeSpecies> {
    TREE_SPECIES.iter().find(|s| s.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CRC-32 (the IEEE polynomial, reflected), written out here rather than
    /// imported.
    ///
    /// The 16 seeds above are copied from the TypeScript, and a copied magic
    /// number is exactly the kind of thing both ports can agree on while both
    /// being wrong. `fmw-noise` ships no CRC-32 - it has no reason to - so this
    /// is an independent implementation living in the test that uses it, in the
    /// same spirit as `test/fixtures/verify-wasm-request.py` being a third
    /// implementation rather than the writer under test.
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn the_crc32_here_matches_the_published_vectors() {
        // The control on the control: an implementation that agreed with the
        // catalog and with nothing else would prove nothing.
        assert_eq!(crc32(b""), 0x0000_0000);
        assert_eq!(crc32(b"a"), 0xe8b7_be43);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn every_seed1_is_the_crc32_of_its_own_name() {
        // A wrong seed produces a perfectly plausible forest, so these are
        // checked rather than trusted - the same reason
        // `NAUVIS_OFFSET_X_SEED1` is pinned directly.
        assert_eq!(TREE_SMALL_NOISE_SEED1, crc32(b"tree-small"));
        for s in &TREE_SPECIES {
            assert_eq!(
                s.seed1,
                crc32(s.seed1_name.as_bytes()),
                "{} seed1 is not crc32({:?})",
                s.name,
                s.seed1_name
            );
        }
    }

    #[test]
    fn the_seed1_name_is_the_expression_name_with_underscores_swapped_for_hyphens() {
        // Not decoration: it is what makes the test above a real check rather
        // than a restatement. If `seed1_name` were free-form, "crc32 of its own
        // name" could be satisfied by any consistent pair of wrong strings.
        for s in &TREE_SPECIES {
            assert_eq!(s.seed1_name, s.name.replace('_', "-"), "{}", s.name);
        }
    }

    #[test]
    fn there_are_fifteen_species_with_distinct_names_and_seeds() {
        assert_eq!(TREE_SPECIES.len(), 15);
        for (i, a) in TREE_SPECIES.iter().enumerate() {
            for b in TREE_SPECIES.iter().skip(i + 1) {
                assert_ne!(a.name, b.name);
                assert_ne!(a.seed1, b.seed1);
            }
        }
        assert!(species_by_name("tree_01").is_some());
        assert!(species_by_name("tree_99").is_none());
    }

    #[test]
    fn the_rows_are_in_descending_cap_order() {
        // Cost, not correctness - but the early-out's hit rate depends on it,
        // and a re-sort would look harmless.
        for pair in TREE_SPECIES.windows(2) {
            assert!(
                pair[0].cap >= pair[1].cap,
                "{} ({}) before {} ({})",
                pair[0].name,
                pair[0].cap,
                pair[1].name,
                pair[1].cap
            );
        }
    }

    #[test]
    fn only_tree_05_and_tree_07_carry_the_smaller_size_offset() {
        // The one genuinely per-species term, and the one an early draft got
        // wrong by 5.01e-2 everywhere on exactly these two species.
        let small: Vec<&str> = TREE_SPECIES
            .iter()
            .filter(|s| s.size_offset != 0.5)
            .map(|s| s.name)
            .collect();
        assert_eq!(small, vec!["tree_05", "tree_07"]);
        for s in &TREE_SPECIES {
            assert!(s.size_offset == 0.5 || s.size_offset == 0.45, "{}", s.name);
        }
    }

    #[test]
    fn every_ramp_is_ordered_bottom_top_top_bottom() {
        // `asymmetric_ramps` divides by `from_top - from_bottom` and
        // `to_bottom - to_top`, so a row whose bounds are out of order does not
        // fail loudly - it produces an inverted ramp, or an infinity.
        for s in &TREE_SPECIES {
            for (label, r) in [("temp", s.temp_ramp), ("moist", s.moist_ramp)] {
                assert!(r[0] < r[1], "{} {label} from bounds {r:?}", s.name);
                assert!(r[1] <= r[2], "{} {label} tops {r:?}", s.name);
                assert!(r[2] < r[3], "{} {label} to bounds {r:?}", s.name);
            }
            assert!(
                s.input_scale_div > 0.0 && s.output_scale > 0.0,
                "{}",
                s.name
            );
            assert!(s.cap > 0.0, "{}", s.name);
        }
    }
}
