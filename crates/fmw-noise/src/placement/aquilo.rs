//! Aquilo's wells and icebergs, placed as a REAL surface places them (#553):
//! the game's own per-chunk generator ([`super::generate`], #492) on the
//! corrected tiles, then the apply step's entity-against-entity collision,
//! which the game's map preview skips.
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
//! per chunk. The icebergs' mask is `{item, object, player, water_tile}`, and
//! both oceans and brash ice carry `water_tile`, so an iceberg is a candidate
//! only on the six land tiles, and its box must cover land only.
//!
//! **The stream reads the CORRECTED tiles.** A real surface runs tile
//! correction before the entity stage, and every iceberg candidate on land
//! spends a draw, so the shore decides where every later draw lands. On the
//! raw argmax (the preview's tiles) the replay of the 640 surface places 222
//! entities, only 86 of them among the game's 209; on the corrected tiles it
//! places exactly the game's 209 (`fixtures`).
//!
//! ## Apply
//!
//! A real surface applies each chunk's queue in queue order, dropping an
//! entity whose map-gen box meets an already placed one on a shared collision
//! layer (`EntityMapGenerationTask::apply`, see
//! `docs/noise/entity-generation-NOTES.md`). Boxes that only touch collide,
//! and chunks apply row-major; both were measured here first (#492). The two
//! masks share no layer, so a well never blocks an iceberg, or the other way
//! round: wells block wells and icebergs block icebergs.
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
//! ## What the wells do to the tiles, and why it is not drawn
//!
//! Each well's `created_effect` spawns two explosions whose `set-tile`
//! effects turn the water near it into snow and ice. The outer one is a
//! `cluster` of seven at a random distance, drawn from the surface's own
//! random generator, which a tile of the preview cannot know (the same reason
//! Gleba's stone takes the expected outcome of its tree-removal roll; read
//! from the Lua, not traced). The terrain is drawn without it: over the
//! default window it rewrites 2,756 tiles, 2,120 outside every well's 3 x 3
//! footprint, up to 5 tiles from a well. It moves no entity: the entity list is the same with the effect removed
//! (`oracle-aquilo-entities`, `scripts/probes/aquilo-real-surface-entities`).

use super::generate::FIXED_ONE;
use super::generate::{generate_chunk, Autoplacer, ChunkInputs, MapGenBox, Positioning, Queued};
use super::roll::{CHUNK, TILES_PER_CHUNK};
use crate::expressions::aquilo_stack::{tile_at, AquiloFields, AquiloStack, KeptFields};
use crate::resources::aquilo_wells::AquiloWell;
use crate::rocks::aquilo_icebergs::{iceberg_probabilities, iceberg_tile_allowed, ICEBERG_COLOR};
use crate::tiles::aquilo_catalog::AquiloTile;
use core::cell::RefCell;
use std::collections::BTreeMap;

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

/// The farthest any box reaches from its position, on either axis, in 1/256
/// tile: the huge iceberg's 473. The apply step searches this far past a new
/// box for entities that might meet it.
const MAX_REACH: i64 = 473;

/// Collision layers as bits: only the ones these five prototypes carry.
pub mod layer {
    pub const RESOURCE: u32 = 1 << 0;
    pub const ITEM: u32 = 1 << 1;
    pub const OBJECT: u32 = 1 << 2;
    pub const PLAYER: u32 = 1 << 3;
    pub const WATER_TILE: u32 = 1 << 4;
}

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

    /// The colour a map draws: the well's `map_color`, or the icebergs'
    /// shared one.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        self.well().map_or(ICEBERG_COLOR, AquiloWell::color)
    }

    /// The prototype's collision layers: a resource's default `{resource}`
    /// for the wells (`resources.lua` sets no mask of its own), and
    /// `decoratives-aquilo.lua`'s `{item, object, player, water_tile}` for
    /// both icebergs (read at 2.1.23).
    #[must_use]
    pub fn layers(self) -> u32 {
        use layer::{ITEM, OBJECT, PLAYER, RESOURCE, WATER_TILE};
        if self.well().is_some() {
            RESOURCE
        } else {
            ITEM | OBJECT | PLAYER | WATER_TILE
        }
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
    /// Whether the view draws this entity.
    #[must_use]
    pub fn shows(self, e: AquiloEntity) -> bool {
        match self {
            Self::All => true,
            Self::Wells => e.well().is_some(),
            Self::Icebergs => e.well().is_none(),
        }
    }
}

/// The tiles the generator may look at, by world tile. `None` is a tile the
/// caller did not compute; it blocks every iceberg, so a box that reaches
/// past the computed area is refused rather than placed on a guess. A well
/// never asks.
pub type AquiloTiles<'a> = &'a dyn Fn(i64, i64) -> Option<AquiloTile>;

/// The generator's inputs over one chunk.
///
/// The chunk's own 1,024 fields are evaluated once, up front, or taken from
/// a correction pass that kept them. The tiles come from `tiles` when given
/// (a real surface's corrected tiles); without it they are the raw argmax at
/// each tile, the preview's, evaluated on demand outside the chunk.
pub struct AquiloChunkInputs<'a> {
    stack: &'a RefCell<AquiloStack>,
    tiles: Option<AquiloTiles<'a>>,
    chunk_x: i64,
    chunk_y: i64,
    own: Vec<AquiloFields>,
    border: BTreeMap<(i64, i64), AquiloTile>,
}

impl<'a> AquiloChunkInputs<'a> {
    /// The raw argmax as the tiles: the preview's.
    #[must_use]
    pub fn new(stack: &'a RefCell<AquiloStack>, chunk_x: i64, chunk_y: i64) -> Self {
        Self::on_tiles(stack, None, None, chunk_x, chunk_y)
    }

    /// `tiles` as the tiles (the raw argmax when `None`), taking a tile's
    /// fields from `kept` where a correction pass already evaluated them.
    /// They are `eval_at`'s own values, so the inputs are the same either way.
    #[must_use]
    pub fn on_tiles(
        stack: &'a RefCell<AquiloStack>,
        tiles: Option<AquiloTiles<'a>>,
        kept: Option<&KeptFields>,
        chunk_x: i64,
        chunk_y: i64,
    ) -> Self {
        let mut own = Vec::with_capacity(TILES_PER_CHUNK);
        for i in 0..TILES_PER_CHUNK {
            #[allow(clippy::cast_possible_wrap)]
            let (lx, ly) = ((i as i64) & 31, (i as i64) >> 5);
            let (tx, ty) = (chunk_x * CHUNK + lx, chunk_y * CHUNK + ly);
            #[allow(clippy::cast_possible_truncation)]
            let reused = kept.and_then(|k| k.get(tx as i32, ty as i32));
            own.push(reused.unwrap_or_else(|| {
                #[allow(clippy::cast_precision_loss)]
                let at = tile_at(tx as f64, ty as f64);
                stack.borrow_mut().eval_at(at)
            }));
        }
        Self {
            stack,
            tiles,
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

    /// The raw argmax at a tile.
    fn raw_tile(&mut self, tx: i64, ty: i64) -> AquiloTile {
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
        let e = AQUILO_ENTITIES[proto];
        if e.well().is_some() {
            return false;
        }
        match self.tiles {
            Some(tiles) => tiles(tx, ty).is_none_or(|t| e.blocked_by(t)),
            None => {
                let t = self.raw_tile(tx, ty);
                e.blocked_by(t)
            }
        }
    }
}

/// One chunk's queue on `tiles` (the raw argmax when `None`), in queue
/// order.
#[must_use]
pub fn queue_chunk(
    stack: &RefCell<AquiloStack>,
    tiles: Option<AquiloTiles<'_>>,
    kept: Option<&KeptFields>,
    chunk_x: i64,
    chunk_y: i64,
) -> Vec<Queued> {
    let mut inputs = AquiloChunkInputs::on_tiles(stack, tiles, kept, chunk_x, chunk_y);
    generate_chunk(
        chunk_x,
        chunk_y,
        &AQUILO_GROUPS,
        &AQUILO_AUTOPLACERS,
        &mut inputs,
    )
}

/// The queue the generator builds for one chunk on the raw argmax (the
/// preview's tiles), as (entity, x, y) in 1/256 tile.
#[must_use]
pub fn preview_chunk_queue(
    stack: &RefCell<AquiloStack>,
    chunk_x: i64,
    chunk_y: i64,
) -> Vec<(AquiloEntity, i64, i64)> {
    queue_chunk(stack, None, None, chunk_x, chunk_y)
        .iter()
        .map(|q| (AQUILO_ENTITIES[q.proto], q.x, q.y))
        .collect()
}

/// Each chunk's queue on `tiles`, in the order given. A chunk's queue reads
/// only the fields and the tiles, never another chunk's entities, so it can
/// be built once and applied under several rules.
#[must_use]
pub fn queue_chunks(
    stack: &RefCell<AquiloStack>,
    tiles: Option<AquiloTiles<'_>>,
    kept: Option<&KeptFields>,
    chunks: &[(i64, i64)],
) -> Vec<Vec<Queued>> {
    chunks
        .iter()
        .map(|&(cx, cy)| queue_chunk(stack, tiles, kept, cx, cy))
        .collect()
}

/// How the queue is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Apply {
    /// What a real surface does: an entity whose box meets (touching
    /// included) a placed one on a shared layer is dropped.
    RealSurface,
    /// The same, but boxes that only touch do not collide. A control: the
    /// game does not do this (`fixtures`).
    StrictOverlap,
    /// Every queued entity is kept, as the game's map preview draws them.
    Preview,
}

/// One placed entity: its position and map-gen box in 1/256 tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AquiloPlaced {
    pub entity: AquiloEntity,
    pub x: i64,
    pub y: i64,
    /// Left, top, right, bottom.
    pub bounds: [i64; 4],
}

impl AquiloPlaced {
    /// The tiles a map paints for it: `floor(left)` to `ceil(right) - 1` on
    /// each axis, so an edge exactly on a tile line does not take the tile
    /// past it. This is the drawing rule measured against the game's preview
    /// PNG (`generate::preview_footprint`), without that rule's clip to the
    /// entity's own chunk, which a real map does not have. Returns (x0, x1,
    /// y0, y1), inclusive.
    #[must_use]
    pub fn footprint(&self) -> (i64, i64, i64, i64) {
        let [left, top, right, bottom] = self.bounds;
        (
            left.div_euclid(FIXED_ONE),
            (right - 1).div_euclid(FIXED_ONE),
            top.div_euclid(FIXED_ONE),
            (bottom - 1).div_euclid(FIXED_ONE),
        )
    }

    /// Where it sits in the paint order: a render paints the HIGHER ranks
    /// first, so where two footprints share a tile the entity of the earlier
    /// autoplace group is on top, the preview's own rule (the first queued
    /// wins, measured on its PNG). Only a well and an iceberg can share a
    /// tile, because each blocks its own kind; two icebergs that share one
    /// paint the same colour.
    #[must_use]
    pub fn paint_rank(&self) -> usize {
        AQUILO_ENTITIES
            .iter()
            .position(|e| *e == self.entity)
            .unwrap_or(0)
    }
}

/// The surface the apply step tests against: every placed entity, bucketed by
/// the tile its position is on.
struct Surface {
    rule: Apply,
    placed: Vec<AquiloPlaced>,
    buckets: BTreeMap<(i64, i64), Vec<usize>>,
}

impl Surface {
    fn new(rule: Apply) -> Self {
        Self {
            rule,
            placed: Vec::new(),
            buckets: BTreeMap::new(),
        }
    }

    /// Whether `b` meets the box of a placed entity on a shared layer.
    fn collides(&self, e: AquiloEntity, b: [i64; 4]) -> bool {
        if self.rule == Apply::Preview {
            return false;
        }
        // Touching boxes meet; under the control they must overlap.
        let edge = i64::from(self.rule == Apply::StrictOverlap);
        // A placed entity whose box can meet `b` has its position within
        // MAX_REACH of it on each axis, and is bucketed by that position.
        let (x0, x1) = (
            (b[0] - MAX_REACH).div_euclid(FIXED_ONE),
            (b[2] + MAX_REACH).div_euclid(FIXED_ONE),
        );
        let (y0, y1) = (
            (b[1] - MAX_REACH).div_euclid(FIXED_ONE),
            (b[3] + MAX_REACH).div_euclid(FIXED_ONE),
        );
        for by in y0..=y1 {
            for bx in x0..=x1 {
                let Some(list) = self.buckets.get(&(bx, by)) else {
                    continue;
                };
                for &k in list {
                    let o = self.placed[k];
                    if o.entity.layers() & e.layers() != 0
                        && b[0] + edge <= o.bounds[2]
                        && o.bounds[0] + edge <= b[2]
                        && b[1] + edge <= o.bounds[3]
                        && o.bounds[1] + edge <= b[3]
                    {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn apply(&mut self, q: &Queued) {
        let entity = AQUILO_ENTITIES[q.proto];
        let bounds = q.bounds(&AQUILO_AUTOPLACERS);
        if self.collides(entity, bounds) {
            return;
        }
        let key = (q.x.div_euclid(FIXED_ONE), q.y.div_euclid(FIXED_ONE));
        self.buckets.entry(key).or_default().push(self.placed.len());
        self.placed.push(AquiloPlaced {
            entity,
            x: q.x,
            y: q.y,
            bounds,
        });
    }
}

/// Apply queues in order under `rule`. Returns every entity kept, in apply
/// order.
#[must_use]
pub fn apply(queues: &[Vec<Queued>], rule: Apply) -> Vec<AquiloPlaced> {
    let mut surface = Surface::new(rule);
    for queue in queues {
        for q in queue {
            surface.apply(q);
        }
    }
    surface.placed
}

/// Generate and apply the chunks `chunks` on `tiles`, in the order given,
/// which should be the order a real surface applies them: row-major, y outer
/// and x inner ([`rows`]). Returns every entity placed, in apply order.
#[must_use]
pub fn place_chunks(
    stack: &RefCell<AquiloStack>,
    tiles: AquiloTiles<'_>,
    kept: Option<&KeptFields>,
    chunks: &[(i64, i64)],
) -> Vec<AquiloPlaced> {
    apply(
        &queue_chunks(stack, Some(tiles), kept, chunks),
        Apply::RealSurface,
    )
}

/// The chunks from `(cx0, cy0)` to `(cx1, cy1)` inclusive, row-major.
#[must_use]
pub fn rows(cx: (i64, i64), cy: (i64, i64)) -> Vec<(i64, i64)> {
    (cy.0..=cy.1)
        .flat_map(|y| (cx.0..=cx.1).map(move |x| (x, y)))
        .collect()
}

/// Chunks generated around a window's own, on each side, when its entities
/// are placed. A real surface applies chunks row-major, so an entity near a
/// chunk edge can be blocked by one the chunk above or to the left placed
/// first, and a huge iceberg's box reaches two tiles into the chunk beside
/// it. One ring covers both. Those ring chunks are applied without THEIR
/// earlier neighbours, which could only reach a window pixel through a chain
/// of two edge collisions; `test/wasmAquiloRenderParity.spec.ts` stitches
/// tiles cut through chunks to the whole render byte for byte, and the whole
/// 1024 window matches the real surface.
pub const AQUILO_ENTITY_RING_CHUNKS: i64 = 1;

/// A window's terrain and entities as a real surface holds them.
pub struct AquiloSurfaceWindow {
    /// The first tile of the entity area: the window's chunks plus the ring.
    pub area_origin: (i64, i64),
    /// The entity area's size in tiles.
    pub area_size: (i64, i64),
    /// The corrected tiles of the entity area, row-major, y outer.
    pub tiles: Vec<AquiloTile>,
    /// Every entity placed in the entity area, in apply order.
    pub placed: Vec<AquiloPlaced>,
}

impl AquiloSurfaceWindow {
    /// The corrected tile at `(tx, ty)`, if it is in the entity area.
    #[must_use]
    pub fn tile(&self, tx: i64, ty: i64) -> Option<AquiloTile> {
        let (ox, oy) = self.area_origin;
        let (w, h) = self.area_size;
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        ((ox..ox + w).contains(&tx) && (oy..oy + h).contains(&ty))
            .then(|| self.tiles[((ty - oy) * w + (tx - ox)) as usize])
    }
}

/// The window `origin` .. `origin + size` as a real surface holds it: tile
/// correction over the window's chunks plus `ring` chunks on each side (and
/// `AQUILO_CORRECTION_MARGIN_CHUNKS` read past that), then every entity of
/// those chunks generated on the corrected tiles and applied row-major.
///
/// Correction evaluates every tile of the entity area, and the generator
/// reads the same fields there, so they are kept rather than evaluated twice
/// while the area is at most `keep_max_chunks` chunks; above that the
/// generator evaluates its own, with the same result.
#[must_use]
pub fn real_surface_window(
    stack: &RefCell<AquiloStack>,
    origin: (i64, i64),
    size: (i64, i64),
    ring: i64,
    keep_max_chunks: i64,
) -> AquiloSurfaceWindow {
    use crate::expressions::aquilo_stack::AQUILO_CORRECTION_MARGIN_CHUNKS;
    let cx = (
        origin.0.div_euclid(CHUNK) - ring,
        (origin.0 + size.0 - 1).div_euclid(CHUNK) + ring,
    );
    let cy = (
        origin.1.div_euclid(CHUNK) - ring,
        (origin.1 + size.1 - 1).div_euclid(CHUNK) + ring,
    );
    let area_origin = (cx.0 * CHUNK, cy.0 * CHUNK);
    let area_size = ((cx.1 - cx.0 + 1) * CHUNK, (cy.1 - cy.0 + 1) * CHUNK);
    let chunks = (cx.1 - cx.0 + 1) * (cy.1 - cy.0 + 1);
    #[allow(clippy::cast_possible_truncation)]
    let mut kept = (chunks <= keep_max_chunks)
        .then(|| KeptFields::new((cx.0 as i32, cx.1 as i32), (cy.0 as i32, cy.1 as i32)));
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let tiles = stack.borrow_mut().corrected_tiles_keeping(
        (area_origin.0 as i32, area_origin.1 as i32),
        (area_size.0 as u32, area_size.1 as u32),
        AQUILO_CORRECTION_MARGIN_CHUNKS,
        kept.as_mut(),
    );
    let mut window = AquiloSurfaceWindow {
        area_origin,
        area_size,
        tiles,
        placed: Vec::new(),
    };
    let lookup = |tx: i64, ty: i64| window.tile(tx, ty);
    let placed = place_chunks(stack, &lookup, kept.as_ref(), &rows(cx, cy));
    window.placed = placed;
    window
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

    /// The audit (2026-11-26) changed this: it used to sort a local literal
    /// against itself and never read the product's table. It now pairs each
    /// `AQUILO_ENTITIES` slot with the game's autoplace `order` string
    /// (`space-age/prototypes/entity/resources.lua`, `base/.../resources.lua`
    /// and `decoratives-aquilo.lua`, read at 2.1.14) and requires the strings
    /// to be strictly increasing in table order, then ties the autoplacer
    /// table's positioning to the entity kind.
    #[test]
    fn the_autoplacer_table_is_in_the_games_sorted_order() {
        let game_order = |e: AquiloEntity| match e {
            AquiloEntity::FluorineVent => "a[resources]-a[fluorine]",
            AquiloEntity::LithiumBrine => "a[resources]-b[lithium]",
            AquiloEntity::IcebergHuge => "a[rock]-a[huge]",
            AquiloEntity::IcebergBig => "a[rock]-b[big]",
            AquiloEntity::CrudeOil => "c",
        };
        let names: Vec<&str> = AQUILO_ENTITIES.iter().map(|e| e.game_name()).collect();
        assert_eq!(
            names,
            [
                "fluorine-vent",
                "lithium-brine",
                "lithium-iceberg-huge",
                "lithium-iceberg-big",
                "crude-oil"
            ]
        );
        let orders: Vec<&str> = AQUILO_ENTITIES.iter().map(|&e| game_order(e)).collect();
        let mut sorted = orders.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, orders, "AQUILO_ENTITIES is not in sorted order");
        assert_eq!(AQUILO_ENTITIES.len(), AQUILO_AUTOPLACERS.len());
        for (e, placer) in AQUILO_ENTITIES.iter().zip(&AQUILO_AUTOPLACERS) {
            let want = if e.well().is_some() {
                Positioning::Resource
            } else {
                Positioning::OffGrid
            };
            assert_eq!(placer.positioning, want, "{}", e.game_name());
        }
        // MAX_REACH must cover every box, or the apply step misses a hit.
        for p in &AQUILO_AUTOPLACERS {
            let b = p.map_gen_box;
            assert!([-b.left, -b.top, b.right, b.bottom]
                .iter()
                .all(|&r| r <= MAX_REACH));
        }
    }

    /// A few wells the game's real surface and its preview agree on, at the
    /// derived seed: the queue must hold them at the tile centre.
    #[test]
    fn the_preview_queue_holds_wells_the_game_placed() {
        let s = stack(DERIVED_SEED);
        let has = |name: &str, x: f64, y: f64| {
            #[allow(clippy::cast_possible_truncation)]
            let (cx, cy) = (
                (x.floor() as i64).div_euclid(32),
                (y.floor() as i64).div_euclid(32),
            );
            preview_chunk_queue(&s, cx, cy).iter().any(|&(k, qx, qy)| {
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
    fn vents_near(s: &RefCell<AquiloStack>, centre: (f64, f64)) -> Vec<(f64, f64)> {
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
            for (k, x, y) in preview_chunk_queue(s, cx, cy) {
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
            let vents = vents_near(&s, centre);
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
        assert_eq!(vents_near(&s, tiny_vent_centre(seed)), vec![]);
    }

    fn queued(proto: usize, x: i64, y: i64) -> Queued {
        Queued { proto, x, y }
    }

    /// Touching boxes collide; boxes a 1/256 tile apart do not; a well and
    /// an iceberg share no layer, so they never collide.
    #[test]
    fn touching_boxes_collide_and_wells_never_meet_icebergs() {
        // Two big icebergs (proto 3, 2.0 wide): 512 apart touch, 513 do not.
        let kept = |rule, dx| apply(&[vec![queued(3, 0, 0), queued(3, dx, 0)]], rule).len();
        assert_eq!(kept(Apply::RealSurface, 512), 1);
        assert_eq!(kept(Apply::RealSurface, 513), 2);
        assert_eq!(kept(Apply::StrictOverlap, 512), 2);
        assert_eq!(kept(Apply::StrictOverlap, 511), 1);
        // A crude oil on top of a big iceberg: both stay.
        assert_eq!(
            apply(
                &[vec![queued(3, 0, 0), queued(4, 128, 128)]],
                Apply::RealSurface
            )
            .len(),
            2
        );
        // A vent on a brine: the second goes, under any rule but the preview.
        let wells = [vec![queued(0, 128, 128)], vec![queued(1, 128 + 256, 128)]];
        assert_eq!(apply(&wells, Apply::RealSurface).len(), 1);
        assert_eq!(apply(&wells, Apply::Preview).len(), 2);
    }

    /// The footprint is `floor(left)` to `ceil(right) - 1`: a well at a tile
    /// centre covers that tile and one either side.
    #[test]
    fn a_well_paints_three_by_three_tiles() {
        let p = apply(
            &[vec![queued(4, 5 * 256 + 128, -3 * 256 + 128)]],
            Apply::Preview,
        )[0];
        assert_eq!(p.footprint(), (4, 6, -4, -2));
    }
}
