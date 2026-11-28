//! Aquilo's terrain against a REAL surface (#454): the raw tile argmax, then
//! tile correction (`tiles::correction`), graded by tile name against
//! `get_tile` on a generated surface.
//!
//! A child of `fixtures` so it can use that module's loaders.

use super::{gleba_real_surface_grid, load_captured_at};
use crate::at::At;
use crate::expressions::aquilo_resources::{AquiloLevers, AquiloResourceControls};
use crate::expressions::aquilo_stack::{AquiloCtx, AquiloStack, AQUILO_CORRECTION_MARGIN_CHUNKS};
use crate::test_json::Json;
use crate::tiles::aquilo_catalog::{probabilities, AquiloTile, TILE_ORDER};
use core::cell::RefCell;
use std::collections::BTreeSet;

/// `get_tile` over -128..127 on a real Aquilo surface at map seed 123456 (the
/// derived surface seed), the three resource controls at size 0 as the terrain
/// PNG has them, written by `FMW_PLANET=aquilo` through
/// `scripts/probes/gleba-real-surface`.
const AQUILO_REAL_SURFACE: &str = "test/fixtures/oracle-aquilo-real-surface.seed123456.json";

/// `123456 + crc32("aquilo")`.
const SEED: u32 = 3_111_923_328;

/// The levers the real surface and the terrain PNG were made with: all three
/// resource controls at size 0. They reshape the islands.
fn levers_off() -> AquiloResourceControls {
    let off = AquiloLevers {
        frequency: 1.0,
        size: 0.0,
    };
    AquiloResourceControls {
        crude_oil: off,
        lithium_brine: off,
        fluorine_vent: off,
    }
}

fn surface() -> (Json, i32, i32, usize, Vec<String>) {
    let fixture = load_captured_at(AQUILO_REAL_SURFACE, "2.1.23");
    assert_eq!(fixture.get("surfaceSeed").as_f64(), f64::from(SEED));
    assert_eq!(fixture.get("chunkOrder").as_str(), "radius");
    let (x0, y0, side, real) = gleba_real_surface_grid(&fixture);
    (fixture, x0, y0, side, real)
}

fn stack() -> AquiloStack {
    AquiloStack::with_host_trig(&AquiloCtx {
        seed0: SEED,
        controls: levers_off(),
    })
}

fn by_name(name: &str) -> AquiloTile {
    *TILE_ORDER
        .iter()
        .find(|t| t.game_name() == name)
        .unwrap_or_else(|| panic!("{name} is not an Aquilo tile"))
}

/// Where `ours` differs from the real surface, by tile name and by map colour
/// (ice-rough and ice-smooth share a colour, so a picture sees only the second).
fn differences(ours: &[AquiloTile], real: &[String]) -> (usize, usize) {
    assert_eq!(ours.len(), real.len());
    let (mut names, mut colours) = (0, 0);
    for (tile, want) in ours.iter().zip(real) {
        if tile.game_name() != want {
            names += 1;
            colours += usize::from(by_name(want).color() != tile.color());
        }
    }
    (names, colours)
}

fn raw_window(stack: &mut AquiloStack, x0: i32, y0: i32, side: usize) -> Vec<AquiloTile> {
    let mut out = Vec::with_capacity(side * side);
    for j in 0..side {
        for i in 0..side {
            out.push(stack.tile_at(At::tile(x0 + i as i32, y0 + j as i32)));
        }
    }
    out
}

/// Every Aquilo tile's `map_color` and effective layer are the ones the game
/// reports. Correction compares nothing about a tile but its layer.
#[test]
fn aquilo_colours_and_layers_match_the_game() {
    let (fixture, ..) = surface();
    let tiles = fixture.get("tiles");
    for tile in TILE_ORDER {
        let t = tiles.get(tile.game_name());
        let colour: Vec<u8> = t
            .get("mapColor")
            .as_array()
            .iter()
            .map(|v| v.as_f64() as u8)
            .collect();
        assert_eq!(tile.color().to_vec(), colour, "{}", tile.game_name());
        assert_eq!(
            f64::from(tile.layer()),
            t.get("layer").as_f64(),
            "{}",
            tile.game_name()
        );
    }
}

/// Our raw argmax against the real surface. **This grades the argmax alone**;
/// the real surface runs tile correction after it, which
/// `aquilo_corrected_tiles_against_the_real_surface` closes.
///
/// The colour count, 531, is the gap between the game's terrain preview PNG
/// and the real surface in this window: the WASM render equals the PNG at all
/// 1,048,576 of its pixels (`test/wasmAquiloRenderParity.spec.ts`).
#[test]
fn aquilo_raw_tiles_against_the_real_surface() {
    let (_, x0, y0, side, real) = surface();
    let ours = raw_window(&mut stack(), x0, y0, side);
    let kinds: std::collections::BTreeSet<_> = ours.iter().map(|t| t.game_name()).collect();
    let differ = differences(&ours, &real);
    eprintln!("aquilo raw vs real surface: {differ:?} (by name, by colour)");
    // Non-vacuity: all nine tiles are in the window.
    assert_eq!(kinds.len(), 9);
    assert_eq!(differ, (551, 531));
}

/// The window corrected as the app's worker pool asks for it: square tiles of
/// `tile` pixels, each corrected on its own with `margin` chunks around it.
fn tiled(
    stack: &mut AquiloStack,
    (x0, y0, side): (i32, i32, usize),
    tile: usize,
    margin: i32,
) -> Vec<AquiloTile> {
    let mut out = vec![AquiloTile::SnowFlat; side * side];
    for ty in (0..side).step_by(tile) {
        for tx in (0..side).step_by(tile) {
            let (w, h) = (tile.min(side - tx), tile.min(side - ty));
            let c = stack.corrected_tiles(
                (x0 + tx as i32, y0 + ty as i32),
                (w as u32, h as u32),
                margin,
            );
            for j in 0..h {
                out[(ty + j) * side + tx..(ty + j) * side + tx + w]
                    .copy_from_slice(&c[j * w..(j + 1) * w]);
            }
        }
    }
    out
}

/// After tile correction: **0 of 65,536 tiles differ by name**.
///
/// The fixture is one radius request, which corrects chunks in columns order,
/// as `correct_chunks` does. A chunk-by-chunk columns request over -6..5 gave a
/// byte-identical window (measured 2026-11-26, not committed).
///
/// **The margin is load-bearing for a tiled render, not for this window
/// whole.** Corrected whole with no margin, the window is still exact. Cut
/// into the tiles a worker pool asks for, each corrected without a margin, it
/// is not; with the one-chunk margin it is exact again. Measured the same way
/// on two uncommitted 1024 x 1024 real surfaces (levers off, and neutral with
/// every entity autoplace removed), 128-pixel tiles as the app cuts them: 46
/// and 108 tiles wrong with no margin, 0 and 0 with one chunk.
#[test]
fn aquilo_corrected_tiles_against_the_real_surface() {
    let (_, x0, y0, side, real) = surface();
    let mut stack = stack();
    let whole = |stack: &mut AquiloStack, margin| {
        stack.corrected_tiles((x0, y0), (side as u32, side as u32), margin)
    };
    let shipped = whole(&mut stack, AQUILO_CORRECTION_MARGIN_CHUNKS);
    let differ = differences(&shipped, &real);
    eprintln!("aquilo corrected vs real surface: {differ:?}");
    assert_eq!(differ, (0, 0));
    assert_eq!(differences(&whole(&mut stack, 0), &real), (0, 0));
    assert_eq!(
        whole(&mut stack, AQUILO_CORRECTION_MARGIN_CHUNKS + 1),
        shipped
    );

    // 128 pixels is the app's tile (`DEFAULT_TILE_SIZE`). 64 gives the same
    // counts here; 100-pixel tiles happen to be exact even with no margin.
    let window = (x0, y0, side);
    let app_tile = 128;
    let none = differences(&tiled(&mut stack, window, app_tile, 0), &real);
    let one = differences(
        &tiled(
            &mut stack,
            window,
            app_tile,
            AQUILO_CORRECTION_MARGIN_CHUNKS,
        ),
        &real,
    );
    eprintln!("aquilo tiled {app_tile}: no margin {none:?}, shipped margin {one:?}");
    assert_eq!((none, one), ((45, 44), (0, 0)));
}

/// **Aquilo's argmax has no ties here, so its tie-break cannot show.** The game
/// keeps the first of its candidate list at a tie, and Gleba showed that list
/// is in name order (`tiles/gleba_catalog.rs`). Aquilo's catalog keeps the
/// first in `autoplace_settings` order instead. The two orders differ only
/// among the land tiles; the one tie the formulas make on purpose, the two
/// oceans where `aux` is exactly 0.5, goes to `ammoniacal-ocean` either way.
///
/// Counted over the window and the 64 tiles around it that correction reads:
/// 0 ties. A one-off run over -576..575 (1,327,104 tiles, release build,
/// 2026-11-26) also found 0, as did `oracle-aquilo-fields` (0 of 1,024).
#[test]
fn aquilo_has_no_tile_ties_in_the_window() {
    let (_, x0, y0, side, _) = surface();
    let mut stack = stack();
    let mut ties = std::collections::BTreeMap::<(String, String), usize>::new();
    // The margin the render reads too.
    let m = 64;
    for j in -m..side as i32 + m {
        for i in -m..side as i32 + m {
            let f = stack.eval_at(At::tile(x0 + i, y0 + j));
            let p = probabilities(&f.terrain);
            let best = p.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let top: Vec<usize> = (0..9).filter(|&k| p[k] == best).collect();
            if top.len() > 1 {
                let key = (
                    TILE_ORDER[top[0]].game_name().to_string(),
                    TILE_ORDER[top[1]].game_name().to_string(),
                );
                *ties.entry(key).or_default() += 1;
            }
        }
    }
    assert!(ties.is_empty(), "ties: {ties:?}");
}

/// A second, independent real surface: the land mask of
/// `oracle-aquilo-surface.seed123456.json` (`scripts/probes/aquilo-entity-stream`),
/// 640 x 640 tiles at NEUTRAL levers, its wells' tile rewrite stripped and its
/// icebergs left in. Our corrected tiles give the game's land or water at
/// every one of its 409,600 tiles; the raw argmax misses 172.
///
/// This bears on #553: the entity replay in `fixtures.rs` reads the game's own
/// land because the raw argmax moves the shore. Corrected tiles do not.
#[test]
fn aquilo_corrected_land_matches_the_entity_stream_surface() {
    let fx = load_captured_at(
        "test/fixtures/oracle-aquilo-surface.seed123456.json",
        "2.1.23",
    );
    assert_eq!(fx.get("surfaceSeed").as_f64(), f64::from(SEED));
    let w = fx.get("window");
    let (x0, y0) = (w.get("x0").as_f64() as i32, w.get("y0").as_f64() as i32);
    let side = w.get("width").as_f64() as usize;
    let mut land = Vec::with_capacity(side * side);
    for row in fx.get("land").as_array() {
        for (k, run) in row.as_array().iter().enumerate() {
            land.extend(std::iter::repeat_n(k % 2 == 1, run.as_f64() as usize));
        }
    }
    assert_eq!(land.len(), side * side);
    let mut stack = AquiloStack::with_host_trig(&AquiloCtx {
        seed0: SEED,
        controls: AquiloResourceControls::default(),
    });
    // Land is the six tiles icebergs may stand on, as the fixture's legend has it.
    let is_land = |t: &AquiloTile| {
        !matches!(
            t,
            AquiloTile::BrashIce | AquiloTile::AmmoniacalOcean | AquiloTile::AmmoniacalOcean2
        )
    };
    let wrong = |tiles: &[AquiloTile]| {
        tiles
            .iter()
            .zip(&land)
            .filter(|(t, l)| is_land(t) != **l)
            .count()
    };
    let raw = raw_window(&mut stack, x0, y0, side);
    let corrected = stack.corrected_tiles(
        (x0, y0),
        (side as u32, side as u32),
        AQUILO_CORRECTION_MARGIN_CHUNKS,
    );
    assert_eq!((wrong(&raw), wrong(&corrected)), (172, 0));
}

// ---------------------------------------------------------------------------
// #553: the wells and icebergs over the app's default window.
// ---------------------------------------------------------------------------

/// Every well and iceberg on a real Aquilo surface over -512..511 at neutral
/// levers, the map a player gets, by `scripts/probes/aquilo-real-surface-entities`.
const AQUILO_REAL_ENTITIES: &str =
    "test/fixtures/oracle-aquilo-real-surface-entities.seed123456.json";

/// An entity as (name, x, y), x and y in 1/256 tile.
type Named = (String, i64, i64);

/// Whether a position in 1/256 tile stands on a tile of the window.
fn in_window((x, y): (i64, i64), (x0, y0): (i64, i64), (w, h): (i64, i64)) -> bool {
    (x0..x0 + w).contains(&x.div_euclid(256)) && (y0..y0 + h).contains(&y.div_euclid(256))
}

/// The game's entities whose tile is in the window.
fn game_entities(fx: &Json, origin: (i64, i64), size: (i64, i64)) -> BTreeSet<Named> {
    fx.get("entities")
        .as_array()
        .iter()
        .map(|r| {
            let r = r.as_array();
            let fixed = |v: &Json| (v.as_f64() * 256.0) as i64;
            (r[0].as_str().to_string(), fixed(&r[1]), fixed(&r[2]))
        })
        .filter(|(_, x, y)| in_window((*x, *y), origin, size))
        .collect()
}

/// The stack at the fixture's seed and neutral levers.
fn neutral_stack() -> RefCell<AquiloStack> {
    RefCell::new(AquiloStack::with_host_trig(&AquiloCtx {
        seed0: SEED,
        controls: AquiloResourceControls::default(),
    }))
}

/// The shipped path over a window, against the game: (matched, ours, game),
/// counting the entities whose tile is in the window. `ring` is the chunks
/// placed around the window's own.
fn aquilo_window_replay(origin: (i64, i64), size: (i64, i64), ring: i64) -> (usize, usize, usize) {
    use crate::placement::aquilo::real_surface_window;
    let fx = load_captured_at(AQUILO_REAL_ENTITIES, "2.1.23");
    assert_eq!(fx.get("surfaceSeed").as_f64(), f64::from(SEED));
    let stack = neutral_stack();
    let surface = real_surface_window(&stack, origin, size, ring, 0);
    let ours: BTreeSet<Named> = surface
        .placed
        .iter()
        .filter(|p| in_window((p.x, p.y), origin, size))
        .map(|p| (p.entity.game_name().to_string(), p.x, p.y))
        .collect();
    let game = game_entities(&fx, origin, size);
    (game.intersection(&ours).count(), ours.len(), game.len())
}

/// **Two windows of the shipped path against the real surface, every entity
/// at the game's position to the 1/256 tile, and nothing else.** The windows
/// are the spec's two (spawn, and the lithium field to the north-east),
/// snapped out to whole chunks. The whole 1024 window is
/// `aquilo_entities_whole_window_real_surface`, ignored because it takes
/// about a minute in a debug build.
#[test]
fn aquilo_entities_replay_the_real_surface() {
    let spawn = aquilo_window_replay(SPAWN.0, SPAWN.1, 1);
    let lithium = aquilo_window_replay(LITHIUM.0, LITHIUM.1, 1);
    eprintln!("aquilo entity windows: spawn {spawn:?}, lithium {lithium:?}");
    assert_eq!(spawn, (69, 69, 69));
    assert_eq!(lithium, (43, 43, 43));
}

/// The spec's spawn window, snapped out to whole chunks.
const SPAWN: ((i64, i64), (i64, i64)) = ((-64, -128), (128, 128));
/// The spec's lithium window to the north-east, snapped out to whole chunks.
const LITHIUM: ((i64, i64), (i64, i64)) = ((128, -448), (160, 128));

/// One rule changed at a time over the same two windows, each against the
/// game: (matched, ours, game).
fn aquilo_window_control(
    (origin, size): ((i64, i64), (i64, i64)),
    raw_tiles: bool,
    rule: crate::placement::aquilo::Apply,
) -> (usize, usize, usize) {
    use crate::placement::aquilo::{apply, queue_chunks, real_surface_window, rows};
    let fx = load_captured_at(AQUILO_REAL_ENTITIES, "2.1.23");
    let stack = neutral_stack();
    let surface = real_surface_window(&stack, origin, size, 1, 0);
    let (ax, ay) = surface.area_origin;
    let (aw, ah) = surface.area_size;
    let chunks = rows((ax / 32, (ax + aw) / 32 - 1), (ay / 32, (ay + ah) / 32 - 1));
    let lookup = |tx: i64, ty: i64| surface.tile(tx, ty);
    let tiles: Option<&dyn Fn(i64, i64) -> Option<AquiloTile>> =
        (!raw_tiles).then_some(&lookup as &dyn Fn(i64, i64) -> Option<AquiloTile>);
    let placed = apply(&queue_chunks(&stack, tiles, None, &chunks), rule);
    let ours: BTreeSet<Named> = placed
        .iter()
        .filter(|p| in_window((p.x, p.y), origin, size))
        .map(|p| (p.entity.game_name().to_string(), p.x, p.y))
        .collect();
    let game = game_entities(&fx, origin, size);
    (game.intersection(&ours).count(), ours.len(), game.len())
}

/// The controls for the test above. Each changes one rule of the shipped
/// path, and each turns the spawn window red (matched, ours, game):
///
/// - **strict overlap** (boxes that only touch do not collide): (65, 72, 69)
///   and (40, 44, 43);
/// - **the preview's rule** (no apply step): every game entity is there, under
///   (69, 180, 69) and (43, 78, 43) of the preview's own;
/// - **the raw argmax** as the stream's tiles (no correction): (11, 71, 69)
///   and (19, 45, 43), so the correction is the larger step;
/// - **no ring** of chunks around the window (the same window placed alone):
///   (68, 68, 69) at spawn. It stays green in the lithium window, which no
///   cross-chunk collision reaches; the whole window shows it too (3 wrong).
#[test]
fn aquilo_entity_replay_controls() {
    use crate::placement::aquilo::Apply;
    let rows = [SPAWN, LITHIUM].map(|w| {
        (
            aquilo_window_control(w, false, Apply::StrictOverlap),
            aquilo_window_control(w, false, Apply::Preview),
            aquilo_window_control(w, true, Apply::RealSurface),
            aquilo_window_replay(w.0, w.1, 0),
        )
    });
    eprintln!("aquilo entity controls (strict, preview, raw, no ring): {rows:?}");
    assert_eq!(
        rows[0],
        ((65, 72, 69), (69, 180, 69), (11, 71, 69), (68, 68, 69))
    );
    assert_eq!(
        rows[1],
        ((40, 44, 43), (43, 78, 43), (19, 45, 43), (43, 43, 43))
    );
}

/// **The whole default window: all 635 of the game's wells and icebergs at
/// the game's positions, and nothing else.** Without the ring of chunks
/// around the window, 3 of the 635 placed are wrong. Run it with
/// `--release --ignored`; it takes about 4 seconds there.
#[test]
#[ignore = "about a minute in a debug build; run with --release --ignored"]
fn aquilo_entities_whole_window_real_surface() {
    let whole = aquilo_window_replay((-512, -512), (1024, 1024), 1);
    let no_ring = aquilo_window_replay((-512, -512), (1024, 1024), 0);
    eprintln!("aquilo whole window: {whole:?}, no ring {no_ring:?}");
    assert_eq!(whole, (635, 635, 635));
    assert_eq!(no_ring, (632, 635, 635));
}
