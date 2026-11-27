//! Fulgora's terrain against a REAL surface (#454's method, applied to
//! Fulgora): the raw tile argmax, then tile correction (`tiles::correction`),
//! graded by tile name against `get_tile`.
//!
//! The fixtures are `get_tile` over -128..127 at map seed 123456 (the derived
//! surface seed), terrain-only, written by
//! `FMW_PLANET=fulgora scripts/probes/gleba-real-surface/capture.ts`. The game's
//! own preview PNG shows the raw argmax and our raw argmax matches it at every
//! pixel, so the gap between raw and real below is the correction pass.
//!
//! Three captures, differing only in how the chunks were requested:
//!
//! | fixture | request | vs radius 10 |
//! | --- | --- | ---: |
//! | `-radius10` | one radius request, 10 chunks | 0 |
//! | (plain) | one radius request, 6 chunks (the probe's default) | 5 |
//! | `-rows` | chunk by chunk over -6..5, rows order | 10 |
//!
//! Radius 7 and 18 give the radius-10 window tile for tile (measured, not
//! committed), so radius 10 is what the inside of a generated area holds.

use super::load_captured_at;
use crate::at::At;
use crate::expressions::fulgora_scrap::ScrapControls;
use crate::expressions::fulgora_shared::FulgoraCtx;
use crate::expressions::fulgora_stack::{
    correction_id, correction_layers, tile_from_correction_id, FulgoraStack,
    CORRECTION_MARGIN_CHUNKS,
};
use crate::test_json::Json;
use crate::tiles::correction::{
    correct_chunks_in_order, requested_correction_order, TileWorld, UNKNOWN,
};
use crate::tiles::fulgora_catalog::{FulgoraTile, NAME_ORDER};
use crate::tiles::fulgora_ocean::ocean_probabilities;

/// One radius request of 10 chunks around spawn: the window is well inside
/// what was generated. The render is graded against this one.
const FULGORA_REAL_SURFACE_RADIUS10: &str =
    "test/fixtures/oracle-fulgora-real-surface-radius10.seed123456.json";

/// One radius request of 6 chunks (the probe's default, two chunks of margin
/// around the window), the same method as Gleba's fixture.
const FULGORA_REAL_SURFACE: &str = "test/fixtures/oracle-fulgora-real-surface.seed123456.json";

/// The same window, its chunks requested one by one over -6..5 in rows order.
const FULGORA_REAL_SURFACE_ROWS: &str =
    "test/fixtures/oracle-fulgora-real-surface-rows.seed123456.json";

/// The derived Fulgora surface seed for map seed 123456.
const FULGORA_SURFACE_SEED_123456: u32 = 2_967_702_466;

/// The fixture as a grid of tiles, row-major from (x0, y0).
fn real_grid(fixture: &Json) -> (i32, i32, usize, Vec<FulgoraTile>) {
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
    let mut grid = Vec::with_capacity(side * side);
    for row in fixture.get("rows").as_array() {
        let row = row.as_str();
        assert_eq!(row.chars().count(), side);
        for c in row.chars() {
            let i = alphabet
                .iter()
                .position(|a| *a == c)
                .expect("a known symbol");
            let tile = NAME_ORDER
                .iter()
                .find(|t| t.game_name() == names[i])
                .unwrap_or_else(|| panic!("{} is not a Fulgora tile", names[i]));
            grid.push(*tile);
        }
    }
    assert_eq!(grid.len(), side * side);
    (
        window.get("x0").as_f64() as i32,
        window.get("y0").as_f64() as i32,
        side,
        grid,
    )
}

fn surface_stack(fixture: &Json) -> FulgoraStack {
    assert_eq!(
        fixture.get("surfaceSeed").as_f64(),
        f64::from(FULGORA_SURFACE_SEED_123456)
    );
    // Islands frequency and size at 1: the capture leaves `fulgora_islands`,
    // which cannot be disabled, at its default.
    FulgoraStack::with_host_trig(
        &FulgoraCtx::new(FULGORA_SURFACE_SEED_123456),
        &ScrapControls::default(),
    )
}

/// Where `ours` differs from the real surface: `(by tile name, by map colour)`.
/// The `-2` oil-ocean variants share a map colour with their base tile, so a
/// picture sees only the second.
fn differences(ours: &[FulgoraTile], real: &[FulgoraTile]) -> (usize, usize) {
    assert_eq!(ours.len(), real.len());
    let names = ours.iter().zip(real).filter(|(a, b)| a != b).count();
    let colours = ours
        .iter()
        .zip(real)
        .filter(|(a, b)| a.folded() != b.folded())
        .count();
    (names, colours)
}

/// Chunks `c0..=c1` on both axes, x outer (columns) or y outer (rows).
fn chunk_list(c0: i32, c1: i32, columns: bool) -> Vec<(i32, i32)> {
    let mut out = Vec::new();
    for u in c0..=c1 {
        for v in c0..=c1 {
            out.push(if columns { (u, v) } else { (v, u) });
        }
    }
    out
}

/// The window after correcting the chunks within one chunk of it in the order
/// the game queues them for `requested` (`requested_correction_order`).
fn corrected_as_requested(
    stack: &mut FulgoraStack,
    (x0, y0): (i32, i32),
    side: usize,
    requested: &[(i32, i32)],
) -> Vec<FulgoraTile> {
    let (c0, c1) = (
        x0.div_euclid(32) - 1,
        (x0 + side as i32 - 1).div_euclid(32) + 1,
    );
    let order: Vec<_> = requested_correction_order(requested)
        .into_iter()
        .filter(|&(x, y)| (c0..=c1).contains(&x) && (c0..=c1).contains(&y))
        .collect();
    // Lazy, as the renderer reads: every tile starts UNKNOWN and is read from
    // the stack the first time a task needs it.
    let mut world = TileWorld {
        chunk_x0: c0 - 1,
        chunk_y0: c0 - 1,
        chunks_wide: c1 - c0 + 3,
        chunks_high: c1 - c0 + 3,
        tiles: Vec::new(),
    };
    world.tiles = vec![UNKNOWN; world.width() * world.width()];
    let mut raw = |x: i32, y: i32| correction_id(stack.tile_at(At::tile(x, y)));
    correct_chunks_in_order(&mut world, &mut raw, &correction_layers(), None, &order);
    let mut out = Vec::with_capacity(side * side);
    for y in y0..y0 + side as i32 {
        for x in x0..x0 + side as i32 {
            out.push(tile_from_correction_id(world.at(x, y)));
        }
    }
    out
}

/// Every Fulgora tile's effective layer is the one the game reports, and
/// `NAME_ORDER` is the game's candidate list (the probe sorts the names the
/// surface's `autoplace_settings` carry).
#[test]
fn fulgora_layers_match_the_game() {
    let fixture = load_captured_at(FULGORA_REAL_SURFACE_RADIUS10, "2.1.23");
    let tiles = fixture.get("tiles");
    for tile in NAME_ORDER {
        let want = tiles.get(tile.game_name()).get("layer").as_f64();
        assert_eq!(f64::from(tile.layer()), want, "{}", tile.game_name());
    }
    let names: Vec<&str> = NAME_ORDER.iter().map(|t| t.game_name()).collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted, "NAME_ORDER is sorted by name");
    let names_in_fixture: Vec<&str> = fixture
        .get("names")
        .as_array()
        .iter()
        .map(Json::as_str)
        .collect();
    assert_eq!(names, names_in_fixture);
}

/// Our raw tile choice, through the chunk-grid kernel (`At::tile`), against
/// `get_tile` on the radius-10 surface: **1,703 of 65,536 differ by name,
/// 1,003 by map colour** (1,706 and 1,006 against the radius-6 one). The colour
/// count is exactly how far the game's own preview PNG is from this surface,
/// because the PNG is the raw argmax. The name count
/// is larger because correction also moves tiles between `oil-ocean-shallow`
/// and `-shallow-2` (layers 148 and 147) and between `oil-ocean-deep` and
/// `-deep-2` (66 and 67), which share a colour.
#[test]
fn fulgora_raw_tiles_against_the_real_surface() {
    let fixture = load_captured_at(FULGORA_REAL_SURFACE_RADIUS10, "2.1.23");
    let (x0, y0, side, real) = real_grid(&fixture);
    let mut stack = surface_stack(&fixture);
    let mut raw = Vec::with_capacity(side * side);
    for j in 0..side {
        for i in 0..side {
            raw.push(stack.tile_at(At::tile(x0 + i as i32, y0 + j as i32)));
        }
    }
    // Non-vacuity: all twelve tiles appear in the window, both `-2`s included.
    let kinds: std::collections::BTreeSet<_> = raw.iter().map(|t| t.game_name()).collect();
    assert_eq!(kinds.len(), 12, "{kinds:?}");
    let differ = differences(&raw, &real);
    eprintln!("fulgora raw vs real surface: {differ:?}");
    assert_eq!(differ, (1703, 1003));
}

/// Our tiles after tile correction (columns order, the window plus one chunk,
/// as the renderer runs it) against the radius-10 surface: **0 of 65,536
/// differ**, by name and so by colour.
///
/// Controls, by (name, colour): correcting only the window's own chunks leaves
/// (61, 58); a wider margin changes nothing.
#[test]
fn fulgora_corrected_tiles_against_the_real_surface() {
    let fixture = load_captured_at(FULGORA_REAL_SURFACE_RADIUS10, "2.1.23");
    assert_eq!(fixture.get("chunkOrder").as_str(), "radius");
    assert_eq!(fixture.get("marginChunks").as_f64(), 6.0);
    let (x0, y0, side, real) = real_grid(&fixture);
    let mut stack = surface_stack(&fixture);
    let mut window = |margin| stack.corrected_tiles((x0, y0), (side as u32, side as u32), margin);
    let shipped = window(CORRECTION_MARGIN_CHUNKS);
    let differ = differences(&shipped, &real);
    eprintln!("fulgora corrected vs real surface: {differ:?}");
    assert_eq!(differ, (0, 0));
    assert_eq!(differences(&window(0), &real), (61, 58));
    assert_eq!(window(CORRECTION_MARGIN_CHUNKS + 1), shipped);
}

/// **Near the edge of what was requested, the request order reaches the map.**
/// The radius-6 surface asked for chunks -6..6 only, two chunks past the
/// window, and differs from the radius-10 one at 5 tiles, in one cluster at
/// the chunk corner near (-128, -96). The rows-order surface (-6..5 requested
/// one by one) differs at 10.
///
/// Columns order (the renderer's) is 5 and 10 tiles off those two. The order
/// the game queues the tasks in when it is asked for exactly those chunks
/// (`requested_correction_order`: each request asks for its 3 x 3 one stage
/// lower first) reproduces each of them at every tile, and also the
/// radius-10 surface, so the difference is that order and nothing else. A
/// preview cannot know what a player's game requested, so the renderer models
/// the inside of a generated area, which is columns order.
#[test]
fn fulgora_corrected_tiles_near_the_edge_of_a_request() {
    let r10 = load_captured_at(FULGORA_REAL_SURFACE_RADIUS10, "2.1.23");
    let (x0, y0, side, r10_real) = real_grid(&r10);
    let r6 = load_captured_at(FULGORA_REAL_SURFACE, "2.1.23");
    assert_eq!(r6.get("chunkOrder").as_str(), "radius");
    let (_, _, _, r6_real) = real_grid(&r6);
    let rows = load_captured_at(FULGORA_REAL_SURFACE_ROWS, "2.1.23");
    assert_eq!(rows.get("chunkOrder").as_str(), "rows");
    let (_, _, _, rows_real) = real_grid(&rows);
    assert_eq!(differences(&r6_real, &r10_real), (5, 5));
    assert_eq!(differences(&rows_real, &r10_real), (10, 7));

    let mut stack = surface_stack(&r10);
    let size = (side as u32, side as u32);
    let columns = stack.corrected_tiles((x0, y0), size, CORRECTION_MARGIN_CHUNKS);
    assert_eq!(differences(&columns, &r6_real), (5, 5));
    assert_eq!(differences(&columns, &rows_real), (10, 7));

    let cases = [
        (chunk_list(-10, 10, true), &r10_real),
        (chunk_list(-6, 6, true), &r6_real),
        (chunk_list(-6, 5, false), &rows_real),
    ];
    for (requested, real) in cases {
        let ours = corrected_as_requested(&mut stack, (x0, y0), side, &requested);
        assert_eq!(differences(&ours, real), (0, 0));
    }
}

/// **No exact tie at the maximum** among the twelve scores, at every tile the
/// shipped render reads around the real-surface window (-192..191) and on a
/// sparse sweep far from spawn. So the candidate order (`NAME_ORDER`, names
/// sorted, Gleba's measured tie rule) changes no tile here, and the order the
/// port used before it changed none either.
#[test]
fn fulgora_ties_at_the_maximum() {
    let mut stack = FulgoraStack::with_host_trig(
        &FulgoraCtx::new(FULGORA_SURFACE_SEED_123456),
        &ScrapControls::default(),
    );
    let mut ties = 0usize;
    let mut seen = 0usize;
    let mut count = |stack: &mut FulgoraStack, at: At| {
        let f = stack.eval_at(at);
        let mut scores: Vec<f32> = ocean_probabilities(&f.elevation)
            .iter()
            .chain(f.land_probabilities().iter())
            .map(|v| *v as f32)
            .filter(|v| v.is_finite())
            .collect();
        scores.sort_unstable_by(|a, b| b.partial_cmp(a).expect("finite"));
        seen += 1;
        if scores.len() > 1 && scores[0] == scores[1] {
            ties += 1;
        }
    };
    for y in -192..192 {
        for x in -192..192 {
            count(&mut stack, At::tile(x, y));
        }
    }
    for j in 0..128 {
        for i in 0..128 {
            count(&mut stack, At::tile(i * 97 - 6000, j * 89 - 5000));
        }
    }
    assert_eq!(seen, 384 * 384 + 128 * 128);
    assert_eq!(ties, 0);
}
