//! Gleba's stone and stromatolites (#454, slice 3) against a REAL surface:
//! the resource fields at tier 1, the autoplacer facts the generator relies
//! on, and the placed entities replayed through the game's per-chunk
//! generator and its apply step.
//!
//! Ground truth is `oracle-gleba-real-surface-entities.seed123456.json`
//! (`scripts/probes/gleba-entities`): every stone, iron-stromatolite and
//! copper-stromatolite on a generated surface over -512..511 at map seed
//! 123456, with plants, pentapod nests and cliffs off.
//!
//! **The whole 1024 window replays exactly**, 5,193 of 5,193 at the game's
//! positions, but that costs about 9 seconds in a release build and far more
//! in the debug build the gate runs. So the tests here replay two 128-tile
//! windows chosen for density (one iron and stone, one copper and stone), and
//! `test/wasmGlebaEntityParity.spec.ts` grades the whole window through the
//! release WASM module, pixel by pixel.
//!
//! A child of `fixtures` so it can use that module's loaders.

use super::{count_exact_bits, load_captured_at};
use crate::at::At;
use crate::expressions::gleba_resources::GlebaResourceFields;
use crate::expressions::gleba_stack::{GlebaCtx, GlebaStack, CORRECTION_MARGIN_CHUNKS};
use crate::expressions::gleba_terrain::GlebaControls;
use crate::placement::generate::{Positioning, FIXED_ONE};
use crate::placement::gleba::{
    apply, layer, queue_chunks, rows, tile_layers, Apply, GLEBA_AUTOPLACERS, GLEBA_ENTITIES,
    GLEBA_GROUPS,
};
use crate::test_json::Json;
use crate::tiles::gleba_catalog::{GlebaTile, TILE_ORDER};
use std::collections::BTreeSet;

/// The graded arm: stone and both stromatolites on a real surface with plants,
/// nests and cliffs off, plus the autoplacer facts and the tier-1 fields.
const ENTITIES_FIXTURE: &str = "test/fixtures/oracle-gleba-real-surface-entities.seed123456.json";

/// `123456 + crc32("gleba")`.
const SEED: u32 = 3_215_206_427;

fn stack() -> GlebaStack {
    GlebaStack::new(&GlebaCtx {
        seed0: SEED,
        controls: GlebaControls::default(),
    })
}

/// The resource fields against `calculate_tile_properties` on the real
/// surface (derived seed, default levers): an exact f32 count per field, every
/// one of 2,560 positions.
///
/// The pool is weighted to where the fields are not flat: 512 positions
/// anywhere, 512 where the iron probability is above 0, 512 where the copper
/// one is, and 1,024 around the placed stone (half with richness above 0).
/// Only the point kernel is graded here; the grid kernel the generator reads
/// is graded by the placement replay below.
#[test]
fn gleba_resource_fields_match_the_game() {
    let fixture = load_captured_at(ENTITIES_FIXTURE, "2.1.23");
    assert_eq!(fixture.get("surfaceSeed").as_f64(), f64::from(SEED));
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 2560);
    let stack = stack();
    let ours: Vec<GlebaResourceFields> = positions
        .iter()
        .map(|p| {
            let xy = p.as_array();
            stack
                .resources_at(At::point(xy[0].as_f64(), xy[1].as_f64()))
                .1
        })
        .collect();
    let fields = fixture.get("fields");
    type Column = (&'static str, fn(&GlebaResourceFields) -> f64);
    let columns: [Column; 11] = [
        ("gleba_scrub_noise", |f| f.scrub_noise),
        ("gleba_decorative_knockout", |f| f.knockout),
        ("gleba_iron_stromatolite", |f| f.iron_stromatolite),
        ("gleba_copper_stromatolite", |f| f.copper_stromatolite),
        ("entity:iron-stromatolite:probability", |f| {
            f.iron_probability
        }),
        ("entity:copper-stromatolite:probability", |f| {
            f.copper_probability
        }),
        ("gleba_highland", |f| f.highland),
        ("gleba_midland_aux_2", |f| f.midland_aux_2),
        ("gleba_stone_richness", |f| f.stone_richness),
        ("entity:stone:probability", |f| f.stone_probability),
        ("entity:stone:richness", |f| f.stone_richness),
    ];
    let mut counts = Vec::new();
    for (name, select) in columns {
        let got: Vec<f64> = ours.iter().map(select).collect();
        let n = count_exact_bits(&got, fields.get(name).as_array());
        eprintln!("gleba {name}: {n}");
        counts.push(n);
    }
    // Non-vacuity: each probability takes both 0 and a positive value in the
    // pool, so a field stuck at 0 cannot pass.
    for (name, select) in &columns[4..6] {
        let positive = ours.iter().filter(|f| select(f) > 0.0).count();
        assert!((512..2560).contains(&positive), "{name}: {positive}");
    }
    let stone = ours.iter().filter(|f| f.stone_probability == 1.0).count();
    assert!(stone > 100 && stone < 2560, "stone: {stone}");
    assert_eq!(counts, vec![2560; 11]);
}

/// The facts `placement::gleba` hard-codes, against the prototypes as the game
/// reported them on the same surface: the sort that makes the stromatolites
/// the first group and stone the only resource, each box, flag and collision
/// layer, and every tile's layers.
#[test]
fn gleba_autoplacer_facts_match_the_game() {
    let fixture = load_captured_at(ENTITIES_FIXTURE, "2.1.23");
    let autoplacers = fixture.get("autoplacers").as_array();
    let fact = |name: &str| {
        autoplacers
            .iter()
            .find(|a| a.get("name").as_str() == name)
            .unwrap_or_else(|| panic!("{name} is not an autoplacer"))
    };
    // The sort is by (order, name) bytewise. The stromatolites' empty order is
    // the smallest of all, so they are the first group, and nothing else
    // shares it; every other prototype sorts after them.
    let mut orders: Vec<(String, String)> = autoplacers
        .iter()
        .map(|a| {
            (
                a.get("order").as_str().to_string(),
                a.get("name").as_str().to_string(),
            )
        })
        .collect();
    orders.sort();
    let first: Vec<&str> = orders[..2].iter().map(|(_, n)| n.as_str()).collect();
    assert_eq!(first, ["copper-stromatolite", "iron-stromatolite"]);
    assert_eq!((orders[0].0.as_str(), orders[1].0.as_str()), ("", ""));
    assert!(orders[2..].iter().all(|(o, _)| !o.is_empty()));
    assert_eq!(GLEBA_GROUPS, [&[0usize, 1][..], &[2][..]]);
    // Stone is the only resource on Gleba, so nothing else competes with it.
    let resources: Vec<&str> = autoplacers
        .iter()
        .filter(|a| a.get("type").as_str() == "resource")
        .map(|a| a.get("name").as_str())
        .collect();
    assert_eq!(resources, ["stone"]);

    for (k, e) in GLEBA_ENTITIES.iter().enumerate() {
        let a = fact(e.game_name());
        let ours = GLEBA_AUTOPLACERS[k];
        assert_eq!(
            a.get("offGrid").as_bool(),
            ours.positioning == Positioning::OffGrid,
            "{e:?}"
        );
        assert_eq!(
            ours.positioning == Positioning::Resource,
            a.get("type").as_str() == "resource"
        );
        let fixed = |v: &Json| (v.as_f64() * FIXED_ONE as f64) as i64;
        let b = a.get("mapGenBox").as_array();
        let ob = ours.map_gen_box;
        assert_eq!(
            [fixed(&b[0]), fixed(&b[1]), fixed(&b[2]), fixed(&b[3])],
            [ob.left, ob.top, ob.right, ob.bottom],
            "{e:?}"
        );
        assert_eq!(a.get("mapGenBox"), a.get("collisionBox"), "{e:?}");
        assert_eq!(a.get("placementDensity").as_f64(), 1.0);
        // Lua writes an empty table as {}; any restriction would be a list.
        assert_eq!(a.get("tileRestriction"), &Json::Obj(Vec::new()), "{e:?}");
        let layers = a
            .get("collisionLayers")
            .as_array()
            .iter()
            .map(|l| layer::by_name(l.as_str()).expect("a known layer"))
            .fold(0, |m, l| m | l);
        assert_eq!(layers, e.layers(), "{e:?}");
    }

    let tiles = fixture.get("tiles");
    for t in TILE_ORDER {
        let layers = tiles
            .get(t.game_name())
            .as_array()
            .iter()
            .map(|l| layer::by_name(l.as_str()).expect("a known layer"))
            .fold(0, |m, l| m | l);
        assert_eq!(layers, tile_layers(t), "{t:?}");
    }
}

/// The game's entities in the fixture whose tile is inside the window, as
/// (name, x * 256, y * 256).
fn game_entities(
    fixture: &Json,
    x: (i64, i64),
    y: (i64, i64),
) -> BTreeSet<(&'static str, i64, i64)> {
    let names: Vec<&'static str> = fixture
        .get("names")
        .as_array()
        .iter()
        .map(|n| {
            GLEBA_ENTITIES
                .iter()
                .find(|e| e.game_name() == n.as_str())
                .unwrap_or_else(|| panic!("unknown entity {}", n.as_str()))
                .game_name()
        })
        .collect();
    fixture
        .get("entities")
        .as_array()
        .iter()
        .map(|e| {
            let e = e.as_array();
            (
                names[e[0].as_f64() as usize],
                e[1].as_f64() as i64,
                e[2].as_f64() as i64,
            )
        })
        .filter(|&(_, ex, ey)| inside(ex, ey, x, y))
        .collect()
}

fn inside(ex: i64, ey: i64, x: (i64, i64), y: (i64, i64)) -> bool {
    let (tx, ty) = (ex.div_euclid(FIXED_ONE), ey.div_euclid(FIXED_ONE));
    (x.0..x.1).contains(&tx) && (y.0..y.1).contains(&ty)
}

/// How a replay differs from the game in a window.
#[derive(Debug, PartialEq, Eq)]
struct ReplayScore {
    matched: usize,
    ours: usize,
    game: usize,
}

/// The two graded windows, chosen for density: 384..511 by 256..383 holds 69
/// iron stromatolites and 138 stone, -384..-257 by -512..-385 holds 52 copper
/// stromatolites and 106 stone.
const WINDOWS: [((i64, i64), (i64, i64)); 2] =
    [((384, 512), (256, 384)), ((-384, -256), (-512, -384))];

/// Replay one window on OUR tiles, corrected or raw, and score it under each
/// apply rule in `rules`. The chunks are the window's plus one ring, applied
/// row-major, as the render does.
fn replay(
    fixture: &Json,
    x: (i64, i64),
    y: (i64, i64),
    corrected: bool,
    rules: &[Apply],
) -> Vec<ReplayScore> {
    let stack = stack();
    let cx = (x.0.div_euclid(32) - 1, (x.1 - 1).div_euclid(32) + 1);
    let cy = (y.0.div_euclid(32) - 1, (y.1 - 1).div_euclid(32) + 1);
    let (ox, oy) = (cx.0 * 32, cy.0 * 32);
    let (w, h) = ((cx.1 - cx.0 + 1) * 32, (cy.1 - cy.0 + 1) * 32);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let tiles: Vec<GlebaTile> = if corrected {
        stack.corrected_tiles(
            (ox as i32, oy as i32),
            (w as u32, h as u32),
            CORRECTION_MARGIN_CHUNKS,
        )
    } else {
        (oy..oy + h)
            .flat_map(|ty| (ox..ox + w).map(move |tx| (tx, ty)))
            .map(|(tx, ty)| stack.tile_at(At::tile(tx as i32, ty as i32)))
            .collect()
    };
    let at = |tx: i64, ty: i64| {
        ((ox..ox + w).contains(&tx) && (oy..oy + h).contains(&ty))
            .then(|| tiles[((ty - oy) * w + (tx - ox)) as usize])
    };
    let queues = queue_chunks(&stack, &at, None, &rows(cx, cy));
    let game = game_entities(fixture, x, y);
    rules
        .iter()
        .map(|&rule| {
            let ours: BTreeSet<(&'static str, i64, i64)> = apply(&queues, rule)
                .iter()
                .map(|p| (p.entity.game_name(), p.x, p.y))
                .filter(|&(_, ex, ey)| inside(ex, ey, x, y))
                .collect();
            ReplayScore {
                matched: game.intersection(&ours).count(),
                ours: ours.len(),
                game: game.len(),
            }
        })
        .collect()
}

/// **The game's per-chunk stream, on our corrected tiles, applied as a real
/// surface applies it, places every stone and stromatolite the game did in
/// both windows, at the same 1/256-tile position, and nothing else.**
///
/// Over the whole 1024 window the same replay scores 5,193 of 5,193 (release
/// build, measured 2026-11-26), and `test/wasmGlebaEntityParity.spec.ts`
/// grades that window through the module. Applying chunks in columns order
/// instead of rows scored the same 5,193 there, so this capture does not tell
/// the two orders apart; rows is what Aquilo measured.
#[test]
fn gleba_entities_replay_the_real_surface() {
    let fixture = load_captured_at(ENTITIES_FIXTURE, "2.1.23");
    let mut scores = Vec::new();
    for (x, y) in WINDOWS {
        let s = replay(&fixture, x, y, true, &[Apply::RealSurface]).remove(0);
        eprintln!("gleba replay {x:?} {y:?}: {s:?}");
        scores.push((s.matched, s.ours, s.game));
    }
    assert_eq!(scores, vec![(209, 209, 209), (158, 158, 158)]);
}

/// The controls: each rule the replay above depends on, removed alone, makes
/// it wrong, so the exact match is not an accident of a lenient comparison.
///
/// - **Touching boxes collide.** Requiring a real overlap keeps stromatolites
///   that only touch one already placed.
/// - **The apply step runs at all.** Without it (the game's map preview) every
///   queued stromatolite is kept: over the whole 1024 window that is 8,631
///   entities against the real 5,193.
/// - **The tiles are corrected.** A stromatolite is a candidate only on
///   wetland, so a moved shore shifts every later draw in its chunk: on the
///   raw argmax (the preview's tiles) the replay goes wrong across both
///   windows. Over the whole window it matched 3,546 of 5,193.
#[test]
fn gleba_entity_replay_controls() {
    let fixture = load_captured_at(ENTITIES_FIXTURE, "2.1.23");
    let mut got = Vec::new();
    for (x, y) in WINDOWS {
        let corrected = replay(
            &fixture,
            x,
            y,
            true,
            &[Apply::StrictOverlap, Apply::Preview],
        );
        let raw = replay(&fixture, x, y, false, &[Apply::RealSurface]);
        for s in corrected.iter().chain(&raw) {
            eprintln!("gleba control {x:?} {y:?}: {s:?}");
            got.push((s.matched, s.ours));
        }
    }
    // (matched, placed) for strict overlap, the preview and raw tiles, in
    // the first window and then the second. The real surface is (209, 209)
    // and (158, 158).
    assert_eq!(
        got,
        vec![
            (207, 214),
            (209, 279),
            (168, 214),
            (156, 161),
            (158, 208),
            (116, 154)
        ],
        "re-measure: these are frozen counts"
    );
}
