//! Which of the game's two pictures of a map the entity overlays draw.
//!
//! The game has two. Its MAP PREVIEW (the new-game screen) queues every entity
//! the roll accepts and draws them all. A REAL surface runs `apply` after the
//! roll, which drops any entity whose box hits one already placed. The two
//! differ a lot: in `[-512, 512)^2` at map seed 123456 the preview shows 533
//! spawners and a real surface gets 47.
//!
//! The overlays target the REAL surface (decided 2026-11-25). That is why
//! [`PlacementSet`](super::roll::PlacementSet) keeps its collision pass even
//! though the preview has none. These tests hold that choice in place: each
//! overlay's count must sit closer to the real surface than to the preview, in
//! the same window. Dropping the collision pass turns them red (spawners would
//! go from 75 to 568).
//!
//! Ground truth is `oracle-entity-counts-preview-vs-real.2.1.23.json`, from
//! `scripts/probes/real-surface-counts/capture.py`. Counts are summed over the
//! prototypes one overlay draws, because an overlay keeps no per-prototype
//! winner.
//!
//! **No exact counts are frozen here.** These paths call libm (`powf` in
//! `resource_math.rs`, for one), and #327 showed an exact count over a libm
//! call can differ by a few between macOS and Linux. The smallest margin below
//! is 3 tiles (the geyser), and every comparison is a difference of counts in
//! the hundreds or less, so a host drift of one or two cannot flip one.
//!
//! **Not run under `--features poison`.** Poison perturbs every roll, so these
//! counts would move for a reason that says nothing about the choice they
//! guard, and the windows cost several seconds each in a debug build.

use core::cell::RefCell;

use crate::distance_from_nearest_point::Point;
use crate::enemies::field::{EnemyBaseField, EnemyFieldParams};
use crate::enemies::placement::NauvisEnemyPlacement;
use crate::eval::ctx::EvalCtx;
use crate::expressions::fulgora_scrap::ScrapControls;
use crate::expressions::fulgora_shared::FulgoraCtx;
use crate::expressions::fulgora_stack::FulgoraStack;
use crate::expressions::nauvis_stack::{NauvisCtx, NauvisStack};
use crate::expressions::vulcanus_stack::{VulcanusBase, VulcanusStack};
use crate::placement::roll::PlacementSet;
use crate::resources::fulgora_catalog::FulgoraScrapPlacement;
use crate::resources::nauvis_oil::NauvisOilPlacement;
use crate::resources::resource_math::ResourceControlLevers;
use crate::resources::vulcanus_geyser::VulcanusGeyserPlacement;
use crate::rocks::field::{NauvisRockFields, RockFieldParams};
use crate::rocks::nauvis_placement::NauvisRockPlacement;
use crate::rocks::vulcanus_field::VulcanusRockFields;
use crate::rocks::vulcanus_placement::VulcanusRockPlacement;
use crate::test_json::Json;
use crate::tiles::nauvis_catalog::NauvisTileCatalog;

const FIXTURE: &str = "test/fixtures/oracle-entity-counts-preview-vs-real.2.1.23.json";

/// The fixture's case for `planet`, after checking the window and seed.
fn case(fixture: &Json, planet: &str, side: i64, surface_seed: u32) -> Json {
    let case = fixture
        .get("cases")
        .as_array()
        .iter()
        .find(|c| c.get("planet").as_str() == planet)
        .unwrap_or_else(|| panic!("no {planet} case in the fixture"))
        .clone();
    assert_eq!(
        case.get("side").as_f64(),
        side as f64,
        "{planet}: the window changed"
    );
    assert_eq!(
        case.get("surfaceSeed").as_f64(),
        f64::from(surface_seed),
        "{planet}: the surface seed changed"
    );
    case
}

/// `(preview, real)` for the named prototypes, summed.
fn game(case: &Json, names: &[&str]) -> (f64, f64) {
    let sum = |picture: &str| {
        names
            .iter()
            .map(|n| case.get(picture).get(n).as_f64())
            .sum()
    };
    (sum("preview"), sum("real"))
}

/// Tiles `set` places in `[-side/2, side/2)^2`.
fn placed(set: &PlacementSet<'_>, side: i64) -> f64 {
    let h = side / 2;
    let mut n = 0u32;
    for y in -h..h {
        for x in -h..h {
            #[allow(clippy::cast_precision_loss)]
            if set.placed(x as f64, y as f64) {
                n += 1;
            }
        }
    }
    f64::from(n)
}

/// The port's count is closer to the real surface than to the preview.
fn assert_closer_to_real(label: &str, port: f64, (preview, real): (f64, f64)) {
    let (to_real, to_preview) = ((port - real).abs(), (port - preview).abs());
    assert!(
        to_real < to_preview,
        "{label}: the port's {port} is {to_real} from the real surface ({real}) and \
         {to_preview} from the preview ({preview}). The overlays target the REAL surface; \
         see this module's docs before changing that."
    );
}

/// Nauvis, `[-512, 512)^2`, map seed 123456 (Nauvis's surface seed is the map
/// seed).
///
/// Measured 2026-11-25 (preview / real / port, then the port with no collision
/// pass): spawners 533 / 47 / 75 / 568, rocks 1,281 / 810 / 841 / 1,014, crude
/// oil 19 / 13 / 12 / 14.
///
/// Spawners are still 60% over the real surface. That is #16: `apply` tests a
/// candidate against trees and rocks too, and across chunks, and the port
/// tests it against spawners in its own chunk only. The upper bound below
/// holds that gap where it is, so it can shrink but not grow.
#[test]
#[cfg_attr(feature = "poison", ignore = "guards a modelling choice, not an op")]
fn nauvis_overlays_draw_the_real_surface_not_the_preview() {
    const SEED: u32 = 123_456;
    let fixture = crate::test_json::load(FIXTURE);
    let case = case(&fixture, "nauvis", 1024, SEED);

    let ctx = NauvisCtx::defaults(SEED);
    let stack = NauvisStack::new(&ctx);
    let catalog = NauvisTileCatalog::new(SEED);

    let field = EnemyBaseField::new(&EnemyFieldParams::defaults(SEED));
    let enemies = NauvisEnemyPlacement::new(&field, &stack, &catalog);
    let spawners = placed(&enemies.placement_set(), 1024);
    let spawners_game = game(&case, &["biter-spawner", "spitter-spawner"]);
    assert_closer_to_real("spawners", spawners, spawners_game);
    assert!(
        spawners <= 1.7 * spawners_game.1,
        "spawners: {spawners} is more than 1.7x the real surface's {} (#16)",
        spawners_game.1
    );

    let rock_fields = NauvisRockFields::new(&RockFieldParams::defaults(SEED));
    let rocks = NauvisRockPlacement::new(&rock_fields, &stack, &catalog);
    assert_closer_to_real(
        "Nauvis rocks",
        placed(&rocks.placement_set(), 1024),
        game(&case, &["huge-rock", "big-rock", "big-sand-rock"]),
    );

    let oil = NauvisOilPlacement::new(
        SEED,
        ResourceControlLevers::defaults(),
        1.0,
        vec![Point { x: 0.0, y: 0.0 }],
        &stack,
        &catalog,
    );
    assert_closer_to_real(
        "crude oil",
        placed(&oil.placement_set(), 1024),
        game(&case, &["crude-oil"]),
    );
}

/// Vulcanus, `[-128, 128)^2`, surface seed 1249936247 (map seed 123456 plus
/// `crc32("vulcanus")`). The window is small because Vulcanus's fields cost
/// about 15 times Nauvis's per tile in a debug build.
///
/// Measured 2026-11-25 (preview / real / port / port with no collision pass):
/// rocks 618 / 317 / 282 / 475, geysers 22 / 19 / 18 / 21.
#[test]
#[cfg_attr(feature = "poison", ignore = "guards a modelling choice, not an op")]
fn vulcanus_overlays_draw_the_real_surface_not_the_preview() {
    const SURFACE_SEED: u32 = 1_249_936_247;
    let fixture = crate::test_json::load(FIXTURE);
    let case = case(&fixture, "vulcanus", 256, SURFACE_SEED);

    let ctx = EvalCtx::new(SURFACE_SEED);
    let base = VulcanusBase::with_host_trig(&ctx);
    let biomes = base.biomes_with_host_trig();
    let stack = VulcanusStack::with_host_trig(&base, &biomes);

    let fields = VulcanusRockFields::new(&stack, SURFACE_SEED);
    let rocks = VulcanusRockPlacement::new(&fields);
    assert_closer_to_real(
        "Vulcanus rocks",
        placed(&rocks.placement_set(), 256),
        game(
            &case,
            &[
                "huge-volcanic-rock",
                "big-volcanic-rock",
                "huge-volcanic-rock-hot",
                "big-volcanic-rock-hot",
            ],
        ),
    );

    let geyser = VulcanusGeyserPlacement::new(&stack, &ctx.vulcanus_resource_controls);
    assert_closer_to_real(
        "sulfuric-acid geysers",
        placed(&geyser.placement_set(), 256),
        game(&case, &["sulfuric-acid-geyser"]),
    );
}

/// Fulgora, `[-256, 256)^2`, surface seed 2967702466 (map seed 123456 plus
/// `crc32("fulgora")`).
///
/// Measured 2026-11-25: preview 1,675, real 1,664, port 1,602. Scrap's
/// collision box cannot reject anything (`fulgora_catalog.rs`), so the port's
/// count is the same with or without the pass, and the two pictures sit only
/// 11 apart. So this one is a bound against the real surface (3.7% today),
/// not a closer-to test that a fix elsewhere could flip by a hair.
#[test]
#[cfg_attr(feature = "poison", ignore = "guards a modelling choice, not an op")]
fn fulgora_scrap_stays_near_the_real_surface() {
    const SURFACE_SEED: u32 = 2_967_702_466;
    let fixture = crate::test_json::load(FIXTURE);
    let case = case(&fixture, "fulgora", 512, SURFACE_SEED);

    let ctx = FulgoraCtx::new(SURFACE_SEED);
    let controls = ScrapControls::default();
    let stack = RefCell::new(FulgoraStack::with_host_trig(&ctx, &controls));
    let scrap = FulgoraScrapPlacement::new(&stack);
    let port = placed(&scrap.placement_set(), 512);
    let (_, real) = game(&case, &["scrap"]);
    assert!(
        (port - real).abs() / real < 0.05,
        "scrap: the port's {port} is more than 5% from the real surface's {real}"
    );
}
