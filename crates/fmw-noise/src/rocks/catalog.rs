//! Constants shared by the rock overlays, ported from
//! `src/noise/rocks/rockCatalog.ts`.
//!
//! `sliderRescale` and `rangeSelectBase` are re-exported from that file for
//! Nauvis callers; both already live in [`crate::eval::math`] here, so nothing
//! is re-exported.

/// `map_color` for every charted rock prototype.
///
/// All four Vulcanus rocks declare `{129, 105, 78}`
/// (`space-age/prototypes/decorative/decoratives-vulcanus.lua`), and so do the
/// three Nauvis ones, so the two planets share this rather than duplicating it.
pub const ROCK_MAP_COLOR: [u8; 3] = [129, 105, 78];

/// Radius, in pixels, of the mark painted per placed rock - `(2r+1)^2`, so `0`
/// would be a single pixel. **Both planets use 1, a 3x3 mark.**
///
/// The value was settled against the game's own `--generate-map-preview`
/// output rather than by eye (2026-07-28, issue #22 item 6):
///
/// | overlay | game | ours at 1x1 | ours at 3x3 |
/// | --- | --- | --- | --- |
/// | Vulcanus rocks | **5.17%** | 0.37% (0.07x) | 3.33% (0.65x) |
///
/// The game covers a twentieth of Vulcanus in rock colour, because it paints
/// each rock's real footprint (~3 x 2.2 tiles) rather than a dot. A 1x1 mark
/// was **14x too little ink**; 3x3 is 0.65x and the closest an odd-sided mark
/// gets, since 5x5 overshoots to ~1.8x.
pub const VULCANUS_ROCK_MARK_RADIUS_PX: i64 = 1;

/// The tile stride at which the rock probability field is evaluated.
///
/// **`1` means "evaluate per tile", i.e. no approximation at all, and that is
/// what ships.** The wrapper stays so the lattice is a one-constant experiment
/// rather than a rewrite. `docs/noise/placement-roll-NOTES.md` carries the
/// measurement that rejected it: a lattice buys back far too little of the
/// render cost to be worth degrading placement for, because rocks are only
/// about a quarter of the overlay budget on Vulcanus and the field is already
/// evaluated once per tile along the chunk resolver's own sweep.
///
/// Ported rather than dropped even though it is inert, so that flipping it on
/// the TypeScript side cannot silently make the two renders disagree - which
/// tier 3 asserts are byte-identical.
pub const ROCK_FIELD_LATTICE: i64 = 1;

/// Snap one coordinate to a `stride`-tile lattice. `stride <= 1` is the
/// identity.
///
/// `floor` rather than truncation, so the lattice is uniform across the origin:
/// `-1 / 4` must land in the cell at `-4`, not the one at `0`, or the cell
/// straddling the axis would be half-width and the density would not be
/// translation-invariant.
#[must_use]
pub fn lattice_snap(v: f64, stride: i64) -> f64 {
    if stride <= 1 {
        return v;
    }
    #[allow(clippy::cast_precision_loss)]
    let s = stride as f64;
    (v / s).floor() * s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shipped lattice is 1, and at 1 the snap is the identity - including
    /// on a fractional coordinate, which is what a render at 0.5 tiles per
    /// pixel hands it.
    #[test]
    fn the_shipped_lattice_is_one_and_snaps_nothing() {
        assert_eq!(ROCK_FIELD_LATTICE, 1);
        for v in [0.0, -1.0, 3.5, -1024.25, 2999.75] {
            assert_eq!(lattice_snap(v, ROCK_FIELD_LATTICE), v, "at {v}");
        }
    }

    /// The snap floors rather than truncating, so cells are uniform across the
    /// origin. Truncation would put `-1` and `+1` in the same cell at stride 4.
    #[test]
    fn the_snap_floors_so_the_cell_across_the_origin_is_full_width() {
        assert_eq!(lattice_snap(-1.0, 4), -4.0);
        assert_eq!(lattice_snap(1.0, 4), 0.0);
        assert_eq!(lattice_snap(-4.0, 4), -4.0);
        assert_eq!(lattice_snap(-5.0, 4), -8.0);
        // Truncation would give -0.0 here, i.e. the same cell as +1.
        assert_ne!(lattice_snap(-1.0, 4), lattice_snap(1.0, 4));
    }
}
