//! Gleba's twelve plants (#454, slice 4) against a REAL surface: the plant
//! fields at tier 1, the autoplacer facts the generator relies on, and every
//! plant, stromatolite and stone replayed through the game's per-chunk
//! generator and its apply step.
//!
//! Ground truth is `oracle-gleba-real-surface-plants.seed123456.json`
//! (`FMW_ARM=plants scripts/probes/gleba-entities`): every stone,
//! stromatolite and plant on a generated surface over -512..511 at map seed
//! 123456, with pentapod nests and cliffs off and everything else at its
//! default.
//!
//! A child of `fixtures` so it can use that module's loaders.

use super::gleba_entities::{game_entities, inside};
use super::{count_exact_bits, load_captured_at};
use crate::at::At;
use crate::expressions::gleba_nests::GlebaEnemyControls;
use crate::expressions::gleba_plants::{GlebaPlantFields, PLANTS};
use crate::expressions::gleba_resources::{GlebaStoneControls, ResourceInputs};
use crate::expressions::gleba_stack::{GlebaCtx, GlebaStack, CORRECTION_MARGIN_CHUNKS};
use crate::expressions::gleba_terrain::GlebaControls;
use crate::placement::gleba::{apply, columns, queue_chunks, Apply, GLEBA_ENTITIES};
use crate::test_json::Json;
use std::collections::{BTreeMap, BTreeSet};

/// The plants arm: plants, stone and stromatolites on a real surface.
pub(super) const PLANTS_FIXTURE: &str =
    "test/fixtures/oracle-gleba-real-surface-plants.seed123456.json";

/// `123456 + crc32("gleba")`.
const SEED: u32 = 3_215_206_427;

/// The graph at the fixture's levers: every control at its default.
pub(super) fn plants_stack() -> GlebaStack {
    GlebaStack::with_enemies(
        &GlebaCtx {
            seed0: SEED,
            controls: GlebaControls::default(),
        },
        &GlebaStoneControls::default(),
        1.0,
        &GlebaEnemyControls::off(),
    )
}

/// The plant fields against `calculate_tile_properties` on the real surface:
/// an exact f32 count per field, every one of 2,048 positions.
///
/// The pool is weighted to where the fields are not flat: 512 positions
/// anywhere, then 128 where each plant's probability is above 0. Only the
/// point kernel is graded here; the grid kernel the generator reads is graded
/// by the placement replay.
#[test]
fn gleba_plant_fields_match_the_game() {
    let fixture = load_captured_at(PLANTS_FIXTURE, "2.1.23");
    assert_eq!(fixture.get("surfaceSeed").as_f64(), f64::from(SEED));
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 2048);
    let stack = plants_stack();
    let ours: Vec<GlebaPlantFields> = positions
        .iter()
        .map(|p| {
            let xy = p.as_array();
            let at = At::point(xy[0].as_f64(), xy[1].as_f64());
            stack.plants_from(at, &ResourceInputs::from(&stack.eval_at(at)))
        })
        .collect();
    let terrain: Vec<ResourceInputs> = positions
        .iter()
        .map(|p| {
            let xy = p.as_array();
            ResourceInputs::from(&stack.eval_at(At::point(xy[0].as_f64(), xy[1].as_f64())))
        })
        .collect();
    let fields = fixture.get("fields");
    let mut counts = Vec::new();
    let mut grade = |name: &str, got: Vec<f64>| {
        let n = count_exact_bits(&got, fields.get(name).as_array());
        eprintln!("gleba {name}: {n}");
        counts.push(n);
    };
    grade(
        "gleba_plants_noise",
        terrain.iter().map(|t| t.plants_noise).collect(),
    );
    grade(
        "gleba_plants_noise_b",
        terrain.iter().map(|t| t.plants_noise_b).collect(),
    );
    grade(
        "gleba_decal_noise",
        ours.iter().map(|f| f.decal_noise).collect(),
    );
    grade(
        "gleba_water_plant_ramp",
        ours.iter().map(|f| f.water_plant_ramp).collect(),
    );
    grade(
        "gleba_funnel_trunk_region",
        ours.iter().map(|f| f.funnel_trunk_region).collect(),
    );
    grade(
        "gleba_boompuff_region",
        ours.iter().map(|f| f.boompuff_region).collect(),
    );
    grade(
        "gleba_teflilly_region",
        ours.iter().map(|f| f.teflilly_region).collect(),
    );
    for (k, plant) in PLANTS.iter().enumerate() {
        grade(
            &format!("entity:{plant}:probability"),
            ours.iter().map(|f| f.probability[k]).collect(),
        );
    }
    // Non-vacuity: each probability takes a positive value at least at its
    // own 128 positions, and is not positive everywhere.
    for (k, plant) in PLANTS.iter().enumerate() {
        let positive = ours.iter().filter(|f| f.probability[k] > 0.0).count();
        assert!((128..2048).contains(&positive), "{plant}: {positive}");
    }
    assert_eq!(counts, vec![2048; 19]);
}

/// Per-name (matched, ours, game) over one window of the plants fixture:
/// the window's chunks plus one ring, on our corrected tiles, applied
/// in columns order under `rule`, as the render does.
fn score_by_name(
    stack: &GlebaStack,
    fixture: &Json,
    x: (i64, i64),
    y: (i64, i64),
    rule: Apply,
) -> BTreeMap<&'static str, (usize, usize, usize)> {
    let cx = (x.0.div_euclid(32) - 1, (x.1 - 1).div_euclid(32) + 1);
    let cy = (y.0.div_euclid(32) - 1, (y.1 - 1).div_euclid(32) + 1);
    let (ox, oy) = (cx.0 * 32, cy.0 * 32);
    let (w, h) = ((cx.1 - cx.0 + 1) * 32, (cy.1 - cy.0 + 1) * 32);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let tiles = stack.corrected_tiles(
        (ox as i32, oy as i32),
        (w as u32, h as u32),
        CORRECTION_MARGIN_CHUNKS,
    );
    let at = |tx: i64, ty: i64| {
        ((ox..ox + w).contains(&tx) && (oy..oy + h).contains(&ty))
            .then(|| tiles[((ty - oy) * w + (tx - ox)) as usize])
    };
    let queues = queue_chunks(stack, &at, None, &columns(cx, cy));
    let game = game_entities(fixture, x, y);
    let ours: BTreeSet<(&'static str, i64, i64)> = apply(&queues, rule)
        .iter()
        .map(|p| (p.entity.game_name(), p.x, p.y))
        .filter(|&(_, ex, ey)| inside(ex, ey, x, y))
        .collect();
    GLEBA_ENTITIES
        .iter()
        .map(|e| {
            let n = e.game_name();
            let g: BTreeSet<_> = game.iter().filter(|t| t.0 == n).collect();
            let o: BTreeSet<_> = ours.iter().filter(|t| t.0 == n).collect();
            (n, (g.intersection(&o).count(), o.len(), g.len()))
        })
        .collect()
}

/// (matched, ours, game) summed over every name.
fn total(s: &BTreeMap<&'static str, (usize, usize, usize)>) -> (usize, usize, usize) {
    s.values()
        .fold((0, 0, 0), |a, v| (a.0 + v.0, a.1 + v.1, a.2 + v.2))
}

/// The three graded windows, chosen so that between them all fifteen
/// entities appear: around spawn, where stone removes 20 plants (465 stone,
/// 149 sunnycomb, 51 boompuff, 45 stingfrond); the water-cane at (134.375,
/// -480.125) that removes a copper stromatolite in the chunk below, beside 16
/// yumako-trees; and a wetland with 93 jellystem, 28 slipstack and 20 lickmaw.
const WINDOWS: [((i64, i64), (i64, i64)); 3] = [
    ((-128, 0), (-64, 64)),
    ((64, 192), (-512, -384)),
    ((-224, -96), (64, 192)),
];

/// **The game's per-chunk stream, on our corrected tiles, applied as a real
/// surface applies it, places every plant, stromatolite and stone the game
/// did in all three windows, at the same 1/256-tile position, and nothing
/// else, except one plant stone's tree-removal roll spared.**
///
/// That one is the sunnycomb at (-44.8125, -27.5), in the spawn window: its
/// box only touches its stones' tiles, its odds of surviving were 0.04, and
/// the game kept it. Over the whole 1024 window the replay scores 35,641 of
/// 35,643 with no extras; the other miss is a stingfrond at (-324.9375,
/// 451.1875) kept against odds of 0.19. On the cliffs arm, a different
/// generation of the same plants, the game removed both of those and kept
/// two others instead, which is why the roll is taken as the expected
/// outcome (`placement::gleba`).
#[test]
fn gleba_plants_replay_the_real_surface() {
    let fixture = load_captured_at(PLANTS_FIXTURE, "2.1.23");
    let stack = plants_stack();
    let mut seen = BTreeSet::new();
    let mut scores = Vec::new();
    for (x, y) in WINDOWS {
        let s = score_by_name(&stack, &fixture, x, y, Apply::RealSurface);
        eprintln!("gleba plants replay {x:?} {y:?}: {:?}", total(&s));
        seen.extend(s.iter().filter(|(_, v)| v.2 > 0).map(|(n, _)| *n));
        scores.push(total(&s));
    }
    // Non-vacuity: every entity this arm places (all but the nests, which
    // it turns off) is graded somewhere.
    assert_eq!(
        seen.len(),
        GLEBA_ENTITIES.iter().filter(|e| !e.is_nest()).count(),
        "{seen:?}"
    );
    assert_eq!(
        scores,
        vec![(740, 740, 741), (567, 567, 567), (876, 876, 876)]
    );
}

/// The controls: each apply rule the replay depends on, changed alone, makes
/// it wrong.
///
/// - **Stone removes plants.** Without `tree_removal_probability` the spawn
///   window keeps 20 plants the game destroyed.
/// - **A plant whose box only touches a stone's tile is searched.** Requiring
///   a real overlap keeps the sunnycomb the game kept by luck here, which
///   scores better on this capture, but the game removed that same plant on
///   the cliffs arm, which no overlap rule can do
///   (`fixtures::gleba_cliffs`).
/// - **The apply step runs at all.** Without it (the game's map preview)
///   every queued entity is kept.
#[test]
fn gleba_plant_replay_controls() {
    let fixture = load_captured_at(PLANTS_FIXTURE, "2.1.23");
    let stack = plants_stack();
    let mut got = Vec::new();
    for rule in [
        Apply::NoTreeRemoval,
        Apply::TreeRemovalOverlap,
        Apply::Preview,
    ] {
        for (x, y) in WINDOWS {
            let t = total(&score_by_name(&stack, &fixture, x, y, rule));
            eprintln!("gleba plants control {rule:?} {x:?} {y:?}: {t:?}");
            got.push((t.0, t.1));
        }
    }
    // (matched, placed) per rule, window by window. The real surface rule
    // scores (740, 740), (567, 567) and (876, 876) of 741, 567 and 876.
    assert_eq!(
        got,
        vec![
            (741, 761),
            (567, 567),
            (876, 876),
            (741, 741),
            (567, 567),
            (876, 876),
            (741, 815),
            (567, 684),
            (876, 1086)
        ],
        "re-measure: these are frozen counts"
    );
}

/// Stone and the stromatolites with the plants on: stone stays exact in
/// every window (tree removal never touches it), and the stromatolites with
/// it. With OUR plants off, the second window keeps one copper stromatolite
/// too many: the one at (134.5, -479.625) that the water-cane at (134.375,
/// -480.125), in the chunk above and so applied first, blocks in the game.
#[test]
fn gleba_plants_keep_stone_exact() {
    let fixture = load_captured_at(PLANTS_FIXTURE, "2.1.23");
    let no_plants = GlebaStack::with_enemies(
        &GlebaCtx {
            seed0: SEED,
            controls: GlebaControls::default(),
        },
        &GlebaStoneControls::default(),
        0.0,
        &GlebaEnemyControls::off(),
    );
    let mut got = Vec::new();
    for stack in [plants_stack(), no_plants] {
        for (x, y) in WINDOWS {
            let s = score_by_name(&stack, &fixture, x, y, Apply::RealSurface);
            got.push((s["stone"], s["copper-stromatolite"], s["iron-stromatolite"]));
        }
    }
    assert_eq!(
        got,
        vec![
            ((465, 465, 465), (0, 0, 0), (0, 0, 0)),
            ((0, 0, 0), (74, 74, 74), (0, 0, 0)),
            ((0, 0, 0), (0, 0, 0), (126, 126, 126)),
            // Plants off: the copper stromatolite the water-cane blocks.
            ((465, 465, 465), (0, 0, 0), (0, 0, 0)),
            ((0, 0, 0), (74, 75, 74), (0, 0, 0)),
            ((0, 0, 0), (0, 0, 0), (126, 126, 126)),
        ]
    );
}
