//! Vulcanus's tiles as a real surface holds them: the raw argmax, then tile
//! correction (`tiles::correction`).
//!
//! A real Vulcanus surface runs `TileCorrectionMapGenerationTask` after the
//! tile argmax; the game's map preview does not. Against `get_tile` on a real
//! surface (256 x 256 around spawn, map seed 123456), the raw argmax differs at
//! 2,053 tiles by name and 1,814 by map colour. The same 1,814 is the gap
//! between the game's terrain preview PNG and the real surface, because the
//! raw render matches that PNG at every pixel.
//!
//! Two things are Vulcanus's own:
//!
//! - **The layers.** Lava (`water-overlay`) and lava-hot (`water`) sit far
//!   below the ground tiles (`ground-natural`); [`VulcanusTile::layer`].
//! - **Tiles that may not touch.** Lava and lava-hot list each other as their
//!   only `allowed_neighbors`, so lava against ground fails the consistency
//!   check outright ([`VulcanusTile::may_touch`]). No chain of tiles joins the
//!   two groups, so neither is ever replaced by the other; without the rule,
//!   the layer checks would turn ground into lava along one-tile strips. The
//!   rule takes the corrected grid from 217 tiles wrong to 1.
//!
//! **No tile ties.** Gleba's ties went to the name that sorts first. In the
//! whole 1024 x 1024 preview window, no two Vulcanus tiles ever share the
//! winning score exactly (`no_vulcanus_tile_ties_near_spawn` checks the
//! fixture window), so the listing-order argmax needs no tie order.

use crate::at::At;
use crate::expressions::vulcanus_stack::VulcanusStack;
#[cfg(test)]
use crate::tiles::correction::{correct_chunks_with, TileWorld};
use crate::tiles::correction::{correct_window, Neighbours};
use crate::tiles::vulcanus_catalog::{VulcanusTile, TILE_ORDER};

/// The margin, in chunks, [`corrected_tiles`] corrects around a window for
/// the renderer. With none, 79 tiles of the 256 x 256 window come out wrong;
/// with 1 or 2, the same 1 (`vulcanus_corrected_tiles_against_the_real_surface`).
pub const CORRECTION_MARGIN_CHUNKS: i32 = 1;

/// A tile's id for `tiles::correction`: its index in `TILE_ORDER`, plus one (0
/// is the game's empty id).
fn tile_id(t: VulcanusTile) -> u8 {
    let i = TILE_ORDER.iter().position(|o| *o == t).unwrap_or(0);
    (i + 1) as u8
}

/// The tile a correction id names.
fn tile_of(id: u8) -> VulcanusTile {
    TILE_ORDER[usize::from(id) - 1]
}

/// The layer of each correction id; index 0 is unused.
fn layers() -> Vec<u16> {
    std::iter::once(0)
        .chain(TILE_ORDER.iter().map(|t| t.layer()))
        .collect()
}

/// Which Vulcanus tiles may touch, by correction id.
///
/// The replacement search runs over these 19 tiles, where the game's runs over
/// every tile prototype. That is enough here: in the game's own table, read
/// over all of them, lava and lava-hot allow nothing but each other, so no
/// path leaves the pair in either search and every replacement between lava
/// and ground is 0.
fn neighbours() -> Neighbours {
    let ids = TILE_ORDER.len() + 1;
    let mut allowed = vec![vec![false; ids]; ids];
    for (i, a) in TILE_ORDER.iter().enumerate() {
        for (j, b) in TILE_ORDER.iter().enumerate() {
            allowed[i + 1][j + 1] = a.may_touch(*b);
        }
    }
    Neighbours::from_allowed(allowed)
}

/// Correct `world` (raw argmax ids) over chunks `xs` by `ys`, in columns order.
/// The world must hold one chunk more on every side.
#[cfg(test)]
fn correct(world: &mut TileWorld, xs: (i32, i32), ys: (i32, i32)) {
    correct_chunks_with(world, &layers(), Some(&neighbours()), xs, ys);
}

/// The raw argmax over every chunk `cx0..=cx1` by `cy0..=cy1`, as a world: the
/// eager reference the tests correct. The renderer reads lazily instead.
#[cfg(test)]
fn raw_world(
    stack: &VulcanusStack<'_>,
    (cx0, cx1): (i32, i32),
    (cy0, cy1): (i32, i32),
) -> TileWorld {
    let mut world = TileWorld {
        chunk_x0: cx0,
        chunk_y0: cy0,
        chunks_wide: cx1 - cx0 + 1,
        chunks_high: cy1 - cy0 + 1,
        tiles: Vec::new(),
    };
    let (wx0, wy0) = (cx0 * 32, cy0 * 32);
    let (w, h) = (world.width(), (world.chunks_high * 32) as usize);
    world.tiles.reserve(w * h);
    for j in 0..h {
        for i in 0..w {
            let t = stack.tile_at(At::tile(wx0 + i as i32, wy0 + j as i32));
            world.tiles.push(tile_id(t));
        }
    }
    world
}

/// The tiles of a window as a real surface holds them: the raw argmax at every
/// whole tile (the chunk-grid kernel), then tile correction over every chunk
/// the window touches plus `margin_chunks` on each side, in columns order.
/// Row-major, `y` outer.
///
/// The margin stands in for the chunks a real map has generated around the
/// window: correction writes into neighbouring chunks, so a chunk's result
/// depends on its neighbours' tasks.
///
/// Through `correct_window`, so a raw tile is resolved only when the pass
/// first reads it, and walks that cannot change anything are skipped.
#[must_use]
pub fn corrected_tiles(
    stack: &VulcanusStack<'_>,
    (x0, y0): (i32, i32),
    (width, height): (u32, u32),
    margin_chunks: i32,
) -> Vec<VulcanusTile> {
    let mut raw = |x: i32, y: i32| tile_id(stack.tile_at(At::tile(x, y)));
    correct_window(
        &mut raw,
        &layers(),
        Some(&neighbours()),
        (x0, y0),
        (width, height),
        margin_chunks,
    )
    .into_iter()
    .map(tile_of)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::ctx::{EvalCtx, ResourceLevers, VulcanusResourceControls};
    use crate::expressions::vulcanus_stack::VulcanusBase;
    use crate::test_json::{load, Json};
    use crate::tiles::correction::correct_chunks;
    use std::sync::OnceLock;

    /// `get_tile` on a real Vulcanus surface, one radius request, written by
    /// `scripts/probes/gleba-real-surface` with `FMW_PLANET=vulcanus`.
    const REAL: &str = "test/fixtures/oracle-vulcanus-real-surface.seed123456.json";

    /// The same window from a surface whose chunks were requested AND made one
    /// at a time, row by row (`FMW_CHUNK_ORDER=each`).
    const REAL_EACH: &str = "test/fixtures/oracle-vulcanus-real-surface-each.seed123456.json";

    /// `123456 + crc32("vulcanus")`.
    const SURFACE_SEED: u32 = 1_249_936_247;

    /// The fixture window: -128..127 on both axes.
    const X0: i32 = -128;
    const SIDE: usize = 256;

    /// Chunks every test here reads raw: the radius-6 request's -6..6, the two
    /// chunks around it the game's request order also corrects, and the ring
    /// each task reads around those.
    const RAW_CHUNKS: (i32, i32) = (-9, 9);

    fn fixture(path: &str) -> Json {
        let f = load(path);
        assert!(
            f.get("buildLine").as_str().contains("Version: 2.1.23 "),
            "{path} was not captured at 2.1.23"
        );
        assert_eq!(f.get("surfaceSeed").as_f64(), f64::from(SURFACE_SEED));
        let window = f.get("window");
        assert_eq!(window.get("x0").as_f64(), f64::from(X0));
        assert_eq!(window.get("y0").as_f64(), f64::from(X0));
        assert_eq!(window.get("width").as_f64() as usize, SIDE);
        assert_eq!(window.get("height").as_f64() as usize, SIDE);
        f
    }

    /// The fixture's tiles, row-major from (-128, -128).
    fn real_grid(f: &Json) -> Vec<VulcanusTile> {
        let names: Vec<&str> = f.get("names").as_array().iter().map(Json::as_str).collect();
        let alphabet: Vec<char> = f.get("alphabet").as_str().chars().collect();
        let mut grid = Vec::with_capacity(SIDE * SIDE);
        for row in f.get("rows").as_array() {
            let row = row.as_str();
            assert_eq!(row.chars().count(), SIDE);
            for c in row.chars() {
                let i = alphabet
                    .iter()
                    .position(|a| *a == c)
                    .expect("a known symbol");
                grid.push(VulcanusTile::from_name(names[i]).expect("a Vulcanus tile"));
            }
        }
        assert_eq!(grid.len(), SIDE * SIDE);
        grid
    }

    /// The raw argmax over `RAW_CHUNKS`, made once: the four resource controls
    /// at size 0, as the capture had them, and host trig (tests only).
    fn raw() -> &'static TileWorld {
        static RAW: OnceLock<TileWorld> = OnceLock::new();
        RAW.get_or_init(|| with_stack(|stack| raw_world(stack, RAW_CHUNKS, RAW_CHUNKS)))
    }

    /// Run `f` on the capture's Vulcanus stack.
    fn with_stack<R>(f: impl FnOnce(&VulcanusStack<'_>) -> R) -> R {
        let levers = ResourceLevers {
            frequency: 1.0,
            size: 0.0,
        };
        let mut ctx = EvalCtx::new(SURFACE_SEED);
        ctx.vulcanus_resource_controls = VulcanusResourceControls {
            tungsten_ore: levers,
            vulcanus_coal: levers,
            calcite: levers,
            sulfuric_acid_geyser: levers,
        };
        let base = VulcanusBase::with_host_trig(&ctx);
        let biomes = base.biomes_with_host_trig();
        f(&VulcanusStack::with_host_trig(&base, &biomes))
    }

    fn copy(world: &TileWorld) -> TileWorld {
        TileWorld {
            chunk_x0: world.chunk_x0,
            chunk_y0: world.chunk_y0,
            chunks_wide: world.chunks_wide,
            chunks_high: world.chunks_high,
            tiles: world.tiles.clone(),
        }
    }

    /// The fixture window out of a world.
    fn window(world: &TileWorld) -> Vec<VulcanusTile> {
        let mut out = Vec::with_capacity(SIDE * SIDE);
        for y in X0..X0 + SIDE as i32 {
            for x in X0..X0 + SIDE as i32 {
                out.push(tile_of(world.at(x, y)));
            }
        }
        out
    }

    /// Where `ours` differs from `real`, by tile name and by map colour (three
    /// ash tiles share one colour, so a picture sees only the second).
    fn differences(ours: &[VulcanusTile], real: &[VulcanusTile]) -> (usize, usize) {
        assert_eq!(
            ours.len(),
            real.len(),
            "our tiles and the real surface's tiles"
        );
        let mut out = (0, 0);
        for (a, b) in ours.iter().zip(real) {
            if a != b {
                out.0 += 1;
                out.1 += usize::from(a.color() != b.color());
            }
        }
        out
    }

    /// The window corrected over the window's chunks plus `margin`, in columns
    /// order, with or without the may-touch rule.
    fn corrected(margin: i32, with_rules: bool) -> Vec<VulcanusTile> {
        let mut world = copy(raw());
        let span = (-4 - margin, 3 + margin);
        if with_rules {
            correct(&mut world, span, span);
        } else {
            correct_chunks(&mut world, &layers(), span, span);
        }
        window(&world)
    }

    /// Every tile's effective layer is the one the game reports.
    #[test]
    fn vulcanus_layers_match_the_game() {
        let f = fixture(REAL);
        let tiles = f.get("tiles");
        for t in TILE_ORDER {
            let want = tiles.get(t.name()).get("layer").as_f64();
            assert_eq!(f64::from(t.layer()), want, "{}", t.name());
        }
    }

    /// Which tiles may touch is the game's own table, read back at runtime
    /// (`LuaTilePrototype::allowed_neighbors`, after the game made it
    /// symmetric; the fixture lists each tile's `notAllowed` candidates), for
    /// every pair of Vulcanus tiles.
    #[test]
    fn vulcanus_tiles_that_may_touch_match_the_game() {
        let f = fixture(REAL);
        let tiles = f.get("tiles");
        let mut refused = 0;
        for a in TILE_ORDER {
            let banned: Vec<&str> = tiles
                .get(a.name())
                .get_opt("notAllowed")
                .map(|v| v.as_array().iter().map(Json::as_str).collect())
                .unwrap_or_default();
            for b in TILE_ORDER {
                if a == b {
                    continue;
                }
                let want = !banned.contains(&b.name());
                assert_eq!(a.may_touch(b), want, "{} next to {}", a.name(), b.name());
                refused += usize::from(!want);
            }
        }
        // Non-vacuity: lava and lava-hot each refuse the 17 ground tiles.
        assert_eq!(refused, 2 * 2 * 17);
    }

    /// The raw argmax against the real surface. The colour count is the gap
    /// between the game's preview PNG and the real surface in this window.
    #[test]
    fn vulcanus_raw_tiles_against_the_real_surface() {
        let real = real_grid(&fixture(REAL));
        let ours = window(raw());
        let kinds: std::collections::BTreeSet<_> = ours.iter().map(|t| t.name()).collect();
        assert!(kinds.len() > 15, "{} kinds", kinds.len());
        assert_eq!(differences(&ours, &real), (2053, 1814));
    }

    /// After tile correction in the renderer's columns order: **1 of 65,536
    /// tiles differs** from the real surface, by name and by colour, at
    /// (-127, 95). It is the ORDER chunks are corrected in, near the edge of
    /// what was requested, not the pass: corrected in the order the game queues
    /// them for this request, every tile matches
    /// (`the_games_request_order_reproduces_both_captures`). A renderer cannot
    /// know what a game requested, so it keeps columns order. The game itself
    /// moves this tile with the request: an uncommitted capture of the whole
    /// 1024 x 1024 preview window (one radius-18 request, 2026-11-26, kept in
    /// `realsurface.local/`) has lava-hot here, as we do, and our corrected
    /// 1024 window differs from that capture at 3 of 1,048,576 tiles, all at its
    /// left edge (x -512 to -509).
    ///
    /// The renderer's lazy path (`corrected_tiles`, through `correct_window`)
    /// gives the same tiles as the eager reference from the same raw tiles.
    ///
    /// Controls: without the may-touch rule, 217 differ; with no margin, 79
    /// (72 by colour); a wider margin changes nothing.
    #[test]
    fn vulcanus_corrected_tiles_against_the_real_surface() {
        let real = real_grid(&fixture(REAL));
        let shipped = corrected(CORRECTION_MARGIN_CHUNKS, true);
        let mut from_raw = |x: i32, y: i32| raw().at(x, y);
        let lazy: Vec<VulcanusTile> = correct_window(
            &mut from_raw,
            &layers(),
            Some(&neighbours()),
            (X0, X0),
            (SIDE as u32, SIDE as u32),
            CORRECTION_MARGIN_CHUNKS,
        )
        .into_iter()
        .map(tile_of)
        .collect();
        assert_eq!(lazy, shipped, "lazy and eager reads agree");
        assert_eq!(differences(&shipped, &real), (1, 1));
        let i = shipped
            .iter()
            .zip(&real)
            .position(|(a, b)| a != b)
            .expect("one tile differs");
        let at = (X0 + (i % SIDE) as i32, X0 + (i / SIDE) as i32);
        assert_eq!(
            (at, shipped[i], real[i]),
            ((-127, 95), VulcanusTile::LavaHot, VulcanusTile::Lava)
        );
        assert_eq!(
            differences(&corrected(CORRECTION_MARGIN_CHUNKS, false), &real),
            (217, 217)
        );
        assert_eq!(differences(&corrected(0, true), &real), (79, 72));
        assert_eq!(corrected(CORRECTION_MARGIN_CHUNKS + 1, true), shipped);
    }

    /// The `each` capture requested and generated the window's chunks and two
    /// of margin (-6..5) one at a time, row by row. Correcting exactly those
    /// chunks in that order reproduces it: **0 of 65,536**. So the pass itself
    /// is exact; what the radius test above misses is order alone.
    #[test]
    fn vulcanus_corrected_tiles_against_a_one_at_a_time_request() {
        let f = fixture(REAL_EACH);
        assert_eq!(f.get("chunkOrder").as_str(), "each");
        let real = real_grid(&f);
        let mut world = copy(raw());
        let (layers, rules) = (layers(), neighbours());
        for cy in -6..=5 {
            for cx in -6..=5 {
                correct_chunks_with(&mut world, &layers, Some(&rules), (cx, cx), (cy, cy));
            }
        }
        assert_eq!(differences(&window(&world), &real), (0, 0));
        // Control: the same chunks in columns order miss this capture.
        assert_ne!(differences(&corrected(2, true), &real), (0, 0));
    }

    /// Corrected in the order the game queues the tasks for each capture's own
    /// request (`requested_correction_order`, the Fulgora port's reading of
    /// `MapGenerationManager::request`: one request corrects the 5 x 5 around
    /// it), both captures match at **every tile**: the radius-6 request (chunks
    /// -6..6, asked for in columns order) and the one-at-a-time row-by-row
    /// request. So the one tile the renderer's columns order leaves at
    /// (-127, 95) is the edge of the request, and nothing else.
    #[test]
    fn the_games_request_order_reproduces_both_captures() {
        use crate::tiles::correction::{correct_chunks_in_order, requested_correction_order};
        let (layers, rules) = (layers(), neighbours());
        let run = |order: &[(i32, i32)]| {
            let mut world = copy(raw());
            correct_chunks_in_order(
                &mut world,
                &mut |_, _| unreachable!("every raw tile is known"),
                &layers,
                Some(&rules),
                order,
            );
            window(&world)
        };
        let radius: Vec<_> = (-6..=6)
            .flat_map(|x| (-6..=6).map(move |y| (x, y)))
            .collect();
        let real = real_grid(&fixture(REAL));
        assert_eq!(
            differences(&run(&requested_correction_order(&radius)), &real),
            (0, 0)
        );
        let rows: Vec<_> = (-6..=5)
            .flat_map(|y| (-6..=5).map(move |x| (x, y)))
            .collect();
        let each = real_grid(&fixture(REAL_EACH));
        assert_eq!(
            differences(&run(&requested_correction_order(&rows)), &each),
            (0, 0)
        );
    }

    /// No exact tie for the winning score anywhere in the fixture window, so
    /// the tie order Gleba needed has nothing to decide here. Measured over the
    /// whole 1024 x 1024 preview window too (2026-11-26): 0 ties, the closest
    /// top two 2.4e-7 apart. Too slow to run here in a debug build.
    #[test]
    fn no_vulcanus_tile_ties_near_spawn() {
        let (ties, closest) = with_stack(|stack| {
            let mut ties = 0;
            let mut closest = f64::INFINITY;
            for y in X0..X0 + SIDE as i32 {
                for x in X0..X0 + SIDE as i32 {
                    let mut p = stack.tile_probabilities_at(At::tile(x, y));
                    p.sort_by(|a, b| b.total_cmp(a));
                    ties += usize::from(p[0] == p[1]);
                    closest = closest.min(p[0] - p[1]);
                }
            }
            (ties, closest)
        });
        eprintln!("vulcanus: {ties} ties, closest top-two gap {closest:e}");
        assert_eq!(ties, 0);
        assert!(closest > 0.0);
    }

    /// The rule in one area: a one-tile-wide column of lava in volcanic soil.
    /// The layer checks alone widen it (a one-wide low strip between two higher
    /// tiles is what correction removes, and the soil beside it takes the lava
    /// it fails against). With the may-touch rule nothing moves, because no
    /// chain of tiles joins lava to soil, so the replacement is 0.
    #[test]
    fn a_lava_strip_in_soil_is_left_alone() {
        use crate::tiles::correction::{Area, AREA};
        let (soil, lava) = (
            tile_id(VulcanusTile::VolcanicSoilDark),
            tile_id(VulcanusTile::Lava),
        );
        let mut tiles = [[soil; AREA]; AREA];
        tiles[40] = [lava; AREA];
        let layers = layers();
        let mut plain = Area::new(tiles, &layers);
        let moved = plain.correct_centre_chunk();
        assert!(!moved.is_empty());
        assert_eq!(
            plain.tile(39, 50),
            lava,
            "without the rule the strip widens"
        );
        let rules = neighbours();
        let mut ruled = Area::with_neighbours(tiles, &layers, &rules);
        assert!(
            ruled.correct_centre_chunk().is_empty(),
            "with it nothing moves"
        );
    }
}
