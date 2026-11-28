//! Gleba's cliffs (#454) against a REAL surface: the cliff fields at tier 1,
//! then every cliff, plant, stromatolite and stone replayed through
//! placement, `applyCliffs` and the entity apply step.
//!
//! Ground truth is `oracle-gleba-real-surface-cliffs.seed123456.json`
//! (`FMW_ARM=cliffs scripts/probes/gleba-entities`): the surface over
//! -512..511 at map seed 123456 with only the pentapod nests off.
//!
//! **The whole 1024 window** (release build, 2026-11-27): 2,484 of 2,484
//! cliffs at the game's position and orientation and nothing else, and
//! 35,228 of 35,230 plants, stromatolites and stone with no extras. The two
//! misses are plants the game kept against stone's tree-removal roll
//! (`placement::gleba`). The gate replays three 128-tile windows.
//!
//! A child of `fixtures` so it can use that module's loaders.

use super::{count_exact_bits, load_captured_at};
use crate::at::At;
use crate::cliffs::catalog::CLIFF_ORIENTATION_NAMES;
use crate::cliffs::gleba_fields::{GlebaCliffFields, GLEBA_CLIFF_RICHNESS};
use crate::cliffs::placement::CliffFields;
use crate::expressions::gleba_resources::GlebaStoneControls;
use crate::expressions::gleba_stack::{GlebaCtx, GlebaStack, CORRECTION_MARGIN_CHUNKS};
use crate::expressions::gleba_terrain::GlebaControls;
use crate::placement::gleba::{apply_with, queue_chunks, rows, Apply, Obstacles};
use crate::placement::gleba_cliffs::{
    gleba_cliffs_with, stone_tiles, GlebaCliffControls, GlebaCliffObstacles, GlebaCliffRules,
};
use crate::test_json::Json;
use crate::tiles::gleba_catalog::GlebaTile;
use std::collections::BTreeSet;

/// The cliffs arm: everything but the nests.
const CLIFFS_FIXTURE: &str = "test/fixtures/oracle-gleba-real-surface-cliffs.seed123456.json";

/// `123456 + crc32("gleba")`.
const SEED: u32 = 3_215_206_427;

/// The graph at the fixture's levers: every control at its default.
fn cliffs_stack() -> GlebaStack {
    GlebaStack::with_levers(
        &GlebaCtx {
            seed0: SEED,
            controls: GlebaControls::default(),
        },
        &GlebaStoneControls::default(),
        1.0,
    )
}

/// The cliff fields against `calculate_tile_properties`: an exact f32 count
/// per field at every one of 768 positions (512 anywhere, 256 where
/// `gleba_rockpools` is above 0). `cliffiness_basic` carries
/// `log2(cliff_richness)` at Gleba's 0.8, the first time the port has run it
/// anywhere but 1.
#[test]
fn gleba_cliff_fields_match_the_game() {
    let fixture = load_captured_at(CLIFFS_FIXTURE, "2.1.23");
    assert_eq!(fixture.get("surfaceSeed").as_f64(), f64::from(SEED));
    assert_eq!(
        fixture.get("cliffSettings").get("richness").as_f64(),
        GLEBA_CLIFF_RICHNESS
    );
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 768);
    let stack = cliffs_stack();
    let cliffs = GlebaCliffFields::new(&stack, SEED, GLEBA_CLIFF_RICHNESS);
    let xy: Vec<(f64, f64)> = positions
        .iter()
        .map(|p| {
            let a = p.as_array();
            (a[0].as_f64(), a[1].as_f64())
        })
        .collect();
    let fields = fixture.get("fields");
    let mut counts = Vec::new();
    let mut grade = |name: &str, got: Vec<f64>| {
        let n = count_exact_bits(&got, fields.get(name).as_array());
        eprintln!("gleba {name}: {n}");
        counts.push(n);
    };
    let terrain: Vec<_> = xy
        .iter()
        .map(|&(x, y)| stack.eval_at(At::point(x, y)))
        .collect();
    grade(
        "gleba_rockpools",
        terrain.iter().map(|t| t.rockpools).collect(),
    );
    grade(
        "cliffiness_basic",
        xy.iter()
            .map(|&(x, y)| cliffs.cliffiness_basic(x, y))
            .collect(),
    );
    let cliffiness: Vec<f64> = xy.iter().map(|&(x, y)| cliffs.cliffiness(x, y)).collect();
    // Non-vacuity: both terms of the max win somewhere in the pool.
    assert!(cliffiness.iter().any(|&c| c == f64::from(0.99f32)));
    assert!(cliffiness.iter().any(|&c| c != f64::from(0.99f32)));
    grade("gleba_cliffiness", cliffiness.clone());
    grade("cliffiness", cliffiness);
    grade(
        "cliff_elevation",
        xy.iter()
            .map(|&(x, y)| cliffs.cliff_elevation(x, y))
            .collect(),
    );
    grade("elevation", terrain.iter().map(|t| t.elevation).collect());
    assert_eq!(counts, vec![768; 6]);
}

/// The corrected tiles of a window's chunks plus `ring_chunks` on each side.
struct Tiles {
    ox: i64,
    oy: i64,
    w: i64,
    h: i64,
    t: Vec<GlebaTile>,
}

impl Tiles {
    fn new(stack: &GlebaStack, x: (i64, i64), y: (i64, i64), ring_chunks: i64) -> Self {
        let cx = (
            x.0.div_euclid(32) - ring_chunks,
            (x.1 - 1).div_euclid(32) + ring_chunks,
        );
        let cy = (
            y.0.div_euclid(32) - ring_chunks,
            (y.1 - 1).div_euclid(32) + ring_chunks,
        );
        let (ox, oy) = (cx.0 * 32, cy.0 * 32);
        let (w, h) = ((cx.1 - cx.0 + 1) * 32, (cy.1 - cy.0 + 1) * 32);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let t = stack.corrected_tiles(
            (ox as i32, oy as i32),
            (w as u32, h as u32),
            CORRECTION_MARGIN_CHUNKS,
        );
        Self { ox, oy, w, h, t }
    }

    fn at(&self, tx: i64, ty: i64) -> Option<GlebaTile> {
        ((self.ox..self.ox + self.w).contains(&tx) && (self.oy..self.oy + self.h).contains(&ty))
            .then(|| self.t[((ty - self.oy) * self.w + (tx - self.ox)) as usize])
    }
}

/// A window's score: (cliffs exact, ours, game) by position and
/// orientation, and (entities matched, ours, game) by name and position.
type Score = ((usize, usize, usize), (usize, usize, usize));

/// Replay one window: its chunks plus one ring of entities, cliffs over the
/// same chunks with tiles one ring further and stone over both, as the
/// render does.
fn score_window(
    stack: &GlebaStack,
    fixture: &Json,
    (x, y): ((i64, i64), (i64, i64)),
    rules: GlebaCliffRules,
    cliffs_block: bool,
) -> Score {
    let ecx = (x.0.div_euclid(32) - 1, (x.1 - 1).div_euclid(32) + 1);
    let ecy = (y.0.div_euclid(32) - 1, (y.1 - 1).div_euclid(32) + 1);
    let tiles = Tiles::new(stack, x, y, 3);
    let at = |tx: i64, ty: i64| tiles.at(tx, ty);
    let stones = stone_tiles(
        stack,
        &at,
        None,
        (ecx.0 - 2, ecx.1 + 2),
        (ecy.0 - 2, ecy.1 + 2),
    );
    let cliffs = gleba_cliffs_with(
        stack,
        SEED,
        &GlebaCliffControls::default(),
        &at,
        &stones,
        (ecx, ecy),
        rules,
    );
    let chunks = rows(ecx, ecy);
    let queues = queue_chunks(stack, &at, None, &chunks);
    let obstacles = GlebaCliffObstacles::new(&cliffs);
    let inside = |ex: i64, ey: i64| {
        (x.0..x.1).contains(&ex.div_euclid(256)) && (y.0..y.1).contains(&ey.div_euclid(256))
    };
    let ours: BTreeSet<(String, i64, i64)> = apply_with(
        &queues,
        &chunks,
        Apply::RealSurface,
        cliffs_block.then_some(&obstacles as &dyn Obstacles),
    )
    .iter()
    .map(|p| (p.entity.game_name().to_string(), p.x, p.y))
    .filter(|(_, ex, ey)| inside(*ex, *ey))
    .collect();

    let names = fixture.get("names").as_array();
    let orientations: Vec<u8> = fixture
        .get("orientations")
        .as_array()
        .iter()
        .map(|o| {
            CLIFF_ORIENTATION_NAMES
                .iter()
                .position(|n| *n == o.as_str())
                .expect("a known orientation") as u8
        })
        .collect();
    let mut game = BTreeSet::new();
    let mut game_cliffs = BTreeSet::new();
    for e in fixture.get("entities").as_array() {
        let e = e.as_array();
        let (n, ex, ey) = (
            names[e[0].as_f64() as usize].as_str(),
            e[1].as_f64() as i64,
            e[2].as_f64() as i64,
        );
        if !inside(ex, ey) {
            continue;
        }
        if n == "cliff-gleba" {
            game_cliffs.insert((ex, ey, orientations[e[3].as_f64() as usize]));
        } else {
            game.insert((n.to_string(), ex, ey));
        }
    }
    let our_cliffs: BTreeSet<(i64, i64, u8)> = cliffs
        .iter()
        .map(|c| ((c.x * 256.0) as i64, (c.y * 256.0) as i64, c.orientation))
        .filter(|&(cx, cy, _)| inside(cx, cy))
        .collect();
    (
        (
            our_cliffs.intersection(&game_cliffs).count(),
            our_cliffs.len(),
            game_cliffs.len(),
        ),
        (ours.intersection(&game).count(), ours.len(), game.len()),
    )
}

/// The three graded windows: around spawn (96 cliffs, where stone removes
/// plants and cliffs), the water-cane window (52 cliffs), and the densest
/// cliff field near the window's north-west (117 cliffs).
const WINDOWS: [((i64, i64), (i64, i64)); 3] = [
    ((-128, 0), (-64, 64)),
    ((64, 192), (-512, -384)),
    ((-384, -256), (-512, -384)),
];

/// **Placement, `applyCliffs` and the entity apply step place every cliff
/// the game did in all three windows, at its position and orientation, and
/// every plant, stromatolite and stone but one, with nothing extra.** The one
/// is the sunnycomb at (-62.75, 0.125) in the spawn window, which the game
/// kept against stone's tree-removal roll at odds of 0.002.
#[test]
fn gleba_cliffs_replay_the_real_surface() {
    let fixture = load_captured_at(CLIFFS_FIXTURE, "2.1.23");
    let stack = cliffs_stack();
    let got: Vec<Score> = WINDOWS
        .iter()
        .map(|&w| {
            let s = score_window(&stack, &fixture, w, GlebaCliffRules::default(), true);
            eprintln!("gleba cliffs replay {w:?}: {s:?}");
            s
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ((96, 96, 96), (717, 717, 718)),
            ((52, 52, 52), (562, 562, 562)),
            ((117, 117, 117), (503, 503, 503)),
        ]
    );
}

/// The controls: each rule the replay depends on, removed alone, makes it
/// wrong.
///
/// - **The tile half of `wouldCollide`.** Without it cliffs stand on wetland
///   and the deep lake.
/// - **Stone removes cliffs.** Without it the cliffs a stone's tile reaches
///   stay.
/// - **Cliffs block entities.** Without it plants stand where the game's
///   cliffs are.
///
/// `updateConnections` is NOT among them: turned off, it changes nothing
/// anywhere in the 1024 window (`gleba_cliffs_whole_window`), because the
/// destroy cascades already trim every end it would. It stays on because it
/// is the game's rule, read from the binary and graded on Vulcanus.
#[test]
fn gleba_cliff_replay_controls() {
    let fixture = load_captured_at(CLIFFS_FIXTURE, "2.1.23");
    let stack = cliffs_stack();
    let game = GlebaCliffRules::default();
    let arms = [
        (
            GlebaCliffRules {
                tile_half: false,
                ..game
            },
            true,
        ),
        (
            GlebaCliffRules {
                stone_removal: false,
                ..game
            },
            true,
        ),
        (game, false),
    ];
    let mut got = Vec::new();
    for (rules, block) in arms {
        for &w in &WINDOWS {
            let s = score_window(&stack, &fixture, w, rules, block);
            eprintln!("gleba cliff control {rules:?} block {block} {w:?}: {s:?}");
            got.push(s);
        }
    }
    assert_eq!(
        got,
        vec![
            // No tile half: cliffs on wetland in the north-west window.
            ((96, 96, 96), (717, 717, 718)),
            ((52, 52, 52), (562, 562, 562)),
            ((115, 121, 117), (500, 500, 503)),
            // No stone removal: cliffs inside the spawn window's stone.
            ((94, 102, 96), (717, 717, 718)),
            ((52, 52, 52), (562, 562, 562)),
            ((117, 117, 117), (503, 503, 503)),
            // Cliffs do not block: plants where the cliffs are.
            ((96, 96, 96), (715, 740, 718)),
            ((52, 52, 52), (561, 567, 562)),
            ((117, 117, 117), (502, 518, 503)),
        ],
        "re-measure: these are frozen counts"
    );
}

/// The whole 1024 window. About 40 s in release; run by hand with
/// `cargo test --release -- --ignored gleba_cliffs_whole_window`.
#[test]
#[ignore = "a measurement: the whole window is too slow for the gate"]
fn gleba_cliffs_whole_window() {
    let fixture = load_captured_at(CLIFFS_FIXTURE, "2.1.23");
    let s = score_window(
        &cliffs_stack(),
        &fixture,
        ((-512, 512), (-512, 512)),
        GlebaCliffRules::default(),
        true,
    );
    eprintln!("gleba cliffs whole window: {s:?}");
    assert_eq!(s, ((2484, 2484, 2484), (35228, 35228, 35230)));
    let game = GlebaCliffRules::default();
    for (label, rules, block) in [
        (
            "no tile half",
            GlebaCliffRules {
                tile_half: false,
                ..game
            },
            true,
        ),
        (
            "no stone removal",
            GlebaCliffRules {
                stone_removal: false,
                ..game
            },
            true,
        ),
        (
            "no connections",
            GlebaCliffRules {
                connections: false,
                ..game
            },
            true,
        ),
        ("cliffs do not block", game, false),
    ] {
        let c = score_window(
            &cliffs_stack(),
            &fixture,
            ((-512, 512), (-512, 512)),
            rules,
            block,
        );
        eprintln!("gleba cliffs whole window, {label}: {c:?}");
    }
}

/// A check by hand of `cliffiness_basic` at a moved continuity slider:
/// `FMW_CLIFF_CHECK=<capture.json> FMW_CLIFF_SIZE=<size> cargo test --release
/// -- --ignored gleba_cliffiness_at_a_moved_slider`, against a scratch
/// capture made with `FMW_ARM=cliffs FMW_CLIFF_SIZE=<size>`.
#[test]
#[ignore = "a check by hand against a scratch capture"]
fn gleba_cliffiness_at_a_moved_slider() {
    use crate::eval::math::f32r;
    let path = std::env::var("FMW_CLIFF_CHECK").expect("FMW_CLIFF_CHECK");
    let size: f64 = std::env::var("FMW_CLIFF_SIZE")
        .expect("FMW_CLIFF_SIZE")
        .parse()
        .expect("a number");
    let text = std::fs::read_to_string(&path).expect("the capture");
    let fixture = crate::test_json::parse(&text);
    let positions = fixture.get("positions").as_array();
    let want = fixture.get("fields").get("cliffiness_basic").as_array();
    let stack = cliffs_stack();
    for (label, richness) in [
        ("0.8 * size", f32r(GLEBA_CLIFF_RICHNESS * size)),
        ("size", size),
        ("0.8", GLEBA_CLIFF_RICHNESS),
    ] {
        let f = GlebaCliffFields::new(&stack, SEED, richness);
        let got: Vec<f64> = positions
            .iter()
            .map(|p| {
                let a = p.as_array();
                f.cliffiness_basic(a[0].as_f64(), a[1].as_f64())
            })
            .collect();
        eprintln!(
            "size {size}, richness {label}: {} of {}",
            count_exact_bits(&got, want),
            want.len()
        );
    }
}
