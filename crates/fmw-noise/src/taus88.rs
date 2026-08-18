//! L'Ecuyer taus88, the generator underneath Factorio's noise RNG.
//!
//! A direct port of `src/noise/taus88.ts`, which was verified against Factorio
//! 2.1.11. Every seeding variant in the port shares this one step, so a bug
//! here would move every table at once rather than one of them.
//!
//! The TypeScript writes `>>> 0` after each shift because JavaScript's bitwise
//! operators produce a SIGNED 32-bit result and it needs the unsigned value
//! back. On `u32` that coercion is what the type already means, so the masks
//! and shifts below carry no `>>> 0` counterpart and are not missing one.

/// The three state words. All-zero is a fixed point, which is why callers
/// clamp the seed word from below rather than passing a raw seed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Taus88State {
    pub s1: u32,
    pub s2: u32,
    pub s3: u32,
}

/// Seed all three state words to the same value, which is the game's shape.
#[must_use]
pub fn seeded_state(word: u32) -> Taus88State {
    Taus88State {
        s1: word,
        s2: word,
        s3: word,
    }
}

/// One canonical taus88 step. The output is taken AFTER the update, matching
/// the game and `taus88Next` in the TypeScript.
pub fn taus88_next(st: &mut Taus88State) -> u32 {
    st.s1 = ((st.s1 & 0xffff_fffe) << 12) ^ (((st.s1 << 13) ^ st.s1) >> 19);
    st.s2 = ((st.s2 & 0xffff_fff8) << 4) ^ (((st.s2 << 2) ^ st.s2) >> 25);
    st.s3 = ((st.s3 & 0xffff_fff0) << 17) ^ (((st.s3 << 3) ^ st.s3) >> 11);
    st.s1 ^ st.s2 ^ st.s3
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first five draws for the clamped minimum seed word 0x155, which is
    /// the word every low-seed map actually uses.
    ///
    /// Ground truth taken by RUNNING the TypeScript, not by reading it and not
    /// from this port - a test that checks a port against itself proves
    /// nothing. Reproduce with:
    ///
    /// ```text
    /// node --experimental-strip-types -e 'import("./src/noise/taus88.ts")
    ///   .then(({seededState, taus88Next}) => {
    ///     const st = seededState(0x155);
    ///     console.log(Array.from({length: 5}, () => taus88Next(st)).join(", "));
    ///   });'
    /// ```
    #[test]
    fn matches_the_typescript_stream_for_the_clamped_seed_word() {
        let mut st = seeded_state(0x155);
        let got: Vec<u32> = (0..5).map(|_| taus88_next(&mut st)).collect();
        assert_eq!(
            got,
            vec![
                45_438_212,
                1_409_544_450,
                3_980_732_798,
                112_738_311,
                3_238_374_133
            ]
        );
    }

    /// The all-zero fixed point is the reason `MIN_SEED_WORD` exists. If this
    /// ever stops being true the clamp is no longer protecting anything.
    #[test]
    fn all_zero_state_is_a_fixed_point() {
        let mut st = seeded_state(0);
        assert_eq!(taus88_next(&mut st), 0);
        assert_eq!(st, seeded_state(0));
    }
}
