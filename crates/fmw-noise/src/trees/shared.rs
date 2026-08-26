//! The tree-specific shared noise fields, ported from
//! `src/noise/trees/treeShared.ts`.
//!
//! From `core/prototypes/noise-programs.lua`:
//!
//! ```text
//! tree_small_noise               = multioctave_noise{persistence 0.75, octaves 3,
//!                                                    seed1 'tree-small',
//!                                                    input_scale 0.2, output_scale 0.5}
//! forest_paths                   = (forest_path_billows   - 0.07) * 3
//! nauvis_hills_paths             = (nauvis_hills          - 0.1)  * 3
//! nauvis_bridge_paths            = (nauvis_bridge_billows - 0.07) * 5
//! trees_forest_path_cutout       = min(nauvis_bridge_paths, nauvis_hills_paths, forest_paths)
//! trees_forest_path_cutout_faded = trees_forest_path_cutout * 0.3 + tree_small_noise * 0.1
//! ```
//!
//! **`tree_small_noise`'s `input_scale` is a flat 0.2** and is NOT scaled by
//! `control:trees:frequency`, unlike every species' own noise term. That
//! asymmetry is easy to "tidy" away and would move every forest.

use crate::eval::math::min;
use crate::expressions::nauvis_shared::NauvisShared;
use crate::multioctave_noise::{MultioctaveParams, Prepared};

use super::catalog::TREE_SMALL_NOISE_SEED1;

/// The three shared fields, built once per seed.
///
/// It BORROWS its [`NauvisShared`] rather than owning one, which is what the
/// TypeScript's optional second parameter exists for: `treeField` already has a
/// shared layer and the render path already has one, so rebuilding the billow
/// stack here would be a third copy of a pure function of
/// `(seed0, segmentation)`.
pub struct TreeShared<'a> {
    shared: &'a NauvisShared,
    small_noise: Prepared,
}

impl<'a> TreeShared<'a> {
    #[must_use]
    pub fn new(seed0: u32, shared: &'a NauvisShared) -> Self {
        Self {
            shared,
            small_noise: Prepared::new(&MultioctaveParams {
                seed0,
                seed1: TREE_SMALL_NOISE_SEED1,
                octaves: 3.0,
                persistence: 0.75,
                // Flat 0.2 - see the module header.
                input_scale: 0.2,
                output_scale: 0.5,
            }),
        }
    }

    /// `tree_small_noise`.
    #[must_use]
    pub fn small_noise(&self, x: f64, y: f64) -> f64 {
        f64::from(self.small_noise.eval(x, y))
    }

    /// `trees_forest_path_cutout`.
    ///
    /// Three-argument `min`, and the ORDER is the TypeScript's: bridge, then
    /// hills, then forest path.
    #[must_use]
    pub fn forest_path_cutout(&self, x: f64, y: f64) -> f64 {
        min(&[
            (self.shared.bridge_billows(x, y) - 0.07) * 5.0,
            (self.shared.hills(x, y) - 0.1) * 3.0,
            (self.shared.forest_path_billows(x, y) - 0.07) * 3.0,
        ])
    }

    /// `trees_forest_path_cutout_faded`.
    #[must_use]
    pub fn forest_path_cutout_faded(&self, x: f64, y: f64) -> f64 {
        self.forest_path_cutout(x, y) * 0.3 + self.small_noise(x, y) * 0.1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::nauvis_shared::NauvisSharedParams;

    fn shared(seed0: u32) -> NauvisShared {
        NauvisShared::new(&NauvisSharedParams {
            seed0,
            segmentation_multiplier: 1.0,
        })
    }

    #[test]
    fn the_faded_cutout_is_the_cutout_scaled_plus_a_tenth_of_the_small_noise() {
        let nz = shared(123_456);
        let t = TreeShared::new(123_456, &nz);
        for &(x, y) in &[(0.5, 0.25), (137.5, -211.25), (-1024.5, 880.75)] {
            assert_eq!(
                t.forest_path_cutout_faded(x, y),
                t.forest_path_cutout(x, y) * 0.3 + t.small_noise(x, y) * 0.1
            );
        }
    }

    #[test]
    fn the_cutout_is_the_minimum_of_three_terms_and_each_wins_somewhere() {
        // A three-argument `min` where one arm never wins would be a two-arm
        // min with a dead branch, which is what a mistyped multiplier looks
        // like. Each of the three has to be the answer at some point.
        let nz = shared(123_456);
        let t = TreeShared::new(123_456, &nz);
        let mut wins = [0usize; 3];
        for i in 0..400 {
            let x = f64::from(i) * 7.5 - 800.0;
            let y = f64::from(i) * 3.25 - 300.0;
            let arms = [
                (nz.bridge_billows(x, y) - 0.07) * 5.0,
                (nz.hills(x, y) - 0.1) * 3.0,
                (nz.forest_path_billows(x, y) - 0.07) * 3.0,
            ];
            let got = t.forest_path_cutout(x, y);
            let best = arms.iter().copied().fold(f64::INFINITY, f64::min);
            assert_eq!(got, best, "at ({x}, {y})");
            let which = arms.iter().position(|a| *a == best).expect("an arm wins");
            wins[which] += 1;
        }
        assert!(
            wins.iter().all(|w| *w > 0),
            "an arm of the three-way min never wins: {wins:?}"
        );
    }

    #[test]
    fn the_small_noise_input_scale_is_not_scaled_by_anything() {
        // The one field in the tree layer that ignores `control:trees:frequency`.
        // Built with a flat 0.2, so two `TreeShared` at the same seed are
        // identical whatever the caller is doing with the trees controls - there
        // is no lever to pass it. Pinned by rebuilding the multioctave directly.
        let nz = shared(123_456);
        let t = TreeShared::new(123_456, &nz);
        let direct = Prepared::new(&MultioctaveParams {
            seed0: 123_456,
            seed1: TREE_SMALL_NOISE_SEED1,
            octaves: 3.0,
            persistence: 0.75,
            input_scale: 0.2,
            output_scale: 0.5,
        });
        for i in 0..20 {
            let x = f64::from(i) * 31.5 - 200.0;
            assert_eq!(t.small_noise(x, 77.25), f64::from(direct.eval(x, 77.25)));
        }
    }

    #[test]
    fn it_reads_the_shared_layer_it_was_handed_rather_than_building_its_own() {
        // The borrow is the point: hand it a shared layer at a different
        // segmentation and the cutout must move with it. A `TreeShared` that
        // quietly built its own at the default would pass every test that only
        // uses the default.
        let a = shared(123_456);
        let b = NauvisShared::new(&NauvisSharedParams {
            seed0: 123_456,
            segmentation_multiplier: 3.0,
        });
        let ta = TreeShared::new(123_456, &a);
        let tb = TreeShared::new(123_456, &b);
        let differs = (0..40).any(|i| {
            let x = f64::from(i) * 23.5 - 400.0;
            ta.forest_path_cutout(x, 55.25) != tb.forest_path_cutout(x, 55.25)
        });
        assert!(differs, "segmentation does not reach the cutout");
        // ...and the small noise does NOT move with it, because it is not a
        // billow field.
        assert_eq!(ta.small_noise(61.5, 55.25), tb.small_noise(61.5, 55.25));
    }
}
