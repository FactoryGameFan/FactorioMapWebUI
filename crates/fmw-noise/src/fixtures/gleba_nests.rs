//! Gleba's pentapod nests (#454, slice 6) against a REAL surface: the nest
//! fields at tier 1, then every entity of the planet replayed through the
//! per-chunk generator, `applyCliffs` and the entity apply step.
//!
//! Ground truth is `oracle-gleba-real-surface-nests.seed123456.json`
//! (`FMW_ARM=nests scripts/probes/gleba-entities`): the surface over
//! -512..511 at map seed 123456 with every control at its default, the map a
//! player gets.
//!
//! A child of `fixtures` so it can use that module's loaders.

use super::{count_exact_bits, load_captured_at};
use crate::at::At;
use crate::eval::math::{clamp, f32r};
use crate::expressions::gleba_nests::{nest_probabilities, GlebaEnemyControls};
use crate::expressions::gleba_resources::{GlebaStoneControls, ResourceInputs};
use crate::expressions::gleba_stack::{GlebaCtx, GlebaStack};
use crate::expressions::gleba_terrain::GlebaControls;
use crate::placement::gleba::Apply;
use crate::test_json::Json;

/// The nests arm: every control at its default.
pub(super) const NESTS_FIXTURE: &str =
    "test/fixtures/oracle-gleba-real-surface-nests.seed123456.json";

/// `123456 + crc32("gleba")`.
const SEED: u32 = 3_215_206_427;

/// The graph at the fixture's levers: every control at its default.
pub(super) fn nests_stack() -> GlebaStack {
    GlebaStack::with_enemies(
        &GlebaCtx {
            seed0: SEED,
            controls: GlebaControls::default(),
        },
        &GlebaStoneControls::default(),
        1.0,
        &GlebaEnemyControls::default(),
    )
}

/// The fixture's f32 bits of `name` at position `i`, widened.
fn want(fields: &Json, name: &str, i: usize) -> f64 {
    let bits = u32::from_str_radix(fields.get(name).as_array()[i].as_str(), 16).expect("hex");
    f64::from(f32::from_bits(bits))
}

/// The nest fields against `calculate_tile_properties`: an exact f32 count
/// per field at 1,280 positions (512 anywhere, then 256 each where
/// `enemy_base_probability` and the two nest probabilities are above 0).
///
/// `enemy_base_probability` is the Nauvis field with Gleba's doubled
/// frequency (`expressions::gleba_nests`). The two nest probabilities read
/// `random_penalty`, whose batch `calculate_tile_properties` forms in a way
/// nobody has measured, so they are graded only where the penalty cannot
/// change the value: where its source is `<= 0` (it passes through) or at
/// least 0.13 (the penalty takes at most 0.1, so `min(0.02, ...)` stays 0.02).
/// The other positions are counted and printed, not graded: the real-surface
/// replay is what grades the penalty's batch.
#[test]
fn gleba_nest_fields_match_the_game() {
    let fixture = load_captured_at(NESTS_FIXTURE, "2.1.23");
    assert_eq!(fixture.get("surfaceSeed").as_f64(), f64::from(SEED));
    let positions = fixture.get("positions").as_array();
    assert_eq!(positions.len(), 1280);
    let stack = nests_stack();
    let nests = stack.nests();
    let xy: Vec<(f64, f64)> = positions
        .iter()
        .map(|p| {
            let a = p.as_array();
            (a[0].as_f64(), a[1].as_f64())
        })
        .collect();
    let inputs: Vec<_> = xy
        .iter()
        .map(|&(x, y)| {
            let at = At::point(x, y);
            stack.nest_inputs(at, &ResourceInputs::from(&stack.eval_at(at)))
        })
        .collect();
    let fields = fixture.get("fields");
    let mut counts = Vec::new();
    let mut grade = |name: &str, got: Vec<f64>| {
        let n = count_exact_bits(&got, fields.get(name).as_array());
        eprintln!("gleba {name}: {n}");
        counts.push(n);
    };
    grade("distance", inputs.iter().map(|t| t.distance).collect());
    // The three scalars `enemy_base_probability` reads, f32 per step.
    let intensity: Vec<f64> = inputs
        .iter()
        .map(|t| f32r(clamp(t.distance, 0.0, 2400.0) / 325.0))
        .collect();
    grade("enemy_base_intensity", intensity.clone());
    grade(
        "enemy_base_radius",
        intensity
            .iter()
            .map(|i| f32r(1.0 * f32r(15.0 + f32r(4.0 * i))))
            .collect(),
    );
    grade(
        "enemy_base_frequency",
        intensity
            .iter()
            .map(|i| f32r(f32r(f32r(0.00002) + f32r(f32r(0.000_006) * i)) * 1.0))
            .collect(),
    );
    let ebp: Vec<f64> = xy
        .iter()
        .map(|&(x, y)| nests.enemy_base_probability(x, y))
        .collect();
    grade("enemy_base_probability", ebp.clone());
    // The field bottoms out near -1000, where one f32 ULP is wider than any
    // residual, so a position no cone reaches is exact for free. Freeze the
    // live bucket beside the headline: where the game's value is above -100.
    let live: Vec<usize> = (0..xy.len())
        .filter(|&i| want(fields, "enemy_base_probability", i) > -100.0)
        .collect();
    let live_exact = live
        .iter()
        .filter(|&&i| ebp[i].to_bits() == want(fields, "enemy_base_probability", i).to_bits())
        .count();
    eprintln!(
        "gleba enemy_base_probability, live bucket: {live_exact} of {}",
        live.len()
    );
    assert_eq!(
        (live_exact, live.len()),
        (1130, 1130),
        "re-measure: frozen counts"
    );
    grade("starting_area_radius", vec![150.0; xy.len()]);
    grade(
        "gleba_starting_enemies",
        inputs.iter().map(|t| t.starting_enemies).collect(),
    );
    grade(
        "gleba_starting_enemies_safe",
        inputs.iter().map(|t| t.starting_enemies_safe).collect(),
    );
    grade(
        "gleba_fertile_spots_coastal",
        inputs.iter().map(|t| t.fertile_spots_coastal).collect(),
    );
    grade(
        "gleba_biome_mask_green",
        inputs
            .iter()
            .map(|t| if t.aux > f32r(0.375) { 1.0 } else { 0.0 })
            .collect(),
    );
    grade(
        "gleba_above_deep_water_mask",
        inputs
            .iter()
            .map(|t| if t.elevation > -10.0 { 1.0 } else { 0.0 })
            .collect(),
    );
    assert_eq!(counts, vec![1280; 11]);

    // The nest probabilities, where the penalty cannot matter.
    let mut graded = 0;
    let mut exact = [0usize; 4];
    let mut skipped = 0;
    let mut positive = [0usize; 2];
    for (i, t) in inputs.iter().enumerate() {
        let source = nests.penalty_source(xy[i].0, xy[i].1);
        if source > 0.0 && source < 0.13 {
            skipped += 1;
            continue;
        }
        graded += 1;
        // Passed through, or saturated: either way `min(0.02, ...)` is fixed.
        let penalised = if source <= 0.0 { source } else { 0.25 };
        let p = nest_probabilities(penalised, t);
        positive[0] += usize::from(p.spawner > 0.0);
        positive[1] += usize::from(p.spawner_small > 0.0);
        for (k, (name, got)) in [
            ("gleba_spawner", p.spawner),
            ("gleba_spawner_small", p.spawner_small),
            ("entity:gleba-spawner:probability", p.spawner),
            ("entity:gleba-spawner-small:probability", p.spawner_small),
        ]
        .into_iter()
        .enumerate()
        {
            if got.to_bits() == want(fields, name, i).to_bits() {
                exact[k] += 1;
            }
        }
    }
    eprintln!(
        "gleba nest probabilities: {exact:?} of {graded}, {skipped} not graded, positive {positive:?}"
    );
    assert_eq!(exact, [graded; 4]);
    // Non-vacuity: the graded set holds positive values of both, and most of
    // the positions.
    assert_eq!((graded, skipped), (1131, 149), "re-measure: frozen counts");
    assert_eq!(positive, [551, 649], "re-measure: frozen counts");
}

/// One window's score, each (matched, ours, game): the cliffs by position and
/// orientation, the nests and every other entity by name and position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NestScore {
    pub(super) cliffs: (usize, usize, usize),
    pub(super) nests: (usize, usize, usize),
    pub(super) others: (usize, usize, usize),
}

/// Replay one window of `fixture` as the render does: its chunks plus one
/// ring of entities and cliffs, the corrected tiles three rings out, stone
/// over both, then `applyCliffs` and the entity apply step.
pub(super) fn score_nests(
    stack: &GlebaStack,
    fixture: &Json,
    (x, y): ((i64, i64), (i64, i64)),
    cliffs_on: bool,
    groups: Option<&[&[usize]]>,
    rule: crate::placement::gleba::Apply,
) -> NestScore {
    use super::gleba_cliffs::Tiles;
    use crate::cliffs::catalog::CLIFF_ORIENTATION_NAMES;
    use crate::placement::gleba::{
        apply_with, columns, queue_chunks, queue_chunks_grouped, Obstacles,
    };
    use crate::placement::gleba_cliffs::{
        gleba_cliffs, stone_tiles, GlebaCliffControls, GlebaCliffObstacles,
    };
    use std::collections::BTreeSet;

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
    let cliffs = if cliffs_on {
        gleba_cliffs(
            stack,
            SEED,
            &GlebaCliffControls::default(),
            &at,
            &stones,
            ecx,
            ecy,
        )
    } else {
        Vec::new()
    };
    let chunks = columns(ecx, ecy);
    let queues = match groups {
        Some(g) => queue_chunks_grouped(stack, &at, None, &chunks, g),
        None => queue_chunks(stack, &at, None, &chunks),
    };
    let obstacles = GlebaCliffObstacles::new(&cliffs);
    let inside = |ex: i64, ey: i64| {
        (x.0..x.1).contains(&ex.div_euclid(256)) && (y.0..y.1).contains(&ey.div_euclid(256))
    };
    let placed = apply_with(&queues, &chunks, rule, Some(&obstacles as &dyn Obstacles));
    let mut ours_nests = BTreeSet::new();
    let mut ours_others = BTreeSet::new();
    for p in &placed {
        if !inside(p.x, p.y) {
            continue;
        }
        let k = (p.entity.game_name().to_string(), p.x, p.y);
        if p.entity.is_nest() {
            ours_nests.insert(k);
        } else {
            ours_others.insert(k);
        }
    }
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
    let (mut game_nests, mut game_others, mut game_cliffs) =
        (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
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
        } else if n.starts_with("gleba-spawner") {
            game_nests.insert((n.to_string(), ex, ey));
        } else {
            game_others.insert((n.to_string(), ex, ey));
        }
    }
    let our_cliffs: BTreeSet<(i64, i64, u8)> = cliffs
        .iter()
        .map(|c| ((c.x * 256.0) as i64, (c.y * 256.0) as i64, c.orientation))
        .filter(|&(cx, cy, _)| inside(cx, cy))
        .collect();
    fn score<T: Ord>(o: &BTreeSet<T>, g: &BTreeSet<T>) -> (usize, usize, usize) {
        (o.intersection(g).count(), o.len(), g.len())
    }
    if std::env::var_os("FMW_NEST_DIFF").is_some() {
        for d in ours_nests.symmetric_difference(&game_nests) {
            let side = if game_nests.contains(d) {
                "game"
            } else {
                "ours"
            };
            eprintln!(
                "  nest {side}: {} ({}, {})",
                d.0,
                d.1 as f64 / 256.0,
                d.2 as f64 / 256.0
            );
        }
        for d in ours_others.symmetric_difference(&game_others) {
            let side = if game_others.contains(d) {
                "game"
            } else {
                "ours"
            };
            eprintln!(
                "  entity {side}: {} ({}, {})",
                d.0,
                d.1 as f64 / 256.0,
                d.2 as f64 / 256.0
            );
        }
    }
    NestScore {
        cliffs: score(&our_cliffs, &game_cliffs),
        nests: score(&ours_nests, &game_nests),
        others: score(&ours_others, &game_others),
    }
}

/// The graded windows: the small nest at (-289.1875, 19.5) whose map-gen
/// box, but not its collision box, meets two copper stromatolites of the
/// next chunk that the game keeps (one nest); six nests near (497, -415),
/// four of them small; and the water-cane at (-111.5625, 289.375) that the
/// small nest of the chunk above takes (two nests).
const WINDOWS: [((i64, i64), (i64, i64)); 3] = [
    ((-384, -256), (0, 128)),
    ((384, 512), (-512, -384)),
    ((-128, 0), (256, 384)),
];

/// **The per-chunk generator, `applyCliffs` and the entity apply step place
/// every nest the game did in all three windows, at the game's position to
/// the 1/256 tile, and nothing else; the cliffs and every other entity stay
/// exact.**
#[test]
fn gleba_nests_replay_the_real_surface() {
    let fixture = load_captured_at(NESTS_FIXTURE, "2.1.23");
    let stack = nests_stack();
    let got: Vec<NestScore> = WINDOWS
        .iter()
        .map(|&w| {
            let s = score_nests(&stack, &fixture, w, true, None, Apply::RealSurface);
            eprintln!("gleba nests replay {w:?}: {s:?}");
            s
        })
        .collect();
    let score = |cliffs, nests, others| NestScore {
        cliffs,
        nests,
        others,
    };
    assert_eq!(
        got,
        vec![
            score((0, 0, 0), (1, 1, 1), (183, 183, 183)),
            score((0, 0, 0), (6, 6, 6), (372, 372, 372)),
            score((58, 58, 58), (2, 2, 2), (1017, 1017, 1017)),
        ],
        "re-measure: these are frozen counts"
    );
}

/// The control: a placed small nest occupying its +-2.35 map-gen box rather
/// than its +-1.35 collision box takes the two copper stromatolites beside
/// the nest in the first window, which the game keeps.
#[test]
fn gleba_nest_replay_controls() {
    let fixture = load_captured_at(NESTS_FIXTURE, "2.1.23");
    let s = score_nests(
        &nests_stack(),
        &fixture,
        WINDOWS[0],
        true,
        None,
        Apply::NestMapGenBox,
    );
    eprintln!("gleba nest control, map-gen box: {s:?}");
    assert_eq!(
        s,
        NestScore {
            cliffs: (0, 0, 0),
            nests: (1, 1, 1),
            others: (181, 181, 183),
        },
        "re-measure: these are frozen counts"
    );
}

/// The whole 1024 window, and the control over it. About 40 s in release;
/// run by hand with `cargo test --release -- --ignored gleba_nests_whole_window`.
#[test]
#[ignore = "a measurement: the whole window is too slow for the gate"]
fn gleba_nests_whole_window() {
    let fixture = load_captured_at(NESTS_FIXTURE, "2.1.23");
    let window = ((-512, 512), (-512, 512));
    let s = score_nests(
        &nests_stack(),
        &fixture,
        window,
        true,
        None,
        Apply::RealSurface,
    );
    eprintln!("gleba nests whole window: {s:?}");
    assert_eq!(
        s,
        NestScore {
            cliffs: (2484, 2484, 2484),
            nests: (67, 67, 67),
            others: (35225, 35225, 35227),
        }
    );
    let c = score_nests(
        &nests_stack(),
        &fixture,
        window,
        true,
        None,
        Apply::NestMapGenBox,
    );
    eprintln!("gleba nests whole window, small nest map-gen box: {c:?}");
}

/// The size-0 question, by hand against a scratch capture made with
/// `FMW_ARM=nests FMW_PLANTS_SIZE=0 FMW_OUT=<file>` (or `FMW_STONE_SIZE=0`;
/// for the enemy control, the committed cliffs arm, which has it at size 0):
/// `FMW_NEST_CHECK=<file> FMW_NEST_ZERO=plants cargo test --release --
/// --ignored gleba_nests_at_a_size_0_control` (or `stone`, or `enemy`).
/// Scores the whole window with that control's groups skipped (the game's
/// rule) and run (a probability of 0 still spends a draw per tile).
#[test]
#[ignore = "a check by hand against a scratch capture"]
fn gleba_nests_at_a_size_0_control() {
    use crate::placement::gleba::{gleba_groups, GLEBA_GROUPS};
    let path = std::env::var("FMW_NEST_CHECK").expect("FMW_NEST_CHECK");
    let zero = std::env::var("FMW_NEST_ZERO").expect("FMW_NEST_ZERO");
    let fixture = crate::test_json::parse(&std::fs::read_to_string(&path).expect("the capture"));
    let (plants, stone, enemy) = match zero.as_str() {
        "plants" => (0.0, 1.0, 1.0),
        "stone" => (1.0, 0.0, 1.0),
        "enemy" => (1.0, 1.0, 0.0),
        _ => panic!("FMW_NEST_ZERO must be plants, stone or enemy"),
    };
    let stack = GlebaStack::with_enemies(
        &GlebaCtx {
            seed0: SEED,
            controls: GlebaControls::default(),
        },
        &GlebaStoneControls {
            size: stone,
            ..GlebaStoneControls::default()
        },
        plants,
        &GlebaEnemyControls {
            size: enemy,
            ..GlebaEnemyControls::default()
        },
    );
    let window = ((-512, 512), (-512, 512));
    let rule = gleba_groups(plants > 0.0, enemy > 0.0);
    // That control's groups alone left out, whatever the rule says.
    let skipped: Vec<&[usize]> = GLEBA_GROUPS
        .iter()
        .copied()
        .filter(|g| {
            let e = crate::placement::gleba::GLEBA_ENTITIES[g[0]];
            match zero.as_str() {
                "plants" => !e.is_plant(),
                "stone" => e != crate::placement::gleba::GlebaEntity::Stone,
                _ => !e.is_nest(),
            }
        })
        .collect();
    for (label, groups) in [
        ("the shipped rule", &rule[..]),
        ("all groups run", &GLEBA_GROUPS[..]),
        ("its groups skipped", &skipped[..]),
    ] {
        let s = score_nests(
            &stack,
            &fixture,
            window,
            true,
            Some(groups),
            Apply::RealSurface,
        );
        eprintln!("{zero} at size 0, {label}: {s:?}");
    }
}
