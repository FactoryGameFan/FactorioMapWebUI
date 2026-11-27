//! Gleba's stone and two stromatolites, placed as a REAL surface places them
//! (#454, slice 3): the game's own per-chunk generator ([`super::generate`]),
//! then the apply step's entity-against-entity collision, which the game's
//! map preview skips.
//!
//! ## The autoplacers, read from the game
//!
//! `oracle-gleba-real-surface-entities.seed123456.json` lists every entity
//! autoplacer a Gleba surface runs, read from the prototypes at runtime. Sorted
//! by (autoplace `order`, name) the way `prepareAutoplacers` sorts them:
//!
//! | order | prototypes | positioning | map-gen box (1/256 tile) |
//! | --- | --- | --- | --- |
//! | `""` | `copper-stromatolite`, `iron-stromatolite` | off grid | +-128 square |
//! | `a[tree]-...` | twelve plants (`gleba_plants`) | off grid | (not ported) |
//! | `b` | `stone` | tile centre | +-25 square |
//! | `b[enemy]-...` | two pentapod nests (`gleba_enemy_base`) | off grid | (not ported) |
//!
//! The two stromatolites set no `order`, so they share the empty one and form
//! ONE group, the first the chunk's stream serves. Their probabilities never
//! depend on anything another group draws. That is what makes them portable
//! before the plants: the plants come after them in the stream.
//!
//! **Stone is independent of the stream.** Its probability is
//! `(size > 0) * (richness > 1)`, exactly 0 or 1, and a roll places when
//! `p > U` with `U` in `[0, 1)`. So whatever the plant groups between it and
//! the stromatolites draw, stone places on exactly the tiles where its
//! probability is 1. This module runs stone straight after the stromatolites;
//! its draws land elsewhere in the stream than the game's, and it cannot tell.
//!
//! ## Tile masks
//!
//! The stromatolites' `collision_mask` is `ground_tile, is_lower_object,
//! is_object, player, train`. Every Gleba land tile is `ground_tile`, and the
//! deep lake carries `player`, so a stromatolite is a candidate only on the
//! nine `wetland-*` tiles (`floor, resource, water_tile`), and its whole box
//! must cover wetland. Stone's mask is `resource`, which every wetland tile and
//! the deep lake carry, so stone stands only on land.
//!
//! ## Apply
//!
//! A real surface applies each chunk's queue in queue order, dropping an
//! entity whose map-gen box meets an already placed one on a shared collision
//! layer (`EntityMapGenerationTask::apply`, see
//! `docs/noise/entity-generation-NOTES.md`). Boxes that only touch collide,
//! and chunks apply row-major; both were measured on Aquilo and hold here
//! (`fixtures`). Stromatolites block stromatolites and stone blocks stone; the
//! two never share a layer.

use super::generate::{generate_chunk, Autoplacer, ChunkInputs, MapGenBox, Positioning, Queued};
use super::roll::{CHUNK, TILES_PER_CHUNK};
use crate::at::At;
use crate::expressions::gleba_resources::GlebaResourceFields;
use crate::expressions::gleba_stack::{GlebaStack, KeptInputs};
use crate::tiles::gleba_catalog::GlebaTile;
use std::collections::BTreeMap;

/// One of the three entities this module places, in the generator's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum GlebaEntity {
    CopperStromatolite,
    IronStromatolite,
    Stone,
}

/// Every entity, indexed as the generator's prototype index.
pub const GLEBA_ENTITIES: [GlebaEntity; 3] = [
    GlebaEntity::CopperStromatolite,
    GlebaEntity::IronStromatolite,
    GlebaEntity::Stone,
];

/// The generator's view of each entity, by prototype index. The boxes are
/// each `collision_box` times 256: 0.5 is exact, and the game reports stone's
/// 0.1 as 0.09765625, which is 25 / 256. None declares a separate
/// `map_generator_bounding_box`.
pub const GLEBA_AUTOPLACERS: [Autoplacer; 3] = [
    Autoplacer {
        positioning: Positioning::OffGrid,
        map_gen_box: MapGenBox::centred(128, 128),
    },
    Autoplacer {
        positioning: Positioning::OffGrid,
        map_gen_box: MapGenBox::centred(128, 128),
    },
    Autoplacer {
        positioning: Positioning::Resource,
        map_gen_box: MapGenBox::centred(25, 25),
    },
];

/// The groups, in the order the chunk's stream serves them.
pub const GLEBA_GROUPS: [&[usize]; 2] = [&[0, 1], &[2]];

/// Collision layers as bits. Only the layers some Gleba tile or one of these
/// three entities carries.
pub mod layer {
    pub const GROUND_TILE: u32 = 1 << 0;
    pub const WATER_TILE: u32 = 1 << 1;
    pub const RESOURCE: u32 = 1 << 2;
    pub const FLOOR: u32 = 1 << 3;
    pub const DOODAD: u32 = 1 << 4;
    pub const ITEM: u32 = 1 << 5;
    pub const PLAYER: u32 = 1 << 6;
    pub const IS_OBJECT: u32 = 1 << 7;
    pub const IS_LOWER_OBJECT: u32 = 1 << 8;
    pub const TRAIN: u32 = 1 << 9;

    /// A layer's bit by the game's name, for the tests that check these
    /// tables against the prototypes.
    #[must_use]
    pub fn by_name(name: &str) -> Option<u32> {
        Some(match name {
            "ground_tile" => GROUND_TILE,
            "water_tile" => WATER_TILE,
            "resource" => RESOURCE,
            "floor" => FLOOR,
            "doodad" => DOODAD,
            "item" => ITEM,
            "player" => PLAYER,
            "is_object" => IS_OBJECT,
            "is_lower_object" => IS_LOWER_OBJECT,
            "train" => TRAIN,
            _ => return None,
        })
    }
}

/// A tile's collision layers, as `prototypes.tile[name].collision_mask` reads
/// at runtime (the fixture's `tiles`).
#[must_use]
pub fn tile_layers(t: GlebaTile) -> u32 {
    use layer::{DOODAD, FLOOR, GROUND_TILE, ITEM, PLAYER, RESOURCE, WATER_TILE};
    if t == GlebaTile::GlebaDeepLake {
        DOODAD | FLOOR | ITEM | PLAYER | RESOURCE | WATER_TILE
    } else if t.game_name().starts_with("wetland-") {
        FLOOR | RESOURCE | WATER_TILE
    } else {
        GROUND_TILE
    }
}

impl GlebaEntity {
    /// The prototype's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::CopperStromatolite => "copper-stromatolite",
            Self::IronStromatolite => "iron-stromatolite",
            Self::Stone => "stone",
        }
    }

    /// The prototype's collision layers.
    #[must_use]
    pub fn layers(self) -> u32 {
        use layer::{GROUND_TILE, IS_LOWER_OBJECT, IS_OBJECT, PLAYER, RESOURCE, TRAIN};
        match self {
            Self::CopperStromatolite | Self::IronStromatolite => {
                GROUND_TILE | IS_LOWER_OBJECT | IS_OBJECT | PLAYER | TRAIN
            }
            Self::Stone => RESOURCE,
        }
    }

    /// The colour a map draws the entity in. Both stromatolites have the
    /// `map_color` `{129, 105, 78}` in the Lua, so a map cannot tell them
    /// apart. Stone's is `{0.69, 0.611, 0.427}`, which the game's preview PNG
    /// draws as (175, 155, 108): measured at every stone tile it shows.
    #[must_use]
    pub fn color(self) -> [u8; 3] {
        match self {
            Self::CopperStromatolite | Self::IronStromatolite => [129, 105, 78],
            Self::Stone => [175, 155, 108],
        }
    }
}

/// One placed entity: its position and map-gen box in 1/256 tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlebaPlaced {
    pub entity: GlebaEntity,
    pub x: i64,
    pub y: i64,
    /// Left, top, right, bottom.
    pub bounds: [i64; 4],
}

impl GlebaPlaced {
    /// The tiles a map paints for it: `floor(left)` to `ceil(right) - 1` on
    /// each axis, so an edge exactly on a tile line does not take the tile
    /// past it. This is the drawing rule measured against the game's preview
    /// PNG on Aquilo (`generate::preview_footprint`), without that rule's
    /// clip to the entity's own chunk, which a real map does not have.
    /// Returns (x0, x1, y0, y1), inclusive.
    #[must_use]
    pub fn footprint(&self) -> (i64, i64, i64, i64) {
        let [left, top, right, bottom] = self.bounds;
        let one = super::generate::FIXED_ONE;
        (
            left.div_euclid(one),
            (right - 1).div_euclid(one),
            top.div_euclid(one),
            (bottom - 1).div_euclid(one),
        )
    }
}

/// The tiles the generator may look at, by world tile. `None` is a tile the
/// caller did not compute; it blocks every entity, so a box that reaches past
/// the computed area is refused rather than placed on a guess.
pub type GlebaTiles<'a> = &'a dyn Fn(i64, i64) -> Option<GlebaTile>;

/// The generator's inputs for one chunk: the resource fields at each tile's
/// integer corner on the chunk grid, evaluated once per tile and shared by the
/// three prototypes.
pub struct GlebaChunkInputs<'a> {
    stack: &'a GlebaStack,
    tiles: GlebaTiles<'a>,
    kept: Option<&'a KeptInputs>,
    x0: i64,
    y0: i64,
    fields: Vec<Option<GlebaResourceFields>>,
}

impl<'a> GlebaChunkInputs<'a> {
    /// `kept`, when given, holds the terrain fields a tile-correction pass
    /// already evaluated at these tiles, so they are not evaluated again.
    #[must_use]
    pub fn new(
        stack: &'a GlebaStack,
        tiles: GlebaTiles<'a>,
        kept: Option<&'a KeptInputs>,
        cx: i64,
        cy: i64,
    ) -> Self {
        Self {
            stack,
            tiles,
            kept,
            x0: cx * CHUNK,
            y0: cy * CHUNK,
            fields: vec![None; TILES_PER_CHUNK],
        }
    }

    fn fields(&mut self, tx: i64, ty: i64) -> GlebaResourceFields {
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let i = ((ty - self.y0) * CHUNK + (tx - self.x0)) as usize;
        let (stack, kept) = (self.stack, self.kept);
        *self.fields[i].get_or_insert_with(|| {
            #[allow(clippy::cast_possible_truncation)]
            let (x, y) = (tx as i32, ty as i32);
            match kept.and_then(|k| k.get(x, y)) {
                Some(t) => stack.resources_from(At::tile(x, y), &t),
                None => stack.resources_at(At::tile(x, y)).1,
            }
        })
    }
}

impl ChunkInputs for GlebaChunkInputs<'_> {
    fn probability(&mut self, proto: usize, tx: i64, ty: i64) -> f64 {
        let f = self.fields(tx, ty);
        match GLEBA_ENTITIES[proto] {
            GlebaEntity::CopperStromatolite => f.copper_probability,
            GlebaEntity::IronStromatolite => f.iron_probability,
            GlebaEntity::Stone => f.stone_probability,
        }
    }

    fn richness_positive(&mut self, proto: usize, tx: i64, ty: i64) -> bool {
        GLEBA_ENTITIES[proto] != GlebaEntity::Stone || self.fields(tx, ty).stone_richness > 0.0
    }

    fn tile_blocks(&mut self, proto: usize, tx: i64, ty: i64) -> bool {
        match (self.tiles)(tx, ty) {
            Some(t) => tile_layers(t) & GLEBA_ENTITIES[proto].layers() != 0,
            None => true,
        }
    }
}

/// How the queue is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Apply {
    /// What a real surface does: an entity whose box meets (touches
    /// included) a placed one on a shared layer is dropped.
    RealSurface,
    /// The same, but boxes that only touch do not collide. A control: the
    /// game does not do this (`fixtures`).
    StrictOverlap,
    /// Every queued entity is kept, as the game's map preview draws them.
    Preview,
}

/// The surface the apply step tests against: every placed entity, bucketed by
/// the tile its position is on.
struct Surface {
    rule: Apply,
    placed: Vec<GlebaPlaced>,
    buckets: BTreeMap<(i64, i64), Vec<usize>>,
}

impl Surface {
    /// Whether `b` meets the box of a placed entity on a shared layer. Boxes
    /// that only touch collide (measured on Aquilo, and needed here: see
    /// `fixtures`).
    fn new(rule: Apply) -> Self {
        Self {
            rule,
            placed: Vec::new(),
            buckets: BTreeMap::new(),
        }
    }

    fn collides(&self, e: GlebaEntity, b: [i64; 4]) -> bool {
        if self.rule == Apply::Preview {
            return false;
        }
        // Touching boxes meet; under the control they must overlap.
        let edge = i64::from(self.rule == Apply::StrictOverlap);
        let one = super::generate::FIXED_ONE;
        // Every box here is at most one tile across, so a hit sits within two
        // tiles of the new entity's own tile.
        let (tx, ty) = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
        let (tx, ty) = (tx.div_euclid(one), ty.div_euclid(one));
        for by in ty - 2..=ty + 2 {
            for bx in tx - 2..=tx + 2 {
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
        let entity = GLEBA_ENTITIES[q.proto];
        let bounds = q.bounds(&GLEBA_AUTOPLACERS);
        if self.collides(entity, bounds) {
            return;
        }
        let one = super::generate::FIXED_ONE;
        let key = (q.x.div_euclid(one), q.y.div_euclid(one));
        self.buckets.entry(key).or_default().push(self.placed.len());
        self.placed.push(GlebaPlaced {
            entity,
            x: q.x,
            y: q.y,
            bounds,
        });
    }
}

/// Generate and apply the chunks `chunks`, in the order given, which should
/// be the order a real surface applies them: row-major, y outer and x inner.
/// Returns every entity placed, in apply order.
#[must_use]
pub fn place_chunks(
    stack: &GlebaStack,
    tiles: GlebaTiles<'_>,
    kept: Option<&KeptInputs>,
    chunks: &[(i64, i64)],
) -> Vec<GlebaPlaced> {
    apply(
        &queue_chunks(stack, tiles, kept, chunks),
        Apply::RealSurface,
    )
}

/// Each chunk's queue, in the order given. A chunk's queue reads only the
/// fields and the tiles, never another chunk's entities, so it can be built
/// once and applied under several rules.
#[must_use]
pub fn queue_chunks(
    stack: &GlebaStack,
    tiles: GlebaTiles<'_>,
    kept: Option<&KeptInputs>,
    chunks: &[(i64, i64)],
) -> Vec<Vec<Queued>> {
    chunks
        .iter()
        .map(|&(cx, cy)| {
            let mut inputs = GlebaChunkInputs::new(stack, tiles, kept, cx, cy);
            generate_chunk(cx, cy, &GLEBA_GROUPS, &GLEBA_AUTOPLACERS, &mut inputs)
        })
        .collect()
}

/// Apply queues in order under `rule`. Returns every entity kept.
#[must_use]
pub fn apply(queues: &[Vec<Queued>], rule: Apply) -> Vec<GlebaPlaced> {
    let mut surface = Surface::new(rule);
    for q in queues.iter().flatten() {
        surface.apply(q);
    }
    surface.placed
}

/// The chunks from `(cx0, cy0)` to `(cx1, cy1)` inclusive, row-major.
#[must_use]
pub fn rows(cx: (i64, i64), cy: (i64, i64)) -> Vec<(i64, i64)> {
    (cy.0..=cy.1)
        .flat_map(|y| (cx.0..=cx.1).map(move |x| (x, y)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::gleba_catalog::TILE_ORDER;

    /// Wetland is the only family a stromatolite may stand on, and stone may
    /// stand on every other family but the deep lake.
    #[test]
    fn stromatolites_stand_on_wetland_and_stone_on_land() {
        let s = GlebaEntity::IronStromatolite.layers();
        let r = GlebaEntity::Stone.layers();
        for t in TILE_ORDER {
            let wet = t.game_name().starts_with("wetland-");
            let lake = t == GlebaTile::GlebaDeepLake;
            assert_eq!(tile_layers(t) & s == 0, wet, "{t:?}");
            assert_eq!(tile_layers(t) & r == 0, !wet && !lake, "{t:?}");
        }
    }

    /// Touching boxes collide; boxes a 1/256 tile apart do not.
    #[test]
    fn touching_boxes_collide() {
        let mut s = Surface::new(Apply::RealSurface);
        s.apply(&Queued {
            proto: 0,
            x: 0,
            y: 0,
        });
        let at = |x| GLEBA_AUTOPLACERS[1].map_gen_box.left + x;
        assert!(s.collides(
            GlebaEntity::IronStromatolite,
            [at(256), -128, at(256) + 256, 128]
        ));
        assert!(!s.collides(
            GlebaEntity::IronStromatolite,
            [at(257), -128, at(257) + 256, 128]
        ));
        // Stone shares no layer with a stromatolite.
        assert!(!s.collides(GlebaEntity::Stone, [-25, -25, 25, 25]));
    }
}
