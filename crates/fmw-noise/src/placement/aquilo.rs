//! Aquilo's wells and icebergs, placed by the game's own per-chunk generator
//! ([`super::generate`]) and drawn by the preview's rule (#492).
//!
//! Aquilo is the first planet where every entity autoplacer is ported, so
//! it is the first that can run the real stream: five prototypes, each its
//! own autoplace `order` group, in the game's sorted order.
//!
//! | group | prototype | `order` | positioning | map-gen box (1/256 tile) |
//! | ---: | --- | --- | --- | --- |
//! | 0 | `fluorine-vent` | `a[resources]-a[fluorine]` | tile centre | +-358 square |
//! | 1 | `lithium-brine` | `a[resources]-b[lithium]` | tile centre | +-358 square |
//! | 2 | `lithium-iceberg-huge` | `a[rock]-a[huge]` | off grid | +-473 by +-320 |
//! | 3 | `lithium-iceberg-big` | `a[rock]-b[big]` | off grid | +-256 by +-192 |
//! | 4 | `crude-oil` | `c` | tile centre | +-358 square |
//!
//! The boxes are each `collision_box` times 256, truncated: 1.4 gives 358,
//! 1.85 gives 473, 1.25 gives 320, 1.0 and 0.75 are exact. None of the five
//! declares a `map_generator_bounding_box`. Truncating or rounding 1.85 and
//! 1.4 gives the same tiles here: positions are multiples of 16 (icebergs) or
//! 128 (wells), and neither box edge can then land on a tile line.
//!
//! ## Where the probabilities are read
//!
//! At each tile's integer corner on the chunk grid ([`tile_at`]), which is
//! where the game's `NoiseCache` puts a chunk's 1,024 positions
//! (`NoiseCache.cpp:59-60`). `aquilo_high_frequency_peaks` is a raw-coordinate
//! noise field, so it takes the grid kernel there. Read at the tile centre on
//! the point kernel instead, 7 of the census's 199 entities fall outside
//! their own probability (`fixtures`).
//!
//! ## Tile masks
//!
//! The wells' `collision_mask` is `{resource}`, and no Aquilo tile carries
//! that layer (`tile_collision_masks.ammoniacal_ocean()` comments it out), so
//! a well is a candidate on every tile and each well group spends 1,024 draws
//! per chunk. The icebergs' mask holds `water_tile`, which both oceans and
//! brash ice carry, so an iceberg is a candidate only on the six land tiles,
//! and its box must cover land only.
//!
//! ## Richness
//!
//! A resource places only where its richness is above 0. Each well's
//! probability is a `max` of terms, and its richness is a `max` of the same
//! fields times positive constants, times the richness slider (Lua at
//! 2.1.23). So a positive probability always comes with a positive richness
//! while the slider is above 0. The engine does not receive the richness
//! slider, and the app's smallest step is 1/6, so this module treats richness
//! as positive. **An imported string with an Aquilo richness of 0 would draw
//! wells the game does not place.**
//!
//! ## Why the preview and a real surface differ
//!
//! The stream reads the tiles, and a real surface runs tile correction where
//! the preview does not. Replayed on our tiles, which are the preview's, the
//! stream reproduces the game's preview PNG. Replayed on the game's
//! real-surface tiles and then applied with entity collision, it reproduces
//! the real surface. `fixtures` pins the second against
//! `oracle-aquilo-surface.seed123456.json`.

use super::generate::{
    generate_chunk, preview_footprint, Autoplacer, ChunkInputs, MapGenBox, Positioning, Queued,
};
use super::roll::{CHUNK, TILES_PER_CHUNK};
use crate::expressions::aquilo_stack::{tile_at, AquiloFields, AquiloStack};
use crate::resources::aquilo_wells::AquiloWell;
use crate::rocks::aquilo_icebergs::{iceberg_probabilities, iceberg_tile_allowed, ICEBERG_COLOR};
use crate::tiles::aquilo_catalog::AquiloTile;
use core::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

/// One of Aquilo's five entity autoplacers, in group order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AquiloEntity {
    FluorineVent,
    LithiumBrine,
    IcebergHuge,
    IcebergBig,
    CrudeOil,
}

/// The groups in the game's sorted order. Index = prototype index.
pub const AQUILO_ENTITIES: [AquiloEntity; 5] = [
    AquiloEntity::FluorineVent,
    AquiloEntity::LithiumBrine,
    AquiloEntity::IcebergHuge,
    AquiloEntity::IcebergBig,
    AquiloEntity::CrudeOil,
];

const WELL_BOX: MapGenBox = MapGenBox::centred(358, 358);

/// The generator's view of the five prototypes, by index.
pub const AQUILO_AUTOPLACERS: [Autoplacer; 5] = [
    Autoplacer {
        positioning: Positioning::Resource,
        map_gen_box: WELL_BOX,
    },
    Autoplacer {
        positioning: Positioning::Resource,
        map_gen_box: WELL_BOX,
    },
    Autoplacer {
        positioning: Positioning::OffGrid,
        map_gen_box: MapGenBox::centred(473, 320),
    },
    Autoplacer {
        positioning: Positioning::OffGrid,
        map_gen_box: MapGenBox::centred(256, 192),
    },
    Autoplacer {
        positioning: Positioning::Resource,
        map_gen_box: WELL_BOX,
    },
];

/// One prototype per group.
pub const AQUILO_GROUPS: [&[usize]; 5] = [&[0], &[1], &[2], &[3], &[4]];

impl AquiloEntity {
    /// The prototype's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::FluorineVent => "fluorine-vent",
            Self::LithiumBrine => "lithium-brine",
            Self::IcebergHuge => "lithium-iceberg-huge",
            Self::IcebergBig => "lithium-iceberg-big",
            Self::CrudeOil => "crude-oil",
        }
    }

    /// The well this is, or `None` for an iceberg.
    #[must_use]
    pub fn well(self) -> Option<AquiloWell> {
        match self {
            Self::FluorineVent => Some(AquiloWell::FluorineVent),
            Self::LithiumBrine => Some(AquiloWell::LithiumBrine),
            Self::CrudeOil => Some(AquiloWell::CrudeOil),
            Self::IcebergHuge | Self::IcebergBig => None,
        }
    }

    /// The colour the preview draws: the well's `map_color`, or the icebergs'
    /// shared one.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        self.well().map_or(ICEBERG_COLOR, AquiloWell::color)
    }

    /// The autoplace probability at a tile's fields, an f32 widened to f64.
    #[must_use]
    pub fn probability(self, f: &AquiloFields) -> f64 {
        match self {
            Self::IcebergHuge => iceberg_probabilities(f.terrain.high_frequency_peaks)[0],
            Self::IcebergBig => iceberg_probabilities(f.terrain.high_frequency_peaks)[1],
            well => well.well().map_or(0.0, |w| w.probability(&f.resources)),
        }
    }

    /// Whether this tile's mask collides with the prototype's. See the module
    /// docs: wells never, icebergs on water.
    #[must_use]
    pub fn blocked_by(self, tile: AquiloTile) -> bool {
        self.well().is_none() && !iceberg_tile_allowed(tile)
    }
}

/// Which entities a view shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AquiloEntityView {
    All,
    Wells,
    Icebergs,
}

impl AquiloEntityView {
    fn shows(self, e: AquiloEntity) -> bool {
        match self {
            Self::All => true,
            Self::Wells => e.well().is_some(),
            Self::Icebergs => e.well().is_none(),
        }
    }
}

/// The generator's inputs over one chunk, read from the stack.
///
/// The chunk's own 1,024 tiles are evaluated once, up front. Tiles outside
/// the chunk are needed only to check an iceberg's box near the edge, and are
/// evaluated on demand.
pub struct AquiloChunkInputs<'a> {
    stack: &'a RefCell<AquiloStack>,
    chunk_x: i64,
    chunk_y: i64,
    own: Vec<AquiloFields>,
    border: BTreeMap<(i64, i64), AquiloTile>,
}

impl<'a> AquiloChunkInputs<'a> {
    #[must_use]
    pub fn new(stack: &'a RefCell<AquiloStack>, chunk_x: i64, chunk_y: i64) -> Self {
        let mut own = Vec::with_capacity(TILES_PER_CHUNK);
        for i in 0..TILES_PER_CHUNK {
            #[allow(clippy::cast_possible_wrap)]
            let (lx, ly) = ((i as i64) & 31, (i as i64) >> 5);
            #[allow(clippy::cast_precision_loss)]
            let at = tile_at((chunk_x * CHUNK + lx) as f64, (chunk_y * CHUNK + ly) as f64);
            own.push(stack.borrow_mut().eval_at(at));
        }
        Self {
            stack,
            chunk_x,
            chunk_y,
            own,
            border: BTreeMap::new(),
        }
    }

    fn own_index(&self, tx: i64, ty: i64) -> Option<usize> {
        let (lx, ly) = (tx - self.chunk_x * CHUNK, ty - self.chunk_y * CHUNK);
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        ((0..CHUNK).contains(&lx) && (0..CHUNK).contains(&ly)).then(|| (ly * CHUNK + lx) as usize)
    }

    fn tile(&mut self, tx: i64, ty: i64) -> AquiloTile {
        if let Some(i) = self.own_index(tx, ty) {
            return self.own[i].tile();
        }
        let stack = self.stack;
        *self.border.entry((tx, ty)).or_insert_with(|| {
            #[allow(clippy::cast_precision_loss)]
            let at = tile_at(tx as f64, ty as f64);
            stack.borrow_mut().eval_at(at).tile()
        })
    }
}

impl ChunkInputs for AquiloChunkInputs<'_> {
    fn probability(&mut self, proto: usize, tx: i64, ty: i64) -> f64 {
        let i = self
            .own_index(tx, ty)
            .expect("the generator asks probabilities only inside its chunk");
        AQUILO_ENTITIES[proto].probability(&self.own[i])
    }

    fn richness_positive(&mut self, _: usize, _: i64, _: i64) -> bool {
        // See the module docs, "Richness".
        true
    }

    fn tile_blocks(&mut self, proto: usize, tx: i64, ty: i64) -> bool {
        let tile = self.tile(tx, ty);
        AQUILO_ENTITIES[proto].blocked_by(tile)
    }
}

/// One chunk's queue and its preview footprint for each view.
struct ChunkPaint {
    queue: Vec<Queued>,
    all: [Option<u16>; TILES_PER_CHUNK],
    wells: [Option<u16>; TILES_PER_CHUNK],
    icebergs: [Option<u16>; TILES_PER_CHUNK],
}

/// Aquilo's entities over a render: one generator run per chunk, cached.
///
/// A pixel's colour depends only on its own chunk, because the preview draws
/// each entity only inside the chunk that generated it. So a tiled render
/// agrees with a whole one with no halo.
pub struct AquiloEntities<'a> {
    stack: &'a RefCell<AquiloStack>,
    cache: RefCell<BTreeMap<(i64, i64), Rc<ChunkPaint>>>,
}

impl<'a> AquiloEntities<'a> {
    #[must_use]
    pub fn new(stack: &'a RefCell<AquiloStack>) -> Self {
        Self {
            stack,
            cache: RefCell::new(BTreeMap::new()),
        }
    }

    fn chunk(&self, chunk_x: i64, chunk_y: i64) -> Rc<ChunkPaint> {
        if let Some(c) = self.cache.borrow().get(&(chunk_x, chunk_y)) {
            return Rc::clone(c);
        }
        let mut inputs = AquiloChunkInputs::new(self.stack, chunk_x, chunk_y);
        let queue = generate_chunk(
            chunk_x,
            chunk_y,
            &AQUILO_GROUPS,
            &AQUILO_AUTOPLACERS,
            &mut inputs,
        );
        let fp = |view: AquiloEntityView| {
            preview_footprint(chunk_x, chunk_y, &queue, &AQUILO_AUTOPLACERS, &|p| {
                view.shows(AQUILO_ENTITIES[p])
            })
        };
        let paint = Rc::new(ChunkPaint {
            all: fp(AquiloEntityView::All),
            wells: fp(AquiloEntityView::Wells),
            icebergs: fp(AquiloEntityView::Icebergs),
            queue,
        });
        self.cache
            .borrow_mut()
            .insert((chunk_x, chunk_y), Rc::clone(&paint));
        paint
    }

    /// The queue the generator built for one chunk, in queue order.
    #[must_use]
    pub fn chunk_queue(&self, chunk_x: i64, chunk_y: i64) -> Vec<(AquiloEntity, i64, i64)> {
        self.chunk(chunk_x, chunk_y)
            .queue
            .iter()
            .map(|q| (AQUILO_ENTITIES[q.proto], q.x, q.y))
            .collect()
    }

    /// The entity the preview draws on the tile containing `(x, y)`, if any.
    #[must_use]
    pub fn drawn_at(&self, x: f64, y: f64, view: AquiloEntityView) -> Option<AquiloEntity> {
        #[allow(clippy::cast_possible_truncation)]
        let (tx, ty) = (x.floor() as i64, y.floor() as i64);
        let c = self.chunk(tx.div_euclid(CHUNK), ty.div_euclid(CHUNK));
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let i = (ty.rem_euclid(CHUNK) * CHUNK + tx.rem_euclid(CHUNK)) as usize;
        let k = match view {
            AquiloEntityView::All => c.all[i],
            AquiloEntityView::Wells => c.wells[i],
            AquiloEntityView::Icebergs => c.icebergs[i],
        }?;
        Some(AQUILO_ENTITIES[c.queue[usize::from(k)].proto])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expressions::aquilo_resources::{AquiloBearings, AquiloResourceControls};
    use crate::expressions::aquilo_stack::AquiloCtx;

    /// Map seed 123456's derived Aquilo surface seed.
    const DERIVED_SEED: u32 = 3_111_923_328;

    fn stack(seed0: u32) -> RefCell<AquiloStack> {
        let ctx = AquiloCtx {
            seed0,
            controls: AquiloResourceControls::default(),
        };
        RefCell::new(AquiloStack::new(&ctx, AquiloBearings::from_host(seed0)))
    }

    #[test]
    fn the_autoplacer_table_is_in_the_games_sorted_order() {
        let order = [
            "a[resources]-a[fluorine]",
            "a[resources]-b[lithium]",
            "a[rock]-a[huge]",
            "a[rock]-b[big]",
            "c",
        ];
        let mut sorted = order;
        sorted.sort_unstable();
        assert_eq!(sorted, order);
        assert_eq!(AQUILO_ENTITIES.len(), AQUILO_AUTOPLACERS.len());
    }

    /// A few wells the game's real surface and its preview agree on, at the
    /// derived seed: the queue must hold them at the tile centre.
    #[test]
    fn the_preview_queue_holds_wells_the_game_placed() {
        let s = stack(DERIVED_SEED);
        let e = AquiloEntities::new(&s);
        let has = |name: &str, x: f64, y: f64| {
            #[allow(clippy::cast_possible_truncation)]
            let (cx, cy) = (
                (x.floor() as i64).div_euclid(32),
                (y.floor() as i64).div_euclid(32),
            );
            e.chunk_queue(cx, cy).iter().any(|&(k, qx, qy)| {
                #[allow(clippy::cast_precision_loss)]
                let at = (qx as f64 / 256.0, qy as f64 / 256.0);
                k.game_name() == name && at == (x, y)
            })
        };
        // Census entries (oracle-aquilo-entities) the preview also shows.
        assert!(has("lithium-brine", -46.5, 73.5));
        assert!(has("fluorine-vent", -40.5, -67.5));
        assert!(has("crude-oil", 37.5, 10.5));
    }

    /// The tiny vent's centre, `(80 sin a, -80 cos a)` with the cone's own
    /// f32 products, as `starting_spot_at_angle` forms it.
    fn tiny_vent_centre(seed0: u32) -> (f64, f64) {
        let trig = AquiloBearings::from_host(seed0).fluorine_vent;
        (
            f64::from((80.0 * trig.sin) as f32),
            f64::from((-80.0 * trig.cos) as f32),
        )
    }

    /// The vents the generator queues within 2 tiles of the tiny vent's
    /// centre, over every chunk those tiles touch.
    fn vents_near(e: &AquiloEntities<'_>, centre: (f64, f64)) -> Vec<(f64, f64)> {
        #[allow(clippy::cast_possible_truncation)]
        let (rx, ry) = (centre.0.round() as i64, centre.1.round() as i64);
        let mut chunks: Vec<(i64, i64)> = (-2..=2)
            .flat_map(|d| {
                [
                    ((rx + d).div_euclid(32), (ry - 2).div_euclid(32)),
                    ((rx + d).div_euclid(32), (ry + 2).div_euclid(32)),
                ]
            })
            .collect();
        chunks.sort_unstable();
        chunks.dedup();
        let mut out = Vec::new();
        for (cx, cy) in chunks {
            for (k, x, y) in e.chunk_queue(cx, cy) {
                #[allow(clippy::cast_precision_loss)]
                let at = (x as f64 / 256.0, y as f64 / 256.0);
                if k == AquiloEntity::FluorineVent
                    && (at.0 - centre.0).abs() <= 2.5
                    && (at.1 - centre.1).abs() <= 2.5
                {
                    out.push(at);
                }
            }
        }
        out
    }

    /// At least one vent near spawn on every seed while the fluorine slider is
    /// above 0, on a corner inside the unit disk: probability 1 always passes
    /// its roll, and a well's box never meets a blocking tile on Aquilo.
    #[test]
    fn the_tiny_vent_is_queued_on_every_seed() {
        for seed in [123_456_u32, 1, 4_000_000_000, DERIVED_SEED, 64_424_508] {
            let centre = tiny_vent_centre(seed);
            let s = stack(seed);
            let e = AquiloEntities::new(&s);
            let vents = vents_near(&e, centre);
            assert!(!vents.is_empty(), "seed {seed}");
            for (x, y) in &vents {
                let d = (x - 0.5 - centre.0).hypot(y - 0.5 - centre.1);
                assert!(
                    d < 1.0,
                    "seed {seed}: corner of ({x}, {y}) is {d} from the centre"
                );
            }
        }
    }

    /// At fluorine size 0 the probability is gated to 0, so the tiny vent goes
    /// too. The control for the test above: the same tiles, one lever moved.
    #[test]
    fn a_zero_fluorine_size_removes_the_tiny_vent() {
        let seed = 123_456;
        let mut controls = AquiloResourceControls::default();
        controls.fluorine_vent.size = 0.0;
        let s = RefCell::new(AquiloStack::new(
            &AquiloCtx {
                seed0: seed,
                controls,
            },
            AquiloBearings::from_host(seed),
        ));
        let e = AquiloEntities::new(&s);
        assert_eq!(vents_near(&e, tiny_vent_centre(seed)), vec![]);
    }

    #[test]
    fn a_pixel_depends_only_on_its_own_chunk() {
        // A fresh cache asked one tile computes exactly one chunk.
        let s = stack(DERIVED_SEED);
        let e = AquiloEntities::new(&s);
        let _ = e.drawn_at(5.5, -3.5, AquiloEntityView::All);
        assert_eq!(
            e.cache.borrow().keys().copied().collect::<Vec<_>>(),
            vec![(0, -1)]
        );
    }
}
