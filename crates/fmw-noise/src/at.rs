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
//! [`At::Tile`] only where the game would be on the grid, and every noise
//! wrapper's `eval_at` follows it. An expression that warps a coordinate
//! builds an [`At::Point`] for that call, whatever it was handed.

/// A position to evaluate an expression at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum At {
    /// A world position evaluated as one point: the point kernel.
    Point { x: f64, y: f64 },
    /// A world tile evaluated by chunk-grid map generation: the grid kernel
    /// for every op on the raw coordinates.
    Tile { x: i32, y: i32 },
}

impl At {
    #[must_use]
    pub const fn point(x: f64, y: f64) -> Self {
        Self::Point { x, y }
    }

    /// The world x coordinate, for an expression's own arithmetic.
    #[must_use]
    pub fn x(self) -> f64 {
        match self {
            Self::Point { x, .. } => x,
            Self::Tile { x, .. } => f64::from(x),
        }
    }

    /// The world y coordinate, for an expression's own arithmetic.
    #[must_use]
    pub fn y(self) -> f64 {
        match self {
            Self::Point { y, .. } => y,
            Self::Tile { y, .. } => f64::from(y),
        }
    }
}
