//! Nauvis terrain against a REAL surface (#454 follow-up): `get_tile` on a
//! fresh Nauvis surface at map seed 123456, written by
//! `scripts/probes/gleba-real-surface` (`FMW_PLANET=nauvis`).
//!
//! Two windows of 256 x 256 tiles. The spawn window (-128..127) is the centre
//! of the terrain preview PNG; the coast window (384..639, -320..-65) is where
//! the raw tiles put deepwater beside land, so it grades the one rule the spawn
//! window cannot reach (`tiles::correction::Neighbours`).

use super::load_captured_at;
use crate::at::At;
use crate::expressions::nauvis_stack::{NauvisCtx, NauvisStack};
use crate::test_json::Json;
use crate::tiles::nauvis_catalog::{NauvisTile, NauvisTileCatalog, NauvisTileFields, TILE_ORDER};
use crate::tiles::nauvis_correction::{
    deepwater_land_contacts, may_touch, nauvis_corrected_tiles, nauvis_corrected_tiles_eager,
    nauvis_corrected_tiles_ignoring_neighbours, nauvis_raw_world_tiles,
    NAUVIS_CORRECTION_MARGIN_CHUNKS,
};
use crate::tiles::nauvis_resolve::nauvis_tile;

const NAUVIS_REAL_SURFACE: &str = "test/fixtures/oracle-nauvis-real-surface.seed123456.json";

/// The coast window, from the same kind of surface (one radius request).
const NAUVIS_REAL_SURFACE_COAST: &str =
    "test/fixtures/oracle-nauvis-real-surface-coast.seed123456.json";

/// Nauvis's surface seed IS the map seed.
const NAUVIS_SEED: u32 = 123_456;

/// A real-surface fixture as a grid of tiles, row-major from (x0, y0).
struct Real {
    x0: i32,
    y0: i32,
    side: usize,
    tiles: Vec<NauvisTile>,
}

fn by_name(name: &str) -> NauvisTile {
    *TILE_ORDER
        .iter()
        .find(|t| t.name() == name)
        .unwrap_or_else(|| panic!("{name} is not a Nauvis tile"))
}

fn real_grid(fixture: &Json) -> Real {
    assert_eq!(fixture.get("chunkOrder").as_str(), "radius");
    assert_eq!(fixture.get("surfaceSeed").as_f64(), f64::from(NAUVIS_SEED));
    let names: Vec<&str> = fixture
        .get("names")
        .as_array()
        .iter()
        .map(Json::as_str)
        .collect();
    let alphabet: Vec<char> = fixture.get("alphabet").as_str().chars().collect();
    let window = fixture.get("window");
    let side = window.get("width").as_f64() as usize;
    assert_eq!(window.get("height").as_f64() as usize, side);
    let mut tiles = Vec::with_capacity(side * side);
    for row in fixture.get("rows").as_array() {
        let row = row.as_str();
        assert_eq!(row.chars().count(), side);
        for c in row.chars() {
            let i = alphabet
                .iter()
                .position(|a| *a == c)
                .expect("a known symbol");
            tiles.push(by_name(names[i]));
        }
    }
    assert_eq!(tiles.len(), side * side);
    Real {
        x0: window.get("x0").as_f64() as i32,
        y0: window.get("y0").as_f64() as i32,
        side,
        tiles,
    }
}

fn stack() -> (NauvisStack, NauvisTileCatalog) {
    (
        NauvisStack::new(&NauvisCtx::defaults(NAUVIS_SEED)),
        NauvisTileCatalog::new(NAUVIS_SEED),
    )
}

/// Where `ours` differs from `real`: by tile name, and by map colour.
fn differences(ours: &[NauvisTile], real: &[NauvisTile]) -> (usize, usize) {
    assert_eq!(ours.len(), real.len());
    let names = ours.iter().zip(real).filter(|(a, b)| a != b).count();
    let colours = ours
        .iter()
        .zip(real)
        .filter(|(a, b)| a.color() != b.color())
        .count();
    (names, colours)
}

fn raw_window(r: &Real) -> Vec<NauvisTile> {
    let (stack, catalog) = stack();
    let mut ours = Vec::with_capacity(r.side * r.side);
    for j in 0..r.side {
        for i in 0..r.side {
            ours.push(nauvis_tile(
                &stack,
                &catalog,
                At::tile(r.x0 + i as i32, r.y0 + j as i32),
            ));
        }
    }
    ours
}

/// Every Nauvis tile's `map_color`, effective layer and forbidden neighbours
/// are the ones the game reports. Tile correction reads nothing else about a
/// tile.
#[test]
fn nauvis_tile_properties_match_the_game() {
    let fixture = load_captured_at(NAUVIS_REAL_SURFACE, "2.1.23");
    let tiles = fixture.get("tiles");
    let mut forbidden = 0;
    for tile in TILE_ORDER {
        let t = tiles.get(tile.name());
        assert_eq!(
            f64::from(tile.layer()),
            t.get("layer").as_f64(),
            "{}",
            tile.name()
        );
        let want: Vec<u8> = t
            .get("mapColor")
            .as_array()
            .iter()
            .map(|v| v.as_f64() as u8)
            .collect();
        assert_eq!(tile.color().to_vec(), want, "{}", tile.name());
        let banned: Vec<NauvisTile> = t.get_opt("notAllowed").map_or_else(Vec::new, |l| {
            l.as_array().iter().map(|n| by_name(n.as_str())).collect()
        });
        for other in TILE_ORDER {
            if other != tile {
                assert_eq!(
                    may_touch(tile, other),
                    !banned.contains(&other),
                    "{} / {}",
                    tile.name(),
                    other.name()
                );
            }
        }
        forbidden += banned.len();
    }
    // Deepwater against the 19 land tiles, both ways round.
    assert_eq!(forbidden, 38);
}

/// Our raw argmax (the chunk-grid kernel, what the preview PNG shows) against
/// the real surface. The whole gap is tile correction, which the corrected
/// test closes. On the spawn window the colour count equals the gap between
/// the game's own preview PNG and the real surface (89), because the raw
/// render matches that PNG at every pixel.
#[test]
fn nauvis_raw_tiles_against_the_real_surface() {
    for (path, want) in [
        // Every one of the 89 is a colour change too: no two of the seven
        // tiles present share a map colour.
        (NAUVIS_REAL_SURFACE, (89, 89)),
        (NAUVIS_REAL_SURFACE_COAST, (326, 326)),
    ] {
        let real = real_grid(&load_captured_at(path, "2.1.23"));
        let ours = raw_window(&real);
        let differ = differences(&ours, &real.tiles);
        eprintln!("nauvis raw vs {path}: {differ:?}");
        // Non-vacuity: each window holds water, deepwater and land tiles.
        let kinds: std::collections::BTreeSet<_> = ours.iter().map(|t| t.name()).collect();
        assert!(kinds.len() >= 6, "{kinds:?}");
        assert!(kinds.contains("deepwater") && kinds.contains("water"));
        assert_eq!(differ, want, "{path}");
    }
}

/// Whether Nauvis has tile TIES at all. Gleba's argmax ties went to the name
/// that sorts first; Nauvis's argmax keeps the first tile in registration
/// order. Over the spawn window and the margin correction reads, no position
/// has two tiles sharing the top score, so the two rules pick the same tile
/// everywhere and the window cannot say which one the game uses.
#[test]
fn nauvis_has_no_tile_ties_in_the_real_surface_window() {
    let real = real_grid(&load_captured_at(NAUVIS_REAL_SURFACE, "2.1.23"));
    let (stack, catalog) = stack();
    // The window plus the one chunk margin and the ring a task reads.
    let pad = 32 * (NAUVIS_CORRECTION_MARGIN_CHUNKS + 1);
    let (mut ties, mut positions) = (0usize, 0usize);
    for y in real.y0 - pad..real.y0 + real.side as i32 + pad {
        for x in real.x0 - pad..real.x0 + real.side as i32 + pad {
            let at = At::tile(x, y);
            let p = catalog.probabilities(&NauvisTileFields {
                x: f64::from(x),
                y: f64::from(y),
                elevation: stack.elevation_nauvis.eval_at(at),
                aux: stack.aux.eval_at(at),
                moisture: stack.moisture.eval_at(at),
                grid: true,
            });
            let best = p.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            ties += usize::from(p.iter().filter(|v| **v == best).count() > 1);
            positions += 1;
        }
    }
    assert_eq!(positions, (real.side + 2 * pad as usize).pow(2));
    assert_eq!(ties, 0);
}

/// Our tiles after tile correction against the real surface, on the spawn
/// window. 0 of 65,536 differ.
#[test]
fn nauvis_corrected_tiles_against_the_real_surface() {
    let real = real_grid(&load_captured_at(NAUVIS_REAL_SURFACE, "2.1.23"));
    let (stack, catalog) = stack();
    let window = |margin| {
        nauvis_corrected_tiles(
            &stack,
            &catalog,
            (real.x0, real.y0),
            (real.side as u32, real.side as u32),
            margin,
        )
    };
    let shipped = window(NAUVIS_CORRECTION_MARGIN_CHUNKS);
    let differ = differences(&shipped, &real.tiles);
    eprintln!("nauvis corrected vs real surface: {differ:?}");
    assert_eq!(differ, (0, 0));
    // The lazy reads and the uniform skip change nothing (see the coast test).
    let size = (real.side as u32, real.side as u32);
    assert_eq!(
        nauvis_corrected_tiles_eager(
            &stack,
            &catalog,
            (real.x0, real.y0),
            size,
            NAUVIS_CORRECTION_MARGIN_CHUNKS
        ),
        shipped
    );
    // Unlike Gleba, correcting only the window's own chunks already gives the
    // same tiles here, and so does a wider margin: the margin is there for
    // windows elsewhere (the 1024 preview window moves 8 tiles without it).
    assert_eq!(window(0), shipped);
    assert_eq!(window(NAUVIS_CORRECTION_MARGIN_CHUNKS + 1), shipped);
    // The deepwater rule cannot reach this window: its raw tiles never put
    // deepwater beside land, so the coast window below grades the rule.
    let (raw, width) = nauvis_raw_world_tiles(
        &stack,
        &catalog,
        (real.x0, real.y0),
        (real.side as u32, real.side as u32),
        NAUVIS_CORRECTION_MARGIN_CHUNKS,
    );
    assert!(raw.contains(&NauvisTile::Deepwater));
    assert_eq!(deepwater_land_contacts(&raw, width), 0);
}

/// The coast window, where the raw tiles put deepwater beside land. With the
/// deepwater rule, 0 of 65,536 differ from the real surface; letting every
/// pair touch instead leaves the contacts in place.
#[test]
fn nauvis_corrected_tiles_against_the_real_coast() {
    let real = real_grid(&load_captured_at(NAUVIS_REAL_SURFACE_COAST, "2.1.23"));
    let (stack, catalog) = stack();
    let origin = (real.x0, real.y0);
    let size = (real.side as u32, real.side as u32);
    let (raw, width) = nauvis_raw_world_tiles(
        &stack,
        &catalog,
        origin,
        size,
        NAUVIS_CORRECTION_MARGIN_CHUNKS,
    );
    let contacts = deepwater_land_contacts(&raw, width);
    let real_contacts = deepwater_land_contacts(&real.tiles, real.side);
    let shipped = nauvis_corrected_tiles(
        &stack,
        &catalog,
        origin,
        size,
        NAUVIS_CORRECTION_MARGIN_CHUNKS,
    );
    let ignoring = nauvis_corrected_tiles_ignoring_neighbours(
        &stack,
        &catalog,
        origin,
        size,
        NAUVIS_CORRECTION_MARGIN_CHUNKS,
    );
    let differ = differences(&shipped, &real.tiles);
    let differ_ignoring = differences(&ignoring, &real.tiles);
    eprintln!(
        "nauvis coast: raw contacts {contacts}, real contacts {real_contacts}, corrected {differ:?}, ignoring neighbours {differ_ignoring:?}"
    );
    // The shipped grade: 0 of 65,536, where the raw argmax is 326 off.
    assert_eq!(differ, (0, 0));
    // The lazy reads and the uniform skip change nothing: the eager pass
    // over a fully filled world gives the same tiles.
    assert_eq!(
        nauvis_corrected_tiles_eager(
            &stack,
            &catalog,
            origin,
            size,
            NAUVIS_CORRECTION_MARGIN_CHUNKS
        ),
        shipped
    );
    // The real surface never puts deepwater beside land; the raw tiles of the
    // corrected world do, 90 times (pairs, counted from the deepwater side).
    assert_eq!(real_contacts, 0);
    assert_eq!(contacts, 90);
    // Control: the same pass with every pair allowed is 73 tiles off, so the
    // deepwater rule is what closes this window, not the layer checks.
    assert_eq!(differ_ignoring, (73, 73));
}
