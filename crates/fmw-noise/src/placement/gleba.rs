//! Gleba's stone, two stromatolites, twelve plants and two pentapod nests,
//! placed as a REAL surface places them (#454, slices 3, 4 and 6): the game's own per-chunk
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
//! | `b[enemy]-c[spawner]-a[large]` | `gleba-spawner` | off grid | +-601 square |
//! | `b[enemy]-c[spawner]-b[small]` | `gleba-spawner-small` | off grid | +-601 square |
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
//! as in the game. But it still draws one roll for every land tile, so the
//! nests, which follow it, start where its draws end.
//!
//! **The nests** are the last two groups, each alone (`expressions::gleba_nests`
//! holds their probabilities). Their probability reads `random_penalty`, a
//! batch op whose batch is the chunk, so [`GlebaChunkInputs`] evaluates it
//! once for all 1,024 tiles of a chunk the first time a nest asks. Both read
//! the same penalised value at a tile, as the game's one noise program does.
//! The small nest's map-gen box (+-2.35) is larger than its collision box
//! (+-1.35); the generator and the apply step use the map-gen box.
//!
//! **A plant or nest control at size 0 skips its groups.** The generator does
//! not run those autoplacers, so they spend no draws: with `gleba_plants` at
//! size 0 the nests read the stream right after the stromatolites and stone.
//! Stone's group runs at every size, spending its draws even where nothing
//! places ([`gleba_groups`], all three measured).
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
use crate::expressions::gleba_nests::{chunk_penalties, nest_probabilities, NestProbabilities};
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
    GlebaSpawner,
    GlebaSpawnerSmall,
}

/// Every entity, indexed as the generator's prototype index.
pub const GLEBA_ENTITIES: [GlebaEntity; 17] = [
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
    GlebaEntity::GlebaSpawner,
    GlebaEntity::GlebaSpawnerSmall,
];

/// The prototype index of the first plant: plant `k` of [`PLANTS`] is
/// `FIRST_PLANT + k`.
pub const FIRST_PLANT: usize = 3;

/// The prototype index of `gleba-spawner`; `gleba-spawner-small` follows it.
pub const FIRST_NEST: usize = 15;

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
pub const GLEBA_AUTOPLACERS: [Autoplacer; 17] = [
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
    // Both nests: 2.34765625 is 601 / 256. The small nest's collision box is
    // +-1.34765625, but it declares a `map_generator_bounding_box` the size
    // of the large one's, and the generator and apply step read that.
    off_grid(-601, -601, 601, 601), // gleba-spawner
    off_grid(-601, -601, 601, 601), // gleba-spawner-small
];

/// The box a placed entity occupies on the surface: its `collision_box`, in
/// 1/256 tile, relative to its position, as (left, top, right, bottom). The
/// apply step tests a NEW entity's map-gen box (`Surface::mapGeneratorWouldCollide`)
/// against the collision boxes of the entities already there
/// (`Surface::collide`). Only the small nest's two boxes differ: measured,
/// its +-2.35 map-gen box would take two copper stromatolites of the next
/// chunk that the game keeps beside it, at (-286.6875, 19.125) and
/// (-287.25, 21.4375), and its +-1.35 collision box does not (`fixtures`).
#[must_use]
pub fn collision_box(proto: usize) -> MapGenBox {
    if GLEBA_ENTITIES[proto] == GlebaEntity::GlebaSpawnerSmall {
        MapGenBox::centred(345, 345)
    } else {
        GLEBA_AUTOPLACERS[proto].map_gen_box
    }
}

/// The farthest any entity's box but a nest's reaches from its position, on
/// either axis, in 1/256 tile: hairyclubnub's and boompuff's 230. The apply
/// step searches this far past a new box for entities that might meet it.
const MAX_REACH: i64 = 230;

/// The farthest a nest's box reaches, in 1/256 tile. Nests are bucketed apart,
/// so the other entities' searches stay at [`MAX_REACH`].
const NEST_REACH: i64 = 601;

/// The groups, in the order the chunk's stream serves them: the two
/// stromatolites, each plant alone, stone, then each nest alone.
pub const GLEBA_GROUPS: [&[usize]; 16] = [
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
    &[15],
    &[16],
];

/// The groups the generator runs: with `plants` false (`gleba_plants` at
/// size 0) it skips the twelve plant groups, and with `nests` false
/// (`gleba_enemy_base` at size 0) the two nest groups, so they spend no
/// draws. Stone's group runs at every size. All three measured on the whole
/// window (`fixtures::gleba_nests`): with the plants at size 0 the nests
/// match the game (77 of 77) only with the plant groups skipped (0 of 77
/// with them run); with the enemy control at size 0 the game has no nest,
/// where running the groups would place 27; but with stone at size 0 the
/// nests match (67 of 67) only with stone's group RUN, spending one draw per
/// land tile though nothing places (11 of 67 with it skipped).
///
/// That is `prepareAutoplacers` (`docs/noise/entity-generation-NOTES.md`,
/// section 1): it drops an autoplacer whose own autoplace `control` is at
/// size 0. Every plant carries `gleba_plants` and both nests
/// `gleba_enemy_base`; stone's autoplace carries no control (the resource
/// helper puts its size gate inside the probability instead), and neither do
/// the stromatolites, so they are never dropped.
#[must_use]
pub fn gleba_groups(plants: bool, nests: bool) -> Vec<&'static [usize]> {
    GLEBA_GROUPS
        .iter()
        .copied()
        .filter(|g| {
            let e = GLEBA_ENTITIES[g[0]];
            if e.is_plant() {
                plants
            } else if e.is_nest() {
                nests
            } else {
                true
            }
        })
        .collect()
}

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
    /// The two pentapod nests.
    Enemies,
}

impl GlebaEntity {
    /// The prototype's name in the game's own vocabulary.
    #[must_use]
    pub fn game_name(self) -> &'static str {
        match self {
            Self::CopperStromatolite => "copper-stromatolite",
            Self::IronStromatolite => "iron-stromatolite",
            Self::Stone => "stone",
            Self::GlebaSpawner => "gleba-spawner",
            Self::GlebaSpawnerSmall => "gleba-spawner-small",
            p => PLANTS[p as usize - FIRST_PLANT],
        }
    }

    /// Whether the entity is one of the twelve plants.
    #[must_use]
    pub fn is_plant(self) -> bool {
        (FIRST_PLANT..FIRST_PLANT + PLANTS.len()).contains(&(self as usize))
    }

    /// Whether the entity is one of the two pentapod nests.
    #[must_use]
    pub fn is_nest(self) -> bool {
        matches!(self, Self::GlebaSpawner | Self::GlebaSpawnerSmall)
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
            // Both nests: they stand only on wetland, like the stromatolites.
            Self::GlebaSpawner | Self::GlebaSpawnerSmall => {
                GROUND_TILE | IS_LOWER_OBJECT | IS_OBJECT | OBJECT | PLAYER
            }
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
        } else if self.is_nest() {
            GlebaLayer::Enemies
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
    /// The nests have no `map_color` either; the game's own Gleba preview
    /// PNG draws every one of them (255, 25, 25), its `default_enemy_color`
    /// `{1, 0.1, 0.1}` (`utility-constants.lua`) with 25.5 truncated.
    #[must_use]
    pub fn paint(self) -> GlebaPaint {
        match self {
            Self::GlebaSpawner | Self::GlebaSpawnerSmall => GlebaPaint::Solid(NEST_MAP_COLOR),
            Self::CopperStromatolite | Self::IronStromatolite => GlebaPaint::Solid([129, 105, 78]),
            Self::Stone => GlebaPaint::Solid([175, 155, 108]),
            Self::YumakoTree | Self::Jellystem => GlebaPaint::Solid([255, 255, 255]),
            _ => GlebaPaint::Blend(crate::trees::catalog::TREE_MAP_COLOR, 102),
        }
    }

    /// The order a render paints entities in: the blended trees first, then
    /// the two white plants, then stone and the stromatolites, then the nests. Footprints are
    /// whole tiles, so two entities whose boxes do not meet can still share a
    /// tile; a fixed class order makes the pixels independent of the order
    /// entities were placed in (blends of one colour commute).
    #[must_use]
    pub fn paint_pass(self) -> u8 {
        match self.paint() {
            GlebaPaint::Blend(..) => 0,
            GlebaPaint::Solid(_) if self.is_plant() => 1,
            GlebaPaint::Solid(_) if self.is_nest() => 3,
            GlebaPaint::Solid(_) => 2,
        }
    }
}

/// The colour a map draws a pentapod nest in.
pub const NEST_MAP_COLOR: [u8; 3] = [255, 25, 25];

/// One placed entity: its position and the box it occupies, its collision
/// box ([`collision_box`]), in 1/256 tile.
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
    /// `enemy_autoplace_base(0, 8)` at every tile, one batch for the chunk,
    /// made the first time a nest asks.
    penalties: Option<Vec<f64>>,
    nests: Vec<Option<NestProbabilities>>,
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
            penalties: None,
            nests: vec![None; TILES_PER_CHUNK],
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

    /// Both nest probabilities at a tile of the chunk. The penalty is one
    /// batch over the whole chunk, so the first call evaluates
    /// `enemy_base_probability` at all 1,024 tiles.
    fn nests(&mut self, tx: i64, ty: i64) -> NestProbabilities {
        let i = self.index(tx, ty);
        if let Some(p) = self.nests[i] {
            return p;
        }
        let (x0, y0) = (self.x0, self.y0);
        let nests = self.stack.nests();
        let penalties = self.penalties.get_or_insert_with(|| {
            #[allow(clippy::cast_precision_loss, clippy::cast_possible_wrap)]
            let source: Vec<f64> = (0..TILES_PER_CHUNK as i64)
                .map(|k| nests.penalty_source((x0 + k % CHUNK) as f64, (y0 + k / CHUNK) as f64))
                .collect();
            chunk_penalties(x0.div_euclid(CHUNK), y0.div_euclid(CHUNK), &source)
        });
        let penalised = penalties[i];
        let t = self.inputs(tx, ty);
        #[allow(clippy::cast_possible_truncation)]
        let at = At::tile(tx as i32, ty as i32);
        let p = nest_probabilities(penalised, &self.stack.nest_inputs(at, &t));
        self.nests[i] = Some(p);
        p
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
            GlebaEntity::GlebaSpawner => self.nests(tx, ty).spawner,
            GlebaEntity::GlebaSpawnerSmall => self.nests(tx, ty).spawner_small,
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
    /// [`Apply::RealSurface`] with stone's tree search requiring a real
    /// overlap, so a plant whose box only touches the stone's tile is not
    /// searched. A control: the game removed such a plant (`fixtures`).
    TreeRemovalOverlap,
    /// [`Apply::RealSurface`] with a placed small nest occupying its map-gen
    /// box rather than its collision box. A control: the game keeps
    /// entities of later chunks that only the larger box would meet
    /// (`fixtures`).
    NestMapGenBox,
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

/// Things already on the surface that are not entities this module places:
/// the cliffs, which a real surface applies before a chunk's entities.
/// `chunk` is the chunk whose entities are being applied, so an
/// implementation can tell which cliffs stand by then.
pub trait Obstacles {
    /// Whether an entity with collision `layers` and map-gen box `bounds`
    /// (1/256 tile) meets an obstacle.
    fn blocks(&self, layers: u32, bounds: [i64; 4], chunk: (i64, i64)) -> bool;
}

/// The surface the apply step tests against: every placed entity, bucketed by
/// the tile its position is on.
struct Surface<'a> {
    obstacles: Option<&'a dyn Obstacles>,
    chunk: (i64, i64),
    rule: Apply,
    placed: Vec<GlebaPlaced>,
    /// Whether each placed entity is still there (a stone can remove a plant).
    alive: Vec<bool>,
    /// Each placed plant's odds of surviving the stone rolls so far.
    survival: Vec<f64>,
    buckets: BTreeMap<(i64, i64), Vec<usize>>,
    /// The nests, bucketed apart: their boxes reach [`NEST_REACH`].
    nest_buckets: BTreeMap<(i64, i64), Vec<usize>>,
}

impl Surface<'_> {
    /// Whether `b` meets the box of a placed entity on a shared layer. Boxes
    /// that only touch collide (measured on Aquilo, and needed here: see
    /// `fixtures`).
    fn new(rule: Apply) -> Self {
        Self {
            obstacles: None,
            chunk: (0, 0),
            rule,
            placed: Vec::new(),
            alive: Vec::new(),
            survival: Vec::new(),
            buckets: BTreeMap::new(),
            nest_buckets: BTreeMap::new(),
        }
    }

    fn collides(&self, e: GlebaEntity, b: [i64; 4]) -> bool {
        if self.rule == Apply::Preview {
            return false;
        }
        self.collides_in(&self.buckets, MAX_REACH, e, b)
            || self.collides_in(&self.nest_buckets, NEST_REACH, e, b)
    }

    /// [`Surface::collides`] against the entities of one bucket map, whose
    /// boxes reach at most `reach` from their positions.
    fn collides_in(
        &self,
        buckets: &BTreeMap<(i64, i64), Vec<usize>>,
        reach: i64,
        e: GlebaEntity,
        b: [i64; 4],
    ) -> bool {
        // Touching boxes meet; under the control they must overlap.
        let edge = i64::from(self.rule == Apply::StrictOverlap);
        let one = super::generate::FIXED_ONE;
        // A placed entity whose box can meet `b` has its position within
        // `reach` of it on each axis, and is bucketed by that position.
        let (x0, x1) = (
            (b[0] - reach).div_euclid(one),
            (b[2] + reach).div_euclid(one),
        );
        let (y0, y1) = (
            (b[1] - reach).div_euclid(one),
            (b[3] + reach).div_euclid(one),
        );
        for by in y0..=y1 {
            for bx in x0..=x1 {
                let Some(list) = buckets.get(&(bx, by)) else {
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
        // The new entity is tested with its map-gen box, and occupies its
        // collision box once placed.
        let test = q.bounds(&GLEBA_AUTOPLACERS);
        if self.collides(entity, test) {
            return;
        }
        if self.rule != Apply::Preview
            && self
                .obstacles
                .is_some_and(|o| o.blocks(entity.layers(), test, self.chunk))
        {
            return;
        }
        let c = if self.rule == Apply::NestMapGenBox {
            GLEBA_AUTOPLACERS[q.proto].map_gen_box
        } else {
            collision_box(q.proto)
        };
        let bounds = [q.x + c.left, q.y + c.top, q.x + c.right, q.y + c.bottom];
        let one = super::generate::FIXED_ONE;
        let key = (q.x.div_euclid(one), q.y.div_euclid(one));
        let buckets = if entity.is_nest() {
            &mut self.nest_buckets
        } else {
            &mut self.buckets
        };
        buckets.entry(key).or_default().push(self.placed.len());
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
    /// box meets the stone's tile, touching included, rolls once, against the surface's own
    /// random generator, and is destroyed on a hit. That generator is shared
    /// by the whole surface, so a roll depends on every draw before it in the
    /// whole generation, which a tile of the preview cannot know. So this is
    /// the expected outcome instead: each roll multiplies the plant's odds of
    /// surviving, and it goes when they fall below one half.
    fn remove_trees(&mut self, x: i64, y: i64) {
        let edge = match self.rule {
            Apply::RealSurface | Apply::NestMapGenBox => 0,
            Apply::TreeRemovalOverlap => 1,
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

/// [`place_chunks`] with obstacles already on the surface (the cliffs).
#[must_use]
pub fn place_chunks_with(
    stack: &GlebaStack,
    tiles: GlebaTiles<'_>,
    kept: Option<&KeptInputs>,
    chunks: &[(i64, i64)],
    obstacles: Option<&dyn Obstacles>,
) -> Vec<GlebaPlaced> {
    apply_with(
        &queue_chunks(stack, tiles, kept, chunks),
        chunks,
        Apply::RealSurface,
        obstacles,
    )
}

/// The groups the generator runs for this graph: every one but those of a
/// control at size 0 ([`gleba_groups`]).
fn groups(stack: &GlebaStack) -> Vec<&'static [usize]> {
    gleba_groups(stack.plants_size() > 0.0, stack.nests().size() > 0.0)
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
    queue_chunks_grouped(stack, tiles, kept, chunks, &groups(stack))
}

/// [`queue_chunks`] running exactly `groups`, whatever the controls say: the
/// control the tests use to show that a size-0 control's groups are skipped.
#[must_use]
pub fn queue_chunks_grouped(
    stack: &GlebaStack,
    tiles: GlebaTiles<'_>,
    kept: Option<&KeptInputs>,
    chunks: &[(i64, i64)],
    groups: &[&[usize]],
) -> Vec<Vec<Queued>> {
    chunks
        .iter()
        .map(|&(cx, cy)| {
            let mut inputs = GlebaChunkInputs::new(stack, tiles, kept, cx, cy);
            generate_chunk(cx, cy, groups, &GLEBA_AUTOPLACERS, &mut inputs)
        })
        .collect()
}

/// Apply queues in order under `rule`. Returns every entity kept.
#[must_use]
pub fn apply(queues: &[Vec<Queued>], rule: Apply) -> Vec<GlebaPlaced> {
    apply_with(queues, &[], rule, None)
}

/// [`apply`] with obstacles: `chunks[i]` is the chunk `queues[i]` belongs to.
#[must_use]
pub fn apply_with(
    queues: &[Vec<Queued>],
    chunks: &[(i64, i64)],
    rule: Apply,
    obstacles: Option<&dyn Obstacles>,
) -> Vec<GlebaPlaced> {
    let mut surface = Surface::new(rule);
    surface.obstacles = obstacles;
    for (i, queue) in queues.iter().enumerate() {
        surface.chunk = chunks.get(i).copied().unwrap_or((0, 0));
        for q in queue {
            surface.apply(q);
        }
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

    /// Stone's removal odds fall with the square of the distance from spawn,
    /// reach 0 at 1,024 tiles, and stay 0 past it, the same in every
    /// direction. The replay cannot see the falloff (every covered plant in
    /// its window has odds below one half either way), so it is pinned here.
    #[test]
    fn stone_tree_removal_falls_off_with_distance() {
        let t = |x: f64, y: f64| stone_tree_removal((x * 256.0) as i64, (y * 256.0) as i64);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-12;
        assert!(close(t(0.0, 0.0), 0.8));
        assert!(close(t(512.0, 0.0), 0.6));
        assert!(close(t(0.0, -512.0), 0.6));
        // 500 tiles out: 0.8 * (1 - 500^2 / 1024^2).
        assert!(close(t(-300.0, 400.0), 0.609_265_136_718_75));
        assert!(close(t(1024.0, 0.0), 0.0));
        assert_eq!(t(1024.5, 0.0), 0.0);
        assert_eq!(t(-2000.0, -2000.0), 0.0);
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
