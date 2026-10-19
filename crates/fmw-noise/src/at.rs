//! Where an expression is evaluated, which decides which `basis_noise` kernel
//! the game would use there (#451).
//!
//! The game has two kernels, and they are different functions, not two
//! speeds of one (`basis_noise::basis_noise_grid`). Map generation - and so
//! the map preview at one tile per pixel - evaluates a 32x32 chunk at a time
//! through the CHUNK-GRID kernel, for every noise op whose `x` and `y` are the
//! raw coordinates. Everything else reaches the POINT kernel:
//! `calculate_tile_properties`, which is how every point fixture here was
//! captured, and any op whose coordinate the expression changed - Nauvis's
//! `nauvis_hills_offset` warps `x` and `y` before its multioctave call.
//!
//! **Which kernel applies cannot be read off the coordinate's value.** A warped
//! coordinate can land on a whole number. So the caller says, by building an
//! [`At::Grid`] (with [`At::tile`]) only where the game would be on the grid,
//! and every noise wrapper's `eval_at` follows it. An expression that warps a
//! coordinate builds an [`At::Point`] for that call, whatever it was handed.

/// A position to evaluate an expression at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum At {
    /// A world position evaluated as one point: the point kernel.
    Point { x: f64, y: f64 },
    /// Column `i`, row `r` of the map-generation chunk whose origin is
    /// `(cx, cy)`: the grid kernel for every op on the raw coordinates.
    ///
    /// The chunk is part of the position, not derived from it, because a
    /// `multisample` reads one column and row PAST the chunk: the game
    /// evaluates such a program on a 33x33 grid from the same origin, so the
    /// last tile's neighbour is column 32 of THIS chunk, not column 0 of the
    /// next one - and the two round differently once an octave's origin
    /// carries the 17.17 shift.
    Grid { cx: i32, cy: i32, i: u32, r: u32 },
}

impl At {
    /// The map generator's chunk edge, in tiles.
    pub const CHUNK: i32 = 32;

    #[must_use]
    pub const fn point(x: f64, y: f64) -> Self {
        Self::Point { x, y }
    }

    /// World tile `(x, y)` in its own chunk, `floor(x / 32)`.
    #[must_use]
    pub const fn tile(x: i32, y: i32) -> Self {
        let cx = x.div_euclid(Self::CHUNK) * Self::CHUNK;
        let cy = y.div_euclid(Self::CHUNK) * Self::CHUNK;
        Self::Grid {
            cx,
            cy,
            i: (x - cx) as u32,
            r: (y - cy) as u32,
        }
    }

    /// The same program read `(di, dj)` tiles over, as `multisample` does: in
    /// the SAME chunk on the grid, at `(x + di, y + dj)` for a point.
    #[must_use]
    pub fn shifted(self, di: u32, dj: u32) -> Self {
        match self {
            Self::Point { x, y } => Self::point(x + f64::from(di), y + f64::from(dj)),
            Self::Grid { cx, cy, i, r } => {
                // The game's multisample program is 33 wide, so a shift may
                // reach column 32 and no further. Nothing builds a wider one:
                // the cliff generator's 4-tile multisample stays a point.
                debug_assert!(i + di <= 32 && r + dj <= 32, "a shift past the 33x33 grid");
                Self::Grid {
                    cx,
                    cy,
                    i: i + di,
                    r: r + dj,
                }
            }
        }
    }

    /// The world x coordinate, for an expression's own arithmetic.
    #[must_use]
    pub fn x(self) -> f64 {
        match self {
            Self::Point { x, .. } => x,
            Self::Grid { cx, i, .. } => f64::from(cx) + f64::from(i),
        }
    }

    /// The world y coordinate, for an expression's own arithmetic.
    #[must_use]
    pub fn y(self) -> f64 {
        match self {
            Self::Point { y, .. } => y,
            Self::Grid { cy, r, .. } => f64::from(cy) + f64::from(r),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tile_lands_in_its_floor_chunk_on_both_sides_of_zero() {
        assert_eq!(
            At::tile(-1, 31),
            At::Grid {
                cx: -32,
                cy: 0,
                i: 31,
                r: 31
            }
        );
        assert_eq!(
            At::tile(32, -33),
            At::Grid {
                cx: 32,
                cy: -64,
                i: 0,
                r: 31
            }
        );
        assert_eq!((At::tile(-1, 31).x(), At::tile(-1, 31).y()), (-1.0, 31.0));
    }

    #[test]
    fn a_grid_shift_stays_in_its_chunk() {
        let last = At::tile(31, 0).shifted(1, 0);
        assert_eq!(
            last,
            At::Grid {
                cx: 0,
                cy: 0,
                i: 32,
                r: 0
            }
        );
        assert_ne!(
            last,
            At::tile(32, 0),
            "column 32 of this chunk is not column 0 of the next"
        );
        assert_eq!(last.x(), 32.0);
    }
}
