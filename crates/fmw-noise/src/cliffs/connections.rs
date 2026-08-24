//! `Cliff::updateConnections` and `Cliff::onDestroy` - the APPLY-time pass that
//! trims a cliff run back to where its connections actually resolve.
//!
//! Ported from `src/noise/cliffs/cliffConnections.ts`. Where
//! [`super::placement`] models `crossingsForChunk` and `generateCliffs` -
//! deciding the crossings and queueing a cliff per placing cell - this models
//! what happens **after** that, in `EntityMapGenerationTask::applyCliffs`:
//!
//! ```text
//! for each queued CliffAddition {u16 protoId, u8 orientation, MapPosition, bool}:
//!     collided = Surface::wouldCollide(proto, position, orientation)
//!     entity   = proto->createEntity(spec)
//!     addEntityToSurface(surface, entity)
//!     if (collided)          -> list A
//!     else if (!record.bool) -> list B          // record.bool is !onChunkBorder
//! for e in list A: e->forceDestroy()
//! for e in list B: e->updateConnections()
//! ```
//!
//! Two things follow that are easy to miss:
//!
//! **The fifth argument of `tryToAddCliff` is what selects list B.**
//! `generateCliffs` computes `onChunkBorder = (cx==0 || cy==0 || cx==7 ||
//! cy==7)` over the chunk's 8x8 cells and passes `!onChunkBorder`; `applyCliffs`
//! skips `updateConnections` when that byte is set. So this whole pass runs on
//! the chunk's outer ring and nowhere else. An earlier note read the flag as
//! "measured not to matter for placement" - true of `tryToAddCliff`, which
//! stores it and never reads it, and false of the queue's consumer.
//!
//! **List B is drained after the whole chunk is on the surface**, so within a
//! chunk there is no placement-order dependence.
//!
//! ## The orientation is read twice, and that is the whole reason a cell can
//! lose two ends in one pass
//!
//! `Cliff::updateConnections` reads the orientation it ITERATES once, before
//! the loop, and re-reads the one it COMPARES from `this+0x80` inside it. So a
//! `destroyEnd` earlier in the loop is visible to the sides after it. This port
//! does the same, and [`tests::a_cell_can_lose_both_ends_in_one_pass`] is what
//! keeps that from silently collapsing into a snapshot.
//!
//! ## The `this+0x83` gate is `proto->place_as_crater == nullptr`
//!
//! The constructor computes it in one instruction on `proto + 0xb90`, and
//! `CliffPrototype` has exactly one optional pointer-valued property. The same
//! byte gates `getNeighbor`, `destroyEnd`, `onDestroy`'s cascade, `connectEnd`
//! and `getConnections`. So `cliff-vulcanus` runs all of it and
//! **`crater-cliff` runs none of it** - craters are outside the connection
//! system entirely, which is worth knowing before attributing anything
//! crater-shaped to these rules.
//!
//! ## What is NOT on the render path
//!
//! Nothing in the shipped Vulcanus cliff overlay calls this. It is the model
//! #84's investigation is scored with, and it is ported so that investigation
//! can run against the engine rather than only against the TypeScript. Read
//! [`apply_cliff_connections`]'s own note on the halo before using it for
//! anything else.

use std::collections::BTreeMap;

use crate::cliffs::catalog::{
    cliff_code_for_orientation, cliff_orientation_for_code, CHUNK_CELLS, CLIFF_CELL_CENTER_X,
    CLIFF_CELL_CENTER_Y, CLIFF_GRID_SIZE,
};
use crate::cliffs::placement::PlacedCliffCell;
use crate::poison;

/// `CellSide`, in the engine's enum order.
///
/// Read off `getNeighborPosition`, whose four arms add `-grid.y`, `+grid.x`,
/// `+grid.y`, `-grid.x` to the cliff's position in that order. `NONE` is 4 and
/// is what the end tables store for the `A-to-none` half of a terminating
/// orientation.
pub const SIDE_NORTH: u8 = 0;
pub const SIDE_EAST: u8 = 1;
pub const SIDE_SOUTH: u8 = 2;
pub const SIDE_WEST: u8 = 3;
pub const SIDE_NONE: u8 = 4;

/// `(from, to)` side per `CliffOrientation` id: the two byte tables at
/// `0x102ed8ff8` and `0x102ed9020` that `isCliffConnected` indexes.
///
/// The bytes turned out to be exactly what the orientation NAMES say -
/// `west-to-east` is `(west, east)`, all 20, with `none` for the halves - so
/// [`tests::the_end_table_is_what_the_orientation_names_say`] re-derives this
/// from the names and asserts it matches. A transcription slip fails rather than
/// shifting the model.
pub const CLIFF_ORIENTATION_ENDS: [(u8, u8); 20] = [
    (SIDE_WEST, SIDE_EAST),   //  0 west-to-east
    (SIDE_NORTH, SIDE_SOUTH), //  1 north-to-south
    (SIDE_EAST, SIDE_WEST),   //  2 east-to-west
    (SIDE_SOUTH, SIDE_NORTH), //  3 south-to-north
    (SIDE_WEST, SIDE_NORTH),  //  4 west-to-north
    (SIDE_NORTH, SIDE_EAST),  //  5 north-to-east
    (SIDE_EAST, SIDE_SOUTH),  //  6 east-to-south
    (SIDE_SOUTH, SIDE_WEST),  //  7 south-to-west
    (SIDE_WEST, SIDE_SOUTH),  //  8 west-to-south
    (SIDE_NORTH, SIDE_WEST),  //  9 north-to-west
    (SIDE_EAST, SIDE_NORTH),  // 10 east-to-north
    (SIDE_SOUTH, SIDE_EAST),  // 11 south-to-east
    (SIDE_WEST, SIDE_NONE),   // 12 west-to-none
    (SIDE_NONE, SIDE_EAST),   // 13 none-to-east
    (SIDE_EAST, SIDE_NONE),   // 14 east-to-none
    (SIDE_NONE, SIDE_WEST),   // 15 none-to-west
    (SIDE_NORTH, SIDE_NONE),  // 16 north-to-none
    (SIDE_NONE, SIDE_SOUTH),  // 17 none-to-south
    (SIDE_SOUTH, SIDE_NONE),  // 18 south-to-none
    (SIDE_NONE, SIDE_NORTH),  // 19 none-to-north
];

/// `N<->S`, `E<->W`, and `none -> none`.
///
/// In the binary this is the immediate `0x01000302` shifted right by
/// `side * 8`, appearing identically in `isCliffConnected` and
/// `Cliff::onDestroy`.
#[must_use]
pub fn opposite_side(side: u8) -> u8 {
    if side < 4 {
        ((0x0100_0302u32 >> (side * 8)) & 0xff) as u8
    } else {
        SIDE_NONE
    }
}

/// `Cliff::neighborSidesForOrientation`: the orientation's ends, `none`
/// dropped.
///
/// Its 20-entry jump table collapses to 10 blocks - `west-to-east` and
/// `east-to-west` share one, and so on - which is the binary saying outright
/// that only the SET of ends matters here, not their direction.
#[must_use]
pub fn connected_sides(orientation: u8) -> Vec<u8> {
    let Some(&(from, to)) = CLIFF_ORIENTATION_ENDS.get(orientation as usize) else {
        return Vec::new();
    };
    [from, to].into_iter().filter(|s| *s != SIDE_NONE).collect()
}

/// `Cliff::destroyEnd(side)` as a pure function on the orientation: `side`
/// becomes `none`, and `None` means the cliff is destroyed because nothing is
/// left. A side the orientation does not have is a no-op.
#[must_use]
pub fn destroy_end(orientation: u8, side: u8) -> DestroyEnd {
    let Some(&(from, to)) = CLIFF_ORIENTATION_ENDS.get(orientation as usize) else {
        return DestroyEnd::Unchanged;
    };
    let next = if from == side {
        (SIDE_NONE, to)
    } else if to == side {
        (from, SIDE_NONE)
    } else {
        return DestroyEnd::Unchanged;
    };
    if next.0 == SIDE_NONE && next.1 == SIDE_NONE {
        return DestroyEnd::Destroyed;
    }
    CLIFF_ORIENTATION_ENDS
        .iter()
        .position(|e| *e == next)
        .map_or(DestroyEnd::Unchanged, |i| DestroyEnd::Became(i as u8))
}

/// What [`destroy_end`] did to an orientation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DestroyEnd {
    /// The orientation does not have that side; nothing happens.
    Unchanged,
    /// The orientation lost that end and became this one.
    Became(u8),
    /// Nothing is left, so the cliff itself goes.
    Destroyed,
}

/// `isCliffConnected(CellSide, CliffOrientation, CliffOrientation)`, which is a
/// **parity** test rather than a "do they touch" test.
///
/// A cliff run is directed: `A-to-B` leaves through `B` and the next cell must
/// ENTER through `opposite(B)`, i.e. that side must be its `from`. So my `to`
/// end pairs with their `from` end and my `from` end with their `to` end, and a
/// neighbour presenting the right side with the wrong parity does not count as
/// connected. The `csel` at `0x1007a94c8` is what picks which arm applies, on
/// whether `side` is my `from`.
///
/// **This is the op's poison hook.** The output is a classification, and the
/// whole pass is a chain of them, so a numeric perturbation could not reach it.
#[must_use]
pub fn is_cliff_connected(side: u8, mine: u8, theirs: u8) -> bool {
    poison::bool_result(is_cliff_connected_inner(side, mine, theirs))
}

fn is_cliff_connected_inner(side: u8, mine: u8, theirs: u8) -> bool {
    let (Some(&a), Some(&b)) = (
        CLIFF_ORIENTATION_ENDS.get(mine as usize),
        CLIFF_ORIENTATION_ENDS.get(theirs as usize),
    ) else {
        return false;
    };
    let opp = opposite_side(side);
    if a.0 == side {
        return b.0 != opp && b.1 == opp;
    }
    a.1 == side && b.0 == opp && b.1 != opp
}

/// Cell-centre delta, in tiles, of the neighbour on `side`.
const SIDE_STEP: [(f64, f64); 4] = [
    (0.0, -CLIFF_GRID_SIZE),
    (CLIFF_GRID_SIZE, 0.0),
    (0.0, CLIFF_GRID_SIZE),
    (-CLIFF_GRID_SIZE, 0.0),
];

/// The cell index a placed cliff centre sits at. Exact, because centres are
/// `cx * 4 + 2` and `cy * 4 + 2.5`.
#[must_use]
pub fn cell_index(x: f64, y: f64) -> (i64, i64) {
    (
        ((x - CLIFF_CELL_CENTER_X) / CLIFF_GRID_SIZE).round() as i64,
        ((y - CLIFF_CELL_CENTER_Y) / CLIFF_GRID_SIZE).round() as i64,
    )
}

/// The centre of a cell index - the exact inverse of [`cell_index`].
#[must_use]
pub fn cell_centre(cx: i64, cy: i64) -> (f64, f64) {
    #[allow(clippy::cast_precision_loss)]
    (
        cx as f64 * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_X,
        cy as f64 * CLIFF_GRID_SIZE + CLIFF_CELL_CENTER_Y,
    )
}

/// True when the cell is on its chunk's outer ring, which is list B's domain.
#[must_use]
pub fn on_chunk_border(x: f64, y: f64) -> bool {
    let (cx, cy) = cell_index(x, y);
    let n = CHUNK_CELLS as i64;
    let ix = cx.rem_euclid(n);
    let iy = cy.rem_euclid(n);
    ix == 0 || ix == n - 1 || iy == 0 || iy == n - 1
}

/// A placed cell carrying the orientation the connection pass left it with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConnectedCliffCell {
    pub x: f64,
    pub y: f64,
    pub code: u8,
    pub orientation: u8,
}

/// `Surface::wouldCollide(CliffPrototype const&, MapPosition const&,
/// CliffOrientation)` - the collision test `applyCliffs` runs per queued cliff.
/// Return `true` to destroy it.
///
/// **This, not `tryToAddCliff`, is where map generation rejects a cliff**, and
/// the note in `cliffs-NOTES.md` that said otherwise had the two modes the wrong
/// way round. `tryToAddCliff` tests collisions only when the task's mode byte is
/// `2`, and the constructors say which is which: real map generation stores
/// **1**, and the MAP PREVIEW generator stores **2**. So on a real map
/// `tryToAddCliff` runs no collision test at all.
///
/// That matters because the two stages differ in what they do to the
/// NEIGHBOURS. A `tryToAddCliff` rejection simply never queues the cliff. The
/// `applyCliffs` rejection creates the cliff, adds it to the surface, and then
/// `forceDestroy()`s it - which runs `Cliff::onDestroy` and takes the facing end
/// of every connected neighbour with it.
pub trait ApplyCollision {
    fn collides(&self, orientation: u8, x: f64, y: f64) -> bool;
}

/// Levers on the connection pass. [`Default`] is the game.
#[derive(Default)]
pub struct CliffConnectionOptions<'a> {
    /// See [`ApplyCollision`].
    pub collides: Option<&'a dyn ApplyCollision>,
    /// Run `updateConnections` on every cell rather than only on the chunk's
    /// outer ring. **Not the game's rule** - `applyCliffs` gates it on the fifth
    /// argument of `tryToAddCliff` - and here only so a spec can measure what
    /// the gate is worth. A rule that scored the same either way would not have
    /// been read out of `generateCliffs` at all.
    pub every_cell: bool,
    /// Skip the `onDestroy` cascade, i.e. destroy a cliff without telling its
    /// neighbours. Also not the game's rule - `Cliff::destroyWithoutCorrection`
    /// exists precisely because the ordinary destroy DOES correct - and again
    /// only here so the cascade can be scored separately.
    pub no_cascade: bool,
    /// Skip the `updateConnections` pass, leaving only the collision destroys.
    pub no_update_connections: bool,
}

/// The live cell set, keyed by cell index so the map needs no float keys.
type Live = BTreeMap<(i64, i64), u8>;

/// Apply the connection pass to a set of placed cells and return the survivors.
///
/// **Callers must supply a halo.** A cell on the query's outer chunk ring reads
/// its neighbour across the boundary, so cells are needed for one chunk beyond
/// whatever is to be kept, and the `onDestroy` cascade can in principle reach
/// further still.
///
/// The chunk-generated test is modelled as "every chunk in the supplied set is
/// generated". That is the one place this is not a transcription: the game skips
/// a side whose neighbouring chunk has status `<= 0x31`, so during a real
/// generation sweep a cliff pointing into a not-yet-generated chunk keeps its
/// end, and this model destroys it. It is therefore an UPPER bound on how much
/// the rule removes.
#[must_use]
pub fn apply_cliff_connections(
    cells: &[PlacedCliffCell],
    opts: &CliffConnectionOptions<'_>,
) -> Vec<ConnectedCliffCell> {
    let mut live: Live = BTreeMap::new();
    for c in cells {
        if let Some(orientation) = cliff_orientation_for_code(c.code) {
            live.insert(cell_index(c.x, c.y), orientation);
        }
    }

    // Chunk order is row-major over the supplied cells, and within a chunk the
    // cells are visited in the order `generateCliffs` queues them (`cy` outer).
    // The real order is the surface's chunk-generation order, which is not
    // knowable from here; the spec's arms are what check the answer does not
    // depend on it.
    let n = CHUNK_CELLS as i64;
    let mut order: Vec<(i64, i64)> = live.keys().copied().collect();
    order.sort_by_key(|&(cx, cy)| (cy.div_euclid(n), cx.div_euclid(n), cy, cx));

    // `applyCliffs`' own two-phase shape, per chunk: every cliff is tested with
    // the orientation it was queued with, and only then are the hits destroyed -
    // so a destroy in this chunk cannot change what its neighbour was tested as.
    if let Some(collides) = opts.collides {
        let mut chunk: Option<(i64, i64)> = None;
        let mut doomed: Vec<(i64, i64)> = Vec::new();
        for &k in &order {
            let id = (k.0.div_euclid(n), k.1.div_euclid(n));
            if chunk != Some(id) {
                for d in doomed.drain(..) {
                    force_destroy(&mut live, d, opts.no_cascade);
                }
                chunk = Some(id);
            }
            let Some(&orientation) = live.get(&k) else {
                continue;
            };
            let (x, y) = cell_centre(k.0, k.1);
            if collides.collides(orientation, x, y) {
                doomed.push(k);
            }
        }
        for d in doomed {
            force_destroy(&mut live, d, opts.no_cascade);
        }
    }

    if !opts.no_update_connections {
        for &k in &order {
            // It may have been destroyed by an earlier cell's cascade.
            let Some(&at_entry) = live.get(&k) else {
                continue;
            };
            let (x, y) = cell_centre(k.0, k.1);
            if !opts.every_cell && !on_chunk_border(x, y) {
                continue;
            }
            // The sides come from the orientation read ONCE, before the loop;
            // the comparison re-reads it. See the module docs.
            for side in connected_sides(at_entry) {
                let Some(&mine) = live.get(&k) else { break };
                let neighbour = neighbour_of(&live, k, side);
                if neighbour.is_none_or(|theirs| !is_cliff_connected(side, mine, theirs)) {
                    do_destroy_end(&mut live, k, side, opts.no_cascade);
                }
            }
        }
    }

    emit(&live)
}

fn neighbour_key(k: (i64, i64), side: u8) -> (i64, i64) {
    let (dx, dy) = SIDE_STEP[side as usize];
    #[allow(clippy::cast_possible_truncation)]
    (
        k.0 + (dx / CLIFF_GRID_SIZE) as i64,
        k.1 + (dy / CLIFF_GRID_SIZE) as i64,
    )
}

fn neighbour_of(live: &Live, k: (i64, i64), side: u8) -> Option<u8> {
    live.get(&neighbour_key(k, side)).copied()
}

/// `destroyEnd` plus the `onDestroy` cascade. Recursive because that is what the
/// engine does: `forceDestroy` calls `onDestroy`, which calls `destroyEnd` on
/// the neighbours, either of which can destroy again.
fn do_destroy_end(live: &mut Live, k: (i64, i64), side: u8, no_cascade: bool) {
    let Some(&orientation) = live.get(&k) else {
        return;
    };
    match destroy_end(orientation, side) {
        DestroyEnd::Unchanged => (),
        DestroyEnd::Became(next) => {
            live.insert(k, next);
        }
        DestroyEnd::Destroyed => {
            // `Cliff::onDestroy` reads the sides of the orientation it still had
            // at that moment, then tells each existing neighbour to lose its
            // facing end.
            cascade(live, k, orientation, no_cascade);
        }
    }
}

/// `Entity::forceDestroy` on a cliff: it leaves, and its neighbours lose the
/// ends facing it.
fn force_destroy(live: &mut Live, k: (i64, i64), no_cascade: bool) {
    let Some(&orientation) = live.get(&k) else {
        return;
    };
    cascade(live, k, orientation, no_cascade);
}

fn cascade(live: &mut Live, k: (i64, i64), orientation: u8, no_cascade: bool) {
    let sides = connected_sides(orientation);
    live.remove(&k);
    if no_cascade {
        return;
    }
    for s in sides {
        let nk = neighbour_key(k, s);
        if live.contains_key(&nk) {
            do_destroy_end(live, nk, opposite_side(s), no_cascade);
        }
    }
}

fn emit(live: &Live) -> Vec<ConnectedCliffCell> {
    live.iter()
        .map(|(&(cx, cy), &orientation)| {
            let (x, y) = cell_centre(cx, cy);
            ConnectedCliffCell {
                x,
                y,
                code: cliff_code_for_orientation(orientation).unwrap_or(0),
                orientation,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cliffs::catalog::CLIFF_ORIENTATION_NAMES;

    fn side_of(name: &str) -> u8 {
        match name {
            "north" => SIDE_NORTH,
            "east" => SIDE_EAST,
            "south" => SIDE_SOUTH,
            "west" => SIDE_WEST,
            "none" => SIDE_NONE,
            other => panic!("unknown side {other}"),
        }
    }

    /// The transcribed end table against the orientation NAMES it should be a
    /// restatement of. This is the check that the bytes were read in the right
    /// order rather than assumed.
    #[test]
    fn the_end_table_is_what_the_orientation_names_say() {
        for (id, name) in CLIFF_ORIENTATION_NAMES.iter().enumerate() {
            let (from, to) = name.split_once("-to-").expect("every name is A-to-B");
            assert_eq!(
                CLIFF_ORIENTATION_ENDS[id],
                (side_of(from), side_of(to)),
                "orientation {id} ({name})"
            );
        }
    }

    #[test]
    fn opposite_pairs_north_with_south_and_east_with_west() {
        assert_eq!(opposite_side(SIDE_NORTH), SIDE_SOUTH);
        assert_eq!(opposite_side(SIDE_SOUTH), SIDE_NORTH);
        assert_eq!(opposite_side(SIDE_EAST), SIDE_WEST);
        assert_eq!(opposite_side(SIDE_WEST), SIDE_EAST);
        assert_eq!(opposite_side(SIDE_NONE), SIDE_NONE);
        // An involution, which the shift table gives for free and a hand-written
        // one would not.
        for s in 0..5u8 {
            assert_eq!(opposite_side(opposite_side(s)), s);
        }
    }

    /// Connection is a PARITY test. `west-to-east` meeting `west-to-east` on the
    /// east side connects, because my `to` pairs with their `from`; meeting
    /// `east-to-west` there does not, even though both present a west end.
    #[test]
    fn connection_is_a_parity_test_and_not_a_do_they_touch_test() {
        let wte = 0; // west-to-east
        let etw = 2; // east-to-west
        assert!(is_cliff_connected(SIDE_EAST, wte, wte));
        assert!(!is_cliff_connected(SIDE_EAST, wte, etw));
        assert!(is_cliff_connected(SIDE_WEST, etw, etw));
        assert!(!is_cliff_connected(SIDE_WEST, etw, wte));
    }

    /// A two-ended orientation loses one end and becomes a terminator; the
    /// terminator loses its last end and the cliff goes.
    #[test]
    fn destroying_both_ends_destroys_the_cliff() {
        let wte = 0; // west-to-east
        let DestroyEnd::Became(next) = destroy_end(wte, SIDE_EAST) else {
            panic!("west-to-east should survive losing its east end");
        };
        assert_eq!(CLIFF_ORIENTATION_NAMES[next as usize], "west-to-none");
        assert_eq!(destroy_end(next, SIDE_WEST), DestroyEnd::Destroyed);
        assert_eq!(destroy_end(next, SIDE_NORTH), DestroyEnd::Unchanged);
    }

    /// The orientation the loop COMPARES is re-read inside it, so a cell whose
    /// first side is destroyed is re-examined with its NEW orientation on the
    /// second - which is how it can lose both ends in one pass. A snapshot of
    /// the orientation would leave the cell alive.
    #[test]
    fn a_cell_can_lose_both_ends_in_one_pass() {
        // One isolated `west-to-east` on the chunk's outer ring, with no
        // neighbours at all: both ends fail to connect and it must vanish.
        let (x, y) = cell_centre(0, 0);
        assert!(on_chunk_border(x, y), "cell (0,0) is on its chunk's ring");
        let cells = [PlacedCliffCell {
            x,
            y,
            code: cliff_code_for_orientation(0).expect("west-to-east has a code"),
        }];
        let out = apply_cliff_connections(&cells, &CliffConnectionOptions::default());
        assert!(
            out.is_empty(),
            "an unconnected two-ended cliff loses both ends"
        );
    }

    /// Off the ring, `updateConnections` never runs, so the same cell survives.
    /// That is the gate the fifth argument of `tryToAddCliff` selects.
    #[test]
    fn a_cell_off_the_chunk_ring_is_left_alone() {
        let (x, y) = cell_centre(3, 3);
        assert!(!on_chunk_border(x, y));
        let cells = [PlacedCliffCell {
            x,
            y,
            code: cliff_code_for_orientation(0).expect("west-to-east has a code"),
        }];
        let out = apply_cliff_connections(&cells, &CliffConnectionOptions::default());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].orientation, 0);

        // ...and `every_cell` is the lever that says what the gate is worth.
        let opts = CliffConnectionOptions {
            every_cell: true,
            ..Default::default()
        };
        assert!(apply_cliff_connections(&cells, &opts).is_empty());
    }

    #[test]
    fn cell_index_and_centre_are_exact_inverses() {
        for cx in -5..5i64 {
            for cy in -5..5i64 {
                let (x, y) = cell_centre(cx, cy);
                assert_eq!(cell_index(x, y), (cx, cy));
            }
        }
    }
}
