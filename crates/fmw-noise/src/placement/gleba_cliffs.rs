//! Gleba's cliffs as a REAL surface places them (#454, the cliffs slice), and
//! the plants and stromatolites they block.
//!
//! A real surface applies each chunk's cliffs before its entities
//! (`EntityMapGenerationTask::apply`: `applyCliffs`, then `applyEntities`).
//! The port, graded on `oracle-gleba-real-surface-cliffs.seed123456.json`:
//!
//! 1. **Placement** with no rejection: real map generation tests no
//!    collision in `tryToAddCliff` (`cliffs::connections::ApplyCollision`).
//! 2. **`applyCliffs`**: a queued cliff whose box meets a blocking tile is
//!    created and then destroyed, cascading into its neighbours, and the
//!    chunk's outer ring runs `updateConnections` (`apply_cliff_connections`).
//! 3. **Stone removes cliffs** (`ResourceEntity::postSetup`,
//!    `cliff_removal_probability` 1): a cliff whose oriented box reaches a
//!    stone's tile goes. Folded into step 2's test with the QUEUED
//!    orientation, the reading the Vulcanus work graded best (#414); here it
//!    is exact, where the live orientation leaves one cliff wrong.
//! 4. **Cliffs block entities**: a plant or stromatolite whose box meets a
//!    standing cliff's oriented box, on a shared layer, is not placed.
//!
//! Steps 1 to 3 place all 2,484 cliffs of the 1024 window at the game's
//! position and orientation, and nothing else.

use std::collections::{BTreeMap, BTreeSet};

use crate::at::At;
use crate::cliffs::collision::{
    box_collide, get_aabb, placed_box, rotation_word, tile_collides, FixedBox, NO_ROTATION,
};
use crate::cliffs::connections::{apply_cliff_connections, ApplyCollision, CliffConnectionOptions};
use crate::cliffs::gleba_fields::{
    GlebaCliffFields, GLEBA_CLIFF_ELEVATION_0, GLEBA_CLIFF_ELEVATION_INTERVAL,
    GLEBA_CLIFF_RICHNESS, GLEBA_CLIFF_SMOOTHING,
};
use crate::cliffs::placement::{CliffBands, CliffPlacement, TileCollision};
use crate::cliffs::vulcanus_ore_rejection::reaches_an_occupied_tile;
use crate::eval::math::f32r;
use crate::expressions::gleba_stack::{GlebaStack, KeptInputs};
use crate::placement::gleba::{layer, tile_layers, GlebaTiles, Obstacles};

/// The cliff's collision layers: the engine default for a `cliff`, which
/// `cliff-gleba` does not override.
pub const CLIFF_LAYERS: u32 = layer::ITEM
    | layer::MELTABLE
    | layer::OBJECT
    | layer::PLAYER
    | layer::WATER_TILE
    | layer::IS_LOWER_OBJECT
    | layer::IS_OBJECT;

/// `cliff-gleba`'s `map_color`.
pub const GLEBA_CLIFF_COLOR: [u8; 3] = [144, 119, 87];

/// Stone's collision half-extent, 0.1 as the game holds it: 25/256.
const STONE_HALF: f64 = 25.0 / 256.0;

/// The `gleba_cliff` control. Neutral is 1 for both.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlebaCliffControls {
    /// `control:gleba_cliff:frequency`: divides the elevation interval.
    pub frequency: f64,
    /// `control:gleba_cliff:size`, the continuity: multiplies the cliff
    /// richness, and 0 turns cliffs off.
    pub continuity: f64,
}

impl Default for GlebaCliffControls {
    fn default() -> Self {
        Self {
            frequency: 1.0,
            continuity: 1.0,
        }
    }
}

/// Each orientation's oriented-box AABB relative to the cell centre, in
/// 1/256 tile (left, top, right, bottom), as `get_aabb` gives it at the cell
/// centred on (2, 2.5). `tests::the_footprint_table_is_the_geometry_at_the_reference_cell`
/// pins it; `test/wasmGlebaEntityParity.spec.ts` carries the same table.
pub const CLIFF_FOOTPRINT_AABB: [[i32; 4]; 20] = [
    [-512, -384, 512, 384],
    [-256, -512, 256, 512],
    [-512, -128, 512, 128],
    [-256, -512, 256, 512],
    [-896, -767, 256, 383],
    [-255, -767, 895, 383],
    [-257, -127, 639, 767],
    [-639, -128, 255, 766],
    [-895, -383, 255, 767],
    [-640, -767, 256, 127],
    [-255, -767, 639, 127],
    [-257, -383, 895, 767],
    [-768, -383, 0, 383],
    [-1, -383, 767, 383],
    [-1, -127, 639, 511],
    [-640, -128, 2, 512],
    [-255, -639, 511, 127],
    [-256, -127, 510, 639],
    [-511, -128, 255, 638],
    [-511, -639, 255, 127],
];

/// One cliff a real surface keeps.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlebaCliff {
    pub x: f64,
    pub y: f64,
    pub orientation: u8,
}

impl GlebaCliff {
    /// The chunk the cliff's position is in.
    #[must_use]
    pub fn chunk(&self) -> (i64, i64) {
        #[allow(clippy::cast_possible_truncation)]
        let (tx, ty) = (self.x.floor() as i64, self.y.floor() as i64);
        (tx.div_euclid(32), ty.div_euclid(32))
    }

    /// The oriented box and its rotation word.
    #[must_use]
    pub fn oriented(&self) -> (FixedBox, crate::cliffs::collision::RotationWord) {
        (
            placed_box(self.orientation, self.x, self.y),
            rotation_word(self.orientation),
        )
    }

    /// The tiles a map paints for it: those under its orientation's box
    /// AABB, `floor` of the low edge to `ceil(high) - 1`, from
    /// [`CLIFF_FOOTPRINT_AABB`]. Returns (x0, x1, y0, y1).
    ///
    /// A drawing rule, not the collision geometry: the rotated box's AABB is
    /// rounded in fixed point at the cliff's absolute position, so it moves
    /// by a 1/256 tile from cell to cell and can cross a tile line. Painting
    /// from one fixed table keeps the picture the same for every cell, so a
    /// spec can draw the game's own cliffs by the same rule.
    #[must_use]
    pub fn footprint(&self) -> (i64, i64, i64, i64) {
        let o = CLIFF_FOOTPRINT_AABB[usize::from(self.orientation)];
        #[allow(clippy::cast_possible_truncation)]
        let (px, py) = ((self.x * 256.0) as i64, (self.y * 256.0) as i64);
        let f = |v: i64| v.div_euclid(256);
        (
            f(px + i64::from(o[0])),
            f(px + i64::from(o[2]) - 1),
            f(py + i64::from(o[1])),
            f(py + i64::from(o[3]) - 1),
        )
    }
}

/// Levers on the cliff pass. [`Default`] is the game; each `false` is a
/// control the tests use to show the rule matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlebaCliffRules {
    /// Destroy a cliff whose box meets a blocking tile.
    pub tile_half: bool,
    /// Destroy a cliff whose box reaches a stone's tile.
    pub stone_removal: bool,
    /// Run `updateConnections` on each chunk's outer ring.
    pub connections: bool,
}

impl Default for GlebaCliffRules {
    fn default() -> Self {
        Self {
            tile_half: true,
            stone_removal: true,
            connections: true,
        }
    }
}

/// The tile half of `wouldCollide`, and stone's removal, on given tiles.
struct ApplyTest<'a> {
    tiles: Blocking<'a>,
    stones: &'a BTreeSet<(i64, i64)>,
    rules: GlebaCliffRules,
}

/// Tiles a cliff may not stand on: any whose layers meet the cliff's. An
/// unknown tile blocks, so a box past the computed area is refused rather
/// than placed on a guess.
struct Blocking<'a>(GlebaTiles<'a>);

impl TileCollision for Blocking<'_> {
    fn collides(&self, x: i64, y: i64) -> bool {
        (self.0)(x, y).is_none_or(|t| tile_layers(t) & CLIFF_LAYERS != 0)
    }
}

impl ApplyCollision for ApplyTest<'_> {
    fn collides(&self, orientation: u8, x: f64, y: f64) -> bool {
        if self.rules.tile_half && tile_collides(orientation, x, y, &self.tiles) {
            return true;
        }
        if !self.rules.stone_removal {
            return false;
        }
        let cliff = placed_box(orientation, x, y);
        let rot = rotation_word(orientation);
        let aabb = get_aabb(&cliff, rot);
        reaches_an_occupied_tile(&cliff, rot, &aabb, STONE_HALF, |tx, ty| {
            self.stones.contains(&(tx, ty))
        })
    }
}

/// Every tile in chunks `cx` by `cy` (inclusive) that holds stone: its
/// probability is exactly 1 (so any roll places it), its richness is above
/// 0, and its tile takes a resource. Stone needs no stream
/// (`placement::gleba`).
#[must_use]
pub fn stone_tiles(
    stack: &GlebaStack,
    tiles: GlebaTiles<'_>,
    kept: Option<&KeptInputs>,
    cx: (i64, i64),
    cy: (i64, i64),
) -> BTreeSet<(i64, i64)> {
    if stack.stone_size() <= 0.0 {
        return BTreeSet::new();
    }
    let mut out = BTreeSet::new();
    for ty in cy.0 * 32..(cy.1 + 1) * 32 {
        for tx in cx.0 * 32..(cx.1 + 1) * 32 {
            let land = tiles(tx, ty).is_some_and(|t| tile_layers(t) & layer::RESOURCE == 0);
            if !land {
                continue;
            }
            #[allow(clippy::cast_possible_truncation)]
            let (x, y) = (tx as i32, ty as i32);
            let f = match kept.and_then(|k| k.get(x, y)) {
                Some(t) => stack.resources_from(At::tile(x, y), &t),
                None => stack.resources_at(At::tile(x, y)).1,
            };
            if f.stone_probability >= 1.0 && f.stone_richness > 0.0 {
                out.insert((tx, ty));
            }
        }
    }
    out
}

/// The cliffs a real surface keeps whose cell is in chunks `cx` by `cy`
/// (inclusive). `tiles` must cover those chunks and one more ring with
/// their corrected tiles, and `stones` the same chunks and one tile past
/// them: the connection pass reads each kept chunk's neighbours, so cells
/// are placed one chunk further out and dropped after.
#[must_use]
pub fn gleba_cliffs(
    stack: &GlebaStack,
    seed0: u32,
    controls: &GlebaCliffControls,
    tiles: GlebaTiles<'_>,
    stones: &BTreeSet<(i64, i64)>,
    cx: (i64, i64),
    cy: (i64, i64),
) -> Vec<GlebaCliff> {
    gleba_cliffs_with(
        stack,
        seed0,
        controls,
        tiles,
        stones,
        (cx, cy),
        GlebaCliffRules::default(),
    )
}

/// [`gleba_cliffs`] under `rules`.
#[must_use]
pub fn gleba_cliffs_with(
    stack: &GlebaStack,
    seed0: u32,
    controls: &GlebaCliffControls,
    tiles: GlebaTiles<'_>,
    stones: &BTreeSet<(i64, i64)>,
    (cx, cy): ((i64, i64), (i64, i64)),
    rules: GlebaCliffRules,
) -> Vec<GlebaCliff> {
    if controls.continuity <= 0.0 || controls.frequency <= 0.0 {
        return Vec::new();
    }
    let richness = f32r(GLEBA_CLIFF_RICHNESS * controls.continuity);
    let fields = GlebaCliffFields::new(stack, seed0, richness);
    let placement = CliffPlacement::new(
        &fields,
        CliffBands {
            elevation0: GLEBA_CLIFF_ELEVATION_0,
            interval: GLEBA_CLIFF_ELEVATION_INTERVAL / controls.frequency,
            smoothing: GLEBA_CLIFF_SMOOTHING,
            ..CliffBands::default()
        },
    );
    #[allow(clippy::cast_precision_loss)]
    let (x0, y0, x1, y1) = (
        ((cx.0 - 1) * 32) as f64,
        ((cy.0 - 1) * 32) as f64,
        ((cx.1 + 2) * 32) as f64,
        ((cy.1 + 2) * 32) as f64,
    );
    let placed = placement.placed_cells(x0, y0, x1, y1);
    let test = ApplyTest {
        tiles: Blocking(tiles),
        stones,
        rules,
    };
    let kept = |c: &GlebaCliff| {
        let (kx, ky) = c.chunk();
        (cx.0..=cx.1).contains(&kx) && (cy.0..=cy.1).contains(&ky)
    };
    apply_cliff_connections(
        &placed,
        &CliffConnectionOptions {
            collides: Some(&test),
            no_update_connections: !rules.connections,
            ..CliffConnectionOptions::default()
        },
    )
    .into_iter()
    .map(|c| GlebaCliff {
        x: c.x,
        y: c.y,
        orientation: c.orientation,
    })
    .filter(kept)
    .collect()
}

/// Cliffs as obstacles to the entity apply step: an entity is blocked by a
/// cliff of its own chunk or an earlier one in row-major order (a later
/// chunk's cliffs are not on the surface yet), whose oriented box meets the
/// entity's box, when their layers meet.
pub struct GlebaCliffObstacles {
    by_tile: BTreeMap<(i64, i64), Vec<GlebaCliff>>,
}

impl GlebaCliffObstacles {
    #[must_use]
    pub fn new(cliffs: &[GlebaCliff]) -> Self {
        let mut by_tile: BTreeMap<(i64, i64), Vec<GlebaCliff>> = BTreeMap::new();
        for c in cliffs {
            #[allow(clippy::cast_possible_truncation)]
            by_tile
                .entry((c.x.floor() as i64, c.y.floor() as i64))
                .or_default()
                .push(*c);
        }
        Self { by_tile }
    }
}

impl Obstacles for GlebaCliffObstacles {
    fn blocks(&self, layers: u32, b: [i64; 4], chunk: (i64, i64)) -> bool {
        if layers & CLIFF_LAYERS == 0 {
            return false;
        }
        #[allow(clippy::cast_possible_truncation)]
        let eb: FixedBox = [b[0] as i32, b[1] as i32, b[2] as i32, b[3] as i32];
        // A cliff's box reaches 3.5 tiles from its position
        // (`CLIFF_FOOTPRINT_AABB`: 896/256 at the most), so a cliff that can
        // meet the entity's box has its position's tile within four tiles of
        // that box's edges.
        let (tx0, tx1) = (b[0].div_euclid(256) - 4, b[2].div_euclid(256) + 4);
        let (ty0, ty1) = (b[1].div_euclid(256) - 4, b[3].div_euclid(256) + 4);
        for ty in ty0..=ty1 {
            for tx in tx0..=tx1 {
                let Some(list) = self.by_tile.get(&(tx, ty)) else {
                    continue;
                };
                for c in list {
                    let (k, kc) = (c.chunk(), chunk);
                    if (k.1, k.0) > (kc.1, kc.0) {
                        continue;
                    }
                    let (cb, rot) = c.oriented();
                    if box_collide(&cb, rot, &eb, NO_ROTATION) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cliffs::catalog::CLIFF_ORIENTATION_NAMES;

    /// The footprint table is the oriented boxes' AABBs at the reference
    /// cell (2, 2.5), so it describes the real geometry there.
    #[test]
    fn the_footprint_table_is_the_geometry_at_the_reference_cell() {
        for (o, name) in CLIFF_ORIENTATION_NAMES.iter().enumerate() {
            #[allow(clippy::cast_possible_truncation)]
            let c = GlebaCliff {
                x: 2.0,
                y: 2.5,
                orientation: o as u8,
            };
            let (b, rot) = c.oriented();
            let a = get_aabb(&b, rot);
            assert_eq!(
                [a[0] - 512, a[1] - 640, a[2] - 512, a[3] - 640],
                CLIFF_FOOTPRINT_AABB[o],
                "{name}"
            );
        }
    }
}
