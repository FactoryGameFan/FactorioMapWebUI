//! The game's own per-chunk entity generator: one random stream per chunk,
//! shared by every autoplacer, in the game's order.
//!
//! This is `EntityMapGenerationTask::generateEntities` and
//! `generateEntityOnTile`, read from the Factorio 2.1.23 Linux headless build,
//! which ships DWARF line tables (`EntityMapGenerationTask.cpp`). It replaces
//! the per-overlay salted roll in [`super::roll`] for any planet whose every
//! entity autoplacer is ported, which so far is Aquilo (#492). The roll module
//! stays for the other planets, whose autoplacers are not all ported.
//!
//! What the game does, per chunk, and what this module reproduces:
//!
//! 1. **Seed once.** taus88 with all three words set to
//!    [`placement_roll_word`]`(cx, cy, 0)`: no map seed and no salt. The one
//!    stream serves every group below, in order, and is never re-seeded
//!    (cpp:358).
//! 2. **Groups.** The active entity autoplacers, sorted bytewise by
//!    (autoplace `order`, prototype name). A group is a run of equal `order`
//!    strings (cpp:420-424). The caller passes the groups already sorted.
//! 3. **Arbitration, per group** (cpp:378-416). Tiles run from index 1023 down
//!    to 0, `i = row * 32 + col`, at integer tile corners. A tile whose tile
//!    collision mask hits the prototype's `collision_mask` is skipped. The
//!    best value starts at -inf, so ANY finite probability wins an empty tile,
//!    0 and negative values included.
//! 4. **The roll, per group** (cpp:426-470), same tile order. A tile with no
//!    winner draws nothing. A tile with a winner draws one `U` and places when
//!    `(double)p > U`. **A tile whose probability is 0 still draws.**
//! 5. **One entity** (cpp:512-542), in 1/256 tile. A resource goes to the tile
//!    centre and draws nothing. A `placeable-off-grid` entity takes two more
//!    draws, x then y, each adding `trunc(256 U)` and clearing the low four
//!    bits, so the offset is `floor(16 U) / 16` tile. **Those draws come
//!    before the tile check below, so an entity that then fails still used
//!    them.**
//! 6. **Tile check.** Every tile from `floor(left)` to `floor(right)` (both
//!    axes, inclusive) of the map-gen box must lie within the chunk plus 32
//!    tiles on each side and must not collide with the prototype's mask. A
//!    pass queues the entity; entity-against-entity collision is NOT tested
//!    here.
//!
//! Entity-against-entity collision happens later, when the queue is applied
//! to a real surface, and draws nothing. So a chunk's stream depends only on
//! the fields, the tile masks and the chunk position, never on collisions.
//! **The game's own map preview does not apply that step at all**, which is
//! why [`generate_chunk`] stops at the queue. [`preview_footprint`] is the
//! preview's drawing rule.
//!
//! ## What is not ported, and why each is unreachable today
//!
//! - **`placement_density`.** The attempt count per tile. No entity
//!   prototype sets it (only decoratives do), so it is the default 1.
//! - **Grid snapping** (`buildPosition`) for entities that are neither
//!   resources nor off-grid. No caller has one.
//! - **The richness tie-break** inside a group with more than one prototype,
//!   and **`tile_restriction`**. Every Aquilo group holds one prototype and
//!   none declares a restriction. [`generate_chunk`] refuses a group of two
//!   rather than quietly using a rule the game does not.
//!
//! ## Measured
//!
//! On Aquilo at derived seed 3111923328, every entity the game placed on a
//! real surface (209 of 209, positions to the 1/16 tile) when replayed on the
//! game's own tiles, and 0 of 1,900 differing entity pixels against the
//! game's preview PNG over tiles -256..255. The tests that pin both are in
//! `fixtures` and `placement::aquilo`; `docs/noise/aquilo-NOTES.md` has the
//! story.

use super::roll::{placement_roll_word, CHUNK, TILES_PER_CHUNK};
use crate::poison;
use crate::taus88::{seeded_state, taus88_next, Taus88State};

/// Positions and boxes are in 1/256 tile, the game's `MapPosition` fixed point.
pub const FIXED_ONE: i64 = 256;

/// How far the generator may look past its own chunk, in tiles: the working
/// area is the chunk plus 32 tiles on each side (cpp:101-103).
pub const AREA_MARGIN: i64 = 32;

/// A prototype's map-generation box, in 1/256 tile, relative to its position.
///
/// The game uses `map_generator_bounding_box` and falls back to
/// `collision_box`. Each edge is the box's tile value times 256, truncated
/// toward zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MapGenBox {
    pub left: i64,
    pub top: i64,
    pub right: i64,
    pub bottom: i64,
}

impl MapGenBox {
    /// A box centred on the position, `half_w` and `half_h` in 1/256 tile.
    #[must_use]
    pub const fn centred(half_w: i64, half_h: i64) -> Self {
        Self {
            left: -half_w,
            top: -half_h,
            right: half_w,
            bottom: half_h,
        }
    }
}

/// Where one placement goes inside its tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Positioning {
    /// A `resource`: the tile centre, no draws, and only where richness is
    /// above 0.
    Resource,
    /// A `placeable-off-grid` non-resource: the tile corner plus two jitter
    /// draws.
    OffGrid,
}

/// One entity autoplacer, as the generator needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Autoplacer {
    pub positioning: Positioning,
    pub map_gen_box: MapGenBox,
}

/// The per-tile inputs the generator reads, by prototype index.
///
/// `tx` and `ty` are world tiles. [`generate_chunk`] asks
/// [`ChunkInputs::candidate`] and [`ChunkInputs::probability`] only for tiles
/// in the chunk, and [`ChunkInputs::tile_blocks`] for any tile in the chunk's
/// working area.
pub trait ChunkInputs {
    /// Whether the tile's own collision mask lets this prototype be a
    /// candidate here. Also the rule [`ChunkInputs::tile_blocks`] applies, so
    /// the default is its negation.
    fn candidate(&mut self, proto: usize, tx: i64, ty: i64) -> bool {
        !self.tile_blocks(proto, tx, ty)
    }

    /// The autoplace probability, an f32 widened to f64.
    fn probability(&mut self, proto: usize, tx: i64, ty: i64) -> f64;

    /// Whether the richness is above 0. Read only for resources, and only on
    /// a tile that rolled a success.
    fn richness_positive(&mut self, proto: usize, tx: i64, ty: i64) -> bool;

    /// Whether this tile's collision mask collides with the prototype's.
    fn tile_blocks(&mut self, proto: usize, tx: i64, ty: i64) -> bool;
}

/// One entity the generator queued: prototype index and position in 1/256
/// tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Queued {
    pub proto: usize,
    pub x: i64,
    pub y: i64,
}

impl Queued {
    /// The entity's map-gen box in absolute 1/256 tile: left, top, right,
    /// bottom.
    #[must_use]
    pub fn bounds(&self, protos: &[Autoplacer]) -> [i64; 4] {
        let b = protos[self.proto].map_gen_box;
        [
            self.x + b.left,
            self.y + b.top,
            self.x + b.right,
            self.y + b.bottom,
        ]
    }
}

/// `taus88() * 2^-32`, the game's `RandomGenerator::uniformDouble`.
fn uniform(state: &mut Taus88State) -> f64 {
    f64::from(taus88_next(state)) / 4_294_967_296.0
}

/// One chunk's queue, in the order the game queues it: group order, then
/// decreasing tile index.
///
/// `groups` lists prototype indices into `protos`, already in the game's
/// sorted order. Each group must hold exactly one prototype; see the module
/// docs.
///
/// # Panics
///
/// On a group that does not hold exactly one prototype.
pub fn generate_chunk(
    chunk_x: i64,
    chunk_y: i64,
    groups: &[&[usize]],
    protos: &[Autoplacer],
    inputs: &mut dyn ChunkInputs,
) -> Vec<Queued> {
    let mut state = seeded_state(placement_roll_word(chunk_x, chunk_y, 0));
    let mut queue = Vec::new();
    let mut best = [f64::NEG_INFINITY; TILES_PER_CHUNK];
    let mut has_winner = [false; TILES_PER_CHUNK];

    for group in groups {
        assert!(
            group.len() == 1,
            "a group of {} prototypes needs the richness tie-break, which is not ported",
            group.len()
        );
        let proto = group[0];

        // Arbitration. With one prototype per group, the winner is that
        // prototype wherever the tile admits it and its value beats -inf.
        for i in (0..TILES_PER_CHUNK).rev() {
            let (tx, ty) = tile_of(chunk_x, chunk_y, i);
            if !inputs.candidate(proto, tx, ty) {
                continue;
            }
            let p = inputs.probability(proto, tx, ty);
            if p > best[i] {
                best[i] = p;
                has_winner[i] = true;
            }
        }

        // The roll.
        for i in (0..TILES_PER_CHUNK).rev() {
            if has_winner[i] {
                let (tx, ty) = tile_of(chunk_x, chunk_y, i);
                let u = uniform(&mut state);
                // A classification, so its control is `bool_result`: see the
                // matching comment in `roll.rs`.
                if poison::bool_result(best[i] > u) {
                    if let Some(q) =
                        place(proto, tx, ty, chunk_x, chunk_y, protos, inputs, &mut state)
                    {
                        queue.push(q);
                    }
                }
            }
            best[i] = f64::NEG_INFINITY;
            has_winner[i] = false;
        }
    }
    queue
}

/// World tile of tile index `i` in a chunk: x fastest.
fn tile_of(chunk_x: i64, chunk_y: i64, i: usize) -> (i64, i64) {
    #[allow(clippy::cast_possible_wrap)]
    let i = i as i64;
    (chunk_x * CHUNK + (i & 31), chunk_y * CHUNK + (i >> 5))
}

/// `generateEntityOnTile`: position, then the tile check over the box.
#[allow(clippy::too_many_arguments)]
fn place(
    proto: usize,
    tx: i64,
    ty: i64,
    chunk_x: i64,
    chunk_y: i64,
    protos: &[Autoplacer],
    inputs: &mut dyn ChunkInputs,
    state: &mut Taus88State,
) -> Option<Queued> {
    let ap = protos[proto];
    let (x, y) = match ap.positioning {
        Positioning::Resource => {
            if !inputs.richness_positive(proto, tx, ty) {
                return None;
            }
            (tx * FIXED_ONE + 128, ty * FIXED_ONE + 128)
        }
        Positioning::OffGrid => {
            // x first, then y (cpp:532-533). `as i64` truncates, and U is
            // non-negative, so it is the floor the game's cast gives.
            #[allow(clippy::cast_possible_truncation)]
            let dx = (uniform(state) * 256.0) as i64;
            #[allow(clippy::cast_possible_truncation)]
            let dy = (uniform(state) * 256.0) as i64;
            ((tx * FIXED_ONE + dx) & !15, (ty * FIXED_ONE + dy) & !15)
        }
    };
    let q = Queued { proto, x, y };
    let [left, top, right, bottom] = q.bounds(protos);
    let area_x = (chunk_x * CHUNK - AREA_MARGIN)..(chunk_x * CHUNK + CHUNK + AREA_MARGIN);
    let area_y = (chunk_y * CHUNK - AREA_MARGIN)..(chunk_y * CHUNK + CHUNK + AREA_MARGIN);
    for by in top.div_euclid(FIXED_ONE)..=bottom.div_euclid(FIXED_ONE) {
        for bx in left.div_euclid(FIXED_ONE)..=right.div_euclid(FIXED_ONE) {
            if !area_x.contains(&bx) || !area_y.contains(&by) || inputs.tile_blocks(proto, bx, by) {
                return None;
            }
        }
    }
    Some(q)
}

/// The tiles the game's map preview paints for one chunk's queue: for each
/// of the chunk's 1024 tiles, the index into `queue` of the entity drawn
/// there, or `None`.
///
/// The preview's rule, measured against its PNG rather than read from code
/// (0 of 1,900 entity pixels differ on Aquilo):
///
/// - No entity-against-entity collision: every queued entity is drawn.
/// - An entity covers the tiles from `floor(left)` to `ceil(right) - 1`, so
///   a box edge that lands exactly on a tile line does not take the tile
///   past it. (The generator's tile check is inclusive there; the drawing is
///   not.)
/// - **Each entity is drawn only inside its own chunk**, the chunk that
///   generated it.
/// - Where two entities overlap, the first in queue order wins.
///
/// `include` filters the queue first, by prototype index, so a view that
/// shows only some prototypes still lets an earlier hidden one leave its
/// tiles to a later shown one.
#[must_use]
pub fn preview_footprint(
    chunk_x: i64,
    chunk_y: i64,
    queue: &[Queued],
    protos: &[Autoplacer],
    include: &dyn Fn(usize) -> bool,
) -> [Option<u16>; TILES_PER_CHUNK] {
    let mut out = [None; TILES_PER_CHUNK];
    let (x0, y0) = (chunk_x * CHUNK, chunk_y * CHUNK);
    for (k, q) in queue.iter().enumerate() {
        if !include(q.proto) {
            continue;
        }
        let [left, top, right, bottom] = q.bounds(protos);
        let tx0 = left.div_euclid(FIXED_ONE).max(x0);
        let tx1 = (right - 1).div_euclid(FIXED_ONE).min(x0 + CHUNK - 1);
        let ty0 = top.div_euclid(FIXED_ONE).max(y0);
        let ty1 = (bottom - 1).div_euclid(FIXED_ONE).min(y0 + CHUNK - 1);
        for ty in ty0..=ty1 {
            for tx in tx0..=tx1 {
                #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
                let i = ((ty - y0) * CHUNK + (tx - x0)) as usize;
                if out[i].is_none() {
                    #[allow(clippy::cast_possible_truncation)]
                    let k = k as u16;
                    out[i] = Some(k);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Inputs from closures over world tiles.
    struct Fake<P: FnMut(usize, i64, i64) -> f64, B: FnMut(usize, i64, i64) -> bool> {
        p: P,
        blocks: B,
        asked: Vec<(usize, i64, i64)>,
    }

    impl<P: FnMut(usize, i64, i64) -> f64, B: FnMut(usize, i64, i64) -> bool> ChunkInputs
        for Fake<P, B>
    {
        fn probability(&mut self, proto: usize, tx: i64, ty: i64) -> f64 {
            self.asked.push((proto, tx, ty));
            (self.p)(proto, tx, ty)
        }
        fn richness_positive(&mut self, _: usize, _: i64, _: i64) -> bool {
            true
        }
        fn tile_blocks(&mut self, proto: usize, tx: i64, ty: i64) -> bool {
            (self.blocks)(proto, tx, ty)
        }
    }

    const RES: Autoplacer = Autoplacer {
        positioning: Positioning::Resource,
        map_gen_box: MapGenBox::centred(358, 358),
    };
    const ROCK: Autoplacer = Autoplacer {
        positioning: Positioning::OffGrid,
        map_gen_box: MapGenBox::centred(256, 192),
    };

    /// The stream a chunk draws, for checking positions by hand.
    fn stream(cx: i64, cy: i64, n: usize) -> Vec<f64> {
        let mut s = seeded_state(placement_roll_word(cx, cy, 0));
        (0..n).map(|_| uniform(&mut s)).collect()
    }

    #[test]
    fn a_probability_of_one_places_a_resource_on_every_tile_in_decreasing_order() {
        let mut f = Fake {
            p: |_, _, _| 1.0,
            blocks: |_, _, _| false,
            asked: Vec::new(),
        };
        let q = generate_chunk(2, -3, &[&[0]], &[RES], &mut f);
        assert_eq!(q.len(), TILES_PER_CHUNK);
        // Index 1023 first: col 31, row 31.
        assert_eq!(
            (q[0].x, q[0].y),
            ((64 + 31) * 256 + 128, (-96 + 31) * 256 + 128)
        );
        assert_eq!(
            (q[1].x, q[1].y),
            ((64 + 30) * 256 + 128, (-96 + 31) * 256 + 128)
        );
        assert_eq!(
            (q[32].x, q[32].y),
            ((64 + 31) * 256 + 128, (-96 + 30) * 256 + 128)
        );
    }

    /// Probability 0 never places, but it still uses a draw: the second
    /// group's stream starts after the first group's 1024 draws, not at the
    /// first draw.
    #[test]
    fn a_zero_probability_group_still_spends_one_draw_per_tile() {
        let target = 1023 - 5; // the sixth tile the second group visits
        let u = stream(0, 0, 1024 + 6);
        let p_at_target = (u[1024 + 5] + u[5]) / 2.0;
        // Pick a probability that the shared stream accepts at draw 1024+5
        // and the unshared one would reject at draw 5, or the other way round.
        let accept_shared = u[1024 + 5] < u[5];
        let mut f = Fake {
            p: move |proto, tx, ty| {
                if proto == 1 && (ty * 32 + tx) as usize == target {
                    p_at_target
                } else {
                    0.0
                }
            },
            blocks: |_, _, _| false,
            asked: Vec::new(),
        };
        let q = generate_chunk(0, 0, &[&[0], &[1]], &[RES, RES], &mut f);
        assert_eq!(q.len(), usize::from(accept_shared));
    }

    #[test]
    fn jitter_is_two_draws_x_first_in_sixteenths_and_spent_even_when_the_box_fails() {
        // One rock wins tile index 1023, (31, 31) of chunk (0, 0); the next
        // success is at tile 1022.
        let u = stream(0, 0, 8);
        let mut f = Fake {
            p: |_, tx, ty| {
                if ty == 31 && (tx == 31 || tx == 30) {
                    1.0
                } else {
                    -1.0
                }
            },
            blocks: |_, tx, ty| tx == 32 && ty == 31, // the first rock's box reaches x = 32
            asked: Vec::new(),
        };
        let q = generate_chunk(0, 0, &[&[0]], &[ROCK], &mut f);
        // Draws: tile 1023 roll (u0), its jitter (u1, u2) - refused by the
        // tile at x = 32 - then tile 1022 roll (u3) and its jitter (u4, u5).
        let fx = (u[4] * 16.0).floor() as i64;
        let fy = (u[5] * 16.0).floor() as i64;
        assert_eq!(
            q,
            vec![Queued {
                proto: 0,
                x: 30 * 256 + fx * 16,
                y: 31 * 256 + fy * 16
            }]
        );
    }

    #[test]
    fn a_blocked_tile_is_not_a_candidate_and_draws_nothing() {
        let all_blocked = Fake {
            p: |_, _, _| 1.0,
            blocks: |_, _, _| true,
            asked: Vec::new(),
        };
        let mut f = all_blocked;
        assert!(generate_chunk(0, 0, &[&[0]], &[ROCK], &mut f).is_empty());
        // ...so the next group sees the chunk's FIRST draw: a probability a
        // hair above draw 0 places and a hair below does not. Had the blocked
        // group spent draws, both would read the same later draw and agree.
        let u0 = stream(0, 0, 1)[0];
        let placed = |p_at: f64| {
            let mut f = Fake {
                p: move |proto, tx, ty| {
                    if proto == 1 && tx == 31 && ty == 31 {
                        p_at
                    } else {
                        0.0
                    }
                },
                blocks: |proto, _, _| proto == 0,
                asked: Vec::new(),
            };
            generate_chunk(0, 0, &[&[0], &[1]], &[ROCK, RES], &mut f).len()
        };
        assert_eq!((placed(u0 + 1e-12), placed(u0 - 1e-12)), (1, 0));
    }

    #[test]
    fn the_box_must_stay_inside_the_working_area() {
        // A huge box at tile 0 of chunk (0, 0) reaches past x = -32.
        let wide = Autoplacer {
            positioning: Positioning::Resource,
            map_gen_box: MapGenBox::centred(33 * 256, 0),
        };
        let mut f = Fake {
            p: |_, tx, ty| if tx == 0 && ty == 0 { 1.0 } else { -1.0 },
            blocks: |_, _, _| false,
            asked: Vec::new(),
        };
        assert!(generate_chunk(0, 0, &[&[0]], &[wide], &mut f).is_empty());
    }

    #[test]
    #[should_panic(expected = "richness tie-break")]
    fn a_group_of_two_is_refused() {
        let mut f = Fake {
            p: |_, _, _| 0.0,
            blocks: |_, _, _| false,
            asked: Vec::new(),
        };
        let _ = generate_chunk(0, 0, &[&[0, 1]], &[RES, RES], &mut f);
    }

    #[test]
    fn the_preview_footprint_is_clipped_to_the_chunk_exclusive_at_the_high_edge_and_first_wins() {
        let protos = [RES, ROCK];
        let queue = [
            // A resource at tile (0, 0): box -1.4..1.4 covers tiles -1..1, but
            // only 0..1 are in the chunk.
            Queued {
                proto: 0,
                x: 128,
                y: 128,
            },
            // A rock whose box right edge lands exactly on x = 3 and bottom on
            // y = 2: tiles 1..2 by 0..1.
            Queued {
                proto: 1,
                x: 2 * 256,
                y: 256 + 64,
            },
        ];
        let fp = preview_footprint(0, 0, &queue, &protos, &|_| true);
        let at = |x: usize, y: usize| fp[y * 32 + x];
        assert_eq!(at(0, 0), Some(0));
        assert_eq!(at(1, 1), Some(0)); // first wins over the rock
        assert_eq!(at(2, 1), Some(1));
        assert_eq!(at(2, 0), Some(1));
        assert_eq!(at(3, 1), None); // right edge exactly on x = 3
        assert_eq!(at(2, 2), None); // bottom edge exactly on y = 2
        assert_eq!(at(1, 2), None);
        // Hiding the resource hands its tiles to the rock.
        let fp = preview_footprint(0, 0, &queue, &protos, &|p| p == 1);
        assert_eq!(fp[32 + 1], Some(1));
        assert_eq!(fp[0], None);
    }
}
