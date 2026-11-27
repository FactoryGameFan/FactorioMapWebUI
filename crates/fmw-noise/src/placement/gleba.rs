//! Gleba's stone, two stromatolites and twelve plants, placed as a REAL
//! surface places them (#454, slices 3 and 4): the game's own per-chunk
//! generator ([`super::generate`]), then the apply step's entity-against-entity
//! collision, which the game's map preview skips.
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
//! | `a[tree]-b[forest]-a` .. `-k` | eleven plants, one group each | off grid | see [`GLEBA_AUTOPLACERS`] |
//! | `a[tree]-d[decorative]-a[water-cane]` | `water-cane` | off grid | +-25 square |
//! | `b` | `stone` | tile centre | +-25 square |
//! | `b[enemy]-...` | two pentapod nests (`gleba_enemy_base`) | off grid | (not ported) |
//!
//! The two stromatolites set no `order`, so they share the empty one and form
//! ONE group, the first the chunk's stream serves. Every plant has an order of
//! its own, so each is its own group, in the order of [`PLANTS`]. A group
//! draws once for every tile with a winner, even where the probability is 0,
//! plus two jitter draws for each success, so where a plant's draws start
//! depends on every earlier group's successes: water-cane, the last, needs all
//! eleven before it exact.
//!
//! **Stone is independent of the stream.** Its probability is
//! `(size > 0) * (richness > 1)`, exactly 0 or 1, and a roll places when
//! `p > U` with `U` in `[0, 1)`, so it places on exactly the tiles where its
//! probability is 1 whatever was drawn before it. It runs after the plants,
//! as in the game.
//!
//! **Tile restrictions.** yumako-tree may stand only on the three yumako
//! soils and jellystem only on the three jellynut soils. The generator checks
//! the one tile under the position, after the tile-mask check
//! (`AutoplaceSpecification.cpp:127-191`; the pairs form that also reads
//! neighbours is not used on Gleba). A restricted tile gets no winner, so it
//! draws nothing. Stingfrond's Lua declares a restriction too, in an
//! `autoplace` key its table overwrites; the game reports none
//! (`expressions::gleba_plants`).
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
use crate::expressions::gleba_plants::{GlebaPlantFields, PLANTS};
use crate::expressions::gleba_resources::{GlebaResourceFields, ResourceInputs};
use crate::expressions::gleba_stack::{GlebaStack, KeptInputs};
use crate::tiles::gleba_catalog::GlebaTile;
use std::collections::BTreeMap;

/// One of the fifteen entities this module places. The first three keep
/// their slice-3 indices; the plants follow in [`PLANTS`] order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum GlebaEntity {
    CopperStromatolite,
    IronStromatolite,
    Stone,
    YumakoTree,
    Jellystem,
    Sunnycomb,
    Boompuff,
    Stingfrond,
    Lickmaw,
    Teflilly,
    Funneltrunk,
    Slipstack,
    Hairyclubnub,
    Cuttlepop,
    WaterCane,
}

/// Every entity, indexed as the generator's prototype index.
pub const GLEBA_ENTITIES: [GlebaEntity; 15] = [
    GlebaEntity::CopperStromatolite,
    GlebaEntity::IronStromatolite,
    GlebaEntity::Stone,
    GlebaEntity::YumakoTree,
    GlebaEntity::Jellystem,
    GlebaEntity::Sunnycomb,
    GlebaEntity::Boompuff,
    GlebaEntity::Stingfrond,
    GlebaEntity::Lickmaw,
    GlebaEntity::Teflilly,
    GlebaEntity::Funneltrunk,
    GlebaEntity::Slipstack,
    GlebaEntity::Hairyclubnub,
    GlebaEntity::Cuttlepop,
    GlebaEntity::WaterCane,
];

/// The prototype index of the first plant: plant `k` of [`PLANTS`] is
/// `FIRST_PLANT + k`.
pub const FIRST_PLANT: usize = 3;

/// An off-grid autoplacer with the box `left, top, right, bottom` in 1/256
/// tile.
const fn off_grid(left: i64, top: i64, right: i64, bottom: i64) -> Autoplacer {
    Autoplacer {
        positioning: Positioning::OffGrid,
        map_gen_box: MapGenBox {
            left,
            top,
            right,
            bottom,
        },
    }
}

/// The generator's view of each entity, by prototype index. The boxes are
/// each `collision_box` times 256, as the game reports it at runtime: 0.5 is
/// exact, and a box the Lua writes as 0.1 the game holds as 0.09765625, which
/// is 25 / 256. None declares a separate `map_generator_bounding_box`.
pub const GLEBA_AUTOPLACERS: [Autoplacer; 15] = [
    off_grid(-128, -128, 128, 128),
    off_grid(-128, -128, 128, 128),
    Autoplacer {
        positioning: Positioning::Resource,
        map_gen_box: MapGenBox::centred(25, 25),
    },
    off_grid(-204, -204, 204, 204), // yumako-tree
    off_grid(-204, -204, 204, 204), // jellystem
    off_grid(-179, -128, 179, 128), // sunnycomb
    off_grid(-230, -102, 230, 204), // boompuff
    off_grid(-153, -102, 153, 153), // stingfrond
    off_grid(-179, -153, 179, 153), // lickmaw
    off_grid(-102, -102, 102, 102), // teflilly
    off_grid(-153, -128, 153, 128), // funneltrunk
    off_grid(-204, -153, 204, 153), // slipstack
    off_grid(-230, -153, 230, 153), // hairyclubnub
    off_grid(-153, -204, 153, 204), // cuttlepop
    off_grid(-25, -25, 25, 25),     // water-cane
];

/// The farthest any entity's box reaches from its position, on either axis,
/// in 1/256 tile: hairyclubnub's and boompuff's 230. The apply step searches
/// this far past a new box for entities that might meet it.
const MAX_REACH: i64 = 230;

/// The groups, in the order the chunk's stream serves them: the two
/// stromatolites, each plant alone, then stone.
pub const GLEBA_GROUPS: [&[usize]; 14] = [
    &[0, 1],
    &[3],
    &[4],
    &[5],
    &[6],
    &[7],
    &[8],
    &[9],
    &[10],
    &[11],
    &[12],
    &[13],
    &[14],
    &[2],
];

/// The groups with every plant left out: what the generator runs when the
/// `gleba_plants` control is at size 0. Every plant probability is then 0 (or
/// -0), so no plant places, and neither group left depends on the draws the
/// plants would have spent: the stromatolites draw first and stone needs no
/// stream. That stops holding once a group AFTER the plants reads the stream
/// (the pentapod nests): whether the game still runs a size-0 autoplacer's
/// draws must be measured before this shortcut can stay.
pub const GLEBA_GROUPS_NO_PLANTS: [&[usize]; 2] = [&[0, 1], &[2]];

/// Collision layers as bits. Only the layers some Gleba tile or one of these
/// entities carries.
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
    pub const MELTABLE: u32 = 1 << 10;
    pub const OBJECT: u32 = 1 << 11;

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
            "meltable" => MELTABLE,
            "object" => OBJECT,
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

/// How a map draws an entity over the tiles under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlebaPaint {
    /// Painted over, in this colour.
    Solid([u8; 3]),
    /// Blended toward this colour at `alpha / 256` (the chart's tree alpha,
    /// 0.4, as the Nauvis tree overlay rounds it: 102), once per entity.
    Blend([u8; 3], u8),
}

/// What a view draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlebaLayer {
    /// The plants.
    Plants,
    /// Stone and the stromatolites.
    Resources,
}

impl GlebaEntity {
    /// The prototype's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::CopperStromatolite => "copper-stromatolite",
            Self::IronStromatolite => "iron-stromatolite",
            Self::Stone => "stone",
            p => PLANTS[p as usize - FIRST_PLANT],
        }
    }

    /// Whether the entity is one of the twelve plants.
    #[must_use]
    pub fn is_plant(self) -> bool {
        self as usize >= FIRST_PLANT
    }

    /// The prototype's collision layers, as `prototypes.entity[name]
    /// .collision_mask` reads at runtime.
    #[must_use]
    pub fn layers(self) -> u32 {
        use layer::{
            GROUND_TILE, IS_LOWER_OBJECT, IS_OBJECT, ITEM, MELTABLE, OBJECT, PLAYER, RESOURCE,
            TRAIN, WATER_TILE,
        };
        match self {
            // The stromatolites, and three wetland plants whose Lua sets the
            // same mask.
            Self::CopperStromatolite
            | Self::IronStromatolite
            | Self::Slipstack
            | Self::Hairyclubnub
            | Self::Cuttlepop => GROUND_TILE | IS_LOWER_OBJECT | IS_OBJECT | PLAYER | TRAIN,
            Self::Stone => RESOURCE,
            // "not player", says the Lua.
            Self::WaterCane => GROUND_TILE | IS_LOWER_OBJECT | IS_OBJECT | TRAIN,
            // The rest keep the default tree mask.
            _ => IS_LOWER_OBJECT | IS_OBJECT | ITEM | MELTABLE | OBJECT | PLAYER | WATER_TILE,
        }
    }

    /// The tiles the entity may stand on, if its autoplace restricts it.
    #[must_use]
    pub fn tile_restriction(self) -> &'static [&'static str] {
        match self {
            Self::YumakoTree => &[
                "natural-yumako-soil",
                "artificial-yumako-soil",
                "overgrowth-yumako-soil",
            ],
            Self::Jellystem => &[
                "natural-jellynut-soil",
                "artificial-jellynut-soil",
                "overgrowth-jellynut-soil",
            ],
            _ => &[],
        }
    }

    /// Which view layer draws the entity.
    #[must_use]
    pub fn layer(self) -> GlebaLayer {
        if self.is_plant() {
            GlebaLayer::Plants
        } else {
            GlebaLayer::Resources
        }
    }

    /// How a map draws the entity. Both stromatolites have the `map_color`
    /// `{129, 105, 78}` in the Lua, so a map cannot tell them apart. Stone's
    /// is `{0.69, 0.611, 0.427}`, which the game's preview PNG draws as
    /// (175, 155, 108): measured at every stone tile it shows. yumako-tree and
    /// jellystem are `plant`s with `map_color = {255, 255, 255}`. The other
    /// ten are `tree`s with no `map_color`, so the chart draws them in its
    /// `default_color_by_type` for trees, `{0.19, 0.39, 0.19, 0.40}`
    /// (`utility-constants.lua`), the colour the Nauvis tree overlay blends.
    #[must_use]
    pub fn paint(self) -> GlebaPaint {
        match self {
            Self::CopperStromatolite | Self::IronStromatolite => GlebaPaint::Solid([129, 105, 78]),
            Self::Stone => GlebaPaint::Solid([175, 155, 108]),
            Self::YumakoTree | Self::Jellystem => GlebaPaint::Solid([255, 255, 255]),
            _ => GlebaPaint::Blend(crate::trees::catalog::TREE_MAP_COLOR, 102),
        }
    }

    /// The order a render paints entities in: the blended trees first, then
    /// the two white plants, then stone and the stromatolites. Footprints are
    /// whole tiles, so two entities whose boxes do not meet can still share a
    /// tile; a fixed class order makes the pixels independent of the order
    /// entities were placed in (blends of one colour commute).
    #[must_use]
    pub fn paint_pass(self) -> u8 {
        match self.paint() {
            GlebaPaint::Blend(..) => 0,
            GlebaPaint::Solid(_) if self.is_plant() => 1,
            GlebaPaint::Solid(_) => 2,
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

/// The generator's inputs for one chunk: the resource and plant fields at
/// each tile's integer corner on the chunk grid, each evaluated once per tile
/// (and only if some prototype asks) and shared by the prototypes.
pub struct GlebaChunkInputs<'a> {
    stack: &'a GlebaStack,
    tiles: GlebaTiles<'a>,
    kept: Option<&'a KeptInputs>,
    x0: i64,
    y0: i64,
    inputs: Vec<Option<ResourceInputs>>,
    fields: Vec<Option<GlebaResourceFields>>,
    plants: Vec<Option<GlebaPlantFields>>,
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
            inputs: vec![None; TILES_PER_CHUNK],
            fields: vec![None; TILES_PER_CHUNK],
            plants: vec![None; TILES_PER_CHUNK],
        }
    }

    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    fn index(&self, tx: i64, ty: i64) -> usize {
        ((ty - self.y0) * CHUNK + (tx - self.x0)) as usize
    }

    /// The terrain values the fields read, kept from tile correction or
    /// evaluated here.
    fn inputs(&mut self, tx: i64, ty: i64) -> ResourceInputs {
        let i = self.index(tx, ty);
        let (stack, kept) = (self.stack, self.kept);
        *self.inputs[i].get_or_insert_with(|| {
            #[allow(clippy::cast_possible_truncation)]
            let (x, y) = (tx as i32, ty as i32);
            kept.and_then(|k| k.get(x, y))
                .unwrap_or_else(|| ResourceInputs::from(&stack.eval_at(At::tile(x, y))))
        })
    }

    fn fields(&mut self, tx: i64, ty: i64) -> GlebaResourceFields {
        let i = self.index(tx, ty);
        if let Some(f) = self.fields[i] {
            return f;
        }
        let t = self.inputs(tx, ty);
        #[allow(clippy::cast_possible_truncation)]
        let f = self
            .stack
            .resources_from(At::tile(tx as i32, ty as i32), &t);
        self.fields[i] = Some(f);
        f
    }

    fn plants(&mut self, tx: i64, ty: i64) -> GlebaPlantFields {
        let i = self.index(tx, ty);
        if let Some(f) = self.plants[i] {
            return f;
        }
        let t = self.inputs(tx, ty);
        #[allow(clippy::cast_possible_truncation)]
        let f = self.stack.plants_from(At::tile(tx as i32, ty as i32), &t);
        self.plants[i] = Some(f);
        f
    }
}

impl ChunkInputs for GlebaChunkInputs<'_> {
    /// The tile's mask, then the autoplace's `tile_restriction`. The game
    /// checks the restriction after the probability compare, but every
    /// restricted prototype here is alone in its group, so the order cannot
    /// change a winner.
    fn candidate(&mut self, proto: usize, tx: i64, ty: i64) -> bool {
        if self.tile_blocks(proto, tx, ty) {
            return false;
        }
        let allowed = GLEBA_ENTITIES[proto].tile_restriction();
        allowed.is_empty() || (self.tiles)(tx, ty).is_some_and(|t| allowed.contains(&t.game_name()))
    }

    fn probability(&mut self, proto: usize, tx: i64, ty: i64) -> f64 {
        match GLEBA_ENTITIES[proto] {
            GlebaEntity::CopperStromatolite => self.fields(tx, ty).copper_probability,
            GlebaEntity::IronStromatolite => self.fields(tx, ty).iron_probability,
            GlebaEntity::Stone => self.fields(tx, ty).stone_probability,
            _ => self.plants(tx, ty).probability[proto - FIRST_PLANT],
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
    /// [`Apply::RealSurface`] without stone's tree removal. A control.
    NoTreeRemoval,
    /// [`Apply::RealSurface`] with stone's tree search counting a plant
    /// whose box only touches the stone's tile. A control.
    TreeRemovalTouching,
}

/// Stone's `tree_removal_probability` and `tree_removal_max_distance`, from
/// the `resource` helper in `base/prototypes/entity/resources.lua` (2.1.23).
const TREE_REMOVAL_PROBABILITY: f64 = 0.8;
const TREE_REMOVAL_MAX_DISTANCE: f64 = 32.0 * 32.0;

/// The chance one stone at `(x, y)` (1/256 tile) destroys a tree in its tile,
/// as `ResourceEntity::postSetup` computes it: the probability scaled by
/// `1 - d^2 / max^2`, with `d` the distance in tiles to the nearest starting
/// position, which a preview fixes at the origin. 0 past the max distance.
#[must_use]
pub fn stone_tree_removal(x: i64, y: i64) -> f64 {
    // `(pos - start) * 0.00390625` per axis, then `dy * dy + dx * dx`.
    #[allow(clippy::cast_precision_loss)]
    let (dx, dy) = (x as f64 * 0.003_906_25, y as f64 * 0.003_906_25);
    let d2 = dy * dy + dx * dx;
    let max2 = TREE_REMOVAL_MAX_DISTANCE * TREE_REMOVAL_MAX_DISTANCE;
    if d2 <= max2 {
        (1.0 - d2 / max2) * TREE_REMOVAL_PROBABILITY
    } else {
        0.0
    }
}

/// The surface the apply step tests against: every placed entity, bucketed by
/// the tile its position is on.
struct Surface {
    rule: Apply,
    placed: Vec<GlebaPlaced>,
    /// Whether each placed entity is still there (a stone can remove a plant).
    alive: Vec<bool>,
    /// Each placed plant's odds of surviving the stone rolls so far.
    survival: Vec<f64>,
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
            alive: Vec::new(),
            survival: Vec::new(),
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
        // A placed entity whose box can meet `b` has its position within
        // MAX_REACH of it on each axis, and is bucketed by that position.
        let (x0, x1) = (
            (b[0] - MAX_REACH).div_euclid(one),
            (b[2] + MAX_REACH).div_euclid(one),
        );
        let (y0, y1) = (
            (b[1] - MAX_REACH).div_euclid(one),
            (b[3] + MAX_REACH).div_euclid(one),
        );
        for by in y0..=y1 {
            for bx in x0..=x1 {
                let Some(list) = self.buckets.get(&(bx, by)) else {
                    continue;
                };
                for &k in list {
                    let o = self.placed[k];
                    if self.alive[k]
                        && o.entity.layers() & e.layers() != 0
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
        self.alive.push(true);
        self.survival.push(1.0);
        if entity == GlebaEntity::Stone {
            self.remove_trees(q.x, q.y);
        }
    }

    /// Stone's tree removal (`ResourceEntity::postSetup`): every plant whose
    /// box meets the stone's tile rolls once, against the surface's own
    /// random generator, and is destroyed on a hit. That generator is shared
    /// by the whole surface, so a roll depends on every draw before it in the
    /// whole generation, which a tile of the preview cannot know. So this is
    /// the expected outcome instead: each roll multiplies the plant's odds of
    /// surviving, and it goes when they fall below one half.
    fn remove_trees(&mut self, x: i64, y: i64) {
        let edge = match self.rule {
            Apply::RealSurface => 1,
            Apply::TreeRemovalTouching => 0,
            Apply::StrictOverlap | Apply::Preview | Apply::NoTreeRemoval => return,
        };
        let p = stone_tree_removal(x, y);
        if p <= 0.0 {
            return;
        }
        let one = super::generate::FIXED_ONE;
        // The stone's box widened outward to whole tiles: its own tile.
        let (tx, ty) = (x.div_euclid(one), y.div_euclid(one));
        let b = [tx * one, ty * one, (tx + 1) * one, (ty + 1) * one];
        let (x0, x1) = (
            (b[0] - MAX_REACH).div_euclid(one),
            (b[2] + MAX_REACH).div_euclid(one),
        );
        let (y0, y1) = (
            (b[1] - MAX_REACH).div_euclid(one),
            (b[3] + MAX_REACH).div_euclid(one),
        );
        for by in y0..=y1 {
            for bx in x0..=x1 {
                let Some(list) = self.buckets.get(&(bx, by)) else {
                    continue;
                };
                for &k in list {
                    let o = self.placed[k];
                    if self.alive[k]
                        && o.entity.is_plant()
                        && b[0] + edge <= o.bounds[2]
                        && o.bounds[0] + edge <= b[2]
                        && b[1] + edge <= o.bounds[3]
                        && o.bounds[1] + edge <= b[3]
                    {
                        self.survival[k] *= 1.0 - p;
                        if self.survival[k] < 0.5 {
                            self.alive[k] = false;
                        }
                    }
                }
            }
        }
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

/// The groups the generator runs for this graph: every one, or, with the
/// `gleba_plants` control at size 0, [`GLEBA_GROUPS_NO_PLANTS`].
fn groups(stack: &GlebaStack) -> &'static [&'static [usize]] {
    if stack.plants_size() > 0.0 {
        &GLEBA_GROUPS
    } else {
        &GLEBA_GROUPS_NO_PLANTS
    }
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
            generate_chunk(cx, cy, groups(stack), &GLEBA_AUTOPLACERS, &mut inputs)
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
    surface
        .placed
        .into_iter()
        .zip(surface.alive)
        .filter_map(|(p, alive)| alive.then_some(p))
        .collect()
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
