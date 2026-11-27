//! Nauvis's tiles as a real surface holds them: the raw argmax, then tile
//! correction (`tiles::correction`), the pass a generated surface runs and the
//! game's preview does not.
//!
//! The same shape as `GlebaStack::corrected_tiles`: every whole tile of the
//! window's chunks, plus a margin and the one-chunk ring correction reads, is
//! resolved through the chunk-grid kernel (`At::tile`), then corrected chunk by
//! chunk in columns order. Graded against `get_tile` on a fresh Nauvis surface
//! in `fixtures.rs` (`nauvis_corrected_tiles_against_the_real_surface`).
//!
//! ## Deepwater may touch only water
//!
//! `deepwater` declares `allowed_neighbors = { "water" }`, the one Nauvis tile
//! that does, and the game makes the table symmetric, so no land tile may touch
//! deepwater either ([`may_touch`]; the 38 forbidden pairs are read back from
//! the game in the fixture's `notAllowed` lists). Correction rewrites a
//! deepwater tile beside land, or a land tile beside deepwater, to water
//! (`tiles::correction::Neighbours`). The raw argmax puts the two side by side
//! where elevation falls steeply, since deepwater needs elevation below -2.5
//! and land about 0 or more (`water_base`): 173 contacts in the raw tiles of
//! the 1024-tile preview window, none in the 256-tile window around spawn.
//! [`deepwater_land_contacts`] counts them; the fixture
//! `oracle-nauvis-real-surface-coast.seed123456.json` grades a window that has
//! them.

use crate::at::At;
use crate::expressions::nauvis_stack::NauvisStack;
use crate::tiles::correction::{correct_window, Neighbours, TileWorld};
use crate::tiles::nauvis_catalog::{NauvisTile, NauvisTileCatalog, TILE_ORDER};
use crate::tiles::nauvis_resolve::{is_water_tile, nauvis_tile};

/// The margin, in chunks, [`nauvis_corrected_tiles`] corrects around a window
/// for the renderer. See `nauvis_corrected_tiles_against_the_real_surface` in
/// `fixtures.rs` for the measurement behind it.
pub const NAUVIS_CORRECTION_MARGIN_CHUNKS: i32 = 1;

/// A tile's id for `tiles::correction`: its index in [`TILE_ORDER`], plus one
/// (0 is the game's empty id).
fn tile_id(t: NauvisTile) -> u8 {
    let i = TILE_ORDER.iter().position(|o| *o == t).unwrap_or(0);
    (i + 1) as u8
}

/// The layer of each correction id; index 0 is unused.
fn nauvis_layers() -> Vec<u16> {
    std::iter::once(0)
        .chain(TILE_ORDER.iter().map(|t| t.layer()))
        .collect()
}

/// Whether two Nauvis tiles may touch: every pair but deepwater and a land
/// tile, in either order.
#[must_use]
pub fn may_touch(a: NauvisTile, b: NauvisTile) -> bool {
    let deep = |t| t == NauvisTile::Deepwater;
    let land = |t| !is_water_tile(t);
    !((deep(a) && land(b)) || (land(a) && deep(b)))
}

/// [`may_touch`] as the correction pass's table, by correction id.
fn nauvis_neighbours() -> Neighbours {
    let n = TILE_ORDER.len() + 1;
    let mut allowed = vec![vec![false; n]; n];
    for (i, a) in TILE_ORDER.iter().enumerate() {
        for (j, b) in TILE_ORDER.iter().enumerate() {
            allowed[i + 1][j + 1] = i != j && may_touch(*a, *b);
        }
    }
    Neighbours::from_allowed(allowed)
}

/// Every raw tile of the world a correction of the window reads, filled up
/// front: the window's chunks, `margin_chunks` more on each side, and the
/// one-chunk ring around those that each task reads. Returns the world and
/// the chunk range to correct. The renderer does not use it (it reads lazily
/// through `correct_window`); the tests do, as the eager reference.
fn raw_world(
    stack: &NauvisStack,
    catalog: &NauvisTileCatalog,
    (x0, y0): (i32, i32),
    (width, height): (u32, u32),
    margin_chunks: i32,
) -> (TileWorld, (i32, i32), (i32, i32)) {
    let chunk = |v: i32| v.div_euclid(32);
    let (cx0, cx1) = (
        chunk(x0) - margin_chunks,
        chunk(x0 + width as i32 - 1) + margin_chunks,
    );
    let (cy0, cy1) = (
        chunk(y0) - margin_chunks,
        chunk(y0 + height as i32 - 1) + margin_chunks,
    );
    let mut world = TileWorld {
        chunk_x0: cx0 - 1,
        chunk_y0: cy0 - 1,
        chunks_wide: cx1 - cx0 + 3,
        chunks_high: cy1 - cy0 + 3,
        tiles: Vec::new(),
    };
    let (wx0, wy0) = (world.chunk_x0 * 32, world.chunk_y0 * 32);
    let (w, h) = (world.width(), (world.chunks_high * 32) as usize);
    world.tiles.reserve(w * h);
    for j in 0..h {
        for i in 0..w {
            let t = nauvis_tile(stack, catalog, At::tile(wx0 + i as i32, wy0 + j as i32));
            world.tiles.push(tile_id(t));
        }
    }
    (world, (cx0, cx1), (cy0, cy1))
}

/// The tiles of a window as a real surface holds them: the raw argmax at every
/// whole tile, then tile correction over every chunk the window touches plus
/// `margin_chunks` on each side, in columns order. Row-major, `y` outer.
///
/// Through `correct_window`, so a raw tile is resolved only when the pass
/// first reads it, and walks that cannot change anything are skipped.
#[must_use]
pub fn nauvis_corrected_tiles(
    stack: &NauvisStack,
    catalog: &NauvisTileCatalog,
    (x0, y0): (i32, i32),
    (width, height): (u32, u32),
    margin_chunks: i32,
) -> Vec<NauvisTile> {
    corrected(
        stack,
        catalog,
        (x0, y0),
        (width, height),
        margin_chunks,
        true,
    )
}

/// [`nauvis_corrected_tiles`] letting every pair touch: the control that shows
/// the deepwater rule is load-bearing.
#[cfg(test)]
pub(crate) fn nauvis_corrected_tiles_ignoring_neighbours(
    stack: &NauvisStack,
    catalog: &NauvisTileCatalog,
    origin: (i32, i32),
    size: (u32, u32),
    margin_chunks: i32,
) -> Vec<NauvisTile> {
    corrected(stack, catalog, origin, size, margin_chunks, false)
}

fn corrected(
    stack: &NauvisStack,
    catalog: &NauvisTileCatalog,
    origin: (i32, i32),
    size: (u32, u32),
    margin_chunks: i32,
    obey_neighbours: bool,
) -> Vec<NauvisTile> {
    let neighbours = nauvis_neighbours();
    let rules = obey_neighbours.then_some(&neighbours);
    let mut raw = |x: i32, y: i32| tile_id(nauvis_tile(stack, catalog, At::tile(x, y)));
    correct_window(
        &mut raw,
        &nauvis_layers(),
        rules,
        origin,
        size,
        margin_chunks,
    )
    .into_iter()
    .map(|id| TILE_ORDER[usize::from(id) - 1])
    .collect()
}

/// [`nauvis_corrected_tiles`] the eager way: every raw tile filled first, then
/// `correct_chunks_with`, no lazy reads. The reference the lazy path is
/// checked against on the real-surface windows.
#[cfg(test)]
pub(crate) fn nauvis_corrected_tiles_eager(
    stack: &NauvisStack,
    catalog: &NauvisTileCatalog,
    (x0, y0): (i32, i32),
    (width, height): (u32, u32),
    margin_chunks: i32,
) -> Vec<NauvisTile> {
    let (mut world, cx, cy) = raw_world(stack, catalog, (x0, y0), (width, height), margin_chunks);
    crate::tiles::correction::correct_chunks_with(
        &mut world,
        &nauvis_layers(),
        Some(&nauvis_neighbours()),
        cx,
        cy,
    );
    let mut out = Vec::with_capacity(width as usize * height as usize);
    for y in y0..y0 + height as i32 {
        for x in x0..x0 + width as i32 {
            out.push(TILE_ORDER[usize::from(world.at(x, y)) - 1]);
        }
    }
    out
}

/// How many 8-neighbour pairs in a row-major grid of `width` put deepwater
/// beside a land tile, each pair counted once. A nonzero count in raw tiles
/// marks a window where the deepwater rule does work; a real surface has
/// none.
#[must_use]
pub fn deepwater_land_contacts(tiles: &[NauvisTile], width: usize) -> usize {
    let height = tiles.len() / width;
    let mut n = 0;
    for j in 0..height {
        for i in 0..width {
            if tiles[j * width + i] != NauvisTile::Deepwater {
                continue;
            }
            for (di, dj) in [
                (-1i64, -1i64),
                (0, -1),
                (1, -1),
                (-1, 0),
                (1, 0),
                (-1, 1),
                (0, 1),
                (1, 1),
            ] {
                let (x, y) = (i as i64 + di, j as i64 + dj);
                if x < 0 || y < 0 || x >= width as i64 || y >= height as i64 {
                    continue;
                }
                if !is_water_tile(tiles[y as usize * width + x as usize]) {
                    n += 1;
                }
            }
        }
    }
    n
}

/// The raw argmax over the same world [`nauvis_corrected_tiles`] corrects,
/// margin and ring included, row-major. For the `allowed_neighbors` check.
#[must_use]
pub fn nauvis_raw_world_tiles(
    stack: &NauvisStack,
    catalog: &NauvisTileCatalog,
    origin: (i32, i32),
    size: (u32, u32),
    margin_chunks: i32,
) -> (Vec<NauvisTile>, usize) {
    let (world, _, _) = raw_world(stack, catalog, origin, size, margin_chunks);
    let width = world.width();
    (
        world
            .tiles
            .iter()
            .map(|id| TILE_ORDER[usize::from(*id) - 1])
            .collect(),
        width,
    )
}
